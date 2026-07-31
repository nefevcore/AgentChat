@echo off
chcp 65001 >nul 2>&1
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
