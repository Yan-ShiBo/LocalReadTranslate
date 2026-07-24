# 本地划词听译助手 - Local Selection Read & Translate

> Select text in Chrome, read it aloud with local [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M), or translate it with a model that the local mediator has actually discovered from local or tray-configured Ollama sources.

[![CI](https://github.com/Yan-ShiBo/LocalReadTranslate/actions/workflows/ci.yml/badge.svg)](https://github.com/Yan-ShiBo/LocalReadTranslate/actions/workflows/ci.yml)

<p align="center">
  <strong>Local read-aloud · Discovered translation models · Tray-managed remote access</strong>
</p>

---

## ✨ Features

- **Selection read-aloud** — Select text on any webpage → click the floating button → hear natural English speech
- **Streaming playback** — Chrome uses `/tts/stream` with MediaSource + WebM/Opus for long text, while older browsers fall back to OGG/Opus
- **Small audio payloads** — `/tts` can return OGG/Opus with `Accept: audio/ogg` or `?format=ogg`; WAV remains the default for compatibility
- **17 voices** — American male/female + British female, easily switchable
- **System tray app** — Runs silently in the background, right-click to control, with optional login auto-start
- **Backend-driven source choice** — While the mediator is online, Local Ollama and Project Server remain explicit choices; the selected source shows either its one truthful recovery action or only its discovered generation models
- **Compact translation workflow** — A two-row source rail comes before one source-filtered model selector and one translation test; target language/model residency and read-aloud controls stay in collapsed sections
- **Copy selection as canonical LaTeX** — Copy selected prose without translation, preserve paragraph breaks, and normalize detected inline/display MathJax, MathML, and KaTeX formulas to `$...$` / `$$...$$`
- **Installable Word/WPS document add-ins** — The shared task pane brings source-first translation and local read-aloud into Word, WPS Writer and WPS PDF; editable Word/Writer documents retain bidirectional native-equation/LaTeX conversion, while selectable WPS PDF formulas can be recognized and copied as canonical LaTeX with the chosen model
- **Trusted Types friendly UI** — The userscript builds UI with DOM APIs instead of assigning HTML strings, so stricter Google pages such as Gemini can run it
- **Truthful Ollama residency** — Contextual advanced actions can keep or unload the selected model; stale pins can be removed without loading the model, and an unload timeout reports `still_running` instead of claiming VRAM was released
- **Target-language guard** — Chinese targets that return all-English output are retried once with a strict same-model instruction; a second non-compliant result is reported as failure
- **Context-aware selected translation** — Nearby text can be sent as reference context for terminology and pronoun disambiguation, but only the selected text is translated
- **Model-aware context budgets** — 4B models ignore reference context for translation and formula read-aloud stability, while 9B/14B/larger models receive progressively longer context
- **No-think Qwen3 requests** — Qwen3/QwQ/DeepSeek-R1 style reasoning models are called with Ollama `think: false` for lower latency in translation and read preparation
- **Conservative 4B formula reading** — When a 4B model is selected, common formulas are read by local literal rules first (`D_I` -> `D sub I`, `\hat{B}(x)` -> `B hat of x`) instead of asking the model to infer context
- **Progressive formula read-aloud** — For English selections with formulas, text starts playing first while formula verbalization runs in the background; playback waits only if it reaches a formula before the spoken formula is ready
- **Formula-aware cleanup** — MathJax/MathML/LaTeX selections are extracted semantically when possible; read-aloud turns formulas into spoken English, while translation renders formulas as readable math with subscripts and superscripts
- **Configurable math glossary** — `config/math_glossary.json` lists direct readings and contextual meanings for 50+ core symbols such as arrows, hats, subscripts, set braces and calculus operators, so formulas can be spoken more professionally
- **Selection-aware UI** — Read/Translate controls stay below the selection, can run independently, and translation cards reposition around the selected text to reduce overlap
- **Partial formula selection recovery** — Selecting only part of a MathJax/MathML/KaTeX formula expands to the full formula container before translation or read preparation, without dropping surrounding sentence text
- **Smart queueing** — Backend checks client connection status to avoid processing dropped requests, preventing GPU OOM
- **Robust UI cleanup** — Frontend uses `MutationObserver` and `AbortController` to cleanly handle SPA routing changes
- **Playback progress** — Floating button shows a horizontal progress fill; streaming mode shows played seconds until final duration is known
- **GPU-accelerated** — Near real-time inference on NVIDIA GPUs
- **Offline-capable local mode** — After models are downloaded, local TTS and local Ollama do not require the internet; remote mode intentionally sends requests to the configured server

## 📐 Architecture

```text
┌──────────────────────┐       HTTP on loopback       ┌───────────────────────┐
│ Chrome + Tampermonkey│  ──────────────────────►  │ Local FastAPI broker  │
│                      │      127.0.0.1:5000      │                       │
│ Read / Translate     │  ◄──────────────────────  │ /tts → lazy Kokoro   │
│ Backend status UI    │                            │ /translate → Ollama │
└──────────────────────┘                            └──────────┬────────────┘
           │ localreadtranslate://              │
           │ start / ollama / remote             │
           ▼                                     ├─► Local Ollama
┌──────────────────────┐                 SSH/API    └─► Configured remote Ollama
│ Windows tray app     │
│ start or wake server │
└──────────────────────┘
```

The userscript never receives SSH credentials or talks directly to Ollama. The local API is the single browser boundary; the tray app owns process startup, SSH/API configuration and tunnel lifecycle.

Microsoft Word, WPS Writer and WPS PDF use a second strict loopback host on
`127.0.0.1:5443`. It serves only the allowlisted add-in files and proxies
same-origin `/api/*` requests to FastAPI. Translation, read preparation and
speech use the same discovered-source contract as the userscript. The add-ins
send only the selected document text; choosing a remote model intentionally
forwards that selection to the tray-configured server through FastAPI. LaTeX
is the only external formula interchange format; DOCX/OMML is used only for
inserting or reading native editable equations inside Word and WPS Writer.
WPS PDF remains read-only for this add-in: it can translate, copy and read
selected text and can recognize selectable formulas into canonical LaTeX, but
does not expose selection replacement or equation writeback. For WPS Writer
reverse conversion, a randomly named one-shot DOCX is saved directly
under the current user's temporary directory. The API accepts only that exact
directory and filename pattern, validates the DOCX limits, and the controller
invokes spool cleanup after both successful and failed conversions.

## 💻 Requirements

| Item | Requirement |
|------|------------|
| OS | Windows 10/11 |
| GPU | NVIDIA GPU with CUDA support (recommended) |
| Python | Managed via Conda (Python 3.10) |
| eSpeak-NG | Required for phonemization |
| Browser | Chrome + [Tampermonkey](https://www.tampermonkey.net/) |
| Pandoc 3.x | Required only for the Word/WPS native-formula add-ins |

## 🚀 Quick Start

### 1. Install eSpeak-NG

Download from [eSpeak-NG Releases](https://github.com/espeak-ng/espeak-ng/releases), install, and **add to system PATH** (usually `C:\Program Files\eSpeak NG`).

### 2. Run Setup

```powershell
# Clone the repo
git clone https://github.com/Yan-ShiBo/LocalReadTranslate.git
cd LocalReadTranslate

# Double-click setup.bat, or run manually:
conda create -n kokoro-tts python=3.10 -y
conda activate kokoro-tts
pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu124
pip install -r requirements.txt
```

### 3. Start the Server

**Option A: System tray app** (recommended)
- Double-click `Kokoro TTS.bat` — starts the tray app without relying on Windows `.pyw` file associations. On Windows, the tray app also creates or repairs the current-user `localreadtranslate://` URL handler used by the fixed `start`, `ollama`, and `remote` actions.

**Option B: Terminal mode**
- Double-click `start.bat` — shows a console window with logs

Both `.bat` launchers locate the `kokoro-tts` Conda environment Python directly, so normal startup does not require `conda init`. `Kokoro TTS.pyw` is kept as a no-console Python launcher, but it only works by double-click when Windows has a `.pyw` file association. Terminal mode starts only the FastAPI process; use the tray app when you need an SSH tunnel or the browser's one-click service start.

You can register or repair the browser start handler explicitly:

```powershell
conda run -n kokoro-tts python windows_protocol.py register
```

The handler is stored under the current user's registry hive and does not require administrator rights. It contains absolute paths, so rerun the command after moving or renaming the project folder.

To remove only this per-user handler:

```powershell
conda run -n kokoro-tts python windows_protocol.py unregister
```

For local translation, install [Ollama](https://ollama.com/) and pull a model:

```powershell
ollama pull translategemma:4b
# optional larger model
ollama pull qwen3:14b
```

The server-side fallback model is `translategemma:4b` for translation, read preparation and formula verbalization; override it with `OLLAMA_TRANSLATE_MODEL`, `OLLAMA_READ_MODEL` or `OLLAMA_FORMULA_MODEL`. The userscript does not display that fallback as an installed model. Its selector is populated only from `/translate/health` models that belong to the explicitly selected, reachable source and are eligible for text generation; obvious embedding/reranking models are excluded. A valid model is remembered independently for each source. If it disappears, discovery may choose another real model from that same source, but never silently switches the translation source. Context passed to Ollama is capped by model size: 4B models ignore reference context for translation and read-time Chinese-to-English conversion, 9B models get moderate context, and 14B or larger models get longer context. Qwen3/QwQ/DeepSeek-R1 style reasoning models are sent to Ollama with top-level `think: false`.

Use **Keep loaded** in the Translation settings when you plan to translate or read many selections with the same Ollama model. This preloads the model with `keep_alive: -1m` and keeps sending that setting for the pinned model, avoiding repeated first-token delays. Use **Unload** when a model is running. If a pin remains after the model has already left `/api/ps`, Advanced shows **Remove keep-alive** and clears only the mediator pin without loading the model again.

### Remote Ollama over LAN

Right-click the Kokoro TTS tray icon and choose `Remote Service`. The bundled profile is prefilled for `10.12.96.203` but remains disabled by default, so normal startup stays local. Choose one of two connection modes:

- `ssh`: uses your SSH agent, default keys, or matching `~/.ssh/config` entry first; an optional key file can be supplied explicitly, and a password is only used as fallback. The app loads system/OpenSSH host keys and rejects an unknown host, then forwards the remote Ollama endpoint through a local tunnel.
- `api`: connects directly to an Ollama API base URL such as `http://10.12.96.203:11434` without creating a tunnel.

The Translation panel always keeps a **Project Server** source row while the mediator is online. Select it and use **Connect** only when it is disconnected; this fixed action opens the tray-owned `Remote Service` dialog without exposing credentials to the page. After the tray connects, the row changes to **Connected**, the redundant action disappears, and only that server's eligible models are shown. A valid model is remembered per source, and translation failures never silently switch sources. Ollama requests bypass ambient HTTP proxy settings so loopback and LAN prompts are not sent through an unrelated proxy.

The browser script never receives the SSH password or key path. The tray app stores the remote profile in the ignored `tray_settings.json` file. This file is not encrypted: if you enter a fallback password, it is stored as plaintext on this computer. Prefer an SSH agent, OpenSSH config or a key file, and protect the local account and file permissions.

Direct API mode targets a native Ollama base URL. It does not add API-key headers or turn Ollama into an authenticated public service. A URL such as `http://10.12.96.203:11434` is plaintext and should be used only on a trusted LAN or VPN; do not expose an unauthenticated Ollama port to the public internet.

> SSH host identity is fail-closed: the client calls `load_system_host_keys()` and uses Paramiko `RejectPolicy`. Add a host to `known_hosts` only after verifying its fingerprint through a trusted channel. The configured `10.12.96.203` entry exists on this machine and was verified by a successful real reconnection.

The Kokoro TTS model is loaded lazily on the first Read request. Starting the API or translating through a remote model does not initialize Torch/Kokoro or allocate local GPU memory; `/health` exposes `api_ready` and `tts_model_loaded` separately.

Formula wording is guided by `config/math_glossary.json`. Each symbol can define a direct reading, read-aloud defaults and contextual readings, for example right arrow can mean `maps to`, `approaches`, `implies`, `gives`, or simply `right arrow`. Local rules choose common cases first. For 4B models, the formula read-aloud path deliberately prefers these literal rules and omits formula context where possible; the same glossary is included in Ollama prompts only for harder formulas.

### 4. Install the Browser Script

1. Install [Tampermonkey](https://chrome.google.com/webstore/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo) in Chrome
2. Install the published script from Greasy Fork, or open the [GitHub raw userscript](https://raw.githubusercontent.com/Yan-ShiBo/LocalReadTranslate/main/tts-userscript.js) for the development version
3. Confirm installation in Tampermonkey

Editing the repository file does not update a copy already installed in Tampermonkey. See [Tampermonkey development and publishing](#tampermonkey-development-and-publishing) for the local test and release flow.

### 5. Use it!

1. Open any webpage
2. **Select text** → floating `Read`, `Translate`, and `Copy` buttons appear
3. Click `Read` for local English TTS with background formula verbalization, `Translate` with the selected local or remote Ollama model, or `Copy` to copy the selection while preserving paragraphs and canonicalizing inline/display formulas as `$...$` / `$$...$$`
4. Open the gear panel to choose the route first and then the model:
   - while the mediator is online, **Local Ollama** and **Project Server** remain visible as separate source rows, even when one of them is offline;
   - select **Local Ollama** to see only discovered local generation models; if it is offline, the row shows **Start**, which opens the fixed `localreadtranslate://ollama` action and waits for local Ollama;
   - select **Project Server** to see only that server's discovered generation models; if it is disconnected, the row shows **Connect**, which opens the tray-owned Remote Service dialog; an already connected server never asks you to connect again;
   - a reachable selected source with no eligible generation model remains visibly connected and asks for a generation model instead of inventing options;
   - **Start local service** appears only while the mediator itself is offline and opens `localreadtranslate://start`; model, translation-test, Advanced and Read aloud controls stay hidden in that state;
   - a failed translation-health request becomes an explicit **Unavailable** state rather than leaving a contradictory **Checking** badge;
   - background refresh after a translation test, source/model switch, or residency action keeps the last valid source view visible instead of flashing **Checking translation sources...**; changing source, model, or target language clears the now-stale test result;
   - target language and applicable model residency actions are under **Advanced**; voice/speed controls are under **Read aloud**;
   - remote credentials and connection lifecycle remain in the tray app's `Remote Service` dialog, never in the webpage.

> ⌨️ Shortcut: `Ctrl+Shift+S` to read selected text directly.

If the floating gear does not appear on a site such as Gemini, first check Tampermonkey and Chrome extension site access for that domain. The script is declared for `*://*/*`, so a missing gear usually means the userscript did not get injected. If the gear appears but selection buttons do not, the page likely uses custom selection DOM; the script also listens to `selectionchange` as a fallback and expands partial formula selections to full math frames where possible. The UI avoids `innerHTML` and related HTML sinks for Trusted Types compatibility.

## Installable Microsoft Word / WPS Writer / WPS PDF add-ins

Save open documents and close Word and the complete WPS Office process, then
install all current-user add-ins:

```powershell
.\install-document-addins.bat
```

Reopen the applications. In Word, choose
**Home → Add-ins → LocalReadTranslate 文档工作台**. In WPS Writer, choose
**LocalReadTranslate → 阅读与公式**. In WPS PDF, choose
**LocalReadTranslate → 阅读与翻译**.

The shared task pane follows the userscript's layout and state rules:

- **Translation** is the only expanded primary section. Select **Local
  Ollama** or **Project Server**, then choose only a generation model actually
  discovered on that reachable source. Translate the current selection, copy
  the result, or replace the selection in editable Word/Writer documents.
  WPS PDF keeps the copy action and hides replacement.
- **Advanced** contains the target language and only the model residency
  actions that are currently applicable.
- **Read aloud** uses the API voice catalog and plays local WAV audio. Plain
  English can be read without Ollama; Chinese or formula-bearing text uses
  `/read/prepare` with the currently selected discovered model before Kokoro
  TTS.
- **Formula & LaTeX** converts mixed prose plus `$...$` / `$$...$$` into
  editable native equations in Word and WPS Writer, and copies selected native
  equations plus prose as canonical plain-text LaTeX. WPS PDF exposes only
  **Recognize and copy as LaTeX**: it reads the selectable PDF text and its
  visual line breaks, asks the explicitly selected discovered model to restore
  the formula, validates/canonicalizes the result, and copies plain-text LaTeX.
  PDF equation writeback remains hidden.

Source, per-source model, target language, voice and speed are remembered in
the task pane. Initialization (or an explicit retry) discovers the applicable
capabilities once in parallel: Word/Writer include native-formula health,
while WPS PDF requests only translation and voice health because PDF formula
recognition uses the selected Ollama model. Normal translation, read and
formula actions reuse that cached state, so clicking them does not flash
**Checking translation sources...**. On a fresh reachable Project Server
without a saved choice, the pane prefers exact `qwen3:30b`, then a discovered
model no larger than 32B, rather than blindly choosing a listed 100B+ model.
An explicit **Start/Connect** action alone polls source health and refreshes
the real model list when the source becomes reachable. Because WPS WebView does
not reliably launch a custom URL scheme, the add-in sends that click to a
same-origin loopback control endpoint; the host accepts only the fixed
`start`, `ollama`, and `remote` actions and forwards them to the tray-owned
`localreadtranslate://` handler. No server address, credential, model name, or
command is accepted by that endpoint. Word/Writer native formula conversion
does not use Ollama, start local Ollama, or change the remote tunnel. WPS PDF
recognition contacts only the explicitly selected reachable model and never
starts local Ollama implicitly.

The installer registers the exact Office manifest, atomically merges separate
WPS Writer (`type="wps"`) and WPS PDF (`type="pdf"`) `publish.xml` items while
preserving unrelated add-ins, and starts the strict `127.0.0.1:5443` host if
needed. It deliberately does not modify the Windows certificate trust store.
The default HTTP endpoint is for local desktop development only;
`addon_host.py` can use caller-supplied trusted TLS certificate/key files for
another deployment.

To remove only LocalReadTranslate's registrations and an installer-owned
standalone add-in host:

```powershell
.\uninstall-document-addins.bat
```

The 50-formula corpus still produces and round-trips 50 native equations in
both Word 16.0 and WPS Writer 12.1.0.26895. Both installed task panes completed
their real formula paths. Word converted two LaTeX expressions to editable
equations and copied
`测试公式 $x^{2} + y^{2} = z^{2}$ 和 $\frac{a}{b}$。`.
WPS likewise converted two expressions to editable native equations; copying
the selected result reported two formulas and wrote exactly
`WPS 测试：$x^{2} + y^{2} = z^{2}$，以及 $\frac{a}{b}$。`
once, with no duplicate paragraph.

The expanded document-assistant API path was also exercised through the exact
add-in proxy (`127.0.0.1:5443/api/*`) with
`remote:project-server:qwen3:30b`: selected-text translation returned
Simplified Chinese while preserving `$x^2 + y^2 = z^2$`; read preparation
returned English formula speech; and local TTS returned a valid 307,244-byte
RIFF/WAV response. The 30B model was then explicitly unloaded, the project
server remained reachable at that time, and local Ollama remained stopped.
Browser layout checks at 390 px and 280 px found no horizontal overflow.

The formal WPS PDF package was then installed and exercised in WPS 365 desktop
`12.1.0.26895`: the `type="pdf"` entry was enabled, its ribbon and
**阅读与翻译** task pane appeared, the pane identified `WPS PDF`, and the
dedicated adapter read real PDF selections through
`Application.ActiveDocument.Selection.Text()`. Selection replacement and PDF
equation writeback remained absent. Clicking **朗读选区** played the selected
text through local TTS, changed the control to **停止朗读**, and stopped
cleanly.

After the Project Server became reachable again, the real WPS PDF
**识别并复制为 LaTeX** button was exercised with the exact discovered
`remote:project-server:qwen3:30b` model. A selected 92-character formula with
stacked scripts and an 18-term underbrace produced:

```latex
$$
u_1 = \underbrace{-2.41x_1 + 0.426x_2 + 0.276x_1^2 - \cdots - 0.453x_2^4 - 0.0691}_{18 \text{ terms}},
$$
```

The pane reported **已复制 1 个公式**, the add-in proxy returned HTTP 200,
and the remote `/api/ps` snapshot contained only `qwen3:30b`; no 100B+ model
or local-Ollama fallback was used. This path intentionally does not rely on
the Writer-only `Selection.Copy()` API or simulated `Ctrl+C`. Image-only
scanned formulas still require a future vision/OCR path.

See [`addons/README.md`](addons/README.md) for installation and troubleshooting,
and
[`docs/iteration-9-2026-07-23-wps-pdf-addin.md`](docs/iteration-9-2026-07-23-wps-pdf-addin.md)
for the exact release evidence.

## Tampermonkey Development and Publishing

For a local pre-push check, open the installed script in Tampermonkey's editor, replace its contents with the complete local `tts-userscript.js`, and save. A repository edit alone cannot change Tampermonkey storage.

The current repository metadata version is `1.15.3` (FastAPI `1.7.19`).

For each release:

1. Increment the userscript `@version`; Tampermonkey will not replace an installed copy with the same version.
2. Run the catalog, Python, JavaScript and metadata checks in [Tests](#-tests).
3. Commit and push the tested files. Both `@downloadURL` and `@updateURL` point at the raw `main` script, so a versioned push is a userscript release.
4. Open the [raw userscript](https://raw.githubusercontent.com/Yan-ShiBo/LocalReadTranslate/main/tts-userscript.js), or use Tampermonkey's **Check for updates**, and verify that the installed version matches the repository.
5. Publish the same script version on Greasy Fork and update its additional information from `docs/greasyfork-additional-info.md`.

The script metadata includes:

- `@homepageURL`: GitHub project page, shown as the script homepage
- `@supportURL`: GitHub Issues, shown as the feedback/support link
- `@license`: MIT

Keep the GitHub repository linked both through `@homepageURL` and in the Greasy Fork additional information. Before announcing a release, verify that the local file, GitHub raw response, Tampermonkey installation and Greasy Fork page show the same version.

## 🎭 Available Voices

The canonical voice and speed list lives in
[`config/tts_catalog.json`](config/tts_catalog.json). The API, tray menu,
browser script and built-in test page are generated from this catalog.

## 📁 Project Files

| File | Description |
|------|-------------|
| `server.py` | FastAPI server with Kokoro TTS inference |
| `document_formula.py` | Canonical LaTeX parser plus validated Pandoc DOCX/OMML conversion |
| `addons/` | Installable Word/WPS manifests, ribbon, shared document-assistant task pane, controller and host adapters |
| `addon_host.py` | Strict `127.0.0.1:5443` add-in asset host, same-origin API proxy, and fixed-action tray relay |
| `addin_registration.py` | Idempotent WPS `publish.xml` registration merge/remove |
| `audio_encoding.py` | Bundled FFmpeg helpers for OGG/Opus and WebM/Opus |
| `tray_app.py` | System tray application (background mode) |
| `windows_protocol.py` | Per-user `localreadtranslate://` registration and exact validation for the fixed `start`, `ollama`, and `remote` actions |
| `windows_startup.py` | Windows Startup shortcut management for tray auto-start |
| `Kokoro TTS.bat` | Recommended tray launcher; does not require `.pyw` file association |
| `Kokoro TTS.pyw` | No-console launcher for tray app |
| `tts-userscript.js` | Tampermonkey script for local selection read-aloud and translation |
| `docs/greasyfork-additional-info.md` | Markdown content for the Greasy Fork additional info field |
| `setup.bat` | One-click environment setup |
| `start.bat` | Terminal-mode server launcher |
| `install-document-addins.bat` | Current-user Word/WPS add-in installer |
| `uninstall-document-addins.bat` | Exact Word/WPS add-in uninstaller |
| `requirements.txt` | Python dependencies |
| `requirements-test.txt` | Lightweight CI/test dependencies (no Torch/Kokoro) |
| `config/tts_catalog.json` | Canonical voices, speeds and defaults |
| `scripts/sync_catalog.py` | Synchronizes the catalog into the userscript |
| `tests/fixtures/latex-formula-corpus.md` | 50-formula native conversion and round-trip corpus |
| `docs/iteration-9-2026-07-23-wps-pdf-addin.md` | Current WPS PDF read/translate/formula-to-LaTeX add-in release record |
| `docs/iteration-8-2026-07-23-office-wps-document-assistant.md` | Historical Word/WPS read, translate and formula add-in release record |
| `docs/iteration-7-2026-07-23-installable-office-wps-addins.md` | Historical installable formula add-in release record |
| `docs/iteration-6-2026-07-23-office-wps-latex-interchange.md` | Historical formula interchange-core release record |
| `docs/iteration-5-2026-07-23.md` | Historical backend-driven translation/settings release record |
| `docs/iteration-4-2026-07-18.md` | Historical service-control and remote-translation release record |
| `.github/workflows/ci.yml` | Windows CI |

## 🔌 API

### `POST /tts`

```json
{ "text": "Hello, how are you?", "voice": "af_bella", "speed": 0.8 }
```

Returns `audio/wav` by default. Use `Accept: audio/ogg` or `?format=ogg` for OGG/Opus.

### `POST /tts/stream`

```json
{ "text": "Long text can start playing before generation finishes.", "voice": "af_bella", "speed": 0.8 }
```

Returns `audio/webm; codecs="opus"` as a continuous stream for MediaSource playback.

### `POST /translate`

```json
{
  "text": "Hello, how are you?",
  "context": "Optional nearby text used only for disambiguation",
  "target_language": "Simplified Chinese",
  "model": "translategemma:4b"
}
```

Returns JSON with `translated_text`, `model`, `target_language` and `elapsed`.

### `POST /read/prepare`

```json
{
  "text": "中文说明 with $x^2$ and English prose.",
  "model": "translategemma:4b"
}
```

Returns `prepared_text`: plain English read-aloud text for Kokoro. English prose is kept, Chinese prose is translated to English, and formulas are converted to concise spoken English descriptions. If this endpoint is unavailable, the userscript falls back to `/translate` with `target_language: "English"` before using the local cleanup fallback.

### `POST /formula/verbalize`

```json
{
  "formulas": ["\\begin{matrix}a&b\\\\c&d\\end{matrix}"],
  "context": "Optional nearby text",
  "model": "translategemma:4b"
}
```

Fallback endpoint returning concise spoken English descriptions for formulas that cannot be handled by local rules. The server passes the configurable math glossary to Ollama so symbols such as arrows, hats and subscripts can be interpreted from nearby context.
`model` is optional; if omitted, the server uses `OLLAMA_FORMULA_MODEL` (`translategemma:4b` by default).

### `GET /document/latex/health`

Reports whether the local Pandoc conversion layer is available. The response
names `latex` as the interchange format and `docx-omml` as the native format,
but does not expose the local executable path.

### `POST /document/latex-fragment`

```json
{ "text": "First paragraph with $x^2$.\\n\\n$$\\n\\\\frac{a}{b}\\n$$" }
```

Canonicalizes the mixed paragraph and returns a short-lived editable DOCX/OMML
fragment in both `docx_base64` (Word insertion) and `local_path` (WPS
insertion) forms, together with inline/display/native formula counts. At least
one recognized formula is required.

### `POST /document/native-to-latex`

```json
{ "source_format": "flat-opc", "content": "<pkg:package>...</pkg:package>" }
```

Accepts Word `flat-opc` XML, a backwards-compatible `docx-base64` package, or
the WPS add-in's `docx-local-path` one-shot spool. Local paths must resolve to
a matching file directly under the current user's temporary directory; package
size, ZIP entry count, expanded size, and required DOCX structure are then
validated. The response is plain canonical LaTeX plus formula counts, and is
the only copy representation used by the add-in controller.

### `POST /document/pdf-selection-to-latex`

```json
{
  "text": "u1 = -2.41x1 + ...",
  "html": "",
  "model": "remote:project-server:qwen3:30b"
}
```

Reconstructs formulas from a selectable WPS PDF text selection with the
explicitly chosen discovered model. The service treats the selection as
untrusted data, validates and canonicalizes the model output, rejects a result
with no LaTeX formula, and returns only canonical text plus formula counts.
`html` is reserved for optional font-run metadata; the current WPS PDF adapter
uses the direct selection text and does not read the Windows clipboard.

### `GET /translate/health?model=translategemma:4b`

Checks translation sources without starting a translation. A plain model name selects local Ollama; `remote:<source-id>:<model>` selects a tray-configured remote source. Compatibility fields still describe the selected model, while `sources[]` independently reports each configured source's safe ID/name/kind, reachability and models with `running`, `pinned` and `usable_for_translation`. It never exposes remote URLs, hosts, ports or credentials. `available_model_options` is the flattened selector list and excludes non-generation models.

### `POST /translate/model/keepalive`

Preloads the selected local or remote Ollama model and keeps it resident. The contextual **Load & keep / Keep loaded** action follows the currently selected source.

### `POST /translate/model/unload`

Removes the source-aware pin and checks the selected local or remote source first. If the model is already absent from `/api/ps`, the endpoint returns `unloaded` without sending a generation request; otherwise it sends explicit `keep_alive: 0` and reports `unloaded` only after absence is confirmed. A model that remains present is reported as `still_running` with `model_running: true`.

### `GET /health` — API and TTS status

Returns `api_ready` and `tts_model_loaded` separately. A healthy translation-only service can report `api_ready: true`, `tts_model_loaded: false`, `device: null` and no local GPU allocation until the first Read request.

### `GET /voices` — Available voices
### `GET /` — Built-in test page

## Troubleshooting

### `Start local service` does not open anything

Run the tray app once or repair the current-user protocol registration:

```powershell
conda run -n kokoro-tts python windows_protocol.py register
```

Chrome may ask whether it can open an external application; allow it only when you intentionally clicked the button. If the project folder moved, register again so the absolute handler paths point at the new location. You can always start manually with `Kokoro TTS.bat`.

### The Project Server row has no models

Select **Project Server** in the Translation panel. If it is disconnected, click **Connect** to open the tray-owned **Remote Service** dialog, configure it there, and connect. Once reachable, the row changes to **Connected** and its generation models appear without another connection step. If it has only embedding/reranking models, the selector remains empty. For Direct API mode, confirm `/api/tags` is reachable directly from this computer without an HTTP proxy.

### A local model does not appear

Select **Local Ollama** in the Translation panel. If it is offline, click **Start**; the tray starts the installed `ollama serve` process and the page waits for discovery. Pull a generation model if the connected row is still empty. The panel never invents defaults or mixes server models into the local selector. Once discovered, use **Advanced → Load & keep** if residency is useful. Kokoro is independent and loads only on the first **Read** request.

## ✅ Tests

```powershell
conda run -n kokoro-tts python -m pytest tests -v
conda run -n kokoro-tts python -m py_compile server.py document_formula.py addon_host.py addin_registration.py audio_encoding.py tray_app.py "Kokoro TTS.pyw" tts_catalog.py windows_protocol.py windows_runtime.py windows_startup.py scripts/sync_catalog.py
node --check tts-userscript.js
node --test tests/office-addins-core.test.cjs tests/userscript-core.test.cjs
conda run -n kokoro-tts python scripts/sync_catalog.py --check
conda run -n kokoro-tts python -c "from audio_encoding import validate_ffmpeg; validate_ffmpeg()"
conda run -n kokoro-tts python -m pip check
git diff --check
```

The default suite uses a fake pipeline and does not load Kokoro or CUDA.
The current document add-in release record is in
[`docs/iteration-9-2026-07-23-wps-pdf-addin.md`](docs/iteration-9-2026-07-23-wps-pdf-addin.md).
Iteration 8 remains the shared document-assistant record, iteration 7 remains
the installable formula-shell record, iteration 6 remains the formula-engine
record, iteration 5 remains the source/model-settings record, and earlier
iterations remain as history.

## License

MIT
