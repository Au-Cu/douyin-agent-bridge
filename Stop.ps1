param([switch]$Force, [int]$Port = 0)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'scripts\Launcher.ps1')
$consoleUrl = 'http://127.0.0.1:' + (Get-BridgePort $Port $PSScriptRoot)
$existing = Get-BridgeInstance $consoleUrl
if (-not $existing) { Write-Output 'Bridge is not running.'; exit 0 }
Assert-BridgeRoot $existing $PSScriptRoot
$body = @{ force = [bool]$Force } | ConvertTo-Json
Invoke-WebRequest -UseBasicParsing -Uri ($consoleUrl + '/api/shutdown') -Method Post -WebSession $existing.Session -ContentType 'application/json' -Body $body -TimeoutSec 15 | Out-Null
Write-Output 'Bridge stopped. Login data and saved knowledge are preserved.'
