$ErrorActionPreference='Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('avhub-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force $testRoot | Out-Null
$setup=$null; $viewer=$null
function Connect-App($kind) {
    $file=Join-Path $testRoot "instance-$kind.json"
    for($i=0;$i -lt 60 -and !(Test-Path $file);$i++){ Start-Sleep -Milliseconds 250 }
    if(!(Test-Path $file)){ throw "$kind did not start" }
    $instance=Get-Content $file -Raw | ConvertFrom-Json
    $session=[Microsoft.PowerShell.Commands.WebRequestSession]::new()
    $null=Invoke-WebRequest -Uri "$($instance.address)/open?key=$($instance.key)" -WebSession $session
    return @{address=$instance.address; session=$session}
}
try {
    $setup=Start-Process -FilePath (Resolve-Path dist/AVReportHub-Setup.exe) -ArgumentList @('--no-browser','--data-dir',"`"$testRoot`"") -PassThru
    $s=Connect-App 'setup'
    $settings=@{ owner='graycoral'; repo='DailyReportAnalysis'; branch='main'; sync_time='08:00'; offline=$true; automatic=$true; token='' } | ConvertTo-Json
    $result=Invoke-RestMethod -Uri "$($s.address)/api/install" -Method Post -WebSession $s.session -Headers @{Origin=$s.address; 'X-AV-Request'='1'} -ContentType 'application/json' -Body $settings
    if(!$result.ok){ throw 'Setup failed' }
    $exe=Join-Path $testRoot 'bin/AVReportHub.exe'
    if(!(Test-Path $exe)){ throw 'Installed EXE missing' }
    $null=Invoke-RestMethod -Uri "$($s.address)/api/exit" -Method Post -WebSession $s.session -Headers @{Origin=$s.address; 'X-AV-Request'='1'} -Body '{}'
    $viewer=Start-Process -FilePath $exe -ArgumentList @('--no-browser','--data-dir',"`"$testRoot`"") -PassThru
    $v=Connect-App 'viewer'
    $state=Invoke-RestMethod -Uri "$($v.address)/api/state" -WebSession $v.session
    if(!$state.config.configured -or $state.snapshot.catalog.reports.Count -lt 1){ throw 'Viewer has no configured reports' }
    if($state.snapshot.catalog.database -and !(Test-Path (Join-Path $testRoot ('databases/' + $state.snapshot.catalog.database.sha256 + '.sqlite')))){throw 'SQLite missing'}
    $dest=Join-Path $testRoot 'attachment.md'
    Invoke-WebRequest -Uri "$($v.address)/api/download?id=2026-10-14&index=0" -WebSession $v.session -OutFile $dest
    $hash=(Get-FileHash $dest -Algorithm SHA256).Hash.ToLower()
    if($hash -ne $state.snapshot.catalog.reports[0].attachments[0].sha256){ throw 'Attachment mismatch' }
    $null=Invoke-RestMethod -Uri "$($v.address)/api/exit" -Method Post -WebSession $v.session -Headers @{Origin=$v.address; 'X-AV-Request'='1'} -Body '{}'
    Write-Host 'Windows setup, install, viewer, and attachment smoke test passed.'
} finally {
    foreach($p in @($setup,$viewer)){if($null -ne $p -and !$p.HasExited){Stop-Process -Id $p.Id -ErrorAction SilentlyContinue}}
    Remove-Item $testRoot -Recurse -Force -ErrorAction SilentlyContinue
}
