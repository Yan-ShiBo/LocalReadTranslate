(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LocalReadTranslateClient = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  class LocalReadTranslateServiceError extends Error {
    constructor(message, status = 0, detail = "") {
      super(message);
      this.name = "LocalReadTranslateServiceError";
      this.status = status;
      this.detail = detail;
    }
  }

  function normalizedBaseUrl(value) {
    return String(value || "").replace(/\/+$/, "");
  }

  function createClient(options = {}) {
    const baseUrl = normalizedBaseUrl(options.baseUrl);
    const fetchFn =
      options.fetch ||
      (typeof fetch === "function" ? fetch.bind(globalThis) : null);
    if (!fetchFn) throw new Error("A fetch implementation is required");

    async function fetchResponse(path, init = {}) {
      let response;
      try {
        response = await fetchFn(`${baseUrl}${path}`, init);
      } catch (error) {
        throw new LocalReadTranslateServiceError(
          "Cannot connect to the local translation service",
          0,
          String(error && error.message || "")
        );
      }
      return response;
    }

    async function readJson(response) {
      let payload = null;
      try {
        payload = await response.json();
      } catch (_error) {
        payload = null;
      }
      return payload;
    }

    function serviceError(response, payload) {
      const detail = String(payload && payload.detail || "");
      return new LocalReadTranslateServiceError(
        detail || `Local service returned HTTP ${response.status}`,
        response.status,
        detail
      );
    }

    async function requestJson(path, init = {}) {
      const response = await fetchResponse(path, init);
      const payload = await readJson(response);
      if (!response.ok) {
        throw serviceError(response, payload);
      }
      return payload;
    }

    async function requestBlob(path, init = {}) {
      const response = await fetchResponse(path, init);
      if (!response.ok) {
        const payload = await readJson(response);
        const detail = String(payload && payload.detail || "");
        throw serviceError(response, detail ? { detail } : payload);
      }
      return response.blob();
    }

    function postJson(path, payload) {
      return requestJson(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    function openControlAction(action) {
      const normalized = String(action || "").trim();
      if (!["start", "ollama", "remote"].includes(normalized)) {
        return Promise.reject(new Error("Unsupported local control action"));
      }
      return requestJson(`/control/${normalized}`, {
        method: "POST",
        headers: { "X-LocalReadTranslate-Addin": "1" },
      });
    }

    return Object.freeze({
      getLatexHealth() {
        return requestJson("/document/latex/health");
      },
      getTranslateHealth() {
        return requestJson("/translate/health");
      },
      getVoices() {
        return requestJson("/voices");
      },
      openControlAction,
      createLatexFragment(text) {
        return postJson("/document/latex-fragment", {
          text: String(text || ""),
        });
      },
      nativeToLatex(source) {
        if (!source || !source.source_format || !source.content) {
          return Promise.reject(
            new Error("Native formula source content is required")
          );
        }
        return postJson("/document/native-to-latex", {
          source_format: source.source_format,
          content: source.content,
        });
      },
      recognizePdfSelection(text, model) {
        const selectedText = String(text || "").trim();
        const selectedModel = String(model || "").trim();
        if (!selectedText) {
          return Promise.reject(new Error("A WPS PDF selection is required"));
        }
        if (!selectedModel) {
          return Promise.reject(new Error("A discovered formula recognition model is required"));
        }
        return postJson("/document/pdf-selection-to-latex", {
          text: selectedText,
          html: "",
          model: selectedModel,
        });
      },
      translate(payload) {
        return postJson("/translate", payload || {});
      },
      prepareRead(payload) {
        return postJson("/read/prepare", payload || {});
      },
      verbalizeFormulas(payload) {
        const formulas = payload && Array.isArray(payload.formulas)
          ? payload.formulas.map((formula) => String(formula || "").trim())
            .filter(Boolean)
          : [];
        const model = String(payload && payload.model || "").trim();
        if (!formulas.length) return Promise.resolve({ verbalizations: [] });
        if (!model) {
          return Promise.reject(
            new Error("A discovered formula verbalization model is required")
          );
        }
        return postJson("/formula/verbalize", {
          formulas,
          context: String(payload && payload.context || "").slice(0, 4000),
          model,
        });
      },
      keepModelLoaded(model, keepAlive = -1) {
        return postJson("/translate/model/keepalive", {
          model: String(model || ""),
          keep_alive: keepAlive,
        });
      },
      unloadModel(model) {
        return postJson("/translate/model/unload", {
          model: String(model || ""),
        });
      },
      synthesizeSpeech(payload) {
        return requestBlob("/tts", {
          method: "POST",
          headers: {
            Accept: "audio/wav",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload || {}),
        });
      },
    });
  }

  return {
    LocalReadTranslateServiceError,
    createClient,
  };
});
