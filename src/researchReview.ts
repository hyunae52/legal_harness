import { digest } from './contracts.js';
import type { ReviewInput, Plan, CitationInput } from './researchContracts.js';
import type { ResearchAttempt, ResearchEvidence } from './researchEvidence.js';
import { inspectScopeCompletion } from './scopeCompletion.js';
import { inspectLegalApplicability } from './legalApplicability.js';
import { researchCoverage, candidateGaps, isCoverageComplete, type CandidateLedger } from './researchCoverage.js';
import { makeRequirements, effectiveRequirements, requirementMissing, type Requirement } from './researchRequirements.js';
import { substantiveCitations } from './researchCitations.js';

export const coreEvidenceIds = (input: ReviewInput) => input.analysis.flatMap(a => [...substantiveCitations(a).filter(c => c.relation !== 'background').map(c => c.evidence_id),
    ...(a.legal_basis?.authorities.filter(a => a.disposition === 'applied' || a.disposition === 'analogy').map(a => a.evidence_id) ?? [])]);
export function inspectResearch(input: ReviewInput, plan: Plan, evidence: ResearchEvidence[], attempts: ResearchAttempt[], ledger?: CandidateLedger, registeredRequirements?: Requirement[]) {
  const core = coreEvidenceIds(input);
  const coverage = researchCoverage(plan, input.expected_revision, evidence, attempts, ledger, undefined, core);
  evidence = evidence.filter(e => e.revision === input.expected_revision);
  const requirements = effectiveRequirements(registeredRequirements ?? makeRequirements(plan, input.expected_revision), plan, input.expected_revision, evidence);
  const findings: { code: string; severity: 'blocked' | 'needs_info'; issue_id?: string; detail: string; gap_id?: string }[] = [];
  const citationChecks: Record<string, unknown>[] = [];
  const gapId = (code: string, detail: string, issue_id?: string) => 'gap-' + digest({ revision: input.expected_revision, code, detail, issue_id }).slice(0, 24);
  const add = (code: string, severity: 'blocked' | 'needs_info', detail: string, issue_id?: string) => findings.push({ code, severity, detail,
    gap_id: gapId(code, detail, issue_id), ...(issue_id ? { issue_id } : {}) });
  for (const r of requirements.filter(r => r.scope_status === 'unmapped')) add('REQUIREMENT_SCOPE_UNRESOLVED', 'needs_info', r.requirement_id + ': ' + r.description);
  const byEvidence = new Map(evidence.map(e => [e.evidence_id, e]));
  const claimIds = new Set<string>();
  const submittedIssues = input.analysis.map(a => a.issue_id);
  if (new Set(submittedIssues).size !== submittedIssues.length || plan.issues.some(i => !submittedIssues.includes(i.id))
    || submittedIssues.some(id => !plan.issues.some(i => i.id === id))) add('ISSUE_COVERAGE', 'blocked', '등록 쟁점마다 분석을 정확히 한 번 제출하세요.');
  for (const analysis of input.analysis) {
    const issue = plan.issues.find(i => i.id === analysis.issue_id);
    if (!issue) continue;
    const beginning = findings.length;
    const block = (code: string, detail: string) => add(code, 'blocked', detail, issue.id);
    const gap = (code: string, detail: string) => add(code, 'needs_info', detail, issue.id);
    for (const item of coverage.preparation_gaps.filter(g => g.issue_id === issue.id)) gap(item.code, '실제 법령 조문 앵커 또는 지원하는 조회 경로를 확보하세요.');
    const obligations = coverage.obligations.filter(o => o.issue_id === issue.id);
    if (!obligations.length || obligations.some(o => !isCoverageComplete(o))) gap('REQUIRED_SEARCH_INCOMPLETE', '필수 자료군·후속/개정 조회 범위가 미완료입니다. coverage를 확인하세요.');
    for (const item of candidateGaps(coverage, analysis)) gap(item.code, item.detail);
    const issueRequirements = requirements.filter(r => r.scope_status === 'current' && r.issue_id === issue.id);
    for (const r of requirements.filter(r => (r.assessment_issue_id ?? r.issue_id) === issue.id && r.status !== 'unresolved'
      && r.basis?.kind === 'source' && requirementMissing(r, plan))) {
      const basis = r.basis!;
      if (basis.kind !== 'source') continue;
      const linked = analysis.legal_basis?.statutes.some(s => s.citation.evidence_id === basis.evidence_id && s.version === basis.version)
        || analysis.legal_basis?.authorities.some(a => a.evidence_id === basis.evidence_id && a.statute_evidence_ids.length
          && a.law_version_relation !== 'unverified' && a.disposition !== 'unresolved');
      if (!linked) gap('REQUIREMENT_APPLICABILITY_LINK_REQUIRED', r.requirement_id + ': 필요성 근거도 최종 legal_basis의 적용·구별 검토에 연결하세요.');
    }
    for (const r of issueRequirements.filter(r => requirementMissing(r, plan))) {
      if (r.status === 'unresolved') gap('REQUIREMENT_NECESSITY_UNRESOLVED', `${r.requirement_id}: ${r.target.id}; 원문과 질문 범위에서 필요성을 먼저 평가하세요.`);
      else if (r.status === 'required' && r.target.kind === 'fact') {
        const fact = plan.facts.find(f => f.id === r.target.id)!;
        gap('REQUIRED_FACT_UNCONFIRMED', `${r.target.id}: ${fact.description} (${fact.status})`);
      }
    }
    // A successful current unit cannot erase failed roles in the same lookup,
    // including receipts that the model does not cite in its claims.
    for (const receipt of coverage.effective_evidence.filter(e => e.issue_ids.includes(issue.id))) {
      for (const unit of receipt.units) {
        const detail = `${receipt.evidence_id}: ${unit.role} (${unit.date ?? 'unknown'})`;
        if (unit.source_access === 'unavailable') gap('UNAVAILABLE_SOURCE_ROLE', detail);
        else if (unit.body_scope === 'unknown' || unit.body_scope === 'partial') gap('SOURCE_ROLE_BODY_INCOMPLETE', detail);
      }
    }
    if (analysis.claims.length === 0 || analysis.conclusion_mode === 'withheld') {
      if (analysis.conclusion_mode !== 'withheld' || !analysis.withholding_reason.trim()) block('CLAIM_REQUIRED', '주장을 제출하거나 명시적으로 유보 사유를 적으세요.');
      gap('CONCLUSION_WITHHELD', analysis.withholding_reason || '주장이 제출되지 않았습니다.');
    }
    const checkCitation = (citation: CitationInput, claimId: string) => {
      const receipt = byEvidence.get(citation.evidence_id);
      const passage = receipt?.passages.find(p => p.passage_id === citation.passage_id);
      const match = Boolean(passage && passage.text.includes(citation.quote));
      const errors: string[] = [];
      if (!receipt) errors.push('EVIDENCE_NOT_FOUND');
      else if (!passage) errors.push('PASSAGE_NOT_FOUND');
      else {
        if (!match) errors.push('QUOTE_MISMATCH');
        if (!receipt.issue_ids.includes(issue.id) && !citation.bridge_reason) errors.push('ISSUE_BRIDGE_REQUIRED');
        if (['discovery_only', 'unknown'].includes(passage.body_scope)) errors.push('BODY_NOT_AVAILABLE');
        if (passage.body_scope === 'partial') gap('PARTIAL_BODY', citation.evidence_id);
        if (receipt.units.some(u => u.source_access === 'unavailable')) gap('UNAVAILABLE_SOURCE_ROLE', citation.evidence_id);
      }
      for (const code of errors) block(code, `${claimId}: ${citation.evidence_id}/${citation.passage_id}`);
      citationChecks.push({ issue_id: issue.id, claim_id: claimId, citation, quote_match: match,
        body_scope: passage?.body_scope ?? receipt?.body_scope ?? 'unknown', errors, semantic_support: 'unverified' });
      return !errors.length && match && citation.relation === 'direct' && passage?.body_scope === 'body_returned';
    };
    for (const claim of analysis.claims) {
      if (claimIds.has(claim.id)) block('DUPLICATE_CLAIM', claim.id);
      claimIds.add(claim.id);
      if (!input.draft_answer.includes(claim.text)) block('CLAIM_NOT_IN_DRAFT', claim.id);
      if (new Set(claim.fact_ids).size !== claim.fact_ids.length) block('DUPLICATE_FACT_REFERENCE', claim.id);
      for (const factId of claim.fact_ids) {
        const fact = plan.facts.find(f => f.id === factId);
        if (!fact) block('FACT_NOT_FOUND', factId);
        else if (fact.status !== 'provided') gap('USED_FACT_UNCONFIRMED', factId);
      }
      let direct = false;
      for (const citation of claim.citations) {
        if (checkCitation(citation, claim.id)) direct = true;
      }
      if (!direct) gap('DIRECT_SUPPORT_REQUIRED', claim.id + ': 확인 가능한 직접 본문 인용이 부족합니다. 유추 여부의 의미 판단은 별도입니다.');
    }
    const counterIds = analysis.counter_evidence.map(c => c.evidence_id);
    if (new Set(counterIds).size !== counterIds.length) block('DUPLICATE_COUNTER', '반대 자료를 중복 처리했습니다.');
    for (const counter of analysis.counter_evidence) {
      const receipt = byEvidence.get(counter.evidence_id);
      if (!receipt) block('EVIDENCE_NOT_FOUND', counter.evidence_id);
      else {
        // A neutral search can discover the strongest contrary authority. Retrieval purpose is
        // provenance, not a restriction on the later legal use of the observed body.
        if (!receipt.issue_ids.includes(issue.id)) block('COUNTER_SCOPE_MISMATCH', counter.evidence_id);
        if (receipt.body_scope !== 'body_returned') gap('COUNTER_BODY_REQUIRED', counter.evidence_id);
      }
      if (counter.disposition === 'unresolved') gap('UNRESOLVED_COUNTER', counter.reason);
      if (counter.disposition === 'resolved' && !counter.resolution_citations?.length) gap('COUNTER_RESOLUTION_SOURCE_REQUIRED', counter.evidence_id);
      for (const citation of counter.resolution_citations ?? []) checkCitation(citation, 'counter_resolution');
    }
    const counters = coverage.effective_evidence.filter(e => e.purpose === 'counter' && e.issue_ids.includes(issue.id) && e.body_scope !== 'discovery_only');
    const counterSearch = obligations.filter(o => o.purpose === 'counter');
    if (!counterSearch.length || counterSearch.some(o => !isCoverageComplete(o))) gap('COUNTER_RESEARCH_REQUIRED', '반대 검색 수행 범위를 확인하세요. 정상 0건은 반례 부재의 증명이 아닙니다.');
    for (const counter of counters) if (!counterIds.includes(counter.evidence_id)) gap('COUNTER_NOT_ADDRESSED', counter.evidence_id);
    for (const attempt of coverage.incomplete_attempts.filter(a => a.issue_ids.includes(issue.id))) {
      gap('SEARCH_INCOMPLETE', `${attempt.attempt_id}: ${attempt.status}; ${attempt.error_code ?? '추가 확인 필요'}`);
    }
    const effectiveIssue = { ...issue, required_date_roles: issue.required_date_roles.filter(id => issueRequirements.some(r =>
      r.target.kind === 'date' && r.target.id === id && (r.status === 'required' || r.status !== 'not_required_for_question' && !requirementMissing(r, plan)))) };
    inspectLegalApplicability(analysis, effectiveIssue, plan, evidence, checkCitation, block, gap, coverage);
    const usedDateRoles = new Set([...effectiveIssue.required_date_roles, ...analysis.timing.date_roles,
      ...(analysis.legal_basis?.statutes.flatMap(s => s.date_roles) ?? [])]);
    for (const role of usedDateRoles) {
      const date = plan.event_dates.find(d => d.role === role);
      if (!date) { block('DATE_ROLE_NOT_FOUND', role); continue; }
      if (!analysis.timing.date_roles.includes(role)) gap('DATE_ROLE_NOT_ADDRESSED', role);
      if (date.precision !== 'day' || date.basis !== 'provided') gap('DATE_UNCONFIRMED', `${role}: ${date.precision}/${date.basis}`);
    }
    if (analysis.timing.status === 'unresolved' || (usedDateRoles.size && analysis.timing.status !== 'addressed')) gap('TIMING_REVIEW_REQUIRED', analysis.timing.reason);
    if (analysis.exceptions.status === 'unresolved') gap('EXCEPTIONS_UNRESOLVED', analysis.exceptions.reason);
    if (analysis.unknowns.length) gap('DECLARED_UNKNOWNS', analysis.unknowns.join('; '));
    const declared = [...analysis.unknowns, ...(analysis.conclusion_mode === 'withheld' && analysis.withholding_reason ? [analysis.withholding_reason] : []),
      ...(analysis.exceptions.status === 'unresolved' ? [analysis.exceptions.reason] : [])];
    const conditions = analysis.blocking_conditions ?? [];
    const declaredOnly = new Set(['DECLARED_UNKNOWNS', 'CONCLUSION_WITHHELD', 'EXCEPTIONS_UNRESOLVED', 'UNRESOLVED_COUNTER', 'TIMING_REVIEW_REQUIRED']);
    const observedGapIds = new Set(findings.filter(f => (!f.issue_id || f.issue_id === issue.id) && !declaredOnly.has(f.code)).map(f => f.gap_id));
    if (declared.some(text => !conditions.some(c => c.text === text))) gap('WITHHOLDING_BASIS_UNCLASSIFIED',
      '결론을 막는 각 unknowns/유보/예외 사유를 blocking_conditions의 text와 실제 requirement_ids 또는 gap_ids로 연결하세요. 요청 밖 주의사항은 별도 범위 설명입니다.');
    for (const condition of conditions) {
      if (!condition.requirement_ids.length && !condition.gap_ids.length) gap('WITHHOLDING_BASIS_UNCLASSIFIED', condition.text);
      for (const id of condition.requirement_ids) {
        const r = requirements.find(r => r.requirement_id === id && (r.issue_id === issue.id || r.scope_status === 'unmapped'));
        if (!r || r.status === 'not_required_for_question' || !requirementMissing(r, plan)) block('WITHHOLDING_REQUIREMENT_NOT_BLOCKING', id);
      }
      for (const id of condition.gap_ids) if (!observedGapIds.has(id)) block('WITHHOLDING_GAP_NOT_FOUND', id);
    }
    const hasGaps = findings.slice(beginning).some(f => f.severity === 'needs_info');
    if (hasGaps && analysis.conclusion_mode === 'definitive') block('DEFINITIVE_WITH_GAPS', '필요한 사실·근거·시점·반론의 공백이 남아 확정 결론과 모순됩니다.');
    if (hasGaps && analysis.conclusion_mode !== 'definitive' && (!analysis.unknowns.length || !analysis.next_queries.length)) block('GAPS_NOT_EXPLAINED', '조건부/유보 답변에 미확인점과 다음 질문·검색을 적으세요.');
  }
  const scopeCompletion = inspectScopeCompletion(input, plan, evidence, attempts, findings, coverage);
  const { findings: scopeFindings, ...scopeStatus } = scopeCompletion;
  findings.push(...scopeFindings);
  return { status: findings.some(f => f.severity === 'blocked') ? 'blocked' : findings.length ? 'needs_info' : 'structurally_complete',
    findings, citation_checks: citationChecks, next_queries: input.analysis.flatMap(a => a.next_queries),
    reference_guide: { fact_ids: plan.facts.map(f => f.id), date_roles: plan.event_dates.map(d => d.role),
      requirements: requirements.map(r => ({ requirement_id: r.requirement_id, issue_id: r.issue_id, target: r.target, status: r.status,
        scope_status: r.scope_status, missing: requirementMissing(r, plan) })),
      gaps: findings.filter(f => f.gap_id && !['DECLARED_UNKNOWNS', 'CONCLUSION_WITHHELD', 'EXCEPTIONS_UNRESOLVED', 'UNRESOLVED_COUNTER', 'TIMING_REVIEW_REQUIRED', 'WITHHOLDING_BASIS_UNCLASSIFIED'].includes(f.code))
        .map(f => ({ gap_id: f.gap_id, code: f.code, issue_id: f.issue_id })),
      evidence: evidence.map(e => ({ evidence_id: e.evidence_id, passage_ids: e.passages.map(p => p.passage_id),
        document_version: e.document_version, issue_ids: e.issue_ids })),
      subsequent_searches: coverage.obligations.filter(o => o.purpose === 'subsequent')
        .map(o => ({ issue_id: o.issue_id, obligation_id: o.obligation_id, document_key: o.document_key, attempt_ids: o.attempt_ids })),
      note: 'fact_ids와 날짜 date_roles는 별도 namespace입니다. 참조만 수정할 때 사실·날짜를 새로 만들거나 추가 조회하지 마세요.' },
    question_scope_complete: scopeCompletion.question_scope_complete,
    declared_scope_review_complete: scopeCompletion.declared_scope_review_complete,
    scope_completion: scopeStatus,
    coverage: { ...coverage, effective_evidence: undefined },
    draft_hash: digest(input.draft_answer), analysis_hash: digest(input.analysis),
    scope_assessment_hash: digest(input.scope_assessments ?? null),
    legal_verification: 'unverified', semantic_support: 'unverified', independent_review: 'not_performed',
    stages: { deterministic_structure: 'completed', independent_semantic_review: 'not_configured' },
    claim_coverage: 'submitted_claims_only', note: '등록된 쟁점·범위 트랙과 제출된 주장만 대조했습니다. 법률 정답·등록되지 않은 쟁점·인용의 의미적 지지는 미검수입니다.',
    correction_suggestion: input.correction_needed ? { next_tool: 'prepare_correction_pr', question: '공개 가능한 정정안을 준비해서 PR로 제안할까요?',
      consent_required: true, note: '먼저 공개할 내용을 prepare_correction_pr로 준비하고 실제 preview·저장소를 보여준 뒤 동의를 받으세요. 연구 원문·개인 사실을 자동 게시하지 않습니다.' } : null };
}
