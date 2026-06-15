import ctypes
import os


ERROR_ALREADY_EXISTS = 183


class WindowsNamedMutex:
    def __init__(self, name):
        self.name = name
        self._handle = None
        self._kernel32 = None

    @staticmethod
    def is_supported():
        return os.name == "nt"

    def acquire(self):
        if self._handle:
            return True
        if not self.is_supported():
            raise RuntimeError("Windows named mutexes are only available on Windows")

        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._kernel32.CreateMutexW.argtypes = [
            ctypes.c_void_p,
            ctypes.c_bool,
            ctypes.c_wchar_p,
        ]
        self._kernel32.CreateMutexW.restype = ctypes.c_void_p
        self._kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        self._kernel32.CloseHandle.restype = ctypes.c_bool

        handle = self._kernel32.CreateMutexW(None, False, self.name)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
            self._kernel32.CloseHandle(handle)
            return False

        self._handle = handle
        return True

    def close(self):
        if self._handle:
            self._kernel32.CloseHandle(self._handle)
            self._handle = None
