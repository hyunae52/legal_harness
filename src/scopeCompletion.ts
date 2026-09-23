import type { Plan, ReviewInput, ScopeAssessmentInput } from './researchContracts.js';
import type { ResearchAttempt, ResearchEvidence } from './researchEvidence.js';

type Finding = { code: string; severity: 'blocked' | 'needs_info'; issue_id?: string; detail: string };
type Track = NonNullable<Plan['scope_review']>['tracks'][number];

const closedStatuses = new Set<ScopeAssessmentInput['status']>(['supported', 'excluded']);
const unique = (values: string[]) => new Set(values).size === values.length;

export function inspectScopeCompletion(input: ReviewInput, plan: Plan, evidence: ResearchEvidence[],
  attempts: ResearchAttempt[], existingFindings: Finding[]) {
  const scope = plan.scope_review;
  if (!scope) return {
    status: 'not_configured' as const, question_scope_complete: false,
    declared_scope_review_complete: false, open_track_ids: [], track_results: [], findings: [] as Finding[],
    note: 'scope_review가 등록되지 않아 완료를 주장할 수 없습니다.',
  };

  const findings: Finding[] = [];
  const add = (code: string, severity: Finding['severity'], detail: string, issue_id?: string) =>
    findings.push({ code, severity, detail, ...(issue_id ? { issue_id } : {}) });
  const assessments = input.scope_assessments ?? [];
  const assessmentCounts = new Map<string, number>();
  for (const assessment of assessments) assessmentCounts.set(assessment.track_id, (assessmentCounts.get(assessment.track_id) ?? 0) + 1);
  for (const [trackId, count] of assessmentCounts) {
    if (!scope.tracks.some(track => track.id === trackId)) add('SCOPE_ASSESSMENT_UNKNOWN_TRACK', 'blocked', trackId);
    else if (count !== 1) add('SCOPE_ASSESSMENT_DUPLICATE', 'blocked', trackId);
  }

  const byEvidence = new Map(evidence.map(item => [item.evidence_id, item]));
  const byFact = new Map(plan.facts.map(fact => [fact.id, fact]));
  const byAnalysis = new Map(input.analysis.map(analysis => [analysis.issue_id, analysis]));
  const trackResults = scope.tracks.map(track => inspectTrack(track));

  function inspectTrack(track: Track) {
    if ((assessmentCounts.get(track.id) ?? 0) > 1) {
      return { track_id: track.id, relation: track.relation, status: 'duplicate', closed: false, reasons: ['assessment_duplicate'] };
    }
    const assessment = assessments.find(item => item.track_id === track.id);
    if (!assessment) {
      add('SCOPE_ASSESSMENT_REQUIRED', 'needs_info', `${track.id}: ${track.party} / ${track.legal_question}`, track.issue_id ?? undefined);
      return { track_id: track.id, relation: track.relation, status: 'missing', closed: false, reasons: ['assessment_missing'] };
    }
    const reasons: string[] = [];
    const invalidate = (reason: string, code = 'SCOPE_BASIS_INVALID') => {
      reasons.push(reason); add(code, 'blocked', `${track.id}: ${reason}`, track.issue_id ?? undefined);
    };
    if (!unique(assessment.fact_ids)) invalidate('duplicate_fact_basis');
    if (!unique(assessment.evidence_ids)) invalidate('duplicate_evidence_basis');
    for (const factId of assessment.fact_ids) {
      if (!track.factual_anchor_ids.includes(factId)) invalidate(`fact_not_declared_anchor:${factId}`);
      else if (byFact.get(factId)?.status !== 'provided') invalidate(`fact_not_provided:${factId}`);
    }
    for (const evidenceId of assessment.evidence_ids) {
      const receipt = byEvidence.get(evidenceId);
      if (!receipt) invalidate(`evidence_not_found:${evidenceId}`);
      else if (!track.issue_id || !receipt.issue_ids.includes(track.issue_id)) invalidate(`evidence_scope_mismatch:${evidenceId}`);
      else if (receipt.body_scope !== 'body_returned' || receipt.units.some(unit => unit.source_access !== 'available'
        || unit.body_scope !== 'body_returned')) invalidate(`evidence_incomplete:${evidenceId}`);
    }
    const expectedLifecycle = assessment.status === 'overflow' ? 'overflow' : assessment.status === 'deferred' ? 'deferred' : null;
    if (expectedLifecycle && track.lifecycle !== expectedLifecycle) invalidate(`lifecycle_status_mismatch:${track.lifecycle}/${assessment.status}`);

    let closed = closedStatuses.has(assessment.status) && reasons.length === 0;
    if (closed) {
      const issueId = track.issue_id;
      if (track.lifecycle !== 'active' || !issueId) invalidate('required_track_not_promoted', 'SCOPE_TRACK_NOT_PROMOTED');
      if (!assessment.fact_ids.length || !assessment.evidence_ids.length) invalidate('closed_status_requires_fact_and_evidence');
      const analysis = issueId ? byAnalysis.get(issueId) : undefined;
      if (!analysis || analysis.conclusion_mode !== 'definitive') invalidate('closed_status_requires_definitive_issue_analysis');
      if (existingFindings.some(finding => !finding.issue_id)) invalidate('review_has_global_findings');
      if (issueId && existingFindings.some(finding => finding.issue_id === issueId)) invalidate('issue_has_unresolved_review_findings');
      if (issueId && attempts.some(attempt => attempt.issue_ids.includes(issueId)
        && ['failed', 'empty', 'pending'].includes(attempt.status))) invalidate('issue_has_incomplete_retrieval');
      closed = reasons.length === 0;
    }
    if (!closed && !closedStatuses.has(assessment.status)) {
      reasons.push(`open_status:${assessment.status}`);
      add('SCOPE_TRACK_OPEN', 'needs_info', `${track.id}: ${assessment.status}; ${assessment.reason}`, track.issue_id ?? undefined);
    }
    return { track_id: track.id, relation: track.relation, status: assessment.status, closed, reasons };
  }

  const closedById = new Map(trackResults.map(result => [result.track_id, result.closed]));
  const questionTracks = scope.tracks.filter(track => track.relation !== 'independent_notice');
  const hasUnknownAssessment = assessments.some(assessment => !scope.tracks.some(track => track.id === assessment.track_id));
  const questionScopeComplete = !hasUnknownAssessment && questionTracks.length > 0 && questionTracks.every(track => closedById.get(track.id));
  const declaredScopeComplete = !hasUnknownAssessment && scope.tracks.every(track => closedById.get(track.id));
  for (const track of questionTracks.filter(item => !closedById.get(item.id))) {
    const targets = track.relation === 'requested' ? [track] : track.blocks_track_ids
      .map(id => scope.tracks.find(candidate => candidate.id === id)).filter((candidate): candidate is Track => Boolean(candidate));
    for (const target of targets) {
      const analysis = target.issue_id ? byAnalysis.get(target.issue_id) : undefined;
      if (analysis?.conclusion_mode === 'definitive') add('DEFINITIVE_WITH_OPEN_SCOPE_DEPENDENCY', 'blocked',
        `${target.id}의 확정 결론을 막는 ${track.id} 트랙이 닫히지 않았습니다.`, target.issue_id ?? undefined);
    }
  }
  const unknownTrackIds = assessments.filter(assessment => !scope.tracks.some(track => track.id === assessment.track_id))
    .map(assessment => assessment.track_id);
  const openTrackIds = [...trackResults.filter(result => !result.closed).map(result => result.track_id), ...new Set(unknownTrackIds)];
  return {
    status: declaredScopeComplete ? 'complete' as const : 'incomplete' as const,
    question_scope_complete: questionScopeComplete,
    declared_scope_review_complete: declaredScopeComplete,
    open_track_ids: openTrackIds, track_results: trackResults, findings,
    note: 'true/false는 후보 자체의 해결 여부가 아니라 해당 범위의 완료 플래그입니다.',
  };
}
