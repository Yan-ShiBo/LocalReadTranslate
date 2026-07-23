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

    async function request(path, init = {}) {
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

      let payload = null;
      try {
        payload = await response.json();
      } catch (_error) {
        payload = null;
      }
      if (!response.ok) {
        const detail = String(payload && payload.detail || "");
        throw new LocalReadTranslateServiceError(
          detail || `Local service returned HTTP ${response.status}`,
          response.status,
          detail
        );
      }
      return payload;
    }

    function postJson(path, payload) {
      return request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    return Object.freeze({
      getLatexHealth() {
        return request("/document/latex/health");
      },
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
    });
  }

  return {
    LocalReadTranslateServiceError,
    createClient,
  };
});
