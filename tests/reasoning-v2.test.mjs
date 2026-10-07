import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { researchSchemas, researchTools } from '../dist/researchContracts.js';
import { reasoningFixture, review, prepare, readAll, submit, status } from './fixtures/reasoning-v2.mjs';
import { coverageActor, coverageReview } from './fixtures/authority-provider.mjs';
import { digest } from '../dist/contracts.js';
import { evaluateTests, inspectApplication } from '../dist/reasoningApplication.js';
import { admitReceipt, emptyReasoningState, findingView } from '../dist/reasoningReviewState.js';
import { GateEngine } from '../dist/gates.js';

const code = expected => e => e.code === expected;
const finding = input => ({ issue_id: 'case', block_id: 'answer', quote: input.draft_answer,
  reason: '본문의 적용 이유가 부족하다.', suggested_change: '요건과 사실의 대응을 보충하라.', citations: [] });

test('IR-19/23: v2 structure input and model-neutral review tools are exposed', async () => {
  const f = await reasoningFixture();
  assert.equal(researchSchemas.review_legal_reasoning.safeParse(f.input).success, true,
    'approved v2 element/application/whole-answer contract must be accepted');
  for (const name of ['prepare_reasoning_review', 'submit_reasoning_review'])
    assert.ok(researchTools.some(tool => tool.name === name), name);
});

test('IR-02/03/04/05: independent three-valued truth table, bounded expressions and no unknown negation shortcut', async () => {
  const values = ['satisfied', 'not_satisfied', 'unknown'];
  const all = [['satisfied', 'not_satisfied', 'unknown'], ['not_satisfied', 'not_satisfied', 'not_satisfied'], ['unknown', 'not_satisfied', 'unknown']];
  const any = [['satisfied', 'satisfied', 'satisfied'], ['satisfied', 'not_satisfied', 'unknown'], ['satisfied', 'unknown', 'unknown']];
  for (let a = 0; a < 3; a++) for (let b = 0; b < 3; b++) {
    const facts = new Map([['a', values[a]], ['b', values[b]]]);
    assert.equal(evaluateTests({ all: [{ test_id: 'a' }, { test_id: 'b' }] }, facts), all[a][b]);
    assert.equal(evaluateTests({ any: [{ test_id: 'a' }, { test_id: 'b' }] }, facts), any[a][b]);
  }
  assert.equal(evaluateTests({ not: { test_id: 'a' } }, new Map([['a', 'unknown']])), 'unknown');
  const f = await reasoningFixture();
  const claim = f.input.analysis[0].claims[0];
  claim.test_expression = { all: [] };
  assert.equal(researchSchemas.review_legal_reasoning.safeParse(f.input).success, false);
  claim.test_expression = { test_id: 'acquired' };
  for (let n = 0; n < 5; n++) claim.test_expression = { not: claim.test_expression };
  assert.equal(researchSchemas.review_legal_reasoning.safeParse(f.input).success, false);
  claim.test_expression = { all: [{ test_id: 'acquired' }, { test_id: 'acquired' }] };
  await assert.rejects(() => review(f), code('REASONING_REFERENCE_INVALID'));
  claim.test_expression = { test_id: 'other_issue_test' };
  await assert.rejects(() => review(f), code('REASONING_REFERENCE_INVALID'));
  f.service.close();
});

test('IR-03: a registered exception cannot disappear from the claim expression without sourced exclusion', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close());
  const a = f.input.analysis[0]; a.legal_tests.push({ ...a.legal_tests[0], id: 'exception', kind: 'exception' });
  let r = await review(f);
  assert.ok(r.findings.some(f => f.code === 'TEST_NOT_ADDRESSED')); assert.equal(r.ready_for_answer, false);
  a.excluded_tests.push({ test_id: 'exception', reason: '합성 조문의 제외 대상과 사실을 대조했다.', citations: a.legal_tests[0].citations });
  r = await review(f); assert.equal(r.status, 'structurally_complete');
  a.claims[0].test_expression = { any: [{ test_id: 'acquired' }, { test_id: 'exception' }] };
  r = await review(f); assert.ok(r.findings.some(f => f.code === 'EXCLUDED_TEST_USED'));
});

test('IR-04: both assumed-positive and assumed-negative application are blocked before not can invert them', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close());
  // Existing API: revise facts, reconnect the existing immutable bodies, preserve search history.
  const plan = structuredClone(f.state.plan); plan.facts[0].status = 'assumed';
  let s = await f.api('update_legal_research', f.state, { plan });
  s = await f.api('reuse_legal_evidence', s, { issue_ids: ['case'], evidence_ids: f.state.evidence.map(e => e.evidence_id) });
  const c = f.input.analysis[0].claims[0];
  c.test_expression = { not: { test_id: 'acquired' } };
  for (const value of ['satisfied', 'not_satisfied']) {
    c.application[0].finding = value;
    const r = await review(f); assert.ok(r.findings.some(f => f.code === 'UNCONFIRMED_ELEMENT_DECIDED'));
    assert.ok(r.findings.some(f => f.code === 'UNKNOWN_ELEMENT_DEFINITIVE')); assert.equal(r.ready_for_answer, false);
  }
});

test('IR-05: node count and declared truth mismatch remain deterministic blockers', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close());
  const c = f.input.analysis[0].claims[0]; c.test_result = 'not_satisfied';
  assert.ok((await review(f)).findings.some(f => f.code === 'TEST_RESULT_MISMATCH'));
  // Many unique tests still cannot evade the 64 node bound by nesting unary NOT.
  const a = f.input.analysis[0];
  a.legal_tests = Array.from({ length: 24 }, (_, n) => ({ ...a.legal_tests[0], id: 't' + n }));
  c.application = a.legal_tests.map(t => ({ ...c.application[0], test_id: t.id }));
  c.test_expression = { all: a.legal_tests.map(t => ({ not: { not: { test_id: t.id } } })) };
  f.input.answer_blocks[0].test_ids = ['t0']; c.test_result = 'satisfied';
  assert.ok((await review(f)).findings.some(f => f.code === 'EXPRESSION_TOO_LARGE'));
});

test('IR-06/07: genuine zero search needs no invented precedent; unresolved authority conflict blocks', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close());
  assert.equal((await review(f)).status, 'structurally_complete');
  const a = f.input.analysis[0];
  a.strongest_opposition.search_attempt_ids = [randomUUID()];
  await assert.rejects(() => review(f), code('REASONING_REFERENCE_INVALID'));
  a.strongest_opposition = { status: 'identified', evidence_id: a.legal_tests[0].citations[0].evidence_id,
    reason: '가장 강한 예외 적용 가능성', application_reason: '동일 사실의 반대 해석' };
  a.counter_evidence = [{ evidence_id: a.strongest_opposition.evidence_id, disposition: 'unresolved', reason: '대립하는 적용 가능성' }];
  a.authority_conflicts = [{ id: 'conflict', claim_ids: ['claim'], test_ids: ['acquired'],
    left: { proposition: '적용한다', citations: a.legal_tests[0].citations }, right: { proposition: '적용하지 않는다', citations: a.legal_tests[0].citations },
    law_difference: '같은 조문', date_difference: '같은 시점', fact_difference: '동일 사실', disposition: 'unresolved', reason: '추가 검토 필요', resolution_citations: [] }];
  const r = await review(f); assert.ok(r.findings.some(f => f.code === 'AUTHORITY_CONFLICT_UNRESOLVED')); assert.equal(r.ready_for_answer, false);
});

test('IR-09/10/25: the entire exact answer, including context, must be delivered before a model review counts', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close());
  f.input.answer_blocks.push({ id: 'hidden', kind: 'context', issue_id: 'case', text: '숨은 단정도 검토한다.', claim_ids: [], test_ids: [], citations: [] });
  assert.ok((await review(f)).findings.some(f => f.code === 'ANSWER_RENDER_MISMATCH'));
  f.input.draft_answer += '\n\n숨은 단정도 검토한다.';
  const r = await review(f); assert.equal(r.status, 'structurally_complete'); assert.equal(r.ready_for_answer, false);
  const p = await prepare(f);
  assert.equal(p.response.structure_current, true);
  const unprovided = await submit(f, p);
  assert.equal(unprovided.response.code, 'REVIEW_MATERIAL_INCOMPLETE'); assert.equal(unprovided.response.model_review.accepted_count, 0);
  await f.service.run('get_legal_research', coverageActor, { research_id: f.state.research_id, evidence_ids: f.state.evidence.map(e => e.evidence_id) });
  assert.equal((await submit(f, p)).response.code, 'REVIEW_MATERIAL_INCOMPLETE');
  const all = await readAll(f, p);
  assert.equal(all.find(u => u.id === 'artifact').data.value.answer_blocks[1].text, '숨은 단정도 검토한다.');
  const accepted = await submit(f, p); assert.equal(accepted.response.ready_for_answer, true);
  assert.equal(accepted.response.independent_review, 'not_performed'); assert.equal(accepted.response.semantic_support, 'unverified');
  assert.equal(accepted.response.stages.independent_semantic_review, 'not_configured');
  // A different draft, even one extra character, cannot inherit that readiness.
  f.input.draft_answer += '!'; await review(f); assert.equal((await status(f)).ready_for_answer, false);
});

test('IR-11/12/13/14: packet identity, owner, stale CAS and claimed model independence cannot be forged', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close());
  await review(f); const p = await prepare(f); await readAll(f, p);
  const fake = { ...p.input, request_id: randomUUID(), expected_state_version: p.response.state_version, artifact_hash: 'x'.repeat(64) };
  await assert.rejects(() => f.service.run('prepare_reasoning_review', coverageActor, fake), code('REVIEW_ARTIFACT_STALE'));
  await assert.rejects(() => f.service.run('prepare_reasoning_review', { kind: 'auth_user', id: 'other' }, p.input), code('RESEARCH_NOT_FOUND'));
  await assert.rejects(() => submit(f, p, { expected_state_version: 1 }), code('RESEARCH_STATE_CHANGED'));
  await assert.rejects(() => submit(f, p, { content_hash: 'x'.repeat(64) }), code('REVIEW_PACKET_STALE'));
  const accepted = await submit(f, p, { reviewer: { kind: 'client_reported_review', model: 'Pro', session: 'independent-claimed' } });
  assert.equal(accepted.response.independent_review, 'not_performed'); assert.equal(accepted.response.ready_for_answer, true);
  await assert.rejects(() => submit(f, p), code('REVIEW_PACKET_ALREADY_ACCEPTED'));
});

test('IR-15/17/27: accepted old-CAS replay survives three packets without restoring old readiness or resetting rounds', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close());
  await review(f); const p1 = await prepare(f); await readAll(f, p1); const r1 = await submit(f, p1);
  const p2 = await prepare(f); await readAll(f, p2); await submit(f, p2);
  const p3 = await prepare(f); await readAll(f, p3); await submit(f, p3, { result: 'revise', findings: [finding(f.input)] });
  const historical = await f.service.run('submit_reasoning_review', coverageActor, r1.input);
  assert.equal(historical.replayed, true); assert.equal(historical.receipt.review_number, 1);
  assert.equal(historical.ready_for_answer, false); assert.equal(historical.model_review.accepted_count, 3);
  const oldPrepare = await f.service.run('prepare_reasoning_review', coverageActor, p1.input);
  assert.equal(oldPrepare.replayed, true); assert.equal(oldPrepare.receipt.packet_id, p1.response.packet.packet_id); assert.equal(oldPrepare.ready_for_answer, false);
  await assert.rejects(() => f.service.run('submit_reasoning_review', coverageActor, { ...r1.input, result: 'revise' }), code('RESEARCH_REQUEST_CONFLICT'));
  await assert.rejects(() => prepare(f), code('REVIEW_ROUND_LIMIT'));
  await f.api('update_legal_research', await status(f), { plan: f.state.plan });
  assert.equal((await f.service.run('submit_reasoning_review', coverageActor, r1.input)).replayed, true);
  assert.equal((await status(f)).model_review.accepted_count, 3);
});

test('IR-16/28/29: reference errors and storage refusal preserve artifact, findings and accepted receipts atomically', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close());
  await review(f); const p = await prepare(f); await readAll(f, p); await submit(f, p);
  const before = structuredClone(f.service.sessions.get(f.state.research_id));
  f.input.analysis[0].claims[0].application[0].citations[0].quote = '없는 원문';
  await assert.rejects(() => review(f), code('REASONING_REFERENCE_INVALID'));
  assert.deepEqual(f.service.sessions.get(f.state.research_id), before);
  f.input.analysis[0].claims[0].application[0].citations[0].quote = f.input.analysis[0].legal_tests[0].citations[0].quote;
  const originalLimit = f.service.limits.maxSessionBytes;
  f.service.limits.maxSessionBytes = 1;
  await assert.rejects(() => prepare(f), e => e.code === 'RESEARCH_CAPACITY' || e.capacity_reason === 'session_bytes');
  assert.deepEqual(f.service.sessions.get(f.state.research_id), before);
  f.service.limits.maxSessionBytes = originalLimit;
  assert.equal((await status(f)).ready_for_answer, true);
});

test('IR-25: packet cursors use immutable manifests, duplicate pages are idempotent and replacement invalidates old cursors', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close()); await review(f);
  const p = await prepare(f), args = { research_id: f.state.research_id, view: 'review_packet', packet_id: p.response.packet.packet_id,
    packet_manifest_hash: p.response.packet.manifest_hash, limit: 1 };
  const first = await f.service.run('get_legal_research', coverageActor, args);
  const repeated = await f.service.run('get_legal_research', coverageActor, args);
  assert.deepEqual(first, repeated); assert.equal(first.state_version, p.response.state_version);
  const p2 = await prepare(f);
  await assert.rejects(() => f.service.run('get_legal_research', coverageActor, { ...args, packet_cursor: first.page.next_cursor }), code('REVIEW_PACKET_STALE'));
  assert.equal((await submit(f, p2)).response.code, 'REVIEW_MATERIAL_INCOMPLETE');
});

test('IR-26/08/10: findings survive omission, block deletion and author disagreement; explicit later review closes them', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close()); await review(f);
  const p1 = await prepare(f); await readAll(f, p1);
  const r1 = await submit(f, p1, { result: 'revise', findings: [finding(f.input)] });
  const id = r1.response.model_review.findings[0].finding_id;
  f.input.answer_blocks[0].id = 'renamed';
  await review(f); const p2 = await prepare(f); await readAll(f, p2);
  await assert.rejects(() => submit(f, p2), code('REVIEW_RESULT_CONFLICT'));
  assert.equal((await status(f)).model_review.findings[0].status, 'unmapped');
  const response = { finding_id: id, disposition: 'disputed', reason: '원문의 적용 근거를 재확인했다.', citations: [], remap_block_id: 'renamed' };
  f.input.finding_responses = [response]; await review(f);
  await assert.rejects(() => submit(f, p2), code('REVIEW_PACKET_STALE'));
  const p3 = await prepare(f); await readAll(f, p3);
  assert.equal((await status(f)).ready_for_answer, false);
  const closed = await submit(f, p3, { prior_findings: [{ finding_id: id, disposition: 'resolved', reason: '대응과 현재 전체 답변을 확인했다.', response_hash: digest(response) }] });
  assert.equal(closed.response.ready_for_answer, true); assert.equal(closed.response.model_review.accepted_count, 2);
});

test('IR-26: result enum cannot override findings, absent qualifications, or structural gaps', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close()); await review(f);
  const p = await prepare(f); await readAll(f, p);
  await assert.rejects(() => submit(f, p, { result: 'revise' }), code('REVIEW_RESULT_CONFLICT'));
  await assert.rejects(() => submit(f, p, { result: 'qualified' }), code('REVIEW_RESULT_CONFLICT'));
  await assert.rejects(() => submit(f, p, { findings: [finding(f.input)] }), code('REVIEW_RESULT_CONFLICT'));
  const qualified = await submit(f, p, { result: 'qualified', qualifications: [{ block_id: 'answer', quote: f.input.draft_answer }] });
  assert.equal(qualified.response.ready_for_answer, true);
  f.input.analysis[0].claims[0].test_result = 'unknown'; await review(f);
  const p2 = await prepare(f); await readAll(f, p2); const stillBlocked = await submit(f, p2);
  assert.equal(stillBlocked.response.ready_for_answer, false);
});

test('IR-24: moving an invalid citation to any new source location cannot escape reference validation', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close());
  await review(f); const before = (await status(f)).reasoning_artifact;
  for (const path of ['test', 'application', 'exclusion', 'block', 'conflict']) {
    const input = structuredClone(f.input), a = input.analysis[0], bad = { ...a.legal_tests[0].citations[0], quote: '존재하지 않는 구절' };
    if (path === 'test') a.legal_tests[0].citations = [bad];
    if (path === 'application') a.claims[0].application[0].citations = [bad];
    if (path === 'exclusion') a.excluded_tests = [{ test_id: 'acquired', reason: '합성 제외', citations: [bad] }];
    if (path === 'block') input.answer_blocks[0].citations = [bad];
    if (path === 'conflict') a.authority_conflicts = [{ id: 'conflict', claim_ids: ['claim'], test_ids: ['acquired'], left: { proposition: 'A', citations: [bad] },
      right: { proposition: 'B', citations: a.legal_tests[0].citations }, law_difference: '동일', date_difference: '동일', fact_difference: '동일', disposition: 'unresolved', reason: '합성', resolution_citations: [] }];
    await assert.rejects(() => review(f, input), code('REASONING_REFERENCE_INVALID'), path);
    assert.deepEqual((await status(f)).reasoning_artifact, before);
  }
});

test('IR-19: disabled rollout, legacy calls, and new v1 drafts never inherit v2 readiness', async t => {
  const disabled = await reasoningFixture({ reasoningV2Enabled: false }); t.after(() => disabled.service.close());
  await assert.rejects(() => review(disabled), code('REASONING_V2_DISABLED'));
  const f = await reasoningFixture(); t.after(() => f.service.close()); await review(f); const p = await prepare(f); await readAll(f, p); await submit(f, p);
  assert.equal((await status(f)).ready_for_answer, true);
  const v1 = coverageReview(await status(f)); v1.draft_answer += ' 다른 문구';
  const result = await f.service.run('review_legal_reasoning', coverageActor, v1);
  assert.equal(result.reasoning_contract_version, 1); assert.equal(result.ready_for_answer, false); assert.equal((await status(f)).ready_for_answer, false);
});

test('IR-18: lexical negation does not automatically suppress candidates; explicit fact-backed exclusions and deduplicated questions', () => {
  const gates = new GateEngine(), rule = gates.rules[0];
  const r = gates.validate({ draft_answer: rule.cues[0] + ' 아니다. 가정적 언급이다.' }, 'fixture');
  assert.ok(r.checks.some(c => c.id === rule.id && c.applicability === 'candidate'));
  assert.equal(new Set(r.questions.map(q => q.fact_id)).size, r.questions.length);
  assert.throws(() => gates.validate({ draft_answer: '무관', gate_assessments: [{ gate_id: rule.id, applicability: 'not_applicable', reason: '무관', fact_ids: [] }] }, 'fixture'), code('GATE_APPLICABILITY_INVALID'));
  const excluded = gates.validate({ draft_answer: '명시적 쟁점', facts: { known: '확인된 사건 범위' }, gate_assessments: [{ gate_id: rule.id,
    applicability: 'not_applicable', reason: '확인된 범위와 비교', fact_ids: ['known'] }] }, 'fixture');
  assert.equal(excluded.checks[0].applicability, 'not_applicable'); assert.equal(excluded.passed, false);
});

test('IR-01: an uncoupled legal element cannot claim a definitive result', async () => {
  const f = await reasoningFixture();
  f.input.analysis[0].claims[0].application[0].fact_ids = [];
  const review = await f.service.run('review_legal_reasoning', { kind: 'auth_user', id: 'authority-fixture' }, f.input);
  assert.equal(review.ready_for_answer, false);
  assert.ok(review.findings.some(finding => finding.code === 'ELEMENT_FACT_REQUIRED'));
});

test('IR-05/25: a fact excluded as unnecessary cannot be used again without reassessment, and same-revision necessity changes stale review', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close()); await review(f); const p = await prepare(f); await readAll(f, p); await submit(f, p);
  const before = await status(f), r = before.requirements.find(r => r.target.id === 'known');
  const basis = { kind: 'source', citation: f.input.analysis[0].legal_tests[0].citations[0], version: f.input.analysis[0].legal_tests[0].version };
  const changed = await f.api('update_legal_research', before, { expected_state_version: before.state_version,
    requirement_assessments: [{ requirement_id: r.requirement_id, status: 'not_required_for_question', reason: '제외 가설', basis }] });
  assert.equal(changed.revision, before.revision); assert.equal(changed.ready_for_answer, false); assert.equal(changed.structure_current, false);
  const reviewed = await review(f); assert.ok(reviewed.findings.some(f => f.code === 'ELEMENT_EXCLUDED_REQUIREMENT_USED'));
});

test('IR-10/25: declared independent notice can remain open, but promoting its link stales the unchanged answer', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close());
  const plan = structuredClone(f.state.plan); plan.scope_review.tracks.push({ id: 'notice', party: '합성인', legal_question: '본질문 밖 안내',
    factual_anchor_ids: ['known'], relation: 'independent_notice', blocks_track_ids: [], issue_id: null, lifecycle: 'deferred' });
  let s = await f.api('update_legal_research', f.state, { plan });
  s = await f.api('reuse_legal_evidence', s, { issue_ids: ['case'], evidence_ids: f.state.evidence.map(e => e.evidence_id) });
  s = await f.finish(s);
  const { reasoningInput } = await import('./fixtures/reasoning-v2.mjs'); f.input = reasoningInput(s);
  f.input.scope_assessments.push({ track_id: 'notice', status: 'deferred', reason: '본질문과 독립인 안내', fact_ids: [], evidence_ids: [] });
  const r = await review(f); assert.equal(r.status, 'structurally_complete'); assert.equal(r.question_scope_complete, true); assert.equal(r.declared_scope_review_complete, false);
  const p = await prepare(f); await readAll(f, p); assert.equal((await submit(f, p)).response.ready_for_answer, true);
  const before = await status(f), changed = await f.api('update_legal_research', before, { expected_state_version: before.state_version,
    scope_promotions: [{ track_id: 'notice', issue_id: 'case' }] });
  assert.equal(changed.revision, before.revision); assert.equal(changed.structure_current, false); assert.equal(changed.ready_for_answer, false);
});

test('IR-14/28: expiry denies even accepted receipt replay', async t => {
  let now = 1; const f = await reasoningFixture({ now: () => now, limits: { ttlMs: 5000 } }); t.after(() => f.service.close());
  await review(f); const p = await prepare(f); await readAll(f, p); const accepted = await submit(f, p);
  now = 6000; await assert.rejects(() => f.service.run('submit_reasoning_review', coverageActor, accepted.input), code('RESEARCH_NOT_FOUND'));
});

test('LH-IR-CODE-01: close one repaired finding while an unrelated structural gap still blocks readiness', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close()); await review(f);
  const p = await prepare(f); await readAll(f, p);
  const first = await submit(f, p, { result: 'revise', findings: [finding(f.input)] });
  const id = first.response.model_review.findings[0].finding_id;
  const response = { finding_id: id, disposition: 'proposed_fix', reason: '적용 이유를 보완했다.', citations: [] };
  f.input.finding_responses = [response];
  f.input.analysis[0].claims[0].application[0].application_reason = '확인한 취득 사실을 해당 요건의 문언에 대입하여 충족을 판단한다.';
  f.input.analysis[0].timing.status = 'unresolved';
  const structural = await review(f); assert.notEqual(structural.status, 'structurally_complete');
  const next = await prepare(f); await readAll(f, next);
  const closed = await submit(f, next, { prior_findings: [{ finding_id: id, disposition: 'resolved', reason: '보완된 적용 설명을 확인했다.', response_hash: digest(response) }] });
  assert.equal(closed.response.model_review.findings[0].status, 'resolved');
  assert.equal(closed.response.ready_for_answer, false);
});

test('LH-IR-CODE-01: a finding linked to a server check cannot close while that specific error remains', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close());
  f.input.analysis[0].claims[0].test_result = 'unknown';
  const r = await review(f), gap = r.findings.find(f => f.code === 'TEST_RESULT_MISMATCH');
  const p = await prepare(f); await readAll(f, p);
  const first = await submit(f, p, { result: 'revise', findings: [{ ...finding(f.input), structure_gap_ids: [gap.gap_id] }] });
  const id = first.response.model_review.findings[0].finding_id;
  const response = { finding_id: id, disposition: 'disputed', reason: '작성자의 이견만으로 검사 오류를 닫을 수 없다.', citations: [] };
  f.input.finding_responses = [response]; await review(f);
  const next = await prepare(f); await readAll(f, next);
  const closure = { prior_findings: [{ finding_id: id, disposition: 'resolved', reason: '닫힘을 시도한다.', response_hash: digest(response) }] };
  await assert.rejects(() => submit(f, next, closure), code('REVIEW_STRUCTURE_UNRESOLVED'));
  f.input.analysis[0].claims[0].test_result = 'satisfied'; f.input.analysis[0].timing.status = 'unresolved';
  await review(f); const repaired = await prepare(f); await readAll(f, repaired);
  const accepted = await submit(f, repaired, closure);
  assert.equal(accepted.response.model_review.findings[0].status, 'resolved'); assert.equal(accepted.response.ready_for_answer, false);
});

test('IR-01/24: a later judgment date is not confused with its applicable statute version', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close());
  const evidence = structuredClone(f.state.evidence), a = f.input.analysis[0], source = a.legal_tests[0].citations[0];
  const court = structuredClone(evidence.find(e => e.evidence_id === source.evidence_id));
  court.evidence_id = randomUUID(); court.tool = 'get_decision_text'; court.document_version = '20250213';
  court.units.forEach(u => u.document_version = '20250213'); evidence.push(court);
  a.legal_tests[0].citations.push({ ...source, evidence_id: court.evidence_id });
  const findings = [], add = (code, detail) => findings.push({ code, detail });
  inspectApplication(a, f.state.plan, evidence, [], add, add);
  assert.ok(!findings.some(f => f.code.startsWith('ELEMENT_VERSION')), JSON.stringify(findings));
  a.legal_tests[0].version = '19900101'; findings.length = 0;
  inspectApplication(a, f.state.plan, evidence, [], add, add);
  assert.ok(findings.some(f => f.code === 'ELEMENT_VERSION_MISMATCH'));
});

test('IR-29: receipt admission preserves all 64 accepted IDs instead of evicting old history', () => {
  let state = emptyReasoningState();
  for (let n = 0; n < 64; n++) state = admitReceipt(state, { tool: 'prepare_reasoning_review', request_id: randomUUID(), input_hash: digest(n),
    packet_id: randomUUID(), content_hash: digest(n), manifest_hash: digest(n), revision: 1, state_version: n + 1, result: 'prepared', review_number: 0, finding_ids: [] });
  const before = structuredClone(state);
  assert.throws(() => admitReceipt(state, { ...state.receipts[0], request_id: randomUUID() }), code('REVIEW_RECEIPT_CAPACITY'));
  assert.deepEqual(state, before);
});

test('IR-14/25: busy sessions retain receipt replay but cannot claim readiness or accept a new review', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close()); await review(f); const p = await prepare(f); await readAll(f, p);
  const accepted = await submit(f, p), session = f.service.sessions.get(f.state.research_id);
  session.busy = { job_id: randomUUID() };
  assert.equal((await status(f)).ready_for_answer, false);
  assert.equal((await f.service.run('submit_reasoning_review', coverageActor, accepted.input)).replayed, true);
  await assert.rejects(() => prepare(f), code('RESEARCH_BUSY'));
  session.busy = null;
});

test('LH-IR-CODE-01 R2: repairing claim A closes its finding even when the same check still fails on claim B', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close()); const a = f.input.analysis[0];
  a.claims[0].test_result = 'unknown'; a.claims.push({ ...structuredClone(a.claims[0]), id: 'second' });
  f.input.answer_blocks[0].claim_ids.push('second');
  const r = await review(f), gap = r.findings.find(g => g.code === 'TEST_RESULT_MISMATCH' && g.detail.startsWith('claim:'));
  const p = await prepare(f); await readAll(f, p);
  const first = await submit(f, p, { result: 'revise', findings: [{ ...finding(f.input), claim_id: 'claim', structure_gap_ids: [gap.gap_id] }] });
  const id = first.response.model_review.findings[0].finding_id;
  const response = { finding_id: id, disposition: 'proposed_fix', reason: '첫 번째 주장의 결과만 수정했다.', citations: [] };
  a.claims[0].test_result = 'satisfied'; f.input.finding_responses = [response]; await review(f);
  const next = await prepare(f); await readAll(f, next);
  const accepted = await submit(f, next, { prior_findings: [{ finding_id: id, disposition: 'resolved', reason: '첫 번째 결과가 계산과 일치한다.', response_hash: digest(response) }] });
  assert.equal(accepted.response.model_review.findings[0].status, 'resolved'); assert.equal(accepted.response.ready_for_answer, false);
});

test('LH-IR-CODE-02: an originally blocking finding cannot silently become an independent notice', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close()); await review(f); const p = await prepare(f); await readAll(f, p);
  await submit(f, p, { result: 'revise', findings: [finding(f.input)] });
  const s = f.service.sessions.get(f.state.research_id), stored = s.reasoning.findings[0], plan = structuredClone(s.plan);
  plan.scope_review.tracks[0].relation = 'independent_notice';
  const view = findingView(stored, s.reasoning, s.reasoning.structure.content_hash, plan);
  assert.equal(view.status, 'open'); assert.equal(view.blocking, true);
});

test('LH-IR-CODE-01: renamed claim targets need an explicit valid remap and cannot close an unfixed error', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close()); const claim = f.input.analysis[0].claims[0];
  claim.test_result = 'unknown'; const r = await review(f), gap = r.findings.find(g => g.code === 'TEST_RESULT_MISMATCH');
  const p = await prepare(f); await readAll(f, p);
  const first = await submit(f, p, { result: 'revise', findings: [{ ...finding(f.input), structure_gap_ids: [gap.gap_id] }] });
  const id = first.response.model_review.findings[0].finding_id;
  claim.id = 'renamed'; f.input.answer_blocks[0].claim_ids = ['renamed'];
  const response = { finding_id: id, disposition: 'proposed_fix', reason: '대상 이름 변경', citations: [] };
  f.input.finding_responses = [response]; await review(f); const next = await prepare(f); await readAll(f, next);
  const closure = () => ({ prior_findings: [{ finding_id: id, disposition: 'resolved', reason: '현재 대응 검토', response_hash: digest(response) }] });
  await assert.rejects(() => submit(f, next, closure()), code('REVIEW_CHECK_UNMAPPED'));
  response.check_remaps = [{ from: { kind: 'claim', id: 'claim' }, to: { kind: 'claim', id: 'renamed' } }];
  await review(f); const mapped = await prepare(f); await readAll(f, mapped);
  await assert.rejects(() => submit(f, mapped, closure()), code('REVIEW_STRUCTURE_UNRESOLVED'));
  claim.test_result = 'satisfied'; await review(f); const fixed = await prepare(f); await readAll(f, fixed);
  assert.equal((await submit(f, fixed, closure())).response.model_review.findings[0].status, 'resolved');
});

test('LH-IR-CODE-01: confirming date A clears only its linked check while date B remains unknown', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close());
  const plan = structuredClone(f.state.plan); plan.issues[0].required_date_roles = ['dateA', 'dateB'];
  plan.event_dates = ['dateA', 'dateB'].map(role => ({ role, value: '2020-01', precision: 'month', basis: 'assumed', source: '합성 가정' }));
  let s = await f.api('update_legal_research', f.state, { plan });
  s = await f.api('reuse_legal_evidence', s, { issue_ids: ['case'], evidence_ids: f.state.evidence.map(e => e.evidence_id) });
  f.input.analysis[0].timing = { status: 'addressed', reason: '두 날짜의 확인 상태 구분', date_roles: ['dateA', 'dateB'] };
  f.input.analysis[0].legal_basis.statutes.forEach(l => l.date_roles = ['dateA', 'dateB']);
  const r = await review(f), gap = r.findings.find(g => g.code === 'DATE_UNCONFIRMED' && g.target.id === 'dateA');
  const p = await prepare(f); await readAll(f, p);
  const first = await submit(f, p, { result: 'revise', findings: [{ ...finding(f.input), structure_gap_ids: [gap.gap_id] }] });
  const id = first.response.model_review.findings[0].finding_id;
  plan.event_dates[0] = { role: 'dateA', value: '2020-01-01', precision: 'day', basis: 'provided', source: '합성 확인' };
  s = await f.api('update_legal_research', await status(f), { plan });
  await f.api('reuse_legal_evidence', s, { issue_ids: ['case'], evidence_ids: f.state.evidence.map(e => e.evidence_id) });
  const response = { finding_id: id, disposition: 'proposed_fix', reason: 'dateA 확인됨; dateB 미상 유지', citations: [] };
  f.input.finding_responses = [response]; await review(f); const next = await prepare(f); await readAll(f, next);
  const closed = await submit(f, next, { prior_findings: [{ finding_id: id, disposition: 'resolved', reason: '해당 날짜의 확인을 검토했다.', response_hash: digest(response) }] });
  assert.equal(closed.response.model_review.findings[0].status, 'resolved'); assert.equal(closed.response.ready_for_answer, false);
});

test('LH-IR-CODE-02: an initially independent finding is nonblocking, and reviewed scope changes can close a former blocker', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close()); await review(f); let p = await prepare(f); await readAll(f, p);
  const first = await submit(f, p, { result: 'revise', findings: [finding(f.input)] });
  const id = first.response.model_review.findings[0].finding_id, s = f.service.sessions.get(f.state.research_id);
  s.plan.scope_review.tracks[0].relation = 'independent_notice';
  const response = { finding_id: id, disposition: 'disputed', reason: '범위 변경의 이유를 제시하고 후속 검토를 요청한다.', citations: [] };
  f.input.finding_responses = [response]; await review(f); p = await prepare(f); await readAll(f, p);
  await assert.rejects(() => submit(f, p), code('REVIEW_RESULT_CONFLICT'));
  const closed = await submit(f, p, { prior_findings: [{ finding_id: id, disposition: 'resolved', reason: '명시한 범위 변경과 답변의 한계를 확인했다.', response_hash: digest(response) }],
    findings: [{ ...finding(f.input), reason: '처음부터 독립 안내에서 생성된 별개 지적' }] });
  assert.equal(closed.response.model_review.findings[0].status, 'resolved');
  assert.equal(closed.response.model_review.findings[1].originally_blocking, false);
  assert.equal(closed.response.model_review.findings[1].blocking, false);
});

test('LH-IR-CODE-01: deleting an erroneous claim needs a targeted explanation and explicit later review', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close()); const a = f.input.analysis[0];
  a.claims.push({ ...structuredClone(a.claims[0]), id: 'extra', test_result: 'unknown' });
  f.input.answer_blocks[0].claim_ids.push('extra');
  const r = await review(f), gap = r.findings.find(g => g.code === 'TEST_RESULT_MISMATCH' && g.target.id === 'extra');
  const p = await prepare(f); await readAll(f, p);
  const first = await submit(f, p, { result: 'revise', findings: [{ ...finding(f.input), structure_gap_ids: [gap.gap_id] }] });
  const id = first.response.model_review.findings[0].finding_id;
  const response = { finding_id: id, disposition: 'proposed_fix', reason: '중복된 잘못된 주장을 삭제한다.', citations: [],
    check_removals: [{ target: { kind: 'claim', id: 'extra' }, reason: '중복 주장을 삭제했고 본래 요건과 올바른 주장은 유지했다.' }] };
  f.input.finding_responses = [response];
  await assert.rejects(() => review(f), code('REVIEW_CHECK_REMOVAL_INVALID'));
  a.claims.pop(); f.input.answer_blocks[0].claim_ids.pop();
  await review(f); const next = await prepare(f); await readAll(f, next);
  await assert.rejects(() => submit(f, next), code('REVIEW_RESULT_CONFLICT'));
  const closed = await submit(f, next, { prior_findings: [{ finding_id: id, disposition: 'resolved',
    reason: '삭제 설명과 남은 요건 및 답변을 검토했다.', response_hash: digest(response) }] });
  assert.equal(closed.response.model_review.findings[0].status, 'resolved');
  assert.equal(closed.response.ready_for_answer, true);
});

test('LH-IR-CODE-03: remap target metadata cannot hide a remaining claim error', async t => {
  const f = await reasoningFixture(); t.after(() => f.service.close()); const claim = f.input.analysis[0].claims[0];
  claim.test_result = 'unknown'; const r = await review(f), gap = r.findings.find(g => g.code === 'TEST_RESULT_MISMATCH');
  const p = await prepare(f); await readAll(f, p);
  const first = await submit(f, p, { result: 'revise', findings: [{ ...finding(f.input), structure_gap_ids: [gap.gap_id] }] });
  claim.id = 'renamed'; f.input.answer_blocks[0].claim_ids = ['renamed'];
  const response = { finding_id: first.response.model_review.findings[0].finding_id, disposition: 'proposed_fix', reason: '이름만 변경', citations: [],
    check_remaps: [{ from: { kind: 'claim', id: 'claim' }, to: { kind: 'claim', id: 'renamed', issue_id: 'case' } }] };
  f.input.finding_responses = [response];
  await assert.rejects(() => review(f), e => e.name === 'ZodError');
  delete response.check_remaps[0].to.issue_id;
  await review(f); const mapped = await prepare(f); await readAll(f, mapped);
  await assert.rejects(() => submit(f, mapped, { prior_findings: [{ finding_id: response.finding_id, disposition: 'resolved',
    reason: '오류가 남아 있어야 한다.', response_hash: digest(response) }] }), code('REVIEW_STRUCTURE_UNRESOLVED'));
});
