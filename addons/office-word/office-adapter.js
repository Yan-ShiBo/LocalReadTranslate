(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LocalReadTranslateOfficeWord = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function createOfficeWordAdapter(wordRuntime) {
    const WordApi =
      wordRuntime ||
      (typeof globalThis !== "undefined" ? globalThis.Word : null);
    if (!WordApi || typeof WordApi.run !== "function") {
      throw new Error("Microsoft Word JavaScript API is unavailable");
    }

    return Object.freeze({
      async readSelectionText() {
        let value = "";
        await WordApi.run(async (context) => {
          const selection = context.document.getSelection();
          selection.load("text");
          await context.sync();
          value = String(selection.text || "");
        });
        return value;
      },

      async exportSelectionForLatex() {
        let value = "";
        await WordApi.run(async (context) => {
          const selection = context.document.getSelection();
          const result = selection.getOoxml();
          await context.sync();
          value = String(result.value || "");
        });
        if (!value) throw new Error("The selected Word content is empty");
        return {
          source_format: "flat-opc",
          content: value,
        };
      },

      async replaceSelectionWithFragment(fragment) {
        const base64 = String(fragment && fragment.docx_base64 || "");
        if (!base64) throw new Error("A DOCX fragment is required");
        await WordApi.run(async (context) => {
          const selection = context.document.getSelection();
          selection.insertFileFromBase64(base64, "Replace");
          await context.sync();
        });
      },

      async replaceSelectionWithText(text) {
        await WordApi.run(async (context) => {
          const selection = context.document.getSelection();
          selection.insertText(String(text || ""), "Replace");
          await context.sync();
        });
      },
    });
  }

  return {
    createOfficeWordAdapter,
  };
});
