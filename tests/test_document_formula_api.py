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


def test_wps_pdf_html_runs_preserve_math_font_and_script_size():
    html = """
    Version:0.9
    <!--StartFragment-->
    <div>
      <span style="font-size:9.9626pt;font-family:'CMMI10';font-style:italic;">x</span>
      <span style="font-size:6.9738pt;font-family:'CMMI7';font-style:italic;">t</span>
      <span style="font-size:6.9738pt;font-family:'CMR7';">+1</span>
      <span style="font-size:9.9626pt;font-family:'CMR10';"> = </span>
      <span style="font-size:9.9626pt;font-family:'CMMI10';font-style:italic;">x</span>
      <span style="font-size:6.9738pt;font-family:'CMMI7';font-style:italic;">t</span>
    </div>
    <!--EndFragment-->
    """

    structured = server._structure_wps_pdf_html(html)

    assert "role=baseline" in structured
    assert "role=script" in structured
    assert "family=CMMI10" in structured
    assert "family=CMMI7" in structured
    assert "text=x" in structured
    assert "text=t" in structured
    assert "text=+1" in structured


def test_wps_pdf_html_marks_computer_modern_extension_glyphs():
    html = """
    <!--StartFragment-->
    <span style="font-size:9.9626pt;font-family:'CMR10';">x</span>
    <span style="font-size:9.9626pt;font-family:'CMEX10';">| {z }</span>
    <span style="font-size:6.9738pt;font-family:'CMR7';">18 terms</span>
    <!--EndFragment-->
    """

    structured = server._structure_wps_pdf_html(html)

    assert "role=extension" in structured
    assert "family=CMEX10" in structured
    assert "text=| {z }" in structured


def test_wps_pdf_html_preserves_multiline_script_order():
    html = """
    <!--StartFragment-->
    <span style="font-size:9.9626pt;font-family:'CMMI10';">x</span>
    <span style="font-size:6.9738pt;font-family:'CMR7';">2
    1
    </span>
    <!--EndFragment-->
    """

    structured = server._structure_wps_pdf_html(html)

    assert "role=script" in structured
    assert "lines-top-to-bottom=2 || 1" in structured


def test_pdf_formula_prompt_explains_cmex_underbrace_glyphs():
    with patch.object(
        server,
        "_call_ollama_text_generation",
        return_value=r"$\underbrace{x_1+\cdots+x_n}_{n\text{ terms}}$",
    ) as generate:
        result = server._call_ollama_pdf_formula_to_latex(
            "x1 + ... + xn | {z } n terms",
            (
                "role=baseline | family=CMMI10 | text=x\n"
                "role=extension | family=CMEX10 | text=| {z }\n"
                "role=script | family=CMR7 | text=n terms"
            ),
            "remote:project-server:qwen3:30b",
        )

    assert result == r"$\underbrace{x_1+\cdots+x_n}_{n\text{ terms}}$"
    system_prompt = generate.call_args.kwargs["system"]
    assert "CMEX" in system_prompt
    assert "underbrace" in system_prompt
    assert "never render those extension glyphs literally" in system_prompt
    assert "first line is the superscript and the second is the subscript" in system_prompt
    assert "complete contiguous right-hand-side expression" in system_prompt
    assert "ASCII Latin glyphs in CMMI runs stay the same Latin variables" in system_prompt
    assert "baseline punctuation after a smaller annotation stays outside" in system_prompt
    assert "line breaks preserve visual top-to-bottom order" in system_prompt
    assert "When font runs are unavailable" in system_prompt


def test_wps_pdf_formula_recognition_uses_the_explicit_discovered_model():
    with patch.object(
        server,
        "_call_ollama_pdf_formula_to_latex",
        return_value="状态更新为 $x_{t+1}=x_t+0.2d_2d_1u_t$。",
    ) as recognize:
        response = client.post(
            "/document/pdf-selection-to-latex",
            json={
                "text": "xt+1 = xt+0.2(d2(d1ut",
                "html": (
                    "<!--StartFragment--><span style=\"font-size:9.96pt;"
                    "font-family:'CMMI10'\">x</span>"
                    "<span style=\"font-size:6.97pt;font-family:'CMMI7'\">t+1"
                    "</span><!--EndFragment-->"
                ),
                "model": "remote:project-server:qwen3:30b",
            },
        )

    assert response.status_code == 200
    assert response.json() == {
        "latex": "状态更新为 $x_{t+1}=x_t+0.2d_2d_1u_t$。",
        "formula_count": 1,
        "inline_formula_count": 1,
        "display_formula_count": 0,
        "warnings": [],
        "model": "remote:project-server:qwen3:30b",
        "recognizer": "ollama-pdf-selection",
        "elapsed": response.json()["elapsed"],
    }
    recognize.assert_called_once()
    args = recognize.call_args.args
    assert args[0] == "xt+1 = xt+0.2(d2(d1ut"
    assert "role=script" in args[1]
    assert args[2] == "remote:project-server:qwen3:30b"


def test_wps_pdf_formula_recognition_rejects_non_formula_model_output():
    with patch.object(
        server,
        "_call_ollama_pdf_formula_to_latex",
        return_value="This selection contains no formula.",
    ):
        response = client.post(
            "/document/pdf-selection-to-latex",
            json={
                "text": "xt+1",
                "html": "<span>x</span><span>t+1</span>",
                "model": "remote:project-server:qwen3:30b",
            },
        )

    assert response.status_code == 422
    assert response.json()["detail"] == "Formula recognition returned no LaTeX formula"
