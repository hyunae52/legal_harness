# Review gate

Run `npm run review` after changes. This compiles TypeScript, then executes the
native ESM tests serially across files to avoid multiple upstream startup races
on small machines. Tests still exercise concurrent requests explicitly.

The suite covers authentication/session binding, input contracts, disconnected
caller capacity, complete upstream results, uncertainty-aware gates, source
refresh deadlines, PostgreSQL roles/RLS/atomic intake, fencing, update candidate
selection and rollback, independent-review failure handling and release identity.

`npm run review:package` separately packs and installs the artifact into a new
empty prefix, then uses real SDK stdio/SSE transports against a local fixture.
It writes the artifact digest and evidence beneath ignored `.runtime/`.

Injected model, GitHub, runner, clock and upstream responses are deterministic
fixtures, not evidence of external AI approval or production deployment. Default
tests make no law API calls, create no PR, and do not change the live database.
Explicit live public-law check: `node scripts/source-smoke.mjs --live` after build.

`tests/taxlaw-client.test.mjs` covers the optional pinned NTS provider with a
real stdio fixture and authenticated Express REST/SSE. In-band NTS errors must
not become successful retrievals; MOLEG serials are not NTS document IDs.
After `python scripts/install-taxlaw-mcp.py`, run
`node scripts/taxlaw-smoke.mjs --live` to check five real public NTS documents,
structured sections, truncation, document-number variants and negative inputs.
Python and internet access are only required for this explicit live check.

The proposed CI uses an ephemeral GitHub-hosted runner with no production secrets.
It is stored in `deploy/review.workflow.yml.example`; publishing an executable
workflow was blocked by the current token's missing workflow scope. Linux CI
has NOT run. Once separately installed by the operator, it remains an
ordinary regression gate; the independent maintenance worker remains disabled
until its isolation and trusted evidence adapters are implemented and verified.
