@echo off
setlocal EnableExtensions

set "PORT=17871"
echo [1/1] Останавливаю OCR helper...

for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$p=Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if($p){$p|%%{$_.OwningProcess}}"`) do (
  if not "%%P"=="" (
    echo - taskkill PID %%P
    taskkill /F /PID %%P >nul 2>nul
  )
)

for /f "tokens=5" %%P in ('netstat -aon ^| findstr :%PORT% ^| findstr LISTENING') do (
  if not "%%P"=="" (
    echo - taskkill PID %%P
    taskkill /F /PID %%P >nul 2>nul
  )
)

for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process | ? { $_.Name -match '^node(.exe)?$' -and $_.CommandLine -match 'ocr_helper_server\\.js' }; if($p){$p|%%{$_.ProcessId}}"`) do (
  if not "%%P"=="" (
    echo - taskkill OCR helper PID %%P
    taskkill /F /PID %%P >nul 2>nul
  )
)

echo Готово.
pause
endlocal
