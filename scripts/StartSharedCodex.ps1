param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Launcher.ps1')
$dataRoot = Get-BridgeDataRoot $projectRoot -Prepare
$configFile = Join-Path $dataRoot 'desktop-shared\connection.json'
if (-not (Test-Path -LiteralPath $configFile)) { throw ('未找到共享连接配置：' + $configFile + '。请在面板准备桌面共享连接，或在 Codex 中执行 npm run setup:desktop。') }
$config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
$desktop = Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue
$desktopRunning = [bool]($desktop | Where-Object { $_.Path -match '\\(?:WindowsApps|Applications|Programs)\\.*(?:ChatGPT|Codex)' })
$appPath = $config.app
if (-not $appPath -or -not (Test-Path -LiteralPath $appPath)) {
    $package = Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1
    if ($package) { $appPath = Join-Path $package.InstallLocation 'app\ChatGPT.exe' }
}
if (-not $appPath -or -not (Test-Path -LiteralPath $appPath)) { throw '未找到桌面应用，请运行 npm run setup:desktop -- --app 完整应用路径。' }
if (-not (Test-Path -LiteralPath $config.wrapper)) { throw '共享连接入口缺失，请重新运行 npm run setup:desktop。' }
if (-not (Test-Path -LiteralPath $config.original)) { throw '桌面 Codex 核心路径已变化，请重新准备共享连接。' }
if ($CheckOnly) { @{ready=$true;desktopRunning=$desktopRunning;dataRoot=$dataRoot} | ConvertTo-Json -Compress; exit 0 }
if ($desktopRunning) { throw '桌面 Codex 仍在运行。请先完全退出桌面应用，再运行这个入口；不会自动关闭正在工作的聊天。' }
$env:CODEX_CLI_PATH = $config.wrapper
# This environment applies only to the launched app, never to global Windows.
Start-Process -FilePath $appPath -WindowStyle Hidden
Write-Output '已启动共享 Codex。打开助手面板，点击“检查共享连接”。'
