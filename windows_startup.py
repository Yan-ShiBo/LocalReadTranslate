import argparse
import json
import os
import subprocess
import sys
from pathlib import Path


SHORTCUT_NAME = "Local Read & Translate.lnk"
LEGACY_SHORTCUT_NAME = "Kokoro TTS.lnk"

CREATE_SHORTCUT_SCRIPT = r"""
$ErrorActionPreference = 'Stop'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($env:KOKORO_SHORTCUT)
$shortcut.TargetPath = $env:KOKORO_TARGET
$shortcut.WorkingDirectory = $env:KOKORO_WORKDIR
$shortcut.Arguments = $env:KOKORO_ARGUMENTS
$shortcut.Description = 'Local Read & Translate'
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
  arguments = $shortcut.Arguments
} | ConvertTo-Json -Compress
"""


class StartupShortcutError(RuntimeError):
    pass


def _start_menu_programs_dir() -> Path:
    appdata = os.environ.get("APPDATA")
    if not appdata:
        raise StartupShortcutError("APPDATA is not set")
    return (
        Path(appdata)
        / "Microsoft"
        / "Windows"
        / "Start Menu"
        / "Programs"
    )


def startup_shortcut_path(name: str = SHORTCUT_NAME) -> Path:
    return (
        _start_menu_programs_dir()
        / "Startup"
        / name
    )


def start_menu_shortcut_path(name: str = SHORTCUT_NAME) -> Path:
    return _start_menu_programs_dir() / name


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


def _inspect_shortcut(shortcut: Path, runner=run_powershell):
    if not shortcut.exists():
        return None
    try:
        return runner(
            INSPECT_SHORTCUT_SCRIPT,
            {
                "KOKORO_SHORTCUT": str(shortcut),
            },
        )
    except Exception as error:
        raise StartupShortcutError("Unable to inspect Windows shortcut") from error


def _shortcut_matches(
    metadata,
    target: Path,
    workdir: Path,
    arguments: str = "",
) -> bool:
    if not isinstance(metadata, dict):
        return False
    return (
        _resolved(Path(metadata.get("target", ""))) == _resolved(target)
        and _resolved(Path(metadata.get("working_directory", ""))) == _resolved(workdir)
        and str(metadata.get("arguments", "") or "").strip() == str(arguments or "").strip()
    )


def _enable_shortcut(
    shortcut: Path,
    target: Path,
    workdir: Path,
    arguments: str = "",
    runner=run_powershell,
) -> None:
    shortcut.parent.mkdir(parents=True, exist_ok=True)
    try:
        runner(
            CREATE_SHORTCUT_SCRIPT,
            {
                "KOKORO_SHORTCUT": str(shortcut),
                "KOKORO_TARGET": str(_resolved(target)),
                "KOKORO_WORKDIR": str(_resolved(workdir)),
                "KOKORO_ARGUMENTS": str(arguments or ""),
            },
        )
    except Exception as error:
        raise StartupShortcutError("Unable to create Windows shortcut") from error

    if not _shortcut_matches(
        _inspect_shortcut(shortcut, runner),
        target,
        workdir,
        arguments,
    ):
        raise StartupShortcutError("Unable to verify Windows shortcut")


def inspect_startup_shortcut(
    target: Path,
    workdir: Path,
    runner=run_powershell,
    arguments: str = "",
) -> bool:
    return _shortcut_matches(
        _inspect_shortcut(startup_shortcut_path(), runner),
        target,
        workdir,
        arguments,
    )


def enable_startup_shortcut(
    target: Path,
    workdir: Path,
    runner=run_powershell,
    arguments: str = "",
) -> None:
    _enable_shortcut(
        startup_shortcut_path(),
        target,
        workdir,
        arguments,
        runner,
    )


def _shortcut_belongs_to_app(metadata) -> bool:
    if not isinstance(metadata, dict):
        return False
    joined = " ".join(
        str(metadata.get(key, "") or "").replace("/", "\\").lower()
        for key in ("target", "working_directory", "arguments")
    )
    return any(
        marker in joined
        for marker in (
            "tray_app.py",
            "windows_launcher.py",
            "localreadtranslate",
            "local-tts-env",
            "kokoro tts",
        )
    )


def _remove_owned_legacy_shortcut(directory: Path, runner=run_powershell) -> bool:
    legacy = directory / LEGACY_SHORTCUT_NAME
    if not legacy.exists():
        return False
    try:
        metadata = _inspect_shortcut(legacy, runner)
    except StartupShortcutError:
        return False
    if not _shortcut_belongs_to_app(metadata):
        return False
    legacy.unlink()
    return True


def disable_startup_shortcut(target: Path, workdir: Path, runner=run_powershell) -> None:
    del target, workdir
    shortcut = startup_shortcut_path()
    if shortcut.exists():
        shortcut.unlink()
    _remove_owned_legacy_shortcut(shortcut.parent, runner)


def reconcile_startup_shortcut(
    enabled: bool,
    target: Path,
    workdir: Path,
    runner=run_powershell,
    arguments: str = "",
) -> bool:
    if enabled:
        if not inspect_startup_shortcut(target, workdir, runner, arguments):
            enable_startup_shortcut(target, workdir, runner, arguments)
        _remove_owned_legacy_shortcut(startup_shortcut_path().parent, runner)
        return True
    disable_startup_shortcut(target, workdir, runner)
    return False


def inspect_start_menu_shortcut(
    target: Path,
    workdir: Path,
    arguments: str = "",
    runner=run_powershell,
) -> bool:
    return _shortcut_matches(
        _inspect_shortcut(start_menu_shortcut_path(), runner),
        target,
        workdir,
        arguments,
    )


def reconcile_start_menu_shortcut(
    target: Path,
    workdir: Path,
    arguments: str = "",
    runner=run_powershell,
) -> Path:
    shortcut = start_menu_shortcut_path()
    if not inspect_start_menu_shortcut(target, workdir, arguments, runner):
        _enable_shortcut(shortcut, target, workdir, arguments, runner)
    _remove_owned_legacy_shortcut(shortcut.parent, runner)
    return shortcut


def remove_start_menu_shortcut(runner=run_powershell) -> bool:
    changed = False
    shortcut = start_menu_shortcut_path()
    if shortcut.exists():
        shortcut.unlink()
        changed = True
    return _remove_owned_legacy_shortcut(shortcut.parent, runner) or changed


def main(
    argv=None,
    *,
    executable: Path | None = None,
    module_path: Path | None = None,
    stdout=None,
    stderr=None,
) -> int:
    parser = argparse.ArgumentParser(
        description="Install or remove the Local Read & Translate Start Menu shortcut."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    install = subparsers.add_parser("install-menu")
    install.add_argument("--pythonw", type=Path)
    install.add_argument("--launcher", type=Path)
    install.add_argument("--workdir", type=Path)
    subparsers.add_parser("remove-menu")
    args = parser.parse_args(argv)

    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    if os.name != "nt":
        print("Start Menu shortcuts are only available on Windows.", file=stderr)
        return 2

    if args.command == "remove-menu":
        try:
            changed = remove_start_menu_shortcut()
        except Exception as error:
            print(f"Unable to remove Start Menu shortcut: {error}", file=stderr)
            return 1
        print("Start Menu shortcut removed." if changed else "No shortcut found.", file=stdout)
        return 0

    current_python = Path(sys.executable if executable is None else executable)
    current_module = Path(__file__ if module_path is None else module_path)
    pythonw = args.pythonw or current_python.with_name("pythonw.exe")
    launcher = args.launcher or current_module.with_name("windows_launcher.py")
    workdir = args.workdir or current_module.parent
    arguments = f'-E "{launcher}"'
    try:
        shortcut = reconcile_start_menu_shortcut(
            pythonw,
            workdir,
            arguments,
        )
    except Exception as error:
        print(f"Unable to install Start Menu shortcut: {error}", file=stderr)
        return 1
    print(f"Start Menu shortcut installed: {shortcut}", file=stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
