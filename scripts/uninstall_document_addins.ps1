[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$ProjectDirectory = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$OfficeAddinId = "74d95f3f-f8d0-4a33-95d8-2f0b637df535"
$OfficeDeveloperKey = "HKCU:\Software\Microsoft\Office\16.0\WEF\Developer"
$WpsPublishPath = Join-Path $env:APPDATA "kingsoft\wps\jsaddons\publish.xml"
$RegistrationScript = Join-Path $ProjectDirectory "addin_registration.py"
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
    throw "Python was not found."
}

if (Test-Path $OfficeDeveloperKey) {
    $Property = Get-ItemProperty `
        -Path $OfficeDeveloperKey `
        -Name $OfficeAddinId `
        -ErrorAction SilentlyContinue
    if ($Property) {
        Remove-ItemProperty -Path $OfficeDeveloperKey -Name $OfficeAddinId
        Write-Host "[OK] Removed the exact Microsoft Word add-in registration."
    }
    $OfficeSubkey = Join-Path $OfficeDeveloperKey $OfficeAddinId
    if (Test-Path $OfficeSubkey) {
        Remove-Item -LiteralPath $OfficeSubkey
    }
}

$PythonPath = Find-ProjectPython
& $PythonPath $RegistrationScript uninstall-wps --path $WpsPublishPath
if ($LASTEXITCODE -ne 0) {
    throw "WPS add-in unregistration failed."
}

if (Test-Path -LiteralPath $StandalonePidPath -PathType Leaf) {
    $RecordedPid = 0
    [void][int]::TryParse(
        (Get-Content -LiteralPath $StandalonePidPath -Raw).Trim(),
        [ref]$RecordedPid
    )
    if ($RecordedPid -gt 0) {
        $Process = Get-Process -Id $RecordedPid -ErrorAction SilentlyContinue
        $Command = Get-CimInstance Win32_Process -Filter "ProcessId = $RecordedPid" `
            -ErrorAction SilentlyContinue
        if (
            $Process -and
            $Command -and
            $Command.CommandLine -like "*addon_host.py*" -and
            $Command.CommandLine -like "*$ProjectDirectory*"
        ) {
            Stop-Process -Id $RecordedPid
            Write-Host "[OK] Stopped the installer-owned add-in host."
        }
    }
    Remove-Item -LiteralPath $StandalonePidPath
}

Write-Host ""
Write-Host "Document add-in registrations were removed."
Write-Host "Close and reopen Word/WPS to refresh their add-in lists."
