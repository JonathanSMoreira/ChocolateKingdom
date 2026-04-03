$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$assetDir = Join-Path $PSScriptRoot "..\assets" | Resolve-Path
$bgPath = Join-Path $assetDir "bg-splash-only.png"
$iconPath = Join-Path $assetDir "icon-amusement-cs.png"
$outPath = Join-Path $assetDir "splash-native-composite.png"

$bg = [System.Drawing.Bitmap]::FromFile($bgPath)
$icon = [System.Drawing.Bitmap]::FromFile($iconPath)

$w = $bg.Width
$h = $bg.Height

# Mesma lógica do App.tsx: splashAppIconSize = min(168, round(screenWidth * 0.42)) em dp.
# Referência ~390dp de largura para o ícone não ficar enorme em telas largas.
$refW = 390
$iconDp = [math]::Min(168, [math]::Round($refW * 0.42))
$iconSide = [int][math]::Max(1, [math]::Round($iconDp * $w / $refW))

$canvas = New-Object System.Drawing.Bitmap($w, $h)
$g = [System.Drawing.Graphics]::FromImage($canvas)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality

$g.DrawImage($bg, 0, 0, $w, $h)

$x = [int](($w - $iconSide) / 2)
$y = [int](($h - $iconSide) / 2)
$g.DrawImage($icon, $x, $y, $iconSide, $iconSide)

$g.Dispose()
$bg.Dispose()
$icon.Dispose()

$canvas.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$canvas.Dispose()

Write-Host "OK: $outPath (${w}x${h}, icon ${iconSide}px)"
