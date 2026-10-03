Add-Type -AssemblyName System.Drawing
$frameFolder = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../out/timeline'))
$frames = Get-ChildItem -LiteralPath $frameFolder -Filter '*.png' | Sort-Object Name
$page = 0
for ($offset=0; $offset -lt $frames.Count; $offset+=18) {
  $canvas = New-Object Drawing.Bitmap 1440,1740
  $graphics = [Drawing.Graphics]::FromImage($canvas)
  $graphics.Clear([Drawing.Color]::FromArgb(15,17,23))
  $font = New-Object Drawing.Font 'Arial',16
  for ($cell=0; $cell -lt 18 -and ($offset+$cell) -lt $frames.Count; $cell++) {
    $asset = [Drawing.Image]::FromFile($frames[$offset+$cell].FullName)
    $x = ($cell % 3)*480
    $y = [Math]::Floor($cell/3)*290
    $graphics.DrawImage($asset,$x,$y,480,270)
    $graphics.DrawString("$($offset+$cell)s",$font,[Drawing.Brushes]::White,$x+8,$y+268)
    $asset.Dispose()
  }
  $canvas.Save((Join-Path $frameFolder "contact-$page.png"),[Drawing.Imaging.ImageFormat]::Png)
  $graphics.Dispose(); $font.Dispose(); $canvas.Dispose()
  $page++
}
