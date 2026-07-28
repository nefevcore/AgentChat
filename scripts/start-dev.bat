@echo off
chcp 65001 >nul
title AgentChat Launcher

cd /d "%~dp0\.."

:: check critical files
set NODE=node\node.exe
if not exist "%NODE%" (
    where node >nul 2>&1
    if %errorlevel% neq 0 (
        echo [ERROR] Node.js not found
        echo Install from https://nodejs.org/
        pause
        exit /b 1
    )
    set NODE=node
)

if not exist "dist\src\index.js" (
    echo [ERROR] Build output not found. Run: npm run build
    pause
    exit /b 1
)

if not exist "workspace\default\.env" (
    echo [WARN] workspace\default\.env not found - API keys may be missing
    echo.
)

echo.
echo ============================================
echo   AgentChat is starting...
echo ============================================
echo.

:: launch server in new window
start "AgentChat Server" cmd /k scripts\_dev_server.bat

:: wait for server
echo Waiting for backend on port 3830...
set /a N=0
:loop
timeout /t 2 /nobreak >nul
set /a N+=1
powershell -Command "try { Invoke-WebRequest http://localhost:3830/api/agents -TimeoutSec 2 -UseBasicParsing | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% equ 0 goto open
if %N% lss 15 goto loop

echo.
echo [WARNING] Backend did not respond within 30s.
echo Check the AgentChat Server window for errors.
echo.
pause
exit /b 1

:open
echo.
echo Backend ready, opening browser on port 3831...
start "" http://localhost:3831

echo.
echo ============================================
echo   AgentChat is running!
echo   Backend API:  http://localhost:3830
echo   Frontend:    http://localhost:3831
echo   Close the Server window to stop.
echo ============================================
echo.

timeout /t 3 /nobreak >nul
exit
