/**
 * Phase 4 migration: Phase 1–3 vocabulary entries become v2 entries (contexts[] + review)
 * losslessly and idempotently. The service worker persists it (MIGRATE_VOCAB, onInstalled);
 * Settings reads old entries the same way in memory and never writes the list itself.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig, runFile, evalIn, loadBackground, createStorageArea, createEvent, waitFor } = require("./helpers/extension-sandbox");
const { loadSettingsPage } = require("./helpers/settings-page");

const VOCAB = "zehVocabulary";
const plain = (value) => JSON.parse(JSON.stringify(value));
/** Writes of the vocabulary key only (the worker also writes cache metadata on start). */
const vocabWrites = (bg) => bg.local.setCalls.filter((keys) => keys.includes(VOCAB)).length;

function loadVocabReview() {
  const context = loadConfig();
  runFile(context, "vocab-review.js");
  return context;
}

/** A Phase 3 entry saved after the context enhancement (flat context fields). */
function phase3Bank() {
  return {
    id: "1791366473041-ab12cd",
    serial: 42,
    savedAt: 1791366473041,
    savedAtLocal: "2026/10/07 17:47:53",
    term: "bank",
    queryType: "word",
    phonetic: "/bæŋk/",
    part_of_speech: "noun",
    short_meaning: "银行；堤；岸；库",
    context_meaning: "金融机构或河流两侧的土地",
    examples: [{ en: "The bank raised its rates.", zh: "银行提高了利率。" }],
    memory_tip: "bank → 银行",
    pageUrl: "https://example.com/news/123",
    pageTitle: "Money News",
    context_sentence: "The bank approved my loan.",
    sourceType: "web",
    meaning_here: "此处指金融机构：银行",
    pos_here: "名词",
    sentence_translation: "银行批准了我的贷款。",
  };
}

/** A Phase 1/2 entry: no context at all. */
function phase2Prayer() {
  return {
    id: "1700000000001-zz99yy",
    serial: 1,
    savedAt: 1700000000001,
    savedAtLocal: "2023-11-14 22:13",
    term: "prayer",
    queryType: "word",
    short_meaning: "祈祷",
    context_meaning: "宗教场合",
    examples: [{ en: "a quiet prayer", zh: "默默的祈祷" }],
    pageUrl: "https://example.test/old",
  };
}

test("a Phase 3 flat context becomes contexts[0]; ids, serials, time and lexical data are kept", () => {
  const ctx = loadVocabReview();
  const { item, changed } = plain(evalIn(ctx, `zehMigrateVocabItem(${JSON.stringify(phase3Bank())})`));
  assert.equal(changed, true);
  assert.deepEqual(item.contexts, [
    {
      id: item.contexts[0].id,
      sentence: "The bank approved my loan.",
      meaning_here: "此处指金融机构：银行",
      pos_here: "名词",
      sentence_translation: "银行批准了我的贷款。",
      sourceType: "web",
      pageTitle: "Money News",
      pageUrl: "https://example.com/news/123",
      savedAt: 1791366473041,
    },
  ]);
  assert.match(item.contexts[0].id, /^ctx-[0-9a-f]{8}$/);
  for (const key of ["context_sentence", "meaning_here", "pos_here", "sentence_translation", "sourceType", "pageTitle"]) {
    assert.equal(key in item, false, `${key} moved into the context`);
  }
  const original = phase3Bank();
  for (const key of ["id", "serial", "savedAt", "savedAtLocal", "term", "queryType", "phonetic", "part_of_speech", "short_meaning", "context_meaning", "examples", "memory_tip", "pageUrl"]) {
    assert.deepEqual(item[key], original[key], `${key} unchanged`);
  }
  assert.deepEqual(item.review, {
    status: "new",
    dueAt: 1791366473041,
    intervalDays: 0,
    ease: 2.5,
    reviewCount: 0,
    lapseCount: 0,
    lastReviewedAt: null,
    lastRating: null,
  });
});

test("an EPUB context keeps its book, chapter and CFI inside the context", () => {
  const ctx = loadVocabReview();
  const book = { id: "7", title: "River Tales", author: "A. Writer", chapterIndex: 2, chapterTitle: "Chapter 3", cfi: "epubcfi(/6/6!/4/2/1:30)" };
  const entry = { ...phase3Bank(), sourceType: "epub", pageTitle: "River Tales", book };
  const { item } = plain(evalIn(ctx, `zehMigrateVocabItem(${JSON.stringify(entry)})`));
  assert.deepEqual(item.contexts[0].book, book);
  assert.equal(item.contexts[0].sourceType, "epub");
  assert.equal("book" in item, false);
});

test("an entry without context gets contexts: [] and a new review state, nothing else changes", () => {
  const ctx = loadVocabReview();
  const { item, changed } = plain(evalIn(ctx, `zehMigrateVocabItem(${JSON.stringify(phase2Prayer())})`));
  assert.equal(changed, true);
  assert.deepEqual(item.contexts, []);
  assert.equal(item.review.status, "new");
  assert.equal(item.review.dueAt, phase2Prayer().savedAt, "reviewable at once");
  const { contexts, review, ...rest } = item;
  assert.deepEqual(rest, phase2Prayer());
});

test("migration is idempotent: a second run changes nothing and never duplicates a context", () => {
  const ctx = loadVocabReview();
  const once = plain(evalIn(ctx, `zehMigrateVocabularyList(${JSON.stringify([phase3Bank(), phase2Prayer()])})`));
  assert.equal(once.changed, 2);
  const twice = plain(evalIn(ctx, `zehMigrateVocabularyList(${JSON.stringify(once.list)})`));
  assert.equal(twice.changed, 0);
  assert.deepEqual(twice.list, once.list);
  assert.equal(twice.list[0].contexts.length, 1);

  // an entry that already has the context in contexts[] AND still carries the flat copy
  // (e.g. written by an older build) is merged, not duplicated
  const both = { ...once.list[0], ...phase3Bank(), contexts: once.list[0].contexts, review: once.list[0].review };
  const merged = plain(evalIn(ctx, `zehMigrateVocabItem(${JSON.stringify(both)})`));
  assert.equal(merged.item.contexts.length, 1);
  assert.equal("context_sentence" in merged.item, false);
});

test("malformed old data fails safely: no throw, no lost entry, bad fields left as they were", () => {
  const ctx = loadVocabReview();
  const list = [
    { ...phase2Prayer(), id: "a", context_sentence: 42 },
    { ...phase2Prayer(), id: "b", term: "blank", context_sentence: "   " },
    { ...phase2Prayer(), id: "c", term: "junkbook", context_sentence: "A junkbook sentence.", book: "not an object", meaning_here: { html: "<b>x</b>" } },
    { ...phase2Prayer(), id: "d", term: "badreview", review: { status: "weird", dueAt: "soon", ease: Number.NaN, intervalDays: -4, reviewCount: -1 } },
    null,
    "a stray string",
    { ...phase2Prayer(), id: undefined, serial: 9, term: "noid" },
  ];
  const out = plain(evalIn(ctx, `zehMigrateVocabularyList(${JSON.stringify(list)})`));
  assert.equal(out.list.length, list.length, "nothing dropped from storage");
  const [a, b, c, d, nul, str, noid] = out.list;
  assert.equal(a.context_sentence, 42, "non-string sentence kept as-is");
  assert.deepEqual(a.contexts, []);
  assert.deepEqual(b.contexts, []);
  assert.equal(c.contexts.length, 1);
  assert.equal(c.contexts[0].sentence, "A junkbook sentence.");
  assert.equal("book" in c.contexts[0], false);
  assert.equal("meaning_here" in c.contexts[0], false);
  assert.equal(c.book, "not an object", "fields that could not be migrated stay where they were");
  assert.deepEqual(c.meaning_here, { html: "<b>x</b>" });
  assert.deepEqual(d.review, {
    status: "new",
    dueAt: phase2Prayer().savedAt,
    intervalDays: 0,
    ease: 2.5,
    reviewCount: 0,
    lapseCount: 0,
    lastReviewedAt: null,
    lastRating: null,
  });
  assert.equal(nul, null);
  assert.equal(str, "a stray string");
  assert.match(noid.id, /^legacy-9-/);
  const again = plain(evalIn(ctx, `zehMigrateVocabularyList(${JSON.stringify(out.list)})`));
  assert.equal(again.changed, 0, "stable on the second run");
  assert.equal(again.list[6].id, noid.id, "the generated id is deterministic");

  const readable = plain(evalIn(ctx, `zehNormalizeVocabularyList(${JSON.stringify(list)})`));
  assert.deepEqual(readable.map((v) => v.term), ["prayer", "blank", "junkbook", "badreview", "noid"], "readers skip junk");
});

test("MIGRATE_VOCAB persists the migration once; a second call does not write", async () => {
  const bg = loadBackground({ storage: { [VOCAB]: [phase3Bank(), phase2Prayer()] } });
  const first = await bg.dispatch({ type: "MIGRATE_VOCAB" });
  assert.deepEqual(first, { ok: true, migrated: 2 });
  const [bank, prayer] = bg.local.data[VOCAB];
  assert.equal(bank.contexts[0].sentence, "The bank approved my loan.");
  assert.deepEqual(prayer.contexts, []);
  assert.equal(bank.serial, 42);
  assert.equal(prayer.id, phase2Prayer().id);

  const writes = vocabWrites(bg);
  assert.deepEqual(await bg.dispatch({ type: "MIGRATE_VOCAB" }), { ok: true, migrated: 0 });
  assert.equal(vocabWrites(bg), writes, "already migrated: no write");
});

test("reloading / updating the extension (onInstalled) migrates the vocabulary", async () => {
  const bg = loadBackground({ storage: { [VOCAB]: [phase3Bank()] } });
  evalIn(bg.context, "chrome.runtime.onInstalled.listeners.forEach((fn) => fn({ reason: 'update' }))");
  await waitFor(() => Array.isArray(bg.local.data[VOCAB][0].contexts), 1000, "migration");
  assert.equal(bg.local.data[VOCAB][0].contexts.length, 1);
});

test("a migration write failure leaves storage untouched and the queue usable", async () => {
  const bg = loadBackground({ storage: { [VOCAB]: [phase3Bank()] } });
  bg.local.failSetWith = new Error("QUOTA_BYTES quota exceeded");
  const res = await bg.dispatch({ type: "MIGRATE_VOCAB" });
  assert.equal(res.ok, false);
  assert.equal(bg.local.data[VOCAB][0].context_sentence, "The bank approved my loan.");
  bg.local.failSetWith = null;
  assert.equal((await bg.dispatch({ type: "MIGRATE_VOCAB" })).migrated, 1);
});

test("Settings shows old entries in the v2 shape at once and asks the worker to persist it", async () => {
  const onChanged = createEvent();
  const local = createStorageArea({ [VOCAB]: [phase3Bank(), phase2Prayer()] }, { onChanged });
  const bg = loadBackground({ local, onChanged });
  const sent = [];
  const settings = await loadSettingsPage({
    local,
    onChanged,
    sendMessage: (m) => {
      sent.push(m.type);
      return bg.dispatch(m);
    },
  });
  assert.ok(sent.includes("MIGRATE_VOCAB"));
  const inPage = plain(settings.vocabulary());
  assert.equal(inPage[0].contexts[0].meaning_here, "此处指金融机构：银行");
  assert.equal(inPage[1].review.status, "new");
  await waitFor(() => Array.isArray(local.data[VOCAB][0].contexts), 1000, "worker migration");
  assert.equal(settings.pageSets.filter((keys) => keys.includes(VOCAB)).length, 0, "Settings never writes the list");
  assert.deepEqual(plain(local.data[VOCAB]), inPage, "the page and storage agree");
});
