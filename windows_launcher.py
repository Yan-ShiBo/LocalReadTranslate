"""Visible, logged bootstrap for the Local Read & Translate tray application."""

from __future__ import annotations

import importlib
import os
import sys
import traceback
from datetime import datetime, timezone
from pathlib import Path


APP_NAME = "Local Read & Translate"
SCRIPT_DIR = Path(__file__).parent.resolve()
APP_DATA_DIR = Path(os.environ.get("LOCALAPPDATA", SCRIPT_DIR)) / "LocalReadTranslate"
LOG_FILE = APP_DATA_DIR / "launcher.log"


def write_launch_failure(error: BaseException, log_file: Path = LOG_FILE) -> Path:
    """Append a startup traceback and return the resolved diagnostic log path."""
    target = Path(log_file)
    target.parent.mkdir(parents=True, exist_ok=True)
    with open(target, "a", encoding="utf-8") as handle:
        timestamp = datetime.now(timezone.utc).astimezone().isoformat()
        handle.write(f"\n[{timestamp}] {APP_NAME} failed to start\n")
        handle.write(f"Python: {sys.executable}\n")
        handle.write(f"Arguments: {sys.argv!r}\n")
        handle.write(f"Working directory: {os.getcwd()}\n")
        traceback.print_exception(
            type(error),
            error,
            error.__traceback__,
            file=handle,
        )
    return target.resolve(strict=False)


def show_launch_failure(error: BaseException, log_file: Path) -> None:
    """Show an actionable error even when the bootstrap runs under pythonw."""
    message = (
        f"{APP_NAME} failed to start.\n\n"
        f"{type(error).__name__}: {error}\n\n"
        f"Details were written to:\n{log_file}"
    )
    if os.name == "nt":
        try:
            import ctypes

            ctypes.windll.user32.MessageBoxW(0, message, APP_NAME, 0x10)
            return
        except Exception:
            pass
    print(message, file=sys.stderr)


def main(
    argv=None,
    *,
    importer=importlib.import_module,
    failure_writer=write_launch_failure,
    failure_reporter=show_launch_failure,
) -> int:
    """Load the tray only after the isolated interpreter has initialized."""
    args = list(sys.argv[1:] if argv is None else argv)
    try:
        os.chdir(SCRIPT_DIR)
        tray_module = importer("tray_app")
        return int(tray_module.main(args) or 0)
    except Exception as error:
        try:
            log_file = failure_writer(error)
        except Exception:
            log_file = LOG_FILE.resolve(strict=False)
        failure_reporter(error, log_file)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
