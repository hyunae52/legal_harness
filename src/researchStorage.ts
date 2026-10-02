import { randomUUID } from 'node:crypto';
import { digest, ServiceError } from './contracts.js';
import type { ResearchEvidence, Passage } from './researchEvidence.js';
export const storedBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
export interface DocumentManifest {
  manifest_id: string; path: 'single_response'; response_hash: string; document_key: string;
  snapshot_id: string; snapshot_basis: 'captured_response'; complete: boolean;
  evidence_ids: string[]; ranges: { unit_id: string; field: string; start: number; end: number; hash: string }[];
}
/** Never combines independently fetched pieces. No installed adapter guarantees an immutable range snapshot. */
export function splitDocument(receipt: ResearchEvidence, byteLimit: number): { evidence: ResearchEvidence[]; manifest: DocumentManifest } {
  const manifestId = randomUUID();
  const blank = (): ResearchEvidence => ({ ...receipt, evidence_id: randomUUID(), manifest_id: manifestId, chunk_index: 0, passages: [] });
  const evidence: ResearchEvidence[] = [], ranges = receipt.passages.map(p => ({ unit_id: p.unit_id, field: p.field, start: p.start, end: p.end, hash: p.hash }));
  let chunk = blank();
  if (storedBytes(chunk) >= byteLimit - 512) throw new ServiceError(429, 'RESEARCH_MANIFEST_CAPACITY');
  const push = () => { chunk.chunk_index = evidence.length; evidence.push(chunk); chunk = blank(); };
  for (const passage of receipt.passages) {
    let offset = 0;
    while (offset < passage.text.length) {
      const piece = (length: number): Passage => {
        const text = passage.text.slice(offset, offset + length);
        return { ...passage, passage_id: `${passage.passage_id}-${offset}`, text, hash: digest(text), start: passage.start + offset, end: passage.start + offset + length };
      };
      // Keep legacy passage IDs when a complete passage fits in a single storage unit.
      if (offset === 0 && storedBytes({ ...chunk, passages: [...chunk.passages, passage] }) <= byteLimit) { chunk.passages.push(passage); offset = passage.text.length; continue; }
      let lo = 0, hi = passage.text.length - offset;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (storedBytes({ ...chunk, passages: [...chunk.passages, piece(mid)] }) <= byteLimit - 16) lo = mid; else hi = mid - 1;
      }
      if (lo && /[\uD800-\uDBFF]/.test(passage.text[offset + lo - 1])) lo--;
      if (!lo) { if (!chunk.passages.length) throw new ServiceError(429, 'RESEARCH_EVIDENCE_TOO_LARGE'); push(); continue; }
      chunk.passages.push(piece(lo)); offset += lo;
      if (offset < passage.text.length) push();
    }
  }
  if (chunk.passages.length || !evidence.length) push();
  const manifest: DocumentManifest = { manifest_id: manifestId, path: 'single_response', response_hash: receipt.response_hash,
    document_key: `${receipt.identity?.namespace ?? 'unknown'}:${receipt.identity?.family ?? 'unknown'}:${receipt.document_id}`,
    snapshot_id: receipt.evidence_id, snapshot_basis: 'captured_response', complete: receipt.body_scope === 'body_returned'
      && receipt.units.every(u => u.source_access === 'available' && u.body_scope === 'body_returned'), evidence_ids: evidence.map(e => e.evidence_id), ranges };
  if (!verifyManifest(manifest, evidence)) throw new ServiceError(500, 'RESEARCH_MANIFEST_INVALID');
  return { evidence, manifest };
}
export function verifyManifest(manifest: DocumentManifest, stored: ResearchEvidence[]): boolean {
  if (manifest.path !== 'single_response' || manifest.snapshot_basis !== 'captured_response' || !manifest.evidence_ids.length
    || new Set(manifest.evidence_ids).size !== manifest.evidence_ids.length) return false;
  const chunks = manifest.evidence_ids.map(id => stored.find(e => e.evidence_id === id));
  if (chunks.some((e, i) => !e || e.manifest_id !== manifest.manifest_id || e.chunk_index !== i || e.response_hash !== manifest.response_hash)) return false;
  const passages = chunks.flatMap(e => e!.passages);
  for (const range of manifest.ranges) {
    const parts = passages.filter(p => p.unit_id === range.unit_id && p.field === range.field && p.start >= range.start && p.end <= range.end).sort((a, b) => a.start - b.start);
    let position = range.start, text = '';
    for (const p of parts) {
      if (p.start !== position || p.end !== p.start + p.text.length || p.hash !== digest(p.text)) return false;
      position = p.end; text += p.text;
    }
    if (position !== range.end || digest(text) !== range.hash) return false;
  }
  return passages.every(p => manifest.ranges.some(r => r.unit_id === p.unit_id && r.field === p.field && p.start >= r.start && p.end <= r.end));
}
