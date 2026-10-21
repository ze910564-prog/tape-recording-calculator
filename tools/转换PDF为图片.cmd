@echo off
rem Double-click entry point. ASCII-only (cmd.exe mangles CJK by code page).
rem Wraps pdf-to-png.ps1 so you do not have to remember the ExecutionPolicy flag.

title PDF to PNG

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0pdf-to-png.ps1" %*
set RC=%ERRORLEVEL%

echo.
if not "%RC%"=="0" (
  echo Failed with exit code %RC%.
) else (
  echo Done. Tell ds-niang the pages are ready.
)
pause
exit /b %RC%
