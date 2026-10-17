import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import type { DatabaseSync } from 'node:sqlite';

export type UsageScope = 'mcp' | 'rest' | 'source';
export interface UsageRecorder {
  registerTools(names: string[]): void;
  start(scope: UsageScope, tool: string): (success: boolean) => void;
  measure<T>(scope: UsageScope, tool: string, operation: () => Promise<T>): Promise<T>;
  status(): { enabled: boolean; healthy: boolean; failed_writes: number };
}
const DAY = 86_400_000;
export const usageDay = (time: number) => new Date(time + 9 * 3_600_000).toISOString().slice(0, 10);
const sqlite = (): typeof import('node:sqlite') => createRequire(import.meta.url)('node:sqlite');
const failed = (result: unknown): boolean => {
  if (!result || typeof result !== 'object') return false;
  const value = result as { isError?: boolean; result?: { isError?: boolean } };
  return value.isError === true || value.result?.isError === true;
};

/** Aggregate-only storage. No arguments, response bodies, identities or error messages enter this API. */
export class UsageStore implements UsageRecorder {
  private readonly db: DatabaseSync;
  private readonly known = new Set<string>();
  private failedWrites = 0;
  private prunedDay = '';
  private closed = false;
  constructor(path: string, private readonly now = Date.now, private readonly monotonic = () => performance.now()) {
    if (!isAbsolute(path)) throw Error('USAGE_PATH_NOT_ABSOLUTE');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new (sqlite().DatabaseSync)(path);
    try {
      chmodSync(path, 0o600);
      this.db.exec(`PRAGMA busy_timeout=100; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        PRAGMA wal_autocheckpoint=100; PRAGMA journal_size_limit=1048576; PRAGMA max_page_count=16384;
        CREATE TABLE IF NOT EXISTS usage_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS usage_daily (
          day TEXT NOT NULL, scope TEXT NOT NULL CHECK(scope IN ('mcp','rest','source')), tool TEXT NOT NULL,
          calls INTEGER NOT NULL, successes INTEGER NOT NULL, failures INTEGER NOT NULL,
          duration_ms REAL NOT NULL, max_ms REAL NOT NULL,
          PRIMARY KEY(day,scope,tool)
        ) STRICT;`);
      this.db.prepare('INSERT OR IGNORE INTO usage_meta VALUES (?,?)').run('started_at', new Date(now()).toISOString());
      this.db.prepare('INSERT OR IGNORE INTO usage_meta VALUES (?,?)').run('schema_version', '1');
      if (this.db.prepare("SELECT value FROM usage_meta WHERE key='schema_version'").get()?.value !== '1') throw Error('USAGE_SCHEMA_VERSION');
    } catch (error) { this.db.close(); throw error; }
  }
  registerTools(names: string[]) {
    for (const name of names) if (this.known.size < 256 && /^[a-z][a-z0-9_]{0,63}$/.test(name)) this.known.add(name);
  }
  status() { return { enabled: true, healthy: this.failedWrites === 0 && !this.closed, failed_writes: this.failedWrites }; }
  start(scope: UsageScope, tool: string) {
    const day = usageDay(this.now()), started = this.monotonic();
    let completed = false;
    return (success: boolean) => {
      if (completed) return;
      completed = true;
      try {
        if (this.closed) throw Error('USAGE_CLOSED');
        const today = usageDay(this.now()), duration = Math.min(DAY, Math.max(0, this.monotonic() - started));
        if (!Number.isFinite(duration)) throw Error('USAGE_CLOCK_INVALID');
        this.db.exec('BEGIN IMMEDIATE');
        if (this.prunedDay !== today) this.db.prepare('DELETE FROM usage_daily WHERE day < ?').run(usageDay(this.now() - 399 * DAY));
        this.db.prepare(`INSERT INTO usage_daily VALUES (?,?,?,1,?,?,?,?)
          ON CONFLICT(day,scope,tool) DO UPDATE SET calls=calls+1, successes=successes+excluded.successes,
          failures=failures+excluded.failures, duration_ms=duration_ms+excluded.duration_ms, max_ms=max(max_ms,excluded.max_ms)`)
          .run(day, scope, this.known.has(tool) ? tool : '_unknown', success ? 1 : 0, success ? 0 : 1, duration, duration);
        this.db.exec('COMMIT');
        this.prunedDay = today;
      } catch {
        try { this.db.exec('ROLLBACK'); } catch { /* No open transaction, or storage unavailable. */ }
        this.failedWrites++;
        if (this.failedWrites === 1) console.error('USAGE_WRITE_UNAVAILABLE: usage totals may be incomplete.');
      }
    };
  }
  async measure<T>(scope: UsageScope, tool: string, operation: () => Promise<T>): Promise<T> {
    const finish = this.start(scope, tool);
    try { const result = await operation(); finish(!failed(result)); return result; }
    catch (error) { finish(false); throw error; }
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
}

export function configuredUsage(env: NodeJS.ProcessEnv) {
  if (!env.TAXLAB_USAGE_DB) return undefined;
  try { return new UsageStore(env.TAXLAB_USAGE_DB); }
  catch {
    console.error('USAGE_STORAGE_UNAVAILABLE: legal retrieval remains enabled.');
    let missed = 0;
    const start = () => { let done = false; return (_success: boolean) => { if (!done) { done = true; missed++; } }; };
    return {
      registerTools() {}, start,
      async measure<T>(_scope: UsageScope, _tool: string, operation: () => Promise<T>) {
        const finish = start(); try { return await operation(); } finally { finish(false); }
      },
      status() { return { enabled: true, healthy: false, failed_writes: missed }; }, close() {},
    } satisfies UsageRecorder & { close(): void };
  }
}

type SourceClient = { listTools(): Promise<{ tools: { name: string }[] }>; callTool(name: string, args: Record<string, unknown>): Promise<unknown> };
/** Preserve class getters/receivers. Only trusted provider catalogs can create tool labels. */
export function meterSourceClient<T extends SourceClient>(source: T, usage?: UsageRecorder): T {
  if (!usage) return source;
  const catalog = async () => { const result = await source.listTools(); usage.registerTools(result.tools.map(t => t.name)); return result; };
  return new Proxy(source, { get(target, key) {
    if (key === 'listTools') return catalog;
    if (key === 'callTool') return (name: string, args: Record<string, unknown>) => usage.measure('source', name, async () => {
      // Do not add discovery I/O or make tax retrieval depend on law-provider availability.
      // A returned result comes from an adapter that validates its own tool catalog.
      const result = await source.callTool(name, args); usage.registerTools([name]); return result;
    });
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

export function readUsage(path: string, days = 7, now = Date.now()) {
  if (!isAbsolute(path) || !Number.isInteger(days) || days < 1 || days > 400) throw Error('USAGE_REPORT_INPUT');
  const db = new (sqlite().DatabaseSync)(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout=100; BEGIN');
    const from = usageDay(now - (days - 1) * DAY), to = usageDay(now);
    const rows = db.prepare('SELECT * FROM usage_daily WHERE day BETWEEN ? AND ? ORDER BY day,scope,tool').all(from, to).map(row => ({
      day: String(row.day), scope: String(row.scope), tool: String(row.tool), calls: Number(row.calls), successes: Number(row.successes),
      failures: Number(row.failures), duration_ms: Number(row.duration_ms), max_ms: Number(row.max_ms),
    }));
    const totals = new Map<string, { calls: number; successes: number; failures: number; duration_ms: number; max_ms: number }>();
    for (const row of rows) {
      const key = String(row.scope), item = totals.get(key) ?? { calls: 0, successes: 0, failures: 0, duration_ms: 0, max_ms: 0 };
      for (const field of ['calls', 'successes', 'failures', 'duration_ms'] as const) item[field] += Number(row[field]);
      item.max_ms = Math.max(item.max_ms, Number(row.max_ms)); totals.set(key, item);
    }
    const startedAt = db.prepare("SELECT value FROM usage_meta WHERE key='started_at'").get()?.value;
    return { timezone: 'Asia/Seoul', from, to, started_at: startedAt, retention_days: 400,
      totals: Object.fromEntries([...totals].map(([scope, v]) => [scope, { ...v, mean_ms: v.calls ? v.duration_ms / v.calls : 0 }])),
      daily_tools: rows.map(row => ({ ...row, mean_ms: Number(row.duration_ms) / Number(row.calls) })) };
  } finally { db.close(); }
}
