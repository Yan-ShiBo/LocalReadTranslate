import ctypes
import os


ERROR_ALREADY_EXISTS = 183
EVENT_MODIFY_STATE = 0x0002
WAIT_OBJECT_0 = 0x00000000
WAIT_TIMEOUT = 0x00000102


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


class WindowsNamedAutoResetEvent:
    """Small wrapper around a named, per-session Windows auto-reset event."""

    def __init__(self, name, *, kernel32=None, platform_name=None):
        self.name = name
        self._kernel32 = kernel32
        self._platform_name = os.name if platform_name is None else platform_name
        self._handle = None

    def is_supported(self):
        return self._platform_name == "nt"

    def _load_kernel32(self):
        if not self.is_supported():
            raise RuntimeError("Windows named events are only available on Windows")
        if self._kernel32 is None:
            self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        self._kernel32.CreateEventW.argtypes = [
            ctypes.c_void_p,
            ctypes.c_bool,
            ctypes.c_bool,
            ctypes.c_wchar_p,
        ]
        self._kernel32.CreateEventW.restype = ctypes.c_void_p
        self._kernel32.WaitForSingleObject.argtypes = [
            ctypes.c_void_p,
            ctypes.c_uint32,
        ]
        self._kernel32.WaitForSingleObject.restype = ctypes.c_uint32
        self._kernel32.SetEvent.argtypes = [ctypes.c_void_p]
        self._kernel32.SetEvent.restype = ctypes.c_bool
        self._kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        self._kernel32.CloseHandle.restype = ctypes.c_bool
        return self._kernel32

    def create(self):
        if self._handle:
            return self
        kernel32 = self._load_kernel32()
        handle = kernel32.CreateEventW(None, False, False, self.name)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        self._handle = handle
        return self

    def wait(self, timeout_ms=500):
        if not self._handle:
            raise RuntimeError("Named event has not been created")
        result = self._kernel32.WaitForSingleObject(self._handle, int(timeout_ms))
        if result == WAIT_OBJECT_0:
            return True
        if result == WAIT_TIMEOUT:
            return False
        raise ctypes.WinError(ctypes.get_last_error())

    def set(self):
        if not self._handle:
            return False
        return bool(self._kernel32.SetEvent(self._handle))

    @classmethod
    def signal_existing(cls, name, *, kernel32=None, platform_name=None):
        event = cls(name, kernel32=kernel32, platform_name=platform_name)
        if not event.is_supported():
            return False
        if event._kernel32 is None:
            event._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32 = event._kernel32
        kernel32.OpenEventW.argtypes = [
            ctypes.c_uint32,
            ctypes.c_bool,
            ctypes.c_wchar_p,
        ]
        kernel32.OpenEventW.restype = ctypes.c_void_p
        kernel32.SetEvent.argtypes = [ctypes.c_void_p]
        kernel32.SetEvent.restype = ctypes.c_bool
        kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
        kernel32.CloseHandle.restype = ctypes.c_bool

        handle = kernel32.OpenEventW(EVENT_MODIFY_STATE, False, name)
        if not handle:
            return False
        try:
            return bool(kernel32.SetEvent(handle))
        finally:
            kernel32.CloseHandle(handle)

    def close(self):
        if self._handle:
            self._kernel32.CloseHandle(self._handle)
            self._handle = None
