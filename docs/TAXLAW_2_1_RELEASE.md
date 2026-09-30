# Korean Taxlaw MCP v2.1.0 integration

The reviewed `hyunae52/korean-taxlaw-mcp` fork merges upstream
`a91872fed2c12cd51fffdc4c2dbbfcabe997262b` (v2.1.0), retaining the fork's daily
candidate PR workflow, installation identity, and operational notices. Its
downstream version is `2.1.0.post1`; runtime code and tests match upstream except
for that version identifier. Existing locked external dependencies are retained.

Document-number lookup checks subsequent pages, reports `LOOKUP_INCOMPLETE`
at the bounded search limit, and preserves ambiguous candidates through unified
search. Explicit requests for curated cases, audit appeals, and taxpayer
protection decisions use their source-specific search actions. Invalid dates and
inconsistent upstream counts remain errors rather than evidence of absence.

The Harness refreshes the commit/archive pin and the real stdio `tools/list`
snapshot. It preserves the new `LOOKUP_INCOMPLETE` error, pagination details, and
guardrail through REST and MCP. The statute provider remains at 4.15.0.

The mandatory runtime audit also identified newly published advisories in two
existing Node dependencies. Only `fast-uri` (3.1.7 to 3.1.8) and `ip-address`
(10.7.0 to 10.7.2) are refreshed within their existing compatible ranges. The
lock files remain identical, and the full application/package checks are rerun
on this dependency set.

Validation includes the provider's locked Python 3.11/3.13 offline suite,
selected live upstream tests, Harness review and package checks, and the expanded
real Express/stdio smoke suite. Production activation changes the application
and tax provider selection together, under the deployment lock and ingress
fence, with the previous application and provider available for rollback.

After successful verification, the operator updates the auto-deployer's provider
fingerprint, manifest hash, and tax commit baseline. Future application-only
main merges continue through the existing automatic deployment workflow. The
daily upstream watcher continues to compare the running provider against both
the reviewed fork and zisu17 upstream; it does not automatically activate code.
