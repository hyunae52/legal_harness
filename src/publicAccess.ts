import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import type { Request } from 'express';
import { ServiceError, type Actor } from './contracts.js';

export const publicSessionSchema = { type: 'string', maxLength: 200,
  description: 'Automatically returned client_session from start_legal_research or prepare_correction_pr. Carry it unchanged for follow-up state operations; never ask the user to obtain a key or include this value in sources or public PR content.' };
export const publicSessionInstructions = '접속키나 로그인 없이 조회할 수 있습니다. 익명 연구·PR 준비 응답의 client_session은 AI가 후속 상태 도구 인수로 그대로 전달하세요. 사용자가 발급받거나 입력할 값이 아닙니다. 다른 대화의 세션을 섞거나 이 값을 답변·출처·PR에 공개하지 마세요. 첫 응답을 잃어 세션을 모르면 작업을 자동 재생성하지 말고 결과 불명을 알리세요. ';
export const actorBudgetKey = (actor: Actor) => actor.kind + ':' + (actor.rateLimitId ?? actor.id);
// Capabilities remain private even when concatenated with letters or other text.
export const publicSessionPattern = /v1\.\d{13}\.[a-f0-9]{64}\.[a-f0-9]{64}/;
/** Catch accidental inclusion in evidence, provider queries or public proposal text. */
export function assertNoPublicSession(value: unknown) {
  const text = JSON.stringify(value) ?? '';
  if (publicSessionPattern.test(text) || /"client_session"\s*:/.test(text)) throw new ServiceError(422, 'PRIVATE_SESSION_IN_CONTENT');
}

/** Public lookup is credential-free. State ownership uses an automatically issued capability. */
export class PublicAccess {
  readonly enabled: boolean;
  private readonly secret: string;
  private readonly trustCloudflare: boolean;
  constructor(env: NodeJS.ProcessEnv, private now: () => number = Date.now) {
    if (env.TAXLAB_PUBLIC_ACCESS !== undefined && !['0', '1'].includes(env.TAXLAB_PUBLIC_ACCESS)) throw Error('Invalid public access setting');
    this.enabled = env.TAXLAB_PUBLIC_ACCESS === '1';
    this.secret = env.TAXLAB_PUBLIC_SESSION_SECRET ?? '';
    this.trustCloudflare = env.TAXLAB_TRUST_CLOUDFLARE === '1';
    if (this.enabled && this.secret.trim().length < 32) throw Error('Public access requires a persisted session signing secret');
    if (env.TAXLAB_TRUST_CLOUDFLARE !== undefined && !['0', '1'].includes(env.TAXLAB_TRUST_CLOUDFLARE)) throw Error('Invalid proxy trust setting');
  }
  private mac(value: string) { return createHmac('sha256', this.secret).update(value).digest('hex'); }
  private issue(nonce: string) {
    const value = 'v1.' + (this.now() + 48 * 3600_000) + '.' + nonce;
    return value + '.' + this.mac('session:' + value);
  }
  anonymous(req: Request): Actor {
    if (!this.enabled) throw new ServiceError(401, 'UNAUTHORIZED');
    let peer = req.socket.remoteAddress ?? '';
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer);
    const forwarded = req.get('cf-connecting-ip');
    if (this.trustCloudflare && loopback && forwarded) {
      if (!isIP(forwarded)) throw new ServiceError(400, 'INVALID_CLIENT_ADDRESS');
      peer = forwarded;
    }
    if (!isIP(peer)) throw new ServiceError(503, 'CLIENT_ADDRESS_UNAVAILABLE');
    if (peer.startsWith('::ffff:') && isIP(peer.slice(7)) === 4) peer = peer.slice(7);
    const rateLimitId = 'peer:' + this.mac('rate:' + peer);
    return { kind: 'anonymous', id: rateLimitId, rateLimitId };
  }
  scope(actor: Actor, raw: unknown, allowCreate = false) {
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    const { client_session, ...args } = input;
    if (actor.kind !== 'anonymous') {
      if (client_session !== undefined) throw new ServiceError(400, 'PUBLIC_SESSION_WITH_AUTH');
      return { actor, input: raw, token: undefined };
    }
    if (!this.enabled) throw new ServiceError(401, 'UNAUTHORIZED');
    let token: string;
    if (client_session === undefined && allowCreate) {
      token = this.issue(randomBytes(32).toString('hex'));
    } else {
      if (typeof client_session !== 'string' || client_session.length > 200) throw new ServiceError(401, 'PUBLIC_SESSION_REQUIRED');
      token = client_session;
    }
    const match = /^(v1\.(\d{13})\.([a-f0-9]{64}))\.([a-f0-9]{64})$/.exec(token);
    if (!match || !timingSafeEqual(Buffer.from(this.mac('session:' + match[1]), 'hex'), Buffer.from(match[4], 'hex'))
      || Number(match[2]) <= this.now() || Number(match[2]) > this.now() + 48 * 3600_000) throw new ServiceError(401, 'PUBLIC_SESSION_INVALID');
    // Starting another operation must leave enough time for its full proposal lifetime.
    // Reissue the same identity; the prior token stays valid until its own expiry.
    if (allowCreate && client_session !== undefined) token = this.issue(match[3]);
    return { actor: { ...actor, id: 'anon-session:' + match[3] }, input: args, token };
  }
  result<T extends Record<string, unknown>>(value: T, token?: string): T & { client_session?: string } {
    return token ? { ...value, client_session: token } : value;
  }
}
