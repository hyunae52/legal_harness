# Daily private usage email

The operator requested private delivery every day at 06:00 Asia/Seoul,
covering the preceding 06:00–06:00 period. The midnight-based historical report
remains available. New `usage_morning` aggregates record completed operations in
the same transaction as `usage_daily`; an operation completing at/after 06:00 goes
into the following email. There are no query bodies, responses or user identities.

Past midnight aggregates cannot reconstruct these windows. The first report
states its actual collection start and is marked partial. MCP, REST and internal
source counts remain separate; counts are not unique visitors or external demand.

Failure reasons are recorded per tool and fixed, allowlisted error code in the same
transaction as the daily and morning totals. Reports include Korean categories and
the ten most frequent tool/code pairs; remaining pairs are summarized without losing
their failure count. Raw payloads, exception messages, arbitrary code strings and
identities are never stored. Unknown errors remain explicitly unclassified. Historical
failures without code rows appear as UNRECORDED; no causes are guessed or backfilled.
The operator JSON report exposes all retained code counts and the collection start.
Categories describe returned errors, not legal-answer correctness or server uptime.

`dist/usageMail.js` previews by default. `--send` uses the closed morning window;
`--test` sends a clearly labelled setup message. Required delivery arguments:
`--database ABSOLUTE_PATH --config ABSOLUTE_PATH --state ABSOLUTE_PATH --to ADDRESS`.
Reuse the existing private Gmail SMTP configuration; do not put its password in
the unit, command line, repository or email. The existing update alert is unchanged.

An exclusive private pending record is created before SMTP. A confirmed accepted
delivery becomes sent and is not sent twice. A crash or uncertain SMTP result
leaves pending: inspect the mailbox before manually resolving it. Automatic blind
retries are intentionally disabled. Delivery records contain only period, recipient
and status; they do not contain credentials. Systemd preserves the next scheduled
run across restarts; after downtime it reports the latest completed period.

Install the service/timer from deploy, and install run-usage-mail.sh as
`/home/cta/.local/lib/legal-harness-usage-mail/run.sh` with mode 0755. Create the
private state directory with owner cta:cta and mode 0700 before activation. Verify
the recipient is stored as a single newline-terminated address in the private
`/home/cta/.config/legal-harness/usage-email-to` file with owner cta and mode 0600.
Keep the recipient out of the public repository. Verify
the current release has usageMail.js, preview and send one setup email, then enable
the timer. The wrapper resolves the active release each time. Rolling back to an
older release without this feature fails visibly instead of inventing zero counts.
