import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptResearchEvidence } from '../dist/researchEvidence.js';
import { inspectResearch } from '../dist/researchReview.js';
import { ResearchService } from '../dist/research.js';
import { LawMcpError } from '../dist/koreanLawClient.js';
import { digest, ServiceError } from '../dist/contracts.js';
import { observeSearch } from '../dist/researchSearch.js';
import { observeIdentity } from '../dist/researchIdentity.js';
import { researchCoverage, addCandidates, carryCandidates, candidateGaps } from '../dist/researchCoverage.js';
import { splitDocument, verifyManifest } from '../dist/researchStorage.js';
import { applyResearchProfiles } from '../dist/researchProfiles.js';
import { researchProgress } from '../dist/researchProgress.js';
import { coverageFixture, coverageActor, coveragePlan, coverageReview, providerResponse } from './fixtures/authority-provider.mjs';

const id = n => '00000000-0000-4000-8000-' + String(n).padStart(12, '0');
const cite = e => ({ evidence_id: e.evidence_id, passage_id: e.passages[0].passage_id,
    quote: e.passages[0].text, relation: 'direct', reason: '합성 원문과 요건을 대조했다.' });

test('Model recovery: a finished search batch cannot hide an unread body or an unreviewed candidate', async () => {
  const f = coverageFixture();
  try {
    let s = await f.law(await f.start());
    assert.equal(s.retrieval_progress.state, 'retrieving');
    assert.equal(s.retrieval_progress.next_step.tool, 'search_decisions');
    s = await f.finish(s);
    assert.equal(s.retrieval_progress.state, 'ready_for_analysis');
    assert.equal(s.review_worklist[0].status, 'applicability_review_required');
    assert.equal(s.legal_verification, 'unverified');
    const coverage = researchCoverage(s.plan, s.revision, [], s.attempts, s.ledger);
    const progress = researchProgress(coverage);
    assert.notEqual(progress.retrieval_progress.state, 'ready_for_analysis');
    assert.ok(progress.retrieval_progress.missing_body_candidate_ids.length > 0);
  } finally { f.service.close(); }
});
function missingCoverage() {
  const wrap = (n, tool, args, result, purpose) => ({ ...adaptResearchEvidence(tool, args,
    { server: { name: tool === 'get_law_text' ? 'korean-law-mcp' : 'korean-taxlaw', version: 'fixture' }, result }),
    evidence_id: id(n), revision: 1, issue_ids: ['case'], purpose, tool, arguments_hash: 'fixture',
    observed_at: '2026-10-01T00:00:00Z', expires_at: '2026-10-01T00:30:00Z' });
  const law = wrap(1, 'get_law_text', { lawId: '100', article: '1' }, { content: [{ type: 'text',
    text: '법령명: 합성법\n시행일: 20200101\n제1조(취득 요건)\n합성 취득 요건을 충족하면 적용한다. 부칙: 2020년 양도부터 적용한다.' }] }, 'timing');
  const ruling = n => wrap(n, 'get_tax_document', { document_id: 'case-' + n }, { structuredContent: { document: {
    ntstDcmId: 'case-' + n, documentNumber: '합성-' + n, productionDate: '20260901',
    documentType: '질의회신', issuingAgency: '국세청', authorityLevel: 'nts_ruling',
    answer: '국세청의 합성 해석: 취득 요건을 충족한 사례에 대한 답변이다.',
  } } }, n === 2 ? 'support' : 'counter');
  const support = ruling(2), counter = ruling(3), evidence = [law, support, counter];
  const plan = { query: '합성 취득 요건 검토', issues: [{ id: 'case', question: '취득 요건', required_fact_ids: ['fact'], required_date_roles: [] }],
    facts: [{ id: 'fact', description: '취득', status: 'provided', value: '공동 취득', source: '합성 진술' }], event_dates: [] };
  const input = { research_id: id(4), expected_revision: 1, expected_state_version: 1, draft_answer: '합성 요건을 적용한다.', correction_needed: false,
    analysis: [{ issue_id: 'case', conclusion_mode: 'definitive', withholding_reason: '',
      claims: [{ id: 'claim', text: '합성 요건을 적용한다.', requirements: ['취득 요건'], fact_ids: ['fact'], citations: [cite(support)] }],
      counter_evidence: [{ evidence_id: counter.evidence_id, disposition: 'irrelevant', reason: '다른 취득 사실을 구별했다.' }],
      unknowns: [], next_queries: [], timing: { status: 'not_required', reason: '합성 사례', date_roles: [] },
      exceptions: { status: 'addressed', reason: '합성 예외 검토' }, legal_basis: {
        statutes: [{ citation: cite(law), version: '20200101', date_roles: [], reason: '적용 법령' }],
        temporal_application: { status: 'addressed', reason: '부칙 확인', citations: [cite(law)] },
        authorities: [support, counter].map(e => ({ evidence_id: e.evidence_id, kind: 'administrative_interpretation',
          disposition: e === support ? 'applied' : 'distinguished', statute_evidence_ids: [law.evidence_id], law_version_relation: 'same_rule',
          reason: '적용 관계 검토', subsequent_review: { status: 'addressed', reason: '후속 검색 없이 동일 문서만 인용함', citations: [cite(e)] } })),
      } }] };
  return { input, plan, evidence, run() { return inspectResearch(this.input, this.plan, this.evidence, []); } };
}
const codes = result => result.findings.map(f => f.code);

test('AC-01/02 RED: statutes and repeated rulings cannot replace judicial research', () => {
  const s = missingCoverage(), result = s.run();
  assert.equal(result.status, 'blocked');
  assert.ok(codes(result).includes('REQUIRED_SEARCH_INCOMPLETE'));
  Object.assign(s.input.analysis[0], { conclusion_mode: 'conditional', unknowns: ['판례 검색 미실행'], next_queries: ['필수 판례 검색'] });
  assert.equal(s.run().status, 'needs_info');
});
test('AC-07 RED: provider-observed NTS ruling cannot be relabelled supreme court', () => {
  const s = missingCoverage(); s.input.analysis[0].legal_basis.authorities[0].kind = 'supreme_court';
  assert.ok(codes(s.run()).includes('AUTHORITY_KIND_MISMATCH'));
});
test('AC-09 RED: re-citing a ruling is not evidence of a subsequent-treatment search', () => {
  const s = missingCoverage();
  assert.ok(codes(s.run()).includes('SUBSEQUENT_SEARCH_REQUIRED'));
});

const actor = { kind: 'auth_user', id: 'coverage-test' };
const simplePlan = () => ({ query: '합성 일반 쟁점', issues: [{ id: 'case', question: '합성 취득 요건', required_fact_ids: [], required_date_roles: [] }], facts: [], event_dates: [] });
const largeDocument = () => ({ server: { name: 'korean-taxlaw', version: 'fixture' }, result: { structuredContent: { document: {
  ntstDcmId: '1', documentNumber: '합성-1', documentType: '질의회신', issuingAgency: '국세청', authorityLevel: 'nts_ruling',
  productionDate: '20260101', answer: 'a'.repeat(200_000),
} } } });
const retrieve = (s, request_id = id(70)) => ({ research_id: s.research_id, expected_revision: s.revision, request_id,
  issue_ids: ['case'], purpose: 'support', tool: 'get_tax_document', arguments: { ntst_dcm_id: '1' } });
test('AC-28: a single complete large response is stored without truncation', async () => {
  const service = new ResearchService({ callTool: async () => largeDocument() });
  try {
    const s = await service.run('start_legal_research', actor, { plan: simplePlan() });
    const result = await service.run('research_legal_sources', actor, retrieve(s));
    assert.ok(result.evidence.length >= 2);
    assert.ok(result.evidence.every(e => e.body_scope === 'body_returned'));
    assert.equal(result.evidence.flatMap(e => e.passages).map(p => p.text).join(''), 'a'.repeat(200_000));
  } finally { service.close(); }
});
test('AC-29: a two-unit body with one free slot ends atomically and its failure is replayed', async () => {
  let calls = 0;
  const service = new ResearchService({ callTool: async () => { calls++; return largeDocument(); } }, undefined, { limits: { maxReceipts: 1 } });
  try {
    const s = await service.run('start_legal_research', actor, { plan: simplePlan() });
    const result = await service.run('research_legal_sources', actor, retrieve(s));
    assert.equal(result.attempts.at(-1).status, 'failed');
    assert.equal(result.evidence.length, 0);
    assert.equal(result.pending, false);
    const replay = await service.run('research_legal_sources', actor, retrieve(s));
    assert.equal(calls, 1);
    assert.equal(replay.attempts.at(-1).status, 'failed');
  } finally { service.close(); }
});

test('AC-03/24: completed bounded zero-result searches allow a normal review without invented counter documents', async () => {
  const f = coverageFixture();
  try {
    const s = await f.finish(await f.law(await f.start()));
    assert.ok(s.coverage.obligations.filter(o => o.purpose !== 'amendment').every(o => o.status === 'completed_no_candidate'));
    assert.equal(s.evidence.length, 2, 'only the original anchor and observed MST body consume body slots');
    const r = await f.service.run('review_legal_reasoning', coverageActor, coverageReview(s));
    assert.equal(r.status, 'structurally_complete', JSON.stringify(r.findings));
    assert.equal(r.question_scope_complete, true);
    assert.equal(r.legal_verification, 'unverified');
    assert.ok(s.attempts.filter(a => a.search?.total === 0).length >= 8, 'narrow zero requires broadening');
  } finally { f.service.close(); }
});
test('AC-17/29: the required runner respects step limits and replays completed requests without source calls', async () => {
  let budgetCalls = 0;
  const f = coverageFixture(undefined, { beforeSourceCall: () => { budgetCalls++; } });
  try {
    const initial = await f.law(await f.start()), request_id = id(90), first = await f.run(initial, { request_id, max_steps: 2 });
    assert.equal(f.calls.length, 3); assert.equal(budgetCalls, 3);
    const replay = await f.run(initial, { request_id, max_steps: 2 });
    assert.equal(replay.job.job_id, first.job.job_id); assert.equal(f.calls.length, 3);
    await assert.rejects(f.run(initial, { request_id, max_steps: 3 }), e => e.code === 'RESEARCH_REQUEST_CONFLICT');
  } finally { f.service.close(); }
});
test('AC-04/05/26: only matching scope success resolves failures; old revision failures do not poison current scope', async () => {
  let fail = true;
  const f = coverageFixture((name, args) => {
    if (name === 'search_decisions' && fail) { fail = false; throw new LawMcpError(504, 'MCP_TIMEOUT', 'synthetic timeout'); }
    return providerResponse(name, args);
  });
  try {
    let s = await f.run(await f.law(await f.start()));
    const failed = s.attempts.find(a => a.status === 'failed'); assert.ok(failed);
    s = await f.api('research_legal_sources', s, { issue_ids: ['case'], purpose: 'context', tool: 'search_tax_decisions', arguments: { type: 'court', query: '다른 범위', page: 1, limit: 20 } });
    assert.ok(s.coverage.incomplete_attempts.some(a => a.attempt_id === failed.attempt_id));
    s = await f.finish(s);
    assert.ok(s.coverage.resolved_attempts.some(a => a.attempt_id === failed.attempt_id));
    s = await f.api('update_legal_research', s, { plan: coveragePlan() });
    assert.ok(s.attempts.some(a => a.attempt_id === failed.attempt_id));
    assert.ok(s.evidence.some(e => e.revision === 1));
    s = await f.finish(await f.law(s));
    const r = await f.service.run('review_legal_reasoning', coverageActor, coverageReview(s));
    assert.equal(r.status, 'structurally_complete', JSON.stringify(r.findings)); assert.equal(r.question_scope_complete, true);
  } finally { f.service.close(); }
});
test('AC-08: conflicting type and issuer observations stay unresolved; mentioning Supreme Court in a body does not promote a ruling', () => {
  const doc = { ntstDcmId: '1', documentType: '질의회신', issuingAgency: '국세청', authorityLevel: 'nts_ruling', answer: '대법원 판결을 인용한다.' };
  assert.equal(observeIdentity('get_tax_document', {}, { structuredContent: { document: doc } }).kind, 'administrative_interpretation');
  assert.equal(observeIdentity('get_tax_document', {}, { structuredContent: { document: { ...doc, issuingAgency: '대법원' } } }).status, 'conflict');
  assert.equal(observeIdentity('get_decision_text', { id: '1', domain: 'precedent' }, { content: [{ type: 'text', text: '전문:\n대법원은 이렇게 말했다.' }] }).status, 'unknown');
});
test('AC-06/19/20: malformed counts, unsupported filters and fallback summaries never complete a search', () => {
  const args = { query: '소득세법 제1조', type: 'court', page: 1, limit: 20 };
  for (const change of [{ total: 1 }, { page: 2 }, { limit: 10 }]) assert.equal(observeSearch('search_tax_decisions', args, providerResponse('search_tax_decisions', args, change)).status, 'partial');
  assert.equal(observeSearch('search_tax_decisions', { ...args, court: '대법원' }, providerResponse('search_tax_decisions', args)).status, 'partial');
  assert.equal(observeSearch('search_decisions', { domain: 'precedent', query: '소득세법 제1조', display: 20, page: 1 }, { result: { content: [{ type: 'text', text: '판례 검색 결과 (총 0건, 1페이지):\n검색 보정: 다른 키워드' }] } }).status, 'partial');
  assert.equal(observeSearch('legal_research', {}, { result: { structuredContent: { total: 0, items: [] } } }).status, 'partial');
});
test('AC-03/20: only the pinned typed NTS search NOT_FOUND is accepted as an observed zero', () => {
  const response = { result: { isError: true, structuredContent: { ok: false, error: { code: 'NOT_FOUND', message: 'no rows' } } } };
  const args = { query: '소득세법 제1조', type: 'court', page: 1, limit: 20 };
  assert.equal(observeSearch('search_tax_decisions', args, response).status, 'complete');
  response.result.structuredContent.error.code = 'UPSTREAM_ERROR';
  assert.equal(observeSearch('search_tax_decisions', args, response).status, 'failed');
  assert.notEqual(observeSearch('lookup_tax_document', { document_number: 'missing' }, response).status, 'complete');
});
test('AC-15: a temporary two-home profile adds the missing acquisition chronology without inventing dates', async () => {
  const f = coverageFixture();
  try {
    const p = coveragePlan(); p.query = '다주택 처분 후 마지막 2주택의 일시적 2주택 비과세';
    p.event_dates.push({ role: 'new_home_acquired', value: '2026-02', precision: 'month', basis: 'provided', source: '사용자 진술' });
    const s = await f.start(p);
    assert.ok(s.plan.issues[0].required_fact_ids.includes('homes_before_new_acquisition'));
    assert.equal(s.plan.facts.find(f => f.id === 'homes_before_new_acquisition').status, 'unknown');
    assert.equal(s.plan.event_dates.find(d => d.role === 'new_home_acquired').value, '2026-02');
    assert.equal(s.plan.event_dates.find(d => d.role === 'new_home_acquired').precision, 'month');
  } finally { f.service.close(); }
});
test('AC-28: gap, changed-response and missing storage units invalidate a document manifest', () => {
  const raw = largeDocument();
  const e = { ...adaptResearchEvidence('get_tax_document', {}, raw), evidence_id: id(12), revision: 1, issue_ids: ['case'], purpose: 'support', tool: 'get_tax_document', arguments_hash: 'x', observed_at: 'now', expires_at: 'later' };
  const group = splitDocument(e, 131072);
  assert.equal(verifyManifest(group.manifest, group.evidence), true);
  assert.equal(verifyManifest(group.manifest, group.evidence.slice(1)), false);
  const other = structuredClone(group.evidence); other[1].response_hash = digest('different source bytes at the same date');
  assert.equal(verifyManifest(group.manifest, other), false);
  const gap = structuredClone(group.evidence); gap[1].passages[0].start++;
  assert.equal(verifyManifest(group.manifest, gap), false);
});
for (const boundary of ['body_bytes', 'manifest_commit', 'receive_limit']) test('AC-29: ' + boundary + ' failure leaves no partial commit or permanent busy', async () => {
  let calls = 0;
  const service = new ResearchService({ callTool: async () => { calls++; return largeDocument(); } }, undefined,
    boundary === 'body_bytes' ? { limits: { bodyBytes: 2000 } }
      : boundary === 'receive_limit' ? { limits: { transientBytes: 3000 } }
      : { beforeDocumentCommit: () => { throw new ServiceError(429, 'RESEARCH_MANIFEST_CAPACITY'); } });
  try {
    const s = await service.run('start_legal_research', actor, { plan: simplePlan() }), result = await service.run('research_legal_sources', actor, retrieve(s));
    assert.equal(result.attempts.at(-1).status, 'failed'); assert.equal(result.pending, false);
    assert.equal(result.evidence.length, 0); assert.equal(result.manifests.length, 0);
    const again = await service.run('research_legal_sources', actor, retrieve(s));
    assert.equal(again.job.status, 'failed'); assert.equal(calls, 1);
  } finally { service.close(); }
});

const courtRow = (key = '1') => ({ ntstDcmId: key, documentNumber: '합성-2025두1', documentType: '판례', issuingAgency: '대법원', authorityLevel: 'court_case', title: '합성 취득 판결' });
const observedCandidateAttempt = (n = 150, key = '1', revision = 1) => {
  const args = { query: '합성 취득', type: 'court', page: 1, limit: 20 };
  return { attempt_id: id(n), revision, issue_ids: ['case'], tool: 'search_tax_decisions', purpose: 'context', arguments_hash: digest(args), status: 'completed',
    search: observeSearch('search_tax_decisions', args, providerResponse('search_tax_decisions', args, { total: 1, items: [courtRow(key)] })) };
};
test('AC-11/12/21/22/23: candidate identity, duplicate discoveries and adverse history survive plan changes', () => {
  let ledger = addCandidates({ candidates: [], overflow: false }, observedCandidateAttempt());
  ledger = addCandidates(ledger, observedCandidateAttempt(151));
  assert.equal(ledger.candidates.length, 1); assert.equal(ledger.candidates[0].discovered_in.length, 2);
  const other = observedCandidateAttempt(152); other.search.hits[0].identity.namespace = 'other-official-source'; other.search.hits[0].key = 'other-official-source:tax_document:1';
  ledger = addCandidates(ledger, other); assert.equal(ledger.candidates.length, 2, 'same numeric ID alone must not merge sources');
  const plan = simplePlan(), renamed = structuredClone(plan); renamed.issues[0].id = 'renamed';
  const carried = carryCandidates(ledger, plan, renamed);
  assert.ok(carried.candidates.every(c => c.state === 'reassessment_required' && c.issue_ids.includes('renamed')));
  assert.deepEqual(carried.candidates[0].discovered_in, ledger.candidates[0].discovered_in);
  renamed.issues[0].question = '범위가 다른 새 질문';
  const changed = carryCandidates(ledger, plan, renamed);
  assert.ok(changed.candidates.every(c => c.state === 'out_of_current_scope'));
  const coverage = researchCoverage(plan, 1, [], [], ledger);
  assert.ok(candidateGaps(coverage, { issue_id: 'case', legal_basis: { authorities: [] } }).some(g => g.code === 'CANDIDATE_BODY_REQUIRED'));
  ledger.candidates[0].non_major = true;
  assert.ok(candidateGaps(researchCoverage(plan, 1, [], [], ledger), { issue_id: 'case' }).some(g => g.code === 'CANDIDATE_BODY_REQUIRED'));
});

test('AC-21: source document B cannot be committed as candidate A even if its text mentions A', async () => {
  const f = coverageFixture((name, args) => name.startsWith('search_tax_')
    ? providerResponse(name, args, { total: 1, items: [courtRow('candidate-a')] })
    : name === 'get_tax_document' ? { result: { structuredContent: { document: { ...courtRow('document-b'), answer: 'candidate-a를 인용하지만 별도 문서' } } } }
      : providerResponse(name, args));
  try {
    let s = await f.law(await f.start());
    s = await f.api('research_legal_sources', s, { issue_ids: ['case'], purpose: 'context', tool: 'search_tax_decisions',
      arguments: { type: 'court', query: '요건', law: '소득세법', article: '제1조', page: 1, limit: 20, sort: 'latest' } });
    const c = s.ledger.candidates[0]; assert.ok(c);
    s = await f.api('research_legal_sources', s, { request_id: id(180), candidate_id: c.candidate_id, issue_ids: ['case'], purpose: 'context',
      tool: 'get_tax_document', arguments: { ntst_dcm_id: 'candidate-a' } });
    assert.equal(s.job.status, 'failed'); assert.equal(s.attempts.at(-1).error_code, 'CANDIDATE_DOCUMENT_MISMATCH');
    assert.equal(s.evidence.filter(e => e.tool === 'get_tax_document').length, 0);
    assert.equal(s.ledger.candidates[0].key, c.key);
  } finally { f.service.close(); }
});

test('AC-28: ledger overflow is explicit and unknown candidates are retained for triage', () => {
  let ledger = addCandidates({ candidates: [], overflow: false }, observedCandidateAttempt(), 1);
  ledger = addCandidates(ledger, observedCandidateAttempt(151, 'second'), 1);
  assert.equal(ledger.candidates.length, 1); assert.equal(ledger.overflow, true);
  const unknown = observedCandidateAttempt(152); unknown.search.hits[0].identity.status = 'unknown';
  const retained = addCandidates({ candidates: [], overflow: false }, unknown);
  assert.equal(retained.candidates[0].state, 'triage_pending');
});

test('AC-29: 31 existing units plus a two-unit response fails without altering previous manifests', async () => {
  let calls = 0;
  const service = new ResearchService({ callTool: async () => {
    calls++; const response = largeDocument(); if (calls <= 31) response.result.structuredContent.document.answer = 'small'; return response;
  } });
  try {
    let s = await service.run('start_legal_research', actor, { plan: simplePlan() });
    for (let n = 0; n < 31; n++) s = await service.run('research_legal_sources', actor, retrieve(s, id(200 + n)));
    assert.equal(s.evidence.length, 31); const old = structuredClone({ evidence: s.evidence, manifests: s.manifests });
    const input = retrieve(s, id(250)); s = await service.run('research_legal_sources', actor, input);
    assert.equal(s.job.status, 'failed'); assert.equal(s.pending, false);
    assert.deepEqual({ evidence: s.evidence, manifests: s.manifests }, old);
    await service.run('research_legal_sources', actor, input); assert.equal(calls, 32);
  } finally { service.close(); }
});

test('AC-17/29: an in-flight replay yields pending without duplicate work and expiry cannot resurrect it', async () => {
  let now = 1000, calls = 0; const release = Promise.withResolvers(), entered = Promise.withResolvers();
  const service = new ResearchService({ callTool: async () => { calls++; entered.resolve(); await release.promise; return largeDocument(); } }, undefined,
    { now: () => now, limits: { ttlMs: 100, yieldMs: 5 } });
  try {
    const initial = await service.run('start_legal_research', actor, { plan: simplePlan() }), input = retrieve(initial);
    const running = service.run('research_legal_sources', actor, input); await entered.promise;
    const replay = await service.run('research_legal_sources', actor, input);
    assert.equal(replay.pending, true); assert.equal(replay.replayed, true); assert.equal(calls, 1);
    const yielded = await running; assert.equal(yielded.job.status, 'pending'); assert.equal(yielded.expires_at, initial.expires_at);
    await assert.rejects(service.run('update_legal_research', actor, { research_id: initial.research_id, expected_revision: 1, plan: simplePlan() }), e => e.code === 'RESEARCH_BUSY');
    now = 1101; release.resolve(); await new Promise(r => setTimeout(r, 10));
    await assert.rejects(service.run('get_legal_research', actor, { research_id: initial.research_id }), e => e.code === 'RESEARCH_NOT_FOUND');
    const replacement = await service.run('start_legal_research', actor, { plan: simplePlan() });
    assert.notEqual(replacement.research_id, initial.research_id); assert.equal(replacement.pending, false); assert.equal(replacement.evidence.length, 0);
  } finally { release.resolve(); service.close(); }
});

test('AC-27/28: partial replies sharing an ID and date never merge into a complete snapshot', () => {
  const raw = largeDocument(), make = n => ({ ...adaptResearchEvidence('get_tax_document', { detail: 'compact' }, raw), evidence_id: id(n), revision: 1,
    issue_ids: ['case'], purpose: 'support', tool: 'get_tax_document', arguments_hash: 'x', observed_at: 'now', expires_at: 'later' });
  const first = make(270); raw.result.structuredContent.document.answer = 'b'.repeat(200000); const second = make(271);
  assert.notEqual(first.response_hash, second.response_hash);
  const one = splitDocument(first, 131072), two = splitDocument(second, 131072);
  assert.equal(one.manifest.complete, false); assert.equal(two.manifest.complete, false);
  assert.equal(verifyManifest(one.manifest, [one.evidence[0], two.evidence[1]]), false);
});

test('AC-20: the pinned provider normal next-tool hint is not a truncation marker', () => {
  const result = { result: { content: [{ type: 'text', text: '판례 검색 결과 (총 1건, 1페이지):\n[1] 합성\n  사건번호: 2025두1\n  법원: 대법원\n  선고일: 20250101\n\n💡 다음: get_precedent_text(id="1") 로 판결문 전문. full=true 로 축약 해제.' }] } };
  assert.equal(observeSearch('search_decisions', { domain: 'precedent', query: '합성', page: 1, display: 20, options: { court: '대법원', search: 2 } }, result).status, 'complete');
});

test('AC-15/18: ordinary one-to-two-home facts do not invent an intermediate disposal or unrelated tax issue', () => {
  const plan = simplePlan(); plan.query = '일시적 2주택 검토'; plan.issues[0].profile = 'temporary_two_homes';
  plan.facts = [{ id: 'homes_before_new_acquisition', description: '신규 취득 직전 주택 수', status: 'provided', value: '1주택', source: '별도 합성 정상 사례' }];
  plan.issues.push({ id: 'vat', question: '별도 용역의 부가가치세', required_fact_ids: [], required_date_roles: [] });
  const applied = applyResearchProfiles(plan);
  assert.ok(applied.issues[0].required_date_roles.includes('new_home_acquired'));
  assert.ok(!applied.issues[0].required_date_roles.includes('other_homes_disposed'));
  assert.equal(applied.issues[1].profile, undefined);
  assert.deepEqual(applied.issues[1].required_date_roles, []);
});

test('AC-15 regression from live model: negated other-home wording must not create a disposal event', () => {
  const plan = simplePlan(); plan.query = '다른 주택 없이 계속 1주택을 보유하다 신규 주택을 취득한 일시적 2주택';
  plan.issues[0].profile = 'temporary_two_homes';
  plan.facts = [{ id: 'homes_before_new_acquisition', description: '신규 취득 직전 주택 수', status: 'provided',
    value: '정확히 1주택', source: '사용자의 명시적 진술' }];
  const result = applyResearchProfiles(plan);
  assert.ok(!result.issues[0].required_date_roles.includes('other_homes_disposed'));
  assert.ok(!result.event_dates.some(d => d.role === 'other_homes_disposed'));
});

test('AC-27: complete replacement closes the body gap but an old partial citation still fails', async () => {
  let first = true;
  const f = coverageFixture((name, args) => {
    const response = providerResponse(name, args);
    if (name === 'get_law_text' && first) { first = false; response.result.content[0].text += '\n응답 크기 제한'; }
    return response;
  });
  try {
    let s = await f.law(await f.start()); const partial = s.evidence[0]; assert.equal(partial.body_scope, 'partial');
    s = await f.finish(await f.law(s));
    const input = coverageReview(s), full = s.evidence.find(e => e.body_scope === 'body_returned');
    input.analysis[0].claims[0].citations = [cite(full)];
    input.analysis[0].legal_basis.statutes[0].citation = cite(full);
    input.analysis[0].legal_basis.temporal_application.citations = input.analysis[0].legal_basis.statutes.map(s => s.citation);
    input.scope_assessments[0].evidence_ids = [full.evidence_id];
    const reviewed = await f.service.run('review_legal_reasoning', coverageActor, input);
    assert.equal(reviewed.status, 'structurally_complete', JSON.stringify(reviewed.findings));
    input.analysis[0].claims[0].citations = [cite(partial)];
    const stale = await f.service.run('review_legal_reasoning', coverageActor, input);
    assert.equal(stale.status, 'blocked'); assert.ok(codes(stale).includes('PARTIAL_BODY'));
  } finally { f.service.close(); }
});

test('AC-10/11/13/14/25: real subsequent candidates require bodies and review; proved zero needs no fabricated citation', async () => {
  const row = n => ({ ...courtRow(String(n)), documentNumber: `CASE-${n}` });
  const f = coverageFixture((name, args) => {
    if (name === 'get_tax_document') return { result: { structuredContent: { document: { ...row(args.ntst_dcm_id), productionDate: '20260901',
      answer: '합성 구법 적용과 소송 경과를 설명한다.' } } } };
    if (name === 'search_tax_decisions' && args.type === 'court' && args.query === '요건') return providerResponse(name, args, { total: 1, items: [row(1)] });
    if (name === 'search_tax_decisions' && args.query === 'CASE-1 변경') return providerResponse(name, args, { total: 1, items: [row(2)] });
    return providerResponse(name, args);
  });
  try {
    let s = await f.finish(await f.law(await f.start()));
    const input = coverageReview(s), a = input.analysis[0], law = s.evidence.find(e => e.tool === 'get_law_text');
    const bodies = s.evidence.filter(e => e.tool === 'get_tax_document'); assert.equal(bodies.length, 2);
    const omitted = await f.service.run('review_legal_reasoning', coverageActor, input);
    assert.equal(omitted.status, 'blocked'); assert.ok(codes(omitted).includes('CANDIDATE_REVIEW_REQUIRED'));
    a.legal_basis.authorities = bodies.map(e => ({ evidence_id: e.evidence_id, kind: 'supreme_court', disposition: 'distinguished',
      statute_evidence_ids: [law.evidence_id], law_version_relation: 'different_rule', reason: '합성 개정 규정과 구법의 요건 차이',
      subsequent_review: { status: 'addressed', reason: '실제 후속 검색 범위와 후보 대조',
        search_attempt_ids: s.coverage.obligations.filter(o => o.purpose === 'subsequent' && o.document_key.endsWith(':' + e.document_id)).flatMap(o => o.attempt_ids), citations: [] } }));
    let r = await f.service.run('review_legal_reasoning', coverageActor, input);
    assert.ok(codes(r).includes('SUBSEQUENT_SOURCE_REQUIRED'));
    a.legal_basis.authorities[0].subsequent_review.citations = [cite(bodies[0]), cite(bodies[1])];
    r = await f.service.run('review_legal_reasoning', coverageActor, input);
    assert.equal(r.status, 'structurally_complete', JSON.stringify(r.findings));
    assert.deepEqual(a.legal_basis.authorities[1].subsequent_review.citations, [], 'true subsequent zero needs no invented source');
    a.legal_basis.authorities[0].disposition = 'applied'; a.claims[0].citations = [cite(bodies[0])];
    r = await f.service.run('review_legal_reasoning', coverageActor, input);
    assert.ok(codes(r).includes('AUTHORITY_LAW_CONTRADICTION'), 'Supreme Court cannot override a different applicable statute by rank alone');
  } finally { f.service.close(); }
});

test('AC-19/20: relabelling a neutral query as counter does not meet the opposite-hypothesis recipe', async () => {
  const f = coverageFixture();
  try {
    let s = await f.law(await f.start());
    const step = s.coverage.obligations.find(o => o.purpose === 'neutral').next_step;
    s = await f.api('research_legal_sources', s, { tool: step.tool, arguments: step.arguments, issue_ids: ['case'], purpose: 'counter' });
    assert.equal(s.coverage.obligations.find(o => o.purpose === 'counter').status, 'not_attempted');
    const missing = coverageFixture();
    try {
      const unanchored = await missing.run(await missing.start());
      assert.ok(unanchored.coverage.preparation_gaps.some(g => g.code === 'ANCHOR_PENDING'));
      assert.equal(unanchored.coverage.obligations.length, 0);
      assert.equal(unanchored.last_review, null);
    } finally { missing.service.close(); }
  } finally { f.service.close(); }
});
