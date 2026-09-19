# Install a reviewed, locally downloaded npm tarball, including dependencies.
# Example: .\scripts\install-mcp.ps1 -Package C:\Downloads\k-tax-agent-backend-2.2.0.tgz
param([Parameter(Mandatory=$true)][string]$Package,
      [string]$Destination = (Join-Path $env:USERPROFILE '.taxlab\legal-mcp'))
$ErrorActionPreference = 'Stop'
$artifact = (Resolve-Path -LiteralPath $Package).Path
if (-not $artifact.EndsWith('.tgz')) { throw 'Select the reviewed npm .tgz artifact.' }
node -e "if (Number(process.versions.node.split('.')[0]) < 22) process.exit(1)"
if ($LASTEXITCODE -ne 0) { throw 'Node.js 22 or later is required.' }
New-Item -ItemType Directory -Path $Destination -Force | Out-Null
& npm install --prefix $Destination --ignore-scripts --omit=optional --no-audit --no-fund -- $artifact
if ($LASTEXITCODE -ne 0) { throw 'Package installation failed.' }
$bridge = Join-Path $Destination 'node_modules\k-tax-agent-backend\scripts\hermes-mcp-bridge.mjs'
if (-not (Test-Path -LiteralPath $bridge)) { throw 'Installed bridge is missing.' }
@{mcpServers=@{'taxlab-legal'=@{command='node';args=@($bridge);env=@{
    TAXLAB_SERVER_URL='https://law.taxlab.kr';TAXLAB_API_KEY='<your existing server key>'
}}}} | ConvertTo-Json -Depth 8
Write-Host 'Add this entry to your MCP client. Existing configurations have not been overwritten.'
Write-Host 'Set the key in your client environment, then run the installed bridge with --doctor.'
