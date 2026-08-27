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
  return core.normalizeCopyTextWithLatex(page.tools.getSelectedText());
}

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
