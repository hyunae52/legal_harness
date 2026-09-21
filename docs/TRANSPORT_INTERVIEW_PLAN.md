# Stateless MCP and legal fact interview

Baseline: `3a872e208d77414abc4e890289a75b01f2b68eca` (merged PR7–9).
New scope: retain service protection, add `/mcp`, and interview missing case facts.
Review/plan/implementation/deployment are separate Pro checkpoints. This document
does not change the previous release's completed review history.

## Review evidence

- Baseline focused gate: 43/43 research and route regression tests passed.
- The upstream korean-law-mcp public `/law` accepted independent initialize and
  tools/list POSTs without a transport session on 2026-09-21 KST. Ten tools were
  advertised; this is no evidence of traffic volume or capacity.
- Upstream source at `c9864683e5bb196d13c9f117a28843078eaa8750` uses stateless
  JSON responses and separate rate/work budgets. Its current deployment notes
  describe a shared Fly host, 1 GiB, 2 shared CPUs and swap; the old disabled
  256 MiB fly.toml is not the current deployment configuration.
- [MCP transport specification](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
  permits JSON responses and authenticated GET 405; keep the old SSE endpoints
  alongside the new endpoint. SDK 1.30.0 is already locked in this repository.

## Intent contracts / plan

| ID | Observable contract | Verification |
| --- | --- | --- |
| TI-01 | Authenticated POST `/mcp` creates a fresh SDK 1.30.0 server/transport per request, JSON response, no MCP session cookie/header. Target protocol 2025-11-25 with the SDK's advertised older versions; not a promise of 2026-07-28 compliance. Initialize, notifications, tools/list and tools/call work. GET/DELETE return authenticated 405. Unsupported protocol, malformed body and batch are rejected. | Real SDK client and HTTP integration |
| TI-02 | Existing SSE and `/messages` keep working. Auth and Origin checks apply equally. Research ownership derives from authenticated actor, never transport/request IDs. | Both transports, REST cross-actor tests |
| TI-03 | Global actual work remains 3. Live SSE connections plus in-flight `/mcp` requests share global 20 / actor 5 admission; completed stateless requests release their slot. Disconnect does not release actual work early. Drain includes unfinished work/auth/dispatch. | Concurrent delayed provider, abort, drain, release-on-error tests |
| TI-04 | Source lookup attempts share a bounded per-process rate budget across REST, SSE and `/mcp`: global 120 / actor 60 per rolling token replenishment minute. Budget applies to direct source calls, source verification and research retrieval. Initialize, listing, interview/status and local review do not consume lookup tokens. Shared API key remains one actor. Limits are positive validated operator settings, not a count of registered people. | Controlled-clock budget test plus cross-path integration |
| TI-04A | Authenticated protected requests, including initialize, notifications and unknown methods, also share a short-request budget (global 600 / actor 180 tokens, replenished per minute). At most 1,024 actor buckets; fully refilled idle buckets can expire after a minute. Overflow fails closed. Auth in-flight 20 and body 256 KiB remain. This does not claim protection from network/body-parser floods before authentication. | Controlled clock, bounded map, no-work exhaustion tests |
| TI-05 | Research responses expose at most one next question from registered required facts/dates. Provided facts and exact provided dates are skipped; shared requirements are deduplicated. Client orders issues/requirements by significance after preliminary source research. Server does not infer all legal requirements. | Synthetic multi-issue cases, no provider work |
| TI-06 | `answer_legal_question` (REST `/api/research/answer`) accepts only the current question/revision/state and authenticated owner. Answers carry source; unknown remains unresolved and is deferred without repeatedly asking. Partial provided dates remain a gap and are deferred. | Replay/stale/foreign/wrong-target/busy/invalid-date tests |
| TI-07 | A fact/date answer replaces only the selected requirement, advances revision/state, clears evidence and prior review. Unknown/defer advances state and invalidates review. TTL and lifetime attempts never reset; no new LLM/API/GitHub call is made. Explicit full plan update resets deferrals and retains its existing invalidation policy. | Ledger, budget, review-binding assertions |
| TI-08 | Missing law sources are researched, interpretation conflicts retain counteranalysis, missing private facts are asked of user. All deferred gaps allow conditional/withheld work and still prevent definitive pass. `no_registered_fact_gaps` is not legal approval or complete issue discovery. | Review regressions + instructions/contract checks |
| TI-09 | Both MCP transports and GPT Actions expose the same interview schema. Existing installers keep their SSE connection. Public guide adds the new endpoint and explains question/unknown behavior without promising app UI compatibility not tested. | Schema and real transport tests; package smoke |

Use test-first implementation for these contracts. Source providers, correction
publication/consent and database schema are unchanged. Do not introduce an
unbounded waiting queue, arbitrary client-supplied identities, a paid LLM call,
or a global unlimited-user promise.

## Interview mechanics

The next question is deterministic from the registered plan, revision and
deferrals. It contains a server-derived question ID, target fact/date, linked
issues and a short reason. The client may rephrase naturally without changing
meaning, after checking the conversation for already supplied answers. Case
facts are never inferred from legal documents or invented to finish an interview.
Issue/requirement order is supplied by the client, not a legal priority oracle.

Answers use separate fact/date/unknown variants. A partial date keeps its
precision and supplied basis; the unresolved exact day is deferred. A changed
fact invalidates all old receipts conservatively, because their applicability
may depend on that fact. The client must retrieve and review again. Retries after
a lost response fetch current status instead of silently replaying an answer.
Transport session lifetime and research state lifetime are independent.

The Discord Remote deep-interview skill inspired one-question-at-a-time,
known-context reuse, and explicit unknowns. Its software approval workflow and
numeric ambiguity threshold are not copied into legal reasoning. No skill text
or upstream implementation is transplanted.

## Deployment boundary

Keep old runtime/env/provider/publisher state. Build and test a release artifact,
review its exact source, stage an isolated candidate, and verify both transports
plus interview with synthetic facts. Switch under ingress fencing/drain; retain
the previous release for rollback. Record the artifact, actual runtime selection,
public HTTPS smoke and Pro's evidence boundary. PR remains for human merge;
the previous authorization to merge through PR9 does not authorize merging this PR.

Transport disconnect has no promise of cancelling or rolling back work. Do not
advertise resumable streams or cross-request cancellation. A lost mutation
response requires status lookup, especially PR publication. Shutdown waits for
actual work, even after a request transport has closed. Lookup token charging
counts attempted calls, including later validation failures; it is not an exact
billable upstream-request counter.

Each stateless response has a 60-second total lifetime (operator-test override
permitted). The route races transport handling against response close, because
SDK JSON response promises need not settle when the transport closes. Cleanup is
idempotent; actual work remains charged independently until its own completion.
Admission remains held through response finish/close, not merely handler return.
Budget capacities equal their refill-per-minute values (initial full burst);
these are token buckets, not an assertion of a strict sliding-window count.

## PLAN TP-01–03 closure contracts

- TP-01: the 60-second clock starts immediately after authenticated transport
  admission, before SDK connect. Each response is capped at 4 MiB of complete
  JSON-RPC serialization, including text and structuredContent duplication.
  Oversize returns a bounded `RESPONSE_TOO_LARGE` RPC error, never truncated
  success. Existing provider/result and ledger caps remain; this is an output
  guard, not a claim that JSON serialization has no transient allocation.
  Finish/close/connect or handle failure/timeout share idempotent cleanup.
  A request-local admission guard rejects late tool handler entry after close;
  already-entered work continues to count until settled. Slow response and
  failed connect are injected at the lifecycle module boundary, while real SDK
  integration verifies abort, timeout, drain and subsequent slot recovery.
- TP-02: answer variants are strict. question_id is nonblank <=128 chars;
  fact value <=2,000, source <=1,000 (both nonblank); date value <=10,
  precision day/month/year and valid calendar, source <=1,000; unknown reason
  <=1,000 nonblank. Wrong target kind is 400; wrong question/revision/state 409;
  foreign/expired research 404. Build a new immutable session, then call the
  existing byte/reservation save boundary exactly once. Any rejection preserves
  plan/deferrals/revision/state/evidence/review. Deferrals have one bounded entry
  per required target (kind + ID, <=52). Data answers preserve other deferrals;
  unknown preserves assumed facts and partial dates; full plan update resets
  deferrals. Status returns current plan, revision/state, next question and a
  target-level unresolved list with deferral reasons. Supplied facts/sources
  are client assertions, not independently authenticated human testimony.
- TP-03: all protected request entries consume request tokens once after auth
  and Origin checks, before dispatch/transport creation. Both actor/global
  buckets must have tokens before either is charged. Rejection does not debit
  either; do not evict partially depleted actors to admit new actors. An idle
  minute refills both capacities and permits expiry. Source tokens are consumed
  once in the shared direct retrieval/source-check/research-retrieve entry,
  before provider or research attempt creation. Rejected research lookup leaves
  attempts unchanged. Tokens count attempted calls, not successful results.

Additional executable/fault-test contracts (besides the original six RED cases):

| Case | Input and independent expected result |
| --- | --- |
| Bounded admission | Exhaust actor/global request tokens with init/notifications/unknown methods across protected routes; next is 429, work 0. Fill a lowered actor capacity, deny new actor without eviction, advance clock one minute and accept. Invalid zero/negative/nonfinite/fractional settings throw. |
| All lookup entries | Exhaust direct lookup tokens, then try REST source check, MCP source check and research retrieve: each rejected, providers 0 additional and no new attempt. One allowed research retrieve charges only once. |
| Isolation | Concurrent actors use same RPC ID; results retain distinct research/query. Five SSE leases deny sixth same-actor HTTP lease; another actor can still list. |
| Lifetime failures | Delayed auth + drain never dispatches; timeout/abort while provider pending releases HTTP lease but leaves active work; closing an already-finished or failed-connect response twice releases once. A stalled output has finite timeout. Closed request's guard rejects late operation entry. |
| Existing review | Create a conditional review, confirm last_review.current=true, answer each kind fact/date/unknown and confirm it is invalidated. Source and counter gaps remain after all user facts are answered/deferred. |
| Atomic answers | Two concurrent answers to the same state (including different values): one applies, other 409. Ignore successful response, recover exact value/deferral/revision via status. Invalid kind/date/over-capacity preserve complete prior state. |
| Oversize response | Provider fixture returns an oversized result; new HTTP returns bounded explicit RPC error, no partial successful result; later request works. |

The focused contracts above are implemented and verified. See
[implementation and deployment evidence](TRANSPORT_INTERVIEW_IMPLEMENTATION.md)
for the RED/GREEN, mutation, package, Linux CI and actual source checks.

Pro status: REVIEW PASS (2026-09-21); PLAN PASS / TP-01–03 CLOSED at a7e2442;
CODE PASS at b1fe256; DEPLOYMENT PASS on evidence a61751c, TRD-01 CLOSED.
PR10 remains unmerged. Accepted SH-01–04 and SI-01–04: shared service/work,
bounded transport and short-request ingress, protocol version boundary,
single question/deferred state, atomic stale-answer rejection, invalidation and
separate source/interpretation gaps. No replay automatically resubmits an answer;
stale replays return 409 and the client reads current state.
