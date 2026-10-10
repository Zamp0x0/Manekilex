/**
 * R-09 / R-24 (reader.js): a bookmark jump updates the current spine index and persists it,
 * and the newer position (chrome.storage position cache) is not overwritten by the older
 * IndexedDB record when the book is opened.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { waitFor } = require("./helpers/extension-sandbox");
const { loadReaderPage } = require("./helpers/reader-page");

test("opening a book restores the newest position: position cache beats an older store record", async () => {
  const page = await loadReaderPage({
    sections: 6,
    book: { id: "b1", lastReadAt: 1000, progress: 0.1 },
    storage: {
      zehReaderPositionCache: {
        b1: { currentSpineIndex: 4, chapterScrollRatio: 0.25, progress: 0.7, savedAt: 2000, totalSpineItems: 6 },
      },
    },
  });
  await page.store.updateBookProgress("b1", {
    progress: 0.1,
    currentSpineIndex: 1,
    chapterScrollRatio: 0.5,
    lastReadAt: 1000,
    persistReason: "scroll-debounce",
  });
  await waitFor(() => page.epub.displays.length > 0, 5000, "rendition.display called");
  assert.equal(page.epub.displays[0], "chapters/chapter-5.xhtml", "restored at the cached (newer) spine index 4, not the store's 1");
});

test("opening a book with no cache restores the store's spine index", async () => {
  const page = await loadReaderPage({ sections: 6, book: { id: "b1" } });
  await page.store.updateBookProgress("b1", {
    progress: 0.3,
    currentSpineIndex: 2,
    chapterScrollRatio: 0.0,
    persistReason: "scroll-debounce",
  });
  await waitFor(() => page.epub.displays.length > 0, 5000, "rendition.display called");
  assert.equal(page.epub.displays[0], "chapters/chapter-3.xhtml");
});

test("bookmark jump displays the CFI, updates the spine index and persists it", async () => {
  const page = await loadReaderPage({
    sections: 6,
    book: { id: "b1" },
    bookmarks: [{ id: "m1", label: "later", location: "epubcfi(/6/10!/4/2/1:0)" }],
  });
  await waitFor(() => page.epub.displays.length > 0, 5000, "book opened");
  const before = page.epub.displays.length;
  await new Promise((r) => setTimeout(r, 1200)); // let the open-book restore settle
  page.clickBookmark("epubcfi(/6/10!/4/2/1:0)");
  await waitFor(() => page.epub.displays.length > before, 5000, "bookmark displayed");
  assert.equal(page.epub.displays[page.epub.displays.length - 1], "epubcfi(/6/10!/4/2/1:0)");
  await waitFor(() => page.indexedDB.records("books")[0].currentSpineIndex === 4, 5000, "spine index 4 persisted");
  const rec = await page.record();
  assert.equal(rec.currentLocation, "epubcfi(/6/10!/4/2/1:0)");
  assert.equal(rec.currentSpineIndex, 4, "/6/10 is the fifth spine item");
  assert.ok(rec.progress > 0.6 && rec.progress <= 1, `progress reflects chapter 5 of 6 (${rec.progress})`);
});
