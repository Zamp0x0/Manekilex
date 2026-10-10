/**
 * The shared lookup UI in a real browser, in every host that is not the PDF reader
 * (npm run test:browser; the PDF reader has its own file, pdf-reader.browser.js).
 *
 *   - an ordinary web page: double-click a word → cat → dictionary-first panel → context
 *     enhancement from the provider stub → vocabulary entry with the page URL;
 *   - iframes: a same-origin frame (its cat and panel go to the top document) and two
 *     cross-origin frames (UI stays in the frame); lookups in different frames overlap and
 *     finish in the opposite order, and each panel shows its own word;
 *   - results that are not for a frame (another frame's queryId, a superseded queryId, a made-up
 *     queryId) are never rendered;
 *   - the EPUB reader: lookup inside the book iframe carries the book, chapter and sentence, and
 *     the reading position survives a reload;
 *   - popup, settings and the vocabulary list in real extension pages;
 *   - the service worker stopped and woken by the next lookup.
 *
 * Every host name except localhost / 127.0.0.1 resolves to NOTFOUND and provider requests are
 * answered by the stub in harness.js: no network, no API key, no paid request.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { SKIP_REASON, sleep, until, startServer, installProviderStub, launch } = require("./harness");

const ARTICLE = "The old harbour was busy at dawn. Merchants waited for the tide.";
const FRAME_TEXT = {
  meadow: "We crossed the meadow before sunset.",
  lantern: "She carried a lantern through the dark hall.",
  glacier: "The glacier moved slowly down the valley.",
};

const PAGES = {
  "/article.html": () =>
    `<!doctype html><title>Harbour article</title><body style="font:20px serif;margin:40px">` +
    `<h1>Morning</h1><p id="p1">${ARTICLE}</p></body>`,
  "/frame.html": (url) => {
    const w = url.searchParams.get("w") || "meadow";
    return `<!doctype html><title>Frame ${w}</title><body style="font:20px serif;margin:16px"><p>${FRAME_TEXT[w]}</p></body>`;
  },
  "/frames.html": (url, port) =>
    `<!doctype html><title>Frames</title><body style="font:20px serif;margin:20px">` +
    `<p>Top page text.</p>` +
    `<iframe id="same" src="/frame.html?w=meadow" style="width:520px;height:120px;border:1px solid #888"></iframe><br>` +
    `<iframe id="crossA" src="http://localhost:${port}/frame.html?w=lantern" style="width:520px;height:120px;border:1px solid #888"></iframe><br>` +
    `<iframe id="crossB" src="http://localhost:${port}/frame.html?w=glacier" style="width:520px;height:120px;border:1px solid #888"></iframe>` +
    `</body>`,
  // a page that tries to use the cat on its own: it selects its text, then fakes a click on the cat
  "/scripted.html": () =>
    `<!doctype html><title>Scripted clicks</title><body style="font:20px serif;margin:40px">` +
    `<p id="p1">${ARTICLE}</p><script>` +
    `window.__tries = 0;` +
    `function pick() { const n = document.getElementById("p1").firstChild; const i = n.nodeValue.indexOf("Merchants");` +
    `  const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 9); getSelection().removeAllRanges(); getSelection().addRange(r); }` +
    `setTimeout(() => { pick(); const t = setInterval(() => { const cat = document.querySelector(".zeh-trigger");` +
    `  if (!cat) return; window.__tries++;` +
    `  for (const type of ["pointerdown", "pointerup"]) cat.dispatchEvent(new PointerEvent(type, { bubbles: true }));` +
    `  cat.click(); if (window.__tries >= 5) clearInterval(t); }, 200); }, 800);` +
    `</script></body>`,
};

let env = null;
let server = null;

test.before(async () => {
  if (SKIP_REASON) return;
  server = await startServer(PAGES);
  env = await launch();
  await recordMessages();
  console.log(`# browser: ${env.version} (major ${env.major})`);
});

test.after(async () => {
  if (env) await env.close();
  if (server) await server.close();
});

const opts = { skip: SKIP_REASON || false, timeout: 90000 };

// ── helpers ──────────────────────────────────────────────────────────────────

/** The service worker (the stop / wake test replaces it with the new instance) */
async function worker() {
  return env.sw;
}

/** Record every runtime message the worker receives, with the sender's frame (an extra listener) */
async function recordMessages() {
  await env.sw.evaluate(() => {
    if (globalThis.__mkSeen) return;
    globalThis.__mkSeen = [];
    chrome.runtime.onMessage.addListener((message, sender) => {
      globalThis.__mkSeen.push({
        type: message && message.type,
        queryId: message && message.queryId,
        text: message && message.text,
        context: message && message.context,
        frameId: sender.frameId,
        documentId: sender.documentId,
        tabId: sender.tab ? sender.tab.id : null,
        url: sender.url,
      });
    });
  });
}

const seen = async () => (await worker()).evaluate(() => globalThis.__mkSeen);

async function lastExplain(after, label) {
  return until(
    async () => (await seen()).slice(after).find((m) => m.type === "EXPLAIN"),
    8000,
    `EXPLAIN for ${label}`
  );
}

async function webTab(path) {
  const page = await env.ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  await page.goto(`${server.origin}${path}`);
  page.errors = errors;
  return page;
}

/** Viewport rect of `word` inside `frame` (frame-relative) */
function wordRect(frame, word) {
  return frame.evaluate((w) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const at = node.nodeValue.indexOf(w);
      if (at < 0) continue;
      const r = document.createRange();
      r.setStart(node, at);
      r.setEnd(node, at + w.length);
      const b = r.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height };
    }
    return null;
  }, word);
}

/** Page coordinates of a frame's top-left corner (nested frames add up) */
async function frameOrigin(frame) {
  let x = 0;
  let y = 0;
  for (let f = frame; f.parentFrame(); f = f.parentFrame()) {
    const el = await f.frameElement();
    const box = await el.boundingBox();
    const inner = await el.evaluate((e) => ({ l: e.clientLeft, t: e.clientTop }));
    // boundingBox is already relative to the main viewport
    return { x: box.x + inner.l, y: box.y + inner.t };
  }
  return { x, y };
}

/** Double-click `word` with the real mouse (selects it; content.js shows the cat on mouseup) */
async function dblclickWord(page, frame, word) {
  const r = await wordRect(frame, word);
  assert.ok(r, `"${word}" is on the page`);
  const o = await frameOrigin(frame);
  // the frame's document keeps the mouse and selection events it gets, for catDiagnosis. The
  // listeners are added from the parent when it can reach the document (epub.js frames run no
  // scripts of their own), otherwise from the frame itself.
  const record = (doc, store) => {
    store.__mkEvents = [];
    store.__mkHover = false;
    if (store.__mkEventsOn) return true;
    store.__mkEventsOn = true;
    const t0 = performance.now();
    doc.addEventListener("mousemove", () => (store.__mkHover = true), true);
    for (const type of ["mousedown", "mouseup", "dblclick", "selectionchange", "focusout", "scroll"]) {
      doc.addEventListener(
        type,
        (e) => {
          if (store.__mkEvents.length > 40) return;
          const sel = String(doc.getSelection() || "").slice(0, 20);
          store.__mkEvents.push([type, Math.round(performance.now() - t0), e.clientX ?? "", e.clientY ?? "", sel, e.target && e.target.nodeName]);
        },
        true
      );
    }
    return true;
  };
  const viaParent = frame.parentFrame()
    ? await (await frame.frameElement())
        .evaluate((el, src) => {
          if (!el.contentDocument) return false;
          return new Function(`return (${src})`)()(el.contentDocument, el);
        }, record.toString())
        .catch(() => false)
    : false;
  if (!viaParent) await frame.evaluate((src) => new Function(`return (${src})`)()(document, window), record.toString()).catch(() => {});
  // the top page records too: a click meant for a frame that lands there shows up in the diagnosis
  if (frame !== page.mainFrame()) await page.mainFrame().evaluate((src) => new Function(`return (${src})`)()(document, window), record.toString()).catch(() => {});
  const at = { x: o.x + r.x + r.w / 2, y: o.y + r.y + r.h / 2 };
  page.__mkLastClick = { word, frame: frame.url().slice(0, 60), at: [at.x, at.y].map(Math.round), rect: [r.x, r.y, r.w, r.h].map(Math.round), origin: [o.x, o.y].map(Math.round) };
  // Chrome sends the mouse to a frame only once it has drawn it: until then (a frame just loaded
  // or just changed by the test) the top page gets the clicks. Hover the word until the frame sees
  // the mouse.
  const hovered = viaParent
    ? async () => (await frame.frameElement()).evaluate((el) => el.__mkHover === true).catch(() => false)
    : () => frame.evaluate(() => window.__mkHover === true).catch(() => false);
  page.__mkLastClick.hovered = false;
  for (let i = 0; i < 40 && !page.__mkLastClick.hovered; i++) {
    await page.mouse.move(at.x + (i % 2), at.y);
    await sleep(50);
    page.__mkLastClick.hovered = await hovered();
  }
  await page.mouse.dblclick(at.x, at.y);
}

/** What every frame shows when a cat does not appear: its selection and the cat elements */
async function catDiagnosis(page, uiFrame) {
  const frames = await Promise.all(
    page.frames().map((f) =>
      Promise.race([
        f
          .evaluate(() => ({
            url: location.href.slice(0, 80),
            selection: String(window.getSelection() || "").slice(0, 40),
            events: window.__mkEvents || [...document.querySelectorAll("iframe")].map((f) => f.__mkEvents).find(Boolean) || null,
            cats: [...document.querySelectorAll(".zeh-trigger")].map((el) => ({
              className: el.className,
              display: getComputedStyle(el).display,
              visibility: getComputedStyle(el).visibility,
              rect: [el.getBoundingClientRect().left, el.getBoundingClientRect().top].map(Math.round),
            })),
          }))
          .catch((e) => ({ url: f.url().slice(0, 80), error: String(e.message || e).slice(0, 80) })),
        sleep(1000).then(() => ({ url: f.url().slice(0, 80), error: "no answer" })),
      ])
    )
  );
  const last = page.__mkLastClick || null;
  const now = last ? await Promise.all(page.frames().filter((f) => f.url().startsWith(last.frame)).map((f) => wordRect(f, last.word).catch(() => null))) : null;
  return { ui: uiFrame === page.mainFrame() ? "main" : uiFrame.url().slice(0, 80), click: last, rectNow: now, frames, errors: page.errors || [] };
}

/** Click the cat that is shown in `uiFrame`; returns the EXPLAIN the worker received */
async function clickCat(page, uiFrame, label) {
  const before = (await seen()).length;
  const cat = await uiFrame
    .waitForSelector(".zeh-trigger.mk-lookup-bubble", { state: "visible", timeout: 5000 })
    .catch(async (error) => {
      throw new Error(`${error.message}\nno cat for "${label}": ${JSON.stringify(await catDiagnosis(page, uiFrame))}`);
    });
  await sleep(300); // activation delay against accidental clicks
  const box = await cat.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  return lastExplain(before, label);
}

const panelText = (frame) => frame.evaluate(() => (document.querySelector(".zeh-panel")?.innerText || "").replace(/\s+/g, " "));
const panelCount = (frame) => frame.evaluate(() => document.querySelectorAll(".zeh-panel").length);

async function lookUp(page, frame, uiFrame, word) {
  if (await panelCount(uiFrame)) {
    // close the open panel first (it may cover the next word), as a reader would
    await uiFrame.evaluate(() => document.body.focus());
    await page.keyboard.press("Escape");
    await until(async () => (await panelCount(uiFrame)) === 0, 3000, "panel closed");
  }
  await dblclickWord(page, frame, word);
  return clickCat(page, uiFrame, word);
}

async function vocabEntry(term) {
  return until(
    async () =>
      (await worker()).evaluate(async (t) => {
        const list = (await chrome.storage.local.get("zehVocabulary")).zehVocabulary || [];
        return list.find((v) => v.term === t) || null;
      }, term),
    8000,
    `vocabulary entry for ${term}`
  );
}

async function clearLookupCache() {
  await (await worker()).evaluate(() => clearAllLookupCache());
}

/** Send a message from the worker to every frame of the tab showing `path` (like sendToTab) */
async function sendToTab(path, message) {
  await (await worker()).evaluate(
    async ({ url, message }) => {
      const [tab] = await chrome.tabs.query({ url });
      await chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    },
    { url: `${server.origin}${path}`, message }
  );
}

const frameByUrl = (page, part) => page.frames().find((f) => f.url().includes(part));

// ── web page ─────────────────────────────────────────────────────────────────

test("web page: cat → dictionary-first panel → context enhancement → vocabulary entry with the page", opts, async () => {
  await clearLookupCache();
  const page = await webTab("/article.html");
  const promptsBefore = await (await worker()).evaluate(() => globalThis.__mkStub.requests.length);
  const explain = await lookUp(page, page.mainFrame(), page.mainFrame(), "harbour");
  assert.equal(explain.text, "harbour");
  assert.equal(explain.frameId, 0);
  assert.ok(explain.queryId, "EXPLAIN carries a queryId");
  assert.equal(explain.context.sentence, "The old harbour was busy at dawn.");
  assert.equal(explain.context.sourceType, "web");

  await until(async () => /港口|海港/.test(await panelText(page.mainFrame())), 8000, "dictionary meaning");
  await until(
    async () => (await (await worker()).evaluate(() => globalThis.__mkStub.requests.map((r) => r.prompt))).slice(promptsBefore).some((p) => p.includes("The old harbour was busy at dawn.")),
    10000,
    "context enhancement request with the sentence"
  );
  await until(async () => /桩此处含义/.test(await panelText(page.mainFrame())), 8000, "context meaning in the panel");

  await (await worker()).evaluate(async () => chrome.storage.local.remove("zehVocabulary"));
  await page.click(".zeh-panel-footer .mk-btn:nth-child(2)");
  const entry = await vocabEntry("harbour");
  const ctx = (entry.contexts || [])[0] || {};
  assert.equal(ctx.sentence, "The old harbour was busy at dawn.");
  assert.equal(ctx.sourceType, "web");
  assert.equal(entry.pageUrl || ctx.pageUrl, `${server.origin}/article.html`);
  assert.deepEqual(page.errors, []);
  await page.close();
});

// ── iframes ──────────────────────────────────────────────────────────────────

test("same-origin iframe: the cat and panel go to the top page, EXPLAIN comes from the frame", opts, async () => {
  const page = await webTab("/frames.html");
  const same = frameByUrl(page, "w=meadow");
  await same.waitForLoadState();
  const explain = await lookUp(page, same, page.mainFrame(), "meadow");
  assert.equal(explain.text, "meadow");
  assert.notEqual(explain.frameId, 0, "sent by the iframe's content script");
  assert.equal(explain.url, `${server.origin}/frame.html?w=meadow`);
  assert.equal(explain.context.sourceType, "iframe");
  assert.equal(explain.context.sentence, FRAME_TEXT.meadow);
  await until(async () => /草地|牧场/.test(await panelText(page.mainFrame())), 8000, "panel in the top document");
  assert.equal(await panelCount(same), 0, "no panel inside the same-origin frame");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("cross-origin iframes: overlapping lookups finish in reverse order; each frame shows only its own word", opts, async () => {
  await clearLookupCache();
  const page = await webTab("/frames.html");
  const a = frameByUrl(page, "w=lantern");
  const b = frameByUrl(page, "w=glacier");
  await a.waitForLoadState();
  await b.waitForLoadState();
  assert.ok(a.url().startsWith("http://localhost:"), "frame A is cross-origin");

  // words the dictionary does not know, so both go to the (held) provider stub
  const sw = await worker();
  await sw.evaluate(() => {
    const stub = globalThis.__mkStub;
    stub.waiting = [];
    stub.hold = true;
    stub.respond = (prompt) => {
      const term = /lanternfly/.test(prompt) ? "lanternfly" : /glacieret/.test(prompt) ? "glacieret" : "other";
      return { term, phonetic: "", part_of_speech: "noun", short_meaning: `释义-${term}`, examples: [], memory_tip: "", memory_tip_type: "none", derivatives: [], synonyms: [], key_phrases: [] };
    };
  });
  await a.evaluate(() => (document.querySelector("p").textContent = "She carried a lanternfly through the dark hall."));
  await b.evaluate(() => (document.querySelector("p").textContent = "The glacieret moved slowly down the valley."));
  try {
    const ea = await lookUp(page, a, a, "lanternfly");
    const eb = await lookUp(page, b, b, "glacieret");
    assert.notEqual(ea.frameId, eb.frameId);
    assert.notEqual(ea.queryId, eb.queryId);
    assert.equal(ea.context.sourceType, "iframe");
    await until(() => sw.evaluate(() => globalThis.__mkStub.waiting.length >= 2), 8000, "both provider requests waiting");
    const order = await sw.evaluate(() => globalThis.__mkStub.waiting.map((w) => (/lanternfly/.test(w.prompt) ? "a" : "b")));
    // finish B first, then A
    await sw.evaluate((i) => globalThis.__mkStub.release(i), order.indexOf("b"));
    await until(async () => /释义-glacieret/.test(await panelText(b)), 8000, "frame B result");
    assert.doesNotMatch(await panelText(a), /释义-glacieret/, "B's result is not shown in A");
    await sw.evaluate((i) => globalThis.__mkStub.release(i), order.indexOf("a"));
    await until(async () => /释义-lanternfly/.test(await panelText(a)), 8000, "frame A result");
    assert.doesNotMatch(await panelText(b), /释义-lanternfly/, "A's result is not shown in B");
    assert.equal(await panelCount(page.mainFrame()), 0, "nothing leaks into the top page");
  } finally {
    await sw.evaluate(() => {
      const stub = globalThis.__mkStub;
      stub.hold = false;
      stub.respond = null;
      stub.waiting.forEach((w, i) => stub.release(i));
    });
  }
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("results for another frame, a superseded query or an unknown queryId are never rendered", opts, async () => {
  const page = await webTab("/frames.html");
  const a = frameByUrl(page, "w=lantern");
  const b = frameByUrl(page, "w=glacier");
  await a.waitForLoadState();
  await b.waitForLoadState();
  const first = await lookUp(page, a, a, "lantern");
  await until(async () => /灯笼|提灯/.test(await panelText(a)), 8000, "frame A dictionary result");
  const second = await lookUp(page, a, a, "hall");
  await until(async () => /大厅|礼堂|走廊/.test(await panelText(a)), 8000, "frame A second result");
  const inB = await lookUp(page, b, b, "glacier");
  await until(async () => /冰川/.test(await panelText(b)), 8000, "frame B result");

  const forged = (queryId, mark) => ({ type: "SHOW_RESULT", queryId, queryType: "word", fromDict: true, durationMs: 0, data: { term: mark, short_meaning: mark } });
  await sendToTab("/frames.html", forged("not-a-real-query", "伪造-未知"));
  await sendToTab("/frames.html", forged(first.queryId, "伪造-已过期"));
  await sendToTab("/frames.html", { type: "SHOW_ERROR", queryId: "not-a-real-query", message: "伪造-错误" });
  await sleep(600);
  for (const f of [page.mainFrame(), a, b, frameByUrl(page, "w=meadow")]) {
    assert.doesNotMatch(await panelText(f), /伪造/, `nothing forged rendered in ${f.url()}`);
  }
  // the real current query of B is still answered in B only
  await sendToTab("/frames.html", forged(inB.queryId, "真实-B"));
  await until(async () => /真实-B/.test(await panelText(b)), 5000, "current query of frame B");
  assert.doesNotMatch(await panelText(a), /真实-B/);
  assert.notEqual(second.queryId, inB.queryId);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("M3b: lookup results go only to the frame that asked; unknown and queryId-less requests are refused", opts, async () => {
  const sw = await worker();
  // watch what the worker sends to tabs, with the frame target (the real call still goes out)
  await sw.evaluate(() => {
    globalThis.__mkSent = [];
    globalThis.__mkRealTabSend = chrome.tabs.sendMessage;
    chrome.tabs.sendMessage = function (tabId, message, options, ...rest) {
      globalThis.__mkSent.push({ tabId, type: message && message.type, queryId: message && message.queryId, options: options || null });
      return globalThis.__mkRealTabSend.call(chrome.tabs, tabId, message, options, ...rest);
    };
  });
  const page = await webTab("/frames.html");
  try {
    const a = frameByUrl(page, "w=lantern");
    const b = frameByUrl(page, "w=glacier");
    await a.waitForLoadState();
    await b.waitForLoadState();
    const ea = await lookUp(page, a, a, "lantern");
    await until(async () => /灯笼|提灯/.test(await panelText(a)), 8000, "frame A result");
    const eb = await lookUp(page, b, b, "glacier");
    await until(async () => /冰川/.test(await panelText(b)), 8000, "frame B result");
    assert.ok(ea.documentId && eb.documentId && ea.documentId !== eb.documentId, "two documents");

    const sent = await sw.evaluate(() => globalThis.__mkSent);
    for (const e of [ea, eb]) {
      const results = sent.filter((m) => m.queryId === e.queryId);
      assert.ok(results.length >= 1, `a result for ${e.text}`);
      for (const r of results) {
        assert.equal(r.tabId, e.tabId);
        assert.deepEqual(r.options, { documentId: e.documentId }, `${r.type} for ${e.text} targets the asking document`);
      }
    }
    assert.doesNotMatch(await panelText(page.mainFrame()), /灯笼|冰川/, "nothing in the top page");
  } finally {
    await sw.evaluate(() => {
      chrome.tabs.sendMessage = globalThis.__mkRealTabSend;
    });
    await page.close();
  }

  // the worker refuses what it does not route, in real Chrome (one answer, no hang)
  const popup = await extensionPage("popup.html");
  const answers = await popup.evaluate(async () => ({
    unknown: await chrome.runtime.sendMessage({ type: "NO_SUCH_TYPE" }),
    noQueryId: await chrome.runtime.sendMessage({ type: "EXPLAIN", text: "harbour" }),
    badType: await chrome.runtime.sendMessage({ type: "EXPLAIN", text: "harbour", queryId: "q_browser", queryType: "evil" }),
  }));
  assert.deepEqual(answers.unknown, { ok: false, accepted: false, code: "UNKNOWN_MESSAGE_TYPE" });
  assert.equal(answers.noQueryId.code, "INVALID_QUERY_ID");
  assert.equal(answers.noQueryId.accepted, false);
  assert.equal(answers.badType.code, "INVALID_QUERY_TYPE");
  assert.deepEqual(popup.errors, []);
  await popup.close();
});

// ── EPUB reader ──────────────────────────────────────────────────────────────

const CHAPTERS = [
  { id: "chapter-1", title: "Orchard", body: "<p>Ripe apples hung in the orchard all summer. The farmer counted them twice.</p>" },
  { id: "chapter-2", title: "Lighthouse", body: "<p>The lighthouse keeper watched the stormy sea.</p>" },
  { id: "chapter-3", title: "Valley", body: "<p>Snow covered the quiet valley by morning.</p>" },
];

/** Build an EPUB with the extension's own builder and store it, from an extension page */
async function addTestBook() {
  const page = await env.ctx.newPage();
  await page.goto(`${env.base}/settings.html#reading`);
  await page.waitForFunction(() => window.ZEHEpubBuilder && window.ZEHBookStore && window.ZEHHtmlSanitize);
  const id = await page.evaluate(async (chapters) => {
    const blob = await ZEHEpubBuilder.buildEpubBlob({
      title: "Browser Test Book",
      author: "Test Author",
      chapters: chapters.map((c) => ({ id: c.id, title: c.title, html: ZEHHtmlSanitize.wrapChapterXhtml(c.title, c.body) })),
    });
    const record = await ZEHBookStore.addBook({ title: "Browser Test Book", author: "Test Author", fileBlob: blob, format: "epub" });
    return record.id;
  }, CHAPTERS);
  await page.close();
  return id;
}

async function openReader(id) {
  const page = await env.ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  await page.goto(`${env.base}/reader.html?id=${encodeURIComponent(id)}`);
  page.errors = errors;
  return page;
}

/**
 * The epub.js iframe that shows `text`, once the reader has finished restoring the position: until
 * then the book is hidden (visibility: hidden) and a double-click there reaches nothing
 */
async function bookFrame(page, text) {
  return until(
    async () => {
      const settled = await page
        .evaluate(() => !document.body.classList.contains("reader-restoring") && !document.body.classList.contains("reader-section-switching"))
        .catch(() => false);
      if (!settled) return null;
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        // a frame that is still being replaced may never answer: give each one a second
        const has = await Promise.race([
          f.evaluate((t) => Boolean(document.body && document.body.innerText.includes(t)), text).catch(() => false),
          sleep(1000).then(() => false),
        ]);
        if (has) return f;
      }
      return null;
    },
    15000,
    `book iframe showing "${text}"`
  );
}

test("EPUB reader: lookup inside the book carries the sentence and the book; the reading position survives a reload", opts, async () => {
  const id = await addTestBook();
  const page = await openReader(id);
  const ch1 = await bookFrame(page, "orchard");
  const explain = await lookUp(page, ch1, page.mainFrame(), "orchard");
  assert.equal(explain.text, "orchard");
  assert.equal(explain.url, `${env.base}/reader.html?id=${encodeURIComponent(id)}`);
  assert.equal(explain.context.sentence, "Ripe apples hung in the orchard all summer.");
  assert.equal(explain.context.sourceType, "epub");
  await until(async () => /果园/.test(await panelText(page.mainFrame())), 8000, "dictionary result in the reader");

  await (await worker()).evaluate(async () => chrome.storage.local.remove("zehVocabulary"));
  await page.click(".zeh-panel-footer .mk-btn:nth-child(2)");
  const entry = await vocabEntry("orchard");
  const ctx = (entry.contexts || [])[0] || {};
  assert.equal(ctx.sentence, "Ripe apples hung in the orchard all summer.");
  assert.equal(ctx.book.id, String(id));
  assert.equal(ctx.book.title, "Browser Test Book");
  assert.equal(ctx.sourceType, "epub");
  assert.equal(ctx.book.chapterIndex, 0);
  assert.equal(ctx.book.chapterTitle, "Orchard");
  assert.match(ctx.book.cfi, /^epubcfi\(/, "the position of the word in the book");

  // go to chapter 3 through the table of contents, then reload
  await page.keyboard.press("Escape");
  const tocItem = page.locator('.reader-toc-item:has-text("Valley")');
  if (!(await tocItem.isVisible())) await page.click("#readerTocToggleBtn");
  await tocItem.click();
  await bookFrame(page, "quiet valley");
  await until(
    () => page.evaluate(async (bookId) => {
      const b = await ZEHBookStore.getBook(bookId);
      return b && b.currentSpineIndex === 2 ? { spine: b.currentSpineIndex, location: b.currentLocation } : null;
    }, id),
    10000,
    "reading position saved"
  );
  await page.reload();
  const again = await bookFrame(page, "quiet valley");
  assert.ok(again, "the reader reopens at chapter 3");
  assert.equal(await again.evaluate(() => document.body.innerText.includes("orchard")), false, "not at chapter 1");
  assert.deepEqual(page.errors, []);
  await page.close();
});

// ── popup, settings, vocabulary ──────────────────────────────────────────────

async function extensionPage(path) {
  const page = await env.ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  await page.goto(`${env.base}/${path}`);
  page.errors = errors;
  return page;
}

test("popup: the global switch turns page lookup off and on again", opts, async () => {
  const web = await webTab("/article.html");
  const popup = await extensionPage("popup.html");
  const toggle = popup.locator("#manekilexEnabledToggle");
  const sw = popup.locator(".popup-enable-switch"); // the visible switch; the checkbox itself is hidden
  await until(() => toggle.isChecked(), 5000, "switch on");
  await sw.click();
  await until(() => popup.isVisible("#manekilexDisabledHint"), 5000, "disabled hint");
  await until(async () => (await (await worker()).evaluate(async () => (await chrome.storage.local.get("zehManekilexEnabled")).zehManekilexEnabled)) === false, 5000, "stored off");

  await dblclickWord(web, web.mainFrame(), "harbour");
  await sleep(800);
  assert.equal(await web.locator(".zeh-trigger.mk-lookup-bubble:visible").count(), 0, "no cat while switched off");

  await sw.click();
  await until(() => toggle.isChecked(), 5000, "switch on again");
  await until(async () => !(await popup.isVisible("#manekilexDisabledHint")), 5000, "hint hidden");
  const explain = await lookUp(web, web.mainFrame(), web.mainFrame(), "harbour");
  assert.equal(explain.text, "harbour", "lookup works again");
  assert.deepEqual(popup.errors, []);
  assert.deepEqual(web.errors, []);
  await popup.close();
  await web.close();
});

test("settings: every visible section opens; the vocabulary list shows a saved word with its sentence", opts, async () => {
  // a saved word from a real page lookup
  await (await worker()).evaluate(async () => chrome.storage.local.remove("zehVocabulary"));
  const web = await webTab("/article.html");
  await lookUp(web, web.mainFrame(), web.mainFrame(), "harbour");
  await until(async () => /港口|海港/.test(await panelText(web.mainFrame())), 8000, "result");
  await web.click(".zeh-panel-footer .mk-btn:nth-child(2)");
  await vocabEntry("harbour");
  await web.close();

  const page = await extensionPage("settings.html");
  const sections = await page.$$eval(".nav-item:not([hidden])", (els) => els.map((e) => e.dataset.section));
  assert.ok(sections.length >= 7, `visible sections: ${sections.join(", ")}`);
  for (const section of sections) {
    const before = await page.textContent("#sectionTitle");
    await page.click(`.nav-item[data-section="${section}"]`);
    await until(async () => (await page.evaluate(() => location.hash)) === `#${section}`, 5000, `#${section}`);
    const title = await page.textContent("#sectionTitle");
    assert.ok(title && title.trim(), `${section} has a title`);
    if (section !== sections[0]) assert.ok(title !== before || section === "usage", `${section} changes the title`);
  }
  await page.click('.nav-item[data-section="vocabulary"]');
  await until(async () => /harbour/.test(await page.textContent("#vocabList")), 8000, "saved word in the list");
  assert.match(await page.textContent("#vocabList"), /The old harbour was busy at dawn\./, "with its sentence");
  // provider key never shown in the page
  assert.doesNotMatch(await page.content(), /browser-test-key/);
  assert.deepEqual(page.errors, []);
  await page.close();
});

// ── service worker stop / wake ───────────────────────────────────────────────

test("a page cannot click the cat for the user: scripted clicks send nothing; a real click still looks the word up", opts, async () => {
  await clearLookupCache();
  const before = (await seen()).length;
  const requestsBefore = await (await worker()).evaluate(() => globalThis.__mkStub.requests.length);
  const page = await webTab("/scripted.html");
  await until(() => page.evaluate(() => window.__tries >= 5), 10000, "the page tried five times");
  await sleep(500);
  const types = (await seen()).slice(before).map((m) => m.type);
  assert.deepEqual(types.filter((t) => ["EXPLAIN", "ADD_VOCAB", "OPEN_SETTINGS"].includes(t)), [], "no lookup, save or settings for scripted clicks");
  assert.equal(await (await worker()).evaluate(() => globalThis.__mkStub.requests.length), requestsBefore, "no provider request");
  assert.equal(await panelCount(page.mainFrame()), 0, "no panel for the page to read");

  // the cat is still there for the user, and a real click works
  await page.click(".zeh-trigger.mk-lookup-bubble");
  const explain = await lastExplain(before, "Merchants");
  assert.equal(explain.text, "Merchants");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("service worker: stopped, then woken by the next lookup, which still gets its result", opts, async () => {
  const web = await webTab("/article.html");
  // ServiceWorker.stopAllWorkers stops the workers of the session's storage partition: an
  // extension page's session reaches the extension's own worker. Its status events say when
  // the worker has stopped and when it runs again.
  const ext = await extensionPage("popup.html");
  const cdp = await env.ctx.newCDPSession(ext);
  const statuses = [];
  cdp.on("ServiceWorker.workerVersionUpdated", (e) => {
    for (const v of e.versions) if (v.scriptURL.endsWith("/background.js")) statuses.push(v.runningStatus);
  });
  await cdp.send("ServiceWorker.enable");
  await until(() => statuses.includes("running"), 5000, "worker status");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await until(() => statuses.at(-1) === "stopped", 10000, "worker stopped");
  const stoppedAt = statuses.length;

  // the first lookup after the stop wakes the worker; a dictionary word needs no provider
  await dblclickWord(web, web.mainFrame(), "harbour");
  const cat = await web.waitForSelector(".zeh-trigger.mk-lookup-bubble", { state: "visible", timeout: 5000 });
  await sleep(300);
  await cat.click();
  await until(async () => /港口|海港/.test(await panelText(web.mainFrame())), 15000, "result from the woken worker");
  assert.ok(statuses.slice(stoppedAt).includes("running"), `worker started again (${statuses.join(" → ")})`);
  await cdp.detach();
  await ext.close();
  // Playwright keeps the old worker handle and does not attach to the restarted worker, so this
  // test runs last: later tests would have no stub or message recorder in the new worker.
  assert.deepEqual(web.errors, []);
  await web.close();
});
