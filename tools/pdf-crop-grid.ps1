# Render a page's regions as a grid of crops, for reading dense schematics.
#
# WHY A GRID
#   A 400 dpi A4 schematic is 6688x9008 px: too large for a vision model (8192 px
#   per side) and too small once the whole page is scaled down to be read.
#   Splitting the page into a few large tiles keeps the detail that matters.
#   A 2x2 split gives ~3344x4504 per tile - full native resolution, well inside limits.
#
# USAGE
#   powershell -ExecutionPolicy Bypass -File "...\pdf-crop-grid.ps1" ^
#     -Pdf "<pdf>" -Pages "23,24,25" -Out "<dir>"
#
# OPTIONS
#   -Pdf    <path>       source PDF (required)
#   -Pages  <list>       comma-separated page numbers, 1-based (required)
#   -Out    <dir>        output directory (required)
#   -Grid   <n>          n x n tiles per page: 2 (default) or 3 for more detail
#   -Dpi    <n>          render resolution (default 400)
#   -Format <png|jpg>    default png - line art stays crisp and compresses well
#   -Quality <1-100>     JPEG quality, only with -Format jpg

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Pdf,
  [Parameter(Mandatory = $true)][string]$Pages,
  [Parameter(Mandatory = $true)][string]$Out,
  [ValidateRange(2, 3)][int]$Grid = 2,
  [int]$Dpi = 400,
  [ValidateSet('png', 'jpg')][string]$Format = 'png',
  [int]$Quality = 92
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Pdf)) {
  Write-Host "PDF not found: $Pdf" -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

$python = $null
foreach ($cand in @('python', 'py')) {
  try {
    $v = & $cand --version 2>&1
    if ($LASTEXITCODE -eq 0 -and "$v" -match 'Python 3') { $python = $cand; break }
  } catch { }
}
if (-not $python) {
  Write-Host 'No Python 3 found.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

New-Item -ItemType Directory -Force -Path $Out | Out-Null

$pageList = ($Pages -split ',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -match '^\d+$' }
if (-not $pageList) { Write-Host 'No valid page numbers in -Pages.' -ForegroundColor Red; exit 1 }

$pyScript = Join-Path $env:TEMP 'dsh-pdf-grid.py'
$pySource = @'
import sys, os
import fitz

pdf_path, pages_csv, out_dir, grid, dpi, fmt, quality = (
    sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]),
    int(sys.argv[5]), sys.argv[6], int(sys.argv[7]),
)

pages = [int(p) for p in pages_csv.split(',') if p.strip()]
doc = fitz.open(pdf_path)
zoom = dpi / 72.0
ext = 'png' if fmt == 'png' else 'jpg'
step = 100.0 / grid

made = 0
for page_no in pages:
    if page_no < 1 or page_no > doc.page_count:
        print(f"page {page_no}: out of range (1-{doc.page_count}), skipped")
        continue
    page = doc.load_page(page_no - 1)
    r = page.rect
    for row in range(grid):
        for col in range(grid):
            left = col * step
            top = row * step
            clip = fitz.Rect(
                r.x0 + r.width * left / 100.0,
                r.y0 + r.height * top / 100.0,
                r.x0 + r.width * (left + step) / 100.0,
                r.y0 + r.height * (top + step) / 100.0,
            )
            pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csRGB, clip=clip)
            # name says where it sits in the page: r1c1 is top-left
            name = f"p{page_no:03d}-r{row + 1}c{col + 1}.{ext}"
            path = os.path.join(out_dir, name)
            if ext == 'jpg':
                pix.save(path, jpg_quality=quality)
            else:
                pix.save(path)
            kb = os.path.getsize(path) // 1024
            made += 1
            print(f"  {name}  {pix.width}x{pix.height}  {kb} KB")

print(f"\n{made} tiles written to {out_dir}")
'@
Set-Content -LiteralPath $pyScript -Value $pySource -Encoding UTF8

$joined = ($pageList -join ',')
& $python $pyScript $Pdf $joined $Out $Grid $Dpi $Format $Quality

if ($LASTEXITCODE -ne 0) {
  Write-Host 'Grid crop failed.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

Write-Host ''
Write-Host 'Done. Names are page-row-column, e.g. p023-r1c1 = page 23 top-left.' -ForegroundColor Green
