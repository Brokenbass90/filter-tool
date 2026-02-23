@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"

set "PORT=17871"
set "HEALTH_URL=http://127.0.0.1:%PORT%/health"
set "APP_HTML=%cd%\vadim-filter-tool.html"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js не найден. Запускаю установщик Node.js LTS...
  if exist "nodejs-lts-x64.msi" (
    start /wait "" "nodejs-lts-x64.msi"
    echo.
    echo Установка завершена. Запустите START_WIN.bat еще раз.
    pause
    exit /b 1
  ) else (
    echo Установщик не найден. Скачайте Node.js LTS и запустите снова.
    start "" "https://nodejs.org/en/download/"
    pause
    exit /b 1
  )
)

for /f %%V in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%V"
if "%NODE_MAJOR%"=="" set "NODE_MAJOR=0"
if %NODE_MAJOR% GEQ 24 (
  echo Обнаружен Node.js v%NODE_MAJOR%.x — для OCR нужен LTS 20/22.
  if exist "nodejs-lts-x64.msi" (
    echo Запускаю установщик nodejs-lts-x64.msi...
    start /wait "" "nodejs-lts-x64.msi"
    echo.
    echo Установка/обновление завершено. Запустите START_WIN.bat еще раз.
    pause
    exit /b 1
  ) else (
    echo Положите установщик nodejs-lts-x64.msi в корень архива и запустите снова.
    start "" "https://nodejs.org/en/download/"
    pause
    exit /b 1
  )
)

echo [0/3] Останавливаю старые процессы OCR...
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$p=Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if($p){$p|%%{$_.OwningProcess}}"`) do (
  if not "%%P"=="" (
    echo - taskkill PID %%P
    taskkill /PID %%P /F >nul 2>nul
  )
)
for /f "tokens=5" %%P in ('netstat -aon ^| findstr :%PORT% ^| findstr LISTENING') do (
  if not "%%P"=="" (
    echo - taskkill PID %%P
    taskkill /PID %%P /F >nul 2>nul
  )
)
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process | ? { $_.Name -match '^node(.exe)?$' -and $_.CommandLine -match 'ocr_helper_server\\.js' }; if($p){$p|%%{$_.ProcessId}}"`) do (
  if not "%%P"=="" (
    echo - taskkill OCR helper PID %%P
    taskkill /PID %%P /F >nul 2>nul
  )
)

echo [1/3] Проверяю зависимости OCR helper...
set "NEED_NPM=0"
if not exist "helper\node_modules\nodemailer\package.json" set "NEED_NPM=1"
if not exist "helper\node_modules\canvas\package.json" set "NEED_NPM=1"
if not exist "helper\.node_major.txt" set "NEED_NPM=1"
if exist "helper\.node_major.txt" (
  set /p PREV_NODE_MAJOR=<helper\.node_major.txt
  if not "!PREV_NODE_MAJOR!"=="%NODE_MAJOR%" set "NEED_NPM=1"
)

if "%NEED_NPM%"=="1" (
  echo Обновляю зависимости helper под Node.js %NODE_MAJOR%...
  if exist "helper\node_modules" rmdir /s /q "helper\node_modules"
  pushd helper
  call npm install
  if errorlevel 1 (
    popd
    echo Ошибка npm install. Проверьте интернет и повторите запуск.
    pause
    exit /b 1
  )
  popd
  > "helper\.node_major.txt" echo %NODE_MAJOR%
)

echo [2/3] Запускаю OCR сервер...
start "Strong Bridge OCR Server" cmd /k "cd /d ""%cd%"" && node helper\ocr_helper_server.js"

echo [3/3] Жду готовность OCR сервера...
set /a TRY=0
:wait_health
set /a TRY+=1
powershell -NoProfile -Command "try { $r=Invoke-RestMethod -Uri '%HEALTH_URL%' -TimeoutSec 2; if($r.ok){ exit 0 } else { exit 1 } } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 goto healthy
if %TRY% GEQ 25 goto health_fail
timeout /t 1 /nobreak >nul
goto wait_health

:healthy
echo OCR сервер готов: %HEALTH_URL%
start "" "%APP_HTML%"
echo.
echo Готово. Ничего вручную чистить не нужно — START_WIN делает это сам.
echo Окно "Strong Bridge OCR Server" не закрывайте во время работы.
echo.
endlocal
exit /b 0

:health_fail
echo.
echo Не удалось запустить OCR сервер на %HEALTH_URL%.
echo Проверьте антивирус/брандмауэр и запустите START_WIN.bat от имени администратора.
echo.
pause
endlocal
exit /b 1
