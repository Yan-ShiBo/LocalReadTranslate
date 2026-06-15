import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import tray_app


class TrayOwnershipTests(unittest.TestCase):
    def make_app(self):
        with patch.object(
            tray_app,
            "find_conda_python",
            return_value=Path(sys.executable),
        ):
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


if __name__ == "__main__":
    unittest.main()
