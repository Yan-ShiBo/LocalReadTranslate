(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) {
    root.LocalReadTranslateWpsRibbon = api;
    root.OnAddinLoad = api.OnAddinLoad;
    root.OnAction = api.OnAction;
    root.OnGetEnabled = api.OnGetEnabled;
    root.GetImage = api.GetImage;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const BUTTON_ID = "localReadTranslateShowFormulaPane";
  const TASKPANE_STORAGE_KEY = "localreadtranslate_formula_taskpane_id";
  const TASKPANE_URL =
    "http://localhost:5443/taskpane/taskpane.html?host=wps";
  const ICON_URL = "http://localhost:5443/assets/icon-32.png";

  function application() {
    const app = root && (root.Application || root.wps);
    if (!app) throw new Error("WPS Writer JavaScript API is unavailable");
    return app;
  }

  function createAndShowTaskPane(app) {
    const pane = app.CreateTaskPane(TASKPANE_URL);
    app.PluginStorage.setItem(TASKPANE_STORAGE_KEY, pane.ID);
    pane.Visible = true;
    return pane;
  }

  function toggleFormulaTaskPane() {
    const app = application();
    if (!app.ActiveDocument) {
      if (typeof root.alert === "function") {
        root.alert("请先打开一个 WPS 文字文档。");
      }
      return false;
    }

    const existingId = app.PluginStorage.getItem(TASKPANE_STORAGE_KEY);
    if (!existingId) {
      createAndShowTaskPane(app);
      return true;
    }
    try {
      const pane = app.GetTaskPane(existingId);
      if (!pane) return Boolean(createAndShowTaskPane(app));
      pane.Visible = !pane.Visible;
      return true;
    } catch (_error) {
      app.PluginStorage.removeItem(TASKPANE_STORAGE_KEY);
      createAndShowTaskPane(app);
      return true;
    }
  }

  function OnAddinLoad(ribbonUI) {
    const app = application();
    app.ribbonUI = ribbonUI;
    return true;
  }

  function OnAction(control) {
    if (control && control.Id === BUTTON_ID) {
      return toggleFormulaTaskPane();
    }
    return true;
  }

  function OnGetEnabled(control) {
    if (!control || control.Id !== BUTTON_ID) return true;
    try {
      return Boolean(application().ActiveDocument);
    } catch (_error) {
      return false;
    }
  }

  function GetImage() {
    return ICON_URL;
  }

  return {
    BUTTON_ID,
    ICON_URL,
    TASKPANE_STORAGE_KEY,
    TASKPANE_URL,
    GetImage,
    OnAction,
    OnAddinLoad,
    OnGetEnabled,
    createAndShowTaskPane,
    toggleFormulaTaskPane,
  };
});
