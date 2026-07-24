(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LocalReadTranslateWpsPdf = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const PDF_CAPABILITIES = Object.freeze({
    formulaTools: true,
    convertFormula: false,
    copyFormula: true,
    requiresFormulaHealth: false,
    formulaRecognition: true,
    replaceSelectionText: false,
  });

  function pdfSelection(application) {
    const document = application && application.ActiveDocument;
    const selection = document && document.Selection;
    if (!selection || typeof selection.Text !== "function") {
      throw new Error("WPS PDF text selection API is unavailable");
    }
    return selection;
  }

  function createWpsPdfAdapter(application) {
    const app =
      application ||
      (typeof globalThis !== "undefined"
        ? (globalThis.Application || globalThis.wps)
        : null);
    pdfSelection(app);

    return Object.freeze({
      capabilities: PDF_CAPABILITIES,

      async readSelectionText() {
        return String(pdfSelection(app).Text() || "");
      },

      async exportSelectionForLatex() {
        const text = String(pdfSelection(app).Text() || "").trim();
        if (!text) {
          throw new Error("Select a PDF formula or formula-bearing paragraph first");
        }
        return {
          source_format: "wps-pdf-selection",
          content: text,
        };
      },
    });
  }

  return {
    PDF_CAPABILITIES,
    createWpsPdfAdapter,
    pdfSelection,
  };
});
