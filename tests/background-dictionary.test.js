/**
 * R-04 (service worker side): the dictionary is not parsed on every worker start,
 * a failed load is retried instead of being cached as empty, and concurrent
 * callers share one load.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackground, jsonResponse, sleep, evalIn } = require("./helpers/extension-sandbox");

const DICTIONARY = {
  "look up": { term: "look up", short_meaning: "查阅", enriched: true },
  prayer: { term: "prayer", short_meaning: "祈祷", enriched: true, forms: { plural: "prayers" } },
};

test("R-04: starting the service worker does not fetch the dictionary", async () => {
  const bg = loadBackground({ dictionary: DICTIONARY });
  await sleep(10);
  assert.equal(bg.dictionaryFetches.length, 0);
});

test("R-04: GET_DICT_KEY_LIST loads once and reuses the key list", async () => {
  const bg = loadBackground({ dictionary: DICTIONARY });
  const first = await bg.dispatch({ type: "GET_DICT_KEY_LIST" });
  assert.equal(first.ok, true);
  assert.deepEqual([...first.keys].sort(), ["look up", "prayer"]);
  const cached = evalIn(bg.context, "_dictKeyList");
  const second = await bg.dispatch({ type: "GET_DICT_KEY_LIST" });
  assert.deepEqual(second.keys, first.keys);
  assert.equal(evalIn(bg.context, "_dictKeyList"), cached, "same array, not rebuilt per request");
  assert.equal(bg.dictionaryFetches.length, 1);
});

test("R-04: concurrent requests share one dictionary fetch", async () => {
  const bg = loadBackground({ dictionary: DICTIONARY });
  const results = await Promise.all([
    bg.dispatch({ type: "GET_DICT_KEY_LIST" }),
    bg.dispatch({ type: "GET_DICT_KEY_LIST" }),
    bg.dispatch({ type: "GET_DICT_KEY_LIST" }),
  ]);
  results.forEach((r) => assert.equal(r.keys.length, 2));
  assert.equal(bg.dictionaryFetches.length, 1);
});

test("R-04: a failed dictionary load is retried on the next request", async () => {
  const bg = loadBackground({
    dictionary: (attempt) =>
      attempt === 1 ? { ok: false, status: 500, json: async () => ({}) } : jsonResponse(200, DICTIONARY),
  });
  const failed = await bg.dispatch({ type: "GET_DICT_KEY_LIST" });
  assert.deepEqual({ ok: failed.ok, n: failed.keys.length }, { ok: false, n: 0 });

  const retried = await bg.dispatch({ type: "GET_DICT_KEY_LIST" });
  assert.equal(retried.ok, true);
  assert.equal(retried.keys.length, 2);
  assert.equal(bg.dictionaryFetches.length, 2);
});

test("R-04: a corrupt dictionary body is not cached either", async () => {
  const bg = loadBackground({
    dictionary: (attempt) =>
      attempt === 1
        ? { ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected end of JSON"); } }
        : jsonResponse(200, DICTIONARY),
  });
  assert.equal((await bg.dispatch({ type: "GET_DICT_KEY_LIST" })).ok, false);
  assert.equal((await bg.dispatch({ type: "GET_DICT_KEY_LIST" })).ok, true);
});

test("R-04: a word lookup after a failed load still reaches the dictionary on retry", async () => {
  const bg = loadBackground({
    dictionary: (attempt) =>
      attempt === 1 ? { ok: false, status: 503, json: async () => ({}) } : jsonResponse(200, DICTIONARY),
    storage: { zehManekilexEnabled: true },
  });
  await bg.dispatch({ type: "GET_DICT_KEY_LIST" }); // first load fails

  const res = await bg.dispatch(
    { type: "EXPLAIN", text: "prayers", queryId: "q-1" },
    { tab: { id: 7 } }
  );
  assert.equal(res.accepted, true);
  const shown = bg.tabMessages.find((m) => m.message.type === "SHOW_RESULT");
  assert.ok(shown, "dictionary result shown");
  assert.equal(shown.message.fromDict, true);
  assert.equal(shown.message.data.short_meaning, "祈祷");
});
