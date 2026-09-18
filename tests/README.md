# Backend review gate

Run `npm run review` from the repository root after installing dependencies.
Use Node.js 22 or newer. The gate first compiles the project to `dist`, then
executes the current `src/index.ts` route implementation in isolated fixtures
with a real Express server bound to loopback, and tests the compiled MCP client.

Supabase uses the real JavaScript client with a fake HTTP transport. Test tokens
and user identifiers are synthetic. Environment files are not loaded. The judge
and GitHub adapters are stubs, so the tests do not create PRs, access a remote
database, call a model, or spend scraping credits.

`mcp-client.test.mjs` runs real stdio JSON-RPC child processes: handshake,
pagination, shared connections, result fidelity, timeouts, crash recovery,
capacity, environment isolation and shutdown. It also starts the installed
official korean-law-mcp package and lists its tools without calling legal APIs.
`supabase-schema.test.mjs` executes the migration in local PostgreSQL (PGlite),
emulating Supabase auth roles and auth.uid() to test triggers, RLS and grants.
`review-regressions.test.mjs` additionally checks HTTP routing, tool errors and
caller-supplied draft validation. The original nine behavior checks remain.

`mcp-update.test.mjs` tests bootstrap, version comparison, activation ordering,
failed install/verification, rollback, interrupted-update recovery and release
retention with filesystem artifacts. npm installation, PM2 restarts and HTTP
health checks are injected offline operations. Release-file selection/version
matching also runs against a real MCP child in `mcp-client.test.mjs`. These tests
do not install cron or restart any live deployment.

The checks cover authentication rejection, concurrency accounting and admission,
missing quality-gate configuration, database authorization headers, returned DB
errors, and required query input. Native ESM import linking is checked separately
from the CommonJS route fixture. A focused correction-routing case also checks
that a timing-rule violation does not return another rule's correction text.
The real installed `js-yaml` and Zod libraries are used by the route fixtures.
A failing assertion is a failed backend
contract, not an expected successful test outcome. Fix the application before
claiming the gate passes; do not turn failures into skips or change assertions
to accept the current broken behavior.

This gate does not certify the legal correctness of `fail-cases.yaml`, live
law API credentials/data, the caller-facing MCP server transport, real AI
review, PR creation, or a deployed Supabase RLS policy.
The VM fixture is a test adapter, not a security sandbox. If the application
entrypoint is refactored, update the adapter while preserving the behavior checks.
