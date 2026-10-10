/**
 * M7 characterisation: what the shared lookup panel renders and sends, recorded before
 * mk-lookup.js is split into lookup/*.js parts.
 *
 * Each scenario drives the real controller (fake DOM, fake chrome) through one lookup and
 * records the panel title, its data-query-type, the full panel body HTML, the EXPLAIN message
 * (without the random queryId), and for result panels the ADD_VOCAB item and the copied note.
 * tests/fixtures/lookup-panel-snapshot.json holds the recording from the single-file
 * mk-lookup.js. Splitting the file must not change one byte of it.
 *
 * Regenerate only for an intended UI change, and review the fixture diff:
 *   UPDATE_LOOKUP_SNAPSHOT=1 node --test tests/lookup-panel-snapshot.test.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { sleep } = require("./helpers/extension-sandbox");
const { createRange, createSelection, loadLookupController, disposeLookupControllers } = require("./helpers/fake-dom");

const FIXTURE = path.join(__dirname, "fixtures", "lookup-panel-snapshot.json");
const UPDATE = process.env.UPDATE_LOOKUP_SNAPSHOT === "1";
const recorded = {};
const expected = fs.existsSync(FIXTURE) ? JSON.parse(fs.readFileSync(FIXTURE, "utf8")) : {};

test.afterEach(() => disposeLookupControllers());

const WORD_DATA = {
  queryType: "word",
  term: "harbour",
  phonetic: "/ˈhɑːbə/",
  part_of_speech: "n.",
  short_meaning: "港口；避风港",
  memory_tip: "harbo(u)r：藏船的地方",
  examples: [
    { en: "The ship left the harbour at dawn.", zh: "船在黎明时离港。" },
    { en: "They harbour no doubts.", zh: "他们毫无疑虑。" },
  ],
  derivatives: [{ word: "harbourage", pos: "n.", meaning: "避难所" }],
  key_phrases: [{ phrase: "safe harbour", meaning: "避风港" }],
};

const SENTENCE_DATA = {
  queryType: "sentence",
  term: "The committee postponed the vote.",
  translation: "委员会推迟了投票。",
  key_phrases: [{ phrase: "postpone the vote", meaning: "推迟投票" }],
  grammar: "过去时，主谓宾结构。",
};

const PARAGRAPH_DATA = {
  queryType: "paragraph",
  translation: "委员会把投票推迟到下次季度会议。大家都同意。",
  summary: "投票推迟。",
  difficult_phrases: [{ phrase: "quarterly meeting", meaning: "季度会议" }],
  key_phrases: [{ phrase: "postpone", meaning: "推迟" }],
  collocations: [{ phrase: "hold a vote", meaning: "举行投票" }],
};

const CODE_DATA = {
  queryType: "word",
  kind: "code_term",
  term: "useEffect",
  short_meaning: "React 副作用 Hook",
  breakdown: [
    { part: "use", meaning: "Hook 前缀" },
    { part: "Effect", meaning: "副作用" },
  ],
  example: { code: "useEffect(() => {}, []);", explanation: "挂载时运行一次" },
  related_terms: ["useLayoutEffect", "useState"],
};

/** The panel's markup including in-place updates (the fake DOM keeps them on "virtual" children). */
function deepMarkup(el) {
  return [el._markup(), ...el.children.map(deepMarkup)].filter(Boolean).join("\n");
}

function record(name, env, extra) {
  const panel = env.panel();
  const out = {
    title: panel?.querySelector(".zeh-panel-title")?.textContent ?? null,
    queryType: panel?.dataset?.queryType ?? null,
    body: env.panelBodyHtml(),
    updates: panel ? deepMarkup(panel).replace(env.panelBodyHtml(), "<body>") : null,
    ...(extra || {}),
  };
  // plain JSON values: objects built inside the page sandbox have that realm's prototypes
  const plain = JSON.parse(JSON.stringify(out));
  recorded[name] = plain;
  if (!UPDATE) {
    assert.ok(expected[name], `no recording for ${name}; run with UPDATE_LOOKUP_SNAPSHOT=1`);
    assert.deepEqual(plain, expected[name], `${name} renders differently`);
  }
  return plain;
}

function explainShape(env) {
  const { queryId, ...rest } = env.explainRequests().at(-1).message;
  assert.ok(typeof queryId === "string" && queryId.length > 0, "EXPLAIN carries a queryId");
  return rest;
}

function lookup(env, text) {
  assert.equal(env.controller.lookupText(text), true);
  return env.explainRequests().at(-1).message.queryId;
}

/** Select `word` inside a paragraph holding `text` and click the bubble (a page lookup with context). */
function lookUpInPage(env, text, word) {
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
  return env.explainRequests().at(-1).message.queryId;
}

async function actions(env) {
  let copied = null;
  env.context.navigator.clipboard = { writeText: async (t) => (copied = t) };
  const footer = (n) => env.panel().querySelector(`.zeh-panel-footer .mk-btn:nth-child(${n})`);
  footer(2).dispatchEvent({ type: "click", stopPropagation() {} });
  const add = env.messages("ADD_VOCAB").at(-1);
  footer(3).dispatchEvent({ type: "click", stopPropagation() {} });
  await sleep(0);
  const item = add ? { ...add.message.item } : null;
  if (item && item.contexts) {
    item.contexts = item.contexts.map(({ id, savedAt, ...c }) => ({ ...c, id: id ? "<id>" : id, savedAt: savedAt ? "<t>" : savedAt }));
  }
  for (const key of ["id", "savedAt", "lookedUpAt"]) if (item && item[key]) item[key] = "<volatile>";
  return { addVocab: item, copied };
}

/** Images "load" on the next tick (the easter egg preloads its pictures). */
class FakeImage {
  set src(value) {
    this._src = value;
    this.complete = false;
    setTimeout(() => {
      this.complete = true;
      if (typeof this.onload === "function") this.onload();
    }, 0);
  }
  get src() {
    return this._src;
  }
  decode() {
    return Promise.resolve();
  }
}

function setup() {
  const env = loadLookupController({ controllerOptions: { aggressiveBubbleMode: true }, globals: { Image: FakeImage } });
  env.document.title = "Harbour News";
  return env;
}

test("M7 snapshot: loading panel and EXPLAIN for a word, a sentence and a paragraph", () => {
  const env = setup();
  lookup(env, "harbour");
  record("loading-word", env, { explain: explainShape(env) });
  lookup(env, "The committee postponed the vote.");
  record("loading-sentence", env, { explain: explainShape(env) });
  lookup(env, "The committee postponed the vote until the next quarterly meeting. Everyone agreed with that plan and went home.");
  record("loading-paragraph", env, { explain: explainShape(env) });
});

test("M7 snapshot: dictionary word result, then a model result with provider and duration", async () => {
  const env = setup();
  let q = lookup(env, "harbour");
  env.deliver({ type: "SHOW_RESULT", queryId: q, queryType: "word", fromDict: true, durationMs: 0, data: WORD_DATA });
  record("word-dictionary", env, await actions(env));
  q = lookup(env, "harbour");
  env.deliver({
    type: "SHOW_RESULT",
    queryId: q,
    queryType: "word",
    durationMs: 2300,
    providerName: "DeepSeek",
    modelName: "deepseek-flash",
    data: WORD_DATA,
  });
  record("word-model", env);
  q = lookup(env, "harbour");
  env.deliver({ type: "SHOW_RESULT", queryId: q, queryType: "word", fromCache: true, durationMs: 4, data: WORD_DATA });
  record("word-cache", env);
  env.deliver({ type: "DICT_ENHANCED", queryId: q, providerName: "DeepSeek", modelName: "deepseek-flash", durationMs: 1500 });
  record("word-dict-enhanced", env);
});

test("M7 snapshot: a page lookup with context: pending, enhanced, vocabulary and copy", async () => {
  const env = setup();
  const q = lookUpInPage(env, "Fog rolled in. The ship left the harbour at dawn. Gulls followed.", "harbour");
  record("context-explain", env, { explain: explainShape(env) });
  env.deliver({
    type: "SHOW_RESULT",
    queryId: q,
    queryType: "word",
    fromDict: true,
    durationMs: 0,
    contextPending: true,
    data: WORD_DATA,
  });
  record("context-pending", env);
  env.deliver({
    type: "CONTEXT_ENHANCED",
    queryId: q,
    contextHash: "00000000",
    ok: true,
    durationMs: 1200,
    providerName: "DeepSeek",
    modelName: "deepseek-chat",
    data: {
      meaning_here: "此处指港口",
      pos_here: "名词",
      sentence_translation: "船在黎明时离开了港口。",
      examples: [{ en: "A busy harbour.", zh: "繁忙的港口。" }],
      synonyms: [{ word: "port", meaning: "港口" }],
    },
  });
  record("context-enhanced", env, await actions(env));
});

test("M7 snapshot: sentence, paragraph and code-term results", async () => {
  const env = setup();
  let q = lookup(env, "The committee postponed the vote.");
  env.deliver({ type: "SHOW_RESULT", queryId: q, queryType: "sentence", durationMs: 900, data: SENTENCE_DATA });
  record("sentence", env, await actions(env));
  q = lookup(env, "The committee postponed the vote until the next quarterly meeting. Everyone agreed with that plan and went home.");
  env.deliver({ type: "SHOW_RESULT", queryId: q, queryType: "paragraph", durationMs: 1900, data: PARAGRAPH_DATA });
  record("paragraph", env, await actions(env));
  q = lookup(env, "useEffect");
  env.deliver({ type: "SHOW_RESULT", queryId: q, queryType: "word", durationMs: 700, data: CODE_DATA });
  record("code-term", env, await actions(env));
});

test("M7 snapshot: fallbacks, errors and the API-key panel", () => {
  const env = setup();
  let q = lookup(env, "harbour");
  env.deliver({ type: "SHOW_RESULT", queryId: q, fallback: true, durationMs: 800, data: { term: "harbour", rawText: "没有查到解释，请稍后重试" } });
  record("fallback-friendly", env);
  q = lookup(env, "harbour");
  env.deliver({ type: "SHOW_RESULT", queryId: q, fallback: true, durationMs: 800, data: { term: "harbour", rawText: '{"term": "harbour", "short_' } });
  record("fallback-json", env);
  q = lookup(env, "harbour");
  env.deliver({ type: "SHOW_ERROR", queryId: q, message: "请求失败：429" });
  record("error", env);
  lookup(env, "harbour");
  env.respond(env.explainRequests().length - 1, { accepted: false, code: "NO_API_KEY", message: "请先配置 API Key" });
  record("no-api-key", env);
  assert.equal(env.controller.lookupText("你好世界"), true);
  record("no-english", env);
  assert.equal(env.controller.lookupText("x".repeat(6000)), true);
  record("too-long", env);
});

test("M7 snapshot: the Manekilex easter egg panel", async () => {
  const env = setup();
  const q = lookup(env, "Manekilex");
  env.deliver({ type: "SHOW_RESULT", queryId: q, queryType: "word", fromDict: true, durationMs: 0, data: { queryType: "word", term: "Manekilex", short_meaning: "招财猫" } });
  record("easter-egg", env);
  env.controller.hideAll();
  await sleep(5);
});

test.after(() => {
  if (UPDATE) fs.writeFileSync(FIXTURE, JSON.stringify(recorded, null, 2) + "\n");
});
