# Office / WPS LaTeX formula add-in core

This directory contains the shared formula workflow and the host adapters for a
future Microsoft Word and WPS Writer add-in. It is an implementation core, not
yet an installable add-in package: there is no task-pane UI, Office manifest,
WPS ribbon package, HTTPS add-in host, or installer in this iteration.

## Interchange contract

LaTeX is the only format copied outside a document:

- inline formulas use `$...$`;
- display formulas use `$$...$$`;
- paragraph breaks and surrounding prose are preserved;
- Word/WPS native equations are used only inside the document;
- failed or unsupported conversions return an error or warning instead of
  silently copying an image or an invented approximation.

The backend accepts the browser's historical `[[MATH: ...]]` wrapper, the new
`[[MATH_BLOCK: ...]]` wrapper, `\(...\)`, `\[...\]`, dollar delimiters, and
common display environments. It canonicalizes them before native conversion.

## Modules

| Module | Responsibility |
|---|---|
| `shared/localreadtranslate-client.js` | Calls the loopback formula endpoints and normalizes connection errors |
| `shared/formula-controller.js` | Implements “Convert selected LaTeX” and “Copy selection as LaTeX” without host-specific logic |
| `office-word/office-adapter.js` | Uses Word `getOoxml()` for export and `insertFileFromBase64(..., "Replace")` for insertion |
| `wps-word/wps-adapter.js` | Uses a temporary DOCX for selection export and `Range.InsertFile` for insertion |

The Python conversion engine is [`../document_formula.py`](../document_formula.py).
It uses Pandoc to convert canonical LaTeX paragraphs to editable DOCX/OMML and
to convert selected native Word/WPS equations back to canonical LaTeX.

## Data flow

### LaTeX paragraph to editable native equations

1. The adapter reads the selected paragraph as plain text.
2. `POST /document/latex-fragment` canonicalizes the LaTeX and creates a
   short-lived DOCX/OMML fragment.
3. Word inserts the returned base64 DOCX; WPS inserts the returned local path.
4. The inserted equations remain native and editable in the document.

### Native equations to the clipboard

1. Word exports the selection as Flat OPC; WPS exports the selection to a
   temporary DOCX.
2. `POST /document/native-to-latex` validates the package and converts it back
   to canonical LaTeX.
3. The shared controller writes only the returned plain-text LaTeX to the
   clipboard.

## Local requirements

- LocalReadTranslate FastAPI `1.7.16`;
- Pandoc 3.x available through `PANDOC_PATH`, `PATH`, or a standard Windows
  installation path;
- Microsoft Word or WPS Writer for the corresponding host adapter.

The WPS insertion path is local-machine only and expires after one hour. The
backend validates decoded package size, expanded ZIP size, entry count, and
entry paths before conversion.

## Current verification

- 50-formula corpus: 50 LaTeX formulas became 50 OMML formulas and 50 formulas
  survived the native-to-LaTeX round trip;
- Microsoft Word 16.0 opened the generated corpus as 50 native formulas across
  61 paragraphs;
- WPS Writer 12.0 opened the same corpus as 50 native formulas across
  61 paragraphs;
- controller and host-adapter contract tests pass under Node;
- backend parser, API, package validation, and Pandoc round-trip tests pass.

The generated document interoperability is therefore verified in both desktop
applications. The live Office.js/WPS add-in buttons are not yet verified
because the installable task-pane shells are the next phase.

## Next phase

1. Build a minimal task pane with two commands: **Convert LaTeX** and
   **Copy as LaTeX**.
2. Add the Office manifest and an HTTPS loopback/static host.
3. Add the WPS ribbon/task-pane package and registration script.
4. Run live button-level acceptance tests in both applications.
5. Package and document installation only after those host-level tests pass.

Host API references:

- [Word Range API](https://learn.microsoft.com/en-us/javascript/api/word/word.range?view=word-js-preview)
- [Word LaTeX equations](https://learn.microsoft.com/en-us/office/math/latex)
- [Word MathML and clipboard behavior](https://learn.microsoft.com/en-us/office/math/mathml)
- [WPS Range.InsertFile](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/wps/Range/member/InsertFile)
- [WPS OMath API](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/wps/OMath/obj)
