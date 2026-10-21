# One-click launcher for the tape recording calculator.
#
# This file is deliberately ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI
# unless the file carries a UTF-8 BOM, so any CJK text here becomes mojibake and
# breaks string terminators - and editors/patch tools drop the BOM silently.
# Chinese UI text lives in README.md and in the web interface instead.

[CmdletBinding()]
param(
  [int]$Port = 7788,
  [switch]$Foreground,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$serverScript = Join-Path $root 'server.mjs'

function Fail($message) {
  Write-Host ''
  Write-Host "[X] $message" -ForegroundColor Red
  Write-Host ''
  Read-Host 'Press Enter to close'
  exit 1
}

function Test-ServerAt([int]$probePort) {
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$probePort/api/state" -TimeoutSec 3 -UseBasicParsing
    if ($response.StatusCode -ne 200) { return $false }
    $data = $response.Content | ConvertFrom-Json
    return [bool]($data.config.tape -and $data.library)
  } catch {
    return $false
  }
}

function Test-PortBusy([int]$probePort) {
  try {
    return [bool](Get-NetTCPConnection -LocalPort $probePort -State Listen -ErrorAction SilentlyContinue)
  } catch {
    return $false
  }
}

# --- 1. is node present? ---------------------------------------------------
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  Fail "node not found. Install Node.js from https://nodejs.org and reopen this window."
}

# Read the version from the executable's file info rather than parsing
# `node --version` output: avoids depending on a child process and on shell shims.
$major = 0
try { $major = [int]([System.Diagnostics.FileVersionInfo]::GetVersionInfo($nodeCmd.Source).FileMajorPart) } catch { $major = 0 }
if ($major -gt 0 -and $major -lt 18) {
  Fail "Node v$major is too old; this needs 18 or newer."
}

# --- 2. pick a port --------------------------------------------------------
if (Test-ServerAt $Port) {
  Write-Host "Already running on port $Port - opening the browser."
  if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$Port" }
  exit 0
}

if (Test-PortBusy $Port) {
  $candidate = $Port
  while ((Test-PortBusy $candidate) -and $candidate -lt ($Port + 5)) { $candidate++ }
  Write-Host "Port $Port is taken by something else; using $candidate instead."
  $Port = $candidate
}

$url = "http://127.0.0.1:$Port"

# --- 3. start the server ---------------------------------------------------
if ($Foreground) {
  Write-Host "Running in the foreground - close this window to stop the server."
  Write-Host "URL: $url"
  Write-Host ''
  if (-not $NoBrowser) {
    Start-Job -ScriptBlock { param($u) Start-Sleep -Seconds 3; Start-Process $u } -ArgumentList $url | Out-Null
  }
  $env:PORT = "$Port"
  & node $serverScript
  exit $LASTEXITCODE
}

# Background mode: the server gets its own visible window, so its output stays
# readable without digging through log files, and closing that window stops it.
$childCommand = @"
`$Host.UI.RawUI.WindowTitle = 'Tape Calc Server  (close this window to stop)'
`$env:PORT = '$Port'
Set-Location -LiteralPath '$root'
node server.mjs
"@

Start-Process -FilePath 'powershell' `
  -ArgumentList @('-NoProfile', '-NoExit', '-Command', $childCommand) `
  -WorkingDirectory $root | Out-Null

Write-Host "Server window opened; waiting until it answers..."

# --- 4. wait for the HTTP endpoint, not just the process -------------------
$ready = $false
for ($i = 0; $i -lt 40; $i++) {
  Start-Sleep -Milliseconds 500
  if (Test-ServerAt $Port) { $ready = $true; break }
}

if (-not $ready) {
  Write-Host ''
  Write-Host "[X] Not responding after 20s - check the server window for errors." -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

# --- 5. done ---------------------------------------------------------------
Write-Host ''
Write-Host "[OK] Ready at $url" -ForegroundColor Green
Write-Host ''
Write-Host "  - The library is scanned in the background; progress shows in the UI."
Write-Host "  - First full scan takes about 20s, later starts are instant (cache)."
Write-Host "  - To stop: close the server window, or run  node tools/stop.mjs"
Write-Host ''

if (-not $NoBrowser) { Start-Process $url }
exit 0
