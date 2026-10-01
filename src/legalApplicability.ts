import type { CitationInput, IssueAnalysisInput, Plan } from './researchContracts.js';
import type { ResearchEvidence } from './researchEvidence.js';
import { documentKey } from './researchIdentity.js';
import { isCoverageComplete, type Coverage } from './researchCoverage.js';

export const applicabilityInstructions = '사실·쟁점·날짜 역할을 먼저 확인하고 사건에 적용되는 법령·시행령·부칙(시행일·적용례·경과조치)을 기준으로 판례·해석례를 교차 검토하세요. 검색 순서는 자유지만 사례의 결론만 가져오지 마세요. 사건 이후 선고·발행된 자료도 당시 적용 법령을 해석했다면 검토 대상이며 사건일을 자료 발행일의 검색 상한으로 쓰지 마세요. legal_basis.statutes에 실제 법령 passage 인용과 unit.document_version 그대로의 version, date_roles, 적용 이유를 제출하세요. temporal_application에는 부칙과 개정의 적용 관계 및 실제 원문 citations를 제출하세요. authorities에는 주장·시점·반론 해결·후속 처리에 인용하거나 반론으로 받은 각 판례·해석례의 종류, 적용/유추/구별/미해결, statute_evidence_ids, law_version_relation, 사실 차이와 채택 이유를 제출하세요. 같은 규정은 same_rule, 개정됐어도 관련 규정이 유지되면 unchanged_relevant_rule, 다른 규정은 different_rule, 미확인은 unverified입니다. subsequent_review에는 심급·확정·파기·판례변경·후속 해석 확인 범위와 원문을 남기세요. 적용 가능한 대법원 법리를 우선 검토하되 법령 개정·사실 차이를 먼저 확인하고, 하급심과 심사/심판 결정·행정해석을 구분하세요. 헌재 결정이나 위임의 위법성도 관련되면 별도 쟁점으로 검토하세요. 법문과 달라 보인다는 모델 판단만으로 자료를 버리지 마세요. 해결된 반론에는 resolution_citations를 붙이고, 배제한 자료도 이유를 남기세요. 답변에 법리상 결론·다른 행정 실무·적용/구별 이유와 미확인점을 표시하세요. 이 연결 검사는 법률적 타당성 인증이 아닙니다. ';

type Finding = (code: string, detail: string) => void;
const isStatute = (e: ResearchEvidence | undefined) => e?.tool === 'get_law_text' || e?.tool === 'check_legal_sources';

/** Checks submitted links against this session's receipts. Authority and legal meaning remain model assertions. */
export function inspectLegalApplicability(analysis: IssueAnalysisInput, issue: Plan['issues'][number], plan: Plan,
  evidence: ResearchEvidence[], checkCitation: (citation: CitationInput, label: string) => boolean, block: Finding, gap: Finding, coverage?: Coverage) {
  const basis = analysis.legal_basis;
  if (!basis) { gap('LEGAL_BASIS_REQUIRED', '적용 법령 버전·시점·판례/해석례 연결을 legal_basis로 제출하세요.'); return; }
  const byId = new Map(evidence.map(e => [e.evidence_id, e]));
  const statuteIds = new Set(basis.statutes.map(s => s.citation.evidence_id));
  if (!basis.statutes.length) gap('STATUTE_BASIS_REQUIRED', '적용 법령의 실제 본문과 버전이 필요합니다.');
  const coveredDates = new Set<string>();
  const statuteKeys = new Set<string>();
  for (const statute of basis.statutes) {
    const ref = statute.citation, receipt = byId.get(ref.evidence_id);
    checkCitation(ref, 'legal_basis.statutes');
    const passage = receipt?.passages.find(p => p.passage_id === ref.passage_id);
    const unit = receipt?.units.find(u => u.unit_id === passage?.unit_id);
    const key = ref.evidence_id + '/' + ref.passage_id;
    if (statuteKeys.has(key)) block('DUPLICATE_STATUTE', key);
    statuteKeys.add(key);
    if (!isStatute(receipt)) block('STATUTE_SOURCE_REQUIRED', ref.evidence_id);
    if (!unit?.document_version || unit.document_version === 'unknown') gap('LAW_VERSION_UNVERIFIED', ref.evidence_id);
    else if (statute.version !== unit.document_version) block('LAW_VERSION_MISMATCH', key + ': 서버 관측 버전과 다릅니다.');
    if (!unit?.document_id || unit.document_id === 'unknown') gap('LAW_ID_UNVERIFIED', ref.evidence_id);
    if (new Set(statute.date_roles).size !== statute.date_roles.length) block('DUPLICATE_DATE_ROLE', key);
    for (const role of statute.date_roles) {
      if (!plan.event_dates.some(d => d.role === role)) block('DATE_ROLE_NOT_FOUND', role);
      coveredDates.add(role);
    }
  }
  for (const role of new Set([...issue.required_date_roles, ...analysis.timing.date_roles])) {
    if (!coveredDates.has(role)) gap('LAW_DATE_ROLE_REQUIRED', role);
  }
  const temporal = basis.temporal_application;
  if (temporal.status === 'unresolved') gap('TEMPORAL_APPLICATION_UNRESOLVED', temporal.reason);
  if (!temporal.citations.length) gap('TEMPORAL_SOURCE_REQUIRED', '부칙·개정 적용 관계의 원문 근거를 제출하세요.');
  for (const citation of temporal.citations) checkCitation(citation, 'legal_basis.temporal_application');

  const authorities = new Map(basis.authorities.map(a => [a.evidence_id, a]));
  if (authorities.size !== basis.authorities.length) block('DUPLICATE_AUTHORITY', '같은 자료는 한 번만 평가하세요.');
  const cited = analysis.claims.flatMap(c => c.citations);
  // Timing, counter resolution and subsequent-treatment sources can change a
  // conclusion too. Their receipts must not bypass the same applicability map.
  const allCitations = [...cited, ...temporal.citations,
    ...analysis.counter_evidence.flatMap(c => c.resolution_citations ?? []),
    ...basis.authorities.flatMap(a => a.subsequent_review.citations)];
  const required = new Set([...allCitations.map(c => c.evidence_id), ...analysis.counter_evidence.map(c => c.evidence_id)]);
  for (const id of required) {
    const e = byId.get(id);
    if (isStatute(e)) {
      if (!statuteIds.has(id)) gap('STATUTE_REVIEW_REQUIRED', id);
    } else if (e && !authorities.has(id)) gap('AUTHORITY_REVIEW_REQUIRED', id);
  }
  for (const authority of basis.authorities) {
    const id = authority.evidence_id, receipt = byId.get(id);
    if (!receipt) block('EVIDENCE_NOT_FOUND', id);
    else if (isStatute(receipt)) block('AUTHORITY_SOURCE_REQUIRED', id);
    else if (!receipt.issue_ids.includes(issue.id)) {
      if (!allCitations.some(c => c.evidence_id === id && c.bridge_reason)) block('ISSUE_BRIDGE_REQUIRED', id);
    }
    if (receipt && !isStatute(receipt)) {
      const observed = receipt.identity;
      if (observed?.status === 'conflict') gap('AUTHORITY_IDENTITY_CONFLICT', id);
      else if (!observed || observed.status !== 'observed' || observed.kind === 'unknown') gap('AUTHORITY_IDENTITY_UNVERIFIED', id);
      else if (authority.kind !== observed.kind) block('AUTHORITY_KIND_MISMATCH', id + ': 서버가 관측한 종류와 모델 선언이 다릅니다.');
    }
    if (!authority.statute_evidence_ids.length) gap('AUTHORITY_STATUTE_REQUIRED', id);
    if (new Set(authority.statute_evidence_ids).size !== authority.statute_evidence_ids.length
      || authority.statute_evidence_ids.some(ref => !statuteIds.has(ref))) block('AUTHORITY_STATUTE_REFERENCE', id);
    if (authority.disposition === 'unresolved' || authority.law_version_relation === 'unverified') gap('AUTHORITY_LAW_UNRESOLVED', id);
    if (authority.disposition === 'applied' && authority.law_version_relation === 'different_rule') block('AUTHORITY_LAW_CONTRADICTION', id);
    if (authority.disposition !== 'applied' && cited.some(c => c.evidence_id === id && c.relation === 'direct')) block('AUTHORITY_DISPOSITION_CONTRADICTION', id);
    if (authority.subsequent_review.status === 'unresolved') gap('SUBSEQUENT_TREATMENT_UNRESOLVED', id);
    const subsequent = coverage?.obligations.filter(o => o.issue_id === issue.id && o.purpose === 'subsequent'
      && o.document_key === (receipt?.identity ? documentKey(receipt.identity) : id)) ?? [];
    const ids = authority.subsequent_review.search_attempt_ids ?? [];
    const followupOnly = coverage?.candidates.some(c => c.key === (receipt?.identity ? documentKey(receipt.identity) : id)
      && c.discovery_role === 'subsequent') && authority.disposition === 'distinguished'
      && !cited.some(c => c.evidence_id === id && c.relation !== 'background');
    const noFurtherSearch = Boolean(followupOnly) && subsequent.length === 0;
    if (noFurtherSearch && ids.length) gap('SUBSEQUENT_REFERENCE_NOT_REQUIRED', id + ': 구별한 후속 발견 자료에 추가 검색 의무가 없습니다. 다른 자료의 조회 ID를 빼고 search_attempt_ids=[]로 수정하세요. 구별 이유를 유지하고 추가 조회를 만들지 마세요.');
    const performed = noFurtherSearch || subsequent.length > 0 && subsequent.every(o => isCoverageComplete(o) && o.attempt_ids.every(a => ids.includes(a)))
      && ids.every(a => subsequent.some(o => o.attempt_ids.includes(a)));
    if (!performed) gap('SUBSEQUENT_SEARCH_REQUIRED', id + ': 동일 원문 재인용은 후속 검색 수행 증거가 아닙니다.');
    if ((!performed || subsequent.some(o => o.candidate_ids.length)) && !authority.subsequent_review.citations.length) gap('SUBSEQUENT_SOURCE_REQUIRED', id);
    for (const citation of authority.subsequent_review.citations) checkCitation(citation, 'legal_basis.subsequent_review');
  }
}
