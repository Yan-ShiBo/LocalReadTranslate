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

function fakeTaskPaneDocument() {
  const listeners = new Map();
  class Element {
    constructor(id = "") {
      this.id = id;
      this.textContent = "";
      this.hidden = false;
      this.disabled = false;
      this.className = "";
      this.children = [];
      this.style = {};
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
