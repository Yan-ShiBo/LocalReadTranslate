# Remote Ollama Service Design

**Status:** Historical `1.13.0` release contract, implemented and verified on 2026-07-18. Tray, credential, tunnel and routing boundaries remain current; the userscript workflow in this file is archived.

> **Iteration 5 supersession:** The three-action userscript flow and flattened health interpretation below describe released version `1.13.0` only. They were superseded on 2026-07-23 by the source-first contract recorded for userscript `1.15.2` / server `1.7.15` in [`2026-07-23-backend-driven-userscript-settings-design.md`](2026-07-23-backend-driven-userscript-settings-design.md). Current repository metadata is userscript `1.15.4` / server `1.7.19`; iterations 6–7 add the formula interchange layer and installable Word/WPS shells, iteration 8 reuses the same source-first contract for Word/WPS translation and read-aloud, iteration 9 adds the non-writing WPS PDF adapter plus model-assisted PDF-selection-to-LaTeX copy, and iteration 10 aligns document formula translation/read behavior with the userscript. Historical sections are retained to explain the old release, not as current usage instructions.

## Goal

Keep local Ollama as the default translation source while allowing the user to opt into a project-server Ollama source configured by the Windows tray app. The browser must continue to use only the loopback FastAPI service and must never receive remote credentials.

## User Flow

1. Launch the Kokoro TTS tray app. It creates or repairs the current-user `localreadtranslate://start` protocol registration and starts the local FastAPI service.
2. To use a remote source, open the tray menu's `Remote Service` dialog, choose `ssh` or `api`, enter the connection details, and click connect.
3. The tray app validates the remote native Ollama `/api/tags` endpoint. SSH mode creates a loopback tunnel; Direct API mode validates the configured base URL directly.
4. The tray restarts its owned FastAPI process with a credential-free `KOKORO_OLLAMA_SOURCES` payload.
5. The browser health response exposes grouped local and remote model choices.
6. The userscript settings panel offers three explicit actions:
   - **Use project server** selects an already available remote choice, or the first available remote choice, persists it, and checks health. If none exists, the user is directed back to the tray dialog.
   - **Initialize local model** rejects `remote:` references and sends a local keepalive request for the selected local model.
   - **Start local service** opens the fixed `localreadtranslate://start` action and polls loopback health for about 20 seconds.
7. Translation, read preparation, formula verbalization, keepalive, unload, and translation health resolve the selected model's source before making an Ollama request.

## Trust and Process Boundaries

```text
Web page + userscript
        |
        | HTTP only to 127.0.0.1:5000
        v
Local FastAPI mediator
        |-- local model reference ------> local Ollama
        `-- remote:<source>:<model> ----> tray-provided tunnel or Direct API

localreadtranslate://start | ollama | remote
        `-------------------------------> Windows tray app fixed actions
```

The userscript never sees an SSH password, key path, remote host, or remote Ollama base URL. Local mode keeps selected text and permitted context on the machine. When a remote model is selected, the local mediator sends the selected text and permitted context to that configured project server.

The tray owns the remote connection and process lifecycle because it already owns hidden FastAPI startup, login auto-start, settings persistence, and the system-tray UI. A bare `start.bat` launch does not establish an SSH tunnel and cannot provide a tray-managed remote source.

Kokoro is lazy-loaded on the first TTS request. Starting the API or translating through a remote model does not initialize Torch/Kokoro or allocate local TTS GPU memory. `/health` reports API readiness separately from `tts_model_loaded`.

## Windows Fixed-action Protocol

The current handler accepts exactly three URLs:

```text
localreadtranslate://start
localreadtranslate://ollama
localreadtranslate://remote
```

`windows_protocol.py` registers the handler under `HKCU\Software\Classes\localreadtranslate`, so registration is per-user and does not require administrator privileges. The command stores quoted absolute paths to the environment's `pythonw.exe` and this checkout's `tray_app.py`; moving the environment or project requires re-registration:

```powershell
conda run -n kokoro-tts python windows_protocol.py register
```

The matching `windows_protocol.py unregister` command removes only this exact current-user protocol tree.

The protocol parser rejects query strings, fragments, extra paths, and any action other than `start`, `ollama`, or `remote`. A web page can still prompt the browser to open a registered external application, so the browser's confirmation dialog remains an important user-consent boundary.

The tray enforces a single instance with a Windows named mutex. A first protocol launch starts the tray and dispatches the requested fixed action. If the tray is already running, the second invocation signals the corresponding named auto-reset event without creating another tray process: start/wake the mediator, start local Ollama if loopback health is down, or open the tray-owned Remote Service dialog.

The protocol carries no host, credentials, model name, shell fragment, or arbitrary command.

## Tray Configuration

The `remote_ollama` object in the Git-ignored `tray_settings.json` has this shape:

```json
{
  "enabled": false,
  "name": "10.12.96.203",
  "connection_mode": "ssh",
  "host": "10.12.96.203",
  "ssh_port": 22,
  "username": "test",
  "password": "",
  "key_file": "",
  "ollama_host": "127.0.0.1",
  "ollama_port": 11434,
  "local_port": 0,
  "base_url": "http://10.12.96.203:11434"
}
```

`local_port: 0` requests an ephemeral loopback port. After an SSH connection succeeds, the selected port may be persisted as the preferred bind for the next connection, but FastAPI receives it only while the current tray process has a live tunnel on that runtime port. A failed reconnect never publishes a stale persisted port. The environment passed to FastAPI contains only a source id, display name, and effective base URL; it omits the SSH host, username, password, and key path.

The optional SSH password is stored as plaintext in `tray_settings.json`. Git ignores this file, but that is not encryption. Users should protect the Windows account and project directory, prefer an agent or key file, and never sync, commit, or share the settings file.

## SSH Mode

Authentication follows Paramiko's key-first behavior: an explicit key or matching OpenSSH configuration, then SSH agent/default keys, with the configured password available only as a fallback in the same connection attempt.

Host identity is fail-closed. The client calls `load_system_host_keys()` and uses `RejectPolicy`, so a host absent from the user's known-hosts database is rejected rather than silently trusted. The deployed `10.12.96.203` host is present in this machine's `known_hosts`, and a real reconnection succeeded with this policy.

The tunnel binds only to local loopback and forwards to the configured remote Ollama host/port, normally `127.0.0.1:11434` on the server. The tray keeps the tunnel alive for the lifetime of the app and stops it on disconnect or exit.

## Direct API Mode

Direct API mode accepts a native Ollama base URL and validates `/api/tags`. It does not add API-key or other authentication headers. An ordinary `http://` URL is unencrypted, so this mode is intended only for a trusted LAN or VPN and must not be used to expose an unauthenticated Ollama port to the public internet.

Both tray validation and server Ollama requests use proxy-free openers. This prevents loopback or trusted-LAN requests, including selected page text, from being redirected through ambient HTTP proxy settings.

## Server Routing

The FastAPI service always defines the local source:

```text
local -> http://127.0.0.1:11434
```

The tray may add remote sources through `KOKORO_OLLAMA_SOURCES`, for example:

```json
[
  {
    "id": "project-server",
    "name": "Project Server",
    "base_url": "http://127.0.0.1:49152"
  }
]
```

Plain model names remain local and backward-compatible. A remote choice uses an internal reference:

```text
remote:<source-id>:<model-name>
```

For example, `remote:project-server:qwen3:30b` resolves to model `qwen3:30b` at the project-server source. The source-aware helpers route `/api/generate`, `/api/tags`, `/api/ps`, keepalive, and unload consistently. Pinned models are keyed by the full reference, so local and remote models with the same Ollama name do not collide.

`GET /translate/health?model=...` remains backward-compatible and adds source metadata plus `available_model_options`. `available_models` remains a list of local-compatible model strings for older userscripts. Health and API errors do not expose passwords or detailed connection strings.

If a selected local model is unavailable, the browser keeps that explicit local selection and reports the problem; it never crosses the local/remote boundary automatically. The user must click **Use project server** or manually choose a `remote:` entry before selected text can be routed to a project server.

## Error Handling

- A failed tray connection leaves the previous working settings and tunnel intact and shows a concise dialog error.
- An unknown SSH host key fails closed; the user must add the verified host key to the system/OpenSSH known-hosts database before reconnecting.
- If FastAPI starts without a working remote source, local Ollama remains usable.
- Remote health failures return `ollama_reachable: false` without leaking credentials.
- Translation endpoints continue to use generic upstream failure responses; logs may contain source display names but never passwords.
- Protocol registration failure is non-fatal to ordinary tray startup. The CLI registration command provides an explicit repair path.

## Verification Contract

The release is covered by server, tray, protocol, Windows-runtime, and userscript tests for:

- local/remote model parsing, discovery, source routing, keepalive, unload, and pinned identity;
- remote settings persistence and credential-free environment construction;
- rejection of stale persisted SSH forwarding ports when no live tunnel exists;
- SSH agent/key/password behavior, strict known-host rejection, Direct API validation, and proxy bypass;
- exact protocol parsing, HKCU registration/repair, quoted commands, single-instance signaling, and existing-tray wakeup;
- remote option merging, selection persistence, and the three settings-panel actions.
- strict userscript `/health` identity/readiness validation before the local service is marked online.

The 2026-07-18 release verification completed **Python 196 passed + 15 subtests** and **Node 33/33 passed**. Real-machine checks covered first protocol launch, existing-tray event wakeup, `/health` with `tts_model_loaded=false`, a strict-host-key SSH reconnect, and remote `qwen3:30b` health availability.

## Non-Goals

- Installing or configuring Ollama on the project server.
- Public Ollama exposure or Direct API authentication.
- Passing remote credentials or arbitrary commands through the browser or URL protocol.
- Loading Kokoro during API startup or translation-only use.
