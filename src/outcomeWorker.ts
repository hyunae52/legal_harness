import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { validOutcomeEvent } from './outcomeStore.js';
import { OUTCOME_VERSION } from './retrievalOutcome.js';
import { usageDay } from './usage.js';

if (!parentPort || !isAbsolute(workerData.path)) throw Error('OUTCOME_WORKER_INPUT');
const sqlite: typeof import('node:sqlite') = createRequire(import.meta.url)('node:sqlite');
mkdirSync(dirname(workerData.path), { recursive: true, mode: 0o700 });
const db = new sqlite.DatabaseSync(workerData.path);
chmodSync(workerData.path, 0o600);
db.exec(`PRAGMA busy_timeout=50; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
  PRAGMA wal_autocheckpoint=32; PRAGMA journal_size_limit=262144; PRAGMA max_page_count=1024;
  CREATE TABLE IF NOT EXISTS outcome_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS outcome_morning (day TEXT NOT NULL,tool TEXT NOT NULL,operation TEXT NOT NULL,
    outcome TEXT NOT NULL,provider TEXT NOT NULL,provider_version TEXT NOT NULL,code TEXT NOT NULL,calls INTEGER NOT NULL,
    PRIMARY KEY(day,tool,operation,outcome,provider,provider_version,code)) STRICT;`);
db.prepare('INSERT OR IGNORE INTO outcome_meta VALUES (?,?)').run('contract', OUTCOME_VERSION);
if (db.prepare("SELECT value FROM outcome_meta WHERE key='contract'").get()?.value !== OUTCOME_VERSION) throw Error('OUTCOME_CONTRACT');
db.prepare('INSERT OR IGNORE INTO outcome_meta VALUES (?,?)').run('started_at', new Date().toISOString());
parentPort.postMessage({ ready: true });
let pruned = '';
parentPort.on('message', ({ event, at }) => {
  let ok = false;
  try {
    if (!validOutcomeEvent(event) || !Number.isSafeInteger(at) || at < 0) throw Error('OUTCOME_EVENT');
    const day = usageDay(at - 6 * 3600000);
    if (pruned !== day) { db.prepare('DELETE FROM outcome_morning WHERE day < ?').run(usageDay(at - 35 * 86400000)); pruned = day; }
    db.prepare(`INSERT INTO outcome_morning VALUES (?,?,?,?,?,?,?,1)
      ON CONFLICT(day,tool,operation,outcome,provider,provider_version,code) DO UPDATE SET calls=calls+1`)
      .run(day, event.tool, event.operation, event.outcome, event.provider, event.provider_version, event.code);
    ok = true;
  } catch { /* Missing rows stay missing. No payloads or diagnostics leave the worker. */ }
  parentPort!.postMessage({ ack: true, ok });
});
