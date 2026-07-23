(function (root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LocalReadTranslateTaskPane = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  const OFFICE_JS_URL =
    "https://appsforoffice.microsoft.com/lib/1/hosted/office.js";
  const ASSISTANT_SETTINGS_KEY =
    "localreadtranslate-document-assistant-settings-v1";
  const ASSISTANT_TARGET_LANGUAGES = [
    "Simplified Chinese",
    "Traditional Chinese",
    "English",
    "Japanese",
    "Korean",
  ];

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

  function assistantModelSource(value, explicitSource = "") {
    const source = String(explicitSource || "").trim();
    if (source) return source;
    const model = String(value || "").trim();
    if (!model.startsWith("remote:")) return model ? "local" : "";
    const parts = model.split(":", 3);
    return parts.length === 3 ? parts[1] : "";
  }

  function normalizeAssistantPreferences(saved = {}) {
    const candidate =
      saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
    const validSource = (value) =>
      /^[a-z0-9][a-z0-9._-]*$/i.test(String(value || ""));
    const requestedSource = String(candidate.translationSource || "").trim();
    const translationSource = validSource(requestedSource)
      ? requestedSource
      : "local";
    const translationModels = {};
    const storedModels = candidate.translationModels;
    if (
      storedModels &&
      typeof storedModels === "object" &&
      !Array.isArray(storedModels)
    ) {
      for (const [source, rawModel] of Object.entries(storedModels)) {
        const model = String(rawModel || "").trim();
        if (
          validSource(source) &&
          model &&
          assistantModelSource(model) === source
        ) {
          translationModels[source] = model;
        }
      }
    }
    const target = String(candidate.targetLanguage || "").trim();
    const voice = String(candidate.voice || "").trim();
    const speed = Number(candidate.speed);
    return {
      translationSource,
      translationModels,
      targetLanguage: ASSISTANT_TARGET_LANGUAGES.includes(target)
        ? target
        : "Simplified Chinese",
      voice,
      speed: Number.isFinite(speed) && speed > 0 ? speed : 0.8,
    };
  }

  function deriveAssistantSourceView(
    payload,
    selectedSource = "local",
    selectedModel = ""
  ) {
    const health = payload && typeof payload === "object" ? payload : {};
    const sourceMap = new Map();
    const discoveredSources = Array.isArray(health.sources) ? health.sources : [];
    for (const item of discoveredSources) {
      const id = String(item && item.id || "").trim();
      if (!id || sourceMap.has(id)) continue;
      const kind = item.kind === "remote" || id !== "local" ? "remote" : "local";
      sourceMap.set(id, {
        id,
        name: String(item.name || id).trim() || id,
        kind,
        configured: item.configured !== false,
        reachable: Boolean(item.reachable),
        models: Array.isArray(item.models) ? item.models : [],
      });
    }
    if (!sourceMap.has("local")) {
      sourceMap.set("local", {
        id: "local",
        name: "本地 Ollama",
        kind: "local",
        configured: true,
        reachable: false,
        models: [],
      });
    }
    if (![...sourceMap.values()].some((source) => source.kind === "remote")) {
      sourceMap.set("project-server", {
        id: "project-server",
        name: "项目服务器",
        kind: "remote",
        configured: false,
        reachable: false,
        models: [],
      });
    }

    const sources = [...sourceMap.values()].sort((left, right) => {
      if (left.id === "local") return -1;
      if (right.id === "local") return 1;
      return 0;
    });
    const requestedSource = String(selectedSource || "local").trim();
    const active =
      sourceMap.get(requestedSource) || sourceMap.get("local") || sources[0];
    const sourceRows = sources.map((source) => ({
      ...source,
      selected: source.id === active.id,
      statusLabel: source.reachable
        ? source.kind === "local" ? "运行中" : "已连接"
        : source.kind === "local" ? "未启动" : source.configured ? "连接不可用" : "未连接",
    }));

    if (!active.reachable) {
      return {
        mode: "source-offline",
        activeSource: active.id,
        activeSourceName: active.name,
        sourceRows,
        modelOptions: [],
        selectedModel: "",
        message: active.kind === "local"
          ? "本地 Ollama 未启动。"
          : `${active.name}尚未连接。`,
        showSourceMessage: true,
        keepAction: { visible: false, label: "加载并保持" },
        unloadAction: { visible: false, label: "卸载" },
        action: active.kind === "local"
          ? {
              label: "启动本地 Ollama",
              protocolUrl: "localreadtranslate://ollama",
            }
          : {
              label: "连接服务器",
              protocolUrl: "localreadtranslate://remote",
            },
      };
    }

    const seen = new Set();
    const discoveredModels = Array.isArray(health.available_model_options)
      ? health.available_model_options
      : [];
    const modelOptions = [];
    for (const option of discoveredModels) {
      const value = String(option && option.value || "").trim();
      const source = assistantModelSource(value, option && option.source);
      if (!value || source !== active.id || seen.has(value)) continue;
      seen.add(value);
      modelOptions.push({
        value,
        label: String(option.label || option.model || value).trim() || value,
        source,
        model: String(option.model || value).trim() || value,
      });
    }
    const requestedModel = String(selectedModel || "").trim();
    const selected = modelOptions.some((option) => option.value === requestedModel)
      ? requestedModel
      : modelOptions[0] && modelOptions[0].value || "";
    if (!selected) {
      return {
        mode: "no-model",
        activeSource: active.id,
        activeSourceName: active.name,
        sourceRows,
        modelOptions: [],
        selectedModel: "",
        message: `${active.name}没有可用于翻译的文本生成模型。`,
        showSourceMessage: true,
        keepAction: { visible: false, label: "加载并保持" },
        unloadAction: { visible: false, label: "卸载" },
        action: null,
      };
    }
    const selectedOption =
      modelOptions.find((option) => option.value === selected) || modelOptions[0];
    const modelState = active.models.find(
      (item) => item && item.value === selected
    ) || null;
    const running = Boolean(modelState && modelState.running);
    const pinned = Boolean(modelState && modelState.pinned);
    return {
      mode: "ready",
      activeSource: active.id,
      activeSourceName: active.name,
      sourceRows,
      modelOptions,
      selectedModel: selected,
      message: running
        ? `${selectedOption.model}已加载。`
        : `${selectedOption.model}可用。`,
      showSourceMessage: running || pinned,
      keepAction: {
        visible: !pinned,
        label: running ? "保持加载" : "加载并保持",
      },
      unloadAction: {
        visible: running || pinned,
        label: "卸载",
      },
      action: null,
    };
  }

  function needsReadPreparation(value) {
    const text = String(value || "");
    return (
      /[\u3400-\u9fff\uf900-\ufaff]/.test(text) ||
      summarizeLatexSelection(text).total > 0 ||
      /\[\[MATH(?:_BLOCK)?:[\s\S]*?\]\]/.test(text)
    );
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
      assistantSourceList: requiredElement(documentObject, "assistant-source-list"),
      assistantState: requiredElement(documentObject, "assistant-state"),
      sourceRail: requiredElement(documentObject, "source-rail"),
      assistantSourceMessage: requiredElement(documentObject, "assistant-source-message"),
      sourceActionSlot: requiredElement(documentObject, "source-action-slot"),
      sourceActionButton: requiredElement(documentObject, "source-action-button"),
      modelField: requiredElement(documentObject, "model-field"),
      modelSelect: requiredElement(documentObject, "model-select"),
      targetLanguage: requiredElement(documentObject, "target-language"),
      voiceSelect: requiredElement(documentObject, "voice-select"),
      speedSelect: requiredElement(documentObject, "speed-select"),
      readButton: requiredElement(documentObject, "read-button"),
      readButtonLabel: requiredElement(documentObject, "read-button-label"),
      translateButton: requiredElement(documentObject, "translate-button"),
      speechAudio: requiredElement(documentObject, "speech-audio"),
      translationResult: requiredElement(documentObject, "translation-result"),
      translationText: requiredElement(documentObject, "translation-text"),
      translationMeta: requiredElement(documentObject, "translation-meta"),
      copyTranslationButton: requiredElement(documentObject, "copy-translation-button"),
      replaceTranslationButton: requiredElement(documentObject, "replace-translation-button"),
      keepModelButton: requiredElement(documentObject, "keep-model-button"),
      unloadModelButton: requiredElement(documentObject, "unload-model-button"),
      advancedSettings: requiredElement(documentObject, "advanced-settings"),
      readSettings: requiredElement(documentObject, "read-settings"),
      operationStatus: requiredElement(documentObject, "operation-status"),
      operationMark: requiredElement(documentObject, "operation-mark"),
      operationTitle: requiredElement(documentObject, "operation-title"),
      operationDetail: requiredElement(documentObject, "operation-detail"),
    };

    let storage = options.storage;
    if (storage === undefined) {
      try {
        storage =
          root && root.window === root && root.localStorage
            ? root.localStorage
            : null;
      } catch (_error) {
        storage = null;
      }
    }
    let savedPreferences = {};
    try {
      const serialized =
        storage && typeof storage.getItem === "function"
          ? storage.getItem(ASSISTANT_SETTINGS_KEY)
          : "";
      savedPreferences = serialized ? JSON.parse(serialized) : {};
    } catch (_error) {
      savedPreferences = {};
    }
    const preferences = normalizeAssistantPreferences(savedPreferences);

    const state = {
      adapter: null,
      client: null,
      controller: options.controller,
      host: "",
      serviceReady: false,
      apiReady: false,
      ttsReady: false,
      assistantHealth: null,
      assistantHealthError: "",
      assistantView: null,
      selectedSource: preferences.translationSource,
      selectedModel: "",
      modelSelections: { ...preferences.translationModels },
      voice: preferences.voice,
      speed: preferences.speed,
      translationText: "",
      audioUrl: "",
      audioPlaying: false,
      sourceActionPending: false,
      sourceActionSource: "",
      sourceActionDeadline: 0,
      sourceActionTimer: null,
      busy: false,
    };
    elements.targetLanguage.value = preferences.targetLanguage;
    const createObjectUrl =
      options.createObjectUrl ||
      (root && root.URL && typeof root.URL.createObjectURL === "function"
        ? root.URL.createObjectURL.bind(root.URL)
        : null);
    const revokeObjectUrl =
      options.revokeObjectUrl ||
      (root && root.URL && typeof root.URL.revokeObjectURL === "function"
        ? root.URL.revokeObjectURL.bind(root.URL)
        : () => undefined);
    const setTimeoutFunction =
      options.setTimeout ||
      (root && typeof root.setTimeout === "function"
        ? root.setTimeout.bind(root)
        : null);
    const clearTimeoutFunction =
      options.clearTimeout ||
      (root && typeof root.clearTimeout === "function"
        ? root.clearTimeout.bind(root)
        : () => undefined);
    const now = typeof options.now === "function" ? options.now : Date.now;

    function persistPreferences() {
      if (!storage || typeof storage.setItem !== "function") return false;
      const payload = normalizeAssistantPreferences({
        translationSource: state.selectedSource,
        translationModels: state.modelSelections,
        targetLanguage: elements.targetLanguage.value,
        voice: state.voice,
        speed: state.speed,
      });
      try {
        storage.setItem(ASSISTANT_SETTINGS_KEY, JSON.stringify(payload));
        return true;
      } catch (_error) {
        return false;
      }
    }

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
      const formulaEnabled = state.serviceReady && state.adapter && !state.busy;
      const documentReady = state.apiReady && state.adapter && !state.busy;
      elements.convertButton.disabled = !formulaEnabled;
      elements.copyButton.disabled = !formulaEnabled;
      elements.readButton.disabled = !(documentReady && state.ttsReady);
      elements.translateButton.disabled = !(
        documentReady &&
        state.assistantView &&
        state.assistantView.mode === "ready" &&
        state.selectedModel
      );
      const hasTranslation = Boolean(state.translationText);
      elements.copyTranslationButton.disabled = state.busy || !hasTranslation;
      elements.replaceTranslationButton.disabled =
        state.busy || !hasTranslation || !state.adapter;
      elements.sourceActionButton.disabled =
        state.busy || state.sourceActionPending;
      elements.modelSelect.disabled = state.busy;
      elements.targetLanguage.disabled = state.busy;
      elements.voiceSelect.disabled = state.busy;
      elements.speedSelect.disabled = state.busy;
      elements.keepModelButton.disabled =
        state.busy || elements.keepModelButton.hidden;
      elements.unloadModelButton.disabled =
        state.busy || elements.unloadModelButton.hidden;
      elements.retryButton.disabled = state.busy;
      for (const row of Array.from(elements.assistantSourceList.children || [])) {
        const choice = row && row.children && row.children[0];
        if (choice) choice.disabled = state.busy;
      }
    }

    function setBusy(value) {
      state.busy = Boolean(value);
      updateButtons();
    }

    function clearChildren(element) {
      element.textContent = "";
      if (Array.isArray(element.children)) element.children.length = 0;
    }

    function appendOption(select, value, label) {
      const option = documentObject.createElement("option");
      option.value = String(value);
      option.textContent = String(label);
      select.appendChild(option);
    }

    function renderVoiceCatalog(payload) {
      const catalog = payload && typeof payload === "object" ? payload : {};
      const voices = [];
      for (const group of Array.isArray(catalog.groups) ? catalog.groups : []) {
        const groupLabel = String(group.label_zh || group.label_en || "").trim();
        for (const voice of Array.isArray(group.voices) ? group.voices : []) {
          const id = String(voice && voice.id || "").trim();
          if (!id) continue;
          const voiceLabel = String(
            voice.label_zh || voice.label_en || id
          ).trim();
          voices.push({
            id,
            label: groupLabel ? `${groupLabel} · ${voiceLabel}` : voiceLabel,
          });
        }
      }
      const defaultVoice = String(catalog.default_voice || "").trim();
      if (defaultVoice && !voices.some((voice) => voice.id === defaultVoice)) {
        voices.unshift({ id: defaultVoice, label: defaultVoice });
      }
      clearChildren(elements.voiceSelect);
      for (const voice of voices) {
        appendOption(elements.voiceSelect, voice.id, voice.label);
      }
      state.voice =
        voices.some((voice) => voice.id === state.voice)
          ? state.voice
          : voices.some((voice) => voice.id === defaultVoice)
            ? defaultVoice
            : voices[0] && voices[0].id || "";
      elements.voiceSelect.value = state.voice;

      const speeds = Array.isArray(catalog.speeds)
        ? catalog.speeds
            .map((value) => Number(value))
            .filter((value) => Number.isFinite(value) && value > 0)
        : [];
      const defaultSpeed = Number(catalog.default_speed);
      clearChildren(elements.speedSelect);
      for (const speed of speeds) {
        appendOption(elements.speedSelect, String(speed), `${speed}×`);
      }
      state.speed = speeds.includes(state.speed)
        ? state.speed
        : speeds.includes(defaultSpeed)
          ? defaultSpeed
          : speeds[0] || 0.8;
      elements.speedSelect.value = String(state.speed);
    }

    function renderAssistantSources() {
      if (!state.apiReady) {
        state.assistantView = null;
        state.selectedModel = "";
        elements.assistantSourceList.hidden = true;
        elements.modelField.hidden = true;
        elements.assistantSourceMessage.textContent =
          state.assistantHealthError || "本地文档服务未启动。";
        elements.sourceRail.hidden = false;
        elements.assistantState.className = "settings-state offline";
        elements.assistantState.textContent = "离线";
        elements.sourceActionSlot.appendChild(elements.sourceActionButton);
        elements.sourceActionButton.hidden = false;
        elements.sourceActionButton.textContent =
          state.sourceActionPending && state.sourceActionSource === "mediator"
            ? "启动中…"
            : "启动本地服务";
        elements.sourceActionButton.dataset.protocolUrl =
          "localreadtranslate://start";
        elements.keepModelButton.hidden = true;
        elements.unloadModelButton.hidden = true;
        elements.advancedSettings.hidden = true;
        elements.readSettings.hidden = true;
        elements.translateButton.hidden = true;
        updateButtons();
        return;
      }
      if (!state.assistantHealth) {
        state.assistantView = null;
        state.selectedModel = "";
        elements.assistantSourceList.hidden = true;
        elements.modelField.hidden = true;
        elements.assistantSourceMessage.textContent =
          state.assistantHealthError || "无法发现翻译来源。";
        elements.sourceRail.hidden = false;
        elements.assistantState.className = "settings-state unavailable";
        elements.assistantState.textContent = "不可用";
        elements.sourceActionButton.hidden = true;
        elements.sourceActionButton.dataset.protocolUrl = "";
        elements.keepModelButton.hidden = true;
        elements.unloadModelButton.hidden = true;
        elements.advancedSettings.hidden = true;
        elements.readSettings.hidden = false;
        elements.translateButton.hidden = true;
        updateButtons();
        return;
      }

      const preferredModel = state.modelSelections[state.selectedSource] || "";
      const view = deriveAssistantSourceView(
        state.assistantHealth,
        state.selectedSource,
        preferredModel
      );
      state.assistantView = view;
      state.selectedSource = view.activeSource;
      state.selectedModel = view.selectedModel;
      if (view.selectedModel) {
        state.modelSelections[view.activeSource] = view.selectedModel;
      }
      elements.assistantSourceList.hidden = false;
      const stateLabels = {
        ready: "就绪",
        "source-offline": view.activeSource === "local" ? "本地离线" : "连接服务器",
        "no-model": "无模型",
      };
      elements.assistantState.className = `settings-state ${view.mode}`;
      elements.assistantState.textContent = stateLabels[view.mode] || "检查中";
      clearChildren(elements.assistantSourceList);
      for (const source of view.sourceRows) {
        const row = documentObject.createElement("div");
        row.className =
          `source-option${source.selected ? " selected" : ""}` +
          `${source.reachable ? " reachable" : ""}`;
        const choice = documentObject.createElement("button");
        choice.id = `assistant-source-${source.id}`;
        choice.type = "button";
        choice.className = "source-choice";
        choice.dataset.sourceId = source.id;
        choice.disabled = state.busy;
        choice.setAttribute("aria-pressed", source.selected ? "true" : "false");
        const marker = documentObject.createElement("span");
        marker.className = "source-marker";
        marker.setAttribute("aria-hidden", "true");
        const copy = documentObject.createElement("span");
        copy.className = "source-copy";
        const name = documentObject.createElement("span");
        name.className = "source-name";
        name.textContent = source.name;
        const status = documentObject.createElement("span");
        status.className = "source-status-label";
        status.textContent = source.statusLabel;
        copy.appendChild(name);
        copy.appendChild(status);
        choice.appendChild(marker);
        choice.appendChild(copy);
        choice.addEventListener("click", () => selectSource(source.id));
        row.appendChild(choice);
        if (source.selected && view.action) {
          elements.sourceActionButton.hidden = false;
          elements.sourceActionButton.textContent =
            state.sourceActionPending &&
            state.sourceActionSource === source.id
              ? source.kind === "local" ? "启动中…" : "正在打开…"
              : view.action.label;
          elements.sourceActionButton.dataset.protocolUrl =
            view.action.protocolUrl;
          row.appendChild(elements.sourceActionButton);
        }
        elements.assistantSourceList.appendChild(row);
      }
      elements.assistantSourceMessage.textContent = view.message;
      elements.sourceRail.hidden = !view.showSourceMessage;
      if (!view.action) {
        elements.sourceActionButton.hidden = true;
        elements.sourceActionButton.dataset.protocolUrl = "";
        elements.sourceActionSlot.appendChild(elements.sourceActionButton);
      }
      elements.modelField.hidden = view.mode !== "ready";
      elements.advancedSettings.hidden = view.mode !== "ready";
      elements.readSettings.hidden = false;
      elements.translateButton.hidden = view.mode !== "ready";
      clearChildren(elements.modelSelect);
      for (const option of view.modelOptions) {
        appendOption(elements.modelSelect, option.value, option.label);
      }
      elements.modelSelect.value = view.selectedModel;
      elements.keepModelButton.hidden = !(
        view.keepAction && view.keepAction.visible
      );
      elements.keepModelButton.textContent =
        view.keepAction && view.keepAction.label || "加载并保持";
      elements.unloadModelButton.hidden = !(
        view.unloadAction && view.unloadAction.visible
      );
      elements.unloadModelButton.textContent =
        view.unloadAction && view.unloadAction.label || "卸载";
      updateButtons();
    }

    function selectSource(sourceId) {
      const nextSource = String(sourceId || "local");
      const changed = nextSource !== state.selectedSource;
      state.selectedSource = nextSource;
      if (changed) clearTranslationResult();
      renderAssistantSources();
      persistPreferences();
      return state.assistantView;
    }

    function selectModel(model) {
      const value = String(model || "").trim();
      if (
        !state.assistantView ||
        !state.assistantView.modelOptions.some((option) => option.value === value)
      ) {
        return state.selectedModel;
      }
      const changed = value !== state.selectedModel;
      state.selectedModel = value;
      state.modelSelections[state.selectedSource] = value;
      elements.modelSelect.value = value;
      if (changed) clearTranslationResult();
      persistPreferences();
      updateButtons();
      return value;
    }

    function renderTranslationResult(payload) {
      const translated = String(
        payload && payload.translated_text || ""
      ).trim();
      state.translationText = translated;
      elements.translationResult.hidden = !translated;
      elements.translationText.textContent = translated;
      if (!translated) {
        elements.translationMeta.textContent = "";
      } else {
        const model = String(payload && payload.model || state.selectedModel);
        const elapsed = Number(payload && payload.elapsed);
        const timing = Number.isFinite(elapsed) ? ` · ${elapsed.toFixed(1)} 秒` : "";
        elements.translationMeta.textContent =
          `${state.assistantView.activeSourceName} · ${model}${timing}`;
      }
      updateButtons();
    }

    function clearTranslationResult() {
      state.translationText = "";
      elements.translationResult.hidden = true;
      elements.translationText.textContent = "";
      elements.translationMeta.textContent = "";
      updateButtons();
    }

    function invokeProtocol(url) {
      const protocolUrl = String(url || "").trim();
      if (!protocolUrl) return false;
      if (typeof options.openProtocol === "function") {
        options.openProtocol(protocolUrl);
        return true;
      }
      const link = documentObject.createElement("a");
      link.href = protocolUrl;
      link.hidden = true;
      documentObject.body.appendChild(link);
      try {
        if (typeof link.click !== "function") {
          throw new Error("当前宿主无法打开本地控制链接");
        }
        link.click();
      } finally {
        documentObject.body.removeChild(link);
      }
      return true;
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
      setService("checking", "正在发现文档、朗读与翻译能力…");
      state.serviceReady = false;
      state.apiReady = false;
      state.ttsReady = false;
      state.assistantHealth = null;
      state.assistantHealthError = "";
      updateButtons();
      const [latexResult, translationResult, voicesResult] =
        await Promise.allSettled([
          state.client.getLatexHealth(),
          state.client.getTranslateHealth(),
          state.client.getVoices(),
        ]);
      const reachable = [latexResult, translationResult, voicesResult].some(
        (result) => result.status === "fulfilled"
      );
      if (!reachable) {
        const firstError =
          latexResult.reason || translationResult.reason || voicesResult.reason;
        state.assistantHealthError =
          firstError && firstError.message
            ? firstError.message
            : "请先启动 LocalReadTranslate 本地服务。";
        setService("error", "本地翻译服务未连接", true);
        setOperation(
          "error",
          "服务离线",
          state.assistantHealthError
        );
        renderAssistantSources();
        return false;
      }

      state.apiReady = true;
      if (latexResult.status === "fulfilled") {
        const health = latexResult.value;
        state.serviceReady = Boolean(health && health.available === true);
      }
      if (translationResult.status === "fulfilled") {
        state.assistantHealth = translationResult.value;
      } else {
        state.assistantHealthError =
          translationResult.reason && translationResult.reason.message
            ? translationResult.reason.message
            : "无法发现翻译来源。";
      }
      state.ttsReady = voicesResult.status === "fulfilled";
      if (state.ttsReady) renderVoiceCatalog(voicesResult.value);
      renderAssistantSources();

      const capabilities = [];
      if (state.serviceReady) capabilities.push("公式");
      if (state.ttsReady) capabilities.push("朗读");
      if (state.assistantView && state.assistantView.mode === "ready") {
        capabilities.push("翻译");
      }
      const detail = capabilities.length
        ? `${capabilities.join("、")}可用`
        : "服务已连接，但当前能力不可用";
      const partial =
        !state.serviceReady ||
        !state.ttsReady ||
        translationResult.status !== "fulfilled";
      setService(partial ? "error" : "ready", detail, partial);
      setOperation(
        "idle",
        "准备就绪",
        "来源只在初始化或主动重试时发现；普通操作直接复用当前状态。"
      );
      updateButtons();
      return state.serviceReady;
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

    function stopSpeech(updateStatus = true) {
      if (typeof elements.speechAudio.pause === "function") {
        elements.speechAudio.pause();
      }
      elements.speechAudio.currentTime = 0;
      if (typeof elements.speechAudio.removeAttribute === "function") {
        elements.speechAudio.removeAttribute("src");
      }
      elements.speechAudio.src = "";
      if (typeof elements.speechAudio.load === "function") {
        elements.speechAudio.load();
      }
      if (state.audioUrl) revokeObjectUrl(state.audioUrl);
      state.audioUrl = "";
      state.audioPlaying = false;
      elements.readButtonLabel.textContent = "朗读选区";
      if (updateStatus) {
        setOperation("idle", "已停止朗读", "可以重新选择内容后再次朗读。");
      }
      updateButtons();
    }

    async function runAssistantAction(kind) {
      if (state.busy || !state.apiReady || !state.adapter) return null;
      if (kind === "read" && state.audioPlaying) {
        stopSpeech();
        return null;
      }
      if (
        kind === "translate" &&
        (!state.assistantView ||
          state.assistantView.mode !== "ready" ||
          !state.selectedModel)
      ) {
        return null;
      }

      setBusy(true);
      try {
        const selected = String(
          await state.adapter.readSelectionText()
        ).trim();
        if (!selected) throw new Error("请先在文档中选择一段内容。");

        if (kind === "translate") {
          setOperation(
            "working",
            "正在翻译选区",
            `${state.assistantView.activeSourceName}正在处理当前内容…`
          );
          const targetLanguage =
            String(elements.targetLanguage.value || "").trim() ||
            "Simplified Chinese";
          const result = await state.client.translate({
            text: selected,
            model: state.selectedModel,
            target_language: targetLanguage,
          });
          renderTranslationResult(result);
          setOperation(
            "success",
            "翻译完成",
            "结果可复制，或直接替换当前文档选区。"
          );
          return result;
        }

        if (!state.ttsReady) {
          throw new Error("朗读服务当前不可用；请点击“重试”。");
        }
        setOperation("working", "正在准备朗读", "清理正文与公式后生成语音…");
        let readableText = selected.replace(/\s+/g, " ").trim();
        if (state.selectedModel) {
          const prepared = await state.client.prepareRead({
            text: selected,
            model: state.selectedModel,
          });
          readableText = String(
            prepared && prepared.prepared_text || ""
          ).trim();
        } else if (needsReadPreparation(selected)) {
          const action = state.assistantView && state.assistantView.action;
          throw new Error(
            action
              ? `中文或公式朗读需要文本模型；请先${action.label}。`
              : "中文或公式朗读需要一个已发现的文本生成模型。"
          );
        }
        if (!readableText) throw new Error("没有可朗读的正文。");
        if (!createObjectUrl) {
          throw new Error("当前文档宿主不支持音频播放。");
        }
        const audioBlob = await state.client.synthesizeSpeech({
          text: readableText,
          voice: state.voice,
          speed: state.speed,
        });
        stopSpeech(false);
        state.audioUrl = createObjectUrl(audioBlob);
        elements.speechAudio.src = state.audioUrl;
        await elements.speechAudio.play();
        state.audioPlaying = true;
        elements.readButtonLabel.textContent = "停止朗读";
        setOperation(
          "success",
          "正在朗读",
          "再次点击“停止朗读”即可结束播放。"
        );
        return { text: readableText, audio: audioBlob };
      } catch (error) {
        if (Number(error && error.status || 0) === 0 && error && error.status === 0) {
          state.apiReady = false;
          state.ttsReady = false;
          state.assistantHealthError = error.message;
          renderAssistantSources();
          setService("error", "本地翻译服务已断开", true);
        }
        setOperation(
          "error",
          kind === "translate" ? "未能翻译选区" : "未能朗读选区",
          error && error.message ? error.message : "操作失败，请检查当前选区。"
        );
        throw error;
      } finally {
        setBusy(false);
      }
    }

    async function copyTranslation() {
      if (!state.translationText || state.busy) return false;
      setBusy(true);
      try {
        await options.writeClipboard(state.translationText);
        setOperation("success", "已复制译文", "剪贴板中只有当前翻译结果。");
        return true;
      } finally {
        setBusy(false);
      }
    }

    async function replaceTranslation() {
      if (!state.translationText || state.busy || !state.adapter) return false;
      setBusy(true);
      try {
        await state.adapter.replaceSelectionWithText(state.translationText);
        setOperation("success", "已替换选区", "译文已写回当前文档。");
        await refreshSelectionPreview(true);
        return true;
      } finally {
        setBusy(false);
      }
    }

    function clearSourceActionTimer() {
      if (state.sourceActionTimer !== null) {
        clearTimeoutFunction(state.sourceActionTimer);
        state.sourceActionTimer = null;
      }
    }

    function finishSourceAction(success, detail) {
      clearSourceActionTimer();
      state.sourceActionPending = false;
      state.sourceActionSource = "";
      state.sourceActionDeadline = 0;
      renderAssistantSources();
      setOperation(
        success ? "success" : "error",
        success ? "来源已就绪" : "来源尚未就绪",
        detail
      );
    }

    function scheduleSourceActionPoll(delay) {
      if (!state.sourceActionPending || !setTimeoutFunction) return false;
      clearSourceActionTimer();
      state.sourceActionTimer = setTimeoutFunction(
        () => {
          state.sourceActionTimer = null;
          return pollSourceAction();
        },
        delay
      );
      return true;
    }

    async function pollSourceAction() {
      if (!state.sourceActionPending) return false;
      const sourceId = state.sourceActionSource;
      let ready = false;
      try {
        if (sourceId === "mediator") {
          await checkService();
          ready = state.apiReady;
        } else {
          state.assistantHealth = await state.client.getTranslateHealth();
          state.assistantHealthError = "";
          renderAssistantSources();
          ready = Boolean(
            state.assistantHealth &&
            Array.isArray(state.assistantHealth.sources) &&
            state.assistantHealth.sources.some(
              (source) =>
                source &&
                String(source.id || "") === sourceId &&
                source.reachable === true
            )
          );
        }
      } catch (error) {
        state.assistantHealthError =
          error && error.message ? error.message : "无法刷新翻译来源。";
      }
      if (!state.sourceActionPending) return ready;
      if (ready) {
        finishSourceAction(
          true,
          sourceId === "mediator"
            ? "本地文档服务已连接。"
            : "来源和真实模型列表已自动刷新。"
        );
        persistPreferences();
        return true;
      }
      if (now() >= state.sourceActionDeadline) {
        finishSourceAction(
          false,
          sourceId === "local"
            ? "本地 Ollama 未能及时启动，请检查托盘提示。"
            : sourceId === "mediator"
              ? "本地文档服务未能及时启动，请检查托盘程序。"
              : "服务器仍未连接，请完成远程服务窗口后重试。"
        );
        return false;
      }
      scheduleSourceActionPoll(1000);
      return false;
    }

    function runSourceAction() {
      if (state.sourceActionPending) return false;
      const url = elements.sourceActionButton.dataset.protocolUrl;
      if (!url) return false;
      const opened = invokeProtocol(url);
      if (!opened) return false;
      state.sourceActionPending = true;
      state.sourceActionSource =
        state.apiReady && state.assistantView
          ? state.assistantView.activeSource
          : "mediator";
      state.sourceActionDeadline = now() + 120000;
      renderAssistantSources();
      setOperation(
        "working",
        "已打开本地控制",
        "正在等待来源就绪；完成操作后会自动刷新真实模型列表。"
      );
      scheduleSourceActionPoll(0);
      return true;
    }

    async function runModelAction(kind) {
      if (!state.selectedModel || state.busy || !state.apiReady) return null;
      setBusy(true);
      try {
        setOperation(
          "working",
          kind === "keep" ? "正在保持模型" : "正在卸载模型",
          `${state.assistantView.activeSourceName}正在更新模型状态…`
        );
        const result = kind === "keep"
          ? await state.client.keepModelLoaded(state.selectedModel)
          : await state.client.unloadModel(state.selectedModel);
        state.assistantHealth = await state.client.getTranslateHealth();
        renderAssistantSources();
        setOperation(
          "success",
          kind === "keep" ? "模型将保持加载" : "模型已卸载",
          "模型列表和运行状态已刷新。"
        );
        return result;
      } catch (error) {
        setOperation(
          "error",
          kind === "keep" ? "未能保持模型" : "未能卸载模型",
          error && error.message ? error.message : "模型操作失败。"
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
        persistPreferences();
      } catch (error) {
        state.serviceReady = false;
        state.apiReady = false;
        state.ttsReady = false;
        state.assistantHealthError =
          error && error.message ? error.message : "未知宿主错误";
        setService("error", "插件宿主初始化失败", false);
        renderAssistantSources();
        setOperation(
          "error",
          "无法初始化文档工作台",
          state.assistantHealthError
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
    elements.readButton.addEventListener("click", () => {
      runAssistantAction("read").catch(() => undefined);
    });
    elements.translateButton.addEventListener("click", () => {
      runAssistantAction("translate").catch(() => undefined);
    });
    elements.sourceActionButton.addEventListener("click", () => {
      try {
        runSourceAction();
      } catch (error) {
        setOperation(
          "error",
          "无法打开本地控制",
          error && error.message ? error.message : "请从托盘程序完成操作。"
        );
      }
    });
    elements.modelSelect.addEventListener("change", (event) => {
      selectModel(event && event.target && event.target.value);
    });
    elements.voiceSelect.addEventListener("change", (event) => {
      state.voice = String(event && event.target && event.target.value || "");
      persistPreferences();
    });
    elements.speedSelect.addEventListener("change", (event) => {
      const speed = Number(event && event.target && event.target.value);
      if (Number.isFinite(speed) && speed > 0) state.speed = speed;
      persistPreferences();
    });
    elements.targetLanguage.addEventListener("change", () => {
      clearTranslationResult();
      persistPreferences();
    });
    elements.copyTranslationButton.addEventListener("click", () => {
      copyTranslation().catch((error) => {
        setOperation(
          "error",
          "未能复制译文",
          error && error.message ? error.message : "剪贴板写入失败。"
        );
      });
    });
    elements.replaceTranslationButton.addEventListener("click", () => {
      replaceTranslation().catch((error) => {
        setOperation(
          "error",
          "未能替换选区",
          error && error.message ? error.message : "文档写入失败。"
        );
      });
    });
    elements.keepModelButton.addEventListener("click", () => {
      runModelAction("keep").catch(() => undefined);
    });
    elements.unloadModelButton.addEventListener("click", () => {
      runModelAction("unload").catch(() => undefined);
    });
    elements.speechAudio.addEventListener("ended", () => {
      stopSpeech(false);
      setOperation("success", "朗读完成", "可以重新选择内容后继续。");
    });
    elements.speechAudio.addEventListener("error", () => {
      if (!state.audioPlaying) return;
      stopSpeech(false);
      setOperation("error", "音频播放失败", "请重试或更换朗读声音。");
    });
    elements.retryButton.addEventListener("click", () => {
      checkService().catch(() => undefined);
    });

    return Object.freeze({
      checkService,
      copyTranslation,
      initialize,
      refreshSelectionPreview,
      runAction,
      runAssistantAction,
      runModelAction,
      runSourceAction,
      selectModel,
      selectSource,
      state,
      stopSpeech,
      replaceTranslation,
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
      throw new Error("文档工作台依赖未完整加载");
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
        if (title) title.textContent = "文档工作台启动失败";
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
    ASSISTANT_SETTINGS_KEY,
    OFFICE_JS_URL,
    bootstrapBrowser,
    createClipboardWriter,
    createTaskPaneApp,
    detectHostHint,
    deriveAssistantSourceView,
    loadOfficeRuntime,
    needsReadPreparation,
    normalizeAssistantPreferences,
    summarizeLatexSelection,
  };
});
