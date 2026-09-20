import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { type Actor, digest, ServiceError } from './contracts.js';

const text = (max: number) => z.string().trim().min(1).max(max);
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const sourceUrl = z.string().url().max(1000).refine(value => {
  const u = new URL(value);
  return u.protocol === 'https:' && !u.username && !u.password && !u.hash &&
    ['law.go.kr', 'moleg.go.kr', 'nts.go.kr', 'moef.go.kr', 'scourt.go.kr', 'court.go.kr', 'simpan.go.kr', 'moel.go.kr'].some(domain => u.hostname === domain || u.hostname.endsWith('.' + domain)) &&
    ![...u.searchParams.keys()].some(k => /key|token|secret|authorization|^oc$/i.test(k));
}, 'Use a public official source URL without credentials');
export const CorrectionProposalSchema = z.object({
  title: text(120), previous_claim: text(2000), correction: text(3000), why: text(2000),
  sources: z.array(z.object({ url: sourceUrl, title: text(200), supporting_excerpt: text(1500) }).strict()).min(1).max(5),
  keywords: z.array(z.string().trim().min(2).max(50)).min(1).max(8),
  next_checks: z.array(text(400)).min(1).max(8),
  public_safe: z.literal(true),
}).strict();
export const PrepareCorrectionSchema = CorrectionProposalSchema.extend({ request_id: uuid }).strict();
export const ConfirmCorrectionSchema = z.object({ proposal_id: uuid, proposal_hash: z.string().regex(/^[a-f0-9]{64}$/),
  confirmation_token: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) }).strict();
export type CorrectionProposal = z.infer<typeof CorrectionProposalSchema>;
export interface CorrectionRecord {
  id: string; actor: string; created_at: string; expires_at: string; proposal: CorrectionProposal;
  proposal_hash: string; confirmation_token: string; state: 'awaiting_confirmation' | 'publishing' | 'publication_uncertain' | 'publication_blocked' | 'published';
  base_sha?: string; pr?: { number: number; url: string; head_sha: string };
  target_repository?: string; // Absent only in legacy records; never permit new writes from those records.
  base_branch?: 'main'; blocked_reason?: string;
  merge_verified?: { proposal_hash: string; head_sha: string; number: number; target_repository: string; base_branch: 'main' };
}
export interface CorrectionRepository {
  readonly target: string;
  base(): Promise<string>;
  publish(record: CorrectionRecord): Promise<NonNullable<CorrectionRecord['pr']>>;
  inspect(record: CorrectionRecord, signal?: AbortSignal): Promise<{ state: 'pending_review' | 'merged' | 'closed' | 'missing' | 'changed' | 'retry_available'; pr?: NonNullable<CorrectionRecord['pr']> }>;
  merged?(records: CorrectionRecord[], signal: AbortSignal, onVerified?: (record: CorrectionRecord) => void): Promise<string[]>;
}
export function correctionDocument(record: Pick<CorrectionRecord, 'id' | 'created_at' | 'proposal'>) {
  return { schema_version: 1, proposal_id: record.id, proposed_at: record.created_at,
    review: { author: 'submitting_client_ai', independent_ai: 'not_verified', legal_applicability: 'unverified' }, proposal: record.proposal };
}
export const correctionFile = (record: CorrectionRecord) => `corrections/proposals/${record.id}.json`;
export const correctionContent = (record: CorrectionRecord) => JSON.stringify(correctionDocument(record), null, 2) + '\n';
const consentDigest = (record: CorrectionRecord) => record.target_repository
  ? digest({ target_repository: record.target_repository, base_branch: record.base_branch, public_preview: correctionDocument(record) })
  : digest(correctionDocument(record));
const privatePattern = /(?:-----BEGIN .*PRIVATE KEY-----|(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{12,}|\b\d{6}-[1-4]\d{6}\b|\b01[016789][- ]?\d{3,4}[- ]?\d{4}\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|PRIVATE_CASE_CANARY)/i;

export class CorrectionService {
  private busy = false;
  private timer?: ReturnType<typeof setInterval>;
  private refreshing?: Promise<void>;
  private merged: Array<{ record: CorrectionRecord; checked_at: string }> = [];
  private checkedAt?: number;
  private closed = false;
  readonly directory: string;
  constructor(private readonly options: { directory: string; repository: CorrectionRepository; secrets?: string[]; dailyLimit?: number; now?: () => number; refreshTimeoutMs?: number }) {
    this.directory = resolve(options.directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private path(id: string) { return join(this.directory, uuid.parse(id) + '.json'); }
  private read(id: string): CorrectionRecord | undefined {
    const path = this.path(id);
    if (!existsSync(path)) return undefined;
    return JSON.parse(readFileSync(path, 'utf8')) as CorrectionRecord;
  }
  private records() { return readdirSync(this.directory).filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).map(n => this.read(n.slice(0, -5))!); }
  private save(record: CorrectionRecord) {
    const path = this.path(record.id), temp = path + '.tmp';
    const fd = openSync(temp, 'w', 0o600);
    try { writeFileSync(fd, JSON.stringify(record) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
    // Linux production needs the directory entry durable as well as the file contents.
    if (process.platform !== 'win32') {
      const directory = openSync(this.directory, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  }
  private owned(actor: Actor, id: string) {
    const record = this.read(id);
    if (!record || record.actor !== actor.id) throw new ServiceError(404, 'CORRECTION_NOT_FOUND');
    return record;
  }
  private writableTarget(record: CorrectionRecord) {
    if (!record.target_repository || record.base_branch !== 'main') throw new ServiceError(409, 'CORRECTION_TARGET_UNBOUND');
    if (record.target_repository !== this.options.repository.target) throw new ServiceError(409, 'CORRECTION_TARGET_CHANGED');
  }
  private readableTarget(record: CorrectionRecord) {
    return record.target_repository ? record.target_repository === this.options.repository.target && record.base_branch === 'main'
      : !!record.pr?.url.startsWith(`https://github.com/${this.options.repository.target}/pull/`);
  }
  private rememberMerge(record: CorrectionRecord) {
    const verified: NonNullable<CorrectionRecord['merge_verified']> = { proposal_hash: record.proposal_hash, head_sha: record.pr!.head_sha,
      number: record.pr!.number, target_repository: this.options.repository.target, base_branch: 'main' };
    const latest = this.read(record.id);
    if (!latest || !this.readableTarget(latest) || latest.proposal_hash !== record.proposal_hash || latest.pr?.head_sha !== record.pr!.head_sha || latest.pr?.number !== record.pr!.number) throw Error('Record changed during refresh');
    if (JSON.stringify(latest.merge_verified) !== JSON.stringify(verified)) { latest.merge_verified = verified; this.save(latest); }
  }
  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy || this.closed) throw new ServiceError(429, 'CORRECTION_BUSY');
    this.busy = true;
    try { return await fn(); } finally { this.busy = false; }
  }
  private preview(record: CorrectionRecord) {
    return { proposal_id: record.id, proposal_hash: record.proposal_hash, confirmation_token: record.confirmation_token,
      state: record.state, expires_at: record.expires_at, target_repository: record.target_repository, base_branch: record.base_branch,
      public_preview: correctionDocument(record), independent_ai_review: 'not_verified',
      pr_url: record.pr?.url,
      question: `기존 답변의 정정 요지와 출처, 재발 방지 점검 항목을 위 내용대로 GitHub ${record.target_repository} 저장소에 공개 가능한 교정 PR로 제안할까요?`,
      next_action: record.state === 'awaiting_confirmation' ? '사용자에게 public_preview와 question을 보여주고 동의를 기다리세요. 이 단계에서는 GitHub에 게시하지 않았습니다. 동의 후에만 create_correction_pr를 호출하세요.' : '이미 게시를 시작한 제안입니다. 새 PR을 만들지 말고 get_correction_pr로 현재 상태를 확인하세요.' };
  }
  async prepare(actor: Actor, input: unknown) {
    return this.exclusive(async () => {
      const { request_id, ...proposal } = PrepareCorrectionSchema.parse(input);
      const serialized = JSON.stringify(proposal);
      if (privatePattern.test(serialized) || this.options.secrets?.some(s => s.length >= 8 && serialized.includes(s))) throw new ServiceError(422, 'PRIVATE_CONTENT_BLOCKED');
      if (Buffer.byteLength(serialized) > 20000) throw new ServiceError(413, 'CORRECTION_TOO_LARGE');
      const existing = this.read(request_id);
      if (existing) {
        if (existing.actor !== actor.id) throw new ServiceError(404, 'CORRECTION_NOT_FOUND');
        if (digest(existing.proposal) !== digest(proposal)) throw new ServiceError(409, 'IDEMPOTENCY_CONFLICT');
        this.writableTarget(existing);
        return this.preview(existing);
      }
      const records = this.records(), now = this.now();
      if (records.length >= 1000 || records.filter(r => Date.parse(r.created_at) > now - 86400000).length >= (this.options.dailyLimit ?? 10)) throw new ServiceError(429, 'CORRECTION_DAILY_LIMIT');
      const record: CorrectionRecord = { id: request_id, actor: actor.id, created_at: new Date(now).toISOString(), expires_at: new Date(now + 48 * 3600000).toISOString(),
        proposal, target_repository: this.options.repository.target, base_branch: 'main', proposal_hash: '', confirmation_token: randomBytes(32).toString('hex'), state: 'awaiting_confirmation' };
      record.proposal_hash = consentDigest(record);
      this.save(record);
      return this.preview(record);
    });
  }
  async confirm(actor: Actor, input: unknown) {
    return this.exclusive(async () => {
      const data = ConfirmCorrectionSchema.parse(input), record = this.owned(actor, data.proposal_id);
      if (record.confirmation_token !== data.confirmation_token || record.proposal_hash !== data.proposal_hash || consentDigest(record) !== data.proposal_hash) throw new ServiceError(409, 'CORRECTION_CONFIRMATION_MISMATCH');
      if (record.pr) return { proposal_id: record.id, state: 'already_published', pr_url: record.pr.url, message: '이미 생성한 PR입니다. get_correction_pr로 현재 검수·머지 상태를 확인하세요.' };
      this.writableTarget(record);
      if (record.state === 'publication_blocked' && record.blocked_reason !== 'CORRECTION_ALREADY_CLOSED') return { proposal_id: record.id, state: record.state, error_code: record.blocked_reason };
      if (record.state === 'awaiting_confirmation' && Date.parse(record.expires_at) < this.now()) throw new ServiceError(410, 'CORRECTION_EXPIRED');
      if (!record.base_sha) record.base_sha = z.string().regex(/^[a-f0-9]{40}$/).parse(await this.options.repository.base());
      record.state = 'publishing'; this.save(record); // persist intent before any GitHub write
      try {
        record.pr = await this.options.repository.publish(record);
        record.state = 'published'; this.save(record);
        return { proposal_id: record.id, state: 'pending_review', pr_url: record.pr.url,
          message: '교정 자료 draft PR을 생성했습니다. 별도 AI 검수·사람 검수 전이며 자동 머지하거나 법적 정답으로 적용하지 않습니다.' };
      } catch (error) {
        if (error instanceof ServiceError && error.status === 409 && error.code !== 'CORRECTION_ALREADY_CLOSED') {
          record.state = 'publication_blocked'; record.blocked_reason = error.code; this.save(record);
          return { proposal_id: record.id, state: record.state, error_code: record.blocked_reason,
            message: '경로 충돌 또는 변경 범위 불일치로 게시를 중단했습니다. 기존 자료를 덮어쓰거나 자동 재시도하지 않습니다. 새 제안이 필요하면 내용을 보여주고 새 동의를 받으세요.' };
        }
        record.state = 'publication_uncertain'; delete record.blocked_reason; this.save(record);
        return { proposal_id: record.id, state: 'publication_uncertain', message: 'GitHub 게시 결과를 확인하지 못했습니다. 새 제안을 만들지 말고 get_correction_pr로 이 제안의 상태를 확인하세요.' };
      }
    });
  }
  async status(actor: Actor, id: string) {
    return this.exclusive(async () => {
      const record = this.owned(actor, id);
      if (!this.readableTarget(record)) return { proposal_id: id, state: 'target_unavailable', pr_url: record.pr?.url,
        message: '기존 동의 대상과 현재 저장소 설정이 일치하지 않거나 구형 제안에 대상 정보가 없습니다. 게시를 재개하지 않습니다.' };
      // Older releases incorrectly blocked ended PRs whose creation response was lost.
      // Keep those records reconcilable; real path/content/scope conflicts stay blocked.
      if (record.state === 'publication_blocked' && record.blocked_reason !== 'CORRECTION_ALREADY_CLOSED') return { proposal_id: id, state: record.state, error_code: record.blocked_reason };
      if (record.state === 'awaiting_confirmation') return { proposal_id: id, state: record.state, expires_at: record.expires_at };
      try {
        const state = await this.options.repository.inspect(record);
        if (state.pr && !record.pr) { record.pr = state.pr; record.state = 'published'; this.save(record); }
        if (state.state === 'retry_available' && !record.pr) {
          this.writableTarget(record);
          if (consentDigest(record) !== record.proposal_hash) throw new ServiceError(409, 'CORRECTION_CONFIRMATION_MISMATCH');
          return { proposal_id: id, state: 'retry_available',
            retry: { tool: 'create_correction_pr', arguments: { proposal_id: id, proposal_hash: record.proposal_hash, confirmation_token: record.confirmation_token, confirm: true } },
            next_action: '이전에 동의한 같은 제안입니다. GitHub에 PR이 없고 재개 가능한 상태임을 확인했습니다. 반환된 retry 인수로 한 번 재시도하세요. 새 제안을 만들거나 자동 반복하지 마세요.' };
        }
        return { proposal_id: id, state: state.state === 'missing' ? 'publication_uncertain' : state.state, pr_url: state.pr?.url ?? record.pr?.url,
          independent_ai_review: 'not_verified', legal_applicability: 'unverified' };
      } catch { return { proposal_id: id, state: 'status_unavailable', pr_url: record.pr?.url }; }
    });
  }
  async refresh() {
    if (this.refreshing || this.closed) return this.refreshing;
    this.refreshing = (async () => {
      const found: typeof this.merged = [], signal = AbortSignal.timeout(this.options.refreshTimeoutMs ?? 30000);
      try {
        const records = this.records().filter(r => r.pr && this.readableTarget(r));
        const mergedIds = this.options.repository.merged ? new Set(await this.options.repository.merged(records, signal, record => this.rememberMerge(record))) : undefined;
        for (const record of records) {
          if (this.closed) return;
          // A completed batch returns only IDs verified against the fetched main tree,
          // even if its later, unverified PR requests ran out of time.
          if (!mergedIds && signal.aborted) throw Error('Refresh expired');
          const merged = mergedIds ? mergedIds.has(record.id) : (await this.options.repository.inspect(record, signal)).state === 'merged';
          if (merged) {
            this.rememberMerge(record);
            found.push({ record, checked_at: new Date(this.now()).toISOString() });
          }
        }
        this.merged = found; this.checkedAt = this.now();
      } catch { /* Do not refresh timestamps or turn lookup failure into approval. */ }
    })();
    try { await this.refreshing; } finally { this.refreshing = undefined; }
  }
  search(query: string) {
    const current = this.checkedAt !== undefined && this.now() - this.checkedAt < 10 * 60000;
    const normalized = query.normalize('NFKC').toLowerCase();
    return { status: current ? 'cached' : 'unavailable', legal_applicability: 'unverified',
      items: current ? this.merged.filter(({ record }) => record.proposal.keywords.some(k => normalized.includes(k.normalize('NFKC').toLowerCase()))).slice(0, 5).map(({ record, checked_at }) => ({
        ...correctionDocument(record), pr_url: record.pr!.url, review_state: 'merged', checked_at,
        note: '저장소의 main에 머지된 교정 참고 자료입니다. 원천의 최신성·사건 적용과 독립 AI 검수는 별도로 확인하세요.',
      })) : [] };
  }
  start() { if (!this.timer) { void this.refresh(); this.timer = setInterval(() => void this.refresh(), 5 * 60000); this.timer.unref(); } }
  async close() { this.closed = true; clearInterval(this.timer); await this.refreshing; }
}
