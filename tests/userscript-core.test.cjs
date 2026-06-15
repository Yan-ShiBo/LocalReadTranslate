const assert = require("node:assert/strict");
const test = require("node:test");


test("userscript core can be imported without browser globals", () => {
  let core;
  assert.doesNotThrow(() => {
    core = require("../tts-userscript.js");
  });
  assert.equal(typeof core.createRequestGate, "function");
  assert.equal(typeof core.releaseAudio, "function");
});


test("starting a new request aborts the previous generation", () => {
  const { createRequestGate } = require("../tts-userscript.js");
  const gate = createRequestGate();
  let firstAborts = 0;
  let secondAborts = 0;

  const first = gate.begin();
  gate.attach(first, { abort: () => { firstAborts += 1; } });
  const second = gate.begin();
  gate.attach(second, { abort: () => { secondAborts += 1; } });

  assert.equal(firstAborts, 1);
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);

  gate.finish(first);
  assert.equal(gate.isCurrent(second), true);

  gate.cancel();
  assert.equal(secondAborts, 1);
  assert.equal(gate.isCurrent(second), false);
});


test("request generation is invalidated before synchronous abort callbacks", () => {
  const { createRequestGate } = require("../tts-userscript.js");
  const gate = createRequestGate();
  const first = gate.begin();
  let wasCurrentDuringAbort = null;

  gate.attach(first, {
    abort: () => {
      wasCurrentDuringAbort = gate.isCurrent(first);
    },
  });

  gate.begin();

  assert.equal(wasCurrentDuringAbort, false);
});


test("audio blob URL is revoked at most once", () => {
  const { releaseAudio } = require("../tts-userscript.js");
  const revoked = [];
  const audio = {
    _blobUrl: "blob:test",
    src: "blob:test",
    pauseCalls: 0,
    pause() { this.pauseCalls += 1; },
  };
  const urlApi = { revokeObjectURL: (url) => revoked.push(url) };

  releaseAudio(audio, urlApi);
  releaseAudio(audio, urlApi);

  assert.deepEqual(revoked, ["blob:test"]);
  assert.equal(audio._blobUrl, null);
  assert.equal(audio.src, "");
});
