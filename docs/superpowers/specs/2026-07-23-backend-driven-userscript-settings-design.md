# Backend-driven Userscript Settings Design

> **Iteration 11 note:** This source/model contract now also governs the shared
> Word/WPS document task pane, including the non-writing WPS PDF adapter and its
> model-assisted formula-selection-to-LaTeX copy action. Current repository metadata is userscript
> `1.15.5` / FastAPI `1.7.20`; the Windows protocol and isolated launcher are
> recorded in
> [`../../iteration-12-2026-07-26-windows-launch-repair.md`](../../iteration-12-2026-07-26-windows-launch-repair.md); the
> LaTeX/Office/WPS formula core is recorded in iteration 6; the current
> userscript visual boundary is recorded in
> [`../../iteration-11-2026-07-24-userscript-settings-visual-repair.md`](../../iteration-11-2026-07-24-userscript-settings-visual-repair.md), and the installable add-in boundary is recorded in
> [`../../iteration-10-2026-07-24-document-formula-translation-read-parity.md`](../../iteration-10-2026-07-24-document-formula-translation-read-parity.md).

**Status:** Historical release contract for userscript `1.15.2` and FastAPI `1.7.15`. Backend-driven discovery, source-first interaction, and non-blocking health refresh were implemented and verified on 2026-07-23.

## Implementation status

Completed and verified on 2026-07-23:

- Unicode page context can no longer break translation through console encoding;
- a Chinese target that receives an all-non-CJK result gets one strict same-model retry;
- a second non-compliant result is reported as an upstream failure instead of successful English output;
- the translation-path regression set passes, including Unicode page context and strict Chinese-target retry;
- real Chrome selected-text translation produced `流式模式 (WebM/Opus` through `remote:project-server:qwen3:30b`.
- `/translate/health` now reports local and configured remote sources independently;
- model entries carry running, pinned, and translation-eligibility state without exposing connection details;
- `available_model_options` excludes embedding/reranking models, while explicit generation capability takes precedence over name heuristics;
- the source-health regression set passes, including independent local/remote reachability and safe model filtering;
- the userscript no longer has a static or custom model catalog and discovers before either translation entry point;
- model preservation/replacement follows the documented source-aware rules and an empty discovery blocks requests;
- the compact settings panel projects mediator/source state into one status rail, one real model selector, one test action, and collapsed Advanced/Read aloud sections;
- while the mediator is online, Local Ollama and Project Server remain visible as separate choices; only the selected source contributes model options;
- an offline selected local source exposes only **Start**, and a disconnected selected remote source exposes only **Connect**; a connected server never shows a redundant connection action;
- settings version 4 persists the selected source and last valid model per source, while legacy remote model references migrate to their owning source;
- fixed `localreadtranslate://start`, `localreadtranslate://ollama`, and `localreadtranslate://remote` actions route through separate tray single-instance events; extra paths, queries, fragments, and unknown actions are rejected;
- local Ollama startup is idempotent and uses the installed hidden `ollama serve` process only when loopback health is unreachable; the remote action opens the tray-owned dialog without carrying credentials;
- offline, remote-only, connected-without-generation-model, health-unavailable, pinned/stale-pinned, migration, focus, responsive, reduced-motion, and Trusted Types constraints are represented in code and regression tests;
- offline state hides translation output and Read aloud as well as model/Advanced controls; stale startup/error wording no longer refers to removed actions;
- unload preserves an explicit `keep_alive: 0`, removes pin before the request, restores it on failure, and reports `still_running` when post-request source state still contains the model; an already absent model clears only its stale pin without a generation call;
- model-source failures use source-neutral public errors, so a remote failure is not mislabeled as local Ollama;
- translation-test, source/model-switch, and residency-action refreshes preserve the last valid source view while the health request is pending instead of replacing the panel with a checking state;
- request generations prevent an older health or model-lifecycle response from overwriting a newer source/model selection, and changing source, model, or target language clears the stale test result;
- source-action polling waits for each health request before scheduling the next one, so slow checks cannot accumulate overlapping requests;
- the complete backend suite passes **212 tests plus 17 subtests** and the userscript core suite passes **48 tests**;
- syntax, Python compilation, catalog synchronization, dependencies, FFmpeg availability, and diff hygiene checks pass;
- live `1.7.15` health reports local Ollama unreachable, Project Server reachable, five eligible generation models, and no local Ollama listener;
- runtime inspection confirms all three fixed tray events exist, the FastAPI listener is healthy, and the project-server tunnel remains connected without starting local Ollama;
- isolated browser QA verifies local-offline and remote-connected source views, source-filtered server models, and a `390 × 844` layout with no horizontal overflow.

The first compact-panel implementation hid an unreachable source completely. That made a stopped local Ollama disappear whenever the project server was reachable, so the user could neither choose local translation nor start it from the translation panel. That behavior is superseded by the implemented source-first correction below.

## Decision

The local FastAPI mediator is the source of truth for translation-source reachability, eligible models, running state, and pinned state. The userscript renders that state and sends a validated request snapshot. It does not maintain a parallel static model catalog or infer the state of one source from another source's health result.

The tray remains the owner of local Ollama process startup, remote credentials, and remote connection lifecycle. The browser owns only user-facing preferences and fixed user-intent actions: selected source, the last selected eligible model for each source, target language, voice, and speed.

## Invariants

1. A model shown in the normal translation selector was discovered from a currently reachable backend and is eligible for text generation.
2. A plain model reference targets local Ollama; `remote:<source-id>:<model>` targets that explicit configured source.
3. Discovery may choose a valid replacement when a persisted choice disappeared. A translation failure never silently changes source.
4. Test translation and selected-text translation use the same request-builder function and the same validated settings snapshot.
5. The browser never receives SSH passwords, key paths, remote hosts, direct base URLs, or tunnel ports.
6. The local and project-server source rows remain visible while the mediator is online. An unreachable source shows one truthful recovery action but contributes no model options.
7. Backward-compatible health fields remain available until the userscript release has propagated.
8. Fixed protocol actions carry no host, credential, model, path, query string, fragment, or arbitrary command.

## Health response

`GET /translate/health?model=...` keeps the existing selected-model fields and adds a source collection. Each source contains only safe presentation and capability data:

```text
source
  id                    stable source identifier
  name                  user-facing display name
  kind                  local | remote
  configured            whether the mediator knows this source
  reachable             whether native Ollama health was read successfully
  error_code            optional stable non-secret error category
  models[]
    value               source-aware request value
    name                Ollama model name
    running             present in that source's /api/ps response
    pinned              pinned by this mediator
    usable_for_translation
```

`available_model_options` remains as a flattened compatibility view of models where `usable_for_translation` is true. `available_models` remains the local-source compatibility list.

Model eligibility uses backend capability metadata when Ollama exposes it. When capability metadata is missing, obvious embedding and reranking model families are excluded conservatively; an explicit capability result takes precedence over name heuristics.

## Userscript state derivation

The userscript derives one view model from API health and persisted preferences. Source choice happens before model choice:

```text
mediator offline
  -> offline card + Start local service only

mediator online
  -> Local Ollama row + Project Server row

selected Local Ollama unreachable
  -> Local selected + Start local Ollama; no local models

selected Project Server not connected/reachable
  -> Project Server selected + Connect server; no server models

selected source reachable with eligible models
  -> only that source's discovered model selector + Test translation

selected source reachable without an eligible model
  -> connected source + truthful no-generation-model message

selected model running/pinned
  -> one contextual lifecycle action in Advanced
```

There is no separate **Use project server** or **Initialize local model** action. Selecting a source is the routing decision. **Start local Ollama** appears only on an unreachable selected local source. **Connect server** appears only on an unconnected or unreachable selected remote source and opens the tray-owned Remote Service dialog. If the server is already connected, the row says **Connected** and exposes its real models without another connection prompt. The mediator **Start local service** action is absent while the mediator is online.

The settings panel invokes only these exact registered protocol actions:

```text
localreadtranslate://start    start or wake the local mediator
localreadtranslate://ollama   start local Ollama, then keep the mediator running
localreadtranslate://remote   open the tray-owned Remote Service dialog
```

The protocol parser rejects all other actions, extra paths, query strings, and fragments. The tray single-instance handoff maps each action to a separate fixed named event. Starting local Ollama uses the installed `ollama` executable with a hidden `serve` process only after loopback Ollama health is found unreachable. The remote action never transports or displays credentials in the page.

## Settings migration

The next userscript settings version validates persisted values before use:

- preserve voice and speed only if they still exist in the catalog;
- preserve target language only if it is in the supported target list;
- preserve a model only until discovery proves whether it still exists;
- persist `translationSource` independently from the selected model so an offline source can still be chosen;
- remember the last valid discovered model per source, and never copy a local model into a remote source or vice versa;
- migrate an existing `translateModel` to its owning source without changing the user's current route;
- remove the custom-model input from the normal UI;
- choose `Simplified Chinese` when a legacy target is empty or invalid;
- never change an explicit valid target merely because the model/source changed.

The final request is built by a pure helper returning normalized `text`, optional normalized `context`, the selected source-aware `model`, and validated `target_language`. Both translation entry points call this helper immediately before transport.

## UI direction

The component is a compact reading instrument, not an infrastructure dashboard. Its signature element is a two-row translation-path rail. Each row is both a source choice and a truthful status surface; only the active row expands into model selection or its single recovery action.

```text
Translation source
  ● Local Ollama       Start
  ○ Project Server     Connected

Model                  (shown only when active source is reachable)
  [ qwen3:14b                                      ▾ ]
  [ Test translation ]
```

If Project Server is active and connected, only server models are shown. If Local Ollama is active and reachable, only local models are shown. When both are reachable, both rows remain selectable; the interface does not merge their models into one undifferentiated list.

The implementation uses native DOM construction and `textContent` only. It preserves keyboard focus, narrow-screen layout, and reduced-motion behavior, and retains the existing maximum z-index required for page overlays.

## Error language

Errors state the unavailable capability and the next action:

- mediator offline: “Local service is not running.” + **Start local service**;
- selected local source offline: “Local Ollama is not running.” + **Start local Ollama**;
- selected remote source disconnected: “Project Server is not connected.” + **Connect server**;
- selected source connected without a generation model: name that source and ask the user to install a text-generation model there;
- selected model disappeared during a request: refresh discovery and ask the user to select an available model;
- upstream translation failure: keep the current source/model selection and report the failure without fallback.

If at least one remote source is reachable, the UI must not claim that the project server is disconnected merely because local Ollama is offline.

## Verification

Automated verification covers:

- identical request payloads for panel test and webpage translation;
- settings-version migration and validated target language;
- source-by-source health when local is offline and remote is reachable;
- completion-model inclusion and embedding/reranker exclusion;
- backend-only model options with selection preservation/replacement;
- source rows and action visibility for mediator offline, remote-only, local-only, both-source, disconnected, and no-model states;
- filtering the model selector to the explicitly selected source;
- settings migration and per-source last-model preservation;
- exact parsing and single-instance handoff for the fixed `start`, `ollama`, and `remote` protocol actions;
- local Ollama startup idempotence and remote-dialog dispatch without credential exposure;
- actual unload ordering and post-request running-state verification;
- non-blocking background health refresh, stale-response rejection, serialized source polling, and stale translation-test reset;
- Trusted Types sink regression and syntax checks.

The normal compact panel and narrow viewport were exercised with the production userscript in an isolated ordinary-page harness; the source switch showed only server models and the `390 × 844` viewport had no horizontal overflow. A delayed-health harness also verified that source switching, successful test translation, and model switching do not flash the checking state, and that the old test result is cleared after the model changes. Trusted Types sinks, native DOM construction, trust guards, syntax, and request behavior are covered by regression tests. Tampermonkey's protected update page for `1.15.2` still requires the user to click the final confirmation before the installed copy can be rechecked on a strict production page; this browser-owned consent step is not bypassed.

## Rollout

The release updates the backend first while preserving old health fields, then ships userscript `1.15.2`. Repository code and GitHub Raw are updated together; Tampermonkey and Greasy Fork must be confirmed separately because both keep their own installed/published copies.
