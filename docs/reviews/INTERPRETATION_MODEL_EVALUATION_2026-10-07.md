# Interpretation workflow model evaluation

This evaluation separates a successful code review from evidence that a client model can use the new workflow. It is a closed-world synthetic experiment, not a measurement of Korean legal accuracy or source-discovery recall.

## Fixed method

- Twelve scenarios, three repetitions per arm, using `gpt-5.6-sol` with `xhigh` reasoning. Four scenarios are held out from the initial development examples. Repetitions are not counted as additional independent cases.
- Eight scenarios provide an erroneous draft; four require a justified definitive or conditional answer from scratch. Sources and discovery are fixed equally for both arms. The different review workflow is the intended intervention.
- The protocol and prose oracle were frozen before the runs. Protocol SHA-256: `18e9ec71a647149d4761f05747a441bdbeca06a6a4d1b8ce78ecb93f0e582d7b`; oracle SHA-256: `2aaa385a2d0216543768daad46ff3fc244df63aa23213aba27de7af00dbb66fd`.
- The runner freezes each source/runtime tree and retains prompts, tool calls, final answers, timing, usage and hashes. The current candidate is paired with all 36 unchanged baseline trials; all superseded candidates remain available.
- The implementation owner reads shuffled, arm-hidden full answer prose before joining the arm mapping. This is not independent human or Pro grading. Later runs also cannot claim a fully independent blind study because the grader has seen earlier outputs.
- Server procedure completion, the model's own readiness label, and semantic correctness are different measurements. Neither a readiness flag nor a stated outcome enum is a semantic oracle.

## Retained unsuccessful candidates

| Metric | Baseline | Candidate R1 | Candidate R3 |
| --- | ---: | ---: | ---: |
| Protocol-valid trials | 36/36 | 36/36 | 36/36 |
| Original decisive errors detected | 24/24 | 24/24 | 24/24 |
| Incorrect or unverified corrected answers in injected cases | 2/24 | 0/24 | 0/24 |
| Held-out incorrect or unverified answers | 2/12 | 0/12 | 0/12 |
| Normal cases with justified answers | 12/12 | 11/12 | 10/12 |
| Median trial seconds | 22.945 | 87.345 | 89.07 |
| Total MCP calls | 56 | 305 | 316 |
| Release quality gate | Reference | **FAIL** | **FAIL** |

The failures were normal case C09. Although its supplied rule explicitly has no other requirements, semantic self-review inferred another event-date requirement from the synthetic provider's effective-date metadata. The answer then became unnecessarily conditional. We did not reclassify this as success or discard the failed repetitions. Both arms already detected every seeded original error, so the observed correction improvement must not be described as increased original-error detection.

R3 generation preceded R4's strict remap-target validation fix. A separate replay of all 316 recorded research-call inputs showed identical parsing outcomes under R3 and R4, with no remaps/removals used. This is limited compatibility evidence, not a claim that stochastic model generation occurred on R4. R3 failed the answerability gate regardless.

Raw retained runs: `.runtime/reasoning-quality-20261007-r1`, `.runtime/reasoning-quality-20261007-r3`; paired R3 analysis: `.runtime/reasoning-quality-20261007-final`. The historical directory name `final` does not mean it passed.

## R5 correction and completed evaluation

R5 adds a required, immutable `review_policy` packet unit. The client reviewer must preserve the question's premises, distinguish rule-application hypotheticals from actual-case applicability, and explain the source and consequence of any additional condition. Necessary real-case dates, transitions, contrary evidence and unknown facts still require review. Packet delivery is not proof that a model follows the instruction.

The change was prompted by development case C09. The full 36-trial candidate run used the same frozen protocol, oracle, model and effort, including every held-out scenario. All 36 completed and all raw evidence hashes were verified. The fixed semantic criteria passed: candidate 36/36 versus baseline 34/36; normal answerability 12/12 for both; held-out wrong/unverified answers 0/12 versus 2/12; original error misses zero in both arms, with all eight error classes detected.

The two groups have different frozen tasks. `reasoning-model-pilot.mjs` explicitly instructs the injected group to audit the seeded draft and output the corrected critique without rewriting that draft. Its prose is therefore **not** a server-reviewed final answer and is never allowed to inherit the seeded artifact's readiness. The normal group must submit and review its own exact final answer. The repaired reporter records binding for both groups, requires successful same-research structure responses, and requires a current matching accepted packet for normal candidate answers. Missing/changed traces or other required evidence are unverified. No frozen prompt or oracle was changed to add these checks.

Two candidate C10 runs incorrectly self-reported `review_ready=true` while the server returned false for the same conditional answer. This remains a disclosed client-compliance limitation, not a server approval. Their conditional prose is correct and the fixed oracle explicitly separates readiness from semantic correctness. The baseline has no v2 readiness field, so its 36 readiness claims are unverifiable rather than counted as matches. Consumers must use the server response bound to the exact text; this experiment does not prove that every client model reports the flag faithfully.

The cost increased in this synthetic comparison: median trial time **22.945 → 99.455 seconds**, total MCP calls **56 → 265**. This is not a production latency forecast. No server-side LLM service or new paid API is introduced; additional reasoning happens in the connected client model.

Current retained pair: `.runtime/reasoning-quality-20261007-r5-paired`. A second complete pairing with byte verification before copying is `.runtime/reasoning-quality-20261007-r5-verified-paired`; it retains the same 72 trials. Machine-readable results and release criteria are recorded in `docs/evidence/interpretation-model-quality-20261007.json`. Baseline semantic grades were compared case-by-case with the previous assessment and were unchanged.

During live preflight, the pinned law provider returned a newer `검색 결과 (총 N건, display=D 적용)` header that the old research adapter did not recognize. The release adds support for that exact annotation and checks its display value, while preserving row-count, uniqueness, truncation and pagination guards. The same observed live response changes from `SEARCH_SCOPE_UNOBSERVED` to one parsed hit out of nine with `has_more=true`; it is not marked as exhausted coverage. This is the only product-runtime delta after the R5 model run. The frozen synthetic provider uses the older header, and replay of its exact response against every distinct law-search argument observed across all 36 candidate trials produced identical old/new observations. R5 model generation was not rerun or represented as occurring on the later parser. The narrow parser delta has separate regression and live-response evidence.

Release requires all deterministic contracts, protocol validity, each decisive error class actually detected, no increase in held-out wrong answers, and normal answerability at least equal to baseline. Because baseline original-error misses are zero, candidate misses must remain zero. Call volume and latency are reported separately. No claim of general quality improvement follows from a small synthetic sample.
