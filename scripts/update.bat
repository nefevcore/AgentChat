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

:: -- Get current version --
set CURVER=unknown
powershell -NoProfile -Command "try{(Get-Content package.json -Raw | ConvertFrom-Json).version | Out-File -Encoding ASCII '%TEMP%\agentchat-curver.txt'}catch{}" >nul 2>&1
if exist "%TEMP%\agentchat-curver.txt" (
    set /p CURVER=<"%TEMP%\agentchat-curver.txt"
    del "%TEMP%\agentchat-curver.txt" >nul 2>&1
)

echo   Current version: !CURVER!
echo   Checking GitHub for latest build...
echo.

:: -- Get latest release info --
set API_URL=https://api.github.com/repos/nefevcore/AgentChat/releases/tags/latest
set DL_URL=https://github.com/nefevcore/AgentChat/releases/download/latest/AgentChat-latest-win-x64.zip

set REMOTE_VER=
powershell -NoProfile -Command "try{$r=Invoke-RestMethod -Uri '%API_URL%' -Headers @{Accept='application/vnd.github+json'} -TimeoutSec 10;if($r.tag_name){$r.tag_name | Out-File -Encoding ASCII '%TEMP%\agentchat-ver.txt'}else{exit 1}}catch{exit 1}" >nul 2>&1
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
    echo    Fetching from GitHub - please wait...
    powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%DL_URL%' -OutFile '%ZIPTMP%' -TimeoutSec 300"

    if not exist "%ZIPTMP%" (
        echo [ERROR] Download failed.
        echo.
        pause
        exit /b 1
    )

    :: Validate and rename
    powershell -NoProfile -Command "try{$z=[IO.Compression.ZipFile]::OpenRead('%ZIPTMP%');$z.Dispose();exit 0}catch{exit 1}" >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] Downloaded zip is corrupted.
        del "%ZIPTMP%" >nul 2>&1
        pause
        exit /b 1
    )
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
