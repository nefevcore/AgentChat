@echo off
setlocal enabledelayedexpansion
title AgentChat
cd /d "%~dp0"

:: Use embedded Node.js portable if present, otherwise system Node
set NODE=node\node.exe
if not exist "%NODE%" (
    if exist "node-portable.zip" (
        echo.
        echo [Node.js] Extracting portable Node.js ^(one-time setup, ~100MB^)...
        powershell -Command "Expand-Archive -Path node-portable.zip -DestinationPath _node_tmp -Force"
        for /d %%d in (_node_tmp\node-*) do move "%%d" node
        rmdir /s /q _node_tmp 2>nul
        del node-portable.zip
        echo [Node.js] Ready.
    ) else (
        set NODE=node
    )
)

if not exist "dist\src\index.js" (
    echo [ERROR] dist\src\index.js not found. Run: npm run build
    pause
    exit /b 1
)

:: First-run hint
if not exist "workspace\default\config.json" (
    echo.
    echo ============================================
    echo   Welcome to AgentChat!
    echo ============================================
    echo.
    echo   Open http://localhost:3831 in your browser
    echo   Configure API Key: Sidebar ^> More ^> Settings
    echo.
    echo ============================================
    echo.
    echo Press any key to continue...
    pause >nul
)

echo.
echo ============================================
echo   AgentChat is starting...
echo ============================================
echo.

:: 配置迁移（升级后首次启动自动更新旧工作区配置到新默认值；幂等，已最新则跳过）
if exist "scripts\update-config.js" (
    %NODE% scripts\update-config.js >nul 2>&1
    if errorlevel 1 (
        echo [WARN] Config migration failed, continuing with existing config.
    )
)

:: 检查新版本（静默，失败/无网络不影响启动）
set CURVER=unknown
for /f "usebackq delims=" %%a in (`findstr /c:^"version^" package.json 2^>nul`) do (
    for /f "tokens=2 delims=:, " %%b in ("%%a") do set CURVER=%%b
)
if defined CURVER set CURVER=!CURVER:"=!
if not defined CURVER set CURVER=unknown

set REMOTE_VER=
powershell -NoProfile -Command "try{$r=Invoke-RestMethod -Uri 'https://api.github.com/repos/nefevcore/AgentChat/releases/tags/latest' -Headers @{Accept='application/vnd.github+json'} -TimeoutSec 5;$m=[regex]::Match($r.body,'\*\*版本\*\*\s*[:：]\s*([0-9.]+)');if($m.Success){$m.Groups[1].Value}else{$r.tag_name}}catch{exit 1}" > "%TEMP%\agentchat-checkver.txt" 2>&1
if not errorlevel 1 (
    set /p REMOTE_VER=<"%TEMP%\agentchat-checkver.txt"
    del "%TEMP%\agentchat-checkver.txt" >nul 2>&1
)

if "!REMOTE_VER!"=="" goto skip_update_check
if "!CURVER!"=="!REMOTE_VER!" goto skip_update_check

echo.
echo ============================================
echo   New version available!
echo     Current: !CURVER!  --  Latest: !REMOTE_VER!
echo ============================================
set /p UPDATE_NOW="   Update now? (Y/N): "
if /i "!UPDATE_NOW!"=="Y" (
    echo.
    echo Starting updater...
    if exist "update.bat" (
        start "" "update.bat"
        echo Update started in a new window.
        timeout /t 3 /nobreak >nul
        exit /b 0
    )
)
echo.
echo Continuing with current version...
echo.

:skip_update_check

:: Start frontend static server (HTTP + WebSocket proxy to 3830)
start "" /B %NODE% scripts\frontend-server.js

:: Start backend
start "AgentChat Backend" %NODE% -r tsconfig-paths/register dist\src\index.js

:: Wait for backend then open browser
echo Waiting for backend on port 3830...
set RETRY=0
:loop
timeout /t 2 /nobreak >nul
set /a RETRY+=1
powershell -Command "try { Invoke-WebRequest http://localhost:3830/api/agents -TimeoutSec 2 -UseBasicParsing | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% equ 0 goto open
if %RETRY% lss 15 goto loop

echo.
echo [WARNING] Backend did not respond within 30s.
echo Check the AgentChat Backend window for errors.
echo.
pause
exit /b 1

:open
echo.
echo Backend ready, opening browser...
start "" http://localhost:3831

echo.
echo ============================================
echo   AgentChat is running!
echo   Frontend:    http://localhost:3831
echo   Backend API: http://localhost:3830
echo ============================================
echo.

timeout /t 3 /nobreak >nul
exit
