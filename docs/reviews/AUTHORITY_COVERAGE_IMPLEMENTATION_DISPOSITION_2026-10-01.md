# Authority coverage implementation follow-up

Status: implementation in progress; not approved for release. Base HEAD: cdb64f9ed44f7267668d9574cb255975172709f9, branch feat/authority-coverage.

The completed intermediate Pro review identified F-1 through F-6. Its exact response is saved beside this file. Codex independently confirmed the reported paths, added failing tests first for identity conflict, expired in-flight reservations, revision reuse, unread law versions and alternate source recovery, then implemented the changes.

| Finding | Disposition | Evidence |
| --- | --- | --- |
| F-1 broad/recursive research | Accepted with a bounded criterion recipe and discovery roles. Mandatory candidates are retained, Supreme Court is prioritized, distinguished follow-up discoveries do not recursively create more searches. Adopted/analogized grounds do. | Plan §14; real issue-query discovery without a case-number hint; live complete retrieval run; supplementary/mandatory scope and subsequent tests |
| F-2 tribunal and amendment overclaim | Accepted. Tribunal/review and court follow-up are distinct. Law ID/MST/effective-date candidates require exact version bodies and temporal application references. | New law MST and court-zero-versus-tribunal tests |
| F-3 valid alternative retrieval stays failed | Accepted. Match observed document, known version, role/date, purpose and issues, never arbitrary successful work. | Positive verified alternative and negative wrong document/version/role/partial-body tests |
| F-4 revision has no recovery path | Accepted. Public `reuse_legal_evidence` binds immutable complete manifests to a new revision without body duplication, a new retrieval timestamp or restoring past review/search success. | 32 stored unit revision test; source call count remains unchanged |
| F-5 independent issuer conflict | Accepted. Classify both issuer and court observations, preserve conflicts. | Conflicting agencies and single-known-field positive tests |
| F-6 expiry releases live resource budget | Accepted. In-flight reservation and retained expired-session bytes are separate from the logical session map; release in actual call cleanup. | TTL race keeps second call out until first settles, then permits it |

Executed evidence (local logs under `.runtime/authority-coverage-implementation-20261001/`):

- `pro-followup-red.log`: the new defect tests failed before the production fixes.
- `pro-fixes-tests-3.log`: 58 tests passed, 0 failed, including the additional tribunal/scope/rate-limit tests and Actions schema regression.
- `full-review-2.log`: 267 tests, 266 passed, 1 failed only because the explicit Actions path fixture omitted `/api/research/reuse`; corrected and verified in the targeted run.
- `full-review-3.log`: all 271 tests passed, no failures/skips. `package-1.log`: all 9 package checks passed, artifact SHA-256 `a839f174e0ecd552dacd4da455d7bee8941d3ed3ade8ea95c6fab36dc5f3f6a8`. This is the Windows development artifact, not a main CI deployment artifact.
- `live-session-attempt1.json`: failed exploratory development run retained; upstream rate limiting remained an error.
- `live-session.json`: 38 actual provider tool calls; 17 search obligations performed; 14 candidates and 15 returned body units; no incomplete required search. Provider-call durations sum to 29,501 ms, with pacing outside calls. JSON body storage is about 0.4 MB; recorded parent process RSS peaked around 77 MB. These figures do not measure upstream internal HTTP calls or all child-process memory.
- Both live runs first discovered the Supreme Court documents through law/article/issue queries, without input case-number hints. A later-numbered decision concerns old-law move-in/lease rules; it is not automatically treated as overruling the acquisition-sequence decision.

Model protocol: `docs/evidence/authority-pilot-protocol-20261001.json`. Actual original-reported model slug `gpt-5.6-sol` with `xhigh` is available through the installed Codex CLI. A connectivity-only EVAL_READY result is not a pilot pass. Eight cases × three repetitions, semantic evaluation and the normal structurally complete control are pending. Controlled synthetic cases are labeled separately from live official sources.

Pro availability: after the intermediate response, the ChatGPT UI displayed a usage-limit warning and the model menu explicitly disabled Pro. No non-Pro response was requested or counted as Pro. The same conversation remains open at https://chatgpt.com/c/6abe1ed3-1050-83ee-99d7-d681aa03cf0b. Final independent Pro assessment is pending service availability.

The initial model-development batch (`pilot-a`) was stopped and retained because the noninteractive client had not granted the already-authorized ephemeral research tools; it failed them with `MCP tool call requires approval, but approval policy is never`. The corrected evaluation configuration uses documented per-tool `approval_mode=approve` only for the eight local research tools, with the read-only filesystem sandbox and no PR publication approval. No user/global Codex configuration is changed. These aborted runs are not release passes. Reference: https://learn.chatgpt.com/docs/config-file/config-reference .

At this checkpoint no merge or production deployment has occurred. A feature PR may be prepared for review while the remaining release checks run. README.md and NEXT_STEPS.md contain unrelated user edits and are preserved.
