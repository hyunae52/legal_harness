import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectScopeCompletion } from '../dist/scopeCompletion.js';
import { ResearchPlan } from '../dist/researchContracts.js';

const uuid = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const issue = id => ({ id, question: `${id} 법적 질문`, required_fact_ids: [`fact_${id}`], required_date_roles: [] });
const fact = id => ({ id: `fact_${id}`, description: `${id} 근거 사실`, status: 'provided', value: '확인됨', source: '고정 시험 입력' });
const track = (id, issueId, relation = 'requested', lifecycle = 'active', blocks = []) => ({
  id, party: `${id} 당사자`, legal_question: `${id} 법적 질문`, factual_anchor_ids: [`fact_${issueId ?? 'req'}`],
  relation, blocks_track_ids: blocks, issue_id: issueId, lifecycle,
});
const receipt = (number, issueId) => ({
  evidence_id: uuid(number), revision: 1, issue_ids: [issueId], purpose: 'support', tool: 'fixture', arguments_hash: 'hash',
  observed_at: '2026-09-23T00:00:00.000Z', expires_at: '2026-09-23T00:30:00.000Z', upstream_name: 'fixture',
  upstream_version: '1', upstream_commit: null, response_hash: 'hash', body_scope: 'body_returned', document_id: 'doc',
  document_version: '1', source_url: null, source_kind: 'provider_formatted_text', completeness: 'unverified', outcome: 'completed',
  units: [{ unit_id: 'u1', role: 'document', date: null, source_access: 'available', body_scope: 'body_returned', document_id: 'doc', document_version: '1' }],
  passages: [{ passage_id: 'p1', unit_id: 'u1', role: 'document', field: 'answer', text: '고정 근거', hash: 'hash', body_scope: 'body_returned', start: 0, end: 5 }],
});
const analysis = id => ({ issue_id: id, conclusion_mode: 'definitive' });
const assessment = (trackId, issueId, evidenceId, status = 'supported') => ({
  track_id: trackId, status, reason: '고정 근거로 처리', fact_ids: [`fact_${issueId}`], evidence_ids: [evidenceId],
});
const run = (plan, scopeAssessments, evidence = [], attempts = [], findings = []) => inspectScopeCompletion(
  { analysis: plan.issues.map(item => analysis(item.id)), scope_assessments: scopeAssessments }, plan, evidence, attempts, findings);

test('scope state variants keep question completion separate from declared-scope completion', () => {
  const reqEvidence = receipt(1, 'req');
  const requested = track('requested_tax', 'req');
  const base = { query: '합성', issues: [issue('req')], facts: [fact('req')], event_dates: [] };

  const independentPlan = { ...base, scope_review: { mode: 'question', tracks: [requested,
    track('adjacent_notice', null, 'independent_notice', 'candidate')] } };
  let result = run(independentPlan, [assessment('requested_tax', 'req', reqEvidence.evidence_id),
    { track_id: 'adjacent_notice', status: 'unresolved', reason: '인접 쟁점 미확인', fact_ids: [], evidence_ids: [] }], [reqEvidence]);
  assert.equal(result.question_scope_complete, true);
  assert.equal(result.declared_scope_review_complete, false);
  assert.ok(!result.findings.some(item => item.code === 'DEFINITIVE_WITH_OPEN_SCOPE_DEPENDENCY'));

  const dependencyPlan = { ...base, scope_review: { mode: 'question', tracks: [requested,
    track('answer_dependency', null, 'answer_dependency', 'candidate', ['requested_tax'])] } };
  result = run(dependencyPlan, [assessment('requested_tax', 'req', reqEvidence.evidence_id),
    { track_id: 'answer_dependency', status: 'unresolved', reason: '답변 의존 쟁점 미확인', fact_ids: [], evidence_ids: [] }], [reqEvidence]);
  assert.equal(result.question_scope_complete, false);
  assert.equal(result.declared_scope_review_complete, false);
  assert.ok(result.findings.some(item => item.code === 'DEFINITIVE_WITH_OPEN_SCOPE_DEPENDENCY'));

  const adjacentEvidence = receipt(2, 'adj');
  const completePlan = { ...base, issues: [issue('req'), issue('adj')], facts: [fact('req'), fact('adj')],
    scope_review: { mode: 'question', tracks: [requested, track('adjacent_notice', 'adj', 'independent_notice')] } };
  result = run(completePlan, [assessment('requested_tax', 'req', reqEvidence.evidence_id),
    assessment('adjacent_notice', 'adj', adjacentEvidence.evidence_id, 'excluded')], [reqEvidence, adjacentEvidence]);
  assert.equal(result.question_scope_complete, true);
  assert.equal(result.declared_scope_review_complete, true);
  assert.equal(result.status, 'complete');
});

test('only supported or validly evidenced excluded tracks close completion', () => {
  const evidence = receipt(1, 'req');
  const plan = { query: '합성', issues: [issue('req')], facts: [fact('req')], event_dates: [],
    scope_review: { mode: 'question', tracks: [track('requested_tax', 'req')] } };
  for (const status of ['conditional', 'unresolved', 'pending']) {
    const result = run(plan, [{ track_id: 'requested_tax', status, reason: '열린 상태', fact_ids: [], evidence_ids: [] }], [evidence]);
    assert.equal(result.question_scope_complete, false, status);
  }
  for (const status of ['supported', 'excluded']) {
    const result = run(plan, [assessment('requested_tax', 'req', evidence.evidence_id, status)], [evidence]);
    assert.equal(result.question_scope_complete, true, status);
  }
});

test('failed retrieval cannot be converted into an excluded closed track', () => {
  const evidence = receipt(1, 'req');
  const plan = { query: '합성', issues: [issue('req')], facts: [fact('req')], event_dates: [],
    scope_review: { mode: 'question', tracks: [track('requested_tax', 'req')] } };
  const attempts = [{ attempt_id: uuid(9), revision: 1, issue_ids: ['req'], purpose: 'support', tool: 'fixture',
    arguments_hash: 'hash', status: 'failed', error_code: 'FIXTURE_FAILURE' }];
  const result = run(plan, [assessment('requested_tax', 'req', evidence.evidence_id, 'excluded')], [evidence], attempts);
  assert.equal(result.question_scope_complete, false);
  assert.ok(result.track_results[0].reasons.includes('issue_has_incomplete_retrieval'));
});

test('a thirteenth overflow dependency is retained and keeps completion false', () => {
  const issues = Array.from({ length: 12 }, (_, index) => issue(index ? `adj${index}` : 'req'));
  const facts = issues.map(item => fact(item.id));
  const tracks = issues.map((item, index) => track(index ? `track_${index}` : 'requested_tax', item.id,
    index ? 'independent_notice' : 'requested'));
  tracks.push(track('overflow_dependency', null, 'answer_dependency', 'overflow', ['requested_tax']));
  const evidence = issues.map((item, index) => receipt(index + 1, item.id));
  const assessments = issues.map((item, index) => assessment(index ? `track_${index}` : 'requested_tax', item.id, evidence[index].evidence_id));
  assessments.push({ track_id: 'overflow_dependency', status: 'overflow', reason: '실행 슬롯 12개 소진', fact_ids: [], evidence_ids: [] });
  const plan = { query: '합성', issues, facts, event_dates: [], scope_review: { mode: 'comprehensive', tracks } };
  const result = run(plan, assessments, evidence);
  assert.equal(result.question_scope_complete, false);
  assert.equal(result.declared_scope_review_complete, false);
  assert.deepEqual(result.open_track_ids, ['overflow_dependency']);
});

test('legacy plans cannot accidentally claim scope completion', () => {
  const plan = { query: '합성', issues: [issue('req')], facts: [fact('req')], event_dates: [] };
  const result = run(plan, []);
  assert.equal(result.status, 'not_configured');
  assert.equal(result.question_scope_complete, false);
  assert.equal(result.declared_scope_review_complete, false);
});

test('scope contract rejects invalid blocking relationships and accepts retained overflow', () => {
  const base = { query: '합성', issues: [issue('req')], facts: [fact('req')], event_dates: [] };
  const invalid = { ...base, scope_review: { mode: 'question', tracks: [track('requested_tax', 'req'),
    track('bad_dependency', null, 'answer_dependency', 'candidate', [])] } };
  assert.equal(ResearchPlan.safeParse(invalid).success, false);
  const valid = { ...base, scope_review: { mode: 'question', tracks: [track('requested_tax', 'req'),
    track('overflow_dependency', null, 'answer_dependency', 'overflow', ['requested_tax'])] } };
  assert.equal(ResearchPlan.safeParse(valid).success, true);
});

test('duplicate or unknown assessments cannot produce a completed scope', () => {
  const evidence = receipt(1, 'req');
  const plan = { query: '합성', issues: [issue('req')], facts: [fact('req')], event_dates: [],
    scope_review: { mode: 'question', tracks: [track('requested_tax', 'req')] } };
  const closed = assessment('requested_tax', 'req', evidence.evidence_id);
  let result = run(plan, [closed, closed], [evidence]);
  assert.equal(result.question_scope_complete, false);
  assert.ok(result.findings.some(item => item.code === 'SCOPE_ASSESSMENT_DUPLICATE'));
  result = run(plan, [closed, { ...closed, track_id: 'unknown_track' }], [evidence]);
  assert.equal(result.question_scope_complete, false);
  assert.ok(result.findings.some(item => item.code === 'SCOPE_ASSESSMENT_UNKNOWN_TRACK'));
  assert.ok(result.open_track_ids.includes('unknown_track'));
  result = run(plan, [closed], [evidence], [], [{ code: 'ISSUE_COVERAGE', severity: 'blocked', detail: '합성 전역 공백' }]);
  assert.equal(result.question_scope_complete, false);
  assert.ok(result.track_results[0].reasons.includes('review_has_global_findings'));
});
