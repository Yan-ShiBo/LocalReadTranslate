(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.LocalReadTranslateReadingCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const CJK_PATTERN = /[\u3400-\u9FFF\uF900-\uFAFF]/;
  const FORMULA_PLACEHOLDER_PREFIX = "__LOCAL_READ_FORMULA_";

  function countMatches(text, pattern) {
    const matches = String(text || "").match(pattern);
    return matches ? matches.length : 0;
  }

  function cjkRatio(text) {
    const normalized = String(text || "").replace(/\s+/g, "");
    if (!normalized) return 0;
    return countMatches(
      normalized,
      /[\u3400-\u9FFF\uF900-\uFAFF]/g
    ) / normalized.length;
  }

  function normalizeDisplayMathWrappers(text) {
    return String(text || "")
      .replace(
        /\[\[MATH_BLOCK:\s*([\s\S]*?)\s*\]\]/g,
        (_match, formula) => {
          const value = String(formula || "").trim();
          return value ? `$$${value}$$` : "";
        }
      )
      .replace(
        /\[\[MATH:\s*([\s\S]*?)\s*\]\]/g,
        (_match, formula) => {
          const value = String(formula || "").trim();
          return value ? `$${value}$` : "";
        }
      );
  }

  function stripLatexDelimiters(formula) {
    let value = String(formula || "").trim();
    if (
      (value.startsWith("$$") && value.endsWith("$$")) ||
      (value.startsWith("$") && value.endsWith("$"))
    ) {
      value = value.replace(/^\$\$?/, "").replace(/\$\$?$/, "");
    } else if (
      (value.startsWith("\\(") && value.endsWith("\\)")) ||
      (value.startsWith("\\[") && value.endsWith("\\]"))
    ) {
      value = value.slice(2, -2);
    }
    return value.trim();
  }

  function splitLatexSegments(text) {
    const value = normalizeDisplayMathWrappers(text);
    const pattern =
      /(\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$[^$\n]+\$)/g;
    const segments = [];
    let lastIndex = 0;
    let match;
    while ((match = pattern.exec(value)) !== null) {
      if (match.index > lastIndex) {
        segments.push({
          type: "text",
          value: value.slice(lastIndex, match.index),
          block: false,
        });
      }
      const formula = match[0];
      segments.push({
        type: "latex",
        value: formula,
        block: formula.startsWith("$$") || formula.startsWith("\\["),
      });
      lastIndex = pattern.lastIndex;
    }
    if (lastIndex < value.length) {
      segments.push({
        type: "text",
        value: value.slice(lastIndex),
        block: false,
      });
    }
    return segments.length
      ? segments
      : [{ type: "text", value, block: false }];
  }

  function normalizeCopyTextWithLatex(text) {
    const normalized = normalizeDisplayMathWrappers(text)
      .replace(/[\u200B-\u200F\uFEFF]/g, "")
      .replace(/\r\n?/g, "\n");
    const pieces = splitLatexSegments(normalized).map((segment) => {
      if (segment.type === "latex") {
        const formula = stripLatexDelimiters(segment.value);
        if (!formula) return "";
        return segment.block
          ? `\n\n$$\n${formula}\n$$\n\n`
          : `$${formula}$`;
      }
      return String(segment.value || "")
        .split("\n")
        .map((line) => line.replace(/[ \t]+/g, " "))
        .join("\n");
    });
    return pieces.join("")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+([,.;:!?，。；：！？])/g, "$1")
      .replace(/([([{（])[ \t]+/g, "$1")
      .replace(/[ \t]+([)\]}）])/g, "$1")
      .trim();
  }

  function verbalizeSimpleFormula(formula) {
    let spoken = String(formula || "").trim();
    if (!spoken || spoken.length > 120) return "formula omitted";

    spoken = spoken
      .replace(/^(\$\$?|\s)+|(\$\$?|\s)+$/g, "")
      .replace(/^\\\(|\\\)$/g, "")
      .replace(/^\\\[|\\\]$/g, "");

    if (/\\begin|\\matrix|\\cases|\\left|\\right/.test(spoken)) {
      return "formula omitted";
    }

    spoken = spoken
      .replace(
        /\\(?:widehat|hat)\s*\{?([A-Za-z][A-Za-z0-9]*)\}?/g,
        "$1 hat"
      )
      .replace(
        /\\(?:overline|bar)\s*\{?([A-Za-z][A-Za-z0-9]*)\}?/g,
        "$1 bar"
      )
      .replace(
        /\\(?:widetilde|tilde)\s*\{?([A-Za-z][A-Za-z0-9]*)\}?/g,
        "$1 tilde"
      )
      .replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, "$1 over $2")
      .replace(/\\sqrt\{([^{}]+)\}/g, "square root of $1")
      .replace(/\\sum/g, "summation")
      .replace(/\\int/g, "integral")
      .replace(/\\alpha/g, "alpha")
      .replace(/\\beta/g, "beta")
      .replace(/\\gamma/g, "gamma")
      .replace(/\\delta/g, "delta")
      .replace(/\\lambda/g, "lambda")
      .replace(/\\mu/g, "mu")
      .replace(/\\pi/g, "pi")
      .replace(/\\theta/g, "theta")
      .replace(/\\rightarrow/g, "to")
      .replace(/\\to/g, "to")
      .replace(/\\mapsto/g, "maps to")
      .replace(/\\Rightarrow/g, "implies")
      .replace(/\^2\b/g, " squared")
      .replace(/\^3\b/g, " cubed")
      .replace(/\^\{([^{}]+)\}/g, " to the power of $1")
      .replace(/_(\w+)\b/g, " sub $1")
      .replace(/_\{([^{}]+)\}/g, " sub $1")
      .replace(
        /([A-Za-z](?: [a-z]+ [A-Za-z0-9]+)?(?: hat| bar| tilde)?)\s*\(([^()]+)\)/g,
        "$1 of $2"
      )
      .replace(/=/g, " equals ")
      .replace(/\+/g, " plus ")
      .replace(/(?<=\S)-(?=\S)/g, " minus ")
      .replace(/\*/g, " times ")
      .replace(/\//g, " over ")
      .replace(/[{}\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    if (
      !spoken ||
      spoken.length > 160 ||
      /[^\w\s.,+\-*/=()]/.test(spoken)
    ) {
      return "formula omitted";
    }
    return `formula: ${spoken}`;
  }

  function formulaPlaceholder(index) {
    return `${FORMULA_PLACEHOLDER_PREFIX}${index}__`;
  }

  function formulaFallback(formulas, body) {
    if (!formulas) return "formula omitted";
    const normalized = String(body || "").trim();
    if (!normalized) return "formula omitted";
    const index = formulas.length;
    formulas.push(normalized);
    return formulaPlaceholder(index);
  }

  function replaceFormulaDelimiters(text, formulas = null, options = {}) {
    const forcePlaceholders = Boolean(options && options.forcePlaceholders);
    const replaceFormula = (_match, body) => {
      if (forcePlaceholders) {
        return ` ${formulaFallback(formulas, body)} `;
      }
      const spoken = verbalizeSimpleFormula(body);
      return ` ${
        spoken === "formula omitted"
          ? formulaFallback(formulas, body)
          : spoken
      } `;
    };
    return String(text || "")
      .replace(/\[\[MATH:\s*([\s\S]*?)\s*\]\]/g, replaceFormula)
      .replace(/\$\$([\s\S]*?)\$\$/g, replaceFormula)
      .replace(/\\\[([\s\S]*?)\\\]/g, replaceFormula)
      .replace(/\\\(([\s\S]*?)\\\)/g, replaceFormula)
      .replace(/\$([^$\n]{2,160})\$/g, replaceFormula);
  }

  function looksLikeMathLine(line) {
    const value = String(line || "").trim();
    if (value.includes(FORMULA_PLACEHOLDER_PREFIX)) return false;
    if (value.length < 3 || value.length > 160) return false;
    if (
      /\\(?:begin|matrix|cases|left|right|frac|sqrt|sum|int|alpha|beta|gamma|delta|lambda|mu|pi|theta)\b/.test(
        value
      )
    ) {
      return true;
    }
    const mathMarks = countMatches(value, /[=^_∑Σ√∫≈≤≥÷×]/g);
    return mathMarks >= 1 && /[A-Za-z0-9]/.test(value);
  }

  function stripUnreadableReadText(text, formulas = null, options = {}) {
    const forceFormulaPlaceholders = Boolean(
      options && options.forceFormulaPlaceholders
    );
    let value = String(text || "");
    value = value
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/~~~[\s\S]*?~~~/g, " ")
      .replace(/`[^`\n]*`/g, " ")
      .replace(
        /\[([^\]\n]{1,80})\]\((?:https?:\/\/|mailto:)[^)]+\)/g,
        "$1"
      )
      .replace(/\bhttps?:\/\/\S+/gi, " ")
      .replace(/\bwww\.\S+/gi, " ")
      .replace(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g, " ")
      .replace(/\[\d+(?:,\s*\d+)*\]/g, " ")
      .replace(
        /\(\s*(?:fig|figure|table|eq|equation)\.?\s*\d+\s*\)/gi,
        " "
      );

    value = replaceFormulaDelimiters(value, formulas, {
      forcePlaceholders: forceFormulaPlaceholders,
    });

    const lines = value.split(/\r?\n/);
    const kept = [];
    for (const rawLine of lines) {
      let line = rawLine.trim();
      if (!line) {
        kept.push("");
        continue;
      }
      if (/^\s*>/.test(line) || (line.match(/\|/g) || []).length >= 2) {
        continue;
      }
      if (cjkRatio(line) >= 0.25) {
        continue;
      }
      if (looksLikeMathLine(line)) {
        const spoken = verbalizeSimpleFormula(line);
        line =
          forceFormulaPlaceholders || spoken === "formula omitted"
            ? formulaFallback(formulas, line)
            : spoken;
      }
      line = line
        .replace(/[\u3400-\u9FFF\uF900-\uFAFF]+/g, " ")
        .replace(/[•◆◇■□●○★☆※→←↑↓↔↗↘↙↖]+/g, " ")
        .replace(/[^\S\r\n]+/g, " ")
        .replace(/\s+([.,;:!?])/g, "$1")
        .trim();
      if (line) kept.push(line);
    }

    return kept
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[ \t]{2,}/g, " ")
      .trim();
  }

  function splitSpeechTextChunks(text, maxChars = 260) {
    const value = String(text || "").replace(/\s+/g, " ").trim();
    if (!value) return [];
    const sentences = value.match(/[^.!?]+[.!?]*/g) || [value];
    const chunks = [];
    let current = "";

    function pushCurrent() {
      const cleaned = current
        .replace(/^[\s,;:]+/g, "")
        .replace(/\s+([.,;:!?])/g, "$1")
        .trim();
      if (cleaned && !/[A-Za-z0-9]/.test(cleaned)) {
        current = "";
        return;
      }
      if (cleaned) chunks.push(cleaned);
      current = "";
    }

    for (const sentence of sentences) {
      const part = sentence.trim();
      if (!part) continue;
      if ((current + " " + part).trim().length <= maxChars) {
        current = (current ? `${current} ${part}` : part).trim();
        continue;
      }
      pushCurrent();
      if (part.length <= maxChars) {
        current = part;
      } else {
        const words = part.split(/\s+/);
        for (const word of words) {
          if ((current + " " + word).trim().length > maxChars) {
            pushCurrent();
          }
          current = (current ? `${current} ${word}` : word).trim();
        }
      }
    }
    pushCurrent();
    return chunks;
  }

  function splitReadTextByFormulaPlaceholders(text, formulas = []) {
    const segments = [];
    const pattern = new RegExp(
      `${FORMULA_PLACEHOLDER_PREFIX}(\\d+)__`,
      "g"
    );
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(text || "")) !== null) {
      if (match.index > lastIndex) {
        for (const chunk of splitSpeechTextChunks(
          String(text).slice(lastIndex, match.index)
        )) {
          segments.push({ type: "text", text: chunk });
        }
      }
      const index = Number.parseInt(match[1], 10);
      if (
        Number.isFinite(index) &&
        index >= 0 &&
        index < formulas.length
      ) {
        segments.push({ type: "formula", index, formula: formulas[index] });
      }
      lastIndex = pattern.lastIndex;
    }

    if (lastIndex < String(text || "").length) {
      for (const chunk of splitSpeechTextChunks(
        String(text).slice(lastIndex)
      )) {
        segments.push({ type: "text", text: chunk });
      }
    }
    return segments;
  }

  function prepareProgressiveReadPlan(text) {
    const original = String(text || "");
    const formulas = [];
    const readableText = stripUnreadableReadText(original, formulas, {
      forceFormulaPlaceholders: true,
    });
    const segments = splitReadTextByFormulaPlaceholders(
      readableText,
      formulas
    );
    return {
      text: readableText,
      formulas,
      segments,
      changed: readableText !== original.trim(),
      removedChinese:
        CJK_PATTERN.test(original) && !CJK_PATTERN.test(readableText),
      empty: segments.length === 0,
    };
  }

  function applyFormulaVerbalizations(text, verbalizations = []) {
    let result = String(text || "");
    for (let index = 0; index < verbalizations.length; index += 1) {
      const spoken =
        String(verbalizations[index] || "formula omitted").trim() ||
        "formula omitted";
      result = result.split(formulaPlaceholder(index)).join(spoken);
    }
    return result
      .replace(
        new RegExp(`${FORMULA_PLACEHOLDER_PREFIX}\\d+__`, "g"),
        "formula omitted"
      )
      .trim();
  }

  function prepareTextForReadPlan(text) {
    const original = String(text || "");
    const formulas = [];
    const readableText = stripUnreadableReadText(original, formulas);
    return {
      text: readableText,
      formulas,
      changed: readableText !== original.trim(),
      removedChinese:
        CJK_PATTERN.test(original) && !CJK_PATTERN.test(readableText),
      empty: readableText.length === 0,
    };
  }

  function prepareTextForRead(text) {
    const plan = prepareTextForReadPlan(text);
    const readableText = applyFormulaVerbalizations(
      plan.text,
      plan.formulas.map(() => "formula omitted")
    );
    return {
      ...plan,
      text: readableText,
      empty: readableText.length === 0,
    };
  }

  function fallbackFormulaSpeech(formula) {
    const spoken = verbalizeSimpleFormula(formula);
    return spoken && spoken !== "formula omitted"
      ? spoken.replace(/^formula:\s*/i, "").trim()
      : "formula omitted";
  }

  function isSmallOllamaModel(model) {
    const matches = String(model || "")
      .toLowerCase()
      .match(/(\d+(?:\.\d+)?)\s*b\b/g);
    if (!matches || matches.length === 0) return false;
    const last = matches[matches.length - 1].match(/(\d+(?:\.\d+)?)/);
    const size = last ? Number.parseFloat(last[1]) : Number.NaN;
    return Number.isFinite(size) && size <= 4.5;
  }

  function normalizeFormulaSpeech(value, formula) {
    let text = String(value || "").trim();
    if (!text || /\[\[|\]\]|\bMATH\b/i.test(text)) {
      text = fallbackFormulaSpeech(formula);
    }
    const cleaned = prepareTextForRead(text).text;
    if (cleaned && !/\[\[|\]\]|\bMATH\b/i.test(cleaned)) {
      return cleaned;
    }
    return fallbackFormulaSpeech(formula);
  }

  function shouldUseProgressiveReadPlan(sourceText, plan) {
    return Boolean(
      plan &&
      plan.formulas &&
      plan.formulas.length > 0 &&
      plan.segments &&
      plan.segments.length > 0 &&
      cjkRatio(sourceText) < 0.15
    );
  }

  function looksFormulaBearingSelection(text) {
    const value = String(text || "").trim();
    if (!value) return false;
    if (splitLatexSegments(value).some((segment) => segment.type === "latex")) {
      return true;
    }
    if (
      /\\(?:begin|frac|sqrt|sum|int|left|right|alpha|beta|gamma|theta|lambda)\b/.test(
        value
      )
    ) {
      return true;
    }
    if (
      /[=^_∑Σ√∫≈≤≥÷×±∞∂∇]|[\u2070-\u209F]/.test(value) &&
      /[A-Za-z0-9Α-Ωα-ω]/.test(value)
    ) {
      return true;
    }
    if (/\b[A-Za-z0-9]+\s*[+\-*/]\s*[A-Za-z0-9]+\b/.test(value)) {
      return true;
    }
    if (
      /^[A-Za-zΑ-Ωα-ω]$/.test(value) ||
      /^[A-Za-zΑ-Ωα-ω][A-Za-z0-9_]*\s*\([^()\r\n]{1,80}\)$/.test(value)
    ) {
      return true;
    }
    const lines = value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    return (
      lines.length >= 3 &&
      lines.filter((line) => line.length <= 12).length >= 2 &&
      /[A-Za-z0-9]/.test(value)
    );
  }

  return Object.freeze({
    applyFormulaVerbalizations,
    cjkRatio,
    fallbackFormulaSpeech,
    isSmallOllamaModel,
    looksFormulaBearingSelection,
    normalizeCopyTextWithLatex,
    normalizeDisplayMathWrappers,
    normalizeFormulaSpeech,
    prepareProgressiveReadPlan,
    prepareTextForRead,
    prepareTextForReadPlan,
    replaceFormulaDelimiters,
    shouldUseProgressiveReadPlan,
    splitLatexSegments,
    splitReadTextByFormulaPlaceholders,
    splitSpeechTextChunks,
    stripLatexDelimiters,
    stripUnreadableReadText,
    verbalizeSimpleFormula,
  });
});
