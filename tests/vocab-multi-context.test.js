/**
 * Phase 4 multi-context vocabulary: one entry per term, each sentence the word was saved
 * from becomes one context. Same sentence again → no duplicate (but missing details are
 * filled in); a bounded number of contexts per word; Settings search / export cover them all.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { loadBackground, createStorageArea, createEvent, evalIn } = require("./helpers/extension-sandbox");
const { loadSettingsPage } = require("./helpers/settings-page");

const VOCAB = "zehVocabulary";
const plain = (value) => JSON.parse(JSON.stringify(value));
/** Writes of the vocabulary key only (the worker also writes cache metadata on start). */
const vocabWrites = (bg) => bg.local.setCalls.filter((keys) => keys.includes(VOCAB)).length;

const LEXICAL = {
  term: "bank",
  queryType: "word",
  phonetic: "/bæŋk/",
  part_of_speech: "noun",
  short_meaning: "银行；河岸",
  context_meaning: "金融机构或河流两侧的土地",
  examples: [{ en: "She works at a bank.", zh: "她在银行工作。" }],
  memory_tip: "bank → 银行 / 岸",
};

const FINANCE = {
  ...LEXICAL,
  pageUrl: "https://example.test/news",
  pageTitle: "Money News",
  context_sentence: "The bank approved my loan.",
  sourceType: "web",
  meaning_here: "此处指金融机构：银行",
  pos_here: "名词",
  sentence_translation: "银行批准了我的贷款。",
};

const RIVER = {
  ...LEXICAL,
  pageUrl: "https://example.test/travel",
  pageTitle: "River Walks",
  context_sentence: "We sat on the bank of the river.",
  sourceType: "web",
  meaning_here: "此处指河岸",
  pos_here: "名词",
  sentence_translation: "我们坐在河岸上。",
};

function contexts(bg, term = "bank") {
  return bg.local.data[VOCAB].find((v) => v.term === term).contexts;
}

test("first save creates the term with its first context; a new sentence appends a context", async () => {
  const bg = loadBackground();
  const first = await bg.dispatch({ type: "ADD_VOCAB", item: FINANCE });
  assert.equal(first.added, true);
  assert.equal(first.contextAdded, true);
  const reviewBefore = plain(bg.local.data[VOCAB][0].review);

  const second = await bg.dispatch({ type: "ADD_VOCAB", item: { ...RIVER, term: "Bank" } });
  assert.deepEqual(second, {
    ok: true,
    added: false,
    contextAdded: true,
    contextUpdated: false,
    reason: "context_added",
    id: first.id,
    serial: first.serial,
    contextCount: 2,
  });

  const list = bg.local.data[VOCAB];
  assert.equal(list.length, 1, "still ONE vocabulary entry for bank");
  const [finance, river] = list[0].contexts;
  assert.equal(finance.sentence, "The bank approved my loan.");
  assert.equal(river.sentence, "We sat on the bank of the river.");
  assert.notEqual(finance.meaning_here, river.meaning_here);
  assert.equal(river.meaning_here, "此处指河岸");
  assert.equal(river.pageTitle, "River Walks");
  assert.notEqual(finance.id, river.id);
  assert.deepEqual(plain(list[0].review), reviewBefore, "one review state per term, untouched by a new context");
  assert.equal(list[0].short_meaning, "银行；河岸", "lexical data stays on the entry");
  assert.equal("meaning_here" in list[0], false, "context data is not copied onto the entry");
});

test("the same sentence again is not a new context (identity ignores case, spacing, quotes, final punctuation)", async () => {
  const bg = loadBackground();
  await bg.dispatch({ type: "ADD_VOCAB", item: { ...FINANCE, context_sentence: "He said: “The bank’s loan was approved.”" } });
  const writes = vocabWrites(bg);
  for (const variant of [
    "He said: “The bank’s loan was approved.”",
    "he said:  \"the BANK's loan was approved.\"",
    "He said: \"The bank's loan was approved\"",
  ]) {
    const res = await bg.dispatch({ type: "ADD_VOCAB", item: { ...FINANCE, context_sentence: variant } });
    assert.equal(res.ok, true);
    assert.equal(res.added, false);
    assert.equal(res.contextAdded, false);
    assert.equal(res.reason, "duplicate", variant);
  }
  assert.equal(vocabWrites(bg), writes, "duplicates do not write");
  assert.equal(contexts(bg).length, 1);
});

test("a context saved before the enhancement is filled in later, without overwriting what it has", async () => {
  const bg = loadBackground();
  const early = { ...RIVER, sentence_translation: "早先保存的翻译" };
  delete early.meaning_here;
  delete early.pos_here;
  await bg.dispatch({ type: "ADD_VOCAB", item: early });
  assert.equal("meaning_here" in contexts(bg)[0], false);

  const res = await bg.dispatch({ type: "ADD_VOCAB", item: RIVER });
  assert.equal(res.contextUpdated, true);
  assert.equal(res.reason, "context_updated");
  const [ctx] = contexts(bg);
  assert.equal(ctx.meaning_here, "此处指河岸");
  assert.equal(ctx.pos_here, "名词");
  assert.equal(ctx.sentence_translation, "早先保存的翻译", "existing details are kept");
  assert.equal(contexts(bg).length, 1);
});

test("contexts per term are capped; at the cap new sentences are refused but existing ones can still be enriched", async () => {
  const bg = loadBackground();
  const max = evalIn(bg.context, "ZEH_VOCAB_MAX_CONTEXTS");
  assert.equal(max, 8);
  for (let i = 0; i < max; i += 1) {
    const item = { ...FINANCE, context_sentence: `Sentence number ${i} uses bank.` };
    if (i === 0) delete item.meaning_here;
    await bg.dispatch({ type: "ADD_VOCAB", item });
  }
  assert.equal(contexts(bg).length, max);
  const writes = vocabWrites(bg);
  const over = await bg.dispatch({ type: "ADD_VOCAB", item: { ...FINANCE, context_sentence: "One sentence too many for bank." } });
  assert.equal(over.reason, "context_limit");
  assert.equal(over.limit, 8);
  assert.equal(over.contextAdded, false);
  assert.equal(vocabWrites(bg), writes);

  const enrich = await bg.dispatch({ type: "ADD_VOCAB", item: { ...FINANCE, context_sentence: "Sentence number 0 uses bank." } });
  assert.equal(enrich.reason, "context_updated");
  assert.equal(contexts(bg)[0].meaning_here, "此处指金融机构：银行");
  assert.equal(contexts(bg).length, max);
});

test("a stored Phase 3 entry is migrated in place when a second sentence is saved", async () => {
  const legacyBank = { id: "old-bank", serial: 3, savedAt: 1790000000000, savedAtLocal: "x", ...FINANCE };
  const other = { id: "old-other", serial: 2, savedAt: 1789000000000, term: "other", queryType: "word", short_meaning: "其他" };
  const bg = loadBackground({ storage: { [VOCAB]: [legacyBank, other] } });
  const res = await bg.dispatch({ type: "ADD_VOCAB", item: RIVER });
  assert.equal(res.contextAdded, true);
  assert.equal(res.id, "old-bank");
  const [bank, untouched] = bg.local.data[VOCAB];
  assert.deepEqual(bank.contexts.map((c) => c.sentence), ["The bank approved my loan.", "We sat on the bank of the river."]);
  assert.equal(bank.contexts[0].meaning_here, "此处指金融机构：银行");
  assert.equal("context_sentence" in bank, false);
  assert.equal(bank.serial, 3);
  assert.equal(bank.review.status, "new");
  assert.deepEqual(plain(untouched), other, "other entries are not rewritten by this mutation");
});

test("the page cannot inject ids, serials, contexts or review state", async () => {
  const bg = loadBackground();
  await bg.dispatch({
    type: "ADD_VOCAB",
    item: {
      ...FINANCE,
      id: "evil",
      serial: 999,
      savedAt: 1,
      contexts: [{ sentence: "injected" }],
      review: { status: "review", dueAt: 4102444800000, intervalDays: 365 },
    },
  });
  const [saved] = bg.local.data[VOCAB];
  assert.notEqual(saved.id, "evil");
  assert.equal(saved.serial, 1);
  assert.notEqual(saved.savedAt, 1);
  assert.deepEqual(saved.contexts.map((c) => c.sentence), ["The bank approved my loan."]);
  assert.equal(saved.review.status, "new");
  assert.equal(saved.review.dueAt, saved.savedAt);
});

test("a save without a sentence for a word already saved is still a plain duplicate", async () => {
  const bg = loadBackground();
  await bg.dispatch({ type: "ADD_VOCAB", item: FINANCE });
  const res = await bg.dispatch({ type: "ADD_VOCAB", item: { ...LEXICAL, pageUrl: "https://example.test/a.pdf" } });
  assert.deepEqual(res, { ok: true, added: false, reason: "duplicate" });
});

test("two tabs saving bank from two sentences at the same time end up as one entry with two contexts", async () => {
  const bg = loadBackground();
  const [a, b] = await Promise.all([
    bg.dispatch({ type: "ADD_VOCAB", item: FINANCE }, { tab: { id: 1 } }),
    bg.dispatch({ type: "ADD_VOCAB", item: RIVER }, { tab: { id: 2 } }),
  ]);
  assert.equal(a.added, true);
  assert.equal(b.contextAdded, true);
  assert.equal(bg.local.data[VOCAB].length, 1);
  assert.equal(contexts(bg).length, 2);
});

// ── Settings: list, search, export ───────────────────────────────────────────

async function loadExtensionWithBank() {
  const onChanged = createEvent();
  const legacy = {
    id: "old-1",
    serial: 1,
    savedAt: 1700000000001,
    savedAtLocal: "2023-11-14 22:13",
    term: "prayer",
    queryType: "word",
    short_meaning: "祈祷",
    context_meaning: "宗教场合的用法说明",
    pageUrl: "https://example.test/old",
  };
  const local = createStorageArea({ [VOCAB]: [legacy] }, { onChanged });
  const bg = loadBackground({ local, onChanged });
  const book = { title: "River Tales", chapterTitle: "Chapter 3", chapterIndex: 2 };
  await bg.dispatch({ type: "ADD_VOCAB", item: FINANCE });
  await bg.dispatch({ type: "ADD_VOCAB", item: { ...RIVER, sourceType: "epub", pageTitle: "River Tales", book } });
  const settings = await loadSettingsPage({ local, onChanged, sendMessage: (m) => bg.dispatch(m) });
  const run = (code) => vm.runInContext(code, settings.context);
  return { bg, settings, run, local };
}

test("Settings list: one row for bank with '2 个语境', the first context inline, the rest expandable", async () => {
  const { settings } = await loadExtensionWithBank();
  const html = settings.listHtml();
  assert.equal((html.match(/class="vocab-term"/g) || []).length, 2, "bank + prayer");
  assert.match(html, /2 个语境/);
  assert.match(html, /The bank approved my loan\./);
  assert.match(html, /<details class="vocab-contexts">/);
  assert.match(html, /查看其余 1 个语境/);
  assert.match(html, /We sat on the bank of the river\./);
  assert.match(html, /此处指河岸/);
  assert.match(html, /River Tales · Chapter 3/);
  assert.match(html, /复习：新词/);
  assert.doesNotMatch(html, /undefined|\[object Object\]/);
});

test("Settings search matches any context's sentence, meaning and source, plus the usage note", async () => {
  const { settings, run } = await loadExtensionWithBank();
  const search = (q) => {
    settings.setSearch(q);
    run("renderVocabList()");
    return plain(run("vocabState._filteredList.map((v) => v.term)"));
  };
  assert.deepEqual(search("bank of the river"), ["bank"], "only in the SECOND context sentence");
  assert.deepEqual(search("此处指河岸"), ["bank"], "second context meaning");
  assert.deepEqual(search("我们坐在河岸上"), ["bank"], "second context translation");
  assert.deepEqual(search("chapter 3"), ["bank"], "book / chapter of a context");
  assert.deepEqual(search("money news"), ["bank"], "page title of a context");
  assert.deepEqual(search("宗教场合"), ["prayer"], "usage note (context_meaning)");
  assert.deepEqual(search("zzz-not-there"), []);
});

/** Minimal RFC-4180 reader (quoted fields with commas / quotes / newlines). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  rows.push(row);
  return rows;
}

test("exports: TXT / CSV / Markdown list every context; old entries export cleanly", async () => {
  const { run } = await loadExtensionWithBank();

  const txt = run("exportVocabAsTxt(vocabulary)");
  assert.match(txt, /语境 1\/2:\n  当前语境: 此处指金融机构：银行\n  原句: The bank approved my loan\.\n  原句翻译: 银行批准了我的贷款。\n  出处: Money News/);
  assert.match(txt, /语境 2\/2:\n  当前语境: 此处指河岸\n  原句: We sat on the bank of the river\.\n  原句翻译: 我们坐在河岸上。\n  出处: River Tales · Chapter 3/);
  assert.match(txt, /【prayer】[\s\S]*用法: 宗教场合的用法说明/);

  const rows = parseCsv(run("exportVocabAsCsv(vocabulary)"));
  const [header, ...body] = rows;
  // 0.11.1 appends 派生词 / 同义词 after the Phase 3 columns; nothing before them moves
  assert.equal(header.length, 21, "only the two 0.11.1 columns appended");
  assert.deepEqual(header.slice(15, 19), ["当前语境", "原句", "原句翻译", "出处"]);
  assert.deepEqual(header.slice(-2), ["派生词", "同义词"]);
  body.forEach((r) => assert.equal(r.length, header.length, "same column count on every row"));
  const bank = body.find((r) => r[3] === "bank");
  const prayer = body.find((r) => r[3] === "prayer");
  assert.deepEqual(bank.slice(15, 19), [
    "[1] 此处指金融机构：银行\n[2] 此处指河岸",
    "[1] The bank approved my loan.\n[2] We sat on the bank of the river.",
    "[1] 银行批准了我的贷款。\n[2] 我们坐在河岸上。",
    "[1] Money News\n[2] River Tales · Chapter 3",
  ]);
  assert.deepEqual(prayer.slice(15), ["", "", "", "", "", ""]);

  const md = run("exportVocabAsMarkdown(vocabulary)");
  assert.match(md, /- \*\*语境 1\/2\*\*:\n  - \*\*当前语境\*\*: 此处指金融机构：银行\n  - \*\*原句\*\*: The bank approved my loan\./);
  assert.match(md, /- \*\*语境 2\/2\*\*:\n  - \*\*当前语境\*\*: 此处指河岸\n  - \*\*原句\*\*: We sat on the bank of the river\./);
  assert.match(md, /  - \*\*出处\*\*: River Tales · Chapter 3/);

  for (const out of [txt, md, rows.flat().join("|")]) assert.doesNotMatch(out, /undefined|\[object Object\]|NaN/);
});
