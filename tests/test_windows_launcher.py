import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import windows_launcher


class WindowsLauncherTests(unittest.TestCase):
    def test_main_forwards_fixed_protocol_action_to_tray(self):
        tray_module = Mock()
        tray_module.main.return_value = 0
        importer = Mock(return_value=tray_module)

        with patch.object(windows_launcher.os, "chdir") as chdir:
            result = windows_launcher.main(
                ["localreadtranslate://ollama"],
                importer=importer,
            )

        self.assertEqual(result, 0)
        chdir.assert_called_once_with(windows_launcher.SCRIPT_DIR)
        importer.assert_called_once_with("tray_app")
        tray_module.main.assert_called_once_with(["localreadtranslate://ollama"])

    def test_main_logs_and_reports_hidden_import_failure(self):
        error = ImportError("broken dependency")
        log_file = Path(r"C:\Users\Example\AppData\Local\LocalReadTranslate\launcher.log")
        writer = Mock(return_value=log_file)
        reporter = Mock()

        with patch.object(windows_launcher.os, "chdir"):
            result = windows_launcher.main(
                ["localreadtranslate://start"],
                importer=Mock(side_effect=error),
                failure_writer=writer,
                failure_reporter=reporter,
            )

        self.assertEqual(result, 1)
        writer.assert_called_once_with(error)
        reporter.assert_called_once_with(error, log_file)


if __name__ == "__main__":
    unittest.main()
