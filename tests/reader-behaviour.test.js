/**
 * Characterization of the EPUB reader (reader.js) as it behaves today, before it is split into
 * modules: open / close lifecycle and its error messages, the position formula and the restore of
 * a saved chapter ratio, what the page writes when it is left, multi-tab ownership, scroll
 * debouncing, chapter switching at the edges, display settings, the table of contents, the
 * lookup controller's book context and a book deleted while it is open.
 *
 * The fake epub.js of helpers/reader-page.js renders nothing: the scroll container is the viewer
 * (scrollHeight 2000, clientHeight 800, so the largest scrollTop is 1200). The same flows run
 * against the real epub.js in tests/browser/reader.browser.js.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { waitFor } = require("./helpers/extension-sandbox");
const { loadReaderPage } = require("./helpers/reader-page");

const settle = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_SCROLL = 2000 - 800;

async function waitForAsync(predicate, timeoutMs, label) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await settle(10);
  }
}

/** Open a reader page and wait until its open-book restore has settled */
async function openReader(opts) {
  const page = await loadReaderPage(opts);
  await waitFor(() => page.epub.displays.length > 0, 5000, "the book was displayed");
  await settle(1300);
  return page;
}

async function cacheEntry(page, id = "b1") {
  const data = await page.local.get("zehReaderPositionCache");
  return (data.zehReaderPositionCache || {})[id];
}

/** A user scroll: the wheel marks the scroll as the user's, then the container moves */
function userScroll(page, top) {
  page.wheel(top >= page.viewer.scrollTop ? 40 : -40);
  page.scrollTo(top);
}

// ── open / close lifecycle ──────────────────────────────────────────────────────

test("reader lifecycle: without ?id the page says so and opens nothing", async () => {
  const page = await loadReaderPage({ search: "?" });
  await settle(200);
  const msg = page.document.getElementById("readerMessage");
  assert.equal(msg.textContent, "缺少书籍参数，请从书架重新打开。");
  assert.equal(msg.hidden, false);
  assert.deepEqual(page.epub.displays, []);
});

test("reader lifecycle: an id that is not in the library shows the deleted-book message", async () => {
  const page = await loadReaderPage({ book: { id: "b1" }, search: "?id=gone" });
  await settle(200);
  assert.equal(page.document.getElementById("readerMessage").textContent, "找不到这本书，可能已被删除。");
  assert.deepEqual(page.epub.displays, []);
});

test("reader lifecycle: an unreadable file shows the open-failure message with the cause", async () => {
  const page = await loadReaderPage({
    book: { id: "b1", fileBlob: { size: 1, arrayBuffer: async () => { throw new Error("zip broken"); } } },
  });
  await settle(200);
  assert.equal(page.document.getElementById("readerMessage").textContent, "打开 EPUB 失败：zip broken");
  assert.deepEqual(page.epub.displays, []);
});

test("reader lifecycle: the title comes from the record; a new book opens at its first chapter and claims the session", async () => {
  const page = await openReader({ book: { id: "b1", title: "Moby" }, sessionId: "s-open" });
  assert.equal(page.document.getElementById("readerTitle").textContent, "Moby");
  assert.equal(page.document.title, "Moby · Manekilex Reader");
  assert.equal(page.epub.displays[0], "(start)", "no saved position: the start of the book");
  assert.equal((await page.record()).activeReaderSessionId, "s-open");
  assert.equal(page.epub.book.rendition.settings.flow, "scrolled-doc");
  assert.equal(page.epub.book.rendition.settings.allowScriptedContent, false);
});

// ── position: restore and formula ───────────────────────────────────────────────

test("reader position: a saved chapter + ratio is restored as that chapter at ratio × max scroll", async () => {
  const page = await openReader({
    sections: 6,
    book: { id: "b1" },
    storage: { zehReaderPositionCache: { b1: { currentSpineIndex: 2, chapterScrollRatio: 0.5, progress: 2.5 / 6, totalSpineItems: 6, savedAt: 1000 } } },
  });
  assert.equal(page.epub.displays[0], "chapters/chapter-3.xhtml");
  assert.equal(page.viewer.scrollTop, 0.5 * MAX_SCROLL);
});

test("reader position: a saved progress is (spine index + chapter ratio) / spine count", async () => {
  const page = await openReader({ sections: 6, book: { id: "b1" } });
  page.clickBookmark("epubcfi(/6/10!/4/2/1:0)");
  await waitForAsync(async () => (await page.record()).currentSpineIndex === 4, 5000, "bookmark jump saved");
  await settle(1500); // let the jump's own locks expire
  userScroll(page, 300);
  await waitForAsync(async () => Math.abs((await page.record()).chapterScrollRatio - 0.25) < 1e-9, 5000, "scroll saved");
  const rec = await page.record();
  assert.equal(rec.currentSpineIndex, 4);
  assert.equal(rec.totalSpineItems, 6);
  assert.equal(rec.progress, (4 + 300 / MAX_SCROLL) / 6);
  assert.match(rec.currentLocation, /^epubcfi\(\/6\/10!/);
  assert.equal(rec.progressUpdatedBySessionId, "reader-session-test");
});

test("reader position: user scrolls are debounced into one save at the final position", async () => {
  const page = await openReader({ sections: 4, book: { id: "b1" } });
  const writes = [];
  const update = page.store.updateBookProgress;
  page.store.updateBookProgress = (id, patch, meta) => {
    writes.push(patch);
    return update(id, patch, meta);
  };
  for (const top of [100, 200, 300, 400, 600]) {
    userScroll(page, top);
    await settle(40);
  }
  await settle(800);
  assert.equal(writes.length, 1, "one save for the whole burst");
  assert.equal(writes[0].chapterScrollRatio, 600 / MAX_SCROLL);
  assert.equal((await page.record()).chapterScrollRatio, 0.5);
});

test("reader position: a scroll the user did not make (no wheel, pointer or touch first) is not saved", async () => {
  const page = await openReader({ sections: 4, book: { id: "b1" } });
  const before = await page.record();
  page.scrollTo(900);
  await settle(800);
  const after = await page.record();
  assert.equal(after.chapterScrollRatio, before.chapterScrollRatio);
  assert.equal(after.lastReadAt, before.lastReadAt);
});

// ── leaving the page ────────────────────────────────────────────────────────────

test("reader leave: pagehide writes the position cache entry (shape and session) and saves an unsaved scroll", async () => {
  const page = await openReader({ sections: 5, book: { id: "b1" }, sessionId: "s-leave" });
  userScroll(page, 600);
  page.fire("pagehide"); // before the 300 ms debounce fires
  await waitForAsync(async () => (await page.record()).chapterScrollRatio === 0.5, 3000, "leave flush saved");
  const entry = await cacheEntry(page);
  assert.deepEqual(Object.keys(entry).sort(), [
    "bookId", "chapterScrollRatio", "currentLocation", "currentSpineIndex", "lastReadAt",
    "progress", "reason", "savedAt", "sessionId", "totalSpineItems",
  ]);
  assert.equal(entry.bookId, "b1");
  assert.equal(entry.sessionId, "s-leave");
  assert.equal(entry.reason, "pagehide");
  assert.equal(entry.currentSpineIndex, 0);
  assert.equal(entry.chapterScrollRatio, 0.5);
  assert.equal(entry.progress, 0.5 / 5);
  assert.equal(entry.totalSpineItems, 5);
});

test("reader leave: a hidden tab flushes like pagehide; the next open restores that position", async () => {
  const page = await openReader({ sections: 5, book: { id: "b1" } });
  userScroll(page, 300);
  page.setHidden(true);
  await waitForAsync(async () => (await page.record()).chapterScrollRatio === 0.25, 3000, "hidden flush saved");
  const again = await openReader({ sections: 5, book: { id: "b1" }, shared: page.shared, sessionId: "s-next" });
  assert.equal(again.epub.displays[0], "chapters/chapter-1.xhtml");
  assert.equal(again.viewer.scrollTop, 0.25 * MAX_SCROLL);
});

// ── several tabs on one book ────────────────────────────────────────────────────

async function twoTabs() {
  const tabA = await openReader({ sections: 5, book: { id: "b1" }, sessionId: "session-A" });
  const tabB = await openReader({ sections: 5, book: { id: "b1" }, sessionId: "session-B", shared: tabA.shared });
  assert.equal((await tabB.record()).activeReaderSessionId, "session-B");
  return { tabA, tabB };
}

test("reader multi-tab: a scroll save from the superseded tab is refused by the store (F9)", async () => {
  const { tabA, tabB } = await twoTabs();
  userScroll(tabB, 300);
  await waitForAsync(async () => (await tabB.record()).chapterScrollRatio === 0.25, 3000, "tab B saved");
  userScroll(tabA, 900);
  await settle(800);
  const rec = await tabB.record();
  assert.equal(rec.chapterScrollRatio, 0.25, "tab A's position was not written");
  assert.equal(rec.progressUpdatedBySessionId, "session-B");
});

test("reader multi-tab: an older tab that becomes visible again takes the book back and can save", async () => {
  const { tabA, tabB } = await twoTabs();
  tabA.setHidden(false);
  await waitForAsync(async () => (await tabB.record()).activeReaderSessionId === "session-A", 3000, "tab A reclaimed");
  await settle(400);
  userScroll(tabA, 900);
  await waitForAsync(async () => (await tabA.record()).chapterScrollRatio === 0.75, 3000, "tab A saved");
  assert.equal((await tabA.record()).progressUpdatedBySessionId, "session-A");
});

// ── chapter navigation ──────────────────────────────────────────────────────────

test("reader navigation: wheeling past the bottom edge opens the next chapter, past the top edge the previous one", async () => {
  const page = await openReader({ sections: 4, book: { id: "b1" } });
  page.viewer.scrollTop = MAX_SCROLL;
  page.wheel(100); // one notch past the bottom (BOUNDARY_WHEEL_DELTA is 72)
  await waitFor(() => page.epub.displays.includes("chapters/chapter-2.xhtml"), 3000, "next chapter");
  await settle(1000);
  assert.equal(page.viewer.scrollTop, 0, "the next chapter starts at its top");

  page.wheel(-100);
  await waitFor(() => page.epub.displays.filter((d) => d === "chapters/chapter-1.xhtml").length > 0, 3000, "previous chapter");
  await settle(1200);
  assert.equal(page.viewer.scrollTop, MAX_SCROLL, "the previous chapter opens at its end");
});

test("reader navigation: a small wheel at the edge (below the threshold) stays in the chapter", async () => {
  const page = await openReader({ sections: 4, book: { id: "b1" } });
  page.viewer.scrollTop = MAX_SCROLL;
  page.wheel(30);
  await settle(800);
  assert.deepEqual(page.epub.displays, ["(start)"]);
});

test("reader TOC: one entry per navigation item; a click displays it and saves its chapter", async () => {
  const page = await openReader({ sections: 5, book: { id: "b1" } });
  const list = page.document.getElementById("readerTocList");
  const items = list.children.filter((c) => c.dataset.tocIndex !== undefined);
  assert.deepEqual(items.map((b) => b.textContent), ["Ch 1", "Ch 2", "Ch 3", "Ch 4", "Ch 5"]);
  assert.deepEqual(items.map((b) => b.dataset.spineIndex), ["0", "1", "2", "3", "4"]);
  await Promise.all(items[3]._listeners.click.map((fn) => fn({ type: "click" })));
  await waitForAsync(async () => (await page.record()).currentSpineIndex === 3, 3000, "TOC jump saved");
  assert.ok(page.epub.displays.includes("chapters/chapter-4.xhtml"));
});

// ── display settings ────────────────────────────────────────────────────────────

test("reader settings: font size and width mode are saved and the next open starts with them", async () => {
  const page = await openReader({ sections: 3, book: { id: "b1" } });
  assert.equal(page.document.getElementById("fontSizeLabel").textContent, "20px");
  await page.click("fontIncBtn");
  await page.click("widthNarrowBtn");
  await settle(100);
  let prefs = (await page.local.get("zehReaderPrefs")).zehReaderPrefs;
  assert.equal(prefs.fontSize, 22);
  assert.equal(prefs.widthMode, "narrow");
  assert.equal(prefs.contentWidth, 900);
  assert.equal(prefs.tocOpen, true);

  for (let i = 0; i < 10; i++) await page.click("fontIncBtn");
  prefs = (await page.local.get("zehReaderPrefs")).zehReaderPrefs;
  assert.equal(prefs.fontSize, 30, "clamped to FONT_MAX");

  const again = await openReader({ sections: 3, book: { id: "b1" }, shared: page.shared, sessionId: "s2" });
  assert.equal(again.document.getElementById("fontSizeLabel").textContent, "30px");
});

test("reader settings: stored prefs are merged over the defaults, then clamped and normalized", async () => {
  // contentWidth alone does not pick a mode: the default widthMode ("wide") is merged in first
  const page = await openReader({ sections: 3, book: { id: "b1" }, storage: { zehReaderPrefs: { fontSize: 99, contentWidth: 1000 } } });
  await page.click("fontDecBtn");
  const prefs = (await page.local.get("zehReaderPrefs")).zehReaderPrefs;
  assert.equal(prefs.widthMode, "wide");
  assert.equal(prefs.contentWidth, 1360);
  assert.equal(prefs.fontSize, 28, "99 is clamped to 30 on load, then one step down");
});

// ── lookup integration ──────────────────────────────────────────────────────────

test("reader lookup: the lookup controller is created for the page and its vocabulary context names the book", async () => {
  const page = await openReader({ sections: 3, book: { id: "b1", title: "Moby", author: "Melville" } });
  const opts = page.lookupOptions();
  assert.ok(opts, "MKLookup.createController was called");
  assert.equal(opts.doc, page.document);
  assert.deepEqual(JSON.parse(JSON.stringify(opts.vocabContext())), {
    pageUrl: "chrome-extension://test-extension/reader.html?id=b1",
    pageTitle: "Moby",
    book: { id: "b1", title: "Moby", author: "Melville" },
  });
});

// ── deletion while open ─────────────────────────────────────────────────────────

test("reader deletion: a book deleted while open is not recreated by later saves; reopening says it is gone", async () => {
  const page = await openReader({ sections: 3, book: { id: "b1" } });
  await page.store.deleteBook("b1");
  userScroll(page, 600);
  await settle(700);
  page.fire("pagehide");
  await settle(200);
  assert.equal(await page.record(), undefined, "no record was written back");
  const entry = await cacheEntry(page);
  assert.equal(entry && entry.bookId, "b1", "the leave cache entry is still written (it is keyed by id only)");

  const again = await loadReaderPage({ book: { id: "b1" }, shared: page.shared, sessionId: "s2" });
  await settle(200);
  assert.equal(again.document.getElementById("readerMessage").textContent, "找不到这本书，可能已被删除。");
  assert.deepEqual(again.epub.displays, []);
});
