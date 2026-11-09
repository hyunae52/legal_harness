import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { outcomeTools, outcomes, OUTCOME_VERSION, type OutcomeEvent } from './retrievalOutcome.js';
import { normalizeFailureCode } from './usageFailures.js';
import { usageDay, type readMorningUsage } from './usage.js';

export function validOutcomeEvent(event: OutcomeEvent) {
  return event && Object.keys(event).length === 6 && outcomeTools.has(event.tool) && outcomes.includes(event.outcome)
    && ['list_search', 'exact_lookup', 'body_read', 'compound'].includes(event.operation)
    && ['nts', 'law', 'attachment'].includes(event.provider)
    && ['2.1.0.post2', 'unsupported'].includes(event.provider_version)
    && (event.code === 'NONE' || normalizeFailureCode(event.code) === event.code);
}

/** Optional worker; recording is bounded and never awaited by retrieval or shutdown. */
export class OutcomeRecorder {
  private worker?: Worker;
  private pending = 0;
  private dropped = 0;
  private failures = 0;
  private ready = false;
  private stopped = false;
  constructor(path: string, workerFactory = (path: string) => new Worker(new URL('./outcomeWorker.js', import.meta.url), { workerData: { path } })) {
    try {
      if (!isAbsolute(path)) throw Error('OUTCOME_PATH');
      this.worker = workerFactory(path);
      this.worker.on('message', message => {
        if (message?.ready === true) this.ready = true;
        else if (message?.ack === true) { this.pending = Math.max(0, this.pending - 1); if (!message.ok) this.failures++; }
      });
      this.worker.on('error', () => { this.ready = false; this.failures++; this.stopped = true; });
      this.worker.on('exit', () => { this.ready = false; this.stopped = true; });
      this.worker.unref();
    } catch { this.failures++; this.stopped = true; }
  }
  record(event: OutcomeEvent, at = Date.now()) {
    try {
      if (!validOutcomeEvent(event) || !Number.isSafeInteger(at) || at < 0 || this.stopped || !this.worker || this.pending >= 128) { this.dropped++; return; }
      this.pending++;
      try { this.worker.postMessage({ event, at }); } catch { this.pending--; this.dropped++; }
    } catch { this.dropped++; }
  }
  status() { return { enabled: true, ready: this.ready, healthy: !this.stopped && this.failures === 0 && this.dropped === 0,
    queued: this.pending, dropped: this.dropped, failed_writes: this.failures, contract: OUTCOME_VERSION }; }
  close() { this.stopped = true; this.ready = false; void this.worker?.terminate().catch(() => undefined); }
}

type UsageReport = ReturnType<typeof readMorningUsage>;
export interface OutcomeReport {
  state: 'collected' | 'partial' | 'uncollected'; started_at?: string; contract: string;
  expected: number; recorded: number; missing: number; rows: Array<OutcomeEvent & { calls: number }>;
}
/** Independent read failure affects only this optional report section. */
export function readOutcomeReport(path: string, usage: UsageReport): OutcomeReport {
  const eligible = usage.tools.filter(row => row.scope === 'source' && outcomeTools.has(row.tool));
  const expected = eligible.reduce((sum, row) => sum + row.calls, 0);
  const absent: OutcomeReport = { state: 'uncollected', contract: OUTCOME_VERSION, expected, recorded: 0, missing: expected, rows: [] };
  if (!isAbsolute(path) || !existsSync(path)) return absent;
  let db: import('node:sqlite').DatabaseSync | undefined;
  try {
    const sqlite: typeof import('node:sqlite') = createRequire(import.meta.url)('node:sqlite');
    db = new sqlite.DatabaseSync(path, { readOnly: true });
    db.exec('PRAGMA busy_timeout=50; BEGIN');
    const metadata = db.prepare('SELECT value FROM outcome_meta WHERE key=?');
    if (metadata.get('contract')?.value !== OUTCOME_VERSION) return absent;
    const startedAt = String(metadata.get('started_at')?.value);
    if (!Number.isFinite(Date.parse(startedAt))) return absent;
    const raw = db.prepare('SELECT tool,operation,outcome,provider,provider_version,code,calls FROM outcome_morning WHERE day=? LIMIT 2049')
      .all(usageDay(Date.parse(usage.from)));
    if (raw.length > 2048) return absent;
    const rows = raw.map(row => ({ tool: String(row.tool), operation: row.operation, outcome: row.outcome, provider: row.provider,
      provider_version: String(row.provider_version), code: String(row.code), calls: Number(row.calls) })) as OutcomeReport['rows'];
    if (rows.some(({ calls, ...event }) => !validOutcomeEvent(event) || !Number.isSafeInteger(calls) || calls < 1)) return absent;
    const recorded = rows.reduce((sum, row) => sum + row.calls, 0);
    const totals = new Map<string, number>();
    for (const row of rows) totals.set(row.tool, (totals.get(row.tool) ?? 0) + row.calls);
    let missing = 0, excess = 0;
    for (const row of eligible) { const actual = totals.get(row.tool) ?? 0; missing += Math.max(0, row.calls - actual); excess += Math.max(0, actual - row.calls); totals.delete(row.tool); }
    excess += [...totals.values()].reduce((a, b) => a + b, 0);
    return { state: missing || excess || Date.parse(startedAt) > Date.parse(usage.from) ? 'partial' : 'collected',
      started_at: startedAt, contract: OUTCOME_VERSION, expected, recorded, missing, rows };
  } catch { return absent; } finally { db?.close(); }
}
