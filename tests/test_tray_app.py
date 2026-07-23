import json
import sys
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import Mock, mock_open, patch

import tray_app
from windows_startup import StartupShortcutError


class TrayOwnershipTests(unittest.TestCase):
    def make_app(self):
        with patch.object(
            tray_app,
            "find_conda_python",
            return_value=Path(sys.executable),
        ), patch.object(tray_app, "reconcile_startup_shortcut"), patch.object(
            tray_app.TrayApp,
            "_init_and_reconcile_auto_start",
        ):
            return tray_app.TrayApp(
                start_background_tasks=False,
                enable_windows_protocol=False,
            )

    def test_external_server_cannot_be_stopped_by_tray(self):
        app = self.make_app()
        app.is_running = True
        app.server_process = None

        self.assertFalse(app.can_stop_server())

    def test_owned_server_can_be_stopped_by_tray(self):
        app = self.make_app()
        app.is_running = True
        app.owns_server = True

        self.assertTrue(app.can_stop_server())

    def test_quit_app_forces_process_exit_after_cleanup(self):
        app = self.make_app()
        app._stop_remote_ollama_tunnel = Mock()
        app.stop_addin_host = Mock()
        app.stop_server = Mock()
        app.tray_icon = Mock()

        with patch.object(tray_app.os, "_exit") as exit_process:
            app.quit_app()

        app._stop_remote_ollama_tunnel.assert_called_once()
        app.stop_addin_host.assert_called_once()
        app.stop_server.assert_called_once()
        app.tray_icon.stop.assert_called_once()
        exit_process.assert_called_once_with(0)

    def test_quit_app_still_exits_when_cleanup_fails(self):
        app = self.make_app()
        app._stop_remote_ollama_tunnel = Mock(side_effect=RuntimeError("stuck"))
        app.stop_addin_host = Mock(side_effect=RuntimeError("also stuck"))
        app.stop_server = Mock(side_effect=RuntimeError("also stuck"))
        app.tray_icon = Mock()

        with patch.object(tray_app.os, "_exit") as exit_process:
            app.quit_app()

        app._stop_remote_ollama_tunnel.assert_called_once()
        app.stop_addin_host.assert_called_once()
        app.stop_server.assert_called_once()
        app.tray_icon.stop.assert_called_once()
        exit_process.assert_called_once_with(0)

    def test_addin_host_uses_hidden_project_process_and_is_owned(self):
        app = self.make_app()
        process = Mock()
        process.poll.return_value = None
        log_handle = Mock()
        fake_socket = Mock()
        fake_socket.__enter__ = Mock(return_value=fake_socket)
        fake_socket.__exit__ = Mock(return_value=False)
        fake_socket.connect_ex.return_value = 1
        data_directory = Mock()
        with patch.object(app, "get_addin_health", return_value=None), patch.object(
            tray_app,
            "ADDIN_DATA_DIR",
            data_directory,
        ), patch.object(
            tray_app.socket,
            "socket",
            return_value=fake_socket,
        ), patch(
            "builtins.open",
            return_value=log_handle,
        ), patch.object(
            tray_app.subprocess,
            "Popen",
            return_value=process,
        ) as popen:
            self.assertTrue(app.start_addin_host())

        command = popen.call_args.args[0]
        kwargs = popen.call_args.kwargs
        self.assertEqual(command, [str(app.python_exe), str(tray_app.ADDIN_HOST_SCRIPT)])
        self.assertEqual(kwargs["cwd"], str(tray_app.SCRIPT_DIR))
        self.assertIs(kwargs["stdin"], tray_app.subprocess.DEVNULL)
        self.assertIs(kwargs["stdout"], log_handle)
        self.assertTrue(app.owns_addin_host)

        app.stop_addin_host()
        process.terminate.assert_called_once()
        process.wait.assert_called_once_with(timeout=5)
        log_handle.close.assert_called_once()


class TrayAutoStartTests(unittest.TestCase):
    def make_app(self):
        with patch.object(
            tray_app,
            "find_conda_python",
            return_value=Path(sys.executable),
        ), patch.object(tray_app, "reconcile_startup_shortcut"), patch.object(
            tray_app.TrayApp,
            "_init_and_reconcile_auto_start",
        ):
            return tray_app.TrayApp(
                start_background_tasks=False,
                enable_windows_protocol=False,
            )

    def test_default_settings_include_auto_start_disabled(self):
        with patch.object(
            tray_app,
            "SETTINGS_FILE",
            Path("__missing_tray_settings_for_test__.json"),
        ):
            settings = tray_app.load_settings()

        self.assertIs(settings["auto_start"], False)

    def test_toggle_auto_start_saves_after_successful_shortcut_update(self):
        app = self.make_app()
        app.settings["auto_start"] = False

        with patch.object(
            tray_app,
            "inspect_startup_shortcut",
            return_value=False,
        ), patch.object(
            tray_app,
            "reconcile_startup_shortcut",
            return_value=True,
        ) as reconcile, patch.object(tray_app, "save_settings") as save:
            app.toggle_auto_start()

        reconcile.assert_called_once()
        self.assertIs(app.settings["auto_start"], True)
        save.assert_called_once_with(app.settings)

    def test_toggle_auto_start_failure_preserves_setting_and_shows_error(self):
        app = self.make_app()
        app.settings["auto_start"] = False
        app.show_error = Mock()

        with patch.object(
            tray_app,
            "inspect_startup_shortcut",
            return_value=False,
        ), patch.object(
            tray_app,
            "reconcile_startup_shortcut",
            side_effect=StartupShortcutError("boom"),
        ), patch.object(tray_app, "save_settings") as save:
            app.toggle_auto_start()

        self.assertIs(app.settings["auto_start"], False)
        save.assert_not_called()
        app.show_error.assert_called_once()

    def test_menu_contains_checked_auto_start_item(self):
        class FakeItem:
            def __init__(self, text, action=None, **kwargs):
                self.text = text
                self.action = action
                self.kwargs = kwargs

        class FakeMenu:
            SEPARATOR = object()

            def __init__(self, *items):
                self.items = items

        fake_pystray = SimpleNamespace(Menu=FakeMenu, MenuItem=FakeItem)
        app = self.make_app()
        app.is_auto_start_enabled = Mock(return_value=True)

        with patch.dict(sys.modules, {"pystray": fake_pystray}):
            menu = app._build_menu()

        auto_start_items = [
            item for item in menu.items
            if isinstance(item, FakeItem) and item.text == "Auto-start on login"
        ]
        self.assertEqual(len(auto_start_items), 1)
        item = auto_start_items[0]
        self.assertIs(item.action.__self__, app)
        self.assertIs(item.action.__func__, app.toggle_auto_start.__func__)
        self.assertTrue(item.kwargs["checked"](item))


class TrayProtocolLaunchTests(unittest.TestCase):
    def test_constructor_can_disable_registry_and_background_threads(self):
        with patch.object(
            tray_app,
            "find_conda_python",
            return_value=Path(sys.executable),
        ), patch.object(
            tray_app,
            "ensure_start_protocol_registered",
        ) as register, patch.object(tray_app.threading, "Thread") as thread:
            tray_app.TrayApp(
                start_background_tasks=False,
                enable_windows_protocol=False,
            )

        register.assert_not_called()
        thread.assert_not_called()

    def test_normal_tray_start_registers_protocol_and_opens_fixed_action_events(self):
        pythonw = Path(r"C:\Conda Env\pythonw.exe")
        events = []
        def make_event(name):
            event = Mock(name=name)
            event.create.return_value = event
            event.name = name
            events.append(event)
            return event
        created_threads = []

        class FakeThread:
            def __init__(self, target=None, daemon=None):
                self.target = target
                self.daemon = daemon
                created_threads.append(self)

            def start(self):
                return None

        with patch.object(
            tray_app,
            "find_conda_python",
            return_value=Path(sys.executable),
        ), patch.object(
            tray_app,
            "find_conda_pythonw",
            return_value=pythonw,
        ), patch.object(
            tray_app,
            "ensure_start_protocol_registered",
        ) as register, patch.object(
            tray_app,
            "WindowsNamedAutoResetEvent",
            side_effect=make_event,
        ) as event_class, patch.object(
            tray_app.threading,
            "Thread",
            FakeThread,
        ):
            tray_app.TrayApp(
                start_background_tasks=True,
                enable_windows_protocol=True,
            )

        register.assert_called_once_with(pythonw, tray_app.SCRIPT_DIR / "tray_app.py")
        self.assertEqual(
            [call.args[0] for call in event_class.call_args_list],
            [
                tray_app.START_SERVER_EVENT_NAME,
                tray_app.START_OLLAMA_EVENT_NAME,
                tray_app.OPEN_REMOTE_EVENT_NAME,
            ],
        )
        for event in events:
            event.create.assert_called_once_with()
        self.assertGreaterEqual(len(created_threads), 4)

    def test_primary_tray_starts_server_when_protocol_event_is_signaled(self):
        with patch.object(
            tray_app,
            "find_conda_python",
            return_value=Path(sys.executable),
        ):
            app = tray_app.TrayApp(
                start_background_tasks=False,
                enable_windows_protocol=False,
            )
        app.start_server = Mock(side_effect=app._protocol_listener_stop.set)
        app._start_server_event = Mock()
        app._start_server_event.wait.return_value = True

        app._listen_for_start_server_requests()

        app._start_server_event.wait.assert_called_once_with(timeout_ms=500)
        app.start_server.assert_called_once_with()

    def test_primary_tray_starts_ollama_when_protocol_event_is_signaled(self):
        with patch.object(tray_app, "find_conda_python", return_value=Path(sys.executable)):
            app = tray_app.TrayApp(
                start_background_tasks=False,
                enable_windows_protocol=False,
            )
        app.start_local_ollama = Mock(side_effect=app._protocol_listener_stop.set)
        app._start_ollama_event = Mock()
        app._start_ollama_event.wait.return_value = True

        app._listen_for_start_ollama_requests()

        app.start_local_ollama.assert_called_once_with()

    def test_primary_tray_opens_remote_dialog_when_protocol_event_is_signaled(self):
        with patch.object(tray_app, "find_conda_python", return_value=Path(sys.executable)):
            app = tray_app.TrayApp(
                start_background_tasks=False,
                enable_windows_protocol=False,
            )
        app.open_remote_service_settings = Mock(side_effect=app._protocol_listener_stop.set)
        app._open_remote_event = Mock()
        app._open_remote_event.wait.return_value = True

        app._listen_for_remote_service_requests()

        app.open_remote_service_settings.assert_called_once_with()

    def test_quit_releases_protocol_listener_resources(self):
        with patch.object(
            tray_app,
            "find_conda_python",
            return_value=Path(sys.executable),
        ):
            app = tray_app.TrayApp(
                start_background_tasks=False,
                enable_windows_protocol=False,
            )
        app._start_server_event = Mock()
        app._start_ollama_event = Mock()
        app._open_remote_event = Mock()
        app._stop_remote_ollama_tunnel = Mock()
        app.stop_server = Mock()

        with patch.object(tray_app.os, "_exit"):
            app.quit_app()

        self.assertTrue(app._protocol_listener_stop.is_set())
        app._start_server_event.close.assert_called_once_with()
        app._start_ollama_event.close.assert_called_once_with()
        app._open_remote_event.close.assert_called_once_with()

    def test_second_protocol_launch_signals_primary_tray_and_exits(self):
        mutex = Mock()
        mutex.acquire.return_value = False

        with patch.object(
            tray_app,
            "WindowsNamedMutex",
            return_value=mutex,
        ), patch.object(
            tray_app.WindowsNamedAutoResetEvent,
            "signal_existing",
            return_value=True,
        ) as signal_existing, patch.object(tray_app, "TrayApp") as tray_class:
            result = tray_app.main(["localreadtranslate://start"])

        self.assertEqual(result, 0)
        signal_existing.assert_called_once_with(tray_app.START_SERVER_EVENT_NAME)
        tray_class.assert_not_called()
        mutex.close.assert_not_called()

    def test_second_protocol_launch_routes_each_fixed_action_to_its_event(self):
        for url, event_name in (
            ("localreadtranslate://ollama", tray_app.START_OLLAMA_EVENT_NAME),
            ("localreadtranslate://remote", tray_app.OPEN_REMOTE_EVENT_NAME),
        ):
            with self.subTest(url=url):
                mutex = Mock()
                mutex.acquire.return_value = False
                with patch.object(
                    tray_app, "WindowsNamedMutex", return_value=mutex
                ), patch.object(
                    tray_app.WindowsNamedAutoResetEvent,
                    "signal_existing",
                    return_value=True,
                ) as signal_existing, patch.object(tray_app, "TrayApp") as tray_class:
                    result = tray_app.main([url])

                self.assertEqual(result, 0)
                signal_existing.assert_called_once_with(event_name)
                tray_class.assert_not_called()


class TrayLocalOllamaTests(unittest.TestCase):
    def make_app(self):
        with patch.object(tray_app, "find_conda_python", return_value=Path(sys.executable)):
            return tray_app.TrayApp(
                start_background_tasks=False,
                enable_windows_protocol=False,
            )

    def test_start_local_ollama_is_idempotent_when_native_health_is_reachable(self):
        app = self.make_app()
        with patch.object(app, "local_ollama_is_reachable", return_value=True), patch.object(
            tray_app.subprocess, "Popen"
        ) as popen:
            self.assertTrue(app.start_local_ollama())
        popen.assert_not_called()

    def test_start_local_ollama_launches_installed_serve_hidden(self):
        app = self.make_app()
        executable = Path(r"C:\Users\Example\AppData\Local\Programs\Ollama\ollama.exe")
        process = Mock()
        with patch.object(
            app,
            "local_ollama_is_reachable",
            side_effect=[False, True],
        ), patch.object(
            app,
            "find_ollama_executable",
            return_value=executable,
        ), patch.object(
            tray_app.subprocess,
            "Popen",
            return_value=process,
        ) as popen, patch.object(tray_app.time, "sleep"):
            self.assertTrue(app.start_local_ollama())

        args, kwargs = popen.call_args
        self.assertEqual(args[0], [str(executable), "serve"])
        self.assertIs(kwargs["stdout"], tray_app.subprocess.DEVNULL)
        self.assertIs(kwargs["stderr"], tray_app.subprocess.DEVNULL)
        self.assertEqual(kwargs["creationflags"], getattr(tray_app.subprocess, "CREATE_NO_WINDOW", 0))


class TrayRemoteOllamaTests(unittest.TestCase):
    def make_app(self):
        with patch.object(
            tray_app,
            "find_conda_python",
            return_value=Path(sys.executable),
        ), patch.object(tray_app, "reconcile_startup_shortcut"), patch.object(
            tray_app.TrayApp,
            "_init_and_reconcile_auto_start",
        ):
            return tray_app.TrayApp(
                start_background_tasks=False,
                enable_windows_protocol=False,
            )

    def test_default_settings_include_remote_ollama(self):
        with patch.object(
            tray_app,
            "SETTINGS_FILE",
            Path("__missing_tray_settings_for_test__.json"),
        ):
            settings = tray_app.load_settings()

        self.assertEqual(
            settings["remote_ollama"],
            {
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
            },
        )

    def test_legacy_remote_settings_are_migrated_without_losing_values(self):
        legacy = {
            "remote_ollama": {
                "enabled": True,
                "name": "Old Server",
                "host": "192.168.1.10",
                "ssh_port": 2222,
                "username": "alice",
                "password": "secret",
                "ollama_host": "127.0.0.1",
                "ollama_port": 11434,
                "local_port": 49152,
            }
        }
        fake_path = Mock()
        fake_path.exists.return_value = True

        with patch.object(tray_app, "SETTINGS_FILE", fake_path), patch(
            "builtins.open",
            mock_open(read_data=json.dumps(legacy)),
        ):
            settings = tray_app.load_settings()

        remote = settings["remote_ollama"]
        self.assertEqual(remote["host"], "192.168.1.10")
        self.assertEqual(remote["username"], "alice")
        self.assertEqual(remote["password"], "secret")
        self.assertEqual(remote["connection_mode"], "ssh")
        self.assertEqual(remote["key_file"], "")
        self.assertEqual(remote["base_url"], "http://192.168.1.10:11434")

    def _start_tunnel_with_fake_paramiko(self, settings, ssh_config=None):
        connect_calls = []
        transport = Mock()
        transport.is_active.return_value = True
        client = Mock()
        client.get_transport.return_value = transport
        client.connect.side_effect = lambda **kwargs: connect_calls.append(kwargs)
        reject_policy = object()
        fake_paramiko = SimpleNamespace(
            SSHClient=Mock(return_value=client),
            AutoAddPolicy=Mock(return_value=object()),
            RejectPolicy=Mock(return_value=reject_policy),
        )

        class FakeForwardServer:
            allow_reuse_address = True
            daemon_threads = True

            def __init__(self, _address, _handler):
                self.server_address = ("127.0.0.1", 49152)

            def serve_forever(self):
                return None

            def shutdown(self):
                return None

            def server_close(self):
                return None

        class FakeThread:
            def __init__(self, target=None, daemon=None):
                self.target = target
                self.daemon = daemon

            def start(self):
                return None

        with patch.dict(sys.modules, {"paramiko": fake_paramiko}), patch.object(
            tray_app.socketserver,
            "ThreadingTCPServer",
            FakeForwardServer,
        ), patch.object(tray_app.threading, "Thread", FakeThread), patch.object(
            tray_app,
            "_load_openssh_host_config",
            return_value=ssh_config or {},
            create=True,
        ):
            tunnel = tray_app.RemoteOllamaTunnel(settings)
            tunnel.start()
            tunnel.stop()

        client.load_system_host_keys.assert_called_once_with()
        client.set_missing_host_key_policy.assert_called_once_with(reject_policy)
        fake_paramiko.AutoAddPolicy.assert_not_called()
        return connect_calls

    def test_remote_tunnel_uses_openssh_key_and_agent_without_password(self):
        calls = self._start_tunnel_with_fake_paramiko(
            {
                "host": "10.12.96.203",
                "username": "test",
                "ssh_port": 22,
                "password": "",
                "key_file": "",
            },
            ssh_config={
                "hostname": "10.12.96.203",
                "user": "test",
                "identityfile": [r"C:\Users\YanShibo\.ssh\ai_server_key"],
            },
        )

        self.assertEqual(len(calls), 1)
        kwargs = calls[0]
        self.assertEqual(kwargs["hostname"], "10.12.96.203")
        self.assertEqual(kwargs["username"], "test")
        self.assertEqual(
            kwargs["key_filename"],
            r"C:\Users\YanShibo\.ssh\ai_server_key",
        )
        self.assertTrue(kwargs["look_for_keys"])
        self.assertTrue(kwargs["allow_agent"])
        self.assertNotIn("password", kwargs)

    def test_explicit_key_file_and_password_are_passed_for_paramiko_fallback(self):
        calls = self._start_tunnel_with_fake_paramiko(
            {
                "host": "10.12.96.203",
                "username": "test",
                "password": "secret",
                "key_file": r"D:\keys\explicit_ed25519",
            },
            ssh_config={
                "identityfile": [r"C:\Users\YanShibo\.ssh\config_key"],
            },
        )

        self.assertEqual(len(calls), 1)
        kwargs = calls[0]
        self.assertEqual(kwargs["key_filename"], r"D:\keys\explicit_ed25519")
        self.assertEqual(kwargs["password"], "secret")
        self.assertTrue(kwargs["look_for_keys"])
        self.assertTrue(kwargs["allow_agent"])

    def test_openssh_config_loader_looks_up_the_requested_host(self):
        parsed_config = Mock()
        parsed_config.lookup.return_value = {
            "user": "test",
            "identityfile": [r"C:\Users\YanShibo\.ssh\ai_server_key"],
        }
        fake_paramiko = SimpleNamespace(SSHConfig=Mock(return_value=parsed_config))

        with patch.object(Path, "is_file", return_value=True), patch(
            "builtins.open",
            mock_open(read_data="Host ai-server 10.12.96.203\n"),
        ):
            result = tray_app._load_openssh_host_config(
                fake_paramiko,
                "10.12.96.203",
            )

        parsed_config.parse.assert_called_once()
        parsed_config.lookup.assert_called_once_with("10.12.96.203")
        self.assertEqual(result["user"], "test")

    def test_remote_source_env_omits_password(self):
        app = self.make_app()
        app.settings["remote_ollama"] = {
            "enabled": True,
            "name": "Lab Server",
            "host": "192.168.1.10",
            "ssh_port": 22,
            "username": "alice",
            "password": "secret",
            "ollama_host": "127.0.0.1",
            "ollama_port": 11434,
            "local_port": 49152,
        }
        app.remote_tunnel_local_port = 49152

        payload = app.build_remote_ollama_sources_env()

        self.assertEqual(
            json.loads(payload),
            [
                {
                    "id": "lab-server",
                    "name": "Lab Server",
                    "base_url": "http://127.0.0.1:49152",
                }
            ],
        )
        self.assertNotIn("secret", payload)

    def test_ssh_source_env_does_not_publish_a_stale_persisted_port(self):
        app = self.make_app()
        app.settings["remote_ollama"] = {
            **tray_app.default_remote_ollama_settings(),
            "enabled": True,
            "connection_mode": "ssh",
            "name": "Project Server",
            "local_port": 49152,
        }
        app.remote_tunnel = None
        app.remote_tunnel_local_port = None

        self.assertEqual(app.build_remote_ollama_sources_env(), "")

    def test_direct_api_source_env_does_not_require_a_tunnel(self):
        app = self.make_app()
        app.settings["remote_ollama"] = {
            "enabled": True,
            "name": "AI Server",
            "connection_mode": "api",
            "host": "10.12.96.203",
            "base_url": "http://10.12.96.203:11434/",
        }
        app.remote_tunnel_local_port = None

        payload = json.loads(app.build_remote_ollama_sources_env())

        self.assertEqual(
            payload,
            [
                {
                    "id": "ai-server",
                    "name": "AI Server",
                    "base_url": "http://10.12.96.203:11434",
                }
            ],
        )

    def test_direct_api_probe_calls_api_tags(self):
        response = Mock()
        response.status = 200
        response.read.return_value = b'{"models": []}'
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        opener = Mock()
        opener.open.return_value = response

        with patch.object(
            tray_app.urllib.request,
            "build_opener",
            return_value=opener,
        ) as build_opener, patch.object(
            tray_app.urllib.request,
            "urlopen",
            side_effect=AssertionError("proxy-aware urlopen must not be used"),
        ):
            app = self.make_app()
            app._test_remote_ollama_api("http://10.12.96.203:11434/")

        handler = build_opener.call_args.args[0]
        self.assertIsInstance(handler, tray_app.urllib.request.ProxyHandler)
        self.assertEqual(handler.proxies, {})
        opener.open.assert_called_once_with(
            "http://10.12.96.203:11434/api/tags",
            timeout=5,
        )

    def test_connect_direct_api_does_not_create_an_ssh_tunnel(self):
        app = self.make_app()
        previous = dict(app.settings["remote_ollama"])
        candidate = {
            **previous,
            "enabled": True,
            "name": "AI Server",
            "connection_mode": "api",
            "host": "10.12.96.203",
            "base_url": "http://10.12.96.203:11434",
        }
        app.restart_server = Mock()

        with patch.object(app, "_test_remote_ollama_api") as probe, patch.object(
            tray_app,
            "RemoteOllamaTunnel",
        ) as tunnel_class, patch.object(tray_app, "save_settings") as save:
            app.connect_remote_ollama(candidate)

        probe.assert_called_once_with("http://10.12.96.203:11434")
        tunnel_class.assert_not_called()
        self.assertEqual(
            app.settings["remote_ollama"],
            {**candidate, "local_port": 0},
        )
        self.assertIsNone(app.remote_tunnel)
        self.assertIsNone(app.remote_tunnel_local_port)
        save.assert_called_once_with(app.settings)
        app.restart_server.assert_called_once()

    def test_failed_connection_preserves_previous_working_settings_and_tunnel(self):
        app = self.make_app()
        previous = {
            **tray_app.default_remote_ollama_settings(),
            "enabled": True,
            "name": "Working Server",
            "host": "192.168.1.10",
            "local_port": 49152,
        }
        app.settings["remote_ollama"] = dict(previous)
        old_tunnel = Mock()
        app.remote_tunnel = old_tunnel
        app.remote_tunnel_local_port = 49152
        app.restart_server = Mock()
        candidate = {
            **previous,
            "name": "Broken Server",
            "host": "10.12.96.203",
            "local_port": 0,
        }
        failed_tunnel = Mock()
        failed_tunnel.start.side_effect = RuntimeError("authentication failed")

        with patch.object(
            tray_app,
            "RemoteOllamaTunnel",
            return_value=failed_tunnel,
        ), patch.object(tray_app, "save_settings") as save:
            with self.assertRaisesRegex(RuntimeError, "authentication failed"):
                app.connect_remote_ollama(candidate)

        self.assertEqual(app.settings["remote_ollama"], previous)
        self.assertIs(app.remote_tunnel, old_tunnel)
        self.assertEqual(app.remote_tunnel_local_port, 49152)
        old_tunnel.stop.assert_not_called()
        failed_tunnel.stop.assert_called_once()
        save.assert_not_called()
        app.restart_server.assert_not_called()

    def test_startup_connection_failure_does_not_disable_saved_profile(self):
        app = self.make_app()
        saved = {
            **tray_app.default_remote_ollama_settings(),
            "enabled": True,
            "host": "10.12.96.203",
        }
        app.settings["remote_ollama"] = dict(saved)
        app.show_error = Mock()
        failed_tunnel = Mock()
        failed_tunnel.start.side_effect = RuntimeError("offline")

        with patch.object(
            tray_app,
            "RemoteOllamaTunnel",
            return_value=failed_tunnel,
        ), patch.object(tray_app, "save_settings") as save:
            connected = app.ensure_remote_ollama_tunnel()

        self.assertFalse(connected)
        self.assertEqual(app.settings["remote_ollama"], saved)
        self.assertTrue(app.settings["remote_ollama"]["enabled"])
        save.assert_not_called()
        app.show_error.assert_called_once_with("Remote Service", "offline")

    def test_remote_dialog_saves_mode_key_file_and_direct_api_url(self):
        app = self.make_app()
        created_entries = []
        created_mode_vars = []
        option_menus = []
        buttons = {}

        class FakeWidget:
            def __init__(self, _parent=None, **kwargs):
                self.value = ""
                self.command = kwargs.get("command")
                self.text = kwargs.get("text")

            def grid(self, **_kwargs):
                return self

            def pack(self, **_kwargs):
                return self

            def insert(self, _index, value):
                self.value = str(value)

            def get(self):
                return self.value

            def focus_set(self):
                return None

            def config(self, **_kwargs):
                return None

        class FakeStringVar:
            def __init__(self, value=""):
                self.value = value
                created_mode_vars.append(self)

            def get(self):
                return self.value

            def set(self, value):
                self.value = value

        class FakeWindow(FakeWidget):
            def title(self, _value):
                return None

            def resizable(self, _width, _height):
                return None

            def after(self, _delay, _callback):
                return None

            def focus_force(self):
                return None

            def update_idletasks(self):
                return None

            def destroy(self):
                return None

            def mainloop(self):
                created_mode_vars[0].set("api")
                created_entries[5].value = r"D:\keys\ai_server_ed25519"
                created_entries[8].value = "http://10.12.96.203:11434/"
                buttons["Save"].command()

        def make_entry(parent=None, **kwargs):
            entry = FakeWidget(parent, **kwargs)
            created_entries.append(entry)
            return entry

        def make_option_menu(parent, variable, *values):
            option_menus.append((variable, values))
            return FakeWidget(parent)

        def make_button(parent=None, **kwargs):
            button = FakeWidget(parent, **kwargs)
            buttons[button.text] = button
            return button

        fake_tkinter = SimpleNamespace(
            Tk=FakeWindow,
            Label=FakeWidget,
            Entry=make_entry,
            StringVar=FakeStringVar,
            OptionMenu=make_option_menu,
            Frame=FakeWidget,
            Button=make_button,
            messagebox=SimpleNamespace(showerror=Mock(), showinfo=Mock()),
        )

        with patch.dict(sys.modules, {"tkinter": fake_tkinter}), patch.object(
            tray_app,
            "save_settings",
        ) as save:
            app._run_remote_service_settings_dialog()

        self.assertEqual(option_menus[0][1], ("ssh", "api"))
        remote = app.settings["remote_ollama"]
        self.assertEqual(remote["connection_mode"], "api")
        self.assertEqual(remote["key_file"], r"D:\keys\ai_server_ed25519")
        self.assertEqual(remote["base_url"], "http://10.12.96.203:11434")
        save.assert_called_once_with(app.settings)

    def test_remote_service_dialog_opens_on_background_thread(self):
        app = self.make_app()
        started = []

        class FakeThread:
            def __init__(self, target=None, daemon=None):
                self.target = target
                self.daemon = daemon

            def start(self):
                started.append(self)

        def raise_if_tk_opens_synchronously():
            raise AssertionError("dialog should not open synchronously")

        fake_tkinter = SimpleNamespace(
            Tk=raise_if_tk_opens_synchronously,
            messagebox=SimpleNamespace(),
        )

        with patch.dict(sys.modules, {"tkinter": fake_tkinter}), patch.object(
            tray_app.threading,
            "Thread",
            side_effect=lambda target=None, daemon=None: FakeThread(target, daemon),
        ):
            app.open_remote_service_settings()

        self.assertEqual(len(started), 1)
        self.assertTrue(started[0].daemon)
        self.assertIs(started[0].target.__self__, app)
        self.assertIs(
            started[0].target.__func__,
            app._run_remote_service_settings_dialog.__func__,
        )


if __name__ == "__main__":
    unittest.main()
