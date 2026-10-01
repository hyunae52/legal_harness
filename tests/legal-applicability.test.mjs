import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptResearchEvidence } from '../dist/researchEvidence.js';
import { inspectResearch } from '../dist/researchReview.js';
import { researchSchemas, researchTools } from '../dist/researchContracts.js';

import { genericSearchAttempts } from './fixtures/generic-searches.mjs';

const lid = '00000000-0000-4000-8000-000000000001';
const aid = '00000000-0000-4000-8000-000000000002';
const cid = '00000000-0000-4000-8000-000000000003';
const lawText = '합성법의 공동취득 요건. 부칙: 이 규정은 2020년 이후 양도분부터 적용한다.';
const caseText = '합성 판결은 2020년 규정과 공동취득 사실에 관하여 판단한다.';
const citation = (evidence_id, quote) => ({ evidence_id, passage_id: 'p1', quote, relation: 'direct', reason: '합성 원문과 적용 이유' });
const receipt = (evidence_id, tool, body, purpose, args = {}) => {
  if (body.structuredContent?.document) Object.assign(body.structuredContent.document, { documentType: '질의회신', issuingAgency: '국세청', documentNumber: body.structuredContent.document.ntstDcmId });
  return ({
  ...adaptResearchEvidence(tool, args, { server: { name: 'fixture', version: '1' }, result: body }),
  evidence_id, revision: 1, issue_ids: ['cost'], purpose, tool, arguments_hash: 'fixture',
  observed_at: '2026-09-28T00:00:00Z', expires_at: '2026-09-28T00:30:00Z',
}); };
function scenario() {
  const evidence = [
    receipt(lid, 'get_law_text', { content: [{ type: 'text', text: '법령명: 합성법\n시행일: 20200101\n제1조(공동취득)\n' + lawText }] }, 'timing', { mst: '100' }),
    receipt(aid, 'get_tax_document', { structuredContent: { document: { ntstDcmId: 'case-1', productionDate: '20260901', answer: caseText } } }, 'support'),
    receipt(cid, 'get_tax_document', { structuredContent: { document: { ntstDcmId: 'case-2', productionDate: '20260902', answer: '합성 반론은 단독취득의 경우에 관한 해석이다.' } } }, 'counter'),
  ];
  const plan = { query: '합성 원가', issues: [{ id: 'cost', question: '합성 원가', required_fact_ids: ['joint'], required_date_roles: ['transfer'] }],
    facts: [{ id: 'joint', description: '공동취득', status: 'provided', value: '공동', source: '합성 진술' }],
    event_dates: [{ role: 'transfer', value: '2020-06-01', precision: 'day', basis: 'provided', source: '합성 진술' }] };
  const authority = (id, disposition) => ({ evidence_id: id, kind: 'administrative_interpretation', disposition,
    statute_evidence_ids: [lid], law_version_relation: 'same_rule', reason: '같은 2020년 규정의 적용 요건을 대조했다.',
    subsequent_review: { status: 'addressed', reason: '합성 자료의 변경 및 적용 범위를 검토했다.', citations: [citation(id, evidence.find(e => e.evidence_id === id).passages[0].text)] } });
  const input = { research_id: '00000000-0000-4000-8000-000000000004', expected_revision: 1, expected_state_version: 7,
    draft_answer: '합성 공동취득 요건을 적용한다.', correction_needed: false, analysis: [{ issue_id: 'cost', conclusion_mode: 'definitive', withholding_reason: '',
      claims: [{ id: 'claim', text: '합성 공동취득 요건을 적용한다.', requirements: ['공동취득'], fact_ids: ['joint'], citations: [citation(aid, caseText)] }],
      counter_evidence: [{ evidence_id: cid, disposition: 'irrelevant', reason: '단독취득이라는 사실 차이를 확인했다.' }],
      unknowns: [], next_queries: [], timing: { status: 'addressed', reason: '양도일과 부칙 대조', date_roles: ['transfer'] },
      exceptions: { status: 'addressed', reason: '합성 예외 검토' }, legal_basis: {
        statutes: [{ citation: citation(lid, lawText), version: '20200101', date_roles: ['transfer'], reason: '2020년 양도와 적용례가 일치한다.' }],
        temporal_application: { status: 'addressed', reason: '시행일과 적용례를 함께 대조했다.', citations: [citation(lid, lawText)] },
        authorities: [authority(aid, 'applied'), authority(cid, 'distinguished')],
      },
    }] };
  return { input, plan, evidence, searches: true, run() {
    const attempts = this.attempts ??= this.searches ? genericSearchAttempts(['case-1', 'case-2', 'case-3']) : [];
    for (const a of this.input.analysis[0].legal_basis?.authorities ?? []) {
      if (a.subsequent_review.search_attempt_ids !== undefined) continue;
      const number = this.evidence.find(e => e.evidence_id === a.evidence_id)?.identity?.document_number;
      a.subsequent_review.search_attempt_ids = attempts.filter(t => t.search.query === number || t.search.query === number + ' 변경').map(t => t.attempt_id);
    }
    this.attempts ??= attempts;
    return inspectResearch(this.input, this.plan, this.evidence, this.searches ? this.attempts : []);
  } };
}
const codes = r => r.findings.map(f => f.code);
function incomplete(s) {
  Object.assign(s.input.analysis[0], { conclusion_mode: 'conditional', unknowns: ['합성 적용관계 미확인'], next_queries: ['추가 원문과 적용 관계 확인'] });
}

test('AP-01: statutes and administrative interpretations alone cannot establish search coverage', () => {
  const s = scenario(); s.searches = false; const r = s.run();
  assert.equal(r.status, 'blocked');
  assert.ok(codes(r).includes('REQUIRED_SEARCH_INCOMPLETE'));
  assert.equal(r.legal_verification, 'unverified');
  assert.equal(researchSchemas.review_legal_reasoning.safeParse(s.input).success, true);
});
test('AP-02: legacy missing legal basis is a gap; a definitive answer is blocked', () => {
  const s = scenario(); delete s.input.analysis[0].legal_basis;
  assert.ok(codes(s.run()).includes('LEGAL_BASIS_REQUIRED'));
  assert.equal(s.run().status, 'blocked');
  incomplete(s); assert.equal(s.run().status, 'needs_info');
});
for (const [name, mutate, code] of [
  ['missing statute', a => { a.legal_basis.statutes = []; }, 'STATUTE_BASIS_REQUIRED'],
  ['forged version', a => { a.legal_basis.statutes[0].version = '20250101'; }, 'LAW_VERSION_MISMATCH'],
  ['forged law quote', a => { a.legal_basis.statutes[0].citation.quote = '존재하지 않는 조문'; }, 'QUOTE_MISMATCH'],
  ['tax document as statute', a => { a.legal_basis.statutes[0].citation = citation(aid, caseText); }, 'STATUTE_SOURCE_REQUIRED'],
  ['missing date link', a => { a.legal_basis.statutes[0].date_roles = []; }, 'LAW_DATE_ROLE_REQUIRED'],
  ['unknown date role', a => { a.legal_basis.statutes[0].date_roles = ['contract']; }, 'DATE_ROLE_NOT_FOUND'],
  ['missing transition evidence', a => { a.legal_basis.temporal_application.citations = []; }, 'TEMPORAL_SOURCE_REQUIRED'],
  ['unresolved transition', a => { a.legal_basis.temporal_application.status = 'unresolved'; }, 'TEMPORAL_APPLICATION_UNRESOLVED'],
  ['omitted authority', a => { a.legal_basis.authorities.shift(); }, 'AUTHORITY_REVIEW_REQUIRED'],
  ['unverified law relationship', a => { a.legal_basis.authorities[0].law_version_relation = 'unverified'; }, 'AUTHORITY_LAW_UNRESOLVED'],
  ['different rule as direct support', a => { a.legal_basis.authorities[0].law_version_relation = 'different_rule'; }, 'AUTHORITY_LAW_CONTRADICTION'],
  ['dismissed source as direct support', a => { a.legal_basis.authorities[0].disposition = 'distinguished'; }, 'AUTHORITY_DISPOSITION_CONTRADICTION'],
  ['unresolved subsequent ruling', a => { a.legal_basis.authorities[0].subsequent_review.status = 'unresolved'; }, 'SUBSEQUENT_TREATMENT_UNRESOLVED'],
  ['missing subsequent search', a => { a.legal_basis.authorities[0].subsequent_review.search_attempt_ids = []; }, 'SUBSEQUENT_SEARCH_REQUIRED'],
  ['duplicate authority', a => { a.legal_basis.authorities.push(structuredClone(a.legal_basis.authorities[0])); }, 'DUPLICATE_AUTHORITY'],
  ['unknown law reference', a => { a.legal_basis.authorities[0].statute_evidence_ids = [cid]; }, 'AUTHORITY_STATUTE_REFERENCE'],
  ['resolved counter without evidence', a => { a.counter_evidence[0].disposition = 'resolved'; }, 'COUNTER_RESOLUTION_SOURCE_REQUIRED'],
  ['forged counter resolution', a => { a.counter_evidence[0].disposition = 'resolved'; a.counter_evidence[0].resolution_citations = [citation(lid, '없는 근거')]; }, 'QUOTE_MISMATCH'],
]) test('AP-negative: ' + name, () => {
  const s = scenario(); mutate(s.input.analysis[0]);
  const r = s.run(); assert.ok(codes(r).includes(code), JSON.stringify(r)); assert.equal(r.status, 'blocked');
});
test('AP-03: partial temporal evidence cannot close a conditional review', () => {
  const s = scenario(); s.evidence[0].passages[0].body_scope = 'partial'; s.evidence[0].units[0].body_scope = 'partial';
  incomplete(s); assert.equal(s.run().status, 'needs_info');
});
test('AP-04: unchanged relevant provision across amendments is expressly explainable', () => {
  const s = scenario(); s.input.analysis[0].legal_basis.authorities[0].law_version_relation = 'unchanged_relevant_rule';
  assert.equal(s.run().status, 'structurally_complete');
});
test('AP-05: real provider colon sections and exact HTML text remain usable without rewriting quotes', () => {
  const text = '=== 합성 판결 ===\n기본 정보:\n  선고일: 20260901\n\n판시사항:\n[1] 구법 적용<br/>\n\n참조조문:\n2020년 규정<br/>\n\n전문:\n【이    유】 공동취득 판단<br/>그대로 보존';
  const e = adaptResearchEvidence('get_decision_text', { domain: 'precedent', id: '1', full: true }, { result: { content: [{ type: 'text', text }] } });
  assert.equal(e.body_scope, 'body_returned');
  assert.ok(e.passages.some(p => p.text.includes('【이    유】 공동취득 판단<br/>그대로 보존')));
  const partial = adaptResearchEvidence('get_decision_text', { domain: 'precedent', id: '1', full: false }, { result: { content: [{ type: 'text', text }] } });
  assert.equal(partial.body_scope, 'partial');
});
test('AP-06: MCP contract teaches applicability, subsequent rulings and explicit uncertainty', () => {
  const t = researchTools.find(t => t.name === 'review_legal_reasoning');
  assert.ok(t.inputSchema.properties.analysis.items.properties.legal_basis);
  assert.match(t.description, /사건 이후/);
  assert.match(t.description, /경과조치/);
});

for (const location of ['temporal', 'counter_resolution', 'subsequent']) test('AP-07: ancillary ' + location + ' authorities need applicability review', () => {
  const s = scenario(), id = '00000000-0000-4000-8000-000000000005';
  const body = '새 합성 해석의 적용 관계도 확인해야 한다.';
  s.evidence.push(receipt(id, 'get_tax_document', { structuredContent: { document: { ntstDcmId: 'case-3', productionDate: '20260903', answer: body } } }, 'context'));
  const a = s.input.analysis[0], ref = citation(id, body);
  if (location === 'temporal') a.legal_basis.temporal_application.citations.push(ref);
  if (location === 'counter_resolution') Object.assign(a.counter_evidence[0], { disposition: 'resolved', resolution_citations: [ref] });
  if (location === 'subsequent') a.legal_basis.authorities[0].subsequent_review.citations.push(ref);
  assert.ok(codes(s.run()).includes('AUTHORITY_REVIEW_REQUIRED'));
  assert.equal(s.run().status, 'blocked');
  a.legal_basis.authorities.push({ ...structuredClone(a.legal_basis.authorities[0]), evidence_id: id,
    subsequent_review: { status: 'addressed', reason: '새 해석의 후속 처리 확인 범위를 기록했다.', citations: [ref] } });
  assert.equal(s.run().status, 'structurally_complete');
});

test('AP-08: an ancillary statute also needs version and date review', () => {
  const s = scenario(), id = '00000000-0000-4000-8000-000000000005';
  s.evidence.push(receipt(id, 'get_law_text', { content: [{ type: 'text', text: '법령명: 추가 합성법\n시행일: 20200101\n제1조(적용)\n' + lawText }] }, 'context', { mst: '101' }));
  s.input.analysis[0].legal_basis.temporal_application.citations.push(citation(id, lawText));
  assert.ok(codes(s.run()).includes('STATUTE_REVIEW_REQUIRED'));
  assert.equal(s.run().status, 'blocked');
});

test('AP-09: a date used by the analysis needs a law link even if omitted from required roles', () => {
  const s = scenario();
  s.plan.issues[0].required_date_roles = [];
  s.input.analysis[0].legal_basis.statutes[0].date_roles = [];
  assert.ok(codes(s.run()).includes('LAW_DATE_ROLE_REQUIRED'));
  assert.equal(s.run().status, 'blocked');
});

test('AP-10: a non-required date used by the analysis cannot hide its uncertainty', () => {
  const s = scenario();
  s.plan.issues[0].required_date_roles = [];
  s.plan.event_dates[0].basis = 'assumed';
  assert.ok(codes(s.run()).includes('DATE_UNCONFIRMED'));
  assert.equal(s.run().status, 'blocked');
});

test('AP-11: a statute date link must also be addressed in timing review', () => {
  const s = scenario();
  s.plan.issues[0].required_date_roles = [];
  s.input.analysis[0].timing.date_roles = [];
  assert.ok(codes(s.run()).includes('DATE_ROLE_NOT_ADDRESSED'));
  assert.equal(s.run().status, 'blocked');
});

test('AP-12: spaced judgment headings preserve reasons and the order', () => {
  const text = '=== 합성 판결 ===\n전문:\n【주    문】\n원심판결을 파기한다.\n【이    유】\n관련 조문의 적용 관계를 설명한다.';
  const e = adaptResearchEvidence('get_decision_text', { domain: 'precedent', id: '1', full: true }, { result: { content: [{ type: 'text', text }] } });
  assert.equal(e.body_scope, 'body_returned');
  assert.ok(e.passages.some(p => p.text.includes('원심판결을 파기한다.')));
  assert.ok(e.passages.some(p => p.text.includes('관련 조문의 적용 관계를 설명한다.')));
});

test('AP-13: a used date cannot be marked timing not required', () => {
  const s = scenario(); s.plan.issues[0].required_date_roles = [];
  s.input.analysis[0].timing.status = 'not_required';
  assert.ok(codes(s.run()).includes('TIMING_REVIEW_REQUIRED'));
  assert.equal(s.run().status, 'blocked');
});

test('AP-14: an unrelated unknown date is not silently made a required condition', () => {
  const s = scenario();
  s.plan.event_dates.push({ role: 'unrelated', value: null, precision: 'unknown', basis: 'unknown', source: '' });
  assert.equal(s.run().status, 'structurally_complete');
});
