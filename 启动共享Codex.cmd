@echo off
setlocal
chcp 65001 >nul
if exist "%~dp0scripts\StartSharedCodex.ps1" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\StartSharedCodex.ps1"
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; try { $root=$env:BRIDGE_DATA_DIR; if (-not $root) { $root=Join-Path ([Environment]::GetFolderPath('UserProfile')) '.douyin-codex-bridge\data' }; $f=Join-Path $root 'desktop-shared\connection.json'; if (-not (Test-Path -LiteralPath $f)) { throw '未找到共享连接配置，请从项目文件夹启动或先准备连接。' }; $c=Get-Content -Raw -Encoding UTF8 -LiteralPath $f | ConvertFrom-Json; if (-not $c.project) { throw '共享连接未记录项目位置，请从项目文件夹启动。' }; $script=Join-Path ([string]$c.project) 'scripts\StartSharedCodex.ps1'; if (-not (Test-Path -LiteralPath $script)) { throw '已记录的项目位置不可用，请从项目文件夹重新准备连接。' }; & $script; if (-not $?) { exit 1 } } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
)
if errorlevel 1 (
    pause
    exit /b 1
)
