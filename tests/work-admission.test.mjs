import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkAdmission } from '../dist/workAdmission.js';

test('read admission bounds real work and FIFO waiters, with no implicit replay', async () => {
  const admission = new WorkAdmission(1, { maxQueued: 2, waitMs: 1000 });
  const held = Promise.withResolvers(), seen = [];
  const first = admission.run(async () => { seen.push('first'); await held.promise; });
  const second = admission.run(async () => { seen.push('second'); throw Error('provider failure'); }, true).catch(e => e.message);
  const third = admission.run(async () => { seen.push('third'); return 'done'; }, true);
  await assert.rejects(admission.run(async () => seen.push('overflow'), true), { code: 'AT_CAPACITY' });
  await assert.rejects(admission.run(async () => seen.push('mutation')), { code: 'AT_CAPACITY' });
  assert.equal(admission.active, 1); assert.equal(admission.queued, 2);
  held.resolve(); await first;
  assert.equal(await second, 'provider failure'); assert.equal(await third, 'done');
  assert.deepEqual(seen, ['first', 'second', 'third']);
  assert.equal(admission.active, 0); assert.equal(admission.queued, 0);
});

test('cancelled and expired waiters never acquire work, even if the timer callback is late', async () => {
  const admission = new WorkAdmission(1, { waitMs: 20 });
  const held = Promise.withResolvers(), cancel = new AbortController(); let calls = 0;
  const first = admission.run(async () => { await held.promise; });
  const cancelled = admission.run(async () => calls++, true, cancel.signal).catch(e => e.code);
  cancel.abort(); assert.equal(await cancelled, 'REQUEST_CLOSED');
  const expired = admission.run(async () => calls++, true).catch(e => e.code);
  // Block just past the deadline, then settle in a microtask before timers run.
  const until = performance.now() + 30;
  while (performance.now() < until) { /* Synthetic event-loop stall. */ }
  held.resolve(); await first;
  assert.equal(await expired, 'AT_CAPACITY'); assert.equal(calls, 0);
  assert.equal(admission.queued, 0); assert.equal(admission.active, 0);
});

test('drain rejects waiting work and retains already running work after cancellation', async () => {
  const admission = new WorkAdmission(1), held = Promise.withResolvers(), cancel = new AbortController();
  const first = admission.run(async () => held.promise, false, cancel.signal);
  const pending = admission.run(async () => assert.fail('drained waiter ran'), true).catch(e => e.code);
  cancel.abort(); assert.equal(admission.active, 1);
  admission.stop(); assert.equal(await pending, 'SHUTTING_DOWN');
  await assert.rejects(admission.run(async () => undefined), { code: 'SHUTTING_DOWN' });
  held.resolve(); await first; assert.equal(admission.active, 0); assert.equal(admission.queued, 0);
});
