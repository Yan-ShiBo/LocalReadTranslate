from unittest.mock import patch

from fastapi.testclient import TestClient

import server
from document_formula import (
    FormulaConversionError,
    GeneratedFormulaFragment,
    NativeToLatexResult,
    PandocUnavailableError,
)


client = TestClient(server.app)


def test_translation_formula_protection_preserves_display_math_wrappers():
    protected, formulas = server._protect_formulas(
        "前文 [[MATH: x^2]]。\n\n[[MATH_BLOCK: \\int_0^1 x\\,dx]]"
    )

    assert protected == "前文 __MATH_0__。\n\n__MATH_1__"
    assert len(formulas) == 2
    assert server._restore_formulas_for_display(protected, formulas) == (
        "前文 $x^2$。\n\n$$\\int_0^1 x\\,dx$$"
    )


def test_latex_formula_health_hides_local_executable_path():
    with patch.object(
        server,
        "pandoc_health",
        return_value={
            "available": True,
            "path": r"C:\private\pandoc.exe",
            "version": "3.8",
            "interchange_format": "latex",
            "native_format": "docx-omml",
        },
    ):
        response = client.get("/document/latex/health")

    assert response.status_code == 200
    assert response.json() == {
        "available": True,
        "version": "3.8",
        "interchange_format": "latex",
        "native_format": "docx-omml",
    }
    assert "private" not in response.text


def test_latex_fragment_endpoint_returns_both_word_and_wps_insertion_forms():
    generated = GeneratedFormulaFragment(
        canonical_latex="设 $x^2$。",
        docx_base64="ZG9jeA==",
        local_path=r"C:\Temp\formula-1.docx",
        filename="formula-1.docx",
        formula_count=1,
        inline_formula_count=1,
        display_formula_count=0,
        native_formula_count=1,
        native_display_formula_count=0,
        warnings=(),
        generator="pandoc",
        generator_version="3.8",
    )
    with patch.object(server, "generate_formula_fragment", return_value=generated):
        response = client.post(
            "/document/latex-fragment",
            json={"text": "设 $x^2$。"},
        )

    assert response.status_code == 200
    payload = response.json()
    assert payload["canonical_latex"] == "设 $x^2$。"
    assert payload["docx_base64"] == "ZG9jeA=="
    assert payload["local_path"] == r"C:\Temp\formula-1.docx"
    assert payload["native_formula_count"] == 1
    assert payload["expires_in_seconds"] == 3600


def test_latex_fragment_endpoint_requires_at_least_one_formula():
    with patch.object(
        server,
        "generate_formula_fragment",
        side_effect=FormulaConversionError("No LaTeX formulas were detected"),
    ):
        response = client.post(
            "/document/latex-fragment",
            json={"text": "plain prose"},
        )

    assert response.status_code == 422
    assert response.json()["detail"] == "No LaTeX formulas were detected"


def test_latex_fragment_endpoint_reports_missing_converter_without_path_details():
    with patch.object(
        server,
        "generate_formula_fragment",
        side_effect=PandocUnavailableError(r"missing C:\private\pandoc.exe"),
    ):
        response = client.post(
            "/document/latex-fragment",
            json={"text": "$x$"},
        )

    assert response.status_code == 503
    assert response.json()["detail"] == "Native formula conversion is unavailable"
    assert "private" not in response.text


def test_native_formula_copy_outputs_only_canonical_latex():
    converted = NativeToLatexResult(
        latex="正文 $x^{2}$。",
        formula_count=1,
        inline_formula_count=1,
        display_formula_count=0,
        warnings=(),
        generator="pandoc",
        generator_version="3.8",
    )
    with patch.object(server, "native_formula_to_latex", return_value=converted):
        response = client.post(
            "/document/native-to-latex",
            json={"source_format": "flat-opc", "content": "<pkg:package/>"},
        )

    assert response.status_code == 200
    assert response.json() == {
        "latex": "正文 $x^{2}$。",
        "formula_count": 1,
        "inline_formula_count": 1,
        "display_formula_count": 0,
        "warnings": [],
        "generator": "pandoc",
        "generator_version": "3.8",
    }


def test_native_formula_copy_accepts_wps_local_spool_paths():
    converted = NativeToLatexResult(
        latex="正文 $x^{2}$。",
        formula_count=1,
        inline_formula_count=1,
        display_formula_count=0,
        warnings=(),
        generator="pandoc",
        generator_version="3.8",
    )
    spool_path = (
        r"C:\Temp\localreadtranslate-selection-1234567890-a1b2c3.docx"
    )
    with patch.object(
        server,
        "native_formula_to_latex",
        return_value=converted,
    ) as convert:
        response = client.post(
            "/document/native-to-latex",
            json={"source_format": "docx-local-path", "content": spool_path},
        )

    assert response.status_code == 200
    convert.assert_called_once_with("docx-local-path", spool_path)


def test_native_formula_copy_rejects_unknown_source_format():
    response = client.post(
        "/document/native-to-latex",
        json={"source_format": "omml", "content": "<m:oMath/>"},
    )

    assert response.status_code == 422
