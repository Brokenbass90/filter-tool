@echo off
if not defined SB_LOGGING (
  set "SB_LOGGING=1"
  set "SB_BASE=%~dp0"
  if not exist "%SB_BASE%logs" mkdir "%SB_BASE%logs" >nul 2>nul
  for /f %%T in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "SB_TS=%%T"
  if not defined SB_TS set "SB_TS=manual"
  set "SB_LOG=%SB_BASE%logs\start_%SB_TS%.log"
  set "SB_HELPER_LOG=%SB_BASE%logs\helper_%SB_TS%.log"
  call "%~f0" %* >> "%SB_LOG%" 2>&1
  echo.
  echo Лог запуска: %SB_LOG%
  echo Лог helper: %SB_HELPER_LOG%
  echo Если есть ошибка — отправьте этот файл.
  pause
  exit /b %errorlevel%
)
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "PORT=17871"
set "HEALTH_URL=http://127.0.0.1:%PORT%/health"
set "APP_HTML=%cd%\vadim-filter-tool.html"

set "NODE_EXE="
set "NPM_CMD=npm"

if exist "%cd%\.node-runtime\node.exe" set "NODE_EXE=%cd%\.node-runtime\node.exe"
if exist "%cd%\.node-runtime\npm.cmd" set "NPM_CMD=%cd%\.node-runtime\npm.cmd"

if not defined NODE_EXE (
  where node >nul 2>nul
  if not errorlevel 1 (
    for /f "usebackq delims=" %%N in (`where node`) do if not defined NODE_EXE set "NODE_EXE=%%N"
  )
)
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPM_CMD=%ProgramFiles%\nodejs\npm.cmd"
if exist "%ProgramFiles(x86)%\nodejs\npm.cmd" set "NPM_CMD=%ProgramFiles(x86)%\nodejs\npm.cmd"

if defined NODE_EXE set "NODE_EXE=%NODE_EXE:\"=%"
if defined NPM_CMD set "NPM_CMD=%NPM_CMD:\"=%"

if not defined NODE_EXE (
  for %%Z in ("%cd%\node-v*-win-x64.zip") do (
    if exist "%%~fZ" (
      echo [Node] extracting %%~nxZ ...
      if exist "%cd%\.node-tmp" rmdir /s /q "%cd%\.node-tmp"
      if exist "%cd%\.node-runtime" rmdir /s /q "%cd%\.node-runtime"
      powershell -NoProfile -Command "Expand-Archive -Path '%%~fZ' -DestinationPath '%cd%\\.node-tmp' -Force"
      for /d %%D in ("%cd%\.node-tmp\*") do (
        if exist "%%~fD\node.exe" xcopy /e /i /y "%%~fD\*" "%cd%\.node-runtime\" >nul
      )
      if exist "%cd%\.node-tmp" rmdir /s /q "%cd%\.node-tmp"
    )
  )
)

if not defined NODE_EXE if exist "%cd%\.node-runtime\node.exe" set "NODE_EXE=%cd%\.node-runtime\node.exe"
if exist "%cd%\.node-runtime\npm.cmd" set "NPM_CMD=%cd%\.node-runtime\npm.cmd"

if not defined NODE_EXE if exist "%cd%\nodejs-lts-x64.msi" (
  echo [Node] installing nodejs-lts-x64.msi silently...
  msiexec /i "%cd%\nodejs-lts-x64.msi" /qn /norestart
)

if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if exist "%ProgramFiles%\nodejs\npm.cmd" set "NPM_CMD=%ProgramFiles%\nodejs\npm.cmd"
if exist "%ProgramFiles(x86)%\nodejs\npm.cmd" set "NPM_CMD=%ProgramFiles(x86)%\nodejs\npm.cmd"

if defined NODE_EXE set "NODE_EXE=%NODE_EXE:\"=%"
if defined NPM_CMD set "NPM_CMD=%NPM_CMD:\"=%"

if not defined NODE_EXE (
  echo ERROR: Node.js was not found.
  echo Put node-v20.x-win-x64.zip OR nodejs-lts-x64.msi near START_WIN.bat and run again as Administrator.
  pause
  exit /b 1
)

for /f %%V in ('"%NODE_EXE%" -p "process.versions.node.split('.')[0]" 2^>nul') do set "NODE_MAJOR=%%V"
if "%NODE_MAJOR%"=="" set "NODE_MAJOR=0"
if %NODE_MAJOR% GEQ 24 (
  echo [WARN] Node v%NODE_MAJOR% detected. Email will still work. OCR may be limited.
)
set "NODE_MAJOR_FILE=helper\.node_major"
set "PREV_NODE_MAJOR="
if exist "%NODE_MAJOR_FILE%" set /p PREV_NODE_MAJOR=<"%NODE_MAJOR_FILE%"

echo [0/3] kill old OCR processes on port %PORT%...
for /f "tokens=5" %%P in ('netstat -aon ^| findstr :%PORT% ^| findstr LISTENING') do taskkill /PID %%P /F >nul 2>nul
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process | ? { $_.Name -match '^node(.exe)?$' -and $_.CommandLine -match 'ocr_helper_server\\.js' }; if($p){$p|%%{$_.ProcessId}}"`) do taskkill /PID %%P /F >nul 2>nul

echo [1/3] install helper deps if needed...
set "NEED_NPM=0"
if not exist "helper\node_modules\nodemailer\package.json" set "NEED_NPM=1"
if not exist "helper\node_modules\tesseract.js\package.json" set "NEED_NPM=1"
if not exist "helper\node_modules\canvas\package.json" set "NEED_NPM=1"
if not exist "helper\node_modules\pdfjs-dist\package.json" set "NEED_NPM=1"
if not "%PREV_NODE_MAJOR%"=="%NODE_MAJOR%" (
  echo [Node] major changed (%PREV_NODE_MAJOR% ^> %NODE_MAJOR%), reinstalling helper deps...
  set "NEED_NPM=1"
  if exist "helper\node_modules" rmdir /s /q "helper\node_modules"
)
if "%NEED_NPM%"=="1" (
  pushd helper
  call "%NPM_CMD%" install --no-audit --no-fund
  if errorlevel 1 (
    echo [WARN] first npm install failed, retrying...
    timeout /t 2 /nobreak >nul
    call "%NPM_CMD%" install --no-audit --no-fund
  )
  if errorlevel 1 (
    popd
    echo ERROR: npm install failed.
    pause
    exit /b 1
  )
  popd
)
> "%NODE_MAJOR_FILE%" echo %NODE_MAJOR%

echo [2/3] start OCR server...
set "HELPER_RUNNER=%cd%\helper\run_helper_logged.ps1"
echo [helper] log file: %SB_HELPER_LOG%
start "Strong Bridge OCR Server" /D "%cd%" cmd /k ""powershell" -NoProfile -ExecutionPolicy Bypass -File "%HELPER_RUNNER%" -NodeExe "%NODE_EXE%" -AppDir "%cd%" -LogFile "%SB_HELPER_LOG%""

echo [3/3] wait for health...
powershell -NoProfile -Command "$ok=$false;1..30|%%{try{$r=Invoke-RestMethod -Uri '%HEALTH_URL%' -TimeoutSec 2;if($r.ok){$ok=$true;break}}catch{};Start-Sleep -s 1}; if(-not $ok){exit 1}"
if errorlevel 1 (
  echo ERROR: helper not ready on %HEALTH_URL%
  echo Send files from logs\: start_*.log and helper_*.log.
  echo Open the "Strong Bridge OCR Server" window and send screenshot if errors are shown.
  pause
  exit /b 1
)
set "OCR_HEALTH_STATE=unknown"
for /f %%S in ('powershell -NoProfile -Command "$r=Invoke-RestMethod -Uri '%HEALTH_URL%' -TimeoutSec 3; if($r.deps.canvas -and $r.deps.pdfjs){'ok'} else {'degraded'}"') do set "OCR_HEALTH_STATE=%%S"
if /I "%OCR_HEALTH_STATE%"=="degraded" (
  echo [WARN] OCR helper started in degraded mode (deps.canvas/pdfjs=false). Re-run START_WIN.bat to reinstall deps.
)

echo OCR server ready: %HEALTH_URL%
start "" "%APP_HTML%"
echo Done.
endlocal
exit /b 0
