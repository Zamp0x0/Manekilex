/**
 * Switching back from Chrome's own PDF viewer to the enhanced reader with the old PDF cat.
 *
 *   - the worker answers PDF_PAGE_ENHANCED status from Chrome's version (chrome.mimeHandler, 151+),
 *     the user's "open PDFs with Manekilex" choice (read only, never changed), the sender frame and
 *     the link type; "open-file" opens the reader next to the PDF tab for a manually chosen file;
 *   - clicking the cat asks the worker, checks the link with one same-origin 1-byte request, then
 *     reloads the same tab (Chrome's MIME handler gives the PDF to the reader again);
 *   - when the PDF cannot go back (handler off, old Chrome, local file, embedded or generated PDF,
 *     expired link, reload cancelled) the page stays as it is and the cat shows why, with a button
 *     that works (open settings / open a local PDF in the reader); never a dead button.
 * The real-browser side (Chrome 155) is in tests/browser/pdf-reader.browser.js (13–16).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackground, contentScriptSender, extensionPageSender, sleep } = require("./helpers/extension-sandbox");
const { createPageEnv, disposeLookupControllers, LOOKUP_CORE } = require("./helpers/fake-dom");

test.afterEach(() => disposeLookupControllers());

const plain = (value) => JSON.parse(JSON.stringify(value));
const PDF_URL = "https://papers.example.test/rag.pdf";
const READER = "chrome-extension://test-extension/pdf-reader.html";

// ── worker ───────────────────────────────────────────────────────────────────

function mimeHandler(options) {
  const calls = { get: 0, set: 0 };
  return {
    calls,
    getMimeHandlerOptions: async (type) => {
      calls.get++;
      assert.equal(type, "application/pdf");
      if (options instanceof Error) throw options;
      return options;
    },
    setMimeHandlerOptions: async () => {
      calls.set++;
    },
  };
}

function workerWith(mime, extra = {}) {
  const created = [];
  const bg = loadBackground({ storage: { zehManekilexEnabled: true }, mimeHandler: mime });
  bg.chrome.tabs.create = (props) => (created.push(props), Promise.resolve({ id: 99 }));
  Object.assign(bg.chrome.tabs, extra);
  return { bg, created };
}

const status = (bg, sender) => bg.dispatch({ type: "PDF_PAGE_ENHANCED", action: "status" }, sender);

test("worker: the PDF goes back to the reader only on Chrome 151+ with the handler on, for a top-level web link", async () => {
  const on = mimeHandler({ enabled: true });
  const { bg } = workerWith(on);
  assert.deepEqual(await status(bg, contentScriptSender(PDF_URL, 7)), { ok: true, available: true, reason: null });
  assert.deepEqual(await status(bg, contentScriptSender("http://intranet.test/a.pdf", 7)), { ok: true, available: true, reason: null });
  // Chrome reports no options until the user changes the choice: on by default
  assert.deepEqual(await status(workerWith(mimeHandler(undefined)).bg, contentScriptSender(PDF_URL, 7)), { ok: true, available: true, reason: null });

  const no = async (sender) => (await status(bg, sender)).reason;
  assert.equal(await no(contentScriptSender("file:///home/me/paper.pdf", 7)), "local-file");
  assert.equal(await no(contentScriptSender("data:application/pdf;base64,JVBERi0=", 7)), "source");
  assert.equal(await no(contentScriptSender("blob:https://papers.example.test/1234", 7)), "source");
  assert.equal(await no({ ...contentScriptSender(PDF_URL, 7), frameId: 3 }), "source", "a PDF embedded in a page");
  assert.equal(await no({ id: "test-extension", url: PDF_URL, frameId: 0 }), "source", "no tab");

  // the reader already shows this tab
  await bg.dispatch({ type: "PDF_READER_STATE", active: true, tabId: 7 }, { id: "test-extension", url: READER, tab: { id: 7 } });
  assert.equal(await no(contentScriptSender(PDF_URL, 7)), "active");
  assert.equal(on.calls.set, 0, "the user's choice is never written");
});

test("worker: handler turned off, old Chrome, or an API failure → not available, with the reason", async () => {
  const off = mimeHandler({ enabled: false });
  assert.deepEqual(await status(workerWith(off).bg, contentScriptSender(PDF_URL, 7)), { ok: true, available: false, reason: "disabled" });
  assert.equal(off.calls.set, 0);
  assert.deepEqual(await status(workerWith(null).bg, contentScriptSender(PDF_URL, 7)), { ok: true, available: false, reason: "unsupported" });
  assert.deepEqual(await status(workerWith({}).bg, contentScriptSender(PDF_URL, 7)), { ok: true, available: false, reason: "unsupported" });
  assert.deepEqual(await status(workerWith(mimeHandler(new Error("boom"))).bg, contentScriptSender(PDF_URL, 7)), {
    ok: true,
    available: false,
    reason: "unsupported",
  });
});

test("worker: open-file opens the reader next to the PDF tab; unknown actions do nothing", async () => {
  const { bg, created } = workerWith(mimeHandler({ enabled: true }));
  const sender = { ...contentScriptSender(PDF_URL, 7), tab: { id: 7, index: 2, url: PDF_URL } };
  assert.deepEqual(await bg.dispatch({ type: "PDF_PAGE_ENHANCED", action: "open-file" }, sender), { ok: true });
  assert.deepEqual(plain(created), [{ url: READER, index: 3, openerTabId: 7 }]);
  assert.deepEqual(await bg.dispatch({ type: "PDF_PAGE_ENHANCED", action: "reload" }, sender), { ok: false });
  assert.deepEqual(await bg.dispatch({ type: "PDF_PAGE_ENHANCED" }, extensionPageSender("settings.html")), { ok: false });
  assert.equal(created.length, 1, "nothing else is opened, nothing is reloaded by the worker");
});

// ── the old cat ──────────────────────────────────────────────────────────────

/**
 * The old cat on a PDF page in Chrome's own viewer. `worker` answers its messages (PDF_PAGE_ENHANCED,
 * OPEN_SETTINGS); `fetch` answers the 1-byte check; timers of 10 s or more (the reload watchdog)
 * are kept in `longTimers` to be run by the test.
 */
function loadCat({ worker, fetch, ready = { ok: true } }) {
  const reloads = [];
  const fetches = [];
  const longTimers = [];
  const env = createPageEnv({
    only: [...LOOKUP_CORE, "pdf-page-assistant.js"],
    location: { href: PDF_URL, protocol: "https:", hostname: "papers.example.test", pathname: "/rag.pdf", search: "", reload: () => reloads.push(Date.now()) },
    globals: {
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      fetch: async (url, init) => {
        fetches.push({ url: String(url), init });
        return fetch(url, init);
      },
      setTimeout: (fn, ms, ...args) => (ms >= 10000 ? (longTimers.push(fn), longTimers.length) : setTimeout(fn, ms, ...args)),
      clearTimeout: (id) => {
        if (typeof id === "number" && id <= longTimers.length) longTimers[id - 1] = null;
        else clearTimeout(id);
      },
    },
  });
  const sendMessage = env.runtime.sendMessage;
  env.runtime.sendMessage = (message, cb) => {
    const result = sendMessage(message, cb);
    const entry = env.sent.at(-1);
    if (message.type !== "PDF_PAGE_ASSISTANT_READY") Promise.resolve().then(() => entry.cb(worker(message)));
    return result;
  };
  env.sent.find((s) => s.message.type === "PDF_PAGE_ASSISTANT_READY").cb(ready);
  const all = (el) => [el, ...el.children.flatMap(all)];
  const root = [env.document.body, env.document.documentElement].flatMap((el) => (el ? [...el.children] : [])).find((el) => el.id === "zeh-pdf-assistant");
  const find = (cls) => all(root).find((el) => el.className.split(" ").includes(cls));
  return {
    env,
    root,
    reloads,
    fetches,
    longTimers,
    ball: () => find("zeh-pdf-assistant-ball"),
    notice: () => find("zeh-pdf-assistant-notice"),
    noticeReason: () => (find("zeh-pdf-assistant-notice").hidden ? null : find("zeh-pdf-assistant-notice").dataset.reason),
    noticeButtons: () => all(find("zeh-pdf-assistant-notice")).filter((el) => el.tagName === "BUTTON"),
    sentOf: (type) => env.sent.map((s) => s.message).filter((m) => m.type === type),
  };
}

const workerSays = (status) => (message) =>
  message.type === "PDF_PAGE_ENHANCED" && message.action === "status" ? { ok: true, ...status } : { ok: true };
const AVAILABLE = workerSays({ available: true, reason: null });
const pdfResponse = (status = 206, type = "application/pdf", headers = {}) => async () =>
  new Response(status === 206 || status === 200 ? "%" : "gone", { status, headers: { "content-type": type, ...headers } });

async function click(cat) {
  cat.ball().click();
  await sleep(15);
}

test("old cat: available → one same-origin 1-byte check of this link, then a same-tab reload; a second click waits", async () => {
  const cat = loadCat({ worker: AVAILABLE, fetch: pdfResponse(206) });
  await sleep(10);
  assert.equal(cat.root.hidden, false);
  assert.equal(cat.root.dataset.enhanced, "available");
  assert.equal(cat.ball().title, "用 Manekilex 增强阅读器打开这份 PDF");
  cat.ball().click();
  cat.ball().click(); // double click while checking
  await sleep(15);
  assert.equal(cat.fetches.length, 1, "one check");
  const [{ url, init }] = cat.fetches;
  assert.equal(url, PDF_URL, "the page's own link (same origin), nothing else");
  assert.deepEqual(plain({ method: init.method, headers: init.headers, cache: init.cache, credentials: init.credentials }), {
    method: "GET",
    headers: { Range: "bytes=0-0" },
    cache: "no-store",
    credentials: "same-origin",
  });
  assert.equal(cat.reloads.length, 1, "reloaded once");
  assert.equal(cat.ball().classList.contains("is-busy"), true);
  assert.equal(cat.noticeReason(), null);
  assert.equal(cat.sentOf("OPEN_SETTINGS").length, 0);
});

test("old cat: an expired / login / form-generated link is not reloaded; the notice offers the manual reader", async () => {
  const failures = [
    pdfResponse(410, "text/html"), // expired signed link
    pdfResponse(403, "text/html"), // needs a new login
    pdfResponse(405, ""), // generated by a form (POST only)
    pdfResponse(200, "text/html"), // a login page
    pdfResponse(200, "application/pdf", { "content-disposition": "attachment; filename=a.pdf" }), // would download
    async () => {
      throw new TypeError("Failed to fetch"); // network / CORS
    },
  ];
  for (const response of failures) {
    disposeLookupControllers();
    const cat = loadCat({ worker: AVAILABLE, fetch: response });
    await sleep(10);
    await click(cat);
    assert.equal(cat.reloads.length, 0, "the page stays");
    assert.equal(cat.noticeReason(), "unavailable");
    assert.equal(cat.ball().classList.contains("is-busy"), false);
    assert.deepEqual(cat.noticeButtons().map((b) => b.dataset.action), ["open-file", "close"]);
    cat.noticeButtons()[0].click();
    await sleep(5);
    assert.deepEqual(plain(cat.sentOf("PDF_PAGE_ENHANCED").at(-1)), { type: "PDF_PAGE_ENHANCED", action: "open-file" });
    assert.equal(cat.noticeReason(), null, "the notice closes");
  }
});

test("old cat: handler off → explains and opens the reading settings; no check, no reload", async () => {
  const cat = loadCat({ worker: workerSays({ available: false, reason: "disabled" }), fetch: pdfResponse(206) });
  await sleep(10);
  assert.equal(cat.root.dataset.enhanced, "disabled");
  assert.equal(cat.ball().title, "Manekilex 查词");
  await click(cat);
  assert.equal(cat.noticeReason(), "disabled");
  assert.equal(cat.fetches.length, 0);
  assert.equal(cat.reloads.length, 0);
  assert.deepEqual(cat.noticeButtons().map((b) => b.dataset.action), ["open-settings", "close"]);
  cat.noticeButtons()[0].click();
  await sleep(5);
  assert.deepEqual(plain(cat.sentOf("OPEN_SETTINGS")), [{ type: "OPEN_SETTINGS", section: "reading" }]);
  // the cat toggles the notice
  await click(cat);
  assert.equal(cat.noticeReason(), "disabled");
  await click(cat);
  assert.equal(cat.noticeReason(), null);
});

test("old cat: old Chrome, local file, generated PDF or no answer → a notice with a working action, the page stays", async () => {
  for (const [said, reason] of [
    [{ available: false, reason: "unsupported" }, "unsupported"],
    [{ available: false, reason: "local-file" }, "local-file"],
    [{ available: false, reason: "source" }, "source"],
    [{ available: false, reason: "something-new" }, "error"],
  ]) {
    disposeLookupControllers();
    const cat = loadCat({ worker: workerSays(said), fetch: pdfResponse(206) });
    await sleep(10);
    await click(cat);
    assert.equal(cat.noticeReason(), reason, reason);
    assert.deepEqual(cat.noticeButtons().map((b) => b.dataset.action), ["open-file", "close"], reason);
    assert.equal(cat.fetches.length + cat.reloads.length, 0, reason);
  }
  disposeLookupControllers();
  const silent = loadCat({ worker: () => undefined, fetch: pdfResponse(206) });
  await sleep(10);
  await click(silent);
  assert.equal(silent.noticeReason(), "error");
  assert.equal(silent.reloads.length, 0);
});

test("old cat: if Chrome does not reload (form resubmission cancelled), the cat stops waiting and says so", async () => {
  const cat = loadCat({ worker: AVAILABLE, fetch: pdfResponse(200) });
  await sleep(10);
  await click(cat);
  assert.equal(cat.reloads.length, 1);
  const watchdogs = cat.longTimers.filter(Boolean);
  assert.equal(watchdogs.length, 1);
  watchdogs[0]();
  assert.equal(cat.ball().classList.contains("is-busy"), false);
  assert.equal(cat.noticeReason(), "not-reloaded");
  assert.deepEqual(cat.noticeButtons().map((b) => b.dataset.action), ["open-file", "close"]);
});

test("old cat: an open lookup panel is closed first; right-click lookups replace the notice; hidden while the reader shows the PDF", async () => {
  const cat = loadCat({ worker: workerSays({ available: false, reason: "unsupported" }), fetch: pdfResponse(206) });
  await sleep(10);
  const deliver = (message) => cat.env.runtime.onMessage.listeners.forEach((fn) => fn(message, { id: "test-extension" }, () => {}));
  deliver({ type: "PDF_PAGE_LOOKUP", text: "factual" });
  assert.equal(cat.root.classList.contains("expanded"), true);
  const statusAsks = cat.sentOf("PDF_PAGE_ENHANCED").length;
  await click(cat);
  assert.equal(cat.root.classList.contains("expanded"), false, "the panel closes");
  assert.equal(cat.sentOf("PDF_PAGE_ENHANCED").length, statusAsks, "no switch on that click");
  await click(cat);
  assert.equal(cat.noticeReason(), "unsupported");
  deliver({ type: "PDF_PAGE_LOOKUP", text: "factual" });
  assert.equal(cat.noticeReason(), null, "the lookup replaces the notice");
  assert.equal(cat.root.classList.contains("expanded"), true);
  await click(cat);
  await click(cat);
  assert.equal(cat.noticeReason(), "unsupported");
  deliver({ type: "PDF_PAGE_SUPPRESS" });
  assert.equal(cat.root.hidden, true);
  assert.equal(cat.noticeReason(), null, "no notice left behind in enhanced mode");
});
