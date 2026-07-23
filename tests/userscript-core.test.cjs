const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");


test("userscript core can be imported without browser globals", () => {
  let core;
  assert.doesNotThrow(() => {
    core = require("../tts-userscript.js");
  });
  assert.equal(typeof core.createRequestGate, "function");
  assert.equal(typeof core.releaseAudio, "function");
  assert.equal(typeof core.supportsWebMOpus, "function");
  assert.equal(typeof core.formatPlaybackProgress, "function");
  assert.equal(typeof core.createAppendQueue, "function");
  assert.equal(typeof core.selectBlobAudioFormat, "function");
  assert.equal(typeof core.normalizeAudioBlob, "function");
  assert.equal(typeof core.normalizeAudioBuffer, "function");
  assert.equal(typeof core.normalizeCopyTextWithLatex, "function");
  assert.equal(typeof core.normalizeLlmSourceText, "function");
  assert.equal(typeof core.prepareTextForReadPlan, "function");
  assert.equal(typeof core.applyFormulaVerbalizations, "function");
  assert.equal(typeof core.splitLatexSegments, "function");
});

test("userscript avoids Trusted Types blocked HTML sinks", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "tts-userscript.js"),
    "utf8"
  );

  assert.doesNotMatch(source, /\binnerHTML\b/);
  assert.doesNotMatch(source, /\binsertAdjacentHTML\b/);
  assert.doesNotMatch(source, /\bcreateContextualFragment\b/);
});


test("starting a new request aborts the previous generation", () => {
  const { createRequestGate } = require("../tts-userscript.js");
  const gate = createRequestGate();
  let firstAborts = 0;
  let secondAborts = 0;

  const first = gate.begin();
  gate.attach(first, { abort: () => { firstAborts += 1; } });
  const second = gate.begin();
  gate.attach(second, { abort: () => { secondAborts += 1; } });

  assert.equal(firstAborts, 1);
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);

  gate.finish(first);
  assert.equal(gate.isCurrent(second), true);

  gate.cancel();
  assert.equal(secondAborts, 1);
  assert.equal(gate.isCurrent(second), false);
});


test("request generation is invalidated before synchronous abort callbacks", () => {
  const { createRequestGate } = require("../tts-userscript.js");
  const gate = createRequestGate();
  const first = gate.begin();
  let wasCurrentDuringAbort = null;

  gate.attach(first, {
    abort: () => {
      wasCurrentDuringAbort = gate.isCurrent(first);
    },
  });

  gate.begin();

  assert.equal(wasCurrentDuringAbort, false);
});


test("audio blob URL is revoked at most once", () => {
  const { releaseAudio } = require("../tts-userscript.js");
  const revoked = [];
  const audio = {
    _blobUrl: "blob:test",
    src: "blob:test",
    pauseCalls: 0,
    pause() { this.pauseCalls += 1; },
  };
  const urlApi = { revokeObjectURL: (url) => revoked.push(url) };

  releaseAudio(audio, urlApi);
  releaseAudio(audio, urlApi);

  assert.deepEqual(revoked, ["blob:test"]);
  assert.equal(audio._blobUrl, null);
  assert.equal(audio.src, "");
});


test("audio cleanup hook is called at most once", () => {
  const { releaseAudio } = require("../tts-userscript.js");
  let cleanups = 0;
  const audio = {
    _cleanup: () => { cleanups += 1; },
    _blobUrl: null,
    src: "blob:test",
    pause() {},
  };

  releaseAudio(audio);
  releaseAudio(audio);

  assert.equal(cleanups, 1);
});


test("webm opus support uses MediaSource codec probe", () => {
  const { WEBM_OPUS_MIME, supportsWebMOpus, choosePlaybackMode } = require("../tts-userscript.js");
  const supported = {
    seen: [],
    isTypeSupported(mime) {
      this.seen.push(mime);
      return mime === WEBM_OPUS_MIME;
    },
  };
  const throwing = {
    isTypeSupported() {
      throw new Error("probe failed");
    },
  };

  assert.equal(supportsWebMOpus(supported), true);
  assert.deepEqual(supported.seen, [WEBM_OPUS_MIME]);
  assert.equal(supportsWebMOpus(throwing), false);
  assert.equal(supportsWebMOpus(null), false);
  assert.equal(
    choosePlaybackMode(supported, "http://127.0.0.1:5000", "http://127.0.0.1:5000"),
    "stream"
  );
  assert.equal(
    choosePlaybackMode(supported, "https://example.com", "http://127.0.0.1:5000"),
    "ogg"
  );
  assert.equal(choosePlaybackMode(null, "http://127.0.0.1:5000", "http://127.0.0.1:5000"), "ogg");
});


test("playback progress shows seconds while streaming and percent after duration is known", () => {
  const { formatPlaybackProgress } = require("../tts-userscript.js");

  assert.deepEqual(
    formatPlaybackProgress({ currentTime: 7.42, duration: Number.NaN, streamEnded: false }),
    { determinate: false, label: "7s", percent: 0 }
  );
  assert.deepEqual(
    formatPlaybackProgress({ currentTime: 10, duration: 40, streamEnded: true }),
    { determinate: true, label: "25%", percent: 25 }
  );
  assert.deepEqual(
    formatPlaybackProgress({ currentTime: 50, duration: 40, streamEnded: true }),
    { determinate: true, label: "100%", percent: 100 }
  );
});


test("append queue preserves source buffer order and ends after pending updates", async () => {
  const { createAppendQueue } = require("../tts-userscript.js");
  const listeners = new Map();
  const appended = [];
  const sourceBuffer = {
    updating: false,
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    appendBuffer(data) {
      this.updating = true;
      appended.push(Buffer.from(data).toString("utf8"));
    },
  };
  const mediaSource = {
    readyState: "open",
    endCalls: 0,
    endOfStream() {
      this.endCalls += 1;
    },
  };

  const queue = createAppendQueue(sourceBuffer, mediaSource);
  const first = queue.append(Buffer.from("first"));
  const second = queue.append(Buffer.from("second"));
  assert.deepEqual(appended, ["first"]);

  sourceBuffer.updating = false;
  listeners.get("updateend")();
  await first;
  assert.deepEqual(appended, ["first", "second"]);

  const end = queue.end();
  assert.equal(mediaSource.endCalls, 0);
  sourceBuffer.updating = false;
  listeners.get("updateend")();
  await second;
  await end;

  assert.deepEqual(appended, ["first", "second"]);
  assert.equal(mediaSource.endCalls, 1);
});


test("blob playback prefers ogg only when the browser reports support", () => {
  const { selectBlobAudioFormat } = require("../tts-userscript.js");

  assert.deepEqual(
    selectBlobAudioFormat({ canPlayType: (mime) => mime.includes("opus") ? "probably" : "" }),
    { format: "ogg", accept: "audio/ogg", mime: "audio/ogg" }
  );
  assert.deepEqual(
    selectBlobAudioFormat({ canPlayType: () => "" }),
    { format: "wav", accept: "audio/wav", mime: "audio/wav" }
  );
  assert.deepEqual(
    selectBlobAudioFormat(null),
    { format: "wav", accept: "audio/wav", mime: "audio/wav" }
  );
});


test("audio blob normalization preserves bytes and assigns playable mime type", async () => {
  const { normalizeAudioBlob } = require("../tts-userscript.js");
  const original = new Blob([Buffer.from("OggS")], { type: "" });

  const normalized = normalizeAudioBlob(original, "audio/ogg");

  assert.equal(normalized.type, "audio/ogg");
  assert.equal(Buffer.from(await normalized.arrayBuffer()).toString("utf8"), "OggS");
});


test("audio buffer normalization accepts array buffers, typed arrays, and blobs", async () => {
  const { normalizeAudioBuffer } = require("../tts-userscript.js");
  const direct = new Uint8Array([1, 2, 3]).buffer;
  const typed = new Uint8Array([4, 5, 6]);
  const blob = new Blob([Buffer.from([7, 8, 9])]);

  assert.deepEqual([...new Uint8Array(await normalizeAudioBuffer(direct))], [1, 2, 3]);
  assert.deepEqual([...new Uint8Array(await normalizeAudioBuffer(typed))], [4, 5, 6]);
  assert.deepEqual([...new Uint8Array(await normalizeAudioBuffer(blob))], [7, 8, 9]);
  await assert.rejects(() => normalizeAudioBuffer("bad"), /Unsupported audio response/);
});


test("read preparation removes Chinese, URLs, code blocks, and table fragments", () => {
  const { prepareTextForRead } = require("../tts-userscript.js");
  const prepared = prepareTextForRead(`
中文段落应该被清洗掉。
English text should remain. Visit https://example.com for details [12].
\`\`\`
const noisy = true;
\`\`\`
| a | b |
`);

  assert.equal(prepared.text, "English text should remain. Visit for details.");
  assert.equal(prepared.removedChinese, true);
  assert.equal(prepared.empty, false);
});


test("LLM source normalization collapses formula selection line breaks", () => {
  const { normalizeLlmSourceText } = require("../tts-userscript.js");
  const normalized = normalizeLlmSourceText(`
前两阶段是:

B
0
(x)
->
D
w
=
{(x
i
,
B
0
(x
i
),
w
i
)}
`);

  assert.equal(
    normalized,
    "前两阶段是:\n\nB 0 (x) -> D w = {(x i , B 0 (x i ), w i )}"
  );
});


test("translation display renders LaTeX formulas as readable math", () => {
  const { formulaToReadableHtml, latexToReadableFormula, normalizeDisplayMathWrappers, splitLatexSegments } = require("../tts-userscript.js");
  const segments = splitLatexSegments("使用 $D_w \\to \\hat{B}(x)$，并保持 $$x^2+y^2=z^2$$。");

  assert.deepEqual(
    segments.map((segment) => [segment.type, segment.block]),
    [
      ["text", false],
      ["latex", false],
      ["text", false],
      ["latex", true],
      ["text", false],
    ]
  );
  assert.equal(segments[1].value, "$D_w \\to \\hat{B}(x)$");
  assert.equal(segments[3].value, "$$x^2+y^2=z^2$$");
  assert.equal(latexToReadableFormula("$B_\\theta(x)$"), "B_θ(x)");
  assert.equal(formulaToReadableHtml("$B_\\theta(x)$"), "B<sub>θ</sub>(x)");
  assert.equal(
    formulaToReadableHtml("$D_w \\to \\hat{B}(x)$"),
    "D<sub>w</sub> → B̂(x)"
  );
  assert.equal(
    normalizeDisplayMathWrappers("记为 [[MATH: D_I]] 和 [[MATH: D_U]]。"),
    "记为 $D_I$ 和 $D_U$。"
  );
  assert.equal(
    splitLatexSegments("记为 [[MATH: D_I]]。")[1].value,
    "$D_I$"
  );
});

test("copy text keeps prose and converts math wrappers to LaTeX", () => {
  const { normalizeCopyTextWithLatex } = require("../tts-userscript.js");
  const copied = normalizeCopyTextWithLatex(`
The resulting sampled sets are denoted by [[MATH: D_I]], [[MATH: D_U]], and [[MATH: D_D]], respectively.
其中 [[MATH: D_w \\to \\hat{B}(x)]] 表示数据构造。
`);

  assert.equal(
    copied,
    "The resulting sampled sets are denoted by $D_I$, $D_U$, and $D_D$, respectively. 其中 $D_w \\to \\hat{B}(x)$ 表示数据构造。"
  );
  assert.doesNotMatch(copied, /\[\[MATH:/);
});


test("simple formulas are verbalized by rule before TTS", () => {
  const { prepareTextForRead } = require("../tts-userscript.js");
  const prepared = prepareTextForRead("The loss is $x^2 + y^2 = z^2$.");

  assert.match(prepared.text, /formula: x squared plus y squared equals z squared/i);
});

test("formula read rules use conservative common readings", () => {
  const { verbalizeSimpleFormula } = require("../tts-userscript.js");

  assert.equal(verbalizeSimpleFormula("D_I"), "formula: D sub I");
  assert.equal(verbalizeSimpleFormula("B_\\theta(x)"), "formula: B sub theta of x");
  assert.equal(verbalizeSimpleFormula("\\hat{B}(x)"), "formula: B hat of x");
  assert.equal(
    verbalizeSimpleFormula("D_w \\to \\hat{B}(x)"),
    "formula: D sub w to B hat of x"
  );
});


test("formula replacement preserves surrounding sentence text", () => {
  const { replaceFormulaDelimiters } = require("../tts-userscript.js");
  const formulas = [];
  const prepared = replaceFormulaDelimiters(
    "If fitting loss is used, then $\\hat{B}(x)$ is only a neural approximation.",
    formulas
  );

  assert.match(prepared, /^If fitting loss is used, then /);
  assert.match(prepared, /formula:/);
  assert.match(prepared, / is only a neural approximation\.$/);
  assert.equal(formulas.length, 0);
});

test("math wrappers are split into progressive read formula segments", () => {
  const { prepareProgressiveReadPlan, prepareTextForReadPlan } = require("../tts-userscript.js");
  const source = "The resulting sampled sets are denoted by [[MATH: D_I]], [[MATH: D_U]], and [[MATH: D_D]], respectively.";

  const legacyPlan = prepareTextForReadPlan(source);
  assert.doesNotMatch(legacyPlan.text, /\bMATH\b/);
  assert.doesNotMatch(legacyPlan.text, /\[\[/);

  const plan = prepareProgressiveReadPlan(source);
  assert.equal(plan.formulas.length, 3);
  assert.deepEqual(
    plan.segments.map((segment) => segment.type),
    ["text", "formula", "formula", "text", "formula", "text"]
  );
  assert.equal(plan.formulas[0], "D_I");
  assert.match(plan.segments[0].text, /The resulting sampled sets/);
  assert.equal(plan.segments[3].text, "and");
});


test("complex formulas are collected for LLM verbalization fallback", () => {
  const { applyFormulaVerbalizations, prepareTextForReadPlan } = require("../tts-userscript.js");
  const prepared = prepareTextForReadPlan("Use $$\\begin{matrix} a & b \\\\ c & d \\end{matrix}$$ here.");

  assert.equal(prepared.formulas.length, 1);
  assert.match(prepared.text, /__LOCAL_READ_FORMULA_0__/);
  assert.equal(
    applyFormulaVerbalizations(prepared.text, ["a two by two matrix with entries a, b, c, and d"]),
    "Use a two by two matrix with entries a, b, c, and d here."
  );
});


test("bare LaTeX formulas use rules or LLM fallback", () => {
  const { prepareTextForReadPlan } = require("../tts-userscript.js");
  const simple = prepareTextForReadPlan("\\frac{x}{y}");
  const complex = prepareTextForReadPlan("\\begin{cases} x & x > 0 \\\\ -x & x < 0 \\end{cases}");

  assert.equal(simple.formulas.length, 0);
  assert.match(simple.text, /formula: x over y/i);
  assert.equal(complex.formulas.length, 1);
  assert.match(complex.text, /__LOCAL_READ_FORMULA_0__/);
});

test("translation model options come only from backend discovery", () => {
  const { getTranslationModelOptions } = require("../tts-userscript.js");
  const options = getTranslationModelOptions({
    available_models: ["legacy-local-model:4b"],
    available_model_options: [
      {
        value: "remote:lab-server:qwen3:14b",
        label: "Lab Server / qwen3:14b",
        source: "lab-server",
        source_name: "Lab Server",
        model: "qwen3:14b",
      },
      {
        value: "remote:lab-server:qwen3:14b",
        label: "duplicate",
      },
    ],
  });

  assert.deepEqual(options, [
    {
      value: "remote:lab-server:qwen3:14b",
      label: "Lab Server / qwen3:14b",
      source: "lab-server",
      sourceName: "Lab Server",
      model: "qwen3:14b",
    },
  ]);
});

test("normal translation settings contain no static or custom model catalog", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "tts-userscript.js"),
    "utf8"
  );

  assert.doesNotMatch(source, /const\s+TRANSLATION_MODELS\b/);
  assert.doesNotMatch(source, /tts-translate-model-input/);
  assert.doesNotMatch(source, /appendLabeledControl\([^\n]*"Custom model"/);
});

test("translation model discovery preserves an available remote selection", () => {
  const { chooseTranslationModel } = require("../tts-userscript.js");
  const remoteModel = "remote:project-server:qwen3:14b";

  const selected = chooseTranslationModel(
    {
      available_model_options: [
        { value: remoteModel, label: "Project Server / qwen3:14b" },
      ],
    },
    remoteModel
  );

  assert.equal(selected, remoteModel);
});

test("translation model discovery replaces a missing model from the same source first", () => {
  const { chooseTranslationModel } = require("../tts-userscript.js");

  const selected = chooseTranslationModel(
    {
      available_model_options: [
        {
          value: "qwen3:4b",
          label: "Local Ollama / qwen3:4b",
          source: "local",
        },
        {
          value: "remote:project-server:qwen3:14b",
          label: "Project Server / qwen3:14b",
          source: "project-server",
        },
      ],
    },
    "missing-local-model:4b"
  );

  assert.equal(selected, "qwen3:4b");
});

test("translation model discovery prefers the persisted remote source", () => {
  const { chooseTranslationModel } = require("../tts-userscript.js");
  const selected = chooseTranslationModel(
    {
      available_model_options: [
        { value: "qwen3:4b", label: "Local Ollama / qwen3:4b", source: "local" },
        {
          value: "remote:project-server:qwen3:14b",
          label: "Project Server / qwen3:14b",
          source: "project-server",
        },
      ],
    },
    "remote:project-server:missing:30b"
  );

  assert.equal(selected, "remote:project-server:qwen3:14b");
});

test("translation model discovery uses the first reachable source or stays empty", () => {
  const { chooseTranslationModel } = require("../tts-userscript.js");
  const remoteModel = "remote:project-server:qwen3:14b";

  assert.equal(
    chooseTranslationModel(
      { available_model_options: [{ value: remoteModel, label: "Project Server / qwen3:14b" }] },
      "missing-local-model:4b"
    ),
    remoteModel
  );
  assert.equal(chooseTranslationModel({}, "translategemma:4b"), "");
});

test("translation model discovery stays inside the explicitly selected source", () => {
  const { chooseTranslationModel, getTranslationModelOptions } = require("../tts-userscript.js");
  const payload = {
    available_model_options: [
      { value: "qwen3:4b", label: "Local Ollama / qwen3:4b", source: "local" },
      {
        value: "remote:project-server:qwen3:30b",
        label: "Project Server / qwen3:30b",
        source: "project-server",
      },
    ],
  };

  assert.deepEqual(
    getTranslationModelOptions(payload, "local").map((item) => item.value),
    ["qwen3:4b"]
  );
  assert.equal(
    chooseTranslationModel(payload, "remote:project-server:qwen3:30b", "local"),
    "qwen3:4b"
  );
  assert.equal(
    chooseTranslationModel(payload, "qwen3:4b", "missing-remote"),
    ""
  );
});

test("translation request builder requires a discovered model and normalizes target", () => {
  const { buildTranslationRequest } = require("../tts-userscript.js");

  assert.deepEqual(
    buildTranslationRequest({
      text: "Hello\nworld",
      context: "Context\nline",
      model: " remote:project-server:qwen3:14b ",
      targetLanguage: "",
    }),
    {
      text: "Hello world",
      context: "Context line",
      model: "remote:project-server:qwen3:14b",
      target_language: "Simplified Chinese",
    }
  );
  assert.throws(
    () => buildTranslationRequest({ text: "Hello", model: "" }),
    /No translation model is available/
  );
  assert.throws(
    () => buildTranslationRequest({
      text: "Hello",
      model: "remote:project-server:qwen3:14b",
      source: "local",
    }),
    /does not belong to the selected source/
  );
});

test("translation preferences migrate the legacy model into its owning source", () => {
  const { normalizeTranslationPreferences } = require("../tts-userscript.js");
  const legacyRemote = "remote:project-server:qwen3:30b";

  assert.deepEqual(normalizeTranslationPreferences({ translateModel: legacyRemote }), {
    translationSource: "project-server",
    translationModels: { "project-server": legacyRemote },
    translateModel: legacyRemote,
  });
  assert.deepEqual(normalizeTranslationPreferences({}), {
    translationSource: "local",
    translationModels: {},
    translateModel: "",
  });
  assert.deepEqual(
    normalizeTranslationPreferences({
      translationSource: "local",
      translationModels: {
        local: "qwen3:4b",
        "project-server": legacyRemote,
      },
      translateModel: legacyRemote,
    }),
    {
      translationSource: "local",
      translationModels: {
        local: "qwen3:4b",
        "project-server": legacyRemote,
      },
      translateModel: "qwen3:4b",
    }
  );
});

test("local service control distinguishes offline, starting, and running states", () => {
  const { getLocalServiceControlState } = require("../tts-userscript.js");

  assert.deepEqual(getLocalServiceControlState({ online: false, starting: false }), {
    label: "Start local service",
    icon: "\u25B6",
    disabled: false,
  });
  assert.deepEqual(getLocalServiceControlState({ online: false, starting: true }), {
    label: "Starting local service...",
    icon: "\u23F3",
    disabled: true,
  });
  assert.deepEqual(getLocalServiceControlState({ online: true, starting: true }), {
    label: "Local service running",
    icon: "\u2705",
    disabled: true,
  });
});

test("local service health accepts only the Kokoro API readiness contract", () => {
  const { isKokoroHealthResponse } = require("../tts-userscript.js");

  assert.equal(
    isKokoroHealthResponse(
      200,
      JSON.stringify({ service: "kokoro-tts", ready: true })
    ),
    true
  );
  assert.equal(
    isKokoroHealthResponse(
      200,
      JSON.stringify({ service: "kokoro-tts", api_ready: true })
    ),
    true
  );
  assert.equal(
    isKokoroHealthResponse(
      200,
      JSON.stringify({ service: "another-service", ready: true })
    ),
    false
  );
  assert.equal(isKokoroHealthResponse(200, "not-json"), false);
  assert.equal(
    isKokoroHealthResponse(
      503,
      JSON.stringify({ service: "kokoro-tts", ready: true })
    ),
    false
  );
  assert.equal(
    isKokoroHealthResponse(
      200,
      JSON.stringify({ service: "kokoro-tts", ready: false, api_ready: false })
    ),
    false
  );
});

test("settings view shows only local service launch while mediator is offline", () => {
  const { deriveTranslationSettingsView } = require("../tts-userscript.js");
  const view = deriveTranslationSettingsView({
    mediatorOnline: false,
    starting: false,
    selectedModel: "remote:project-server:qwen3:30b",
  });

  assert.equal(view.mode, "offline");
  assert.equal(view.statusLabel, "Offline");
  assert.equal(view.message, "Local service is not running.");
  assert.equal(view.showStartService, true);
  assert.equal(view.showModelSelect, false);
  assert.equal(view.showTestTranslation, false);
  assert.equal(view.showAdvanced, false);
  assert.equal(view.showTranslationOutput, false);
  assert.equal(view.showReadAloud, false);
});

test("settings view keeps local available as a startable source while remote is connected", () => {
  const { deriveTranslationSettingsView } = require("../tts-userscript.js");
  const model = "remote:project-server:qwen3:30b";
  const view = deriveTranslationSettingsView({
    mediatorOnline: true,
    selectedSource: "local",
    selectedModel: "",
    payload: {
      available_model_options: [
        {
          value: model,
          label: "Project Server / qwen3:30b",
          source: "project-server",
          source_name: "Project Server",
          model: "qwen3:30b",
        },
      ],
      sources: [
        {
          id: "local",
          name: "Local Ollama",
          kind: "local",
          reachable: false,
          models: [],
        },
        {
          id: "project-server",
          name: "Project Server",
          kind: "remote",
          reachable: true,
          models: [
            {
              value: model,
              name: "qwen3:30b",
              running: false,
              pinned: false,
              usable_for_translation: true,
            },
          ],
        },
      ],
    },
  });

  assert.equal(view.mode, "source-offline");
  assert.equal(view.activeSource, "local");
  assert.equal(view.sourceRows.length, 2);
  assert.deepEqual(
    view.sourceRows.map(({ id, selected, reachable, statusLabel, action }) => ({
      id, selected, reachable, statusLabel, action,
    })),
    [
      {
        id: "local",
        selected: true,
        reachable: false,
        statusLabel: "Offline",
        action: { visible: true, type: "start-ollama", label: "Start" },
      },
      {
        id: "project-server",
        selected: false,
        reachable: true,
        statusLabel: "Connected",
        action: { visible: false, type: "connect-server", label: "Connect" },
      },
    ]
  );
  assert.deepEqual(view.modelOptions, []);
  assert.equal(view.selectedModel, "");
  assert.equal(view.showStartOllama, true);
  assert.equal(view.showConnectServer, false);
  assert.equal(view.showStartService, false);
  assert.equal(view.showModelSelect, false);
  assert.equal(view.showTestTranslation, false);
  assert.equal(view.showAdvanced, false);
  assert.equal(view.showTranslationOutput, false);
  assert.equal(view.showReadAloud, true);
  assert.equal(view.showSourceMessage, true);
  assert.deepEqual(view.keepAction, { visible: false, label: "Load & keep" });
  assert.deepEqual(view.unloadAction, { visible: false, label: "Unload" });
});

test("settings view shows only connected server models when server is selected", () => {
  const { deriveTranslationSettingsView } = require("../tts-userscript.js");
  const remoteModel = "remote:project-server:qwen3:30b";
  const view = deriveTranslationSettingsView({
    mediatorOnline: true,
    selectedSource: "project-server",
    selectedModel: remoteModel,
    payload: {
      available_model_options: [
        { value: "qwen3:4b", label: "Local Ollama / qwen3:4b", source: "local" },
        {
          value: remoteModel,
          label: "Project Server / qwen3:30b",
          source: "project-server",
          source_name: "Project Server",
          model: "qwen3:30b",
        },
      ],
      sources: [
        { id: "local", name: "Local Ollama", kind: "local", reachable: true, models: [] },
        {
          id: "project-server",
          name: "Project Server",
          kind: "remote",
          reachable: true,
          models: [{ value: remoteModel, name: "qwen3:30b", running: false, pinned: false }],
        },
      ],
    },
  });

  assert.equal(view.mode, "ready");
  assert.equal(view.activeSource, "project-server");
  assert.deepEqual(view.modelOptions.map((item) => item.value), [remoteModel]);
  assert.equal(view.selectedModel, remoteModel);
  assert.equal(view.showStartOllama, false);
  assert.equal(view.showConnectServer, false);
  assert.equal(view.sourceLabel, "Project Server · connected");
  assert.equal(view.showSourceMessage, false);
});

test("settings view exposes unload but not redundant keep for a pinned model", () => {
  const { deriveTranslationSettingsView } = require("../tts-userscript.js");
  const model = "remote:project-server:qwen3:30b";
  const view = deriveTranslationSettingsView({
    mediatorOnline: true,
    selectedModel: model,
    payload: {
      available_model_options: [{ value: model, label: "Project Server / qwen3:30b" }],
      sources: [{
        id: "project-server",
        name: "Project Server",
        reachable: true,
        models: [{ value: model, name: "qwen3:30b", running: true, pinned: true }],
      }],
    },
  });

  assert.deepEqual(view.keepAction, { visible: false, label: "Kept loaded" });
  assert.deepEqual(view.unloadAction, { visible: true, label: "Unload" });
});

test("settings view can remove a stale pin without claiming the model is loaded", () => {
  const { deriveTranslationSettingsView } = require("../tts-userscript.js");
  const model = "remote:project-server:qwen3:30b";
  const view = deriveTranslationSettingsView({
    mediatorOnline: true,
    selectedModel: model,
    payload: {
      available_model_options: [{ value: model, label: "Project Server / qwen3:30b" }],
      sources: [{
        id: "project-server",
        name: "Project Server",
        reachable: true,
        models: [{ value: model, name: "qwen3:30b", running: false, pinned: true }],
      }],
    },
  });

  assert.deepEqual(view.keepAction, { visible: false, label: "Kept loaded" });
  assert.deepEqual(view.unloadAction, {
    visible: true,
    label: "Remove keep-alive",
  });
  assert.match(view.message, /available/);
  assert.doesNotMatch(view.message, /loaded/);
});

test("settings view reports an online mediator with no fabricated model", () => {
  const { deriveTranslationSettingsView } = require("../tts-userscript.js");
  const view = deriveTranslationSettingsView({
    mediatorOnline: true,
    selectedSource: "local",
    selectedModel: "translategemma:4b",
    payload: {
      available_model_options: [],
      sources: [
        { id: "local", name: "Local Ollama", reachable: false, models: [] },
      ],
    },
  });

  assert.equal(view.mode, "source-offline");
  assert.match(view.message, /Local Ollama is not running/);
  assert.equal(view.showStartOllama, true);
  assert.equal(view.showStartService, false);
  assert.equal(view.showModelSelect, false);
  assert.equal(view.showTestTranslation, false);
  assert.equal(view.selectedModel, "");
  assert.equal(view.showTranslationOutput, false);
  assert.equal(view.showReadAloud, true);
});

test("settings view keeps a reachable source connected when it has no eligible model", () => {
  const { deriveTranslationSettingsView } = require("../tts-userscript.js");
  const view = deriveTranslationSettingsView({
    mediatorOnline: true,
    selectedSource: "project-server",
    selectedModel: "",
    payload: {
      available_model_options: [],
      sources: [
        {
          id: "project-server",
          name: "Project Server",
          kind: "remote",
          reachable: true,
          models: [
            {
              value: "remote:project-server:qwen3-embedding:8b",
              name: "qwen3-embedding:8b",
              usable_for_translation: false,
            },
          ],
        },
      ],
    },
  });

  assert.equal(view.mode, "no-model");
  assert.equal(view.sourceLabel, "Project Server · connected");
  assert.match(view.message, /No eligible text-generation model/);
  assert.doesNotMatch(view.message, /connect Remote Service/i);
});

test("settings view offers tray connection only for a selected disconnected server", () => {
  const { deriveTranslationSettingsView } = require("../tts-userscript.js");
  const view = deriveTranslationSettingsView({
    mediatorOnline: true,
    selectedSource: "project-server",
    payload: {
      available_model_options: [],
      sources: [{ id: "local", name: "Local Ollama", kind: "local", reachable: false, models: [] }],
    },
  });

  assert.equal(view.mode, "source-offline");
  assert.equal(view.activeSource, "project-server");
  assert.equal(view.sourceRows[1].statusLabel, "Not connected");
  assert.equal(view.showStartOllama, false);
  assert.equal(view.showConnectServer, true);
  assert.match(view.message, /Project Server is not connected/);
});

test("settings view reports translation health failure without staying in checking", () => {
  const { deriveTranslationSettingsView } = require("../tts-userscript.js");
  const view = deriveTranslationSettingsView({
    mediatorOnline: true,
    healthError: "Translation status unavailable.",
  });

  assert.equal(view.mode, "unavailable");
  assert.equal(view.statusLabel, "Unavailable");
  assert.equal(view.message, "Translation status unavailable.");
  assert.equal(view.showStartService, false);
  assert.equal(view.showModelSelect, false);
  assert.equal(view.showTestTranslation, false);
  assert.equal(view.showReadAloud, true);
});

test("target language normalization migrates invalid legacy values", () => {
  const { normalizeTargetLanguage, SUPPORTED_TARGET_LANGUAGES } = require("../tts-userscript.js");

  assert.equal(normalizeTargetLanguage("Traditional Chinese"), "Traditional Chinese");
  assert.equal(normalizeTargetLanguage(""), "Simplified Chinese");
  assert.equal(normalizeTargetLanguage("made-up target"), "Simplified Chinese");
  assert.deepEqual(SUPPORTED_TARGET_LANGUAGES, [
    "Simplified Chinese",
    "Traditional Chinese",
    "English",
    "Japanese",
    "Korean",
  ]);
});

test("settings expose fixed source actions without exposing connection details", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "tts-userscript.js"),
    "utf8"
  );

  assert.doesNotMatch(source, /"tts-init-local-model-btn"/);
  assert.match(source, /"tts-start-local-service-btn"/);
  assert.match(source, /"tts-source-local"/);
  assert.match(source, /"tts-source-project-server"/);
  assert.match(source, /"tts-start-local-ollama-btn"/);
  assert.match(source, /"tts-connect-server-btn"/);
  assert.match(source, /const LOCAL_SERVICE_START_URL = "localreadtranslate:\/\/start"/);
  assert.match(source, /const LOCAL_OLLAMA_START_URL = "localreadtranslate:\/\/ollama"/);
  assert.match(source, /const REMOTE_SERVICE_OPEN_URL = "localreadtranslate:\/\/remote"/);
  assert.match(source, /window\.location\.assign\(LOCAL_SERVICE_START_URL\)/);
  assert.match(source, /function pollLocalServiceStatus\(/);
  assert.match(source, /if \(!e\.isTrusted\) return;/);
  assert.match(source, /<details>|document\.createElement\("details"\)/);
  assert.equal(
    (source.match(/KokoroTTSCore\.isKokoroHealthResponse/g) || []).length,
    2
  );
  assert.doesNotMatch(source, /ssh_password|private_key|identity_file|auth_password/i);
});

test("settings messages do not reference removed local-model actions", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "..", "tts-userscript.js"),
    "utf8"
  );

  assert.doesNotMatch(source, /initialize a local model/i);
  assert.doesNotMatch(source, /run start\.bat/i);
  assert.match(source, /Local service is running\. Translation sources are being refreshed\./);
  assert.match(source, /Local service is offline\. Start it from this panel or the tray app\./);
});
