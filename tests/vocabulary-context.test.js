/**
 * Phase 3 vocabulary: entries keep where the word was met (sentence, meaning here,
 * page / book location). Writes still go through the service worker queue (Phase 2),
 * old entries stay valid, and Settings search / export understand the new fields.
 * Phase 4: the same information now lives in the entry's contexts[] (one context per
 * sentence) instead of flat fields; the assertions below read it from there.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { loadBackground, createStorageArea, createEvent } = require("./helpers/extension-sandbox");
const { loadSettingsPage } = require("./helpers/settings-page");

const VOCAB = "zehVocabulary";
const plain = (value) => JSON.parse(JSON.stringify(value));

function contextual(term, extra) {
  return {
    term,
    queryType: "word",
    short_meaning: "银行；河岸",
    pageUrl: "https://example.test/news",
    pageTitle: "Money News",
    context_sentence: `The ${term} approved my loan.`,
    sourceType: "web",
    meaning_here: "此处指金融机构：银行",
    pos_here: "名词",
    sentence_translation: "银行批准了我的贷款。",
    examples: [{ en: "The bank raised its rates.", zh: "银行提高了利率。" }],
    ...(extra || {}),
  };
}

function legacyEntry(term, serial) {
  return {
    id: `old-${serial}`,
    serial,
    savedAt: 1700000000000 + serial,
    savedAtLocal: "2023-11-14 22:13",
    term,
    queryType: "word",
    short_meaning: `${term} 的意思`,
    context_meaning: "旧版的通用语境说明",
    pageUrl: "https://example.test/old",
    examples: [{ en: `${term} example`, zh: "例句" }],
  };
}

async function loadExtension(initial) {
  const onChanged = createEvent();
  const local = createStorageArea(initial, { onChanged });
  const bg = loadBackground({ local, onChanged });
  const settings = await loadSettingsPage({ local, onChanged, sendMessage: (m) => bg.dispatch(m) });
  const run = (code) => vm.runInContext(code, settings.context);
  return { bg, settings, local, run };
}

test("ADD_VOCAB saves the source sentence, meaning here and page / book location", async () => {
  const bg = loadBackground({ storage: { [VOCAB]: [legacyEntry("prayer", 1)] } });
  const book = { id: "7", title: "River Tales", author: "A. Writer", chapterIndex: 2, chapterTitle: "Chapter 3", cfi: "epubcfi(/6/6!/4/2/1:30)" };
  const res = await bg.dispatch({ type: "ADD_VOCAB", item: contextual("bank", { sourceType: "epub", book }) });
  assert.equal(res.added, true);
  const [saved, old] = bg.local.data[VOCAB];
  assert.equal(saved.contexts.length, 1);
  const [ctx] = saved.contexts;
  assert.equal(ctx.sentence, "The bank approved my loan.");
  assert.equal(ctx.meaning_here, "此处指金融机构：银行");
  assert.equal(ctx.pos_here, "名词");
  assert.equal(ctx.sentence_translation, "银行批准了我的贷款。");
  assert.equal(ctx.sourceType, "epub");
  assert.equal(ctx.pageTitle, "Money News");
  assert.deepEqual(plain(ctx.book), book);
  for (const key of ["context_sentence", "meaning_here", "pos_here", "sentence_translation", "sourceType", "book"]) {
    assert.equal(key in saved, false, `${key} is not duplicated on the entry`);
  }
  assert.equal(saved.serial, 2);
  assert.deepEqual(plain(old), legacyEntry("prayer", 1), "old entries are left exactly as they were");
});

test("ADD_VOCAB bounds and type-checks the context fields (never trusts the page)", async () => {
  const bg = loadBackground();
  await bg.dispatch({
    type: "ADD_VOCAB",
    item: contextual("bank", {
      context_sentence: `The bank\u0007 approved\n\n my loan. ${"x".repeat(2000)}`,
      meaning_here: { html: "<b>x</b>" },
      pos_here: "",
      sentence_translation: "银行批准了我的贷款，（全角标点保留）。",
      sourceType: "javascript:",
      pageTitle: "T".repeat(1000),
      book: { id: 7, title: "River Tales", chapterIndex: -1, cfi: "c".repeat(5000), extra: "dropped" },
    }),
  });
  const [ctx] = bg.local.data[VOCAB][0].contexts;
  assert.ok(ctx.sentence.startsWith("The bank approved my loan. x"));
  assert.ok(ctx.sentence.length <= 400);
  assert.equal("meaning_here" in ctx, false, "non-string removed");
  assert.equal("pos_here" in ctx, false, "empty string removed");
  assert.equal(ctx.sentence_translation, "银行批准了我的贷款，（全角标点保留）。");
  assert.equal("sourceType" in ctx, false);
  assert.equal(ctx.pageTitle.length, 300);
  assert.deepEqual(Object.keys(ctx.book).sort(), ["cfi", "title"]);
  assert.equal(ctx.book.cfi.length, 600);

  await bg.dispatch({ type: "ADD_VOCAB", item: contextual("loan", { book: "not an object" }) });
  const loan = bg.local.data[VOCAB][0];
  assert.equal("book" in loan, false);
  assert.equal("book" in loan.contexts[0], false);
});

test("words saved without context (PDF, sentences, old flow) are stored as before", async () => {
  const bg = loadBackground();
  const item = { term: "postpone", queryType: "word", short_meaning: "推迟", pageUrl: "https://example.test/pdf" };
  await bg.dispatch({ type: "ADD_VOCAB", item });
  const [saved] = bg.local.data[VOCAB];
  for (const key of ["context_sentence", "meaning_here", "sourceType", "book"]) {
    assert.equal(key in saved, false, key);
  }
  assert.equal(saved.short_meaning, "推迟");
});

test("Phase 2 concurrency still holds for adds that carry context", async () => {
  const bg = loadBackground({ storage: { [VOCAB]: [legacyEntry("prayer", 1)] } });
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"];
  const results = await Promise.all(
    words.map((t, i) => bg.dispatch({ type: "ADD_VOCAB", item: contextual(t) }, { tab: { id: i + 1 } }))
  );
  results.forEach((r) => assert.equal(r.added, true));
  const list = bg.local.data[VOCAB];
  assert.equal(list.length, words.length + 1);
  const serials = list.map((v) => v.serial);
  assert.equal(new Set(serials).size, serials.length, "unique serials");
  words.forEach((t) => {
    const entry = list.find((v) => v.term === t);
    assert.equal(entry.contexts[0].sentence, `The ${t} approved my loan.`, "each entry keeps its own sentence");
  });
  // Phase 4: the same term in another sentence is still one entry, with a second context
  const more = await bg.dispatch({ type: "ADD_VOCAB", item: contextual("Alpha", { context_sentence: "Alpha waves were measured." }) });
  assert.equal(more.added, false);
  assert.equal(more.contextAdded, true);
  const after = bg.local.data[VOCAB];
  assert.equal(after.length, words.length + 1, "no second alpha entry");
  assert.deepEqual(
    after.find((v) => v.term === "alpha").contexts.map((c) => c.sentence),
    ["The alpha approved my loan.", "Alpha waves were measured."]
  );
});

test("Settings: list shows meaning here + sentence; search finds the sentence and the meaning", async () => {
  const ext = await loadExtension({
    [VOCAB]: [
      { id: "n-2", serial: 2, savedAt: 1700000000002, ...contextual("bank") },
      legacyEntry("prayer", 1),
    ],
  });
  const html = ext.settings.listHtml();
  assert.match(html, /vocab-meaning-here/);
  assert.match(html, /此处指金融机构：银行/);
  assert.match(html, /The bank approved my loan\./);
  assert.match(html, /Money News/);
  assert.doesNotMatch(html, /undefined/);

  const search = (q) => {
    ext.settings.setSearch(q);
    ext.run("renderVocabList()");
    return ext.run("vocabState._filteredList.map((v) => v.term)");
  };
  assert.deepEqual(plain(search("approved my loan")), ["bank"]);
  assert.deepEqual(plain(search("金融机构")), ["bank"]);
  assert.deepEqual(plain(search("prayer")), ["prayer"], "old entries are still searchable");
  assert.deepEqual(plain(search("")).sort(), ["bank", "prayer"]);
});

/** Minimal RFC-4180 reader for the exported CSV (quoted fields, embedded commas / newlines). */
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

test("exports: TXT / CSV / Markdown include context; old entries export without gaps", async () => {
  const book = { title: "River Tales", chapterTitle: "Chapter 3", chapterIndex: 2 };
  const ext = await loadExtension({
    [VOCAB]: [
      { id: "n-3", serial: 3, savedAt: 1700000000003, ...contextual("bank", { context_sentence: 'He said, "The bank approved my loan."', book }) },
      legacyEntry("prayer", 1),
    ],
  });
  const items = ext.run("vocabulary");

  const txt = ext.run("exportVocabAsTxt(vocabulary)");
  assert.match(txt, /当前语境: 此处指金融机构：银行/);
  assert.match(txt, /原句: He said, "The bank approved my loan\."/);
  assert.match(txt, /原句翻译: 银行批准了我的贷款。/);
  assert.match(txt, /出处: River Tales · Chapter 3/);
  assert.match(txt, /用法: 旧版的通用语境说明/, "old context_meaning still exported");

  const rows = parseCsv(ext.run("exportVocabAsCsv(vocabulary)"));
  const [header, ...body] = rows;
  assert.deepEqual(header.slice(15, 19), ["当前语境", "原句", "原句翻译", "出处"], "Phase 3 columns appended after the old ones");
  body.forEach((r) => assert.equal(r.length, header.length, "same column count on every row"));
  const bank = body.find((r) => r.includes("bank"));
  const prayer = body.find((r) => r.includes("prayer"));
  assert.deepEqual(bank.slice(15, 19), ["此处指金融机构：银行", 'He said, "The bank approved my loan."', "银行批准了我的贷款。", "River Tales · Chapter 3"]);
  assert.deepEqual(prayer.slice(15, 19), ["", "", "", ""]);

  const md = ext.run("exportVocabAsMarkdown(vocabulary)");
  assert.match(md, /- \*\*当前语境\*\*: 此处指金融机构：银行/);
  assert.match(md, /- \*\*原句\*\*: He said, "The bank approved my loan\."/);
  assert.match(md, /- \*\*出处\*\*: River Tales · Chapter 3/);

  for (const out of [txt, md, rows.flat().join("|")]) assert.doesNotMatch(out, /undefined|\[object Object\]/);
  assert.equal(items.length, 2);
});

test("exports: CSV cells that a spreadsheet would run as a formula are kept as text", async () => {
  const ext = await loadExtension({
    [VOCAB]: [
      {
        id: "f-1",
        serial: 7,
        savedAt: 1700000000007,
        ...contextual("sum", {
          context_sentence: '=HYPERLINK("https://evil.example","click")',
          meaning_here: "+1 means agree",
          sentence_translation: "@SUM(A1)",
          short_meaning: "-总和",
        }),
      },
    ],
  });
  const csv = ext.run("exportVocabAsCsv(vocabulary)");
  const [header, row] = parseCsv(csv);
  const cell = (name) => row[header.indexOf(name)];
  assert.equal(cell("原句"), `'=HYPERLINK("https://evil.example","click")`);
  assert.equal(cell("当前语境"), "'+1 means agree");
  assert.equal(cell("原句翻译"), "'@SUM(A1)");
  assert.equal(cell("中文释义"), "'-总和");
  assert.equal(cell("词条"), "sum", "ordinary cells are unchanged");
  assert.equal(cell("编号"), "7", "numbers are unchanged");
  for (const value of row) assert.doesNotMatch(value, /^[=+\-@\t\r]/);
});
