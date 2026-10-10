/**
 * M8: reader/progress.js keeps the reader's progress formula exactly as it was in reader.js:
 * progress = clamp((spineIndex + clamp(ratio)) / spine count), on 0..1.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadProgress(spineLength) {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "reader", "progress.js"), "utf8"), context, { filename: "reader/progress.js" });
  let book = spineLength === null ? null : { spine: { length: spineLength } };
  const api = context.zehCreateReaderProgress({ book: () => book });
  return { api, setBook: (b) => (book = b) };
}

test("M8 progress: (spine + ratio) / total, clamped; a ratio outside 0..1 or not a number is clamped first", () => {
  const { api } = loadProgress(4);
  assert.equal(api.getTotalSpineItems(), 4);
  assert.equal(api.calculateProgressFromSpineAndRatio(0, 0), 0);
  assert.equal(api.calculateProgressFromSpineAndRatio(1, 0.5), 0.375);
  assert.equal(api.calculateProgressFromSpineAndRatio(3, 1), 1);
  assert.equal(api.calculateProgressFromSpineAndRatio(2, 7), 0.75, "ratio 7 counts as 1");
  assert.equal(api.calculateProgressFromSpineAndRatio(2, -1), 0.5, "a negative ratio counts as 0");
  assert.equal(api.calculateProgressFromSpineAndRatio(2, Number.NaN), 0.5);
  assert.equal(api.calculateProgressFromSpineAndRatio(9, 0.5), 1, "past the last chapter is still 100%");
  assert.equal(api.calculateProgressFromSpineRatio(1, 0.5, 10), 0.15, "an explicit total wins over the book");
  assert.equal(api.calculateProgressFromSpineRatio(1, 0.5, 0), 0.375, "a total of 0 falls back to the book");
  assert.equal(api.clampRatio("0.25"), 0.25);
  assert.equal(api.clampRatio(undefined), 0);
});

test("M8 progress: no book open yet means no spine and 0%", () => {
  const { api, setBook } = loadProgress(null);
  assert.equal(api.getTotalSpineItems(), 0);
  assert.equal(api.calculateProgressFromSpineAndRatio(2, 0.5), 0);
  setBook({ spine: { length: 5 } });
  assert.equal(api.getTotalSpineItems(), 5, "the book is read when needed, not when the factory runs");
});

test("M8 progress: a stored record's progress uses the given total, else its own, else the book's", () => {
  const { api } = loadProgress(8);
  const record = { currentSpineIndex: 3, chapterScrollRatio: 0.5, totalSpineItems: 4 };
  assert.equal(api.derivedProgressFromRecord(record, 10), 0.35);
  assert.equal(api.derivedProgressFromRecord(record), 0.875);
  assert.equal(api.derivedProgressFromRecord({ currentSpineIndex: 3, chapterScrollRatio: 0.5 }), 0.4375);
  assert.equal(api.derivedProgressFromRecord({ currentSpineIndex: 1.5, chapterScrollRatio: 0.5 }), null, "spine index must be an integer");
  assert.equal(api.derivedProgressFromRecord({ currentSpineIndex: 1 }), null, "no ratio, no derived progress");
  assert.equal(api.derivedProgressFromRecord(null), null);
  assert.equal(loadProgress(null).api.derivedProgressFromRecord({ currentSpineIndex: 1, chapterScrollRatio: 0 }), null, "no total anywhere");
});
