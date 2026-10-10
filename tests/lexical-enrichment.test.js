/**
 * 0.11.1 lexical enrichment: one async enhancement fills meaning here, sentence translation,
 * mnemonic, derivatives and synonyms; a conservative quality gate hides junk legacy mnemonics;
 * the panel updates in place in the agreed order; vocabulary / Settings keep the new fields.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const {
  loadConfig,
  loadBackground,
  createStorageArea,
  createEvent,
  evalIn,
  waitFor,
  sleep,
  hangingFetch,
  openAIChatResponse,
} = require("./helpers/extension-sandbox");
const {
  createRange,
  createSelection,
  loadLookupController,
  disposeLookupControllers,
} = require("./helpers/fake-dom");
const { loadSettingsPage } = require("./helpers/settings-page");

test.afterEach(() => disposeLookupControllers());

const cfg = loadConfig();
const plain = (value) => JSON.parse(JSON.stringify(value));
const VOCAB = "zehVocabulary";

const FINANCE = { sentence: "The bank approved my loan.", sourceType: "web" };
const RIVER = { sentence: "We sat on the bank of the river.", sourceType: "web" };

const WITH_KEY = {
  zehActiveProvider: "deepseek",
  zehProviders: { deepseek: { enabled: true, apiKey: "test-key", model: "" } },
};
const NO_KEY = {
  zehActiveProvider: "deepseek",
  zehProviders: { deepseek: { enabled: true, apiKey: "" } },
};

const BAD_TIP = "联想：b（不）+ ank（谐音“安克”）→ 不安克的地方是银行";
const GOOD_TIP = "银行（bank）存钱，河岸（bank）靠水：同一个词两个常用义项。";

const DICTIONARY = {
  bank: { term: "bank", short_meaning: "银行；河岸", part_of_speech: "n.", memory_tip: BAD_TIP, enriched: true },
  decide: {
    term: "decide",
    short_meaning: "决定",
    part_of_speech: "v.",
    memory_tip: "de-（加强）+ cide（切）→ 一刀切下去，就是做决定",
    enriched: true,
  },
};

const ENHANCEMENT = {
  meaning_here: "此处指金融机构：银行",
  pos_here: "名词",
  sentence_translation: "银行批准了我的贷款。",
  memory_tip: "bank 原指钱商的长凳（意大利语 banca），引申为银行。",
  memory_tip_type: "etymology",
  derivatives: [
    { word: "banker", pos: "n.", zh: "银行家" },
    { word: "banking", pos: "n.", zh: "银行业" },
    { word: "banks", pos: "n.", zh: "银行（复数）" },
    { word: "Bank", pos: "n.", zh: "银行" },
  ],
  synonyms: [
    { word: "lender", zh: "放贷方", nuance: "强调借钱给别人" },
    { word: "financial institution", zh: "金融机构", nuance: "更正式" },
    { word: "bank", zh: "银行" },
  ],
  examples: [{ en: "The bank raised its rates.", zh: "银行提高了利率。" }],
};

function explain(bg, { text = "bank", queryId = "q1", context } = {}) {
  const message = { type: "EXPLAIN", text, queryId };
  if (context !== undefined) message.context = context;
  return bg.dispatch(message, { tab: { id: 1 } });
}

const forTab = (bg, type) => bg.tabMessages.filter((m) => m.message.type === type).map((m) => m.message);

// ── quality gate ────────────────────────────────────────────────────────────

test("mnemonic gate rejects only obvious junk and keeps real morphology", () => {
  const rejected = [
    ["bank", "ban + k"],
    ["award", "联想：a（一个）+ ward（守卫）→ 守卫获得一个奖章。"],
    ["address", "a+ddress（穿衣）→ 穿好衣服去找地址"],
    ["river", "想象一条蜿蜒的河流在流淌，记住字母 'r' 像河岸。"],
    ["bank", "bank"],
    ["bank", "b-a-n-k"],
    ["f", "像一根拐杖"],
    ["bank", "暂无"],
    ["bank", "TODO"],
    ["bank", ""],
  ];
  const kept = [
    ["decide", "de-（加强）+ cide（切）→ 一刀切下去，就是做决定"],
    ["benevolent", "bene-（好）+ volent（意愿）→ 好意的，仁慈的"],
    ["additions", "add + ition + s（复数）→ 加上的东西"],
    ["aged", "age + d → 上了年纪的"],
    ["bank", GOOD_TIP],
    ["eject", "e（出）+ ject（扔）→ 扔出去，弹出"],
    ["discovery", "dis-（分开）+ cover（覆盖）+ y → 揭开覆盖物 → 发现"],
  ];
  rejected.forEach(([term, tip]) => assert.equal(cfg.zehIsUsefulMemoryTip(tip, term), false, `${term}: ${tip}`));
  kept.forEach(([term, tip]) => assert.equal(cfg.zehIsUsefulMemoryTip(tip, term), true, `${term}: ${tip}`));
  assert.equal(cfg.zehIsUsefulMemoryTip("银行；河岸", "bank", "银行；河岸"), false, "only repeats the definition");

  assert.deepEqual(plain(cfg.zehNormalizeMemoryTip(GOOD_TIP, "contrast", "bank")), {
    memory_tip: GOOD_TIP,
    memory_tip_type: "contrast",
  });
  assert.deepEqual(plain(cfg.zehNormalizeMemoryTip(GOOD_TIP, "made-up", "bank")), { memory_tip: GOOD_TIP, memory_tip_type: "" });
  assert.deepEqual(plain(cfg.zehNormalizeMemoryTip("ban + k", "morphology", "bank")), { memory_tip: "", memory_tip_type: "none" });
  assert.deepEqual(plain(cfg.zehNormalizeMemoryTip(GOOD_TIP, "none", "bank")), { memory_tip: "", memory_tip_type: "none" });
});

test("derivatives and synonyms: real entries only, deduped, capped, no trivial plural / case variants", () => {
  const derivatives = cfg.zehSanitizeDerivatives(
    [
      ...ENHANCEMENT.derivatives,
      { word: "banker", pos: "n.", zh: "重复" },
      { word: "bankrupt", zh: "破产的" },
      { word: "bankable", pos: "adj.", zh: "可赚钱的" },
      { word: "bankroll", pos: "v.", zh: "资助" },
      { word: "banknote", pos: "n.", zh: "钞票" },
      { word: "<b>x</b>", zh: "坏数据" },
      { word: "bankless", zh: "" },
      null,
      "banker",
    ],
    "bank"
  );
  assert.deepEqual(plain(derivatives).map((d) => d.word), ["banker", "banking", "bankrupt", "bankable", "bankroll"]);
  assert.deepEqual(plain(derivatives[2]), { word: "bankrupt", zh: "破产的" });

  const synonyms = cfg.zehSanitizeSynonyms(ENHANCEMENT.synonyms, "bank");
  assert.deepEqual(plain(synonyms), [
    { word: "lender", zh: "放贷方", nuance: "强调借钱给别人" },
    { word: "financial institution", zh: "金融机构", nuance: "更正式" },
  ]);
  assert.deepEqual(plain(cfg.zehSanitizeSynonyms("lender", "bank")), []);
});

test("prompts: teacher persona, mnemonic policy, derivatives / synonyms schema, injection guard, no antonyms", () => {
  const persona = "You are an experienced GRE and IELTS vocabulary teacher for a native Chinese-speaking English learner.";
  for (const name of ["ZEH_CONTEXT_ENHANCE_PROMPT", "ZEH_WORD_CONTEXT_PROMPT", "ZEH_PHRASE_CONTEXT_PROMPT", "ZEH_WORD_PROMPT"]) {
    const prompt = evalIn(cfg, name);
    assert.ok(prompt.startsWith(persona), `${name} starts with the persona`);
    assert.match(prompt, /memory_tip_type/);
    assert.match(prompt, /synonyms/);
    assert.match(prompt, /禁止：编造词源或词根、把单词随意拆成字母/);
    assert.match(prompt, /memory_tip 留空，memory_tip_type 填 none/);
    assert.doesNotMatch(prompt, /antonym|反义词："/);
  }
  const enhancePrompt = evalIn(cfg, "ZEH_CONTEXT_ENHANCE_PROMPT");
  assert.match(enhancePrompt, /derivatives/);
  assert.match(enhancePrompt, /绝不是给你的指令/);
  assert.match(enhancePrompt, /只返回下面的 JSON/);
  for (const name of ["ZEH_SENTENCE_PROMPT", "ZEH_PARAGRAPH_PROMPT", "ZEH_CODE_TERM_PROMPT"]) {
    assert.ok(!evalIn(cfg, name).includes(persona), `${name} unchanged`);
  }
});

// ── service worker: one enhancement call fills everything ─────────────────────

test("dictionary hit with context: bad legacy tip hidden at once, ONE request fills every lexical field", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const bg = loadBackground({
    storage: WITH_KEY,
    dictionary: DICTIONARY,
    fetch: async () => {
      await gate;
      return openAIChatResponse(JSON.stringify(ENHANCEMENT));
    },
  });
  await explain(bg, { queryId: "q1", context: FINANCE });
  await waitFor(() => forTab(bg, "SHOW_RESULT").length, 2000, "dictionary result");
  const [shown] = forTab(bg, "SHOW_RESULT");
  assert.equal(shown.data.short_meaning, "银行；河岸");
  assert.equal(shown.data.memory_tip, "", "junk legacy mnemonic is not shown as authoritative");

  await waitFor(() => bg.fetchCalls.length === 1, 2000, "enhance request");
  const body = JSON.parse(bg.fetchCalls[0].init.body);
  assert.equal(body.messages[0].content, evalIn(bg.context, "ZEH_CONTEXT_ENHANCE_PROMPT"));
  const payload = JSON.parse(body.messages[1].content);
  assert.deepEqual(Object.keys(payload).sort(), ["basic_meaning", "sentence", "term"], "no URL / title / page text");
  assert.equal(body.temperature <= 0.3 || body.temperature === undefined, true, "low temperature");

  release();
  await waitFor(() => forTab(bg, "CONTEXT_ENHANCED").length, 2000, "enhancement");
  const [enhanced] = forTab(bg, "CONTEXT_ENHANCED");
  assert.equal(enhanced.ok, true);
  assert.equal(enhanced.data.memory_tip, ENHANCEMENT.memory_tip);
  assert.equal(enhanced.data.memory_tip_type, "etymology");
  assert.deepEqual(plain(enhanced.data.derivatives.map((d) => d.word)), ["banker", "banking"]);
  assert.deepEqual(plain(enhanced.data.synonyms.map((s) => s.word)), ["lender", "financial institution"]);
  assert.equal(bg.fetchCalls.length, 1, "exactly one model call");

  // merged result cached under this sentence: the same sentence again costs zero requests
  const cached = bg.local.data[cfg.zehContextCacheStorageKey("word", "bank", FINANCE)].data;
  assert.equal(cached.memory_tip, ENHANCEMENT.memory_tip);
  assert.equal(cached.derivatives.length, 2);
  assert.equal(cached.synonyms.length, 2);
  await explain(bg, { queryId: "q2", context: FINANCE });
  await waitFor(() => forTab(bg, "SHOW_RESULT").length === 2, 2000, "cached");
  assert.equal(forTab(bg, "SHOW_RESULT")[1].data.synonyms[0].word, "lender");
  assert.equal(bg.fetchCalls.length, 1);
});

test("a good legacy tip is kept and the model is told so (has_memory_tip) ", async () => {
  const bg = loadBackground({
    storage: WITH_KEY,
    dictionary: DICTIONARY,
    fetch: async () =>
      openAIChatResponse(JSON.stringify({ ...ENHANCEMENT, memory_tip: "另一条助记，模型也写了一条。", derivatives: [] })),
  });
  const context = { sentence: "We decide what to cook on Sundays.", sourceType: "web" };
  await explain(bg, { text: "decide", context });
  await waitFor(() => forTab(bg, "CONTEXT_ENHANCED").length, 2000, "enhancement");
  assert.equal(JSON.parse(JSON.parse(bg.fetchCalls[0].init.body).messages[1].content).has_memory_tip, true);
  const cached = bg.local.data[cfg.zehContextCacheStorageKey("word", "decide", context)].data;
  assert.equal(cached.memory_tip, DICTIONARY.decide.memory_tip, "good dictionary mnemonic not overwritten");
});

test("no API key: the dictionary result stays usable, no request, junk tip hidden, good tip shown", async () => {
  const bg = loadBackground({ storage: NO_KEY, dictionary: DICTIONARY, fetch: hangingFetch });
  await explain(bg, { text: "bank", queryId: "a", context: FINANCE });
  await explain(bg, { text: "decide", queryId: "b" });
  await waitFor(() => forTab(bg, "SHOW_RESULT").length === 2, 2000, "dictionary results");
  await sleep(20);
  const [bank, decide] = forTab(bg, "SHOW_RESULT");
  assert.equal(bank.data.short_meaning, "银行；河岸");
  assert.equal(bank.data.memory_tip, "");
  assert.equal(bank.contextPending, false);
  assert.equal(decide.data.memory_tip, DICTIONARY.decide.memory_tip);
  assert.equal(bg.fetchCalls.length, 0);
});

test("merge keeps the basic meaning and a good tip, replaces a bad one, merges derivatives", () => {
  const base = {
    term: "bank",
    short_meaning: "银行；河岸",
    memory_tip: "ban + k",
    derivatives: [{ word: "bankroll", pos: "v.", zh: "资助" }],
    synonyms: [{ word: "shore", zh: "岸" }],
  };
  const enhancement = cfg.zehNormalizeContextEnhancement(ENHANCEMENT, "bank");
  const merged = cfg.zehMergeContextEnhancement(base, enhancement);
  assert.equal(merged.short_meaning, "银行；河岸");
  assert.equal(merged.memory_tip, ENHANCEMENT.memory_tip);
  assert.deepEqual(plain(merged.derivatives.map((d) => d.word)), ["banker", "banking", "bankroll"]);
  assert.deepEqual(plain(merged.synonyms.map((s) => s.word)), ["lender", "financial institution"], "synonyms follow this sense");

  const kept = cfg.zehMergeContextEnhancement({ ...base, memory_tip: GOOD_TIP, memory_tip_type: "contrast" }, enhancement);
  assert.equal(kept.memory_tip, GOOD_TIP);
  assert.equal(kept.memory_tip_type, "contrast");

  const none = cfg.zehMergeContextEnhancement(base, cfg.zehNormalizeContextEnhancement({ meaning_here: "此处", memory_tip: "", memory_tip_type: "none" }, "bank"));
  assert.equal(none.memory_tip, "", "no useful mnemonic → empty, the bad one is not kept");
  assert.equal(cfg.zehNormalizeContextEnhancement({ derivatives: ENHANCEMENT.derivatives }, "bank"), null, "meaning_here required");
});

// ── page: panel order and in-place update ───────────────────────────────────

function setupPage() {
  return loadLookupController({ controllerOptions: { aggressiveBubbleMode: true } });
}

function lookUpInPage(env, text, word = "bank") {
  const p = env.document.createElement("p");
  const node = env.document.createTextNode(text);
  p.appendChild(node);
  env.document.body.appendChild(p);
  const at = text.indexOf(word);
  env.setSelection(createSelection(createRange(node, at, node, at + word.length)));
  const info = env.controller.getSelectionInfo();
  env.controller.presentTrigger({ ...info, releaseX: 40, releaseY: 30 });
  env.document
    .querySelector(".zeh-trigger")
    .dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  return env.explainRequests().at(-1).message;
}

function showDict(env, queryId, data) {
  env.deliver({
    type: "SHOW_RESULT",
    queryId,
    queryType: "word",
    durationMs: 0,
    fromDict: true,
    contextPending: true,
    data: {
      queryType: "word",
      term: "bank",
      part_of_speech: "n.",
      short_meaning: "银行；河岸",
      context_meaning: "金融机构或河流两侧的土地",
      examples: [{ en: "She works at a bank.", zh: "她在银行工作。" }],
      common_collocations: ["bank account"],
      ...(data || {}),
    },
  });
}

function enhancePage(env, queryId, data = ENHANCEMENT) {
  env.deliver({ type: "CONTEXT_ENHANCED", queryId, contextHash: "0", ok: true, data, durationMs: 900, providerName: "DeepSeek", modelName: "deepseek-flash" });
}

test("panel: sections in the agreed order, empty ones hidden, filled in place by the one enhancement", () => {
  const env = setupPage();
  const { queryId } = lookUpInPage(env, "The bank approved my loan. We celebrated.");
  showDict(env, queryId, { memory_tip: "" });
  const panel = env.panel();
  const derivativesEl = panel.querySelector(".zeh-derivatives-section");
  const synonymsEl = panel.querySelector(".zeh-synonyms-section");
  const memoryEl = panel.querySelector(".zeh-memory-section");
  assert.ok(derivativesEl && synonymsEl && memoryEl, "placeholders exist");
  const html = env.panelBodyHtml();
  for (const kind of ["derivatives", "synonyms", "memory"]) {
    assert.match(html, new RegExp(`zeh-${kind}-section"\\s+hidden>`), `empty ${kind} section is hidden`);
  }
  const order = ["基础释义", "当前语境", "用法说明", "zeh-derivatives-section", "zeh-synonyms-section", "例句", "zeh-memory-section", "常见搭配"];
  const positions = order.map((label) => html.indexOf(label));
  positions.forEach((pos, i) => assert.ok(pos >= 0, `${order[i]} rendered`));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "order: 基础释义 → 当前语境 → 用法说明 → 派生词 → 同义词 → 例句 → 助记 → 常见搭配");

  const footer = panel.querySelector(".zeh-panel-footer");
  enhancePage(env, queryId);
  assert.equal(env.panel(), panel, "same panel");
  assert.equal(panel.querySelector(".zeh-panel-footer"), footer, "footer kept");
  assert.equal(derivativesEl.hidden, false);
  assert.match(derivativesEl.innerHTML, /派生词/);
  assert.match(derivativesEl.innerHTML, /banker<\/span> · <span class="zeh-lex-pos">n\.<\/span> 银行家/);
  assert.doesNotMatch(derivativesEl.innerHTML, /banks</, "no trivial plural");
  assert.equal(synonymsEl.hidden, false);
  assert.match(synonymsEl.innerHTML, /lender<\/span> — 放贷方/);
  assert.match(synonymsEl.innerHTML, /强调借钱给别人/);
  assert.equal(memoryEl.hidden, false);
  assert.match(memoryEl.innerHTML, /助记[\s\S]*钱商的长凳/);

  const item = (() => {
    panel.querySelector(".zeh-panel-footer .mk-btn:nth-child(2)").dispatchEvent({ type: "click", stopPropagation() {} });
    return env.messages("ADD_VOCAB").at(-1).message.item;
  })();
  assert.deepEqual(plain(item.derivatives.map((d) => d.word)), ["banker", "banking"]);
  assert.deepEqual(plain(item.synonyms.map((s) => s.word)), ["lender", "financial institution"]);
  assert.equal(item.memory_tip_type, "etymology");
});

test("panel: a stale enhancement never fills the lexical sections of a newer lookup", async () => {
  const env = setupPage();
  const first = lookUpInPage(env, "The bank approved my loan.");
  showDict(env, first.queryId);
  await sleep(380);
  const second = lookUpInPage(env, "We sat on the bank of the river.");
  showDict(env, second.queryId);
  enhancePage(env, first.queryId);
  assert.equal(env.panel().querySelector(".zeh-synonyms-section").innerHTML, "", "still empty");
  assert.doesNotMatch(env.panelBodyHtml(), /lender/);
  enhancePage(env, second.queryId, { meaning_here: "此处指河岸", synonyms: [{ word: "shore", zh: "岸" }], examples: [] });
  assert.match(env.panel().querySelector(".zeh-synonyms-section").innerHTML, /shore/);
});

// ── vocabulary + Settings ───────────────────────────────────────────────────

const SAVED = {
  term: "bank",
  queryType: "word",
  short_meaning: "银行；河岸",
  memory_tip: "ban + k",
  derivatives: [{ word: "banker", pos: "n.", zh: "银行家" }],
  pageUrl: "https://example.test/news",
  context_sentence: "The bank approved my loan.",
  meaning_here: "此处指金融机构：银行",
  synonyms: [{ word: "lender", zh: "放贷方", nuance: "强调借钱给别人" }],
};

test("vocabulary: derivatives on the term, synonyms on the context, good tips kept, bad ones replaced", async () => {
  const bg = loadBackground();
  const first = await bg.dispatch({ type: "ADD_VOCAB", item: SAVED });
  assert.equal(first.added, true);
  let [entry] = bg.local.data[VOCAB];
  assert.equal(entry.memory_tip, "", "junk tip is not stored");
  assert.deepEqual(plain(entry.derivatives), [{ word: "banker", zh: "银行家", pos: "n." }]);
  assert.equal("synonyms" in entry, false, "synonyms live on the context");
  assert.deepEqual(plain(entry.contexts[0].synonyms), [{ word: "lender", zh: "放贷方", nuance: "强调借钱给别人" }]);

  // second sentence: new context with its own synonyms; derivatives merged; empty tip filled
  await bg.dispatch({
    type: "ADD_VOCAB",
    item: {
      ...SAVED,
      memory_tip: GOOD_TIP,
      memory_tip_type: "contrast",
      derivatives: [{ word: "banking", pos: "n.", zh: "银行业" }, { word: "banker", pos: "n.", zh: "银行家" }],
      context_sentence: "We sat on the bank of the river.",
      meaning_here: "此处指河岸",
      synonyms: [{ word: "shore", zh: "岸" }],
    },
  });
  [entry] = bg.local.data[VOCAB];
  assert.equal(entry.memory_tip, GOOD_TIP);
  assert.equal(entry.memory_tip_type, "contrast");
  assert.deepEqual(entry.derivatives.map((d) => d.word), ["banker", "banking"]);
  assert.deepEqual(entry.contexts.map((c) => c.synonyms.map((s) => s.word)), [["lender"], ["shore"]]);

  // the same sentence again with another tip: the good one stays, nothing duplicated
  const again = await bg.dispatch({
    type: "ADD_VOCAB",
    item: { ...SAVED, memory_tip: "另一条完全不同的助记文字。", memory_tip_type: "association" },
  });
  assert.equal(again.reason, "duplicate");
  [entry] = bg.local.data[VOCAB];
  assert.equal(entry.memory_tip, GOOD_TIP);
  assert.equal(entry.contexts.length, 2);
});

test("vocabulary: an old entry with a junk tip gets a good one on the next save without a sentence", async () => {
  const old = { id: "old-1", serial: 1, savedAt: 1700000000001, term: "bank", queryType: "word", short_meaning: "银行", memory_tip: "ban + k" };
  const bg = loadBackground({ storage: { [VOCAB]: [old] } });
  const res = await bg.dispatch({ type: "ADD_VOCAB", item: { term: "bank", queryType: "word", memory_tip: GOOD_TIP, derivatives: [{ word: "banker", zh: "银行家" }] } });
  assert.equal(res.reason, "duplicate");
  assert.equal(res.lexicalUpdated, true);
  const [entry] = bg.local.data[VOCAB];
  assert.equal(entry.memory_tip, GOOD_TIP);
  assert.equal(entry.derivatives[0].word, "banker");
  assert.equal(entry.id, "old-1", "same entry, review state kept");

  // nothing new → no write
  const writes = bg.local.setCalls.filter((keys) => keys.includes(VOCAB)).length;
  await bg.dispatch({ type: "ADD_VOCAB", item: { term: "bank", queryType: "word", memory_tip: "ban + k" } });
  assert.equal(bg.local.setCalls.filter((keys) => keys.includes(VOCAB)).length, writes);
});

async function loadSettingsWithBank() {
  const onChanged = createEvent();
  const legacy = { id: "old-1", serial: 1, savedAt: 1700000000001, term: "address", queryType: "word", short_meaning: "地址", memory_tip: "a+ddress（穿衣）" };
  const local = createStorageArea({ [VOCAB]: [legacy] }, { onChanged });
  const bg = loadBackground({ local, onChanged });
  await bg.dispatch({ type: "ADD_VOCAB", item: { ...SAVED, memory_tip: GOOD_TIP, memory_tip_type: "contrast" } });
  const settings = await loadSettingsPage({ local, onChanged, sendMessage: (m) => bg.dispatch(m) });
  const run = (code) => vm.runInContext(code, settings.context);
  return { settings, run };
}

test("Settings: compact derivatives / synonyms / useful mnemonic; search covers English and Chinese", async () => {
  const { settings, run } = await loadSettingsWithBank();
  const html = settings.listHtml();
  assert.match(html, /派生词<\/span>banker · n\. 银行家/);
  assert.match(html, /同义词<\/span>lender — 放贷方/);
  assert.match(html, /助记<\/span>银行（bank）存钱/);
  assert.doesNotMatch(html, /ddress（穿衣）/, "old junk tip is not shown");
  for (const q of ["banker", "银行家", "lender", "放贷方"]) {
    settings.setSearch(q);
    run("renderVocabList()");
    assert.deepEqual(plain(run("vocabState._filteredList.map((v) => v.term)")), ["bank"], q);
  }
});

test("Settings: review shows derivatives / synonyms / mnemonic only after reveal", async () => {
  const { run } = await loadSettingsWithBank();
  const back = run('renderReviewBack(vocabulary.find((v) => v.term === "bank"))');
  assert.match(back, /派生词[\s\S]*banker/);
  assert.match(back, /同义词[\s\S]*lender[\s\S]*强调借钱给别人/);
  assert.match(back, /助记[\s\S]*银行（bank）存钱/);
  const oldBack = run('renderReviewBack(vocabulary.find((v) => v.term === "address"))');
  assert.doesNotMatch(oldBack, /助记|穿衣/);
});

test("Settings exports: TXT / MD / CSV carry the new fields; CSV columns stay equal", async () => {
  const { run } = await loadSettingsWithBank();
  const txt = run("exportVocabAsTxt(vocabulary)");
  assert.match(txt, /派生词: banker n\. 银行家/);
  assert.match(txt, /同义词: lender — 放贷方（强调借钱给别人）/);
  assert.match(txt, /记忆: 银行（bank）存钱/);
  assert.doesNotMatch(txt, /穿衣/);
  const md = run("exportVocabAsMarkdown(vocabulary)");
  assert.match(md, /- \*\*派生词\*\*: banker n\. 银行家/);
  assert.match(md, /- \*\*同义词\*\*: lender — 放贷方/);
  const csv = run("exportVocabAsCsv(vocabulary)").replace(/^\uFEFF/, "");
  const rows = parseCsv(csv);
  const [header, ...body] = rows;
  assert.deepEqual(header.slice(-2), ["派生词", "同义词"]);
  body.forEach((r) => assert.equal(r.length, header.length));
  const bank = body.find((r) => r[3] === "bank");
  assert.equal(bank.at(-2), "banker n. 银行家");
  assert.equal(bank.at(-1), "lender — 放贷方（强调借钱给别人）");
  for (const out of [txt, md, csv]) assert.doesNotMatch(out, /undefined|\[object Object\]/);
});

/** Minimal RFC 4180 parser (quoted cells may contain commas, quotes and newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}
