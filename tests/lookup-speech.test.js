/**
 * M7: the lookup panel's pronunciation (Web Speech API).
 *
 * The controller warms speech synthesis once per controller (a silent utterance and one
 * voiceschanged listener), prefers a local English voice, and the footer's first button reads
 * the term aloud. These checks pin that behaviour so moving it into lookup/tts.js cannot
 * change it.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { sleep } = require("./helpers/extension-sandbox");
const { loadLookupController, disposeLookupControllers } = require("./helpers/fake-dom");

test.afterEach(() => disposeLookupControllers());

const VOICES = [
  { name: "Remote GB", lang: "en-GB", localService: false },
  { name: "Local US", lang: "en-US", localService: true },
  { name: "Chinese", lang: "zh-CN", localService: true },
];

function fakeSpeech(voices) {
  const synth = {
    voices,
    spoken: [],
    cancels: 0,
    listeners: [],
    paused: false,
    getVoices: () => synth.voices,
    addEventListener: (type, fn) => synth.listeners.push({ type, fn }),
    speak: (u) => synth.spoken.push(u),
    cancel: () => (synth.cancels += 1),
    resume() {},
  };
  class Utterance {
    constructor(text) {
      this.text = text;
    }
  }
  return { synth, Utterance };
}

function setup(voices) {
  const env = loadLookupController();
  const { synth, Utterance } = fakeSpeech(voices);
  env.window.speechSynthesis = synth;
  env.window.SpeechSynthesisUtterance = Utterance;
  return { env, synth };
}

function speakButton(env) {
  return env.panel().querySelector(".zeh-panel-footer .mk-btn:nth-child(1)");
}

test("the controller warms speech once with a silent utterance and one voiceschanged listener", async () => {
  const { env, synth } = setup(VOICES);
  await sleep(0);
  assert.equal(synth.spoken.length, 1);
  const warm = synth.spoken[0];
  assert.equal(warm.text, "​");
  assert.equal(warm.volume, 0);
  assert.equal(warm.rate, 10);
  assert.equal(warm.lang, "en-US");
  assert.equal(warm.voice.name, "Local US", "a local English voice is preferred");
  assert.deepEqual(
    synth.listeners.map((l) => l.type),
    ["voiceschanged"],
  );
  // later panels warm again but neither re-register the listener nor speak another silent utterance
  env.controller.lookupText("harbour");
  env.controller.lookupText("harbour");
  assert.equal(synth.listeners.length, 1);
  assert.equal(synth.spoken.length, 1);
});

test("the speak button cancels what is playing and reads the term with the preferred voice", async () => {
  const { env, synth } = setup(VOICES);
  await sleep(0);
  const q = env.controller.lookupText("harbour") && env.explainRequests().at(-1).message.queryId;
  env.deliver({ type: "SHOW_RESULT", queryId: q, queryType: "word", fromDict: true, durationMs: 0, data: { queryType: "word", term: "harbour", short_meaning: "港口" } });
  speakButton(env).dispatchEvent({ type: "click", stopPropagation() {} });
  const spoken = synth.spoken.at(-1);
  assert.equal(spoken.text, "harbour");
  assert.equal(spoken.lang, "en-US");
  assert.equal(spoken.rate, 0.92);
  assert.equal(spoken.voice.name, "Local US");
  assert.ok(synth.cancels >= 1, "the previous utterance is cancelled first");
});

test("voices that arrive later (voiceschanged) are used for the next utterance", async () => {
  const { env, synth } = setup([]);
  await sleep(0);
  assert.equal(synth.spoken[0].voice, undefined, "no voice yet");
  synth.voices = [{ name: "Only GB", lang: "en-GB", localService: false }, ...VOICES.slice(2)];
  synth.listeners[0].fn();
  const q = env.controller.lookupText("harbour") && env.explainRequests().at(-1).message.queryId;
  env.deliver({ type: "SHOW_RESULT", queryId: q, queryType: "word", fromDict: true, durationMs: 0, data: { queryType: "word", term: "harbour" } });
  speakButton(env).dispatchEvent({ type: "click", stopPropagation() {} });
  assert.equal(synth.spoken.at(-1).voice.name, "Only GB");
});

test("each controller keeps its own speech state; no speechSynthesis is not an error", async () => {
  const a = setup(VOICES);
  const b = setup(VOICES);
  await sleep(0);
  assert.equal(a.synth.listeners.length, 1);
  assert.equal(b.synth.listeners.length, 1);

  const env = loadLookupController();
  await sleep(0);
  const q = env.controller.lookupText("harbour") && env.explainRequests().at(-1).message.queryId;
  env.deliver({ type: "SHOW_RESULT", queryId: q, queryType: "word", fromDict: true, durationMs: 0, data: { queryType: "word", term: "harbour" } });
  assert.doesNotThrow(() => speakButton(env).dispatchEvent({ type: "click", stopPropagation() {} }));
});
