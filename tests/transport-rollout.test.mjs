import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { runRemotePhase } from '../deploy/remote-phase.mjs';
import { performRollout } from '../scripts/rollout-gate.mjs';

test('TRD-01: live smoke, orphan provider and uncertain observation block every recovery mutation', async () => {
  const cases = JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-B', 'tests/fixtures/transport-smoke-faults.py'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }));
  for (const [name, event] of Object.entries(cases)) {
    const calls = [];
    const result = await performRollout({ fence: async () => {}, drain: async () => {}, activate: async () => {},
      verifyCandidate: () => runRemotePhase('verify-candidate', async () => { throw { code: 1, stdout: JSON.stringify(event) }; }),
      rollback: async () => { calls.push('rollback'); }, verifyPrevious: async () => { calls.push('verifyPrevious'); },
      resume: async () => { calls.push('resume'); } });
    if (name === 'finished_assertion') {
      assert.equal(event.operation_state_unknown, undefined);
      assert.deepEqual(calls, ['rollback', 'verifyPrevious', 'resume']);
      assert.equal(result.status, 'previous_restored_verified');
    } else {
      assert.equal(event.operation_state_unknown, true, name);
      assert.deepEqual(calls, [], name);
      assert.equal(result.status, 'operation_state_unknown');
      assert.equal(result.public_resumed, false);
    }
  }
});
