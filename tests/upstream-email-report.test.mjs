import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emailConfigFileIsSecure, prepareEmail, sendUpstreamEmail } from '../scripts/upstream-email-report.mjs';

const checkedAt = '2026-09-25T18:30:00.000Z';
const report = {
  installed: { law: { version: '4.14.2' }, taxlaw: { version: '2.0.0.post1', commit: 'a'.repeat(40) } },
  candidates: [],
  sources: { law_package: { status: 'ok' }, taxlaw_repository: { status: 'ok' } },
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'taxlab-email-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = join(root, 'upstream-email.env');
  await writeFile(configPath, [
    'SMTP_HOST=smtp.gmail.com', 'SMTP_PORT=465', 'SMTP_SECURE=true',
    'SMTP_USER=cta@planbtax.co.kr', 'SMTP_APP_PASSWORD=example-app-password',
    'ALERT_EMAIL_TO=cta@planbtax.co.kr', '',
  ].join('\n'), { mode: 0o600 });
  const stateDirectory = join(root, 'state');
  await mkdir(stateDirectory, { mode: 0o700 });
  return { root, configPath, stateDirectory };
}

test('email summary records deployed versions and uses recovery after a failed check', () => {
  const normal = prepareEmail(report, { status: 'current', checked_at: checkedAt });
  assert.match(normal.subject, /^\[정상\]/);
  assert.match(normal.text, /4\.14\.2/);
  assert.match(normal.text, /2\.0\.0\.post1/);
  const recovery = prepareEmail(report, { status: 'current', checked_at: checkedAt }, { status: 'partial' });
  assert.match(recovery.subject, /^\[복구\]/);
});

test('successful delivery is recorded and an identical execution is not sent twice', async t => {
  const paths = await fixture(t);
  const deliveries = [];
  const transportFactory = options => ({ sendMail: async message => {
    deliveries.push({ options, message });
    return { messageId: 'test-message', rejected: [] };
  } });
  const input = { ...paths, report, execution: { status: 'current', checked_at: checkedAt }, transportFactory };
  assert.deepEqual(await sendUpstreamEmail(input), { sent: true, message_id: 'test-message' });
  assert.deepEqual(await sendUpstreamEmail(input), { sent: false, reason: 'duplicate' });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].options.auth.user, 'cta@planbtax.co.kr');
  assert.match(deliveries[0].message.subject, /^\[정상\]/);
  const state = JSON.parse(await readFile(join(paths.stateDirectory, 'email-state.json'), 'utf8'));
  assert.equal(state.status, 'current');
  assert.equal(state.recipient, 'cta@planbtax.co.kr');
});

test('Linux credentials file must be private and owned by the running user', () => {
  const metadata = { isFile: () => true, size: 100, mode: 0o100600, uid: 1000 };
  assert.equal(emailConfigFileIsSecure(metadata, 'linux', 1000), true);
  assert.equal(emailConfigFileIsSecure({ ...metadata, mode: 0o100640 }, 'linux', 1000), false);
  assert.equal(emailConfigFileIsSecure(metadata, 'linux', 1001), false);
});

test('an SMTP rejection does not advance notification state', async t => {
  const paths = await fixture(t);
  const transportFactory = () => ({ sendMail: async () => { throw new Error('SMTP secret detail'); } });
  await assert.rejects(sendUpstreamEmail({ ...paths, report,
    execution: { status: 'partial', checked_at: checkedAt }, transportFactory }), /SMTP secret detail/);
  await assert.rejects(readFile(join(paths.stateDirectory, 'email-state.json')), error => error.code === 'ENOENT');
});
