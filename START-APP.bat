@echo off
setlocal
title Matrix Chat Tester
cd /d "%~dp0"

echo ==========================================
echo   Matrix Chat Tester
echo ==========================================

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js is not installed or not on PATH.
  echo Install Node.js 20 LTS or newer from https://nodejs.org/ and run this file again.
  goto :fail
)
for /f "delims=" %%v in ('node -v') do echo Node.js version: %%v

if not exist "node_modules\" (
  echo Installing dependencies, this can take a few minutes...
  call npm install
  if errorlevel 1 (
    echo [ERROR] npm install failed. Check your internet connection and try again.
    goto :fail
  )
)

echo.
echo Starting development server...
echo The app will open at:  http://localhost:5173
echo (If port 5173 is busy, Vite prints the actual URL below.)
echo Press Ctrl+C to stop.
echo.
call npm run dev
if errorlevel 1 goto :fail
goto :eof

:fail
echo.
echo Something went wrong. Read the messages above.
pause
exit /b 1
