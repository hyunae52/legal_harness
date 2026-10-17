# MCP usage accounting

## Contract

- U01: Each MCP `tools/call` reaching the tool dispatcher contributes exactly one completed call, success or failure, and elapsed milliseconds. Discovery and HTTP health probes are excluded. Repeated client requests count separately, even when a research request reuses an existing result.
- U02: REST operations and source adapter calls are separate scopes. A research operation may make several source calls. Never sum source calls with client calls as a single usage total. Source counts describe harness adapter invocations, not upstream HTTP requests, retries, tokens, or unique people.
- U03: Attribute a call to its start date in Asia/Seoul. Commit aggregates atomically on completion and preserve them across processes, restarts and releases. A killed process can lose its unfinished calls.
- U04: Store only date, scope, a server-registered tool name (unknown names collapse to `_unknown`), counts and total/maximum duration. Never store arguments, responses, user/IP/session identifiers, error messages, credentials or document content.
- U05: A bounded local database retains 400 calendar days. Statistics failures must not change a legal tool response. Public health reports whether accounting is enabled and whether writes have failed; aggregate reports are available only through the operator CLI, not a new public route.
- U06: Production explicitly enables accounting with an absolute `TAXLAB_USAGE_DB` path outside the release directory. Candidate preflight has no such setting and must not write production usage.

## Operator commands

Requires Node 22.13 or newer when accounting is enabled. No additional npm dependency or Supabase migration is needed.

```sh
node dist/usageReport.js --database /home/cta/.local/state/legal-harness-usage/usage.sqlite --days 7
node dist/usageReport.js --database /home/cta/.local/state/legal-harness-usage/usage.sqlite --days 30 --json
```

Reports include separate MCP, REST and source totals, daily breakdowns and tool breakdowns. Mean response time includes completed successes and failures; success means tool execution completed without a protocol/application error, not that a legal conclusion was verified. Historical usage before accounting was enabled cannot be reconstructed. Automated smoke tests that invoke tools count as ordinary calls; these are not unique-user or human-only statistics. Authentication/rate-limit refusals before MCP dispatch are excluded from MCP tool counts.

The database directory must be writable only by the service user and included in the systemd service's `ReadWritePaths`; see [usage-store.conf](../deploy/usage-store.conf). Keep this directory outside deployment cleanup paths. The database is limited to 64 MiB (16,384 default 4 KiB pages); daily aggregate rows expire on the next write after aging out. Backup the SQLite database using SQLite's backup interface (or stop writers first); copying only the main file while WAL writes are active is not a consistent backup.

If writes fail (for example disk full or a database lock), requests continue, health becomes degraded and `failed_writes` counts unrecorded completions since process start. These missed records cannot be retroactively recovered. The reporter reads persisted counts only. No per-request log is emitted.

## Verification

| Contract | Evidence boundary |
| --- | --- |
| U01/U02 | Real HTTP MCP/REST app tests, including failure, repeated calls and separate source counts |
| U03 | KST date boundary, weighted durations, reopen and concurrent writer tests |
| U04 | Unknown-tool cardinality and persisted-file content tests |
| U05 | Database write failure, retention and read-only report tests |
| U06 | Disabled configuration test and deployed service/preflight configuration inspection |
