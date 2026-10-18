const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const { JSDOM } = require("jsdom");
const core = require("../tts-userscript.js");

const RADIUS_SOURCE = String.raw`\rho_z=\sqrt{\frac{A_z}{\pi}},`;
const RADIUS_DISPLAY = "$$\n\\rho_z=\\sqrt{\\frac{A_z}{\\pi}},\n$$";

function escapeAttribute(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function sourceFormula({
  id = "radius",
  source = RADIUS_SOURCE,
  ariaLabel = source,
  display = true,
  includeSource = true,
  layoutWrapper = "span",
} = {}) {
  const sourceAttribute = includeSource
    ? ` data-math-source="${escapeAttribute(source)}"`
    : "";
  const layoutClass = display ? "katex-display" : "katex-inline-layout";
  // Deliberately no MathML/annotation: the rendered text has lost the source
  // structure and reads rho-z = pi-A-z. The outer source must remain available.
  return `<span id="${id}" role="math"${sourceAttribute} aria-label="${escapeAttribute(ariaLabel)}" data-client-katex-layout=""${display ? ' style="display: block"' : ""}>` +
    `<${layoutWrapper} class="${layoutClass}"><span class="katex"><span class="katex-html" aria-hidden="true">` +
    `<span class="mord">ρ</span><span class="msupsub"><span id="${id}-subscript">z</span></span>=` +
    `<span class="sqrt"><span class="mfrac"><span>π</span><span>A<span>z</span></span></span></span>,` +
    `</span></span></${layoutWrapper}></span>`;
}

function createPage(t, html) {
  const dom = new JSDOM(html, {
    url: "https://selection.test/",
  });
  t.after(() => dom.window.close());
  return {
    window: dom.window,
    document: dom.window.document,
    tools: core.createSelectionTools(dom.window.document),
  };
}

function setSelection(page, range) {
  const selection = page.window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
}

function selectContents(page, selector) {
  const range = page.document.createRange();
  range.selectNodeContents(page.document.querySelector(selector));
  setSelection(page, range);
  return range;
}

function selectText(page, startSelector, startOffset, endSelector, endOffset) {
  const range = page.document.createRange();
  range.setStart(page.document.querySelector(startSelector).firstChild, startOffset);
  range.setEnd(page.document.querySelector(endSelector).firstChild, endOffset);
  setSelection(page, range);
  return range;
}

function copySelection(page) {
  // These extraction assertions deliberately retain the canonical interchange
  // format used by translation/read. The UI tests below check the clipboard.
  return core.normalizeCopyTextWithLatex(page.tools.getSelectedText());
}

function createUserscriptPage(t, html) {
  const dom = new JSDOM(html, {
    url: "https://selection.test/",
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const clipboard = [];
  const listeners = new WeakMap();
  const timers = new Map();
  let timerId = 0;
  const addEventListener = window.EventTarget.prototype.addEventListener;
  window.EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (!listeners.has(this)) listeners.set(this, new Map());
    const registered = listeners.get(this);
    if (!registered.has(type)) registered.set(type, []);
    registered.get(type).push(listener);
    return addEventListener.call(this, type, listener, options);
  };
  window.setTimeout = (callback, delay) => {
    timers.set(++timerId, { callback, delay });
    return timerId;
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.requestAnimationFrame = (callback) => callback(0);
  window.Range.prototype.getBoundingClientRect = () => ({
    left: 20, right: 120, top: 20, bottom: 40, width: 100, height: 20,
  });
  window.GM_addStyle = () => {};
  window.GM_getValue = (_key, fallback) => fallback;
  window.GM_setValue = () => {};
  window.GM_setClipboard = (text, type) => clipboard.push({ text, type });
  window.GM_xmlhttpRequest = () => {
    throw new Error("Copy must not require a local service or model");
  };
  window.console.log = () => {};
  window.eval(fs.readFileSync(path.join(__dirname, "..", "tts-userscript.js"), "utf8"));

  return {
    window,
    document: window.document,
    clipboard,
    tools: core.createSelectionTools(window.document),
    invokeUserEvent(target, type, eventTarget = target) {
      // jsdom cannot create trusted DOM events. Invoke the actual registered
      // handler with the browser's user-event contract; production guards stay.
      const callbacks = listeners.get(target)?.get(type) || [];
      assert.ok(callbacks.length, `Expected a registered ${type} handler`);
      for (const callback of callbacks) callback.call(target, {
        isTrusted: true, target: eventTarget,
        preventDefault() {}, stopPropagation() {},
      });
    },
    runTimers(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay === delay) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
  };
}

test("the Copy button prepares the reported matrix for a WPS equation editor", async (t) => {
  const source = String.raw`\begin{bmatrix} \dot{\theta}\\ \dot{\omega} \end{bmatrix} = \begin{bmatrix} \omega\\[2mm] \displaystyle\frac{g}{l}\left(\theta-\frac{\theta^3}{6}\right) +\frac{1}{ml^2}u \end{bmatrix}`;
  const expected = String.raw`\left[\begin{matrix} \dot{\theta}\\ \dot{\omega} \end{matrix}\right] = \left[\begin{matrix} \omega\\ \displaystyle\frac{g}{l}\left(\theta-\frac{\theta^3}{6}\right) +\frac{1}{ml^2}u \end{matrix}\right]`;
  const page = createUserscriptPage(t, sourceFormula({ source }));
  selectText(page, "#radius-subscript", 0, "#radius-subscript", 1);
  const canonical = copySelection(page);
  assert.ok(canonical.startsWith("$$\n"));
  assert.ok(canonical.includes(String.raw`\\[2mm]`));

  page.invokeUserEvent(page.document, "mouseup", page.document.querySelector("#radius-subscript"));
  page.runTimers(10);
  const button = page.document.querySelector(".tts-copy-btn");
  assert.ok(button, "Selecting a rendered formula should expose Copy");
  button.click();
  assert.deepEqual(page.clipboard, [], "An untrusted synthetic click must remain ignored");
  page.invokeUserEvent(button, "click");
  await Promise.resolve();

  assert.deepEqual(page.clipboard, [{ text: expected, type: "text" }]);
  assert.equal(copySelection(page), canonical);
  assert.equal(page.document.querySelector("#radius").getAttribute("data-math-source"), source);
});

test("the Copy button preserves the merged bar fix for a solitary formula", async (t) => {
  const source = String.raw`\bar v_z`;
  const page = createUserscriptPage(t, sourceFormula({ source }));
  selectContents(page, "#radius");
  assert.equal(copySelection(page), "$$\n\\bar{v}_z\n$$");
  page.invokeUserEvent(page.document, "mouseup", page.document.querySelector("#radius"));
  page.runTimers(10);
  page.invokeUserEvent(page.document.querySelector(".tts-copy-btn"), "click");
  await Promise.resolve();

  assert.deepEqual(page.clipboard, [{ text: String.raw`\bar{v}_z`, type: "text" }]);
  assert.equal(page.document.querySelector("#radius").getAttribute("data-math-source"), source);
});

for (const display of [false, true]) {
  for (const [label, wrap] of [
    ["bare", (formula) => formula],
    ["parenthesized", (formula) => String.raw`\(${formula}\)`],
    ["bracketed", (formula) => String.raw`\[${formula}\]`],
    ["inline dollars", (formula) => `$${formula}$`],
    ["display dollars", (formula) => `$$${formula}$$`],
  ]) {
    test(`Copy from ${display ? "display" : "inline"} DOM with ${label} metadata unwraps the reported sigma formula`, async (t) => {
      const formula = String.raw`\sigma_0,\sigma_1,\ldots,\sigma_m\in\Sigma[x]`;
      const source = wrap(formula);
      const page = createUserscriptPage(t, sourceFormula({ source, display }));
      selectText(page, "#radius-subscript", 0, "#radius-subscript", 1);
      page.invokeUserEvent(page.document, "mouseup", page.document.querySelector("#radius-subscript"));
      page.runTimers(10);
      const button = page.document.querySelector(".tts-copy-btn");
      assert.ok(button, "Selecting the inner glyph should expose the actual Copy button");
      page.invokeUserEvent(button, "click");
      await Promise.resolve();

      assert.deepEqual(page.clipboard, [{ text: formula, type: "text" }]);
      assert.equal(page.document.querySelector("#radius").getAttribute("data-math-source"), source);
    });
  }
}

test("Copy keeps prose and multiple wrapped metadata formulas in canonical paragraph form", async (t) => {
  const sigma = String.raw`\sigma_m\in\Sigma[x]`;
  const page = createUserscriptPage(t,
    '<p id="paragraph">设 ' +
    sourceFormula({ id: "sigma", source: String.raw`\(${sigma}\)`, display: false }) +
    "，并令 " + sourceFormula({ id: "interval", source: "$[a,b]$", display: false }) +
    "。</p>"
  );
  selectContents(page, "#paragraph");
  page.invokeUserEvent(page.document, "mouseup", page.document.querySelector("#paragraph"));
  page.runTimers(10);
  page.invokeUserEvent(page.document.querySelector(".tts-copy-btn"), "click");
  await Promise.resolve();

  const expected = `设 $${sigma}$，并令 $[a,b]$。`;
  assert.deepEqual(page.clipboard, [{ text: expected, type: "text" }]);
  assert.equal(copySelection(page), expected);
  assert.equal(page.document.querySelector("#sigma").getAttribute("data-math-source"), String.raw`\(${sigma}\)`);
  assert.equal(page.document.querySelector("#interval").getAttribute("data-math-source"), "$[a,b]$");
});

test("Copy preserves literal text spacing inside formulas while normalizing surrounding prose", async (t) => {
  const formula = String.raw`\text{keep  two spaces [ x ]}+\Sigma[x]`;
  const source = String.raw`\(${formula}\)`;
  const page = createUserscriptPage(t,
    '<p id="paragraph">Before   ' + sourceFormula({ source, display: false }) + "   after.</p>"
  );
  selectContents(page, "#paragraph");
  page.invokeUserEvent(page.document, "mouseup", page.document.querySelector("#paragraph"));
  page.runTimers(10);
  page.invokeUserEvent(page.document.querySelector(".tts-copy-btn"), "click");
  await Promise.resolve();

  const expected = `Before $${formula}$ after.`;
  assert.deepEqual(page.clipboard, [{ text: expected, type: "text" }]);
  assert.equal(copySelection(page), expected);
  assert.equal(page.document.querySelector("#radius").getAttribute("data-math-source"), source);
});

test("copying a ChatGPT HTML-only formula retains the outer LaTeX source", (t) => {
  const page = createPage(t, sourceFormula());
  selectContents(page, "#radius");

  assert.equal(copySelection(page), RADIUS_DISPLAY);
});

test("copying an inline ChatGPT bar formula braces its argument for WPS without changing prose", (t) => {
  const page = createPage(t,
    '<p id="paragraph">均值为 <span id="bar" role="math" data-math-source="\\bar v_z">' +
    '<span class="katex"><span class="katex-html" aria-hidden="true">v</span></span>' +
    '</span>，下标保持不变。</p>'
  );
  selectContents(page, "#paragraph");

  assert.equal(copySelection(page), "均值为 $\\bar{v}_z$，下标保持不变。");
  assert.equal(page.document.querySelector("#bar").getAttribute("data-math-source"), "\\bar v_z");
});

test("copying a selected glyph in a display bar formula retains the source and normalizes its argument", (t) => {
  const page = createPage(t,
    '<span id="bar" role="math" data-math-source="\\bar v" style="display: block">' +
    '<span class="katex-display"><span class="katex"><span class="katex-html" aria-hidden="true">' +
    '<span id="glyph">v</span></span></span></span></span>'
  );
  selectText(page, "#glyph", 0, "#glyph", 1);

  assert.equal(copySelection(page), "$$\n\\bar{v}\n$$");
  assert.equal(page.document.querySelector("#bar").getAttribute("data-math-source"), "\\bar v");
});

test("the captured ChatGPT formula copies as its original display LaTeX", (t) => {
  const html = fs.readFileSync(
    path.join(__dirname, "fixtures", "chatgpt-formula.html"),
    "utf8"
  );
  const page = createPage(t, html);
  selectContents(page, "#formula-block [data-math-source]");

  assert.equal(copySelection(page), RADIUS_DISPLAY);
});

test("selecting an inner character of the captured formula retains its outer source", (t) => {
  const html = fs.readFileSync(
    path.join(__dirname, "fixtures", "chatgpt-formula.html"),
    "utf8"
  );
  const page = createPage(t, html);
  selectText(page, ".katex-html .mathnormal.mtight", 0, ".katex-html .mathnormal.mtight", 1);

  assert.equal(copySelection(page), RADIUS_DISPLAY);
});

test("a layout div between a selected glyph and its source does not hide the source", (t) => {
  const page = createPage(t, sourceFormula({ layoutWrapper: "div" }));
  selectText(page, "#radius-subscript", 0, "#radius-subscript", 1);

  assert.equal(copySelection(page), RADIUS_DISPLAY);
});

test("source-bearing formulas preserve prose on both sides of a display equation", (t) => {
  const page = createPage(t,
    '<p id="paragraph">半径定义为：' + sourceFormula() + "其中 A_z 表示面积。</p>"
  );
  selectContents(page, "#paragraph");

  assert.equal(
    copySelection(page),
    "半径定义为：\n\n$$\n\\rho_z=\\sqrt{\\frac{A_z}{\\pi}},\n$$\n\n其中 A_z 表示面积。"
  );
});

test("an inline source formula stays inline inside a block paragraph", (t) => {
  const page = createPage(t,
    '<div id="paragraph">The area is ' +
    sourceFormula({ source: "A_z", display: false }) +
    " in the selected zone.</div>"
  );
  selectContents(page, "#paragraph");

  assert.equal(copySelection(page), "The area is $A_z$ in the selected zone.");
});

test("a recovered source wrapper retains the display mode of its KaTeX child", (t) => {
  const page = createPage(t, sourceFormula());
  page.document.querySelector("#radius").removeAttribute("style");
  selectContents(page, "#radius .katex-html");

  assert.equal(copySelection(page), RADIUS_DISPLAY);
});

test("an explicitly block-level source formula uses display delimiters", (t) => {
  const page = createPage(t, sourceFormula({ display: false }));
  page.document.querySelector("#radius").style.display = "block";
  selectContents(page, "#radius");

  assert.equal(copySelection(page), RADIUS_DISPLAY);
});

test("data-math-source is sufficient without a role or accessibility label", (t) => {
  const page = createPage(t, sourceFormula());
  const formula = page.document.querySelector("#radius");
  formula.removeAttribute("role");
  formula.removeAttribute("aria-label");
  selectContents(page, "#radius .katex-html");

  assert.equal(copySelection(page), RADIUS_DISPLAY);
});

test("a role=math wrapper can recover LaTeX from its own aria-label", (t) => {
  const page = createPage(t, sourceFormula({
    includeSource: false,
    ariaLabel: String.raw`\frac{x_i^2}{\sqrt[n]{y}}`,
    display: false,
  }));
  selectText(page, "#radius-subscript", 0, "#radius-subscript", 1);

  assert.equal(copySelection(page), "$\\frac{x_i^2}{\\sqrt[n]{y}}$");
});

test("explicit LaTeX source wins over a prose accessibility label and rendered glyphs", (t) => {
  const page = createPage(t, sourceFormula({ ariaLabel: "radius of zone z" }));
  selectContents(page, "#radius");

  assert.equal(copySelection(page), RADIUS_DISPLAY);
});

test("copying original source preserves spaces inside LaTeX text commands", (t) => {
  const page = createPage(t, sourceFormula({
    source: String.raw`\rho_z = \sqrt{\frac{A_z}{\pi}} \quad \text{zone z = active}`,
    ariaLabel: "A plain-language description of the radius",
  }));
  selectText(page, "#radius-subscript", 0, "#radius-subscript", 1);

  assert.equal(
    copySelection(page),
    "$$\n\\rho_z = \\sqrt{\\frac{A_z}{\\pi}} \\quad \\text{zone z = active}\n$$"
  );
});

test("an unrelated ancestor label cannot replace the selected formula source", (t) => {
  const page = createPage(t,
    '<article aria-label="An unrelated article description"><p>Outside the selection.</p>' +
    sourceFormula() +
    "<p>Also outside the selection.</p></article>"
  );
  selectText(page, "#radius-subscript", 0, "#radius-subscript", 1);

  assert.equal(copySelection(page), RADIUS_DISPLAY);
});

function adjacentFormulas() {
  return '<p id="paragraph"><span id="before">Before </span>' +
    sourceFormula({ id: "first", source: "x_i^2", display: false }) +
    ' <span id="between">and</span> ' +
    sourceFormula({ id: "second", source: String.raw`\sqrt[n]{y}`, display: false }) +
    '<span id="after"> after.</span></p>';
}

test("selecting the first of adjacent formulas does not copy its neighbor", (t) => {
  const page = createPage(t, adjacentFormulas());
  selectText(page, "#first-subscript", 0, "#first-subscript", 1);

  assert.equal(copySelection(page), "$x_i^2$");
});

test("selecting the second of adjacent formulas uses its own source", (t) => {
  const page = createPage(t, adjacentFormulas());
  selectContents(page, "#second .katex-html");

  assert.equal(copySelection(page), "$\\sqrt[n]{y}$");
});

test("a selection spanning partial formulas recovers both and retains intervening prose", (t) => {
  const page = createPage(t, adjacentFormulas());
  selectText(page, "#first-subscript", 0, "#second-subscript", 1);

  assert.equal(copySelection(page), "$x_i^2$ and $\\sqrt[n]{y}$");
});

test("selecting a paragraph with adjacent formulas includes each source exactly once", (t) => {
  const page = createPage(t, adjacentFormulas());
  selectContents(page, "#paragraph");

  assert.equal(copySelection(page), "Before $x_i^2$ and $\\sqrt[n]{y}$ after.");
});

test("selecting only prose between formulas does not acquire either formula", (t) => {
  const page = createPage(t, adjacentFormulas());
  selectText(page, "#between", 0, "#between", 3);

  assert.equal(copySelection(page), "and");
});

test("MathML without annotations still preserves fractions, roots, and subscripts", (t) => {
  const page = createPage(t,
    '<math id="mathml" display="block"><mrow>' +
    "<msub><mi>ρ</mi><mi>z</mi></msub><mo>=</mo>" +
    "<msqrt><mfrac><msub><mi>A</mi><mi>z</mi></msub><mi>π</mi></mfrac></msqrt>" +
    "<mo>,</mo></mrow></math>"
  );
  selectContents(page, "#mathml");

  assert.equal(copySelection(page), "$$\nρ_{z}=\\sqrt{\\frac{A_{z}}{π}},\n$$");
});

test("KaTeX TeX annotations remain authoritative and are not copied twice", (t) => {
  const page = createPage(t,
    '<span id="annotated" class="katex-display"><span class="katex">' +
    '<span class="katex-mathml"><math><semantics><mrow><mi>wrong</mi></mrow>' +
    '<annotation encoding="application/x-tex">\\rho_z=\\sqrt{\\frac{A_z}{\\pi}},</annotation>' +
    '</semantics></math></span><span class="katex-html" aria-hidden="true">' +
    '<span id="annotated-glyph">ρ</span>z=πAz,</span></span></span>'
  );
  selectText(page, "#annotated-glyph", 0, "#annotated-glyph", 1);

  assert.equal(copySelection(page), RADIUS_DISPLAY);
});

test("legacy source attributes still copy canonical inline LaTeX", (t) => {
  const page = createPage(t,
    '<p id="legacy">Use <span data-latex="x_i^2">not the formula source</span>.</p>'
  );
  selectContents(page, "#legacy");

  assert.equal(copySelection(page), "Use $x_i^2$.");
});

test("a role=math wrapper without source does not replace its child's legacy LaTeX", (t) => {
  const page = createPage(t,
    '<span role="math"><span id="selected" data-latex="\\frac{a}{b}">ab</span></span>'
  );
  selectContents(page, "#selected");

  assert.equal(copySelection(page), "$\\frac{a}{b}$");
});

test("an empty data-math-source wrapper does not hide its child's usable source", (t) => {
  const page = createPage(t,
    '<span data-math-source=""><span id="selected" data-latex="x_i">xi</span></span>'
  );
  selectContents(page, "#selected");

  assert.equal(copySelection(page), "$x_i$");
});

test("a source-less role=math group cannot substitute the first MathML for the selected second formula", (t) => {
  const page = createPage(t,
    '<div role="math"><math><mi>x</mi></math> + <math id="selected"><mi>y</mi></math></div>'
  );
  selectContents(page, "#selected");

  assert.equal(copySelection(page), "$y$");
});

test("a source-less role=math wrapper preserves MathJax's existing root and fraction structure", (t) => {
  const page = createPage(t,
    '<span role="math"><mjx-container display="true"><mjx-math><mjx-msqrt><mjx-mfrac>' +
    '<mjx-mi id="selected">A</mjx-mi><mjx-mi>B</mjx-mi>' +
    '</mjx-mfrac></mjx-msqrt></mjx-math></mjx-container></span>'
  );
  selectContents(page, "#selected");

  assert.equal(copySelection(page), "$$\n\\sqrt{\\frac{A}{B}}\n$$");
});

test("the generic aria-label math placeholder cannot override a child's formula source", (t) => {
  const page = createPage(t,
    '<span role="math" aria-label="math"><span id="selected" data-latex="x_i">xi</span></span>'
  );
  selectContents(page, "#selected");

  assert.equal(copySelection(page), "$x_i$");
});

test("a prose accessibility label cannot override a child's explicit LaTeX source", (t) => {
  const page = createPage(t,
    '<span role="math" aria-label="fraction a over b">' +
    '<span id="selected" data-latex="\\frac{a}{b}">ab</span></span>'
  );
  selectContents(page, "#selected");

  assert.equal(copySelection(page), "$\\frac{a}{b}$");
});

test("plain text selections keep their paragraphs without needing formula metadata", (t) => {
  const page = createPage(t, '<section id="plain"><p>First paragraph.</p><p>Second paragraph.</p></section>');
  selectContents(page, "#plain");

  assert.equal(copySelection(page), "First paragraph.\n\nSecond paragraph.");
});

test("selection tools use their own document rather than another window's selection", (t) => {
  const first = createPage(t, sourceFormula({ source: "x_i^2", display: false }));
  const second = createPage(t, sourceFormula({ source: "y_j^3", display: false }));
  selectContents(first, "#radius");
  selectContents(second, "#radius");

  assert.deepEqual([copySelection(first), copySelection(second)], ["$x_i^2$", "$y_j^3$"]);
});
