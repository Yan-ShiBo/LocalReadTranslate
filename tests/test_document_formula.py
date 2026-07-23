import base64
import io
import uuid
import zipfile
from pathlib import Path

import pytest

import document_formula


def test_canonicalizes_every_supported_math_wrapper_to_latex():
    result = document_formula.canonicalize_latex_interchange(
        "设 [[MATH: f(x)=x^2]]，则\n\n"
        "[[MATH_BLOCK: \\int_0^1 f(x)\\,dx=\\frac{1}{3}]]\n\n"
        r"另外 \(g(x)=x+1\)，并且 \[g(0)=1\]。"
    )

    assert result.inline_formula_count == 2
    assert result.display_formula_count == 2
    assert result.formula_count == 4
    assert "[[MATH:" not in result.text
    assert r"设 $f(x)=x^2$，则" in result.text
    assert "$$\n\\int_0^1 f(x)\\,dx=\\frac{1}{3}\n$$" in result.text
    assert r"另外 $g(x)=x+1$，并且" in result.text
    assert "$$\ng(0)=1\n$$" in result.text


def test_preserves_paragraphs_and_does_not_treat_currency_as_math():
    result = document_formula.canonicalize_latex_interchange(
        "第一段价格是 $5 and $10。\n\n第二段公式是 $x+1$。"
    )

    assert result.text == "第一段价格是 $5 and $10。\n\n第二段公式是 $x+1$。"
    assert result.formula_count == 1


def test_normalizes_display_environments():
    result = document_formula.canonicalize_latex_interchange(
        "\\begin{align}\n"
        "a &= b + c \\\\\n"
        "d &= e\n"
        "\\end{align}"
    )

    assert result.formula_count == 1
    assert result.display_formula_count == 1
    assert "\\begin{aligned}" in result.text
    assert "\\end{aligned}" in result.text


def test_reports_unclosed_formula_without_destroying_source():
    result = document_formula.canonicalize_latex_interchange(
        r"保留未闭合公式 \(x+1"
    )

    assert result.formula_count == 0
    assert result.text == r"保留未闭合公式 \(x+1"
    assert result.warnings == (r"Unclosed \( inline formula",)


def test_rejects_invalid_docx_base64():
    with pytest.raises(document_formula.FormulaConversionError):
        document_formula.decode_docx_base64("not-base64")


def test_reads_wps_local_docx_spool_without_browser_binary_encoding():
    docx = document_formula.flat_opc_to_docx(_minimal_flat_opc())
    test_root = (
        Path(__file__).resolve().parents[1]
        / "test-venv"
        / f"wps-spool-{uuid.uuid4().hex}"
    )
    test_root.mkdir(parents=True)
    try:
        spool_path = (
            test_root / "localreadtranslate-selection-1234567890-a1b2c3.docx"
        )
        spool_path.write_bytes(docx)

        assert (
            document_formula.read_wps_local_docx(
                str(spool_path),
                temp_root=test_root,
            )
            == docx
        )
    finally:
        spool_path.unlink(missing_ok=True)
        test_root.rmdir()


def test_rejects_wps_local_docx_paths_outside_the_temp_root():
    docx = document_formula.flat_opc_to_docx(_minimal_flat_opc())
    test_root = (
        Path(__file__).resolve().parents[1]
        / "test-venv"
        / f"wps-spool-{uuid.uuid4().hex}"
    )
    nested = test_root / "nested"
    nested.mkdir(parents=True)
    try:
        unsafe_path = (
            nested / "localreadtranslate-selection-1234567890-a1b2c3.docx"
        )
        unsafe_name_path = test_root / "unrelated-document.docx"
        unsafe_path.write_bytes(docx)
        unsafe_name_path.write_bytes(docx)

        with pytest.raises(
            document_formula.FormulaConversionError,
            match="Unsafe WPS formula spool path",
        ):
            document_formula.read_wps_local_docx(
                str(unsafe_path),
                temp_root=test_root,
            )
        with pytest.raises(
            document_formula.FormulaConversionError,
            match="Unsafe WPS formula spool path",
        ):
            document_formula.read_wps_local_docx(
                str(unsafe_name_path),
                temp_root=test_root,
            )
    finally:
        unsafe_path.unlink(missing_ok=True)
        unsafe_name_path.unlink(missing_ok=True)
        nested.rmdir()
        test_root.rmdir()


def _minimal_flat_opc() -> str:
    content_types = (
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        "</Types>"
    )
    relationships = (
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="word/document.xml"/>'
        "</Relationships>"
    )
    document = (
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body><w:p><w:r><w:t>test</w:t></w:r></w:p></w:body>"
        "</w:document>"
    )
    return f"""<?xml version="1.0" encoding="utf-8"?>
<pkg:package xmlns:pkg="http://schemas.microsoft.com/office/2006/xmlPackage">
  <pkg:part pkg:name="/[Content_Types].xml" pkg:contentType="application/xml">
    <pkg:xmlData>{content_types}</pkg:xmlData>
  </pkg:part>
  <pkg:part pkg:name="/_rels/.rels" pkg:contentType="application/vnd.openxmlformats-package.relationships+xml">
    <pkg:xmlData>{relationships}</pkg:xmlData>
  </pkg:part>
  <pkg:part pkg:name="/word/document.xml" pkg:contentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml">
    <pkg:xmlData>{document}</pkg:xmlData>
  </pkg:part>
</pkg:package>"""


def test_converts_flat_opc_to_safe_docx_package():
    docx = document_formula.flat_opc_to_docx(_minimal_flat_opc())

    with zipfile.ZipFile(io.BytesIO(docx), "r") as archive:
        assert "[Content_Types].xml" in archive.namelist()
        assert "_rels/.rels" in archive.namelist()
        assert "word/document.xml" in archive.namelist()
        document = archive.read("word/document.xml").decode("utf-8")
        assert ">test<" in document


def test_reconstructs_package_metadata_omitted_by_word_selection_ooxml():
    root = document_formula.ElementTree.fromstring(_minimal_flat_opc())
    for part in list(root):
        name = part.attrib.get(
            f"{{{document_formula._PKG_NAMESPACE}}}name",
            "",
        )
        if name in {"/[Content_Types].xml", "/_rels/.rels"}:
            root.remove(part)
    selection_ooxml = document_formula.ElementTree.tostring(
        root,
        encoding="unicode",
    )

    docx = document_formula.flat_opc_to_docx(selection_ooxml)

    with zipfile.ZipFile(io.BytesIO(docx), "r") as archive:
        names = set(archive.namelist())
        assert {"[Content_Types].xml", "_rels/.rels", "word/document.xml"} <= names
        content_types = archive.read("[Content_Types].xml").decode("utf-8")
        relationships = archive.read("_rels/.rels").decode("utf-8")
        assert "/word/document.xml" in content_types
        assert "officeDocument" in relationships


def test_rejects_flat_opc_without_word_document_even_when_metadata_exists():
    root = document_formula.ElementTree.fromstring(_minimal_flat_opc())
    for part in list(root):
        if part.attrib.get(
            f"{{{document_formula._PKG_NAMESPACE}}}name",
            "",
        ) == "/word/document.xml":
            root.remove(part)

    with pytest.raises(
        document_formula.FormulaConversionError,
        match="missing word/document.xml",
    ):
        document_formula.flat_opc_to_docx(
            document_formula.ElementTree.tostring(root, encoding="unicode")
        )


@pytest.mark.skipif(
    document_formula.find_pandoc() is None,
    reason="Pandoc is not installed",
)
def test_word_selection_flat_opc_round_trip_uses_only_inline_document_xml():
    generated = document_formula.generate_formula_fragment(
        "测试 $x^2+y^2=z^2$ 和 $\\frac{a}{b}$。",
        fragment_dir=Path(__file__).resolve().parents[1] / "test-venv",
    )
    try:
        with zipfile.ZipFile(
            io.BytesIO(base64.b64decode(generated.docx_base64)),
            "r",
        ) as archive:
            document_xml = archive.read("word/document.xml").decode("utf-8")
        document_xml = document_formula.ElementTree.tostring(
            document_formula.ElementTree.fromstring(document_xml),
            encoding="unicode",
        )
        selection_ooxml = (
            '<pkg:package xmlns:pkg="'
            f'{document_formula._PKG_NAMESPACE}">'
            '<pkg:part pkg:name="/word/document.xml" '
            'pkg:contentType="application/vnd.openxmlformats-officedocument.'
            'wordprocessingml.document.main+xml">'
            f"<pkg:xmlData>{document_xml}</pkg:xmlData>"
            "</pkg:part></pkg:package>"
        )

        converted = document_formula.native_formula_to_latex(
            "flat-opc",
            selection_ooxml,
            work_dir=Path(__file__).resolve().parents[1] / "test-venv",
        )

        assert converted.formula_count == 2
        assert "$x^{2} + y^{2} = z^{2}$" in converted.latex
        assert "$\\frac{a}{b}$" in converted.latex
    finally:
        Path(generated.local_path).unlink(missing_ok=True)


@pytest.mark.skipif(
    document_formula.find_pandoc() is None,
    reason="Pandoc is not installed",
)
def test_pandoc_generates_editable_inline_and_display_omml():
    result = document_formula.generate_formula_fragment(
        "设 $f(x)=x^2$，则\n\n"
        "$$\n\\int_0^1 f(x)\\,dx=\\frac{1}{3}.\n$$\n\n"
        "因此结果为 $\\frac{1}{3}$。",
        fragment_dir=Path(__file__).resolve().parents[1] / "test-venv",
    )
    try:
        data = base64.b64decode(result.docx_base64)
        assert result.formula_count == 3
        assert result.inline_formula_count == 2
        assert result.display_formula_count == 1
        assert result.native_formula_count == 3
        assert result.native_display_formula_count == 1
        assert Path(result.local_path).is_file()

        with zipfile.ZipFile(io.BytesIO(data), "r") as archive:
            document_xml = archive.read("word/document.xml").decode("utf-8")
        assert "<m:oMath>" in document_xml
        assert "<m:oMathPara>" in document_xml
        assert "<m:f>" in document_xml
        assert "<m:nary>" in document_xml
        assert "设" in document_xml
        assert "因此结果为" in document_xml
    finally:
        Path(result.local_path).unlink(missing_ok=True)


@pytest.mark.skipif(
    document_formula.find_pandoc() is None,
    reason="Pandoc is not installed",
)
def test_native_docx_round_trip_copies_formulas_as_canonical_latex():
    generated = document_formula.generate_formula_fragment(
        "行内 $x^2+y^2=z^2$。\n\n"
        "$$\n\\frac{a}{b}\n$$",
        fragment_dir=Path(__file__).resolve().parents[1] / "test-venv",
    )
    try:
        converted = document_formula.native_formula_to_latex(
            "docx-base64",
            generated.docx_base64,
            work_dir=Path(__file__).resolve().parents[1] / "test-venv",
        )

        assert converted.formula_count == 2
        assert "$x^{2} + y^{2} = z^{2}$" in converted.latex
        assert "$$\n\\frac{a}{b}\n$$" in converted.latex
    finally:
        Path(generated.local_path).unlink(missing_ok=True)


@pytest.mark.skipif(
    document_formula.find_pandoc() is None,
    reason="Pandoc is not installed",
)
def test_fifty_formula_interoperability_corpus_becomes_native_and_round_trips():
    corpus_path = Path(__file__).parent / "fixtures" / "latex-formula-corpus.md"
    source = corpus_path.read_text(encoding="utf-8")
    canonical = document_formula.canonicalize_latex_interchange(source)
    assert canonical.formula_count == 50

    generated = document_formula.generate_formula_fragment(
        source,
        fragment_dir=Path(__file__).resolve().parents[1] / "test-venv",
    )
    try:
        assert generated.formula_count == 50
        assert generated.native_formula_count == 50
        converted = document_formula.native_formula_to_latex(
            "docx-base64",
            generated.docx_base64,
            work_dir=Path(__file__).resolve().parents[1] / "test-venv",
        )
        assert converted.formula_count == 50
    finally:
        Path(generated.local_path).unlink(missing_ok=True)
