import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { OutcomeRecorder, validOutcomeEvent, readOutcomeReport } from '../dist/outcomeStore.js';
import { UsageStore, readMorningUsage } from '../dist/usage.js';
import { prepareUsageMail } from '../dist/usageMail.js';

const event = { tool: 'search_tax_interpretations', operation: 'list_search', outcome: 'empty_confirmed',
  provider: 'nts', provider_version: '2.1.0.post2', code: 'NOT_FOUND' };
test('O15: queue bounded to 128, invalid data rejected, worker failure never throws to caller', () => {
  class Fake extends EventEmitter { messages = []; unref() {} postMessage(value) { this.messages.push(value); } terminate() { return Promise.resolve(); } }
  const worker = new Fake(), recorder = new OutcomeRecorder(join(tmpdir(), 'unused-outcomes.sqlite'), () => worker);
  for (let i = 0; i < 1000; i++) recorder.record(event);
  assert.equal(worker.messages.length, 128); assert.equal(recorder.status().dropped, 872);
  assert.equal(validOutcomeEvent({ ...event, query: 'sensitive' }), false);
  assert.equal(validOutcomeEvent({ ...event, provider_version: 'arbitrary text' }), false);
  worker.emit('error', Error('storage down')); recorder.record(event);
  assert.equal(recorder.status().healthy, false); recorder.close();
});

test('O16: completion boundary, separate DB, retry counts, missing data and mail definitions', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'outcome-test-'));
  let recorder;
  t.after(async () => { recorder?.close(); await delay(100); assert.equal(dirname(directory), tmpdir()); await rm(directory, { recursive: true, force: true }); });
  const db = join(directory, 'usage.sqlite'), out = db + '.outcomes.sqlite';
  const boundary = Date.parse('2026-11-09T21:00:00Z');
  let now = boundary - 1;
  const usage = new UsageStore(db, () => now); usage.registerTools([event.tool]);
  recorder = new OutcomeRecorder(out);
  for (let i = 0; i < 100 && !recorder.status().ready; i++) await delay(20);
  assert.equal(recorder.status().ready, true);
  for (let i = 0; i < 2; i++) { usage.start('source', event.tool)(true); recorder.record(event, now); }
  usage.start('source', event.tool)(false, 'TIMEOUT'); // Simulate a dropped outcome, never fill it with zero.
  const finish = usage.start('source', event.tool); now = boundary + 1; finish(true); recorder.record(event, now);
  for (let i = 0; i < 100 && recorder.status().queued; i++) await delay(20);
  assert.equal(recorder.status().queued, 0);
  const report = readMorningUsage(db, boundary + 1000), summary = readOutcomeReport(out, report);
  assert.equal(report.totals.source.calls, 3); assert.equal(summary.recorded, 2); assert.equal(summary.missing, 1); assert.equal(summary.state, 'partial');
  const next = readOutcomeReport(out, readMorningUsage(db, boundary + 86400000));
  assert.equal(next.recorded, 1); assert.equal(next.expected, 1);
  const mail = prepareUsageMail(report, false, summary);
  assert.match(mail.text, /정상 검색 0건/); assert.match(mail.text, /부분 집계/); assert.match(mail.text, /검색 적중률 향상을 뜻하지/);
  assert.equal(readOutcomeReport(join(directory, 'missing.sqlite'), report).state, 'uncollected');
  assert.match(prepareUsageMail(report, false, readOutcomeReport(join(directory, 'missing.sqlite'), report)).text, /미수집/);
  usage.close(); recorder.close(); await delay(100);
  const bytes = await readFile(out);
  assert.ok(!bytes.includes(Buffer.from('sensitive')));
  assert.ok((await readdir(directory)).includes('usage.sqlite'));
});
