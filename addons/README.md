# Microsoft Word / WPS Writer formula add-ins

This directory contains the installable LocalReadTranslate document add-ins.
Both hosts expose the same two actions:

- **Convert to document formula** turns selected prose plus `$...$` or
  `$$...$$` LaTeX into editable native Word/WPS equations.
- **Copy as LaTeX** exports the selected native equations and surrounding
  prose, canonicalizes the equations, and writes plain text only.

LaTeX is the only external interchange format. DOCX/OMML is a short-lived
local insertion/export format and is never copied as an image or proprietary
clipboard object. WPS reverse export uses a random one-shot DOCX directly
under the current user's temporary directory; the API validates the exact path
and package before use, and the controller always invokes cleanup afterward.

## Install and remove

First install the normal LocalReadTranslate environment and Pandoc 3.x. Then
close Word and WPS Writer and run:

```powershell
.\install-document-addins.bat
```

The installer:

1. registers the exact Office XML manifest for the current user;
2. safely merges one `LocalReadTranslateFormula` entry into
   `%APPDATA%\kingsoft\wps\jsaddons\publish.xml`, preserving unrelated entries
   and backing up an existing file;
3. starts the strict loopback add-in host on `127.0.0.1:5443` if the tray app
   is not already managing it.

Reopen the applications after installation. In Word, choose
**Home → Add-ins → LocalReadTranslate 公式工作台**. In WPS Writer, choose
**LocalReadTranslate → LaTeX 公式**.

To remove only these two registrations and an installer-owned standalone host:

```powershell
.\uninstall-document-addins.bat
```

The uninstaller does not remove other Office/WPS add-ins, stop the remote
Ollama tunnel, stop the local FastAPI service, or change local Ollama.

Advanced installer switches:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install_document_addins.ps1 -OfficeOnly
powershell -ExecutionPolicy Bypass -File scripts\install_document_addins.ps1 -WpsOnly
powershell -ExecutionPolicy Bypass -File scripts\install_document_addins.ps1 -NoStart
```

Local requirements:

- Windows 10/11 with the LocalReadTranslate FastAPI `1.7.17` environment;
- Pandoc 3.x found through `PANDOC_PATH`, `PATH`, or a standard Windows path;
- Microsoft Word desktop for the Office add-in;
- a WPS Writer build with JavaScript add-in support for the WPS add-in.

## Runtime architecture

```text
Word Office.js adapter ─┐
                        ├─ shared task pane ─ http://127.0.0.1:5443
WPS JSAPI adapter ──────┘                         │
                                                │ same-origin /api proxy
                                                ▼
                                   http://127.0.0.1:5000
                                   FastAPI + Pandoc
```

The add-in host is intentionally small:

- it binds only to `127.0.0.1`;
- it serves an explicit static-file allowlist, not the repository;
- it proxies only `/api/*` to the loopback FastAPI service;
- it disables CORS and adds CSP, `nosniff`, no-referrer, and no-store headers;
- it never receives or exposes SSH credentials or remote Ollama settings.

The default development installation uses loopback HTTP because it works in
the tested desktop Word/WPS hosts without modifying the Windows certificate
trust store. `addon_host.py --cert ... --key ...` supports TLS when the caller
already owns a suitable trusted certificate, but the installer deliberately
does not create or trust one.

The host process can be owned by the tray app. Stopping that optional host does
not stop the remote tunnel; closing the tray app follows the tray application's
existing lifecycle rules.

## Components

| Path | Responsibility |
|---|---|
| `taskpane/` | Shared two-action UI; service health is checked once on initialization or explicit retry |
| `shared/localreadtranslate-client.js` | Same-origin formula API client with source-neutral errors |
| `shared/formula-controller.js` | Host-independent conversion and plain-text clipboard contract |
| `office-word/manifest.xml` | Word task-pane XML manifest |
| `office-word/office-adapter.js` | Word `getOoxml()` export and `insertFileFromBase64(..., "Replace")` insertion |
| `wps-word/ribbon.xml` | WPS ribbon command |
| `wps-word/js/ribbon.js` | Creates/toggles one shared WPS task pane |
| `wps-word/wps-adapter.js` | WPS `Range.Copy/Paste` one-shot DOCX export, `finally`-driven cleanup, and `Range.InsertFile` insertion |
| `../addon_host.py` | Strict loopback static host and narrow API proxy |
| `../addin_registration.py` | Idempotent WPS `publish.xml` merge/remove |
| `../scripts/install_document_addins.ps1` | Current-user installation |
| `../scripts/uninstall_document_addins.ps1` | Exact current-user removal |

## Data flow

### LaTeX to native equations

1. The task pane reads the current selection only when the user clicks.
2. `POST /document/latex-fragment` canonicalizes supported wrappers and asks
   local Pandoc to create an editable DOCX/OMML fragment.
3. Word inserts the returned base64 package; WPS inserts the returned local
   path.
4. The selection becomes native equations that remain editable in the host.

### Native equations to LaTeX

1. Word exports the selection as Flat OPC. WPS uses native
   `Range.Copy()` followed by `Range(0, 0).Paste()` in a temporary document,
   then saves a randomly named one-shot DOCX.
2. WPS sends `docx-local-path`, not WebView-encoded binary data. The API
   requires a matching filename directly under the current user's temporary
   root, then validates package size, entry count, expanded size, and structure.
3. The shared controller removes the WPS spool in `finally`, including API or
   clipboard failures.
4. Word selection packages are placed into Pandoc's complete reference DOCX
   shell while preserving conventional `w:` and `m:` namespaces.
5. Only canonical plain-text LaTeX plus surrounding prose is written to the
   clipboard.

Formula conversion depends on Pandoc, not Ollama. Neither local Ollama nor a
remote model is required, started, or contacted by these actions.

## Current verification

- The 50-formula corpus becomes 50 native OMML equations and round-trips as 50
  formulas.
- Microsoft Word 16.0 and WPS Writer 12.1.0.26895 both opened that corpus as 50 native
  equations across 61 paragraphs.
- The installed Microsoft Word task pane was exercised in a real blank
  document:
  - `测试公式 $x^2 + y^2 = z^2$ 和 $\frac{a}{b}$。` became two editable
    native equations;
  - selecting the result and clicking **Copy as LaTeX** produced
    `测试公式 $x^{2} + y^{2} = z^{2}$ 和 $\frac{a}{b}$。`.
- The installed WPS Writer 12.1.0.26895 task pane completed the same real
  two-button flow in a new unsaved test document:
  - `WPS 测试：$x^2 + y^2 = z^2$，以及 $\frac{a}{b}$。` became two editable
    native equations;
  - selecting the result and clicking **Copy as LaTeX** reported two formulas
    and wrote exactly
    `WPS 测试：$x^{2} + y^{2} = z^{2}$，以及 $\frac{a}{b}$。` once.
- WPS package structure, ribbon callbacks, `Copy/Paste` export, one-shot spool
  validation/cleanup, registration merge/remove, and HTTP assets are covered
  by automated tests.

See
[`../docs/iteration-7-2026-07-23-installable-office-wps-addins.md`](../docs/iteration-7-2026-07-23-installable-office-wps-addins.md)
for the release record and exact evidence.

## Troubleshooting

### The task pane is missing

- Confirm `http://127.0.0.1:5443/health` returns
  `localreadtranslate-addin-host`.
- Close and reopen Word/WPS once after registration changes.
- Rerun the installer; it is idempotent.
- For Word, open **Home → Add-ins** and select the add-in once if Office has
  registered it but has not opened the pane automatically.

### The pane says the local service is offline

Start `Kokoro TTS.bat` or `start.bat`, then click **Retry**. The task pane
checks formula health only during initial load and explicit retry; ordinary
actions do not repeat “Checking translation sources”.

### Pandoc is unavailable

Install Pandoc 3.x or set `PANDOC_PATH`, restart only the local FastAPI service,
and click **Retry**. The formula health endpoint does not expose the executable
path.

### WPS does not show the ribbon

WPS reads `publish.xml` at startup. Close WPS only after saving the document,
then reopen it. Confirm the WPS build includes JS add-in support and that
`http://127.0.0.1:5443/wps-word/ribbon.xml` is reachable.

Host API references:

- [Office add-in XML manifest](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/xml-manifest-overview)
- [Word Range API](https://learn.microsoft.com/en-us/javascript/api/word/word.range?view=word-js-preview)
- [WPS add-in deployment](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-addin-development/wps-addin-development-instructions)
- [WPS task panes](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/addin-api/TaskPane/task-pane-overview)
- [WPS Range.InsertFile](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/wps/Range/member/InsertFile)
