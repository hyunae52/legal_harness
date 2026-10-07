import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('model quality evidence rejects missing bytes, failed reviews and stale answer readiness', () => {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    [fileURLToPath(new URL('./pilot_evidence_test.py', import.meta.url))], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Ran 6 tests/);
});
