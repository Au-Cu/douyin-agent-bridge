function Get-BridgePort([int]$RequestedPort = 0, [string]$ProjectRoot) {
    $selected = $RequestedPort
    if ($selected -eq 0 -and $env:BRIDGE_PORT) { $selected = [int]$env:BRIDGE_PORT }
    $file = Join-Path $ProjectRoot 'data\config.json'
    if ($selected -eq 0 -and (Test-Path -LiteralPath $file)) { $selected = [int](Get-Content -LiteralPath $file -Raw | ConvertFrom-Json).port }
    if ($selected -eq 0) { $selected = 39361 }
    if ($selected -lt 1024 -or $selected -gt 65535) { throw 'Port must be between 1024 and 65535.' }
    return $selected
}
function Get-BridgeInstance([string]$ConsoleUrl) {
    try { $page = Invoke-WebRequest -UseBasicParsing -Uri $ConsoleUrl -SessionVariable localBridgeSession -TimeoutSec 2 }
    catch { if ($_.Exception.Response) { throw 'The selected port belongs to another application.' }; return $null }
    if (-not $page.Content.Contains('douyin-bridge-console')) { throw 'The selected port belongs to another application.' }
    try { $identity = Invoke-RestMethod -Uri ($ConsoleUrl + '/api/instance') -WebSession $localBridgeSession -TimeoutSec 3 }
    catch { throw 'Cannot verify this running instance. Use a different -Port.' }
    return [pscustomobject]@{ Identity = $identity; Session = $localBridgeSession }
}
function Assert-BridgeRoot($Connection, [string]$ProjectRoot) {
    $running = [IO.Path]::GetFullPath([string]$Connection.Identity.projectRoot).TrimEnd([char[]]'/\')
    $expected = [IO.Path]::GetFullPath($ProjectRoot).TrimEnd([char[]]'/\')
    if ($Connection.Identity.app -ne 'douyin-codex-bridge' -or $running -ne $expected) { throw 'A different project copy is using this port. Choose another -Port.' }
}
function Get-BridgeNode {
    $node = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $node) { throw 'Install Node.js 24.5.0+ from https://nodejs.org/ and reopen the terminal.' }
    $version = (& $node.Source --version | Select-Object -Last 1).Trim().TrimStart('v')
    if ([version]$version -lt [version]'24.5.0') { throw 'Node.js 24.5.0 or newer is required.' }
    return $node.Source
}
