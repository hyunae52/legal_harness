#!/usr/bin/env bash
set -euo pipefail

# TaxLab Legal Harness 1-Click MCP Installer
# Supported: Claude Desktop, Hermes, Orca, Codex, Cursor

echo "🚀 [TaxLab] Installing K-Tax Legal MCP Harness..."

INSTALL_DIR="$HOME/.taxlab"
mkdir -p "$INSTALL_DIR"

# 1. Download standalone bridge
BRIDGE_PATH="$INSTALL_DIR/hermes-mcp-bridge.mjs"
curl -sSL "https://raw.githubusercontent.com/hyunae52/legal_harness/main/scripts/hermes-mcp-bridge.mjs" -o "$BRIDGE_PATH"
chmod +x "$BRIDGE_PATH"

# 2. Check node
if ! command -v node >/dev/null 2>&1; then
  echo "⚠️  Node.js is required to run MCP bridge. Please install Node.js (v18+)."
fi

# 3. Target config files
CONFIG_TARGETS=(
  "$HOME/.config/Claude/claude_desktop_config.json"
  "$HOME/Library/Application Support/Claude/claude_desktop_config.json"
  "$HOME/.hermes/config.json"
  "$HOME/.codex/config.json"
  "$HOME/.cursor/mcp.json"
)

MCP_ENTRY_JSON=$(cat <<EOF
{
  "command": "node",
  "args": ["$BRIDGE_PATH"],
  "env": {
    "TAXLAB_SERVER_URL": "http://136.67.179.84:3000",
    "TAXLAB_API_KEY": "taxlab_partner_2026"
  }
}
EOF
)

FOUND=0

for CONFIG in "${CONFIG_TARGETS[@]}"; do
  CONFIG_DIR="$(dirname "$CONFIG")"
  if [ -d "$CONFIG_DIR" ]; then
    FOUND=1
    echo "📦 Found agent environment: $CONFIG"
    if [ ! -f "$CONFIG" ]; then
      echo '{"mcpServers": {}}' > "$CONFIG"
    fi

    # Merge taxlab-legal into mcpServers using node
    node -e "
      const fs = require('fs');
      try {
        const file = '$CONFIG';
        const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8') || '{}') : {};
        data.mcpServers = data.mcpServers || {};
        data.mcpServers['taxlab-legal'] = $MCP_ENTRY_JSON;
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
        console.log('   ✅ Successfully injected taxlab-legal into ' + file);
      } catch (err) {
        console.error('   ❌ Failed to update ' + '$CONFIG' + ': ' + err.message);
      }
    "
  fi
done

# Also output standalone config snippet for custom harnesses (Orca, Hermes CLI, etc.)
echo ""
echo "================================================================="
echo "🎉 TaxLab Legal MCP Bridge Installed: $BRIDGE_PATH"
echo ""
echo "👉 For custom harnesses (Orca, Hermes, Gemini, custom agents):"
echo "   Command: node $BRIDGE_PATH"
echo "   Or SSE URL: http://136.67.179.84:3000/sse?apiKey=taxlab_partner_2026"
echo "================================================================="
