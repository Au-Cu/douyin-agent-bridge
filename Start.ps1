param([switch]$NoOpen, [int]$Port = 0)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\Launcher.ps1')
$projectRoot = $PSScriptRoot
$effectivePort = Get-BridgePort $Port $projectRoot
$consoleUrl = 'http://127.0.0.1:' + $effectivePort
$existing = Get-BridgeInstance $consoleUrl
if ($existing) { Assert-BridgeRoot $existing $projectRoot }
if (-not $existing) {
    $node = Get-BridgeNode
    Set-Location -LiteralPath $projectRoot
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\@openai\codex\bin\codex.js'))) {
        & npm.cmd ci --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    }
    & $node --use-env-proxy (Join-Path $projectRoot 'scripts\setup-runtime.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Video runtime installation failed.' }
    $dataRoot = Join-Path $projectRoot 'data'
    New-Item -ItemType Directory -Path $dataRoot -Force | Out-Null
    $serverFile = Join-Path $projectRoot 'src\server.mjs'
    $serverProcess = Start-Process -FilePath $node -ArgumentList @('--use-env-proxy', ('"' + $serverFile + '"'), '--port', [string]$effectivePort) -WorkingDirectory $projectRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataRoot 'server.stdout.log') -RedirectStandardError (Join-Path $dataRoot 'server.stderr.log') -PassThru
    Set-Content -LiteralPath (Join-Path $dataRoot 'server.pid') -Value $serverProcess.Id -Encoding ascii
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        Start-Sleep -Milliseconds 250
        $existing = Get-BridgeInstance $consoleUrl
        if ($existing) { Assert-BridgeRoot $existing $projectRoot; break }
        if ($serverProcess.HasExited) { break }
    }
    if (-not $existing) { throw 'The bridge did not start. See data/server.stderr.log.' }
}
Write-Output ('Bridge console: ' + $consoleUrl)
if (-not $NoOpen) { Start-Process $consoleUrl }
