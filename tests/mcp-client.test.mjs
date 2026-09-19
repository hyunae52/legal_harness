import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { KoreanLawClient, koreanLawOptionsFromEnv } from '../dist/koreanLawClient.js';

const fixturePath = fileURLToPath(new URL('./fixtures/law-mcp-server.mjs', import.meta.url));
function fixture(t, changes = {}) {
  const options = koreanLawOptionsFromEnv({
    LAW_OC: 'fixture-only',
    KOREAN_LAW_MCP_COMMAND: process.execPath,
    KOREAN_LAW_MCP_ARGS: JSON.stringify([fixturePath]),
  });
  const client = new KoreanLawClient({ ...options, ...changes });
  t.after(() => client.close());
  return client;
}

test('real stdio handshake, paginated discovery and concurrent calls share one child', async t => {
  const client = fixture(t);
  const results = await Promise.all(Array.from({ length: 3 }, (_, index) => client.callTool('search_law', { query: String(index) })));
  assert.equal(new Set(results.map(result => result.result.structuredContent.pid)).size, 1);
  assert.deepEqual(results.map(result => result.result.structuredContent.callNumber).sort(), [1, 2, 3]);
  for (const result of results) {
    assert.equal(result.result.structuredContent.lists, 2);
    assert.equal(result.result.content[1].uri, 'https://www.law.go.kr/법령/소득세법');
    assert.equal(result.result.structuredContent.effectiveDate, '20250101');
    assert.deepEqual(result.result._meta, { fixture: true });
    assert.equal(result.server.name, 'law-fixture');
    assert.ok(Number.isFinite(Date.parse(result.retrieved_at)));
  }
});

test('tool errors and invalid arguments remain failures without breaking a healthy child', async t => {
  const client = fixture(t);
  const first = await client.callTool('search_law', { query: 'ok' });
  await assert.rejects(client.callTool('search_law', { query: '__error__' }), error =>
    error.status === 502 && error.code === 'MCP_TOOL_ERROR' && error.result.isError === true);
  await assert.rejects(client.callTool('search_law', { query: '__invalid__' }), error => error.status === 400);
  await assert.rejects(client.callTool('not_advertised', {}), error => error.code === 'MCP_UNKNOWN_TOOL');
  const next = await client.callTool('search_law', { query: 'ok' });
  assert.equal(first.result.structuredContent.pid, next.result.structuredContent.pid);
});

test('tool timeout retires the old child and the next request reconnects', async t => {
  const client = fixture(t, { requestTimeoutMs: 100 });
  await client.listTools();
  const first = await client.callTool('search_law', { query: 'ok' });
  const oldPid = first.result.structuredContent.pid;
  await assert.rejects(client.callTool('search_law', { query: '__hang__' }), error => error.status === 504);
  assert.throws(() => process.kill(oldPid, 0), { code: 'ESRCH' });
  await client.listTools();
  const next = await client.callTool('search_law', { query: 'ok' });
  assert.notEqual(next.result.structuredContent.pid, oldPid);
});
test('cold child connection consumes the total retrieval budget; warm calls retain the remaining budget',async t=>{
  const options=koreanLawOptionsFromEnv({LAW_OC:'fixture',KOREAN_LAW_MCP_COMMAND:process.execPath,KOREAN_LAW_MCP_ARGS:JSON.stringify([fixturePath,'--start-delay=600'])});
  const client=fixture(t,{...options,requestTimeoutMs:2000,connectTimeoutMs:2000});
  const started=Date.now();
  await assert.rejects(client.callTool('search_law',{query:'__budget_slow__'}),e=>e.code==='MCP_TIMEOUT');
  assert.ok(Date.now()-started<6500,'slot includes bounded child cleanup');
  await client.listTools();assert.equal((await client.callTool('search_law',{query:'__budget_slow__'})).kind,'retrieval');
  assert.throws(()=>koreanLawOptionsFromEnv({KOREAN_LAW_MCP_TIMEOUT_MS:'45001'}));
});
test('expiration while waiting for retirement retains capacity and cannot spawn an orphan child',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'legal-harness-retirement-'));
  const log=join(directory,'lifecycle.log');await writeFile(log,'');
  const options=koreanLawOptionsFromEnv({LAW_OC:'fixture',KOREAN_LAW_MCP_COMMAND:process.execPath,KOREAN_LAW_MCP_ARGS:JSON.stringify([fixturePath,'--linger-after-eof','--lifecycle-log='+log])});
  const client=fixture(t,{...options,requestTimeoutMs:100,maxConcurrentCalls:2});
  t.after(async()=>{const target=await realpath(directory);assert.equal(dirname(target),await realpath(tmpdir()));assert.ok(basename(target).startsWith('legal-harness-retirement-'));await rm(target,{recursive:true,force:true});});
  await client.listTools();
  const first=assert.rejects(client.callTool('search_law',{query:'__hang__'}),e=>e.code==='MCP_TIMEOUT');
  const until=Date.now()+4000;
  while(!(await readFile(log,'utf8')).includes('eof:')) {assert.ok(Date.now()<until,'child entered actual SDK shutdown');await new Promise(r=>setTimeout(r,20));}
  let secondSettled=false;
  const second=assert.rejects(client.callTool('search_law',{query:'ok'}),e=>e.code==='MCP_TIMEOUT').finally(()=>{secondSettled=true;});
  try {
    await new Promise(r=>setTimeout(r,250));
    assert.equal(secondSettled,false,'the expired waiter still owns its slot until cleanup completes');
    await assert.rejects(client.callTool('search_law',{query:'excess'}),e=>e.code==='MCP_AT_CAPACITY');
  } finally {await Promise.all([first,second]);}
  await new Promise(r=>setTimeout(r,250));
  assert.equal((await readFile(log,'utf8')).match(/^start:/gm)?.length,1,'no child starts without a new live request');
  await client.listTools();assert.equal((await client.callTool('search_law',{query:'ok'})).kind,'retrieval');
  assert.equal((await readFile(log,'utf8')).match(/^start:/gm)?.length,2);
});

test('a crashed child is reported as failure and does not poison later requests', async t => {
  const client = fixture(t);
  await assert.rejects(client.callTool('search_law', { query: '__crash__' }), error => error.status === 502);
  const next = await client.callTool('search_law', { query: 'ok' });
  assert.equal(next.result.structuredContent.callNumber, 1);
});

test('MCP capacity remains bounded independently of HTTP connection lifetime', async t => {
  const client = fixture(t);
  const requests = Array.from({ length: 3 }, () => client.callTool('search_law', { query: '__slow__' }));
  try {
    await assert.rejects(client.callTool('search_law', { query: 'excess' }), error => error.status === 429);
  } finally {
    await Promise.all(requests);
  }
  assert.equal((await client.callTool('search_law', { query: 'ok' })).result.structuredContent.callNumber, 4);
});

test('missing executable and stalled initialization fail within the startup deadline', async t => {
  const options = koreanLawOptionsFromEnv({ LAW_OC: 'fixture' });
  const missing = fixture(t, { server: { ...options.server, command: 'missing-legal-harness-test-executable' } });
  await assert.rejects(missing.listTools(), error => error.status === 503);
  const stalled = fixture(t, {
    server: { ...options.server, command: process.execPath, args: [fixturePath, '--hang-start'] },
    connectTimeoutMs: 100,
  });
  const started = Date.now();
  await assert.rejects(stalled.listTools(), error => error.status === 503);
  assert.ok(Date.now() - started < 6000);
});

test('closing the client reaps its child and prevents accidental respawn', async t => {
  const client = fixture(t);
  const result = await client.callTool('search_law', { query: 'ok' });
  await client.close();
  assert.throws(() => process.kill(result.result.structuredContent.pid, 0), { code: 'ESRCH' });
  await assert.rejects(client.listTools(), error => error.code === 'MCP_CLOSED');
});

test('only explicit law settings reach the child, and absent LAW_OC cannot produce legal data', async t => {
  const keys = ['SUPABASE_ANON_KEY', 'GITHUB_TOKEN', 'NODE_OPTIONS'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  t.after(() => {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  });
  process.env.SUPABASE_ANON_KEY = 'must-not-inherit';
  process.env.GITHUB_TOKEN = 'must-not-inherit';
  process.env.NODE_OPTIONS = '--stack-trace-limit=2';
  const client = fixture(t);
  const result = await client.callTool('search_law', { query: 'ok' });
  assert.equal(result.result.structuredContent.inheritedSecrets, false);
  assert.equal(result.result.structuredContent.hasLawKey, true);
  const noKey = new KoreanLawClient(koreanLawOptionsFromEnv({}));
  t.after(() => noKey.close());
  await assert.rejects(noKey.callTool('search_law', { query: 'ok' }), error => error.code === 'MCP_NOT_CONFIGURED');
});

test('installed korean-law-mcp release starts over stdio and advertises real tool schemas without API calls', async t => {
  const client = new KoreanLawClient(koreanLawOptionsFromEnv({}));
  t.after(() => client.close());
  const catalog = await client.listTools();
  assert.equal(catalog.server.name, 'korean-law');
  for (const name of ['legal_research', 'search_law', 'get_law_text', 'search_decisions', 'get_decision_text']) {
    assert.ok(catalog.tools.some(tool => tool.name === name && tool.inputSchema.type === 'object'), name);
  }
});

test('deployment release file selects the verified upstream executable and rejects conflicting manual settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'legal-harness-release-'));
  t.after(async () => {
    const target = await realpath(directory);
    assert.equal(dirname(target), await realpath(tmpdir()));
    assert.ok(basename(target).startsWith('legal-harness-release-'));
    await rm(target, { recursive: true, force: true });
  });
  const entrypoint = fileURLToPath(import.meta.resolve('korean-law-mcp'));
  const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.resolve('korean-law-mcp')), 'utf8'));
  const releaseFile = join(directory, 'active.json');
  await writeFile(releaseFile, JSON.stringify({ version: metadata.version, entrypoint }));
  const env = { KOREAN_LAW_MCP_RELEASE_FILE: releaseFile };
  const options = koreanLawOptionsFromEnv(env);
  assert.equal(options.server.args[0], entrypoint);
  assert.equal(options.releaseVersion, metadata.version);
  assert.throws(() => koreanLawOptionsFromEnv({ ...env, KOREAN_LAW_MCP_ARGS: '[]' }), /not both/);
  const client = new KoreanLawClient(options);
  t.after(() => client.close());
  assert.equal((await client.listTools()).server.version, metadata.version);
});

test('a process whose version differs from its release manifest cannot initialize successfully', async t => {
  const client = fixture(t, { releaseVersion: '9.9.9' });
  await assert.rejects(client.listTools(), error => error.code === 'MCP_UNAVAILABLE');
});
