import sys
import unittest
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import Mock, patch

import tray_app
from windows_startup import StartupShortcutError


class TrayOwnershipTests(unittest.TestCase):
    def make_app(self):
        with patch.object(
            tray_app,
            "find_conda_python",
            return_value=Path(sys.executable),
        ), patch.object(tray_app, "reconcile_startup_shortcut"):
            return tray_app.TrayApp()

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


class TrayAutoStartTests(unittest.TestCase):
    def make_app(self):
        with patch.object(
            tray_app,
            "find_conda_python",
            return_value=Path(sys.executable),
        ), patch.object(tray_app, "reconcile_startup_shortcut"):
            return tray_app.TrayApp()

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


if __name__ == "__main__":
    unittest.main()
