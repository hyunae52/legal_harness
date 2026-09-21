# Public MCP access

User intent: connect to law.taxlab.kr without obtaining or entering an access key. Public legal retrieval, research/interview and correction PR proposals must remain usable. Existing request, lookup, provider, memory and publication limits remain in force. Merge authorization is unchanged.

Baseline: main c7c75e7c129efc9936a97666e2b2b2e5c95c97e7; `npm run review`: 152 pass, 0 fail, 0 skip on 2026-09-21.

## Implementation contract

| ID | Observable behavior | Verification |
|---|---|---|
| PA-01 | Opted-in deployment accepts header-free MCP HTTP, SSE and REST retrieval; protected deployments and invalid supplied credentials still reject access | Real SDK/HTTP routes |
| PA-02 | Research and correction preparation automatically return an opaque client_session; subsequent state operations require that session, and another session cannot read or modify the same resource | Research and correction HTTP/SDK flows |
| PA-03 | Session information never reaches upstream source tools, GitHub proposal content, public instructions/examples or error output | Adapter input/output assertions |
| PA-04 | Anonymous sessions cannot multiply peer rate, transport or research admission limits; global protection remains in force | Controlled provider and bucket tests |
| PA-05 | Only an explicitly trusted loopback proxy may supply CF-Connecting-IP for rate grouping; arbitrary forwarded headers never determine ownership | Auth/peer unit tests |
| PA-06 | PR preparation never publishes; exact preview confirmation is still required, publication stays bounded and cannot merge | Real correction service with fake GitHub boundary |
| PA-07 | Session signing survives an application restart with a persisted operator-only secret; tampering, expiry and missing secret fail closed | Fixed-clock session tests |
| PA-08 | Public installation files, bridge and Actions schema require no manually entered key; retained credentials remain optional for existing private clients | Artifact and clean-directory bridge tests |

Explicit public activation uses TAXLAB_PUBLIC_ACCESS=1 and a persisted TAXLAB_PUBLIC_SESSION_SECRET (at least 32 random bytes). No user receives that operator secret. Read-only lookup needs neither login nor client_session. start_legal_research and prepare_correction_pr issue a signed 48-hour session automatically if none is supplied; reuse during preparation refreshes the same identity for the new operation's lifetime. The AI carries the returned client_session in follow-up tool arguments. Authenticated ownership is unchanged. The existing 30-minute research lifetime and 48-hour proposal lifetime remain authoritative.

Anonymous rate grouping uses a keyed hash of the actual socket peer, or a validated CF-Connecting-IP only when the operator explicitly trusts the loopback Cloudflare tunnel. Rate grouping is separate from the signed session identity; IP addresses do not authorize access to stored research. Same-proxy/NAT users may share a quota. Anonymous durable legacy failure intake remains unavailable; public corrections use the PR proposal flow.

The public session is a bearer capability handled by the AI, not a setup credential. Keep it private and out of sources, PRs and user-facing answers. A lost first preparation response cannot reveal the new capability; use the same request ID and retain an already-issued session when one exists. Do not create duplicate proposals automatically after uncertain responses.

Verification order: focused RED, minimal implementation, same focused GREEN, full review and package gates, public-safe Pro review, staged anonymous SDK/bridge checks, controlled release and public HTTPS verification. No production cutover until deployment checks and the requested review are satisfied.

Pro review: the fresh Pro conversation on 2026-09-22 reviewed commit `dc83bde52c1fbf8079010052b2ef494180a241fc` and reported one P2 finding, PA-C1: word boundaries let a valid session escape content detection when joined to letters, digits or underscores. Its initial verdict was CODE FAIL / DEPLOY HOLD. The finding was independently reproduced in the retrieval guard, correction service and diagnostic sanitizer, then corrected by removing content-pattern word boundaries while retaining the anchored authentication pattern. The current review record is in PR #11; the initial verdict is not approval of a later candidate.

## Implementation evidence (2026-09-21)

Mode: test-first implementation. Initial four route contracts failed as intended with 401 instead of anonymous success on the private baseline. After implementation the same contracts passed; five subsequent boundary cases were added as coverage and passed. They are not claimed as original RED evidence.

- `npm run review`: 161 tests passed, 0 failed/skipped/cancelled. Includes real SDK HTTP/SSE, actual correction persistence with fake GitHub writes, and the extracted keyless Claude bundle from an empty directory.
- `npm run review:package`: nine checks passed, including installed public stdio/SSE, HTTP session continuity, doctor without credentials and legacy authenticated doctor. Dependencies stay pinned; no new runtime package.
- After final guide wording changes, `npx tsc` and the 31 public-access/route regression cases passed again.
- Four controlled compiled-code mutations were independently killed: disabled public access (PA-01), shared anonymous owner (PA-02), session-specific quota identity (PA-04), ignored session signature (PA-07). The original compiled files were restored and the focused tests passed again.
- Browser inspection of the local guide confirmed keyless setup text, working section navigation, and no overlapping or clipped desktop content. Real third-party app installation UI remains unverified.
- Existing guide/schema tests changed because the requested authentication contract changed, while private-route rejection tests were retained.

The anonymous tool catalog excludes legacy authenticated `submit_failure`; anonymous corrections use prepare/confirm PR tools. Legacy owner-key/JWT calls still work and retain their existing ownership semantics. Bad credentials are not downgraded, and unexpected Origin checks stay active. Public session values are stripped from state tool arguments, blocked when accidentally embedded in provider queries/proposals, and removed from error diagnostics.

Read-only live verification is available through `node scripts/research-smoke.mjs --live --public`. It checks anonymous REST/SSE/HTTP, an actual NTS document, exact/forged quotation behavior and an unknown interview answer without a GitHub publication. Its report deliberately omits client_session.

## PA-C1 regression evidence (2026-09-22)

The added boundary regression failed on the reviewed code, then passed with the shared detection pattern corrected. It covers bare and concatenated capabilities through REST, real MCP and research lookup; correction routes and direct persistence; multiple capabilities in error text; and rejection of decorated authentication tokens. Provider calls, stored proposals and GitHub writes remain zero for rejected content. A normal session continues to authorize its own research.

After the runtime correction, the full review passed 162 tests without skips. The final expanded boundary checks and all ten public-access tests also passed. All nine installed-package checks passed with artifact SHA-256 `76c6625dec581a7596b1ab050603a15031625961b87e7f4d87dbec85168ff6a0`. CI and focused Pro re-review evidence must bind the exact revised candidate rather than reuse the original artifact's approval status.

Release status is tracked separately from code review. Production activation requires a persisted signing secret, verified loopback proxy trust, correction-service readiness, controlled drain/rollback and anonymous public HTTPS checks. Local and fixture evidence must not be presented as a deployed public endpoint or a legal judgment approval.
