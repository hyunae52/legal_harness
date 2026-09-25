// Explicit live integration test: public official documents, no production account or credentials.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { KoreanLawClient, koreanLawOptionsFromEnv } from '../dist/koreanLawClient.js';
import { createLegalRetrievalClient, taxLawOptionsFromEnv } from '../dist/taxLawClient.js';
import { createApp } from '../dist/app.js';

if (!process.argv.includes('--live')) throw new Error('Use --live to query public NTS documents.');
if (!taxLawOptionsFromEnv()) throw new Error('Run the pinned tax-law installer first.');
const law = createLegalRetrievalClient(new KoreanLawClient(koreanLawOptionsFromEnv({})));
const runtime = createApp({ law, env: { TAXLAB_API_KEY: 'local-smoke-only' } });
const server = runtime.app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const headers = { Authorization: 'Bearer local-smoke-only', 'Content-Type': 'application/json' };
const client = new Client({ name: 'taxlab-live-taxlaw-check', version: '1' });
const evidence = { observed_at: new Date().toISOString(), scope: 'local Express REST and SSE to pinned real tax-law stdio child', calls: [], checks: [] };
async function call(name, args, expectedError) {
  const start = Date.now();
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60000 });
  evidence.calls.push({ name, args, duration_ms: Date.now() - start, result });
  if (expectedError) {
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.error?.code, expectedError);
  } else assert.notEqual(result.isError, true, JSON.stringify(result));
  console.log(JSON.stringify({ tool: name, document: args.document_number ?? args.ntst_dcm_id ?? args.query, status: expectedError ?? 'OK', duration_ms: Date.now() - start }));
  return result.structuredContent;
}
try {
  await client.connect(new SSEClientTransport(new URL(origin + '/sse'), { requestInit: { headers } }), { timeout: 30000 });
  const tools = await client.listTools({}, { timeout: 30000 });
  evidence.tool_names = tools.tools.map(t => t.name);
  for (const name of ['lookup_tax_document', 'search_tax_interpretations', 'search_tax_decisions', 'get_tax_document', 'tax_research']) assert.ok(evidence.tool_names.includes(name));
  const search = await call('search_tax_interpretations', { query: '서면-2020-부동산-4503', limit: 3 });
  assert.equal(search.items[0].documentNumber, '서면-2020-부동산-4503');
  const docs = [
    ['서면-2020-부동산-4503', ['facts', 'question', 'answer']],
    ['서면-2026-법규재산-0119', ['facts', 'question', 'answer']],
    ['서면-2026-법규재산-0109', ['facts', 'question', 'answer']],
    ['조심-2025-인-4460', ['facts', 'reasoning', 'conclusion']],
    ['적부-국세청-2026-0119', ['facts', 'claimantView', 'agencyView', 'reasoning', 'conclusion']],
  ];
  for (const [number, fields] of docs) {
    const data = await call('lookup_tax_document', { document_number: number, include_full_text: true, detail: 'full', body_limit: 60000 });
    assert.equal(data.exactMatch, true); assert.equal(data.document.documentNumber, number);
    assert.match(data.document.sourceUrl, /^https:\/\/taxlaw\.nts\.go\.kr\//);
    for (const key of fields) assert.ok(data.document[key]?.length > 10, `${number} missing ${key}`);
    evidence.checks.push({ document_number: number, fields: Object.fromEntries(fields.map(key => [key, data.document[key].length])) });
  }
  const same = await call('get_tax_document', { ntst_dcm_id: search.items[0].ntstDcmId, detail: 'full' });
  assert.equal(same.document.documentNumber, '서면-2020-부동산-4503');
  const variant = await call('lookup_tax_document', { document_number: '서면 2026 법규재산 0119' });
  assert.equal(variant.document.documentNumber, '서면-2026-법규재산-0119');
  const ambiguous = await call('lookup_tax_document', {
    document_number: '법인46012-1784', include_full_text: false,
  }, 'AMBIGUOUS_DOCUMENT_NUMBER');
  assert.deepEqual(new Set(ambiguous.error.detail.candidates.map(item => item.ntstDcmId)), new Set([
    '010000000000091224', '010000000000062896',
  ]));
  const resolved = await call('lookup_tax_document', {
    document_number: '법인46012-1784', context_query: '퇴직금', include_full_text: false,
  });
  assert.equal(resolved.resolvedBy, 'document_number_and_context');
  assert.equal(resolved.document.ntstDcmId, '010000000000062896');
  const limited = await call('get_tax_document', { ntst_dcm_id: search.items[0].ntstDcmId, body_limit: 500 });
  assert.ok(JSON.stringify(limited).includes('나머지는 sourceUrl 원문에서 확인하세요'), 'truncation must not be silent');
  await call('lookup_tax_document', { document_number: '법규재산-0119' }, 'NOT_FOUND');
  await call('get_tax_document', { ntst_dcm_id: 'invalid' }, 'INVALID_INPUT');
  const rest = await fetch(origin + '/api/analyze', { method: 'POST', headers, body: JSON.stringify({ tool: 'lookup_tax_document', query: '공유물 분할 원문', arguments: { document_number: '서면-2020-부동산-4503' } }) });
  assert.equal(rest.status, 200);
  evidence.rest = await rest.json();
  assert.equal(evidence.rest.data.evidence.upstream_name, 'korean-taxlaw');
  assert.equal(evidence.rest.data.evidence.upstream_version, '2.0.0');
  assert.equal(evidence.rest.data.result.structuredContent.document.documentNumber, '서면-2020-부동산-4503');
  evidence.status = 'passed';
} catch (error) {
  evidence.status = 'failed'; evidence.error = { name: error.name, message: error.message };
  console.error(error); process.exitCode = 1;
} finally {
  await client.close().catch(() => {});
  await runtime.close();
  await new Promise(resolve => server.close(resolve));
  await mkdir('.runtime/taxlaw', { recursive: true });
  await writeFile('.runtime/taxlaw/live-integration.json', JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify({ status: evidence.status, documents: evidence.checks.length, mcp_calls: evidence.calls.length, evidence: '.runtime/taxlaw/live-integration.json' }));
}
