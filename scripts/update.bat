@echo off
setlocal enabledelayedexpansion
title AgentChat - Update
cd /d "%~dp0"

echo.
echo ============================================
echo   AgentChat - Check for Updates
echo ============================================
echo.

:: -- Node.js detection (same as start.bat) --
set NODE=node\node.exe
if not exist "%NODE%" (
    if exist "node-portable.zip" (
        echo [Node.js] Extracting portable Node.js (first time, ~100MB)...
        powershell -Command "Expand-Archive -Path node-portable.zip -DestinationPath _node_tmp -Force"
        for /d %%d in (_node_tmp\node-*) do move "%%d" node
        rmdir /s /q _node_tmp 2>nul
        del node-portable.zip
        echo [Node.js] Ready.
    ) else (
        set NODE=node
    )
)
%NODE% --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Run start.bat first for initial setup.
    pause
    exit /b 1
)

:: -- Get current version --
if exist "package.json" (
    for /f "tokens=2 delims=:," %%a in ('powershell -Command "(Get-Content package.json -Raw | ConvertFrom-Json).version" 2^>nul') do (
        set CURVER=%%a
        set CURVER=!CURVER: =!
        set CURVER=!CURVER:"=!
    )
)
if not defined CURVER set CURVER=unknown

echo   Current version: !CURVER!
echo   Checking GitHub for latest build...
echo.

:: -- Get latest release info --
set API_URL=https://api.github.com/repos/nefevcore/AgentChat/releases/tags/latest
set DL_URL=https://github.com/nefevcore/AgentChat/releases/download/latest/AgentChat-latest-win-x64.zip

set REMOTE_COMMIT=
for /f "delims=" %%a in ('powershell -NoProfile -Command "$headers=@{'Accept'='application/vnd.github+json'};try{$r=Invoke-RestMethod -Uri '%API_URL%' -Headers $headers -TimeoutSec 10;Write-Output $r.target_commitish}catch{Write-Output ''}" 2^>nul') do (
    set REMOTE_COMMIT=%%a
)

if "%REMOTE_COMMIT%"=="" (
    echo [WARNING] Cannot reach GitHub. Skipping update check.
    echo.
    pause
    exit /b 0
)

set REMOTE_VER=
for /f "delims=" %%a in ('powershell -NoProfile -Command "$headers=@{'Accept'='application/vnd.github+json'};try{$r=Invoke-RestMethod -Uri '%API_URL%' -Headers $headers -TimeoutSec 10;$b=$r.body -split '\n' ^| Select-String 'version.*[0-9]';if($b){Write-Output ($b -replace '.*\*\*version\*\*: ([0-9.]+).*','$1')}else{Write-Output $r.tag_name}}catch{Write-Output ''}" 2^>nul') do (
    set REMOTE_VER=%%a
)

echo   Remote version: !REMOTE_VER!
echo.

:: -- Compare versions --
if "!CURVER!"=="!REMOTE_VER!" (
    echo   [OK] Already up to date.
    echo.
    pause
    exit /b 0
)

:confirm
echo   [!] New version available!
echo.
echo     Current: !CURVER!  --  Remote: !REMOTE_VER!
echo.
echo   Update will overwrite program files. Config and chat history preserved.
echo.
set /p CONFIRM="   Confirm update? (Y/N): "
if /i "!CONFIRM!"=="Y" goto do_update
if /i "!CONFIRM!"=="y" goto do_update
echo   Cancelled.
echo.
pause
exit /b 0
if /i "!CONFIRM!"=="Y" goto do_update
if /i "!CONFIRM!"=="y" goto do_update
echo   Cancelled.
echo.
pause
exit /b 0

:do_update
echo.
echo [1/4] Stopping AgentChat...
powershell -Command "try{Invoke-WebRequest 'http://localhost:3830/api/shutdown' -Method POST -TimeoutSec 3 -UseBasicParsing 2>$null}catch{}" >nul 2>&1

for /f "tokens=2" %%a in ('tasklist /fi "imagename eq node.exe" /fo csv ^| findstr /i "node" 2^>nul') do (
    taskkill /f /pid %%a >nul 2>&1
)
timeout /t 2 /nobreak >nul
echo    [OK] Stopped

echo [2/4] Downloading update...
set ZIPFILE=%TEMP%\AgentChat-update.zip

:: Get remote file size from API
set REMOTE_SIZE=0
for /f "delims=" %%a in ('powershell -NoProfile -Command "$h=@{'Accept'='application/vnd.github+json'};try{$r=Invoke-RestMethod -Uri '%API_URL%' -Headers $h -TimeoutSec 10;Write-Output $r.assets[0].size}catch{Write-Output '0'}" 2^>nul') do set REMOTE_SIZE=%%a
if "!REMOTE_SIZE!"=="0" set REMOTE_SIZE=94371840

:: Check cached download first
set SKIP_DL=0
if exist "%ZIPFILE%" (
    echo    Cached zip found, checking if still up to date...
    for %%f in ("%ZIPFILE%") do set LOCAL_SIZE=%%~zf
    if "!LOCAL_SIZE!"=="!REMOTE_SIZE!" (
        echo    [OK] Cached zip matches remote, skipping download.
        set SKIP_DL=1
    )
)

if "!SKIP_DL!"=="0" (
    set /a REMOTE_MB=!REMOTE_SIZE!/1048576
    echo    Fetching from GitHub (~!REMOTE_MB!MB, please wait)...
    powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%DL_URL%' -OutFile '%ZIPFILE%' -TimeoutSec 300"

    if not exist "%ZIPFILE%" (
        echo [ERROR] Download failed.
        echo.
        pause
        exit /b 1
    )
    echo    [OK] Download complete
)

echo [3/4] Extracting...

powershell -NoProfile -Command "try{$z=[IO.Compression.ZipFile]::OpenRead('%ZIPFILE%');$z.Dispose();exit 0}catch{exit 1}" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Zip file is corrupted. Will re-download on next run.
    del "%ZIPFILE%" >nul 2>&1
    pause
    exit /b 1
)

set TMPDIR=%TEMP%\AgentChat-update-tmp
if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%" >nul 2>&1
mkdir "%TMPDIR%"

powershell -NoProfile -Command "Expand-Archive -Path '%ZIPFILE%' -DestinationPath '%TMPDIR%' -Force"
if errorlevel 1 (
    echo [ERROR] Extract failed. Zip may be corrupted.
    del "%ZIPFILE%" >nul 2>&1
    rmdir /s /q "%TMPDIR%" >nul 2>&1
    pause
    exit /b 1
)

set SRCDIR=%TMPDIR%
if exist "%TMPDIR%\AgentChat" set SRCDIR=%TMPDIR%\AgentChat

if not exist "%SRCDIR%\start.bat" (
    echo [ERROR] Extracted content is incomplete.
    del "%ZIPFILE%" >nul 2>&1
    rmdir /s /q "%TMPDIR%" >nul 2>&1
    pause
    exit /b 1
)
echo    [OK] Extract complete

echo [4/4] Applying update...
set SRCDIR=%TMPDIR%
if exist "%TMPDIR%\AgentChat" set SRCDIR=%TMPDIR%\AgentChat

for %%d in (dist webui node_modules scripts) do (
    if exist "%SRCDIR%\%%d" (
        echo    - %%~d ...
        if exist "%%d" rmdir /s /q "%%d" >nul 2>&1
        xcopy "%SRCDIR%\%%d" "%%d" /E /I /Q /Y >nul 2>&1
    )
)

for %%f in ("%SRCDIR%\start.bat" "%SRCDIR%\update.bat" "%SRCDIR%\install.bat" "%SRCDIR%\*.md" "%SRCDIR%\package.json" "%SRCDIR%\tsconfig.json") do (
    if exist %%f (
        copy /Y %%f "." >nul 2>&1
    )
)

rmdir /s /q "%TMPDIR%" >nul 2>&1
echo    [OK] Update applied

echo.
echo ============================================
echo   Update Complete!
echo ============================================
echo.
echo   Restarting AgentChat...
timeout /t 2 /nobreak >nul

if exist "start.bat" (
    start "" "start.bat"
)

exit /b 0
