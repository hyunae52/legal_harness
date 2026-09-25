import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runWatch } from '../scripts/run-upstream-watch.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'taxlab-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDirectory = join(root, 'state');
  await mkdir(stateDirectory);
  return { stateDirectory, configPath: join(root, 'upstream-email.env'), service: 'legal-harness-a.service' };
}

test('watch sends the fresh report from a successful check', async t => {
  const options = await fixture(t);
  const checkedAt = '2026-09-25T18:30:00.000Z';
  const report = { checked_at: checkedAt, status: 'current', installed: { law: { version: '4.14.2' } } };
  await writeFile(join(options.stateDirectory, 'latest.json'), JSON.stringify(report));
  let delivered;
  const result = await runWatch(options, {
    spawn: () => ({ status: 0, stdout: `${JSON.stringify({ checked_at: checkedAt, status: 'current' })}\n`, stderr: '' }),
    send: async input => { delivered = input; return { sent: true }; },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(delivered.execution, { checked_at: checkedAt, status: 'current' });
  assert.deepEqual(delivered.report, report);
});

test('watch sends a redacted failure record when the check cannot produce a report', async t => {
  const options = await fixture(t);
  let delivered;
  const result = await runWatch(options, {
    spawn: () => ({ status: 1, stdout: '', stderr: '{"status":"check_failed"}\n' }),
    send: async input => { delivered = input; return { sent: true }; },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(delivered.execution.status, 'check_failed');
  assert.equal(delivered.report, null);
});
