# Microsoft Word / WPS Writer / WPS PDF add-ins

This directory contains the installable LocalReadTranslate document add-ins.
Three host packages reuse the same source-first document assistant:

- **Translate selection** uses only eligible models discovered on the selected
  Local Ollama or Project Server source. Formula-bearing selections are
  canonicalized to LaTeX first: Word/Writer export native equations, while WPS
  PDF uses the selected model to reconstruct formula structure. The result
  keeps `$...$` / `$$...$$` when copied; Word and WPS Writer can also replace
  the current selection.
- **Read selection** uses the API voice/speed catalog and local WAV playback.
  Plain English can go directly to Kokoro. English plus formulas uses the same
  progressive queue as the userscript: prose starts while formula
  verbalization runs in the background, then each formula is spoken in place.
  CJK/formula content keeps the `/read/prepare` path.
- **Formula & LaTeX in editable documents** turns selected prose plus `$...$`
  or `$$...$$` LaTeX into editable native Word/WPS Writer equations and copies
  selected native equations plus prose as canonical plain-text LaTeX.
- **Formula recognition in WPS PDF** reads a selectable PDF formula or
  formula-bearing paragraph, sends that text to the explicitly selected
  discovered model, validates the returned LaTeX, and copies only canonical
  plain text. It does not write back to the PDF.

| Capability | Word | WPS Writer | WPS PDF |
|---|---:|---:|---:|
| Read selected text | Yes | Yes | Yes |
| Translate and copy | Yes | Yes | Yes |
| Replace the document selection | Yes | Yes | No |
| Insert/export editable equations | Yes | Yes | No |
| Recognize selectable PDF formula to LaTeX | N/A | N/A | Yes, selected model |

The task pane mirrors the userscript layout: Translation is the sole expanded
primary section; target/model lifecycle controls are under Advanced; Read
aloud and Formula & LaTeX are separate collapsed sections. Word and WPS Writer
show native conversion in both directions. WPS PDF shows only **Recognize and
copy as LaTeX** and hides equation writeback plus translation replacement. The
pane remembers the source, one model per source, target language, voice and
speed.

LaTeX is the only external interchange format. DOCX/OMML is a short-lived
local insertion/export format and is never copied as an image or proprietary
clipboard object. WPS reverse export uses a random one-shot DOCX directly
under the current user's temporary directory; the API validates the exact path
and package before use, and the controller always invokes cleanup afterward.
These mutation paths are never exposed in WPS PDF. PDF recognition reads the
selection text directly and does not create a DOCX spool, read the Windows
clipboard, or synthesize a `Ctrl+C` keystroke.

## Install and remove

First install the normal LocalReadTranslate environment. Pandoc 3.x is required
for editable-document formula conversion but not for WPS PDF translation,
read-aloud, or model-assisted LaTeX recognition. Save open work, close Word and
the complete WPS Office process, and run:

```powershell
.\install-document-addins.bat
```

The installer:

1. registers the exact Office XML manifest for the current user;
2. atomically merges the `LocalReadTranslateFormula` Writer entry and the
   `LocalReadTranslatePdf` PDF entry into
   `%APPDATA%\kingsoft\wps\jsaddons\publish.xml`, preserving unrelated entries
   and backing up an existing file;
3. starts the strict loopback add-in host on `127.0.0.1:5443` if the tray app
   is not already managing it.

Reopen the applications after installation. In Word, choose
**Home → Add-ins → LocalReadTranslate 文档工作台**. In WPS Writer, choose
**LocalReadTranslate → 阅读与公式**. In WPS PDF, choose
**LocalReadTranslate → 阅读与翻译**.

To remove only these three registrations and an installer-owned standalone
host:

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

- Windows 10/11 with the LocalReadTranslate FastAPI `1.7.19` environment;
- Pandoc 3.x found through `PANDOC_PATH`, `PATH`, or a standard Windows path;
- Microsoft Word desktop for the Office add-in;
- a WPS build with JavaScript add-in support. WPS Writer and WPS PDF were
  probed on WPS 365 desktop `12.1.0.26895`; PDF compatibility is verified for
  that build because the public WPS deployment documentation does not list the
  PDF component type.

## Runtime architecture

```text
Word Office.js adapter ─────┐
WPS Writer JSAPI adapter ───┼─ shared task pane ─ http://127.0.0.1:5443
WPS PDF selection adapter ──┘                         │
                                                     ├─ same-origin API proxy
                                                     │
                                                     ├─ fixed local control relay
                                                     ▼
                                        http://127.0.0.1:5000
                               FastAPI + Pandoc + Ollama routing + Kokoro
```

The add-in host is intentionally small:

- it binds only to `127.0.0.1`;
- it serves an explicit static-file allowlist, not the repository;
- it proxies normal `/api/*` requests only to the loopback FastAPI service;
- it handles only the exact no-body `/api/control/{start|ollama|remote}`
  requests locally, requires an add-in-only header, and forwards those fixed
  actions to the tray-owned URL handler;
- it disables CORS and adds CSP, `nosniff`, no-referrer, and no-store headers;
- it never receives or exposes SSH credentials or remote Ollama settings;
- it allows up to 150 seconds for a bounded upstream request so a cold,
  explicitly selected Ollama model can initialize without a premature 502.

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
| `taskpane/` | Userscript-aligned shared translation/read/formula UI with persisted source-scoped preferences |
| `shared/localreadtranslate-client.js` | Same-origin formula, translation, read, speech, model-lifecycle and fixed tray-control client with source-neutral errors |
| `shared/formula-controller.js` | Host-independent conversion and plain-text clipboard contract |
| `shared/reading-core.js` | Userscript-parity LaTeX normalization, read cleanup, progressive segmentation and conservative formula speech rules |
| `office-word/manifest.xml` | Word task-pane XML manifest |
| `office-word/office-adapter.js` | Word selection text read/replace, `getOoxml()` export and `insertFileFromBase64(..., "Replace")` insertion |
| `wps-word/ribbon.xml` | WPS ribbon command |
| `wps-word/js/ribbon.js` | Creates/toggles one shared WPS task pane |
| `wps-word/wps-adapter.js` | WPS selection text read/replace, `Range.Copy/Paste` one-shot DOCX export, `finally`-driven cleanup, and `Range.InsertFile` insertion |
| `wps-pdf/ribbon.xml` | WPS PDF read/translate ribbon command |
| `wps-pdf/js/ribbon.js` | Creates/toggles the PDF task pane without redefining WPS's read-only `Application.ribbonUI` property |
| `wps-pdf/pdf-adapter.js` | Reads PDF text through `Application.ActiveDocument.Selection.Text()`, exposes model-assisted LaTeX copy, and declares all document-mutation capabilities unavailable |
| `../addon_host.py` | Strict loopback static host, narrow API proxy and fixed-action tray relay |
| `../addin_registration.py` | Atomic, idempotent WPS Writer/PDF `publish.xml` merge/remove |
| `../scripts/install_document_addins.ps1` | Current-user installation |
| `../scripts/uninstall_document_addins.ps1` | Exact current-user removal |

## Data flow

### Translation and model sources

1. Initialization (or explicit Retry) requests translation health and the
   voice catalog once in parallel. Word/Writer also request formula health;
   WPS PDF skips that inapplicable dependency.
2. The pane keeps Local Ollama and Project Server as explicit source rows while
   the mediator is online. Only the selected reachable source contributes
   options, and only `available_model_options` values are rendered.
3. Source and model choices do not trigger another discovery request.
   Ordinary translation also reuses the cached snapshot. Only explicit
   Start/Connect or model keep/unload actions refresh source state. The
   Start/Connect buttons use the same-origin fixed-action relay so WPS does not
   have to launch a custom protocol directly from its WebView.
4. Before `POST /translate`, canonical LaTeX already present in the selection
   is normalized. Formula-like Word/Writer selections use native export, and
   WPS PDF selections use `/document/pdf-selection-to-latex` with the exact
   selected model. A 422 “no formula” response falls back to the original
   prose instead of fabricating math.
5. `POST /translate` receives that canonical selection, the exact selected
   model and target language. Returned formula wrappers are normalized to
   `$...$` / `$$...$$`; this same canonical text drives display, copy and
   mutable-document replacement. WPS PDF intentionally offers copy only.
6. Preferences are stored per task-pane origin. A saved
   `remote:project-server:qwen3:30b` is restored only if discovery still lists
   that exact model on that source; a stale value is never injected into the
   selector. On a fresh reachable Project Server with no saved model, the pane
   prefers exact `qwen3:30b`, then a discovered model no larger than 32B, so a
   listed 100B+ model is not selected merely because it appears first.

### Read aloud

1. The pane reads the current document selection only after the user clicks.
   WPS PDF uses `Application.ActiveDocument.Selection.Text()`; Word and WPS
   Writer use their existing selection adapters.
2. The same preflight used by translation converts a detected native or PDF
   formula selection into canonical LaTeX before read planning.
3. Plain English can go directly to `/tts`. English plus LaTeX uses
   `prepareProgressiveReadPlan`: `/formula/verbalize` starts in the background,
   prose chunks are synthesized immediately, and the queue waits only when it
   reaches a formula whose speech is not ready. Small models may use the same
   conservative local rules as the userscript.
4. CJK/formula content outside the progressive English path requires the
   selected discovered model and calls `/read/prepare`.
5. Every queued `/tts` response is played in source order. Its temporary blob
   URL is revoked after the segment, and **Stop read aloud** invalidates the
   active generation so late TTS/formula responses cannot resume playback.

### LaTeX to native equations (Word and WPS Writer)

1. The task pane reads the current selection only when the user clicks.
2. `POST /document/latex-fragment` canonicalizes supported wrappers and asks
   local Pandoc to create an editable DOCX/OMML fragment.
3. Word inserts the returned base64 package; WPS inserts the returned local
   path.
4. The selection becomes native equations that remain editable in the host.

### Native equations to LaTeX (Word and WPS Writer)

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

### Selectable WPS PDF formulas to LaTeX

1. The button re-reads the current PDF selection through
   `Application.ActiveDocument.Selection.Text()`. WPS preserves visual
   top-to-bottom script order as line breaks in selectable formulas.
2. The shared client posts `{text, html: "", model}` to
   `/document/pdf-selection-to-latex` through the ordinary loopback proxy.
   It does not call the Writer-only `Selection.Copy()` method and does not
   inspect the Windows clipboard.
3. The selected discovered model reconstructs only formula structure supported
   by the text and visual line order. The server rejects output with no valid
   LaTeX and canonicalizes inline/display wrappers before returning it.
4. The shared controller copies the canonical result as plain text. No PDF
   content is replaced and no native equation is inserted.

Word/Writer native formula conversion depends on Pandoc, not Ollama. Neither
local Ollama nor a remote model is required, started, or contacted by those
actions. WPS PDF recognition is different: it calls only the explicitly
selected reachable model and never starts local Ollama implicitly. This first
release supports selectable/vector PDF text; image-only or scanned formulas
need a future OCR/vision route.

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
- A live WPS PDF compatibility probe on `12.1.0.26895` established that:
  - a `type="pdf"` `publish.xml` entry is loaded by the PDF component;
  - WPS requests the package manifest, ribbon, entry page and scripts;
  - the PDF object model exposes `Application.ActiveDocument.Selection.Text()`;
  - the Writer adapter fails in PDF because `Application.Selection` is absent,
    which is why the dedicated PDF adapter is required;
  - WPS PDF exposes a non-configurable `Application.ribbonUI`, so the PDF
    ribbon retains its callback handle inside the module instead of assigning
    that property.
- The formal `LocalReadTranslatePdf` package was then installed in the same
  WPS build:
  - its `publish.xml` and `authaddin.json` entries were enabled and loaded;
  - the PDF ribbon opened a task pane labelled `WPS PDF`;
  - the pane read a real selected PDF paragraph while selection replacement
    and equation writeback stayed hidden;
  - clicking **朗读选区** started real local audio playback, changed the
    control to **停止朗读**, and stopped cleanly.
- After the Project Server recovered, the same installed PDF pane completed a
  real formula recognition click with exact
  `remote:project-server:qwen3:30b`:
  - the pane showed `Project Server / qwen3:30b` even though larger models were
    installed;
  - clicking **识别并复制为 LaTeX** re-read a 92-character selected formula;
  - the pane reported **已复制 1 个公式** and the add-in proxy logged HTTP 200;
  - the clipboard contained exactly one canonical display formula:

    ```latex
    $$
    u_1 = \underbrace{-2.41x_1 + 0.426x_2 + 0.276x_1^2 - \cdots - 0.453x_2^4 - 0.0691}_{18 \text{ terms}},
    $$
    ```

  - remote `/api/ps` listed only `qwen3:30b` (`30.5B`, `Q4_K_M`); no 100B+
    model and no local Ollama were used.
- The current assistant core has 27 Node subtests covering the translation,
  read/audio, source filtering, preference restore, explicit connection poll,
  Word/WPS selection replacement, formula controller, WPS Writer ribbon, PDF
  selection, PDF model recognition, canonical LaTeX translation, userscript-
  parity progressive formula reading, and the 30B-over-122B default rule.
- The focused Python add-in-host/formula API suite has 27 passing tests,
  including the explicit `/wps-pdf/*` static allowlist, normal proxying of PDF
  selections without clipboard access, legacy-console-safe request logging,
  font-run/plain-line reconstruction prompts, and canonical response checks.
- The exact add-in proxy path was tested with
  `remote:project-server:qwen3:30b` (never a 100B+ model):
  - selected-text translation returned Simplified Chinese and preserved
    `$x^2 + y^2 = z^2$`;
  - `/read/prepare` returned an English formula reading with the same exact
    model;
  - `/tts` returned `200 audio/wav`, 307,244 bytes and a `RIFF` header;
  - the 30B model was explicitly unloaded afterward, Project Server remained
    reachable, and local Ollama remained stopped.
- Iteration 10 reloaded the add-in host and repeated the flow in the installed
  WPS PDF pane with a real prose-plus-display-formula selection:
  - the Chinese translation result retained canonical `$...$` LaTeX for
    `p(x,c)`, `uSAC(x)`, `\min c`, and the inequality;
  - **Read selection** changed to **Stop reading**, played prose and formula in
    document order, then returned to the idle label;
  - the complete regression finished at `77/77` Node tests (27 add-in and 50
    userscript), plus `264` Python tests and `17` Python subtests.
  - the exact 30B model was unloaded after verification; its final state was
    not running or pinned, Project Server stayed reachable, and local Ollama
    stayed offline.
- Isolated browser checks at 390 px and 280 px found no horizontal overflow.
  The WPS PDF read and formula-recognition buttons are now verified in the
  formal package. The earlier translation/read-preparation API evidence still
  used the same exact 30B model through the add-in proxy.

See
[`../docs/iteration-9-2026-07-23-wps-pdf-addin.md`](../docs/iteration-9-2026-07-23-wps-pdf-addin.md)
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
checks formula, translation and voice capability only during initial load and
explicit retry; ordinary actions do not repeat “Checking translation
sources”.

### Local or Project Server models are missing

Choose the source row first. An offline Local Ollama row shows **Start**; a
disconnected Project Server row shows **Connect**. Once the selected source is
reachable, only its discovered generation models appear. A connected source
with no generation model stays visibly connected and does not invent a
default. Source credentials remain in the tray app. The pane polls only after
an explicit Start/Connect action and refreshes the list automatically when
that source becomes ready.

### WPS PDF formula recognition says there is no selection

Select the formula (or the paragraph containing it) in the PDF itself, then
click **识别并复制为 LaTeX**. The button re-reads the selection at action time,
so opening or hiding the task pane does not cache old document content. This
path requires selectable/vector text and one reachable discovered generation
model. Scanned image-only formulas are not silently sent through text
recognition and are not supported by the current text-only 30B path.

### Pandoc is unavailable

Install Pandoc 3.x or set `PANDOC_PATH`, restart only the local FastAPI service,
and click **Retry**. The formula health endpoint does not expose the executable
path.

### WPS does not show the Writer or PDF ribbon

WPS reads `publish.xml` at startup. Close WPS only after saving the document,
then reopen it. Confirm the WPS build includes JS add-in support and that
`http://127.0.0.1:5443/wps-word/ribbon.xml` and
`http://127.0.0.1:5443/wps-pdf/ribbon.xml` are reachable. Writer and PDF are
separate WPS component registrations; opening a Writer document cannot prove
that the PDF entry loaded.

Host API references:

- [Office add-in XML manifest](https://learn.microsoft.com/en-us/office/dev/add-ins/develop/xml-manifest-overview)
- [Word Range API](https://learn.microsoft.com/en-us/javascript/api/word/word.range?view=word-js-preview)
- [WPS add-in deployment](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-addin-development/wps-addin-development-instructions)
- [WPS task panes](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/addin-api/TaskPane/task-pane-overview)
- [WPS Range.InsertFile](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/wps/Range/member/InsertFile)
- [WPS ActivePDF selection APIs](https://open.wps.cn/documents/app-integration-dev/docs-center/online-preview-edit/client/PDF/ActivePDF)
- [WPS Writer `Selection.Copy()`](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/wps/Selection/member/Copy)

The PDF API documents `GetTextSelection()` and `GetSelectionPicture()` but no
PDF `Copy()` method. The similarly named `Selection.Copy()` page is a Writer
API, which is why the PDF add-in reads selection text directly instead of
calling or emulating that method.
