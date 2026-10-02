import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createApp } from '../dist/app.js';
import { ServiceError } from '../dist/contracts.js';
import { KoreanLawClient } from '../dist/koreanLawClient.js';
import { TaxLawClient } from '../dist/taxLawClient.js';

import { emptyCourtResult, emptyLawResult } from './fixtures/generic-searches.mjs';

const sourceText = '합성 규정 본문입니다. 공동 취득분은 기록된 원가에 따라 구분합니다.';
const plan = () => ({ query: '합성 원가 구분 연구',
  issues: [{ id: 'cost', question: '합성 원가의 구분 조건', required_fact_ids: ['joint'], required_date_roles: [] }],
  facts: [{ id: 'joint', description: '공동 취득 사실', status: 'provided', value: '공동 취득', source: '합성 시험 입력' }],
  event_dates: [] });
const routes = { start_legal_research: 'start', update_legal_research: 'update', get_legal_research: 'status',
  research_legal_sources: 'retrieve', run_required_legal_research: 'run', reuse_legal_evidence: 'reuse', answer_legal_question: 'answer', review_legal_reasoning: 'review' };
const exampleDocument = () => ({ document: { ntstDcmId: '010000000000575140', documentNumber: 'SYNTHETIC-1',
  documentType: '질의회신', issuingAgency: '국세청', answer: sourceText, sourceUrl: 'https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=010000000000575140' } });

async function fixture(t, opts = {}) {
  const calls = [];
  let writes = 0;
  const law = { releaseVersion: 'fixture', listTools: async () => ({ tools: [
    { name: 'lookup_tax_document', inputSchema: { type: 'object' } },
    { name: 'search_law', inputSchema: { type: 'object' } },
    { name: 'get_law_text', inputSchema: { type: 'object' } },
  ] }), close: async () => {}, callTool: async (name, args) => {
    calls.push({ name, args });
    if (name === 'get_law_text' && args.lawId === 'SYNTHETIC-STATUTE') return { server: { name: 'korean-law-mcp', version: 'fixture' },
      result: { content: [{ type: 'text', text: '법령명: 합성법\n시행일: 20200101\n제1조(원가)\n합성 법령 및 부칙의 적용 근거.' }] } };
    if (name === 'search_decisions') return emptyCourtResult();
    if (name === 'search_law') return emptyLawResult();
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
    // Legacy behavior assertions inspect explicit full state. CF-06 below separately
    // exercises the default production MCP response without this reader convenience.
    if (response.ok && data.response_mode === 'summary') {
      const full = await request('status', { research_id: data.research_id, view: 'full' }, actor);
      assert.equal(full.status, 200);
      data = { ...full.body, ...(data.job ? { job: data.job } : {}), ...(data.replayed ? { replayed: true } : {}) };
    }
    return { status: response.status, body: data };
  };
  return { request, calls, base, runtime, writes: () => writes };
}

test('Model recovery: invalid values return allowed enums and bounds without echoing submitted data', async t => {
  const f = await fixture(t), s = (await f.request('start', { plan: plan() })).body;
  const bad = await f.request('review', { research_id: s.research_id, expected_revision: 1, expected_state_version: s.state_version,
    draft_answer: '합성 입력', correction_needed: false, analysis: [{ issue_id: 'cost', conclusion_mode: 'SECRET_INVALID_VALUE',
      withholding_reason: '', claims: [], counter_evidence: [], unknowns: [], next_queries: [],
      timing: { status: 'SECRET_INVALID_VALUE', reason: '합성', date_roles: [] }, exceptions: { status: 'addressed', reason: '합성' } }] });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.body.issues.find(i => i.path === 'analysis.0.timing.status').allowed_values, ['addressed', 'unresolved', 'not_required']);
  assert.ok(!JSON.stringify(bad.body).includes('SECRET_INVALID_VALUE'));
  const oversize = await f.request('run', { research_id: s.research_id, expected_revision: 1, request_id: randomUUID(), max_steps: 10 });
  assert.equal(oversize.status, 400); assert.equal(oversize.body.issues[0].maximum, 4); assert.equal(f.calls.length, 0);
});

test('Model recovery: selected evidence reads preserve exact text, current review state, and actor isolation', async t => {
  const f = await fixture(t), longPlan = plan(); longPlan.query += ' 확인된 배경 사실'.repeat(900);
  let s = (await f.request('start', { plan: longPlan })).body;
  for (const document_number of ['SYNTHETIC-1', 'SYNTHETIC-2']) s = (await f.request('retrieve', {
    research_id: s.research_id, expected_revision: 1, issue_ids: ['cost'], purpose: 'support',
    tool: 'lookup_tax_document', arguments: { document_number } })).body;
  const calls = f.calls.length, e = s.evidence[0];
  const summary = (await f.request('status', { research_id: s.research_id, evidence_ids: [] })).body;
  assert.deepEqual(summary.evidence, []); assert.equal(summary.evidence_selection.total_evidence_count, 2);
  assert.equal(summary.evidence_index.length, 2); assert.equal(summary.state_version, s.state_version);
  const selected = (await f.request('status', { research_id: s.research_id, evidence_ids: [e.evidence_id] })).body;
  assert.deepEqual(selected.evidence, [e]);
  assert.ok(JSON.stringify(selected).slice(0, 3000).includes(sourceText), 'targeted source text must precede a long plan/history in clients that bound tool output');
  const full = (await f.request('status', { research_id: s.research_id })).body;
  assert.deepEqual(full.evidence, s.evidence); assert.equal(f.calls.length, calls);
  assert.equal((await f.request('status', { research_id: s.research_id, evidence_ids: [randomUUID()] })).status, 400);
  assert.equal((await f.request('status', { research_id: s.research_id, evidence_ids: [e.evidence_id] }, 'bob')).status, 404);
});

test('AC-16/23: new reuse operation works across REST and actual HTTP MCP without a new upstream lookup', async t => {
  const f = await fixture(t);
  let s = (await f.request('start', { plan: plan() })).body;
  s = (await f.request('retrieve', { research_id: s.research_id, expected_revision: s.revision, issue_ids: ['cost'], purpose: 'timing',
    tool: 'get_law_text', arguments: { lawId: 'SYNTHETIC-STATUTE', jo: '제1조' } })).body;
  const e = s.evidence[0], calls = f.calls.length;
  s = (await f.request('update', { research_id: s.research_id, expected_revision: s.revision, plan: plan() })).body;
  const response = await fetch(f.base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer alice', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 101, method: 'tools/call', params: { name: 'reuse_legal_evidence',
      arguments: { research_id: s.research_id, expected_revision: s.revision, issue_ids: ['cost'], evidence_ids: [e.evidence_id] } } }) });
  const payload = await response.json(); assert.equal(payload.result.isError, undefined);
  const summary = payload.result.structuredContent; assert.deepEqual(JSON.parse(payload.result.content[0].text), summary);
  const result = (await f.request('status', { research_id: summary.research_id, evidence_ids: [e.evidence_id] })).body;
  assert.equal(result.evidence[0].observed_at, e.observed_at); assert.equal(result.evidence[0].cache_of, e.evidence_id);
  assert.equal(result.evidence[0].revision, s.revision); assert.equal(f.calls.length, calls);
  const denied = await f.request('reuse', { research_id: s.research_id, expected_revision: s.revision, issue_ids: ['cost'], evidence_ids: [e.evidence_id] }, 'bob');
  assert.equal(denied.status, 404); assert.equal(f.calls.length, calls);
});

async function completionReuseFixture(t) {
  const f = await fixture(t, { operation: async (_name, args) => ({ result: { content: [{ type: 'text',
    text: args.lawId === 'OTHER' ? '법령명: 부가가치세법\n시행일: 20260101\n제1조(과세)\n독립된 합성 쟁점입니다.'
      : '법령명: 소득세법 시행령\n시행일: 20260101\n제155조(특례)\n합성 주택 취득 순서의 검토 대상입니다.' }] } }) });
  const p = { query: '일시적 2주택과 적용 시기 및 독립된 부가가치세 검토', facts: [], event_dates: [],
    issues: [
      { id: 'I1', question: '일시적 2주택 취득 순서', profile: 'temporary_two_homes', required_fact_ids: [], required_date_roles: [] },
      ...['I2', 'I3', 'I4'].map(id => ({ id, question: id === 'I4' ? '부가가치세 별도 적용' : '관측된 동일 조문의 적용 시기', required_fact_ids: [], required_date_roles: [] })),
    ] };
  let s = (await f.request('start', { plan: p })).body;
  s = (await f.request('retrieve', { research_id: s.research_id, expected_revision: 1, issue_ids: ['I1', 'I2'],
    purpose: 'timing', tool: 'get_law_text', arguments: { lawId: 'HOMES', jo: '제155조' } })).body;
  return { f, s, reuse: (state, issue_ids) => f.request('reuse', { research_id: state.research_id,
    expected_revision: state.revision, issue_ids, evidence_ids: [state.evidence[0].evidence_id] }) };
}

test('CF-01: same-revision reuse adds issue bindings and preserves immutable source and original obligations', async t => {
  const { f, s, reuse } = await completionReuseFixture(t), original = s.evidence[0], calls = f.calls.length;
  const result = await reuse(s, ['I3']); assert.equal(result.status, 200);
  const next = result.body, e = next.evidence[0];
  assert.deepEqual([...e.issue_ids].sort(), ['I1', 'I2', 'I3']);
  for (const key of ['passages', 'observed_at', 'expires_at', 'response_hash', 'manifest_id']) assert.deepEqual(e[key], original[key], key);
  assert.deepEqual(next.manifests, s.manifests); assert.deepEqual(next.attempts, s.attempts);
  assert.equal(next.revision, 1); assert.equal(next.state_version, s.state_version + 1);
  assert.equal(next.evidence.length, 1); assert.equal(f.calls.length, calls);
  for (const id of ['I1', 'I2', 'I3']) assert.ok(next.coverage.obligations.some(o => o.issue_id === id));
  const duplicate = (await reuse(next, ['I2', 'I3', 'I1'])).body;
  assert.equal(duplicate.state_version, next.state_version, 'same effective binding is a no-op');
  assert.deepEqual(duplicate.evidence, next.evidence); assert.equal(f.calls.length, calls);
});

test('CF-02: additional issue reuse keeps narrow acquisition recipes and never transfers them to a different statute', async t => {
  const { f, s, reuse } = await completionReuseFixture(t);
  let next = (await reuse(s, ['I3'])).body;
  const queries = next.coverage.obligations.filter(o => o.issue_id === 'I3').map(o => o.next_step?.arguments.query).filter(Boolean);
  assert.ok(queries.some(q => q.includes('취득 선후')), 'reuse must not turn a contextual obligation into broad 요건 discovery');
  assert.ok(!queries.includes('소득세법 시행령 제155조 요건'));
  next = (await f.request('retrieve', { research_id: s.research_id, expected_revision: 1, issue_ids: ['I4'], purpose: 'timing',
    tool: 'get_law_text', arguments: { lawId: 'OTHER', jo: '제1조' } })).body;
  const unrelated = next.coverage.obligations.filter(o => o.issue_id === 'I4');
  assert.ok(unrelated.length); assert.ok(unrelated.every(o => !JSON.stringify(o.next_step).includes('2주택')));
});

test('CF-03: old-revision reuse starts with only explicitly requested issues then adds current bindings', async t => {
  const { f, s, reuse } = await completionReuseFixture(t), calls = f.calls.length;
  let next = (await f.request('update', { research_id: s.research_id, expected_revision: 1, plan: s.plan })).body;
  next = (await reuse(next, ['I3'])).body;
  assert.deepEqual(next.evidence[0].issue_ids, ['I3']); assert.equal(next.evidence[0].revision, 2);
  assert.equal(next.evidence[0].source_revision, 1); assert.equal(next.evidence[0].observed_at, s.evidence[0].observed_at);
  next = (await reuse(next, ['I2'])).body;
  assert.deepEqual([...next.evidence[0].issue_ids].sort(), ['I2', 'I3']);
  assert.ok(!next.evidence[0].issue_ids.includes('I1')); assert.equal(f.calls.length, calls);
  assert.ok(next.coverage.obligations.every(o => o.status === 'not_attempted'), 'reused bodies are not fresh searches');
});

test('CF-03: unchanged reuse retains a current review; adding a binding invalidates it', async t => {
  const f = await fixture(t), p = plan();
  p.issues.push({ id: 'newscope', question: '별도의 쟁점 연결', required_fact_ids: [], required_date_roles: [] });
  let s = await seed(f, p);
  const input = reviewInput(s);
  input.analysis.push({ ...structuredClone(input.analysis[0]), issue_id: 'newscope', conclusion_mode: 'withheld', withholding_reason: '자료 조사 전', claims: [] });
  const reviewed = await f.request('review', input); assert.equal(reviewed.status, 200);
  s = (await f.request('status', { research_id: s.research_id })).body;
  const before = s.last_review, calls = f.calls.length;
  assert.equal(before.current, true);
  const request = { research_id: s.research_id, expected_revision: s.revision, issue_ids: ['cost'], evidence_ids: [s.evidence[0].evidence_id] };
  let next = (await f.request('reuse', request)).body;
  assert.equal(next.state_version, s.state_version); assert.deepEqual(next.last_review, before);
  next = (await f.request('reuse', { ...request, issue_ids: ['newscope'] })).body;
  assert.equal(next.last_review, null); assert.equal(next.state_version, s.state_version + 1); assert.equal(f.calls.length, calls);
});

test('CF-04: ledger admission exhaustion reports the actual limit before any provider call and keeps the session readable', async t => {
  const f = await fixture(t, { researchOptions: { limits: { ledgerBytes: 8192 } } });
  const s = (await f.request('start', { plan: plan() })).body;
  const refused = await f.request('retrieve', retrieveInput(s));
  assert.equal(refused.status, 429); assert.equal(refused.body.code, 'RESEARCH_CAPACITY');
  assert.equal(refused.body.capacity_reason, 'ledger_bytes');
  assert.equal(refused.body.recovery.research_id, s.research_id);
  assert.equal(refused.body.recovery.remaining_attempts, 40);
  assert.equal(refused.body.recovery.pending, false); assert.equal(refused.body.recovery.retryable, false);
  assert.ok(refused.body.recovery.available_actions.includes('read_stored_evidence'));
  assert.ok(!refused.body.recovery.available_actions.includes('retrieve'));
  assert.equal(f.calls.length, 0);
  const unchanged = (await f.request('status', { research_id: s.research_id })).body;
  assert.equal(unchanged.state_version, s.state_version); assert.equal(unchanged.pending, false);
  assert.deepEqual(unchanged.jobs, []);
  const denied = await f.request('retrieve', retrieveInput(s), 'bob');
  assert.equal(denied.status, 404); assert.equal(denied.body.recovery, undefined);
});

test('CF-05: exhausted attempts retain exact bodies and idempotent job results without recommending a new research', async t => {
  const f = await fixture(t, { researchOptions: { limits: { maxAttempts: 1 } } });
  let s = (await f.request('start', { plan: plan() })).body;
  const request = { ...retrieveInput(s), request_id: randomUUID() };
  s = (await f.request('retrieve', request)).body;
  const e = s.evidence[0], calls = f.calls.length;
  const refused = await f.request('retrieve', { ...request, request_id: randomUUID() });
  assert.equal(refused.status, 429); assert.equal(refused.body.capacity_reason, 'attempts');
  assert.equal(refused.body.recovery.remaining_attempts, 0);
  assert.equal(refused.body.recovery.retryable, false);
  assert.ok(refused.body.recovery.available_actions.includes('review'));
  assert.ok(!refused.body.recovery.available_actions.includes('start_new_research'));
  const replay = (await f.request('retrieve', request)).body;
  assert.equal(replay.replayed, true); assert.deepEqual(replay.job, s.job);
  assert.equal(replay.state_version, s.state_version);
  const read = (await f.request('status', { research_id: s.research_id, evidence_ids: [e.evidence_id] })).body;
  assert.deepEqual(read.evidence, [e]); assert.equal(f.calls.length, calls);
});

test('CF-07: wrong fact references provide separate current fact IDs and date roles for a no-query repair', async t => {
  const f = await fixture(t), s = await seed(f), input = reviewInput(s), calls = f.calls.length;
  input.analysis[0].claims[0].fact_ids = ['old_home_acquired'];
  let review = (await f.request('review', input)).body;
  assert.ok(review.findings.some(item => item.code === 'FACT_NOT_FOUND'));
  assert.ok(review.reference_guide, 'review must provide a safe guide to current reference namespaces');
  assert.deepEqual(review.reference_guide.fact_ids, ['joint']); assert.deepEqual(review.reference_guide.date_roles, []);
  input.analysis[0].claims[0].fact_ids = ['joint'];
  review = (await f.request('review', input)).body;
  assert.ok(!review.findings.some(item => item.code === 'FACT_NOT_FOUND')); assert.equal(f.calls.length, calls);
});

test('CF-08: an ungrounded missing-fact hypothesis asks for requirement research without inventing or deleting its value', async t => {
  const f = await fixture(t), p = plan();
  p.facts.push({ id: 'arbitrary_condition', description: '확인 전 가설 조건', status: 'unknown', value: null, source: '' });
  p.issues[0].required_fact_ids.push('arbitrary_condition');
  const s = (await f.request('start', { plan: p })).body;
  assert.equal(s.interview.next_action, 'assess_requirements'); assert.equal(s.interview.next_question, null);
  assert.deepEqual(s.plan.facts.find(fact => fact.id === 'arbitrary_condition'), p.facts[1]);
  assert.equal(s.requirements.find(r => r.target.id === 'arbitrary_condition').status, 'unresolved');
  assert.equal(f.calls.length, 0);
});

test('CF-06/12: actual MCP summaries stay bounded, explicit paged metadata is complete and source reads are exact', async t => {
  const body = '합성 원문을 변경하지 않습니다. '.repeat(1600);
  const f = await fixture(t, { operation: async (_name, args) => ({ result: { structuredContent: { document: {
    ...exampleDocument().document, ntstDcmId: args.ntst_dcm_id, answer: body } } } }) });
  const rpc = async (name, args, actor = 'alice') => {
    const response = await fetch(f.base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + actor,
      'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0',
        id: randomUUID(), method: 'tools/call', params: { name, arguments: args } }) });
    const payload = await response.json(); assert.equal(payload.error, undefined);
    return payload.result;
  };
  const p = plan(); p.query = '합성 긴 질문 '.repeat(1500);
  let result = await rpc('start_legal_research', { plan: p }), s = result.structuredContent;
  const bounded = state => {
    assert.equal(state.response_mode, 'summary');
    assert.ok(Buffer.byteLength(JSON.stringify(state), 'utf8') <= 32768);
    assert.equal(state.plan, undefined, 'large full plans are read explicitly');
    assert.equal(state.evidence, undefined, 'summary is not a silently truncated body read');
  };
  bounded(s);
  for (let n = 0; n < 3; n++) {
    result = await rpc('research_legal_sources', { research_id: s.research_id, expected_revision: s.revision,
      issue_ids: ['cost'], purpose: 'support', tool: 'get_tax_document', arguments: { ntst_dcm_id: 'synthetic-' + n } });
    s = result.structuredContent; bounded(s); assert.deepEqual(JSON.parse(result.content[0].text), s);
  }
  let page = (await rpc('get_legal_research', { research_id: s.research_id, view: 'evidence_index', limit: 2 })).structuredContent;
  assert.equal(page.response_mode, 'page'); assert.equal(page.page.total, 3); assert.equal(page.items.length, 2);
  assert.equal(page.page.has_more, true); assert.ok(page.page.next_cursor);
  const savedCursor = page.page.next_cursor, ids = page.items.map(e => e.evidence_id);
  page = (await rpc('get_legal_research', { research_id: s.research_id, view: 'evidence_index', limit: 2,
    cursor: savedCursor })).structuredContent;
  assert.equal(page.page.has_more, false); ids.push(...page.items.map(e => e.evidence_id));
  assert.equal(new Set(ids).size, 3);
  const calls = f.calls.length;
  const selected = (await rpc('get_legal_research', { research_id: s.research_id, evidence_ids: [ids[0]] })).structuredContent;
  assert.equal(selected.response_mode, 'selected_evidence'); assert.equal(selected.evidence.length, 1);
  assert.ok(selected.evidence[0].passages.some(passage => passage.text === body));
  assert.ok(selected.manifests.some(m => m.evidence_ids.includes(ids[0]) && m.complete)); assert.equal(f.calls.length, calls);
  assert.equal((await rpc('get_legal_research', { research_id: s.research_id, view: 'evidence_index', cursor: savedCursor }, 'bob')).isError, true);
  await rpc('update_legal_research', { research_id: s.research_id, expected_revision: s.revision, plan: p });
  const stale = await rpc('get_legal_research', { research_id: s.research_id, view: 'evidence_index', cursor: savedCursor });
  assert.equal(stale.isError, true); assert.match(stale.content[0].text, /RESEARCH_STATE_CHANGED/);
});

test('RH-01: all research routes authenticate before source work; start returns a server session', async t => {
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

test('RH-01/11: real authenticated SSE advertises all research tools and returns the same JSON as text', async t => {
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
  r = await f.request('retrieve', { ...retrieveInput(r.body), purpose: 'timing', tool: 'get_law_text', arguments: { lawId: 'SYNTHETIC-STATUTE' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  for (let n = 0; n < 4 && r.body.coverage.obligations.some(o => !o.status.startsWith('completed')); n++) {
    r = await f.request('run', { research_id: r.body.research_id, expected_revision: r.body.revision, request_id: randomUUID(), max_steps: 4 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
  return r.body;
}
function reviewInput(state) {
  const support = state.evidence.find(e => e.purpose === 'support');
  const counter = state.evidence.find(e => e.purpose === 'counter');
  const statute = state.evidence.find(e => e.tool === 'get_law_text');
  const cite = e => ({ evidence_id: e.evidence_id, passage_id: e.passages[0].passage_id, quote: e.passages[0].text,
    relation: 'direct', reason: '합성 적용 관계 원문 확인' });
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
      ...(statute ? { legal_basis: {
        statutes: [{ citation: cite(statute), version: statute.document_version, date_roles: state.plan.issues[0].required_date_roles, reason: '합성 법령 적용 근거' }],
        temporal_application: { status: 'addressed', reason: '합성 시점 적용 검토', citations: [cite(statute)] },
        authorities: [support, counter].filter(e => e.passages.length).map(e => ({ evidence_id: e.evidence_id, kind: 'administrative_interpretation',
          disposition: e === support ? 'applied' : 'distinguished', statute_evidence_ids: [statute.evidence_id], law_version_relation: 'same_rule',
          reason: '합성 법령과 사실의 대응', subsequent_review: { status: 'addressed', reason: '합성 후속 처리 확인', citations: [cite(e)],
            search_attempt_ids: state.coverage.obligations.filter(o => o.purpose === 'subsequent').flatMap(o => o.attempt_ids) } })),
      } } : {}),
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
  assert.equal(result.question_scope_complete, false);
  assert.equal(result.declared_scope_review_complete, false);
  assert.equal(result.scope_completion.status, 'not_configured');
  assert.equal(result.stages.independent_semantic_review, 'not_configured');
  assert.equal(result.claim_coverage, 'submitted_claims_only');
  assert.equal(result.citation_checks[0].quote_match, true);
  assert.equal(result.draft_hash, createHash('sha256').update(JSON.stringify(input.draft_answer)).digest('hex'));
  // Explicit alphabetical projection, independent of the production canonicalizer.
  const bindingJson = JSON.stringify({ analysis_hash: result.analysis_hash, correction_needed: false, draft_hash: result.draft_hash,
    plan_hash: result.plan_hash, policy_version: result.policy_version, research_id: result.research_id, revision: result.revision,
    scope_assessment_hash: result.scope_assessment_hash, snapshot_hash: result.snapshot_hash, state_version: result.state_version });
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

test('RH-05: configured scope completion is returned through the authenticated review API', async t => {
  const f = await fixture(t), p = plan();
  p.scope_review = { mode: 'question', tracks: [{ id: 'requested_cost', party: '합성 당사자',
    legal_question: '합성 원가의 구분 조건', factual_anchor_ids: ['joint'], relation: 'requested',
    blocks_track_ids: [], issue_id: 'cost', lifecycle: 'active' }] };
  const state = await seed(f, p), input = reviewInput(state);
  input.scope_assessments = [{ track_id: 'requested_cost', status: 'supported', reason: '합성 근거 확인',
    fact_ids: ['joint'], evidence_ids: [state.evidence.find(item => item.purpose === 'support').evidence_id] }];
  const result = (await f.request('review', input)).body;
  assert.equal(result.status, 'structurally_complete', JSON.stringify(result));
  assert.equal(result.question_scope_complete, true);
  assert.equal(result.declared_scope_review_complete, true);
  assert.equal(result.scope_completion.status, 'complete');
  const changed = structuredClone(input); changed.scope_assessments[0].reason = '같은 상태의 다른 설명';
  const changedResult = (await f.request('review', changed)).body;
  assert.equal(changedResult.analysis_hash, result.analysis_hash);
  assert.notEqual(changedResult.scope_assessment_hash, result.scope_assessment_hash);
  assert.notEqual(changedResult.binding_hash, result.binding_hash);
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
  const state = await seed(f), input = reviewInput(state), beforeCalls = f.calls.length;
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
  assert.equal(f.calls.length, beforeCalls + 1);
});

test('RH-08: lifetime attempt and receipt limits reserve before upstream; update does not replenish attempts', async t => {
  const f = await fixture(t, { researchOptions: { limits: { maxAttempts: 1, maxReceipts: 1 } } });
  let state = (await f.request('start', { plan: plan() })).body;
  state = (await f.request('retrieve', retrieveInput(state))).body;
  assert.equal((await f.request('retrieve', retrieveInput(state))).status, 429);
  state = (await f.request('update', { research_id: state.research_id, expected_revision: 1, plan: plan() })).body;
  assert.equal(state.evidence.length, 1); assert.equal(state.evidence[0].revision, 1); assert.equal(state.attempts.length, 1);
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
  assert.equal(f.calls.filter(c => !c.name.startsWith('search_')).length, 3);
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
  const small = await fixture(t, { researchOptions: { limits: { maxSessionBytes: 9_000 } } });
  const state = (await small.request('start', { plan: plan() })).body;
  assert.equal((await small.request('retrieve', retrieveInput(state))).status, 429); assert.equal(small.calls.length, 0);
  const one = await fixture(t, { researchOptions: { limits: { maxSessionsPerActor: 1, maxSessions: 2 } } });
  assert.equal((await one.request('start', { plan: plan() })).status, 200);
  assert.equal((await one.request('start', { plan: plan() })).status, 429);
  assert.equal((await one.request('start', { plan: plan() }, 'bob')).status, 200);
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const f = await fixture(t, { researchOptions: { limits: { maxTotalBytes: 200_000, transientBytes: 131072 } }, operation: async () => {
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
  assert.equal(response.status, 200);
  assert.equal(response.body.job.status, 'failed');
  assert.equal(response.body.attempts.at(-1).error_code, 'RESEARCH_CAPACITY');
  assert.equal(response.body.evidence.length, 0);
  assert.equal(response.body.manifests.length, 0);
  assert.equal(response.body.pending, false);
});

test('RH-07: legacy analyze rejects impossible calendar days before touching upstream', async t => {
  const f = await fixture(t);
  const response = await fetch(f.base + '/api/analyze', { method: 'POST', headers: { authorization: 'Bearer alice', 'content-type': 'application/json' },
    body: JSON.stringify({ query: '합성', event_dates: { transfer: '2025-02-29' } }) });
  assert.equal(response.status, 400); assert.equal(f.calls.length, 0);
});
