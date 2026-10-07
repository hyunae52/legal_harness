import { randomUUID } from 'node:crypto';
import { digest, ServiceError } from './contracts.js';
import type { Plan, ReviewInput, CitationInput } from './researchContracts.js';
import type { ResearchEvidence, ResearchAttempt } from './researchEvidence.js';
import type { DocumentManifest } from './researchStorage.js';
import { storedBytes } from './researchStorage.js';
import type { Requirement, RequirementHistory } from './researchRequirements.js';
import type { CandidateLedger } from './researchCoverage.js';
import { reasoningPolicy, type FindingResponseInput, type SubmitInput } from './reasoningContracts.js';
import type { inspectResearch } from './researchReview.js';
import type { ReviewPacket } from './reasoningReviewPacket.js';
import { referenceUsage } from './researchCitations.js';

export interface ReviewSnapshot {
  research_id: string; revision: number; plan: Plan; evidence: ResearchEvidence[]; attempts: ResearchAttempt[];
  manifests: DocumentManifest[]; ledger: CandidateLedger; requirements: Requirement[]; requirement_history: RequirementHistory[];
  evidence_bindings: unknown[]; review_adopted_evidence_ids: string[]; policy: string;
}
export type ArtifactValue = Pick<ReviewInput, 'reasoning_contract_version' | 'draft_answer' | 'analysis' | 'scope_assessments' | 'answer_blocks' | 'correction_needed'>;
export interface Artifact { artifact_id: string; artifact_hash: string; value: ArtifactValue; reference_usage: ReturnType<typeof referenceUsage> }
type Inspection = ReturnType<typeof inspectResearch>;
export interface StructureRecord { content_hash: string; status: string; findings: Inspection['findings']; draft_hash: string;
  question_scope_complete: boolean; declared_scope_review_complete: boolean }
export type ModelFinding = SubmitInput['findings'][number] & {
  finding_id: string; origin_content_hash: string; origin_block_hash: string; status: 'open' | 'resolved'; resolved_content_hash?: string;
  deterministic_checks: { code: string; issue_id?: string }[];
}
export interface ReviewReceipt {
  tool: 'prepare_reasoning_review' | 'submit_reasoning_review'; request_id: string; input_hash: string;
  packet_id: string; content_hash: string; manifest_hash: string; revision: number; state_version: number;
  result: 'prepared' | SubmitInput['result']; review_number: number; finding_ids: string[];
}
export interface ReasoningState {
  artifact: Artifact | null; structure: StructureRecord | null; packet: ReviewPacket | null;
  previous_packet: { packet_id: string; content_hash: string; manifest_hash: string } | null;
  findings: ModelFinding[]; responses: FindingResponseInput[]; receipts: ReviewReceipt[]; reviews_accepted: number;
  accepted_review: { packet_id: string; content_hash: string; responses_hash: string; result: SubmitInput['result']; reviewer: SubmitInput['reviewer']; review_number: number } | null;
}
export const emptyReasoningState = (): ReasoningState => ({ artifact: null, structure: null, packet: null, previous_packet: null,
  findings: [], responses: [], receipts: [], reviews_accepted: 0, accepted_review: null });
export const contentHash = (snapshot: ReviewSnapshot, artifact: ArtifactValue) => digest({ policy: reasoningPolicy, contract: 2, snapshot, artifact });
export const reviewContextHash = (state: ReasoningState) => digest({ findings: state.findings, responses: state.responses });
export function artifactValue(input: ReviewInput): ArtifactValue {
  return { reasoning_contract_version: 2, draft_answer: input.draft_answer, analysis: input.analysis,
    scope_assessments: input.scope_assessments, answer_blocks: input.answer_blocks, correction_needed: input.correction_needed };
}

/** Feedback is proposed research, not an adopted ground. Still validate actual receipt, quote and issue linkage. */
export function checkFeedbackCitations(citations: CitationInput[], evidence: ResearchEvidence[], issueId: string) {
  for (const c of citations) {
    const e = evidence.find(e => e.evidence_id === c.evidence_id), p = e?.passages.find(p => p.passage_id === c.passage_id);
    if (!e || !p || !p.text.includes(c.quote) || p.body_scope !== 'body_returned'
      || e.units.some(u => u.source_access !== 'available') || !e.issue_ids.includes(issueId) && !c.bridge_reason)
      throw new ServiceError(400, 'REVIEW_FEEDBACK_SOURCE_INVALID');
  }
}
const referenceErrors = new Set(['ISSUE_COVERAGE', 'DUPLICATE_CLAIM', 'FACT_NOT_FOUND', 'DATE_ROLE_NOT_FOUND', 'EVIDENCE_NOT_FOUND',
  'PASSAGE_NOT_FOUND', 'QUOTE_MISMATCH', 'ISSUE_BRIDGE_REQUIRED', 'DUPLICATE_TEST', 'DUPLICATE_EXCLUDED_TEST', 'TEST_REFERENCE_INVALID',
  'DUPLICATE_TEST_REFERENCE', 'DUPLICATE_APPLICATION', 'APPLICATION_REFERENCE_INVALID', 'ANSWER_ISSUE_NOT_FOUND', 'ANSWER_REFERENCE_INVALID',
  'DUPLICATE_ANSWER_BLOCK', 'CONFLICT_REFERENCE_INVALID', 'OPPOSITION_REFERENCE_INVALID', 'OPPOSITION_SEARCH_INVALID']);
export function recordArtifact(prior: ReasoningState, input: ReviewInput, result: Inspection, snapshot: ReviewSnapshot): ReasoningState {
  if (result.findings.some(f => referenceErrors.has(f.code))) throw new ServiceError(400, 'REASONING_REFERENCE_INVALID');
  const value = artifactValue(input), hash = digest(value), responses = input.finding_responses ?? [];
  if (new Set(responses.map(r => r.finding_id)).size !== responses.length) throw new ServiceError(400, 'REVIEW_RESPONSE_INVALID');
  for (const r of responses) {
    const f = prior.findings.find(f => f.finding_id === r.finding_id);
    if (!f || r.remap_block_id && !value.answer_blocks?.some(b => b.id === r.remap_block_id)) throw new ServiceError(400, 'REVIEW_RESPONSE_INVALID');
    checkFeedbackCitations(r.citations, snapshot.evidence, f.issue_id);
  }
  const artifact = prior.artifact?.artifact_hash === hash ? prior.artifact : { artifact_id: randomUUID(), artifact_hash: hash, value, reference_usage: referenceUsage(input) };
  return { ...prior, artifact, responses, structure: { content_hash: contentHash(snapshot, value), status: result.status, findings: result.findings,
    draft_hash: result.draft_hash, question_scope_complete: result.question_scope_complete, declared_scope_review_complete: result.declared_scope_review_complete } };
}
export function findingView(f: ModelFinding, state: ReasoningState, currentHash: string, plan: Plan) {
  const b = state.artifact?.value.answer_blocks?.find(b => b.id === f.block_id && b.issue_id === f.issue_id && b.text.includes(f.quote));
  const resolved = f.status === 'resolved' && f.resolved_content_hash === currentHash;
  const status = resolved ? 'resolved' : !b ? 'unmapped' : 'open';
  const tracks = plan.scope_review?.tracks.filter(t => t.issue_id === f.issue_id) ?? [];
  const independent = tracks.length > 0 && tracks.every(t => t.relation === 'independent_notice' && t.blocks_track_ids.length === 0);
  return { ...f, status, blocking: !resolved && (status === 'unmapped' || !independent) };
}
export function reasoningStatus(state: ReasoningState | undefined, snapshot: ReviewSnapshot, busy: boolean, enabled: boolean) {
  const hash = state?.artifact ? contentHash(snapshot, state.artifact.value) : null;
  const current = enabled && !busy && Boolean(hash && state?.structure?.content_hash === hash);
  const review = state?.accepted_review, packet = state?.packet;
  const findings = state?.findings.map(f => findingView(f, state, hash ?? '', snapshot.plan)) ?? [];
  const reviewCurrent = current && Boolean(review && packet?.packet_id === review.packet_id && review.content_hash === hash && review.responses_hash === digest(state?.responses)
    && packet.required_units.every(u => packet.provided_units.includes(u.id)));
  const ready = reviewCurrent && state?.structure?.status === 'structurally_complete' && state.structure.question_scope_complete
    && (snapshot.plan.scope_review?.mode !== 'comprehensive' || state.structure.declared_scope_review_complete)
    && review?.result !== 'revise' && !findings.some(f => f.blocking);
  return { reasoning_contract_version: state?.artifact ? 2 : 1, ready_for_answer: Boolean(ready),
    reasoning_artifact: state?.artifact ? { artifact_id: state.artifact.artifact_id, artifact_hash: state.artifact.artifact_hash } : null,
    review_content_hash: hash, structure_current: current,
    answer_binding: state?.artifact ? { draft_hash: digest(state.artifact.value.draft_answer),
      whole_answer: true, current, applies_to_exact_text_only: true } : null,
    model_review: { status: review ? reviewCurrent ? 'recorded' : 'stale' : packet ? 'pending' : 'not_requested',
      ...(review ? { result: review.result, reviewer: review.reviewer, review_number: review.review_number } : {}),
      accepted_count: state?.reviews_accepted ?? 0, remaining: Math.max(0, 3 - (state?.reviews_accepted ?? 0)), findings },
    legal_verification: 'unverified', semantic_support: 'unverified', independent_review: 'not_performed',
    stages: { deterministic_structure: state?.structure ? 'completed' : 'not_performed', independent_semantic_review: 'not_configured' } };
}
export function acceptedReceipt(state: ReasoningState, tool: ReviewReceipt['tool'], input: { request_id: string }) {
  const found = state.receipts.find(r => r.request_id === input.request_id);
  if (found && (found.tool !== tool || found.input_hash !== digest(input))) throw new ServiceError(409, 'RESEARCH_REQUEST_CONFLICT');
  return found;
}
export function admitReceipt(state: ReasoningState, receipt: ReviewReceipt): ReasoningState {
  // Accepted request IDs survive for the entire session, including across revisions.
  if (state.receipts.length >= 64 || storedBytes([...state.receipts, receipt]) > 65536) throw new ServiceError(429, 'REVIEW_RECEIPT_CAPACITY');
  return { ...state, receipts: [...state.receipts, receipt] };
}
export function acceptModelReview(state: ReasoningState, input: SubmitInput, snapshot: ReviewSnapshot): ReasoningState {
  if (!state.artifact || !state.packet) throw new ServiceError(409, 'REVIEW_PACKET_REQUIRED');
  const hash = contentHash(snapshot, state.artifact.value);
  const findings = structuredClone(state.findings);
  if (new Set(input.prior_findings.map(f => f.finding_id)).size !== input.prior_findings.length) throw new ServiceError(400, 'REVIEW_FINDING_INVALID');
  for (const p of input.prior_findings) {
    const f = findings.find(f => f.finding_id === p.finding_id), response = state.responses.find(r => r.finding_id === p.finding_id);
    if (!f) throw new ServiceError(400, 'REVIEW_FINDING_INVALID');
    if (p.disposition === 'resolved') {
      if (!response || p.response_hash !== digest(response)) throw new ServiceError(409, 'REVIEW_AUTHOR_RESPONSE_REQUIRED');
      // Close this finding independently of unrelated gaps. A linked server check
      // must actually clear; revision/target renaming cannot discard its check family.
      if (f.deterministic_checks.some(check => state.structure?.findings.some(g => g.code === check.code && g.issue_id === check.issue_id)))
        throw new ServiceError(409, 'REVIEW_STRUCTURE_UNRESOLVED');
      const b = state.artifact.value.answer_blocks?.find(b => b.id === (response.remap_block_id ?? f.block_id));
      if ((!b || b.issue_id !== f.issue_id || !b.text.includes(f.quote)) && !response.remap_block_id && !response.removal_reason)
        throw new ServiceError(409, 'REVIEW_FINDING_UNMAPPED');
      if (b && response.remap_block_id) { f.block_id = b.id; f.issue_id = b.issue_id; }
      f.status = 'resolved'; f.resolved_content_hash = hash;
    } else { f.status = 'open'; delete f.resolved_content_hash; }
  }
  for (const proposal of input.findings) {
    const b = state.artifact.value.answer_blocks?.find(b => b.id === proposal.block_id && b.issue_id === proposal.issue_id);
    const a = state.artifact.value.analysis.find(a => a.issue_id === proposal.issue_id);
    if (!b?.text.includes(proposal.quote) || proposal.claim_id && !a?.claims.some(c => c.id === proposal.claim_id)
      || proposal.test_id && !a?.legal_tests?.some(t => t.id === proposal.test_id)) throw new ServiceError(400, 'REVIEW_FINDING_INVALID');
    checkFeedbackCitations(proposal.citations, snapshot.evidence, proposal.issue_id);
    const deterministic_checks = (proposal.structure_gap_ids ?? []).map(id => {
      const gap = state.structure?.findings.find(g => g.gap_id === id && (!g.issue_id || g.issue_id === proposal.issue_id));
      if (!gap) throw new ServiceError(400, 'REVIEW_FINDING_GAP_INVALID');
      return { code: gap.code, ...(gap.issue_id ? { issue_id: gap.issue_id } : {}) };
    });
    findings.push({ ...proposal, deterministic_checks, finding_id: randomUUID(), origin_content_hash: hash, origin_block_hash: digest(b), status: 'open' });
  }
  const next = { ...state, findings };
  const blocking = findings.some(f => findingView(f, next, hash, snapshot.plan).blocking);
  if (input.result === 'revise') {
    if (!input.findings.length && !input.prior_findings.some(f => f.disposition === 'open')) throw new ServiceError(409, 'REVIEW_RESULT_CONFLICT');
  } else if (blocking) throw new ServiceError(409, 'REVIEW_RESULT_CONFLICT');
  if (input.result === 'qualified' && !input.qualifications.length || input.result !== 'qualified' && input.qualifications.length)
    throw new ServiceError(409, 'REVIEW_RESULT_CONFLICT');
  for (const q of input.qualifications) if (!state.artifact.value.answer_blocks?.some(b => b.id === q.block_id && b.text.includes(q.quote)))
    throw new ServiceError(409, 'REVIEW_RESULT_CONFLICT');
  return { ...next, reviews_accepted: state.reviews_accepted + 1, packet: { ...state.packet, accepted: true },
    accepted_review: { packet_id: state.packet.packet_id, content_hash: hash, responses_hash: digest(state.responses), result: input.result, reviewer: input.reviewer, review_number: state.reviews_accepted + 1 } };
}
