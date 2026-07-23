(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LocalReadTranslateTaskPane = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const OFFICE_JS_URL =
    "https://appsforoffice.microsoft.com/lib/1/hosted/office.js";

  function detectHostHint(search) {
    const value = String(search || "");
    try {
      const host = new URLSearchParams(value).get("host");
      return host === "office" || host === "wps" ? host : "";
    } catch (_error) {
      return "";
    }
  }

  function summarizeLatexSelection(value) {
    const source = String(value || "");
    if (!source.trim()) {
      return { inline: 0, display: 0, total: 0, hasText: false };
    }

    let masked = source;
    let display = 0;
    const displayPatterns = [
      /\$\$[\s\S]*?\$\$/g,
      /\\\[[\s\S]*?\\\]/g,
      /\\begin\{(?:equation\*?|align\*?|alignat\*?|gather\*?|multline\*?)\}[\s\S]*?\\end\{(?:equation\*?|align\*?|alignat\*?|gather\*?|multline\*?)\}/g,
      /\[\[MATH_BLOCK:[\s\S]*?\]\]/g,
    ];
    for (const pattern of displayPatterns) {
      masked = masked.replace(pattern, (match) => {
        display += 1;
        return " ".repeat(match.length);
      });
    }

    let inline = 0;
    const inlinePatterns = [
      /\\\([\s\S]*?\\\)/g,
      /\[\[MATH:(?!_BLOCK)[\s\S]*?\]\]/g,
      /(^|[^\\$])\$(?!\$)(?:\\.|[^$\r\n])+\$/gm,
    ];
    for (const pattern of inlinePatterns) {
      masked = masked.replace(pattern, (match) => {
        inline += 1;
        return " ".repeat(match.length);
      });
    }
    return {
      inline,
      display,
      total: inline + display,
      hasText: true,
    };
  }

  function createClipboardWriter(documentObject, navigatorObject) {
    return async function writeClipboard(text) {
      const clipboard = navigatorObject && navigatorObject.clipboard;
      if (clipboard && typeof clipboard.writeText === "function") {
        try {
          await clipboard.writeText(text);
          return;
        } catch (_error) {
          // WPS and older Office webviews can expose Clipboard API while
          // denying writes. Continue with the user-gesture execCommand path.
        }
      }
      if (!documentObject || typeof documentObject.createElement !== "function") {
        throw new Error("当前宿主无法写入纯文本剪贴板");
      }
      const area = documentObject.createElement("textarea");
      area.value = String(text || "");
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      documentObject.body.appendChild(area);
      area.select();
      let copied = false;
      try {
        copied =
          typeof documentObject.execCommand === "function" &&
          documentObject.execCommand("copy");
      } finally {
        documentObject.body.removeChild(area);
      }
      if (!copied) throw new Error("当前宿主无法写入纯文本剪贴板");
    };
  }

  function requiredElement(documentObject, id) {
    const element = documentObject.getElementById(id);
    if (!element) throw new Error(`Task pane element #${id} is missing`);
    return element;
  }

  function createTaskPaneApp(options = {}) {
    const documentObject = options.document;
    if (!documentObject) throw new Error("A task pane document is required");

    const elements = {
      hostName: requiredElement(documentObject, "host-name"),
      servicePill: requiredElement(documentObject, "service-pill"),
      serviceDetail: requiredElement(documentObject, "service-detail"),
      retryButton: requiredElement(documentObject, "retry-button"),
      preview: requiredElement(documentObject, "selection-preview"),
      formulaCount: requiredElement(documentObject, "formula-count"),
      inlineCount: requiredElement(documentObject, "inline-count"),
      displayCount: requiredElement(documentObject, "display-count"),
      selectionNote: requiredElement(documentObject, "selection-note"),
      convertButton: requiredElement(documentObject, "convert-button"),
      copyButton: requiredElement(documentObject, "copy-button"),
      operationStatus: requiredElement(documentObject, "operation-status"),
      operationMark: requiredElement(documentObject, "operation-mark"),
      operationTitle: requiredElement(documentObject, "operation-title"),
      operationDetail: requiredElement(documentObject, "operation-detail"),
    };

    const state = {
      adapter: null,
      client: null,
      controller: options.controller,
      host: "",
      serviceReady: false,
      busy: false,
    };

    function setService(kind, detail, canRetry = false) {
      elements.servicePill.className = `status-dot is-${kind}`;
      elements.serviceDetail.textContent = detail;
      elements.retryButton.hidden = !canRetry;
    }

    function setOperation(kind, title, detail) {
      const marks = {
        idle: "·",
        working: "…",
        success: "✓",
        error: "!",
      };
      elements.operationStatus.className = `operation-status is-${kind}`;
      elements.operationMark.textContent = marks[kind] || "·";
      elements.operationTitle.textContent = title;
      elements.operationDetail.textContent = detail;
    }

    function updateButtons() {
      const enabled = state.serviceReady && state.adapter && !state.busy;
      elements.convertButton.disabled = !enabled;
      elements.copyButton.disabled = !enabled;
      elements.retryButton.disabled = state.busy;
    }

    function setBusy(value) {
      state.busy = Boolean(value);
      updateButtons();
    }

    function renderSelectionSummary(summary) {
      elements.preview.textContent = "";
      elements.inlineCount.textContent = String(summary.inline);
      elements.displayCount.textContent = String(summary.display);
      elements.formulaCount.textContent = summary.hasText
        ? String(summary.total)
        : "—";
      if (!summary.hasText) {
        elements.preview.className = "formula-strip is-empty";
        const empty = documentObject.createElement("span");
        empty.className = "empty-strip";
        empty.textContent = "切回文档选择一段内容";
        elements.preview.appendChild(empty);
        return;
      }
      if (!summary.total) {
        elements.preview.className = "formula-strip is-empty";
        const empty = documentObject.createElement("span");
        empty.className = "empty-strip";
        empty.textContent = "未发现 LaTeX；可直接复制原生公式";
        elements.preview.appendChild(empty);
        return;
      }

      elements.preview.className = "formula-strip";
      const maximumSegments = 12;
      const segments = [];
      for (let index = 0; index < summary.inline; index += 1) {
        segments.push("inline");
      }
      for (let index = 0; index < summary.display; index += 1) {
        segments.push("display");
      }
      for (const [index, type] of segments.slice(0, maximumSegments).entries()) {
        const segment = documentObject.createElement("span");
        segment.className = `formula-segment ${type}`;
        segment.textContent = type === "inline" ? "$" : "$$";
        segment.title = `${type === "inline" ? "行内" : "独立"}公式 ${index + 1}`;
        elements.preview.appendChild(segment);
      }
      if (segments.length > maximumSegments) {
        const more = documentObject.createElement("span");
        more.className = "formula-segment inline";
        more.textContent = `+${segments.length - maximumSegments}`;
        elements.preview.appendChild(more);
      }
    }

    async function refreshSelectionPreview(force = false) {
      if (!state.adapter || (state.busy && !force)) return;
      try {
        const selected = await state.adapter.readSelectionText();
        renderSelectionSummary(summarizeLatexSelection(selected));
      } catch (_error) {
        renderSelectionSummary(
          { inline: 0, display: 0, total: 0, hasText: false }
        );
      }
    }

    async function resolveAdapter() {
      const hint = options.hostHint || "";
      if (hint === "office") {
        const office = options.office;
        if (!office || typeof office.onReady !== "function") {
          throw new Error("Microsoft Office JavaScript 运行时未加载");
        }
        const info = await office.onReady();
        const wordHost =
          office.HostType && office.HostType.Word
            ? office.HostType.Word
            : "Word";
        if (info && info.host && info.host !== wordHost) {
          throw new Error("此插件只支持 Microsoft Word");
        }
        state.host = "office";
        elements.hostName.textContent = "Microsoft Word";
        return options.officeAdapterFactory(options.wordRuntime);
      }
      if (hint === "wps") {
        state.host = "wps";
        elements.hostName.textContent = "WPS Writer";
        return options.wpsAdapterFactory(options.wpsApplication);
      }
      throw new Error("无法识别当前文档宿主");
    }

    async function checkService() {
      setService("checking", "正在检查一次转换环境…");
      state.serviceReady = false;
      updateButtons();
      try {
        const health = await state.client.getLatexHealth();
        if (!health || health.available !== true) {
          setService(
            "error",
            "已连接服务，但未找到 Pandoc 公式转换器",
            true
          );
          setOperation(
            "error",
            "转换器不可用",
            "安装 Pandoc 3.x 后点击“重试”，无需重启文档。"
          );
          return false;
        }
        state.serviceReady = true;
        const version = health.version ? ` · Pandoc ${health.version}` : "";
        setService("ready", `可用${version}`);
        setOperation(
          "idle",
          "准备就绪",
          "选择内容后直接执行，不会重复检查服务。"
        );
        return true;
      } catch (error) {
        setService("error", "本地翻译服务未连接", true);
        setOperation(
          "error",
          "服务离线",
          error && error.message
            ? error.message
            : "请先启动 LocalReadTranslate 本地服务。"
        );
        return false;
      } finally {
        updateButtons();
      }
    }

    async function runAction(kind) {
      if (!state.serviceReady || state.busy) return null;
      setBusy(true);
      try {
        if (kind === "convert") {
          setOperation("working", "正在转换", "读取当前选区并生成原生公式…");
          const result = await state.controller.convertSelectedLatex({
            adapter: state.adapter,
            client: state.client,
          });
          const formulaCount = Number(result.formula_count || 0);
          const warningCount = Array.isArray(result.warnings)
            ? result.warnings.length
            : 0;
          setOperation(
            "success",
            `已转换 ${formulaCount} 个公式`,
            warningCount
              ? `文档已更新，另有 ${warningCount} 条转换提示。`
              : "文档已更新；公式仍可在 Word/WPS 中编辑。"
          );
          await refreshSelectionPreview(true);
          return result;
        }

        setOperation("working", "正在统一为 LaTeX", "导出当前选区并写入纯文本剪贴板…");
        const result = await state.controller.copySelectionAsLatex({
          adapter: state.adapter,
          client: state.client,
          writeClipboard: options.writeClipboard,
        });
        const formulaCount = Number(result.formula_count || 0);
        setOperation(
          "success",
          `已复制 ${formulaCount} 个公式`,
          "剪贴板中只有规范化 LaTeX 与原段落文本。"
        );
        return result;
      } catch (error) {
        const status = Number(error && error.status || 0);
        if (status === 0 || status === 502) {
          state.serviceReady = false;
          setService("error", "本地翻译服务已断开", true);
        } else if (status === 503) {
          state.serviceReady = false;
          setService("error", "Pandoc 公式转换器不可用", true);
        }
        setOperation(
          "error",
          kind === "convert" ? "未能转换选区" : "未能复制选区",
          error && error.message ? error.message : "操作失败，请检查当前选区。"
        );
        throw error;
      } finally {
        setBusy(false);
      }
    }

    async function initialize() {
      setBusy(true);
      try {
        state.adapter = await resolveAdapter();
        state.client = options.clientFactory({ baseUrl: "/api" });
        await checkService();
        await refreshSelectionPreview(true);
      } catch (error) {
        state.serviceReady = false;
        setService("error", "插件宿主初始化失败", false);
        setOperation(
          "error",
          "无法初始化公式工作台",
          error && error.message ? error.message : "未知宿主错误"
        );
      } finally {
        setBusy(false);
      }
      return state;
    }

    elements.convertButton.addEventListener("click", () => {
      runAction("convert").catch(() => undefined);
    });
    elements.copyButton.addEventListener("click", () => {
      runAction("copy").catch(() => undefined);
    });
    elements.retryButton.addEventListener("click", () => {
      checkService().catch(() => undefined);
    });

    return Object.freeze({
      checkService,
      initialize,
      refreshSelectionPreview,
      runAction,
      state,
    });
  }

  function loadOfficeRuntime(documentObject, rootObject = root) {
    if (rootObject && rootObject.Office) return Promise.resolve(rootObject.Office);
    return new Promise((resolve, reject) => {
      const script = documentObject.createElement("script");
      script.src = OFFICE_JS_URL;
      script.onload = () => resolve(rootObject.Office);
      script.onerror = () =>
        reject(new Error("Microsoft Office JavaScript 运行时加载失败"));
      documentObject.head.appendChild(script);
    });
  }

  async function bootstrapBrowser(rootObject = root) {
    const documentObject = rootObject && rootObject.document;
    if (!documentObject) return null;
    const hostHint = detectHostHint(rootObject.location && rootObject.location.search);
    let office = rootObject.Office;
    if (hostHint === "office") {
      office = await loadOfficeRuntime(documentObject, rootObject);
    }
    const clientApi = rootObject.LocalReadTranslateClient;
    const controller = rootObject.LocalReadTranslateFormulaController;
    const officeApi = rootObject.LocalReadTranslateOfficeWord;
    const wpsApi = rootObject.LocalReadTranslateWpsWord;
    if (!clientApi || !controller || !officeApi || !wpsApi) {
      throw new Error("公式工作台依赖未完整加载");
    }
    const app = createTaskPaneApp({
      document: documentObject,
      hostHint,
      office,
      wordRuntime: rootObject.Word,
      wpsApplication: rootObject.Application || rootObject.wps,
      controller,
      clientFactory: clientApi.createClient,
      officeAdapterFactory: officeApi.createOfficeWordAdapter,
      wpsAdapterFactory: wpsApi.createWpsWriterAdapter,
      writeClipboard: createClipboardWriter(
        documentObject,
        rootObject.navigator
      ),
    });
    rootObject.LocalReadTranslateTaskPaneApp = app;
    await app.initialize();
    if (typeof rootObject.addEventListener === "function") {
      rootObject.addEventListener("focus", () => {
        app.refreshSelectionPreview().catch(() => undefined);
      });
    }
    return app;
  }

  if (root && root.document) {
    const start = () => {
      bootstrapBrowser(root).catch((error) => {
        const detail = root.document.getElementById("operation-detail");
        const title = root.document.getElementById("operation-title");
        if (title) title.textContent = "公式工作台启动失败";
        if (detail) detail.textContent = error && error.message || String(error);
      });
    };
    if (root.document.readyState === "loading") {
      root.document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }

  return {
    OFFICE_JS_URL,
    bootstrapBrowser,
    createClipboardWriter,
    createTaskPaneApp,
    detectHostHint,
    loadOfficeRuntime,
    summarizeLatexSelection,
  };
});
