@echo off
setlocal

set PORT=17871
echo [1/1] Stopping OCR server on port %PORT%...

for /f "tokens=5" %%a in ('netstat -aon ^| findstr :%PORT% ^| findstr LISTENING') do (
  echo - taskkill PID %%a
  taskkill /F /PID %%a >nul 2>&1
)

echo Done.
pause
endlocal