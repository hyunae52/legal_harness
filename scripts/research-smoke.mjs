// Explicit live read, also used by the operator against the staged and public release.
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdir, writeFile } from 'node:fs/promises';
import dotenv from 'dotenv';
if (!process.argv.includes('--live')) throw Error('Use --live for the explicit source read.');
dotenv.config();
let runtime, server;
let origin = process.env.TAXLAB_SERVER_URL;
let key = process.env.TAXLAB_API_KEY;
if (!origin) {
  const { createApp } = await import('../dist/app.js');
  const { createKoreanLawClient } = await import('../dist/koreanLawClient.js');
  const { createLegalRetrievalClient } = await import('../dist/taxLawClient.js');
  key = 'local-research-smoke';
  runtime = createApp({ env: { TAXLAB_API_KEY: key }, law: createLegalRetrievalClient(createKoreanLawClient()) });
  server = runtime.app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  origin = `http://127.0.0.1:${server.address().port}`;
}
const url = new URL(origin);
assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1'));
assert.ok(key, 'Missing operator access key');
const headers = { authorization: 'Bearer ' + key, 'content-type': 'application/json' };
const request = async (path, body, authenticated = true) => {
  const response = await fetch(origin + path, { method: body ? 'POST' : 'GET', headers: authenticated ? headers : { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000) });
  const data = await response.json(); return { status: response.status, data };
};
const mcp = new Client({ name: 'taxlab-research-live-verification', version: '1' });
const httpMcp = new Client({ name: 'taxlab-interview-live-verification', version: '1' });
try {
  assert.equal((await request('/api/research/start', {}, false)).status, 401);
  await mcp.connect(new SSEClientTransport(new URL(origin + '/sse'), { requestInit: { headers } }), { timeout: 15000 });
  const tools = (await mcp.listTools()).tools;
  for (const name of ['start_legal_research', 'research_legal_sources', 'review_legal_reasoning', 'lookup_tax_document']) assert.ok(tools.some(t => t.name === name));
  const start = await mcp.callTool({ name: 'start_legal_research', arguments: { plan: {
    query: '공개 문서 원문 조회와 인용 대조 확인', issues: [{ id: 'source', question: '추가 사실 확인 전 원문을 읽었는가', required_fact_ids: ['case_fact'], required_date_roles: [] }],
    facts: [{ id: 'case_fact', description: '실제 사건 사실은 이 smoke에 제공하지 않음', status: 'unknown', value: null, source: '운영 시험' }], event_dates: [],
  } } });
  assert.equal(start.isError, undefined);
  assert.deepEqual(JSON.parse(start.content[0].text), start.structuredContent);
  const state = start.structuredContent;
  const lookup = await request('/api/research/retrieve', { research_id: state.research_id, expected_revision: state.revision,
    issue_ids: ['source'], purpose: 'support', tool: 'lookup_tax_document', arguments: { document_number: '서면-2020-부동산-4503', include_full_text: true } });
  assert.equal(lookup.status, 200); assert.equal(lookup.data.attempts.at(-1).status, 'completed');
  const evidence = lookup.data.evidence[0]; assert.equal(evidence.body_scope, 'body_returned');
  const passage = evidence.passages.find(p => p.field === 'document.answer') ?? evidence.passages[0];
  assert.ok(passage.text.length > 30);
  const input = { research_id: state.research_id, expected_revision: state.revision, expected_state_version: lookup.data.state_version,
    draft_answer: '확보한 회신 내용을 바탕으로 추가 사실을 확인해야 합니다.', correction_needed: false, analysis: [{
      issue_id: 'source', conclusion_mode: 'conditional', withholding_reason: '', claims: [{ id: 'read_source',
        text: '확보한 회신 내용을 바탕으로 추가 사실을 확인해야 합니다.', requirements: ['사건 사실 추가 확인'], fact_ids: [], citations: [{
          evidence_id: evidence.evidence_id, passage_id: passage.passage_id, quote: passage.text.slice(0, 300), relation: 'direct', reason: '공개 회신의 반환 텍스트를 정확히 대조하는 시험' }]}],
      counter_evidence: [], unknowns: ['실제 사건 사실과 반대 자료 미확인'], next_queries: ['사건 사실 및 후속 해석 확인'],
      timing: { status: 'not_required', reason: '적용 결론을 내리지 않는 원문 대조 시험', date_roles: [] },
      exceptions: { status: 'unresolved', reason: '법률 적용 검수는 이 시험의 대상이 아님' },
    }] };
  const reviewed = await mcp.callTool({ name: 'review_legal_reasoning', arguments: input });
  assert.equal(reviewed.structuredContent.status, 'needs_info');
  assert.equal(reviewed.structuredContent.citation_checks[0].quote_match, true);
  assert.equal(reviewed.structuredContent.legal_verification, 'unverified');
  input.analysis[0].claims[0].citations[0].quote = 'SYNTHETIC_TAMPERED_CITATION_NOT_IN_SOURCE_7b8f';
  const rejected = await request('/api/research/review', input);
  assert.equal(rejected.data.status, 'blocked'); assert.ok(rejected.data.findings.some(f => f.code === 'QUOTE_MISMATCH'));
  assert.equal((await request('/mcp', {}, false)).status, 401);
  const httpTransport = new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { requestInit: { headers } });
  await httpMcp.connect(httpTransport, { timeout: 15000 });
  assert.equal(httpTransport.sessionId, undefined);
  const httpTools = (await httpMcp.listTools()).tools;
  assert.deepEqual(httpTools.map(t => t.name).sort(), tools.map(t => t.name).sort());
  const current = (await httpMcp.callTool({ name: 'get_legal_research', arguments: { research_id: state.research_id } })).structuredContent;
  assert.equal(current.last_review.current, true); assert.equal(current.interview.next_question.target.id, 'case_fact');
  const answered = (await httpMcp.callTool({ name: 'answer_legal_question', arguments: {
    research_id: state.research_id, expected_revision: current.revision, expected_state_version: current.state_version,
    question_id: current.interview.next_question.question_id, answer: { kind: 'unknown', reason: '합성 운영 시험: 사건 사실 미제공' },
  } })).structuredContent;
  assert.equal(answered.interview.next_action, 'conditional_or_withheld'); assert.equal(answered.interview.next_question, null);
  assert.equal(answered.interview.unresolved_count, 1); assert.equal(answered.last_review, null);
  assert.equal(answered.remaining_attempts, current.remaining_attempts); assert.equal(answered.expires_at, current.expires_at);
  const report = { status: 'pass', transport: 'REST, MCP SSE and stateless Streamable HTTP', tool_count: tools.length,
    http_session_id_absent: true, interview_unknown_preserved: true, interview_unresolved: 1, previous_review_invalidated: true,
    provider: evidence.upstream_name, provider_version: evidence.upstream_version, provider_commit: evidence.upstream_commit,
    document_number: '서면-2020-부동산-4503', body_scope: evidence.body_scope, passages: evidence.passages.length,
    response_hash: evidence.response_hash, quote_match: true, missing_fact_result: reviewed.structuredContent.status,
    forged_quote_result: rejected.data.status, legal_verification: 'unverified', github_writes: 0,
    endpoint: url.protocol === 'https:' ? origin : 'loopback', observed_at: new Date().toISOString() };
  if (process.env.RESEARCH_SMOKE_REPORT) await writeFile(process.env.RESEARCH_SMOKE_REPORT, JSON.stringify(report, null, 2));
  else { await mkdir('.runtime', { recursive: true }); await writeFile('.runtime/research-live-smoke.json', JSON.stringify(report, null, 2)); }
  console.log(JSON.stringify(report));
} finally { await httpMcp.close(); await mcp.close(); if (runtime) await runtime.close(); if (server) { server.closeAllConnections(); await new Promise(r => server.close(r)); } }
