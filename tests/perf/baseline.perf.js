/**
 * Performance baseline (npm run perf): measures, does not assert. Runs the extension in a real
 * Chrome (the browser-test harness: MK_BROWSER_PATH, MK_HEADED) with every provider call answered
 * by the in-worker stub, and prints one JSON object with, per measurement, the sample count and
 * median / p95 / min / max in milliseconds (memory in MB).
 *
 *   dictionaryLookup   web page: pointerdown on the cat → dictionary meaning in the panel (cache cleared)
 *   contextEnhancement same lookups: pointerdown on the cat → stubbed AI context meaning in the panel
 *   aiLookup           a word missing from the dictionary: pointerdown on the cat → stubbed AI
 *                      meaning in the panel
 *   workerWarm / workerCold  an extension page's message round trip, with the worker running /
 *                      just stopped (CDP ServiceWorker.stopAllWorkers), so the cold one includes
 *                      the worker's start and its importScripts
 *   epubOpen           reader.html?id=… navigation start → first chapter shown, restore finished
 *                      (a 4-chapter book and a 150-chapter book)
 *   epubChapterSwitch  click on a table-of-contents entry → that chapter shown (in-page clock,
 *                      requestAnimationFrame resolution)
 *   epubMemory         JS heap of the reader page (after a forced GC) for the large book: after
 *                      opening, after 30 chapter switches, and after closing / reopening
 *   pdfOpen            enhanced PDF reader: local file chosen → first text layer; and (Chrome
 *                      151+) top-level navigation to a PDF → reader frame with its text layer
 *
 * MK_PERF_RUNS sets the sample count per measurement (default 12). Timer resolution and run-to-run
 * noise are in the output; compare medians of runs on the same machine only.
 */
const { performance } = require("node:perf_hooks");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SKIP_REASON, sleep, until, startServer, fixtureFile, installProviderStub, launch } = require("../browser/harness");

const RUNS = Math.max(3, Number(process.env.MK_PERF_RUNS) || 12);

const PAGES = {
  "/article.html": () =>
    `<!doctype html><title>Harbour article</title><body style="font:20px serif;margin:40px">` +
    `<h1>Morning</h1><p id="p1">The old harbour was busy at dawn. Merchants waited for the tide.</p>` +
    `<p id="p2">The zorblaxian lanterns glowed along the pier all night.</p></body>`,
};

function stats(samples, digits = 1) {
  const s = samples.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return { n: 0 };
  const at = (q) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
  const r = (v) => Number(v.toFixed(digits));
  return { n: s.length, median: r(at(0.5)), p95: r(at(0.95)), min: r(s[0]), max: r(s[s.length - 1]) };
}

/** Viewport rect of `word` in a frame */
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
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }
    return null;
  }, word);
}

/**
 * One web-page lookup: double-click `word`, click the cat, and time (in the page's clock, from the
 * pointerdown on the cat) until the panel text matches each pattern.
 */
async function timeLookup(env, server, word, patterns) {
  const page = await env.ctx.newPage();
  await page.goto(`${server.origin}/article.html`);
  await env.sw.evaluate(() => clearAllLookupCache());
  await page.evaluate((sources) => {
    const res = sources.map((s) => new RegExp(s));
    window.__mkPerf = { t0: null, hits: res.map(() => null) };
    // the cat acts on pointerdown and removes itself, so the clock starts there (window, capture:
    // before any of the page's own handlers)
    window.addEventListener("pointerdown", (e) => {
      const onCat = e.composedPath().some((el) => el && el.classList && el.classList.contains("zeh-trigger"));
      if (onCat && window.__mkPerf.t0 === null) window.__mkPerf.t0 = performance.now();
    }, true);
    const check = () => {
      const panel = document.querySelector(".zeh-panel");
      if (!panel || window.__mkPerf.t0 === null) return;
      const text = panel.innerText || "";
      res.forEach((re, i) => {
        if (window.__mkPerf.hits[i] === null && re.test(text)) window.__mkPerf.hits[i] = performance.now() - window.__mkPerf.t0;
      });
    };
    new MutationObserver(check).observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  }, patterns.map((p) => p.source));
  const r = await wordRect(page.mainFrame(), word);
  await page.mouse.dblclick(r.x, r.y);
  const cat = await page.waitForSelector(".zeh-trigger.mk-lookup-bubble", { state: "visible", timeout: 5000 });
  await sleep(300); // the cat's activation delay
  const box = await cat.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const hits = await until(
    async () => {
      const h = await page.evaluate(() => window.__mkPerf.hits);
      return h.every((v) => v !== null) ? h : null;
    },
    15000,
    `panel for ${word}`,
    20
  ).catch(async (err) => {
    const seen = await page.evaluate(() => ({ t0: window.__mkPerf.t0, hits: window.__mkPerf.hits, panel: (document.querySelector(".zeh-panel")?.innerText || "").slice(0, 300) }));
    err.message += ` ${JSON.stringify(seen)}`;
    throw err;
  });
  await page.close();
  return hits;
}

async function measureLookups(env, server, out) {
  const dict = [];
  const ctx = [];
  const ai = [];
  for (let i = 0; i <= RUNS; i++) {
    const [d, c] = await timeLookup(env, server, "harbour", [/港口|海港/, /桩此处含义/]);
    const [a] = await timeLookup(env, server, "zorblaxian", [/桩释义|桩此处含义/]);
    if (i === 0) continue; // warm-up
    dict.push(d);
    ctx.push(c);
    ai.push(a);
  }
  out.dictionaryLookup = stats(dict);
  out.contextEnhancement = stats(ctx);
  out.aiLookup = stats(ai);
}

async function addBook(env, chapters, paragraphs, label) {
  const page = await env.ctx.newPage();
  await page.goto(`${env.base}/settings.html#reading`);
  await page.waitForFunction(() => window.ZEHEpubBuilder && window.ZEHBookStore && window.ZEHHtmlSanitize);
  const result = await page.evaluate(
    async ({ chapters, paragraphs, label }) => {
      const para = (w, i) =>
        `<p>${w} paragraph ${i}. The river ran past the old mill while the keeper of chapter ${w} waited by the bank, ` +
        `counting boats, clouds and the slow turn of the water wheel through a long afternoon.</p>`;
      const list = Array.from({ length: chapters }, (_, c) => {
        const w = `ch${c + 1}`;
        return { id: `chapter-${c + 1}`, title: `Chapter ${c + 1}`, html: ZEHHtmlSanitize.wrapChapterXhtml(`Chapter ${c + 1}`, Array.from({ length: paragraphs }, (_, i) => para(w, i)).join("")) };
      });
      const blob = await ZEHEpubBuilder.buildEpubBlob({ title: label, author: "Perf", chapters: list });
      const rec = await ZEHBookStore.addBook({ title: label, author: "Perf", fileBlob: blob, format: "epub" });
      return { id: rec.id, bytes: blob.size };
    },
    { chapters, paragraphs, label }
  );
  await page.close();
  return result;
}

/** The chapter word (ch<n>) the book iframe shows, and whether the reader is still restoring */
const READER_STATE = () => {
  const frame = document.querySelector("#viewer iframe");
  const text = (frame && frame.contentDocument && frame.contentDocument.body && frame.contentDocument.body.innerText) || "";
  const m = text.match(/^(ch\d+) paragraph 0\./m);
  const busy = document.body.classList.contains("reader-restoring") || document.body.classList.contains("reader-section-switching");
  return { chapter: m ? m[1] : null, busy };
};

async function timeOpen(env, id) {
  const page = await env.ctx.newPage();
  await page.goto(`${env.base}/reader.html?id=${encodeURIComponent(id)}`, { waitUntil: "commit" });
  const ms = await until(
    () => page.evaluate((src) => {
      const s = new Function(`return (${src})()`)();
      return s.chapter === "ch1" && !s.busy ? performance.now() : null;
    }, READER_STATE.toString()),
    30000,
    "first chapter",
    15
  );
  return { page, ms };
}

/** Click the n-th table-of-contents entry and time it (in-page) until chapter n+1 is shown */
function timeTocJump(page, index) {
  return page.evaluate(
    async ({ index, src }) => {
      const state = new Function(`return (${src})()`);
      const items = document.querySelectorAll(".reader-toc-item");
      const t0 = performance.now();
      items[index].click();
      const want = `ch${index + 1}`;
      for (;;) {
        await new Promise((r) => requestAnimationFrame(r));
        const s = state();
        if (s.chapter === want && !s.busy) return performance.now() - t0;
        if (performance.now() - t0 > 20000) return NaN;
      }
    },
    { index, src: READER_STATE.toString() }
  );
}

async function heapMB(env, page) {
  const cdp = await env.ctx.newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("Performance.enable");
  const { metrics } = await cdp.send("Performance.getMetrics");
  await cdp.detach();
  const get = (name) => (metrics.find((m) => m.name === name) || {}).value || 0;
  return { heapMB: Number((get("JSHeapUsedSize") / 1048576).toFixed(2)), nodes: get("Nodes"), documents: get("Documents"), frames: get("Frames") };
}

async function measureEpub(env, out) {
  const small = await addBook(env, 4, 60, "Perf small");
  const large = await addBook(env, 150, 80, "Perf large");
  out.epubBooks = { small: { chapters: 4, paragraphs: 60, epubKB: Math.round(small.bytes / 1024) }, large: { chapters: 150, paragraphs: 80, epubKB: Math.round(large.bytes / 1024) } };

  for (const [name, book, jumps] of [["small", small, [1, 2, 3, 0]], ["large", large, [75, 149, 10, 120, 40]]]) {
    const opens = [];
    const switches = [];
    for (let i = 0; i <= Math.ceil(RUNS / 2); i++) {
      const { page, ms } = await timeOpen(env, book.id);
      await sleep(1600); // the open restore keeps short locks after the visual is ready
      if (i > 0) opens.push(ms);
      if (i === 1) {
        for (const j of jumps) {
          switches.push(await timeTocJump(page, j));
          await sleep(1200);
        }
      }
      // start every open from the first chapter
      await page.evaluate(() => document.querySelectorAll(".reader-toc-item")[0].click());
      await until(() => page.evaluate((src) => new Function(`return (${src})()`)().chapter === "ch1", READER_STATE.toString()), 15000, "back to ch1");
      await sleep(1200);
      await page.close();
    }
    out[`epubOpen_${name}`] = stats(opens);
    out[`epubChapterSwitch_${name}`] = stats(switches);
  }

  // memory: the large book, 30 chapter switches, then a reopen in a new tab
  const { page } = await timeOpen(env, large.id);
  await sleep(1600);
  const opened = await heapMB(env, page);
  for (let k = 0; k < 30; k++) {
    await timeTocJump(page, (k * 37) % 150);
    await sleep(300);
  }
  const afterSwitches = await heapMB(env, page);
  await page.evaluate(() => document.querySelectorAll(".reader-toc-item")[0].click());
  await sleep(1500);
  await page.close();
  const again = await timeOpen(env, large.id);
  await sleep(1600);
  const reopened = await heapMB(env, again.page);
  await again.page.close();
  out.epubMemory_large = { opened, after30Switches: afterSwitches, reopenedNewTab: reopened };
}

async function measurePdf(env, server, out) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mk-perf-pdf-"));
  try {
    const local = [];
    for (let i = 0; i <= Math.ceil(RUNS / 2); i++) {
      const page = await env.ctx.newPage();
      await page.goto(`${env.base}/pdf-reader.html`);
      await page.waitForFunction(() => window.ZEHPdfReaderApp && document.body.dataset.view === "landing");
      const t0 = performance.now();
      await page.setInputFiles("#fileInput", fixtureFile(tmp, "multi-page.pdf"));
      await page.waitForFunction(() => document.body.dataset.view === "ready" && document.querySelector(".textLayer") !== null, null, { timeout: 30000, polling: 10 });
      if (i > 0) local.push(performance.now() - t0);
      await page.close();
    }
    out.pdfOpen_localFile = stats(local);

    const mime = await env.sw.evaluate(() => Boolean(chrome.mimeHandler && chrome.mimeHandler.getMimeHandlerOptions));
    if (!mime) {
      out.pdfOpen_navigation = { skipped: `chrome.mimeHandler missing in ${env.version}` };
      return;
    }
    const nav = [];
    for (let i = 0; i <= Math.ceil(RUNS / 2); i++) {
      const page = await env.ctx.newPage();
      const t0 = performance.now();
      await page.goto(server.pdfUrl("multi-page.pdf")).catch(() => {});
      const frame = await until(() => page.frames().find((f) => f.url().startsWith(`${env.base}/pdf-reader.html`)) || null, 15000, "reader frame", 10);
      await frame.waitForFunction(() => document.body.dataset.view === "ready" && document.querySelector(".textLayer") !== null, null, { timeout: 30000, polling: 10 });
      if (i > 0) nav.push(performance.now() - t0);
      await page.close();
    }
    out.pdfOpen_navigation = stats(nav);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function measureWorker(env, out) {
  const page = await env.ctx.newPage();
  await page.goto(`${env.base}/popup.html`);
  const ask = () =>
    page.evaluate(async () => {
      const t0 = performance.now();
      const r = await chrome.runtime.sendMessage({ type: "GET_LOOKUP_CACHE_STATS" });
      return r ? performance.now() - t0 : NaN;
    });
  const cdp = await env.ctx.newCDPSession(page);
  const statuses = [];
  cdp.on("ServiceWorker.workerVersionUpdated", (e) => {
    for (const v of e.versions) if (v.scriptURL.endsWith("/background.js")) statuses.push(v.runningStatus);
  });
  await cdp.send("ServiceWorker.enable");
  await until(() => statuses.length > 0, 5000, "worker status");
  const warm = [];
  const cold = [];
  for (let i = 0; i <= RUNS; i++) {
    await ask();
    const w = await ask();
    await cdp.send("ServiceWorker.stopAllWorkers");
    await until(() => statuses.at(-1) === "stopped", 10000, "worker stopped", 20);
    await sleep(200);
    const c = await ask();
    if (i === 0) continue;
    warm.push(w);
    cold.push(c);
  }
  await cdp.detach();
  await page.close();
  out.workerWarm = stats(warm, 2);
  out.workerCold = stats(cold, 1);
}

async function main() {
  if (SKIP_REASON) {
    console.error(SKIP_REASON);
    process.exit(2);
  }
  const server = await startServer(PAGES);
  const env = await launch();
  const out = {
    browser: env.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}, ${os.cpus().length} × ${os.cpus()[0]?.model || "cpu"}`,
    node: process.version,
    headed: process.env.MK_HEADED === "1",
    runs: RUNS,
    when: new Date().toISOString(),
  };
  try {
    await installProviderStub(env.sw);
    await measureLookups(env, server, out);
    await measureEpub(env, out);
    await measurePdf(env, server, out);
    await measureWorker(env, out); // last: Playwright keeps no handle on the restarted worker
  } finally {
    await env.close();
    await server.close();
  }
  const text = JSON.stringify(out, null, 2);
  if (process.env.MK_PERF_OUT) fs.writeFileSync(process.env.MK_PERF_OUT, text + "\n");
  console.log(text);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
