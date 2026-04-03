$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$assetDir = "C:\Users\Jonathan\Documents\My Web Sites\choco-app\assets"
$files = @(
  "mapa-parque.png",
  "lojas-bg.png",
  "atracoes-bg.png",
  "icon-amusement-cs.png",
  "bg-splash-only.png",
  "favicon.png"
)

foreach ($name in $files) {
  $full = Join-Path $assetDir $name
  $fixed = Join-Path $assetDir ($name + ".fixed.png")

  Write-Host "Fixing $name ..."
  try {
    $img = New-Object System.Drawing.Bitmap($full)
    $w = $img.Width
    $h = $img.Height

    # Re-encode into a standard RGBA PNG
    $img.Save($fixed, [System.Drawing.Imaging.ImageFormat]::Png)
    $img.Dispose()

    # Replace original only if re-encode succeeded
    Copy-Item -Force $fixed $full
    Remove-Item -Force $fixed

    Write-Host "  OK ${w}x${h}"
  } catch {
    Write-Host "  FAIL: $($_.Exception.Message)"
    if (Test-Path $fixed) { Remove-Item -Force $fixed }
  }
}

