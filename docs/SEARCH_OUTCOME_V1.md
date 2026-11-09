# Search outcome v1

2026-11-09 implementation of the separate search classification plan. The user
authorized code, external review, then deployment in that order. This supersedes
the draft's earlier plan-review-before-code sequence. Actual code review and
deployment results must be recorded separately; this document is not approval.

## Scope and behavior

Set `TAXLAB_SEARCH_OUTCOME_V1=true` to enable the common retrieval boundary.
The default is false. The exact NTS version, commit and contract must match
`upstreams/search-outcome-contracts.json`. The provider receives its proof flag
only when that match holds. A subsequent automatic provider update does not
silently inherit permission to normalize empty results.

Only ordinary NTS `search_tax_interpretations` and `search_tax_decisions` lists
may normalize a verified legacy NOT_FOUND into `isError: false`. Exact-number
options, special modules, local tax and compound tools remain excluded. The
classifier does not call a source, retry a request, widen a query or change limits.
Existing successful content, IDs, order and provenance remain intact.
Omitted list limits use the pinned public default of 10 in both classification
and enabled research page/signature observation, without adding or changing
outbound arguments. Disabled observation and explicit recipe limits are unchanged.
Research's new positive-page proof gate
uses the same ordinary NTS scope; excluded local/special successful pages keep
their existing structural, count and duplicate checks.

**Law-provider `search_decisions` is not normalized in this release.** Its pinned
output does not expose sufficient raw-response proof; automatic query/date
fallback further prevents certifying the original scope. A bare NOT_FOUND is
reported as `unclassified`, preserving its original failure. A separate provider
source/release change is needed before that route can be enabled.

NTS raw responses use a sparse facet array, not a total field. Two public empty
fixtures verify the explicit empty-array form. This is the plan's documented
schema-omission exception, not a default-zero fallback. Missing fields, bad
counts, non-success envelopes, HTML and contradictions remain errors. The
provider's new parser is opt-in and limited to ordinary lists. Unknown tax
filters, partial rows, duplicate IDs and a zero-total page other than page 1
cannot certify an empty first page.

`_meta["legal-harness/retrieval-outcome"]` contains only the contract, operation
and status. Error sanitization preserves only metadata created by this process,
using a WeakMap; it cannot copy arbitrary provider metadata or request markers.
The original error code and retry instructions remain intact for real failures.

Research uses the same response. In v1, bare NOT_FOUND and unsupported/partial
results cannot satisfy an empty-search obligation. An out-of-range page does
not discharge unread-page obligations. A verified empty search can continue
the existing recipe, with the same subsequent steps and budget as the prior
successful-empty control. It does not certify legal absence or a final answer.

## Isolated counts and 06:00 mail

When v1 and `TAXLAB_USAGE_DB` are configured, an optional worker aggregates fixed
enums and counts in `<TAXLAB_USAGE_DB>.outcomes.sqlite`. No existing usage table,
transaction, recipient, schedule or delivery receipt is changed. The queue holds
at most 128 events, the independent DB is limited to 4 MiB with 35-day retention,
and neither retrieval nor drain waits for writes. A failing/full collector drops
records without altering provider calls or user responses.

Only known retrieval tools create events, once per completed source call.
Fields: tool, operation, outcome, fixed provider/version, original error code,
completion day and count. No query, arguments, raw result, error message,
document identity, client identity or input hash is collected. Repeated calls
count separately. Shutdown may lose queued events; this is visible as missing
coverage, never zero-result evidence.

The existing protocol-success table stays separate from the new **source**
retrieval table; their counts are not added together. A 06:00-crossing operation
belongs to its completion window. The optional reader compares each tool's
recorded count with the existing source denominator and labels missing or
inconsistent data as partial/uncollected. Mixed/unsupported versions remain
visible. A normalized empty result changes protocol success accounting; it is
not evidence of improved search recall. Historical failures are not relabeled.

## Verification and rollout

- Provider tests validate real public raw fixtures and malformed HTTP 200 cases.
- `npm run review` covers pure classification, disabled mode, transport-thrown
  errors, collector failure/full queue, 06:00 boundaries and existing behavior.
- `python scripts/install-taxlaw-mcp.py --dev` then `npm run review:search`
  runs the actual pinned Python provider against intercepted public/synthetic
  HTTP fixtures through direct MCP, REST and research. It also compares complete
  follow-up call sequences with the existing normal-empty research control.
- Existing `review:package`, runtime audit and secrets gates remain required.
- CI installs the same immutable provider archive for the offline integration
  test before exporting a deployable main package.

Deploy only after external code review and exact-candidate CI. Enable the NTS
route with the reviewed candidate under the existing deployment ingress fence;
the deployment gate verifies package/pin identity and existing provider smoke
before resuming public traffic. Independently verify the enabled contract and
new search behavior after activation. Preserve the prior absent/disabled flag
configuration for rollback. Live
smoke uses public synthetic queries, not replayed user traffic. No live source
call is added to the classifier or collector.

Rollback: set `TAXLAB_SEARCH_OUTCOME_V1=false` and restart through the existing
release procedure. This disables provider proof validation as well as response
normalization and new collection, without a DB migration. Preserve the prior
package and NTS pin for full package rollback. Auto-updates remain unchanged;
an unreviewed pin defaults to unclassified behavior. Existing evidence/legal
gates, concurrency, queue policy, cache sizes and retry settings are unchanged.
