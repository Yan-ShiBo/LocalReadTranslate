import os
from io import StringIO
from pathlib import Path
from unittest.mock import patch

import pytest

import windows_startup


class FakeShortcutRunner:
    def __init__(self):
        self.shortcuts = {}
        self.create_calls = 0
        self.inspect_calls = 0
        self.fail_on_create = False

    def __call__(self, script, env):
        shortcut = Path(env["KOKORO_SHORTCUT"])
        if script == windows_startup.CREATE_SHORTCUT_SCRIPT:
            self.create_calls += 1
            if self.fail_on_create:
                raise RuntimeError("powershell failed")
            shortcut.parent.mkdir(parents=True, exist_ok=True)
            shortcut.write_text("shortcut", encoding="utf-8")
            self.shortcuts[shortcut] = {
                "target": str(Path(env["KOKORO_TARGET"]).resolve()),
                "working_directory": str(Path(env["KOKORO_WORKDIR"]).resolve()),
                "arguments": env.get("KOKORO_ARGUMENTS", ""),
            }
            return None
        if script == windows_startup.INSPECT_SHORTCUT_SCRIPT:
            self.inspect_calls += 1
            return self.shortcuts.get(shortcut, {
                "target": "",
                "working_directory": "",
                "arguments": "",
            })
        raise AssertionError("unexpected script")


@pytest.fixture
def startup_env(tmp_path):
    with patch.dict(os.environ, {"APPDATA": str(tmp_path)}):
        yield tmp_path


def test_enabled_creates_missing_shortcut(startup_env):
    runner = FakeShortcutRunner()
    target = startup_env / "Kokoro TTS.pyw"
    workdir = startup_env / "project"

    assert windows_startup.reconcile_startup_shortcut(True, target, workdir, runner)

    shortcut = windows_startup.startup_shortcut_path()
    assert shortcut.exists()
    assert runner.create_calls == 1
    assert windows_startup.inspect_startup_shortcut(target, workdir, runner)
    assert windows_startup.startup_shortcut_path().name == "Local Read & Translate.lnk"


def test_enabled_repairs_wrong_shortcut(startup_env):
    runner = FakeShortcutRunner()
    target = startup_env / "Kokoro TTS.pyw"
    workdir = startup_env / "project"
    shortcut = windows_startup.startup_shortcut_path()
    shortcut.parent.mkdir(parents=True, exist_ok=True)
    shortcut.write_text("wrong", encoding="utf-8")
    runner.shortcuts[shortcut] = {
        "target": str(startup_env / "old.pyw"),
        "working_directory": str(startup_env / "old"),
    }

    assert windows_startup.reconcile_startup_shortcut(True, target, workdir, runner)

    assert runner.create_calls == 1
    assert windows_startup.inspect_startup_shortcut(target, workdir, runner)


def test_enabled_leaves_correct_shortcut_unchanged(startup_env):
    runner = FakeShortcutRunner()
    target = startup_env / "Kokoro TTS.pyw"
    workdir = startup_env / "project"
    shortcut = windows_startup.startup_shortcut_path()
    shortcut.parent.mkdir(parents=True, exist_ok=True)
    shortcut.write_text("correct", encoding="utf-8")
    runner.shortcuts[shortcut] = {
        "target": str(target.resolve()),
        "working_directory": str(workdir.resolve()),
    }

    assert windows_startup.reconcile_startup_shortcut(True, target, workdir, runner)

    assert runner.create_calls == 0
    assert runner.inspect_calls == 1


def test_disabled_removes_only_named_shortcut(startup_env):
    runner = FakeShortcutRunner()
    target = startup_env / "Kokoro TTS.pyw"
    workdir = startup_env / "project"
    shortcut = windows_startup.startup_shortcut_path()
    other = shortcut.parent / "Other App.lnk"
    shortcut.parent.mkdir(parents=True, exist_ok=True)
    shortcut.write_text("remove", encoding="utf-8")
    other.write_text("keep", encoding="utf-8")

    assert not windows_startup.reconcile_startup_shortcut(False, target, workdir, runner)

    assert not shortcut.exists()
    assert other.exists()


def test_addin_loader_startup_is_distinct_from_full_app_autostart(startup_env):
    runner = FakeShortcutRunner()
    pythonw = startup_env / "pythonw.exe"
    workdir = startup_env / "LocalReadTranslate"
    host = workdir / "addon_host.py"
    pid_file = startup_env / "LocalReadTranslate" / "addin-host-standalone.pid"
    arguments = f'-E "{host}" --pid-file "{pid_file}"'
    full_app_shortcut = windows_startup.startup_shortcut_path()
    full_app_shortcut.parent.mkdir(parents=True, exist_ok=True)
    full_app_shortcut.write_text("keep", encoding="utf-8")

    assert windows_startup.reconcile_addin_loader_startup_shortcut(
        True,
        pythonw,
        workdir,
        arguments,
        runner,
    )

    loader_shortcut = windows_startup.addin_loader_startup_shortcut_path()
    assert loader_shortcut.name == "LocalReadTranslate Add-in Loader.lnk"
    assert loader_shortcut.exists()
    assert full_app_shortcut.exists()
    assert windows_startup.inspect_addin_loader_startup_shortcut(
        pythonw,
        workdir,
        arguments,
        runner,
    )


def test_cli_installs_addin_loader_without_enabling_full_app(startup_env):
    pythonw = startup_env / "pythonw.exe"
    workdir = startup_env / "LocalReadTranslate"
    host = workdir / "addon_host.py"
    pid_file = startup_env / "LocalReadTranslate" / "addin-host-standalone.pid"
    stdout = StringIO()
    stderr = StringIO()

    with patch.object(
        windows_startup,
        "reconcile_addin_loader_startup_shortcut",
        return_value=True,
    ) as reconcile:
        result = windows_startup.main(
            [
                "install-addin-loader",
                "--pythonw",
                str(pythonw),
                "--host",
                str(host),
                "--workdir",
                str(workdir),
                "--pid-file",
                str(pid_file),
            ],
            stdout=stdout,
            stderr=stderr,
        )

    assert result == 0
    reconcile.assert_called_once_with(
        True,
        pythonw,
        workdir,
        f'-E "{host}" --pid-file "{pid_file}"',
    )
    assert "Add-in loader startup installed" in stdout.getvalue()
    assert stderr.getvalue() == ""


def test_cli_removes_only_addin_loader_startup(startup_env):
    loader = windows_startup.addin_loader_startup_shortcut_path()
    full_app = windows_startup.startup_shortcut_path()
    loader.parent.mkdir(parents=True, exist_ok=True)
    loader.write_text("remove", encoding="utf-8")
    full_app.write_text("keep", encoding="utf-8")
    stdout = StringIO()
    stderr = StringIO()

    result = windows_startup.main(
        ["remove-addin-loader"],
        stdout=stdout,
        stderr=stderr,
    )

    assert result == 0
    assert not loader.exists()
    assert full_app.exists()
    assert "Add-in loader startup removed" in stdout.getvalue()
    assert stderr.getvalue() == ""


def test_runner_failure_raises_startup_error(startup_env):
    runner = FakeShortcutRunner()
    runner.fail_on_create = True

    with pytest.raises(windows_startup.StartupShortcutError):
        windows_startup.reconcile_startup_shortcut(
            True,
            startup_env / "Kokoro TTS.pyw",
            startup_env / "project",
            runner,
        )


def test_start_menu_shortcut_replaces_owned_legacy_link(startup_env):
    runner = FakeShortcutRunner()
    target = startup_env / "pythonw.exe"
    workdir = startup_env / "LocalReadTranslate"
    launcher = workdir / "windows_launcher.py"
    arguments = f'-E "{launcher}"'
    legacy = windows_startup.start_menu_shortcut_path("Kokoro TTS.lnk")
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text("legacy", encoding="utf-8")
    runner.shortcuts[legacy] = {
        "target": str(target),
        "working_directory": r"d:\local-tts-env",
        "arguments": r'"d:\local-tts-env\tray_app.py"',
    }

    shortcut = windows_startup.reconcile_start_menu_shortcut(
        target,
        workdir,
        arguments,
        runner,
    )

    assert shortcut.name == "Local Read & Translate.lnk"
    assert shortcut.exists()
    assert not legacy.exists()
    assert windows_startup.inspect_start_menu_shortcut(
        target,
        workdir,
        arguments,
        runner,
    )


def test_start_menu_migration_preserves_unrelated_legacy_named_link(startup_env):
    runner = FakeShortcutRunner()
    target = startup_env / "pythonw.exe"
    workdir = startup_env / "LocalReadTranslate"
    legacy = windows_startup.start_menu_shortcut_path("Kokoro TTS.lnk")
    legacy.parent.mkdir(parents=True, exist_ok=True)
    legacy.write_text("unrelated", encoding="utf-8")
    runner.shortcuts[legacy] = {
        "target": str(startup_env / "other.exe"),
        "working_directory": str(startup_env / "other"),
        "arguments": "",
    }

    windows_startup.reconcile_start_menu_shortcut(
        target,
        workdir,
        f'-E "{workdir / "windows_launcher.py"}"',
        runner,
    )

    assert legacy.exists()
