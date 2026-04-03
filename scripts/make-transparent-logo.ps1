$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$src = "C:\Users\Jonathan\Documents\My Web Sites\choco-app\assets\logo-cacau-show-whitebg.png"
$dst = "C:\Users\Jonathan\Documents\My Web Sites\choco-app\assets\logo-cacau-show.png"

$bmp = New-Object System.Drawing.Bitmap($src)

$out = New-Object System.Drawing.Bitmap($bmp.Width, $bmp.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$gfx = [System.Drawing.Graphics]::FromImage($out)
$gfx.DrawImage($bmp, 0, 0, $bmp.Width, $bmp.Height)
$gfx.Dispose()
$bmp.Dispose()

# Remove background near-white (keeps logo details)
$threshold = 242
for ($y = 0; $y -lt $out.Height; $y++) {
  for ($x = 0; $x -lt $out.Width; $x++) {
    $c = $out.GetPixel($x, $y)
    if ($c.R -ge $threshold -and $c.G -ge $threshold -and $c.B -ge $threshold) {
      $out.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, $c.R, $c.G, $c.B))
    }
  }
}

$out.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
$out.Dispose()

Write-Host "Saved transparent logo to $dst"

