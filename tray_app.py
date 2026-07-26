"""
tray_app.py - Local Read & Translate System Tray Application

Double-click to launch. The server runs in the background
with a system tray icon for control.

Features:
  - Auto-starts TTS server on launch
  - System tray icon with status indicator
  - Right-click menu: Start/Stop, Voice, Speed, Test Page, Exit
  - No terminal window
"""

import json
import os
import signal
import select
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from pathlib import Path
from tts_catalog import (
    AVAILABLE_VOICES,
    DEFAULT_SPEED,
    DEFAULT_VOICE,
    SPEEDS,
    VOICE_GROUPS,
)
from windows_protocol import ensure_start_protocol_registered, parse_protocol_action
from windows_runtime import WindowsNamedAutoResetEvent, WindowsNamedMutex
from windows_startup import (
    StartupShortcutError,
    inspect_startup_shortcut,
    reconcile_start_menu_shortcut,
    reconcile_startup_shortcut,
)

# ---------------------------------------------------------------------------
#  Config
# ---------------------------------------------------------------------------

SCRIPT_DIR = Path(__file__).parent.resolve()
SERVER_SCRIPT = SCRIPT_DIR / "server.py"
ADDIN_HOST_SCRIPT = SCRIPT_DIR / "addon_host.py"
WINDOWS_LAUNCHER = SCRIPT_DIR / "windows_launcher.py"
WINDOWS_LAUNCH_ARGUMENTS = f'-E "{WINDOWS_LAUNCHER}"'
SETTINGS_FILE = SCRIPT_DIR / "tray_settings.json"
CONDA_ENV_NAME = "kokoro-tts"
APP_NAME = "Local Read & Translate"
APP_DATA_DIR = Path(os.environ.get("LOCALAPPDATA", SCRIPT_DIR)) / "KokoroTTS"
LOG_FILE = APP_DATA_DIR / "server.log"
ADDIN_DATA_DIR = (
    Path(os.environ.get("LOCALAPPDATA", SCRIPT_DIR)) / "LocalReadTranslate"
)
ADDIN_HOST_LOG_FILE = ADDIN_DATA_DIR / "addin-host.log"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 5000
ADDIN_HOST_PORT = 5443
START_SERVER_EVENT_NAME = r"Local\LocalReadTranslate.StartServer"
START_OLLAMA_EVENT_NAME = r"Local\LocalReadTranslate.StartOllama"
OPEN_REMOTE_EVENT_NAME = r"Local\LocalReadTranslate.OpenRemote"
PROTOCOL_EVENT_NAMES = {
    "start": START_SERVER_EVENT_NAME,
    "ollama": START_OLLAMA_EVENT_NAME,
    "remote": OPEN_REMOTE_EVENT_NAME,
}

VOICES = {
    group["label_en"]: [
        (
            voice["id"],
            f'{voice["id"]} - {voice["label_en"]}'
            + (" (Default)" if voice["id"] == DEFAULT_VOICE else ""),
        )
        for voice in group["voices"]
    ]
    for group in VOICE_GROUPS
}


# ---------------------------------------------------------------------------
#  Auto-detect conda environment Python path
# ---------------------------------------------------------------------------

def find_conda_python(env_name: str) -> Path:
    """Find the Python executable for a given conda environment name."""
    # Method 1: Try 'conda env list' to get all env paths
    try:
        result = subprocess.run(
            ["conda", "env", "list", "--json"],
            capture_output=True, text=True, timeout=10,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if result.returncode == 0:
            envs = json.loads(result.stdout).get("envs", [])
            for env_path in envs:
                if Path(env_path).name == env_name:
                    python_exe = Path(env_path) / "python.exe"
                    if python_exe.exists():
                        return python_exe
    except Exception:
        pass

    # Method 2: Check common locations
    home = Path.home()
    candidates = [
        home / ".conda" / "envs" / env_name / "python.exe",
        home / "anaconda3" / "envs" / env_name / "python.exe",
        home / "miniconda3" / "envs" / env_name / "python.exe",
        Path(r"C:\ProgramData\anaconda3\envs") / env_name / "python.exe",
        Path(r"C:\ProgramData\miniconda3\envs") / env_name / "python.exe",
    ]
    for p in candidates:
        if p.exists():
            return p

    raise FileNotFoundError(
        f"Conda environment '{env_name}' was not found. Run setup.bat first."
    )


def find_conda_pythonw(env_name: str) -> Path:
    """Find pythonw.exe (no-console) for a conda env."""
    python = find_conda_python(env_name)
    pythonw = python.parent / "pythonw.exe"
    return pythonw if pythonw.exists() else python


# ---------------------------------------------------------------------------
#  Settings persistence
# ---------------------------------------------------------------------------

def default_remote_ollama_settings():
    return {
        "enabled": False,
        "name": "10.12.96.203",
        "connection_mode": "ssh",
        "host": "10.12.96.203",
        "ssh_port": 22,
        "username": "test",
        "password": "",
        "key_file": "",
        "ollama_host": "127.0.0.1",
        "ollama_port": 11434,
        "local_port": 0,
        "base_url": "http://10.12.96.203:11434",
    }


def _remote_connection_mode(settings):
    value = str((settings or {}).get("connection_mode") or "ssh").strip().lower()
    return "api" if value in {"api", "direct", "direct_api"} else "ssh"


def _remote_api_base_url(settings):
    remote = settings or {}
    base_url = str(remote.get("base_url") or "").strip().rstrip("/")
    if not base_url:
        host = str(remote.get("host") or "").strip()
        if not host:
            return ""
        port = int(remote.get("ollama_port") or 11434)
        base_url = f"http://{host}:{port}"
    elif "://" not in base_url:
        base_url = f"http://{base_url}"
    return base_url


def _load_openssh_host_config(paramiko, host):
    config_path = Path.home() / ".ssh" / "config"
    if not config_path.is_file():
        return {}
    try:
        config = paramiko.SSHConfig()
        with open(config_path, "r", encoding="utf-8") as config_file:
            config.parse(config_file)
        return dict(config.lookup(host) or {})
    except (OSError, ValueError):
        return {}


def _expand_ssh_key_files(value):
    if not value:
        return None
    raw_values = value if isinstance(value, (list, tuple)) else [value]
    paths = [
        os.path.expandvars(os.path.expanduser(str(path).strip()))
        for path in raw_values
        if str(path).strip()
    ]
    if not paths:
        return None
    return paths[0] if len(paths) == 1 else paths


def slugify_source_id(value):
    cleaned = "".join(
        ch.lower() if ch.isalnum() else "-"
        for ch in str(value or "").strip()
    )
    cleaned = "-".join(part for part in cleaned.split("-") if part)
    return cleaned or "remote-server"


def load_settings():
    defaults = {
        "voice": DEFAULT_VOICE,
        "speed": DEFAULT_SPEED,
        "auto_start": False,
        "remote_ollama": default_remote_ollama_settings(),
    }
    try:
        if SETTINGS_FILE.exists():
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                saved = json.load(f)
                defaults.update(saved)
    except Exception:
        pass
    if defaults["voice"] not in AVAILABLE_VOICES:
        defaults["voice"] = DEFAULT_VOICE
    if defaults["speed"] not in SPEEDS:
        defaults["speed"] = DEFAULT_SPEED
    defaults["auto_start"] = bool(defaults.get("auto_start", False))
    remote = default_remote_ollama_settings()
    saved_remote = defaults.get("remote_ollama")
    if isinstance(saved_remote, dict):
        remote.update(saved_remote)
    remote["enabled"] = bool(remote.get("enabled", False))
    remote["connection_mode"] = _remote_connection_mode(remote)
    for key in ("ssh_port", "ollama_port", "local_port"):
        try:
            remote[key] = int(remote.get(key) or default_remote_ollama_settings()[key])
        except (TypeError, ValueError):
            remote[key] = default_remote_ollama_settings()[key]
    if isinstance(saved_remote, dict) and "base_url" not in saved_remote:
        legacy_host = str(remote.get("host") or "").strip()
        if legacy_host:
            remote["base_url"] = f"http://{legacy_host}:{remote['ollama_port']}"
    remote["base_url"] = _remote_api_base_url(remote)
    remote["key_file"] = str(remote.get("key_file") or "").strip()
    defaults["remote_ollama"] = remote
    return defaults


def save_settings(settings):
    try:
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2)
    except Exception:
        pass


# ---------------------------------------------------------------------------
#  Icon generation (no external image files needed)
# ---------------------------------------------------------------------------

def create_icon_image(color="green"):
    """Create a simple tray icon with PIL."""
    from PIL import Image, ImageDraw, ImageFont

    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background circle
    if color == "green":
        fill = (102, 126, 234, 255)  # Purple-blue (brand color)
    elif color == "red":
        fill = (200, 80, 80, 255)    # Red (stopped)
    elif color == "yellow":
        fill = (240, 192, 64, 255)   # Yellow (loading)
    else:
        fill = (128, 128, 128, 255)  # Gray

    draw.ellipse([4, 4, size - 4, size - 4], fill=fill)

    # App initial
    try:
        font = ImageFont.truetype("segoeui.ttf", 32)
    except Exception:
        try:
            font = ImageFont.truetype("arial.ttf", 32)
        except Exception:
            font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), "L", font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    tx = (size - tw) // 2
    ty = (size - th) // 2 - 2
    draw.text((tx, ty), "L", fill=(255, 255, 255, 255), font=font)

    return img


# ---------------------------------------------------------------------------
#  Server process management
# ---------------------------------------------------------------------------

class RemoteOllamaTunnel:
    def __init__(self, settings):
        self.settings = dict(settings or {})
        self.client = None
        self.server = None
        self.thread = None
        self.local_port = 0

    def start(self):
        import paramiko

        host = str(self.settings.get("host") or "").strip()
        ssh_config = _load_openssh_host_config(paramiko, host) if host else {}
        connect_host = str(ssh_config.get("hostname") or host).strip()
        username = str(
            self.settings.get("username") or ssh_config.get("user") or ""
        ).strip()
        password = str(self.settings.get("password") or "")
        if not host:
            raise RuntimeError("Remote server IP is required")
        if not username:
            raise RuntimeError("Remote username is required")

        ssh_port = int(
            self.settings.get("ssh_port") or ssh_config.get("port") or 22
        )
        ollama_host = str(self.settings.get("ollama_host") or "127.0.0.1").strip()
        ollama_port = int(self.settings.get("ollama_port") or 11434)
        requested_local_port = int(self.settings.get("local_port") or 0)
        key_filename = _expand_ssh_key_files(
            self.settings.get("key_file") or ssh_config.get("identityfile")
        )

        client = paramiko.SSHClient()
        client.load_system_host_keys()
        client.set_missing_host_key_policy(paramiko.RejectPolicy())
        connect_kwargs = {
            "hostname": connect_host,
            "port": ssh_port,
            "username": username,
            "look_for_keys": True,
            "allow_agent": True,
            "timeout": 10,
            "banner_timeout": 10,
            "auth_timeout": 10,
        }
        if key_filename:
            connect_kwargs["key_filename"] = key_filename
        if password:
            # Paramiko tries explicit/default keys and the SSH agent before
            # falling back to this password in the same connection attempt.
            connect_kwargs["password"] = password
        client.connect(**connect_kwargs)
        transport = client.get_transport()
        if transport is None or not transport.is_active():
            client.close()
            raise RuntimeError("SSH connection is not active")

        class ForwardHandler(socketserver.BaseRequestHandler):
            def handle(handler_self):
                channel = None
                try:
                    channel = transport.open_channel(
                        "direct-tcpip",
                        (ollama_host, ollama_port),
                        handler_self.client_address,
                    )
                    while True:
                        readable, _, _ = select.select(
                            [handler_self.request, channel],
                            [],
                            [],
                            10,
                        )
                        if handler_self.request in readable:
                            data = handler_self.request.recv(32768)
                            if not data:
                                break
                            channel.sendall(data)
                        if channel in readable:
                            data = channel.recv(32768)
                            if not data:
                                break
                            handler_self.request.sendall(data)
                finally:
                    if channel is not None:
                        channel.close()
                    handler_self.request.close()

        class ThreadingForwardServer(socketserver.ThreadingTCPServer):
            allow_reuse_address = True
            daemon_threads = True

        server = ThreadingForwardServer((DEFAULT_HOST, requested_local_port), ForwardHandler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        self.client = client
        self.server = server
        self.thread = thread
        self.local_port = int(server.server_address[1])
        return self.local_port

    def stop(self):
        if self.server is not None:
            try:
                self.server.shutdown()
                self.server.server_close()
            except Exception:
                pass
        self.server = None
        if self.client is not None:
            try:
                self.client.close()
            except Exception:
                pass
        self.client = None
        self.thread = None
        self.local_port = 0


class TrayApp:
    def __init__(
        self,
        *,
        start_background_tasks=True,
        enable_windows_protocol=True,
        initial_protocol_action=None,
    ):
        self.server_process = None
        self.owns_server = False
        self._log_handle = None
        self.addin_host_process = None
        self.owns_addin_host = False
        self._addin_log_handle = None
        self.settings = load_settings()
        self.tray_icon = None
        self.is_running = False
        self._lock = threading.Lock()
        self.python_exe = find_conda_python(CONDA_ENV_NAME)
        self.pythonw_exe = find_conda_pythonw(CONDA_ENV_NAME)
        self.remote_tunnel = None
        self.remote_tunnel_local_port = None
        self._enable_windows_protocol = bool(enable_windows_protocol)
        self._initial_protocol_action = initial_protocol_action
        self._start_server_event = None
        self._start_ollama_event = None
        self._open_remote_event = None
        self._protocol_listener_stop = threading.Event()
        self._protocol_listener_thread = None
        self._protocol_listener_threads = []
        self._local_ollama_process = None
        # 缓存开机自启状态，避免右键托盘菜单渲染时同步拉起 PowerShell 子进程导致系统假死
        self.auto_start_cached = bool(self.settings.get("auto_start", False))
        if self._enable_windows_protocol:
            self._initialize_windows_protocol(
                start_listener=bool(start_background_tasks),
            )
        if start_background_tasks:
            threading.Thread(
                target=self._init_and_reconcile_auto_start,
                daemon=True,
            ).start()

    def _initialize_windows_protocol(self, *, start_listener):
        try:
            ensure_start_protocol_registered(
                self.pythonw_exe,
                WINDOWS_LAUNCHER,
            )
        except Exception:
            # URL registration is a convenience feature and must never prevent
            # the tray or API server from starting normally.
            pass

        if not start_listener:
            return
        event_specs = (
            (
                "_start_server_event",
                START_SERVER_EVENT_NAME,
                self._listen_for_start_server_requests,
            ),
            (
                "_start_ollama_event",
                START_OLLAMA_EVENT_NAME,
                self._listen_for_start_ollama_requests,
            ),
            (
                "_open_remote_event",
                OPEN_REMOTE_EVENT_NAME,
                self._listen_for_remote_service_requests,
            ),
        )
        for attribute, event_name, listener_target in event_specs:
            try:
                event = WindowsNamedAutoResetEvent(event_name).create()
            except Exception:
                continue
            setattr(self, attribute, event)
            listener = threading.Thread(target=listener_target, daemon=True)
            self._protocol_listener_threads.append(listener)
            if attribute == "_start_server_event":
                self._protocol_listener_thread = listener
            listener.start()

    def _listen_for_protocol_requests(self, event, callback):
        if event is None:
            return
        while not self._protocol_listener_stop.is_set():
            try:
                requested = event.wait(timeout_ms=500)
            except Exception:
                return
            if requested and not self._protocol_listener_stop.is_set():
                callback()

    def _listen_for_start_server_requests(self):
        self._listen_for_protocol_requests(self._start_server_event, self.start_server)

    def _listen_for_start_ollama_requests(self):
        self._listen_for_protocol_requests(
            self._start_ollama_event,
            self.start_local_ollama,
        )

    def _listen_for_remote_service_requests(self):
        self._listen_for_protocol_requests(
            self._open_remote_event,
            self.open_remote_service_settings,
        )

    def local_ollama_is_reachable(self):
        """Return whether the native loopback Ollama API is healthy."""
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        try:
            with opener.open("http://127.0.0.1:11434/api/tags", timeout=1) as response:
                payload = json.load(response)
            return response.status == 200 and isinstance(payload.get("models"), list)
        except (OSError, ValueError, AttributeError, urllib.error.URLError):
            return False

    def find_ollama_executable(self):
        """Find an installed Ollama CLI without accepting a browser-provided path."""
        discovered = shutil.which("ollama")
        if discovered:
            return Path(discovered)
        local_app_data = os.environ.get("LOCALAPPDATA")
        if local_app_data:
            candidate = Path(local_app_data) / "Programs" / "Ollama" / "ollama.exe"
            if candidate.is_file():
                return candidate
        candidate = Path.home() / "AppData" / "Local" / "Programs" / "Ollama" / "ollama.exe"
        return candidate if candidate.is_file() else None

    def start_local_ollama(self, _=None):
        """Start native Ollama once and verify its loopback API becomes reachable."""
        if self.local_ollama_is_reachable():
            return True
        executable = self.find_ollama_executable()
        if executable is None:
            self.show_error(
                "Local Ollama",
                "Ollama is not installed or could not be found.",
            )
            return False
        try:
            self._local_ollama_process = subprocess.Popen(
                [str(executable), "serve"],
                cwd=str(executable.parent),
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception as error:
            self.show_error("Local Ollama", f"Unable to start Ollama: {error}")
            return False

        for _attempt in range(20):
            time.sleep(0.5)
            if self.local_ollama_is_reachable():
                return True
            if self._local_ollama_process.poll() is not None:
                break
        self.show_error(
            "Local Ollama",
            "Ollama was started but its local API did not become ready.",
        )
        return False

    def get_health(self, port=DEFAULT_PORT):
        try:
            with urllib.request.urlopen(
                f"http://{DEFAULT_HOST}:{port}/health", timeout=1
            ) as response:
                data = json.load(response)
            if (
                response.status == 200
                and data.get("service") == "kokoro-tts"
                and data.get("ready") is True
            ):
                return data
        except (OSError, ValueError, urllib.error.URLError):
            pass
        return None

    def get_addin_health(self, port=ADDIN_HOST_PORT):
        """Return the loopback add-in host health without using proxies."""
        opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}),
        )
        try:
            with opener.open(
                f"http://{DEFAULT_HOST}:{port}/health",
                timeout=1,
            ) as response:
                data = json.load(response)
            if (
                response.status == 200
                and data.get("service") == "localreadtranslate-addin-host"
                and data.get("ready") is True
            ):
                return data
        except (OSError, ValueError, urllib.error.URLError):
            pass
        return None

    def start_addin_host(self):
        """Start the document add-in loopback host."""
        if (
            self.addin_host_process
            and self.addin_host_process.poll() is None
        ):
            return True
        if self.get_addin_health():
            self.owns_addin_host = False
            return True
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.settimeout(1)
            if sock.connect_ex((DEFAULT_HOST, ADDIN_HOST_PORT)) == 0:
                self.owns_addin_host = False
                return False

        ADDIN_DATA_DIR.mkdir(parents=True, exist_ok=True)
        self._addin_log_handle = open(
            ADDIN_HOST_LOG_FILE,
            "a",
            encoding="utf-8",
        )
        try:
            self.addin_host_process = subprocess.Popen(
                [str(self.python_exe), "-E", str(ADDIN_HOST_SCRIPT)],
                cwd=str(SCRIPT_DIR),
                stdin=subprocess.DEVNULL,
                stdout=self._addin_log_handle,
                stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except Exception:
            self._close_addin_log()
            self.addin_host_process = None
            self.owns_addin_host = False
            return False
        self.owns_addin_host = True
        return True

    def stop_addin_host(self):
        """Stop only the add-in host process created by this tray."""
        if (
            self.owns_addin_host
            and self.addin_host_process
            and self.addin_host_process.poll() is None
        ):
            self.addin_host_process.terminate()
            try:
                self.addin_host_process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.addin_host_process.kill()
        self.addin_host_process = None
        self.owns_addin_host = False
        self._close_addin_log()

    def start_server(self, _=None):
        with self._lock:
            if self.server_process and self.server_process.poll() is None:
                return  # Already running

            existing_health = self.get_health()
            if existing_health:
                self.owns_server = False
                self.is_running = True
                self.start_addin_host()
                self._update_icon("green", f"{APP_NAME} - Running")
                return

            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                sock.settimeout(1)
                if sock.connect_ex((DEFAULT_HOST, DEFAULT_PORT)) == 0:
                    self.owns_server = False
                    self.is_running = False
                    self._update_icon(
                        "red", f"{APP_NAME} - Port {DEFAULT_PORT} is occupied"
                    )
                    return

            self._update_icon("yellow", f"{APP_NAME} - Starting...")

            env = os.environ.copy()
            self.ensure_remote_ollama_tunnel()
            env["PYTHONIOENCODING"] = "utf-8"
            env["KOKORO_HOST"] = DEFAULT_HOST
            env["KOKORO_PORT"] = str(DEFAULT_PORT)
            env["KOKORO_VOICE"] = self.settings["voice"]
            env["KOKORO_SPEED"] = str(self.settings["speed"])
            env["KOKORO_TRAY_PID"] = str(os.getpid())
            sources_env = self.build_remote_ollama_sources_env()
            if sources_env:
                env["KOKORO_OLLAMA_SOURCES"] = sources_env

            # Start server process (hidden, no window)
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = 0  # SW_HIDE

            APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
            self._log_handle = open(LOG_FILE, "a", encoding="utf-8")
            self.server_process = subprocess.Popen(
                [str(self.python_exe), "-E", str(SERVER_SCRIPT)],
                cwd=str(SCRIPT_DIR),
                env=env,
                startupinfo=startupinfo,
                stdout=self._log_handle,
                stderr=subprocess.STDOUT,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
            self.owns_server = True
            self.start_addin_host()

        # Wait for server to be ready in background
        def wait_ready():
            for _ in range(60):  # 60s timeout
                if self.server_process.poll() is not None:
                    self.owns_server = False
                    self.is_running = False
                    self._update_icon("red", f"{APP_NAME} - Failed to start")
                    self._close_log()
                    return
                if self.get_health():
                    self.is_running = True
                    self._update_icon("green", f"{APP_NAME} - Running")
                    return
                time.sleep(1)
            self.is_running = False
            self._update_icon("red", f"{APP_NAME} - Startup timeout")

        threading.Thread(target=wait_ready, daemon=True).start()

    def stop_server(self, _=None):
        with self._lock:
            if self.server_process and self.server_process.poll() is None:
                self.server_process.terminate()
                try:
                    self.server_process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.server_process.kill()
            self.server_process = None
            self.owns_server = False
            self._close_log()
            if self.get_health():
                self.is_running = True
                self._update_icon("green", f"{APP_NAME} - External server running")
                return
            self.is_running = False
            self._update_icon("red", f"{APP_NAME} - Stopped")

    def restart_server(self, _=None):
        self.stop_server()
        time.sleep(1)
        self.start_server()

    def can_stop_server(self):
        return self.is_running and self.owns_server

    def build_remote_ollama_sources_env(self):
        remote = self.settings.get("remote_ollama") or {}
        if not remote.get("enabled"):
            return ""
        if _remote_connection_mode(remote) == "api":
            base_url = _remote_api_base_url(remote)
            if not base_url:
                return ""
        else:
            try:
                local_port = int(self.remote_tunnel_local_port or 0)
            except (TypeError, ValueError):
                local_port = 0
            if local_port <= 0:
                return ""
            base_url = f"http://127.0.0.1:{local_port}"
        name = (remote.get("name") or remote.get("host") or "Remote Ollama").strip()
        source_id = slugify_source_id(name)
        return json.dumps(
            [
                {
                    "id": source_id,
                    "name": name,
                    "base_url": base_url,
                }
            ],
            ensure_ascii=False,
        )

    def _test_remote_ollama_tunnel(self, local_port):
        self._test_remote_ollama_api(f"http://{DEFAULT_HOST}:{local_port}")

    def _test_remote_ollama_api(self, base_url):
        tags_url = f"{str(base_url or '').strip().rstrip('/')}/api/tags"
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open(
            tags_url,
            timeout=5,
        ) as response:
            if response.status != 200:
                raise RuntimeError("Remote Ollama did not return model tags")
            json.load(response)

    def _stop_remote_ollama_tunnel(self):
        if self.remote_tunnel:
            self.remote_tunnel.stop()
        self.remote_tunnel = None
        self.remote_tunnel_local_port = None

    def ensure_remote_ollama_tunnel(self):
        remote = self.settings.get("remote_ollama") or {}
        if not remote.get("enabled"):
            return False
        mode = _remote_connection_mode(remote)
        if mode == "ssh" and self.remote_tunnel and self.remote_tunnel_local_port:
            return True
        tunnel = None
        try:
            if mode == "api":
                base_url = _remote_api_base_url(remote)
                if not base_url:
                    raise RuntimeError("Remote Ollama API base URL is required")
                self._test_remote_ollama_api(base_url)
                self._stop_remote_ollama_tunnel()
                return True
            tunnel = RemoteOllamaTunnel(remote)
            local_port = tunnel.start()
            self._test_remote_ollama_tunnel(local_port)
            self.remote_tunnel = tunnel
            self.remote_tunnel_local_port = local_port
            remote["local_port"] = local_port
            self.settings["remote_ollama"] = remote
            save_settings(self.settings)
            return True
        except Exception as error:
            if tunnel is not None:
                tunnel.stop()
            self.show_error("Remote Service", str(error))
            return False

    def connect_remote_ollama(self, remote_settings=None):
        previous_tunnel = self.remote_tunnel
        previous_local_port = self.remote_tunnel_local_port
        remote = default_remote_ollama_settings()
        candidate = remote_settings
        if candidate is None:
            candidate = self.settings.get("remote_ollama") or {}
        if isinstance(candidate, dict):
            remote.update(candidate)
        remote["enabled"] = True
        remote["connection_mode"] = _remote_connection_mode(remote)
        remote["base_url"] = _remote_api_base_url(remote)
        tunnel = None
        try:
            if remote["connection_mode"] == "api":
                if not remote["base_url"]:
                    raise RuntimeError("Remote Ollama API base URL is required")
                self._test_remote_ollama_api(remote["base_url"])
                local_port = 0
            else:
                tunnel_settings = dict(remote)
                if (
                    previous_tunnel is not None
                    and int(tunnel_settings.get("local_port") or 0)
                    == int(previous_local_port or 0)
                ):
                    tunnel_settings["local_port"] = 0
                tunnel = RemoteOllamaTunnel(tunnel_settings)
                local_port = tunnel.start()
                self._test_remote_ollama_tunnel(local_port)
        except Exception:
            if tunnel is not None:
                tunnel.stop()
            raise

        if previous_tunnel is not None:
            previous_tunnel.stop()
        self.remote_tunnel = tunnel
        self.remote_tunnel_local_port = local_port or None
        remote["local_port"] = local_port
        self.settings["remote_ollama"] = remote
        save_settings(self.settings)
        self.restart_server()
        if self.tray_icon:
            self.tray_icon.menu = self._build_menu()

    def disconnect_remote_ollama(self, _=None, restart=True):
        self._stop_remote_ollama_tunnel()
        remote = dict(self.settings.get("remote_ollama") or default_remote_ollama_settings())
        remote["enabled"] = False
        remote["local_port"] = 0
        self.settings["remote_ollama"] = remote
        save_settings(self.settings)
        if restart:
            self.restart_server()
        if self.tray_icon:
            self.tray_icon.menu = self._build_menu()

    def open_test_page(self, _=None):
        webbrowser.open(f"http://{DEFAULT_HOST}:{DEFAULT_PORT}/")

    def open_health(self, _=None):
        webbrowser.open(f"http://{DEFAULT_HOST}:{DEFAULT_PORT}/health")

    def open_project_dir(self, _=None):
        os.startfile(str(SCRIPT_DIR))

    def open_log(self, _=None):
        APP_DATA_DIR.mkdir(parents=True, exist_ok=True)
        if not LOG_FILE.exists():
            LOG_FILE.touch()
        os.startfile(str(LOG_FILE))

    def open_remote_service_settings(self, _=None):
        threading.Thread(
            target=self._run_remote_service_settings_dialog,
            daemon=True,
        ).start()

    def _run_remote_service_settings_dialog(self):
        import tkinter as tk
        from tkinter import messagebox

        remote = default_remote_ollama_settings()
        if isinstance(self.settings.get("remote_ollama"), dict):
            remote.update(self.settings["remote_ollama"])

        window = tk.Tk()
        window.title(f"{APP_NAME} - Remote Service")
        window.resizable(False, False)

        fields = [
            ("Server name", "name", remote.get("name") or ""),
            (
                "Connection mode (ssh/api)",
                "connection_mode",
                _remote_connection_mode(remote),
            ),
            ("Server IP", "host", remote.get("host") or ""),
            ("SSH port", "ssh_port", str(remote.get("ssh_port") or 22)),
            ("Username", "username", remote.get("username") or ""),
            ("Password", "password", remote.get("password") or ""),
            ("SSH key file (optional)", "key_file", remote.get("key_file") or ""),
            ("Ollama host", "ollama_host", remote.get("ollama_host") or "127.0.0.1"),
            ("Ollama port", "ollama_port", str(remote.get("ollama_port") or 11434)),
            ("Direct API base URL", "base_url", _remote_api_base_url(remote)),
        ]
        entries = {}
        for row, (label, key, value) in enumerate(fields):
            tk.Label(window, text=label).grid(
                row=row,
                column=0,
                padx=10,
                pady=5,
                sticky="e",
            )
            if key == "connection_mode":
                mode_var = tk.StringVar(value=str(value))
                mode_menu = tk.OptionMenu(window, mode_var, "ssh", "api")
                mode_menu.grid(row=row, column=1, padx=10, pady=5, sticky="we")
                entries[key] = mode_var
            else:
                entry = tk.Entry(
                    window,
                    width=32,
                    show="*" if key == "password" else "",
                )
                entry.insert(0, str(value))
                entry.grid(row=row, column=1, padx=10, pady=5, sticky="we")
                entries[key] = entry
        entries["host"].focus_set()
        window.after(100, window.focus_force)

        status_text = "Connected" if remote.get("enabled") else "Not connected"
        status = tk.Label(window, text=status_text)
        status.grid(row=len(fields), column=0, columnspan=2, padx=10, pady=5)

        def read_remote_settings():
            values = default_remote_ollama_settings()
            values.update(
                {
                    "name": entries["name"].get().strip(),
                    "connection_mode": entries["connection_mode"].get().strip().lower(),
                    "host": entries["host"].get().strip(),
                    "username": entries["username"].get().strip(),
                    "password": entries["password"].get(),
                    "key_file": entries["key_file"].get().strip(),
                    "ollama_host": entries["ollama_host"].get().strip() or "127.0.0.1",
                    "base_url": entries["base_url"].get().strip(),
                }
            )
            if values["connection_mode"] not in {"ssh", "api"}:
                raise RuntimeError("connection mode must be ssh or api")
            for key, fallback in (("ssh_port", 22), ("ollama_port", 11434)):
                try:
                    values[key] = int(entries[key].get().strip() or fallback)
                except ValueError:
                    raise RuntimeError(f"{key.replace('_', ' ')} must be a number")
            values["name"] = values["name"] or values["host"] or "Remote Ollama"
            values["base_url"] = _remote_api_base_url(values)
            values["local_port"] = int(remote.get("local_port") or 0)
            return values

        def on_save():
            try:
                values = read_remote_settings()
            except Exception as error:
                messagebox.showerror("Remote Service", str(error), parent=window)
                return
            values["enabled"] = bool(remote.get("enabled"))
            self.settings["remote_ollama"] = values
            save_settings(self.settings)
            window.destroy()

        def on_connect():
            try:
                values = read_remote_settings()
                values["enabled"] = True
                status.config(text="Connecting...")
                window.update_idletasks()
                self.connect_remote_ollama(values)
                messagebox.showinfo("Remote Service", "Connected.", parent=window)
                window.destroy()
            except Exception as error:
                messagebox.showerror("Remote Service", str(error), parent=window)
                status.config(text="Connection failed")

        def on_disconnect():
            self.disconnect_remote_ollama(restart=True)
            messagebox.showinfo("Remote Service", "Disconnected.", parent=window)
            window.destroy()

        buttons = tk.Frame(window)
        buttons.grid(row=len(fields) + 1, column=0, columnspan=2, padx=10, pady=10)
        tk.Button(buttons, text="Connect", command=on_connect, width=10).pack(
            side="left",
            padx=4,
        )
        tk.Button(buttons, text="Disconnect", command=on_disconnect, width=10).pack(
            side="left",
            padx=4,
        )
        tk.Button(buttons, text="Save", command=on_save, width=10).pack(
            side="left",
            padx=4,
        )
        tk.Button(buttons, text="Cancel", command=window.destroy, width=10).pack(
            side="left",
            padx=4,
        )

        window.mainloop()

    def show_error(self, title, message):
        if os.name == "nt":
            try:
                import ctypes

                ctypes.windll.user32.MessageBoxW(
                    0,
                    str(message),
                    f"{APP_NAME} - {title}",
                    0x10,
                )
                return
            except Exception:
                pass
        print(f"[{APP_NAME}] {title}: {message}")

    def _init_and_reconcile_auto_start(self):
        try:
            reconcile_start_menu_shortcut(
                self.pythonw_exe,
                SCRIPT_DIR,
                WINDOWS_LAUNCH_ARGUMENTS,
            )
        except Exception as error:
            self.show_error("Start Menu", str(error))
        try:
            # 在后台线程中检查快捷方式实际是否存在，避免卡死托盘启动
            actual = inspect_startup_shortcut(
                self.pythonw_exe,
                SCRIPT_DIR,
                arguments=WINDOWS_LAUNCH_ARGUMENTS,
            )
            self.auto_start_cached = actual
            
            desired = bool(self.settings.get("auto_start", False))
            if desired != actual:
                actual = reconcile_startup_shortcut(
                    desired,
                    self.pythonw_exe,
                    SCRIPT_DIR,
                    arguments=WINDOWS_LAUNCH_ARGUMENTS,
                )
                self.auto_start_cached = actual
        except Exception:
            pass
        self.settings["auto_start"] = self.auto_start_cached
        save_settings(self.settings)
        if self.tray_icon:
            self.tray_icon.menu = self._build_menu()

    def is_auto_start_enabled(self):
        return self.auto_start_cached

    def toggle_auto_start(self, _=None):
        previous = self.auto_start_cached
        try:
            requested = not previous
            actual = reconcile_startup_shortcut(
                requested,
                self.pythonw_exe,
                SCRIPT_DIR,
                arguments=WINDOWS_LAUNCH_ARGUMENTS,
            )
            self.auto_start_cached = actual
        except StartupShortcutError as error:
            self.auto_start_cached = previous
            self.show_error("Auto-start", str(error))
            return

        self.settings["auto_start"] = self.auto_start_cached
        save_settings(self.settings)
        if self.tray_icon:
            self.tray_icon.menu = self._build_menu()

    def set_voice(self, voice_id):
        def _set(_=None):
            self.settings["voice"] = voice_id
            save_settings(self.settings)
            self.restart_server()
        return _set

    def set_speed(self, speed_val):
        def _set(_=None):
            self.settings["speed"] = speed_val
            save_settings(self.settings)
            self.restart_server()
        return _set

    def _schedule_force_exit(self, delay=6.0):
        timer = threading.Timer(delay, lambda: os._exit(0))
        timer.daemon = True
        timer.start()
        return timer

    def quit_app(self, _=None):
        watchdog = self._schedule_force_exit()
        try:
            self._protocol_listener_stop.set()
            protocol_events = (
                self._start_server_event,
                self._start_ollama_event,
                self._open_remote_event,
            )
            for event in protocol_events:
                if event is None:
                    continue
                try:
                    event.set()
                except Exception:
                    pass
            for listener in self._protocol_listener_threads:
                if listener is not threading.current_thread():
                    try:
                        listener.join(timeout=1)
                    except Exception:
                        pass
            for event in protocol_events:
                if event is None:
                    continue
                try:
                    event.close()
                except Exception:
                    pass
            try:
                self._stop_remote_ollama_tunnel()
            except Exception:
                pass
            try:
                self.stop_addin_host()
            except Exception:
                pass
            try:
                self.stop_server()
            except Exception:
                pass
            if self.tray_icon:
                try:
                    self.tray_icon.stop()
                except Exception:
                    pass
        finally:
            watchdog.cancel()
        os._exit(0)

    def _update_icon(self, color, title):
        if self.tray_icon:
            self.tray_icon.icon = create_icon_image(color)
            self.tray_icon.title = title

    def _close_log(self):
        if self._log_handle:
            self._log_handle.close()
            self._log_handle = None

    def _close_addin_log(self):
        if self._addin_log_handle:
            self._addin_log_handle.close()
            self._addin_log_handle = None

    def _build_menu(self):
        import pystray
        from pystray import MenuItem as Item

        # Voice submenu
        voice_items = []
        for group_name, voices in VOICES.items():
            for vid, vlabel in voices:
                is_current = vid == self.settings["voice"]
                voice_items.append(
                    Item(
                        (">> " if is_current else "   ") + vlabel,
                        self.set_voice(vid),
                    )
                )
            voice_items.append(pystray.Menu.SEPARATOR)

        # Speed submenu
        speed_items = []
        for spd in SPEEDS:
            is_current = abs(spd - self.settings["speed"]) < 0.01
            label = f"{'>> ' if is_current else '   '}{spd}x"
            if abs(spd - DEFAULT_SPEED) < 0.01:
                label += " (default)"
            speed_items.append(Item(label, self.set_speed(spd)))

        menu = pystray.Menu(
            Item("Start Server", self.start_server,
                 enabled=lambda _: not self.is_running),
            Item("Stop Server", self.stop_server,
                 enabled=lambda _: self.can_stop_server()),
            Item("Restart Server", self.restart_server,
                 enabled=lambda _: self.can_stop_server()),
            pystray.Menu.SEPARATOR,
            Item("Voice", pystray.Menu(*voice_items)),
            Item("Speed", pystray.Menu(*speed_items)),
            pystray.Menu.SEPARATOR,
            Item("Open Test Page", self.open_test_page,
                  enabled=lambda _: self.is_running),
            Item("Open Server Log", self.open_log),
            Item("Open Project Folder", self.open_project_dir),
            Item("Remote Service", self.open_remote_service_settings),
            Item(
                "Auto-start on login",
                self.toggle_auto_start,
                checked=lambda _: self.is_auto_start_enabled(),
            ),
            pystray.Menu.SEPARATOR,
            Item("Exit", self.quit_app),
        )
        return menu

    def run(self):
        import pystray

        icon = pystray.Icon(
            name="local-read-translate",
            icon=create_icon_image("yellow"),
            title=f"{APP_NAME} - Starting...",
            menu=self._build_menu(),
        )
        self.tray_icon = icon

        # Auto-start server
        threading.Thread(target=self.start_server, daemon=True).start()
        if self._initial_protocol_action in {"ollama", "remote"}:
            action = self._initial_protocol_action
            target = (
                self.start_local_ollama
                if action == "ollama"
                else self.open_remote_service_settings
            )
            threading.Thread(target=target, daemon=True).start()

        icon.run()


# ---------------------------------------------------------------------------
#  Entry point
# ---------------------------------------------------------------------------

def main(argv=None):
    args = list(sys.argv[1:] if argv is None else argv)
    protocol_action = next(
        (action for value in args if (action := parse_protocol_action(value))),
        None,
    )
    instance_mutex = WindowsNamedMutex(r"Local\KokoroTTS.Tray")
    if not instance_mutex.acquire():
        if protocol_action:
            WindowsNamedAutoResetEvent.signal_existing(
                PROTOCOL_EVENT_NAMES[protocol_action]
            )
            return 0
        import ctypes

        ctypes.windll.user32.MessageBoxW(
            0,
            f"{APP_NAME} 已在运行。",
            APP_NAME,
            0x40,
        )
        return 0
    try:
        app = TrayApp(initial_protocol_action=protocol_action)
        app.run()
    finally:
        instance_mutex.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
