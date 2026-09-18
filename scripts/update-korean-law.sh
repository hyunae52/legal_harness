#!/usr/bin/env bash
# Linux deployment entrypoint. The OS releases this lock even after a crash.
set -euo pipefail
app_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$app_dir"
mkdir -p -- "$app_dir/.runtime"
command -v flock >/dev/null || { echo "flock (util-linux) is required" >&2; exit 1; }
export LEGAL_HARNESS_UPDATE_LOCKED=1
exec flock --nonblock --conflict-exit-code 0 "$app_dir/.runtime/mcp-update.lock" npm run mcp:update -- "$@"
