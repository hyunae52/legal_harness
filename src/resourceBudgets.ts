import { ServiceError, type Actor } from './contracts.js';
import { actorBudgetKey } from './publicAccess.js';

const defaults = { requestRpm: 600, actorRequestRpm: 180, lookupRpm: 120, actorLookupRpm: 60,
  maxActors: 1024, responseMs: 60_000, responseBytes: 4_194_304 };
export interface ResourceOptions { now?: () => number; limits?: Partial<typeof defaults> }
export function positiveLimit(value: unknown, fallback: number): number {
  const parsed = value === undefined ? fallback : typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 100_000_000) throw Error('Invalid service limit');
  return parsed;
}
type Bucket = { tokens: number; updated: number };
type Pair = { request: Bucket; lookup: Bucket; touched: number };

/** Per-process token buckets for verified principals or anonymous network peers. No queues. */
export class ResourceBudgets {
  readonly limits: typeof defaults;
  private readonly now: () => number;
  private readonly actors = new Map<string, Pair>();
  private readonly global: Pair;
  constructor(env: NodeJS.ProcessEnv, options: ResourceOptions = {}) {
    this.now = options.now ?? (() => performance.now());
    this.limits = { ...defaults };
    const envNames: Record<keyof typeof defaults, string> = {
      requestRpm: 'TAXLAB_REQUEST_RPM', actorRequestRpm: 'TAXLAB_REQUEST_RPM_PER_ACTOR',
      lookupRpm: 'TAXLAB_LOOKUP_RPM', actorLookupRpm: 'TAXLAB_LOOKUP_RPM_PER_ACTOR',
      maxActors: 'TAXLAB_MAX_RATE_ACTORS', responseMs: 'TAXLAB_MCP_RESPONSE_MS', responseBytes: 'TAXLAB_MCP_RESPONSE_BYTES',
    };
    for (const key of Object.keys(defaults) as (keyof typeof defaults)[]) {
      this.limits[key] = positiveLimit(options.limits?.[key] ?? env[envNames[key]], defaults[key]);
    }
    this.global = this.pair(this.limits.requestRpm, this.limits.lookupRpm, this.now());
  }
  private pair(request: number, lookup: number, now: number): Pair {
    return { request: { tokens: request, updated: now }, lookup: { tokens: lookup, updated: now }, touched: now };
  }
  consume(actor: Actor, kind: 'request' | 'lookup') {
    const now = this.now(), key = actorBudgetKey(actor);
    for (const [id, value] of this.actors) if (now - value.touched >= 60_000) this.actors.delete(id);
    let actorPair = this.actors.get(key);
    if (!actorPair) {
      if (this.actors.size >= this.limits.maxActors) throw new ServiceError(429, 'RATE_ACTOR_CAPACITY');
      actorPair = this.pair(this.limits.actorRequestRpm, this.limits.actorLookupRpm, now);
      this.actors.set(key, actorPair);
    }
    actorPair.touched = Math.max(actorPair.touched, now);
    const buckets = [this.global[kind], actorPair[kind]];
    const sizes = kind === 'request' ? [this.limits.requestRpm, this.limits.actorRequestRpm]
      : [this.limits.lookupRpm, this.limits.actorLookupRpm];
    buckets.forEach((bucket, i) => {
      bucket.tokens = Math.min(sizes[i], bucket.tokens + Math.max(0, now - bucket.updated) * sizes[i] / 60_000);
      bucket.updated = Math.max(bucket.updated, now);
    });
    if (buckets.some(bucket => bucket.tokens < 1)) throw new ServiceError(429, kind === 'lookup' ? 'LOOKUP_RATE_LIMIT' : 'REQUEST_RATE_LIMIT');
    buckets.forEach(bucket => { bucket.tokens--; });
  }
}
