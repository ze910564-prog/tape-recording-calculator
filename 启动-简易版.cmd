@echo off
setlocal enabledelayedexpansion
rem Fallback launcher that uses NO PowerShell at all.
rem Use this if the main launcher is blocked by execution policy or antivirus.
rem ASCII-only and CRLF on purpose: cmd.exe mangles CJK depending on the code page,
rem and mishandles LF-only batch files.

title Tape Recording Calculator
cd /d "%~dp0"

echo ============================================
echo   Tape Recording Calculator
echo ============================================
echo.

rem --- 1. node present? -----------------------------------------------------
where node >nul 2>nul
if errorlevel 1 (
  echo [X] node not found.
  echo     Install Node.js 18+ from https://nodejs.org and run this again.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node --version 2^>nul') do set NODEV=%%v
echo Node %NODEV%

rem --- 2. reuse the port from last time, if it is usable --------------------
set PORT=7788
if exist ".cache\config.json" (
  for /f "tokens=2 delims=:," %%p in ('findstr /c:"\"port\"" .cache\config.json 2^>nul') do set RAW=%%p
  if defined RAW (
    set RAW=!RAW: =!
    if not "!RAW!"=="null" set PORT=!RAW!
  )
)

rem --- 3. already running? --------------------------------------------------
rem curl ships with Windows 10 1803 and newer; exit code 0 means it answered.
curl -s -o nul -m 2 "http://127.0.0.1:!PORT!/api/state"
if not errorlevel 1 (
  echo Server already running on port !PORT!. Opening the browser.
  start "" "http://127.0.0.1:!PORT!"
  exit /b 0
)

echo Starting the server on port !PORT! ...
echo A second window will open with the server output - close it to stop.
echo.

start "Tape Calc Server" cmd /k node server.mjs

rem --- 4. wait until it actually answers ------------------------------------
set READY=0
for /l %%i in (1,1,40) do (
  if "!READY!"=="0" (
    timeout /t 1 /nobreak >nul
    curl -s -o nul -m 2 "http://127.0.0.1:!PORT!/api/state"
    if not errorlevel 1 set READY=1
  )
)

if "!READY!"=="0" (
  echo.
  echo [X] No response after 40 seconds. Check the server window for errors.
  echo.
  pause
  exit /b 1
)

echo.
echo [OK] Ready at http://127.0.0.1:!PORT!
echo.
echo   First start scans the library (~20s); later starts use the cache.
echo   To stop: close the server window, or run  node tools\stop.mjs
echo.
start "" "http://127.0.0.1:!PORT!"
exit /b 0
