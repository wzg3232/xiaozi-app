@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Please install Node.js 24.15 or newer, then run this file again.
  pause
  exit /b 1
)
if not exist "node_modules\ws\package.json" (
  call npm ci --omit=dev --no-fund --no-audit
  if errorlevel 1 exit /b 1
)
node scripts\build-web.mjs
if errorlevel 1 exit /b 1
set "HOST=0.0.0.0"
echo iChat demo: http://127.0.0.1:4200/showcase
node scripts\list-server-addresses.mjs
echo Keep this window open. Press Ctrl+C here to stop the server.
node "%CD%\server\index.mjs" --demo
pause
