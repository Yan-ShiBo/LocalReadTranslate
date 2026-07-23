[CmdletBinding()]
param(
    [switch]$OfficeOnly,
    [switch]$WpsOnly,
    [switch]$NoStart
)

$ErrorActionPreference = "Stop"

if ($OfficeOnly -and $WpsOnly) {
    throw "OfficeOnly and WpsOnly cannot be used together."
}

$ProjectDirectory = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$OfficeManifest = Join-Path $ProjectDirectory "addons\office-word\manifest.xml"
$RegistrationScript = Join-Path $ProjectDirectory "addin_registration.py"
$HostScript = Join-Path $ProjectDirectory "addon_host.py"
$OfficeAddinId = "74d95f3f-f8d0-4a33-95d8-2f0b637df535"
$OfficeDeveloperKey = "HKCU:\Software\Microsoft\Office\16.0\WEF\Developer"
$WpsPublishPath = Join-Path $env:APPDATA "kingsoft\wps\jsaddons\publish.xml"
$StandalonePidPath = Join-Path $env:LOCALAPPDATA "LocalReadTranslate\addin-host-standalone.pid"

function Find-ProjectPython {
    $UserProfilePath = [Environment]::GetFolderPath("UserProfile")
    $Candidates = @(
        (Join-Path $UserProfilePath ".conda\envs\kokoro-tts\python.exe"),
        (Join-Path $UserProfilePath "anaconda3\envs\kokoro-tts\python.exe"),
        (Join-Path $UserProfilePath "miniconda3\envs\kokoro-tts\python.exe"),
        (Join-Path $env:ProgramData "anaconda3\envs\kokoro-tts\python.exe"),
        (Join-Path $env:ProgramData "miniconda3\envs\kokoro-tts\python.exe")
    )
    foreach ($Candidate in $Candidates) {
        if (Test-Path -LiteralPath $Candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $Candidate).Path
        }
    }
    $Discovered = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($Discovered) {
        return $Discovered.Source
    }
    throw "The kokoro-tts Python environment was not found. Run setup.bat first."
}

function Test-AddinHost {
    try {
        $Health = Invoke-RestMethod `
            -Uri "http://localhost:5443/health" `
            -TimeoutSec 2 `
            -UseBasicParsing
        return (
            $Health.service -eq "localreadtranslate-addin-host" -and
            $Health.ready -eq $true
        )
    } catch {
        return $false
    }
}

$InstallOffice = -not $WpsOnly
$InstallWps = -not $OfficeOnly
$PythonPath = Find-ProjectPython

if ($InstallOffice) {
    if (-not (Test-Path -LiteralPath $OfficeManifest -PathType Leaf)) {
        throw "Office manifest is missing: $OfficeManifest"
    }
    New-Item -Path $OfficeDeveloperKey -Force | Out-Null
    New-ItemProperty `
        -Path $OfficeDeveloperKey `
        -Name $OfficeAddinId `
        -Value $OfficeManifest `
        -PropertyType String `
        -Force | Out-Null
    Write-Host "[OK] Registered the Microsoft Word task-pane manifest."
}

if ($InstallWps) {
    if (Test-Path -LiteralPath $WpsPublishPath -PathType Leaf) {
        $Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
        $BackupPath = "$WpsPublishPath.localreadtranslate-$Timestamp.bak"
        Copy-Item -LiteralPath $WpsPublishPath -Destination $BackupPath
        Write-Host "[OK] Backed up the existing WPS publish.xml to $BackupPath"
    }
    & $PythonPath $RegistrationScript install-wps --path $WpsPublishPath
    if ($LASTEXITCODE -ne 0) {
        throw "WPS add-in registration failed."
    }
}

if (-not $NoStart -and -not (Test-AddinHost)) {
    $PythonwPath = Join-Path (Split-Path $PythonPath -Parent) "pythonw.exe"
    if (-not (Test-Path -LiteralPath $PythonwPath -PathType Leaf)) {
        $PythonwPath = $PythonPath
    }
    $Process = Start-Process `
        -FilePath $PythonwPath `
        -ArgumentList @("""$HostScript""") `
        -WorkingDirectory $ProjectDirectory `
        -WindowStyle Hidden `
        -PassThru
    $PidDirectory = Split-Path $StandalonePidPath -Parent
    New-Item -ItemType Directory -Path $PidDirectory -Force | Out-Null
    Set-Content -LiteralPath $StandalonePidPath -Value $Process.Id -Encoding ascii
    $Ready = $false
    foreach ($Attempt in 1..30) {
        Start-Sleep -Milliseconds 200
        if (Test-AddinHost) {
            $Ready = $true
            break
        }
        if ($Process.HasExited) {
            break
        }
    }
    if (-not $Ready) {
        throw "The add-in loopback host did not become ready on port 5443."
    }
    Write-Host "[OK] Started the local loopback add-in host (PID $($Process.Id))."
} elseif (-not $NoStart) {
    Write-Host "[OK] The local loopback add-in host is already running."
}

$RunningHosts = Get-Process -Name WINWORD, wps -ErrorAction SilentlyContinue
if ($RunningHosts) {
    Write-Warning "Word/WPS is already open. Close and reopen it once to load the new registration."
}

Write-Host ""
Write-Host "Document add-in installation completed."
Write-Host "Microsoft Word: Home > Add-ins > LocalReadTranslate Formula Workbench"
Write-Host "WPS Writer: LocalReadTranslate > LaTeX Formula"
