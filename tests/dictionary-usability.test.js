/**
 * Phase 5 dictionary hardening at runtime: an entry flagged enriched:true but without any
 * meaning is not a hit (provider fallback, nothing cached); dictionary hits are no longer
 * copied into the lookup cache (R-27); part-of-speech spellings are normalised for display;
 * debug logging is silent by default.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackground, loadConfig, evalIn, contentScriptSender } = require("./helpers/extension-sandbox");

const DICTIONARY = {
  jj: { term: "jj", phonetic: "", part_of_speech: "", short_meaning: "", context_meaning: "", examples: [], memory_tip: "", common_collocations: [], enriched: true },
  prayer: { term: "prayer", phonetic: "ˈpreə", part_of_speech: "n. & v.", short_meaning: "祈祷", context_meaning: "", examples: [], memory_tip: "", enriched: false },
  bank: { term: "bank", part_of_speech: "noun, verb", short_meaning: "银行；河岸", examples: [{ en: "x", zh: "y" }], memory_tip: "记", enriched: true },
};

function cacheKeys(bg) {
  return Object.keys(bg.local.data).filter((k) => k.startsWith("zehCache:"));
}

test("empty shell flagged enriched:true is a miss → NO_API_KEY (provider fallback), nothing cached", async () => {
  const bg = loadBackground({ dictionary: DICTIONARY, storage: { zehManekilexEnabled: true } });
  const res = await bg.dispatch({ type: "EXPLAIN", text: "jj", queryId: "q1" }, contentScriptSender());
  assert.equal(res.accepted, false);
  assert.equal(res.code, "NO_API_KEY", "fell through to the provider path instead of showing an empty card");
  assert.equal(bg.tabMessages.filter((m) => m.message.type === "SHOW_RESULT").length, 0);
  assert.equal(cacheKeys(bg).length, 0);
});

test("usable dictionary hit is shown at once and is NOT copied into the lookup cache", async () => {
  const bg = loadBackground({ dictionary: DICTIONARY, storage: { zehManekilexEnabled: true } });
  const res = await bg.dispatch({ type: "EXPLAIN", text: "bank", queryId: "q2" }, contentScriptSender());
  assert.equal(res.accepted, true);
  const shown = bg.tabMessages.find((m) => m.message.type === "SHOW_RESULT");
  assert.equal(shown.message.fromDict, true);
  assert.equal(shown.message.data.short_meaning, "银行；河岸");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cacheKeys(bg).length, 0, "dictionary-only result not written to zehCache");
});

test("part-of-speech spellings are normalised for display (n. & v. → noun, verb)", async () => {
  const bg = loadBackground({ dictionary: DICTIONARY, storage: { zehManekilexEnabled: true } });
  await bg.dispatch({ type: "EXPLAIN", text: "prayer", queryId: "q3" }, contentScriptSender());
  const shown = bg.tabMessages.find((m) => m.message.type === "SHOW_RESULT");
  assert.equal(shown.message.data.part_of_speech, "noun, verb");
  const ctx = loadConfig();
  const norm = evalIn(ctx, "zehNormalizePartOfSpeech");
  assert.equal(norm("n."), "noun");
  assert.equal(norm("adj./n./v."), "adjective, noun, verb");
  assert.equal(norm("noun, verb, noun"), "noun, verb");
  assert.equal(norm("名词"), "名词");
  assert.equal(norm("动词（过去式/过去分词）"), "动词（过去式/过去分词）", "slash inside parentheses is not a separator");
  assert.equal(norm("Noun & Adjective"), "noun, adjective");
  assert.equal(norm("  prep.,  conj. "), "preposition, conjunction");
  assert.equal(norm(""), "");
});

test("zehIsDictEntryUsable / zehIsDictEntryEnriched need real content, not just the flag", () => {
  const ctx = loadConfig();
  const usable = evalIn(ctx, "zehIsDictEntryUsable");
  const enriched = evalIn(ctx, "zehIsDictEntryEnriched");
  assert.equal(usable(DICTIONARY.jj), false);
  assert.equal(enriched(DICTIONARY.jj), false, "enriched:true alone is not enough");
  assert.equal(usable(DICTIONARY.prayer), true);
  assert.equal(enriched(DICTIONARY.prayer), false);
  assert.equal(usable(DICTIONARY.bank), true);
  assert.equal(enriched(DICTIONARY.bank), true);
  assert.equal(usable({ context_meaning: "只有语境义" }), true);
  assert.equal(usable(null), false);
  assert.equal(usable({ specialEntry: true }), true);
});

test("debug logging is off by default: a full lookup emits no console.debug", async () => {
  const bg = loadBackground({ dictionary: DICTIONARY, storage: { zehManekilexEnabled: true } });
  evalIn(bg.context, "globalThis.__debugCalls = 0; console.debug = () => { globalThis.__debugCalls += 1; };");
  await bg.dispatch({ type: "EXPLAIN", text: "bank", queryId: "q4" }, contentScriptSender());
  await bg.dispatch({ type: "EXPLAIN", text: "jj", queryId: "q5" }, contentScriptSender());
  assert.equal(evalIn(bg.context, "__debugCalls"), 0);
  assert.equal(evalIn(bg.context, "ZEH_DEBUG_LOGS"), false);
  const ctx = loadConfig();
  evalIn(ctx, "globalThis.__n = 0; console.debug = () => { globalThis.__n += 1; }; zehDebugLog('x'); zehDebugLog('y', {});");
  assert.equal(evalIn(ctx, "__n"), 0);
});
