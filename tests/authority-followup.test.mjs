import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { identityFromDocument } from '../dist/researchIdentity.js';
import { researchCoverage } from '../dist/researchCoverage.js';
import { observeSearch } from '../dist/researchSearch.js';
import { coverageFixture, coveragePlan, coverageReview, providerResponse } from './fixtures/authority-provider.mjs';
import { inspectResearch } from '../dist/researchReview.js';
import { reasoningInput, review, prepare, readAll, status } from './fixtures/reasoning-v2.mjs';

test('Pro F-5: independent issuer and court conflicts cannot become Supreme Court evidence', () => {
  const doc = { id: 'a', documentType: '판결', issuingAgency: '대법원', court: '서울고등법원' };
  assert.equal(identityFromDocument(doc, 'nts', 'tax_document').status, 'conflict');
  assert.equal(identityFromDocument({ ...doc, issuingAgency: undefined }, 'nts', 'tax_document').kind, 'lower_court');
  assert.equal(identityFromDocument({ ...doc, court: undefined }, 'nts', 'tax_document').kind, 'supreme_court');
});

test('Pro F-6: an expired in-flight call keeps its reservation until actual settlement', async () => {
  let now = 1, finish, calls = 0;
  const gate = new Promise(resolve => { finish = resolve; });
  const f = coverageFixture(async (name, args) => { if (++calls === 1) await gate; return providerResponse(name, args); },
    { now: () => now, limits: { ttlMs: 50, yieldMs: 1, transientBytes: 20000, maxTotalBytes: 35000 } });
  const first = await f.law(await f.start()); assert.equal(first.pending, true);
  now = 100;
  await assert.rejects(() => f.start(), e => e.code === 'RESEARCH_CAPACITY' && e.capacity_reason === 'shared_reservation');
  assert.equal(calls, 1, 'expired call is still consuming the global reservation');
  finish(); await new Promise(resolve => setTimeout(resolve, 10));
  const second = await f.law(await f.start()); assert.equal(second.job.status, 'completed'); assert.equal(calls, 2);
  f.service.close();
});

test('Pro F-4: 32 stored units can be rebound after a fact revision without another source call or body copy', async () => {
  const f = coverageFixture(); let s = await f.start();
  for (let n = 0; n < 32; n++) s = await f.law(s);
  const originals = s.evidence.map(e => ({ id: e.evidence_id, at: e.observed_at, hash: e.response_hash }));
  const count = f.calls.length, plan = structuredClone(s.plan); plan.facts[0].value = '보완된 합성 사실';
  s = await f.api('update_legal_research', s, { plan });
  s = await f.api('reuse_legal_evidence', s, { issue_ids: ['case'], evidence_ids: originals.map(e => e.id) });
  assert.equal(f.calls.length, count); assert.equal(s.evidence.length, 32);
  assert.equal(s.coverage.preparation_gaps.length, 0);
  assert.equal(s.last_review, null);
  for (const e of s.evidence) { const original = originals.find(o => o.id === e.evidence_id);
    assert.equal(e.revision, s.revision); assert.equal(e.observed_at, original.at);
    assert.equal(e.response_hash, original.hash); assert.equal(e.cache_of, e.evidence_id); }
  assert.equal(s.coverage.obligations.some(o => o.status.startsWith('completed')), false, 'old searches are not fresh searches');
  f.service.close();
});

test('Pro F-2: a new law MST is an unread version candidate, not a completed empty amendment search', async () => {
  const f = coverageFixture(); let s = await f.law(await f.start());
  s = await f.api('research_legal_sources', s, { issue_ids: ['case'], purpose: 'timing', tool: 'search_law', arguments: { query: '소득세법', display: 50 } });
  assert.ok(s.coverage.candidates.some(c => c.identity.family === 'statute'));
  const amendment = s.coverage.obligations.find(o => o.purpose === 'amendment');
  assert.equal(amendment.status, 'completed_with_candidates'); assert.ok(amendment.candidate_ids.length);
  f.service.close();
});

test('Pro F-3: only the same observed document/version/role can satisfy an alternative failed body request', () => {
  const identity = identityFromDocument({ id: 'doc', documentNumber: '번호-1', productionDate: '2026-01-01', issuingAgency: '국세청', documentType: '질의회신' }, 'nts', 'tax_document');
  const evidence = { evidence_id: randomUUID(), revision: 1, issue_ids: ['case'], purpose: 'context', body_scope: 'body_returned', identity,
    document_version: '2026-01-01', units: [{ role: 'document', date: null, body_scope: 'body_returned', source_access: 'available' }], passages: [] };
  const failed = { attempt_id: randomUUID(), revision: 1, issue_ids: ['case'], purpose: 'context', tool: 'get_tax_document', arguments_hash: 'one', status: 'failed',
    requirement: { document_key: 'nts:tax_document:doc', document_number: '번호-1', document_version: '2026-01-01', role: 'document', date: null } };
  const success = { attempt_id: randomUUID(), revision: 1, issue_ids: ['case'], purpose: 'context', tool: 'lookup_tax_document', arguments_hash: 'two', status: 'completed', evidence_ids: [evidence.evidence_id] };
  const inspect = e => researchCoverage(coveragePlan(), 1, [e], [failed, success]);
  assert.equal(inspect(evidence).incomplete_attempts.length, 0);
  assert.equal(inspect(evidence).resolved_attempts[0].resolved_by_attempt_id, success.attempt_id);
  for (const bad of [{ ...evidence, identity: { ...identity, document_id: 'other' } }, { ...evidence, document_version: '2025-01-01' },
    { ...evidence, body_scope: 'partial' }, { ...evidence, units: [{ ...evidence.units[0], role: 'current' }] }])
    assert.equal(inspect(bad).incomplete_attempts.length, 1);
});

test('Pro F-2: court zero cannot close a tribunal subsequent-treatment obligation', async () => {
  const row = { ntstDcmId: 'appeal', documentNumber: '조심-2025-서-0001', productionDate: '2025-01-01', issuingAgency: '조세심판원', documentType: '심판청구' };
  const f = coverageFixture((name, args) => name === 'get_tax_document'
    ? { result: { structuredContent: { document: { ...row, answer: '합성 심판 원문' } } } } : providerResponse(name, args));
  let s = await f.law(await f.start());
  s = await f.api('research_legal_sources', s, { issue_ids: ['case'], purpose: 'support', tool: 'get_tax_document', arguments: { ntst_dcm_id: 'appeal' } });
  const steps = s.coverage.obligations.filter(o => o.purpose === 'subsequent');
  assert.deepEqual(steps.map(o => o.family).sort(), ['adjudication', 'court']);
  for (let n = 0; n < 2; n++) {
    const step = s.coverage.obligations.find(o => o.purpose === 'subsequent' && o.family === 'court').next_step;
    s = await f.api('research_legal_sources', s, { tool: step.tool, arguments: step.arguments, purpose: step.purpose, issue_ids: ['case'] });
  }
  assert.ok(s.coverage.obligations.find(o => o.purpose === 'subsequent' && o.family === 'court').status.startsWith('completed'));
  assert.equal(s.coverage.obligations.find(o => o.purpose === 'subsequent' && o.family === 'adjudication').status, 'not_attempted');
  f.service.close();
});

test('Pro F-1: supplementary broad discovery stays visible and cannot downgrade a required failed query', async () => {
  const f = coverageFixture((name, args) => name.startsWith('search_tax_') && args.query === '넓은 보조 탐색'
    ? providerResponse(name, args, { total: 100, items: [] }) : providerResponse(name, args));
  let s = await f.law(await f.start());
  s = await f.api('research_legal_sources', s, { issue_ids: ['case'], purpose: 'context', tool: 'search_tax_decisions', arguments: { type: 'court', query: '넓은 보조 탐색', page: 1, limit: 20 } });
  assert.equal(s.attempts.at(-1).search_scope, 'exploratory'); assert.equal(s.coverage.exploratory_gaps.length, 1);
  assert.equal(s.coverage.obligations.every(o => o.status === 'not_attempted'), true);
  const step = s.coverage.obligations[0].next_step;
  s = await f.api('research_legal_sources', s, { issue_ids: ['case'], purpose: step.purpose, tool: step.tool, arguments: step.arguments });
  assert.equal(s.attempts.at(-1).search_scope, 'required');
  f.service.close();
});

test('Rate-limited provider searches preserve a retry hint and are never zero results', () => {
  const r = observeSearch('search_tax_decisions', { type: 'court', query: '쟁점', page: 1, limit: 20 },
    { result: { isError: true, structuredContent: { ok: false, error: { code: 'RATE_LIMITED', detail: { retryAfterSec: 2 } } } } });
  assert.equal(r.status, 'failed'); assert.equal(r.total, null); assert.equal(r.retry_after_ms, 2000);
});

function subsequentFixture({ longSuccessor = false, reasoningV2Enabled = false } = {}) {
  return coverageFixture((name, args) => {
    if (name === 'get_law_text') return { result: { content: [{ type: 'text', text: '법령명: 합성법\n시행일: 20200101\n제1조(취득)\n합성 취득 요건과 부칙.' }] } };
    if (name === 'search_law') return { result: { content: [{ type: 'text', text: '검색 결과 (총 0건):' }] } };
    if (name === 'search_decisions') {
      if (args.query === '보조 쟁점 탐색') return { result: { content: [{ type: 'text', text:
        '판례 검색 결과 (총 1건, 1페이지)\n[extra] 합성 보조 판결\n  사건번호: 2022두3\n  법원: 대법원\n  선고일: 20210101' }] } };
      const next = args.query.includes('2020두1');
      const found = next || !/변경|2021두2|2022두3|적용 제외|예외/.test(args.query);
      return { result: { content: [{ type: 'text', text: `판례 검색 결과 (총 ${found ? 1 : 0}건, 1페이지)\n` +
        (found ? `[${next ? 'next' : 'old'}] 합성 판결\n  사건번호: ${next ? '2021두2' : '2020두1'}\n  법원: 대법원\n  선고일: 20210101` : '') }] } };
    }
    if (name === 'get_decision_text') return { result: { content: [{ type: 'text', text: `기본 정보:\n사건번호: ${args.id === 'next' ? '2021두2' : args.id === 'extra' ? '2022두3' : '2020두1'}\n법원: 대법원\n선고일: 20210101\n전문:\n`
      + (longSuccessor && args.id === 'next' ? '합성 판결의 실제 적용 요건.\n'.repeat(7000) : '합성 판결 요건.') }] } };
    return providerResponse(name, args);
  }, { reasoningV2Enabled });
}

test('IR-24: moving the same applied authority into each v2 field preserves identity, law-version and follow-up obligations', async t => {
  const f = subsequentFixture({ reasoningV2Enabled: true }); t.after(() => f.service.close());
  const s = await f.finish(await f.law(await f.start())), e = s.evidence.find(e => e.identity?.document_number === '2021두2');
  const citation = { evidence_id: e.evidence_id, passage_id: e.passages[0].passage_id, quote: e.passages[0].text,
    relation: 'direct', reason: '현재 사건 적용 근거' };
  const obligation = r => r.coverage.obligations.filter(o => o.document_key === 'moleg:precedent:next');
  for (const slot of ['test', 'application', 'conflict', 'block', 'exclusion']) {
    const input = reasoningInput(s), a = input.analysis[0], cite = structuredClone(citation);
    if (slot === 'test') a.legal_tests[0].citations.push(cite);
    if (slot === 'application') a.claims[0].application[0].citations.push(cite);
    if (slot === 'block') input.answer_blocks[0].citations.push(cite);
    if (slot === 'conflict') a.authority_conflicts.push({ id: 'conflict', claim_ids: ['claim'], test_ids: ['acquired'],
      left: { proposition: '현재 적용', citations: [cite] }, right: { proposition: '예외 가능성', citations: a.legal_tests[0].citations },
      law_difference: '같은 규정', date_difference: '같은 시점', fact_difference: '확인한 사실 차이', disposition: 'prefer_left', reason: '직접 적용 검토', resolution_citations: [cite] });
    if (slot === 'exclusion') {
      a.legal_tests.push({ ...a.legal_tests[0], id: 'excluded', kind: 'exception' });
      a.excluded_tests.push({ test_id: 'excluded', reason: '예외 배제 근거', citations: [cite] });
    }
    const authority = { evidence_id: e.evidence_id, kind: 'lower_court', disposition: 'applied',
      statute_evidence_ids: [a.legal_basis.statutes[0].citation.evidence_id], law_version_relation: 'different_rule', reason: '의도적인 잘못된 적용',
      subsequent_review: { status: 'addressed', reason: '아직 수행하지 않은 후속 조회', citations: [], search_attempt_ids: [] } };
    a.legal_basis.authorities = [authority];
    const result = await review({ ...f, state: s }, input);
    for (const code of ['AUTHORITY_KIND_MISMATCH', 'AUTHORITY_LAW_CONTRADICTION', 'SUBSEQUENT_SEARCH_REQUIRED'])
      assert.ok(result.findings.some(f => f.code === code), slot + ': ' + code);
    assert.equal(obligation(result).length, 1, slot);
    const live = await status({ ...f, state: s }); assert.equal(obligation(live).length, 1, slot);
    // The same source used only to describe history does not create a fresh chain.
    cite.relation = 'background'; authority.kind = 'supreme_court'; authority.disposition = 'distinguished'; authority.law_version_relation = 'same_rule';
    const background = await review({ ...f, state: s }, input);
    assert.equal(obligation(background).length, 0, slot);
  }
});

test('IR-26: review packet provides every stored chunk of a long decision without duplicating or truncating its body', async t => {
  const f = subsequentFixture({ longSuccessor: true, reasoningV2Enabled: true }); t.after(() => f.service.close());
  const state = await f.finish(await f.law(await f.start())), wrapped = { ...f, state, input: reasoningInput(state) };
  const chunks = state.evidence.filter(e => e.identity?.document_number === '2021두2'); assert.ok(chunks.length > 1);
  await review(wrapped); const p = await prepare(wrapped), material = await readAll(wrapped, p);
  for (const e of chunks) assert.deepEqual(material.find(u => u.id === 'evidence:' + e.evidence_id).data, e);
  assert.equal(material.filter(u => u.id.startsWith('evidence:')).length, state.evidence.length);
});

async function splitSuccessor(t) {
  const f = subsequentFixture({ longSuccessor: true }); t.after(() => f.service.close());
  const s = await f.finish(await f.law(await f.start()));
  const chunks = s.evidence.filter(e => e.identity?.document_number === '2021두2');
  assert.ok(chunks.length > 1, 'real provider body must pass through actual multi-chunk storage');
  assert.equal(new Set(chunks.map(e => e.manifest_id)).size, 1);
  assert.ok(s.manifests.find(m => m.manifest_id === chunks[0].manifest_id)?.complete);
  assert.ok(!s.coverage.obligations.some(o => o.document_key === 'moleg:precedent:next'));
  const e = chunks.at(-1), input = coverageReview(s), a = input.analysis[0];
  const citation = { evidence_id: e.evidence_id, passage_id: e.passages[0].passage_id,
    quote: e.passages[0].text.slice(0, 100), relation: 'direct', reason: '후반부에 저장된 현재 적용 근거' };
  const authority = { evidence_id: e.evidence_id, kind: 'supreme_court', disposition: 'applied',
    statute_evidence_ids: [a.legal_basis.statutes[0].citation.evidence_id], law_version_relation: 'same_rule',
    reason: '합성 후속 판결의 현재 적용', subsequent_review: { status: 'addressed', reason: '별도 후속 조회가 필요', citations: [], search_attempt_ids: [] } };
  a.legal_basis.authorities = [authority];
  return { f, s, chunks, e, input, a, citation, authority };
}

for (const slot of ['claim', 'temporal', 'counter']) test(`FU-04: adopted non-first ${slot} citation opens exactly one document follow-up through the real runner`, async t => {
  const { f, s, chunks, e, input, a, citation } = await splitSuccessor(t);
  if (slot === 'claim') a.claims[0].citations.push(citation);
  else if (slot === 'temporal') a.legal_basis.temporal_application.citations.push(citation);
  else a.counter_evidence = [{ evidence_id: s.evidence.find(e => e.identity?.document_number === '2020두1').evidence_id,
    disposition: 'resolved', reason: '후속 판결 후반 원문으로 반론 해소', resolution_citations: [citation] }];
  const selected = view => view.coverage.obligations.filter(o => o.document_key === 'moleg:precedent:next');
  const before = inspectResearch(input, s.plan, s.evidence, s.attempts, s.ledger);
  assert.equal(selected(before).length, 1);
  assert.ok(selected(before)[0].next_step);
  const reversed = inspectResearch(input, s.plan, [...s.evidence].reverse(), s.attempts, s.ledger);
  assert.deepEqual(selected(reversed), selected(before), 'storage ordering cannot decide which adopted fragment counts');
  assert.ok(before.findings.some(x => x.code === 'SUBSEQUENT_SEARCH_REQUIRED' && x.detail.startsWith(e.evidence_id)));
  await f.service.run('review_legal_reasoning', { kind: 'auth_user', id: 'authority-fixture' }, input);
  const observed = await f.service.run('get_legal_research', { kind: 'auth_user', id: 'authority-fixture' }, { research_id: s.research_id });
  assert.ok(observed.review_adopted_evidence_ids.includes(e.evidence_id));
  assert.equal(selected(observed).length, 1);
  const count = f.calls.length, after = await f.finish(observed);
  assert.ok(f.calls.slice(count).some(c => c.name === 'search_decisions' && c.args.query.includes('2021두2')));
  assert.ok(selected(after).every(o => o.status.startsWith('completed')));
  assert.equal(f.calls.slice(count).filter(c => c.name === 'get_decision_text').length, 0, 'stored successor is not fetched again');
  assert.deepEqual(after.evidence.filter(x => chunks.some(c => c.evidence_id === x.evidence_id)), chunks);
});

for (const disposition of ['applied', 'analogy']) test(`FU-05: non-first ${disposition} authority without a claim citation still opens document follow-up`, async t => {
  const { s, e, input, authority } = await splitSuccessor(t); authority.disposition = disposition;
  const r = inspectResearch(input, s.plan, s.evidence, s.attempts, s.ledger);
  assert.ok(r.coverage.obligations.some(o => o.document_key === 'moleg:precedent:next' && o.next_step));
  assert.ok(r.findings.some(x => x.code === 'SUBSEQUENT_SEARCH_REQUIRED' && x.detail.startsWith(e.evidence_id)));
});

test('FU-06: non-first background or treatment-history citations alone preserve finite follow-up', async t => {
  const { f, s, e, input, a, citation, authority } = await splitSuccessor(t);
  authority.disposition = 'distinguished'; citation.relation = 'background';
  a.legal_basis.temporal_application.citations.push(citation);
  const check = () => {
    const r = inspectResearch(input, s.plan, s.evidence, s.attempts, s.ledger);
    assert.ok(!r.coverage.obligations.some(o => o.document_key === 'moleg:precedent:next'));
    assert.ok(!r.findings.some(x => x.code === 'SUBSEQUENT_SEARCH_REQUIRED' && x.detail.startsWith(e.evidence_id)));
  };
  check(); a.legal_basis.temporal_application.citations.pop();
  authority.subsequent_review.citations = [{ ...citation, relation: 'direct', reason: '판결 경과 설명에만 인용' }]; check();
  const count = f.calls.length; await f.run(s);
  assert.equal(f.calls.length, count);
});

for (const [slot, relation] of [['temporal', 'direct'], ['counter', 'analogy']])
  test(`FU-07: adopted exploratory ${slot} ${relation} survives review, status and real runner; background stays optional`, async t => {
    const f = subsequentFixture(); t.after(() => f.service.close());
    let s = await f.finish(await f.law(await f.start()));
    s = await f.api('research_legal_sources', s, { issue_ids: ['case'], purpose: 'context', tool: 'search_decisions',
      arguments: { domain: 'precedent', query: '보조 쟁점 탐색', page: 1, display: 50 } });
    assert.equal(s.attempts.at(-1).search_scope, 'exploratory');
    const candidate = s.coverage.candidates.find(c => c.key === 'moleg:precedent:extra');
    assert.equal(candidate.discovery_role, 'exploratory');
    s = await f.api('research_legal_sources', s, { issue_ids: ['case'], purpose: 'context', tool: 'get_decision_text',
      arguments: { domain: 'precedent', id: 'extra', full: true } });
    const e = s.evidence.find(e => e.identity?.document_number === '2022두3'), input = coverageReview(s), a = input.analysis[0];
    assert.equal(s.evidence.filter(x => x.identity?.document_number === '2022두3').length, 1);
    const cite = { evidence_id: e.evidence_id, passage_id: e.passages[0].passage_id, quote: e.passages[0].text,
      relation: 'background', reason: '보조 탐색으로 확인한 판결의 관계' };
    if (slot === 'temporal') a.legal_basis.temporal_application.citations.push(cite);
    else a.counter_evidence = [{ evidence_id: s.evidence.find(e => e.identity?.document_number === '2020두1').evidence_id,
      disposition: 'resolved', reason: '보조 자료를 통한 반론 검토', resolution_citations: [cite] }];
    const authority = { evidence_id: e.evidence_id, kind: 'supreme_court', disposition: 'distinguished',
      statute_evidence_ids: [a.legal_basis.statutes[0].citation.evidence_id], law_version_relation: 'same_rule', reason: '적용하지 않은 보조 자료',
      subsequent_review: { status: 'unresolved', reason: '현재 적용하지 않은 보조 판결', citations: [], search_attempt_ids: [] } };
    a.legal_basis.authorities = [authority];
    const work = view => view.coverage.obligations.filter(o => o.document_key === 'moleg:precedent:extra');
    const read = () => f.service.run('get_legal_research', { kind: 'auth_user', id: 'authority-fixture' }, { research_id: s.research_id });
    await f.service.run('review_legal_reasoning', { kind: 'auth_user', id: 'authority-fixture' }, input);
    s = await read(); assert.equal(work(s).length, 0);
    assert.ok(!s.review_adopted_evidence_ids.includes(e.evidence_id));
    const calls = f.calls.length; await f.run(s); assert.equal(f.calls.length, calls);
    s = await read(); input.expected_state_version = s.state_version;
    cite.relation = relation; authority.disposition = relation === 'direct' ? 'applied' : 'analogy';
    const reviewed = await f.service.run('review_legal_reasoning', { kind: 'auth_user', id: 'authority-fixture' }, input);
    assert.equal(work(reviewed).length, 1);
    s = await read(); assert.equal(work(s).length, 1, 'review-created obligation must remain visible to the runner');
    assert.ok(s.review_adopted_evidence_ids.includes(e.evidence_id));
    assert.deepEqual(work(s), work(reviewed));
    const before = f.calls.length; s = await f.finish(s);
    assert.ok(f.calls.slice(before).some(c => c.name === 'search_decisions' && c.args.query.includes('2022두3')));
    assert.ok(work(s).every(o => o.status.startsWith('completed')));
  });

test('FU-08: exploratory background has no contradictory mandatory follow-up with an empty worklist', async t => {
  const f = subsequentFixture(); t.after(() => f.service.close());
  let s = await f.finish(await f.law(await f.start()));
  s = await f.api('research_legal_sources', s, { issue_ids: ['case'], purpose: 'context', tool: 'search_decisions',
    arguments: { domain: 'precedent', query: '보조 쟁점 탐색', page: 1, display: 50 } });
  s = await f.api('research_legal_sources', s, { issue_ids: ['case'], purpose: 'context', tool: 'get_decision_text',
    arguments: { domain: 'precedent', id: 'extra', full: true } });
  const e = s.evidence.find(e => e.identity?.document_number === '2022두3'), input = coverageReview(s), a = input.analysis[0];
  a.legal_basis.temporal_application.citations.push({ evidence_id: e.evidence_id, passage_id: e.passages[0].passage_id,
    quote: e.passages[0].text, relation: 'background', reason: '현재 요건에 적용하지 않은 보조 판결의 배경 설명' });
  a.legal_basis.authorities = [{ evidence_id: e.evidence_id, kind: 'supreme_court', disposition: 'distinguished',
    statute_evidence_ids: [a.legal_basis.statutes[0].citation.evidence_id], law_version_relation: 'same_rule', reason: '다른 사실관계이므로 배경으로 구별',
    subsequent_review: { status: 'addressed', reason: '새 법리로 채택하지 않은 보조 발견', citations: [], search_attempt_ids: [] } }];
  const r = inspectResearch(input, s.plan, s.evidence, s.attempts, s.ledger);
  assert.ok(!r.coverage.obligations.some(o => o.document_key === 'moleg:precedent:extra'));
  assert.ok(!r.findings.some(x => x.code === 'SUBSEQUENT_SEARCH_REQUIRED' && x.detail.startsWith(e.evidence_id)));
});

test('FU-09: an earlier context receipt cannot suppress a later support receipt for the same document', async t => {
  const f = subsequentFixture(); t.after(() => f.service.close());
  let s = await f.finish(await f.law(await f.start()));
  const original = s.evidence.find(e => e.identity?.document_number === '2021두2');
  assert.equal(original.purpose, 'context');
  s = await f.api('research_legal_sources', s, { issue_ids: ['case'], purpose: 'support', tool: 'get_decision_text',
    arguments: { domain: 'precedent', id: 'next', full: true } });
  const receipts = s.evidence.filter(e => e.identity?.document_number === '2021두2');
  assert.equal(receipts.length, 2); assert.equal(receipts.at(-1).purpose, 'support');
  assert.equal(receipts[0].response_hash, receipts[1].response_hash);
  assert.equal(s.coverage.obligations.filter(o => o.document_key === 'moleg:precedent:next').length, 1);
  const before = f.calls.length; s = await f.finish(s);
  assert.ok(f.calls.slice(before).some(c => c.name === 'search_decisions' && c.args.query.includes('2021두2')));
  assert.ok(s.coverage.obligations.filter(o => o.document_key === 'moleg:precedent:next').every(o => o.status.startsWith('completed')));
});

for (const slot of ['temporal', 'counter']) test(`FU-01/02: ${slot} use of a successor cannot evade adoption, contradiction checks or runner follow-up`, async t => {
  const f = subsequentFixture(); t.after(() => f.service.close());
  const plan = coveragePlan();
  plan.scope_review.tracks.push({ id: 'notice', party: '납세자', legal_question: '요청 밖 안내', factual_anchor_ids: ['known'],
    relation: 'independent_notice', blocks_track_ids: [], issue_id: null, lifecycle: 'deferred' });
  let s = await f.finish(await f.law(await f.start(plan))), input = coverageReview(s);
  const e = s.evidence.find(e => e.identity?.document_number === '2021두2');
  const old = s.evidence.find(e => e.identity?.document_number === '2020두1');
  const citation = { evidence_id: e.evidence_id, passage_id: e.passages[0].passage_id, quote: e.passages[0].text,
    relation: 'direct', reason: '현재 적용 시점 또는 반론 해소의 직접 근거' };
  const a = input.analysis[0];
  if (slot === 'temporal') a.legal_basis.temporal_application.citations.push(citation);
  else a.counter_evidence = [{ evidence_id: old.evidence_id, disposition: 'resolved', reason: '후속 법리로 해소', resolution_citations: [citation] }];
  a.legal_basis.authorities = [{ evidence_id: e.evidence_id, kind: 'supreme_court', disposition: 'distinguished',
    statute_evidence_ids: [a.legal_basis.statutes[0].citation.evidence_id], law_version_relation: 'same_rule', reason: '구별 선언',
    subsequent_review: { status: 'addressed', reason: '후속에서 발견', citations: [], search_attempt_ids: [] } }];
  citation.relation = 'background';
  const background = inspectResearch(input, s.plan, s.evidence, s.attempts, s.ledger);
  assert.ok(!background.findings.some(x => ['AUTHORITY_DISPOSITION_CONTRADICTION', 'SUBSEQUENT_SEARCH_REQUIRED'].includes(x.code) && x.detail.startsWith(e.evidence_id)));
  citation.relation = 'analogy';
  const analogous = inspectResearch(input, s.plan, s.evidence, s.attempts, s.ledger);
  assert.ok(analogous.coverage.obligations.some(o => o.document_key === 'moleg:precedent:next' && o.next_step));
  citation.relation = 'direct';
  const r = await f.service.run('review_legal_reasoning', { kind: 'auth_user', id: 'authority-fixture' }, input);
  assert.ok(r.findings.some(x => x.code === 'AUTHORITY_DISPOSITION_CONTRADICTION' && x.detail.startsWith(e.evidence_id)));
  assert.ok(r.findings.some(x => x.code === 'SUBSEQUENT_SEARCH_REQUIRED' && x.detail.startsWith(e.evidence_id)));
  s = await f.service.run('get_legal_research', { kind: 'auth_user', id: 'authority-fixture' }, { research_id: s.research_id });
  assert.ok(s.coverage.obligations.some(o => o.document_key === 'moleg:precedent:next' && o.next_step));
  const adopted = s.review_adopted_evidence_ids;
  s = await f.api('update_legal_research', s, { expected_state_version: s.state_version, scope_promotions: [{ track_id: 'notice', issue_id: 'case' }] });
  assert.deepEqual(s.review_adopted_evidence_ids, adopted);
  assert.ok(s.coverage.obligations.some(o => o.document_key === 'moleg:precedent:next' && o.next_step));
  const calls = f.calls.length; await f.run(s);
  assert.ok(f.calls.slice(calls).some(c => c.name === 'search_decisions' && c.args.query.includes('2021두2')));
});

test('Model recovery: a follow-up decision adopted during review becomes resumable runner work', async () => {
  const f = subsequentFixture();
  try {
    let s = await f.finish(await f.law(await f.start()));
    const e = s.evidence.find(e => e.identity?.document_number === '2021두2'); assert.ok(e);
    assert.equal(s.coverage.obligations.some(o => o.document_key === 'moleg:precedent:next'), false);
    const input = coverageReview(s);
    input.analysis[0].legal_basis.authorities = [{ evidence_id: e.evidence_id, kind: 'supreme_court', disposition: 'applied',
      statute_evidence_ids: [input.analysis[0].legal_basis.statutes[0].citation.evidence_id], law_version_relation: 'same_rule',
      reason: '새로 채택한 합성 법리', subsequent_review: { status: 'unresolved', reason: '이 판결 자체의 후속 검색 필요', citations: [] } }];
    const review = await f.service.run('review_legal_reasoning', { kind: 'auth_user', id: 'authority-fixture' }, input);
    s = await f.service.run('get_legal_research', { kind: 'auth_user', id: 'authority-fixture' }, { research_id: s.research_id });
    assert.ok(s.coverage.obligations.some(o => o.document_key === 'moleg:precedent:next' && o.next_step));
    assert.ok(review.state_version > input.expected_state_version);
    const before = f.calls.length; s = await f.run(s);
    assert.ok(f.calls.slice(before).some(c => c.name === 'search_decisions' && c.args.query.includes('2021두2')));
  } finally { f.service.close(); }
});

test('Model recovery: distinguished follow-up candidates expose their empty search obligation and actionable reference correction', async () => {
  const f = subsequentFixture();
  try {
    const s = await f.finish(await f.law(await f.start())), input = coverageReview(s);
    const e = s.evidence.find(e => e.identity?.document_number === '2021두2');
    const work = s.review_worklist.find(c => c.evidence_ids.includes(e.evidence_id));
    assert.deepEqual(work.subsequent_search_requirements, []);
    const authority = { evidence_id: e.evidence_id, kind: 'supreme_court', disposition: 'distinguished',
      statute_evidence_ids: [input.analysis[0].legal_basis.statutes[0].citation.evidence_id], law_version_relation: 'different_rule',
      reason: '본문을 읽었으나 다른 규정의 후속 자료로 구별함',
      subsequent_review: { status: 'addressed', reason: '새 법적 근거로 채택하지 않은 후속 발견 자료', citations: [],
        search_attempt_ids: [s.coverage.obligations.find(o => o.purpose === 'subsequent').attempt_ids[0]] } };
    input.analysis[0].legal_basis.authorities = [authority];
    let result = inspectResearch(input, s.plan, s.evidence, s.attempts, s.ledger);
    assert.ok(result.findings.some(f => f.code === 'SUBSEQUENT_REFERENCE_NOT_REQUIRED' && f.detail.includes('search_attempt_ids=[]')));
    assert.ok(!result.findings.some(f => f.code === 'SUBSEQUENT_SEARCH_REQUIRED' && f.detail.startsWith(e.evidence_id)));
    authority.subsequent_review.search_attempt_ids = [];
    result = inspectResearch(input, s.plan, s.evidence, s.attempts, s.ledger);
    assert.ok(!result.findings.some(f => f.code.startsWith('SUBSEQUENT_') && f.detail.startsWith(e.evidence_id)));
    authority.disposition = 'applied'; authority.law_version_relation = 'same_rule';
    result = inspectResearch(input, s.plan, s.evidence, s.attempts, s.ledger);
    assert.ok(result.findings.some(f => f.code === 'SUBSEQUENT_SEARCH_REQUIRED' && f.detail.startsWith(e.evidence_id)));
  } finally { f.service.close(); }
});

test('Model recovery: a neutral-search body can be assessed as contrary evidence without fetching it twice', async () => {
  const f = subsequentFixture();
  try {
    const s = await f.finish(await f.law(await f.start())), input = coverageReview(s);
    const e = s.evidence.find(e => e.identity?.document_number === '2020두1'); assert.equal(e.purpose, 'context');
    input.analysis[0].counter_evidence = [{ evidence_id: e.evidence_id, disposition: 'unresolved', reason: '새로 확인한 반대 법리' }];
    const result = inspectResearch(input, s.plan, s.evidence, s.attempts, s.ledger);
    assert.ok(!result.findings.some(f => f.code === 'COUNTER_SCOPE_MISMATCH'));
    assert.ok(result.findings.some(f => f.code === 'UNRESOLVED_COUNTER'));
    const foreign = s.evidence.map(x => x.evidence_id === e.evidence_id ? { ...x, issue_ids: ['other_issue'] } : x);
    assert.ok(inspectResearch(input, s.plan, foreign, s.attempts, s.ledger).findings.some(f => f.code === 'COUNTER_SCOPE_MISMATCH'));
  } finally { f.service.close(); }
});

test('Model recovery: one identical required query serves two registered issues without duplicate external calls', async () => {
  const f = coverageFixture();
  try {
    const p = coveragePlan(); p.issues.push({ ...p.issues[0], id: 'timing', question: '같은 규정의 시점 적용' });
    let s = await f.start(p);
    s = await f.api('research_legal_sources', s, { issue_ids: ['case', 'timing'], purpose: 'timing', tool: 'get_law_text', arguments: { lawId: '100', jo: '제1조' } });
    const before = f.calls.length; s = await f.run(s, { max_steps: 1 });
    assert.equal(f.calls.length - before, 1);
    const neutrals = s.coverage.obligations.filter(o => o.family === 'court' && o.purpose === 'neutral' && !o.channel);
    assert.equal(neutrals.length, 2); assert.ok(neutrals.every(o => o.attempt_ids.length === 1));
    assert.equal(new Set(neutrals.flatMap(o => o.attempt_ids)).size, 1);
    assert.ok(s.coverage.obligations.filter(o => o.purpose === 'counter').every(o => o.status === 'not_attempted'));
  } finally { f.service.close(); }
});

test('Model recovery: related issues sharing a two-home statute retain the case topic, unrelated VAT does not', async () => {
  const f = coverageFixture((name, args) => name === 'get_law_text' && args.lawId === 'vat'
    ? { result: { content: [{ type: 'text', text: '법령명: 부가가치세법\n시행일: 20200101\n제1조(합성 부가세)\n합성 원문' }] } } : providerResponse(name, args));
  try {
    const p = coveragePlan(); p.query = '일시적 2주택 취득 순서와 별도 용역'; p.issues[0].profile = 'temporary_two_homes';
    p.issues.push({ ...p.issues[0], profile: 'general', id: 'timing', question: '같은 규정의 시점 적용' },
      { id: 'vat', question: '별도 용역의 부가가치세', required_fact_ids: [], required_date_roles: [] });
    let s = await f.start(p);
    s = await f.api('research_legal_sources', s, { issue_ids: ['case', 'timing'], purpose: 'timing', tool: 'get_law_text', arguments: { lawId: '100', jo: '제1조' } });
    s = await f.api('research_legal_sources', s, { issue_ids: ['vat'], purpose: 'timing', tool: 'get_law_text', arguments: { lawId: 'vat', jo: '제1조' } });
    const firstQuery = issue => s.coverage.obligations.find(o => o.issue_id === issue && o.family === 'court' && o.purpose === 'neutral' && !o.channel).next_step.arguments.query;
    assert.equal(firstQuery('case'), firstQuery('timing')); assert.ok(!firstQuery('vat').includes('신규 주택'));
  } finally { f.service.close(); }
});

test('Pro F-3 model regression: an exact MST body resolves a failed law-ID read of that version', async () => {
  const f = coverageFixture();
  try {
    let s = await f.start();
    s = await f.api('research_legal_sources', s, { issue_ids: ['case'], purpose: 'context', tool: 'search_law', arguments: { query: '소득세법', display: 10 } });
    const candidate = s.coverage.candidates[0];
    s = await f.api('research_legal_sources', s, { issue_ids: ['case'], purpose: 'support', candidate_id: candidate.candidate_id,
      tool: 'get_law_text', arguments: { lawId: '100', jo: '제1조' } });
    assert.equal(s.attempts.at(-1).error_code, 'CANDIDATE_DOCUMENT_MISMATCH');
    const failed = s.attempts.at(-1).attempt_id;
    s = await f.api('research_legal_sources', s, { issue_ids: ['case'], purpose: 'support', tool: 'get_law_text', arguments: { mst: '999', jo: '제1조' } });
    assert.ok(s.coverage.incomplete_attempts.some(a => a.attempt_id === failed), 'a different MST cannot satisfy it');
    s = await f.api('research_legal_sources', s, { issue_ids: ['case'], purpose: 'support', tool: 'get_law_text', arguments: { mst: '200', jo: '제1조' } });
    assert.ok(!s.coverage.incomplete_attempts.some(a => a.attempt_id === failed));
    assert.ok(s.coverage.resolved_attempts.some(a => a.attempt_id === failed));
  } finally { f.service.close(); }
});
