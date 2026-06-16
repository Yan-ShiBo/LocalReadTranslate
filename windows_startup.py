import json
import os
import subprocess
from pathlib import Path


SHORTCUT_NAME = "Kokoro TTS.lnk"

CREATE_SHORTCUT_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($env:KOKORO_SHORTCUT)
$shortcut.TargetPath = $env:KOKORO_TARGET
$shortcut.WorkingDirectory = $env:KOKORO_WORKDIR
$shortcut.IconLocation = $env:KOKORO_TARGET
$shortcut.Save()
"""

INSPECT_SHORTCUT_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($env:KOKORO_SHORTCUT)
[pscustomobject]@{
  target = $shortcut.TargetPath
  working_directory = $shortcut.WorkingDirectory
} | ConvertTo-Json -Compress
"""


class StartupShortcutError(RuntimeError):
    pass


def startup_shortcut_path() -> Path:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise StartupShortcutError("APPDATA is not set")
    return (
        Path(appdata)
        / "Microsoft"
        / "Windows"
        / "Start Menu"
        / "Programs"
        / "Startup"
        / SHORTCUT_NAME
    )


def run_powershell(script: str, env_vars: dict[str, str]):
    env = os.environ.copy()
    env.update(env_vars)
    try:
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script,
            ],
            capture_output=True,
            text=True,
            timeout=15,
            env=env,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise StartupShortcutError("Unable to run PowerShell") from error

    if result.returncode != 0:
        message = result.stderr.strip() or result.stdout.strip()
        raise StartupShortcutError(message or "PowerShell shortcut command failed")

    output = result.stdout.strip()
    if not output:
        return None
    try:
        return json.loads(output)
    except json.JSONDecodeError as error:
        raise StartupShortcutError("PowerShell returned invalid shortcut metadata") from error


def _resolved(path: Path) -> Path:
    return Path(path).resolve(strict=False)


def inspect_startup_shortcut(target: Path, workdir: Path, runner=run_powershell) -> bool:
    shortcut = startup_shortcut_path()
    if not shortcut.exists():
        return False
    try:
        metadata = runner(
            INSPECT_SHORTCUT_SCRIPT,
            {
                "KOKORO_SHORTCUT": str(shortcut),
            },
        )
    except Exception as error:
        raise StartupShortcutError("Unable to inspect login auto-start shortcut") from error

    if not isinstance(metadata, dict):
        return False
    return (
        _resolved(Path(metadata.get("target", ""))) == _resolved(target)
        and _resolved(Path(metadata.get("working_directory", ""))) == _resolved(workdir)
    )


def enable_startup_shortcut(target: Path, workdir: Path, runner=run_powershell) -> None:
    shortcut = startup_shortcut_path()
    shortcut.parent.mkdir(parents=True, exist_ok=True)
    try:
        runner(
            CREATE_SHORTCUT_SCRIPT,
            {
                "KOKORO_SHORTCUT": str(shortcut),
                "KOKORO_TARGET": str(_resolved(target)),
                "KOKORO_WORKDIR": str(_resolved(workdir)),
            },
        )
    except Exception as error:
        raise StartupShortcutError("Unable to enable login auto-start") from error

    if not inspect_startup_shortcut(target, workdir, runner):
        raise StartupShortcutError("Unable to verify login auto-start shortcut")


def disable_startup_shortcut(target: Path, workdir: Path, runner=run_powershell) -> None:
    del target, workdir, runner
    shortcut = startup_shortcut_path()
    if shortcut.exists():
        shortcut.unlink()


def reconcile_startup_shortcut(
    enabled: bool,
    target: Path,
    workdir: Path,
    runner=run_powershell,
) -> bool:
    if enabled:
        if not inspect_startup_shortcut(target, workdir, runner):
            enable_startup_shortcut(target, workdir, runner)
        return True
    disable_startup_shortcut(target, workdir, runner)
    return False
