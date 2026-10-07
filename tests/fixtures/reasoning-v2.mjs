import { randomUUID } from 'node:crypto';
import { coverageFixture, coverageReview, coverageActor } from './authority-provider.mjs';

export function reasoningInput(state) {
  const input = coverageReview(state), a = input.analysis[0], citation = structuredClone(a.claims[0].citations[0]);
  input.reasoning_contract_version = 2;
  input.answer_blocks = [{ id: 'answer', kind: 'claim', text: input.draft_answer, issue_id: 'case',
    claim_ids: ['claim'], test_ids: ['acquired'], citations: [] }];
  a.legal_tests = [{ id: 'acquired', proposition: '합성 취득 요건', kind: 'prerequisite',
    citations: [citation], version: a.legal_basis.statutes[0].version, date_roles: [] }];
  a.excluded_tests = []; a.authority_conflicts = [];
  a.strongest_opposition = { status: 'none_observed', reason: '정상 수행한 반대 검색에서 반례를 관측하지 못했다. 부재의 증명은 아니다.',
    search_attempt_ids: state.attempts.filter(a => a.obligation_purpose === 'counter').map(a => a.attempt_id) };
  Object.assign(a.claims[0], { test_expression: { test_id: 'acquired' }, test_result: 'satisfied',
    application: [{ test_id: 'acquired', fact_ids: ['known'], date_roles: [], citations: [citation],
      finding: 'satisfied', application_reason: '제공된 취득 사실과 합성 요건을 연결한다.' }] });
  return input;
}

export async function reasoningFixture(options = {}, operation) {
  const fixture = coverageFixture(operation, { reasoningV2Enabled: true, ...options });
  let state = await fixture.start();
  state = await fixture.finish(await fixture.law(state));
  return { ...fixture, state, input: reasoningInput(state) };
}
export const status = f => f.service.run('get_legal_research', coverageActor, { research_id: f.state.research_id });
export async function review(f, input = f.input) {
  const s = await status(f);
  return f.service.run('review_legal_reasoning', coverageActor, { ...input, expected_revision: s.revision, expected_state_version: s.state_version });
}
export async function prepare(f) {
  const s = await status(f);
  const input = { research_id: s.research_id, expected_revision: s.revision, expected_state_version: s.state_version,
    request_id: randomUUID(), ...s.reasoning_artifact };
  return { input, response: await f.service.run('prepare_reasoning_review', coverageActor, input) };
}
export async function readAll(f, prepared, limit = 1) {
  const packet = prepared.response.packet, all = []; let cursor;
  do {
    const page = await f.service.run('get_legal_research', coverageActor, { research_id: f.state.research_id, view: 'review_packet',
      packet_id: packet.packet_id, packet_manifest_hash: packet.manifest_hash, packet_cursor: cursor, limit });
    all.push(...page.items); cursor = page.page.next_cursor;
  } while (cursor);
  return all;
}
export async function submit(f, prepared, changes = {}) {
  const s = await status(f), p = prepared.response.packet;
  const input = { research_id: s.research_id, expected_revision: s.revision, expected_state_version: s.state_version,
    request_id: randomUUID(), packet_id: p.packet_id, content_hash: p.content_hash, manifest_hash: p.manifest_hash,
    result: 'no_detected_issue', reviewer: { kind: 'self_review', model: 'synthetic-test' }, findings: [], prior_findings: [], qualifications: [], ...changes };
  return { input, response: await f.service.run('submit_reasoning_review', coverageActor, input) };
}
