// Local-only browser regression harness. Does not contact the backend, modify
// the system clipboard, or expose arbitrary workspace files.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const userscript = () => fs.readFileSync(path.join(root, "tts-userscript.js"), "utf8");
const controls = String.raw`
<style>body{font:16px system-ui;margin:24px}svg{width:100px;height:40px}pre{white-space:pre-wrap}button{padding:8px;margin:8px}</style>
<button id="run-full">Test full formula</button>
<button id="run-partial">Test partial formula</button>
<p id="verdict"></p><pre id="result"></pre>
<p><a href="/tts-userscript.user.js">Local userscript update</a></p>
<script src="/selection-core.js"></script>
<script>
const selectionTools = KokoroTTSCore.createSelectionTools(document);
function runFormulaCheck(partial) {
  const formula = document.querySelector('[data-math-source]');
  const range = document.createRange();
  if (partial) {
    const text = formula.querySelector('.mathnormal').firstChild;
    range.setStart(text, 0); range.setEnd(text, 1);
  } else { range.selectNode(formula); }
  const selection = window.getSelection();
  selection.removeAllRanges(); selection.addRange(range);
  const selected = selection.toString();
  const extracted = selectionTools.getSelectedText();
  const copied = KokoroTTSCore.normalizeCopyTextWithLatex(extracted);
  const expected = '$$\n' + formula.getAttribute('data-math-source') + '\n$$';
  const result = {partial, selected, extracted, copied, expected, pass:copied===expected};
  document.getElementById('verdict').textContent = result.pass ? 'PASS' : 'FAIL';
  document.getElementById('result').textContent = JSON.stringify(result,null,2);
}
document.getElementById('run-full').onclick = () => runFormulaCheck(false);
document.getElementById('run-partial').onclick = () => runFormulaCheck(true);
runFormulaCheck(false);
</script>`;
const server = http.createServer((req, res) => {
  if (req.url === "/") {
    res.writeHead(200, {"Content-Type":"text/html; charset=utf-8", "Cache-Control":"no-store"});
    res.end(fs.readFileSync(path.join(root, "tests/fixtures/chatgpt-formula.html"), "utf8") + controls);
  } else if (req.url === "/selection-core.js") {
    const source = userscript();
    res.writeHead(200, {"Content-Type":"application/javascript; charset=utf-8", "Cache-Control":"no-store"});
    res.end(source.slice(0, source.indexOf('if (typeof window !== "undefined"')));
  } else if (req.url === "/tts-userscript.user.js") {
    res.writeHead(200, {"Content-Type":"application/javascript; charset=utf-8", "Cache-Control":"no-store"});
    res.end(userscript());
  } else { res.writeHead(404); res.end(); }
});
server.listen(0, "127.0.0.1", () => console.log(`Formula fixture: http://127.0.0.1:${server.address().port}/`));
