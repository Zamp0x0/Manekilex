/**
 * Pure lookup-lifecycle helpers in config.js (timeout, de-duplication, terminal
 * messages, result sanitising). Run with: npm test
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig, evalIn, sleep } = require("./helpers/extension-sandbox");

const cfg = loadConfig();

test("provider timeout is per query type and the page-side timeout is always longer", () => {
  for (const qt of ["word", "phrase", "code_term", "sentence", "paragraph", "unknown"]) {
    const provider = cfg.zehLookupProviderTimeoutMs(qt);
    const client = cfg.zehLookupClientTimeoutMs(qt);
    assert.ok(provider > 0, `${qt} provider timeout`);
    assert.ok(client > provider, `${qt}: client ${client} must exceed provider ${provider}`);
  }
  assert.equal(cfg.zehLookupProviderTimeoutMs("unknown"), cfg.zehLookupProviderTimeoutMs("word"));
});

test("zehCreateTimeoutSignal aborts after the deadline and reports timedOut()", async () => {
  const t = cfg.zehCreateTimeoutSignal(20);
  assert.equal(t.signal.aborted, false);
  assert.equal(t.timedOut(), false);
  await sleep(40);
  assert.equal(t.signal.aborted, true);
  assert.equal(t.timedOut(), true);
});

test("zehCreateTimeoutSignal cleanup() prevents a late abort", async () => {
  const t = cfg.zehCreateTimeoutSignal(20);
  t.cleanup();
  await sleep(40);
  assert.equal(t.signal.aborted, false);
  assert.equal(t.timedOut(), false);
});

test("timeout errors carry the LOOKUP_TIMEOUT code", () => {
  const err = cfg.zehLookupTimeoutError(20000, "DeepSeek");
  assert.equal(err.code, evalIn(cfg, "ZEH_LOOKUP_TIMEOUT_CODE"));
  assert.match(err.message, /DeepSeek/);
  assert.match(err.message, /20s/);
});

test("zehShareInflightLookup: waiters share the leader's rejection, then the key is freed", async () => {
  const map = new Map();
  let calls = 0;
  const factory = () => {
    calls += 1;
    return Promise.reject(new Error("provider down"));
  };
  const a = cfg.zehShareInflightLookup(map, "k", factory);
  const b = cfg.zehShareInflightLookup(map, "k", factory);
  assert.equal(a.leader, true);
  assert.equal(b.leader, false);
  assert.equal(a.promise, b.promise);

  const [oa, ob] = await Promise.all([
    cfg.zehSettleLookupOutcome(a.promise),
    cfg.zehSettleLookupOutcome(b.promise),
  ]);
  assert.equal(calls, 1);
  assert.equal(oa.status, "error");
  assert.equal(ob.status, "error");
  assert.equal(ob.error.message, "provider down");

  await sleep(0);
  assert.equal(map.has("k"), false, "a failed lookup must not stay pending");
  const c = cfg.zehShareInflightLookup(map, "k", () => Promise.resolve({ data: {} }));
  assert.equal(c.leader, true, "the next lookup retries instead of joining a dead promise");
  await c.promise;
});

test("zehShareInflightLookup: a synchronous throw in the factory is still a rejection", async () => {
  const map = new Map();
  const { promise } = cfg.zehShareInflightLookup(map, "k", () => {
    throw new Error("boom");
  });
  const outcome = await cfg.zehSettleLookupOutcome(promise);
  assert.equal(outcome.status, "error");
  await sleep(0);
  assert.equal(map.size, 0);
});

test("zehSettleLookupOutcome classifies ok / fallback / error", async () => {
  assert.equal((await cfg.zehSettleLookupOutcome(Promise.resolve({ data: {} }))).status, "ok");
  assert.equal(
    (await cfg.zehSettleLookupOutcome(Promise.resolve({ fallback: true }))).status,
    "fallback"
  );
  assert.equal((await cfg.zehSettleLookupOutcome(Promise.reject(new Error("x")))).status, "error");
});

test("zehLookupOutcomeMessage: every outcome without a dictionary hit is terminal", () => {
  const ctx = { queryId: "q1", queryType: "sentence", hasDictEntry: false };

  const ok = cfg.zehLookupOutcomeMessage(
    { status: "ok", result: { data: { translation: "你好" }, durationMs: 5, providerName: "P" } },
    ctx
  );
  assert.equal(ok.type, "SHOW_RESULT");
  assert.equal(ok.queryId, "q1");
  assert.equal(ok.data.translation, "你好");

  const fb = cfg.zehLookupOutcomeMessage(
    { status: "fallback", result: { fallback: true, term: "t", rawText: "" } },
    ctx
  );
  assert.equal(fb.type, "SHOW_RESULT");
  assert.equal(fb.fallback, true);
  assert.ok(fb.data.rawText, "fallback always carries text to show");

  const err = cfg.zehLookupOutcomeMessage({ status: "error", error: new Error("HTTP 500") }, ctx);
  assert.equal(err.type, "SHOW_ERROR");
  assert.equal(err.queryId, "q1");
  assert.equal(err.message, evalIn(cfg, "ZEH_LOOKUP_GENERIC_ERROR_MESSAGE"));

  const timeout = cfg.zehLookupOutcomeMessage(
    { status: "error", error: cfg.zehLookupTimeoutError(30000, "Groq") },
    ctx
  );
  assert.equal(timeout.type, "SHOW_ERROR");
  assert.match(timeout.message, /超时/);
});

test("zehLookupOutcomeMessage: with a dictionary hit already shown, only success updates the page", () => {
  const ctx = { queryId: "q1", queryType: "word", hasDictEntry: true };
  const ok = cfg.zehLookupOutcomeMessage(
    { status: "ok", result: { data: {}, providerName: "P", modelName: "m", durationMs: 9 } },
    ctx
  );
  assert.equal(ok.type, "DICT_ENHANCED");
  assert.equal(cfg.zehLookupOutcomeMessage({ status: "fallback", result: {} }, ctx), null);
  assert.equal(cfg.zehLookupOutcomeMessage({ status: "error", error: new Error("x") }, ctx), null);
});

test("zehSanitizeLookupResult tolerates null / non-object results", () => {
  for (const bad of [null, undefined, "text", 42, [1, 2]]) {
    const out = cfg.zehSanitizeLookupResult(bad);
    assert.equal(typeof out, "object");
    assert.equal(Array.isArray(out), false);
  }
});

test("zehSanitizeLookupResult removes null list items and normalises tag lists", () => {
  const out = cfg.zehSanitizeLookupResult({
    term: "x",
    difficult_phrases: [null, "plain", { phrase: "p", meaning: "m" }, 3],
    examples: [null, { en: "a", zh: "b" }, "str"],
    key_phrases: [null, "k", { phrase: "obj" }],
    common_collocations: "single",
    breakdown: null,
    related_terms: [undefined, "r"],
    example: "not-an-object",
  });
  assert.deepEqual(JSON.parse(JSON.stringify(out.difficult_phrases)), [
    "plain",
    { phrase: "p", meaning: "m" },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(out.examples)), [{ en: "a", zh: "b" }]);
  assert.deepEqual(JSON.parse(JSON.stringify(out.key_phrases)), ["k", "obj"]);
  assert.deepEqual(JSON.parse(JSON.stringify(out.common_collocations)), ["single"]);
  assert.equal("breakdown" in out, false);
  assert.deepEqual(JSON.parse(JSON.stringify(out.related_terms)), ["r"]);
  assert.equal("example" in out, false);
  assert.equal(out.term, "x");
});

test("zehSanitizeLookupResult leaves well-formed results unchanged", () => {
  const good = {
    term: "run",
    short_meaning: "跑",
    examples: [{ en: "I run.", zh: "我跑。" }],
    common_collocations: ["run fast"],
    queryType: "word",
  };
  assert.deepEqual(JSON.parse(JSON.stringify(cfg.zehSanitizeLookupResult(good))), good);
});
