import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ResearchService } from '../dist/research.js';
import { coverageFixture, coveragePlan, coverageReview, providerResponse, coverageActor } from './fixtures/authority-provider.mjs';

const requirementPlan = () => {
  const p = coveragePlan();
  p.facts.push({ id: 'unclassified', description: '등록 사실', status: 'unknown', value: null, source: '' });
  p.issues[0].required_fact_ids.push('unclassified'); return p;
};

test('CF-11: seven ordinary fact/date answers leave room for source research without duplicating unchanged requirement snapshots', async t => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/authority-history-plan.json', import.meta.url), 'utf8'));
  let calls = 0;
  const service = new ResearchService({ callTool: async () => { calls++; return { result: { content: [{ type: 'text',
    text: '법령명: 합성법\n시행일: 20200101\n제1조(합성 원문)\n합성 취득 순서의 확인 자료.' }] } }; } });
  t.after(() => service.close());
  let state = await service.run('start_legal_research', coverageActor, { plan: fixture.plan });
  const ids = state.requirements.map(r => r.requirement_id);
  for (const answer of fixture.answers) state = await service.run('answer_legal_question', coverageActor, {
    research_id: state.research_id, expected_revision: state.revision, expected_state_version: state.state_version,
    question_id: state.interview.next_question.question_id, answer
  });
  assert.equal(state.revision, 8); assert.equal(calls, 0);
  assert.deepEqual(state.requirements.map(r => r.requirement_id), ids);
  assert.equal(state.requirement_history.length, 7);
  // Each fact revision remains auditable; unchanged requirement descriptions and scope
  // are not seven separate semantic changes. Actual renames/resets are covered below.
  assert.ok(state.requirement_history.every(h => h.before_hash !== h.after_hash));
  assert.ok(Buffer.byteLength(JSON.stringify(state.requirement_history)) < 8192);
  const read = await service.run('research_legal_sources', coverageActor, {
    research_id: state.research_id, expected_revision: state.revision, issue_ids: state.plan.issues.map(i => i.id),
    purpose: 'context', tool: 'get_law_text', arguments: { lawId: 'fixture', jo: '제1조' }
  });
  assert.equal(calls, 1); assert.equal(read.evidence[0].body_scope, 'body_returned');
  assert.equal(read.plan.event_dates.find(d => d.role === 'new_home_acquired').precision, 'month');
});
async function prepared(t, required = false) {
  const text = required ? '합성 취득 요건과 등록 요건을 모두 충족해야 적용한다.' : '합성 취득 요건만 충족하면 등록하지 않아도 적용한다.';
  const f = coverageFixture((name, args) => name === 'get_law_text' ? { result: { content: [{ type: 'text',
    text: '법령명: 소득세법\n시행일: 20200101\n제1조(합성 요건)\n' + text }] } } : providerResponse(name, args));
  t.after(() => f.service.close());
  const s = await f.finish(await f.law(await f.start(requirementPlan())));
  assert.ok(s.requirements, 'server must mint and retain requirement necessity records');
  return { f, s, text };
}

test('CF-10: observed judgment date identifies a necessity source without inventing an applicable statute version', async t => {
  for (const observedDate of [true, false]) {
    const service = new ResearchService({ callTool: async () => ({ result: { content: [{ type: 'text', text:
      '기본 정보:\n사건번호: 2099두10002\n법원: 대법원\n' + (observedDate ? '선고일: 20990201\n' : '')
      + '전문:\n[합성 판결] 신법상 취득에는 등록 요건을 요구하지 않는다.' }] } }) });
    t.after(() => service.close());
    let s = await service.run('start_legal_research', coverageActor, { plan: requirementPlan() });
    s = await service.run('research_legal_sources', coverageActor, { research_id: s.research_id, expected_revision: s.revision,
      issue_ids: ['case'], purpose: 'context', tool: 'get_decision_text', arguments: { id: 'synthetic-judgment', domain: 'prec', full: true } });
    const e = s.evidence[0];
    assert.equal(e.document_version, observedDate ? '20990201' : 'unknown');
    assert.equal(e.statute_anchor, undefined); // A judgment's date does not become a law's effective date.
    if (observedDate) {
      const wrong = assessment(s, 'not_required_for_question'); wrong.requirement_assessments[0].basis.version = '20990101';
      await assert.rejects(() => service.run('update_legal_research', coverageActor, wrong), e => e.code === 'REQUIREMENT_VERSION_MISMATCH');
      const next = await service.run('update_legal_research', coverageActor, assessment(s, 'not_required_for_question'));
      assert.equal(next.requirements.find(r => r.target.id === 'unclassified').status, 'not_required_for_question');
      assert.deepEqual(next.evidence, s.evidence);
    } else await assert.rejects(() => service.run('update_legal_research', coverageActor, assessment(s, 'not_required_for_question')),
      e => e.code === 'REQUIREMENT_VERSION_MISMATCH');
  }
});
function assessment(s, status, reason = '현재 합성 규정과 질문 범위의 대응', target = 'unclassified') {
  const r = s.requirements.find(r => r.target.id === target), e = s.evidence[0], p = e.passages[0];
  return { research_id: s.research_id, expected_revision: s.revision, expected_state_version: s.state_version,
    requirement_assessments: [{ requirement_id: r.requirement_id, status, reason,
      basis: { kind: 'source', version: e.document_version, citation: { evidence_id: e.evidence_id, passage_id: p.passage_id,
        quote: p.text, relation: 'direct', reason: '가상 원문 확인' } } }] };
}

test('CF-09/11: supported scope exclusion preserves unknown facts, observations and scope verification', async t => {
  const { f, s } = await prepared(t), calls = f.calls.length;
  const input = assessment(s, 'not_required_for_question');
  const next = await f.service.run('update_legal_research', coverageActor, input);
  assert.equal(next.revision, s.revision); assert.equal(next.state_version, s.state_version + 1);
  assert.deepEqual(next.attempts, s.attempts); assert.deepEqual(next.evidence, s.evidence);
  assert.deepEqual(next.plan.facts, s.plan.facts); assert.equal(next.interview.next_question, null);
  assert.equal(f.calls.length, calls);
  const reviewed = await f.service.run('review_legal_reasoning', coverageActor, coverageReview(next));
  assert.equal(reviewed.status, 'structurally_complete', JSON.stringify(reviewed.findings));
  assert.equal(reviewed.question_scope_complete, true);
  await assert.rejects(() => f.service.run('update_legal_research', coverageActor, input), e => e.code === 'RESEARCH_STATE_CHANGED');
  const repeat = await f.service.run('update_legal_research', coverageActor, { ...input, expected_state_version: next.state_version });
  assert.equal(repeat.state_version, next.state_version); assert.equal(repeat.last_review.current, true);
  const changed = assessment(repeat, 'required', '조건 해석을 재검토한 별도 선언');
  const revised = await f.service.run('update_legal_research', coverageActor, changed);
  assert.equal(revised.last_review, null); assert.equal(revised.state_version, repeat.state_version + 1);
  // These assertions verify provenance and lifecycle, not whether the model interpreted this clause correctly.
  assert.equal(revised.legal_verification, 'unverified'); assert.equal(f.calls.length, calls);
});

test('CF-09: a grounded genuinely missing requirement remains a question and prevents complete scope', async t => {
  const { f, s } = await prepared(t, true);
  const next = await f.service.run('update_legal_research', coverageActor, assessment(s, 'required'));
  assert.equal(next.interview.next_question.target.id, 'unclassified');
  assert.equal(next.plan.facts.find(f => f.id === 'unclassified').status, 'unknown');
  const review = await f.service.run('review_legal_reasoning', coverageActor, coverageReview(next));
  assert.equal(review.status, 'blocked'); assert.equal(review.question_scope_complete, false);
  assert.ok(review.findings.some(f => f.code === 'REQUIRED_FACT_UNCONFIRMED'));
  const conditional = coverageReview(next), a = conditional.analysis[0];
  a.conclusion_mode = 'conditional'; a.unknowns = ['등록 사실이 확인되지 않음']; a.next_queries = ['등록 여부 확인'];
  a.blocking_conditions = [{ text: a.unknowns[0], requirement_ids: [next.requirements.find(r => r.target.id === 'unclassified').requirement_id], gap_ids: [] }];
  conditional.scope_assessments[0].status = 'conditional';
  assert.equal((await f.service.run('review_legal_reasoning', coverageActor, conditional)).status, 'needs_info');
});

test('CF-10: necessity decisions reject fabricated, foreign, partial and wrong-version citations atomically', async t => {
  const { f, s } = await prepared(t);
  const valid = assessment(s, 'not_required_for_question');
  const mutations = [
    input => { input.requirement_assessments[0].requirement_id = randomUUID(); },
    input => { input.requirement_assessments[0].basis.citation.evidence_id = randomUUID(); },
    input => { input.requirement_assessments[0].basis.citation.quote = '없는 인용문'; },
    input => { input.requirement_assessments[0].basis.version = '19000101'; },
  ];
  for (const mutate of mutations) {
    const invalid = structuredClone(valid); mutate(invalid);
    await assert.rejects(() => f.service.run('update_legal_research', coverageActor, invalid));
    const after = await f.service.run('get_legal_research', coverageActor, { research_id: s.research_id });
    assert.equal(after.state_version, s.state_version); assert.deepEqual(after.requirements, s.requirements);
  }
  await assert.rejects(() => f.service.run('update_legal_research', { ...coverageActor, id: 'other' }, valid), e => e.code === 'RESEARCH_NOT_FOUND');
  const partial = coverageFixture(() => ({ result: { content: [{ type: 'text', text:
    '법령명: 합성법\n시행일: 20200101\n제1조(합성)\n요건이 일부 보임. 응답 크기 제한' }] } }));
  t.after(() => partial.service.close());
  const incomplete = await partial.law(await partial.start(requirementPlan()));
  await assert.rejects(() => partial.service.run('update_legal_research', coverageActor, assessment(incomplete, 'not_required_for_question')),
    e => e.code === 'REQUIREMENT_SOURCE_INCOMPLETE');
});

test('CF-10/11: renaming and deleting a requirement cannot silently resolve it across plan revisions', async t => {
  const { f, s } = await prepared(t);
  let next = await f.service.run('update_legal_research', coverageActor, assessment(s, 'required'));
  const requirementId = next.requirements.find(r => r.target.id === 'unclassified').requirement_id;
  const renamed = structuredClone(next.plan); renamed.facts[1].id = 'renamed'; renamed.issues[0].required_fact_ids[1] = 'renamed';
  next = await f.api('update_legal_research', next, { plan: renamed });
  const record = next.requirements.find(r => r.requirement_id === requirementId);
  assert.ok(record); assert.equal(record.target.id, 'renamed'); assert.equal(record.status, 'unresolved');
  const history = next.requirement_history.at(-1).changes.find(r => r.requirement_id === requirementId);
  assert.equal(history.before.target.id, 'unclassified'); assert.equal(history.after.target.id, 'renamed');
  assert.equal(history.before.status, 'required'); assert.equal(history.after.status, 'unresolved');
  const dropped = structuredClone(next.plan); dropped.facts.splice(1, 1); dropped.issues[0].required_fact_ids = ['known'];
  next = await f.api('update_legal_research', next, { plan: dropped });
  assert.ok(next.requirements.some(r => r.requirement_id === requirementId && r.scope_status === 'unmapped' && r.status === 'unresolved'));
  assert.ok(next.requirement_history.length > 0);
  next = await f.api('reuse_legal_evidence', next, { issue_ids: ['case'], evidence_ids: next.evidence.map(e => e.evidence_id) });
  next = await f.finish(next);
  const review = await f.service.run('review_legal_reasoning', coverageActor, coverageReview(next));
  assert.equal(review.question_scope_complete, false);
  assert.ok(review.findings.some(f => f.code === 'REQUIREMENT_SCOPE_UNRESOLVED'));
  const withdrawal = assessment(next, 'not_required_for_question', '현재 합성 원문의 적용은 등록을 요구하지 않아 선언에서 제외함', 'renamed');
  withdrawal.requirement_assessments[0].scope_issue_id = 'case';
  next = await f.service.run('update_legal_research', coverageActor, withdrawal);
  assert.equal(next.requirements.find(r => r.requirement_id === requirementId).scope_status, 'withdrawn');
  assert.equal((await f.service.run('review_legal_reasoning', coverageActor, coverageReview(next))).status, 'structurally_complete');
});

test('CF-10: real plan changes invalidate old necessity citations without converting old retrievals into fresh ones', async t => {
  const { f, s } = await prepared(t);
  const assessed = await f.service.run('update_legal_research', coverageActor, assessment(s, 'not_required_for_question'));
  const plan = structuredClone(assessed.plan); plan.query += ' 실제 판단 범위 수정';
  const changed = await f.api('update_legal_research', assessed, { plan });
  const stale = assessment({ ...changed, evidence: s.evidence }, 'not_required_for_question');
  await assert.rejects(() => f.service.run('update_legal_research', coverageActor, stale), e => e.code === 'REQUIREMENT_EVIDENCE_NOT_CURRENT');
  assert.deepEqual(changed.attempts, s.attempts); assert.equal(changed.requirements.find(r => r.target.id === 'unclassified').status, 'unresolved');
});

test('CF-10: exclusions cannot bypass checks on unknown facts actually used in a claim', async t => {
  const { f, s } = await prepared(t);
  const next = await f.service.run('update_legal_research', coverageActor, assessment(s, 'not_required_for_question'));
  const input = coverageReview(next); input.analysis[0].claims[0].fact_ids.push('unclassified');
  const review = await f.service.run('review_legal_reasoning', coverageActor, input);
  assert.ok(review.findings.some(f => f.code === 'USED_FACT_UNCONFIRMED'));
  assert.equal(review.question_scope_complete, false);
});

test('CF-10: moving an excluded condition into free-text withholding cannot make it a supported blocker', async t => {
  const { f, s } = await prepared(t);
  const next = await f.service.run('update_legal_research', coverageActor, assessment(s, 'not_required_for_question'));
  const input = coverageReview(next), a = input.analysis[0];
  a.conclusion_mode = 'conditional'; a.unknowns = ['등록 필요라는 조건을 되살림']; a.next_queries = ['등록 확인'];
  let review = await f.service.run('review_legal_reasoning', coverageActor, input);
  assert.ok(review.findings.some(f => f.code === 'WITHHOLDING_BASIS_UNCLASSIFIED'));
  a.blocking_conditions = [{ text: a.unknowns[0], requirement_ids: [next.requirements.find(r => r.target.id === 'unclassified').requirement_id], gap_ids: [] }];
  review = await f.service.run('review_legal_reasoning', coverageActor, input);
  assert.ok(review.findings.some(f => f.code === 'WITHHOLDING_REQUIREMENT_NOT_BLOCKING'));
  assert.equal(review.question_scope_complete, false);
});

test('CF-10: a necessity decision must be linked to the final applicable-source map, not merely a stored body', async t => {
  const { f, s } = await prepared(t);
  const next = await f.service.run('update_legal_research', coverageActor, assessment(s, 'not_required_for_question'));
  const input = coverageReview(next), basis = next.requirements.find(r => r.target.id === 'unclassified').basis.evidence_id;
  input.analysis[0].legal_basis.statutes = input.analysis[0].legal_basis.statutes.filter(s => s.citation.evidence_id !== basis);
  input.analysis[0].legal_basis.temporal_application.citations = input.analysis[0].legal_basis.temporal_application.citations.filter(c => c.evidence_id !== basis);
  const review = await f.service.run('review_legal_reasoning', coverageActor, input);
  assert.ok(review.findings.some(f => f.code === 'REQUIREMENT_APPLICABILITY_LINK_REQUIRED'));
  assert.equal(review.question_scope_complete, false);
});
