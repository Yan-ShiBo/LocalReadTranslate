from xml.etree import ElementTree

import pytest

from addin_registration import (
    AddinRegistrationError,
    WPS_PDF_PLUGIN_NAME,
    WPS_PDF_PLUGIN_URL,
    WPS_PLUGIN_NAME,
    WPS_PLUGIN_URL,
    install_wps_plugin,
    install_wps_plugins,
    uninstall_wps_plugin,
    uninstall_wps_plugins,
)


@pytest.fixture()
def publish_path(tmp_path):
    return tmp_path / "publish.xml"


def plugin_entries(path):
    root = ElementTree.parse(path).getroot()
    return list(root.findall("jspluginonline"))


def test_wps_registration_preserves_unrelated_entries_and_is_idempotent(publish_path):
    publish = publish_path
    publish.write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<jsplugins>
  <jspluginonline name="OtherPlugin" type="wps"
    url="https://example.test/plugin/" enable="enable_dev"/>
  <custom-setting value="preserve-me"/>
</jsplugins>
""",
        encoding="utf-8",
    )

    assert install_wps_plugin(publish) is True
    entries = plugin_entries(publish)
    assert len(entries) == 2
    assert entries[0].attrib["name"] == "OtherPlugin"
    installed = entries[1]
    assert installed.attrib == {
        "name": WPS_PLUGIN_NAME,
        "type": "wps",
        "url": WPS_PLUGIN_URL,
        "debug": "",
        "enable": "enable_dev",
        "install": "null",
    }
    assert ElementTree.parse(publish).getroot().find("custom-setting").attrib == {
        "value": "preserve-me"
    }

    first_bytes = publish.read_bytes()
    assert install_wps_plugin(publish) is False
    assert publish.read_bytes() == first_bytes


def test_wps_registration_updates_duplicates_without_touching_other_plugins(publish_path):
    publish = publish_path
    publish.write_text(
        f"""<jsplugins>
  <jspluginonline name="{WPS_PLUGIN_NAME}" type="wps" url="http://old/"/>
  <jspluginonline name="DuplicateUrl" type="wps" url="{WPS_PLUGIN_URL}"/>
  <jspluginonline name="Keep" type="wps" url="https://keep.test/"/>
</jsplugins>""",
        encoding="utf-8",
    )

    assert install_wps_plugin(publish) is True
    entries = plugin_entries(publish)
    assert [entry.attrib["name"] for entry in entries] == [
        WPS_PLUGIN_NAME,
        "Keep",
    ]


def test_wps_uninstall_removes_only_localreadtranslate(publish_path):
    publish = publish_path
    install_wps_plugin(publish)
    root = ElementTree.parse(publish).getroot()
    root.append(
        ElementTree.Element(
            "jspluginonline",
            {"name": "Keep", "type": "wps", "url": "https://keep.test/"},
        )
    )
    ElementTree.ElementTree(root).write(
        publish,
        encoding="utf-8",
        xml_declaration=True,
    )

    assert uninstall_wps_plugin(publish) is True
    assert [entry.attrib["name"] for entry in plugin_entries(publish)] == ["Keep"]
    assert uninstall_wps_plugin(publish) is False


def test_wps_document_plugins_install_and_uninstall_writer_and_pdf_atomically(
    publish_path,
):
    publish_path.write_text(
        """<jsplugins>
  <jspluginonline name="Keep" type="et" url="https://keep.test/"/>
</jsplugins>""",
        encoding="utf-8",
    )

    assert install_wps_plugins(publish_path) is True
    entries = plugin_entries(publish_path)
    assert [(entry.attrib["name"], entry.attrib["type"], entry.attrib["url"]) for entry in entries] == [
        ("Keep", "et", "https://keep.test/"),
        (WPS_PLUGIN_NAME, "wps", WPS_PLUGIN_URL),
        (WPS_PDF_PLUGIN_NAME, "pdf", WPS_PDF_PLUGIN_URL),
    ]
    first_bytes = publish_path.read_bytes()
    assert install_wps_plugins(publish_path) is False
    assert publish_path.read_bytes() == first_bytes

    assert uninstall_wps_plugins(publish_path) is True
    assert [entry.attrib["name"] for entry in plugin_entries(publish_path)] == [
        "Keep"
    ]
    assert uninstall_wps_plugins(publish_path) is False


def test_malformed_wps_publish_file_is_never_overwritten(publish_path):
    publish = publish_path
    original = b"<not-valid"
    publish.write_bytes(original)

    with pytest.raises(AddinRegistrationError):
        install_wps_plugin(publish)

    assert publish.read_bytes() == original
