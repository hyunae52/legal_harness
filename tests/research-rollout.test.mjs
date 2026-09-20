import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../dist/app.js';
import { performRollout } from '../scripts/rollout-gate.mjs';
import { runRemotePhase } from '../deploy/remote-phase.mjs';

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

test('CR-03: a resume effect followed by an error never triggers a replacement or claims a closed fence', async () => {
  for (const candidateFails of [false, true]) {
    let publicOpen = true, rollbacks = 0, resumed = false;
    const calls = [];
    const result = await performRollout({
      fence: async () => { calls.push('fence'); publicOpen = false; },
      drain: async () => { calls.push('drain'); assert.equal(publicOpen, false); },
      activate: async () => { calls.push('activate'); assert.equal(publicOpen, false); },
      verifyCandidate: async () => { calls.push('verifyCandidate'); if (candidateFails) throw Error('Readiness failure'); },
      rollback: async () => { calls.push('rollback'); rollbacks++; if (resumed) throw Error('Unsafe rollback while ingress is open'); },
      verifyPrevious: async () => { calls.push('verifyPrevious'); },
      resume: async () => { calls.push('resume'); publicOpen = true; resumed = true; throw Error('Effect succeeded, acknowledgement lost'); },
    });
    assert.equal(result.status, 'public_state_unknown'); assert.equal(result.public_resumed, null);
    assert.equal(publicOpen, true); assert.equal(rollbacks, candidateFails ? 1 : 0);
    assert.equal(calls.at(-1), 'resume'); assert.equal(calls.filter(c => c === 'resume').length, 1);
  }
  const uncertainFence = await performRollout({ fence: async () => { throw Error('Fence unconfirmed'); },
    verifyPrevious: async () => { throw Error('Identity unconfirmed'); } });
  assert.equal(uncertainFence.status, 'public_state_unknown'); assert.equal(uncertainFence.public_resumed, null);
});

test('remote completion uncertainty stops all follow-up mutations even if activation finishes later', async () => {
  const release = Promise.withResolvers(); let remoteFinished = false, publicOpen = true;
  const delayed = release.promise.then(() => { remoteFinished = true; });
  const calls = [];
  const result = await performRollout({
    fence: async () => { publicOpen = false; }, drain: async () => {},
    activate: async () => { calls.push('activate'); throw Object.assign(Error('SSH acknowledgement lost'), { operation_state_unknown: true, phase: 'activate' }); },
    verifyCandidate: async () => { calls.push('verifyCandidate'); }, rollback: async () => { calls.push('rollback'); },
    verifyPrevious: async () => { calls.push('verifyPrevious'); }, resume: async () => { calls.push('resume'); publicOpen = true; },
  });
  assert.equal(result.status, 'operation_state_unknown'); assert.equal(result.public_resumed, false);
  assert.deepEqual(calls, ['activate']); assert.equal(publicOpen, false);
  release.resolve(); await delayed; assert.equal(remoteFinished, true); assert.equal(publicOpen, false);
});

test('remote adapter distinguishes finished failures from SSH loss, timeout and malformed success', async () => {
  const completed = (status, extra = {}) => JSON.stringify({ phase: 'activate', status, finished_at: '2026-09-21T00:00:00Z', ...extra });
  assert.equal((await runRemotePhase('activate', async () => ({ stdout: completed('pass') }))).status, 'pass');
  await assert.rejects(runRemotePhase('activate', async () => { throw { code: 1, stdout: completed('failed') }; }), e => !e.operation_state_unknown);
  for (const error of [{ code: 255, stdout: '' }, { code: 'ETIMEDOUT', killed: true },
    { code: 1, stdout: '' }, { code: 1, stdout: completed('failed', { operation_state_unknown: true }) }]) {
    await assert.rejects(runRemotePhase('activate', async () => { throw error; }), e => e.operation_state_unknown && e.phase === 'activate');
  }
  await assert.rejects(runRemotePhase('activate', async () => ({ stdout: 'not a completion record' })), e => e.operation_state_unknown);
  const calls = [], release = Promise.withResolvers();
  let activatedLater = false; const pending = release.promise.then(() => { activatedLater = true; });
  const result = await performRollout({ fence: async () => {}, drain: async () => {},
    activate: () => runRemotePhase('activate', async () => { throw { code: 255, stdout: '' }; }),
    rollback: async () => { calls.push('rollback'); }, verifyPrevious: async () => { calls.push('verifyPrevious'); }, resume: async () => { calls.push('resume'); } });
  assert.equal(result.status, 'operation_state_unknown'); assert.deepEqual(calls, []);
  release.resolve(); await pending; assert.equal(activatedLater, true); assert.equal(result.public_resumed, false);
});
