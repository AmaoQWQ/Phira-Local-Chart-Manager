@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js was not found in PATH.
  echo         Install Node.js 22.5 or newer, then reopen this window.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found in PATH.
  echo         Install Node.js 22.5 or newer, then reopen this window.
  pause
  exit /b 1
)

if not exist "node_modules\" (
  echo Dependencies are not installed. Installing them now...
  call npm.cmd install
  if errorlevel 1 (
    echo [ERROR] Dependency installation failed.
    pause
    exit /b 1
  )
)

if exist "certs\server.crt" if exist "certs\server.key" goto certificate_ready

  echo TLS certificate not found. Generating a self-signed certificate...
  call npm.cmd run cert:generate
  if errorlevel 1 exit /b 1

:certificate_ready

if not exist "certs\server.crt" (
  echo [ERROR] certs\server.crt was not created.
  pause
  exit /b 1
)

if not exist "certs\server.key" (
  echo [ERROR] certs\server.key was not created.
  pause
  exit /b 1
)

if not "%~1"=="" set "PORT=%~1"

rem Without an explicit argument, leave PORT unset so the application reads it
rem from .env. This keeps the configured origin port stable across restarts.

if defined PORT (
  echo Starting Phira Local Chart Manager on port %PORT%...
) else (
  echo Starting Phira Local Chart Manager using the port configured in .env...
)
call npm.cmd run start:quick
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo [ERROR] Probe failed to start.
  pause
  exit /b %EXIT_CODE%
)

echo.
echo Probe started. Use stop-probe.cmd to stop it.
echo Logs: logs\server.log and logs\server-error.log
echo.
echo Showing the latest log entries. Press Ctrl+C to close the log viewer.
echo The Probe service will keep running; use stop-probe.cmd to stop it.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Get-Content -LiteralPath '%~dp0logs\server.log' -Tail 20 -Wait"
exit /b 0
