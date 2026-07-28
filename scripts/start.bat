@echo off
chcp 65001 >nul
title AgentChat
cd /d "%~dp0"

:: 使用内嵌 Node.js portable（如果存在），否则用系统 Node
set NODE=node\node.exe
if not exist "%NODE%" set NODE=node

if not exist "dist\src\index.js" (
    echo [ERROR] dist\src\index.js not found. Run: npm run build
    pause
    exit /b 1
)

:: 首次运行提示
if not exist "workspace\default\config.json" (
    echo.
    echo ============================================
    echo   Welcome to AgentChat!
    echo ============================================
    echo.
    echo   首次使用请打开浏览器访问 http://localhost:3831
    echo   在侧边栏「更多」-「设置」中配置 API Key
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

:: 启动前端静态服务（HTTP + WebSocket 代理到 3830）
start "" /B %NODE% scripts\frontend-server.js

:: 启动后端
start "AgentChat Backend" %NODE% -r tsconfig-paths/register dist\src\index.js 2>&1

:: 等待后端就绪后自动打开浏览器
echo Waiting for backend on port 3830...
set N=0
:loop
timeout /t 2 /nobreak >nul
set /a N+=1
powershell -Command "try { Invoke-WebRequest http://localhost:3830/api/agents -TimeoutSec 2 -UseBasicParsing | Out-Null; exit 0 } catch { exit 1 }" >nul 2>&1
if %errorlevel% equ 0 goto open
if %N% lss 15 goto loop

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
