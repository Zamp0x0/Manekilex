/**
 * The old PDF cat (pdf-page-assistant.js) next to the enhanced PDF reader.
 *
 *   - the reader tells the worker which tab it took over (PDF_READER_STATE, extension pages only);
 *     the old top-right cat in that tab stays hidden and ignores lookups, and comes back when the
 *     reader hands the PDF to Chrome's own viewer;
 *   - right-click "Manekilex 查词" inside the reader goes to the reader's own lookup controller
 *     (PDF_READER_LOOKUP), with the side panel as the fallback; in Chrome's own viewer it still goes
 *     to the old cat panel; on other pages it does nothing, as before;
 *   - lookups from the reader get their results by runtime broadcast (claimed by queryId), so they
 *     arrive whether the reader runs as a tab or as the PDF tab's MIME handler page.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackground, extensionPageSender, contentScriptSender, evalIn, sleep } = require("./helpers/extension-sandbox");
const { createPageEnv, disposeLookupControllers, LOOKUP_CORE } = require("./helpers/fake-dom");
const { loadPdfReaderPage } = require("./helpers/pdf-reader-page");

test.afterEach(() => disposeLookupControllers());

/** Values built inside the vm sandbox have another realm's prototypes; compare as plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const READER = "chrome-extension://test-extension/pdf-reader.html";
const PDF_URL = "https://papers.example.test/rag.pdf";
const readerSender = (tabId) => ({ id: "test-extension", url: READER, ...(tabId ? { tab: { id: tabId, url: PDF_URL } } : {}) });
const pdfTab = (id) => ({ id, url: PDF_URL });

async function clickMenu(bg, info, tab) {
  const [listener] = bg.chrome.contextMenus.onClicked.listeners;
  listener({ menuItemId: "mk-lookup-selection", ...info }, tab);
  await sleep(20);
}

test("worker: only the reader page can report a take-over; the old cat in that tab is hidden and restored", async () => {
  const bg = loadBackground({ storage: { zehManekilexEnabled: true } });
  assert.deepEqual(await bg.dispatch({ type: "PDF_READER_STATE", active: true, tabId: 7 }, extensionPageSender("settings.html")), { ok: false });
  const forbidden = await bg.dispatch({ type: "PDF_READER_STATE", active: true, tabId: 7 }, contentScriptSender(PDF_URL, 7));
  assert.equal(forbidden.code, "FORBIDDEN_SENDER");
  assert.deepEqual(await bg.dispatch({ type: "PDF_READER_STATE", active: true, tabId: "7" }, readerSender()), { ok: false });
  assert.equal(evalIn(bg.context, "pdfReaderTabIds.size"), 0);

  assert.deepEqual(await bg.dispatch({ type: "PDF_READER_STATE", active: true, tabId: 7 }, readerSender(7)), { ok: true });
  assert.equal(evalIn(bg.context, "pdfReaderTabIds.has(7)"), true);
  assert.deepEqual(plain(bg.tabMessages.at(-1)), { tabId: 7, message: { type: "PDF_PAGE_SUPPRESS" } });

  // the old cat asks when it loads: hidden in the taken-over tab, shown elsewhere
  assert.deepEqual(await bg.dispatch({ type: "PDF_PAGE_ASSISTANT_READY" }, contentScriptSender(PDF_URL, 7)), { ok: true, suppressed: true });
  assert.equal(evalIn(bg.context, "pdfOverlayTabIds.has(7)"), false);
  assert.deepEqual(await bg.dispatch({ type: "PDF_PAGE_ASSISTANT_READY" }, contentScriptSender(PDF_URL, 8)), { ok: true });
  assert.equal(evalIn(bg.context, "pdfOverlayTabIds.has(8)"), true);

  // back to Chrome's viewer: restored once, and closing the tab forgets it
  assert.deepEqual(await bg.dispatch({ type: "PDF_READER_STATE", active: false, tabId: 7 }, readerSender(7)), { ok: true });
  assert.deepEqual(plain(bg.tabMessages.at(-1)), { tabId: 7, message: { type: "PDF_PAGE_RESTORE" } });
  const count = bg.tabMessages.length;
  await bg.dispatch({ type: "PDF_READER_STATE", active: false, tabId: 7 }, readerSender(7));
  assert.equal(bg.tabMessages.length, count, "no second restore");
  await bg.dispatch({ type: "PDF_READER_STATE", active: true, tabId: 9 }, readerSender(9));
  bg.chrome.tabs.onRemoved.listeners.forEach((fn) => fn(9));
  assert.equal(evalIn(bg.context, "pdfReaderTabIds.has(9)"), false);
});

test("worker: right-click lookup goes to the reader when the reader shows the PDF, to the old cat otherwise", async () => {
  const answered = [];
  const bg = loadBackground({
    storage: { zehManekilexEnabled: true },
    runtimeReply: (message) => {
      if (message.type !== "PDF_READER_LOOKUP") return undefined;
      answered.push(message);
      return { ok: true };
    },
  });
  await bg.dispatch({ type: "PDF_READER_STATE", active: true, tabId: 7 }, readerSender(7));

  // taken-over PDF tab: to the reader, never to the old cat
  bg.tabMessages.length = 0;
  await clickMenu(bg, { selectionText: "  factual ", frameUrl: READER }, pdfTab(7));
  assert.deepEqual(plain(answered.at(-1)), { type: "PDF_READER_LOOKUP", tabId: 7, text: "factual" });
  assert.equal(bg.tabMessages.filter((m) => m.message.type === "PDF_PAGE_LOOKUP").length, 0);

  // the reader in its own tab (local file)
  await clickMenu(bg, { selectionText: "vector", pageUrl: READER }, { id: 12, url: READER });
  assert.deepEqual(plain(answered.at(-1)), { type: "PDF_READER_LOOKUP", tabId: 12, text: "vector" });

  // Chrome's own viewer: the old cat panel, as before
  await clickMenu(bg, { selectionText: "baselines" }, pdfTab(8));
  assert.deepEqual(plain(bg.tabMessages.at(-1)), { tabId: 8, message: { type: "PDF_PAGE_LOOKUP", text: "baselines" } });

  // an ordinary page: nothing happens
  const before = bg.tabMessages.length + bg.runtimeMessages.length;
  await clickMenu(bg, { selectionText: "word" }, { id: 3, url: "https://news.example.test/story" });
  assert.equal(bg.tabMessages.length + bg.runtimeMessages.length, before);
});

test("worker: with no reader answering, right-click falls back to the side panel", async () => {
  const bg = loadBackground({ storage: { zehManekilexEnabled: true } });
  const opened = [];
  bg.chrome.sidePanel = { setOptions: async (o) => opened.push(o), open: async () => {} };
  bg.chrome.tabs.query = async () => [{ id: 12 }];
  await clickMenu(bg, { selectionText: "vector", pageUrl: READER }, { id: 12, url: READER });
  assert.equal(bg.runtimeMessages.at(-1).type, "PDF_READER_LOOKUP");
  assert.equal(opened.length, 1);
  assert.match(opened[0].path, /lookup-panel\.html\?text=vector$/);
});

test("worker: results of a lookup from the reader are broadcast, not sent to the PDF tab", async () => {
  const bg = loadBackground({
    storage: { zehManekilexEnabled: true },
    dictionary: { factual: { term: "factual", short_meaning: "事实的", meaning_here: "事实的" } },
  });
  const reply = await bg.dispatch({ type: "EXPLAIN", text: "factual", queryId: "q_reader" }, readerSender(7));
  assert.equal(reply.accepted, true);
  for (let i = 0; i < 100 && !bg.runtimeMessages.some((m) => m.queryId === "q_reader"); i++) await sleep(10);
  assert.ok(bg.runtimeMessages.some((m) => m.queryId === "q_reader"), "result broadcast to extension pages");
  assert.equal(bg.tabMessages.filter((m) => m.message.queryId === "q_reader").length, 0);

  // a web page still gets its results in its own tab
  await bg.dispatch({ type: "EXPLAIN", text: "factual", queryId: "q_web" }, contentScriptSender("https://news.example.test/a", 4));
  for (let i = 0; i < 100 && !bg.tabMessages.some((m) => m.message.queryId === "q_web"); i++) await sleep(10);
  assert.ok(bg.tabMessages.some((m) => m.tabId === 4 && m.message.queryId === "q_web"));
});

// ── the old cat (content script on a PDF page) ───────────────────────────────

/** The assistant's root element (the fake page document has no id index) */
function assistantRoot(env) {
  const all = [env.document.body, env.document.documentElement].flatMap((el) => (el ? [...el.children] : []));
  return all.find((el) => el.id === "zeh-pdf-assistant") || null;
}

function loadPdfPageAssistant() {
  return createPageEnv({
    only: [...LOOKUP_CORE, "pdf-page-assistant.js"],
    location: { href: PDF_URL, hostname: "papers.example.test", pathname: "/rag.pdf", search: "" },
    globals: { MutationObserver: class { observe() {} disconnect() {} } },
  });
}

test("old cat: hidden until the worker answers; stays hidden and ignores lookups while the reader shows the PDF", async () => {
  const env = loadPdfPageAssistant();
  const root = assistantRoot(env);
  assert.ok(root, "assistant mounted");
  assert.equal(root.hidden, true, "hidden while waiting");
  const ready = env.sent.find((s) => s.message.type === "PDF_PAGE_ASSISTANT_READY");
  ready.cb({ ok: true, suppressed: true });
  await sleep(5);
  assert.equal(root.hidden, true);

  // every runtime listener of the page (the lookup controller's and the assistant's), like Chrome
  const listener = (message) => env.runtime.onMessage.listeners.forEach((fn) => fn(message, { id: "test-extension" }, () => {}));
  listener({ type: "PDF_PAGE_LOOKUP", text: "factual" });
  listener({ type: "SHOW_ERROR", message: "x" });
  assert.equal(root.classList.contains("expanded"), false, "no panel while suppressed");
  assert.equal(env.sent.filter((s) => s.message.type === "EXPLAIN").length, 0);

  // handed back to Chrome's viewer: the cat and right-click lookup work again
  listener({ type: "PDF_PAGE_RESTORE" });
  assert.equal(root.hidden, false);
  listener({ type: "PDF_PAGE_LOOKUP", text: "factual" });
  assert.equal(root.classList.contains("expanded"), true);
  listener({ type: "PDF_PAGE_SUPPRESS" });
  assert.equal(root.hidden, true);
  assert.equal(root.classList.contains("expanded"), false);
});

test("old cat: shown in Chrome's own viewer (worker says not taken over, or cannot answer)", async () => {
  const env = loadPdfPageAssistant();
  const root = assistantRoot(env);
  env.sent.find((s) => s.message.type === "PDF_PAGE_ASSISTANT_READY").cb({ ok: true });
  await sleep(5);
  assert.equal(root.hidden, false);
  disposeLookupControllers();
  const env2 = loadPdfPageAssistant();
  env2.sent.find((s) => s.message.type === "PDF_PAGE_ASSISTANT_READY").cb(undefined);
  await sleep(5);
  assert.equal(assistantRoot(env2).hidden, false);
});

// ── the reader page side ─────────────────────────────────────────────────────

function streamHandler(tabId) {
  const bytes = new Uint8Array(Buffer.from("%PDF-1.7\n%stub\n"));
  return {
    getStreamInfo: async () => ({ streamUrl: "blob:stream-1", originalUrl: PDF_URL, mimeType: "application/pdf", tabId, embedded: false, responseHeaders: {} }),
    abortAndFallbackToNativeHandler: async () => {},
    bytes,
  };
}

test("reader: announces the take-over with the stream's tab, answers right-click lookups for that tab only, releases on fallback", async () => {
  const mime = streamHandler(7);
  const env = loadPdfReaderPage({
    mimeHandler: mime,
    fetch: async () => new Response(mime.bytes, { headers: { "content-type": "application/pdf" } }),
  });
  await env.app.ready;
  const states = () => env.sent.map((s) => s.message).filter((m) => m.type === "PDF_READER_STATE");
  assert.deepEqual(plain(states()), [{ type: "PDF_READER_STATE", active: true, tabId: 7 }]);

  const looked = [];
  env.app.lookup.lookup.lookupText = (text) => (looked.push(text), true);
  const [listener] = env.runtime.onMessage.listeners.filter((fn) => fn.name === "onRuntimeMessage");
  let answer = null;
  listener({ type: "PDF_READER_LOOKUP", tabId: 8, text: "other" }, { id: "test-extension" }, (r) => (answer = r));
  assert.equal(answer, null, "another tab's lookup is not claimed");
  listener({ type: "PDF_READER_LOOKUP", tabId: 7, text: "factual" }, { id: "test-extension" }, (r) => (answer = r));
  assert.deepEqual(plain(answer), { ok: true });
  assert.deepEqual(looked, ["factual"]);

  await env.app.fallBackToNative();
  assert.deepEqual(plain(states().at(-1)), { type: "PDF_READER_STATE", active: false, tabId: 7 });
  env.app.destroy();
  assert.equal(states().length, 2, "released once");
  assert.equal(env.runtime.onMessage.listeners.filter((fn) => fn.name === "onRuntimeMessage").length, 0);
});

test("reader: a manually opened reader never reports a take-over", async () => {
  const env = loadPdfReaderPage();
  await env.app.ready;
  env.app.destroy();
  assert.equal(env.sent.filter((s) => s.message.type === "PDF_READER_STATE").length, 0);
});
