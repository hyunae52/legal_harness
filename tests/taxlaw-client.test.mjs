import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { KoreanLawClient, koreanLawOptionsFromEnv } from '../dist/koreanLawClient.js';
import { TaxLawClient, LegalRetrievalClient, normalizeTaxLawResult, taxLawOptionsFromEnv, taxLawTools } from '../dist/taxLawClient.js';
import { createApp } from '../dist/app.js';

const fixturePath = fileURLToPath(new URL('./fixtures/taxlaw-mcp-server.mjs', import.meta.url));
const response = (label, data) => ({ isError: false, content: [{ type: 'text', text: `[${label}]\n${JSON.stringify(data)}` }], structuredContent: { result: `[${label}]\n${JSON.stringify(data)}` } });
function fixture(t, changes = {}) {
  const managed = new KoreanLawClient({ server: { command: process.execPath, args: [fixturePath], env: {}, cwd: dirname(fixturePath) },
    credentialPolicy: 'none', providerName: 'korean-taxlaw', releaseVersion: '2.0.0', connectTimeoutMs: 3000, requestTimeoutMs: 3000, maxConcurrentCalls: 2, ...changes });
  const client = new TaxLawClient(managed);
  t.after(() => client.close());
  return { managed, client };
}

test('pinned lookup schema exposes duplicate-number context', () => {
  const lookup = taxLawTools.find(tool => tool.name === 'lookup_tax_document');
  assert.equal(lookup.inputSchema.properties.context_query.description, '중복 문서번호를 구분할 주제 키워드. 중복일 때만 사용.');
  assert.equal(lookup.inputSchema.additionalProperties, false);
});

test('NTS application failures cannot become successful retrievals even when MCP isError is false', () => {
  for (const [code, status] of Object.entries({ NOT_FOUND: 404, DETAIL_NOT_AVAILABLE: 502, UPSTREAM_ERROR: 502, PARSE_ERROR: 502, RATE_LIMITED: 429, INVALID_INPUT: 400, AMBIGUOUS_DOCUMENT_NUMBER: 409, TIMEOUT: 504 })) {
    assert.throws(() => normalizeTaxLawResult(response(code, { ok: false, error: { code, message: 'source result' } })), error =>
      error.code === 'MCP_TOOL_ERROR' && error.status === status && error.result.isError && error.result.structuredContent.error.code === code);
  }
  for (const value of [response('OK', { ok: false }), response('UNKNOWN', {}), response('NOT_FOUND', { ok: false, error: { code: 'UPSTREAM_ERROR', message: 'wrong' } }), { content: [{ type: 'text', text: 'not JSON' }] }]) {
    assert.throws(() => normalizeTaxLawResult(value), e => e.code === 'TAXLAW_INVALID_RESPONSE');
  }
  const empty = normalizeTaxLawResult(response('OK', { total: 0, items: [] }));
  assert.equal(empty.isError, false); assert.equal(empty.structuredContent.total, 0);
});

test('real tax-law child uses no OC key, preserves structured facts and survives source errors', async t => {
  const { client } = fixture(t);
  const first = await client.callTool('lookup_tax_document', { document_number: '서면-2020-부동산-4503' });
  assert.equal(first.result.structuredContent.document.answer, 'fixture answer');
  assert.equal(first.result.structuredContent.fixture.law_oc, false);
  assert.equal(first.result.structuredContent.fixture.secret, false);
  await assert.rejects(client.callTool('lookup_tax_document', { document_number: '__missing__' }), e => e.status === 404);
  await assert.rejects(client.callTool('lookup_tax_document', { document_number: '__offline__' }), e => e.status === 502);
  const next = await client.callTool('lookup_tax_document', { document_number: '다음 조회' });
  assert.equal(first.result.structuredContent.fixture.pid, next.result.structuredContent.fixture.pid);
});

test('duplicate document numbers require context and preserve candidates for the caller', async t => {
  const { client } = fixture(t);
  await assert.rejects(client.callTool('lookup_tax_document', { document_number: '__ambiguous__' }), error =>
    error.status === 409
      && error.result.structuredContent.error.code === 'AMBIGUOUS_DOCUMENT_NUMBER'
      && error.result.structuredContent.error.detail.candidates.length === 2);
  const selected = await client.callTool('lookup_tax_document', {
    document_number: '__ambiguous__', context_query: '퇴직금',
  });
  assert.equal(selected.result.structuredContent.fixture.args.context_query, '퇴직금');
});

test('tax-law hangs retire the actual child and recover without affecting the statute provider', async t => {
  const { managed, client } = fixture(t, { requestTimeoutMs: 100 });
  await managed.listTools();
  const first = await client.callTool('lookup_tax_document', { document_number: 'first' });
  const oldPid = first.result.structuredContent.fixture.pid;
  await assert.rejects(client.callTool('lookup_tax_document', { document_number: '__hang__' }), e => e.code === 'MCP_TIMEOUT');
  assert.throws(() => process.kill(oldPid, 0), { code: 'ESRCH' });
  await managed.listTools();
  assert.notEqual((await client.callTool('lookup_tax_document', { document_number: 'again' })).result.structuredContent.fixture.pid, oldPid);
});

test('a found lookup without a body cannot be reported as a successful full-text read', async t => {
  const { client } = fixture(t);
  await assert.rejects(client.callTool('lookup_tax_document', { document_number: '__body_missing__' }), e =>
    e.status === 502 && e.result.structuredContent.error.code === 'DETAIL_NOT_AVAILABLE');
  const metadata = await client.callTool('lookup_tax_document', { document_number: '__body_missing__', include_full_text: false });
  assert.equal(metadata.result._meta['legal-harness/taxlaw'].body_scope, 'unavailable');
  assert.equal(metadata.result._meta['legal-harness/taxlaw'].completeness, 'unverified');
});

test('provider routing never treats a MOLEG serial number as an NTS document ID', async t => {
  const { client } = fixture(t);
  let statuteCalls = 0;
  const law = { releaseVersion: '4.13.0', listTools: async () => ({ tools: [{ name: 'search_law' }] }), callTool: async () => { statuteCalls++; return 'law result'; }, close: async () => {} };
  const all = new LegalRetrievalClient(law, client);
  assert.equal((await all.listTools()).tools.length, 13);
  await assert.rejects(all.callTool('get_decision_text', { domain: 'nts', id: '212174' }), e => e.status === 400 && JSON.stringify(e.result).includes('NTS_ID_REQUIRED'));
  const doc = await all.callTool('get_decision_text', { domain: 'nts', id: '010000000000575140' });
  assert.equal(doc.result.structuredContent.document.ntstDcmId, '010000000000575140');
  assert.equal(await all.callTool('search_law', { query: '상법' }), 'law result');
  assert.equal(statuteCalls, 1);
  await assert.rejects(new LegalRetrievalClient(law).callTool('lookup_tax_document', {}), e => e.code === 'TAXLAW_NOT_CONFIGURED');
});

test('release selection pins version and commit and does not inherit application credentials', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'taxlaw-config-'));
  t.after(async () => { const target = await realpath(directory); assert.equal(dirname(target), await realpath(tmpdir())); assert.ok(basename(target).startsWith('taxlaw-config-')); await rm(target, { recursive: true, force: true }); });
  const manifest = join(directory, 'active.json');
  const data = { version: '2.0.0.post1', commit: '72f6e7fc14f2e92b5580ca1ad2ccfaec9fbfec13', python: process.execPath, cwd: directory };
  await writeFile(manifest, JSON.stringify(data));
  const options = taxLawOptionsFromEnv({ TAXLAW_MCP_RELEASE_FILE: manifest, LAW_OC: 'secret', SUPABASE_SERVICE_ROLE_KEY: 'secret', GITHUB_TOKEN: 'secret', PYTHONPATH: 'bad' });
  assert.equal(options.credentialPolicy, 'none');
  assert.equal(options.maxConcurrentCalls, 2);
  for (const key of ['LAW_OC', 'SUPABASE_SERVICE_ROLE_KEY', 'GITHUB_TOKEN', 'PYTHONPATH']) assert.equal(options.server.env[key], undefined);
  assert.deepEqual(options.server.args, ['-I', '-X', 'utf8', '-m', 'korean_taxlaw_mcp']);
  await writeFile(manifest, JSON.stringify({ ...data, commit: '0'.repeat(40) }));
  assert.throws(() => taxLawOptionsFromEnv({ TAXLAW_MCP_RELEASE_FILE: manifest }));
  assert.throws(() => taxLawOptionsFromEnv({ TAXLAW_MCP_RELEASE_FILE: join(directory, 'missing.json') }));
});

test('authenticated REST and SSE expose NTS tools and actual provider provenance; source failure stays failure', async t => {
  const { client } = fixture(t);
  const law = new KoreanLawClient(koreanLawOptionsFromEnv({ LAW_OC: 'fixture', KOREAN_LAW_MCP_COMMAND: process.execPath,
    KOREAN_LAW_MCP_ARGS: JSON.stringify([fileURLToPath(new URL('./fixtures/law-mcp-server.mjs', import.meta.url))]) }));
  const runtime = createApp({ law: new LegalRetrievalClient(law, client), env: { TAXLAB_API_KEY: 'fixture-test-key' } });
  const server = runtime.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await runtime.close(); await new Promise(resolve => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: 'Bearer fixture-test-key', 'Content-Type': 'application/json' };
  const input = { tool: 'search_tax_interpretations', query: '공유물 분할', arguments: { limit: 3 } };
  assert.equal((await fetch(origin + '/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })).status, 401);
  const result = await (await fetch(origin + '/api/analyze', { method: 'POST', headers, body: JSON.stringify(input) })).json();
  assert.equal(result.data.result.structuredContent.fixture.args.query, '공유물 분할');
  assert.equal(result.data.evidence.upstream_name, 'korean-taxlaw');
  assert.equal(result.data.evidence.upstream_version, '2.0.0');
  assert.equal(result.data.evidence.applicability, 'unverified');
  const missing = await fetch(origin + '/api/analyze', { method: 'POST', headers, body: JSON.stringify({ tool: 'lookup_tax_document', query: 'lookup', arguments: { document_number: '__missing__' } }) });
  assert.equal(missing.status, 404); assert.equal((await missing.json()).result.structuredContent.error.code, 'NOT_FOUND');
  const mcp = new Client({ name: 'nts-integration-test', version: '1' });
  t.after(() => mcp.close());
  await mcp.connect(new SSEClientTransport(new URL(origin + '/sse'), { requestInit: { headers } }));
  const names = (await mcp.listTools()).tools.map(t => t.name);
  for (const tool of taxLawTools) assert.ok(names.includes(tool.name));
  const read = await mcp.callTool({ name: 'lookup_tax_document', arguments: { document_number: '서면-2020-부동산-4503' } });
  assert.equal(read.structuredContent.document.question, 'fixture question');
  assert.equal(read._meta['legal-harness/evidence'].upstream_name, 'korean-taxlaw');
  const unavailable = await mcp.callTool({ name: 'lookup_tax_document', arguments: { document_number: '__offline__' } });
  assert.equal(unavailable.isError, true); assert.equal(unavailable.structuredContent.error.code, 'UPSTREAM_ERROR');
});
