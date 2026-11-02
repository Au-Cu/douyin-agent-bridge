param([switch]$CheckOnly, [switch]$NoOpen)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Launcher.ps1')
$dataRoot = Get-BridgeDataRoot $projectRoot -Prepare
$configFile = Join-Path $dataRoot 'desktop-shared\connection.json'
if (-not (Test-Path -LiteralPath $configFile)) { throw ('未找到共享连接配置：' + $configFile + '。请在面板准备桌面共享连接，或在 Codex 中执行 npm run setup:desktop。') }
$config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
$appPath = $config.app
if (-not $appPath -or -not (Test-Path -LiteralPath $appPath)) {
    $package = Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1
    if ($package) { $appPath = Join-Path $package.InstallLocation 'app\ChatGPT.exe' }
}
if (-not $appPath -or -not (Test-Path -LiteralPath $appPath)) { throw '未找到桌面应用，请运行 npm run setup:desktop -- --app 完整应用路径。' }
if (-not (Test-Path -LiteralPath $config.wrapper)) { throw '共享连接入口缺失，请重新运行 npm run setup:desktop。' }
if (-not (Test-Path -LiteralPath $config.original)) { throw '桌面 Codex 核心路径已变化，请重新准备共享连接。' }
$desktop = Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue
$desktopRunning = [bool]($desktop | Where-Object { $_.Path -eq $appPath })
if ($CheckOnly) { @{ready=$true;desktopRunning=$desktopRunning;dataRoot=$dataRoot} | ConvertTo-Json -Compress; exit 0 }
if ($desktopRunning) {
    # Ask the single-instance app to show its window without stopping any chat.
    Start-Process -FilePath $appPath -WindowStyle Normal
    Write-Warning '已请求显示现有桌面窗口，本次没有切换共享连接。若检查仍未就绪，请等工作结束后完全退出桌面 Codex（包括托盘），再运行这个入口。'
} else {
    $previousCliPath = $env:CODEX_CLI_PATH
    try {
        # Only the desktop child inherits the wrapper; isolated clients keep
        # their original environment when the console launcher runs below.
        $env:CODEX_CLI_PATH = $config.wrapper
        Start-Process -FilePath $appPath -WindowStyle Normal
    } finally {
        $env:CODEX_CLI_PATH = $previousCliPath
    }
    Write-Output '已请求打开桌面 Codex 窗口；共享服务将在后台运行。'
}
if (-not $NoOpen) {
    try { & (Join-Path $projectRoot 'Start.ps1') }
    catch { throw ('桌面窗口已请求打开，但助手控制台启动失败：' + $_.Exception.Message) }
}
Write-Output '请在助手控制台点击“检查共享连接”；通过检查后才表示共享连接就绪。'
