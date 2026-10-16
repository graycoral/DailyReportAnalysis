# Run in the Windows account that owns AV Report Hub. No administrator shell required.
[CmdletBinding()]
param([switch]$SkipRagSetup)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repoRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$toolsRoot = Join-Path $repoRoot 'build\tools'
$appData = Join-Path $env:LOCALAPPDATA 'AVReportHub'
$target = Join-Path $appData 'bin\AVReportHub.exe'
New-Item -ItemType Directory -Force $toolsRoot | Out-Null

function Get-Download([string]$Uri, [string]$Destination) {
    Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination -TimeoutSec 600
}
function Connect-Viewer {
    $file = Join-Path $appData 'instance-viewer.json'
    if (!(Test-Path -LiteralPath $file)) { return $null }
    $instance = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
    $uri = [Uri]$instance.address
    if ($uri.Scheme -ne 'http' -or $uri.Host -ne '127.0.0.1' -or $instance.key -notmatch '^[a-f0-9]{64}$') {
        throw 'Invalid local app connection file.'
    }
    $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    $session.Cookies.Add($uri, (New-Object Net.Cookie('av_session', $instance.key, '/')))
    try {
        $null = Invoke-RestMethod -Uri "$($instance.address)/api/ping" -WebSession $session -TimeoutSec 3
        return @{ address=$instance.address; key=$instance.key; session=$session }
    } catch { return $null }
}
function Invoke-AppPost($Connection, [string]$Path) {
    Invoke-RestMethod -Uri ($Connection.address + $Path) -Method Post -WebSession $Connection.session -Headers @{
        Origin=$Connection.address; 'X-AV-Request'='1'
    } -ContentType 'application/json' -Body '{}' -TimeoutSec 30
}
function Wait-RagEnvironment($Connection) {
    $deadline = [DateTime]::UtcNow.AddMinutes(90)
    $previous = ''
    do {
        $state = Invoke-RestMethod -Uri ($Connection.address + '/api/rag/environment') -WebSession $Connection.session -TimeoutSec 15
        if ($state.message -ne $previous) { Write-Host $state.message; $previous=$state.message }
        if (!$state.busy) { return $state }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Environment setup is taking longer than expected. Check the multimodal tab.'
}
function Find-Python310 {
    $paths = @(
        (Join-Path $appData 'rag\runtime\.venv\Scripts\python.exe'),
        (Join-Path $env:LOCALAPPDATA 'Programs\Python\Python310\python.exe'),
        (Join-Path $env:ProgramFiles 'Python310\python.exe')
    )
    $launcher = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($launcher) {
        try {
            $found = & $launcher.Source -3.10 -c 'import sys; print(sys.executable)' 2>$null
            if ($LASTEXITCODE -eq 0 -and $found) { $paths += "$found" }
        } catch { # The launcher may be installed without Python 3.10.
        }
    }
    foreach ($candidate in $paths) {
        if (!(Test-Path -LiteralPath $candidate)) { continue }
        try {
            & $candidate -c "import sys,struct; assert sys.version_info[:2]==(3,10) and struct.calcsize('P')==8; assert 'conda' not in sys.base_prefix.lower()" 2>$null
            if ($LASTEXITCODE -eq 0) { return $candidate }
        } catch { # Continue looking for a compatible installation.
        }
    }
    return $null
}

Push-Location $repoRoot
try {
    Write-Host '[1/5] Preparing Go 1.27.2 (same version as Windows CI)...'
    $goRoot = Join-Path $toolsRoot 'go-1.27.2\go'
    $goExe = Join-Path $goRoot 'bin\go.exe'
    if (!(Test-Path -LiteralPath $goExe)) {
        $archive = Join-Path $toolsRoot 'go1.27.2.windows-amd64.zip'
        Get-Download 'https://go.dev/dl/go1.27.2.windows-amd64.zip' $archive
        # Published SHA256: https://go.dev/dl/#go1.27.2
        $expected = '1314008898bd40df77af4b014f777f08873dbdfbcd3d92308728ee03304fe04f'
        if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) {
            throw 'Go download checksum mismatch.'
        }
        Expand-Archive -LiteralPath $archive -DestinationPath (Split-Path $goRoot -Parent) -Force
    }
    $env:GOROOT = $goRoot
    $env:PATH = (Join-Path $goRoot 'bin') + ';' + $env:PATH
    $env:GOCACHE = Join-Path $toolsRoot 'go-cache'
    $env:GOTOOLCHAIN = 'local'
    & $goExe version
    if ($LASTEXITCODE -ne 0) { throw 'Go could not start.' }

    Write-Host '[2/5] Preparing Python 3.10 x64 for the optional search feature...'
    $python = Find-Python310
    if (!$python) {
        $installer = Join-Path $toolsRoot 'python-3.10.11-amd64.exe'
        Get-Download 'https://www.python.org/ftp/python/3.10.11/python-3.10.11-amd64.exe' $installer
        $signature = Get-AuthenticodeSignature -LiteralPath $installer
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'CN=Python Software Foundation(,|$)') {
            throw 'Python installer signature verification failed.'
        }
        $pythonDir = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python310'
        $options = @('/quiet','InstallAllUsers=0','Include_launcher=1','InstallLauncherAllUsers=0','Include_test=0','PrependPath=0','Shortcuts=0',('TargetDir="' + $pythonDir + '"'))
        $installation = Start-Process -FilePath $installer -ArgumentList $options -WindowStyle Hidden -Wait -PassThru
        if ($installation.ExitCode -notin @(0,3010)) { throw "Python installation failed: exit $($installation.ExitCode)" }
        $python = Find-Python310
        if (!$python) { throw 'Python 3.10 verification failed after installation.' }
    }

    Write-Host '[3/5] Testing and building Windows executables...'
    & (Join-Path $goRoot 'bin\gofmt.exe') -w internal/hub/rag_setup.go internal/hub/rag_setup_test.go rag/assets.go internal/hub/app.go
    if ($LASTEXITCODE -ne 0) { throw 'Go formatting failed.' }
    node --check internal/hub/web/app.js
    if ($LASTEXITCODE -ne 0) { throw 'JavaScript syntax check failed.' }
    node scripts/check-catalog-ui.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Catalog visibility UI tests failed' }
    node scripts/check-rag-ui.cjs
    if ($LASTEXITCODE -ne 0) { throw 'UI regression tests failed.' }
    node scripts/check-outlook-ui.cjs
    if ($LASTEXITCODE -ne 0) { throw 'Outlook path UI tests failed.' }
    & (Join-Path $PSScriptRoot 'build.ps1')

    Write-Host '[4/5] Replacing the installed viewer after successful tests...'
    $old = Connect-Viewer
    if ($old) { $null = Invoke-AppPost $old '/api/exit' }
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        $running = @(Get-Process AVReportHub -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $target })
        if ($running.Count -eq 0) { break }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($running.Count -gt 0) { throw 'The existing viewer has not exited. Close AV Report Hub and run this script again.' }
    New-Item -ItemType Directory -Force (Split-Path $target -Parent) | Out-Null
    $backup = $target + '.previous'
    $hadPrevious = Test-Path -LiteralPath $target
    if ($hadPrevious) { Copy-Item -LiteralPath $target -Destination $backup -Force }
    $launched = $null
    try {
        Copy-Item -LiteralPath (Join-Path $repoRoot 'dist\AVReportHub.exe') -Destination $target -Force
        $launched = Start-Process -FilePath $target -ArgumentList @('--no-browser','--data-dir',('"' + $appData + '"')) -WindowStyle Hidden -PassThru
        $connection = $null
        for ($i=0; $i -lt 80; $i++) {
            if ($launched.HasExited) { break }
            $connection = Connect-Viewer
            if ($connection) { break }
            Start-Sleep -Milliseconds 250
        }
        if (!$connection) { throw 'The rebuilt viewer did not start.' }
        $null = Invoke-RestMethod -Uri ($connection.address + '/api/rag/environment') -WebSession $connection.session -TimeoutSec 15
    } catch {
        if ($launched -and !$launched.HasExited) { Stop-Process -Id $launched.Id; $launched.WaitForExit() }
        if ($hadPrevious) {
            Copy-Item -LiteralPath $backup -Destination $target -Force
            Start-Process -FilePath $target -WindowStyle Hidden
        }
        throw
    }
    # The user requested the app to be reopened; show its multimodal tab.
    Start-Process ($connection.address + '/open?key=' + $connection.key + '#rag')

    Write-Host '[5/5] Preparing and starting multimodal search...'
    if (!$SkipRagSetup) {
        $environment = Wait-RagEnvironment $connection
        if (!$environment.ready) {
            $null = Invoke-AppPost $connection '/api/rag/setup'
            $environment = Wait-RagEnvironment $connection
        }
        if (!$environment.ready) { throw 'App rebuilt and reopened, but search setup failed. See the multimodal tab for details.' }
        $null = Invoke-AppPost $connection '/api/rag/start'
        $environment = Wait-RagEnvironment $connection
        $status = Invoke-RestMethod -Uri ($connection.address + '/api/rag/status') -WebSession $connection.session -TimeoutSec 15
        if (!$status.ok) { throw 'App rebuilt and reopened, but search service did not become ready.' }
    }
    Write-Host 'Completed: tools installed, tests passed, app rebuilt and reopened.'
} finally {
    Pop-Location
}
