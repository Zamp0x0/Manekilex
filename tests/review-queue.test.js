/**
 * Phase 4 review queue and context rotation: deterministic order (due → learning → new),
 * future items excluded, stable ties, bounded sessions, and no dependence on the local
 * time zone. Contexts rotate by review count.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { loadConfig, runFile, evalIn } = require("./helpers/extension-sandbox");

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const ctx = loadConfig();
runFile(ctx, "vocab-review.js");
const plain = (value) => JSON.parse(JSON.stringify(value));
const queue = (items, now = NOW, limits) =>
  plain(evalIn(ctx, `zehBuildReviewQueue(${JSON.stringify(items)}, ${JSON.stringify(now)}, ${JSON.stringify(limits || null)})`));

function entry(id, serial, review) {
  return {
    id,
    serial,
    savedAt: NOW - 30 * DAY + serial,
    term: `w-${id}`,
    queryType: "word",
    short_meaning: id,
    contexts: [],
    review: {
      status: "new",
      dueAt: NOW - 30 * DAY + serial,
      intervalDays: 0,
      ease: 2.5,
      reviewCount: 0,
      lapseCount: 0,
      lastReviewedAt: null,
      lastRating: null,
      ...(review || {}),
    },
  };
}

const FIXTURE = [
  entry("future-review", 3, { status: "review", intervalDays: 5, dueAt: NOW + DAY }),
  entry("new-older", 6),
  entry("overdue", 1, { status: "review", intervalDays: 3, dueAt: NOW - 2 * DAY }),
  entry("tie-9", 9, { status: "review", intervalDays: 2, dueAt: NOW - HOUR }),
  entry("learning-due", 4, { status: "learning", dueAt: NOW - 5 * MIN }),
  entry("due-hour", 2, { status: "review", intervalDays: 2, dueAt: NOW - HOUR }),
  entry("future-learning", 5, { status: "learning", dueAt: NOW + 5 * MIN }),
  entry("relearning-due", 10, { status: "relearning", intervalDays: 2, dueAt: NOW - MIN }),
  entry("tie-8", 8, { status: "review", intervalDays: 2, dueAt: NOW - HOUR }),
  entry("new-newest", 7),
  entry("due-now", 11, { status: "review", intervalDays: 1, dueAt: NOW }),
];

const EXPECTED_SESSION = [
  "overdue",
  "due-hour",
  "tie-8",
  "tie-9",
  "due-now",
  "learning-due",
  "relearning-due",
  "new-newest",
  "new-older",
];

test("order: due / overdue (earliest first) → learning → new (newest first); future excluded", () => {
  const q = queue(FIXTURE);
  assert.deepEqual(q.session, EXPECTED_SESSION);
  assert.deepEqual(q.counts, { due: 5, learning: 2, new: 2, future: 2 });
  assert.equal(q.nextDueAt, NOW + 5 * MIN, "next future item is the learning one");
  assert.ok(!q.session.includes("future-review") && !q.session.includes("future-learning"));
});

test("stable: the same queue for any input order, and on every call", () => {
  const shuffled = [...FIXTURE].reverse();
  const rotated = [...FIXTURE.slice(4), ...FIXTURE.slice(0, 4)];
  assert.deepEqual(queue(shuffled).session, EXPECTED_SESSION);
  assert.deepEqual(queue(rotated).session, EXPECTED_SESSION);
  assert.deepEqual(queue(FIXTURE).session, queue(FIXTURE).session);
});

test("items become due exactly at dueAt (no early or late window)", () => {
  const item = entry("edge", 1, { status: "review", intervalDays: 1, dueAt: NOW });
  assert.deepEqual(queue([item], NOW - 1).session, []);
  assert.deepEqual(queue([item], NOW).session, ["edge"]);
});

test("new words are always reviewable, including old entries that have no review state yet", () => {
  const legacy = { id: "legacy", serial: 1, savedAt: 1700000000000, term: "prayer", short_meaning: "祈祷" };
  const clockSkew = entry("saved-in-the-future", 2, { dueAt: NOW + DAY });
  const q = queue([legacy, clockSkew]);
  assert.deepEqual(q.session, ["saved-in-the-future", "legacy"]);
  assert.equal(q.counts.new, 2);
});

test("session limits: at most 20 new words and 100 cards by default; due words come first", () => {
  const many = Array.from({ length: 30 }, (_, i) => entry(`n${i}`, i + 1));
  assert.equal(queue(many).session.length, 20);
  assert.deepEqual(queue(many).session.slice(0, 2), ["n29", "n28"]);
  assert.deepEqual(queue(FIXTURE, NOW, { maxNew: 1 }).session.slice(-2), ["relearning-due", "new-newest"]);
  assert.deepEqual(queue(FIXTURE, NOW, { maxCards: 3 }).session, ["overdue", "due-hour", "tie-8"]);
  const dueMany = Array.from({ length: 150 }, (_, i) => entry(`d${i}`, i + 1, { status: "review", intervalDays: 1, dueAt: NOW - i }));
  assert.equal(queue(dueMany).session.length, 100);
});

test("empty vocabulary or nothing due: an empty session (the UI shows 今天没有需要复习的单词)", () => {
  assert.deepEqual(queue([]), { session: [], counts: { due: 0, learning: 0, new: 0, future: 0 }, nextDueAt: null });
  const later = [entry("later", 1, { status: "review", intervalDays: 3, dueAt: NOW + 3 * DAY })];
  assert.deepEqual(queue(later).session, []);
  assert.equal(queue(later).nextDueAt, NOW + 3 * DAY);
});

test("a broken clock never makes scheduled words due; new words stay available", () => {
  for (const now of [Number.NaN, 0, Date.UTC(2300, 0, 1)]) {
    const q = queue(FIXTURE, now);
    assert.deepEqual(q.session, ["new-newest", "new-older"], String(now));
  }
});

test("due calculation does not depend on the local time zone", () => {
  const script = `
    const { loadConfig, runFile, evalIn } = require(${JSON.stringify(path.join(__dirname, "helpers", "extension-sandbox.js"))});
    const ctx = loadConfig();
    runFile(ctx, "vocab-review.js");
    const items = ${JSON.stringify(FIXTURE)};
    const q = evalIn(ctx, "zehBuildReviewQueue(" + JSON.stringify(items) + ", ${NOW})");
    const local = evalIn(ctx, "zehFormatLocalTime(${NOW})");
    process.stdout.write(JSON.stringify({ q, local, offset: new Date(${NOW}).getTimezoneOffset() }));
  `;
  const runs = ["UTC", "Asia/Shanghai", "America/Los_Angeles", "Pacific/Kiritimati"].map((TZ) => {
    const out = spawnSync(process.execPath, ["-e", script], { env: { ...process.env, TZ }, encoding: "utf8" });
    assert.equal(out.status, 0, out.stderr);
    return JSON.parse(out.stdout);
  });
  runs.forEach((r) => assert.deepEqual(r.q, runs[0].q));
  assert.deepEqual(runs[0].q.session, EXPECTED_SESSION);
  assert.equal(new Set(runs.map((r) => r.offset)).size, 4, "the time zones really differ");
  assert.equal(new Set(runs.map((r) => r.local)).size, 4, "only the displayed local time differs");
});

// ── context rotation ─────────────────────────────────────────────────────────

const pick = (item) => plain(evalIn(ctx, `zehPickReviewContext(${JSON.stringify(item)})`));

function bankWith(contexts, reviewCount) {
  return { ...entry("bank", 1, { reviewCount }), term: "bank", contexts };
}

const FINANCE = { id: "ctx-a", sentence: "The bank approved my loan.", meaning_here: "银行" };
const RIVER = { id: "ctx-b", sentence: "We sat on the bank of the river.", meaning_here: "河岸" };
const VAULT = { id: "ctx-c", sentence: "Blood bank donors were thanked." };

test("several contexts rotate deterministically: index = reviewCount % contexts", () => {
  const order = [0, 1, 2, 3, 4, 5].map((n) => pick(bankWith([FINANCE, RIVER, VAULT], n)).context.id);
  assert.deepEqual(order, ["ctx-a", "ctx-b", "ctx-c", "ctx-a", "ctx-b", "ctx-c"]);
  assert.deepEqual(pick(bankWith([FINANCE, RIVER], 1)), { context: RIVER, index: 1, total: 2 });
});

test("one context is always shown; zero contexts → null (the card falls back to lexical data)", () => {
  [0, 1, 7].forEach((n) => assert.equal(pick(bankWith([FINANCE], n)).context.id, "ctx-a"));
  assert.equal(pick(bankWith([], 3)), null);
  assert.equal(pick({ term: "x" }), null);
});

test("junk contexts are skipped and a bad reviewCount counts as 0", () => {
  const item = bankWith([null, { meaning_here: "no sentence" }, FINANCE, RIVER], 1);
  assert.deepEqual(pick(item), { context: RIVER, index: 1, total: 2 });
  assert.equal(pick({ ...bankWith([FINANCE, RIVER], 0), review: { reviewCount: -3 } }).context.id, "ctx-a");
});
