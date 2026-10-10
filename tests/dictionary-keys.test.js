/**
 * R-04: dictionary keys are loaded lazily (only when selection repair needs them),
 * reused afterwards, shared with same-origin frames, and a failed load can be retried.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { loadLookupController, disposeLookupControllers } = require("./helpers/fake-dom");
const { baseGlobals, runFile } = require("./helpers/extension-sandbox");
const { scriptsFor } = require("./helpers/load-order");

test.afterEach(() => disposeLookupControllers());

const KEYS = ["look up", "prayer", "committee"];
// Selecting "look up" inside "look upward": repair would extend it to "look upward",
// but "look up" is a dictionary entry, so the user's selection is kept.
const PHRASE_TEXT = "Please look upward now";
const PHRASE_START = 7;
const PHRASE_END = 14;

function keyRequests(env) {
  return env.messages("GET_DICT_KEY_LIST");
}

function selectAndPresent(env, text, start, end) {
  env.selectText(text, start, end);
  const info = env.controller.getSelectionInfo();
  if (info) env.controller.presentTrigger({ ...info, releaseX: 40, releaseY: 30 });
  return info;
}

function answerKeys(env, index, response, lastError) {
  env.runtime.lastError = lastError;
  try {
    keyRequests(env)[index].cb(response);
  } finally {
    env.runtime.lastError = undefined;
  }
}

test("R-04: creating a controller does not request dictionary keys", () => {
  const env = loadLookupController();
  assert.equal(keyRequests(env).length, 0);
  assert.equal(env.sent.length, 0, "page load sends nothing to the service worker");
});

test("R-04: a selection that needs no repair does not request keys", () => {
  const env = loadLookupController();
  const info = selectAndPresent(env, "Please look up now", 7, 14);
  assert.equal(info.text, "look up");
  assert.equal(keyRequests(env).length, 0);
});

test("R-04: the first repair that needs keys requests them once and keeps the dictionary term", () => {
  const env = loadLookupController();
  const info = selectAndPresent(env, PHRASE_TEXT, PHRASE_START, PHRASE_END);
  assert.equal(info.text, "look upward", "without keys the repair extends the word");
  assert.equal(keyRequests(env).length, 1);

  // a second read of the same selection while the request is in flight sends nothing new
  env.controller.getSelectionInfo();
  assert.equal(keyRequests(env).length, 1);

  answerKeys(env, 0, { ok: true, keys: KEYS });
  assert.equal(env.controller.getPendingLookupText(), "look up");
  const bubble = env.document.querySelector(".mk-lookup-bubble");
  assert.equal(bubble.dataset.lookupText, "look up");
});

test("R-04: later selections reuse the loaded keys synchronously", () => {
  const env = loadLookupController();
  selectAndPresent(env, PHRASE_TEXT, PHRASE_START, PHRASE_END);
  answerKeys(env, 0, { ok: true, keys: KEYS });

  const info = selectAndPresent(env, "They look upward again", 5, 12);
  assert.equal(info.text, "look up");
  assert.equal(keyRequests(env).length, 1, "no second transfer");
});

test("R-04: keys arriving after the lookup started do not change the pending query", () => {
  const env = loadLookupController();
  selectAndPresent(env, PHRASE_TEXT, PHRASE_START, PHRASE_END);
  env.controller.lookupText("look upward");
  answerKeys(env, 0, { ok: true, keys: KEYS });
  assert.equal(env.explainRequests()[0].message.text, "look upward");
  assert.equal(env.controller.isPending(), true);
});

test("R-04: a failed key load is not cached and the next repair retries", () => {
  const env = loadLookupController();
  selectAndPresent(env, PHRASE_TEXT, PHRASE_START, PHRASE_END);
  answerKeys(env, 0, { ok: false, keys: [] });
  assert.equal(env.controller.getPendingLookupText(), "look upward");

  selectAndPresent(env, PHRASE_TEXT, PHRASE_START, PHRASE_END);
  assert.equal(keyRequests(env).length, 2, "retried after the failure");
  answerKeys(env, 1, undefined, { message: "Could not establish connection." });

  selectAndPresent(env, PHRASE_TEXT, PHRASE_START, PHRASE_END);
  assert.equal(keyRequests(env).length, 3, "retried after a transport error");
  answerKeys(env, 2, { ok: true, keys: KEYS });
  assert.equal(env.controller.getPendingLookupText(), "look up");
});

test("R-04 / R-22: when Manekilex is disabled no keys are requested and no selection is read", () => {
  const env = loadLookupController();
  env.window.MKLookup.setGlobalEnabled(false);
  env.selectText(PHRASE_TEXT, PHRASE_START, PHRASE_END);
  assert.equal(env.controller.getSelectionInfo(), null);
  assert.equal(keyRequests(env).length, 0);

  env.window.MKLookup.setGlobalEnabled(true);
  assert.equal(env.controller.getSelectionInfo().text, "look upward");
  assert.equal(keyRequests(env).length, 1);
});

/** config.js and its page-side part in their own realm, like one frame's content script. */
function loadFrameConfig({ topWindow, sendMessage }) {
  const document = { title: "frame" };
  const window = { document };
  window.top = topWindow || window;
  const context = vm.createContext({
    ...baseGlobals(),
    window,
    document,
    chrome: { runtime: { lastError: undefined, sendMessage } },
  });
  scriptsFor("content", { only: ["config.js", "lookup/dom-helpers.js"] }).forEach((file) => runFile(context, file));
  return { window, document, context };
}

test("R-04: a same-origin child frame reuses the keys its top frame already loaded", () => {
  const topSent = [];
  const top = loadFrameConfig({ sendMessage: (m, cb) => topSent.push({ m, cb }) });
  top.context.zehEnsureDictKeys();
  assert.equal(topSent.length, 1);
  topSent[0].cb({ ok: true, keys: KEYS });

  const childSent = [];
  const child = loadFrameConfig({
    topWindow: top.window,
    sendMessage: (m, cb) => childSent.push({ m, cb }),
  });
  const keys = child.context.zehGetDictKeysSync();
  assert.ok(keys && keys.has("look up"));
  let fromEnsure = null;
  child.context.zehEnsureDictKeys((set) => (fromEnsure = set));
  assert.equal(fromEnsure, keys);
  assert.equal(childSent.length, 0, "child frame sends no GET_DICT_KEY_LIST");
});

test("R-04: a cross-origin child frame cannot reach the top frame and loads its own keys", () => {
  const top = loadFrameConfig({ sendMessage: (m, cb) => cb({ ok: true, keys: KEYS }) });
  top.context.zehEnsureDictKeys();

  const crossOriginTop = {};
  Object.defineProperty(crossOriginTop, "document", {
    get() {
      throw new Error("SecurityError: Blocked a frame with origin");
    },
  });
  const childSent = [];
  const child = loadFrameConfig({
    topWindow: crossOriginTop,
    sendMessage: (m, cb) => childSent.push({ m, cb }),
  });
  assert.equal(child.context.zehGetDictKeysSync(), null);
  child.context.zehEnsureDictKeys();
  assert.equal(childSent.length, 1);
});
