# TaxLab Legal Harness 1-Click MCP Installer for Windows
# Run: irm https://raw.githubusercontent.com/hyunae52/legal_harness/main/scripts/install-mcp.ps1 | iex

Write-Host "🚀 [TaxLab] Installing K-Tax Legal MCP Harness for Windows..." -ForegroundColor Cyan

$InstallDir = "$HOME\.taxlab"
if (!(Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$BridgePath = "$InstallDir\hermes-mcp-bridge.mjs"
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/hyunae52/legal_harness/main/scripts/hermes-mcp-bridge.mjs" -OutFile $BridgePath

$ClaudeConfig = "$env:APPDATA\Claude\claude_desktop_config.json"
$ClaudeDir = Split-Path $ClaudeConfig

if (Test-Path $ClaudeDir) {
    Write-Host "📦 Found Claude Desktop configuration: $ClaudeConfig" -ForegroundColor Yellow
    $ConfigData = @{ mcpServers = @{} }
    if (Test-Path $ClaudeConfig) {
        try {
            $Raw = Get-Content $ClaudeConfig -Raw -Encoding UTF8
            if ($Raw.Trim()) { $ConfigData = $Raw | ConvertFrom-Json }
        } catch {}
    }
    if (!$ConfigData.mcpServers) {
        $ConfigData | Add-Member -MemberType NoteProperty -Name "mcpServers" -Value @{} -Force
    }

    $BridgeEscaped = $BridgePath.Replace("\", "/")
    $ConfigData.mcpServers | Add-Member -MemberType NoteProperty -Name "taxlab-legal" -Value @{
        command = "node"
        args = @($BridgeEscaped)
        env = @{
            TAXLAB_SERVER_URL = "http://136.67.179.84:3000"
            TAXLAB_API_KEY = "taxlab_partner_2026"
        }
    } -Force

    $ConfigData | ConvertTo-Json -Depth 10 | Set-Content $ClaudeConfig -Encoding UTF8
    Write-Host "✅ Successfully injected taxlab-legal into Claude Desktop config!" -ForegroundColor Green
}

Write-Host ""
Write-Host "=================================================================" -ForegroundColor Cyan
Write-Host "🎉 TaxLab Legal MCP Bridge Installed: $BridgePath" -ForegroundColor Green
Write-Host "👉 For custom agent harnesses (Orca, Codex, Gemini):"
Write-Host "   Command: node $BridgePath"
Write-Host "   Or SSE URL: http://136.67.179.84:3000/sse?apiKey=taxlab_partner_2026"
Write-Host "=================================================================" -ForegroundColor Cyan
