# Crop regions out of a scanned PDF page and render them at a chosen dpi.
#
# WHY
#   A 400 dpi A4 schematic page renders to 6688x9008 px, which exceeds what a
#   vision model will accept (8192 px per side). Feeding the whole page also
#   wastes resolution: the interesting parts end up a few hundred px wide.
#   Cropping the region of interest is what actually makes a schematic readable.
#
# USAGE
#   powershell -ExecutionPolicy Bypass -File "...\pdf-crop.ps1" ^
#     -Pdf "<pdf>" -Page 23 -Left 0 -Top 0 -Right 50 -Bottom 50 -Out "<dir>"
#
#   -Left/-Top/-Right/-Bottom are PERCENTAGES of the page (0-100), so you can
#   eyeball a region in any PDF viewer and pass roughly what you see.
#
# OPTIONS
#   -Pdf      <path>    source PDF (required)
#   -Page     <n>       page number, 1-based (required)
#   -Out      <dir>     output directory
#   -Left/-Top/-Right/-Bottom <0-100>   region, defaults to the whole page
#   -Dpi      <n>       render resolution (default: 400, the scan's native)
#   -Format   <png|jpg> default png (line art compresses well and stays sharp)
#   -Quality  <1-100>   JPEG quality, only used with -Format jpg
#   -Name     <string>  output file name without extension

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Pdf,
  [Parameter(Mandatory = $true)][int]$Page,
  [Parameter(Mandatory = $true)][string]$Out,
  [double]$Left = 0,
  [double]$Top = 0,
  [double]$Right = 100,
  [double]$Bottom = 100,
  [int]$Dpi = 400,
  [ValidateSet('png', 'jpg')][string]$Format = 'png',
  [int]$Quality = 92,
  [string]$Name = ''
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Pdf)) {
  Write-Host "PDF not found: $Pdf" -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

if ($Left -ge $Right -or $Top -ge $Bottom) {
  Write-Host 'Invalid region: need Left < Right and Top < Bottom.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

# --- find python --------------------------------------------------------------
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

# --- render the crop ----------------------------------------------------------
New-Item -ItemType Directory -Force -Path $Out | Out-Null
if (-not $Name) { $Name = "p$Page-$([int]$Left)-$([int]$Top)-$([int]$Right)-$([int]$Bottom)" }

$pyScript = Join-Path $env:TEMP 'dsh-pdf-crop.py'
$pySource = @'
import sys, os
import fitz

(pdf_path, page_no, out_dir, left, top, right, bottom, dpi, fmt, quality, name) = (
    sys.argv[1], int(sys.argv[2]), sys.argv[3],
    float(sys.argv[4]), float(sys.argv[5]), float(sys.argv[6]), float(sys.argv[7]),
    int(sys.argv[8]), sys.argv[9], int(sys.argv[10]), sys.argv[11],
)

doc = fitz.open(pdf_path)
if page_no < 1 or page_no > doc.page_count:
    print(f"page {page_no} out of range (1-{doc.page_count})")
    sys.exit(1)

page = doc.load_page(page_no - 1)
rect = page.rect

# Percentage region -> PDF rectangle
clip = fitz.Rect(
    rect.x0 + rect.width * left / 100.0,
    rect.y0 + rect.height * top / 100.0,
    rect.x0 + rect.width * right / 100.0,
    rect.y0 + rect.height * bottom / 100.0,
)

zoom = dpi / 72.0
pix = page.get_pixmap(matrix=fitz.Matrix(zoom, zoom), colorspace=fitz.csRGB, clip=clip)

ext = 'png' if fmt == 'png' else 'jpg'
out_path = os.path.join(out_dir, f"{name}.{ext}")
if ext == 'jpg':
    pix.save(out_path, jpg_quality=quality)
else:
    pix.save(out_path)

kb = os.path.getsize(out_path) // 1024
print(f"page {page_no}  region L{left:.0f}% T{top:.0f}% R{right:.0f}% B{bottom:.0f}%")
print(f"  -> {out_path}")
print(f"  {pix.width}x{pix.height} px  {kb} KB")

# Warn when the result would exceed what a vision model accepts.
if max(pix.width, pix.height) > 8192:
    print("  NOTE: over 8192 px on a side - models may refuse this image.")
    print("        Either lower -Dpi or crop a smaller region.")
'@
Set-Content -LiteralPath $pyScript -Value $pySource -Encoding UTF8

& $python $pyScript $Pdf $Page $Out $Left $Top $Right $Bottom $Dpi $Format $Quality $Name

if ($LASTEXITCODE -ne 0) {
  Write-Host 'Crop failed.' -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}

Write-Host ''
Write-Host 'Done.' -ForegroundColor Green
