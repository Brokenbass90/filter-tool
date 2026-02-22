\
@echo off
setlocal
cd /d %~dp0

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

rem Освобождаем порт (если предыдущий OCR helper "завис")
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command ^
  "$c = Get-NetTCPConnection -LocalPort 17871 -State Listen -ErrorAction SilentlyContinue; if($c){$c.OwningProcess}"`) do set OLD_PID=%%P

if not "%OLD_PID%"=="" (
  echo Порт 17871 занят (PID=%OLD_PID%). Останавливаю...
  taskkill /PID %OLD_PID% /F >nul 2>nul
)

if not exist "helper\node_modules" (
  echo [1/2] Устанавливаю зависимости OCR helper (npm install)...
  pushd helper
  npm install
  popd
)

echo [2/2] Запускаю OCR сервер...
start "Vadim OCR Server" cmd /k "node helper\ocr_helper_server.js"

timeout /t 2 /nobreak >nul
start "" "%cd%\vadim-filter-tool.html"

echo.
echo Готово. Окно "Vadim OCR Server" должно оставаться открытым.
echo Если порт снова занят — используйте STOP_WIN.bat.
echo.
endlocal
