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

function createUserscriptPage(t, html, options = {}) {
  const dom = new JSDOM(html, {
    url: "https://selection.test/",
    runScripts: "outside-only",
  });
  t.after(() => dom.window.close());
  const { window } = dom;
  const clipboard = [];
  const nativeWrites = [];
  const gmClipboardCalls = [];
  const frameCopyCalls = [];
  const clipboardFrames = [];
  const clipboardFrameListeners = new Map();
  const instrumentedFrameDocuments = new WeakSet();
  let activatedClipboardFrames = new Set();
  const hostCopyEvents = [];
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
  window.GM_setClipboard = (text, type) => {
    gmClipboardCalls.push({ text, type });
    clipboard.push({ text, type });
  };
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true });
  Object.defineProperty(window.navigator, "clipboard", {
    configurable: true,
    value: options.nativeClipboard === false ? undefined : {
      writeText(text) {
        nativeWrites.push(text);
        if (typeof options.nativeClipboard === "function") {
          return options.nativeClipboard(text, clipboard);
        }
        clipboard.push({ text, type: "text" });
        return Promise.resolve();
      },
    },
  });
  if (options.hostileCopy) {
    // Installed before the userscript, as in the isolated-browser reproduction. A
    // parent-document copy event would gain unwanted display delimiters.
    window.addEventListener("copy", (event) => {
      hostCopyEvents.push(event);
      event.clipboardData?.setData("text/plain", String.raw`\[ hijacked \]`);
      event.preventDefault();
      event.stopImmediatePropagation();
    }, true);
  }
  const appendChild = window.Node.prototype.appendChild;
  window.Node.prototype.appendChild = function (node) {
    const result = appendChild.call(this, node);
    const frames = [node, ...Array.from(node.querySelectorAll?.("iframe") || [])];
    for (const frame of frames) {
      if (frame.tagName !== "IFRAME" || !frame.contentDocument || instrumentedFrameDocuments.has(frame.contentDocument)) continue;
      if (!clipboardFrames.includes(frame)) clipboardFrames.push(frame);
      const frameDocument = frame.contentDocument;
      instrumentedFrameDocuments.add(frameDocument);
      const copyListeners = new Map();
      clipboardFrameListeners.set(frame, copyListeners);
      const frameAddListener = frameDocument.addEventListener;
      const frameRemoveListener = frameDocument.removeEventListener;
      frameDocument.addEventListener = function (type, callback, eventOptions) {
        if (type === "copy") copyListeners.set(callback, eventOptions);
        return frameAddListener.call(this, type, callback, eventOptions);
      };
      frameDocument.removeEventListener = function (type, callback, eventOptions) {
        if (type === "copy") copyListeners.delete(callback);
        return frameRemoveListener.call(this, type, callback, eventOptions);
      };
      frameDocument.execCommand = (command) => {
        frameCopyCalls.push(command);
        // Match Chrome: a frame created after this user click begins has no
        // inherited transient activation, even when its parent has activation.
        if (!activatedClipboardFrames.has(frame)) return false;
        if (options.clearHostSelection) window.getSelection().removeAllRanges();
        if (options.frameCopyMode === "throw") throw new Error("Copy is blocked");
        if (options.frameCopyMode !== "no-event") {
          const data = new Map();
          const event = new frame.contentWindow.Event("copy", { bubbles: true, cancelable: true });
          Object.defineProperty(event, "clipboardData", {
            value: {
              setData(type, value) { data.set(type, value); },
              getData(type) { return data.get(type) || ""; },
              clearData() { data.clear(); },
            },
          });
          (frameDocument.activeElement || frameDocument).dispatchEvent(event);
          for (const [callback, eventOptions] of copyListeners) {
            if (eventOptions?.once) copyListeners.delete(callback);
          }
          if (data.has("text/plain")) {
            // Chrome commits the system clipboard later; destroying the frame
            // before that task loses the pending write, despite execCommand=true.
            window.setTimeout(() => {
              if (frame.isConnected) clipboard.push({ text: data.get("text/plain"), type: "text" });
            }, 0);
          }
        }
        return options.frameCopyMode !== "false";
      };
    }
    return result;
  };
  window.GM_xmlhttpRequest = () => {
    throw new Error("Copy must not require a local service or model");
  };
  window.console.log = () => {};
  window.console.warn = () => {};
  window.eval(fs.readFileSync(path.join(__dirname, "..", "tts-userscript.js"), "utf8"));

  return {
    window,
    document: window.document,
    clipboard,
    nativeWrites,
    gmClipboardCalls,
    frameCopyCalls,
    clipboardFrames,
    clipboardFrameListeners,
    hostCopyEvents,
    tools: core.createSelectionTools(window.document),
    invokeUserEvent(target, type, eventTarget = target) {
      // jsdom cannot create trusted DOM events. Invoke the actual registered
      // handler with the browser's user-event contract; production guards stay.
      const callbacks = listeners.get(target)?.get(type) || [];
      assert.ok(callbacks.length, `Expected a registered ${type} handler`);
      if (type === "click") {
        activatedClipboardFrames = new Set(clipboardFrames.filter((frame) => frame.isConnected));
      }
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

const BARRIER_FORMULA = String.raw`B(x,\mathbf b)=\sum_{|\alpha|\le d_B}b_\alpha x^\alpha.`;
const BARRIER_CLIPBOARD = String.raw`B(x,\mathbf{b})=\sum_{|\alpha|\le d_B}b_\alpha x^\alpha.`;
// The first base is the exact visible KaTeX fragment supplied by the user.
// It contains only the left side: a full equation can have several bases.
const BARRIER_BASE = '<span class="base"><span class="strut" style="height: 1em; vertical-align: -0.25em;"></span><span class="mord mathnormal" style="margin-right: 0.0502em;">B</span><span class="mopen">(</span><span class="mord mathnormal">x</span><span class="mpunct">,</span><span class="mspace" style="margin-right: 0.1667em;"></span><span class="mord mathbf">b</span><span class="mclose">)</span><span class="mspace" style="margin-right: 0.2778em;"></span><span class="mrel">=</span><span class="mspace" style="margin-right: 0.2778em;"></span></span>';
const POLYNOMIAL_BASE = '<span class="base"><span class="strut" style="height: 1em; vertical-align: -0.25em;"></span><span class="mord mathnormal">p</span><span class="mopen">(</span><span class="mord mathnormal">x</span><span class="mclose">)</span></span>';

function reportedKatexFormula({ source, metadata, bases }) {
  const annotation = metadata === "annotation"
    ? '<span class="katex-mathml"><math><semantics><mrow><mi>not the source</mi></mrow>' +
      `<annotation encoding="application/x-tex">${escapeAttribute(source)}</annotation>` +
      '</semantics></math></span>'
    : "";
  const attribute = metadata === "annotation" ? "" :
    ` ${metadata}="${escapeAttribute(source)}"`;
  return `<span id="reported-formula" role="math"${attribute}>` +
    `<span class="katex-display"><span class="katex">${annotation}` +
    `<span class="katex-html" aria-hidden="true">${bases}</span></span></span></span>`;
}

async function clickSelectedFormulaCopy(page, selectedElement) {
  page.invokeUserEvent(page.document, "mouseup", selectedElement);
  page.runTimers(10);
  const button = page.document.querySelector(".tts-copy-btn");
  assert.ok(button, "The rendered selection should expose the floating Copy button");
  page.invokeUserEvent(button, "click");
  await Promise.resolve();
}

async function settleClipboardUi(page) {
  // Native writes and a rejected-write fallback each add Promise continuations.
  for (let index = 0; index < 8; index += 1) {
    await Promise.resolve();
    page.runTimers(0);
  }
}

function clipboardTestPage(t, options = {}) {
  const page = createUserscriptPage(t,
    '<button id="prior-focus">Keep focus here</button>' + sourceFormula({ source: BARRIER_FORMULA }),
    options
  );
  page.document.querySelector("#prior-focus").focus();
  selectText(page, "#radius-subscript", 0, "#radius-subscript", 1);
  const selection = page.window.getSelection();
  page.originalRange = selection.getRangeAt(0).cloneRange();
  return page;
}

function assertClipboardFallbackCleanedUp(page) {
  assert.ok(page.clipboardFrames.length, "The fallback should use its own iframe document");
  assert.equal(page.clipboardFrames.length, 1, "The toolbar should reuse its pre-existing frame");
  const frame = page.clipboardFrames[0];
  assert.equal(frame.isConnected, true, "Keep the frame alive for the system clipboard commit");
  assert.equal(frame.closest(".tts-float-container"), page.document.querySelector(".tts-float-container"));
  assert.equal(frame.contentDocument.querySelectorAll("textarea").length, 0);
  assert.equal(page.clipboardFrameListeners.get(frame).size, 0, "No copy listener may retain the old clipboard text");
  assert.equal(page.document.querySelectorAll("textarea").length, 0);
  assert.equal(page.document.activeElement.id, "prior-focus");
  const selection = page.window.getSelection();
  assert.equal(selection.rangeCount, 1, "The original page selection must be restored");
  const range = selection.getRangeAt(0);
  assert.equal(range.startContainer, page.originalRange.startContainer);
  assert.equal(range.endContainer, page.originalRange.endContainer);
  assert.equal(range.startOffset, page.originalRange.startOffset);
  assert.equal(range.endOffset, page.originalRange.endOffset);
}

function closeClipboardToolbar(page) {
  page.invokeUserEvent(page.document, "mousedown", page.document.querySelector("#prior-focus"));
  page.runTimers(150);
  assert.equal(page.document.querySelector(".tts-float-container"), null);
  assert.equal(page.document.querySelectorAll(".tts-clipboard-frame").length, 0);
  assert.ok(page.clipboardFrames.every((frame) => !frame.isConnected));
}

test("floating Copy prefers native clipboard writes and bypasses an earlier host copy interceptor", async (t) => {
  const page = clipboardTestPage(t, { hostileCopy: true });
  await clickSelectedFormulaCopy(page, page.document.querySelector("#radius-subscript"));
  await settleClipboardUi(page);

  assert.deepEqual(page.nativeWrites, [BARRIER_CLIPBOARD]);
  assert.deepEqual(page.gmClipboardCalls, []);
  assert.deepEqual(page.clipboard, [{ text: BARRIER_CLIPBOARD, type: "text" }]);
  assert.deepEqual(page.hostCopyEvents, []);
  assert.equal(page.clipboardFrames.length, 1);
  assert.equal(page.clipboardFrames[0].contentDocument.querySelectorAll("textarea").length, 0);
  assert.equal(page.clipboardFrameListeners.get(page.clipboardFrames[0]).size, 0);
  assert.match(page.document.querySelector(".tts-copy-btn").textContent, /Copied/);
  closeClipboardToolbar(page);
});

test("floating Copy waits for the native clipboard promise before reporting Copied", async (t) => {
  let resolveWrite;
  const pendingWrite = new Promise((resolve) => { resolveWrite = resolve; });
  const page = clipboardTestPage(t, {
    nativeClipboard: (text, clipboard) => pendingWrite.then(() => {
      clipboard.push({ text, type: "text" });
    }),
  });
  await clickSelectedFormulaCopy(page, page.document.querySelector("#radius-subscript"));
  const button = page.document.querySelector(".tts-copy-btn");
  assert.deepEqual(page.nativeWrites, [BARRIER_CLIPBOARD]);
  assert.deepEqual(page.clipboard, []);
  assert.match(button.textContent, /Copying/);
  assert.equal(button.classList.contains("done"), false);

  resolveWrite();
  await settleClipboardUi(page);
  assert.deepEqual(page.clipboard, [{ text: BARRIER_CLIPBOARD, type: "text" }]);
  assert.match(button.textContent, /Copied/);
  assert.deepEqual(page.gmClipboardCalls, []);
});

for (const native of ["missing", "rejected"]) {
  test(`floating Copy uses an isolated iframe when native clipboard is ${native}`, async (t) => {
    const page = clipboardTestPage(t, {
      nativeClipboard: native === "missing" ? false : () => Promise.reject(new Error("Permission denied")),
      hostileCopy: true,
      clearHostSelection: true,
    });
    await clickSelectedFormulaCopy(page, page.document.querySelector("#radius-subscript"));
    await settleClipboardUi(page);

    assert.deepEqual(page.nativeWrites, native === "missing" ? [] : [BARRIER_CLIPBOARD]);
    assert.deepEqual(page.gmClipboardCalls, []);
    assert.deepEqual(page.frameCopyCalls, ["copy"]);
    assert.deepEqual(page.hostCopyEvents, [], "The fallback must not dispatch copy in the host document");
    assert.deepEqual(page.clipboard, [{ text: BARRIER_CLIPBOARD, type: "text" }]);
    assert.match(page.document.querySelector(".tts-copy-btn").textContent, /Copied/);
    assertClipboardFallbackCleanedUp(page);
    closeClipboardToolbar(page);
  });
}

test("iframe Copy waits for the clipboard commit task and reuses the live toolbar frame", async (t) => {
  const page = clipboardTestPage(t, { nativeClipboard: false, hostileCopy: true });
  await clickSelectedFormulaCopy(page, page.document.querySelector("#radius-subscript"));
  const button = page.document.querySelector(".tts-copy-btn");
  const frame = page.clipboardFrames[0];
  assert.ok(frame?.isConnected, "The activated frame must stay alive through clipboard commit");
  assert.deepEqual(page.clipboard, [], "The modeled system write has not committed yet");
  assert.match(button.textContent, /Copying/);

  await settleClipboardUi(page);
  assert.deepEqual(page.clipboard, [{ text: BARRIER_CLIPBOARD, type: "text" }]);
  assert.match(button.textContent, /Copied/);
  assertClipboardFallbackCleanedUp(page);

  page.invokeUserEvent(button, "click");
  await settleClipboardUi(page);
  assert.equal(page.clipboardFrames.length, 1);
  assert.equal(page.clipboardFrames[0], frame);
  assert.deepEqual(page.clipboard, [
    { text: BARRIER_CLIPBOARD, type: "text" },
    { text: BARRIER_CLIPBOARD, type: "text" },
  ]);
  assert.deepEqual(page.hostCopyEvents, []);
  assertClipboardFallbackCleanedUp(page);
  closeClipboardToolbar(page);
});

for (const frameCopyMode of ["false", "no-event", "throw"]) {
  test(`floating Copy reports Failed and restores the page when iframe copy returns ${frameCopyMode}`, async (t) => {
    const page = clipboardTestPage(t, {
      nativeClipboard: false,
      hostileCopy: true,
      clearHostSelection: true,
      frameCopyMode,
    });
    await clickSelectedFormulaCopy(page, page.document.querySelector("#radius-subscript"));
    await settleClipboardUi(page);

    const button = page.document.querySelector(".tts-copy-btn");
    assert.match(button.textContent, /Failed/);
    assert.equal(button.classList.contains("error"), true);
    assert.equal(button.classList.contains("done"), false);
    assert.deepEqual(page.frameCopyCalls, ["copy"]);
    assert.deepEqual(page.gmClipboardCalls, []);
    assert.deepEqual(page.hostCopyEvents, []);
    assertClipboardFallbackCleanedUp(page);
    closeClipboardToolbar(page);
  });
}

for (const metadata of ["data-math-source", "aria-label", "annotation"]) {
  for (const selection of ["left base", "right base", "partial glyph", "across bases"]) {
    test(`floating Copy unwraps the reported display barrier from ${metadata} when selecting ${selection}`, async (t) => {
      const source = String.raw`\[ ${BARRIER_FORMULA} \]`;
      const page = createUserscriptPage(t, reportedKatexFormula({
        source, metadata,
        bases: BARRIER_BASE + '<span class="base"><span class="mop">∑</span><span class="mord mathnormal">b</span><span class="mord mathnormal">x</span><span class="mpunct">.</span></span>',
      }));
      const before = page.document.querySelector("#reported-formula").outerHTML;
      const left = ".katex-html .base:first-child";
      const right = ".katex-html .base:last-child";
      if (selection === "left base") selectContents(page, left);
      if (selection === "right base") selectContents(page, right);
      if (selection === "partial glyph") selectText(page, `${left} .mathnormal`, 0, `${left} .mathnormal`, 1);
      if (selection === "across bases") selectText(page, `${left} .mathnormal`, 0, `${right} .mpunct`, 1);
      await clickSelectedFormulaCopy(page, page.document.querySelector(left));

      assert.deepEqual(page.clipboard, [{ text: BARRIER_CLIPBOARD, type: "text" }]);
      assert.equal(page.document.querySelector("#reported-formula").outerHTML, before);
    });
  }

  test(`floating Copy preserves the real p(x) parentheses in the reported base with ${metadata}`, async (t) => {
    const page = createUserscriptPage(t, reportedKatexFormula({
      source: String.raw`\(p(x)\)`, metadata, bases: POLYNOMIAL_BASE,
    }));
    selectText(page, ".katex-html .base .mathnormal", 0, ".katex-html .base .mathnormal", 1);
    await clickSelectedFormulaCopy(page, page.document.querySelector(".base"));

    assert.deepEqual(page.clipboard, [{ text: "p(x)", type: "text" }]);
  });
}

for (const selection of [
  "outer component", "display container", "complete KaTeX", "visible HTML",
  "left base", "right base", "partial left glyph", "partial summation limit",
  "across bases", "hidden MathML",
]) {
  test(`floating Copy from the exact reported DeepSeek DOM produces one unwrapped formula: ${selection}`, async (t) => {
    const html = fs.readFileSync(
      path.join(__dirname, "fixtures", "reported-deepseek-barrier.html"), "utf8"
    );
    const page = createUserscriptPage(t, html);
    const component = page.document.querySelector('[data-d-component="math"]');
    const before = component.outerHTML;
    assert.equal(component.querySelector('annotation[encoding="application/x-tex"]').textContent, BARRIER_FORMULA);
    const left = ".katex-html > .base:first-child";
    const right = ".katex-html > .base:last-child";
    const containers = {
      "outer component": '[data-d-component="math"]',
      "display container": ".katex-display",
      "complete KaTeX": ".katex",
      "visible HTML": ".katex-html",
      "left base": left,
      "right base": right,
      "hidden MathML": ".katex-mathml math",
    };
    if (containers[selection]) selectContents(page, containers[selection]);
    if (selection === "partial left glyph") {
      selectText(page, `${left} .mathnormal`, 0, `${left} .mathnormal`, 1);
    }
    if (selection === "partial summation limit") {
      selectText(page, `${right} .mop .mathnormal`, 0, `${right} .mop .mathnormal`, 1);
    }
    if (selection === "across bases") {
      selectText(page, `${left} .mathnormal`, 0, `${right} > .mord:last-child`, 1);
    }
    await clickSelectedFormulaCopy(page, component);

    assert.deepEqual(page.clipboard, [{ text: BARRIER_CLIPBOARD, type: "text" }]);
    assert.equal(copySelection(page), `$$\n${BARRIER_FORMULA}\n$$`);
    assert.equal(component.outerHTML, before, "Copy must not rewrite the captured page DOM");
  });
}

const LIE_DERIVATIVE_FORMULA = String.raw`\mathcal L_{F_p}B` + "\n" + String.raw`=\nabla B(x,\mathbf b)^\top f(x,p(x)).`;
const LIE_DERIVATIVE_CLIPBOARD = String.raw`\mathcal{L}_{F_p}B =\nabla B(x,\mathbf{b})^\top f(x,p(x)).`;

for (const selection of ["outer component", "visible HTML", "left base", "right base", "calligraphic L", "transpose glyph"]) {
  test(`floating Copy preserves the exact reported Lie derivative commands: ${selection}`, async (t) => {
    const html = fs.readFileSync(
      path.join(__dirname, "fixtures", "reported-deepseek-lie-derivative.html"), "utf8"
    );
    const page = createUserscriptPage(t, html);
    const component = page.document.querySelector('[data-d-component="math"]');
    const before = component.outerHTML;
    const annotation = component.querySelector('annotation[encoding="application/x-tex"]').textContent;
    assert.equal(annotation, LIE_DERIVATIVE_FORMULA);
    const containers = {
      "outer component": '[data-d-component="math"]',
      "visible HTML": ".katex-html",
      "left base": ".katex-html > .base:first-child",
      "right base": ".katex-html > .base:last-child",
    };
    if (containers[selection]) selectContents(page, containers[selection]);
    if (selection === "calligraphic L") selectText(page, ".katex-html .mathcal", 0, ".katex-html .mathcal", 1);
    if (selection === "transpose glyph") {
      const transpose = ".katex-html > .base:last-child .msupsub .mord.mtight";
      selectText(page, transpose, 0, transpose, 1);
    }
    await clickSelectedFormulaCopy(page, component);

    assert.deepEqual(page.clipboard, [{ text: LIE_DERIVATIVE_CLIPBOARD, type: "text" }]);
    assert.doesNotMatch(page.clipboard[0].text, /[\r\n]/, "One formula must paste into one WPS equation box");
    const canonical = copySelection(page);
    assert.equal(canonical, `$$\n${LIE_DERIVATIVE_FORMULA}\n$$`);
    assert.ok(canonical.includes(String.raw`\mathcal L`), "Canonical data must retain the original calligraphic command");
    assert.ok(canonical.includes(String.raw`\mathbf b`), "Canonical data must retain the original bold command");
    assert.ok(canonical.includes(String.raw`^\top`), "Transpose is not an arrow command followed by p");
    assert.equal(component.outerHTML, before);
  });
}

test("the multiline Lie derivative also reaches the isolated clipboard fallback as one physical line", async (t) => {
  const html = fs.readFileSync(
    path.join(__dirname, "fixtures", "reported-deepseek-lie-derivative.html"), "utf8"
  );
  const page = createUserscriptPage(t, html, {
    nativeClipboard: () => Promise.reject(new Error("Permission denied")),
    hostileCopy: true,
  });
  const component = page.document.querySelector('[data-d-component="math"]');
  const before = component.outerHTML;
  selectContents(page, ".katex-html");
  await clickSelectedFormulaCopy(page, component);
  await settleClipboardUi(page);

  assert.deepEqual(page.nativeWrites, [LIE_DERIVATIVE_CLIPBOARD]);
  assert.deepEqual(page.frameCopyCalls, ["copy"]);
  assert.deepEqual(page.hostCopyEvents, []);
  assert.deepEqual(page.clipboard, [{ text: LIE_DERIVATIVE_CLIPBOARD, type: "text" }]);
  assert.doesNotMatch(page.clipboard[0].text, /[\r\n]/);
  assert.equal(copySelection(page), `$$\n${LIE_DERIVATIVE_FORMULA}\n$$`);
  assert.equal(component.outerHTML, before);
});

for (const [label, formula] of [
  ["transpose", String.raw`A^\top`],
  ["to arrow", String.raw`a \to b`],
  ["right arrow", String.raw`a \rightarrow b`],
  ["double right arrow", String.raw`a \Rightarrow b`],
  ["maps-to arrow", String.raw`a \mapsto b`],
]) {
  test(`annotation extraction and floating Copy preserve ${label} semantics`, async (t) => {
    const page = createUserscriptPage(t, reportedKatexFormula({
      source: formula,
      metadata: "annotation",
      bases: '<span class="base"><span class="mord">x</span></span>',
    }));
    selectContents(page, ".katex-html .base");
    await clickSelectedFormulaCopy(page, page.document.querySelector(".base"));

    assert.deepEqual(page.clipboard, [{ text: formula, type: "text" }]);
    assert.equal(copySelection(page), `$$\n${formula}\n$$`);
  });
}

test("annotation command names are not truncated at an arrow-command prefix", async (t) => {
  const formula = String.raw`a \rightarrowtail b`;
  const page = createUserscriptPage(t, reportedKatexFormula({
    source: formula,
    metadata: "annotation",
    bases: '<span class="base"><span class="mord">x</span></span>',
  }));
  selectContents(page, ".katex-html .base");
  await clickSelectedFormulaCopy(page, page.document.querySelector(".base"));

  assert.equal(copySelection(page), `$$\n${formula}\n$$`);
  assert.deepEqual(page.clipboard, [{ text: formula, type: "text" }]);
});

test("MathML arrows without annotations retain distinct right, double-right, and maps-to semantics", async (t) => {
  const formula = String.raw`a \to b \Rightarrow c \mapsto d`;
  const page = createUserscriptPage(t,
    '<math id="arrows" display="block"><mrow>' +
    '<mi>a</mi><mo>→</mo><mi>b</mi><mo>⇒</mo><mi>c</mi><mo>↦</mo><mi>d</mi>' +
    '</mrow></math>'
  );
  selectContents(page, "#arrows");
  await clickSelectedFormulaCopy(page, page.document.querySelector("#arrows"));

  assert.equal(copySelection(page), `$$\n${formula}\n$$`);
  assert.deepEqual(page.clipboard, [{ text: formula, type: "text" }]);
});

for (const metadata of ["data-math-source", "data-latex", "data-tex", "data-math", "data-mathml", "aria-label", "annotation", "script"]) {
  test(`${metadata} retains source command names, comment newline, and literal text spacing`, async (t) => {
    const source = String.raw`\mathcal L + \text{two  spaces} % keep this comment` + "\n" +
      String.raw`+\mathbf b^\top\quad x\mapsto y\Rightarrow z`;
    const clipboard = String.raw`\mathcal{L} + \text{two  spaces} +\mathbf{b}^\top\quad x\mapsto y\Rightarrow z`;
    const bases = '<span class="base"><span class="mord">x</span></span>';
    const html = metadata === "script"
      ? '<span class="katex-display"><span class="katex">' +
        `<script type="math/tex; mode=display">${source}</script>` +
        `<span class="katex-html" aria-hidden="true">${bases}</span></span></span>`
      : reportedKatexFormula({ source, metadata, bases });
    const page = createUserscriptPage(t, html);
    selectContents(page, ".katex-html .base");
    await clickSelectedFormulaCopy(page, page.document.querySelector(".base"));

    // Legacy source attributes on an outer shell are currently canonicalized
    // inline; this test checks source fidelity, not display-mode inference.
    const legacyOuterSource = ["data-latex", "data-tex", "data-math", "data-mathml"].includes(metadata);
    assert.equal(copySelection(page), legacyOuterSource ? `$${source}$` : `$$\n${source}\n$$`);
    assert.deepEqual(page.clipboard, [{ text: clipboard, type: "text" }]);
    assert.doesNotMatch(page.clipboard[0].text, /[\r\n]/);
  });
}

test("single-formula Copy removes actual comments but preserves escaped and verbatim percent signs", async (t) => {
  const source = String.raw`50\%+\verb|100%|+\verb*+20%+ % remove this comment` + "\n" +
    String.raw`+\mathbf b`;
  const expected = String.raw`50\%+\verb|100%|+\verb*+20%+ +\mathbf{b}`;
  const page = createUserscriptPage(t, sourceFormula({ source }));
  selectContents(page, "#radius");
  await clickSelectedFormulaCopy(page, page.document.querySelector("#radius"));

  assert.deepEqual(page.clipboard, [{ text: expected, type: "text" }]);
  assert.doesNotMatch(page.clipboard[0].text, /[\r\n]/);
  assert.equal(copySelection(page), `$$\n${source}\n$$`);
  assert.equal(page.document.querySelector("#radius").getAttribute("data-math-source"), source);
});

test("single-formula Copy folds matrix source lines without deleting LaTeX row separators", async (t) => {
  const source = String.raw`\begin{bmatrix}` + "\n  " + String.raw`a&b\\` + "\n  " +
    String.raw`c&d` + "\n" + String.raw`\end{bmatrix}`;
  const expected = String.raw`\left[\begin{matrix} a&b\\ c&d \end{matrix}\right]`;
  const page = createUserscriptPage(t, sourceFormula({ source }));
  selectContents(page, "#radius");
  await clickSelectedFormulaCopy(page, page.document.querySelector("#radius"));

  assert.deepEqual(page.clipboard, [{ text: expected, type: "text" }]);
  assert.doesNotMatch(page.clipboard[0].text, /[\r\n]/);
  assert.equal(copySelection(page), `$$\n${source}\n$$`);
});

test("Copy of surrounding paragraphs keeps multiline canonical math rather than flattening the document", async (t) => {
  const page = createUserscriptPage(t,
    '<section id="paragraphs"><p>Before.</p>' +
    sourceFormula({ source: LIE_DERIVATIVE_FORMULA }) +
    '<p>After.</p></section>'
  );
  selectContents(page, "#paragraphs");
  await clickSelectedFormulaCopy(page, page.document.querySelector("#paragraphs"));
  const expected = `Before.\n\n$$\n${LIE_DERIVATIVE_FORMULA}\n$$\n\nAfter.`;

  assert.deepEqual(page.clipboard, [{ text: expected, type: "text" }]);
  assert.equal(copySelection(page), expected);
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
