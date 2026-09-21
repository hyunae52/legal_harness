import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { createApp } from '../dist/app.js';
import { ServiceError } from '../dist/contracts.js';

const plan = () => ({ query: '합성 공동취득 사례', issues: [
  { id: 'cost', question: '합성 원가 배분', required_fact_ids: ['known', 'payer', 'amount'], required_date_roles: ['sale'] },
  { id: 'timing', question: '합성 시점', required_fact_ids: ['payer'], required_date_roles: ['sale'] },
], facts: [
  { id: 'known', description: '공동 취득 여부', status: 'provided', value: '공동 취득', source: '사용자 진술' },
  { id: 'payer', description: '분담금 실제 부담자', status: 'unknown', value: null, source: '' },
  { id: 'amount', description: '실제 분담금액', status: 'assumed', value: '합성 가정액', source: '임시 가정' },
], event_dates: [{ role: 'sale', value: '2024-09', precision: 'month', basis: 'provided', source: '합성 진술' }] });

async function fixture(t, opts = {}) {
  let calls = 0;
  const law = { releaseVersion: 'fixture', close: async () => {},
    listTools: async () => ({ tools: [{ name: 'search_law', inputSchema: { type: 'object' } }] }),
    callTool: async () => { calls++; await opts.operation?.(); return { result: { content: [{ type: 'text', text: '합성 본문' }] } }; } };
  const runtime = createApp({ law, authenticate: async req => {
    if (!['Bearer alice', 'Bearer bob'].includes(req.get('authorization'))) throw new ServiceError(401, 'UNAUTHORIZED');
    return { id: req.get('authorization').slice(7), kind: 'auth_user' };
  }, ...opts });
  const server = createServer(runtime.app);
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await runtime.close(); server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const request = async (path, body, actor = 'alice', extra = {}) => {
    const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: {
      'content-type': 'application/json', accept: 'application/json, text/event-stream',
      ...(actor ? { authorization: 'Bearer ' + actor } : {}), ...extra,
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(4000) });
    const raw = await res.text();
    let bodyResult; try { bodyResult = raw ? JSON.parse(raw) : null; } catch { bodyResult = { non_json: raw.slice(0, 100) }; }
    return { status: res.status, headers: res.headers, body: bodyResult };
  };
  const client = async (actor = 'alice', endpoint = 'mcp') => {
    const c = new Client({ name: 'transport-interview-contract', version: '1' });
    const Transport = endpoint === 'mcp' ? StreamableHTTPClientTransport : SSEClientTransport;
    await c.connect(new Transport(new URL(base + '/' + endpoint), { requestInit: { headers: { authorization: 'Bearer ' + actor } } }), { timeout: 3000 });
    t.after(() => c.close()); return c;
  };
  return { request, client, runtime, base, calls: () => calls };
}
const rpc = (name, args = {}, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });
const answer = (state, value) => ({ research_id: state.research_id, expected_revision: state.revision,
  expected_state_version: state.state_version, question_id: state.interview.next_question.question_id, answer: value });
const ask = (f, route, body, actor) => f.request('/api/research/' + route, body, actor);
const eventually = async predicate => {
  const end = Date.now() + 3000;
  while (!await predicate()) { if (Date.now() > end) assert.fail('bounded condition did not settle'); await new Promise(r => setTimeout(r, 5)); }
};

test('TI-01/02: stateless SDK client, repeated IDs, authentication and legacy SSE share the tool contract', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/mcp', rpc('search_law'), null)).status, 401);
  const client = await f.client(), sse = await f.client('alice', 'sse');
  const names = (await client.listTools()).tools.map(t => t.name).sort();
  assert.ok(names.includes('answer_legal_question'));
  assert.deepEqual((await sse.listTools()).tools.map(t => t.name).sort(), names);
  for (let i = 0; i < 7; i++) {
    const r = await f.request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.equal(r.status, 200); assert.equal(r.headers.get('mcp-session-id'), null);
    assert.ok(r.body.result.tools.length); assert.match(r.headers.get('content-type'), /application\/json/);
  }
  assert.equal((await f.request('/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  assert.equal((await f.request('/mcp')).status, 405);
  assert.equal((await f.request('/mcp', undefined, null)).status, 401);
  assert.equal((await fetch(f.base + '/mcp', { method: 'DELETE', headers: { authorization: 'Bearer alice' } })).status, 405);
  assert.equal((await f.request('/mcp', rpc('search_law'), 'alice', { origin: 'https://evil.invalid' })).status, 403);
  assert.equal((await f.request('/mcp', rpc('search_law'), 'alice', { 'mcp-protocol-version': 'invalid' })).status, 400);
  assert.equal((await f.request('/mcp', [rpc('search_law')])).status, 400);
  assert.equal(f.calls(), 0);
});

test('TI-03: SSE and in-flight HTTP share admission; disconnection holds real work until settled', async t => {
  const pending = Promise.withResolvers(); let entered = false;
  const f = await fixture(t, { maxSessions: 1, maxActive: 1, operation: async () => { entered = true; await pending.promise; } });
  t.after(() => pending.resolve());
  const sse = await f.client('alice', 'sse');
  assert.equal((await f.request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 429);
  await sse.close();
  await eventually(async () => (await f.request('/health')).body.mcp_transport.active === 0);
  const abort = new AbortController();
  const operation = fetch(f.base + '/mcp', { method: 'POST', signal: abort.signal,
    headers: { authorization: 'Bearer alice', 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(rpc('search_law')) }).catch(() => null);
  await eventually(() => entered);
  assert.equal((await f.request('/mcp', rpc('search_law'), 'bob')).status, 429);
  abort.abort(); await operation;
  assert.equal((await f.request('/api/analyze', { query: '합성' }, 'bob')).status, 429);
  let drained = false; const drain = f.runtime.drain(2000).then(() => { drained = true; });
  await new Promise(r => setTimeout(r, 20)); assert.equal(drained, false);
  assert.equal((await f.request('/mcp', rpc('search_law'))).status, 503);
  pending.resolve(); await drain;
  assert.equal((await f.request('/health')).body.active_requests, 0);
});

test('TI-04: retrieval rate is shared across REST/HTTP/SSE and actor buckets; local questions remain usable', async t => {
  let now = 0;
  const f = await fixture(t, { resourceOptions: { now: () => now, limits: { lookupRpm: 2, actorLookupRpm: 1 } } });
  const sse = await f.client('bob', 'sse');
  assert.equal((await f.request('/api/analyze', { query: '합성' })).status, 200);
  assert.equal((await f.request('/api/analyze', { query: '합성' })).status, 429);
  const denied = await f.request('/mcp', rpc('search_law'));
  assert.equal(denied.body.result.isError, true); assert.match(denied.body.result.content[0].text, /LOOKUP_RATE_LIMIT/);
  assert.equal((await sse.callTool({ name: 'search_law', arguments: {} })).isError, undefined);
  assert.equal((await f.request('/api/analyze', { query: '합성' }, 'bob')).status, 429);
  const state = (await ask(f, 'start', { plan: plan() })).body;
  assert.ok(state.interview.next_question); assert.equal(f.calls(), 2);
  const next = await ask(f, 'answer', answer(state, { kind: 'unknown', reason: '사용자가 모른다고 답함' }));
  assert.equal(next.status, 200); assert.equal(f.calls(), 2);
  now = 60_001;
  assert.equal((await f.request('/api/analyze', { query: '합성' })).status, 200);
});

test('TI-05/06/07: one question, reuse known facts, revision bound answers and conservative evidence invalidation', async t => {
  const f = await fixture(t);
  let state = (await ask(f, 'start', { plan: plan() })).body;
  assert.ok(state.interview, 'research start must supply an interview next action');
  assert.equal(state.interview.next_question.target.id, 'payer');
  assert.deepEqual(state.interview.next_question.issue_ids, ['cost', 'timing']);
  assert.equal(state.interview.unresolved_count, 3);
  const input = answer(state, { kind: 'fact', value: '두 사람이 절반씩 부담', source: '현재 사용자 답변' });
  assert.equal((await ask(f, 'answer', input, 'bob')).status, 404);
  assert.equal((await ask(f, 'answer', { ...input, question_id: 'fabricated' })).status, 409);
  assert.equal((await ask(f, 'answer', { ...input, expected_state_version: 99 })).status, 409);
  const good = await ask(f, 'answer', input); assert.equal(good.status, 200);
  state = good.body;
  assert.equal(state.revision, 2); assert.equal(state.plan.facts[1].status, 'provided');
  assert.equal(state.plan.facts[1].source, '현재 사용자 답변');
  assert.equal(state.interview.next_question.target.id, 'amount');
  assert.equal((await ask(f, 'answer', input)).status, 409);
  const expiry = state.expires_at, revision = state.revision;
  state = (await ask(f, 'answer', answer(state, { kind: 'unknown', reason: '영수증이 없어 현재 확인 불가' }))).body;
  assert.equal(state.revision, revision); assert.equal(state.plan.facts[2].status, 'assumed');
  assert.equal(state.interview.next_question.target.id, 'sale');
  const invalid = await ask(f, 'answer', answer(state, { kind: 'date', value: '2024-02-30', precision: 'day', source: '합성' }));
  assert.equal(invalid.status, 400);
  state = (await ask(f, 'answer', answer(state, { kind: 'date', value: '2024-09', precision: 'month', source: '사용자: 월만 확인됨' }))).body;
  assert.equal(state.plan.event_dates[0].precision, 'month');
  assert.equal(state.interview.next_question, null);
  assert.equal(state.interview.next_action, 'conditional_or_withheld');
  assert.equal(state.interview.unresolved_count, 2);
  assert.equal(state.expires_at, expiry); assert.equal(state.legal_verification, 'unverified');
  assert.equal(f.calls(), 0);
  const updated = await ask(f, 'update', { research_id: state.research_id, expected_revision: state.revision, plan: state.plan });
  assert.equal(updated.body.interview.next_question.target.id, 'amount');
});

test('TI-06/07: answers reject busy/stale state and do not replenish attempts or preserve old receipts', async t => {
  const pending = Promise.withResolvers(); let entered = false;
  const f = await fixture(t, { operation: async () => { entered = true; await pending.promise; } });
  t.after(() => pending.resolve());
  let state = (await ask(f, 'start', { plan: plan() })).body;
  assert.ok(state.interview, 'research start must supply an interview next action');
  const oldAnswer = answer(state, { kind: 'fact', value: '공동 부담', source: '합성 진술' });
  const read = ask(f, 'retrieve', { research_id: state.research_id, expected_revision: state.revision,
    issue_ids: ['cost'], purpose: 'support', tool: 'search_law', arguments: { query: '합성' } });
  await eventually(() => entered);
  assert.equal((await ask(f, 'answer', oldAnswer)).body.code, 'RESEARCH_BUSY');
  pending.resolve(); state = (await read).body;
  assert.equal((await ask(f, 'answer', oldAnswer)).body.code, 'RESEARCH_STATE_CHANGED');
  assert.ok(state.evidence.length);
  const next = (await ask(f, 'answer', answer(state, oldAnswer.answer))).body;
  assert.deepEqual(next.evidence, []); assert.equal(next.last_review, null);
  assert.equal(next.remaining_attempts, state.remaining_attempts);
  assert.equal(next.expires_at, state.expires_at);
});

test('TI-09: interview works through a real stateless MCP call and advertised Actions schema', async t => {
  const f = await fixture(t), c = await f.client();
  const started = await c.callTool({ name: 'start_legal_research', arguments: { plan: plan() } });
  const state = started.structuredContent;
  const result = await c.callTool({ name: 'answer_legal_question', arguments: answer(state, { kind: 'unknown', reason: '합성 미상' }) });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(result.structuredContent.interview.next_question.target.id, 'amount');
  const schema = (await f.request('/openapi.json')).body;
  assert.equal(schema.paths['/api/research/answer'].post.operationId, 'answer_legal_question');
  assert.equal(f.calls(), 0);
});
