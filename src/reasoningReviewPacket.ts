import { randomUUID } from 'node:crypto';
import { digest, ServiceError } from './contracts.js';
import { storedBytes } from './researchStorage.js';
import { contentHash, reviewContextHash, type ReasoningState, type ReviewSnapshot } from './reasoningReviewState.js';
import { reasoningPolicy } from './reasoningContracts.js';

export interface ReviewPacket {
  packet_id: string; actor: string; research_id: string; revision: number; issued_state_version: number;
  artifact_id: string; content_hash: string; manifest_hash: string; context_hash: string; policy_version: string; expires_at: string;
  required_units: { id: string; hash: string; bytes: number }[]; provided_units: string[]; accepted: boolean;
  review_context: Pick<ReasoningState, 'findings' | 'responses'>;
}
function units(state: ReasoningState, snapshot: ReviewSnapshot, context: ReviewPacket['review_context']) {
  return [{ id: 'plan', data: snapshot.plan }, { id: 'artifact', data: state.artifact }, { id: 'structure', data: state.structure },
    { id: 'observations', data: { requirements: snapshot.requirements, requirement_history: snapshot.requirement_history,
      attempts: snapshot.attempts, ledger: snapshot.ledger, manifests: snapshot.manifests, adopted: snapshot.review_adopted_evidence_ids } },
    { id: 'review_history', data: { ...context, response_hashes: context.responses.map(r => ({ finding_id: r.finding_id, response_hash: digest(r) })) } },
    ...snapshot.evidence.map(e => ({ id: 'evidence:' + e.evidence_id, data: e }))];
}
export function preparePacket(state: ReasoningState, snapshot: ReviewSnapshot, actor: string, stateVersion: number, expiresAt: string): ReviewPacket {
  if (!state.artifact || !state.structure || state.structure.content_hash !== contentHash(snapshot, state.artifact.value))
    throw new ServiceError(409, 'REVIEW_STRUCTURE_STALE');
  const context = structuredClone({ findings: state.findings, responses: state.responses });
  const base = { packet_id: randomUUID(), actor, research_id: snapshot.research_id, revision: snapshot.revision,
    issued_state_version: stateVersion, artifact_id: state.artifact.artifact_id, content_hash: state.structure.content_hash,
    context_hash: reviewContextHash(state), policy_version: reasoningPolicy, expires_at: expiresAt,
    required_units: units(state, snapshot, context).map(u => ({ id: u.id, hash: digest(u.data), bytes: storedBytes(u.data) })) };
  return { ...base, manifest_hash: digest(base), provided_units: [], accepted: false, review_context: context };
}
export function assertPacket(state: ReasoningState, snapshot: ReviewSnapshot, packetId: string, manifestHash: string, actor: string) {
  const p = state.packet;
  if (!p || p.packet_id !== packetId || p.manifest_hash !== manifestHash || p.actor !== actor || !state.artifact
    || p.content_hash !== contentHash(snapshot, state.artifact.value) || p.policy_version !== reasoningPolicy
    || !p.accepted && p.context_hash !== reviewContextHash(state)) throw new ServiceError(409, 'REVIEW_PACKET_STALE');
  return p;
}
export function packetSummary(p: ReviewPacket) {
  const { actor: _actor, review_context: _context, ...publicPacket } = p;
  return { ...publicPacket, missing_units: p.required_units.filter(u => !p.provided_units.includes(u.id)).map(u => u.id),
    delivery_semantics: 'complete units produced by server; receipt or understanding by the model is not verified' };
}
export function readPacketPage(state: ReasoningState, snapshot: ReviewSnapshot, actor: string,
  input: { packet_id: string; packet_manifest_hash: string; limit: number; packet_cursor?: { packet_id: string; manifest_hash: string; offset: number } }) {
  const packet = assertPacket(state, snapshot, input.packet_id, input.packet_manifest_hash, actor), cursor = input.packet_cursor;
  if (cursor && (cursor.packet_id !== packet.packet_id || cursor.manifest_hash !== packet.manifest_hash)) throw new ServiceError(409, 'REVIEW_PACKET_STALE');
  const all = units(state, snapshot, packet.review_context), offset = cursor?.offset ?? 0;
  if (offset >= all.length) throw new ServiceError(400, 'REVIEW_CURSOR_INVALID');
  const items: typeof all = [];
  for (const u of all.slice(offset, offset + input.limit)) {
    const expected = packet.required_units.find(r => r.id === u.id);
    if (!expected || digest(u.data) !== expected.hash) throw new ServiceError(409, 'REVIEW_PACKET_STALE');
    // A single large unit remains whole. Stored evidence units are already byte bounded.
    if (items.length && storedBytes([...items, u]) > 65536) break;
    items.push(u);
  }
  const provided = [...new Set([...packet.provided_units, ...items.map(i => i.id)])];
  const updated = { ...packet, provided_units: provided }, end = offset + items.length;
  const result = { status: 'review_packet_page', response_mode: 'review_packet', research_id: snapshot.research_id,
    packet: packetSummary(updated), items, page: { total: all.length, offset, has_more: end < all.length,
      next_cursor: end < all.length ? { packet_id: packet.packet_id, manifest_hash: packet.manifest_hash, offset: end } : null } };
  // Serialize before committing the observation; failed construction must never count as provision.
  JSON.stringify(result);
  return { state: { ...state, packet: updated }, result };
}
