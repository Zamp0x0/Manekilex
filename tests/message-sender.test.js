/**
 * Phase 5 sender boundary: content scripts (any web page) may only look words up, save a word,
 * open Settings, register the PDF helper and fetch dictionary keys. Everything that deletes,
 * reviews, migrates, clears data, changes providers or spends money is accepted only from the
 * extension's own pages (chrome-extension://<id>/…).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadBackground,
  extensionPageSender,
  contentScriptSender,
} = require("./helpers/extension-sandbox");

const VOCAB = "zehVocabulary";
const DICTIONARY = { prayer: { term: "prayer", short_meaning: "祈祷", part_of_speech: "n.", enriched: true } };

function saved(term, id) {
  return { id, serial: 1, savedAt: 1700000000000, savedAtLocal: "x", term, queryType: "word", short_meaning: "m" };
}

test("content script: ADD_VOCAB and EXPLAIN are allowed", async () => {
  const bg = loadBackground({ dictionary: DICTIONARY, storage: { zehManekilexEnabled: true } });
  const page = contentScriptSender("https://news.example.test/story", 3);
  const add = await bg.dispatch({ type: "ADD_VOCAB", item: { term: "prayer", queryType: "word", short_meaning: "祈祷" } }, page);
  assert.equal(add.ok, true);
  assert.equal(add.added, true);
  const explain = await bg.dispatch({ type: "EXPLAIN", text: "prayer", queryId: "q1" }, page);
  assert.equal(explain.accepted, true);
  const keys = await bg.dispatch({ type: "GET_DICT_KEY_LIST" }, page);
  assert.equal(keys.ok, true);
});

test("content script: DELETE_VOCAB / REVIEW_VOCAB / MIGRATE_VOCAB are rejected and nothing changes", async () => {
  const list = [saved("alpha", "a1"), saved("beta", "b1")];
  const bg = loadBackground({ storage: { [VOCAB]: list } });
  const page = contentScriptSender("https://evil.example.test/", 9);
  const before = bg.local.setCalls.length;

  const del = await bg.dispatch({ type: "DELETE_VOCAB", ids: ["a1", "b1"] }, page);
  assert.equal(del.ok, false);
  assert.equal(del.code, "FORBIDDEN_SENDER");
  const review = await bg.dispatch({ type: "REVIEW_VOCAB", id: "a1", rating: "good" }, page);
  assert.equal(review.code, "FORBIDDEN_SENDER");
  const migrate = await bg.dispatch({ type: "MIGRATE_VOCAB" }, page);
  assert.equal(migrate.code, "FORBIDDEN_SENDER");

  assert.equal(bg.local.data[VOCAB].length, 2, "vocabulary untouched");
  assert.equal(bg.local.setCalls.filter((k) => k.includes(VOCAB)).length, 0, "no vocabulary write");
  assert.equal(bg.local.setCalls.length, before, "no storage write at all");
});

test("content script: cache / usage / benchmark / provider / transcript mutations are rejected", async () => {
  const bg = loadBackground({ storage: { zehUsageLogs: [{ a: 1 }], "zehCache:v2:word:5:abc": { x: 1 } } });
  const page = contentScriptSender("https://blog.example.test/", 4);
  const types = [
    "CLEAR_LOOKUP_CACHE",
    "CLEANUP_LOOKUP_CACHE",
    "CLEAR_USAGE_LOGS",
    "CLEAR_READER_POSITION_CACHE",
    "START_PROVIDER_BENCHMARK",
    "CANCEL_PROVIDER_BENCHMARK",
    "CLEAR_PROVIDER_BENCHMARK",
    "SET_PROVIDER_MODEL_FROM_BENCHMARK",
    "SAVE_BENCHMARK_CUSTOM_MODELS",
    "SET_LIVE_TRANSCRIBE_PROVIDER",
    "GET_ASSEMBLYAI_TEMP_TOKEN",
    "TRANSLATE_TRANSCRIPT",
    "START_TAB_AUDIO_CAPTURE_FROM_ACTIVE_TAB",
    "PREVIEW_TAB_CAPTURE_TARGET",
    "GET_LOOKUP_CACHE_STATS",
    "GET_PROVIDER_BENCHMARK_STATUS",
    "GET_LIVE_TRANSCRIBE_PROVIDER_OPTIONS",
  ];
  for (const type of types) {
    const res = await bg.dispatch({ type, providerId: "openai", model: "x", models: {}, currentText: "hi" }, page);
    assert.equal(res && res.code, "FORBIDDEN_SENDER", type);
  }
  assert.deepEqual(bg.local.data.zehUsageLogs, [{ a: 1 }], "usage logs kept");
  assert.ok(bg.local.data["zehCache:v2:word:5:abc"], "cache kept");
  assert.equal(bg.fetchCalls.length, 0, "no network call");
});

test("extension pages: the same mutations are accepted (Settings deletes, reviews, clears)", async () => {
  const bg = loadBackground({ storage: { [VOCAB]: [saved("alpha", "a1")], zehUsageLogs: [{ a: 1 }] } });
  const settings = extensionPageSender("settings.html#vocabulary");
  const del = await bg.dispatch({ type: "DELETE_VOCAB", ids: ["a1"] }, settings);
  assert.equal(del.ok, true);
  assert.equal(bg.local.data[VOCAB].length, 0);
  const usage = await bg.dispatch({ type: "CLEAR_USAGE_LOGS" }, settings);
  assert.equal(usage.ok, true);
  assert.deepEqual(bg.local.data.zehUsageLogs, []);
  const popup = extensionPageSender("popup.html");
  const cleared = await bg.dispatch({ type: "CLEAR_READER_POSITION_CACHE" }, popup);
  assert.equal(cleared.ok, true);
});

test("sender checks: wrong extension id, missing url and page-like urls are not extension pages", async () => {
  const bg = loadBackground({ storage: { [VOCAB]: [saved("alpha", "a1")] } });
  const cases = [
    { id: "other-extension", url: "chrome-extension://test-extension/settings.html" },
    { id: "test-extension" },
    { id: "test-extension", url: "https://example.test/chrome-extension://test-extension/settings.html" },
    { id: "test-extension", url: "chrome-extension://another-id/settings.html" },
  ];
  for (const sender of cases) {
    const res = await bg.dispatch({ type: "DELETE_VOCAB", ids: ["a1"] }, sender);
    assert.equal(res.code, "FORBIDDEN_SENDER", JSON.stringify(sender));
  }
  assert.equal(bg.local.data[VOCAB].length, 1);
  const reader = { id: "test-extension", url: "chrome-extension://test-extension/reader.html?id=b1", tab: { id: 12 } };
  const ok = await bg.dispatch({ type: "DELETE_VOCAB", ids: ["a1"] }, reader);
  assert.equal(ok.ok, true, "the reader tab is an extension page too");
});

test("M3b: unknown (including removed) and malformed messages are refused explicitly", async () => {
  const bg = loadBackground({});
  const unknown = { ok: false, accepted: false, code: "UNKNOWN_MESSAGE_TYPE" };
  const malformed = { ok: false, accepted: false, code: "MALFORMED_MESSAGE" };
  assert.deepEqual(await bg.dispatch({ type: "GET_ACTIVE_PROVIDER_INFO" }), unknown, "removed handler");
  assert.deepEqual(await bg.dispatch({ type: "GET_TAB_CAPTURE_STREAM_ID" }), unknown, "removed handler");
  assert.deepEqual(await bg.dispatch({ nope: 1 }), malformed);
  assert.deepEqual(await bg.dispatch("string"), malformed);
});
