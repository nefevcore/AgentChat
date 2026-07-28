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
%NODE% -r tsconfig-paths/register dist\src\index.js 2>&1

echo.
echo ============================================
echo   Server stopped.
echo ============================================
pause
