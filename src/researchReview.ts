import { digest } from './contracts.js';
import type { ReviewInput, Plan } from './researchContracts.js';
import type { ResearchAttempt, ResearchEvidence } from './researchEvidence.js';
import { inspectScopeCompletion } from './scopeCompletion.js';

export function inspectResearch(input: ReviewInput, plan: Plan, evidence: ResearchEvidence[], attempts: ResearchAttempt[]) {
  const findings: { code: string; severity: 'blocked' | 'needs_info'; issue_id?: string; detail: string }[] = [];
  const citationChecks: Record<string, unknown>[] = [];
  const add = (code: string, severity: 'blocked' | 'needs_info', detail: string, issue_id?: string) => findings.push({ code, severity, detail, ...(issue_id ? { issue_id } : {}) });
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
    for (const factId of issue.required_fact_ids) {
      const fact = plan.facts.find(f => f.id === factId)!;
      if (fact.status !== 'provided') gap('REQUIRED_FACT_UNCONFIRMED', `${factId}: ${fact.description} (${fact.status})`);
    }
    // A successful current unit cannot erase failed roles in the same lookup,
    // including receipts that the model does not cite in its claims.
    for (const receipt of evidence.filter(e => e.issue_ids.includes(issue.id))) {
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
        for (const code of errors) block(code, `${claim.id}: ${citation.evidence_id}/${citation.passage_id}`);
        citationChecks.push({ issue_id: issue.id, claim_id: claim.id, citation, quote_match: match,
          body_scope: passage?.body_scope ?? receipt?.body_scope ?? 'unknown', errors, semantic_support: 'unverified' });
        if (!errors.length && match && citation.relation === 'direct' && passage?.body_scope === 'body_returned') direct = true;
      }
      if (!direct) gap('DIRECT_SUPPORT_REQUIRED', claim.id + ': 확인 가능한 직접 본문 인용이 부족합니다. 유추 여부의 의미 판단은 별도입니다.');
    }
    const counterIds = analysis.counter_evidence.map(c => c.evidence_id);
    if (new Set(counterIds).size !== counterIds.length) block('DUPLICATE_COUNTER', '반대 자료를 중복 처리했습니다.');
    for (const counter of analysis.counter_evidence) {
      const receipt = byEvidence.get(counter.evidence_id);
      if (!receipt) block('EVIDENCE_NOT_FOUND', counter.evidence_id);
      else {
        if (receipt.purpose !== 'counter' || !receipt.issue_ids.includes(issue.id)) block('COUNTER_SCOPE_MISMATCH', counter.evidence_id);
        if (receipt.body_scope !== 'body_returned') gap('COUNTER_BODY_REQUIRED', counter.evidence_id);
      }
      if (counter.disposition === 'unresolved') gap('UNRESOLVED_COUNTER', counter.reason);
    }
    const counters = evidence.filter(e => e.purpose === 'counter' && e.issue_ids.includes(issue.id));
    if (!counters.length) gap('COUNTER_RESEARCH_REQUIRED', '반대 자료를 확인하세요. 0건이나 실패는 반례 부재의 증명이 아닙니다.');
    for (const counter of counters) if (!counterIds.includes(counter.evidence_id)) gap('COUNTER_NOT_ADDRESSED', counter.evidence_id);
    for (const attempt of attempts.filter(a => a.revision === input.expected_revision && a.issue_ids.includes(issue.id) && ['failed', 'empty', 'pending'].includes(a.status))) {
      gap('SEARCH_INCOMPLETE', `${attempt.attempt_id}: ${attempt.status}; ${attempt.error_code ?? '추가 확인 필요'}`);
    }
    for (const role of analysis.timing.date_roles) if (!plan.event_dates.some(d => d.role === role)) block('DATE_ROLE_NOT_FOUND', role);
    for (const role of issue.required_date_roles) {
      const date = plan.event_dates.find(d => d.role === role)!;
      if (!analysis.timing.date_roles.includes(role)) gap('DATE_ROLE_NOT_ADDRESSED', role);
      if (date.precision !== 'day' || date.basis !== 'provided') gap('DATE_UNCONFIRMED', `${role}: ${date.precision}/${date.basis}`);
    }
    if (analysis.timing.status === 'unresolved' || (issue.required_date_roles.length && analysis.timing.status !== 'addressed')) gap('TIMING_REVIEW_REQUIRED', analysis.timing.reason);
    if (analysis.exceptions.status === 'unresolved') gap('EXCEPTIONS_UNRESOLVED', analysis.exceptions.reason);
    if (analysis.unknowns.length) gap('DECLARED_UNKNOWNS', analysis.unknowns.join('; '));
    const hasGaps = findings.slice(beginning).some(f => f.severity === 'needs_info');
    if (hasGaps && analysis.conclusion_mode === 'definitive') block('DEFINITIVE_WITH_GAPS', '필요한 사실·근거·시점·반론의 공백이 남아 확정 결론과 모순됩니다.');
    if (hasGaps && analysis.conclusion_mode !== 'definitive' && (!analysis.unknowns.length || !analysis.next_queries.length)) block('GAPS_NOT_EXPLAINED', '조건부/유보 답변에 미확인점과 다음 질문·검색을 적으세요.');
  }
  const scopeCompletion = inspectScopeCompletion(input, plan, evidence, attempts, findings);
  const { findings: scopeFindings, ...scopeStatus } = scopeCompletion;
  findings.push(...scopeFindings);
  return { status: findings.some(f => f.severity === 'blocked') ? 'blocked' : findings.length ? 'needs_info' : 'structurally_complete',
    findings, citation_checks: citationChecks, next_queries: input.analysis.flatMap(a => a.next_queries),
    question_scope_complete: scopeCompletion.question_scope_complete,
    declared_scope_review_complete: scopeCompletion.declared_scope_review_complete,
    scope_completion: scopeStatus,
    draft_hash: digest(input.draft_answer), analysis_hash: digest(input.analysis),
    scope_assessment_hash: digest(input.scope_assessments ?? null),
    legal_verification: 'unverified', semantic_support: 'unverified', independent_review: 'not_performed',
    stages: { deterministic_structure: 'completed', independent_semantic_review: 'not_configured' },
    claim_coverage: 'submitted_claims_only', note: '등록된 쟁점·범위 트랙과 제출된 주장만 대조했습니다. 법률 정답·등록되지 않은 쟁점·인용의 의미적 지지는 미검수입니다.',
    correction_suggestion: input.correction_needed ? { next_tool: 'prepare_correction_pr', question: '공개 가능한 정정안을 준비해서 PR로 제안할까요?',
      consent_required: true, note: '먼저 공개할 내용을 prepare_correction_pr로 준비하고 실제 preview·저장소를 보여준 뒤 동의를 받으세요. 연구 원문·개인 사실을 자동 게시하지 않습니다.' } : null };
}
