# Runtime dependency maintenance

The daily provider workflow updates the official law package, the reviewed tax
provider, kordoc and a compatible Zod release. It cannot change unrelated
application dependencies, scripts or deployment controls.

## 2026-10-27 automatic update repair

The scheduled candidate for law MCP 4.15.14 failed `audit:runtime` before
publication. That law release replaced its nested kordoc/Zod dependency, while
the application's kordoc 4.21.31 still used vulnerable Zod 3. The old exception
required two exact legacy dependency paths and correctly rejected the changed
tree. The updater only selected law/tax releases, so retrying could not repair
the application's remaining parser dependency.

- Update law MCP to 4.15.14 and application kordoc to 4.24.11; retain compatible
  application Zod 4.6.7. Both parser copies now use Zod 4; remove the obsolete
  advisory exception and its checksum manifest. No advisories are waived.
- Select the highest stable Zod release satisfying the selected kordoc's actual
  npm dependency range, not the global `latest` tag. Reject downgrades, changed
  release identities, invalid metadata and missing compatible releases.
- Detect kordoc-only and Zod-only updates even when law/tax have no new release.
  Update the parser's version/commit/integrity manifest together with both locks.
- The offline parser checks that release manifest at runtime, so each parser
  upgrade does not require a source edit. Only the manifest's exact file is added
  to the worker's filesystem permissions; network/process/resource limits stay.
- The trusted publisher permits only the three named npm pins, the tax pin/tool
  snapshot and the parser identity. It independently rechecks the parser/Zod
  registry metadata and rejects incompatible ranges, altered scripts, PDF engine
  changes, lock drift and same-version identity changes.
- Install pinned updater tooling from the trusted base before preparation and
  publication. Candidate contents are inert JSON in the privileged job; no
  candidate lifecycle scripts run.

## 2026-10-25 patch

- MCP SDK 1.32.2, Nodemailer 10.2.1, law MCP 4.15.12 and application Zod 4.6.7.
- Refresh compatible transitive security fixes while preserving both kordoc pins.
- Use actual Zod 4 validation, including early rejection of oversized collections.
  Preserve input defaults, partial date records, generic UUID-shaped identifiers,
  redacted diagnostics and published JSON input schemas.
- Keep moderate/high/critical audit failures blocking, including network/format
  failures. Raw audit output is still read; it is not represented as zero findings.

The October 25 release temporarily scoped GHSA-mrhx-c7xc-m3w5 to reviewed unused
parser APIs with exact byte/consumer checks. That exception is retired by the
October 27 update; the current audit blocks every moderate/high/critical finding.

## Verification

CI uses the existing clean install, runtime audit, secret scan, full review and
clean package review. tests/runtime-dependencies.test.mjs additionally proves
oversized-array rejection before child validation, normal contract compatibility,
and rejection of advisories (including the former exception). Provider tests
cover independent parser/Zod updates, compatibility selection, trusted publication
boundaries and registry identity. Real PDF/HWP/HWPX fixtures and clean installed
package tests cover the parser under its production process restrictions.
