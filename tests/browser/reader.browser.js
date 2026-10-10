/**
 * The EPUB reader with the real epub.js in a real browser (npm run test:browser): the behaviour
 * that reader.js has today and that its split into modules must keep.
 *
 *   - a wheel scroll inside a chapter is saved and a reload reopens at the same place;
 *   - keyboard scrolling (PageDown) moves inside the chapter, never to another chapter, and the
 *     position is saved when the page is left;
 *   - the wheel past a chapter's end opens the next chapter, past its top the previous one (at
 *     its end); the new chapter is saved when the page is left;
 *   - the table of contents jumps and saves; its collapsed state survives a reload;
 *   - font size, width mode and paper colour are saved and applied after a reload;
 *   - a smaller window keeps the chapter and the reading ratio;
 *   - two tabs on one book: the newer tab owns the position, "back to shelf" in the older tab
 *     does not overwrite it;
 *   - right-click on a selection: the bookmark menu adds a bookmark there (with its excerpt), and
 *     the bookmark list jumps back to it;
 *   - "＋ 书签" offers the chapter title as the name; the list renames and deletes the mark, and a
 *     click outside closes it;
 *   - a book deleted while it is open: no crash, nothing written back, a reload says it is gone.
 *
 * Books are built in the extension with its own EPUB builder; no network is used.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { SKIP_REASON, sleep, until, launch } = require("./harness");

let env = null;

test.before(async () => {
  if (SKIP_REASON) return;
  env = await launch();
  console.log(`# browser: ${env.version} (major ${env.major})`);
});

test.after(async () => {
  if (env) await env.close();
});

const opts = { skip: SKIP_REASON || false, timeout: 90000 };

const TITLES = ["Orchard", "Lighthouse", "Valley", "Harbor"];

/** Four chapters of 60 paragraphs each: every chapter scrolls several screens */
async function addLongBook() {
  const page = await env.ctx.newPage();
  await page.goto(`${env.base}/settings.html#reading`);
  await page.waitForFunction(() => window.ZEHEpubBuilder && window.ZEHBookStore && window.ZEHHtmlSanitize);
  const id = await page.evaluate(async (titles) => {
    const para = (w, i) => `<p>${w} paragraph ${i}. The river ran past the old mill while the ${w} keeper waited by the bank.</p>`;
    const chapters = titles.map((t, c) => ({
      id: `chapter-${c + 1}`,
      title: t,
      html: ZEHHtmlSanitize.wrapChapterXhtml(t, Array.from({ length: 60 }, (_, i) => para(t.toLowerCase(), i)).join("")),
    }));
    const blob = await ZEHEpubBuilder.buildEpubBlob({ title: "Long Book", author: "Test Author", chapters });
    return (await ZEHBookStore.addBook({ title: "Long Book", author: "Test Author", fileBlob: blob, format: "epub" })).id;
  }, TITLES);
  await page.close();
  return id;
}

async function openReader(id, page) {
  const p = page || (await env.ctx.newPage());
  if (!p.errors) {
    p.errors = [];
    p.on("pageerror", (e) => p.errors.push(String(e.message || e)));
  }
  await p.goto(`${env.base}/reader.html?id=${encodeURIComponent(id)}`);
  return p;
}

/** The chapter the book iframe shows (by its first paragraph) and the scroll position */
function view(page) {
  return page.evaluate(() => {
    const c = document.querySelector("#viewer .epub-container");
    const frame = document.querySelector("#viewer iframe");
    const text = (frame && frame.contentDocument && frame.contentDocument.body && frame.contentDocument.body.innerText) || "";
    const max = c ? Math.max(0, c.scrollHeight - c.clientHeight) : 0;
    return {
      chapter: (text.match(/^(\w+) paragraph 0\./m) || [])[1] || null,
      scrollTop: c ? c.scrollTop : 0,
      max,
      ratio: c && max > 0 ? c.scrollTop / max : 0,
    };
  });
}

/** Wait until the reader shows `chapter` (lower case) and its restore has settled */
async function readyAt(page, chapter) {
  await until(async () => (await view(page)).chapter === chapter, 15000, `chapter ${chapter} shown`);
  await page.waitForFunction(() => !document.body.classList.contains("reader-restoring") && !document.body.classList.contains("reader-section-switching"), null, { timeout: 10000 });
  await sleep(1500); // the open restore keeps short locks after the visual is ready
}

function stored(page, id) {
  return page.evaluate(async (bookId) => {
    const b = await ZEHBookStore.getBook(bookId);
    return b ? { spine: b.currentSpineIndex, ratio: b.chapterScrollRatio, progress: b.progress, owner: b.activeReaderSessionId, by: b.progressUpdatedBySessionId, location: b.currentLocation } : null;
  }, id);
}

async function wheelOverBook(page, deltaY, times = 1) {
  const box = await (await page.$("#viewer")).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(300, box.height / 2));
  for (let i = 0; i < times; i++) {
    await page.mouse.wheel(0, deltaY);
    await sleep(120);
  }
}

const near = (a, b, tol, label) => assert.ok(Math.abs(a - b) <= tol, `${label}: ${a} vs ${b} (±${tol})`);

// ── tests ────────────────────────────────────────────────────────────────────

test("reader: a wheel scroll inside a chapter is saved and a reload reopens at the same place", opts, async () => {
  const id = await addLongBook();
  const page = await openReader(id);
  await readyAt(page, "orchard");
  await wheelOverBook(page, 450, 2);
  const before = await view(page);
  assert.ok(before.ratio > 0.1 && before.ratio < 0.9, `scrolled inside the chapter (${before.ratio})`);
  const rec = await until(async () => {
    const r = await stored(page, id);
    return r && r.spine === 0 && Math.abs(r.ratio - before.ratio) < 0.01 ? r : null;
  }, 5000, "scroll saved");
  near(rec.progress, (0 + rec.ratio) / TITLES.length, 1e-9, "progress = (spine + ratio) / spines");

  await page.reload();
  await readyAt(page, "orchard");
  near((await view(page)).ratio, before.ratio, 0.02, "restored ratio");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("reader: PageDown scrolls inside the chapter only; leaving the page saves that position", opts, async () => {
  const id = await addLongBook();
  const page = await openReader(id);
  await readyAt(page, "orchard");
  const box = await (await page.$("#viewer")).boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + 300);
  await sleep(1700); // past the 1.5 s window in which a click counts as the user scrolling
  await page.keyboard.press("PageDown");
  await sleep(400);
  const moved = await view(page);
  assert.ok(moved.scrollTop > 0, "PageDown scrolled the book");
  for (let i = 0; i < 8; i++) {
    await page.keyboard.press("PageDown");
    await sleep(150);
  }
  await sleep(800);
  const end = await view(page);
  assert.equal(end.chapter, "orchard", "the keyboard never switches chapters");
  near(end.ratio, 1, 0.01, "at the end of the chapter");

  await page.reload(); // pagehide flushes the position
  await readyAt(page, "orchard");
  near((await view(page)).ratio, end.ratio, 0.02, "restored after the reload");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("reader: the wheel past a chapter's end opens the next chapter, past its top the previous one at its end", opts, async () => {
  const id = await addLongBook();
  const page = await openReader(id);
  await readyAt(page, "orchard");
  await page.evaluate(() => {
    const c = document.querySelector("#viewer .epub-container");
    c.scrollTop = c.scrollHeight;
  });
  await sleep(300);
  await wheelOverBook(page, 120); // one notch past the end (the threshold is 72)
  await readyAt(page, "lighthouse");
  const next = await view(page);
  assert.ok(next.scrollTop < 30, `the next chapter starts at its top (${next.scrollTop})`);
  // a chapter switch is not a save reason of its own: leaving the page writes it
  await page.reload();
  await readyAt(page, "lighthouse");
  assert.equal((await stored(page, id)).spine, 1);

  await page.evaluate(() => {
    document.querySelector("#viewer .epub-container").scrollTop = 0;
  });
  await sleep(300);
  await wheelOverBook(page, -120);
  await readyAt(page, "orchard");
  near((await view(page)).ratio, 1, 0.02, "the previous chapter opens at its end");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("reader: the table of contents jumps and saves; its collapsed state survives a reload", opts, async () => {
  const id = await addLongBook();
  const page = await openReader(id);
  await readyAt(page, "orchard");
  const items = await page.$$eval(".reader-toc-item", (els) => els.map((e) => e.textContent.trim()));
  assert.deepEqual(items, TITLES);
  await page.click('.reader-toc-item:has-text("Valley")');
  await readyAt(page, "valley");
  const rec = await until(async () => {
    const r = await stored(page, id);
    return r && r.spine === 2 ? r : null;
  }, 5000, "TOC jump saved");
  assert.match(rec.location, /^epubcfi\(/);
  assert.equal(await page.$eval(".reader-toc-item.is-active", (e) => e.textContent.trim()).catch(() => null), "Valley");

  await page.click("#readerTocCollapseBtn");
  await until(() => page.evaluate(() => document.getElementById("readerLayout").classList.contains("toc-collapsed")), 3000, "TOC collapsed");
  await page.reload();
  await readyAt(page, "valley");
  assert.equal(await page.evaluate(() => document.getElementById("readerLayout").classList.contains("toc-collapsed")), true);
  assert.equal(await page.evaluate(() => document.getElementById("readerTocExpandTab").hidden), false);
  await page.click("#readerTocExpandTab");
  await until(() => page.evaluate(() => !document.getElementById("readerLayout").classList.contains("toc-collapsed")), 3000, "TOC open again");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("reader: font size, width mode and paper colour are saved and applied again after a reload", opts, async () => {
  const id = await addLongBook();
  const page = await openReader(id);
  await readyAt(page, "orchard");
  const fontSize = () => page.frames().find((f) => f !== page.mainFrame()).evaluate(() => getComputedStyle(document.querySelector("p")).fontSize);
  const width = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--reader-content-width").trim());
  assert.equal(await page.textContent("#fontSizeLabel"), "20px");
  await page.click("#fontIncBtn");
  await page.click("#widthNarrowBtn");
  await page.click("#toggleThemeBtn");
  await page.click('.theme-choice[data-theme-type="paperBg"][data-color="#f3fbf3"]');
  await until(async () => (await fontSize()) === "22px", 5000, "font applied in the book");
  await until(async () => (await width()) === "900px", 5000, "narrow width applied");
  // the width mode is saved once its new layout has been applied
  const prefs = await until(async () => {
    const p = await page.evaluate(() => chrome.storage.local.get(["zehReaderPrefs", "zehReaderTheme"]));
    return p.zehReaderPrefs && p.zehReaderPrefs.widthMode === "narrow" ? p : null;
  }, 5000, "width mode saved");
  assert.equal(prefs.zehReaderPrefs.fontSize, 22);
  assert.equal(prefs.zehReaderPrefs.contentWidth, 900);
  assert.equal(prefs.zehReaderTheme.paperBg, "#f3fbf3");

  await page.reload();
  await readyAt(page, "orchard");
  assert.equal(await page.textContent("#fontSizeLabel"), "22px");
  assert.equal(await fontSize(), "22px");
  assert.equal(await width(), "900px");
  assert.equal(await page.$eval(".epub-container", (e) => getComputedStyle(e).backgroundColor), "rgb(243, 251, 243)");
  // the chapter's own page takes the paper colour too (epub.js theme and the reader's typography theme)
  const bookBg = () => page.frames().find((f) => f !== page.mainFrame()).evaluate(() => getComputedStyle(document.body).backgroundColor);
  await until(async () => (await bookBg()) === "rgb(243, 251, 243)", 5000, "paper colour inside the chapter");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("reader: a smaller window keeps the chapter and the reading ratio", opts, async () => {
  const id = await addLongBook();
  const page = await openReader(id);
  await readyAt(page, "orchard");
  await wheelOverBook(page, 500, 2);
  const before = await view(page);
  await until(async () => Math.abs(((await stored(page, id)) || {}).ratio - before.ratio) < 0.01, 5000, "scroll saved");
  await page.setViewportSize({ width: 900, height: 650 });
  await sleep(2500); // resize debounce + reflow + ratio restore
  const after = await view(page);
  assert.equal(after.chapter, "orchard");
  assert.ok(after.max !== before.max, "the chapter was laid out again");
  near(after.ratio, before.ratio, 0.03, "ratio kept across the reflow");
  const rec = await stored(page, id);
  assert.equal(rec.spine, 0);
  near(rec.ratio, before.ratio, 0.03, "the stored ratio did not jump");
  await page.setViewportSize({ width: 1200, height: 900 });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("reader: with two tabs on one book the newer tab owns the position; 'back to shelf' in the older one does not overwrite it", opts, async () => {
  const id = await addLongBook();
  const older = await openReader(id);
  await readyAt(older, "orchard");
  const olderOwner = (await stored(older, id)).owner;
  const newer = await openReader(id);
  await readyAt(newer, "orchard");
  const owner = (await stored(newer, id)).owner;
  assert.ok(owner && owner !== olderOwner, "the newer tab claimed the book");

  await newer.click('.reader-toc-item:has-text("Harbor")');
  await readyAt(newer, "harbor");
  await until(async () => ((await stored(newer, id)) || {}).spine === 3, 5000, "newer tab saved chapter 4");

  const closed = older.waitForEvent("close", { timeout: 10000 });
  await older.click("#backBtn");
  await closed; // back to shelf closes the reader tab and opens the shelf
  await sleep(300);
  const rec = await stored(newer, id);
  assert.equal(rec.spine, 3, "still the newer tab's chapter");
  assert.equal(rec.by, owner);
  for (const p of env.ctx.pages()) if (p.url().includes("settings.html")) await p.close();
  assert.deepEqual(newer.errors, []);
  await newer.close();
});

test("reader: right-click on a selected word opens the bookmark menu; 添加书签 saves it with its excerpt, the list jumps back to it", opts, async () => {
  const id = await addLongBook();
  const page = await openReader(id);
  await readyAt(page, "orchard");
  const frame = page.frames().find((f) => f !== page.mainFrame());
  // select "mill" in the third paragraph, then the context menu event there (dispatched: on Linux
  // and macOS Chrome sends contextmenu on mousedown and the following mouseup closes the menu)
  page.once("dialog", (d) => d.accept("Mill mark"));
  await frame.evaluate(() => {
    const p = [...document.querySelectorAll("p")][2];
    const node = p.firstChild;
    const from = node.nodeValue.indexOf("mill");
    const r = document.createRange();
    r.setStart(node, from);
    r.setEnd(node, from + 4);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    const b = r.getBoundingClientRect();
    p.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: b.left + 4, clientY: b.top + 4 }));
  });
  await page.waitForSelector("#ctxMenu:not([hidden])", { timeout: 5000 });
  await page.click("#ctxAddBookmark");
  const marks = await until(
    () => page.evaluate(async (bookId) => {
      const list = await ZEHBookStore.getBookmarks(bookId);
      return list.length ? list : null;
    }, id),
    5000,
    "bookmark saved"
  );
  assert.equal(marks.length, 1);
  assert.equal(marks[0].label, "Mill mark");
  assert.equal(marks[0].excerpt, "mill");
  assert.match(marks[0].location, /^epubcfi\(/);
  assert.equal(await page.isHidden("#ctxMenu"), true, "the menu closes");

  // scroll away, then jump back through the list
  await wheelOverBook(page, 900, 3);
  const away = await view(page);
  await page.click("#toggleBookmarksBtn");
  await page.click(".bookmark-item-label");
  // back in the chapter with the marked word on screen (where exactly depends on the font size
  // and width earlier tests saved)
  const markOnScreen = () => page.evaluate(() => {
    const c = document.querySelector("#viewer .epub-container");
    const frame = document.querySelector("#viewer iframe");
    const p = frame && frame.contentDocument && [...frame.contentDocument.querySelectorAll("p")][2];
    if (!c || !p) return false;
    const r = frame.contentDocument.createRange();
    const from = p.firstChild.nodeValue.indexOf("mill");
    r.setStart(p.firstChild, from);
    r.setEnd(p.firstChild, from + 4);
    const top = frame.getBoundingClientRect().top + r.getBoundingClientRect().top;
    const box = c.getBoundingClientRect();
    return top >= box.top - 1 && top < box.bottom;
  });
  let last = null;
  await until(async () => {
    last = await view(page);
    return last.chapter === "orchard" && last.scrollTop < away.scrollTop && (await markOnScreen());
  }, 8000, "back at the bookmark").catch((err) => {
    err.message += ` (after the wheel ${JSON.stringify(away)}, last ${JSON.stringify(last)})`;
    throw err;
  });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("reader: a real right-click (Linux / macOS send contextmenu on mousedown) leaves the bookmark menu open after the button is released", opts, async () => {
  const id = await addLongBook();
  const page = await openReader(id);
  await readyAt(page, "orchard");
  // select "mill" in the first paragraph on screen and record the order of the real mouse events
  // with listeners from the reader page (scripts do not run inside the sandboxed book iframe)
  const at = await page.evaluate(() => {
    const frame = document.querySelector("#viewer iframe");
    const doc = frame.contentDocument;
    const box = document.querySelector("#viewer").getBoundingClientRect();
    const fr = frame.getBoundingClientRect();
    window.__mkMouse = [];
    for (const type of ["mousedown", "mouseup", "contextmenu"]) {
      doc.addEventListener(type, (e) => window.__mkMouse.push(`${type}:${e.button}`), true);
    }
    const p = [...doc.querySelectorAll("p")].find((el) => {
      const r = el.getBoundingClientRect();
      return fr.top + r.top > box.top + 20 && fr.top + r.bottom < box.bottom - 20;
    });
    const node = p.firstChild;
    const from = node.nodeValue.indexOf("mill");
    const r = doc.createRange();
    r.setStart(node, from);
    r.setEnd(node, from + 4);
    const sel = doc.defaultView.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
    const b = r.getBoundingClientRect();
    return { x: fr.left + b.left + b.width / 2, y: fr.top + b.top + b.height / 2 };
  });
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await sleep(400);
  const order = await page.evaluate(() => window.__mkMouse.join(" "));
  assert.equal(await page.isVisible("#ctxMenu"), true, `the menu stays open after the release (events: ${order})`);
  if (process.platform !== "win32") {
    assert.match(order, /mousedown:2 contextmenu:2 mouseup:2/, "this platform opens the menu on mousedown");
  }

  page.once("dialog", (d) => d.accept("Released mark"));
  await page.click("#ctxAddBookmark");
  const marks = await until(
    () => page.evaluate(async (bookId) => {
      const list = await ZEHBookStore.getBookmarks(bookId);
      return list.length ? list : null;
    }, id),
    5000,
    "bookmark saved"
  );
  assert.equal(marks[0].label, "Released mark");
  assert.equal(marks[0].excerpt, "mill");
  assert.equal(await page.isHidden("#ctxMenu"), true, "choosing the item closes the menu");

  // open it again; a left click in the book closes it
  await page.mouse.move(at.x, at.y);
  await page.mouse.down({ button: "right" });
  await page.mouse.up({ button: "right" });
  await page.waitForSelector("#ctxMenu:not([hidden])", { timeout: 5000 });
  await page.mouse.click(at.x + 40, at.y + 60);
  await page.waitForSelector("#ctxMenu", { state: "hidden", timeout: 5000 });
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("reader: '＋ 书签' names the mark after the chapter; the list renames and deletes it", opts, async () => {
  const id = await addLongBook();
  const page = await openReader(id);
  await readyAt(page, "orchard");
  const marks = () => page.evaluate((bookId) => ZEHBookStore.getBookmarks(bookId), id);

  // the name prompt offers the chapter title; accepting it as is keeps that name
  let offered = null;
  page.once("dialog", (d) => {
    offered = d.defaultValue();
    d.accept();
  });
  await page.click("#addBookmarkBtn");
  const added = await until(async () => ((await marks()).length ? await marks() : null), 5000, "bookmark saved");
  assert.equal(offered, "Orchard");
  assert.equal(added[0].label, "Orchard");
  assert.match(added[0].location, /^epubcfi\(/);

  await page.click("#toggleBookmarksBtn");
  await page.waitForSelector(".bookmark-item-label");
  assert.equal(await page.textContent(".bookmark-item-label"), "Orchard");
  page.once("dialog", (d) => d.accept("Renamed mark"));
  await page.click(".bm-rename");
  await until(async () => (await page.textContent(".bookmark-item-label")) === "Renamed mark", 5000, "list shows the new name");
  assert.equal((await marks())[0].label, "Renamed mark");

  await page.click(".bm-delete");
  await page.waitForSelector(".bookmark-empty");
  assert.deepEqual(await marks(), []);
  // a click outside closes the panel
  await page.mouse.click(5, 300);
  await until(() => page.isHidden("#bookmarkPanel"), 3000, "panel closed");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("reader: a book deleted while it is open is not written back; a reload says it is gone", opts, async () => {
  const id = await addLongBook();
  const page = await openReader(id);
  await readyAt(page, "orchard");
  const shelf = await env.ctx.newPage();
  await shelf.goto(`${env.base}/settings.html#reading`);
  await shelf.waitForFunction(() => window.ZEHBookStore);
  await shelf.evaluate((bookId) => ZEHBookStore.deleteBook(bookId), id);
  await shelf.close();

  await page.bringToFront();
  await wheelOverBook(page, 400, 2);
  await sleep(1000);
  assert.equal(await stored(page, id), null, "nothing recreated the record");
  await page.reload();
  await page.waitForFunction(() => !document.getElementById("readerMessage").hidden, null, { timeout: 10000 });
  assert.equal(await page.textContent("#readerMessage"), "找不到这本书，可能已被删除。");
  assert.equal(await stored(page, id), null);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("reader: without a book id the page explains how to open a book", opts, async () => {
  const page = await env.ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  await page.goto(`${env.base}/reader.html`);
  await page.waitForFunction(() => !document.getElementById("readerMessage").hidden, null, { timeout: 10000 });
  assert.equal(await page.textContent("#readerMessage"), "缺少书籍参数，请从书架重新打开。");
  assert.equal(await page.$("#viewer iframe"), null);
  assert.deepEqual(errors, []);
  await page.close();
});
