/**
 * Phase 4 REVIEW_VOCAB: a rating is applied by the service worker inside the Phase 2
 * per-key queue, on the latest stored list, to ONE entry identified by its id.
 * Contexts and lexical data are preserved; concurrent adds / deletes are not lost;
 * failures leave storage untouched and the queue keeps working.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackground, evalIn } = require("./helpers/extension-sandbox");

const VOCAB = "zehVocabulary";
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const plain = (value) => JSON.parse(JSON.stringify(value));
/** Writes of the vocabulary key only (the worker also writes cache metadata on start). */
const vocabWrites = (bg) => bg.local.setCalls.filter((keys) => keys.includes(VOCAB)).length;

function entry(id, serial, term, extra) {
  return {
    id,
    serial,
    savedAt: NOW - DAY + serial,
    savedAtLocal: "2026/10/06 12:00:00",
    term,
    queryType: "word",
    short_meaning: `${term} 的意思`,
    memory_tip: `${term} tip`,
    contexts: [
      { id: `ctx-${id}-1`, sentence: `The ${term} approved my loan.`, meaning_here: "此处一" },
      { id: `ctx-${id}-2`, sentence: `We sat on the ${term} of the river.`, meaning_here: "此处二" },
    ],
    review: {
      status: "new",
      dueAt: NOW - DAY + serial,
      intervalDays: 0,
      ease: 2.5,
      reviewCount: 0,
      lapseCount: 0,
      lastReviewedAt: null,
      lastRating: null,
    },
    ...(extra || {}),
  };
}

function setup(list) {
  const bg = loadBackground({ storage: { [VOCAB]: list || [entry("a", 2, "bank"), entry("b", 1, "issue")] } });
  evalIn(bg.context, `Date.now = () => ${NOW}`);
  return bg;
}

const find = (bg, id) => bg.local.data[VOCAB].find((v) => v.id === id);

test("a rating updates only that entry's review state; contexts and lexical data are kept", async () => {
  const bg = setup();
  const before = plain(bg.local.data[VOCAB]);
  const res = await bg.dispatch({ type: "REVIEW_VOCAB", id: "a", rating: "good", expectedReviewCount: 0 });
  assert.deepEqual(res, {
    ok: true,
    id: "a",
    review: {
      status: "review",
      dueAt: NOW + DAY,
      intervalDays: 1,
      ease: 2.5,
      reviewCount: 1,
      lapseCount: 0,
      lastReviewedAt: NOW,
      lastRating: "good",
    },
  });
  const [a, b] = bg.local.data[VOCAB];
  const { review, ...rest } = a;
  const { review: oldReview, ...oldRest } = before[0];
  assert.deepEqual(plain(rest), oldRest, "contexts, meanings, ids untouched");
  assert.deepEqual(plain(review), res.review);
  assert.deepEqual(plain(b), before[1], "the other entry is untouched");
});

test("invalid requests and unknown ids return a clear result without writing", async () => {
  const bg = setup();
  const writes = vocabWrites(bg);
  for (const msg of [
    { id: "a", rating: "perfect" },
    { id: "", rating: "good" },
    { rating: "good" },
    { id: { $ne: 1 }, rating: "good" },
  ]) {
    const res = await bg.dispatch({ type: "REVIEW_VOCAB", ...msg });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "invalid");
  }
  assert.equal((await bg.dispatch({ type: "REVIEW_VOCAB", id: "missing", rating: "good" })).reason, "not_found");
  assert.equal(vocabWrites(bg), writes);
});

test("a stale rating (the card was already rated elsewhere) is not applied twice", async () => {
  const bg = setup();
  await bg.dispatch({ type: "REVIEW_VOCAB", id: "a", rating: "good", expectedReviewCount: 0 });
  const writes = vocabWrites(bg);
  const res = await bg.dispatch({ type: "REVIEW_VOCAB", id: "a", rating: "easy", expectedReviewCount: 0 });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "stale");
  assert.equal(res.review.reviewCount, 1, "returns the latest state so the page can move on");
  assert.equal(vocabWrites(bg), writes);
  assert.equal(find(bg, "a").review.lastRating, "good");
});

test("concurrent add + review: both land, nothing unrelated is lost", async () => {
  const bg = setup();
  const [added, reviewed] = await Promise.all([
    bg.dispatch({ type: "ADD_VOCAB", item: { term: "charlie", queryType: "word", short_meaning: "c", context_sentence: "Charlie said hi." } }),
    bg.dispatch({ type: "REVIEW_VOCAB", id: "b", rating: "again" }),
    bg.dispatch({ type: "ADD_VOCAB", item: { term: "bank", queryType: "word", context_sentence: "Blood bank donors were thanked." } }),
  ]);
  assert.equal(added.added, true);
  assert.equal(reviewed.ok, true);
  const list = bg.local.data[VOCAB];
  assert.deepEqual(list.map((v) => v.term), ["charlie", "bank", "issue"]);
  assert.equal(find(bg, "b").review.status, "learning");
  assert.equal(find(bg, "a").contexts.length, 3, "a context added while another entry was reviewed");
});

test("concurrent delete + review: the queue order decides, and both outcomes are clean", async () => {
  // delete first, then review the same entry → not_found, nothing resurrected
  const first = setup();
  const [del, rev] = await Promise.all([
    first.dispatch({ type: "DELETE_VOCAB", ids: ["a"] }),
    first.dispatch({ type: "REVIEW_VOCAB", id: "a", rating: "good" }),
  ]);
  assert.equal(del.removed, 1);
  assert.equal(rev.reason, "not_found");
  assert.deepEqual(first.local.data[VOCAB].map((v) => v.id), ["b"]);

  // review first, then delete → the delete wins in the end
  const second = setup();
  const [rev2, del2] = await Promise.all([
    second.dispatch({ type: "REVIEW_VOCAB", id: "a", rating: "good" }),
    second.dispatch({ type: "DELETE_VOCAB", ids: ["a"] }),
  ]);
  assert.equal(rev2.ok, true);
  assert.equal(del2.removed, 1);
  assert.deepEqual(second.local.data[VOCAB].map((v) => v.id), ["b"]);

  // reviewing one entry while another is deleted: both happen
  const third = setup();
  await Promise.all([
    third.dispatch({ type: "REVIEW_VOCAB", id: "a", rating: "easy" }),
    third.dispatch({ type: "DELETE_VOCAB", ids: ["b"] }),
  ]);
  assert.deepEqual(third.local.data[VOCAB].map((v) => v.id), ["a"]);
  assert.equal(find(third, "a").review.intervalDays, 4);
});

test("a failed write returns ok:false, leaves storage as it was, and the queue recovers", async () => {
  const bg = setup();
  const before = plain(bg.local.data[VOCAB]);
  bg.local.failSetWith = new Error("QUOTA_BYTES quota exceeded");
  const res = await bg.dispatch({ type: "REVIEW_VOCAB", id: "a", rating: "good" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "error");
  assert.match(res.message, /QUOTA_BYTES/);
  assert.deepEqual(plain(bg.local.data[VOCAB]), before, "nothing corrupted");

  bg.local.failSetWith = null;
  assert.equal((await bg.dispatch({ type: "REVIEW_VOCAB", id: "a", rating: "good" })).ok, true);
  assert.equal((await bg.dispatch({ type: "ADD_VOCAB", item: { term: "delta", queryType: "word" } })).added, true);
  assert.equal(find(bg, "a").review.reviewCount, 1);
});

test("a broken system clock is refused instead of writing a bad due date", async () => {
  const bg = setup();
  evalIn(bg.context, "Date.now = () => Number.NaN");
  const writes = vocabWrites(bg);
  const res = await bg.dispatch({ type: "REVIEW_VOCAB", id: "a", rating: "good" });
  assert.equal(res.ok, false);
  assert.equal(res.reason, "invalid");
  assert.equal(vocabWrites(bg), writes);
});

test("reviewing an entry that was never migrated migrates it in the same write", async () => {
  const legacy = {
    id: "old",
    serial: 5,
    savedAt: NOW - 3 * DAY,
    term: "bank",
    queryType: "word",
    short_meaning: "银行",
    context_sentence: "The bank approved my loan.",
    meaning_here: "银行",
  };
  const bg = setup([legacy]);
  const res = await bg.dispatch({ type: "REVIEW_VOCAB", id: "old", rating: "hard" });
  assert.equal(res.ok, true);
  const [saved] = bg.local.data[VOCAB];
  assert.equal(saved.contexts[0].sentence, "The bank approved my loan.");
  assert.equal("context_sentence" in saved, false);
  assert.equal(saved.review.status, "learning");
  assert.equal(saved.review.dueAt, NOW + 30 * 60 * 1000);
});

test("bank's next review exposes the other saved context (rotation after an authoritative review)", async () => {
  const bg = setup();
  const pick = () => plain(evalIn(bg.context, `zehPickReviewContext(${JSON.stringify(find(bg, "a"))})`)).context.id;
  assert.equal(pick(), "ctx-a-1");
  await bg.dispatch({ type: "REVIEW_VOCAB", id: "a", rating: "good" });
  assert.equal(pick(), "ctx-a-2");
  evalIn(bg.context, `Date.now = () => ${NOW + DAY}`);
  await bg.dispatch({ type: "REVIEW_VOCAB", id: "a", rating: "good" });
  assert.equal(pick(), "ctx-a-1");
});
