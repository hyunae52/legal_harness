import type { ReviewInput, Plan, IssueAnalysisInput } from './researchContracts.js';
import type { ResearchEvidence } from './researchEvidence.js';
import type { Requirement } from './researchRequirements.js';
import type { TestExpression, CheckTargetInput } from './reasoningContracts.js';

export type Truth = 'satisfied' | 'not_satisfied' | 'unknown';
type Finding = (code: string, detail: string, target?: CheckTargetInput) => void;
export function evaluateTests(expression: TestExpression, values: Map<string, Truth>): Truth {
  if ('test_id' in expression) return values.get(expression.test_id) ?? 'unknown';
  if ('not' in expression) { const v = evaluateTests(expression.not, values); return v === 'unknown' ? v : v === 'satisfied' ? 'not_satisfied' : 'satisfied'; }
  const all = 'all' in expression, children = all ? expression.all : expression.any;
  const results = children.map(child => evaluateTests(child, values));
  if (results.includes(all ? 'not_satisfied' : 'satisfied')) return all ? 'not_satisfied' : 'satisfied';
  return results.includes('unknown') ? 'unknown' : all ? 'satisfied' : 'not_satisfied';
}
function expressionRefs(expression: TestExpression, refs: string[], depth = 0): number {
  if (depth > 4) return 65;
  if ('test_id' in expression) { refs.push(expression.test_id); return 1; }
  return 1 + ('not' in expression ? expressionRefs(expression.not, refs, depth + 1)
    : ('all' in expression ? expression.all : expression.any).reduce((n, c) => n + expressionRefs(c, refs, depth + 1), 0));
}
export const renderAnswer = (blocks: NonNullable<ReviewInput['answer_blocks']>) => blocks.map(b => b.text).join('\n\n');
export const newDateRoles = (a: IssueAnalysisInput) => [...(a.legal_tests ?? []).flatMap(t => t.date_roles),
  ...a.claims.flatMap(c => (c.application ?? []).flatMap(t => t.date_roles))];

/** Structural proof obligations only. Propositions, relevance and application reasons need model/human scrutiny. */
export function inspectApplication(a: IssueAnalysisInput, plan: Plan, evidence: ResearchEvidence[], requirements: Requirement[], block: Finding, gap: Finding) {
  const tests = a.legal_tests ?? [], excluded = a.excluded_tests ?? [], allRefs = new Set<string>();
  const testIds = new Set(tests.map(t => t.id));
  if (testIds.size !== tests.length) block('DUPLICATE_TEST', a.issue_id);
  if (new Set(excluded.map(e => e.test_id)).size !== excluded.length) block('DUPLICATE_EXCLUDED_TEST', a.issue_id);
  for (const e of excluded) if (!testIds.has(e.test_id)) block('TEST_REFERENCE_INVALID', e.test_id);
  for (const t of tests) {
    let linkedLaw = false;
    for (const c of t.citations) {
      const e = evidence.find(e => e.evidence_id === c.evidence_id), p = e?.passages.find(p => p.passage_id === c.passage_id);
      if (e?.tool !== 'get_law_text' && e?.tool !== 'check_legal_sources') {
        // A decision's issue date is not the version of the statute it interprets.
        const authority = a.legal_basis?.authorities.find(a => a.evidence_id === c.evidence_id);
        if (authority?.statute_evidence_ids.some(id => a.legal_basis?.statutes.some(s => s.citation.evidence_id === id && s.version === t.version))) linkedLaw = true;
        continue;
      }
      linkedLaw = true;
      const version = e?.units.find(u => u.unit_id === p?.unit_id)?.document_version;
      if (!version || version === 'unknown') gap('ELEMENT_VERSION_UNVERIFIED', t.id, { kind: 'test', id: t.id, issue_id: a.issue_id });
      else if (version !== t.version) block('ELEMENT_VERSION_MISMATCH', t.id, { kind: 'test', id: t.id, issue_id: a.issue_id });
    }
    if (!linkedLaw) gap('ELEMENT_VERSION_UNVERIFIED', t.id, { kind: 'test', id: t.id, issue_id: a.issue_id });
  }
  const usedFacts = new Set<string>();
  for (const claim of a.claims) {
    if (!claim.test_expression || !claim.application) { block('ELEMENT_APPLICATION_REQUIRED', claim.id, { kind: 'claim', id: claim.id }); continue; }
    const refs: string[] = [], nodes = expressionRefs(claim.test_expression, refs), values = new Map<string, Truth>();
    if (nodes > 64) block('EXPRESSION_TOO_LARGE', claim.id, { kind: 'claim', id: claim.id });
    if (new Set(refs).size !== refs.length) block('DUPLICATE_TEST_REFERENCE', claim.id);
    if (new Set(claim.application.map(p => p.test_id)).size !== claim.application.length) block('DUPLICATE_APPLICATION', claim.id);
    for (const ref of refs) {
      allRefs.add(ref);
      if (!testIds.has(ref)) block('TEST_REFERENCE_INVALID', ref);
      if (excluded.some(e => e.test_id === ref)) block('EXCLUDED_TEST_USED', ref, { kind: 'test', id: ref, issue_id: a.issue_id });
      if (!claim.application.some(p => p.test_id === ref)) block('ELEMENT_APPLICATION_REQUIRED', ref, { kind: 'test', id: ref, issue_id: a.issue_id });
    }
    for (const p of claim.application) {
      if (!refs.includes(p.test_id) || !testIds.has(p.test_id)) block('APPLICATION_REFERENCE_INVALID', p.test_id);
      if (new Set(p.fact_ids).size !== p.fact_ids.length) block('DUPLICATE_FACT_REFERENCE', p.test_id);
      if (!p.fact_ids.length && !p.pure_law_reason) block('ELEMENT_FACT_REQUIRED', p.test_id, { kind: 'test', id: p.test_id, issue_id: a.issue_id });
      if (p.pure_law_reason && p.fact_ids.length) block('PURE_LAW_FACT_CONTRADICTION', p.test_id, { kind: 'test', id: p.test_id, issue_id: a.issue_id });
      let unconfirmed = false;
      for (const id of p.fact_ids) {
        usedFacts.add(id);
        const fact = plan.facts.find(f => f.id === id);
        if (!fact) block('FACT_NOT_FOUND', id);
        if (fact?.status !== 'provided') unconfirmed = true;
      }
      for (const role of p.date_roles) {
        const date = plan.event_dates.find(d => d.role === role);
        if (!date) block('DATE_ROLE_NOT_FOUND', role);
        if (date?.basis !== 'provided' || date.precision !== 'day') unconfirmed = true;
      }
      if (unconfirmed && p.finding !== 'unknown') block('UNCONFIRMED_ELEMENT_DECIDED', p.test_id, { kind: 'test', id: p.test_id, issue_id: a.issue_id });
      values.set(p.test_id, unconfirmed ? 'unknown' : p.finding);
    }
    const calculated = evaluateTests(claim.test_expression, values);
    if (calculated !== claim.test_result) block('TEST_RESULT_MISMATCH', claim.id + ': ' + calculated, { kind: 'claim', id: claim.id });
    if (calculated === 'unknown' && a.conclusion_mode === 'definitive') block('UNKNOWN_ELEMENT_DEFINITIVE', claim.id, { kind: 'claim', id: claim.id });
  }
  for (const test of tests) if (!allRefs.has(test.id) && !excluded.some(e => e.test_id === test.id)) block('TEST_NOT_ADDRESSED', test.id, { kind: 'test', id: test.id, issue_id: a.issue_id });
  for (const r of requirements.filter(r => r.issue_id === a.issue_id && r.scope_status === 'current' && r.status === 'required' && r.target.kind === 'fact')) {
    if (!usedFacts.has(r.target.id) && a.conclusion_mode !== 'withheld') block('ELEMENT_REQUIRED_FACT_UNUSED', r.target.id, { kind: 'fact', id: r.target.id });
  }
  const dates = new Set([...newDateRoles(a), ...a.timing.date_roles]);
  for (const c of a.claims) for (const id of c.fact_ids) usedFacts.add(id);
  for (const r of requirements.filter(r => (r.assessment_issue_id ?? r.issue_id) === a.issue_id && r.status === 'not_required_for_question')) {
    if (r.target.kind === 'fact' ? usedFacts.has(r.target.id) : dates.has(r.target.id)) block('ELEMENT_EXCLUDED_REQUIREMENT_USED', r.requirement_id, { kind: 'requirement', id: r.requirement_id });
  }
}

export function inspectAnswer(input: ReviewInput, block: Finding) {
  const blocks = input.answer_blocks ?? [];
  if (renderAnswer(blocks) !== input.draft_answer) block('ANSWER_RENDER_MISMATCH', '답변은 저장된 블록 전체를 순서대로 두 줄바꿈으로 연결한 내용이어야 합니다.');
  if (new Set(blocks.map(b => b.id)).size !== blocks.length) block('DUPLICATE_ANSWER_BLOCK', 'block id');
  for (const b of blocks) {
    const a = input.analysis.find(a => a.issue_id === b.issue_id);
    if (!a) { block('ANSWER_ISSUE_NOT_FOUND', b.id); continue; }
    if (b.claim_ids.some(id => !a.claims.some(c => c.id === id)) || b.test_ids.some(id => !a.legal_tests?.some(t => t.id === id))) block('ANSWER_REFERENCE_INVALID', b.id);
    if (b.kind === 'claim' && !b.claim_ids.length) block('ANSWER_CLAIM_REQUIRED', b.id, { kind: 'block', id: b.id });
    if (b.kind === 'source_quote' && (!b.citations.length || b.citations.some(c => !b.text.includes(c.quote)))) block('ANSWER_QUOTE_REQUIRED', b.id, { kind: 'block', id: b.id });
  }
  for (const a of input.analysis) for (const c of a.claims) {
    if (!blocks.some(b => b.issue_id === a.issue_id && b.kind === 'claim' && b.claim_ids.includes(c.id) && b.text.includes(c.text))) block('CLAIM_BLOCK_REQUIRED', c.id, { kind: 'claim', id: c.id });
  }
}
