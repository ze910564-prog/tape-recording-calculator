@echo off
rem Entry point for double-clicking. Keep this file ASCII-only, filename included:
rem cmd.exe mis-parses CJK text and CJK paths depending on the active code page.
rem All real logic (and all Chinese output) lives in start.ps1.

title Tape Recording Calculator

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*

if errorlevel 1 (
  echo.
  echo Startup failed. See the messages above.
  pause
)

exit /b %ERRORLEVEL%
