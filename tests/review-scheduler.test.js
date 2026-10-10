/**
 * Phase 4 scheduler: (review state, rating, now) → next review state.
 * Pure and deterministic; every expectation below is an exact timestamp from a fixed `now`.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig, runFile, evalIn } = require("./helpers/extension-sandbox");

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0); // 2026-10-07 12:00:00 UTC
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

const ctx = loadConfig();
runFile(ctx, "vocab-review.js");
const plain = (value) => JSON.parse(JSON.stringify(value));
const literal = (a) => (a === undefined ? "undefined" : Number.isNaN(a) ? "NaN" : JSON.stringify(a));
const call = (fn, ...args) => plain(evalIn(ctx, `${fn}(${args.map(literal).join(", ")})`) ?? null);
const schedule = (state, rating, now = NOW) => call("zehScheduleReview", state, rating, now);

const NEW = {
  status: "new",
  dueAt: NOW - DAY,
  intervalDays: 0,
  ease: 2.5,
  reviewCount: 0,
  lapseCount: 0,
  lastReviewedAt: null,
  lastRating: null,
};

function reviewState(intervalDays, ease = 2.5, extra) {
  return { ...NEW, status: "review", intervalDays, ease, reviewCount: 3, dueAt: NOW, ...(extra || {}) };
}

test("a new word's review state is due at once (dueAt = time it was saved)", () => {
  assert.deepEqual(call("zehNewReviewState", NOW - DAY), NEW);
  assert.equal(call("zehNewReviewState", "garbage").dueAt, 0, "invalid save time → due immediately");
});

test("first review of a new word: Again / Hard stay in learning, Good / Easy graduate", () => {
  assert.deepEqual(schedule(NEW, "again"), {
    ...NEW,
    status: "learning",
    dueAt: NOW + 10 * MIN,
    reviewCount: 1,
    lastReviewedAt: NOW,
    lastRating: "again",
  });
  assert.deepEqual(schedule(NEW, "hard"), {
    ...NEW,
    status: "learning",
    dueAt: NOW + 30 * MIN,
    reviewCount: 1,
    lastReviewedAt: NOW,
    lastRating: "hard",
  });
  assert.deepEqual(schedule(NEW, "good"), {
    ...NEW,
    status: "review",
    dueAt: NOW + DAY,
    intervalDays: 1,
    reviewCount: 1,
    lastReviewedAt: NOW,
    lastRating: "good",
  });
  assert.deepEqual(schedule(NEW, "easy"), {
    ...NEW,
    status: "review",
    dueAt: NOW + 4 * DAY,
    intervalDays: 4,
    reviewCount: 1,
    lastReviewedAt: NOW,
    lastRating: "easy",
  });
});

test("learning: Again repeats in 10 min, Good graduates to 1 day; ease never changes while learning", () => {
  const learning = schedule(NEW, "again");
  const again = schedule(learning, "again", NOW + 10 * MIN);
  assert.equal(again.status, "learning");
  assert.equal(again.dueAt, NOW + 20 * MIN);
  assert.equal(again.reviewCount, 2);
  assert.equal(again.lapseCount, 0, "a lapse only counts for words in review");
  const good = schedule(again, "good", NOW + 20 * MIN);
  assert.equal(good.status, "review");
  assert.equal(good.intervalDays, 1);
  assert.equal(good.dueAt, NOW + 20 * MIN + DAY);
  assert.equal(good.ease, 2.5);
});

test("review: exact intervals and ease for each rating (I = 10 days, E = 2.5)", () => {
  const base = reviewState(10);
  assert.deepEqual(schedule(base, "again"), {
    ...base,
    status: "relearning",
    intervalDays: 5,
    ease: 2.3,
    lapseCount: 1,
    dueAt: NOW + 10 * MIN,
    reviewCount: 4,
    lastReviewedAt: NOW,
    lastRating: "again",
  });
  assert.deepEqual(schedule(base, "hard"), {
    ...base,
    intervalDays: 12,
    ease: 2.35,
    dueAt: NOW + 12 * DAY,
    reviewCount: 4,
    lastReviewedAt: NOW,
    lastRating: "hard",
  });
  assert.deepEqual(schedule(base, "good"), {
    ...base,
    intervalDays: 25,
    dueAt: NOW + 25 * DAY,
    reviewCount: 4,
    lastReviewedAt: NOW,
    lastRating: "good",
  });
  assert.deepEqual(schedule(base, "easy"), {
    ...base,
    intervalDays: 33,
    ease: 2.65,
    dueAt: NOW + 33 * DAY,
    reviewCount: 4,
    lastReviewedAt: NOW,
    lastRating: "easy",
  });
});

test("relearning after a lapse: Good returns to the reduced interval, Easy goes a little further", () => {
  const lapsed = schedule(reviewState(10), "again");
  assert.equal(lapsed.status, "relearning");
  const t = NOW + 10 * MIN;
  const again = schedule(lapsed, "again", t);
  assert.equal(again.status, "relearning");
  assert.equal(again.dueAt, t + 10 * MIN);
  assert.equal(again.intervalDays, 5, "the post-lapse interval is remembered");
  assert.equal(again.lapseCount, 1, "no second lapse while relearning");
  assert.equal(schedule(lapsed, "hard", t).dueAt, t + 30 * MIN);
  const good = schedule(lapsed, "good", t);
  assert.deepEqual([good.status, good.intervalDays, good.dueAt, good.ease], ["review", 5, t + 5 * DAY, 2.3]);
  const easy = schedule(lapsed, "easy", t);
  assert.deepEqual([easy.status, easy.intervalDays, easy.dueAt], ["review", 7, t + 7 * DAY]);
});

test("repeated Good: 1 → 3 → 8 → 20 → 50 → 125 → 313 → 365 → 365 days (capped)", () => {
  let state = NEW;
  let now = NOW;
  const intervals = [];
  for (let i = 0; i < 9; i += 1) {
    state = schedule(state, "good", now);
    intervals.push(state.intervalDays);
    assert.equal(state.dueAt, now + state.intervalDays * DAY);
    now = state.dueAt;
  }
  assert.deepEqual(intervals, [1, 3, 8, 20, 50, 125, 313, 365, 365]);
  assert.equal(state.reviewCount, 9);
  assert.equal(state.ease, 2.5);
});

test("ease stays within 1.3 – 3.0; intervals within 1 – 365 days", () => {
  assert.equal(schedule(reviewState(10, 1.3), "again").ease, 1.3);
  assert.equal(schedule(reviewState(10, 1.35), "hard").ease, 1.3);
  assert.equal(schedule(reviewState(10, 3.0), "easy").ease, 3.0);
  assert.equal(schedule(reviewState(1), "again").intervalDays, 1, "a lapse never drops below 1 day");
  assert.equal(schedule(reviewState(300, 3.0), "easy").intervalDays, 365);
  let state = reviewState(1, 1.3);
  for (let i = 0; i < 20; i += 1) state = schedule(state, "hard", NOW + i * DAY);
  assert.ok(state.intervalDays <= 365 && state.ease === 1.3);
});

test("invalid ratings or clocks are refused (null), never a broken state", () => {
  assert.equal(schedule(NEW, "meh"), null);
  assert.equal(schedule(NEW, undefined), null);
  for (const now of [Number.NaN, 0, -5, Date.UTC(1999, 0, 1), Date.UTC(2200, 0, 1), "2026-10-07"]) {
    assert.equal(schedule(NEW, "good", now), null, String(now));
  }
});

test("corrupted state is repaired before scheduling (NaN, negatives, unknown status, huge values)", () => {
  const broken = { status: "weird", dueAt: "soon", intervalDays: -5, ease: Number.NaN, reviewCount: -1, lapseCount: 1.5 };
  const next = schedule(broken, "good");
  assert.deepEqual(next, {
    status: "review",
    dueAt: NOW + DAY,
    intervalDays: 1,
    ease: 2.5,
    reviewCount: 1,
    lapseCount: 0,
    lastReviewedAt: NOW,
    lastRating: "good",
  });
  const huge = schedule({ status: "review", intervalDays: 1e9, ease: 99, dueAt: NOW }, "good");
  assert.equal(huge.intervalDays, 365);
  assert.equal(huge.ease, 3.0);
  assert.equal(huge.dueAt, NOW + 365 * DAY);
  assert.equal(schedule(null, "again").status, "learning");
  for (const value of Object.values(next)) assert.ok(value === null || typeof value !== "number" || Number.isFinite(value));
});

test("the scheduler is pure: same input, same output; the input is not modified", () => {
  const input = reviewState(10);
  const snapshot = JSON.stringify(input);
  const a = evalIn(ctx, `(() => { const s = ${snapshot}; const out = zehScheduleReview(s, "good", ${NOW}); return JSON.stringify([s, out]); })()`);
  const [after, out] = JSON.parse(a);
  assert.equal(JSON.stringify(after), snapshot);
  assert.deepEqual(out, schedule(input, "good"));
});

test("button previews and delay labels", () => {
  const preview = call("zehReviewPreview", NEW, NOW);
  const labels = Object.fromEntries(
    Object.entries(preview).map(([rating, next]) => [rating, call("zehFormatReviewDelay", next.dueAt - NOW)])
  );
  assert.deepEqual(labels, { again: "10 分钟", hard: "30 分钟", good: "1 天", easy: "4 天" });
  assert.equal(call("zehFormatReviewDelay", 3 * 60 * MIN), "3 小时");
  assert.equal(call("zehFormatReviewDelay", 125 * DAY), "4 个月");
  assert.equal(call("zehFormatReviewDelay", 365 * DAY), "1 年");
});
