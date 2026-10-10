/**
 * F9: two reader tabs on the same book. The tab that opened (or was focused) last owns the
 * reading position; an older tab must not overwrite it, neither with a forced "back to shelf"
 * save nor through the chrome.storage position cache that the next open applies.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { baseGlobals, runFile, waitFor } = require("./helpers/extension-sandbox");
const { createFakeIndexedDB } = require("./helpers/fake-indexeddb");
const { loadReaderPage } = require("./helpers/reader-page");

const blob = { size: 3 };
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForAsync(predicate, timeoutMs, label) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await settle(10);
  }
}

function loadBookStore() {
  const { indexedDB, IDBKeyRange } = createFakeIndexedDB();
  const context = vm.createContext({
    ...baseGlobals(),
    indexedDB,
    IDBKeyRange,
    DOMException: globalThis.DOMException,
    location: { search: "" },
    console: { log() {}, warn() {}, error() {}, debug() {} },
  });
  context.window = context;
  runFile(context, "book-store.js");
  return context.ZEHBookStore;
}

test("F9: a forced save from a stale reader session is rejected; the active session can still force", async () => {
  const store = loadBookStore();
  await store.addBook({ id: "b1", title: "A", fileBlob: blob });
  await store.claimActiveReaderSession("b1", "session-old");
  await store.claimActiveReaderSession("b1", "session-new");
  await store.updateBookProgress("b1", {
    progress: 0.8,
    currentSpineIndex: 4,
    persistReason: "scroll-debounce",
    updatedBySessionId: "session-new",
  });

  const stale = await store.updateBookProgress(
    "b1",
    { progress: 0.1, currentSpineIndex: 0, persistReason: "back-to-shelf", updatedBySessionId: "session-old", forceWrite: true },
    { readerSessionId: "session-old", force: true, persistReason: "back-to-shelf" }
  );
  assert.equal(stale.skipped, true, "force does not bypass the session check");
  assert.equal(stale.reason, "stale-session");
  const kept = await store.getBook("b1");
  assert.equal(kept.currentSpineIndex, 4);
  assert.equal(kept.progress, 0.8);

  const own = await store.updateBookProgress(
    "b1",
    { progress: 0.9, currentSpineIndex: 5, persistReason: "back-to-shelf", updatedBySessionId: "session-new", forceWrite: true },
    { readerSessionId: "session-new", force: true, persistReason: "back-to-shelf" }
  );
  assert.equal(own.skipped, false);
  assert.equal((await store.getBook("b1")).currentSpineIndex, 5);
});

/** Tab A opens the book, then tab B opens it and jumps to chapter 5 (spine 4). */
async function twoTabs() {
  const tabA = await loadReaderPage({
    sections: 6,
    book: { id: "b1" },
    sessionId: "session-A",
    bookmarks: [{ id: "m1", label: "later", location: "epubcfi(/6/10!/4/2/1:0)" }],
  });
  await waitFor(() => tabA.epub.displays.length > 0, 5000, "tab A opened the book");
  await settle(1200); // let tab A's open-book restore settle
  const tabB = await loadReaderPage({ sections: 6, book: { id: "b1" }, sessionId: "session-B", shared: tabA.shared });
  await waitFor(() => tabB.epub.displays.length > 0, 5000, "tab B opened the book");
  await waitForAsync(async () => (await tabB.record()).activeReaderSessionId === "session-B", 5000, "tab B claimed the book");
  await settle(1200);
  tabB.clickBookmark("epubcfi(/6/10!/4/2/1:0)");
  await waitForAsync(async () => (await tabB.record()).currentSpineIndex === 4, 5000, "tab B saved spine 4");
  return { tabA, tabB };
}

test("F9: 'back to shelf' in an older reader tab does not overwrite the newer tab's position", async () => {
  const { tabA, tabB } = await twoTabs();
  const before = await tabB.record();
  await tabA.clickBack();
  const after = await tabB.record();
  assert.equal(after.currentSpineIndex, 4, "still the newer tab's chapter");
  assert.equal(after.progress, before.progress);
  assert.equal(after.progressUpdatedBySessionId, "session-B");
});

test("F9: a position cache written by an older reader tab is not applied when the book is reopened", async () => {
  const { tabA, tabB } = await twoTabs();
  const { local } = tabA.shared;
  tabA.fire("pagehide");
  await settle(300);
  const cached = (await local.get("zehReaderPositionCache")).zehReaderPositionCache;
  const entry = cached && cached.b1;
  // Either the stale tab never wrote the cache, or the entry it wrote is ignored on reopen.
  if (entry && entry.sessionId === "session-A") {
    assert.ok(entry.savedAt > ((await tabB.record()).lastReadAt || 0), "the stale entry is newer than the store record");
  }

  const tabC = await loadReaderPage({ sections: 6, book: { id: "b1" }, sessionId: "session-C", shared: tabA.shared });
  await waitFor(() => tabC.epub.displays.length > 0, 5000, "tab C opened the book");
  assert.equal(tabC.epub.displays[0], "chapters/chapter-5.xhtml", "reopened at the newer tab's chapter, not the stale tab's");
});

test("F9: the active tab's own position cache still wins over an older store record", async () => {
  const { tabA, tabB } = await twoTabs();
  const { local } = tabA.shared;
  const rec = await tabB.record();
  await local.set({
    zehReaderPositionCache: {
      b1: { currentSpineIndex: 5, chapterScrollRatio: 0.1, progress: 0.85, savedAt: (rec.lastReadAt || 0) + 5000, totalSpineItems: 6, sessionId: "session-B" },
    },
  });
  const tabC = await loadReaderPage({ sections: 6, book: { id: "b1" }, sessionId: "session-C", shared: tabA.shared });
  await waitFor(() => tabC.epub.displays.length > 0, 5000, "tab C opened the book");
  assert.equal(tabC.epub.displays[0], "chapters/chapter-6.xhtml", "the owning session's newer cache is applied");
});
