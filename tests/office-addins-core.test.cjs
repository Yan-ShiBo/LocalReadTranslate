const assert = require("node:assert/strict");
const test = require("node:test");

const {
  LocalReadTranslateServiceError,
  createClient,
} = require("../addons/shared/localreadtranslate-client.js");
const {
  convertSelectedLatex,
  copySelectionAsLatex,
} = require("../addons/shared/formula-controller.js");
const {
  createOfficeWordAdapter,
} = require("../addons/office-word/office-adapter.js");
const {
  createWpsWriterAdapter,
} = require("../addons/wps-word/wps-adapter.js");
const {
  createClipboardWriter,
  createTaskPaneApp,
  detectHostHint,
  deriveAssistantSourceView,
  needsReadPreparation,
  normalizeAssistantPreferences,
  summarizeLatexSelection,
} = require("../addons/taskpane/taskpane.js");
const {
  BUTTON_ID,
  TASKPANE_URL,
  toggleFormulaTaskPane,
} = require("../addons/wps-word/js/ribbon.js");


test("shared client calls native formula endpoints without inventing formats", async () => {
  const requests = [];
  const client = createClient({
    baseUrl: "https://localhost:3210/api",
    fetch: async (url, init = {}) => {
      requests.push({ url, init });
      return {
        ok: true,
        status: 200,
        async json() {
          return url.endsWith("latex-fragment")
            ? { docx_base64: "ZG9jeA==", local_path: "C:\\Temp\\formula.docx" }
            : { latex: "$x^2$" };
        },
      };
    },
  });

  await client.createLatexFragment("正文 $x^2$");
  await client.nativeToLatex({
    source_format: "flat-opc",
    content: "<pkg:package/>",
  });

  assert.equal(
    requests[0].url,
    "https://localhost:3210/api/document/latex-fragment"
  );
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    text: "正文 $x^2$",
  });
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    source_format: "flat-opc",
    content: "<pkg:package/>",
  });
});

test("shared client returns source-neutral connection errors", async () => {
  const client = createClient({
    fetch: async () => {
      throw new Error("private network details");
    },
  });

  await assert.rejects(
    client.getLatexHealth(),
    (error) =>
      error instanceof LocalReadTranslateServiceError &&
      error.message === "Cannot connect to the local translation service"
  );
});

test("shared client exposes translation, read preparation, voices, and speech audio", async () => {
  const requests = [];
  const audioBlob = new Blob(["RIFF-test-audio"], { type: "audio/wav" });
  const client = createClient({
    baseUrl: "http://localhost:5443/api",
    fetch: async (url, init = {}) => {
      requests.push({ url, init });
      const path = new URL(url).pathname;
      const payloads = {
        "/api/translate/health": {
          sources: [],
          available_model_options: [],
        },
        "/api/voices": {
          default_voice: "af_bella",
          default_speed: 0.8,
          speeds: [0.8, 1],
          groups: [],
        },
        "/api/translate": {
          translated_text: "你好",
          model: "qwen3:8b",
        },
        "/api/read/prepare": {
          prepared_text: "Readable English.",
          model: "qwen3:8b",
        },
        "/api/translate/model/keepalive": {
          model: "qwen3:8b",
          model_running: true,
          model_pinned: true,
        },
        "/api/translate/model/unload": {
          model: "qwen3:8b",
          model_running: false,
          model_pinned: false,
        },
      };
      return {
        ok: true,
        status: 200,
        async json() {
          return payloads[path] || null;
        },
        async blob() {
          return audioBlob;
        },
      };
    },
  });

  await client.getTranslateHealth();
  await client.getVoices();
  const translated = await client.translate({
    text: "Hello",
    model: "qwen3:8b",
    target_language: "Simplified Chinese",
  });
  const prepared = await client.prepareRead({
    text: "论文 $x^2$",
    model: "qwen3:8b",
  });
  const speech = await client.synthesizeSpeech({
    text: "Readable English.",
    voice: "af_bella",
    speed: 0.8,
  });
  await client.keepModelLoaded("qwen3:8b");
  await client.unloadModel("qwen3:8b");

  assert.equal(translated.translated_text, "你好");
  assert.equal(prepared.prepared_text, "Readable English.");
  assert.equal(speech, audioBlob);
  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    [
      "/api/translate/health",
      "/api/voices",
      "/api/translate",
      "/api/read/prepare",
      "/api/tts",
      "/api/translate/model/keepalive",
      "/api/translate/model/unload",
    ]
  );
  assert.deepEqual(JSON.parse(requests[2].init.body), {
    text: "Hello",
    model: "qwen3:8b",
    target_language: "Simplified Chinese",
  });
  assert.equal(requests[4].init.headers.Accept, "audio/wav");
  assert.deepEqual(JSON.parse(requests[5].init.body), {
    model: "qwen3:8b",
    keep_alive: -1,
  });
  assert.deepEqual(JSON.parse(requests[6].init.body), {
    model: "qwen3:8b",
  });
});

test("formula controller converts selected LaTeX through the host adapter", async () => {
  const calls = [];
  const adapter = {
    async readSelectionText() {
      return "设 $x^2$。";
    },
    async replaceSelectionWithFragment(fragment) {
      calls.push(fragment);
    },
  };
  const client = {
    async createLatexFragment(text) {
      assert.equal(text, "设 $x^2$。");
      return {
        docx_base64: "ZG9jeA==",
        local_path: "C:\\Temp\\formula.docx",
      };
    },
  };

  await convertSelectedLatex({ adapter, client });
  assert.equal(calls.length, 1);
});

test("formula controller copies only canonical LaTeX", async () => {
  const clipboard = [];
  let cleanupCalls = 0;
  const adapter = {
    async exportSelectionForLatex() {
      return {
        source_format: "flat-opc",
        content: "<pkg:package/>",
        cleanup() {
          cleanupCalls += 1;
        },
      };
    },
  };
  const client = {
    async nativeToLatex(source) {
      assert.equal(source.source_format, "flat-opc");
      return { latex: "正文 $\\frac{a}{b}$。" };
    },
  };

  const result = await copySelectionAsLatex({
    adapter,
    client,
    async writeClipboard(value) {
      clipboard.push(value);
    },
  });

  assert.equal(result.latex, "正文 $\\frac{a}{b}$。");
  assert.deepEqual(clipboard, ["正文 $\\frac{a}{b}$。"]);
  assert.equal(cleanupCalls, 1);
});

test("formula controller cleans up a WPS spool when conversion fails", async () => {
  let cleanupCalls = 0;
  const adapter = {
    async exportSelectionForLatex() {
      return {
        source_format: "docx-local-path",
        content: "C:\\Temp\\localreadtranslate-selection-1-a.docx",
        cleanup() {
          cleanupCalls += 1;
        },
      };
    },
  };
  const client = {
    async nativeToLatex() {
      throw new Error("DOCX payload is not a valid package");
    },
  };

  await assert.rejects(
    copySelectionAsLatex({ adapter, client }),
    /DOCX payload is not a valid package/
  );
  assert.equal(cleanupCalls, 1);
});

test("Office adapter reads OOXML and inserts generated DOCX at the selection", async () => {
  const calls = [];
  const range = {
    text: "设 $x^2$。",
    load(property) {
      calls.push(["load", property]);
    },
    getOoxml() {
      return { value: "<pkg:package/>" };
    },
    insertFileFromBase64(content, location) {
      calls.push(["insert", content, location]);
    },
    insertText(content, location) {
      calls.push(["insert-text", content, location]);
    },
  };
  const Word = {
    async run(callback) {
      await callback({
        document: { getSelection: () => range },
        async sync() {
          calls.push(["sync"]);
        },
      });
    },
  };
  const adapter = createOfficeWordAdapter(Word);

  assert.equal(await adapter.readSelectionText(), "设 $x^2$。");
  assert.deepEqual(await adapter.exportSelectionForLatex(), {
    source_format: "flat-opc",
    content: "<pkg:package/>",
  });
  await adapter.replaceSelectionWithFragment({ docx_base64: "ZG9jeA==" });

  assert.deepEqual(calls.at(-2), ["insert", "ZG9jeA==", "Replace"]);
  assert.deepEqual(calls.at(-1), ["sync"]);
  await adapter.replaceSelectionWithText("翻译结果");
  assert.deepEqual(calls.at(-2), ["insert-text", "翻译结果", "Replace"]);
  assert.deepEqual(calls.at(-1), ["sync"]);
});

test("WPS adapter exports selection as DOCX and inserts a generated fragment", async () => {
  const calls = [];
  const selectionRange = {
    get FormattedText() {
      throw new Error("WPS export must not assign FormattedText");
    },
    Text: "selected",
    Copy() {
      calls.push(["copy-selection"]);
    },
    Collapse(value) {
      calls.push(["collapse", value]);
    },
    InsertFile(path) {
      calls.push(["insert", path]);
    },
  };
  const originalDocument = {
    Activate() {
      calls.push(["activate-original"]);
    },
  };
  const temporaryDocument = {
    Content: { FormattedText: null },
    Range(start, end) {
      calls.push(["range", start, end]);
      return {
        Paste() {
          calls.push(["paste"]);
        },
      };
    },
    SaveAs2(path, format, _a, _b, addToRecent) {
      calls.push(["save", path, format, addToRecent]);
    },
    Close(mode) {
      calls.push(["close", mode]);
    },
  };
  const app = {
    Selection: { Text: "selected", Range: selectionRange },
    ActiveDocument: originalDocument,
    Documents: {
      Add() {
        calls.push(["add"]);
        return temporaryDocument;
      },
    },
    Env: {
      GetTempPath() {
        return "C:\\Temp\\";
      },
    },
    FileSystem: {
      unlinkSync(path) {
        calls.push(["unlink", path]);
      },
    },
  };
  const adapter = createWpsWriterAdapter(app);

  assert.equal(await adapter.readSelectionText(), "selected");
  const exported = await adapter.exportSelectionForLatex();
  assert.equal(exported.source_format, "docx-local-path");
  assert.match(
    exported.content,
    /^C:\\Temp\\localreadtranslate-selection-\d+-[0-9a-f]+\.docx$/
  );
  assert.equal(typeof exported.cleanup, "function");
  assert.equal(temporaryDocument.Content.FormattedText, null);
  assert.equal(
    calls.filter((call) => call[0] === "copy-selection").length,
    1
  );
  assert.deepEqual(
    calls.filter((call) => ["copy-selection", "add", "range", "paste"].includes(call[0])),
    [["copy-selection"], ["add"], ["range", 0, 0], ["paste"]]
  );
  assert.equal(calls.find((call) => call[0] === "save")[2], 12);
  assert.equal(calls.some((call) => call[0] === "read"), false);
  assert.equal(calls.some((call) => call[0] === "unlink"), false);

  await exported.cleanup();
  await exported.cleanup();
  assert.equal(
    calls.filter((call) => call[0] === "unlink").length,
    1
  );
  assert.deepEqual(calls.at(-1), ["unlink", exported.content]);

  await adapter.replaceSelectionWithFragment({
    local_path: "C:\\Temp\\formula.docx",
  });
  assert.equal(selectionRange.Text, "");
  assert.deepEqual(calls.at(-2), ["collapse", 1]);
  assert.deepEqual(calls.at(-1), ["insert", "C:\\Temp\\formula.docx"]);
  await adapter.replaceSelectionWithText("翻译结果");
  assert.equal(selectionRange.Text, "翻译结果");
});

test("task pane host hint and formula strip summary stay deterministic", () => {
  assert.equal(detectHostHint("?host=office"), "office");
  assert.equal(detectHostHint("?host=wps"), "wps");
  assert.equal(detectHostHint("?host=unknown"), "");
  assert.deepEqual(
    summarizeLatexSelection("正文 $x$，然后 $$y^2$$ 与 \\(z\\)。"),
    { inline: 2, display: 1, total: 3, hasText: true }
  );
  assert.deepEqual(
    summarizeLatexSelection("plain text"),
    { inline: 0, display: 0, total: 0, hasText: true }
  );
});

test("assistant source view exposes only models discovered on the selected reachable source", () => {
  const payload = {
    sources: [
      {
        id: "local",
        name: "Local Ollama",
        kind: "local",
        configured: true,
        reachable: false,
        models: [],
      },
      {
        id: "project-server",
        name: "Project Server",
        kind: "remote",
        configured: true,
        reachable: true,
        models: [
          {
            value: "remote:project-server:qwen3:8b",
            running: true,
            usable_for_translation: true,
          },
        ],
      },
    ],
    available_model_options: [
      {
        value: "remote:project-server:qwen3:8b",
        label: "qwen3:8b",
        source: "project-server",
        source_name: "Project Server",
        model: "qwen3:8b",
      },
      {
        value: "stale-local:latest",
        label: "stale-local:latest",
        source: "local",
        source_name: "Local Ollama",
        model: "stale-local:latest",
      },
    ],
  };

  const remote = deriveAssistantSourceView(
    payload,
    "project-server",
    "remote:project-server:qwen3:8b"
  );
  assert.equal(remote.mode, "ready");
  assert.equal(remote.activeSource, "project-server");
  assert.deepEqual(
    remote.modelOptions.map((option) => option.value),
    ["remote:project-server:qwen3:8b"]
  );
  assert.equal(remote.selectedModel, "remote:project-server:qwen3:8b");
  assert.equal(remote.action, null);
  assert.deepEqual(remote.keepAction, {
    visible: true,
    label: "保持加载",
  });
  assert.deepEqual(remote.unloadAction, {
    visible: true,
    label: "卸载",
  });
  assert.equal(
    remote.sourceRows.find((source) => source.id === "project-server").statusLabel,
    "已连接"
  );

  const local = deriveAssistantSourceView(payload, "local", "");
  assert.equal(local.mode, "source-offline");
  assert.deepEqual(local.modelOptions, []);
  assert.equal(local.selectedModel, "");
  assert.deepEqual(local.action, {
    label: "启动本地 Ollama",
    protocolUrl: "localreadtranslate://ollama",
  });
  assert.equal(
    local.sourceRows.find((source) => source.id === "local").statusLabel,
    "未启动"
  );
});

test("assistant read preparation is required only for CJK or formula-bearing text", () => {
  assert.equal(needsReadPreparation("A plain English paragraph."), false);
  assert.equal(needsReadPreparation("需要朗读的中文"), true);
  assert.equal(needsReadPreparation("The result is $x^2$."), true);
  assert.equal(needsReadPreparation("Display: \\[x+y\\]."), true);
});

test("assistant preferences preserve one discovered-model choice per source", () => {
  assert.deepEqual(
    normalizeAssistantPreferences({
      translationSource: "project-server",
      translationModels: {
        local: "qwen3:8b",
        "project-server": "remote:project-server:qwen3:30b",
        invalid: "remote:other:qwen3:122b",
      },
      targetLanguage: "English",
      voice: "bf_emma",
      speed: 1,
    }),
    {
      translationSource: "project-server",
      translationModels: {
        local: "qwen3:8b",
        "project-server": "remote:project-server:qwen3:30b",
      },
      targetLanguage: "English",
      voice: "bf_emma",
      speed: 1,
    }
  );
  assert.deepEqual(normalizeAssistantPreferences(null), {
    translationSource: "local",
    translationModels: {},
    targetLanguage: "Simplified Chinese",
    voice: "",
    speed: 0.8,
  });
});

function fakeTaskPaneDocument() {
  const listeners = new Map();
  class Element {
    constructor(id = "") {
      this.id = id;
      this.textContent = "";
      this.value = "";
      this.hidden = false;
      this.disabled = false;
      this.className = "";
      this.children = [];
      this.dataset = {};
      this.style = {};
      this.src = "";
      this.currentTime = 0;
      this.paused = true;
    }
    addEventListener(name, callback) {
      listeners.set(`${this.id}:${name}`, callback);
    }
    appendChild(child) {
      this.children.push(child);
      return child;
    }
    removeChild(child) {
      this.children = this.children.filter((value) => value !== child);
    }
    setAttribute() {}
    select() {}
    async play() {
      this.paused = false;
    }
    pause() {
      this.paused = true;
    }
  }
  const ids = [
    "host-name",
    "service-pill",
    "service-detail",
    "retry-button",
    "selection-preview",
    "formula-count",
    "inline-count",
    "display-count",
    "selection-note",
    "convert-button",
    "copy-button",
    "assistant-source-list",
    "assistant-state",
    "source-rail",
    "assistant-source-message",
    "source-action-slot",
    "source-action-button",
    "model-field",
    "model-select",
    "target-language",
    "voice-select",
    "speed-select",
    "read-button",
    "read-button-label",
    "translate-button",
    "speech-audio",
    "translation-result",
    "translation-text",
    "translation-meta",
    "copy-translation-button",
    "replace-translation-button",
    "keep-model-button",
    "unload-model-button",
    "advanced-settings",
    "read-settings",
    "operation-status",
    "operation-mark",
    "operation-title",
    "operation-detail",
  ];
  const elements = Object.fromEntries(ids.map((id) => [id, new Element(id)]));
  const document = {
    body: new Element("body"),
    createElement() {
      return new Element();
    },
    execCommand() {
      return true;
    },
    getElementById(id) {
      return elements[id] || null;
    },
  };
  return { document, elements, listeners };
}

test("task pane checks formula health once, then actions reuse that state", async () => {
  const { document, elements } = fakeTaskPaneDocument();
  let healthChecks = 0;
  let converted = 0;
  let copied = 0;
  let disconnectOnCopy = false;
  const adapter = {
    async readSelectionText() {
      return "正文 $x^2$";
    },
  };
  const client = {
    async getLatexHealth() {
      healthChecks += 1;
      return { available: true, version: "3.8" };
    },
    async getTranslateHealth() {
      return {
        sources: [],
        available_model_options: [],
      };
    },
    async getVoices() {
      return {
        default_voice: "af_bella",
        default_speed: 0.8,
        speeds: [0.8],
        groups: [],
      };
    },
  };
  const app = createTaskPaneApp({
    document,
    hostHint: "wps",
    wpsApplication: {},
    wpsAdapterFactory() {
      return adapter;
    },
    officeAdapterFactory() {
      throw new Error("Office should not be selected");
    },
    clientFactory(options) {
      assert.equal(options.baseUrl, "/api");
      return client;
    },
    controller: {
      async convertSelectedLatex(options) {
        assert.equal(options.client, client);
        converted += 1;
        return { formula_count: 1, warnings: [] };
      },
      async copySelectionAsLatex(options) {
        assert.equal(options.client, client);
        if (disconnectOnCopy) {
          const error = new Error("proxy unavailable");
          error.status = 502;
          throw error;
        }
        copied += 1;
        return { formula_count: 1, latex: "$x^2$" };
      },
    },
    async writeClipboard() {},
  });

  await app.initialize();
  assert.equal(healthChecks, 1);
  assert.equal(elements["host-name"].textContent, "WPS Writer");
  assert.equal(elements["formula-count"].textContent, "1");
  assert.equal(elements["convert-button"].disabled, false);

  await app.runAction("convert");
  await app.runAction("copy");
  assert.equal(converted, 1);
  assert.equal(copied, 1);
  assert.equal(healthChecks, 1);

  disconnectOnCopy = true;
  await assert.rejects(app.runAction("copy"), /proxy unavailable/);
  assert.equal(healthChecks, 1);
  assert.equal(elements["service-detail"].textContent, "本地翻译服务已断开");
  assert.equal(elements["retry-button"].hidden, false);
  assert.equal(elements["copy-button"].disabled, true);
});

test("task pane translates and reads with cached backend discovery", async () => {
  const { document, elements, listeners } = fakeTaskPaneDocument();
  let latexChecks = 0;
  let translationChecks = 0;
  let voiceChecks = 0;
  let translations = 0;
  let preparations = 0;
  let speechRequests = 0;
  const clipboard = [];
  const replacements = [];
  const adapter = {
    async readSelectionText() {
      return "论文结论是 $x^2$。";
    },
    async replaceSelectionWithText(text) {
      replacements.push(text);
    },
  };
  const client = {
    async getLatexHealth() {
      latexChecks += 1;
      return { available: true, version: "3.8" };
    },
    async getTranslateHealth() {
      translationChecks += 1;
      return {
        sources: [
          {
            id: "local",
            name: "Local Ollama",
            kind: "local",
            configured: true,
            reachable: false,
            models: [],
          },
          {
            id: "project-server",
            name: "Project Server",
            kind: "remote",
            configured: true,
            reachable: true,
            models: [],
          },
        ],
        available_model_options: [
          {
            value: "remote:project-server:qwen3:8b",
            label: "qwen3:8b",
            source: "project-server",
            model: "qwen3:8b",
          },
        ],
      };
    },
    async getVoices() {
      voiceChecks += 1;
      return {
        default_voice: "af_bella",
        default_speed: 0.8,
        speeds: [0.8, 1],
        groups: [
          {
            id: "american-female",
            label_zh: "美式女声",
            voices: [{ id: "af_bella", label_zh: "Bella" }],
          },
        ],
      };
    },
    async translate(payload) {
      translations += 1;
      assert.deepEqual(payload, {
        text: "论文结论是 $x^2$。",
        model: "remote:project-server:qwen3:8b",
        target_language: "Simplified Chinese",
      });
      return {
        translated_text: "The paper concludes that $x^2$.",
        model: payload.model,
        elapsed: 1.2,
      };
    },
    async prepareRead(payload) {
      preparations += 1;
      assert.equal(payload.model, "remote:project-server:qwen3:8b");
      return { prepared_text: "The paper concludes that x squared." };
    },
    async synthesizeSpeech(payload) {
      speechRequests += 1;
      assert.deepEqual(payload, {
        text: "The paper concludes that x squared.",
        voice: "af_bella",
        speed: 0.8,
      });
      return new Blob(["RIFF"], { type: "audio/wav" });
    },
  };
  const app = createTaskPaneApp({
    document,
    hostHint: "wps",
    wpsApplication: {},
    wpsAdapterFactory() {
      return adapter;
    },
    officeAdapterFactory() {
      throw new Error("Office should not be selected");
    },
    clientFactory() {
      return client;
    },
    controller: {
      async convertSelectedLatex() {
        return { formula_count: 1, warnings: [] };
      },
      async copySelectionAsLatex() {
        return { formula_count: 1, latex: "$x^2$" };
      },
    },
    async writeClipboard(value) {
      clipboard.push(value);
    },
    createObjectUrl() {
      return "blob:assistant-audio";
    },
    revokeObjectUrl() {},
  });

  await app.initialize();
  assert.deepEqual(
    [latexChecks, translationChecks, voiceChecks],
    [1, 1, 1]
  );
  assert.equal(elements["source-action-button"].hidden, false);
  assert.equal(elements["source-action-button"].textContent, "启动本地 Ollama");
  assert.equal(elements["translate-button"].disabled, true);
  assert.equal(elements["translate-button"].hidden, true);
  assert.equal(elements["advanced-settings"].hidden, true);
  assert.equal(elements["read-settings"].hidden, false);

  app.selectSource("project-server");
  assert.equal(elements["source-action-button"].hidden, true);
  assert.equal(elements["model-select"].value, "remote:project-server:qwen3:8b");
  assert.equal(elements["translate-button"].disabled, false);
  assert.equal(elements["translate-button"].hidden, false);
  assert.equal(elements["advanced-settings"].hidden, false);
  assert.equal(elements["source-rail"].hidden, true);

  await app.runAssistantAction("translate");
  assert.equal(translations, 1);
  assert.equal(translationChecks, 1);
  assert.equal(elements["translation-result"].hidden, false);
  assert.equal(
    elements["translation-text"].textContent,
    "The paper concludes that $x^2$."
  );
  await app.copyTranslation();
  await app.replaceTranslation();
  assert.deepEqual(clipboard, ["The paper concludes that $x^2$."]);
  assert.deepEqual(replacements, ["The paper concludes that $x^2$."]);

  elements["target-language"].value = "English";
  listeners.get("target-language:change")();
  assert.equal(elements["translation-result"].hidden, true);
  assert.equal(elements["copy-translation-button"].disabled, true);

  await app.runAssistantAction("read");
  assert.equal(preparations, 1);
  assert.equal(speechRequests, 1);
  assert.equal(translationChecks, 1);
  assert.equal(elements["speech-audio"].src, "blob:assistant-audio");
  assert.equal(elements["speech-audio"].paused, false);
});

test("task pane keeps plain-English read aloud available when translation discovery fails", async () => {
  const { document, elements } = fakeTaskPaneDocument();
  let speechRequests = 0;
  const app = createTaskPaneApp({
    document,
    hostHint: "wps",
    wpsApplication: {},
    wpsAdapterFactory() {
      return {
        async readSelectionText() {
          return "A plain English paragraph.";
        },
      };
    },
    officeAdapterFactory() {
      throw new Error("Office should not be selected");
    },
    clientFactory() {
      return {
        async getLatexHealth() {
          return { available: true };
        },
        async getTranslateHealth() {
          throw new Error("translation discovery unavailable");
        },
        async getVoices() {
          return {
            default_voice: "af_bella",
            default_speed: 0.8,
            speeds: [0.8],
            groups: [
              {
                label_zh: "美式女声",
                voices: [{ id: "af_bella", label_zh: "Bella" }],
              },
            ],
          };
        },
        async synthesizeSpeech(payload) {
          speechRequests += 1;
          assert.equal(payload.text, "A plain English paragraph.");
          return new Blob(["RIFF"], { type: "audio/wav" });
        },
      };
    },
    controller: {
      async convertSelectedLatex() {
        return { formula_count: 0, warnings: [] };
      },
      async copySelectionAsLatex() {
        return { formula_count: 0, latex: "" };
      },
    },
    async writeClipboard() {},
    createObjectUrl() {
      return "blob:plain-english";
    },
    revokeObjectUrl() {},
  });

  await app.initialize();

  assert.equal(elements["assistant-state"].textContent, "不可用");
  assert.equal(elements["translate-button"].hidden, true);
  assert.equal(elements["advanced-settings"].hidden, true);
  assert.equal(elements["read-settings"].hidden, false);
  assert.equal(elements["read-button"].disabled, false);

  await app.runAssistantAction("read");
  assert.equal(speechRequests, 1);
  assert.equal(elements["speech-audio"].src, "blob:plain-english");
});

test("task pane restores the saved 30b server model instead of selecting a larger first option", async () => {
  const { document, elements } = fakeTaskPaneDocument();
  const writes = [];
  const storage = {
    getItem() {
      return JSON.stringify({
        translationSource: "project-server",
        translationModels: {
          "project-server": "remote:project-server:qwen3:30b",
        },
        targetLanguage: "English",
        voice: "af_bella",
        speed: 1,
      });
    },
    setItem(key, value) {
      writes.push({ key, value: JSON.parse(value) });
    },
  };
  const app = createTaskPaneApp({
    document,
    storage,
    hostHint: "wps",
    wpsApplication: {},
    wpsAdapterFactory() {
      return {
        async readSelectionText() {
          return "Selected text";
        },
      };
    },
    officeAdapterFactory() {
      throw new Error("Office should not be selected");
    },
    clientFactory() {
      return {
        async getLatexHealth() {
          return { available: true };
        },
        async getTranslateHealth() {
          return {
            sources: [
              {
                id: "local",
                name: "Local Ollama",
                kind: "local",
                configured: true,
                reachable: false,
                models: [],
              },
              {
                id: "project-server",
                name: "Project Server",
                kind: "remote",
                configured: true,
                reachable: true,
                models: [],
              },
            ],
            available_model_options: [
              {
                value: "remote:project-server:qwen3:122b",
                label: "qwen3:122b",
                source: "project-server",
                model: "qwen3:122b",
              },
              {
                value: "remote:project-server:qwen3:30b",
                label: "qwen3:30b",
                source: "project-server",
                model: "qwen3:30b",
              },
            ],
          };
        },
        async getVoices() {
          return {
            default_voice: "af_bella",
            default_speed: 0.8,
            speeds: [0.8, 1],
            groups: [
              {
                label_zh: "美式女声",
                voices: [{ id: "af_bella", label_zh: "Bella" }],
              },
            ],
          };
        },
      };
    },
    controller: {
      async convertSelectedLatex() {
        return { formula_count: 0, warnings: [] };
      },
      async copySelectionAsLatex() {
        return { formula_count: 0, latex: "" };
      },
    },
    async writeClipboard() {},
  });

  await app.initialize();

  assert.equal(app.state.selectedSource, "project-server");
  assert.equal(
    app.state.selectedModel,
    "remote:project-server:qwen3:30b"
  );
  assert.equal(
    elements["model-select"].value,
    "remote:project-server:qwen3:30b"
  );
  assert.equal(elements["target-language"].value, "English");
  assert.equal(elements["voice-select"].value, "af_bella");
  assert.equal(elements["speed-select"].value, "1");

  app.selectSource("local");
  assert.equal(writes.at(-1).value.translationSource, "local");
  assert.equal(
    writes.at(-1).value.translationModels["project-server"],
    "remote:project-server:qwen3:30b"
  );
});

test("task pane refreshes discovery only after an explicit source connection action", async () => {
  const { document, elements } = fakeTaskPaneDocument();
  const timers = [];
  const opened = [];
  let healthChecks = 0;
  let connected = false;
  const app = createTaskPaneApp({
    document,
    hostHint: "wps",
    wpsApplication: {},
    wpsAdapterFactory() {
      return {
        async readSelectionText() {
          return "Selected text";
        },
      };
    },
    officeAdapterFactory() {
      throw new Error("Office should not be selected");
    },
    clientFactory() {
      return {
        async getLatexHealth() {
          return { available: true };
        },
        async getTranslateHealth() {
          healthChecks += 1;
          return {
            sources: [
              {
                id: "local",
                name: "Local Ollama",
                kind: "local",
                configured: true,
                reachable: false,
                models: [],
              },
              {
                id: "project-server",
                name: "Project Server",
                kind: "remote",
                configured: connected,
                reachable: connected,
                models: [],
              },
            ],
            available_model_options: connected
              ? [
                  {
                    value: "remote:project-server:qwen3:30b",
                    label: "qwen3:30b",
                    source: "project-server",
                    model: "qwen3:30b",
                  },
                ]
              : [],
          };
        },
        async getVoices() {
          return {
            default_voice: "af_bella",
            default_speed: 0.8,
            speeds: [0.8],
            groups: [],
          };
        },
      };
    },
    controller: {
      async convertSelectedLatex() {
        return { formula_count: 0, warnings: [] };
      },
      async copySelectionAsLatex() {
        return { formula_count: 0, latex: "" };
      },
    },
    async writeClipboard() {},
    openProtocol(url) {
      opened.push(url);
    },
    setTimeout(callback, delay) {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeout() {},
  });

  await app.initialize();
  app.selectSource("project-server");
  assert.equal(healthChecks, 1);
  assert.equal(elements["source-action-button"].textContent, "连接服务器");

  assert.equal(app.runSourceAction(), true);
  assert.deepEqual(opened, ["localreadtranslate://remote"]);
  assert.equal(healthChecks, 1);
  assert.equal(timers[0].delay, 0);

  connected = true;
  await timers.shift().callback();

  assert.equal(healthChecks, 2);
  assert.equal(app.state.assistantView.mode, "ready");
  assert.equal(
    app.state.selectedModel,
    "remote:project-server:qwen3:30b"
  );
  assert.equal(elements["source-action-button"].hidden, true);
});

test("clipboard fallback writes only text through the host document", async () => {
  const { document } = fakeTaskPaneDocument();
  const values = [];
  document.execCommand = (command) => {
    assert.equal(command, "copy");
    values.push(document.body.children[0].value);
    return true;
  };
  const writer = createClipboardWriter(document, {});
  await writer("正文 $\\frac{a}{b}$");
  assert.deepEqual(values, ["正文 $\\frac{a}{b}$"]);
  assert.equal(document.body.children.length, 0);
});

test("clipboard rejection falls back to the host document copy command", async () => {
  const { document } = fakeTaskPaneDocument();
  const values = [];
  document.execCommand = (command) => {
    assert.equal(command, "copy");
    values.push(document.body.children[0].value);
    return true;
  };
  const writer = createClipboardWriter(document, {
    clipboard: {
      async writeText() {
        throw new Error("permission denied");
      },
    },
  });

  await writer("正文 $x^2$");

  assert.deepEqual(values, ["正文 $x^2$"]);
  assert.equal(document.body.children.length, 0);
});

test("WPS ribbon creates and toggles one shared task pane", () => {
  const storage = new Map();
  const panes = new Map();
  const app = {
    ActiveDocument: {},
    PluginStorage: {
      getItem(key) {
        return storage.get(key);
      },
      setItem(key, value) {
        storage.set(key, value);
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    CreateTaskPane(url) {
      assert.equal(url, TASKPANE_URL);
      const pane = { ID: 41, Visible: false };
      panes.set(41, pane);
      return pane;
    },
    GetTaskPane(id) {
      return panes.get(id);
    },
  };
  const previousApplication = globalThis.Application;
  globalThis.Application = app;
  try {
    assert.equal(toggleFormulaTaskPane(), true);
    assert.equal(panes.get(41).Visible, true);
    assert.equal(toggleFormulaTaskPane(), true);
    assert.equal(panes.get(41).Visible, false);
  } finally {
    globalThis.Application = previousApplication;
  }
  assert.equal(BUTTON_ID, "localReadTranslateShowFormulaPane");
});
