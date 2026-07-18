import unittest
from types import SimpleNamespace
from unittest.mock import Mock

from windows_runtime import WindowsNamedAutoResetEvent


def fake_kernel32():
    return SimpleNamespace(
        CreateEventW=Mock(return_value=101),
        OpenEventW=Mock(return_value=202),
        SetEvent=Mock(return_value=True),
        WaitForSingleObject=Mock(return_value=0),
        CloseHandle=Mock(return_value=True),
    )


class WindowsNamedAutoResetEventTests(unittest.TestCase):
    def test_create_uses_auto_reset_and_initially_unsignaled_flags(self):
        kernel32 = fake_kernel32()
        event = WindowsNamedAutoResetEvent(
            r"Local\LocalReadTranslate.StartServer",
            kernel32=kernel32,
            platform_name="nt",
        )

        event.create()

        kernel32.CreateEventW.assert_called_once_with(
            None,
            False,
            False,
            r"Local\LocalReadTranslate.StartServer",
        )
        event.close()

    def test_signal_existing_wakes_primary_event_without_creating_another(self):
        kernel32 = fake_kernel32()

        signaled = WindowsNamedAutoResetEvent.signal_existing(
            r"Local\LocalReadTranslate.StartServer",
            kernel32=kernel32,
            platform_name="nt",
        )

        self.assertTrue(signaled)
        kernel32.OpenEventW.assert_called_once_with(
            0x0002,
            False,
            r"Local\LocalReadTranslate.StartServer",
        )
        kernel32.SetEvent.assert_called_once_with(202)
        kernel32.CloseHandle.assert_called_once_with(202)
        kernel32.CreateEventW.assert_not_called()

    def test_wait_reports_a_signal_to_the_primary_listener(self):
        kernel32 = fake_kernel32()
        event = WindowsNamedAutoResetEvent(
            r"Local\LocalReadTranslate.StartServer",
            kernel32=kernel32,
            platform_name="nt",
        ).create()

        self.assertTrue(event.wait(timeout_ms=250))

        kernel32.WaitForSingleObject.assert_called_once_with(101, 250)
        event.close()

    def test_primary_can_signal_its_event_to_stop_the_listener(self):
        kernel32 = fake_kernel32()
        event = WindowsNamedAutoResetEvent(
            r"Local\LocalReadTranslate.StartServer",
            kernel32=kernel32,
            platform_name="nt",
        ).create()

        self.assertTrue(event.set())

        kernel32.SetEvent.assert_called_once_with(101)
        event.close()


if __name__ == "__main__":
    unittest.main()
