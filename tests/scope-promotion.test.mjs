import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { coverageActor, coverageFixture, coveragePlan, coverageReview, providerResponse } from './fixtures/authority-provider.mjs';

const planWithNotice = () => {
  const p = coveragePlan();
  p.scope_review.tracks.push({ id: 'notice', party: '납세자', legal_question: '취득 요건 외 효과는 요청 범위 밖',
    factual_anchor_ids: ['known'], relation: 'independent_notice', blocks_track_ids: [], issue_id: null, lifecycle: 'deferred' });
  return p;
};
const promotion = s => ({ research_id: s.research_id, expected_revision: s.revision,
  expected_state_version: s.state_version, scope_promotions: [{ track_id: 'notice', issue_id: 'case' }] });
const read = (f, s) => f.service.run('get_legal_research', coverageActor, { research_id: s.research_id });
const reviewNotice = s => {
  const input = coverageReview(s);
  input.scope_assessments.push({ track_id: 'notice', status: 'excluded', reason: '별도 효과는 이 취득 요건의 결론을 막지 않는 요청 밖 안내',
    fact_ids: ['known'], evidence_ids: input.scope_assessments[0].evidence_ids });
  return input;
};

test('SP-01/02: independent notice promotion closes a completed question at zero source budget without resetting research', async t => {
  const f = coverageFixture(); t.after(() => f.service.close());
  let s = await f.finish(await f.law(await f.start(planWithNotice())));
  while (s.recovery.remaining_attempts > 0) s = await f.api('research_legal_sources', s,
    { issue_ids: ['case'], purpose: 'timing', tool: 'search_law', arguments: { query: '소득세법', display: 50 } });
  assert.equal(s.recovery.remaining_attempts, 0);
  const waiting = reviewNotice(s); waiting.scope_assessments[1].evidence_ids = [];
  const oldReview = await f.service.run('review_legal_reasoning', coverageActor, waiting);
  assert.equal(oldReview.question_scope_complete, true);
  assert.equal(oldReview.status, 'blocked');
  assert.ok(oldReview.findings.some(x => x.code === 'SCOPE_TRACK_NOT_PROMOTED'));
  s = await read(f, s);
  const before = structuredClone(s), calls = f.calls.length;
  const next = await f.service.run('update_legal_research', coverageActor, promotion(s));
  assert.equal(next.revision, s.revision);
  assert.equal(next.state_version, s.state_version + 1);
  assert.equal(next.last_review, null);
  for (const key of ['attempts', 'evidence', 'manifests', 'ledger', 'requirements', 'requirement_history',
    'review_adopted_evidence_ids', 'expires_at']) assert.deepEqual(next[key], before[key], key);
  assert.equal(next.recovery.remaining_attempts, 0);
  const expectedPlan = structuredClone(s.plan);
  Object.assign(expectedPlan.scope_review.tracks[1], { issue_id: 'case', lifecycle: 'active' });
  assert.deepEqual(next.plan, expectedPlan);
  const result = await f.service.run('review_legal_reasoning', coverageActor, reviewNotice(next));
  assert.equal(result.status, 'structurally_complete', JSON.stringify(result.findings));
  assert.equal(result.declared_scope_review_complete, true);
  for (const key of ['plan_hash', 'snapshot_hash', 'binding_hash']) assert.notEqual(result[key], oldReview[key], key);
  assert.equal(f.calls.length, calls);
  await assert.rejects(f.service.run('update_legal_research', coverageActor, promotion(before)), e => e.code === 'RESEARCH_STATE_CHANGED');
});

test('SP-03/04: promotion has actor/revision/state checks and accepts no new scope or mixed mutation', async t => {
  const f = coverageFixture(); t.after(() => f.service.close());
  const s = await f.start(planWithNotice()), good = promotion(s);
  await assert.rejects(f.service.run('update_legal_research', { kind: 'auth_user', id: 'other' }, good), e => e.code === 'RESEARCH_NOT_FOUND');
  await assert.rejects(f.service.run('update_legal_research', coverageActor, { ...good, expected_revision: 2 }), e => e.code === 'RESEARCH_REVISION_CHANGED');
  await assert.rejects(f.service.run('update_legal_research', coverageActor, { ...good, expected_state_version: 2 }), e => e.code === 'RESEARCH_STATE_CHANGED');
  for (const change of [
    x => { delete x.expected_state_version; }, x => { x.plan = s.plan; },
    x => { x.requirement_assessments = [{ requirement_id: randomUUID(), status: 'unresolved', reason: '합성' }]; },
    x => { x.scope_promotions[0].legal_question = '다른 질문'; },
    x => { x.scope_promotions[0].factual_anchor_ids = ['other']; },
    x => { x.scope_promotions[0].blocks_track_ids = ['question']; },
    x => { x.scope_promotions[0].issue_id = 'missing'; },
    x => { x.scope_promotions[0].track_id = 'question'; },
    x => { x.scope_promotions[0].track_id = 'missing'; },
    x => { x.scope_promotions.push({ ...x.scope_promotions[0] }); },
  ]) {
    const bad = structuredClone(good); change(bad);
    await assert.rejects(f.service.run('update_legal_research', coverageActor, bad));
    assert.deepEqual(await read(f, s), s);
  }
  const next = await f.service.run('update_legal_research', coverageActor, good);
  await assert.rejects(f.service.run('update_legal_research', coverageActor, promotion(next)), e => e.code === 'SCOPE_PROMOTION_INVALID');
  assert.equal(f.calls.length, 0);
});

test('SP-03: busy or expired research cannot promote a notice', async t => {
  let now = 1, resolveSource;
  const gate = new Promise(resolve => { resolveSource = resolve; });
  const f = coverageFixture(async (name, args) => { await gate; return providerResponse(name, args); },
    { now: () => now, limits: { ttlMs: 50, yieldMs: 1 } });
  t.after(() => f.service.close());
  const s = await f.start(planWithNotice()), busy = await f.law(s);
  assert.equal(busy.pending, true);
  await assert.rejects(f.service.run('update_legal_research', coverageActor, promotion(busy)), e => e.code === 'RESEARCH_BUSY');
  resolveSource();
  await new Promise(resolve => setTimeout(resolve, 10));
  now = 60;
  await assert.rejects(f.service.run('update_legal_research', coverageActor, promotion(busy)), e => e.code === 'RESEARCH_NOT_FOUND');
});

test('SP-05/06: promotion cannot close unresearched scope and capacity failure leaves original state intact', async t => {
  const f = coverageFixture(); t.after(() => f.service.close());
  let s = await f.law(await f.start(planWithNotice()));
  s = await read(f, s);
  const before = structuredClone(s);
  // Fault-inject the actual storage bound, then restore it before reading state.
  const limit = f.service.limits.maxSessionBytes; f.service.limits.maxSessionBytes = 1;
  await assert.rejects(f.service.run('update_legal_research', coverageActor, promotion(s)), e => e.code === 'RESEARCH_CAPACITY');
  f.service.limits.maxSessionBytes = limit;
  assert.deepEqual(await read(f, s), before);
  s = await f.service.run('update_legal_research', coverageActor, promotion(s));
  const r = await f.service.run('review_legal_reasoning', coverageActor, reviewNotice(s));
  assert.equal(r.status, 'blocked');
  assert.ok(r.findings.some(x => x.code === 'REQUIRED_SEARCH_INCOMPLETE'));
  assert.equal(r.declared_scope_review_complete, false);
  const p = structuredClone(s.plan); p.facts[0].value = '실제 사실 변경';
  const revised = await f.api('update_legal_research', s, { plan: p });
  assert.equal(revised.revision, s.revision + 1);
  assert.ok(revised.evidence.every(e => e.revision !== revised.revision));
});

test('SP-04: only a deferred independent notice may be promoted and multi-promotion failure is atomic', async t => {
  const f = coverageFixture(); t.after(() => f.service.close());
  for (const lifecycle of ['candidate', 'overflow']) {
    const p = planWithNotice(); p.scope_review.tracks[1].lifecycle = lifecycle;
    const s = await f.start(p);
    await assert.rejects(f.service.run('update_legal_research', coverageActor, promotion(s)), e => e.code === 'SCOPE_PROMOTION_INVALID');
  }
  const p = planWithNotice(); p.scope_review.tracks[1].relation = 'answer_dependency'; p.scope_review.tracks[1].blocks_track_ids = ['question'];
  const dependency = await f.start(p);
  await assert.rejects(f.service.run('update_legal_research', coverageActor, promotion(dependency)), e => e.code === 'SCOPE_PROMOTION_INVALID');
  const s = await f.start(planWithNotice()), bad = promotion(s);
  bad.scope_promotions.push({ track_id: 'missing', issue_id: 'case' });
  await assert.rejects(f.service.run('update_legal_research', coverageActor, bad), e => e.code === 'SCOPE_PROMOTION_INVALID');
  assert.deepEqual(await read(f, s), s);
});

for (const variant of ['unknown_fact', 'partial_body', 'failed_search', 'wrong_issue', 'unresolved_analysis'])
  test(`SP-05: promotion preserves the ${variant} completion blocker`, async t => {
    const f = coverageFixture((name, args) => {
      if (variant === 'failed_search' && name === 'search_decisions') throw new Error('provider unavailable');
      const result = providerResponse(name, args);
      if (variant === 'partial_body' && name === 'get_law_text') result.result.content[0].text += '\n응답 크기 제한';
      return result;
    });
    t.after(() => f.service.close());
    const p = planWithNotice();
    if (variant === 'unknown_fact') Object.assign(p.facts[0], { status: 'unknown', value: null, source: '' });
    if (variant === 'wrong_issue') p.issues.push({ ...p.issues[0], id: 'unrelated', question: '다른 법률 쟁점' });
    let s = await f.law(await f.start(p));
    if (!['partial_body', 'wrong_issue'].includes(variant)) s = await f.finish(s);
    const input = promotion(s);
    if (variant === 'wrong_issue') input.scope_promotions[0].issue_id = 'unrelated';
    s = await f.service.run('update_legal_research', coverageActor, input);
    const review = reviewNotice(s);
    if (variant === 'unresolved_analysis') review.analysis[0].exceptions = { status: 'unresolved', reason: '실제 남은 예외 공백' };
    const result = await f.service.run('review_legal_reasoning', coverageActor, review);
    assert.notEqual(result.status, 'structurally_complete');
    assert.equal(result.declared_scope_review_complete, false);
    const expected = { unknown_fact: 'USED_FACT_UNCONFIRMED', partial_body: 'PARTIAL_BODY', failed_search: 'REQUIRED_SEARCH_INCOMPLETE',
      wrong_issue: 'SCOPE_BASIS_INVALID', unresolved_analysis: 'EXCEPTIONS_UNRESOLVED' }[variant];
    assert.ok(result.findings.some(x => x.code === expected), JSON.stringify(result.findings));
  });
