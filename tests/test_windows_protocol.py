import unittest
from io import StringIO
from pathlib import Path

from windows_protocol import (
    OLLAMA_PROTOCOL_URL,
    PROTOCOL_REGISTRY_PATH,
    REMOTE_PROTOCOL_URL,
    START_PROTOCOL_URL,
    ProtocolRegistrationError,
    build_start_protocol_command,
    ensure_start_protocol_registered,
    is_start_protocol_url,
    main as protocol_main,
    parse_protocol_action,
    unregister_start_protocol,
)


class FakeRegistry:
    HKEY_CURRENT_USER = "HKCU"
    REG_SZ = 1
    KEY_READ = 0x20019
    KEY_WRITE = 0x20006

    class Key:
        def __init__(self, registry, path):
            self.registry = registry
            self.path = path

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

    def __init__(self):
        self.values = {}
        self.keys = set()

    def CreateKeyEx(self, root, path, _reserved=0, _access=0):
        self.assert_root(root)
        parts = path.split("\\")
        for index in range(1, len(parts) + 1):
            self.keys.add("\\".join(parts[:index]))
        return self.Key(self, path)

    def QueryValueEx(self, key, name):
        lookup = (key.path, name)
        if lookup not in self.values:
            raise FileNotFoundError(lookup)
        return self.values[lookup], self.REG_SZ

    def SetValueEx(self, key, name, _reserved, _kind, value):
        self.values[(key.path, name)] = value

    def DeleteKey(self, root, path):
        self.assert_root(root)
        if path not in self.keys:
            raise FileNotFoundError(path)
        prefix = path + "\\"
        if any(key.startswith(prefix) for key in self.keys):
            raise OSError(f"key has children: {path}")
        self.keys.remove(path)
        self.values = {
            key: value
            for key, value in self.values.items()
            if key[0] != path
        }

    def assert_root(self, root):
        if root != self.HKEY_CURRENT_USER:
            raise AssertionError(f"unexpected registry root: {root}")


class NonPersistingRegistry(FakeRegistry):
    def SetValueEx(self, _key, _name, _reserved, _kind, _value):
        return None


class WindowsProtocolCommandTests(unittest.TestCase):
    def test_command_quotes_python_script_and_protocol_url(self):
        command = build_start_protocol_command(
            Path(r"C:\Users\Example User\.conda\envs\kokoro-tts\pythonw.exe"),
            Path(r"D:\Local Read Translate\tray_app.py"),
        )

        self.assertEqual(
            command,
            '"C:\\Users\\Example User\\.conda\\envs\\kokoro-tts\\pythonw.exe" '
            '"D:\\Local Read Translate\\tray_app.py" "%1"',
        )

    def test_registration_creates_per_user_url_protocol_values(self):
        registry = FakeRegistry()

        changed = ensure_start_protocol_registered(
            Path(r"C:\Conda Env\pythonw.exe"),
            Path(r"D:\LocalReadTranslate\tray_app.py"),
            registry=registry,
            platform_name="nt",
        )

        command_path = PROTOCOL_REGISTRY_PATH + r"\shell\open\command"
        self.assertTrue(changed)
        self.assertEqual(
            registry.values[(PROTOCOL_REGISTRY_PATH, "")],
            "URL:LocalReadTranslate Protocol",
        )
        self.assertEqual(registry.values[(PROTOCOL_REGISTRY_PATH, "URL Protocol")], "")
        self.assertEqual(
            registry.values[(command_path, "")],
            '"C:\\Conda Env\\pythonw.exe" '
            '"D:\\LocalReadTranslate\\tray_app.py" "%1"',
        )

    def test_registration_fails_when_written_values_cannot_be_verified(self):
        with self.assertRaisesRegex(ProtocolRegistrationError, "verify"):
            ensure_start_protocol_registered(
                Path(r"C:\Conda Env\pythonw.exe"),
                Path(r"D:\LocalReadTranslate\tray_app.py"),
                registry=NonPersistingRegistry(),
                platform_name="nt",
            )

    def test_fixed_protocol_actions_are_parsed_without_payloads(self):
        self.assertTrue(is_start_protocol_url("localreadtranslate://start"))
        self.assertTrue(is_start_protocol_url("LOCALREADTRANSLATE://START/"))
        self.assertEqual(parse_protocol_action(START_PROTOCOL_URL), "start")
        self.assertEqual(parse_protocol_action(OLLAMA_PROTOCOL_URL), "ollama")
        self.assertEqual(parse_protocol_action(REMOTE_PROTOCOL_URL), "remote")
        self.assertEqual(parse_protocol_action("LOCALREADTRANSLATE://REMOTE/"), "remote")

    def test_protocol_parser_rejects_unknown_or_parameterized_actions(self):
        self.assertIsNone(parse_protocol_action("localreadtranslate://settings"))
        self.assertIsNone(parse_protocol_action("localreadtranslate://ollama/extra"))
        self.assertIsNone(parse_protocol_action("localreadtranslate://remote?host=secret"))
        self.assertIsNone(parse_protocol_action("localreadtranslate://remote#dialog"))
        self.assertIsNone(parse_protocol_action("https://start"))
        self.assertFalse(is_start_protocol_url("localreadtranslate://remote"))
        self.assertFalse(is_start_protocol_url("https://start"))

    def test_register_cli_defaults_to_current_pythonw_and_sibling_tray_script(self):
        registry = FakeRegistry()
        output = StringIO()

        result = protocol_main(
            ["register"],
            platform_name="nt",
            registry=registry,
            executable=Path(r"C:\Conda Env\python.exe"),
            module_path=Path(r"D:\LocalReadTranslate\windows_protocol.py"),
            stdout=output,
        )

        command_path = PROTOCOL_REGISTRY_PATH + r"\shell\open\command"
        self.assertEqual(result, 0)
        self.assertEqual(
            registry.values[(command_path, "")],
            '"C:\\Conda Env\\pythonw.exe" '
            '"D:\\LocalReadTranslate\\tray_app.py" "%1"',
        )
        self.assertIn(r"HKCU\Software\Classes\localreadtranslate", output.getvalue())

    def test_unregister_removes_only_the_per_user_protocol_tree_and_is_idempotent(self):
        registry = FakeRegistry()
        ensure_start_protocol_registered(
            Path(r"C:\Conda Env\pythonw.exe"),
            Path(r"D:\LocalReadTranslate\tray_app.py"),
            registry=registry,
            platform_name="nt",
        )
        registry.keys.add(r"Software\Classes\unrelated")
        registry.values[(r"Software\Classes\unrelated", "")] = "keep"

        self.assertTrue(
            unregister_start_protocol(registry=registry, platform_name="nt")
        )
        self.assertFalse(
            unregister_start_protocol(registry=registry, platform_name="nt")
        )

        self.assertFalse(
            any(
                key == PROTOCOL_REGISTRY_PATH
                or key.startswith(PROTOCOL_REGISTRY_PATH + "\\")
                for key in registry.keys
            )
        )
        self.assertEqual(
            registry.values[(r"Software\Classes\unrelated", "")],
            "keep",
        )

    def test_unregister_cli_removes_registered_handler(self):
        registry = FakeRegistry()
        ensure_start_protocol_registered(
            Path(r"C:\Conda Env\pythonw.exe"),
            Path(r"D:\LocalReadTranslate\tray_app.py"),
            registry=registry,
            platform_name="nt",
        )
        output = StringIO()

        result = protocol_main(
            ["unregister"],
            platform_name="nt",
            registry=registry,
            stdout=output,
        )

        self.assertEqual(result, 0)
        self.assertNotIn(PROTOCOL_REGISTRY_PATH, registry.keys)
        self.assertIn("removed", output.getvalue())


if __name__ == "__main__":
    unittest.main()
