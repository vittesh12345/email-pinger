@echo off
rem Double-click this file on Windows to start Pinger.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Pinger needs Node.js 22.13 or newer. Download it from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing Pinger ^(first run only, about a minute^)...
  call npm install --omit=dev --no-audit --no-fund
  if errorlevel 1 (
    echo Installation failed.
    pause
    exit /b 1
  )
)

node bin\pinger.js %*
if errorlevel 1 pause
