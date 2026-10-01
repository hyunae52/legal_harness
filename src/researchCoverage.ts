import { digest } from './contracts.js';
import type { Plan, IssueAnalysisInput } from './researchContracts.js';
import type { ResearchAttempt, ResearchEvidence } from './researchEvidence.js';
import { documentKey, type SourceIdentity } from './researchIdentity.js';
import { normalizedSearch, normalizeQuery, type SearchFamily, type SearchHit } from './researchSearch.js';

export const coveragePolicy = 'research-v7-scope-promotion-20261002';
export interface Candidate {
  candidate_id: string; key: string; identity: SourceIdentity; title: string; related_laws: string;
  discovered_in: string[]; issue_ids: string[]; first_revision: number; last_revision: number;
  state: 'triage_pending' | 'reassessment_required' | 'out_of_current_scope';
  discovery_role?: 'primary' | 'subsequent' | 'exploratory'; statute?: SearchHit['statute'];
}
export interface CandidateLedger { candidates: Candidate[]; overflow: boolean }
export interface ResearchStep { tool: string; arguments: Record<string, unknown>; purpose: ResearchEvidence['purpose']; issue_ids: string[]; obligation_id: string }
export interface Obligation {
  obligation_id: string; issue_id: string; family: SearchFamily; purpose: 'neutral' | 'counter' | 'subsequent' | 'amendment';
  anchor_key: string; document_key?: string; recipe_id: string;
  channel?: string;
  status: 'not_attempted' | 'failed' | 'partial' | 'completed_with_candidates' | 'completed_no_candidate';
  attempt_ids: string[]; candidate_ids: string[]; next_step: ResearchStep | null; gap?: string;
}
export interface Coverage {
  policy_version: string; revision: number; obligations: Obligation[];
  candidates: Candidate[]; incomplete_attempts: ResearchAttempt[]; effective_evidence: ResearchEvidence[];
  resolved_attempts: { attempt_id: string; resolved_by_attempt_id: string }[];
  preparation_gaps: { issue_id: string; code: string }[]; candidate_overflow: boolean;
  exploratory_gaps: ResearchAttempt[];
}
const complete = (o: Obligation) => o.status === 'completed_with_candidates' || o.status === 'completed_no_candidate';
export const isCoverageComplete = complete;
export const isTaxLaw = (name: string) => /^(?:소득세법|법인세법|부가가치세법|상속세 및 증여세법|조세특례제한법|국세기본법|국세징수법|종합부동산세법|지방세법|지방세기본법|지방세특례제한법)(?: 시행령| 시행규칙)?$/.test(name);
const temporaryHomes = (plan: Plan, issue: Plan['issues'][number]) => issue.profile === 'temporary_two_homes'
  || /일시적\s*2주택|마지막\s*2주택/.test(issue.question + (plan.issues.length === 1 ? plan.query : ''));

export function addCandidates(ledger: CandidateLedger, attempt: ResearchAttempt, max = 128): CandidateLedger {
  const next = structuredClone(ledger);
  for (const hit of attempt.search?.hits ?? []) {
    const role = attempt.search_scope === 'exploratory' ? 'exploratory' : attempt.obligation_purpose === 'subsequent' ? 'subsequent' : 'primary';
    const current = next.candidates.find(c => c.key === hit.key);
    if (current) {
      if (!current.discovered_in.includes(attempt.attempt_id)) current.discovered_in.push(attempt.attempt_id);
      current.issue_ids = [...new Set([...current.issue_ids, ...attempt.issue_ids])]; current.last_revision = attempt.revision;
      if (role === 'primary' || current.discovery_role === 'exploratory') current.discovery_role = role;
      // Conflicting source observations cannot silently overwrite the original identity.
      if (current.identity.kind !== hit.identity.kind || current.identity.document_number !== hit.identity.document_number) current.identity.status = 'conflict';
    } else if (next.candidates.length < max) next.candidates.push({ candidate_id: 'candidate-' + digest(hit.key).slice(0, 24),
      key: hit.key, identity: hit.identity, title: hit.title, related_laws: hit.related_laws, discovered_in: [attempt.attempt_id],
      issue_ids: [...attempt.issue_ids], first_revision: attempt.revision, last_revision: attempt.revision, state: 'triage_pending', discovery_role: role,
      ...(hit.statute ? { statute: hit.statute } : {}) });
    else next.overflow = true;
  }
  return next;
}
export function carryCandidates(ledger: CandidateLedger, oldPlan: Plan, plan: Plan): CandidateLedger {
  const next = structuredClone(ledger);
  for (const candidate of next.candidates) {
    const mapped = plan.issues.filter(i => candidate.issue_ids.includes(i.id)
      || oldPlan.issues.some(old => candidate.issue_ids.includes(old.id) && normalizeQuery(old.question) === normalizeQuery(i.question))).map(i => i.id);
    candidate.state = mapped.length ? 'reassessment_required' : 'out_of_current_scope';
    // An ID edit cannot erase a discovery. Unmapped history remains an explicit scope gap.
    if (mapped.length) candidate.issue_ids = [...new Set([...candidate.issue_ids, ...mapped])];
  }
  return next;
}
export function candidateBody(candidate: Candidate, evidence: ResearchEvidence[]) {
  return evidence.filter(e => e.identity && (documentKey(e.identity) === candidate.key || (candidate.statute
    && e.tool === 'get_law_text' && e.document_id === candidate.statute.mst && e.statute_anchor?.name === candidate.statute.name
    && (!candidate.statute.effective_date || e.document_version === candidate.statute.effective_date))) && e.body_scope === 'body_returned'
    && e.identity.status === 'observed' && candidate.identity.status !== 'conflict'
    && (!candidate.identity.document_number || candidate.identity.document_number === e.identity.document_number));
}
function bodyRequest(candidate: Candidate, coverage: Coverage): Omit<ResearchStep, 'obligation_id'> | null {
  const i = candidate.identity;
  if (i.document_id === 'unknown') return null;
  const articles = coverage.effective_evidence.flatMap(e => candidate.statute && e.statute_anchor?.name === candidate.statute.name ? e.statute_anchor.articles : []);
  const request = candidate.statute ? { tool: 'get_law_text', arguments: { mst: candidate.statute.mst, ...(articles.length ? { jo: [...new Set(articles)].join(',') } : {}) } }
    : i.namespace === 'nts' ? { tool: 'get_tax_document', arguments: { ntst_dcm_id: i.document_id, include_full_text: true, detail: 'full', body_limit: 200000 } }
    : i.namespace === 'moleg' && i.family === 'precedent' ? { tool: 'get_decision_text', arguments: { domain: 'precedent', id: i.document_id, full: true } }
    : i.namespace === 'olta' && i.document_number ? { tool: 'lookup_local_tax_document', arguments: { document_number: i.document_number } } : null;
  return request ? { ...request, issue_ids: candidate.issue_ids, purpose: 'context' } : null;
}
export function nextCandidateStep(coverage: Coverage): ResearchStep | null {
  const priority = (c: Candidate) => c.identity.kind === 'supreme_court' ? 0 : c.statute ? 1 : c.discovery_role === 'subsequent' ? 3 : 2;
  for (const c of [...coverage.candidates].sort((a, b) => priority(a) - priority(b))) {
    if (c.discovery_role === 'exploratory' || c.state === 'out_of_current_scope' || candidateBody(c, coverage.effective_evidence).length) continue;
    const request = bodyRequest(c, coverage);
    if (request) return { ...request, obligation_id: c.candidate_id };
  }
  return null;
}

/** One observed query may cover several issues only when their predeclared source scope is identical. */
export function nextRequiredResearchStep(coverage: Coverage): ResearchStep | null {
  const first = coverage.obligations.find(o => o.next_step);
  if (!first?.next_step) return nextCandidateStep(coverage);
  const step = first.next_step;
  const same = coverage.obligations.filter(o => o.next_step && o.anchor_key === first.anchor_key && o.family === first.family
    && o.purpose === first.purpose && o.channel === first.channel && o.next_step.tool === step.tool
    && o.next_step.purpose === step.purpose && digest(o.next_step.arguments) === digest(step.arguments));
  return { ...step, issue_ids: [...new Set(same.flatMap(o => o.next_step!.issue_ids))] };
}

/** One current-revision calculation shared by reasoning, applicability and scope completion. */
export function researchCoverage(plan: Plan, revision: number, evidence: ResearchEvidence[], attempts: ResearchAttempt[],
  storedLedger?: CandidateLedger, policy = coveragePolicy, coreEvidenceIds: string[] = []): Coverage {
  const current = attempts.filter(a => a.revision === revision), currentEvidence = evidence.filter(e => e.revision === revision);
  let ledger = storedLedger ?? { candidates: [], overflow: false };
  if (!storedLedger) for (const a of attempts) ledger = addCandidates(ledger, a);
  const resolved: Coverage['resolved_attempts'] = [];
  const superseded = (a: ResearchAttempt) => current.find(b => b.attempt_id !== a.attempt_id && b.purpose === a.purpose
    && digest([...b.issue_ids].sort()) === digest([...a.issue_ids].sort()) && ['completed', 'empty'].includes(b.status)
    && ((b.tool === a.tool && b.arguments_hash === a.arguments_hash && (b.search ? b.search.status === 'complete'
      : (b.evidence_ids ?? [b.evidence_id]).some(id => currentEvidence.some(e => e.evidence_id === id && e.body_scope === 'body_returned'))))
      || (a.requirement && !a.search && !b.search && (b.evidence_ids ?? [b.evidence_id]).some(id => currentEvidence.some(e => e.evidence_id === id
        && e.body_scope === 'body_returned' && e.identity?.status === 'observed' && documentKey(e.identity) === a.requirement!.document_key
        && (!a.requirement!.document_number || e.identity.document_number === a.requirement!.document_number)
        && e.document_version !== 'unknown' && (!a.requirement!.document_version || e.document_version.replace(/-/g, '') === a.requirement!.document_version.replace(/-/g, ''))
        && e.units.some(u => u.role === a.requirement!.role && u.date === a.requirement!.date && u.body_scope === 'body_returned' && u.source_access === 'available'))))));
  const incomplete = current.filter(a => {
    if (a.search_scope === 'exploratory') return false;
    if (a.status === 'pending') return true;
    if (a.status !== 'failed' && (a.search ? a.search.status === 'complete' : a.status !== 'empty')) return false;
    const b = superseded(a); if (b) { resolved.push({ attempt_id: a.attempt_id, resolved_by_attempt_id: b.attempt_id }); return false; }
    return true;
  });
  const effectiveEvidence = currentEvidence.filter(e => !['partial', 'unknown'].includes(e.body_scope)
    || !currentEvidence.some(n => n !== e && n.body_scope === 'body_returned' && n.identity && e.identity && documentKey(e.identity) && documentKey(n.identity) === documentKey(e.identity)
      && n.document_version !== 'unknown' && n.document_version === e.document_version && digest([...n.issue_ids].sort()) === digest([...e.issue_ids].sort())));
  const out: Coverage = { policy_version: policy, revision, candidates: ledger.candidates, candidate_overflow: ledger.overflow,
    obligations: [], incomplete_attempts: incomplete, effective_evidence: effectiveEvidence, resolved_attempts: resolved, preparation_gaps: [],
    exploratory_gaps: current.filter(a => a.search_scope === 'exploratory' && (a.status === 'failed' || a.search?.status !== 'complete' || a.search?.has_more)) };
  for (const issue of plan.issues) {
    const anchors = [...new Map(currentEvidence.filter(e => e.issue_ids.includes(issue.id) && e.statute_anchor && e.body_scope === 'body_returned')
      .map(e => [digest({ name: e.statute_anchor!.name, articles: e.statute_anchor!.articles }), e.statute_anchor!])).values()];
    if (!anchors.length) out.preparation_gaps.push({ issue_id: issue.id, code: 'ANCHOR_PENDING' });
    for (const anchor of anchors) {
      const anchorKey = digest({ name: anchor.name, articles: anchor.articles }), tax = isTaxLaw(anchor.name), local = anchor.name.startsWith('지방세');
      // A legal-version subissue about the exact same observed statute/article does not
      // become an unrelated whole-article investigation just because its issue label differs.
      // Separate statutes (e.g. an independent VAT issue) never inherit this context.
      const sharedTopic = currentEvidence.some(e => e.statute_anchor && e.body_scope === 'body_returned'
        && digest({ name: e.statute_anchor.name, articles: e.statute_anchor.articles }) === anchorKey
        && plan.issues.some(other => e.issue_ids.includes(other.id) && temporaryHomes(plan, other)));
      const article = anchor.articles.join(' '), topic = temporaryHomes(plan, issue) || sharedTopic ? '일시적 2주택' : '';
      const families: SearchFamily[] = tax ? ['court', 'administrative', 'adjudication'] : ['court'];
      const recipe = (family: SearchFamily, purpose: Obligation['purpose'], target?: ResearchEvidence, channel?: string) => {
        const key = target?.identity ? documentKey(target.identity) ?? target.evidence_id : undefined;
        const number = target?.identity?.document_number;
        if (target && !number) { out.preparation_gaps.push({ issue_id: issue.id, code: 'SUBSEQUENT_IDENTITY_PENDING' }); return; }
        let tool: string, args: Record<string, unknown>, broad: Record<string, unknown>;
        if (family === 'statute') {
          tool = 'search_law'; args = { query: anchor.name, display: 50 }; broad = args;
        } else if (tax && !local && (family !== 'court' || target || channel === 'nts')) {
          tool = family === 'administrative' ? 'search_tax_interpretations' : 'search_tax_decisions';
          const query = number ? number + ' 변경' : purpose === 'counter' ? (topic ? '일시적 2주택 신규 주택 취득 선후' : '적용 제외') : topic ? '일시적 2주택 비과세 취득 선후' : '요건';
          args = { query, ...(number ? {} : { law: anchor.name, article }), type: family === 'court' ? 'court' : family === 'adjudication' ? channel ?? 'tribunal' : 'all', page: 1, limit: 20, sort: 'latest' };
          broad = { ...args, query: number ?? (purpose === 'counter' ? (topic ? '신규주택 취득' : '예외') : anchor.name), ...(number ? {} : { law: anchor.name, article }) };
        } else if (family === 'administrative' && local) {
          tool = 'search_local_tax_interpretations'; args = { query: `${anchor.name} ${article} ${topic || '요건'}`, type: 'all', page: 1, limit: 10 };
          broad = { ...args, query: `${anchor.name} ${article}` };
        } else if (family === 'adjudication') {
          // This provider has no auditable page/filter adapter yet; the obligation stays explicit.
          out.preparation_gaps.push({ issue_id: issue.id, code: 'RECIPE_UNAVAILABLE_LOCAL_ADJUDICATION' }); return;
        } else {
          tool = 'search_decisions';
          args = { domain: 'precedent', query: number ? number + ' 변경' : `${anchor.name} ${article}${topic ? purpose === 'counter' ? ' 신규 주택 3주택' : ' 신규 주택' : purpose === 'counter' ? ' 적용 제외' : ''}`, page: 1, display: 20, sort: 'ddes', options: { search: 2, ...(tax ? { court: '대법원' } : {}) } };
          broad = { ...args, query: number ?? `${anchor.name} ${article} ${purpose === 'counter' ? '예외' : '요건'}` };
        }
        const obligation: Obligation = { obligation_id: 'ob-' + digest({ policy, issue: issue.id, anchorKey, family, purpose, key, channel }).slice(0, 24), issue_id: issue.id,
          family, purpose, channel, anchor_key: anchorKey, ...(key ? { document_key: key } : {}), recipe_id: 'criterion-v2', status: 'not_attempted', attempt_ids: [], candidate_ids: [], next_step: null };
        const requestPurpose = purpose === 'counter' ? 'counter' : purpose === 'amendment' ? 'timing' : 'context';
        const pages = (parameters: Record<string, unknown>, broadened: boolean): boolean => {
          for (let page = 1; page <= (family === 'statute' ? 1 : 2); page++) {
            const queryArgs = family === 'statute' ? parameters : { ...parameters, page }, signature = normalizedSearch(tool, queryArgs).signature;
            const matching = current.filter(a => a.tool === tool && a.issue_ids.includes(issue.id) && a.search?.signature === signature
              && (purpose !== 'counter' || a.purpose === 'counter'));
            const accepted = [...matching].reverse().find(a => a.search?.status === 'complete' && ['completed', 'empty'].includes(a.status));
            if (!accepted) {
              const last = matching.at(-1); obligation.status = last ? last.status === 'failed' ? 'failed' : 'partial' : 'not_attempted';
              obligation.gap = last?.error_code ?? last?.search?.error_code;
              obligation.next_step = { tool, arguments: queryArgs, purpose: requestPurpose, issue_ids: [issue.id], obligation_id: obligation.obligation_id };
              return false;
            }
            obligation.attempt_ids.push(accepted.attempt_id);
            for (const h of accepted.search!.hits) {
              if (h.key === key) continue;
              const c = ledger.candidates.find(c => c.key === h.key);
              if (c && !obligation.candidate_ids.includes(c.candidate_id)) obligation.candidate_ids.push(c.candidate_id);
            }
            if (accepted.search!.total === 0 && !broadened && digest(parameters) !== digest(broad)) return pages(broad, true);
            if (!accepted.search!.has_more) return true;
          }
          obligation.status = 'partial'; obligation.gap = 'PAGE_LIMIT_REACHED'; return false;
        };
        if (pages(args, false)) obligation.status = obligation.candidate_ids.length ? 'completed_with_candidates' : 'completed_no_candidate';
        out.obligations.push(obligation);
      };
      recipe('court', 'neutral'); recipe('court', 'counter');
      if (tax && !local) recipe('court', 'neutral', undefined, 'nts');
      for (const family of families.filter(f => f !== 'court')) {
        recipe(family, 'neutral', undefined, family === 'adjudication' ? 'tribunal' : undefined);
        if (family === 'adjudication' && !local) recipe(family, 'neutral', undefined, 'review');
      }
      recipe('statute', 'amendment');
      const seen = new Set<string>();
      for (const e of currentEvidence.filter(e => e.issue_ids.includes(issue.id) && e.identity && e.identity.family !== 'statute' && e.body_scope !== 'discovery_only')) {
        const key = documentKey(e.identity!) ?? e.evidence_id;
        if (seen.has(key)) continue; seen.add(key);
        const candidate = ledger.candidates.find(c => candidateBody(c, [e]).length);
        // Follow-up discoveries are inspected, but only promoted legal grounds open another search generation.
        if (candidate && candidate.discovery_role !== undefined && candidate.discovery_role !== 'primary'
          && e.purpose !== 'support' && !coreEvidenceIds.includes(e.evidence_id)) continue;
        const kind = e.identity!.kind;
        if (kind === 'tax_appeal') {
          const type = e.identity!.observations.find(o => o.field === 'documentType')?.value ?? '';
          if (!/심판|심사/.test(type)) out.preparation_gaps.push({ issue_id: issue.id, code: 'SUBSEQUENT_ADJUDICATION_TYPE_PENDING' });
          else recipe('adjudication', 'subsequent', e, /심판/.test(type) ? 'tribunal' : 'review');
          recipe('court', 'subsequent', e);
        } else recipe(kind === 'administrative_interpretation' ? 'administrative' : 'court', 'subsequent', e);
      }
    }
  }
  return out;
}
export function candidateGaps(coverage: Coverage, analysis: IssueAnalysisInput): { code: string; detail: string }[] {
  const gaps: { code: string; detail: string }[] = [];
  if (coverage.candidate_overflow) gaps.push({ code: 'CANDIDATE_OVERFLOW', detail: '후보 원장 용량 초과; 조사 완료 아님' });
  for (const c of coverage.candidates) {
    if (c.discovery_role === 'exploratory' && !analysis.legal_basis?.authorities.some(a => candidateBody(c, coverage.effective_evidence).some(e => e.evidence_id === a.evidence_id))) continue;
    if (c.state === 'out_of_current_scope') { gaps.push({ code: 'CANDIDATE_SCOPE_CHANGED', detail: c.candidate_id }); continue; }
    if (!c.issue_ids.includes(analysis.issue_id)) continue;
    const bodies = candidateBody(c, coverage.effective_evidence);
    if (!bodies.length) { gaps.push({ code: 'CANDIDATE_BODY_REQUIRED', detail: c.candidate_id }); continue; }
    if (c.statute) {
      if (!analysis.legal_basis?.statutes.some(s => bodies.some(e => e.evidence_id === s.citation.evidence_id))
        || !analysis.legal_basis.temporal_application.citations.some(c => bodies.some(e => e.evidence_id === c.evidence_id)))
        gaps.push({ code: 'AMENDMENT_VERSION_REVIEW_REQUIRED', detail: c.candidate_id });
      continue;
    }
    const review = analysis.legal_basis?.authorities.find(a => bodies.some(e => e.evidence_id === a.evidence_id));
    if (!review || review.disposition === 'unresolved') gaps.push({ code: 'CANDIDATE_REVIEW_REQUIRED', detail: c.candidate_id });
  }
  return gaps;
}
