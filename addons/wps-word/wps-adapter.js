(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LocalReadTranslateWpsWord = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const WD_COLLAPSE_START = 1;
  const WD_DO_NOT_SAVE_CHANGES = 0;
  const WD_FORMAT_XML_DOCUMENT = 12;

  function tempDocxPath(application) {
    const root = String(
      application.Env && application.Env.GetTempPath
        ? application.Env.GetTempPath()
        : application.FileSystem.tmpdir()
    );
    const separator = /[\\/]$/.test(root) ? "" : "\\";
    const random = Math.random().toString(16).slice(2) || "0";
    return `${root}${separator}localreadtranslate-selection-${Date.now()}-${random}.docx`;
  }

  function removeFile(fileSystem, path) {
    if (!fileSystem || !path) return;
    try {
      if (typeof fileSystem.unlinkSync === "function") {
        fileSystem.unlinkSync(path);
      } else if (typeof fileSystem.Remove === "function") {
        fileSystem.Remove(path);
      }
    } catch (_error) {
      // The OS temp directory also cleans stale files. Copy must not fail only
      // because a WPS build keeps the just-closed file locked briefly.
    }
  }

  function createWpsWriterAdapter(application) {
    const app =
      application ||
      (typeof globalThis !== "undefined"
        ? (globalThis.Application || globalThis.wps)
        : null);
    if (!app || !app.Selection || !app.Documents) {
      throw new Error("WPS Writer JavaScript API is unavailable");
    }

    return Object.freeze({
      async readSelectionText() {
        return String(app.Selection.Text || "");
      },

      async exportSelectionForLatex() {
        const originalDocument = app.ActiveDocument;
        const sourceRange = app.Selection.Range;
        const path = tempDocxPath(app);
        let temporaryDocument = null;
        let handedOff = false;
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          removeFile(app.FileSystem, path);
        };
        try {
          sourceRange.Copy();
          temporaryDocument = app.Documents.Add();
          temporaryDocument.Range(0, 0).Paste();
          temporaryDocument.SaveAs2(
            path,
            WD_FORMAT_XML_DOCUMENT,
            null,
            null,
            false
          );
          temporaryDocument.Close(WD_DO_NOT_SAVE_CHANGES);
          temporaryDocument = null;
          if (originalDocument && typeof originalDocument.Activate === "function") {
            originalDocument.Activate();
          }
          handedOff = true;
          return {
            source_format: "docx-local-path",
            content: path,
            cleanup,
          };
        } finally {
          if (temporaryDocument) {
            try {
              temporaryDocument.Close(WD_DO_NOT_SAVE_CHANGES);
            } catch (_error) {
              // Continue restoring the original document and temp file cleanup.
            }
          }
          if (originalDocument && typeof originalDocument.Activate === "function") {
            try {
              originalDocument.Activate();
            } catch (_error) {
              // The original document may have been closed during the operation.
            }
          }
          if (!handedOff) cleanup();
        }
      },

      async replaceSelectionWithFragment(fragment) {
        const path = String(fragment && fragment.local_path || "");
        if (!path) throw new Error("A local DOCX fragment path is required");
        const range = app.Selection.Range;
        range.Text = "";
        if (typeof range.Collapse === "function") {
          range.Collapse(WD_COLLAPSE_START);
        }
        range.InsertFile(path, null, false, false, false);
      },

      async replaceSelectionWithText(text) {
        app.Selection.Range.Text = String(text || "");
      },
    });
  }

  return {
    WD_COLLAPSE_START,
    WD_DO_NOT_SAVE_CHANGES,
    WD_FORMAT_XML_DOCUMENT,
    createWpsWriterAdapter,
  };
});
