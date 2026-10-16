# Maintainer tool: render the small SVG vocabulary used by our icon with Windows GDI+.
# No downloaded renderer, font, Python, or Node dependency. Build consumes the committed ICO.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$assetDir = Join-Path (Split-Path $PSScriptRoot -Parent) 'assets'
[xml]$svg = Get-Content -LiteralPath (Join-Path $assetDir 'av-report-hub.svg') -Raw
$sizes = @(16,20,24,32,40,48,64,128,256)
$canvas = New-Object Drawing.Bitmap 1024,1024
$graphics = [Drawing.Graphics]::FromImage($canvas)
try {
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.ScaleTransform(4,4)
    $rect = $svg.svg.rect
    [single]$x = $rect.x; [single]$y = $rect.y
    [single]$w = $rect.width; [single]$h = $rect.height; [single]$d = 2 * [single]$rect.rx
    $path = New-Object Drawing.Drawing2D.GraphicsPath
    $path.AddArc($x,$y,$d,$d,180,90)
    $path.AddArc(($x+$w-$d),$y,$d,$d,270,90)
    $path.AddArc(($x+$w-$d),($y+$h-$d),$d,$d,0,90)
    $path.AddArc($x,($y+$h-$d),$d,$d,90,90)
    $path.CloseFigure()
    $stops = $svg.svg.defs.linearGradient.stop
    $brush = New-Object Drawing.Drawing2D.LinearGradientBrush ([Drawing.PointF]::new($x,$y)),([Drawing.PointF]::new(($x+$w),($y+$h))),([Drawing.ColorTranslator]::FromHtml($stops[0].'stop-color')),([Drawing.ColorTranslator]::FromHtml($stops[1].'stop-color'))
    try { $graphics.FillPath($brush,$path) } finally { $brush.Dispose(); $path.Dispose() }
    foreach ($line in $svg.svg.g.polyline) {
        [Drawing.PointF[]]$points = @($line.points.Split(' ') | ForEach-Object {
            $xy = $_.Split(','); [Drawing.PointF]::new([single]$xy[0],[single]$xy[1])
        })
        $pen = New-Object Drawing.Pen ([Drawing.ColorTranslator]::FromHtml($line.stroke)),([single]$line.'stroke-width')
        $pen.StartCap = $pen.EndCap = [Drawing.Drawing2D.LineCap]::Round
        $pen.LineJoin = [Drawing.Drawing2D.LineJoin]::Round
        try { $graphics.DrawLines($pen,$points) } finally { $pen.Dispose() }
    }
    $images = @()
    foreach ($size in $sizes) {
        $bitmap = New-Object Drawing.Bitmap $size,$size
        $scaled = [Drawing.Graphics]::FromImage($bitmap)
        $stream = New-Object IO.MemoryStream
        try {
            $scaled.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $scaled.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $scaled.DrawImage($canvas,0,0,$size,$size)
            $bitmap.Save($stream,[Drawing.Imaging.ImageFormat]::Png)
            $images += ,$stream.ToArray()
            if ($size -eq 256) { $bitmap.Save((Join-Path $assetDir 'av-report-hub.png'),[Drawing.Imaging.ImageFormat]::Png) }
        } finally { $stream.Dispose(); $scaled.Dispose(); $bitmap.Dispose() }
    }
    $file = [IO.File]::Create((Join-Path $assetDir 'av-report-hub.ico'))
    $writer = New-Object IO.BinaryWriter $file
    try {
        $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
        [uint32]$offset = 6 + 16 * $sizes.Count
        for ($i=0; $i -lt $sizes.Count; $i++) {
            [byte]$dimension = $sizes[$i] % 256
            $writer.Write($dimension); $writer.Write($dimension)
            $writer.Write([byte]0); $writer.Write([byte]0)
            $writer.Write([uint16]1); $writer.Write([uint16]32)
            $writer.Write([uint32]$images[$i].Length); $writer.Write($offset)
            $offset += $images[$i].Length
        }
        foreach ($bytes in $images) { $writer.Write([byte[]]$bytes) }
    } finally { $writer.Dispose(); $file.Dispose() }
} finally { $graphics.Dispose(); $canvas.Dispose() }
Write-Host 'Generated AV Report Hub PNG and ICO (16, 20, 24, 32, 40, 48, 64, 128, 256 px).'
