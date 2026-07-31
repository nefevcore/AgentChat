@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
title AgentChat ─ 检查更新
cd /d "%~dp0"

echo.
echo ============================================
echo   AgentChat ─ 检查更新
echo ============================================
echo.

:: ── 检测 Node.js（与 start.bat 一致） ──
set NODE=node\node.exe
if not exist "%NODE%" (
    if exist "node-portable.zip" (
        echo [Node.js] 正在解压便携版 Node.js（首次设置，约 100MB）...
        powershell -Command "Expand-Archive -Path node-portable.zip -DestinationPath _node_tmp -Force"
        for /d %%d in (_node_tmp\node-*) do move "%%d" node
        rmdir /s /q _node_tmp 2>nul
        del node-portable.zip
        echo [Node.js] 就绪。
    ) else (
        set NODE=node
    )
)
%NODE% --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js 未找到。请先运行 start.bat 完成首次设置。
    pause
    exit /b 1
)

:: ── 获取当前版本 ──
if exist "package.json" (
    for /f "tokens=2 delims=:," %%a in ('powershell -Command "(Get-Content package.json -Raw | ConvertFrom-Json).version" 2^>nul') do (
        set CURVER=%%a
        set CURVER=!CURVER: =!
        set CURVER=!CURVER:"=!
    )
)
if not defined CURVER set CURVER=unknown

echo  当前版本: !CURVER!
echo  正在检查 GitHub 最新构建...
echo.

:: ── 获取 latest release 信息 ──
set API_URL=https://api.github.com/repos/nefevcore/AgentChat/releases/tags/latest
set DL_URL=https://github.com/nefevcore/AgentChat/releases/download/latest/AgentChat-latest-win-x64.zip

:: 用 PowerShell 调用 GitHub API 获取远程 commit
set REMOTE_COMMIT=
for /f "delims=" %%a in ('powershell -NoProfile -Command "$headers=@{'Accept'='application/vnd.github+json'};try{$r=Invoke-RestMethod -Uri '%API_URL%' -Headers $headers -TimeoutSec 10;Write-Output $r.target_commitish}catch{Write-Output ''}" 2^>nul') do (
    set REMOTE_COMMIT=%%a
)

if "%REMOTE_COMMIT%"=="" (
    echo [WARNING] 无法连接到 GitHub，跳过更新检查。
    echo.
    pause
    exit /b 0
)

:: ── 获取远程版本号（从 body 中提取或直接用 tag_name） ──
set REMOTE_VER=
for /f "delims=" %%a in ('powershell -NoProfile -Command "$headers=@{'Accept'='application/vnd.github+json'};try{$r=Invoke-RestMethod -Uri '%API_URL%' -Headers $headers -TimeoutSec 10;$b=$r.body -split '\n' ^| Select-String '版本.*[0-9]';if($b){Write-Output ($b -replace '.*\*\*版本\*\*: ([0-9.]+).*','$1')}else{Write-Output $r.tag_name}}catch{Write-Output ''}" 2^>nul') do (
    set REMOTE_VER=%%a
)

echo  远程版本: !REMOTE_VER!
echo.

:: ── 比较版本 ──
if "!CURVER!"=="!REMOTE_VER!" (
    echo  已是最新版本，无需更新。
    echo.
    pause
    exit /b 0
)

:confirm
echo  发现新版本！
echo.
echo   当前: !CURVER!  →  远程: !REMOTE_VER!
echo.
echo  更新将覆盖程序文件，您的配置和对话记录会保留。
echo.
set /p CONFIRM="  确认更新？(Y/N): "
if /i "!CONFIRM!"=="Y" goto do_update
if /i "!CONFIRM!"=="y" goto do_update
echo  已取消。
echo.
pause
exit /b 0

:do_update
echo.
echo [1/4] 停止 AgentChat...
:: 尝试优雅关闭后端
powershell -Command "try{Invoke-WebRequest 'http://localhost:3830/api/shutdown' -Method POST -TimeoutSec 3 -UseBasicParsing 2>$null}catch{}" >nul 2>&1

:: 强制杀掉 node 进程（只杀本项目目录下的）
for /f "tokens=2" %%a in ('tasklist /fi "imagename eq node.exe" /fo csv ^| findstr /i "node" 2^>nul') do (
    taskkill /f /pid %%a >nul 2>&1
)
timeout /t 2 /nobreak >nul

echo [2/4] 下载更新包...
set ZIPFILE=%TEMP%\AgentChat-update.zip
powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%DL_URL%' -OutFile '%ZIPFILE%' -TimeoutSec 300"

if not exist "%ZIPFILE%" (
    echo [ERROR] 下载失败。
    echo.
    pause
    exit /b 1
)

echo [3/4] 解压更新包...
set TMPDIR=%TEMP%\AgentChat-update-tmp
if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%" >nul 2>&1
mkdir "%TMPDIR%"

:: 用 PowerShell 解压（Windows 10+ 内置，无需 7z）
powershell -NoProfile -Command "Expand-Archive -Path '%ZIPFILE%' -DestinationPath '%TMPDIR%' -Force"

:: 删除旧的 zip
del "%ZIPFILE%" >nul 2>&1

echo [4/4] 覆盖文件...
:: 列出解压后的第一层目录（应该是 AgentChat/）
set SRCDIR=%TMPDIR%
if exist "%TMPDIR%\AgentChat" set SRCDIR=%TMPDIR%\AgentChat

:: 覆盖: dist, webui, node_modules, scripts, *.bat, *.md, package.json
:: 保留: workspace, node (Node.js 便携版)

for %%d in (dist webui node_modules scripts) do (
    if exist "%SRCDIR%\%%d" (
        echo   更新 %%~d ...
        if exist "%%d" rmdir /s /q "%%d" >nul 2>&1
        xcopy "%SRCDIR%\%%d" "%%d" /E /I /Q /Y >nul 2>&1
    )
)

:: 覆盖根目录文件
for %%f in ("%SRCDIR%\start.bat" "%SRCDIR%\检查更新.bat" "%SRCDIR%\使用说明.md" "%SRCDIR%\package.json" "%SRCDIR%\tsconfig.json") do (
    if exist %%f (
        echo   更新 %%~nxf ...
        copy /Y %%f "." >nul 2>&1
    )
)

:: 清理临时目录
rmdir /s /q "%TMPDIR%" >nul 2>&1

echo.
echo ============================================
echo   更新完成！
echo ============================================
echo.
echo   即将重启 AgentChat...
echo.
timeout /t 2 /nobreak >nul

:: 重启
if exist "start.bat" (
    start "" "start.bat"
)

exit /b 0
