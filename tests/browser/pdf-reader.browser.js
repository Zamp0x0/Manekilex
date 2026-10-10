/**
 * Enhanced PDF reader in a real browser (npm run test:browser).
 *
 * Manual path (any Chromium with extensions): the twelve fixture cases that do not need Chrome's
 * PDF handling, the cat lookup acceptance flow (bubble → dictionary-first panel → context sentence
 * sent to the provider stub → vocabulary entry with the PDF source and page) and resource release.
 *
 * MIME path (Chrome 151+ only, chrome.mimeHandler): top-level navigation to an application/pdf
 * response opens the reader automatically, the same acceptance flow inside it, the old PDF cat
 * hidden, the fallback to Chrome's own viewer and the settings toggle. On an older browser these
 * tests are skipped with the reason, unless MK_REQUIRE_MIME=1 (CI), where they fail.
 *
 * Switching back (Chrome 151+): the old cat in Chrome's own viewer reopens the same PDF in the
 * reader (same-tab reload through the MIME handler), any number of times; with the handler turned
 * off, an expired link, or an unsupported browser it explains why and offers a working action.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SKIP_REASON, sleep, until, startServer, fixtureFile, installProviderStub, launch, RECORD_MESSAGES } = require("./harness");

const RAG = "Retrieval-augmented generation improves factual accuracy by incorporating external knowledge.";
const MIME_MIN_MAJOR = 151;
const REQUIRE_MIME = process.env.MK_REQUIRE_MIME === "1";

let env = null;
let server = null;
let tmp = null;

test.before(async () => {
  if (SKIP_REASON) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mk-pdf-fixtures-"));
  server = await startServer();
  env = await launch();
  console.log(`# browser: ${env.version} (major ${env.major})`);
});

test.after(async () => {
  if (env) await env.close();
  if (server) await server.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

const opts = { skip: SKIP_REASON || false, timeout: 90000 };

// ── helpers ──────────────────────────────────────────────────────────────────

async function readerTab() {
  const page = await env.ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  await page.addInitScript(RECORD_MESSAGES);
  await page.goto(`${env.base}/pdf-reader.html`);
  await page.waitForFunction(() => window.ZEHPdfReaderApp && document.body.dataset.view === "landing");
  page.errors = errors;
  return page;
}

async function openFixture(page, name, view = "ready") {
  await page.setInputFiles("#fileInput", fixtureFile(tmp, name));
  await page.waitForFunction((v) => document.body.dataset.view === v, view, { timeout: 30000 });
  if (view === "ready") await page.waitForFunction(() => document.querySelector(".textLayer") !== null, null, { timeout: 15000 });
}

/** Wait until the text layer that holds `word` is mapped to its layout model */
async function waitMapped(frame, word) {
  await frame.waitForFunction(
    (w) => [...document.querySelectorAll('.textLayer[data-mk-mapped="1"] span[role="presentation"]')].some((s) => s.textContent.includes(w)),
    word,
    { timeout: 15000 }
  );
}

/** Viewport rect of the n-th occurrence of `word` in the text layer (frame-relative) */
function wordRect(frame, word, nth = 0) {
  return frame.evaluate(
    ({ word, nth }) => {
      const spans = [...document.querySelectorAll('.textLayer span[role="presentation"]')].filter((s) => s.textContent.includes(word));
      const span = spans[nth];
      if (!span) return null;
      const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const at = node.nodeValue.indexOf(word);
        if (at < 0) continue;
        const r = document.createRange();
        r.setStart(node, at);
        r.setEnd(node, at + word.length);
        const b = r.getBoundingClientRect();
        return { x: b.left, y: b.top, w: b.width, h: b.height };
      }
      return null;
    },
    { word, nth }
  );
}

async function frameOffset(frame) {
  const el = await frame.frameElement().catch(() => null);
  if (!el) return { x: 0, y: 0 };
  const box = await el.boundingBox();
  return box ? { x: box.x, y: box.y } : { x: 0, y: 0 };
}

/** Drag-select from the start of `from` to the end of `to` with the real mouse */
async function dragSelect(page, frame, from, to = from, nth = 0) {
  await waitMapped(frame, from);
  const off = await frameOffset(frame);
  const a = await wordRect(frame, from, nth);
  const b = await wordRect(frame, to, to === from ? nth : 0);
  assert.ok(a && b, `"${from}" / "${to}" are in the text layer`);
  await page.mouse.click(off.x + 4, off.y + 300); // clear any selection / panel
  await sleep(150);
  await page.mouse.move(off.x + a.x + 1, off.y + a.y + a.h / 2);
  await page.mouse.down();
  await page.mouse.move(off.x + (a.x + b.x + b.w) / 2, off.y + (a.y + b.y + b.h) / 2, { steps: 4 });
  await page.mouse.move(off.x + b.x + b.w - 1, off.y + b.y + b.h / 2, { steps: 4 });
  await page.mouse.up();
}

/** Click the cat; returns the EXPLAIN message the page sent */
async function clickCat(frame) {
  const trigger = await frame.waitForSelector(".zeh-trigger", { timeout: 5000 });
  const before = await frame.evaluate(() => window.__mkSent.length);
  await trigger.click();
  await frame.waitForFunction((n) => window.__mkSent.slice(n).some((m) => m.type === "EXPLAIN"), before, { timeout: 5000 });
  return frame.evaluate((n) => window.__mkSent.slice(n).find((m) => m.type === "EXPLAIN"), before);
}

const panelText = (frame) => frame.evaluate(() => (document.querySelector(".zeh-panel")?.innerText || "").replace(/\s+/g, " "));

async function stubPrompts() {
  await installProviderStub(env.sw);
  return env.sw.evaluate(() => globalThis.__mkStub.requests.map((r) => r.prompt));
}

async function vocabEntry(term) {
  return until(
    () =>
      env.sw.evaluate(async (t) => {
        const list = (await chrome.storage.local.get("zehVocabulary")).zehVocabulary || [];
        return list.find((v) => v.term === t) || null;
      }, term),
    8000,
    `vocabulary entry for ${term}`
  );
}

/** Same acceptance flow for the manual and the MIME path */
async function acceptanceLookup(page, frame, { expectUrl }) {
  // the worker caches the result of a word in a sentence: an earlier test of the same profile
  // would answer from that cache and no provider request would be made
  await env.sw.evaluate(() => clearAllLookupCache());
  await installProviderStub(env.sw);
  const promptsBefore = (await stubPrompts()).length;
  await dragSelect(page, frame, "factual");
  const explain = await clickCat(frame);
  assert.equal(explain.text, "factual");
  assert.equal(explain.context.sentence, RAG, "the sentence of the PDF paragraph is sent as context");
  assert.equal(explain.context.sourceType, "pdf");
  assert.doesNotMatch(JSON.stringify(explain), /127\.0\.0\.1|single-column|Single column fixture/, "no URL or title leaves with the lookup");

  // dictionary-first panel, then the context enhancement from the stub provider
  await until(async () => /事实/.test(await panelText(frame)), 8000, "dictionary result");
  await until(async () => (await stubPrompts()).slice(promptsBefore).some((p) => p.includes(RAG)), 10000, "context request with the PDF sentence");
  const prompts = (await stubPrompts()).slice(promptsBefore);
  assert.ok(prompts.every((p) => !/127\.0\.0\.1|single-column\.pdf/.test(p)), "no URL or file name in provider prompts");

  // save → vocabulary entry with the PDF source and page
  await env.sw.evaluate(async () => chrome.storage.local.remove("zehVocabulary"));
  await frame.click(".zeh-panel-footer .mk-btn:nth-child(2)");
  const entry = await vocabEntry("factual");
  const ctx = (entry.contexts || [])[0] || {};
  assert.equal(ctx.sourceType, "pdf");
  assert.equal(ctx.sentence, RAG);
  assert.equal(ctx.pdf.page, 1);
  assert.equal(ctx.pdf.title, "Single column fixture");
  if (expectUrl) assert.equal(ctx.pdf.url, expectUrl);
  else assert.equal(ctx.pdf.url, undefined, "a local file has no source URL");
  return { explain, entry };
}

// ── manual path: fixtures ────────────────────────────────────────────────────

test("1 single-column academic PDF: cat → dictionary-first panel → context sentence → vocabulary entry with page", opts, async () => {
  const page = await readerTab();
  await openFixture(page, "single-column.pdf");
  await acceptanceLookup(page, page.mainFrame(), { expectUrl: null });
  // a heading or the running header gives no context (dictionary only)
  await dragSelect(page, page.mainFrame(), "Reproducible");
  const header = await clickCat(page.mainFrame());
  assert.equal(header.context, undefined);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("2 two-column academic PDF: the context never joins the columns", opts, async () => {
  const page = await readerTab();
  await openFixture(page, "two-column.pdf");
  await dragSelect(page, page.mainFrame(), "vector");
  const left = await clickCat(page.mainFrame());
  assert.equal(left.context.sentence, "Dense retrieval maps queries and passages into one vector space.");
  assert.doesNotMatch(JSON.stringify(left.context), /Sparse|baselines|Hybrid/);
  await dragSelect(page, page.mainFrame(), "baselines");
  const right = await clickCat(page.mainFrame());
  assert.match(right.context.sentence, /^They remain strong baselines because/);
  assert.doesNotMatch(JSON.stringify(right.context), /Dense|vector/);
  await page.close();
});

test("3 long wrapped paragraphs: a word hyphenated across lines is looked up whole, with its sentence", opts, async () => {
  const page = await readerTab();
  await openFixture(page, "wrapped.pdf");
  await dragSelect(page, page.mainFrame(), "incorpo-", "rating");
  const msg = await clickCat(page.mainFrame());
  assert.equal(msg.text, "incorporating");
  assert.equal(msg.context.sentence, "Retrieval-augmented generation improves factual accuracy by incorporating external knowledge into the prompt.");
  await page.close();
});

test("4 tables and formulas: cells and formula lines are looked up without context", opts, async () => {
  const page = await readerTab();
  await openFixture(page, "table-formula.pdf");
  // the layout model is built once the text layer has rendered
  await page.waitForFunction(() => document.querySelector('.textLayer[data-mk-mapped="1"]') && window.ZEHPdfReaderApp.lookup.modelFor(1));
  const cellWord = await page.evaluate(() => {
    const model = window.ZEHPdfReaderApp.lookup.modelFor(1);
    const bad = model.blocks.map((b, i) => (b.usable ? -1 : i)).filter((i) => i >= 0);
    const it = model.items.find((x) => bad.includes(x.block) && /^[A-Za-z]{4,}/.test(x.str.trim()));
    return it ? it.str.trim().match(/^[A-Za-z]{4,}/)[0] : null;
  });
  assert.ok(cellWord, "a word inside a table / formula block");
  await dragSelect(page, page.mainFrame(), cellWord);
  const msg = await clickCat(page.mainFrame());
  assert.equal(msg.text, cellWord);
  assert.equal(msg.context, undefined);
  await page.close();
});

test("5 image-only PDF: shown, no text layer words, OCR notice (no OCR attempted)", opts, async () => {
  const page = await readerTab();
  await openFixture(page, "image-only.pdf");
  await page.waitForFunction(() => !document.getElementById("notice").hidden, null, { timeout: 10000 });
  assert.match(await page.textContent("#notice"), /OCR|扫描/);
  assert.equal(await page.evaluate(() => document.querySelectorAll('.textLayer span[role="presentation"]').length), 0);
  await page.close();
});

test("6 corrupt PDF: a clear error with a way out, no endless loading", opts, async () => {
  const page = await readerTab();
  await openFixture(page, "corrupt.pdf", "error");
  assert.ok((await page.textContent("#errorText")).trim().length > 0);
  assert.equal(await page.isVisible("#errorOpenBtn"), true);
  assert.equal(await page.isVisible("#errorNativeBtn"), false, "no Chrome-viewer button for a local file");
  await page.close();
});

test("7 password-protected PDF: wrong password asks again, right one opens, cancel leaves cleanly", opts, async () => {
  const page = await readerTab();
  await openFixture(page, "password.pdf", "password");
  await page.fill("#passwordInput", "wrong");
  await page.click("#passwordSubmitBtn");
  await page.waitForFunction(() => /不正确/.test(document.getElementById("passwordPrompt").textContent));
  await page.fill("#passwordInput", "manekilex");
  await page.click("#passwordSubmitBtn");
  await page.waitForFunction(() => document.body.dataset.view === "ready", null, { timeout: 15000 });
  assert.equal(await page.inputValue("#passwordInput"), "", "the password is not kept in the form");
  await openFixture(page, "password.pdf", "password");
  await page.click("#passwordCancelBtn");
  await page.waitForFunction(() => ["landing", "error"].includes(document.body.dataset.view));
  await page.close();
});

test("8 multi-page PDF: page navigation, zoom and fit modes, search", opts, async () => {
  const page = await readerTab();
  await openFixture(page, "multi-page.pdf");
  const st = () =>
    page.evaluate(() => ({
      page: document.getElementById("pageInput").value,
      count: document.getElementById("pageCount").textContent,
      scale: document.getElementById("scaleSelect").value,
    }));
  assert.equal((await st()).page, "1");
  await page.click("#nextPageBtn");
  await until(async () => (await st()).page === "2", 5000, "page 2");
  await page.fill("#pageInput", "5");
  await page.press("#pageInput", "Enter");
  await until(async () => (await st()).page === "5", 5000, "page 5");
  await page.click("#zoomInBtn");
  await until(async () => (await st()).scale !== "auto", 5000, "zoomed");
  await page.selectOption("#scaleSelect", "page-fit");
  await until(async () => (await st()).scale === "page-fit", 5000, "fit page");
  assert.equal((await st()).page, "5", "zoom keeps the page");
  await page.selectOption("#scaleSelect", "page-width");
  await page.keyboard.press("Control+F");
  await page.fill("#findInput", "calibration");
  await until(async () => /1 \/ 2/.test(await page.textContent("#findStatus")), 8000, "first match");
  await page.press("#findInput", "Enter");
  await until(async () => /2 \/ 2/.test(await page.textContent("#findStatus")), 8000, "second match");
  await page.press("#findInput", "Escape");
  assert.equal(await page.isVisible("#findBar"), false);
  await page.close();
});

test("9 long PDF (300 pages): opens quickly, renders lazily, keeps bounded caches", opts, async () => {
  const page = await readerTab();
  const t0 = Date.now();
  await openFixture(page, "long.pdf");
  const openMs = Date.now() - t0;
  assert.ok(openMs < 15000, `opened in ${openMs} ms`);
  assert.equal(await page.textContent("#pageCount"), "/ 300");
  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => (document.getElementById("viewerContainer").scrollTop += 4000));
    await sleep(40);
  }
  await sleep(800);
  const stats = await page.evaluate(() => ({
    canvases: document.querySelectorAll(".page canvas").length,
    page: Number(document.getElementById("pageInput").value),
    models: window.ZEHPdfReaderApp.lookup.modelCount,
  }));
  assert.ok(stats.page > 20, `scrolled to page ${stats.page}`);
  assert.ok(stats.canvases <= 20, `${stats.canvases} canvases kept (PDF.js buffer is bounded)`);
  assert.ok(stats.models <= 24, `${stats.models} layout models kept`);
  await page.click("#zoomInBtn");
  await sleep(600);
  const after = Number(await page.inputValue("#pageInput"));
  assert.ok(Math.abs(after - stats.page) <= 1, `zoom keeps the reading position (${stats.page} → ${after})`);
  await page.close();
});

test("11 manual local PDF opening, download of the same bytes, and resource release", opts, async () => {
  const page = await readerTab();
  assert.equal(await page.isVisible("#landingOpenBtn"), true);
  await openFixture(page, "multi-page.pdf");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#downloadBtn")]);
  const saved = fs.readFileSync(await download.path());
  assert.deepEqual(saved, fs.readFileSync(fixtureFile(tmp, "multi-page.pdf")));
  // the PDF.js worker of the first document goes away when another document replaces it
  await until(() => page.workers().length >= 1, 5000, "PDF.js worker");
  await openFixture(page, "single-column.pdf");
  await until(() => page.workers().length === 1, 5000, "one worker after replacing the document");
  await page.evaluate(() => window.ZEHPdfReaderApp.closeDocument());
  await until(() => page.workers().length === 0, 5000, "worker released after closing");
  assert.equal(await page.evaluate(() => window.ZEHPdfReaderApp.lookup.modelCount), 0);
  await page.evaluate(() => window.ZEHPdfReaderApp.destroy());
  assert.deepEqual(await page.evaluate(() => ({ timers: window.ZEHPdfReaderApp.timerCount, blobs: window.ZEHPdfReaderApp.blobUrlCount })), { timers: 0, blobs: 0 });
  // nothing about the file was stored
  const stored = await env.sw.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  assert.doesNotMatch(stored, /multi-page\.pdf|calibration/);
  await page.close();
});

// ── MIME path: Chrome 151+ ───────────────────────────────────────────────────

function mimeSkip() {
  if (SKIP_REASON) return SKIP_REASON;
  return false;
}

async function requireMimeHandler(t) {
  const page = await env.ctx.newPage();
  await page.goto(`${env.base}/settings.html#reading`);
  const api = await page.evaluate(() => Boolean(globalThis.chrome && chrome.mimeHandler && chrome.mimeHandler.getMimeHandlerOptions));
  await page.close();
  if (env.major >= MIME_MIN_MAJOR && api) return true;
  const reason =
    env.major >= MIME_MIN_MAJOR
      ? `chrome.mimeHandler is missing in ${env.version}`
      : `needs Chrome ${MIME_MIN_MAJOR}+ for chrome.mimeHandler; this is ${env.version}`;
  if (REQUIRE_MIME) assert.fail(reason);
  t.skip(reason);
  return false;
}

/** The reader inside a tab that navigated to a PDF: the tab itself, or one of its frames */
async function findReaderFrame(page) {
  const prefix = `${env.base}/pdf-reader.html`;
  return until(
    () => page.frames().find((f) => f.url().startsWith(prefix)) || null,
    15000,
    `reader frame (frames: ${page.frames().map((f) => f.url()).join(", ")})`
  );
}

test("10 top-level navigation to an application/pdf response opens the enhanced reader; cat lookup end to end", { ...opts, skip: mimeSkip() }, async (t) => {
  if (!(await requireMimeHandler(t))) return;
  const page = await env.ctx.newPage();
  await page.addInitScript(RECORD_MESSAGES);
  const url = server.pdfUrl("single-column.pdf");
  await page.goto(url).catch(() => {});
  const frame = await findReaderFrame(page);
  await frame.waitForFunction(() => document.body.dataset.view === "ready", null, { timeout: 30000 });
  assert.equal(server.requests.filter((p) => p.endsWith("/single-column.pdf")).length, 1, "the PDF is fetched once");
  // the old top-right cat stays hidden in this tab
  const tabId = await env.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((x) => x.url === u)?.id, url);
  assert.ok(await env.sw.evaluate((id) => pdfReaderTabIds.has(id), tabId), "the worker knows the reader took over");
  const cat = await oldCat(page);
  assert.equal(cat.count, 1, "the old PDF cat is there");
  assert.equal(cat.visible, false, "old PDF cat hidden");
  await acceptanceLookup(page, frame, { expectUrl: url });
  await page.close();
});

test("12 fallback to Chrome's own viewer, and the settings toggle", { ...opts, skip: mimeSkip() }, async (t) => {
  if (!(await requireMimeHandler(t))) return;
  const url = server.pdfUrl("multi-page.pdf");
  const page = await env.ctx.newPage();
  await page.goto(url).catch(() => {});
  const frame = await findReaderFrame(page);
  await frame.waitForFunction(() => document.body.dataset.view === "ready", null, { timeout: 30000 });
  assert.equal(await frame.isVisible("#nativeBtn"), true);
  await frame.click("#nativeBtn");
  await until(() => !page.frames().some((f) => f.url().startsWith(`${env.base}/pdf-reader.html`)), 15000, "reader gone after fallback");
  const tabId = await env.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((x) => x.url === u)?.id, url);
  assert.equal(await env.sw.evaluate((id) => pdfReaderTabIds.has(id), tabId), false, "take-over released");
  await page.close();

  // settings: turn the handler off → Chrome's viewer; on again → the reader
  const settings = await env.ctx.newPage();
  await settings.goto(`${env.base}/settings.html#reading`);
  await settings.waitForSelector("#pdfHandlerToggle:not([disabled])", { timeout: 10000 });
  assert.equal(await settings.isChecked("#pdfHandlerToggle"), true, "on by default on supported Chrome");
  await settings.click("#pdfHandlerToggle");
  await until(() => settings.evaluate(async () => (await chrome.mimeHandler.getMimeHandlerOptions("application/pdf"))?.enabled === false), 5000, "handler disabled");
  const off = await env.ctx.newPage();
  await off.goto(url).catch(() => {});
  await sleep(2500);
  assert.equal(off.frames().some((f) => f.url().startsWith(`${env.base}/pdf-reader.html`)), false, "Chrome's viewer when off");
  await off.close();
  await settings.click("#pdfHandlerToggle");
  await until(() => settings.evaluate(async () => (await chrome.mimeHandler.getMimeHandlerOptions("application/pdf"))?.enabled !== false), 5000, "handler enabled");
  const on = await env.ctx.newPage();
  await on.goto(url).catch(() => {});
  await findReaderFrame(on);
  await on.close();
  await settings.close();
});

// ── switching back from Chrome's viewer with the old cat ─────────────────────

const readerPrefix = () => `${env.base}/pdf-reader.html`;
const hasReader = (page) => page.frames().some((f) => f.url().startsWith(readerPrefix()));

/** The old cat in the PDF tab's top document */
function oldCat(page) {
  return page.mainFrame().evaluate(() => {
    const roots = document.querySelectorAll("#zeh-pdf-assistant");
    const root = roots[0];
    if (!root) return { count: 0 };
    const notice = root.querySelector(".zeh-pdf-assistant-notice");
    return {
      count: roots.length,
      // the root is position: fixed (no offsetParent): visible = not hidden and the ball has a box
      visible: !root.hidden && root.querySelector(".zeh-pdf-assistant-ball").getClientRects().length > 0,
      enhanced: root.dataset.enhanced || "",
      busy: root.querySelector(".zeh-pdf-assistant-ball").classList.contains("is-busy"),
      notice: notice && !notice.hidden ? notice.dataset.reason : null,
      actions: notice && !notice.hidden ? [...notice.querySelectorAll("button")].map((b) => b.dataset.action) : [],
    };
  });
}

/** Chrome's own viewer is showing the PDF and the old cat is ready (the worker answered) */
async function waitNativeWithCat(page, enhanced) {
  await until(() => !hasReader(page), 15000, "Chrome's own viewer");
  return until(
    async () => {
      const cat = await oldCat(page).catch(() => null);
      return cat && cat.visible && (!enhanced || cat.enhanced === enhanced) ? cat : null;
    },
    10000,
    `old cat (${enhanced || "any"})`
  );
}

async function readyReader(page) {
  const frame = await findReaderFrame(page);
  await frame.waitForFunction(() => document.body.dataset.view === "ready", null, { timeout: 30000 });
  await frame.waitForFunction(() => document.querySelector(".textLayer") !== null, null, { timeout: 15000 });
  return frame;
}

const firstPageText = (frame) =>
  frame.evaluate(() => (document.querySelector('.page[data-page-number="1"] .textLayer')?.textContent || "").replace(/\s+/g, " ").trim());

const tabIdFor = (url) => env.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((x) => x.url === u)?.id, url);

async function setPdfHandler(enabled) {
  await env.sw.evaluate((on) => chrome.mimeHandler.setMimeHandlerOptions("application/pdf", { enabled: on }), enabled);
  await until(async () => (await env.sw.evaluate(() => chrome.mimeHandler.getMimeHandlerOptions("application/pdf")))?.enabled === enabled, 5000, "handler option");
}

test("13 Chrome viewer → old cat → enhanced reader, three times: same document, old cat hidden, nothing left behind", { ...opts, skip: mimeSkip() }, async (t) => {
  if (!(await requireMimeHandler(t))) return;
  const url = server.pdfUrl("multi-page.pdf");
  const page = await env.ctx.newPage();
  await page.goto(url).catch(() => {});
  const tabId = await tabIdFor(url);
  const fetches = () => server.requests.filter((p) => p === "/fixtures/multi-page.pdf").length;
  const probes = () => server.ranges.filter((p) => p === "/fixtures/multi-page.pdf").length;
  let reference = null;
  let historyLength = null;
  for (let round = 1; round <= 3; round++) {
    const frame = await readyReader(page);
    assert.equal(await frame.textContent("#pageCount"), "/ 6", `round ${round}: whole document`);
    const text = await firstPageText(frame);
    if (!reference) reference = text;
    assert.ok(text.length > 20, `round ${round}: page 1 has text`);
    assert.equal(text, reference, `round ${round}: the same document`);
    assert.equal(page.frames().filter((f) => f.url().startsWith(readerPrefix())).length, 1, `round ${round}: one reader`);
    assert.equal(await env.sw.evaluate((id) => pdfReaderTabIds.has(id), tabId), true, `round ${round}: worker knows the take-over`);
    const hiddenCat = await oldCat(page);
    assert.equal(hiddenCat.count, 1);
    assert.equal(hiddenCat.visible, false, `round ${round}: old cat hidden in enhanced mode`);

    await frame.click("#nativeBtn");
    const cat = await waitNativeWithCat(page, "available");
    assert.deepEqual({ count: cat.count, busy: cat.busy, notice: cat.notice }, { count: 1, busy: false, notice: null }, `round ${round}: one idle cat`);
    assert.equal(await env.sw.evaluate((id) => pdfReaderTabIds.has(id), tabId), false, `round ${round}: take-over released`);
    const h = await page.mainFrame().evaluate(() => history.length);
    if (historyLength === null) historyLength = h;
    assert.equal(h, historyLength, `round ${round}: no history entries added`);

    const before = { fetches: fetches(), probes: probes() };
    await page.click("#zehPdfBall");
    await until(() => hasReader(page), 15000, `round ${round}: reader again`);
    assert.equal(probes() - before.probes, 1, `round ${round}: one 1-byte check of the link`);
    assert.ok(fetches() - before.fetches <= 2, `round ${round}: the check and the reload only (${fetches() - before.fetches})`);
  }
  const frame = await readyReader(page);
  assert.equal(await firstPageText(frame), reference);
  assert.equal(await env.sw.evaluate(() => pdfReaderTabIds.size), 1, "one taken-over tab");
  assert.equal(page.url(), url);
  await page.close();
  await until(() => env.sw.evaluate((id) => !pdfReaderTabIds.has(id), tabId), 5000, "released when the tab closes");
});

test("14 handler turned off in settings: the old cat explains, opens settings, never reloads or changes the choice", { ...opts, skip: mimeSkip() }, async (t) => {
  if (!(await requireMimeHandler(t))) return;
  const url = server.pdfUrl("two-column.pdf");
  await setPdfHandler(false);
  try {
    const page = await env.ctx.newPage();
    await page.goto(url).catch(() => {});
    await sleep(1500);
    assert.equal(hasReader(page), false, "Chrome's viewer while the handler is off");
    await waitNativeWithCat(page, "disabled");
    const fetches = server.requests.filter((p) => p === "/fixtures/two-column.pdf").length;
    await page.click("#zehPdfBall");
    const cat = await until(async () => ((await oldCat(page)).notice ? oldCat(page) : null), 5000, "notice");
    assert.equal(cat.notice, "disabled");
    assert.deepEqual(cat.actions, ["open-settings", "close"]);
    await sleep(1500);
    assert.equal(hasReader(page), false, "not reopened");
    assert.equal(server.requests.filter((p) => p === "/fixtures/two-column.pdf").length, fetches, "no request for the PDF");
    assert.equal((await env.sw.evaluate(() => chrome.mimeHandler.getMimeHandlerOptions("application/pdf"))).enabled, false, "choice kept");

    const [settings] = await Promise.all([env.ctx.waitForEvent("page"), page.click('.zeh-pdf-assistant-notice button[data-action="open-settings"]')]);
    await until(() => settings.url().startsWith(`${env.base}/settings.html#reading`), 5000, "settings at the reading section");
    assert.equal((await oldCat(page)).notice, null, "notice closed");
    await settings.close();
    // the cat toggles the notice; it never stays as a dead button
    await page.click("#zehPdfBall");
    await until(async () => (await oldCat(page)).notice === "disabled", 5000, "notice again");
    await page.click("#zehPdfBall");
    assert.equal((await oldCat(page)).notice, null);
    await page.close();
  } finally {
    await setPdfHandler(true);
  }
});

test("15 expired link: the old cat keeps Chrome's viewer, explains, and opens the reader for a local file", { ...opts, skip: mimeSkip() }, async (t) => {
  if (!(await requireMimeHandler(t))) return;
  const url = server.expiringUrl("multi-page.pdf");
  const page = await env.ctx.newPage();
  await page.goto(url).catch(() => {});
  const frame = await readyReader(page);
  await frame.click("#nativeBtn");
  await waitNativeWithCat(page, "available");
  server.expired.add("/expiring/multi-page.pdf");
  const before = server.requests.filter((p) => p === "/expiring/multi-page.pdf").length;
  await page.click("#zehPdfBall");
  const cat = await until(async () => ((await oldCat(page)).notice ? oldCat(page) : null), 10000, "notice");
  assert.equal(cat.notice, "unavailable");
  assert.equal(cat.busy, false);
  assert.deepEqual(cat.actions, ["open-file", "close"]);
  await sleep(1500);
  assert.equal(server.requests.filter((p) => p === "/expiring/multi-page.pdf").length - before, 1, "only the 1-byte check");
  assert.equal(hasReader(page), false);
  assert.equal(page.url(), url, "still the same page");
  assert.equal((await oldCat(page)).visible, true, "Chrome's viewer and the cat are still there");

  const [manual] = await Promise.all([env.ctx.waitForEvent("page"), page.click('.zeh-pdf-assistant-notice button[data-action="open-file"]')]);
  await manual.waitForFunction(() => window.ZEHPdfReaderApp && document.body.dataset.view === "landing", null, { timeout: 10000 });
  assert.equal(manual.url(), `${env.base}/pdf-reader.html`, "the reader opens for a manually chosen file");
  await manual.close();
  await page.close();
});

test("16 unsupported Chrome: the old cat keeps the legacy viewer and right-click lookup, and says why", opts, async () => {
  // Chrome 151+: Chrome's viewer (handler off) and a worker without chrome.mimeHandler, like Chrome 150
  const simulate = env.major >= MIME_MIN_MAJOR;
  if (simulate) {
    await setPdfHandler(false);
    await env.sw.evaluate(() => {
      globalThis.__mkMimeHandler = chrome.mimeHandler;
      Object.defineProperty(chrome, "mimeHandler", { value: undefined, configurable: true, writable: true });
    });
  }
  try {
    const url = server.pdfUrl("single-column.pdf");
    const page = await env.ctx.newPage();
    await page.goto(url).catch(() => {});
    await waitNativeWithCat(page, "unsupported");
    await page.click("#zehPdfBall");
    const cat = await until(async () => ((await oldCat(page)).notice ? oldCat(page) : null), 5000, "notice");
    assert.equal(cat.notice, "unsupported");
    assert.deepEqual(cat.actions, ["open-file", "close"]);
    assert.equal(hasReader(page), false);
    // right-click "Manekilex 查词" still opens the old cat's panel
    const tab = await env.sw.evaluate(async (u) => (await chrome.tabs.query({})).find((x) => x.url === u), url);
    await env.sw.evaluate(({ tab }) => dispatchPdfLookup("factual", tab), { tab });
    await until(
      () => page.mainFrame().evaluate(() => document.getElementById("zeh-pdf-assistant").classList.contains("expanded") && Boolean(document.querySelector("#zeh-pdf-assistant .zeh-panel"))),
      8000,
      "old cat panel"
    );
    assert.equal((await oldCat(page)).notice, null, "the lookup replaces the notice");
    await page.close();
  } finally {
    if (simulate) {
      await env.sw.evaluate(() => {
        Object.defineProperty(chrome, "mimeHandler", { value: globalThis.__mkMimeHandler, configurable: true, writable: true });
      });
      await setPdfHandler(true);
    }
  }
});

test("ordinary web pages are not intercepted and keep the web lookup", opts, async () => {
  const page = await env.ctx.newPage();
  await page.goto(`${server.origin}/page.html`);
  await sleep(600);
  assert.equal(page.url(), `${server.origin}/page.html`);
  assert.equal(await page.evaluate(() => document.getElementById("zeh-pdf-assistant")), null);
  await page.close();
});
