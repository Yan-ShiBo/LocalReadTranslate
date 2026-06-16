import os
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
            }
            return None
        if script == windows_startup.INSPECT_SHORTCUT_SCRIPT:
            self.inspect_calls += 1
            return self.shortcuts.get(shortcut, {
                "target": "",
                "working_directory": "",
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
