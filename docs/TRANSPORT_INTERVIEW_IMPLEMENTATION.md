# Implementation verification: transport and fact interview

Scope is the [approved contract](TRANSPORT_INTERVIEW_PLAN.md). Pro REVIEW passed;
PLAN TP-01–03 closed at `a7e24424e7d84b0c363a6444a72c69260f3941b6`.
Code/deployment review is separate and has not yet passed in this record.

## Behavior

- `/mcp` uses a fresh SDK server per authenticated HTTP request and JSON results.
  The same application, research ledger, providers and work budget serve REST,
  SSE and Streamable HTTP. SDK 1.30.0 / protocol 2025-11-25; no 2026 compliance
  claim, OAuth, resumable stream or cross-request cancellation.
- SSE and in-flight HTTP share 20 transport leases / actor 5; actual work stays
  at 3 until its operation settles, even after disconnection. A 60-second HTTP
  lifetime, 4 MiB wire-result limit, late-handler guard and idempotent cleanup
  bound the new transport. Independent response and work accounting is tested.
- Protected requests use global/actor token buckets (600/180 capacity and
  refill per minute); source attempts use 120/60. Map capacity is 1,024 actors,
  idle fully replenishable buckets expire after a minute. Identity is verified
  auth, not request/session/client IDs. Shared-key users still share one actor.
- `answer_legal_question` is added to the existing five research tools and GPT
  Actions. Every research response exposes one next question, target-level
  unresolved facts/date roles, deferral reasons and state/revision identifiers.
- Provided facts and exact provided dates are skipped. Unknown or partial dates
  do not become assumed full dates or legal approval. A changed fact/date clears
  old receipts and review; unknown defers and clears review. Every accepted
  answer advances state. TTL, attempts and actor/storage quotas are preserved.
- All changes remain ephemeral, within the research byte cap. Server LLM calls,
  GitHub writes, legal semantic verification and automatic merging are not added.
  The independent implementation borrows interview principles, not upstream
  skill code/text or its software approval/ambiguity-scoring workflow.

## Executed evidence

- Baseline narrow gate: 43/43 passed before product edits.
- Test-first RED: initial six, then thirteen focused cases failed against the
  original implementation (`/mcp` missing, interview state missing, limits not
  implemented). The first fixture parsed non-JSON 404 as JSON; that fixture was
  corrected before recording the intentional assertions. A missing-feature RED
  is not claimed to prove each later protection branch.
- `npm run review`: **151 passed, zero failed/skipped/cancelled**, about 62 s.
  Includes 21 new tests: real SDK HTTP+SSE, concurrent actors/request IDs,
  token admission and all source entries, auth/drain/disconnect/timeout,
  response-size error, calendar/kind/revision checks, atomic capacity rejection,
  concurrent different answers, status recovery, existing review invalidation,
  source/interpretation gaps and generated Actions schema.
- Three controlled mutations of generated files were detected: disabled closed
  request guard; retaining a previous review after an answer; removed actor-map
  bound. Each produced an assertion failure; original bytes restored in finally.
- Lifecycle module faults use a fake response and transport only to inject
  connect/handle failures, stalled output and overlapping finish/close. Real SDK
  integration separately exercises actual response/abort/drain behavior.
- The existing exact Actions path-list assertion was expanded by the approved
  `/api/research/answer` route; no existing test was disabled or weakened.

Package check, Linux CI, Pro CODE review and real deployment evidence will be
recorded when completed. These tests are synthetic and publish no GitHub PR or
private case facts. A successful interview is not an assurance that the client
identified every applicable legal requirement or followed every instruction.
