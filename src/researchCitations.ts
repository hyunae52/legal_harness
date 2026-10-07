import type { CitationInput, IssueAnalysisInput, ReviewInput } from './researchContracts.js';
import type { AnswerBlockInput } from './reasoningContracts.js';

/** Current conclusions include timing and counter resolution, regardless of citation placement.
 * Subsequent-treatment citations alone document case history; adopting that authority as a
 * current ground is expressed here or by applied/analogy, and opens its own follow-up work. */
export function substantiveCitations(analysis: IssueAnalysisInput, blocks: AnswerBlockInput[] = []): CitationInput[] {
  return [...analysis.claims.flatMap(c => c.citations),
    ...(analysis.legal_basis?.temporal_application.citations ?? []),
    ...analysis.counter_evidence.flatMap(c => c.resolution_citations ?? []), ...reasoningCitations(analysis, blocks)];
}

/** Every new source-bearing location traverses the same citation, applicability and adoption checks. */
export function reasoningCitations(analysis: IssueAnalysisInput, blocks: AnswerBlockInput[] = []): CitationInput[] {
  return [...(analysis.legal_tests ?? []).flatMap(t => t.citations),
    ...analysis.claims.flatMap(c => (c.application ?? []).flatMap(a => a.citations)),
    ...(analysis.excluded_tests ?? []).flatMap(t => t.citations),
    ...(analysis.authority_conflicts ?? []).flatMap(c => [...c.left.citations, ...c.right.citations, ...c.resolution_citations]),
    ...blocks.filter(b => b.issue_id === analysis.issue_id).flatMap(b => b.citations)];
}

/** Computed from the canonical contract, never accepted as a client-authored usage manifest. */
export function referenceUsage(input: ReviewInput) {
  const uses: { path: string; issue_id: string; kind: 'evidence' | 'fact' | 'date'; id: string; passage_id?: string; role: string }[] = [];
  const cites = (path: string, issue: string, items: CitationInput[], role?: string) => items.forEach((c, n) => uses.push({
    path: `${path}[${n}]`, issue_id: issue, kind: 'evidence', id: c.evidence_id, passage_id: c.passage_id, role: role ?? c.relation }));
  const refs = (path: string, issue: string, kind: 'fact' | 'date', ids: string[]) => ids.forEach((id, n) => uses.push({
    path: `${path}[${n}]`, issue_id: issue, kind, id, role: 'application' }));
  input.analysis.forEach((a, i) => {
    const root = `analysis[${i}]`, issue = a.issue_id;
    a.claims.forEach((c, n) => {
      cites(`${root}.claims[${n}].citations`, issue, c.citations); refs(`${root}.claims[${n}].fact_ids`, issue, 'fact', c.fact_ids);
      c.application?.forEach((p, m) => { const path = `${root}.claims[${n}].application[${m}]`;
        cites(path + '.citations', issue, p.citations); refs(path + '.fact_ids', issue, 'fact', p.fact_ids); refs(path + '.date_roles', issue, 'date', p.date_roles); });
    });
    a.legal_tests?.forEach((t, n) => { cites(`${root}.legal_tests[${n}].citations`, issue, t.citations); refs(`${root}.legal_tests[${n}].date_roles`, issue, 'date', t.date_roles); });
    a.excluded_tests?.forEach((t, n) => cites(`${root}.excluded_tests[${n}].citations`, issue, t.citations));
    a.authority_conflicts?.forEach((c, n) => {
      cites(`${root}.authority_conflicts[${n}].left.citations`, issue, c.left.citations);
      cites(`${root}.authority_conflicts[${n}].right.citations`, issue, c.right.citations);
      cites(`${root}.authority_conflicts[${n}].resolution_citations`, issue, c.resolution_citations);
    });
    a.counter_evidence.forEach((c, n) => {
      uses.push({ path: `${root}.counter_evidence[${n}].evidence_id`, issue_id: issue, kind: 'evidence', id: c.evidence_id, role: 'counter' });
      cites(`${root}.counter_evidence[${n}].resolution_citations`, issue, c.resolution_citations ?? []);
    });
    a.legal_basis?.statutes.forEach((s, n) => { cites(`${root}.legal_basis.statutes[${n}].citation`, issue, [s.citation]); refs(`${root}.legal_basis.statutes[${n}].date_roles`, issue, 'date', s.date_roles); });
    cites(root + '.legal_basis.temporal_application.citations', issue, a.legal_basis?.temporal_application.citations ?? []);
    a.legal_basis?.authorities.forEach((a, n) => {
      uses.push({ path: `${root}.legal_basis.authorities[${n}].evidence_id`, issue_id: issue, kind: 'evidence', id: a.evidence_id, role: a.disposition });
      cites(`${root}.legal_basis.authorities[${n}].subsequent_review.citations`, issue, a.subsequent_review.citations, 'subsequent_history');
    });
    refs(root + '.timing.date_roles', issue, 'date', a.timing.date_roles);
  });
  input.answer_blocks?.forEach((b, n) => cites(`answer_blocks[${n}].citations`, b.issue_id, b.citations));
  return uses;
}
