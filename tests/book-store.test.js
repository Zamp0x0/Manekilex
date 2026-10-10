/**
 * R-10 / R-12 (book-store.js): IndexedDB promises settle on abort (quota), and
 * reorderBooks / claimActiveReaderSession read and write inside one transaction so they
 * never overwrite progress fields with a stale list.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { baseGlobals, runFile } = require("./helpers/extension-sandbox");
const { createFakeIndexedDB } = require("./helpers/fake-indexeddb");

function loadBookStore(search) {
  const { indexedDB, IDBKeyRange } = createFakeIndexedDB();
  const logs = [];
  const context = vm.createContext({
    ...baseGlobals(),
    indexedDB,
    IDBKeyRange,
    DOMException: globalThis.DOMException,
    location: { search: search || "" },
    console: {
      log: (...a) => logs.push(["log", ...a]),
      warn: (...a) => logs.push(["warn", ...a]),
      error: (...a) => logs.push(["error", ...a]),
      debug: () => {},
    },
  });
  context.window = context;
  runFile(context, "book-store.js");
  return { store: context.ZEHBookStore, indexedDB, logs };
}

const blob = { size: 3 };

test("addBook / getAllBooks round-trip and assign sortOrder", async () => {
  const { store } = loadBookStore();
  const a = await store.addBook({ title: "A", fileBlob: blob });
  const b = await store.addBook({ title: "B", fileBlob: blob });
  assert.equal(a.sortOrder, 0);
  assert.equal(b.sortOrder, 1);
  const all = await store.getAllBooks();
  assert.deepEqual(Array.from(all, (x) => x.title), ["A", "B"]);
});

test("a write that aborts the transaction (quota) rejects instead of hanging", async () => {
  const { store, indexedDB } = loadBookStore();
  await store.addBook({ id: "b1", title: "A", fileBlob: blob });
  indexedDB.failNextPut("books", "QuotaExceededError");
  const outcome = await Promise.race([
    store.addBook({ id: "b2", title: "B", fileBlob: blob }).then(() => "resolved", (e) => `rejected:${e.name}`),
    new Promise((r) => setTimeout(() => r("hung"), 300)),
  ]);
  assert.equal(outcome, "rejected:QuotaExceededError");
  assert.equal(indexedDB.records("books").length, 1, "nothing half-written");

  indexedDB.failNextPut("books", "QuotaExceededError");
  const progress = await Promise.race([
    store
      .updateBookProgress("b1", { progress: 0.5, persistReason: "scroll-debounce" })
      .then(() => "resolved", (e) => `rejected:${e.name}`),
    new Promise((r) => setTimeout(() => r("hung"), 300)),
  ]);
  assert.equal(progress, "rejected:QuotaExceededError");

  indexedDB.failNextPut("bookmarks", "QuotaExceededError");
  const bm = await Promise.race([
    store.addBookmark({ bookId: "b1", label: "x" }).then(() => "resolved", (e) => `rejected:${e.name}`),
    new Promise((r) => setTimeout(() => r("hung"), 300)),
  ]);
  assert.equal(bm, "rejected:QuotaExceededError");
});

test("reorderBooks changes only sortOrder and keeps progress written meanwhile", async () => {
  const { store, indexedDB } = loadBookStore();
  await store.addBook({ id: "b1", title: "A", fileBlob: blob });
  await store.addBook({ id: "b2", title: "B", fileBlob: blob });
  await store.addBook({ id: "b3", title: "C", fileBlob: blob });
  // The reader (another tab) saved progress after the shelf page loaded its list.
  await store.updateBookProgress("b2", {
    progress: 0.42,
    currentSpineIndex: 7,
    chapterScrollRatio: 0.3,
    persistReason: "scroll-debounce",
  });
  await store.reorderBooks(["b3", "b2", "b1", "missing"]);
  const byId = Object.fromEntries(indexedDB.records("books").map((b) => [b.id, b]));
  assert.deepEqual(
    [byId.b3.sortOrder, byId.b2.sortOrder, byId.b1.sortOrder],
    [0, 1, 2]
  );
  assert.equal(byId.b2.progress, 0.42, "progress not overwritten by the reorder");
  assert.equal(byId.b2.currentSpineIndex, 7);
  assert.equal(byId.b2.chapterScrollRatio, 0.3);
  assert.equal(byId.b2.title, "B");
  const all = await store.getAllBooks();
  assert.deepEqual(Array.from(all, (b) => b.id), ["b3", "b2", "b1"]);
});

test("updateBookProgress rejects disallowed reasons and stale sessions, accepts bookmark-jump", async () => {
  const { store } = loadBookStore();
  await store.addBook({ id: "b1", title: "A", fileBlob: blob });
  const bad = await store.updateBookProgress("b1", { progress: 0.1, persistReason: "random" });
  assert.equal(bad.skipped, true);
  await store.claimActiveReaderSession("b1", "session-A");
  const stale = await store.updateBookProgress("b1", { progress: 0.2, persistReason: "scroll-debounce", updatedBySessionId: "session-B" });
  assert.equal(stale.skipped, true);
  assert.equal(stale.reason, "stale-session");
  const ok = await store.updateBookProgress("b1", { progress: 0.3, currentSpineIndex: 2, persistReason: "bookmark-jump", updatedBySessionId: "session-A" });
  assert.equal(ok.skipped, false);
  assert.equal(ok.book.progress, 0.3);
  assert.equal((await store.getBook("b1")).currentSpineIndex, 2);
});

test("claimActiveReaderSession and deleteBook (cascade) settle through transaction completion", async () => {
  const { store, indexedDB } = loadBookStore();
  await store.addBook({ id: "b1", title: "A", fileBlob: blob });
  await store.addBookmark({ id: "m1", bookId: "b1", label: "one" });
  await store.addBookmark({ id: "m2", bookId: "b1", label: "two" });
  await store.addBookmark({ id: "m3", bookId: "other", label: "three" });
  const claimed = await store.claimActiveReaderSession("b1", "s1");
  assert.equal(claimed.activeReaderSessionId, "s1");
  assert.equal(await store.claimActiveReaderSession("nope", "s1"), null);
  assert.deepEqual(Array.from(await store.getBookmarks("b1"), (m) => m.id), ["m1", "m2"]);
  await store.deleteBook("b1");
  assert.equal(indexedDB.records("books").length, 0);
  assert.deepEqual(Array.from(indexedDB.records("bookmarks"), (m) => m.id), ["m3"]);
});

test("resetAllReadingProgress clears progress fields in one transaction", async () => {
  const { store } = loadBookStore();
  await store.addBook({ id: "b1", title: "A", fileBlob: blob, progress: 0.9, currentLocation: "epubcfi(/6/4)" });
  await store.updateBookProgress("b1", { progress: 0.9, currentSpineIndex: 3, chapterScrollRatio: 0.5, persistReason: "scroll-debounce" });
  const res = await store.resetAllReadingProgress();
  assert.equal(res.count, 1);
  const b = await store.getBook("b1");
  assert.equal(b.progress, 0);
  assert.equal(b.currentSpineIndex, 0);
  assert.equal(b.currentLocation, "");
  assert.equal(b.title, "A");
});

test("progress logging is silent unless the page runs with ?debug=1", async () => {
  const quiet = loadBookStore("");
  await quiet.store.addBook({ id: "b1", title: "A", fileBlob: blob });
  await quiet.store.updateBookProgress("b1", { progress: 0.5, persistReason: "scroll-debounce" });
  assert.equal(quiet.logs.filter((l) => l[0] === "log").length, 0);
  const loud = loadBookStore("?id=b1&debug=1");
  await loud.store.addBook({ id: "b1", title: "A", fileBlob: blob });
  await loud.store.updateBookProgress("b1", { progress: 0.5, persistReason: "scroll-debounce" });
  assert.equal(loud.logs.filter((l) => l[0] === "log").length, 1);
});
