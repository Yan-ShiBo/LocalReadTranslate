"""LaTeX interchange and native Word/WPS formula document helpers.

LaTeX is the only external interchange format.  DOCX/OMML is generated only
as a short-lived insertion format for Word and WPS Writer.
"""

from __future__ import annotations

import base64
import binascii
import functools
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Literal
from xml.etree import ElementTree


PANDOC_INPUT_FORMAT = "markdown+tex_math_dollars+raw_tex"
PANDOC_OUTPUT_FORMAT = "markdown+tex_math_dollars"
FORMULA_FRAGMENT_TTL_SECONDS = 60 * 60
MAX_DOCX_BYTES = 8 * 1024 * 1024
MAX_DOCX_EXPANDED_BYTES = 24 * 1024 * 1024
MAX_DOCX_ENTRIES = 512
_WPS_LOCAL_DOCX_NAME = re.compile(
    r"localreadtranslate-selection-\d+-[0-9a-f]+\.docx"
)

_PKG_NAMESPACE = "http://schemas.microsoft.com/office/2006/xmlPackage"
_PKG = f"{{{_PKG_NAMESPACE}}}"
_CONTENT_TYPES_NAMESPACE = (
    "http://schemas.openxmlformats.org/package/2006/content-types"
)
_RELATIONSHIPS_NAMESPACE = (
    "http://schemas.openxmlformats.org/package/2006/relationships"
)
_OFFICE_DOCUMENT_RELATIONSHIP = (
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
    "officeDocument"
)
_WORD_XML_NAMESPACES = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "m": "http://schemas.openxmlformats.org/officeDocument/2006/math",
    "r": (
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    ),
    "o": "urn:schemas-microsoft-com:office:office",
    "v": "urn:schemas-microsoft-com:vml",
    "w10": "urn:schemas-microsoft-com:office:word",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
    "wp": (
        "http://schemas.openxmlformats.org/drawingml/2006/"
        "wordprocessingDrawing"
    ),
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "w14": "http://schemas.microsoft.com/office/word/2010/wordml",
    "w15": "http://schemas.microsoft.com/office/word/2012/wordml",
    "w16": "http://schemas.microsoft.com/office/word/2018/wordml",
}
_DISPLAY_ENVIRONMENTS = {
    "equation": None,
    "equation*": None,
    "align": "aligned",
    "align*": "aligned",
    "alignat": "aligned",
    "alignat*": "aligned",
    "gather": "gathered",
    "gather*": "gathered",
    "multline": "aligned",
    "multline*": "aligned",
}


class FormulaDocumentError(RuntimeError):
    """Base error for formula document conversion."""


class PandocUnavailableError(FormulaDocumentError):
    """Raised when no usable Pandoc executable can be found."""


class FormulaConversionError(FormulaDocumentError):
    """Raised when formula conversion cannot produce native math."""


@dataclass(frozen=True)
class LatexSegment:
    kind: Literal["text", "math"]
    value: str
    display: bool = False
    source: str = "text"


@dataclass(frozen=True)
class CanonicalLatex:
    text: str
    segments: tuple[LatexSegment, ...]
    inline_formula_count: int
    display_formula_count: int
    warnings: tuple[str, ...] = ()

    @property
    def formula_count(self) -> int:
        return self.inline_formula_count + self.display_formula_count


@dataclass(frozen=True)
class GeneratedFormulaFragment:
    canonical_latex: str
    docx_base64: str
    local_path: str
    filename: str
    formula_count: int
    inline_formula_count: int
    display_formula_count: int
    native_formula_count: int
    native_display_formula_count: int
    warnings: tuple[str, ...]
    generator: str
    generator_version: str
    expires_in_seconds: int = FORMULA_FRAGMENT_TTL_SECONDS


@dataclass(frozen=True)
class NativeToLatexResult:
    latex: str
    formula_count: int
    inline_formula_count: int
    display_formula_count: int
    warnings: tuple[str, ...]
    generator: str
    generator_version: str


def _is_escaped(value: str, index: int) -> bool:
    backslashes = 0
    cursor = index - 1
    while cursor >= 0 and value[cursor] == "\\":
        backslashes += 1
        cursor -= 1
    return backslashes % 2 == 1


def _find_unescaped(
    value: str,
    marker: str,
    start: int,
    *,
    stop_at_newline: bool = False,
) -> int:
    cursor = start
    while cursor <= len(value) - len(marker):
        if stop_at_newline and value[cursor] in "\r\n":
            return -1
        if value.startswith(marker, cursor) and not _is_escaped(value, cursor):
            return cursor
        cursor += 1
    return -1


def _normalize_formula_body(value: str) -> str:
    lines = str(value or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    return "\n".join(line.rstrip() for line in lines).strip()


def _normalize_display_environment(environment: str, body: str) -> str:
    replacement = _DISPLAY_ENVIRONMENTS[environment]
    cleaned = _normalize_formula_body(body)
    if replacement is None:
        return cleaned
    return f"\\begin{{{replacement}}}\n{cleaned}\n\\end{{{replacement}}}"


def _single_dollar_close(value: str, start: int) -> int:
    cursor = start
    while cursor < len(value):
        char = value[cursor]
        if char in "\r\n":
            return -1
        if char == "$" and not _is_escaped(value, cursor):
            if cursor == start or value[cursor - 1].isspace():
                cursor += 1
                continue
            if cursor + 1 < len(value) and value[cursor + 1].isdigit():
                cursor += 1
                continue
            return cursor
        cursor += 1
    return -1


def parse_latex_interchange(text: str) -> tuple[tuple[LatexSegment, ...], tuple[str, ...]]:
    """Split prose and formulas without interpreting the LaTeX expression."""

    value = str(text or "").replace("\r\n", "\n").replace("\r", "\n")
    segments: list[LatexSegment] = []
    warnings: list[str] = []
    text_start = 0
    cursor = 0

    def push_text(end: int) -> None:
        nonlocal text_start
        if end > text_start:
            segments.append(LatexSegment("text", value[text_start:end]))

    def push_math(
        start: int,
        end: int,
        body: str,
        *,
        display: bool,
        source: str,
    ) -> None:
        nonlocal cursor, text_start
        push_text(start)
        normalized = _normalize_formula_body(body)
        if normalized:
            segments.append(LatexSegment("math", normalized, display, source))
        else:
            warnings.append(f"Ignored an empty {source} formula")
        cursor = end
        text_start = end

    while cursor < len(value):
        if value.startswith("[[MATH_BLOCK:", cursor):
            close = value.find("]]", cursor + len("[[MATH_BLOCK:"))
            if close >= 0:
                body_start = cursor + len("[[MATH_BLOCK:")
                push_math(
                    cursor,
                    close + 2,
                    value[body_start:close],
                    display=True,
                    source="math-block-wrapper",
                )
                continue
            warnings.append("Unclosed [[MATH_BLOCK: ...]] wrapper")

        if value.startswith("[[MATH:", cursor):
            close = value.find("]]", cursor + len("[[MATH:"))
            if close >= 0:
                body_start = cursor + len("[[MATH:")
                push_math(
                    cursor,
                    close + 2,
                    value[body_start:close],
                    display=False,
                    source="math-wrapper",
                )
                continue
            warnings.append("Unclosed [[MATH: ...]] wrapper")

        if value.startswith("$$", cursor) and not _is_escaped(value, cursor):
            close = _find_unescaped(value, "$$", cursor + 2)
            if close >= 0:
                push_math(
                    cursor,
                    close + 2,
                    value[cursor + 2 : close],
                    display=True,
                    source="double-dollar",
                )
                continue
            warnings.append("Unclosed $$ display formula")

        if value.startswith(r"\[", cursor) and not _is_escaped(value, cursor):
            close = _find_unescaped(value, r"\]", cursor + 2)
            if close >= 0:
                push_math(
                    cursor,
                    close + 2,
                    value[cursor + 2 : close],
                    display=True,
                    source="bracket-display",
                )
                continue
            warnings.append(r"Unclosed \[ display formula")

        if value.startswith(r"\(", cursor) and not _is_escaped(value, cursor):
            close = _find_unescaped(value, r"\)", cursor + 2)
            if close >= 0:
                push_math(
                    cursor,
                    close + 2,
                    value[cursor + 2 : close],
                    display=False,
                    source="parenthesis-inline",
                )
                continue
            warnings.append(r"Unclosed \( inline formula")

        if value.startswith(r"\begin{", cursor) and not _is_escaped(value, cursor):
            environment_match = re.match(r"\\begin\{([^{}]+)\}", value[cursor:])
            if environment_match:
                environment = environment_match.group(1)
                if environment in _DISPLAY_ENVIRONMENTS:
                    open_end = cursor + environment_match.end()
                    close_marker = rf"\end{{{environment}}}"
                    close = value.find(close_marker, open_end)
                    if close >= 0:
                        push_math(
                            cursor,
                            close + len(close_marker),
                            _normalize_display_environment(
                                environment,
                                value[open_end:close],
                            ),
                            display=True,
                            source=f"environment:{environment}",
                        )
                        continue
                    warnings.append(f"Unclosed {environment} environment")

        if value[cursor] == "$" and not _is_escaped(value, cursor):
            if cursor + 1 < len(value) and not value[cursor + 1].isspace():
                close = _single_dollar_close(value, cursor + 1)
                if close >= 0:
                    push_math(
                        cursor,
                        close + 1,
                        value[cursor + 1 : close],
                        display=False,
                        source="single-dollar",
                    )
                    continue

        cursor += 1

    push_text(len(value))
    if not segments:
        segments.append(LatexSegment("text", value))
    return tuple(segments), tuple(dict.fromkeys(warnings))


def _normalize_prose(value: str) -> str:
    cleaned = (
        str(value or "")
        .replace("\u00a0", " ")
        .replace("\u200b", "")
        .replace("\u200c", "")
        .replace("\u200d", "")
        .replace("\u200e", "")
        .replace("\u200f", "")
        .replace("\ufeff", "")
    )
    # Keep one boundary space around an inline formula.  Line-end spaces are
    # removed later, after all prose and formula segments have been joined.
    lines = [re.sub(r"[ \t]+", " ", line) for line in cleaned.split("\n")]
    return "\n".join(lines)


def canonicalize_latex_interchange(text: str) -> CanonicalLatex:
    """Normalize every copied formula to one canonical LaTeX text contract."""

    segments, warnings = parse_latex_interchange(text)
    pieces: list[str] = []
    inline_count = 0
    display_count = 0

    for segment in segments:
        if segment.kind == "text":
            pieces.append(_normalize_prose(segment.value))
            continue
        if segment.display:
            display_count += 1
            if pieces and pieces[-1] and not pieces[-1].endswith("\n"):
                pieces.append("\n\n")
            elif pieces and pieces[-1].endswith("\n") and not pieces[-1].endswith("\n\n"):
                pieces.append("\n")
            pieces.append(f"$$\n{segment.value}\n$$")
            pieces.append("\n\n")
        else:
            inline_count += 1
            pieces.append(f"${segment.value}$")

    canonical = "".join(pieces)
    canonical = re.sub(r"[ \t]+\n", "\n", canonical)
    canonical = re.sub(r"\n[ \t]+", "\n", canonical)
    canonical = re.sub(r"\n{3,}", "\n\n", canonical)
    canonical = re.sub(r"[ \t]{2,}", " ", canonical)
    canonical = re.sub(r"[ \t]+([,.;:!?，。；：！？])", r"\1", canonical)
    canonical = re.sub(r"([\(\[（])\s+", r"\1", canonical)
    canonical = re.sub(r"\s+([\)\]）])", r"\1", canonical)
    canonical = canonical.strip()

    return CanonicalLatex(
        text=canonical,
        segments=segments,
        inline_formula_count=inline_count,
        display_formula_count=display_count,
        warnings=warnings,
    )


def _pandoc_candidates() -> tuple[Path, ...]:
    candidates: list[Path] = []
    configured = os.environ.get("PANDOC_PATH", "").strip()
    if configured:
        candidates.append(Path(configured))

    discovered = shutil.which("pandoc")
    if discovered:
        candidates.append(Path(discovered))

    local_app_data = os.environ.get("LOCALAPPDATA")
    if local_app_data:
        candidates.append(Path(local_app_data) / "Pandoc" / "pandoc.exe")
    program_files = os.environ.get("ProgramFiles")
    if program_files:
        candidates.append(Path(program_files) / "Pandoc" / "pandoc.exe")
    candidates.append(Path(sys.executable).resolve().parent / "pandoc.exe")

    unique: list[Path] = []
    seen: set[str] = set()
    for candidate in candidates:
        key = str(candidate).lower()
        if key not in seen:
            seen.add(key)
            unique.append(candidate)
    return tuple(unique)


def find_pandoc() -> Path | None:
    for candidate in _pandoc_candidates():
        if candidate.is_file():
            return candidate
    return None


def _subprocess_creation_flags() -> int:
    if os.name == "nt":
        return getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return 0


def pandoc_version(pandoc: Path | None = None) -> str:
    executable = pandoc or find_pandoc()
    if executable is None:
        return ""
    try:
        result = subprocess.run(
            [str(executable), "--version"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
            check=False,
            creationflags=_subprocess_creation_flags(),
        )
    except (OSError, subprocess.SubprocessError):
        return ""
    first_line = (result.stdout or "").splitlines()
    if result.returncode != 0 or not first_line:
        return ""
    return first_line[0].replace("pandoc", "", 1).strip()


def pandoc_health() -> dict:
    executable = find_pandoc()
    version = pandoc_version(executable) if executable else ""
    return {
        "available": bool(executable and version),
        "path": str(executable) if executable else None,
        "version": version or None,
        "interchange_format": "latex",
        "native_format": "docx-omml",
    }


def _require_pandoc() -> tuple[Path, str]:
    executable = find_pandoc()
    if executable is None:
        raise PandocUnavailableError(
            "Pandoc is required for native Word/WPS formula conversion"
        )
    version = pandoc_version(executable)
    if not version:
        raise PandocUnavailableError("Pandoc was found but could not be started")
    return executable, version


def _run_pandoc(args: list[str], *, input_text: str | None = None) -> str:
    executable, _version = _require_pandoc()
    try:
        result = subprocess.run(
            [str(executable), *args],
            input=input_text,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
            creationflags=_subprocess_creation_flags(),
        )
    except subprocess.TimeoutExpired as error:
        raise FormulaConversionError("Formula conversion timed out") from error
    except OSError as error:
        raise FormulaConversionError("Formula converter could not be started") from error
    if result.returncode != 0:
        diagnostic = (result.stderr or result.stdout or "").strip().splitlines()
        detail = diagnostic[-1] if diagnostic else "unknown conversion error"
        raise FormulaConversionError(f"Pandoc formula conversion failed: {detail}")
    return result.stdout


def _formula_fragment_directory(fragment_dir: Path | None = None) -> Path:
    root = (
        Path(fragment_dir)
        if fragment_dir is not None
        else Path(tempfile.gettempdir())
        / "LocalReadTranslate"
        / "formula-fragments"
    )
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def cleanup_formula_fragments(
    fragment_dir: Path | None = None,
    *,
    max_age_seconds: int = FORMULA_FRAGMENT_TTL_SECONDS,
) -> int:
    root = _formula_fragment_directory(fragment_dir)
    cutoff = time.time() - max(1, max_age_seconds)
    removed = 0
    for candidate in root.glob("formula-*.docx"):
        try:
            resolved = candidate.resolve()
            if resolved.parent != root or resolved.stat().st_mtime >= cutoff:
                continue
            resolved.unlink()
            removed += 1
        except (FileNotFoundError, OSError):
            continue
    return removed


def _safe_docx_entry_name(name: str) -> str:
    normalized = str(PurePosixPath(str(name).lstrip("/")))
    if not normalized or normalized == ".":
        raise FormulaConversionError("DOCX package contains an empty part name")
    if normalized.startswith("../") or "/../" in f"/{normalized}/":
        raise FormulaConversionError("DOCX package contains an unsafe part name")
    return normalized


def _validate_docx_bytes(data: bytes) -> None:
    if not data or len(data) > MAX_DOCX_BYTES:
        raise FormulaConversionError("DOCX payload is empty or too large")
    try:
        with zipfile.ZipFile(io.BytesIO(data), "r") as archive:
            entries = archive.infolist()
            if len(entries) > MAX_DOCX_ENTRIES:
                raise FormulaConversionError("DOCX package contains too many parts")
            total_size = 0
            names = set()
            for entry in entries:
                name = _safe_docx_entry_name(entry.filename)
                names.add(name)
                total_size += max(0, entry.file_size)
                if total_size > MAX_DOCX_EXPANDED_BYTES:
                    raise FormulaConversionError("DOCX package expands beyond the safety limit")
            required = {"[Content_Types].xml", "word/document.xml"}
            if not required.issubset(names):
                raise FormulaConversionError("DOCX package is missing required document parts")
    except zipfile.BadZipFile as error:
        raise FormulaConversionError("DOCX payload is not a valid package") from error


def _inspect_docx_math(data: bytes) -> tuple[int, int]:
    _validate_docx_bytes(data)
    with zipfile.ZipFile(io.BytesIO(data), "r") as archive:
        document_xml = archive.read("word/document.xml").decode("utf-8", "replace")
    native_count = len(re.findall(r"<m:oMath(?:\s|>)", document_xml))
    display_count = len(re.findall(r"<m:oMathPara(?:\s|>)", document_xml))
    return native_count, display_count


def generate_formula_fragment(
    text: str,
    *,
    fragment_dir: Path | None = None,
) -> GeneratedFormulaFragment:
    canonical = canonicalize_latex_interchange(text)
    if canonical.formula_count == 0:
        raise FormulaConversionError("No LaTeX formulas were detected")

    executable, version = _require_pandoc()
    root = _formula_fragment_directory(fragment_dir)
    cleanup_formula_fragments(root)
    filename = f"formula-{uuid.uuid4().hex}.docx"
    output_path = (root / filename).resolve()
    if output_path.parent != root:
        raise FormulaConversionError("Unsafe formula fragment path")

    try:
        result = subprocess.run(
            [
                str(executable),
                f"--from={PANDOC_INPUT_FORMAT}",
                "--to=docx",
                f"--output={output_path}",
            ],
            input=canonical.text,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            check=False,
            creationflags=_subprocess_creation_flags(),
        )
    except subprocess.TimeoutExpired as error:
        raise FormulaConversionError("Formula conversion timed out") from error
    except OSError as error:
        raise FormulaConversionError("Formula converter could not be started") from error

    if result.returncode != 0:
        output_path.unlink(missing_ok=True)
        diagnostic = (result.stderr or result.stdout or "").strip().splitlines()
        detail = diagnostic[-1] if diagnostic else "unknown conversion error"
        raise FormulaConversionError(f"Pandoc formula conversion failed: {detail}")

    try:
        data = output_path.read_bytes()
        native_count, native_display_count = _inspect_docx_math(data)
    except Exception:
        output_path.unlink(missing_ok=True)
        raise

    if native_count < canonical.formula_count:
        output_path.unlink(missing_ok=True)
        raise FormulaConversionError(
            "Not every LaTeX expression became an editable native formula"
        )

    warnings = list(canonical.warnings)
    if native_count != canonical.formula_count:
        warnings.append(
            "The native document contains a different number of math objects than the source"
        )

    return GeneratedFormulaFragment(
        canonical_latex=canonical.text,
        docx_base64=base64.b64encode(data).decode("ascii"),
        local_path=str(output_path),
        filename=filename,
        formula_count=canonical.formula_count,
        inline_formula_count=canonical.inline_formula_count,
        display_formula_count=canonical.display_formula_count,
        native_formula_count=native_count,
        native_display_formula_count=native_display_count,
        warnings=tuple(warnings),
        generator="pandoc",
        generator_version=version,
    )


def decode_docx_base64(content: str) -> bytes:
    try:
        data = base64.b64decode(str(content or ""), validate=True)
    except (binascii.Error, ValueError) as error:
        raise FormulaConversionError("DOCX content is not valid base64") from error
    _validate_docx_bytes(data)
    return data


def read_wps_local_docx(
    content: str,
    *,
    temp_root: Path | None = None,
) -> bytes:
    """Read a one-shot WPS selection spool from the current user's temp root."""

    raw_path = str(content or "").strip()
    candidate = Path(raw_path)
    root = (
        Path(temp_root)
        if temp_root is not None
        else Path(tempfile.gettempdir())
    ).resolve()
    if not raw_path or not candidate.is_absolute():
        raise FormulaConversionError("Unsafe WPS formula spool path")
    try:
        resolved = candidate.resolve(strict=True)
    except (FileNotFoundError, OSError) as error:
        raise FormulaConversionError("WPS formula spool file is unavailable") from error
    if (
        resolved.parent != root
        or _WPS_LOCAL_DOCX_NAME.fullmatch(resolved.name) is None
    ):
        raise FormulaConversionError("Unsafe WPS formula spool path")
    try:
        with resolved.open("rb") as handle:
            data = handle.read(MAX_DOCX_BYTES + 1)
    except OSError as error:
        raise FormulaConversionError("WPS formula spool file is unavailable") from error
    _validate_docx_bytes(data)
    return data


def _flat_opc_content_types(parts: dict[str, str]) -> bytes:
    ElementTree.register_namespace("", _CONTENT_TYPES_NAMESPACE)
    root = ElementTree.Element(f"{{{_CONTENT_TYPES_NAMESPACE}}}Types")
    ElementTree.SubElement(
        root,
        f"{{{_CONTENT_TYPES_NAMESPACE}}}Default",
        {
            "Extension": "rels",
            "ContentType": (
                "application/vnd.openxmlformats-package.relationships+xml"
            ),
        },
    )
    ElementTree.SubElement(
        root,
        f"{{{_CONTENT_TYPES_NAMESPACE}}}Default",
        {"Extension": "xml", "ContentType": "application/xml"},
    )
    default_content_types = {
        "application/xml",
        "application/vnd.openxmlformats-package.relationships+xml",
    }
    for name, content_type in sorted(parts.items()):
        if (
            name == "[Content_Types].xml"
            or not content_type
            or content_type in default_content_types
        ):
            continue
        ElementTree.SubElement(
            root,
            f"{{{_CONTENT_TYPES_NAMESPACE}}}Override",
            {"PartName": f"/{name}", "ContentType": content_type},
        )
    return ElementTree.tostring(
        root,
        encoding="utf-8",
        xml_declaration=True,
    )


def _flat_opc_root_relationships() -> bytes:
    ElementTree.register_namespace("", _RELATIONSHIPS_NAMESPACE)
    root = ElementTree.Element(
        f"{{{_RELATIONSHIPS_NAMESPACE}}}Relationships"
    )
    ElementTree.SubElement(
        root,
        f"{{{_RELATIONSHIPS_NAMESPACE}}}Relationship",
        {
            "Id": "rId1",
            "Type": _OFFICE_DOCUMENT_RELATIONSHIP,
            "Target": "word/document.xml",
        },
    )
    return ElementTree.tostring(
        root,
        encoding="utf-8",
        xml_declaration=True,
    )


def _flat_opc_empty_relationships() -> bytes:
    ElementTree.register_namespace("", _RELATIONSHIPS_NAMESPACE)
    root = ElementTree.Element(
        f"{{{_RELATIONSHIPS_NAMESPACE}}}Relationships"
    )
    return ElementTree.tostring(
        root,
        encoding="utf-8",
        xml_declaration=True,
    )


def flat_opc_to_docx(content: str) -> bytes:
    if not content or len(content) > MAX_DOCX_EXPANDED_BYTES:
        raise FormulaConversionError("Flat OPC payload is empty or too large")
    try:
        root = ElementTree.fromstring(content)
    except ElementTree.ParseError as error:
        raise FormulaConversionError("Flat OPC payload is not valid XML") from error
    if root.tag != f"{_PKG}package":
        raise FormulaConversionError("Expected an Office Flat OPC package")

    # ElementTree otherwise rewrites the core Word namespaces as ns0/ns1.
    # Pandoc's DOCX reader expects the conventional w:/m: qualified names.
    for prefix, namespace in _WORD_XML_NAMESPACES.items():
        ElementTree.register_namespace(prefix, namespace)

    part_count = 0
    expanded_size = 0
    part_content_types: dict[str, str] = {}
    document_payload: bytes | None = None
    for part in root.findall(f"{_PKG}part"):
        part_count += 1
        if part_count > MAX_DOCX_ENTRIES:
            raise FormulaConversionError("Flat OPC package contains too many parts")
        name = _safe_docx_entry_name(part.attrib.get(f"{_PKG}name", ""))
        if name in part_content_types:
            raise FormulaConversionError(
                f"Flat OPC package contains duplicate part {name}"
            )
        part_content_types[name] = str(
            part.attrib.get(f"{_PKG}contentType", "")
        ).strip()
        xml_data = part.find(f"{_PKG}xmlData")
        binary_data = part.find(f"{_PKG}binaryData")
        if xml_data is not None:
            children = list(xml_data)
            if not children:
                payload = b""
            else:
                payload = b"".join(
                    ElementTree.tostring(
                        child,
                        encoding="utf-8",
                        xml_declaration=index == 0,
                    )
                    for index, child in enumerate(children)
                )
        elif binary_data is not None:
            try:
                payload = base64.b64decode(
                    "".join(binary_data.itertext()).strip(),
                    validate=True,
                )
            except (binascii.Error, ValueError) as error:
                raise FormulaConversionError(
                    f"Flat OPC binary part {name} is invalid"
                ) from error
        else:
            payload = b""
        expanded_size += len(payload)
        if expanded_size > MAX_DOCX_EXPANDED_BYTES:
            raise FormulaConversionError("Flat OPC package exceeds the safety limit")
        if name == "word/document.xml":
            document_payload = payload

    if document_payload is None:
        raise FormulaConversionError(
            "Flat OPC selection is missing word/document.xml"
        )

    # Word Range.getOoxml() is a selection package, not a complete document.
    # It may omit package metadata or contain relationships to parts outside
    # the selection.  Build a deliberately minimal DOCX from the selected
    # document XML only.  Text and OMML equations are inline in this part;
    # excluding unrelated relationships also prevents broken targets from
    # making Pandoc reject an otherwise valid selection.
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            _flat_opc_content_types(
                {
                    "word/document.xml": (
                        "application/vnd.openxmlformats-officedocument."
                        "wordprocessingml.document.main+xml"
                    )
                }
            )
        )
        archive.writestr("_rels/.rels", _flat_opc_root_relationships())
        archive.writestr("word/document.xml", document_payload)
        archive.writestr(
            "word/_rels/document.xml.rels",
            _flat_opc_empty_relationships(),
        )

    data = buffer.getvalue()
    _validate_docx_bytes(data)
    return data


@functools.lru_cache(maxsize=2)
def _pandoc_reference_docx(executable: str) -> bytes:
    """Load Pandoc's complete reference DOCX once per converter executable."""

    try:
        result = subprocess.run(
            [executable, "--print-default-data-file=reference.docx"],
            capture_output=True,
            timeout=30,
            check=False,
            creationflags=_subprocess_creation_flags(),
        )
    except subprocess.TimeoutExpired as error:
        raise FormulaConversionError(
            "Formula converter reference document timed out"
        ) from error
    except OSError as error:
        raise FormulaConversionError(
            "Formula converter reference document could not be loaded"
        ) from error
    if result.returncode != 0:
        diagnostic = (result.stderr or result.stdout or b"").decode(
            "utf-8",
            "replace",
        )
        detail = diagnostic.strip().splitlines()
        suffix = detail[-1] if detail else "unknown reference document error"
        raise FormulaConversionError(
            f"Formula converter reference document failed: {suffix}"
        )

    data = bytes(result.stdout)
    _validate_docx_bytes(data)
    return data


def _hydrate_word_selection_docx(
    selection_docx: bytes,
    *,
    executable: Path,
) -> bytes:
    """Place a Word selection document.xml into Pandoc's valid DOCX shell."""

    _validate_docx_bytes(selection_docx)
    with zipfile.ZipFile(io.BytesIO(selection_docx), "r") as archive:
        document_payload = archive.read("word/document.xml")

    reference = _pandoc_reference_docx(str(executable))
    output = io.BytesIO()
    with (
        zipfile.ZipFile(io.BytesIO(reference), "r") as source,
        zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as target,
    ):
        for info in source.infolist():
            if info.is_dir() or info.filename == "word/document.xml":
                continue
            target.writestr(info, source.read(info.filename))
        target.writestr("word/document.xml", document_payload)

    data = output.getvalue()
    _validate_docx_bytes(data)
    return data


def native_formula_to_latex(
    source_format: Literal["docx-base64", "docx-local-path", "flat-opc"],
    content: str,
    *,
    work_dir: Path | None = None,
) -> NativeToLatexResult:
    executable, version = _require_pandoc()
    if source_format == "docx-base64":
        docx = decode_docx_base64(content)
    elif source_format == "docx-local-path":
        docx = read_wps_local_docx(content)
    elif source_format == "flat-opc":
        docx = _hydrate_word_selection_docx(
            flat_opc_to_docx(content),
            executable=executable,
        )
    else:
        raise FormulaConversionError("Unsupported native formula source format")

    root = _formula_fragment_directory(work_dir)
    input_path = (root / f"native-{uuid.uuid4().hex}.docx").resolve()
    if input_path.parent != root:
        raise FormulaConversionError("Unsafe native formula work path")
    try:
        input_path.write_bytes(docx)
        markdown = _run_pandoc(
            [
                str(input_path),
                "--from=docx",
                f"--to={PANDOC_OUTPUT_FORMAT}",
                "--wrap=none",
            ]
        )
    finally:
        input_path.unlink(missing_ok=True)

    canonical = canonicalize_latex_interchange(markdown)
    if canonical.formula_count == 0:
        raise FormulaConversionError(
            "The selected native content did not contain an editable formula"
        )
    return NativeToLatexResult(
        latex=canonical.text,
        formula_count=canonical.formula_count,
        inline_formula_count=canonical.inline_formula_count,
        display_formula_count=canonical.display_formula_count,
        warnings=canonical.warnings,
        generator="pandoc",
        generator_version=version,
    )
