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
set ZIPTMP=%TEMP%\AgentChat-install.tmp

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
    echo    Fetching from GitHub...
    :: curl progress bar refreshes via \r (cmd may flicker), that's normal.
    :: --write-out prints download stats when done.
    curl -L --fail --progress-bar -o "%ZIPTMP%" "%DL_URL%" --write-out "    Downloaded %{size_download} bytes in %{time_total}s (%{speed_download}/s)\n"
    if errorlevel 1 (
        echo [ERROR] Download failed.
        del "%ZIPTMP%" >nul 2>&1
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

:: -- Extract --
echo [2/5] Extracting...

set TMPDIR=%TEMP%\AgentChat-install-tmp
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
    echo [ERROR] Extracted content is missing start.bat. Zip may be from an older format.
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
        echo    Extracting Node.js portable - approx 100MB - first time only...
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
