from pathlib import Path
from xml.etree import ElementTree


OFFICE_NAMESPACE = "http://schemas.microsoft.com/office/appforoffice/1.1"
WPS_RIBBON_NAMESPACE = "http://schemas.microsoft.com/office/2006/01/customui"


def test_office_manifest_targets_word_and_loopback_taskpane():
    manifest = Path("addons/office-word/manifest.xml")
    root = ElementTree.parse(manifest).getroot()
    namespace = {"o": OFFICE_NAMESPACE}

    assert root.attrib[
        "{http://www.w3.org/2001/XMLSchema-instance}type"
    ] == "TaskPaneApp"
    assert root.find("o:Id", namespace).text == (
        "74d95f3f-f8d0-4a33-95d8-2f0b637df535"
    )
    assert root.findtext("o:Version", namespaces=namespace) == "1.1.0.0"
    assert root.find("o:DisplayName", namespace).attrib["DefaultValue"] == (
        "LocalReadTranslate 文档工作台"
    )
    assert root.find("o:Hosts/o:Host", namespace).attrib["Name"] == "Document"
    assert root.find("o:Permissions", namespace).text == "ReadWriteDocument"
    source = root.find(
        "o:DefaultSettings/o:SourceLocation",
        namespace,
    ).attrib["DefaultValue"]
    assert source == (
        "http://localhost:5443/taskpane/taskpane.html?host=office"
    )


def test_wps_package_has_official_entrypoints_and_one_formula_button():
    plugin = ElementTree.parse("addons/wps-word/manifest.xml").getroot()
    assert plugin.tag == "JsPlugin"
    assert plugin.findtext("Name") == "LocalReadTranslateFormula"

    ribbon = ElementTree.parse("addons/wps-word/ribbon.xml").getroot()
    namespace = {"r": WPS_RIBBON_NAMESPACE}
    buttons = ribbon.findall(".//r:button", namespace)
    assert len(buttons) == 1
    assert buttons[0].attrib["id"] == "localReadTranslateShowFormulaPane"
    assert buttons[0].attrib["onAction"] == "OnAction"
    assert buttons[0].attrib["label"] == "阅读与公式"

    index = Path("addons/wps-word/index.html").read_text(encoding="utf-8")
    main = Path("addons/wps-word/main.js").read_text(encoding="utf-8")
    assert "./main.js" in index
    assert "./js/ribbon.js" in main


def test_installers_use_narrow_current_user_registration_targets():
    install = Path("scripts/install_document_addins.ps1").read_text(
        encoding="utf-8"
    )
    uninstall = Path("scripts/uninstall_document_addins.ps1").read_text(
        encoding="utf-8"
    )
    assert "HKCU:\\Software\\Microsoft\\Office\\16.0\\WEF\\Developer" in install
    assert "74d95f3f-f8d0-4a33-95d8-2f0b637df535" in install
    assert "publish.xml" in install
    assert "Remove-ItemProperty" in uninstall
    assert "setup_addin_certificate" not in install
