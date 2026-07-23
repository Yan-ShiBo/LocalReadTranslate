(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LocalReadTranslateFormulaController = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  async function defaultWriteClipboard(text) {
    if (
      typeof navigator === "undefined" ||
      !navigator.clipboard ||
      typeof navigator.clipboard.writeText !== "function"
    ) {
      throw new Error("Clipboard text writing is unavailable");
    }
    await navigator.clipboard.writeText(text);
  }

  function requireMethod(target, name) {
    if (!target || typeof target[name] !== "function") {
      throw new Error(`Formula adapter must implement ${name}()`);
    }
  }

  async function convertSelectedLatex(options) {
    const { adapter, client } = options || {};
    requireMethod(adapter, "readSelectionText");
    requireMethod(adapter, "replaceSelectionWithFragment");
    requireMethod(client, "createLatexFragment");

    const source = String(await adapter.readSelectionText() || "").trim();
    if (!source) throw new Error("Select a paragraph containing LaTeX first");
    const fragment = await client.createLatexFragment(source);
    if (!fragment || !fragment.docx_base64 || !fragment.local_path) {
      throw new Error("The local service did not return a native formula fragment");
    }
    await adapter.replaceSelectionWithFragment(fragment);
    return fragment;
  }

  async function copySelectionAsLatex(options) {
    const { adapter, client } = options || {};
    const writeClipboard = options && options.writeClipboard
      ? options.writeClipboard
      : defaultWriteClipboard;
    requireMethod(adapter, "exportSelectionForLatex");
    requireMethod(client, "nativeToLatex");

    const nativeSource = await adapter.exportSelectionForLatex();
    const result = await client.nativeToLatex(nativeSource);
    const latex = String(result && result.latex || "").trim();
    if (!latex) throw new Error("The selected content did not produce LaTeX");

    // LaTeX is deliberately the only externally copied representation.
    await writeClipboard(latex);
    return { ...result, latex };
  }

  return {
    convertSelectedLatex,
    copySelectionAsLatex,
    defaultWriteClipboard,
  };
});
