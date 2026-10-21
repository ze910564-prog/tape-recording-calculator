@echo off
rem Double-click entry: renders the attached NT-1 manual to PNG.
rem ASCII-only (cmd.exe mangles CJK by code page). The PDF path is built by
rem PowerShell at runtime, so the CJK folder name never lands inside this file.

title Render manual to PNG

set SCRIPT=%~dp0pdf-to-png.ps1

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p = Join-Path $env:USERPROFILE '.dsh\attachments\v1\files\ee\ee9a523d340f6b58b0f11bd46b6a8365d119f634134088a955b5b8ac7039a42a\nt1维修手册.pdf'; & '%SCRIPT%' -Pdf $p"

echo.
echo Done.
pause
