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
    if (value.startsWith("$$") && value.endsWith("$$")) {
      value = value.slice(2, -2);
    } else if (value.startsWith("$") && value.endsWith("$")) {
      value = value.slice(1, -1);
    } else if (
      (value.startsWith("\\(") && value.endsWith("\\)")) ||
      (value.startsWith("\\[") && value.endsWith("\\]"))
    ) {
      value = value.slice(2, -2);
    }
    return value.trim();
  }

  // Only clipboard output uses equation-editor syntax. Paragraph interchange
  // keeps its math delimiters through normalizeCopyTextWithLatex().
  function clipboardSingleFormula(text) {
    const value = normalizeDisplayMathWrappers(text)
      .replace(/[\u200B-\u200F\uFEFF]/g, "")
      .replace(/\r\n?/g, "\n")
      .trim();
    const pair = [["$$", "$$"], ["$", "$"], ["\\[", "\\]"], ["\\(", "\\)"]]
      .find(([opening]) => value.startsWith(opening));
    if (!pair) return null;
    const [opening, closing] = pair;
    let depth = 0;
    for (let index = opening.length; index < value.length; index += 1) {
      if (depth === 0 && value.startsWith(closing, index)) {
        return value.slice(index + closing.length).trim()
          ? null
          : value.slice(opening.length, index).trim();
      }
      if (value[index] === "%") {
        const newline = value.indexOf("\n", index);
        if (newline < 0) return null;
        index = newline;
      } else if (value[index] === "\\") {
        index += 1;
      } else if (value[index] === "{") {
        depth += 1;
      } else if (value[index] === "}") {
        depth -= 1;
        if (depth < 0) return null;
      }
    }
    return null;
  }

  function clipboardLatexGroupEnd(value, start) {
    let depth = 0;
    for (let index = start; index < value.length; index += 1) {
      if (value[index] === "\\") {
        index += 1;
      } else if (value[index] === "%") {
        const newline = value.indexOf("\n", index);
        if (newline < 0) return -1;
        index = newline;
      } else if (value[index] === "{") {
        depth += 1;
      } else if (value[index] === "}" && --depth === 0) {
        return index + 1;
      }
    }
    return -1;
  }

  function clipboardCompatibleMatrices(formula) {
    const fences = {
      bmatrix: ["[", "]"],
      pmatrix: ["(", ")"],
      Bmatrix: ["\\{", "\\}"],
      vmatrix: ["|", "|"],
      Vmatrix: ["\\|", "\\|"],
    };
    const rowEnvironments = new Set([
      "matrix", "bmatrix", "pmatrix", "Bmatrix", "vmatrix", "Vmatrix",
      "smallmatrix", "array", "aligned", "alignedat", "gathered", "cases",
      "split", "align", "align*", "alignat", "alignat*", "gather", "gather*",
      "eqnarray", "eqnarray*",
    ]);
    const environments = [];
    const replacements = [];
    let depth = 0;
    for (let index = 0; index < formula.length;) {
      const character = formula[index];
      if (character === "%") {
        const newline = formula.indexOf("\n", index);
        index = newline < 0 ? formula.length : newline + 1;
        continue;
      }
      if (character !== "\\") {
        if (character === "{") depth += 1;
        if (character === "}") depth -= 1;
        if (depth < 0) return formula;
        index += 1;
        continue;
      }
      const command = /^\\([A-Za-z]+|[^])/u.exec(formula.slice(index));
      if (!command) break;
      const next = index + command[0].length;
      if (/^(?:text[A-Za-z]*|mbox|hbox|vbox|operatorname)$/.test(command[1])) {
        let groupStart = next;
        let sawStar = false;
        while (groupStart < formula.length) {
          if (/\s/.test(formula[groupStart])) {
            groupStart += 1;
          } else if (formula[groupStart] === "%") {
            const newline = formula.indexOf("\n", groupStart);
            groupStart = newline < 0 ? formula.length : newline + 1;
          } else if (!sawStar && formula[groupStart] === "*") {
            sawStar = true;
            groupStart += 1;
          } else {
            break;
          }
        }
        if (formula[groupStart] === "{") {
          const groupEnd = clipboardLatexGroupEnd(formula, groupStart);
          if (groupEnd < 0) return formula;
          index = groupEnd;
          continue;
        }
      }
      if (command[1] === "verb") {
        const delimiterStart = formula[next] === "*" ? next + 1 : next;
        const delimiter = formula[delimiterStart];
        const end = delimiter && formula.indexOf(delimiter, delimiterStart + 1);
        if (end > delimiterStart) {
          index = end + 1;
          continue;
        }
      }
      const environment = /^\\(begin|end)\s*\{([A-Za-z]+\*?)\}/.exec(formula.slice(index));
      if (environment) {
        const [token, action, name] = environment;
        if (action === "begin") {
          environments.push({ name, depth, start: index, end: index + token.length });
        } else {
          const opening = environments.pop();
          if (!opening || opening.name !== name || opening.depth !== depth) return formula;
          if (Object.prototype.hasOwnProperty.call(fences, name)) {
            const [left, right] = fences[name];
            replacements.push(
              { start: opening.start, end: opening.end, text: "\\left" + left + "\\begin{matrix}" },
              { start: index, end: index + token.length, text: "\\end{matrix}\\right" + right }
            );
          }
        }
        index += token.length;
        continue;
      }
      const environmentContext = environments[environments.length - 1];
      if (command[1] === "\\" && environmentContext &&
          rowEnvironments.has(environmentContext.name) && environmentContext.depth === depth) {
        const optionStart = formula[next] === "*" ? next + 1 : next;
        // A dimensional option after a row break is spacing, not another cell.
        // Non-dimensions such as [x], literal brackets and all & cells stay intact.
        const spacing = /^\s*\[\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)\s*(?:pt|pc|in|bp|cm|mm|dd|cc|sp|ex|em|mu)\s*\]/.exec(formula.slice(optionStart));
        if (spacing) {
          replacements.push({ start: optionStart, end: optionStart + spacing[0].length, text: "" });
          index = optionStart + spacing[0].length;
          continue;
        }
      }
      index = next;
    }
    if (environments.length || depth !== 0) return formula;
    let result = formula;
    replacements.sort((a, b) => b.start - a.start).forEach(({ start, end, text }) => {
      result = result.slice(0, start) + text + result.slice(end);
    });
    return result;
  }

  function prepareLatexForClipboard(text) {
    const formula = clipboardSingleFormula(text);
    return formula === null
      ? normalizeCopyTextWithLatex(text)
      : clipboardCompatibleMatrices(normalizeLatexBarArguments(formula));
  }

  function splitLatexSegments(text) {
    const value = normalizeDisplayMathWrappers(text);
    const pattern =
      /(\$\$(?:\\[\s\S]|[^\\])*?\$\$|\\\[(?:\\(?!\])[\s\S]|[^\\])*?\\\]|\\\((?:\\(?!\))[\s\S]|[^\\])*?\\\)|\$(?:\\[^\n]|[^$\\\n])+\$)/y;
    const openings = /\$\$|\$|\\\[|\\\(/g;
    const segments = [];
    let lastIndex = 0;
    let opening;
    while ((opening = openings.exec(value)) !== null) {
      let backslashes = 0;
      for (let cursor = opening.index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
        backslashes += 1;
      }
      if (backslashes % 2) {
        // Reject literal delimiters before scanning for a close. Otherwise
        // repeated escaped prices force a full suffix scan for each dollar.
        openings.lastIndex = opening.index + 1;
        continue;
      }
      pattern.lastIndex = opening.index;
      const match = pattern.exec(value);
      if (!match) {
        openings.lastIndex = opening.index + 1;
        continue;
      }
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
      openings.lastIndex = lastIndex;
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

  function normalizeLatexBarArguments(formula) {
    const value = String(formula || "");
    const textCommands = /^(?:text(?:bf|it|rm|sf|tt|normal|up|sl|sc)?|mbox|hbox|operatorname)$/;
    const symbolCommands = /^(?:alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|varkappa|lambda|mu|nu|xi|pi|varpi|rho|varrho|sigma|varsigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Upsilon|Phi|Psi|Omega|imath|jmath|ell)$/;
    let result = "";
    let index = 0;

    function afterWhitespace(start) {
      while (start < value.length && /\s/.test(value[start])) start += 1;
      return start;
    }

    function afterTextTrivia(start) {
      let cursor = afterWhitespace(start);
      while (value[cursor] === "%") {
        const newline = value.indexOf("\n", cursor);
        if (newline < 0) return value.length;
        cursor = afterWhitespace(newline + 1);
      }
      return cursor;
    }

    function afterTextGroup(start) {
      let depth = 0;
      for (let cursor = start; cursor < value.length; cursor += 1) {
        if (value[cursor] === "\\") {
          cursor += 1;
        } else if (value[cursor] === "%") {
          const newline = value.indexOf("\n", cursor);
          if (newline < 0) return value.length;
          cursor = newline;
        } else if (value[cursor] === "{") {
          depth += 1;
        } else if (value[cursor] === "}" && --depth === 0) {
          return cursor + 1;
        }
      }
      return value.length;
    }

    while (index < value.length) {
      if (value[index] === "%") {
        const newline = value.indexOf("\n", index);
        const end = newline < 0 ? value.length : newline + 1;
        result += value.slice(index, end);
        index = end;
        continue;
      }
      if (value[index] !== "\\") {
        result += value[index++];
        continue;
      }
      const command = /^\\([A-Za-z]+|[\s\S])/.exec(value.slice(index));
      if (!command) {
        result += value[index++];
        continue;
      }
      const commandEnd = index + command[0].length;
      const argumentStart = afterWhitespace(commandEnd);

      // Verbatim delimiters are arbitrary; their contents must stay literal.
      if (command[1] === "verb") {
        const delimiterStart = commandEnd + (value[commandEnd] === "*" ? 1 : 0);
        const delimiter = value[delimiterStart];
        const close = delimiter && !/\s/.test(delimiter)
          ? value.indexOf(delimiter, delimiterStart + 1)
          : -1;
        const end = close < 0 ? value.length : close + 1;
        result += value.slice(index, end);
        index = end;
        continue;
      }

      // Text-mode contents are literal, not math arguments to rewrite.
      if (textCommands.test(command[1])) {
        const textStart = afterTextTrivia(commandEnd);
        const groupStart = value[textStart] === "*"
          ? afterTextTrivia(textStart + 1)
          : textStart;
        if (value[groupStart] === "{") {
          const groupEnd = afterTextGroup(groupStart);
          result += value.slice(index, groupEnd);
          index = groupEnd;
          continue;
        }
      }

      // WPS drops the accent from valid TeX shorthand such as \bar v.
      // Brace one unambiguous atom only; never guess a macro's arity, consume
      // a following subscript, or change an already grouped expression.
      if (command[1] === "bar") {
        const character = String.fromCodePoint(value.codePointAt(argumentStart) || 0);
        const symbol = /^\\([A-Za-z]+)/.exec(value.slice(argumentStart));
        const atom = /[\p{L}\p{N}]/u.test(character)
          ? character
          : symbol && symbolCommands.test(symbol[1]) ? symbol[0] : "";
        if (atom) {
          result += command[0] + "{" + atom + "}";
          index = argumentStart + atom.length;
          continue;
        }
      }
      result += command[0];
      index = commandEnd;
    }
    return result;
  }

  function normalizeCopyTextWithLatex(text) {
    const normalized = normalizeDisplayMathWrappers(text)
      .replace(/[\u200B-\u200F\uFEFF]/g, "")
      .replace(/\r\n?/g, "\n");
    const pieces = splitLatexSegments(normalized).map((segment) => {
      if (segment.type === "latex") {
        const formula = normalizeLatexBarArguments(stripLatexDelimiters(segment.value));
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
    prepareLatexForClipboard,
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
