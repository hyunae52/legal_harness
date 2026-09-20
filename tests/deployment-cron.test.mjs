import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
test('cron freeze refuses pre-exec dispatched work and resumes only after verified quiescence', () => {
  const result = execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', 'tests/fixtures/cron-freeze-check.py'], {encoding:'utf8'});
  assert.deepEqual(JSON.parse(result), {status:'pass',checks:process.platform==='linux'?5:4});
});
