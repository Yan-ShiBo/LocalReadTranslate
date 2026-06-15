import unittest
import uuid

from windows_runtime import WindowsNamedMutex


@unittest.skipUnless(WindowsNamedMutex.is_supported(), "Windows-only behavior")
class WindowsNamedMutexTests(unittest.TestCase):
    def test_second_owner_is_rejected_until_first_releases(self):
        name = f"Local\\KokoroTTS.Test.{uuid.uuid4()}"
        first = WindowsNamedMutex(name)
        second = WindowsNamedMutex(name)

        self.assertTrue(first.acquire())
        self.assertFalse(second.acquire())

        first.close()
        self.assertTrue(second.acquire())
        second.close()


if __name__ == "__main__":
    unittest.main()
