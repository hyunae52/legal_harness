import type { IssueAnalysisInput } from './researchContracts.js';
import type { ResearchAttempt, ResearchEvidence } from './researchEvidence.js';

export function inspectConflicts(a: IssueAnalysisInput, evidence: ResearchEvidence[], attempts: ResearchAttempt[],
  block: (code: string, detail: string) => void, gap: (code: string, detail: string) => void) {
  const conflicts = a.authority_conflicts ?? [];
  if (new Set(conflicts.map(c => c.id)).size !== conflicts.length) block('DUPLICATE_CONFLICT', a.issue_id);
  for (const c of conflicts) {
    if (c.test_ids.some(id => !a.legal_tests?.some(t => t.id === id)) || c.claim_ids.some(id => !a.claims.some(p => p.id === id))) block('CONFLICT_REFERENCE_INVALID', c.id);
    if (c.left.proposition === c.right.proposition) block('CONFLICT_PROPOSITION_IDENTICAL', c.id);
    if (c.disposition === 'unresolved') gap('AUTHORITY_CONFLICT_UNRESOLVED', c.id);
    else if (!c.resolution_citations.length) block('CONFLICT_RESOLUTION_SOURCE_REQUIRED', c.id);
  }
  const opposition = a.strongest_opposition;
  if (!opposition) { block('STRONGEST_OPPOSITION_REQUIRED', a.issue_id); return; }
  if (opposition.status === 'identified') {
    if (!evidence.some(e => e.evidence_id === opposition.evidence_id && e.issue_ids.includes(a.issue_id))) block('OPPOSITION_REFERENCE_INVALID', opposition.evidence_id);
    if (!a.counter_evidence.some(c => c.evidence_id === opposition.evidence_id)) block('OPPOSITION_NOT_ADDRESSED', opposition.evidence_id);
  } else {
    if (a.counter_evidence.some(c => c.disposition !== 'irrelevant') || conflicts.length) block('OPPOSITION_DECLARATION_CONTRADICTION', a.issue_id);
    for (const id of opposition.search_attempt_ids) {
      const attempt = attempts.find(t => t.attempt_id === id && t.issue_ids.includes(a.issue_id));
      if (!attempt || !attempt.search || !['empty', 'completed'].includes(attempt.status)
        || attempt.obligation_purpose !== 'counter') block('OPPOSITION_SEARCH_INVALID', id);
    }
  }
}
