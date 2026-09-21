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
| TI-01 | Authenticated POST `/mcp` creates a fresh SDK server/transport per request, JSON response, no MCP session cookie/header. Initialize, notifications, tools/list and tools/call work. GET/DELETE return authenticated 405. Unsupported protocol, malformed body and batch are rejected. | Real SDK client and HTTP integration |
| TI-02 | Existing SSE and `/messages` keep working. Auth and Origin checks apply equally. Research ownership derives from authenticated actor, never transport/request IDs. | Both transports, REST cross-actor tests |
| TI-03 | Global actual work remains 3. Live SSE connections plus in-flight `/mcp` requests share global 20 / actor 5 admission; completed stateless requests release their slot. Disconnect does not release actual work early. Drain includes unfinished work/auth/dispatch. | Concurrent delayed provider, abort, drain, release-on-error tests |
| TI-04 | Source lookup attempts share a bounded per-process rate budget across REST, SSE and `/mcp`: global 120 / actor 60 per rolling token replenishment minute. Budget applies to direct source calls, source verification and research retrieval. Initialize, listing, interview/status and local review do not consume lookup tokens. Shared API key remains one actor. Limits are positive validated operator settings, not a count of registered people. | Controlled-clock budget test plus cross-path integration |
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

Pro status: REVIEW pending; PLAN pending; IMPLEMENTATION not started; DEPLOYMENT not started.
