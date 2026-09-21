# Implementation verification: transport and fact interview

Scope is the [approved contract](TRANSPORT_INTERVIEW_PLAN.md). Pro REVIEW passed;
PLAN TP-01–03 closed at `a7e24424e7d84b0c363a6444a72c69260f3941b6`.
Pro CODE passed at `b1fe256d514c68adea66a2b98a522350f2576dd0`.
Deployment preflight TRD-01 is closed. Public deployment and runtime checks have
passed; the final Pro evidence review is pending in this record.

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

Linux CI run 35549450300 at application commit
`85f81cb118b55e251cd5c585d8aa8ae5eec7ade9` passed 151 tests and 8 clean-install
package checks. The 50-file local tarball and Linux CI tarball share SHA-256
`668e1552c4ed5cf31195aaa26e598a24f4179c6e3091dd9e3f6e6c651776863d`.
The later operator-only fix does not change this application artifact.

Pro deployment preflight identified TRD-01: a failed resource/ps observation
could leave a smoke process alive while permitting ordinary rollback. Smoke now
owns a POSIX process group; both the parent and its inherited provider group must
be gone before reporting ordinary completion. Observation errors, live children,
and deadlines report `operation_state_unknown`, which blocks rollback, previous
verification and resume. No kill of an unverified process is attempted. A known
smoke failure still requires application work/auth/dispatch to drain before the
rollback changes systemd configuration. Failure to prove that drain leaves the
ingress fence in place.

The TRD-01 test drives the actual Python classifier through the remote adapter
and rollout gate: monitoring exception, orphan provider, group observation
failure, and post-completion assertion failure. Linux additionally uses real
process groups and a test-only child subreaper to prove orphan behavior and clean
up every fixture. `verify-stage` repeats the read-only source/interview smoke on
the immutable staged install under the corrected operator. Each new phase binds
its operator hash/commit; the original stage record is retained without relabeling.

Unit/package tests are synthetic and publish no GitHub PR or
private case facts. A successful interview is not an assurance that the client
identified every applicable legal requirement or followed every instruction.

Initial GCE stage smoke did read the public NTS document
`서면-2020-부동산-4503`: 4 body passages, quote match, missing-fact and forged-quote
gates, 36 tools over SSE/HTTP, unknown-answer preservation and old-review
invalidation. This is separate from public deployment acceptance; evidence is in
`docs/evidence/transport-interview-deployment-20260921.json`.

## Deployment execution

- Final operator ref `0cb0a36fe10870d5be74a3936085ff1d69d701fa`, CI run
  35550394896 / attempt 1 / job 106183924714: **152 tests, 8 package checks**,
  zero failures/skips, the same `668e1552...776863d` application archive.
- Prior run 35550242720 is retained as a failure: CP-14 had not completed all
  records after 20 refreshes. The fixture retains its 150 ms per-refresh deadline
  and durability/search assertions, using a 30-second eventual-recovery bound.
  Operator bytes are identical to Pro-reviewed `a0543fd`. A controlled removal
  of the unknown classification was detected by the new gate test and restored.
- Corrected operator `verify-stage` passed at 01:20:37 UTC. Fence, application
  drain (all three counters zero), activation, candidate checks and resume all
  passed. Public ingress resumed at **2026-09-21 01:21:33 UTC**.
- Public HTTPS smoke passed at 01:22:05 UTC with the same real NTS body, 36 tools,
  no HTTP session ID, preserved unknown and invalidated prior review. No GitHub
  writes were made by smoke. A separate client observed homepage 200 and
  unauthenticated `/mcp` 401.
- Read-only binding audit checked all 50 application payload files, operator
  files, three Node dependency closures, all 69 Python freeze entries, effective
  systemd/drop-in/runtime selectors and both live provider processes. Main PID
  89499 runs the new release. Prior runtime/publisher env, upstream selector and
  90-research drop-in hashes are preserved; correction state remains 0700.
- Actual health retains 20 transport slots / actor 5 / actual work 3, request
  600/180 and lookup 120/60 global/actor budgets. No registered-user quota or
  client-specific OAuth capability is claimed. PR10 remains a draft for merge.
