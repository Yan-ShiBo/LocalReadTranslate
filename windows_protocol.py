"""Per-user Windows URL protocol support for fixed LocalReadTranslate actions."""

import argparse
import os
import sys
from pathlib import Path
from urllib.parse import urlsplit


PROTOCOL_SCHEME = "localreadtranslate"
START_PROTOCOL_URL = f"{PROTOCOL_SCHEME}://start"
OLLAMA_PROTOCOL_URL = f"{PROTOCOL_SCHEME}://ollama"
REMOTE_PROTOCOL_URL = f"{PROTOCOL_SCHEME}://remote"
PROTOCOL_ACTIONS = frozenset({"start", "ollama", "remote"})
PROTOCOL_REGISTRY_PATH = rf"Software\Classes\{PROTOCOL_SCHEME}"


class ProtocolRegistrationError(RuntimeError):
    pass


def build_start_protocol_command(pythonw: Path, tray_script: Path) -> str:
    """Return the quoted command stored in the URL protocol registry key."""
    return f'"{Path(pythonw)}" "{Path(tray_script)}" "%1"'


def parse_protocol_action(value: str) -> str | None:
    """Return a supported payload-free action, or ``None`` for any other URL."""
    try:
        parsed = urlsplit(str(value or "").strip())
    except ValueError:
        return None
    action = parsed.netloc.lower()
    if (
        parsed.scheme.lower() == PROTOCOL_SCHEME
        and action in PROTOCOL_ACTIONS
        and parsed.path in {"", "/"}
        and not parsed.query
        and not parsed.fragment
    ):
        return action
    return None


def is_start_protocol_url(value: str) -> bool:
    """Return whether *value* is the supported one-click mediator start URL."""
    return parse_protocol_action(value) == "start"


def _set_string_value(registry, key, name: str, value: str) -> bool:
    try:
        current, value_type = registry.QueryValueEx(key, name)
    except FileNotFoundError:
        current, value_type = None, None
    if current == value and value_type == registry.REG_SZ:
        return False
    registry.SetValueEx(key, name, 0, registry.REG_SZ, value)
    return True


def _verify_string_value(registry, key, name: str, expected: str) -> None:
    try:
        actual, value_type = registry.QueryValueEx(key, name)
    except OSError as error:
        raise ProtocolRegistrationError("Unable to verify URL protocol registration") from error
    if actual != expected or value_type != registry.REG_SZ:
        raise ProtocolRegistrationError("Unable to verify URL protocol registration")


def ensure_start_protocol_registered(
    pythonw: Path,
    tray_script: Path,
    *,
    registry=None,
    platform_name: str | None = None,
) -> bool:
    """Create or repair the current user's ``localreadtranslate`` handler.

    Returns ``True`` when at least one value changed. On non-Windows systems the
    operation is an intentional no-op, which keeps imports and tests portable.
    """
    if (os.name if platform_name is None else platform_name) != "nt":
        return False
    if registry is None:
        import winreg as registry

    command = build_start_protocol_command(pythonw, tray_script)
    access = registry.KEY_READ | registry.KEY_WRITE
    changed = False
    with registry.CreateKeyEx(
        registry.HKEY_CURRENT_USER,
        PROTOCOL_REGISTRY_PATH,
        0,
        access,
    ) as protocol_key:
        changed |= _set_string_value(
            registry,
            protocol_key,
            "",
            "URL:LocalReadTranslate Protocol",
        )
        changed |= _set_string_value(registry, protocol_key, "URL Protocol", "")
        _verify_string_value(
            registry,
            protocol_key,
            "",
            "URL:LocalReadTranslate Protocol",
        )
        _verify_string_value(registry, protocol_key, "URL Protocol", "")

    command_path = PROTOCOL_REGISTRY_PATH + r"\shell\open\command"
    with registry.CreateKeyEx(
        registry.HKEY_CURRENT_USER,
        command_path,
        0,
        access,
    ) as command_key:
        changed |= _set_string_value(registry, command_key, "", command)
        _verify_string_value(registry, command_key, "", command)
    return changed


def unregister_start_protocol(
    *,
    registry=None,
    platform_name: str | None = None,
) -> bool:
    """Remove only this app's current-user URL protocol tree.

    The operation is idempotent and deliberately does not recurse outside the
    exact ``Software\\Classes\\localreadtranslate`` key.
    """
    if (os.name if platform_name is None else platform_name) != "nt":
        return False
    if registry is None:
        import winreg as registry

    changed = False
    paths = [
        PROTOCOL_REGISTRY_PATH + r"\shell\open\command",
        PROTOCOL_REGISTRY_PATH + r"\shell\open",
        PROTOCOL_REGISTRY_PATH + r"\shell",
        PROTOCOL_REGISTRY_PATH,
    ]
    for path in paths:
        try:
            registry.DeleteKey(registry.HKEY_CURRENT_USER, path)
        except FileNotFoundError:
            continue
        changed = True
    return changed


def main(
    argv=None,
    *,
    platform_name: str | None = None,
    registry=None,
    executable: Path | None = None,
    module_path: Path | None = None,
    stdout=None,
    stderr=None,
) -> int:
    """CLI used by setup scripts to register or repair the URL handler."""
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    register = subparsers.add_parser(
        "register",
        help="register the current-user localreadtranslate URL handler",
    )
    register.add_argument("--pythonw", type=Path)
    register.add_argument("--tray-script", type=Path)
    subparsers.add_parser(
        "unregister",
        help="remove the current-user localreadtranslate URL handler",
    )
    args = parser.parse_args(argv)

    stdout = sys.stdout if stdout is None else stdout
    stderr = sys.stderr if stderr is None else stderr
    current_platform = os.name if platform_name is None else platform_name
    if current_platform != "nt":
        print("URL protocol registration is only available on Windows.", file=stderr)
        return 2

    if args.command == "unregister":
        try:
            changed = unregister_start_protocol(
                registry=registry,
                platform_name=current_platform,
            )
        except Exception as error:
            print(f"Unable to unregister URL protocol: {error}", file=stderr)
            return 1
        status = "removed" if changed else "already absent"
        print(f"Protocol {status}: HKCU\\{PROTOCOL_REGISTRY_PATH}", file=stdout)
        return 0

    current_python = Path(sys.executable if executable is None else executable)
    current_module = Path(__file__ if module_path is None else module_path)
    pythonw = args.pythonw or current_python.with_name("pythonw.exe")
    tray_script = args.tray_script or current_module.with_name("tray_app.py")
    try:
        changed = ensure_start_protocol_registered(
            pythonw,
            tray_script,
            registry=registry,
            platform_name=current_platform,
        )
    except Exception as error:
        print(f"Unable to register URL protocol: {error}", file=stderr)
        return 1

    status = "updated" if changed else "verified"
    print(f"Protocol {status}: HKCU\\{PROTOCOL_REGISTRY_PATH}", file=stdout)
    print(f"Command: {build_start_protocol_command(pythonw, tray_script)}", file=stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
