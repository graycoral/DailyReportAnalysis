$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
New-Item -ItemType Directory -Force dist, cmd/setup/payload | Out-Null
Copy-Item data/catalog.json internal/hub/seed/catalog.json -Force
$env:CGO_ENABLED='0'
go test ./internal/...
if ($LASTEXITCODE -ne 0) { throw 'Tests failed' }
go build -trimpath -ldflags '-s -w -H windowsgui' -o dist/AVReportHub.exe ./cmd/viewer
if ($LASTEXITCODE -ne 0) { throw 'Viewer build failed' }
Copy-Item dist/AVReportHub.exe cmd/setup/payload/AVReportHub.exe -Force
go build -trimpath -ldflags '-s -w -H windowsgui' -o dist/AVReportHub-Setup.exe ./cmd/setup
if ($LASTEXITCODE -ne 0) { throw 'Setup build failed' }
$smokePath = Join-Path ([IO.Path]::GetTempPath()) 'avhub-self-test'
$p = Start-Process -FilePath (Resolve-Path dist/AVReportHub.exe) -ArgumentList @('--self-test', '--data-dir', "`"$smokePath`"") -WindowStyle Hidden -Wait -PassThru
if ($p.ExitCode -ne 0) { throw 'Windows smoke test failed' }
./scripts/smoke.ps1
Copy-Item README.md dist/README.md -Force
Get-FileHash dist/*.exe -Algorithm SHA256 | ForEach-Object { $_.Hash.ToLower() + '  ' + (Split-Path $_.Path -Leaf) } | Set-Content dist/SHA256SUMS.txt
Compress-Archive -Path dist/AVReportHub.exe,dist/AVReportHub-Setup.exe,dist/README.md,dist/SHA256SUMS.txt -DestinationPath dist/AVReportHub-Windows-x64.zip -Force
