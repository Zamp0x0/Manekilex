/**
 * Phase 3 page side: the lookup panel shows the basic meaning at once and fills in
 * "当前语境" (meaning here) when CONTEXT_ENHANCED arrives, in place, only for the
 * lookup that asked for it. Closed / replaced / timed-out panels are never touched.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { sleep } = require("./helpers/extension-sandbox");
const {
  createRange,
  createSelection,
  loadLookupController,
  disposeLookupControllers,
} = require("./helpers/fake-dom");

test.afterEach(() => disposeLookupControllers());

const FINANCE_TEXT = "My salary arrived late. The bank approved my loan. We celebrated.";
const RIVER_TEXT = "We sat on the bank of the river. The water was cold.";
const DICT_BANK = {
  queryType: "word",
  term: "bank",
  part_of_speech: "n.",
  short_meaning: "银行；河岸",
  examples: [{ en: "She works at a bank.", zh: "她在银行工作。" }],
};
const ENHANCED_FINANCE = {
  meaning_here: "此处指金融机构：银行",
  pos_here: "名词",
  sentence_translation: "银行批准了我的贷款。",
  examples: [{ en: "The bank raised its rates.", zh: "银行提高了利率。" }],
};

function setup(options) {
  const env = loadLookupController({
    ...(options || {}),
    controllerOptions: { aggressiveBubbleMode: true },
  });
  env.document.title = "Money News";
  return env;
}

/** Select `word` inside a paragraph holding `text`, click the bubble; returns the EXPLAIN message. */
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

function showDictResult(env, queryId, extra) {
  env.deliver({
    type: "SHOW_RESULT",
    queryId,
    queryType: "word",
    durationMs: 0,
    fromDict: true,
    contextPending: true,
    data: DICT_BANK,
    ...(extra || {}),
  });
}

function enhance(env, queryId, data = ENHANCED_FINANCE, extra) {
  env.deliver({
    type: "CONTEXT_ENHANCED",
    queryId,
    contextHash: "00000000",
    ok: true,
    data,
    durationMs: 1200,
    providerName: "DeepSeek",
    modelName: "deepseek-chat",
    ...(extra || {}),
  });
}

const contextSection = (env) => env.panel().querySelector(".zeh-context-section");
const examplesSection = (env) => env.panel().querySelector(".zeh-examples-section");

/** State after an in-place update (section dataset), else the state rendered into the body. */
function contextState(env) {
  const section = contextSection(env);
  if (section && section.dataset.contextState) return section.dataset.contextState;
  const m = env.panelBodyHtml().match(/data-context-state="(\w+)"/);
  return m ? m[1] : null;
}

/** Count re-renders of the panel body / footer (the in-place update must not do either). */
function watchRenders(env) {
  const counts = { body: 0, footer: 0 };
  for (const [name, selector] of [
    ["body", ".zeh-panel-body"],
    ["footer", ".zeh-panel-footer"],
  ]) {
    const el = env.panel().querySelector(selector);
    Object.defineProperty(el, "innerHTML", {
      configurable: true,
      get() {
        return this._html;
      },
      set(v) {
        counts[name] += 1;
        this._html = String(v);
        this._virtual.clear();
      },
    });
  }
  return counts;
}

function clickVocab(env) {
  env.panel().querySelector(".zeh-panel-footer .mk-btn:nth-child(2)").dispatchEvent({ type: "click", stopPropagation() {} });
  return env.messages("ADD_VOCAB").at(-1).message.item;
}

test("dictionary result renders at once with 基础释义, the source sentence and a pending 当前语境", () => {
  const env = setup();
  const { queryId, context } = lookUpInPage(env, FINANCE_TEXT);
  assert.equal(context.sentence, "The bank approved my loan.");
  showDictResult(env, queryId);

  const html = env.panelBodyHtml();
  assert.match(html, /基础释义/);
  assert.match(html, /银行；河岸/);
  assert.match(html, /data-context-state="pending"/);
  assert.match(html, /正在分析当前语境/);
  assert.match(html, /The <mark class="zeh-source-term">bank<\/mark> approved my loan\./);
  assert.equal(env.controller.isPending(), false, "the main spinner is gone: the result is usable");
});

test("CONTEXT_ENHANCED updates only the 当前语境 and example sections, in place", () => {
  const env = setup();
  const { queryId } = lookUpInPage(env, FINANCE_TEXT);
  showDictResult(env, queryId);
  const renders = watchRenders(env);

  enhance(env, queryId);
  const section = contextSection(env);
  assert.equal(section.dataset.contextState, "done");
  assert.match(section.innerHTML, /此处指金融机构：银行/);
  assert.match(section.innerHTML, /名词/);
  assert.match(section.innerHTML, /银行批准了我的贷款。/);
  assert.match(section.innerHTML, /DeepSeek · deepseek-chat · 1\.2s/);
  assert.match(examplesSection(env).innerHTML, /The bank raised its rates\./);
  assert.deepEqual({ ...renders }, { body: 0, footer: 0 }, "no full re-render, buttons untouched");
  assert.equal(env.controller.hasPanel(), true);
});

test("a failed enhancement keeps the dictionary result and shows a quiet note", () => {
  const env = setup();
  const { queryId } = lookUpInPage(env, FINANCE_TEXT);
  showDictResult(env, queryId);
  env.deliver({ type: "CONTEXT_ENHANCED", queryId, ok: false, reason: "error" });
  assert.equal(contextState(env), "failed");
  assert.match(contextSection(env).innerHTML, /基础释义仍可使用/);
  assert.match(env.panelBodyHtml(), /银行；河岸/);
  assert.doesNotMatch(env.panelBodyHtml(), /zeh-error/);

  // an ok:true message with nothing usable is treated the same way
  const env2 = setup();
  const second = lookUpInPage(env2, FINANCE_TEXT);
  showDictResult(env2, second.queryId);
  enhance(env2, second.queryId, { pos_here: "名词" });
  assert.equal(contextState(env2), "failed");
});

test("a stale enhancement for an older lookup never touches the newer one", async () => {
  const env = setup();
  const first = lookUpInPage(env, FINANCE_TEXT);
  showDictResult(env, first.queryId);
  await sleep(380); // past the bubble's double-activation guard

  const second = lookUpInPage(env, RIVER_TEXT);
  assert.notEqual(second.queryId, first.queryId);
  enhance(env, first.queryId); // arrives while the second lookup is still loading
  assert.equal(env.controller.isPending(), true);
  assert.doesNotMatch(env.panelBodyHtml(), /金融机构/);

  showDictResult(env, second.queryId);
  enhance(env, first.queryId); // and again once the second result is shown
  assert.equal(contextState(env), "pending");
  assert.doesNotMatch(env.panelBodyHtml(), /金融机构/);
  assert.doesNotMatch(contextSection(env).innerHTML, /金融机构/);

  enhance(env, second.queryId, { meaning_here: "此处指河岸", examples: [] });
  assert.equal(contextState(env), "done");
  assert.match(contextSection(env).innerHTML, /此处指河岸/);
  assert.equal(examplesSection(env).innerHTML, "", "no new examples: the example section is not replaced");
  assert.match(env.panelBodyHtml(), /She works at a bank\./);
});

test("a late enhancement after the panel was closed does not reopen it", () => {
  const env = setup();
  const { queryId } = lookUpInPage(env, FINANCE_TEXT);
  showDictResult(env, queryId);
  env.controller.hideAll(); // Esc / ×
  enhance(env, queryId);
  env.deliver({ type: "CONTEXT_ENHANCED", queryId, ok: false, reason: "timeout" });
  assert.equal(env.controller.hasPanel(), false);
});

test("the page gives up waiting after the client timeout; a later enhancement is ignored", async () => {
  const env = setup();
  env.context.zehLookupClientTimeoutMs = () => 30;
  const { queryId } = lookUpInPage(env, FINANCE_TEXT);
  showDictResult(env, queryId);
  await sleep(70);
  assert.equal(contextState(env), "failed");
  enhance(env, queryId);
  assert.equal(contextState(env), "failed");
  assert.doesNotMatch(contextSection(env).innerHTML, /金融机构/);
  assert.match(env.panelBodyHtml(), /银行；河岸/);
});

test("vocabulary payload: source sentence and page info now, meaning here after enhancement", () => {
  const before = setup();
  const a = lookUpInPage(before, FINANCE_TEXT);
  showDictResult(before, a.queryId);
  const early = clickVocab(before);
  assert.equal(early.term, "bank");
  assert.equal(early.short_meaning, "银行；河岸");
  assert.equal(early.context_sentence, "The bank approved my loan.");
  assert.equal(early.sourceType, "web");
  assert.equal(early.pageUrl, "https://example.test/article");
  assert.equal(early.pageTitle, "Money News");
  assert.equal(early.meaning_here, undefined);

  const after = setup();
  const b = lookUpInPage(after, FINANCE_TEXT);
  showDictResult(after, b.queryId);
  enhance(after, b.queryId);
  const late = clickVocab(after);
  assert.equal(late.meaning_here, "此处指金融机构：银行");
  assert.equal(late.pos_here, "名词");
  assert.equal(late.sentence_translation, "银行批准了我的贷款。");
  assert.equal(late.short_meaning, "银行；河岸", "basic meaning kept");
  assert.equal(late.examples[0].en, "The bank raised its rates.");
});

test("copy text includes the basic meaning, the meaning here and the source sentence", async () => {
  const env = setup();
  let copied = "";
  env.context.navigator.clipboard = { writeText: async (t) => (copied = t) };
  const { queryId } = lookUpInPage(env, FINANCE_TEXT);
  showDictResult(env, queryId);
  enhance(env, queryId);
  env.panel().querySelector(".zeh-panel-footer .mk-btn:nth-child(3)").dispatchEvent({ type: "click", stopPropagation() {} });
  await sleep(5);
  assert.match(copied, /基础释义: 银行；河岸/);
  assert.match(copied, /当前语境: 此处指金融机构：银行/);
  assert.match(copied, /原句: The bank approved my loan\./);
  assert.match(copied, /原句翻译: 银行批准了我的贷款。/);
});

test("a cached contextual result renders as done; no model configured shows the sentence only", () => {
  const cached = setup();
  const a = lookUpInPage(cached, FINANCE_TEXT);
  cached.deliver({
    type: "SHOW_RESULT",
    queryId: a.queryId,
    queryType: "word",
    fromCache: true,
    durationMs: 0,
    data: { ...DICT_BANK, ...ENHANCED_FINANCE },
  });
  assert.match(cached.panelBodyHtml(), /data-context-state="done"/);
  assert.match(cached.panelBodyHtml(), /此处指金融机构：银行/);
  assert.match(cached.panelBodyHtml(), /⚡ 缓存/);

  const sourceOnly = setup();
  const b = lookUpInPage(sourceOnly, FINANCE_TEXT);
  showDictResult(sourceOnly, b.queryId, { contextPending: false });
  const html = sourceOnly.panelBodyHtml();
  assert.match(html, /data-context-state="source"/);
  assert.match(html, /原句/);
  assert.doesNotMatch(html, /正在分析/);
});

test("lookups without context (PDF / side panel / sentences) show no context section", () => {
  const env = setup();
  env.controller.lookupText("bank");
  const { queryId } = env.explainRequests().at(-1).message;
  showDictResult(env, queryId); // even if a buggy sender claimed contextPending
  assert.doesNotMatch(env.panelBodyHtml(), /zeh-context-section/);
  enhance(env, queryId);
  assert.doesNotMatch(env.panelBodyHtml(), /金融机构/);

  const sentence = "The committee postponed the vote until the next quarterly meeting.";
  env.controller.lookupText(sentence);
  const next = env.explainRequests().at(-1).message;
  env.deliver({
    type: "SHOW_RESULT",
    queryId: next.queryId,
    queryType: "sentence",
    contextPending: true,
    data: { queryType: "sentence", translation: "委员会推迟了投票。" },
  });
  assert.match(env.panelBodyHtml(), /委员会推迟了投票/);
  assert.doesNotMatch(env.panelBodyHtml(), /zeh-context-section/);
});

test("Phase 4: the add button reports a new context, a filled-in context, the cap and duplicates", () => {
  const cases = [
    [{ ok: true, added: true, serial: 7, id: "x", contextAdded: true }, "已加入 #7 ✓"],
    [{ ok: true, added: false, contextAdded: true, reason: "context_added", contextCount: 2 }, "已添加新语境（共 2 个）✓"],
    [{ ok: true, added: false, contextAdded: false, contextUpdated: true, reason: "context_updated" }, "已补全语境 ✓"],
    [{ ok: true, added: false, contextAdded: false, reason: "context_limit", limit: 8 }, "语境已满"],
    [{ ok: true, added: false, contextAdded: false, reason: "duplicate" }, "已在生词本"],
    [{ ok: false, added: false, reason: "error" }, "加入失败"],
  ];
  for (const [response, label] of cases) {
    const env = setup();
    const { queryId } = lookUpInPage(env, RIVER_TEXT);
    showDictResult(env, queryId);
    clickVocab(env);
    env.messages("ADD_VOCAB").at(-1).cb(response);
    const button = env.panel().querySelector(".zeh-panel-footer .mk-btn:nth-child(2)");
    assert.equal(button.textContent, label, response.reason || "added");
    disposeLookupControllers();
  }
});
