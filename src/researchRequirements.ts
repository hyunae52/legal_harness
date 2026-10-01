import { randomUUID } from 'node:crypto';
import { digest, ServiceError } from './contracts.js';
import type { Plan, RequirementAssessmentInput } from './researchContracts.js';
import type { ResearchEvidence } from './researchEvidence.js';

export interface Requirement {
  requirement_id: string; revision: number; issue_id: string; issue_question: string;
  target: { kind: 'fact' | 'date'; id: string }; description: string;
  scope_status: 'current' | 'unmapped' | 'withdrawn'; status: 'unresolved' | 'required' | 'not_required_for_question';
  profile_key?: string; reason: string; assessment_issue_id?: string;
  basis?: { kind: 'profile'; profile_key: string } | { kind: 'source'; evidence_id: string; passage_id: string;
    version: string; quote_hash: string; start: number; end: number };
}
export interface RequirementHistory { revision: number; state_version: number; event: 'plan_revision' | 'assessment';
  before_hash: string; after_hash: string; requirement_ids: string[]; reason: string;
  changes: { requirement_id: string; before: Requirement | null; after: Requirement }[] }
const normal = (value: string) => value.replace(/\s+/g, ' ').trim();
function registeredProfile(issue: Plan['issues'][number], kind: 'fact' | 'date', id: string) {
  if (issue.profile !== 'temporary_two_homes') return undefined;
  const items = kind === 'fact' ? ['housing_timeline', 'homes_before_new_acquisition', 'housing_special_exceptions']
    : ['old_home_acquired', 'new_home_acquired', 'old_home_transferred', 'other_homes_disposed'];
  return items.includes(id) ? `temporary_two_homes/v1/${kind}/${id}` : undefined;
}

/** A model's required_* list registers a hypothesis, not proof that a legal condition exists. */
export function makeRequirements(plan: Plan, revision: number, previous: Requirement[] = []): Requirement[] {
  const out: Requirement[] = [], used = new Set<string>();
  for (const issue of plan.issues) for (const [kind, targets] of [['fact', issue.required_fact_ids], ['date', issue.required_date_roles]] as const) {
    for (const id of targets) {
      const description = kind === 'fact' ? plan.facts.find(f => f.id === id)!.description : id;
      const matches = previous.filter(r => !used.has(r.requirement_id) && r.target.kind === kind
        && (r.issue_id === issue.id || normal(r.issue_question) === normal(issue.question))
        && (r.target.id === id || kind === 'fact' && normal(r.description) === normal(description)));
      const old = matches.length === 1 ? matches[0] : undefined, profile = registeredProfile(issue, kind, id);
      if (old) used.add(old.requirement_id);
      out.push({ requirement_id: old?.requirement_id ?? randomUUID(), revision, issue_id: issue.id, issue_question: issue.question,
        target: { kind, id }, description, scope_status: 'current', status: profile ? 'required' : 'unresolved',
        ...(profile ? { profile_key: profile, basis: { kind: 'profile', profile_key: profile } as const } : {}),
        reason: profile ? '서버가 등록한 사건 연혁 확인 항목입니다.' : '법적 필요성은 원문과 질문 범위로 평가해야 합니다.' });
    }
  }
  // Renaming/deleting a declaration cannot silently discharge an unresolved condition.
  for (const old of previous.filter(r => !used.has(r.requirement_id))) out.push({ ...old, revision,
    scope_status: 'unmapped', status: 'unresolved', basis: undefined,
    reason: '계획 변경으로 연결이 끊겼습니다. 현재 질문 범위와 원문으로 철회·재연결 이유를 검토하세요.' });
  return out;
}
export function requirementMissing(r: Requirement, plan: Plan) {
  if (r.scope_status === 'unmapped') return true;
  return r.target.kind === 'fact' ? plan.facts.find(f => f.id === r.target.id)?.status !== 'provided'
    : !plan.event_dates.some(d => d.role === r.target.id && d.basis === 'provided' && d.precision === 'day');
}
export function effectiveRequirements(records: Requirement[], plan: Plan, revision: number, evidence: ResearchEvidence[]) {
  return records.map(r => {
    if (r.status === 'unresolved') return r;
    const basis = r.basis;
    const e = basis?.kind === 'source' ? evidence.find(e => e.evidence_id === basis.evidence_id && e.revision === revision) : undefined;
    const p = basis?.kind === 'source' ? e?.passages.find(p => p.passage_id === basis.passage_id) : undefined;
    const scopeId = r.assessment_issue_id ?? r.issue_id;
    const valid = r.revision === revision && (basis?.kind === 'profile'
      ? plan.issues.some(i => i.id === r.issue_id && registeredProfile(i, r.target.kind, r.target.id) === basis.profile_key)
      : basis?.kind === 'source' && e?.body_scope === 'body_returned' && e.issue_ids.includes(scopeId)
        && e.document_version === basis.version && p?.body_scope === 'body_returned'
        && digest(p.text.slice(basis.start, basis.end)) === basis.quote_hash);
    return valid ? r : { ...r, status: 'unresolved' as const, reason: '필요성 근거가 현재 revision·원문·쟁점에 유효하지 않습니다.' };
  });
}

export function assessRequirements(records: Requirement[], input: RequirementAssessmentInput[], plan: Plan,
  revision: number, evidence: ResearchEvidence[]): Requirement[] {
  if (new Set(input.map(i => i.requirement_id)).size !== input.length) throw new ServiceError(400, 'REQUIREMENT_DUPLICATE');
  const out = structuredClone(records);
  for (const change of input) {
    const r = out.find(r => r.requirement_id === change.requirement_id);
    if (!r || r.revision !== revision) throw new ServiceError(400, 'REQUIREMENT_NOT_FOUND');
    const scope = change.scope_issue_id ?? r.issue_id;
    if (!plan.issues.some(i => i.id === scope) || r.scope_status === 'current' && scope !== r.issue_id)
      throw new ServiceError(400, 'REQUIREMENT_SCOPE_INVALID');
    if (r.profile_key && r.scope_status === 'current' && change.status !== 'required') throw new ServiceError(409, 'REQUIREMENT_PROFILE_REQUIRED');
    if (r.scope_status === 'unmapped' && (change.status !== 'not_required_for_question' || !change.scope_issue_id))
      throw new ServiceError(409, 'REQUIREMENT_SCOPE_RECONCILIATION_REQUIRED');
    let basis: Requirement['basis'];
    if (change.basis?.kind === 'profile') {
      if (!r.profile_key || r.profile_key !== change.basis.profile_key || change.status !== 'required')
        throw new ServiceError(400, 'REQUIREMENT_PROFILE_INVALID');
      basis = { kind: 'profile', profile_key: r.profile_key };
    } else if (change.basis?.kind === 'source') {
      const { citation, version } = change.basis, e = evidence.find(e => e.evidence_id === citation.evidence_id && e.revision === revision);
      if (!e) throw new ServiceError(409, 'REQUIREMENT_EVIDENCE_NOT_CURRENT');
      if (e.body_scope !== 'body_returned' || e.units.some(u => u.source_access !== 'available' || u.body_scope !== 'body_returned')
        || e.identity?.status !== 'observed') throw new ServiceError(409, 'REQUIREMENT_SOURCE_INCOMPLETE');
      if (!e.issue_ids.includes(scope)) throw new ServiceError(400, 'REQUIREMENT_SOURCE_SCOPE');
      if (version === 'unknown' || version !== e.document_version) throw new ServiceError(400, 'REQUIREMENT_VERSION_MISMATCH');
      const p = e.passages.find(p => p.passage_id === citation.passage_id), start = p?.text.indexOf(citation.quote) ?? -1;
      if (!p || p.body_scope !== 'body_returned' || start < 0 || citation.relation !== 'direct') throw new ServiceError(400, 'REQUIREMENT_CITATION_INVALID');
      basis = { kind: 'source', evidence_id: e.evidence_id, passage_id: p.passage_id, version,
        start, end: start + citation.quote.length, quote_hash: digest(citation.quote) };
    }
    if (change.status !== 'unresolved' && !basis) throw new ServiceError(400, 'REQUIREMENT_BASIS_REQUIRED');
    Object.assign(r, { status: change.status, basis, reason: change.reason, assessment_issue_id: scope,
      scope_status: r.scope_status === 'unmapped' ? 'withdrawn' : r.scope_status });
  }
  return out;
}
