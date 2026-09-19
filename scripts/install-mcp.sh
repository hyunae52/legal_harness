#!/usr/bin/env bash
# Install a reviewed local tarball. No network script piping or agent config guessing.
set -euo pipefail
artifact="${1:?Usage: bash scripts/install-mcp.sh /absolute/path/reviewed-package.tgz [destination]}"
destination="${2:-$HOME/.taxlab/legal-mcp}"
case "$artifact" in /*.tgz) ;; *) echo 'Provide an absolute path to the reviewed npm tarball.' >&2; exit 1;; esac
test -f "$artifact"
node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
mkdir -p -- "$destination"
npm install --prefix "$destination" --ignore-scripts --omit=optional --no-audit --no-fund -- "$artifact"
npm ci --prefix "$destination/node_modules/k-tax-agent-backend" --ignore-scripts --omit=dev --omit=optional --no-audit --no-fund
node --input-type=module - "$destination" <<'NODE'
import {resolve} from 'node:path';
import {access} from 'node:fs/promises';
const bridge=resolve(process.argv[2],'node_modules/k-tax-agent-backend/scripts/hermes-mcp-bridge.mjs');
await access(bridge);
console.log(JSON.stringify({mcpServers:{'taxlab-legal':{command:'node',args:[bridge],env:{TAXLAB_SERVER_URL:'https://law.taxlab.kr',TAXLAB_API_KEY:'<your existing server key>'}}}},null,2));
console.log('Add this entry to your MCP client. Existing configurations have not been overwritten.');
console.log('Set the key in your client environment, then run the installed bridge with --doctor.');
NODE
