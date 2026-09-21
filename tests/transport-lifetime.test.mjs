import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { serveStateless } from '../dist/statelessHttp.js';
import { ResourceBudgets } from '../dist/resourceBudgets.js';

class Response extends EventEmitter {
  destroyed = false; writableEnded = false; writableFinished = false;
  destroy() { this.destroyed = true; this.emit('close'); }
  finish() { this.writableEnded = this.writableFinished = true; this.emit('finish'); }
}
test('TI-03: lifecycle fault injection cleans once, holds stalled output and rejects late handler entry', async () => {
  for (const mode of ['connect_failure', 'handle_failure', 'stalled_output', 'finish_close']) {
    const res = new Response(); let released = 0, closed = 0, entry, writes = 0;
    const transport = { send: async () => {}, close: async () => { closed++; }, handleRequest: async () => {
      if (mode === 'handle_failure') throw Error('synthetic handle failure');
      if (mode === 'finish_close') { res.finish(); res.destroy(); }
    } };
    const p = serveStateless({ body: {} }, res, guard => {
      entry = guard;
      return { connect: async () => { if (mode === 'connect_failure') throw Error('synthetic connect failure'); }, close: () => transport.close() };
    }, { responseMs: 25, responseBytes: 1024, release: () => { released++; } }, transport);
    if (mode.includes('failure')) await assert.rejects(p, /synthetic/);
    else {
      if (mode === 'stalled_output') {
        await new Promise(r => setTimeout(r, 5)); assert.equal(released, 0, 'returned handle is not finished output');
        await new Promise(r => setTimeout(r, 35));
      }
      await p;
    }
    res.finish(); res.destroy();
    assert.equal(released, 1); assert.equal(closed, 1);
    await assert.rejects(entry(async () => { writes++; }), e => e.code === 'REQUEST_CLOSED');
    assert.equal(writes, 0);
  }
});

test('TI-04A: budget rejection never partially debits global tokens or evicts depleted actors', () => {
  let now = 0;
  const actor = id => ({ id, kind: 'auth_user' });
  const b = new ResourceBudgets({}, { now: () => now, limits: { requestRpm: 2, actorRequestRpm: 1, maxActors: 2 } });
  b.consume(actor('a'), 'request');
  assert.throws(() => b.consume(actor('a'), 'request'), e => e.code === 'REQUEST_RATE_LIMIT');
  b.consume(actor('b'), 'request');
  assert.throws(() => b.consume(actor('c'), 'request'), e => e.code === 'RATE_ACTOR_CAPACITY');
  now = 30_000;
  assert.throws(() => b.consume(actor('a'), 'request'), e => e.code === 'REQUEST_RATE_LIMIT');
  now = 60_000; b.consume(actor('a'), 'request');
  now = 120_001; b.consume(actor('c'), 'request');
});

test('TI-04A: default actor map admits at most 1024 identities and idle full refill permits recovery', () => {
  let now = 0;
  const b = new ResourceBudgets({}, { now: () => now, limits: { requestRpm: 5000, actorRequestRpm: 1 } });
  for (let i = 0; i < 1024; i++) b.consume({ id: String(i), kind: 'auth_user' }, 'request');
  assert.throws(() => b.consume({ id: 'new', kind: 'auth_user' }, 'request'), e => e.code === 'RATE_ACTOR_CAPACITY');
  assert.throws(() => b.consume({ id: '0', kind: 'auth_user' }, 'request'), e => e.code === 'REQUEST_RATE_LIMIT');
  now = 60_001; b.consume({ id: 'new', kind: 'auth_user' }, 'request');
});
