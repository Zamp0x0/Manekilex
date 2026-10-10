/**
 * M3: the service worker's runtime messages are listed in one registry (sw/router.js,
 * ZEH_MESSAGE_ROUTES): type → who may send it, what it carries, an optional validation step and
 * its handler. The onMessage listener is a table lookup.
 *
 * Behaviour is unchanged on purpose (the security tightening is a separate follow-up):
 *   - unknown types are still allowed through the sender check and simply not answered
 *     (the listener returns false, sendResponse is never called);
 *   - every registered handler keeps the message channel open (returns true), including the
 *     ones that answer synchronously, exactly like the old if-chain;
 *   - the content-script / extension-page split is the Phase 5 one, pinned below.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadBackground, extensionPageSender, contentScriptSender, sleep, evalIn } = require("./helpers/extension-sandbox");
const { readSource } = require("./helpers/script-scan");
const { scriptsFor, getContext } = require("./helpers/load-order");

const ROOT = path.resolve(__dirname, "..");

/** The Phase 5 sender split, written out so a registry edit cannot change it silently. */
const FROM_CONTENT_SCRIPTS = [
  "EXPLAIN",
  "ADD_VOCAB",
  "OPEN_SETTINGS",
  "PDF_PAGE_ASSISTANT_READY",
  // the old PDF cat in Chrome's own viewer: can this PDF go back to the enhanced reader, open a local file
  "PDF_PAGE_ENHANCED",
  "GET_DICT_KEY_LIST",
];
const EXTENSION_PAGES_ONLY = [
  "START_PROVIDER_BENCHMARK",
  "GET_PROVIDER_BENCHMARK_STATUS",
  "CANCEL_PROVIDER_BENCHMARK",
  "CLEAR_PROVIDER_BENCHMARK",
  "SET_PROVIDER_MODEL_FROM_BENCHMARK",
  // M9: the worker is the only writer of the provider configuration
  "SAVE_PROVIDER_SETTINGS",
  "MIGRATE_PROVIDER_SETTINGS",
  "SAVE_BENCHMARK_CUSTOM_MODELS",
  "DELETE_VOCAB",
  "REVIEW_VOCAB",
  "MIGRATE_VOCAB",
  "GET_LOOKUP_CACHE_STATS",
  "CLEANUP_LOOKUP_CACHE",
  "CLEAR_LOOKUP_CACHE",
  "CLEAR_USAGE_LOGS",
  "CLEAR_READER_POSITION_CACHE",
  "GET_ASSEMBLYAI_TEMP_TOKEN",
  "GET_LIVE_TRANSCRIBE_PROVIDER_OPTIONS",
  "SET_LIVE_TRANSCRIBE_PROVIDER",
  "PREVIEW_TAB_CAPTURE_TARGET",
  "START_TAB_AUDIO_CAPTURE_FROM_ACTIVE_TAB",
  "TRANSLATE_TRANSCRIPT",
  // enhanced PDF reader: tells the worker which tab it took over (hides the old PDF cat there)
  "PDF_READER_STATE",
];
const ALL_TYPES = [...FROM_CONTENT_SCRIPTS, ...EXTENSION_PAGES_ONLY];

/** A payload each handler can run with in the sandbox without network or real tabs. */
const SAMPLE = {
  EXPLAIN: { text: "" },
  TRANSLATE_TRANSCRIPT: { currentText: "" },
  ADD_VOCAB: { item: { term: "prayer", queryType: "word", short_meaning: "祈祷" } },
  DELETE_VOCAB: { ids: [] },
  REVIEW_VOCAB: { id: "missing", rating: "good" },
  SET_PROVIDER_MODEL_FROM_BENCHMARK: { providerId: "nope", model: "x" },
  SET_LIVE_TRANSCRIBE_PROVIDER: { providerId: "nope" },
};

/**
 * Call the real listener once, the way Chrome does, and report what it returned synchronously,
 * whether it answered synchronously, and the answer once it arrives (or "none").
 */
async function callListener(bg, message, sender) {
  const [listener] = bg.chrome.runtime.onMessage.listeners;
  let answer = "none";
  let calls = 0;
  const returned = listener(message, sender, (payload) => {
    calls++;
    answer = payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));
  });
  const syncAnswered = calls > 0;
  for (let i = 0; i < 50 && calls === 0 && returned === true; i++) await sleep(10);
  return { returned, syncAnswered, answer, calls };
}

const page = () => extensionPageSender("settings.html");
const webPage = () => contentScriptSender("https://news.example.test/story", 3);

// ── Behaviour baseline (true before and after the registry) ─────────────────────────────────

test("M3 baseline: every handled type keeps the channel open (returns true) for an extension page", async () => {
  const bg = loadBackground({ storage: { zehManekilexEnabled: true } });
  for (const type of ALL_TYPES) {
    const r = await callListener(bg, { type, ...(SAMPLE[type] || {}) }, page());
    assert.equal(r.returned, true, `${type} returns true`);
    assert.ok(r.calls <= 1, `${type} answers at most once`);
  }
});

test("M3 baseline: content scripts get FORBIDDEN_SENDER for page-only types, synchronously", async () => {
  const bg = loadBackground({ storage: { zehManekilexEnabled: true } });
  for (const type of EXTENSION_PAGES_ONLY) {
    const r = await callListener(bg, { type, ...(SAMPLE[type] || {}) }, webPage());
    assert.equal(r.returned, true, type);
    assert.equal(r.syncAnswered, true, `${type} is refused synchronously`);
    assert.deepEqual(r.answer, { ok: false, accepted: false, code: "FORBIDDEN_SENDER", reason: "extension_page_only" }, type);
  }
  for (const type of FROM_CONTENT_SCRIPTS) {
    const r = await callListener(bg, { type, ...(SAMPLE[type] || {}) }, webPage());
    assert.equal(r.returned, true, type);
    assert.notEqual(r.answer && r.answer.code, "FORBIDDEN_SENDER", `${type} is allowed from a web page`);
  }
});

// M3b deliberately replaced the old default-allow baseline ("unknown, inherited-name and malformed
// messages are not answered"): such messages are now refused explicitly. Page-bound types stay
// unanswered. tests/message-security.test.js covers the rest of M3b.
test("M3b: unknown, inherited-name and malformed messages are refused explicitly; page-bound ones stay unanswered", async () => {
  const bg = loadBackground();
  const unknown = { ok: false, accepted: false, code: "UNKNOWN_MESSAGE_TYPE" };
  const malformed = { ok: false, accepted: false, code: "MALFORMED_MESSAGE" };
  for (const [message, expected] of [
    [{ type: "NO_SUCH_TYPE" }, unknown],
    [{ type: "toString" }, unknown],
    [{ type: "constructor" }, unknown],
    [{ type: "__proto__" }, unknown],
    [{ type: "hasOwnProperty" }, unknown],
    [{ type: "SHOW_RESULT" }, "none"], // page-bound: the worker never answers it
    [{ type: 42 }, malformed],
    [{}, malformed],
    [null, malformed],
    ["EXPLAIN", malformed],
  ]) {
    for (const sender of [page(), webPage()]) {
      const r = await callListener(bg, message, sender);
      assert.equal(r.returned, expected !== "none", JSON.stringify(message));
      assert.equal(r.calls, expected === "none" ? 0 : 1, JSON.stringify(message));
      assert.deepEqual(r.answer, expected, JSON.stringify(message));
      if (expected !== "none") assert.equal(r.syncAnswered, true, JSON.stringify(message));
    }
  }
});

test("M3 baseline: validation answers keep their exact shape", async () => {
  const bg = loadBackground();
  const explain = await callListener(bg, { type: "EXPLAIN", text: "   " }, webPage());
  assert.equal(explain.syncAnswered, true);
  assert.equal(explain.answer.accepted, false);
  assert.equal(typeof explain.answer.code, "string");
  assert.deepEqual(Object.keys(explain.answer).sort(), ["accepted", "code", "message"]);

  const translate = await callListener(bg, { type: "TRANSLATE_TRANSCRIPT", currentText: "  ", text: "" }, page());
  assert.equal(translate.syncAnswered, true);
  assert.deepEqual(translate.answer, { ok: false, error: "empty transcript", message: "没有可翻译的文本" });
});

test("M3 baseline: a synchronous throw inside a handler still reaches Chrome (no new try/catch)", async () => {
  const bg = loadBackground();
  bg.context.openExtensionSettings = () => {
    throw new Error("boom");
  };
  const [listener] = bg.chrome.runtime.onMessage.listeners;
  assert.throws(() => listener({ type: "OPEN_SETTINGS" }, page(), () => {}), /boom/);
});

// ── The registry ────────────────────────────────────────────────────────────────────────────

function registry(bg) {
  const routes = evalIn(bg.context, "ZEH_MESSAGE_ROUTES");
  assert.equal(evalIn(bg.context, "ZEH_MESSAGE_ROUTES instanceof Map"), true, "a Map: no inherited keys");
  return routes;
}

test("M3 registry: lists exactly the handled types, each with sender rule, payload, senders and handler", () => {
  const bg = loadBackground();
  const routes = registry(bg);
  assert.deepEqual([...routes.keys()].sort(), [...ALL_TYPES].sort());
  for (const [type, route] of routes) {
    assert.ok(["any", "extension-page"].includes(route.from), `${type}.from`);
    assert.equal(typeof route.payload, "string", `${type}.payload documents the fields`);
    assert.ok(Array.isArray(route.senders) && route.senders.length > 0, `${type}.senders`);
    assert.equal(typeof route.handle, "function", `${type}.handle`);
    if ("validate" in route) assert.equal(typeof route.validate, "function", `${type}.validate`);
  }
});

test("M3 registry: the sender rule of every type is the Phase 5 one", () => {
  const bg = loadBackground();
  const routes = registry(bg);
  for (const type of FROM_CONTENT_SCRIPTS) assert.equal(routes.get(type).from, "any", type);
  for (const type of EXTENSION_PAGES_ONLY) assert.equal(routes.get(type).from, "extension-page", type);
  // The two sets the sender check reads are derived from the registry.
  assert.deepEqual([...evalIn(bg.context, "ZEH_CONTENT_SCRIPT_MESSAGE_TYPES")].sort(), [...FROM_CONTENT_SCRIPTS].sort());
  assert.deepEqual([...evalIn(bg.context, "ZEH_EXTENSION_PAGE_MESSAGE_TYPES")].sort(), [...EXTENSION_PAGES_ONLY].sort());
});

/** First-party scripts of every context (no vendored libraries). */
function firstPartyScripts() {
  const files = new Set();
  for (const ctx of ["service-worker", "content", "settings", "reader", "popup", "side-panel"]) {
    for (const f of scriptsFor(ctx)) if (!f.startsWith("lib/")) files.add(f);
  }
  files.add("live-transcribe-worklet.js");
  return [...files].filter((f) => fs.existsSync(path.join(ROOT, f)));
}

/** Every `type: "UPPER_CASE"` literal in a file (message objects). */
function typeLiterals(file) {
  return [...readSource(file).matchAll(/\btype:\s*"([A-Z][A-Z0-9_]+)"/g)].map((m) => m[1]);
}

test("M3 registry: every message type literal in the extension is registered or explicitly page-bound", () => {
  const bg = loadBackground();
  const routes = registry(bg);
  const pageBound = evalIn(bg.context, "ZEH_PAGE_BOUND_MESSAGES");
  const unknown = [];
  for (const file of firstPartyScripts()) {
    for (const type of typeLiterals(file)) {
      if (!routes.has(type) && !Object.prototype.hasOwnProperty.call(pageBound, type)) unknown.push(`${file}: ${type}`);
    }
  }
  assert.deepEqual(unknown, [], "message types that are neither routed nor page-bound");
});

test("M3 registry: declared senders really send the type; page-bound receivers really handle it", () => {
  const bg = loadBackground();
  const routes = registry(bg);
  for (const [type, route] of routes) {
    for (const file of route.senders) {
      assert.ok(typeLiterals(file).includes(type), `${file} sends ${type}`);
    }
  }
  const pageBound = evalIn(bg.context, "ZEH_PAGE_BOUND_MESSAGES");
  for (const [type, receivers] of Object.entries(pageBound)) {
    for (const file of receivers) {
      assert.match(readSource(file), new RegExp(`\\.type [!=]== "${type}"`), `${file} handles ${type}`);
    }
  }
});

test("M3 registry: the onMessage listener is a short table lookup and EXPLAIN has a named handler", () => {
  const src = readSource("background.js");
  const start = src.indexOf("chrome.runtime.onMessage.addListener(");
  assert.ok(start > 0);
  const end = src.indexOf("\n});", start);
  const body = src.slice(start, end).split("\n");
  assert.ok(body.length < 40, `listener is ${body.length} lines`);
  assert.doesNotMatch(body.join("\n"), /message\.type === "/, "no if-chain on message types");
  const workerFiles = getContext("service-worker").scripts;
  assert.ok(
    workerFiles.some((f) => /\bfunction handleExplain\(/.test(readSource(f))),
    "EXPLAIN is handled by a named function in a service worker file"
  );
  assert.equal((src.match(/onMessage\.addListener\(/g) || []).length, 1, "still exactly one listener");
});
