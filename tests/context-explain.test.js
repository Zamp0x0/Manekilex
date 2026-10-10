/**
 * Phase 3: EXPLAIN with a context sentence, in the real service worker.
 * - dictionary miss → one contextual provider request (term + sentence only)
 * - dictionary / generic-cache hit → result immediately, then CONTEXT_ENHANCED
 * - enhancement failures never replace the shown result with an error
 * - old callers without context behave exactly as before
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadConfig,
  loadBackground,
  evalIn,
  waitFor,
  sleep,
  hangingFetch,
  jsonResponse,
  openAIChatResponse,
} = require("./helpers/extension-sandbox");

const cfg = loadConfig();
const FINANCE = { sentence: "The bank approved my loan.", sourceType: "web" };
const RIVER = { sentence: "We sat on the bank of the river.", sourceType: "web" };

const DICTIONARY = {
  bank: {
    term: "bank",
    short_meaning: "银行；河岸",
    part_of_speech: "n.",
    examples: [{ en: "She works at a bank.", zh: "她在银行工作。" }],
    enriched: true,
  },
};

const WITH_KEY = {
  zehActiveProvider: "deepseek",
  zehProviders: { deepseek: { enabled: true, apiKey: "test-key", model: "" } },
};
const NO_KEY = {
  zehActiveProvider: "deepseek",
  zehProviders: { deepseek: { enabled: true, apiKey: "" } },
};

function explain(bg, { text = "bank", queryId = "q1", tabId = 1, context, queryType } = {}) {
  const message = { type: "EXPLAIN", text, queryId };
  if (queryType) message.queryType = queryType;
  if (context !== undefined) message.context = context;
  return bg.dispatch(message, { tab: { id: tabId } });
}

const forTab = (bg, tabId, type) =>
  bg.tabMessages.filter((m) => m.tabId === tabId && (!type || m.message.type === type)).map((m) => m.message);

function requestBody(bg, index = 0) {
  return JSON.parse(bg.fetchCalls[index].init.body);
}

function lookupReply(meaningHere, extra) {
  return openAIChatResponse(
    JSON.stringify({
      term: "bank",
      phonetic: "/bæŋk/",
      part_of_speech: "n.",
      short_meaning: "银行；河岸",
      meaning_here: meaningHere,
      pos_here: "名词",
      sentence_translation: "译文",
      examples: [{ en: "The bank lent us money.", zh: "银行借钱给我们。" }],
      ...(extra || {}),
    })
  );
}

function enhanceReply(meaningHere) {
  return openAIChatResponse(
    JSON.stringify({
      meaning_here: meaningHere,
      pos_here: "名词",
      sentence_translation: "银行批准了我的贷款。",
      examples: [{ en: "The bank raised its rates.", zh: "银行提高了利率。" }],
    })
  );
}

// ── dictionary miss: contextual provider lookup ─────────────────────────────

test("dictionary miss with context: one request carrying the term and the sentence only", async () => {
  const bg = loadBackground({ storage: WITH_KEY, fetch: async () => lookupReply("此处指金融机构：银行") });
  const res = await explain(bg, { context: { ...FINANCE, nearbyText: "I needed money. The bank approved my loan." } });
  assert.equal(res.accepted, true);
  await waitFor(() => forTab(bg, 1, "SHOW_RESULT").length, 2000, "result");

  const body = requestBody(bg);
  const [system, user] = body.messages;
  assert.equal(system.content, evalIn(bg.context, "ZEH_WORD_CONTEXT_PROMPT"));
  assert.deepEqual(JSON.parse(user.content), {
    term: "bank",
    sentence: "The bank approved my loan.",
    nearby: "I needed money. The bank approved my loan.",
  });
  assert.equal(body.max_tokens, 1000); // 0.11.1: room for mnemonic, derivatives and synonyms in the same call
  const sent = bg.fetchCalls[0].init.body;
  assert.doesNotMatch(sent, /example\.test|https?:\/\/(?!api)|sourceType|pageTitle/);

  const [shown] = forTab(bg, 1, "SHOW_RESULT");
  assert.equal(shown.queryId, "q1");
  assert.equal(shown.data.meaning_here, "此处指金融机构：银行");
  assert.equal(shown.data.short_meaning, "银行；河岸");
  assert.equal(forTab(bg, 1, "CONTEXT_ENHANCED").length, 0, "a full contextual lookup needs no second step");

  const contextKey = cfg.zehContextCacheStorageKey("word", "bank", {
    ...FINANCE,
    nearbyText: "I needed money. The bank approved my loan.",
  });
  assert.ok(bg.local.data[contextKey], "cached under the contextual key");
  const genericKey = cfg.zehCacheV2StorageKey("word", 4, cfg.zehCacheTextHash("word", "bank"));
  assert.equal(bg.local.data[genericKey], undefined, "no contextual meaning in the generic cache");
});

test("same word, different sentence: separate requests; same sentence again: contextual cache hit", async () => {
  let n = 0;
  const bg = loadBackground({
    storage: WITH_KEY,
    fetch: async () => {
      n += 1;
      return lookupReply(n === 1 ? "银行" : "河岸");
    },
  });
  await explain(bg, { queryId: "a", context: FINANCE });
  await waitFor(() => forTab(bg, 1, "SHOW_RESULT").length === 1, 2000, "finance");
  await explain(bg, { queryId: "b", context: RIVER });
  await waitFor(() => forTab(bg, 1, "SHOW_RESULT").length === 2, 2000, "river");
  assert.equal(bg.fetchCalls.length, 2, "river must not reuse the finance result");
  assert.equal(forTab(bg, 1, "SHOW_RESULT")[1].data.meaning_here, "河岸");

  await explain(bg, { queryId: "c", context: { sentence: "the BANK approved  my loan.", sourceType: "web" } });
  await waitFor(() => forTab(bg, 1, "SHOW_RESULT").length === 3, 2000, "cached finance");
  const third = forTab(bg, 1, "SHOW_RESULT")[2];
  assert.equal(bg.fetchCalls.length, 2, "equivalent context is served from cache");
  assert.equal(third.fromCache, true);
  assert.equal(third.data.meaning_here, "银行");
  assert.equal(third.contextHash, cfg.zehLookupContextHash(FINANCE));
});

test("no context (old callers): the original prompt and plain selected text", async () => {
  const bg = loadBackground({
    storage: WITH_KEY,
    fetch: async () => openAIChatResponse(JSON.stringify({ term: "bank", short_meaning: "银行" })),
  });
  await explain(bg);
  await waitFor(() => forTab(bg, 1, "SHOW_RESULT").length, 2000, "result");
  const body = requestBody(bg);
  assert.equal(body.messages[0].content, evalIn(bg.context, 'zehBuildSystemPrompt("word")'));
  assert.equal(body.messages[1].content, "bank");
  assert.equal(body.max_tokens, evalIn(bg.context, 'zehMaxTokens("word", 4)'));
  const genericKey = cfg.zehCacheV2StorageKey("word", 4, cfg.zehCacheTextHash("word", "bank"));
  assert.ok(bg.local.data[genericKey], "generic cache as before");
});

test("phrase with context uses the phrase prompt", async () => {
  const bg = loadBackground({
    storage: WITH_KEY,
    fetch: async () => openAIChatResponse(JSON.stringify({ term: "look up", short_meaning: "查阅", meaning_here: "查字典" })),
  });
  await explain(bg, {
    text: "look up",
    context: { sentence: "Please look up the word before class.", sourceType: "web" },
  });
  await waitFor(() => forTab(bg, 1, "SHOW_RESULT").length, 2000, "result");
  const body = requestBody(bg);
  assert.equal(body.messages[0].content, evalIn(bg.context, "ZEH_PHRASE_CONTEXT_PROMPT"));
  assert.equal(JSON.parse(body.messages[1].content).term, "look up");
  assert.equal(body.max_tokens, 1000);
});

test("sentence lookups ignore any context field", async () => {
  const text = "The committee postponed the vote until the next quarterly meeting.";
  const bg = loadBackground({
    storage: WITH_KEY,
    fetch: async () => openAIChatResponse(JSON.stringify({ translation: "委员会推迟了投票。" })),
  });
  await explain(bg, { text, context: { sentence: text, sourceType: "web" } });
  await waitFor(() => forTab(bg, 1, "SHOW_RESULT").length, 2000, "result");
  const body = requestBody(bg);
  assert.match(body.messages[1].content, /^The committee postponed the vote/, "plain sentence, not a JSON payload");
  assert.equal(body.messages[0].content, evalIn(bg.context, 'zehBuildSystemPrompt("sentence")'));
  const cacheKeys = () => Object.keys(bg.local.data).filter((k) => k.startsWith("zehCache:v2:sentence:"));
  await waitFor(() => cacheKeys().length, 2000, "generic sentence cache");
  assert.deepEqual(cacheKeys().filter((k) => /:c[0-9a-f]{8}$/.test(k)), [], "no contextual key for sentences");
});

test("the service worker re-validates context: bounded, whitelisted, unusable → plain lookup", async () => {
  const bg = loadBackground({ storage: WITH_KEY, fetch: async () => lookupReply("银行") });
  const long = `${"very ".repeat(200)}the bank approved my loan ${"again ".repeat(400)}`;
  await explain(bg, {
    queryId: "a",
    context: { sentence: long, nearbyText: long + long, sourceType: "javascript:", pageUrl: "https://secret.test", title: "Private" },
  });
  await waitFor(() => bg.fetchCalls.length === 1, 2000, "first request");
  const user = JSON.parse(requestBody(bg, 0).messages[1].content);
  assert.deepEqual(Object.keys(user).sort(), ["nearby", "sentence", "term"].filter((k) => k in user).sort());
  assert.ok(user.sentence.length <= 400 && user.sentence.includes("bank approved"));
  assert.ok(!user.nearby || user.nearby.length <= 600);
  assert.doesNotMatch(bg.fetchCalls[0].init.body, /secret\.test|Private|javascript:/);

  // a sentence that does not contain the term is not context
  await explain(bg, { queryId: "b", text: "loan", context: { sentence: "We sat on the bank of the river." } });
  await waitFor(() => bg.fetchCalls.length === 2, 2000, "second request");
  assert.equal(requestBody(bg, 1).messages[1].content, "loan");

  // malformed context values are ignored
  const malformed = [
    ["mortgage", "The mortgage was approved yesterday."],
    ["deposit", ["x"]],
    ["interest", { sentence: 42 }],
    ["account", null],
  ];
  for (const [text, context] of malformed) {
    bg.fetchCalls.length = 0;
    await explain(bg, { queryId: `m-${text}`, text, context });
    await waitFor(() => bg.fetchCalls.length === 1, 2000, `malformed context request (${text})`);
    assert.equal(requestBody(bg, 0).messages[1].content, text);
  }
});

// ── dictionary hit: show now, enhance in place ──────────────────────────────

test("dictionary hit with context: immediate dictionary result, then CONTEXT_ENHANCED for the same query", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const bg = loadBackground({
    storage: WITH_KEY,
    dictionary: DICTIONARY,
    fetch: async () => {
      await gate;
      return enhanceReply("此处指金融机构：银行");
    },
  });
  await explain(bg, { queryId: "q7", context: FINANCE });
  await waitFor(() => forTab(bg, 1, "SHOW_RESULT").length, 2000, "dictionary result");
  const [shown] = forTab(bg, 1, "SHOW_RESULT");
  assert.equal(shown.fromDict, true);
  assert.equal(shown.contextPending, true);
  assert.equal(shown.data.short_meaning, "银行；河岸");
  assert.equal(forTab(bg, 1, "CONTEXT_ENHANCED").length, 0, "enhancement still running");

  await waitFor(() => bg.fetchCalls.length === 1, 2000, "enhance request");
  const body = requestBody(bg);
  assert.equal(body.messages[0].content, evalIn(bg.context, "ZEH_CONTEXT_ENHANCE_PROMPT"));
  assert.deepEqual(JSON.parse(body.messages[1].content), {
    term: "bank",
    basic_meaning: "银行；河岸",
    sentence: "The bank approved my loan.",
  });
  assert.equal(body.max_tokens, 800); // 0.11.1: one enhancement call now also fills the lexical fields

  release();
  await waitFor(() => forTab(bg, 1, "CONTEXT_ENHANCED").length, 2000, "enhancement");
  const [enhanced] = forTab(bg, 1, "CONTEXT_ENHANCED");
  assert.equal(enhanced.queryId, "q7");
  assert.equal(enhanced.ok, true);
  assert.equal(enhanced.contextHash, cfg.zehLookupContextHash(FINANCE));
  assert.equal(enhanced.data.meaning_here, "此处指金融机构：银行");
  assert.equal(enhanced.data.sentence_translation, "银行批准了我的贷款。");
  assert.equal(forTab(bg, 1, "SHOW_ERROR").length, 0);
  assert.equal(forTab(bg, 1, "SHOW_RESULT").length, 1, "the panel is not re-rendered");

  const cached = bg.local.data[cfg.zehContextCacheStorageKey("word", "bank", FINANCE)];
  assert.equal(cached.data.short_meaning, "银行；河岸", "dictionary meaning kept");
  assert.equal(cached.data.meaning_here, "此处指金融机构：银行");

  // the same sentence again is answered from the contextual cache with no request
  await explain(bg, { queryId: "q8", context: FINANCE });
  await waitFor(() => forTab(bg, 1, "SHOW_RESULT").length === 2, 2000, "cached");
  assert.equal(forTab(bg, 1, "SHOW_RESULT")[1].data.meaning_here, "此处指金融机构：银行");
  assert.equal(bg.fetchCalls.length, 1);
});

test("dictionary hit without context, or without an API key: no enhancement request", async () => {
  const noContext = loadBackground({ storage: WITH_KEY, dictionary: DICTIONARY, fetch: hangingFetch });
  await explain(noContext);
  await waitFor(() => forTab(noContext, 1, "SHOW_RESULT").length, 2000, "dictionary result");
  await sleep(20);
  assert.equal(forTab(noContext, 1, "SHOW_RESULT")[0].contextPending, false);
  assert.equal(noContext.fetchCalls.length, 0);
  assert.equal(forTab(noContext, 1, "CONTEXT_ENHANCED").length, 0);

  const noKey = loadBackground({ storage: NO_KEY, dictionary: DICTIONARY, fetch: hangingFetch });
  await explain(noKey, { context: FINANCE });
  await waitFor(() => forTab(noKey, 1, "SHOW_RESULT").length, 2000, "dictionary result");
  await sleep(20);
  assert.equal(forTab(noKey, 1, "SHOW_RESULT")[0].contextPending, false);
  assert.equal(noKey.fetchCalls.length, 0);
  assert.equal(forTab(noKey, 1, "CONTEXT_ENHANCED").length, 0);
});

test("enhancement failures report ok:false (error / unparseable / timeout) and never SHOW_ERROR", async () => {
  const cases = [
    { reason: "error", fetch: async () => jsonResponse(500, { error: { message: "boom" } }) },
    { reason: "error", fetch: async () => { throw new TypeError("Failed to fetch"); } },
    { reason: "unparseable", fetch: async () => openAIChatResponse("not json at all") },
    { reason: "unparseable", fetch: async () => openAIChatResponse(JSON.stringify({ pos_here: "n." })) },
    { reason: "timeout", fetch: hangingFetch },
  ];
  for (const { reason, fetch } of cases) {
    const bg = loadBackground({ storage: WITH_KEY, dictionary: DICTIONARY, fetch });
    evalIn(bg.context, "ZEH_LOOKUP_PROVIDER_TIMEOUT_MS.word = 60");
    await explain(bg, { queryId: "qf", context: FINANCE });
    await waitFor(() => forTab(bg, 1, "CONTEXT_ENHANCED").length, 3000, `enhancement (${reason})`);
    const [msg] = forTab(bg, 1, "CONTEXT_ENHANCED");
    assert.equal(msg.ok, false, reason);
    assert.equal(msg.reason, reason);
    assert.equal(msg.queryId, "qf");
    assert.equal(forTab(bg, 1, "SHOW_ERROR").length, 0, `${reason}: the dictionary result stays`);
    assert.equal(forTab(bg, 1, "SHOW_RESULT").length, 1);
    assert.equal(bg.local.data[cfg.zehContextCacheStorageKey("word", "bank", FINANCE)], undefined, "failures are not cached");
  }
});

test("identical enhancements from two tabs share one request; each tab gets its own message", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const bg = loadBackground({
    storage: WITH_KEY,
    dictionary: DICTIONARY,
    fetch: async () => {
      await gate;
      return enhanceReply("银行");
    },
  });
  await Promise.all([
    explain(bg, { tabId: 1, queryId: "a", context: FINANCE }),
    explain(bg, { tabId: 2, queryId: "b", context: { ...FINANCE, sourceType: "iframe" } }),
  ]);
  await sleep(20);
  assert.equal(bg.fetchCalls.length, 1, "no duplicate in-flight context request");
  release();
  await waitFor(
    () => forTab(bg, 1, "CONTEXT_ENHANCED").length && forTab(bg, 2, "CONTEXT_ENHANCED").length,
    2000,
    "both tabs"
  );
  assert.equal(forTab(bg, 1, "CONTEXT_ENHANCED")[0].queryId, "a");
  assert.equal(forTab(bg, 2, "CONTEXT_ENHANCED")[0].queryId, "b");
  assert.equal(forTab(bg, 2, "CONTEXT_ENHANCED")[0].data.meaning_here, "银行");
});

test("different contexts for the same word are never merged into one request", async () => {
  const bg = loadBackground({
    storage: WITH_KEY,
    dictionary: DICTIONARY,
    fetch: async (_url, init) =>
      enhanceReply(JSON.parse(JSON.parse(init.body).messages[1].content).sentence.includes("river") ? "河岸" : "银行"),
  });
  await Promise.all([
    explain(bg, { tabId: 1, queryId: "a", context: FINANCE }),
    explain(bg, { tabId: 2, queryId: "b", context: RIVER }),
  ]);
  await waitFor(
    () => forTab(bg, 1, "CONTEXT_ENHANCED").length && forTab(bg, 2, "CONTEXT_ENHANCED").length,
    2000,
    "both tabs"
  );
  assert.equal(bg.fetchCalls.length, 2);
  assert.equal(forTab(bg, 1, "CONTEXT_ENHANCED")[0].data.meaning_here, "银行");
  assert.equal(forTab(bg, 2, "CONTEXT_ENHANCED")[0].data.meaning_here, "河岸");
});

test("generic cache hit with context: cached result now, contextual enhancement next", async () => {
  const bg = loadBackground({ storage: WITH_KEY, fetch: async () => enhanceReply("河岸") });
  await sleep(20);
  bg.context.__generic = { queryType: "word", term: "bank", short_meaning: "银行；河岸" };
  await evalIn(bg.context, `setCacheLookup("word", "bank", __generic, { id: "deepseek" })`);

  await explain(bg, { queryId: "g1", context: RIVER });
  await waitFor(() => forTab(bg, 1, "CONTEXT_ENHANCED").length, 2000, "enhancement");
  const [shown] = forTab(bg, 1, "SHOW_RESULT");
  assert.equal(shown.fromCache, true);
  assert.equal(shown.contextPending, true);
  assert.equal(shown.data.meaning_here, undefined);
  assert.equal(JSON.parse(requestBody(bg).messages[1].content).basic_meaning, "银行；河岸");
  assert.equal(forTab(bg, 1, "CONTEXT_ENHANCED")[0].data.meaning_here, "河岸");

  // no API key any more: the generic hit is shown without a pending context state
  bg.local.data.zehProviders = { deepseek: { enabled: true, apiKey: "" } };
  await explain(bg, { queryId: "g2", context: FINANCE });
  await waitFor(() => forTab(bg, 1, "SHOW_RESULT").length === 2, 2000, "second result");
  assert.equal(forTab(bg, 1, "SHOW_RESULT")[1].contextPending, false);
});
