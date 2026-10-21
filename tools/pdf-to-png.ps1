# Render a scanned PDF's pages to PNG so they can be read as images.
#
# WHY THIS EXISTS
#   The NT-1 service manual is an Internet Archive scan: its text layer uses
#   GlyphLessFont (a placeholder font with no glyphs), so text extraction yields
#   nothing, and the page images are JBIG2 / JPEG2000 which Node cannot decode.
#   Rendering to plain PNG is the only practical way to get at the content.
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as ANSI unless the file
# carries a UTF-8 BOM, and editors silently drop the BOM. Keep it ASCII.
# That is also why no default path is baked in - the manual lives under a folder
# whose name contains CJK characters, which would corrupt the script again.
#
# USAGE (no admin rights needed):
#   powershell -ExecutionPolicy Bypass -File "...\pdf-to-png.ps1" -Pdf "<path to pdf>"
#
# OPTIONS
#   -Pdf     <path>     source PDF (required)
#   -Out     <dir>      output directory
#   -First   <n>        first page, 1-based (default 1)
#   -Last    <n>        last page, 0 = to the end (default 0)
#   -Dpi     <n>        render resolution. Match the scan's native resolution:
#                         140 too low for schematics (you end up zooming to 400%)
#                         300 typical A4 color scan (the NT-1 operating manual)
#                         400 the NT-1 service manual's native scan resolution
#                       Rendering above native only interpolates; below loses detail.
#   -Format  <png|jpg>  png = lossless but big; jpg = far smaller (default jpg)
#   -Quality <1-100>    JPEG quality (default 92)
#   -Gray               force grayscale (smaller; fine for B/W text, wrong for color)

[CmdletBinding()]
param(
  [string]$Pdf = '',
  [string]$Out = '',
  [int]$First = 1,
  [int]$Last = 0,
  [int]$Dpi = 300,
  [ValidateSet('png', 'jpg')]
  [string]$Format = 'jpg',
  [int]$Quality = 92,
  [switch]$Gray
)

$ErrorActionPreference = 'Stop'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not $Pdf) {
  Write-Host 'No -Pdf given. Example:' -ForegroundColor Yellow
  Write-Host '  powershell -ExecutionPolicy Bypass -File "pdf-to-png.ps1" -Pdf "D:\some\manual.pdf"'
  Write-Host ''
  Read-Host 'Press Enter to close'
  exit 1
}

if (-not $Out) { $Out = Join-Path (Split-Path -Parent $scriptDir) '.cache\pdf-pages' }

Write-Host '=== PDF -> PNG ===' -ForegroundColor Cyan
Write-Host "source : $Pdf"
Write-Host "output : $Out"
Write-Host ''

if (-not (Test-Path -LiteralPath $Pdf)) {
  Write-Host "PDF not found: $Pdf" -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

# --- 1. find a usable Python -------------------------------------------------
$python = $null
foreach ($cand in @('python', 'py')) {
  try {
    $v = & $cand --version 2>&1
    if ($LASTEXITCODE -eq 0 -and "$v" -match 'Python 3') {
      $python = $cand
      Write-Host "python : $cand ($v)" -ForegroundColor Green
      break
    }
  } catch { }
}

if (-not $python) {
  Write-Host 'No Python 3 found.' -ForegroundColor Red
  Write-Host 'Install it from https://www.python.org/downloads/ (tick "Add to PATH").'
  Read-Host 'Press Enter to close'
  exit 1
}

# --- 2. make sure PyMuPDF is available ---------------------------------------
Write-Host 'Checking PyMuPDF (the PDF renderer)...'
$hasFitz = $false
try {
  $null = & $python -c "import fitz" 2>&1
  $hasFitz = ($LASTEXITCODE -eq 0)
} catch { }

if (-not $hasFitz) {
  Write-Host 'Not installed - installing PyMuPDF (tens of MB, needs network)...' -ForegroundColor Yellow
  & $python -m pip install --upgrade pip --quiet
  & $python -m pip install PyMuPDF --quiet
  $null = & $python -c "import fitz" 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host 'PyMuPDF install failed. Run this by hand:' -ForegroundColor Red
    Write-Host "  $python -m pip install PyMuPDF"
    Read-Host 'Press Enter to close'
    exit 1
  }
  Write-Host 'installed' -ForegroundColor Green
}

# --- 3. render ----------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $Out | Out-Null

$pyScript = Join-Path $env:TEMP 'dsh-pdf-render.py'
$pySource = @'
import sys, os
import fitz

pdf_path, out_dir, first, last, dpi, fmt, quality, gray = (
    sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]),
    int(sys.argv[5]), sys.argv[6], int(sys.argv[7]), sys.argv[8] == '1',
)

doc = fitz.open(pdf_path)
total = doc.page_count
last = total if last <= 0 else min(last, total)
first = max(1, first)

# Zoom factor from PDF points (1/72 inch) to the requested dpi.
# Output width in pixels ends up = dpi / 72 * page width in points,
# which is the same scale a PDF reader uses when you zoom to 100%.
zoom = dpi / 72.0

cs = fitz.csGRAY if gray else fitz.csRGB
ext = 'png' if fmt == 'png' else 'jpg'
print(f"PDF has {total} pages; rendering {first}-{last} at {dpi} dpi as {ext.upper()}"
      f" ({'gray' if gray else 'color'}, quality {quality})")

done = 0
for i in range(first - 1, last):
    page = doc.load_page(i)
    pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=cs)
    name = f"page-{i + 1:03d}.{ext}"
    out_path = os.path.join(out_dir, name)
    if ext == 'jpg':
        pix.save(out_path, jpg_quality=quality)
    else:
        pix.save(out_path)
    done += 1
    if done % 5 == 0 or done == last - first + 1:
        size_kb = os.path.getsize(out_path) // 1024
        print(f"  {done}/{last - first + 1}  {name}  {pix.width}x{pix.height}  {size_kb} KB")

# How many pages carry real extractable text.
# All zeros confirms a pure image scan with no OCR layer.
texty = sum(1 for i in range(total) if doc.load_page(i).get_text().strip())
print(f"\npages with native text: {texty}/{total}")
print("done")
'@
Set-Content -LiteralPath $pyScript -Value $pySource -Encoding UTF8

$grayArg = if ($Gray) { '1' } else { '0' }
& $python $pyScript $Pdf $Out $First $Last $Dpi $Format $Quality $grayArg

if ($LASTEXITCODE -ne 0) {
  Write-Host 'Render failed - see the error above.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

$pngs = Get-ChildItem -LiteralPath $Out -Filter '*.png'
$sizeMB = [math]::Round((($pngs | Measure-Object Length -Sum).Sum / 1MB), 1)

Write-Host ''
Write-Host "OK: $($pngs.Count) PNG files, $sizeMB MB total" -ForegroundColor Green
Write-Host "at : $Out"
Write-Host ''
Write-Host 'Now tell ds-niang the pages are ready.' -ForegroundColor Cyan
