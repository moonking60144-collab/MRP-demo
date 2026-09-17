@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24 LTS and reopen this file.
  pause
  exit /b 1
)
if not exist "node_modules\next\dist\bin\next" (
  call npm ci
  if errorlevel 1 goto :failed
)
if not exist ".next\BUILD_ID" (
  call npm run build
  if errorlevel 1 goto :failed
)
echo MRP Demo: http://127.0.0.1:3000
echo Keep this window open. Ctrl+C stops the demo.
start "" "http://127.0.0.1:3000"
call npm start
if errorlevel 1 goto :failed
exit /b 0
:failed
echo Startup failed. Read the message above. No data was deleted.
pause
exit /b 1
