(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    root.LocalReadTranslateWpsPdfRibbon = api;
    root.OnAddinLoad = api.OnAddinLoad;
    root.OnAction = api.OnAction;
    root.OnGetEnabled = api.OnGetEnabled;
    root.GetImage = api.GetImage;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const PDF_BUTTON_ID = "localReadTranslateShowPdfPane";
  const PDF_TASKPANE_STORAGE_KEY = "localreadtranslate_pdf_taskpane_id";
  const PDF_TASKPANE_URL =
    "http://localhost:5443/taskpane/taskpane.html?host=wps-pdf";
  // WPS PDF resolves callback image values relative to the package URL. A
  // root-relative value avoids turning an absolute URL into
  // /wps-pdf/http://localhost:... .
  const PDF_ICON_URL = "/assets/icon-32.png";
  let ribbonUIHandle = null;

  function application() {
    const app = root && (root.Application || root.wps);
    if (!app) throw new Error("WPS PDF JavaScript API is unavailable");
    return app;
  }

  function hasActivePdf(app) {
    try {
      return Boolean(
        app &&
        app.ActiveDocument &&
        app.ActiveDocument.Selection &&
        typeof app.ActiveDocument.Selection.Text === "function"
      );
    } catch (_error) {
      return false;
    }
  }

  function createAndShowPdfTaskPane(app) {
    const pane = app.CreateTaskPane(PDF_TASKPANE_URL);
    app.PluginStorage.setItem(PDF_TASKPANE_STORAGE_KEY, pane.ID);
    pane.Visible = true;
    return pane;
  }

  function togglePdfTaskPane() {
    const app = application();
    if (!hasActivePdf(app)) {
      if (typeof root.alert === "function") {
        root.alert("请先打开一个 WPS PDF 文档。");
      }
      return false;
    }

    const existingId = app.PluginStorage.getItem(PDF_TASKPANE_STORAGE_KEY);
    if (!existingId) {
      createAndShowPdfTaskPane(app);
      return true;
    }
    try {
      const pane = app.GetTaskPane(existingId);
      if (!pane) return Boolean(createAndShowPdfTaskPane(app));
      pane.Visible = !pane.Visible;
      return true;
    } catch (_error) {
      app.PluginStorage.removeItem(PDF_TASKPANE_STORAGE_KEY);
      createAndShowPdfTaskPane(app);
      return true;
    }
  }

  function OnAddinLoad(ribbonUI) {
    // PDF exposes a non-configurable Application.ribbonUI property. Keep the
    // handle in this module instead of assigning to Application.
    ribbonUIHandle = ribbonUI || null;
    return true;
  }

  function OnAction(control) {
    if (control && control.Id === PDF_BUTTON_ID) {
      return togglePdfTaskPane();
    }
    return true;
  }

  function OnGetEnabled(control) {
    if (!control || control.Id !== PDF_BUTTON_ID) return true;
    return hasActivePdf(application());
  }

  function GetImage() {
    return PDF_ICON_URL;
  }

  return {
    PDF_BUTTON_ID,
    PDF_ICON_URL,
    PDF_TASKPANE_STORAGE_KEY,
    PDF_TASKPANE_URL,
    GetImage,
    OnAction,
    OnAddinLoad,
    OnGetEnabled,
    createAndShowPdfTaskPane,
    hasActivePdf,
    togglePdfTaskPane,
    getRibbonUI() {
      return ribbonUIHandle;
    },
  };
});
