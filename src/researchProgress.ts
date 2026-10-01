import { candidateBody, nextRequiredResearchStep, type Coverage } from './researchCoverage.js';

/** A finished four-step job is not a finished investigation. Expose the remaining work first. */
export function researchProgress(coverage: Coverage) {
  const candidates = coverage.candidates.filter(c => c.discovery_role !== 'exploratory' && c.state !== 'out_of_current_scope');
  const worklist = candidates.map(c => {
    const bodies = candidateBody(c, coverage.effective_evidence);
    return { candidate_id: c.candidate_id, issue_ids: c.issue_ids, document_number: c.identity.document_number,
      title: c.title, discovery_role: c.discovery_role, evidence_ids: bodies.map(e => e.evidence_id),
      observed_kind: bodies[0]?.identity?.kind ?? c.identity.kind,
      review_location: c.statute ? 'legal_basis.statutes and legal_basis.temporal_application' : 'legal_basis.authorities',
      ...(c.statute ? { statute: c.statute } : {}),
      status: bodies.length ? 'applicability_review_required' : 'body_required' };
  });
  const next = nextRequiredResearchStep(coverage);
  const pending = coverage.obligations.filter(o => !o.status.startsWith('completed')).length;
  const missing = worklist.filter(c => c.status === 'body_required').map(c => c.candidate_id);
  const gaps = coverage.preparation_gaps.length + coverage.incomplete_attempts.length
    + Number(coverage.candidate_overflow) + coverage.candidates.filter(c => c.state === 'out_of_current_scope').length;
  return { retrieval_progress: { state: next ? 'retrieving' : pending || missing.length || gaps ? 'source_gaps' : 'ready_for_analysis',
    pending_search_count: pending, missing_body_candidate_ids: missing, source_gap_count: gaps, next_step: next,
    note: 'job.completed는 해당 배치만 완료한 상태입니다. ready_for_analysis도 법률 검수 완료가 아닙니다. 원문을 읽고 모든 필수 후보의 적용·구별 근거를 직접 작성하세요.' },
    review_worklist: worklist };
}
