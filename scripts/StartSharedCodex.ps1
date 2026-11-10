param([switch]$CheckOnly, [switch]$NoOpen)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$projectRoot = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'Launcher.ps1')
$dataRoot = Get-BridgeDataRoot $projectRoot -Prepare
$configFile = Join-Path $dataRoot 'desktop-shared\connection.json'
function Stop-SharedStart([string]$Message) {
    # A setup error should still give a first-time user access to the console.
    # CheckOnly remains read-only; NoOpen is useful for unattended diagnostics.
    if (-not $NoOpen -and -not $CheckOnly) {
        try { & (Join-Path $projectRoot 'Start.ps1') }
        catch { $Message += ' 助手控制台也未能启动：' + $_.Exception.Message }
    }
    throw $Message
}
if (-not (Test-Path -LiteralPath $configFile)) { Stop-SharedStart ('未找到共享连接配置：' + $configFile + '。请在面板准备桌面共享连接，或在 Codex 中执行 npm run setup:desktop。') }
try { $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json }
catch { Stop-SharedStart '共享连接配置无法读取，原文件已保留。请在面板检查连接。' }
$appPath = $config.app
$package = $null
if (-not $appPath -or -not (Test-Path -LiteralPath $appPath)) {
    $package = Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1
    if ($package) { $appPath = Join-Path $package.InstallLocation 'app\ChatGPT.exe' }
}
if (-not $appPath -or -not (Test-Path -LiteralPath $appPath)) { Stop-SharedStart '未找到桌面应用，请运行 npm run setup:desktop -- --app 完整应用路径。' }
if (-not $config.wrapper -or -not (Test-Path -LiteralPath $config.wrapper)) { Stop-SharedStart '共享连接入口缺失，请在面板重新准备桌面共享连接。' }
$desktop = Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue
$desktopRunning = [bool]($desktop | Where-Object { $_.Path -eq $appPath })
$relatedDesktopRunning = $desktopRunning -or [bool]($desktop | Where-Object { $_.Path -and (($_.Path -eq $config.app) -or ($_.Path -match '(?i)\\WindowsApps\\OpenAI\.Codex_[^\\]+\\app\\ChatGPT\.exe$')) })
if (-not $config.original -or -not (Test-Path -LiteralPath $config.original)) {
    if ($CheckOnly) { throw '桌面 Codex 核心路径已变化；完全退出桌面后运行共享启动入口，可尝试自动恢复。' }
    # Never rewrite a connection that may still be in use by another desktop.
    if ($relatedDesktopRunning) { Stop-SharedStart '桌面 Codex 核心已更新。请先保存工作并完全退出桌面 Codex，再运行共享启动入口以恢复连接。' }
    if (-not $package) { $package = Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1 }
    if (-not $package) { Stop-SharedStart '桌面 Codex 核心路径已变化，无法核验当前安装版本。请在面板重新准备桌面共享连接。' }
    $officialApp = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
    $officialCore = Join-Path $package.InstallLocation 'app\resources\codex.exe'
    if ([IO.Path]::GetFullPath($appPath) -ine [IO.Path]::GetFullPath($officialApp) -or -not (Test-Path -LiteralPath $officialCore)) {
        Stop-SharedStart '桌面 Codex 核心路径已变化，无法核验当前应用自带的核心。请在面板重新准备桌面共享连接。'
    }
    $previousDataRoot = $env:BRIDGE_DATA_DIR
    try {
        $env:BRIDGE_DATA_DIR = $dataRoot
        $node = Get-BridgeNode
        & $node --use-env-proxy (Join-Path $PSScriptRoot 'setup-desktop.mjs') --codex $officialCore --app $officialApp | Out-Null
        if ($LASTEXITCODE -ne 0) { throw '重新准备共享连接失败，请在面板查看并重试。' }
    } catch { Stop-SharedStart ('桌面 Codex 核心已更新，但自动恢复失败：' + $_.Exception.Message) }
    finally { $env:BRIDGE_DATA_DIR = $previousDataRoot }
    $config = Get-Content -LiteralPath $configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not $config.original -or -not (Test-Path -LiteralPath $config.original) -or -not $config.wrapper -or -not (Test-Path -LiteralPath $config.wrapper)) { Stop-SharedStart '共享连接恢复后仍未就绪，请在面板重新准备。' }
    Write-Output '已根据当前安装的桌面 Codex 更新共享连接路径。'
}
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
