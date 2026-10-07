import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const base = process.argv[2];
assert.ok(base === 'https://law.taxlab.kr' || process.env.TAXLAB_SMOKE_LOCAL_FIXTURE === '1' && /^http:\/\/127\.0\.0\.1:\d+$/.test(base));
const health = await (await fetch(base + '/health')).json();
assert.equal(health.version, '2.5.0');
assert.equal(health.research_harness.reasoning_review.enabled, true);
const client = new Client({ name: 'taxlab-release-verification', version: '2.5.0' });
const rest = async (route, input) => {
  const response = await fetch(base + '/api/research/' + route, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
  return { status: response.status, body: await response.json() };
};
const checked = async (route, input) => {
  const r = await rest(route, input);
  assert.equal(r.status, 200, route + ': ' + (r.body.code ?? r.status));
  return r.body;
};
try {
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
  const catalog = await client.listTools();
  for (const name of ['prepare_reasoning_review', 'submit_reasoning_review', 'search_law']) assert.ok(catalog.tools.some(t => t.name === name));
  const plan = { query: '운영 연결 점검: 민법 법령 조회와 미완료 검토 상태 확인',
    issues: [{ id: 'smoke', question: '민법 원문을 확보하고 검토했는가', required_fact_ids: [], required_date_roles: [], profile: 'general' }], facts: [], event_dates: [] };
  let s = await checked('start', { plan });
  const session = s.client_session, research_id = s.research_id;
  // 001706 is the Civil Act ID observed in the live search response. A law-name
  // search alone is exploratory and cannot count as a required counter search.
  s = await checked('retrieve', { research_id, expected_revision: s.revision, client_session: session, issue_ids: ['smoke'], purpose: 'context',
    tool: 'get_law_text', arguments: { lawId: '001706', jo: '제1조' } });
  s = await checked('status', { research_id, client_session: session, view: 'full' });
  assert.ok(s.evidence.some(e => e.statute_anchor && e.body_scope === 'body_returned'), 'An observed law body anchor is required');
  const counter = s.coverage.obligations.find(o => o.purpose === 'counter' && o.next_step);
  assert.ok(counter, 'The server must generate the actual counter-search obligation');
  const step = counter.next_step;
  s = await checked('retrieve', { research_id, expected_revision: s.revision, client_session: session,
    issue_ids: step.issue_ids, purpose: step.purpose, tool: step.tool, arguments: step.arguments });
  s = await checked('status', { research_id, client_session: session, view: 'full' });
  const attempt = s.attempts.find(a => a.obligation_id === counter.obligation_id && a.obligation_purpose === 'counter'
    && a.search?.status === 'complete' && ['completed', 'empty'].includes(a.status));
  assert.ok(attempt, 'The actual required counter search must complete without a provider error');
  const answer = '운영 점검용: 법령 원문 검토를 아직 완료하지 않았다.';
  const review = { research_id, expected_revision: s.revision, expected_state_version: s.state_version, client_session: session,
    reasoning_contract_version: 2, draft_answer: answer, correction_needed: false,
    analysis: [{ issue_id: 'smoke', conclusion_mode: 'withheld', withholding_reason: '조회 연결 점검이며 법률 결론을 작성하지 않는다.',
      claims: [], legal_tests: [], excluded_tests: [], authority_conflicts: [],
      strongest_opposition: { status: 'none_observed', reason: '운영 연결 점검에서 반대 검색은 수행했으나 후보 전문의 판단은 미완료이며 법률 결론을 내리지 않는다.', search_attempt_ids: [attempt.attempt_id] },
      counter_evidence: [], unknowns: ['법령 원문과 적용 조건 미검토'], next_queries: ['민법 원문'],
      timing: { status: 'unresolved', reason: '연결 시험에서 미검토', date_roles: [] }, exceptions: { status: 'unresolved', reason: '연결 시험에서 미검토' } }],
    answer_blocks: [{ id: 'status', kind: 'uncertainty', text: answer, issue_id: 'smoke', claim_ids: [], test_ids: [], citations: [] }] };
  const mcpReview = await client.callTool({ name: 'review_legal_reasoning', arguments: review });
  assert.ok(!mcpReview.isError, 'v2 review must be accepted');
  const r = mcpReview.structuredContent; assert.equal(r.ready_for_answer, false);
  const p = await checked('prepare-review', { research_id, expected_revision: s.revision, expected_state_version: r.state_version,
    client_session: session, request_id: randomUUID(), ...r.reasoning_artifact });
  const input = { research_id, expected_revision: s.revision, expected_state_version: p.state_version, client_session: session, request_id: randomUUID(),
    packet_id: p.packet.packet_id, content_hash: p.packet.content_hash, manifest_hash: p.packet.manifest_hash,
    result: 'revise', reviewer: { kind: 'self_review', model: 'release-smoke-script' }, findings: [{ issue_id: 'smoke', block_id: 'status', quote: answer,
      reason: '원문 및 적용 조건 검토가 미완료다.', suggested_change: '실제 답변 전에 원문 및 조건을 검토한다.', citations: [] }], prior_findings: [], qualifications: [] };
  assert.equal((await rest('submit-review', input)).body.code, 'REVIEW_MATERIAL_INCOMPLETE');
  let cursor, pages = 0, policySeen = false;
  do {
    const result = await client.callTool({ name: 'get_legal_research', arguments: { research_id, client_session: session,
      view: 'review_packet', packet_id: p.packet.packet_id, packet_manifest_hash: p.packet.manifest_hash, packet_cursor: cursor, limit: 1 } });
    assert.ok(!result.isError); policySeen ||= result.structuredContent.items.some(u => u.id === 'review_policy');
    cursor = result.structuredContent.page.next_cursor; pages++;
  } while (cursor);
  assert.equal(policySeen, true);
  const accepted = await checked('submit-review', input);
  assert.equal(accepted.ready_for_answer, false); assert.equal(accepted.model_review.accepted_count, 1);
  assert.equal(accepted.legal_verification, 'unverified'); assert.equal(accepted.independent_review, 'not_performed');
  assert.equal((await checked('submit-review', input)).replayed, true);
  const foreign = await checked('start', { plan });
  assert.equal((await rest('submit-review', { ...input, client_session: foreign.client_session })).status, 404);
  console.log(JSON.stringify({ status: 'pass', version: health.version, public_keyless: true, live_upstream_search: true,
    mcp_rest_roundtrip: true, packet_pages: pages, review_policy_seen: policySeen, incomplete_material_rejected: true, accepted_review_count: 1,
    incomplete_research_ready: false, receipt_replay: true, cross_session_denied: true, independent_review: accepted.independent_review }));
} finally { await client.close(); }
