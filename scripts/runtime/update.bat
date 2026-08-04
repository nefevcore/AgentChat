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
        echo [Node.js] Extracting portable Node.js - first time - approx 100MB...
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

:: -- Get current version (pure cmd, no PowerShell) --
set CURVER=unknown
for /f "usebackq delims=" %%a in (`findstr /c:^"version^" package.json 2^>nul`) do (
    for /f "tokens=2 delims=:, " %%b in ("%%a") do set CURVER=%%b
)
if defined CURVER set CURVER=!CURVER:"=!
if not defined CURVER set CURVER=unknown

echo   Current version: !CURVER!
echo   Checking GitHub for latest build...
echo.

:: -- Get latest release info --
set API_URL=https://api.github.com/repos/nefevcore/AgentChat/releases/tags/latest
set DL_URL=https://github.com/nefevcore/AgentChat/releases/download/latest/AgentChat-latest-win-x64.zip

set REMOTE_VER=
powershell -NoProfile -Command "try{$r=Invoke-RestMethod -Uri '%API_URL%' -Headers @{Accept='application/vnd.github+json'} -TimeoutSec 10;$m=[regex]::Match($r.body,'\*\*版本\*\*\s*[:：]\s*([0-9.]+)');if($m.Success){$m.Groups[1].Value | Out-File -Encoding ASCII '%TEMP%\agentchat-ver.txt'}else{$r.id | Out-File -Encoding ASCII '%TEMP%\agentchat-ver.txt'}}catch{exit 1}" >nul 2>&1
if not errorlevel 1 (
    set /p REMOTE_VER=<"%TEMP%\agentchat-ver.txt"
    del "%TEMP%\agentchat-ver.txt" >nul 2>&1
)

if "!REMOTE_VER!"=="" (
    echo [WARNING] Cannot reach GitHub. Skipping update check.
    echo.
    pause
    exit /b 0
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
set ZIPTMP=%TEMP%\AgentChat-update.tmp

:: Check cache: if zip exists and is valid, skip download
set SKIP_DL=0
if exist "%ZIPFILE%" (
    powershell -NoProfile -Command "try{$z=[IO.Compression.ZipFile]::OpenRead('%ZIPFILE%');$z.Dispose();exit 0}catch{exit 1}" >nul 2>&1
    if not errorlevel 1 (
        echo    [OK] Valid cached zip found, skipping download.
        set SKIP_DL=1
    ) else (
        echo    Cached zip is corrupted, will re-download.
        del "%ZIPFILE%" >nul 2>&1
    )
)

if "!SKIP_DL!"=="0" (
    :: Detect best downloader: aria2c (multi-connection, fast) > curl (fallback)
    set DOWNLOADER=curl
    where aria2c >nul 2>&1
    if not errorlevel 1 set DOWNLOADER=aria2c

    if "!DOWNLOADER!"=="aria2c" goto dl_aria2
    goto dl_curl

    :: ── aria2c path (multi-connection, much faster) ──
    :dl_aria2
    echo    Downloading with aria2c (16 connections^)...
    aria2c -x16 -s16 --allow-overwrite=true --console-log-level=warn ^
      -o "%ZIPTMP%" "%DL_URL%" ^
      --max-connection-per-server=16 --min-split-size=1M ^
      --retry-wait=3 --max-tries=3 --timeout=30 --connect-timeout=10
    if not errorlevel 1 goto validate_zip
    echo [ERROR] aria2c download failed.
    del "%ZIPTMP%" >nul 2>&1
    pause
    exit /b 1

    :: ── curl path (with retry + resume) ──
    :dl_curl
    set RETRY=0
    set MAX_RETRY=3
    :retry_download
    echo    Fetching from GitHub (attempt !RETRY!/!MAX_RETRY!^)...
    :: -C - resumes partial download; --retry handles transient failures
    curl -L --fail --progress-bar -C - --retry 3 --retry-delay 2 --retry-max-time 120 ^
      -o "%ZIPTMP%" "%DL_URL%" ^
      --write-out "    Downloaded %%{size_download} bytes in %%{time_total}s (%%{speed_download}/s)\n"
    if not errorlevel 1 goto validate_zip

    :: curl failed — retry loop
    set /a RETRY+=1
    if !RETRY! lss !MAX_RETRY! (
        echo    [WARN] Download interrupted, retrying in 3s...
        timeout /t 3 /nobreak >nul
        goto retry_download
    )
    echo [ERROR] Download failed after !MAX_RETRY! attempts.
    del "%ZIPTMP%" >nul 2>&1
    pause
    exit /b 1

    :validate_zip
    :: Validate integrity
    powershell -NoProfile -Command "try{$z=[IO.Compression.ZipFile]::OpenRead('%ZIPTMP%');$z.Dispose();exit 0}catch{exit 1}" >nul 2>&1
    if not errorlevel 1 goto download_ok

    :: Corrupted zip — retry
    set /a RETRY+=1
    if !RETRY! lss !MAX_RETRY! (
        echo    [WARN] Downloaded zip corrupted, retrying...
        del "%ZIPTMP%" >nul 2>&1
        timeout /t 2 /nobreak >nul
        goto retry_download
    )
    echo [ERROR] Downloaded zip is corrupted after !MAX_RETRY! attempts.
    del "%ZIPTMP%" >nul 2>&1
    pause
    exit /b 1

    :download_ok
    move /Y "%ZIPTMP%" "%ZIPFILE%" >nul 2>&1
    echo    [OK] Download complete
)

echo [3/4] Extracting...

set TMPDIR=%TEMP%\AgentChat-update-tmp
if exist "%TMPDIR%" rmdir /s /q "%TMPDIR%" >nul 2>&1
mkdir "%TMPDIR%" 2>nul

powershell -NoProfile -Command "try{[IO.Compression.ZipFile]::ExtractToDirectory('%ZIPFILE%','%TMPDIR%');exit 0}catch{Write-Host $_.Exception.Message;exit 1}" > "%TEMP%\agentchat-extract.log" 2>&1
if errorlevel 1 (
    echo [ERROR] Extract failed:
    type "%TEMP%\agentchat-extract.log"
    del "%TEMP%\agentchat-extract.log" >nul 2>&1
    del "%ZIPFILE%" >nul 2>&1
    rmdir /s /q "%TMPDIR%" >nul 2>&1
    pause
    exit /b 1
)
del "%TEMP%\agentchat-extract.log" >nul 2>&1

set SRCDIR=%TMPDIR%
if exist "%TMPDIR%\AgentChat" set SRCDIR=%TMPDIR%\AgentChat

if not exist "%SRCDIR%\start.bat" (
    echo [ERROR] Extracted content is missing start.bat.
    del "%ZIPFILE%" >nul 2>&1
    rmdir /s /q "%TMPDIR%" >nul 2>&1
    pause
    exit /b 1
)
echo    [OK] Extract complete

echo [4/4] Applying update...

for %%d in (dist webui node_modules scripts) do (
    if exist "%SRCDIR%\%%d" (
        echo    - %%~d ...
        if exist "%%d" rmdir /s /q "%%d" >nul 2>&1
        xcopy "%SRCDIR%\%%d" "%%d" /E /I /Q /Y >nul 2>&1
    )
)

for %%f in ("%SRCDIR%\start.bat" "%SRCDIR%\update.bat" "%SRCDIR%\*.md" "%SRCDIR%\package.json" "%SRCDIR%\tsconfig.json") do (
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
