param([switch]$Start, [switch]$SkipModel, [switch]$SkipDoctor, [int]$Port = 0)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\Launcher.ps1')
$node = Get-BridgeNode
Set-Location -LiteralPath $PSScriptRoot
Write-Output 'Installing dependencies, including the official Codex CLI...'
& npm.cmd ci --no-audit --no-fund
if ($LASTEXITCODE -ne 0) { throw 'npm ci failed. Check the network/proxy and try again.' }
& $node --use-env-proxy (Join-Path $PSScriptRoot 'scripts\setup-runtime.mjs')
if ($LASTEXITCODE -ne 0) { throw 'FFmpeg setup failed.' }
if (-not $SkipModel) {
    & $node --use-env-proxy (Join-Path $PSScriptRoot 'scripts\setup-asr.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Speech model setup failed.' }
}
if (-not $SkipDoctor) {
    & $node --use-env-proxy (Join-Path $PSScriptRoot 'scripts\doctor.mjs')
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Some checks need attention. For a new Codex account, run: npm run codex:login' }
}
Write-Output 'Dependencies are ready. Use your own Codex login and Douyin assistant account.'
if ($Start) { & (Join-Path $PSScriptRoot 'Start.ps1') -Port $Port }
