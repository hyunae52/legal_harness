import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { spawnSync } from 'node:child_process';
import { UsageStore, configuredUsage, meterSourceClient, readUsage } from '../dist/usage.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'taxlab-usage-')), path = join(directory, 'usage.sqlite'), stores = [];
  t.after(async () => { for (const store of stores) store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, path, open(now, monotonic) { const store = new UsageStore(path, now, monotonic); stores.push(store); return store; } };
}

test('U03: KST start dates, successes/failures and weighted duration survive reopen', async t => {
  const f = await fixture(t);
  let wall = Date.parse('2026-10-17T14:59:59.900Z'), elapsed = 0;
  const store = f.open(() => wall, () => elapsed);
  store.registerTools(['search_law']);
  const finish = store.start('mcp', 'search_law');
  wall += 200; elapsed = 200; finish(true); finish(false);
  const fail = store.start('mcp', 'search_law'); elapsed = 500; fail(false);
  store.close();
  const again = f.open(() => wall, () => elapsed); again.registerTools(['search_law']);
  const success = again.start('mcp', 'search_law'); elapsed = 600; success(true);
  const report = readUsage(f.path, 2, wall);
  assert.deepEqual(report.daily_tools.map(r => [r.day, r.calls, r.successes, r.failures, r.mean_ms]), [
    ['2026-10-17', 1, 1, 0, 200], ['2026-10-18', 2, 1, 1, 200],
  ]);
  assert.deepEqual(report.totals.mcp, { calls: 3, successes: 2, failures: 1, duration_ms: 600, max_ms: 300, mean_ms: 200 });
  assert.equal(report.started_at, '2026-10-17T14:59:59.900Z');
});

test('U03: independent connections atomically add to the same persisted aggregate', async t => {
  const f = await fixture(t), now = Date.parse('2026-10-18T01:00:00Z');
  const a = f.open(() => now, () => 0), b = f.open(() => now, () => 0);
  for (const store of [a, b]) store.registerTools(['search_law']);
  for (let i = 0; i < 8; i++) { a.start('source', 'search_law')(true); b.start('source', 'search_law')(false); }
  assert.equal(readUsage(f.path, 1, now).totals.source.calls, 16);
  assert.equal(readUsage(f.path, 1, now).totals.source.failures, 8);
});

test('U04: arbitrary tool names collapse and arguments/results never enter persisted storage', async t => {
  const f = await fixture(t), store = f.open(); store.registerTools(['search_law']);
  const privateText = 'PRIVATE_QUERY_BODY_SECRET_481237';
  for (let i = 0; i < 280; i++) store.start('mcp', privateText + i)(false);
  const value = { content: [{ type: 'text', text: privateText }] };
  assert.equal(await store.measure('mcp', 'search_law', async () => value), value);
  const report = readUsage(f.path, 1);
  assert.equal(report.daily_tools.length, 2);
  assert.equal(report.daily_tools.find(r => r.tool === '_unknown').calls, 280);
  for (const name of await readdir(f.directory)) assert.equal((await readFile(join(f.directory, name))).includes(Buffer.from(privateText)), false);
});

test('U05: busy storage does not replace a successful result or a provider error', async t => {
  const f = await fixture(t), store = f.open(); store.registerTools(['search_law']);
  const blocker = new DatabaseSync(f.path); blocker.exec('BEGIN IMMEDIATE');
  const result = { result: { content: [] } }, failure = Error('PRIVATE_PROVIDER_ERROR');
  try {
    assert.equal(await store.measure('source', 'search_law', async () => result), result);
    await assert.rejects(store.measure('source', 'search_law', async () => { throw failure; }), error => error === failure);
    assert.deepEqual(store.status(), { enabled: true, healthy: false, failed_writes: 2 });
  } finally { blocker.exec('ROLLBACK'); blocker.close(); }
  assert.deepEqual(readUsage(f.path, 1).totals, {});
  await store.measure('source', 'search_law', async () => result);
  assert.equal(readUsage(f.path, 1).totals.source.calls, 1);
});

test('U05: retention removes days outside 400-day window and reports are read-only', async t => {
  const f = await fixture(t);
  let wall = Date.parse('2025-01-01T00:00:00Z');
  const store = f.open(() => wall, () => 0); store.registerTools(['search_law']);
  store.start('mcp', 'search_law')(true);
  wall += 400 * 86400000; store.start('mcp', 'search_law')(true);
  const reader = new DatabaseSync(f.path, { readOnly: true });
  try { assert.equal(reader.prepare('SELECT sum(calls) AS n FROM usage_daily').get().n, 1); } finally { reader.close(); }
  assert.equal(readUsage(f.path, 400, wall).totals.mcp.calls, 1);
  assert.throws(() => readUsage(f.path, 401, wall), /USAGE_REPORT_INPUT/);
  const missing = join(f.directory, 'missing.sqlite'); assert.throws(() => readUsage(missing));
  await assert.rejects(access(missing));
});

test('U01/U02/U05: returned MCP error is a failure; metering does not add catalog I/O', async t => {
  const f = await fixture(t), store = f.open(); store.registerTools(['search_law']);
  const source = { releaseVersion: 'fixture', listTools: async () => { throw Error('discovery unavailable'); },
    callTool: async () => ({ result: { isError: true, content: [] } }) };
  const metered = meterSourceClient(source, store);
  assert.equal(metered.releaseVersion, 'fixture');
  assert.equal((await metered.callTool('search_law', {})).result.isError, true);
  const report = readUsage(f.path, 1); assert.equal(report.totals.source.failures, 1);
  assert.equal(report.totals.mcp, undefined);
});

test('U06: accounting is opt-in, bad storage is visible but does not stop the operation', async () => {
  assert.equal(configuredUsage({}), undefined);
  const usage = configuredUsage({ TAXLAB_USAGE_DB: 'relative.sqlite' });
  assert.equal(usage.status().healthy, false);
  assert.equal(await usage.measure('mcp', 'search_law', async () => 'success'), 'success');
  usage.close();
});

test('U05: operator CLI reports persisted aggregates without exposing a public endpoint', async t => {
  const f = await fixture(t), store = f.open(); store.registerTools(['search_law']);
  store.start('mcp', 'search_law')(true);
  const command = spawnSync(process.execPath, ['dist/usageReport.js', '--database', f.path, '--days', '7', '--json'], { encoding: 'utf8' });
  assert.equal(command.status, 0, command.stderr);
  const report = JSON.parse(command.stdout); assert.equal(report.totals.mcp.calls, 1); assert.equal(report.timezone, 'Asia/Seoul');
});
