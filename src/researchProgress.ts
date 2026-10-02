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
      subsequent_search_requirements: coverage.obligations.filter(o => o.purpose === 'subsequent' && o.document_key === c.key)
        .map(o => ({ issue_id: o.issue_id, obligation_id: o.obligation_id, status: o.status, search_attempt_ids: o.attempt_ids })),
      ...(c.discovery_role === 'subsequent' ? { subsequent_guidance: '후속 발견 원문도 읽고 적용·구별 이유를 작성하세요. 새 법적 근거로 채택하지 않고 distinguished로 구별했으며 이 자료의 subsequent_search_requirements가 비어 있으면 추가 후속 검색은 필요하지 않습니다. subsequent_review={status:"addressed",reason:"구별 이유와 추가 검색이 필요하지 않은 범위",citations:[],search_attempt_ids:[]}로 기록하세요. applied/analogy 또는 직접 주장에 채택하면 새 후속 검색 의무가 생성됩니다.' } : {}),
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
