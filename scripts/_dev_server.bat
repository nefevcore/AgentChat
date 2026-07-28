@echo off
chcp 65001 >nul
title AgentChat Server

:: cd to project root (scripts/..)
cd /d "%~dp0\.."

:: Find node: portable first, then system
set NODE=node\node.exe
if not exist "%NODE%" set NODE=node

echo.
echo ============================================
echo   AgentChat Server
echo   Close this window to stop
echo ============================================
echo.

:: Start frontend static server on 3831 (proxies /api to 3830)
start "" /B %NODE% scripts\frontend-server.js

:: Start main backend on 3830
%NODE% -r tsconfig-paths/register dist\src\index.js 2>&1

echo.
echo ============================================
echo   Server stopped - check errors above
echo ============================================
pause
