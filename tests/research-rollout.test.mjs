import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../dist/app.js';
import { performRollout } from '../scripts/rollout-gate.mjs';

test('PH-06-A: authentication that completes after drain cannot start a publication or SSE session', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let publications = 0;
  const runtime = createApp({ law: { listTools: async () => ({ tools: [] }), callTool: async () => {}, close: async () => {} },
    authenticate: async () => { entered.resolve(); await release.promise; return { id: 'fixture', kind: 'auth_user' }; },
    corrections: { confirm: async () => { publications++; return {}; }, search: () => ({ items: [] }) } });
  const server = runtime.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { release.resolve(); await runtime.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const pending = fetch(base + '/api/corrections/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await entered.promise;
  assert.equal((await (await fetch(base + '/health')).json()).active_requests, 0);
  await assert.rejects(runtime.drain(30), e => e.code === 'DRAIN_TIMEOUT');
  assert.equal(publications, 0);
  release.resolve(); const response = await pending;
  assert.equal(response.status, 503); assert.equal((await response.json()).code, 'SHUTTING_DOWN');
  assert.equal((await runtime.drain()).status, 'drained'); assert.equal(publications, 0);
  assert.equal((await fetch(base + '/sse')).status, 503);
});

test('PH-06-A: drain waits for an already-started publication without closing its provider', async t => {
  const entered = Promise.withResolvers(), release = Promise.withResolvers(); let closed = false;
  const runtime = createApp({ law: { listTools: async () => ({ tools: [] }), callTool: async () => {}, close: async () => { closed = true; } },
    authenticate: async () => ({ id: 'fixture', kind: 'auth_user' }),
    corrections: { confirm: async () => { entered.resolve(); await release.promise; return { state: 'pending_review' }; }, search: () => ({ items: [] }) } });
  const server = runtime.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { release.resolve(); await runtime.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const pending = fetch(`http://127.0.0.1:${server.address().port}/api/corrections/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  await entered.promise; await assert.rejects(runtime.drain(30), e => e.code === 'DRAIN_TIMEOUT');
  assert.equal(closed, false); release.resolve(); assert.equal((await pending).status, 200);
  await runtime.drain(); assert.equal(closed, false);
});

test('PH-06-B: candidate plus rollback failure keeps the fence; verified restoration alone may resume', async () => {
  for (const rollbackFails of [true, false]) {
    const calls = [];
    const ops = Object.fromEntries(['fence', 'drain', 'activate', 'verifyCandidate', 'rollback', 'verifyPrevious', 'resume'].map(name => [name, async () => {
      calls.push(name); if (name === 'verifyCandidate' || (name === 'rollback' && rollbackFails)) throw Error('Injected failure');
    }]));
    const result = await performRollout(ops);
    assert.equal(result.public_resumed, !rollbackFails);
    assert.equal(calls.filter(c => c === 'resume').length, rollbackFails ? 0 : 1);
    if (!rollbackFails) assert.ok(calls.indexOf('verifyPrevious') < calls.indexOf('resume'));
  }
  let activated = false, resumed = false;
  const result = await performRollout({ fence: async () => {}, drain: async () => { throw Error('Authentication still pending'); },
    activate: async () => { activated = true; }, verifyPrevious: async () => {}, resume: async () => { resumed = true; } });
  assert.equal(result.status, 'aborted_previous_verified'); assert.equal(activated, false); assert.equal(resumed, true);
});
