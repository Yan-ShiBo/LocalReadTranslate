"""Narrow registration helpers for LocalReadTranslate document add-ins.

Only the WPS ``publish.xml`` file is edited here.  Existing third-party entries
are preserved, malformed files are rejected, and installation is idempotent.
Office registry registration remains in the PowerShell installer because it is
Windows-specific and requires no XML rewriting.
"""

from __future__ import annotations

import argparse
import os
import tempfile
from pathlib import Path
from xml.etree import ElementTree


WPS_PLUGIN_NAME = "LocalReadTranslateFormula"
WPS_PLUGIN_TYPE = "wps"
WPS_PLUGIN_URL = "http://localhost:5443/wps-word/"


class AddinRegistrationError(RuntimeError):
    """Raised when an existing registration file cannot be edited safely."""


def default_wps_publish_path() -> Path:
    app_data = os.environ.get("APPDATA")
    if not app_data:
        raise AddinRegistrationError("APPDATA is unavailable")
    return Path(app_data) / "kingsoft" / "wps" / "jsaddons" / "publish.xml"


def _parse_publish_xml(path: Path) -> ElementTree.Element:
    if not path.exists():
        return ElementTree.Element("jsplugins")
    try:
        root = ElementTree.parse(path).getroot()
    except (ElementTree.ParseError, OSError) as error:
        raise AddinRegistrationError(
            f"WPS publish file is invalid and was not changed: {path}"
        ) from error
    if root.tag != "jsplugins":
        raise AddinRegistrationError(
            f"WPS publish file has an unexpected root element: {root.tag}"
        )
    return root


def _write_publish_xml(path: Path, root: ElementTree.Element) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    ElementTree.indent(root, space="  ")
    tree = ElementTree.ElementTree(root)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix="publish.",
        suffix=".xml",
        dir=path.parent,
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        tree.write(
            temporary_path,
            encoding="utf-8",
            xml_declaration=True,
            short_empty_elements=True,
        )
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def install_wps_plugin(
    path: Path,
    *,
    name: str = WPS_PLUGIN_NAME,
    url: str = WPS_PLUGIN_URL,
) -> bool:
    """Install or refresh one WPS online plugin entry.

    Returns ``True`` when the XML file changed.
    """
    publish_path = Path(path)
    root = _parse_publish_xml(publish_path)
    matches = [
        element
        for element in list(root)
        if element.tag == "jspluginonline"
        and (
            element.attrib.get("name") == name
            or element.attrib.get("url") == url
        )
    ]
    desired = {
        "name": name,
        "type": WPS_PLUGIN_TYPE,
        "url": url,
        "debug": "",
        "enable": "enable_dev",
        "install": "null",
    }
    if (
        len(matches) == 1
        and matches[0].attrib == desired
        and all(
            element is matches[0]
            or element.tag != "jspluginonline"
            or (
                element.attrib.get("name") != name
                and element.attrib.get("url") != url
            )
            for element in root
        )
    ):
        return False

    insert_at = len(root)
    if matches:
        insert_at = list(root).index(matches[0])
        for element in matches:
            root.remove(element)
    root.insert(insert_at, ElementTree.Element("jspluginonline", desired))
    _write_publish_xml(publish_path, root)
    return True


def uninstall_wps_plugin(
    path: Path,
    *,
    name: str = WPS_PLUGIN_NAME,
) -> bool:
    """Remove only this project's WPS entry and preserve all other entries."""
    publish_path = Path(path)
    if not publish_path.exists():
        return False
    root = _parse_publish_xml(publish_path)
    matches = [
        element
        for element in list(root)
        if element.tag == "jspluginonline"
        and element.attrib.get("name") == name
    ]
    if not matches:
        return False
    for element in matches:
        root.remove(element)
    _write_publish_xml(publish_path, root)
    return True


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    for command in ("install-wps", "uninstall-wps"):
        child = subparsers.add_parser(command)
        child.add_argument("--path", type=Path, default=None)
        child.add_argument("--name", default=WPS_PLUGIN_NAME)
        if command == "install-wps":
            child.add_argument("--url", default=WPS_PLUGIN_URL)
    return parser.parse_args(argv)


def main(argv=None) -> int:
    args = parse_args(argv)
    path = args.path or default_wps_publish_path()
    if args.command == "install-wps":
        changed = install_wps_plugin(path, name=args.name, url=args.url)
        print(f"WPS add-in {'registered' if changed else 'already registered'}: {path}")
        return 0
    changed = uninstall_wps_plugin(path, name=args.name)
    print(f"WPS add-in {'removed' if changed else 'was not registered'}: {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
