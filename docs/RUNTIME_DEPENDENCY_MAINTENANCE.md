# Runtime dependency maintenance

The daily provider workflow updates the official law package and the reviewed tax
provider. It deliberately cannot change unrelated application dependencies.
The main release pinned MCP SDK 1.31.0 and Nodemailer 10.0.10; newly published
advisories therefore stopped the normal runtime audit before tests/deployment.
Retrying the same lockfile cannot repair that failure.

## 2026-10-25 patch

- MCP SDK 1.32.2, Nodemailer 10.2.1, law MCP 4.15.12 and application Zod 4.6.7.
- Refresh compatible transitive security fixes while preserving both kordoc pins.
- Use actual Zod 4 validation, including early rejection of oversized collections.
  Preserve input defaults, partial date records, generic UUID-shaped identifiers,
  redacted diagnostics and published JSON input schemas.
- Keep moderate/high/critical audit failures blocking, including network/format
  failures. Raw audit output is still read; it is not represented as zero findings.

## One scoped, unreachable dependency advisory

Two nested Zod 3.25.76 copies remain in kordoc 4.21.31 and 4.18.2. The root
application and MCP provider use patched Zod 4. The Zod 3 advisory
GHSA-mrhx-c7xc-m3w5 also produces propagated kordoc/law entries in npm audit.

The used kordoc API is parse(Buffer); its complete literal ESM import closures
(14 and 13 JavaScript files) contain no Zod imports. Format-profile/MCP/worker
entrypoints use Zod 3 but are not imported by either consumer. The helper's
PowerShell fallback requires filePath; both consumers supply Buffer without that
option. Installed parser externals and their required dependency graph contain no
Zod dependencies. Optional OCR/browser packages are not installed.

scripts/audit-runtime.mjs recognizes only this advisory and the two exact nested
paths. Before allowing those propagated reports it verifies package versions,
ESM entrypoints, reviewed file checksums, exact application/provider consumers,
external resolutions and absence of new optional extras/computed imports.
upstreams/kordoc-parse-audit.json is the reviewed boundary. Changes fail closed
and need a new source review; do not refresh hashes merely to make the audit pass.
A root Zod 3 copy, another advisory, another vulnerable node or any independent
kordoc/law finding still blocks the gate. This is an exposure-specific exception,
not a claim that the unused upstream Zod 3 APIs were patched.

Remove the exception once both kordoc versions adopt patched validation. Do not
force Zod 4 onto their Zod 3-only format-profile schemas, or use zod/v3 under a
new package version to hide the same vulnerable implementation.

## Verification

CI uses the existing clean install, runtime audit, secret scan, full review and
clean package review. tests/runtime-dependencies.test.mjs additionally proves
oversized-array rejection before child validation, normal contract compatibility,
and rejection of new advisories, root/extra vulnerable nodes, parser byte drift
and newly introduced parser consumers.
