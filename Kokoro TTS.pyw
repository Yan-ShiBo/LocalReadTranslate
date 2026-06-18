"""Launcher for Kokoro TTS tray app (no console window)."""
import json
import subprocess
import tkinter.messagebox
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent.resolve()
TRAY_SCRIPT = SCRIPT_DIR / "tray_app.py"
CONDA_ENV_NAME = "kokoro-tts"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def _python_from_env_path(env_path):
    """Return a GUI-friendly Python executable from a conda env path."""
    env_path = Path(env_path)
    for exe_name in ("pythonw.exe", "python.exe"):
        exe = env_path / exe_name
        if exe.exists():
            return str(exe)
    return None


def _common_env_paths():
    home = Path.home()
    for base in (
        home / ".conda" / "envs",
        home / "anaconda3" / "envs",
        home / "miniconda3" / "envs",
        Path(r"C:\ProgramData\anaconda3\envs"),
        Path(r"C:\ProgramData\miniconda3\envs"),
    ):
        yield base / CONDA_ENV_NAME


def find_pythonw():
    """Auto-detect Python in the kokoro-tts conda environment."""
    for env_path in _common_env_paths():
        pythonw = _python_from_env_path(env_path)
        if pythonw:
            return pythonw

    try:
        result = subprocess.run(
            ["conda", "env", "list", "--json"],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=NO_WINDOW,
        )
        if result.returncode == 0:
            envs = json.loads(result.stdout).get("envs", [])
            for env_path in envs:
                if Path(env_path).name == CONDA_ENV_NAME:
                    pythonw = _python_from_env_path(env_path)
                    if pythonw:
                        return pythonw
    except Exception:
        pass

    return None


pythonw = find_pythonw()
if not pythonw:
    tkinter.messagebox.showerror(
        "Kokoro TTS",
        "Cannot find the kokoro-tts Conda environment. Please run setup.bat first.",
    )
    raise SystemExit(1)

subprocess.Popen(
    [pythonw, str(TRAY_SCRIPT)],
    cwd=str(SCRIPT_DIR),
    creationflags=NO_WINDOW,
)
