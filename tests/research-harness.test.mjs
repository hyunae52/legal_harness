import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createApp } from '../dist/app.js';
import { ServiceError } from '../dist/contracts.js';
import { KoreanLawClient } from '../dist/koreanLawClient.js';
import { TaxLawClient } from '../dist/taxLawClient.js';

const sourceText = '합성 규정 본문입니다. 공동 취득분은 기록된 원가에 따라 구분합니다.';
const plan = () => ({ query: '합성 원가 구분 연구',
  issues: [{ id: 'cost', question: '합성 원가의 구분 조건', required_fact_ids: ['joint'], required_date_roles: [] }],
  facts: [{ id: 'joint', description: '공동 취득 사실', status: 'provided', value: '공동 취득', source: '합성 시험 입력' }],
  event_dates: [] });
const routes = { start_legal_research: 'start', update_legal_research: 'update', get_legal_research: 'status',
  research_legal_sources: 'retrieve', review_legal_reasoning: 'review' };
const exampleDocument = () => ({ document: { ntstDcmId: '010000000000575140', documentNumber: 'SYNTHETIC-1',
  answer: sourceText, sourceUrl: 'https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=010000000000575140' } });

async function fixture(t, opts = {}) {
  const calls = [];
  let writes = 0;
  const law = { releaseVersion: 'fixture', listTools: async () => ({ tools: [
    { name: 'lookup_tax_document', inputSchema: { type: 'object' } },
    { name: 'search_law', inputSchema: { type: 'object' } },
    { name: 'get_law_text', inputSchema: { type: 'object' } },
  ] }), close: async () => {}, callTool: async (name, args) => {
    calls.push({ name, args });
    if (opts.operation) return opts.operation(name, args);
    const data = exampleDocument();
    return { server: { name: 'korean-taxlaw', version: '2.0.0' }, result: {
      content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data,
      _meta: { 'legal-harness/taxlaw': { body_scope: 'provided', completeness: 'unverified', truncated_fields: [] } },
    } };
  } };
  const authenticate = async req => {
    if (!['Bearer alice', 'Bearer bob'].includes(req.get('authorization'))) throw new ServiceError(401, 'UNAUTHORIZED');
    return { id: req.get('authorization').slice(7), kind: 'auth_user' };
  };
  const corrections = { search: () => ({ status: 'available', items: [] }),
    prepare: async () => { writes++; }, confirm: async () => { writes++; }, status: async () => { writes++; } };
  const runtime = createApp({ law, authenticate, corrections, ...opts });
  const server = createServer(runtime.app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await runtime.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const request = async (route, body, actor = 'alice') => {
    const response = await fetch(base + '/api/research/' + route, { method: 'POST',
      headers: { 'content-type': 'application/json', ...(actor ? { authorization: 'Bearer ' + actor } : {}) },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    const text = await response.text();
    let data; try { data = JSON.parse(text); } catch { data = { non_json_response: text.slice(0, 200) }; }
    return { status: response.status, body: data };
  };
  return { request, calls, base, runtime, writes: () => writes };
}

test('RH-01: all five research routes authenticate before source work; start returns a server session', async t => {
  const f = await fixture(t);
  for (const route of Object.values(routes)) assert.equal((await f.request(route, {}, null)).status, 401, route);
  assert.equal(f.calls.length, 0);
  const created = await f.request('start', { plan: plan() });
  assert.equal(created.status, 200);
  assert.match(created.body.research_id, /^[0-9a-f-]{36}$/);
  assert.equal(created.body.revision, 1);
  assert.deepEqual(created.body.plan, plan());
  assert.equal(f.writes(), 0);
});

test('RH-01/11: real authenticated SSE advertises the five tools and returns the same JSON as text', async t => {
  const f = await fixture(t);
  const client = new Client({ name: 'research-contract', version: '1' });
  t.after(() => client.close());
  await client.connect(new SSEClientTransport(new URL(f.base + '/sse'), {
    requestInit: { headers: { authorization: 'Bearer alice' } },
  }), { timeout: 3000 });
  const names = (await client.listTools()).tools.map(tool => tool.name);
  for (const name of Object.keys(routes)) assert.ok(names.includes(name), name);
  const result = await client.callTool({ name: 'start_legal_research', arguments: { plan: plan() } });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(result.structuredContent.revision, 1);
  assert.equal(f.writes(), 0);
});

const retrieveInput = state => ({ research_id: state.research_id, expected_revision: state.revision,
  issue_ids: ['cost'], purpose: 'support', tool: 'lookup_tax_document', arguments: { document_number: 'SYNTHETIC-1' } });
async function seed(f, p = plan()) {
  let r = await f.request('start', { plan: p }); assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await f.request('retrieve', retrieveInput(r.body)); assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await f.request('retrieve', { ...retrieveInput(r.body), purpose: 'counter' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
function reviewInput(state) {
  const support = state.evidence.find(e => e.purpose === 'support');
  const counter = state.evidence.find(e => e.purpose === 'counter');
  return { research_id: state.research_id, expected_revision: state.revision, expected_state_version: state.state_version,
    draft_answer: '합성 사건의 원가를 구분할 수 있습니다.', correction_needed: false, analysis: [{
      issue_id: 'cost', conclusion_mode: 'definitive', withholding_reason: '',
      claims: [{ id: 'cost_claim', text: '합성 사건의 원가를 구분할 수 있습니다.', requirements: ['공동 취득'], fact_ids: ['joint'],
        citations: [{ evidence_id: support.evidence_id, passage_id: support.passages[0].passage_id,
          quote: sourceText, relation: 'direct', reason: '제출한 합성 사실과 규정의 연결 설명' }] }],
      counter_evidence: [{ evidence_id: counter.evidence_id, disposition: 'irrelevant', reason: '다른 적용 요건에 관한 합성 자료' }],
      unknowns: [], next_queries: [],
      timing: { status: 'not_required', reason: '시점을 요건으로 등록하지 않은 합성 사례', date_roles: [] },
      exceptions: { status: 'addressed', reason: '반환된 합성 규정의 예외 문구 검토' },
    }] };
}
const codes = result => result.findings.map(f => f.code);
const conditional = input => {
  input.analysis[0].conclusion_mode = 'conditional';
  input.analysis[0].unknowns = ['자료 또는 사실이 추가로 필요함'];
  input.analysis[0].next_queries = ['필요한 사실과 반대 자료 확인'];
  return input;
};

test('RH-02: each session operation enforces actor, revision and same-session evidence', async t => {
  const f = await fixture(t), state = await seed(f), count = f.calls.length;
  for (const [route, body] of [ ['status', { research_id: state.research_id }],
    ['update', { research_id: state.research_id, expected_revision: 1, plan: plan() }],
    ['retrieve', retrieveInput(state)], ['review', reviewInput(state)] ]) {
    assert.deepEqual(await f.request(route, body, 'bob'), { status: 404, body: { code: 'RESEARCH_NOT_FOUND' } });
  }
  for (const route of ['update', 'retrieve', 'review']) {
    const input = route === 'review' ? reviewInput(state) : route === 'retrieve' ? retrieveInput(state)
      : { research_id: state.research_id, plan: plan() };
    const rejected = await f.request(route, { ...input, expected_revision: 9 });
    assert.equal(rejected.status, 409); assert.equal(rejected.body.code, 'RESEARCH_REVISION_CHANGED');
  }
  assert.equal(f.calls.length, count);
  const other = (await f.request('start', { plan: plan() })).body;
  const foreign = { ...reviewInput(state), research_id: other.research_id, expected_state_version: other.state_version };
  const result = (await f.request('review', foreign)).body;
  assert.equal(result.status, 'blocked'); assert.ok(codes(result).includes('EVIDENCE_NOT_FOUND'));
  const forged = reviewInput(state); forged.analysis[0].claims[0].citations[0].evidence_id = '00000000-0000-4000-8000-000000000001';
  assert.ok(codes((await f.request('review', forged)).body).includes('EVIDENCE_NOT_FOUND'));
  assert.equal(f.writes(), 0);
});

test('RH-03/09: exact returned quotes pass structure only; draft and snapshot binding has an independent hash oracle', async t => {
  const f = await fixture(t), state = await seed(f), input = reviewInput(state);
  const result = (await f.request('review', input)).body;
  assert.equal(result.status, 'structurally_complete', JSON.stringify(result));
  assert.equal(result.legal_verification, 'unverified'); assert.equal(result.semantic_support, 'unverified');
  assert.equal(result.independent_review, 'not_performed');
  assert.equal(result.stages.independent_semantic_review, 'not_configured');
  assert.equal(result.claim_coverage, 'submitted_claims_only');
  assert.equal(result.citation_checks[0].quote_match, true);
  assert.equal(result.draft_hash, createHash('sha256').update(JSON.stringify(input.draft_answer)).digest('hex'));
  // Explicit alphabetical projection, independent of the production canonicalizer.
  const bindingJson = JSON.stringify({ analysis_hash: result.analysis_hash, correction_needed: false, draft_hash: result.draft_hash,
    plan_hash: result.plan_hash, policy_version: result.policy_version, research_id: result.research_id, revision: result.revision,
    snapshot_hash: result.snapshot_hash, state_version: result.state_version });
  assert.equal(result.binding_hash, createHash('sha256').update(bindingJson).digest('hex'));
  const changed = structuredClone(input); changed.draft_answer += '\n추가 설명';
  const next = (await f.request('review', changed)).body;
  assert.notEqual(next.draft_hash, result.draft_hash); assert.notEqual(next.binding_hash, result.binding_hash);
  const differentAnalysis = structuredClone(input); differentAnalysis.analysis[0].claims[0].citations[0].reason += ' 수정';
  assert.notEqual((await f.request('review', differentAnalysis)).body.analysis_hash, result.analysis_hash);
  const status = (await f.request('status', { research_id: state.research_id })).body;
  assert.equal(status.last_review.current, true);
  const more = (await f.request('retrieve', { ...retrieveInput(state), purpose: 'counter' })).body;
  assert.equal(more.last_review.current, false);
  const refreshed = await f.request('review', { ...input, expected_state_version: more.state_version });
  assert.notEqual(refreshed.body.snapshot_hash, result.snapshot_hash);
  assert.ok(codes(refreshed.body).includes('COUNTER_NOT_ADDRESSED'));
  const changedPlan = plan(); changedPlan.query += ' 다른 연구 범위';
  let revised = (await f.request('update', { research_id: state.research_id, expected_revision: 1, plan: changedPlan })).body;
  revised = (await f.request('retrieve', retrieveInput(revised))).body;
  revised = (await f.request('retrieve', { ...retrieveInput(revised), purpose: 'counter' })).body;
  assert.notEqual((await f.request('review', reviewInput(revised))).body.plan_hash, result.plan_hash);
});

test('RH-03: empty, changed, noncontiguous and wrong-passage citations never disappear into a pass', async t => {
  const f = await fixture(t), state = await seed(f);
  for (const [quote, expected] of [['', 400], ['합성 규정은 모든 양도차익을 면제합니다.', 200], ['합성 규정 본문입니다. 원가에 따라 구분합니다.', 200]]) {
    const input = reviewInput(state); input.analysis[0].claims[0].citations[0].quote = quote;
    const response = await f.request('review', input); assert.equal(response.status, expected);
    if (expected === 200) {
      assert.equal(response.body.status, 'blocked'); assert.ok(codes(response.body).includes('QUOTE_MISMATCH'));
      assert.equal(response.body.citation_checks[0].citation.quote, quote);
      assert.equal(response.body.citation_checks[0].quote_match, false);
    }
  }
  const swapped = reviewInput(state); swapped.analysis[0].claims[0].citations[0].passage_id = 'absent';
  assert.ok(codes((await f.request('review', swapped)).body).includes('PASSAGE_NOT_FOUND'));
});

test('RH-05/06: declared facts, issue coverage and cross-issue bridges cannot be bypassed by omission', async t => {
  const f = await fixture(t);
  for (const transform of [p => { p.issues = []; }, p => p.facts.push(p.facts[0]), p => { p.facts[0].value = null; },
    p => { p.issues[0].required_fact_ids = ['missing']; }]) {
    const p = plan(); transform(p); assert.equal((await f.request('start', { plan: p })).status, 400);
  }
  const p = plan(); p.facts[0].status = 'unknown'; p.facts[0].value = null;
  const state = await seed(f, p);
  const missing = reviewInput(state); missing.analysis[0].claims[0].fact_ids = [];
  assert.equal((await f.request('review', missing)).body.status, 'blocked');
  assert.equal((await f.request('review', conditional(missing))).body.status, 'needs_info');
  const both = plan(); both.issues.push({ id: 'partition', question: '분할 해당 여부', required_fact_ids: [], required_date_roles: [] });
  const two = await seed(f, both), incomplete = reviewInput(two);
  assert.ok(codes((await f.request('review', incomplete)).body).includes('ISSUE_COVERAGE'));
  const pAnalysis = structuredClone(incomplete.analysis[0]); pAnalysis.issue_id = 'partition'; pAnalysis.claims[0].id = 'partition_claim';
  incomplete.analysis.push(pAnalysis);
  assert.ok(codes((await f.request('review', incomplete)).body).includes('ISSUE_BRIDGE_REQUIRED'));
  pAnalysis.claims[0].citations[0].bridge_reason = '다른 쟁점으로 넘어가는 별도의 연결 설명';
  assert.equal((await f.request('review', incomplete)).body.semantic_support, 'unverified');
});

test('RH-07: role dates retain precision and only exact registered day facts reach the historical provider', async t => {
  let sourceCalls = [];
  const f = await fixture(t, { sources: { check: async args => { sourceCalls.push(args); return { source_access: 'unavailable', error_code: 'SYNTHETIC' }; }, close: async () => {} } });
  const p = plan(); p.event_dates = [{ role: 'transfer', precision: 'month', value: '2025-03', basis: 'provided', source: '합성 진술' }];
  p.issues[0].required_date_roles = ['transfer'];
  let state = (await f.request('start', { plan: p })).body;
  assert.equal(state.plan.event_dates[0].value, '2025-03');
  const check = { ...retrieveInput(state), tool: 'check_legal_sources', arguments: { law_name: '합성법', law_id: '1', event_dates: { transfer: '2025-03-15' } } };
  let response = await f.request('retrieve', check);
  assert.equal(response.status, 400); assert.equal(response.body.code, 'RESEARCH_DATE_MISMATCH'); assert.equal(sourceCalls.length, 0);
  p.event_dates[0].precision = 'day'; p.event_dates[0].value = '2025-02-30';
  assert.equal((await f.request('update', { research_id: state.research_id, expected_revision: 1, plan: p })).status, 400);
  assert.equal((await f.request('status', { research_id: state.research_id })).body.plan.event_dates[0].value, '2025-03');
  p.event_dates[0].value = '2025-03-15';
  state = (await f.request('update', { research_id: state.research_id, expected_revision: 1, plan: p })).body;
  response = await f.request('retrieve', { ...check, expected_revision: state.revision });
  assert.equal(response.status, 200); assert.deepEqual(sourceCalls[0].event_dates, { transfer: '2025-03-15' });
  assert.equal(response.body.attempts.at(-1).status, 'failed'); assert.equal(response.body.evidence.length, 0);
});

test('RH-08/09: delayed retrieval rejects conflicting operations and immediately invalidates old review', async t => {
  let block = false; const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, { operation: async () => {
    if (block) { entered.resolve(); await release.promise; }
    return { server: { name: 'korean-taxlaw', version: '2.0.0' }, result: { structuredContent: exampleDocument(), content: [] } };
  } });
  const state = await seed(f), input = reviewInput(state);
  await f.request('review', input);
  block = true;
  const pending = f.request('retrieve', { ...retrieveInput(state), purpose: 'counter' });
  await entered.promise;
  try {
    const status = (await f.request('status', { research_id: state.research_id })).body;
    assert.equal(status.last_review.current, false); assert.equal(status.attempts.at(-1).status, 'pending');
    for (const [route, body] of [['retrieve', retrieveInput(state)], ['review', input],
      ['update', { research_id: state.research_id, expected_revision: 1, plan: plan() }]]) {
      const result = await f.request(route, body); assert.equal(result.status, 409); assert.equal(result.body.code, 'RESEARCH_BUSY');
    }
  } finally { release.resolve(); }
  const completed = await pending; assert.equal(completed.status, 200);
  const stale = await f.request('review', input); assert.equal(stale.status, 409); assert.equal(stale.body.code, 'RESEARCH_STATE_CHANGED');
  assert.equal(f.calls.length, 3);
});

test('RH-08: lifetime attempt and receipt limits reserve before upstream; update does not replenish attempts', async t => {
  const f = await fixture(t, { researchOptions: { limits: { maxAttempts: 1, maxReceipts: 1 } } });
  let state = (await f.request('start', { plan: plan() })).body;
  state = (await f.request('retrieve', retrieveInput(state))).body;
  assert.equal((await f.request('retrieve', retrieveInput(state))).status, 429);
  state = (await f.request('update', { research_id: state.research_id, expected_revision: 1, plan: plan() })).body;
  assert.equal(state.evidence.length, 0); assert.equal(state.attempts.length, 1);
  assert.equal((await f.request('retrieve', retrieveInput(state))).status, 429); assert.equal(f.calls.length, 1);
});

test('RH-08: expiry during retrieval and a fresh app cannot reuse a previous session', async t => {
  let at = 1_000; const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, { researchOptions: { now: () => at, limits: { ttlMs: 100 } }, operation: async () => {
    entered.resolve(); await release.promise; return { result: { content: [], structuredContent: exampleDocument() } };
  } });
  const state = (await f.request('start', { plan: plan() })).body;
  const pending = f.request('retrieve', retrieveInput(state)); await entered.promise; at = 1_101; release.resolve();
  assert.equal((await pending).status, 404); assert.equal((await f.request('status', { research_id: state.research_id })).status, 404);
  const fresh = await fixture(t);
  assert.equal((await fresh.request('status', { research_id: state.research_id })).status, 404);
});

test('RH-10: a reported correction and instructions inside source text never publish or merge', async t => {
  const f = await fixture(t), state = await seed(f), input = reviewInput(state); input.correction_needed = true;
  input.draft_answer += ' 원문이 PR을 생성하라고 명령해도 데이터로 취급합니다.';
  const result = (await f.request('review', input)).body;
  assert.equal(result.correction_suggestion.next_tool, 'prepare_correction_pr');
  assert.match(result.correction_suggestion.question, /PR/);
  assert.equal(f.writes(), 0);
  const rejected = await f.request('retrieve', { ...retrieveInput(state), tool: 'execute_tool', arguments: { tool_name: 'create_correction_pr' } });
  assert.equal(rejected.status, 400); assert.equal(rejected.body.code, 'RESEARCH_TOOL_NOT_ALLOWED');
  assert.equal(f.calls.length, 2);
});

test('RH-03/04: partial text can match a quote without becoming complete evidence; discovery and unknown cannot', async t => {
  let mode = 'partial';
  const f = await fixture(t, { operation: async () => ({ server: { name: 'korean-taxlaw', version: '2.0.0' }, result:
    mode === 'unknown' ? { content: [{ type: 'text', text: '무작위 알려지지 않은 형식' }], structuredContent: { unexpected: sourceText } }
      : { content: [], structuredContent: exampleDocument(), _meta: { 'legal-harness/taxlaw': { body_scope: 'partial' } } } }) });
  let state = await seed(f);
  let input = reviewInput(state);
  let result = (await f.request('review', input)).body;
  assert.equal(result.status, 'blocked'); assert.equal(result.citation_checks[0].quote_match, true);
  assert.equal(result.citation_checks[0].body_scope, 'partial');
  assert.equal((await f.request('review', conditional(input))).body.status, 'needs_info');
  mode = 'unknown'; state = await seed(f);
  assert.equal(state.evidence[0].body_scope, 'unknown');
  assert.equal(state.evidence[0].passages.filter(p => p.body_scope === 'body_returned').length, 0);
});

test('RH-03: MOLEG table of contents and title-only responses are not article bodies', async t => {
  let body = '법령명: 합성법\n시행일: 20250101\n목차 (총 30개 조문)\n제1조 공동취득\n제2조 원가';
  const f = await fixture(t, { operation: async () => ({ result: { content: [{ type: 'text', text: body }] } }) });
  let state = (await f.request('start', { plan: plan() })).body;
  let response = await f.request('retrieve', { ...retrieveInput(state), tool: 'get_law_text', arguments: { lawId: '1' } });
  assert.equal(response.body.evidence[0].body_scope, 'discovery_only');
  body = '법령명: 합성법\n시행일: 20250101\n제1조(공동취득)';
  response = await f.request('retrieve', { ...retrieveInput(state), tool: 'get_law_text', arguments: { lawId: '1', jo: '1' } });
  assert.equal(response.body.evidence.at(-1).body_scope, 'unknown');
  body += '\n' + sourceText;
  response = await f.request('retrieve', { ...retrieveInput(state), tool: 'get_law_text', arguments: { lawId: '1', jo: '1' } });
  const receipt = response.body.evidence.at(-1);
  assert.equal(receipt.body_scope, 'body_returned');
  assert.equal(receipt.passages[0].text, sourceText);
});

test('RH-04: stale SourceVerifier fallback is never a new receipt; failed historical roles survive', async t => {
  let success = false;
  const current = { content: [{ type: 'text', text: '법령명: 합성법\n시행일: 20250101\n제1조(원가)\n' + sourceText }] };
  const f = await fixture(t, { sources: { close: async () => {}, check: async () => success
    ? { source_access: 'available', upstream_version: 'fixture', current_result: current,
      historical_observations: [{ role: 'transfer', date: '2025-03-15', source_access: 'unavailable', error_code: 'SOURCE_REFRESH_FAILED', result: null }] }
    : { source_access: 'unavailable', error_code: 'SOURCE_REFRESH_FAILED', previous: { result: { source_access: 'available', current_result: current } } } } });
  const p = plan(); p.event_dates = [{ role: 'transfer', value: '2025-03-15', precision: 'day', basis: 'provided', source: '합성 진술' }];
  const state = (await f.request('start', { plan: p })).body;
  const input = { ...retrieveInput(state), tool: 'check_legal_sources', arguments: { law_name: '합성법', law_id: '1', article: '1', event_dates: { transfer: '2025-03-15' } } };
  let result = (await f.request('retrieve', input)).body;
  assert.equal(result.evidence.length, 0); assert.equal(result.attempts[0].status, 'failed');
  success = true; result = (await f.request('retrieve', input)).body;
  const receipt = result.evidence[0];
  assert.equal(receipt.units.find(u => u.role === 'current').source_access, 'available');
  assert.equal(receipt.units.find(u => u.role === 'transfer').source_access, 'unavailable');
  assert.equal(receipt.passages.filter(p => p.role === 'transfer').length, 0);
});

test('RH-04/08: actual stdio NTS failures, compact reads and timeout preserve research state', async t => {
  const file = fileURLToPath(new URL('./fixtures/taxlaw-mcp-server.mjs', import.meta.url));
  const managed = new KoreanLawClient({ server: { command: process.execPath, args: [file], env: {}, cwd: dirname(file) },
    credentialPolicy: 'none', releaseVersion: '2.0.0', connectTimeoutMs: 3000, requestTimeoutMs: 500, maxConcurrentCalls: 2 });
  const taxlaw = new TaxLawClient(managed);
  const f = await fixture(t, { law: taxlaw });
  await managed.listTools();
  const state = (await f.request('start', { plan: plan() })).body;
  for (const query of ['__missing__', '__body_missing__', '__offline__', '__hang__']) {
    const response = await f.request('retrieve', { ...retrieveInput(state), arguments: { document_number: query } });
    assert.equal(response.status, 200); assert.equal(response.body.attempts.at(-1).status, 'failed');
    assert.equal(response.body.evidence.length, 0);
  }
  await managed.listTools();
  const compact = (await f.request('retrieve', { ...retrieveInput(state), arguments: { document_number: 'SYNTHETIC', detail: 'compact' } })).body;
  assert.equal(compact.evidence[0].body_scope, 'partial');
  const full = (await f.request('retrieve', retrieveInput(state))).body;
  assert.equal(full.evidence.at(-1).body_scope, 'body_returned');
  assert.equal(full.attempts.filter(a => a.status === 'failed').length, 4);
});

test('RH-04: an unavailable role in a composite counter or context receipt remains a review gap', async t => {
  let access = 'unavailable';
  const f = await fixture(t, { sources: { close: async () => {}, check: async () => ({
    source_access: 'available', upstream_version: 'fixture',
    current_result: { content: [{ type: 'text', text: '법령명: 합성법\n시행일: 20250101\n제1조(원가)\n' + sourceText }] },
    historical_observations: [{ role: 'transfer', date: '2025-03-15', source_access: access,
      result: access === 'available' ? { content: [{ type: 'text', text: '인식하지 못하는 과거 복합 형식' }] } : null }],
  }) } });
  for (const [purpose, sourceAccess] of [['counter', 'unavailable'], ['context', 'unavailable'], ['counter', 'available'], ['context', 'available']]) {
    access = sourceAccess;
    const p = plan(); p.event_dates = [{ role: 'transfer', value: '2025-03-15', precision: 'day', basis: 'provided', source: '합성 진술' }];
    let state = await seed(f, p);
    state = (await f.request('retrieve', { ...retrieveInput(state), purpose, tool: 'check_legal_sources',
      arguments: { law_name: '합성법', law_id: '1', article: '1', event_dates: { transfer: '2025-03-15' } } })).body;
    const failedRole = state.evidence.at(-1);
    assert.equal(failedRole.body_scope, 'body_returned');
    assert.equal(failedRole.units.find(u => u.role === 'transfer').source_access, sourceAccess);
    const input = reviewInput(state);
    if (purpose === 'counter') input.analysis[0].counter_evidence.push({ evidence_id: failedRole.evidence_id, disposition: 'irrelevant', reason: '다른 시점이라고 선언해도 조회 실패는 해결되지 않음' });
    const blocked = (await f.request('review', input)).body;
    const expectedCode = sourceAccess === 'unavailable' ? 'UNAVAILABLE_SOURCE_ROLE' : 'SOURCE_ROLE_BODY_INCOMPLETE';
    assert.equal(blocked.status, 'blocked'); assert.ok(codes(blocked).includes(expectedCode));
    const incomplete = (await f.request('review', conditional(input))).body;
    assert.equal(incomplete.status, 'needs_info'); assert.ok(codes(incomplete).includes(expectedCode));
  }
  assert.equal(f.writes(), 0);
});

test('RH-07: explicitly unresolved timing cannot pass when no required date role was registered', async t => {
  const f = await fixture(t), state = await seed(f), input = reviewInput(state);
  assert.equal((await f.request('review', input)).body.status, 'structurally_complete');
  input.analysis[0].timing = { status: 'unresolved', reason: '적용 시점을 아직 확인하지 못함', date_roles: [] };
  const blocked = (await f.request('review', input)).body;
  assert.equal(blocked.status, 'blocked'); assert.ok(codes(blocked).includes('TIMING_REVIEW_REQUIRED'));
  const incomplete = (await f.request('review', conditional(input))).body;
  assert.equal(incomplete.status, 'needs_info'); assert.ok(codes(incomplete).includes('TIMING_REVIEW_REQUIRED'));
  assert.equal(f.writes(), 0);
});

test('RH-08: byte and session capacity reject before source calls, including cross-session reservations', async t => {
  const small = await fixture(t, { researchOptions: { limits: { maxSessionBytes: 10_000 } } });
  const state = (await small.request('start', { plan: plan() })).body;
  assert.equal((await small.request('retrieve', retrieveInput(state))).status, 429); assert.equal(small.calls.length, 0);
  const one = await fixture(t, { researchOptions: { limits: { maxSessionsPerActor: 1, maxSessions: 2 } } });
  assert.equal((await one.request('start', { plan: plan() })).status, 200);
  assert.equal((await one.request('start', { plan: plan() })).status, 429);
  assert.equal((await one.request('start', { plan: plan() }, 'bob')).status, 200);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, { researchOptions: { limits: { maxTotalBytes: 200_000 } }, operation: async () => {
    entered.resolve(); await release.promise; return { result: { content: [], structuredContent: exampleDocument() } };
  } });
  const first = (await f.request('start', { plan: plan() })).body;
  const second = (await f.request('start', { plan: plan() })).body;
  const pending = f.request('retrieve', retrieveInput(first)); await entered.promise;
  try { assert.equal((await f.request('retrieve', retrieveInput(second))).status, 429); assert.equal(f.calls.length, 1); }
  finally { release.resolve(); }
  assert.equal((await pending).status, 200);
});

test('RH-11: generated Actions schemas accept the real five-tool flow and reject blank citations', async t => {
  const f = await fixture(t), schema = await (await fetch(f.base + '/openapi.json')).json();
  const ajv = new Ajv2020({ strict: false, validateFormats: false });
  const state = await seed(f);
  const inputs = { start: { plan: plan() }, status: { research_id: state.research_id },
    retrieve: retrieveInput(state), review: reviewInput(state), update: { research_id: state.research_id, expected_revision: 1, plan: plan() } };
  for (const [route, body] of Object.entries(inputs)) {
    const op = schema.paths['/api/research/' + route].post;
    assert.equal(op['x-openai-isConsequential'], false);
    const validate = ajv.compile(op.requestBody.content['application/json'].schema);
    assert.equal(validate(body), true, JSON.stringify(validate.errors));
    if (route === 'review') {
      const invalid = structuredClone(body); invalid.analysis[0].claims[0].citations[0].quote = '';
      assert.equal(validate(invalid), false);
    }
  }
  const result = await f.request('review', inputs.review);
  assert.equal(ajv.compile(schema.paths['/api/research/review'].post.responses['200'].content['application/json'].schema)(result.body), true);
});

test('RH-05/08: duplicate claim, absent fact, unacknowledged gaps and receipt truncation remain visible', async t => {
  const f = await fixture(t), state = await seed(f);
  const duplicate = reviewInput(state); duplicate.analysis[0].claims.push(structuredClone(duplicate.analysis[0].claims[0]));
  assert.ok(codes((await f.request('review', duplicate)).body).includes('DUPLICATE_CLAIM'));
  const missing = reviewInput(state); missing.analysis[0].claims[0].fact_ids.push('absent');
  assert.ok(codes((await f.request('review', missing)).body).includes('FACT_NOT_FOUND'));
  const withheld = reviewInput(state); withheld.analysis[0].conclusion_mode = 'withheld';
  assert.equal((await f.request('review', withheld)).body.status, 'blocked');
  const large = await fixture(t, { operation: async () => ({ result: { content: [], structuredContent: { document: { answer: '공개 합성 문자열 '.repeat(30000) } } } }) });
  const created = (await large.request('start', { plan: plan() })).body;
  const response = await large.request('retrieve', retrieveInput(created));
  assert.equal(response.status, 200); const receipt = response.body.evidence[0];
  assert.equal(receipt.body_scope, 'partial'); assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 131072);
  assert.ok(receipt.passages.every(p => p.body_scope === 'partial'));
});

test('RH-07: legacy analyze rejects impossible calendar days before touching upstream', async t => {
  const f = await fixture(t);
  const response = await fetch(f.base + '/api/analyze', { method: 'POST', headers: { authorization: 'Bearer alice', 'content-type': 'application/json' },
    body: JSON.stringify({ query: '합성', event_dates: { transfer: '2025-02-29' } }) });
  assert.equal(response.status, 400); assert.equal(f.calls.length, 0);
});
