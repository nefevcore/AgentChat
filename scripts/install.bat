@echo off
chcp 65001 >nul 2>nul
if errorlevel 1 chcp 936 >nul
setlocal enabledelayedexpansion
title AgentChat ─ 安装
cd /d "%~dp0"

:: 兜底：脚本意外退出时至少停住让用户看到错误
if "%~1"=="" ( call :main ) else ( goto %~1 )
goto :end
:main

echo.
echo ┌──────────────────────────────────────────┐
echo │  AgentChat ─ 一键安装                      │
echo └──────────────────────────────────────────┘
echo.

:: ── 检测已有安装 ──
if exist "start.bat" (
    echo [*] 检测到已有 AgentChat 安装。
    echo    配置文件 (workspace/) 和对话记录不会被覆盖。
    echo.
    set /p OVERWRITE="   继续安装（仅更新程序文件）？(Y/N): "
    if /i not "!OVERWRITE!"=="Y" (
        if /i not "!OVERWRITE!"=="y" (
            echo   已取消。
            pause
            exit /b 0
        )
    )
    echo.
)

:: ── 下载 ──
echo [1/5] 下载最新版本...
set DL_URL=https://github.com/nefevcore/AgentChat/releases/download/latest/AgentChat-latest-win-x64.zip
set ZIPFILE=%TEMP%\AgentChat-install.zip

echo   从 GitHub 下载（约 90MB，请耐心等待）...
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%DL_URL%' -OutFile '%ZIPFILE%' -TimeoutSec 600"

if not exist "%ZIPFILE%" (
    echo [ERROR] 下载失败。请检查网络连接或手动从以下地址下载：
    echo   https://github.com/nefevcore/AgentChat/releases/latest
    pause
    exit /b 1
)
echo    [████████████████████] 下载完成

:: ── 解压 ──
echo [2/5] 解压...
set TMPDIR=%TEMP%\AgentChat-install-tmp
if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%" >nul 2>&1
mkdir "%TMPDIR%"

powershell -NoProfile -Command "Expand-Archive -Path '%ZIPFILE%' -DestinationPath '%TMPDIR%' -Force"
del "%ZIPFILE%" >nul 2>&1

:: 定位解压内容（发布包内有一层 AgentChat/ 目录）
set SRCDIR=%TMPDIR%
if exist "%TMPDIR%\AgentChat" set SRCDIR=%TMPDIR%\AgentChat
echo    [████████████████████] 解压完成

:: ── 覆盖程序文件 ──
echo [3/5] 安装程序文件...

for %%d in (dist webui node_modules scripts) do (
    if exist "%SRCDIR%\%%d" (
        echo    → %%~d ...
        if exist "%%d" rmdir /s /q "%%d" >nul 2>&1
        xcopy "%SRCDIR%\%%d" "%%d" /E /I /Q /Y >nul 2>&1
    )
)

for %%f in ("%SRCDIR%\start.bat" "%SRCDIR%\update.bat" "%SRCDIR%\使用说明.md" "%SRCDIR%\package.json" "%SRCDIR%\tsconfig.json") do (
    if exist %%f (
        copy /Y %%f "." >nul 2>&1
    )
)

rmdir /s /q "%TMPDIR%" >nul 2>&1
echo    [████████████████████] 安装完成

:: ── Node.js ──
echo [4/5] 准备 Node.js 运行环境...
set NODE=node\node.exe
if not exist "%NODE%" (
    if exist "node-portable.zip" (
        echo   正在解压 Node.js（约 100MB，仅首次需要）...
        powershell -Command "Expand-Archive -Path node-portable.zip -DestinationPath _node_tmp -Force"
        for /d %%d in (_node_tmp\node-*) do move "%%d" node
        rmdir /s /q _node_tmp 2>nul
        del node-portable.zip
        echo    [████████████████████] Node.js 就绪
    ) else (
        echo    [*] 未找到 node-portable.zip，将使用系统 Node.js（如已安装）
        set NODE=node
    )
) else (
    echo    [^✓] Node.js 已存在
)
%NODE% --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js 不可用。请安装 Node.js 后重试：
    echo   https://nodejs.org/
    pause
    exit /b 1
)

:: ── 初始配置 ──
echo [5/5] 初始化工作空间...
if not exist "workspace\default\config.json" (
    if not exist "workspace" mkdir "workspace"
    if not exist "workspace\default" mkdir "workspace\default"
    echo {> "workspace\default\config.json"
    echo   "llmProviders": {>> "workspace\default\config.json"
    echo     "deepseek-pro": {>> "workspace\default\config.json"
    echo       "provider": "deepseek",>> "workspace\default\config.json"
    echo       "model": "deepseek-v4-pro",>> "workspace\default\config.json"
    echo       "api_key": "YOUR_API_KEY_HERE",>> "workspace\default\config.json"
    echo       "temperature": 0.7,>> "workspace\default\config.json"
    echo       "max_tokens": 8192>> "workspace\default\config.json"
    echo     }>> "workspace\default\config.json"
    echo   },>> "workspace\default\config.json"
    echo   "defaultLLM": "deepseek-pro">> "workspace\default\config.json"
    echo }>> "workspace\default\config.json"
    echo.
    echo    [*] 已创建默认配置文件。
    echo    请编辑 workspace\default\config.json 填入你的 API Key。
    echo.
)

echo    [████████████████████] 初始化完成

:: ── 完成 ──
echo.
echo ┌──────────────────────────────────────────┐
echo │  ✓  安装完成！                             │
echo └──────────────────────────────────────────┘
echo.
echo   启动前请确认已配置 API Key：
echo     workspace\default\config.json
echo.
set /p LAUNCH="   是否立即启动？(Y/N): "

if /i not "!LAUNCH!"=="Y" (
    if /i not "!LAUNCH!"=="y" (
        echo   已跳过。双击 start.bat 即可启动。
        pause
        exit /b 0
    )
)

if exist "start.bat" (
    start "" "start.bat"
)
pause
exit /b 0
