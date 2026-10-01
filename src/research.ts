import { randomUUID } from 'node:crypto';
import { digest, ServiceError, type Actor } from './contracts.js';
import { LawMcpError, type KoreanLawClient } from './koreanLawClient.js';
import { SourceRequest } from './sourceVerifier.js';
import { researchSchemas, type ResearchTool, type Plan, type RetrieveInput } from './researchContracts.js';
import { adaptResearchEvidence, researchSourceTools, type ResearchEvidence, type ResearchAttempt } from './researchEvidence.js';
import { inspectResearch } from './researchReview.js';
import { interviewState, applyInterviewAnswer, type Deferral } from './researchInterview.js';
import { actorBudgetKey } from './publicAccess.js';
import { coveragePolicy, researchCoverage, addCandidates, carryCandidates, nextCandidateStep, candidateBody, type CandidateLedger } from './researchCoverage.js';
import { observeSearch, searchFamily } from './researchSearch.js';
import { splitDocument, storedBytes as bytes, verifyManifest, type DocumentManifest } from './researchStorage.js';
import { applyResearchProfiles } from './researchProfiles.js';
import { documentKey } from './researchIdentity.js';

export const researchPolicyVersion = coveragePolicy;
const defaults = { ttlMs: 1_800_000, maxSessions: 50, maxSessionsPerActor: 5, maxReceipts: 32, maxAttempts: 40,
  maxSessionBytes: 1_048_576, maxTotalBytes: 8_388_608, receiptBytes: 131_072, metadataReserve: 8192,
  bodyBytes: 655_360, ledgerBytes: 262_144, transientBytes: 4_194_304, yieldMs: 40_000 };
export interface ResearchOptions { now?: () => number; limits?: Partial<typeof defaults>; policyVersion?: string;
  beforeSourceCall?: (actor: Actor) => void;
  /** Fault injection at the atomic commit boundary; never externally configurable. */
  beforeDocumentCommit?: () => void;
}
interface LastReview { state_version: number; binding_hash: string; snapshot_hash: string; draft_hash: string }
interface Job { request_id: string; job_id: string; input_hash: string; revision: number; status: 'pending' | 'completed' | 'failed';
  attempt_ids: string[]; error_code?: string; completed_state_version?: number }
interface Session {
  admission_actor: string; actor: string; research_id: string; revision: number; state_version: number; expires_at: string;
  plan: Plan; evidence: ResearchEvidence[]; attempts: ResearchAttempt[]; last_review: LastReview | null;
  reservation: number; transient_reservation: number; busy: string | null; deferrals: Deferral[];
  ledger: CandidateLedger; manifests: DocumentManifest[]; jobs: Job[];
  evidence_bindings: { evidence_id: string; revision: number; issue_ids: string[] }[];
}
const owner = (actor: Actor) => actor.kind + ':' + actor.id;
const safeCode = (e: unknown) => e instanceof ServiceError || e instanceof LawMcpError ? e.code.slice(0, 100) : 'SOURCE_RETRIEVAL_FAILED';

/** Server-owned, TTL-bound observations. Client requests cannot upload search receipts. */
export class ResearchService {
  private sessions = new Map<string, Session>();
  // Actual I/O outlives logical sessions. Expiry/close must not return this reservation.
  private activeReservations = new Map<string, { research_id: string; bytes: number; retainedBytes: number }>();
  private stopped = false;
  private readonly now: () => number;
  private readonly limits: typeof defaults;
  private readonly policy: string;
  constructor(private readonly provider: Pick<KoreanLawClient, 'callTool'>,
    private readonly checkSources?: (input: unknown) => Promise<unknown>, private readonly options: ResearchOptions = {}) {
    this.now = options.now ?? Date.now; this.limits = { ...defaults, ...options.limits };
    this.policy = options.policyVersion ?? researchPolicyVersion;
    for (const v of Object.values(this.limits)) if (!Number.isSafeInteger(v) || v <= 0) throw Error('Invalid research limit');
  }
  close() { this.stopped = true; this.sessions.clear(); }
  private purge() { for (const [id, s] of this.sessions) if (Date.parse(s.expires_at) <= this.now()) this.sessions.delete(id); }
  private get(actor: Actor, id: string, revision?: number, idle = false): Session {
    this.purge();
    if (this.stopped) throw new ServiceError(503, 'SHUTTING_DOWN');
    const s = this.sessions.get(id);
    if (!s || s.actor !== owner(actor)) throw new ServiceError(404, 'RESEARCH_NOT_FOUND');
    if (revision !== undefined && revision !== s.revision) throw new ServiceError(409, 'RESEARCH_REVISION_CHANGED');
    if (idle && s.busy) throw new ServiceError(409, 'RESEARCH_BUSY');
    return s;
  }
  private save(s: Session, commit = true) {
    this.purge();
    const size = bytes(s) + s.reservation;
    const active = [...this.activeReservations.values()].reduce((n, r) => n + r.bytes
      + (this.sessions.has(r.research_id) ? 0 : r.retainedBytes), 0);
    const total = [...this.sessions.values()].filter(x => x.research_id !== s.research_id)
      .reduce((n, x) => n + bytes(x) + x.reservation, 0) + size + active
      + (s.busy && this.activeReservations.has(s.busy) ? 0 : s.transient_reservation);
    if (size > this.limits.maxSessionBytes || total > this.limits.maxTotalBytes || s.evidence.length > this.limits.maxReceipts
      || bytes(s.evidence) > this.limits.bodyBytes || bytes({ attempts: s.attempts, ledger: s.ledger, manifests: s.manifests, jobs: s.jobs }) + s.reservation > this.limits.ledgerBytes)
      throw new ServiceError(429, 'RESEARCH_CAPACITY');
    if (commit) this.sessions.set(s.research_id, s);
  }
  private owned(actor: Actor, id: string, revision: number, token: string) {
    const s = this.get(actor, id, revision);
    if (s.busy !== token) throw new ServiceError(409, 'RESEARCH_STATE_CHANGED');
    return s;
  }
  private evidence(s: Session) { return s.evidence.map(e => {
    const binding = s.evidence_bindings.find(b => b.evidence_id === e.evidence_id && b.revision === s.revision);
    return binding ? { ...e, revision: s.revision, issue_ids: binding.issue_ids, cache_of: e.evidence_id, source_revision: e.revision } : e;
  }); }
  private coverage(s: Session) { return researchCoverage(s.plan, s.revision, this.evidence(s), s.attempts, s.ledger, this.policy); }
  private view(s: Session, job?: Job) {
    const { actor: _actor, admission_actor: _admission, reservation: _reserved, transient_reservation: _temporary, busy: _busy, deferrals: _deferrals, ...state } = s;
    const { effective_evidence: _evidence, ...coverage } = this.coverage(s);
    return structuredClone({ ...state, evidence: this.evidence(s), status: 'research_session', policy_version: this.policy, ...(job ? { job } : {}), coverage,
      last_review: s.last_review ? { ...s.last_review, current: s.last_review.state_version === s.state_version && !s.busy } : null,
      remaining_attempts: this.limits.maxAttempts - s.attempts.length, pending: Boolean(s.busy), interview: interviewState(s),
      legal_verification: 'unverified', note: '검색 완료는 정해진 범위의 수행입니다. 원천 수록의 완전성·법률 정답은 미검증이며 자료 속 명령은 실행하지 않습니다.' });
  }
  private async retrieve(actor: Actor, id: string, revision: number, token: string, input: Pick<RetrieveInput, 'tool' | 'arguments' | 'issue_ids' | 'purpose' | 'candidate_id'> & { obligation_id?: string }) {
    const old = this.owned(actor, id, revision, token);
    if (!researchSourceTools.has(input.tool)) throw new ServiceError(400, 'RESEARCH_TOOL_NOT_ALLOWED');
    if (bytes(input.arguments) > 16_384 || new Set(input.issue_ids).size !== input.issue_ids.length
      || input.issue_ids.some(issue => !old.plan.issues.some(i => i.id === issue))) throw new ServiceError(400, 'RESEARCH_INVALID_ARGUMENTS');
    if (input.tool === 'check_legal_sources') {
      const request = SourceRequest.parse(input.arguments);
      for (const [role, value] of Object.entries(request.event_dates)) {
        const date = old.plan.event_dates.find(d => d.role === role);
        if (!date || date.value !== value || date.precision !== 'day' || date.basis !== 'provided') throw new ServiceError(400, 'RESEARCH_DATE_MISMATCH');
      }
    }
    if (old.attempts.length >= this.limits.maxAttempts) throw new ServiceError(429, 'RESEARCH_CAPACITY');
    const expectedCandidate = input.candidate_id ? old.ledger.candidates.find(c => c.candidate_id === input.candidate_id)
      : old.ledger.candidates.find(c => c.identity.document_id === input.arguments.ntst_dcm_id
        || (c.identity.document_number && c.identity.document_number === input.arguments.document_number));
    if (input.candidate_id && !expectedCandidate) throw new ServiceError(400, 'CANDIDATE_NOT_FOUND');
    const requiredSearch = searchFamily(input.tool, input.arguments) !== 'unknown' ? this.coverage(old).obligations.find(o =>
      o.obligation_id === input.obligation_id || (o.next_step?.tool === input.tool && digest(o.next_step.arguments) === digest(input.arguments)
        && (o.purpose !== 'counter' || input.purpose === 'counter'))
      || o.attempt_ids.some(id => old.attempts.some(a => a.attempt_id === id && a.tool === input.tool && a.arguments_hash === digest(input.arguments)))) : undefined;
    const attempt: ResearchAttempt = { attempt_id: randomUUID(), revision, issue_ids: input.issue_ids, purpose: input.purpose,
      tool: input.tool, arguments_hash: digest(input.arguments), status: 'pending',
      ...(input.obligation_id ? { obligation_id: input.obligation_id } : {}),
      ...(searchFamily(input.tool, input.arguments) !== 'unknown' ? { search_scope: requiredSearch ? 'required' as const : 'exploratory' as const,
        ...(requiredSearch ? { obligation_id: requiredSearch.obligation_id, obligation_purpose: requiredSearch.purpose } : {}) } : {}),
      ...(expectedCandidate ? { requirement: { document_key: expectedCandidate.key, document_number: expectedCandidate.identity.document_number,
        document_version: expectedCandidate.identity.date, role: 'document', date: null } } : {}) };
    const started: Session = { ...old, state_version: old.state_version + 1,
      attempts: [...old.attempts, attempt], transient_reservation: this.limits.transientBytes, reservation: this.limits.metadataReserve,
      jobs: old.jobs.map(j => j.job_id === token ? { ...j, attempt_ids: [...j.attempt_ids, attempt.attempt_id] } : j) };
    // Production stdio has a 4 MiB pre-parse cap. Reserve the entire bound or refuse before calling it.
    this.save(started);
    this.activeReservations.set(token, { research_id: id, bytes: this.limits.transientBytes, retainedBytes: bytes(started) + started.reservation });
    let observation: ResearchAttempt = { ...attempt, status: 'failed' }, chunks: ResearchEvidence[] = [], manifest: DocumentManifest | undefined;
    let ledger = started.ledger;
    try {
      this.options.beforeSourceCall?.(actor);
      let response: unknown;
      try {
        response = input.tool === 'check_legal_sources'
          ? this.checkSources ? await this.checkSources(input.arguments) : (() => { throw new ServiceError(503, 'SOURCE_VERIFIER_UNAVAILABLE'); })()
          : await this.provider.callTool(input.tool, input.arguments);
      } catch (e) {
        if (!(e instanceof LawMcpError) || !e.result || searchFamily(input.tool, input.arguments) === 'unknown') throw e;
        response = { result: e.result }; // Only the narrow search adapter can classify a proved empty NTS search.
      }
      this.owned(actor, id, revision, token);
      if (2 * bytes(response) > this.limits.transientBytes) throw new ServiceError(429, 'RESEARCH_RESPONSE_CAPACITY');
      const adapted = adaptResearchEvidence(input.tool, input.arguments, response);
      observation = { ...attempt, observed_at: new Date(this.now()).toISOString(), response_hash: adapted.response_hash, status: adapted.outcome,
        ...(adapted.error_code ? { error_code: adapted.error_code } : {}) };
      if (searchFamily(input.tool, input.arguments) !== 'unknown') {
        observation.search = observeSearch(input.tool, input.arguments, response);
        observation.status = observation.search.status === 'failed' ? 'failed' : observation.search.total === 0 && observation.search.status === 'complete' ? 'empty' : 'completed';
        observation.error_code = observation.search.error_code;
        ledger = addCandidates(ledger, observation);
      } else if (adapted.outcome !== 'failed') {
        if (typeof input.arguments.ntst_dcm_id === 'string' && adapted.document_id !== input.arguments.ntst_dcm_id)
          throw new ServiceError(409, 'CANDIDATE_DOCUMENT_MISMATCH');
        if (expectedCandidate && !expectedCandidate.statute && (!adapted.identity || documentKey(adapted.identity) !== expectedCandidate.key
          || (expectedCandidate.identity.document_number && expectedCandidate.identity.document_number !== adapted.identity.document_number)))
          throw new ServiceError(409, 'CANDIDATE_DOCUMENT_MISMATCH');
        const stored = splitDocument({ ...adapted, evidence_id: randomUUID(), revision, issue_ids: input.issue_ids, purpose: input.purpose,
          tool: input.tool, arguments_hash: attempt.arguments_hash, observed_at: observation.observed_at!, expires_at: started.expires_at }, this.limits.receiptBytes);
        chunks = stored.evidence; manifest = stored.manifest;
        if (expectedCandidate?.statute && !candidateBody(expectedCandidate, chunks).length) throw new ServiceError(409, 'CANDIDATE_DOCUMENT_MISMATCH');
        observation.evidence_id = chunks[0].evidence_id; observation.evidence_ids = chunks.map(e => e.evidence_id);
      }
      const current = this.owned(actor, id, revision, token);
      const finished: Session = { ...current, state_version: current.state_version + 1, transient_reservation: 0, reservation: 1024, ledger,
        evidence: [...current.evidence, ...chunks], manifests: manifest ? [...current.manifests, manifest] : current.manifests,
        attempts: current.attempts.map(a => a.attempt_id === attempt.attempt_id ? observation : a) };
      if (manifest) this.options.beforeDocumentCommit?.();
      this.save(finished); // Chunks, manifest, candidate observations and step status become visible together.
    } catch (e) {
      const current = this.owned(actor, id, revision, token);
      observation = { ...attempt, status: 'failed', error_code: safeCode(e), observed_at: new Date(this.now()).toISOString() };
      this.save({ ...current, state_version: current.state_version + 1, transient_reservation: 0, reservation: 1024,
        attempts: current.attempts.map(a => a.attempt_id === attempt.attempt_id ? observation : a) });
    } finally {
      this.activeReservations.delete(token);
    }
    return observation;
  }
  private async work(actor: Actor, initial: Session, job: Job, input: RetrieveInput | { max_steps: number }) {
    let errorCode: string | undefined;
    try {
      for (let n = 0; n < ('max_steps' in input ? input.max_steps : 1); n++) {
        const current = this.owned(actor, initial.research_id, initial.revision, job.job_id);
        let step: Pick<RetrieveInput, 'tool' | 'arguments' | 'issue_ids' | 'purpose' | 'candidate_id'> & { obligation_id?: string };
        if ('tool' in input) step = input;
        else {
          const coverage = this.coverage(current);
          const request = coverage.obligations.find(o => o.next_step)?.next_step ?? nextCandidateStep(coverage);
          if (!request) break;
          if (current.attempts.some(a => current.jobs.find(j => j.job_id === job.job_id)?.attempt_ids.includes(a.attempt_id)
            && a.tool === request.tool && a.arguments_hash === digest(request.arguments))) break;
          step = { ...request, issue_ids: request.issue_ids.filter(i => current.plan.issues.some(p => p.id === i)),
            ...(request.obligation_id.startsWith('candidate-') ? { candidate_id: request.obligation_id } : {}) };
        }
        const result = await this.retrieve(actor, initial.research_id, initial.revision, job.job_id, step);
        if (result.status === 'failed') { errorCode = result.error_code ?? 'SOURCE_RETRIEVAL_FAILED'; break; }
      }
    } catch (e) { errorCode = safeCode(e); }
    const current = this.owned(actor, initial.research_id, initial.revision, job.job_id);
    const result: Job = { ...current.jobs.find(j => j.job_id === job.job_id)!, status: errorCode ? 'failed' : 'completed',
      ...(errorCode ? { error_code: errorCode } : {}), completed_state_version: current.state_version + 1 };
    const finished: Session = { ...current, state_version: current.state_version + 1, reservation: 0, transient_reservation: 0, busy: null,
      jobs: current.jobs.map(j => j.job_id === job.job_id ? result : j) };
    this.save(finished); return this.view(finished, result);
  }
  async run(name: ResearchTool, actor: Actor, raw: unknown): Promise<Record<string, unknown>> {
    this.purge(); if (this.stopped) throw new ServiceError(503, 'SHUTTING_DOWN');
    if (name === 'start_legal_research') {
      const input = researchSchemas[name].parse(raw);
      if (this.sessions.size >= this.limits.maxSessions || [...this.sessions.values()].filter(s => s.admission_actor === actorBudgetKey(actor)).length >= this.limits.maxSessionsPerActor) throw new ServiceError(429, 'RESEARCH_CAPACITY');
      const s: Session = { actor: owner(actor), admission_actor: actorBudgetKey(actor), research_id: randomUUID(), revision: 1, state_version: 1,
        expires_at: new Date(this.now() + this.limits.ttlMs).toISOString(), plan: applyResearchProfiles(input.plan), evidence: [], attempts: [],
        last_review: null, reservation: 0, transient_reservation: 0, busy: null, deferrals: [], ledger: { candidates: [], overflow: false }, manifests: [], jobs: [], evidence_bindings: [] };
      this.save(s); return this.view(s);
    }
    if (name === 'get_legal_research') { const input = researchSchemas[name].parse(raw); return this.view(this.get(actor, input.research_id)); }
    if (name === 'reuse_legal_evidence') {
      const input = researchSchemas[name].parse(raw), old = this.get(actor, input.research_id, input.expected_revision, true);
      if (new Set(input.evidence_ids).size !== input.evidence_ids.length || new Set(input.issue_ids).size !== input.issue_ids.length
        || input.issue_ids.some(id => !old.plan.issues.some(i => i.id === id))) throw new ServiceError(400, 'RESEARCH_INVALID_ARGUMENTS');
      for (const id of input.evidence_ids) {
        const e = old.evidence.find(e => e.evidence_id === id), manifest = old.manifests.find(m => m.manifest_id === e?.manifest_id);
        if (!e || !manifest?.complete || !verifyManifest(manifest, old.evidence)
          || manifest.evidence_ids.some(part => !input.evidence_ids.includes(part))) throw new ServiceError(409, 'RESEARCH_REUSE_INCOMPLETE');
      }
      const next = { ...old, state_version: old.state_version + 1, last_review: null,
        evidence_bindings: [...old.evidence_bindings.filter(b => b.revision === old.revision && !input.evidence_ids.includes(b.evidence_id)),
          ...input.evidence_ids.map(evidence_id => ({ evidence_id, revision: old.revision, issue_ids: input.issue_ids }))] };
      this.save(next); return this.view(next);
    }
    if (name === 'update_legal_research') {
      const input = researchSchemas[name].parse(raw), old = this.get(actor, input.research_id, input.expected_revision, true), plan = applyResearchProfiles(input.plan);
      const next = { ...old, plan, revision: old.revision + 1, state_version: old.state_version + 1, last_review: null, deferrals: [], ledger: carryCandidates(old.ledger, old.plan, plan) };
      this.save(next); return this.view(next);
    }
    if (name === 'answer_legal_question') {
      const input = researchSchemas[name].parse(raw), old = this.get(actor, input.research_id, input.expected_revision, true);
      const answer = applyInterviewAnswer(old, input), plan = applyResearchProfiles(answer.plan);
      const next: Session = { ...old, plan, deferrals: answer.deferrals, revision: old.revision + Number(answer.changed_plan), state_version: old.state_version + 1,
        last_review: null, ledger: answer.changed_plan ? carryCandidates(old.ledger, old.plan, plan) : old.ledger };
      this.save(next); return this.view(next);
    }
    if (name === 'research_legal_sources' || name === 'run_required_legal_research') {
      const input = researchSchemas[name].parse(raw), old = this.get(actor, input.research_id, input.expected_revision);
      // Preserve ordinary input errors as 4xx, before reserving a job or spending a source call.
      if ('tool' in input) {
        if (!researchSourceTools.has(input.tool)) throw new ServiceError(400, 'RESEARCH_TOOL_NOT_ALLOWED');
        if (bytes(input.arguments) > 16_384 || new Set(input.issue_ids).size !== input.issue_ids.length
          || input.issue_ids.some(i => !old.plan.issues.some(issue => issue.id === i))) throw new ServiceError(400, 'RESEARCH_INVALID_ARGUMENTS');
        if (input.tool === 'check_legal_sources') {
          const request = SourceRequest.parse(input.arguments);
          for (const [role, value] of Object.entries(request.event_dates)) {
            const date = old.plan.event_dates.find(d => d.role === role);
            if (!date || date.value !== value || date.precision !== 'day' || date.basis !== 'provided') throw new ServiceError(400, 'RESEARCH_DATE_MISMATCH');
          }
        }
      }
      const requestId = input.request_id ?? randomUUID(), inputHash = digest({ name, input }), existing = old.jobs.find(j => j.request_id === requestId);
      if (existing) {
        if (existing.input_hash !== inputHash || existing.revision !== old.revision) throw new ServiceError(409, 'RESEARCH_REQUEST_CONFLICT');
        return { ...this.view(old, existing), replayed: true };
      }
      if (old.busy) throw new ServiceError(409, 'RESEARCH_BUSY');
      if (old.jobs.length >= this.limits.maxAttempts || old.attempts.length >= this.limits.maxAttempts
        || ('tool' in input && searchFamily(input.tool, input.arguments) === 'unknown' && old.evidence.length >= this.limits.maxReceipts))
        throw new ServiceError(429, 'RESEARCH_CAPACITY');
      const job: Job = { request_id: requestId, job_id: randomUUID(), input_hash: inputHash, revision: old.revision, status: 'pending', attempt_ids: [] };
      const admitted: Session = { ...old, jobs: [...old.jobs, job], state_version: old.state_version + 1, busy: job.job_id,
        reservation: this.limits.metadataReserve };
      // Admission must cover the first step and its terminal record without leaving a pending job on refusal.
      this.save({ ...admitted, transient_reservation: this.limits.transientBytes,
        attempts: [...admitted.attempts, { attempt_id: randomUUID(), revision: old.revision,
          issue_ids: 'issue_ids' in input ? input.issue_ids : old.plan.issues.map(i => i.id), purpose: 'context',
          tool: 'tool' in input ? input.tool : 'run_required_legal_research', arguments_hash: inputHash, status: 'pending' }] }, false);
      this.save(admitted);
      const running = this.work(actor, admitted, job, input);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([running, new Promise<Record<string, unknown>>(resolve => { timer = setTimeout(() => {
          try { const s = this.get(actor, old.research_id, old.revision); resolve(this.view(s, s.jobs.find(j => j.job_id === job.job_id))); }
          catch { resolve({ status: 'expired', research_id: old.research_id, legal_verification: 'unverified' }); }
        }, this.limits.yieldMs); })]);
      } finally { clearTimeout(timer); }
    }
    const input = researchSchemas.review_legal_reasoning.parse(raw), s = this.get(actor, input.research_id, input.expected_revision, true);
    if (input.expected_state_version !== s.state_version) throw new ServiceError(409, 'RESEARCH_STATE_CHANGED');
    if (s.manifests.some(m => !verifyManifest(m, s.evidence))) throw new ServiceError(409, 'RESEARCH_MANIFEST_INVALID');
    const result = inspectResearch(input, s.plan, this.evidence(s), s.attempts, s.ledger);
    const planHash = digest(s.plan), snapshotHash = digest({ revision: s.revision, state_version: s.state_version,
      evidence: s.evidence, evidence_bindings: s.evidence_bindings, attempts: s.attempts, ledger: s.ledger, manifests: s.manifests, jobs: s.jobs, coverage: this.coverage(s) });
    const binding = { research_id: s.research_id, revision: s.revision, state_version: s.state_version,
      policy_version: this.policy, plan_hash: planHash, snapshot_hash: snapshotHash, draft_hash: result.draft_hash, analysis_hash: result.analysis_hash,
      scope_assessment_hash: result.scope_assessment_hash, correction_needed: input.correction_needed };
    const bindingHash = digest(binding);
    this.save({ ...s, last_review: { state_version: s.state_version, binding_hash: bindingHash, snapshot_hash: snapshotHash, draft_hash: result.draft_hash } });
    return { ...binding, ...result, binding_hash: bindingHash, expires_at: s.expires_at, interview: interviewState(s) };
  }
}
