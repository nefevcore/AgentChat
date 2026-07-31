@echo off
setlocal enabledelayedexpansion
title AgentChat - Install
cd /d "%~dp0"

echo.
echo ============================================
echo   AgentChat - One-Click Install
echo ============================================
echo.

:: -- Check existing installation --
if exist "start.bat" (
    echo [*] Existing AgentChat installation detected.
    echo     Config and chat history will be preserved.
    echo.
    set /p OVERWRITE="    Continue (update program files only)? (Y/N): "
    if /i not "!OVERWRITE!"=="Y" (
        echo    Cancelled.
        pause
        exit /b 0
    )
    echo.
)

:: -- Download --
echo [1/5] Downloading latest release...
set DL_URL=https://github.com/nefevcore/AgentChat/releases/download/latest/AgentChat-latest-win-x64.zip
set ZIPFILE=%TEMP%\AgentChat-install.zip

:: Get remote file size from GitHub API
set REMOTE_SIZE=0
for /f "delims=" %%a in ('powershell -NoProfile -Command "$h=@{'Accept'='application/vnd.github+json'};try{$r=Invoke-RestMethod -Uri 'https://api.github.com/repos/nefevcore/AgentChat/releases/tags/latest' -Headers $h -TimeoutSec 10;Write-Output $r.assets[0].size}catch{Write-Output '0'}" 2^>nul') do set REMOTE_SIZE=%%a
if "!REMOTE_SIZE!"=="0" set REMOTE_SIZE=94371840

:: Check if cached zip matches remote
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
    powershell -NoProfile -Command "[Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri '%DL_URL%' -OutFile '%ZIPFILE%' -TimeoutSec 600"

    if not exist "%ZIPFILE%" (
        echo [ERROR] Download failed. Check your network or visit:
        echo   https://github.com/nefevcore/AgentChat/releases/latest
        pause
        exit /b 1
    )
    echo    [OK] Download complete
)

:: -- Extract --
echo [2/5] Extracting...

:: Validate zip before extracting
powershell -NoProfile -Command "try{$z=[IO.Compression.ZipFile]::OpenRead('%ZIPFILE%');$z.Dispose();exit 0}catch{exit 1}" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Zip file is corrupted. Will re-download on next run.
    del "%ZIPFILE%" >nul 2>&1
    pause
    exit /b 1
)

set TMPDIR=%TEMP%\AgentChat-install-tmp
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

:: Verify extracted content
if not exist "%SRCDIR%\start.bat" (
    echo [ERROR] Extracted content is incomplete.
    del "%ZIPFILE%" >nul 2>&1
    rmdir /s /q "%TMPDIR%" >nul 2>&1
    pause
    exit /b 1
)
echo    [OK] Extract complete

:: -- Copy files --
echo [3/5] Installing program files...

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
echo    [OK] Files installed

:: -- Node.js --
echo [4/5] Setting up Node.js...
set NODE=node\node.exe
if not exist "%NODE%" (
    if exist "node-portable.zip" (
        echo    Extracting Node.js portable (~100MB, first time only)...
        powershell -Command "Expand-Archive -Path node-portable.zip -DestinationPath _node_tmp -Force"
        for /d %%d in (_node_tmp\node-*) do move "%%d" node
        rmdir /s /q _node_tmp 2>nul
        del node-portable.zip
        echo    [OK] Node.js ready
    ) else (
        echo    [*] node-portable.zip not found, using system Node.js
        set NODE=node
    )
) else (
    echo    [OK] Node.js already present
)
%NODE% --version >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js is not available. Install from https://nodejs.org/
    pause
    exit /b 1
)

:: -- Default config --
echo [5/5] Initializing workspace...
if not exist "workspace\default\config.json" (
    if not exist "workspace" mkdir "workspace"
    if not exist "workspace\default" mkdir "workspace\default"
    (
    echo {
    echo   "llmProviders": {
    echo     "deepseek-pro": {
    echo       "provider": "deepseek",
    echo       "model": "deepseek-v4-pro",
    echo       "api_key": "YOUR_API_KEY_HERE",
    echo       "temperature": 0.7,
    echo       "max_tokens": 8192
    echo     }
    echo   },
    echo   "defaultLLM": "deepseek-pro"
    echo }
    ) > "workspace\default\config.json"
    echo.
    echo    [*] Default config created.
    echo    Edit workspace\default\config.json and set your API Key.
    echo.
)
echo    [OK] Workspace initialized

:: -- Done --
echo.
echo ============================================
echo   Install Complete!
echo ============================================
echo.
echo   Before launching, set your API Key in:
echo     workspace\default\config.json
echo.
set /p LAUNCH="   Launch now? (Y/N): "

if /i not "!LAUNCH!"=="Y" (
    echo   Skipped. Double-click start.bat to launch later.
    pause
    exit /b 0
)

if exist "start.bat" (
    start "" "start.bat"
)
pause
exit /b 0
