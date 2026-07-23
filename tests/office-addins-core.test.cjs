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
  const adapter = {
    async exportSelectionForLatex() {
      return {
        source_format: "flat-opc",
        content: "<pkg:package/>",
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
  const sourceFormattedText = { rich: true };
  const selectionRange = {
    FormattedText: sourceFormattedText,
    Text: "selected",
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
      readAsBinaryString(path) {
        calls.push(["read", path]);
        return "docx";
      },
      unlinkSync(path) {
        calls.push(["unlink", path]);
      },
    },
  };
  const adapter = createWpsWriterAdapter(app);

  assert.equal(await adapter.readSelectionText(), "selected");
  const exported = await adapter.exportSelectionForLatex();
  assert.deepEqual(exported, {
    source_format: "docx-base64",
    content: Buffer.from("docx", "binary").toString("base64"),
  });
  assert.equal(temporaryDocument.Content.FormattedText, sourceFormattedText);
  assert.equal(calls.find((call) => call[0] === "save")[2], 12);

  await adapter.replaceSelectionWithFragment({
    local_path: "C:\\Temp\\formula.docx",
  });
  assert.equal(selectionRange.Text, "");
  assert.deepEqual(calls.at(-2), ["collapse", 1]);
  assert.deepEqual(calls.at(-1), ["insert", "C:\\Temp\\formula.docx"]);
});
