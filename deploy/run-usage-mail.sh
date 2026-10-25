#!/bin/sh
set -eu
release_dir=$(systemctl show legal-harness-a.service --property=WorkingDirectory --value)
case "$release_dir" in /home/cta/legal-harness-autodeploy/releases/*) ;; *) echo 'USAGE_MAIL_RELEASE_UNAVAILABLE' >&2; exit 1;; esac
test -f "$release_dir/dist/usageMail.js"
IFS= read -r recipient < /home/cta/.config/legal-harness/usage-email-to
exec /usr/bin/node --no-warnings "$release_dir/dist/usageMail.js" \
  --database /home/cta/.local/state/legal-harness-usage/usage.sqlite \
  --config /home/cta/.config/legal-harness/upstream-email.env \
  --state /home/cta/.local/state/legal-harness-usage-mail \
  --to "$recipient" --send
