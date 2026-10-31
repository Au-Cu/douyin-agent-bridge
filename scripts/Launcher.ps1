function Get-BridgeDataRoot([string]$ProjectRoot, [switch]$Prepare) {
    $node = Get-BridgeNode
    $arguments = @('--no-warnings', (Join-Path $ProjectRoot 'scripts\storage.mjs'), '--encoded')
    if ($Prepare) { $arguments += '--prepare' }
    $output = & $node @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Cannot prepare saved data. The existing state was not replaced.' }
    $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([string]($output | Select-Object -Last 1)))
    return [IO.Path]::GetFullPath($decoded)
}
function Get-BridgePort([int]$RequestedPort = 0, [string]$ProjectRoot) {
    $selected = $RequestedPort
    if ($selected -eq 0 -and $env:BRIDGE_PORT) { $selected = [int]$env:BRIDGE_PORT }
    if ($selected -eq 0) {
        $node = Get-BridgeNode
        $savedPort = & $node --no-warnings (Join-Path $ProjectRoot 'scripts\storage.mjs') --port
        if ($LASTEXITCODE -ne 0) { throw 'Cannot read saved data.' }
        $selected = [int]($savedPort | Select-Object -Last 1)
    }
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
    if ($Connection.Identity.dataRoot) {
        $runningData = [IO.Path]::GetFullPath([string]$Connection.Identity.dataRoot).TrimEnd([char[]]'/\')
        $expectedData = (Get-BridgeDataRoot $ProjectRoot).TrimEnd([char[]]'/\')
        if ($Connection.Identity.app -ne 'douyin-codex-bridge' -or $runningData -ne $expectedData) { throw 'A different data profile is using this port. Choose another -Port.' }
        return
    }
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
