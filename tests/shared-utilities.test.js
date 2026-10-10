/**
 * M2: helpers that used to be copied into several files now exist once. Each test pins the
 * shared helper to the behaviour of every copy it replaced:
 *
 *   zehEscapeHtml          config.js     ← escapeHtml in mk-lookup.js, reader.js, settings.js
 *   zehSubscribeEnabled    config.js     ← the Manekilex on/off subscription in content.js,
 *                                          pdf-page-assistant.js and reader.js
 *   zehIsPdfViewerUrl      config.js     ← isPdfViewerUrl (background.js) and the .pdf regex in
 *                                          content.js and pdf-page-assistant.js
 *   isSaveAllowedPersistReason  book-store.js ← SAVE_ALLOWED_REASONS in book-store.js and reader.js
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { baseGlobals, runFile, loadConfig, evalIn, createStorageArea, createEvent, sleep } = require("./helpers/extension-sandbox");
const { createFakeIndexedDB } = require("./helpers/fake-indexeddb");
const { loadReaderPage } = require("./helpers/reader-page");
const { loadSettingsPage } = require("./helpers/settings-page");
const { readSource } = require("./helpers/script-scan");
const { getContext, scriptsFor } = require("./helpers/load-order");

// ── escapeHtml ──────────────────────────────────────────────────────────────────────────────

/**
 * The old mk-lookup.js / reader.js copy: `div.textContent = s; return div.innerHTML`. A browser
 * serialises a text node by escaping exactly &, U+00A0, < and > (HTML spec, "escaping a string",
 * text mode).
 */
function oldTextNodeCopy(str) {
  if (str == null) return "";
  return String(str).replace(/&/g, "&amp;").replace(/\u00a0/g, "&nbsp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The old settings.js copy (after F4): the same, plus both quote characters. */
function oldSettingsCopy(str) {
  return oldTextNodeCopy(str == null ? "" : String(str)).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** What an HTML parser turns those entities back into (text content and quoted attribute values). */
function decodeEntities(html) {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

const ESCAPE_CORPUS = [
  "",
  "plain",
  `a"b'c<d>&e`,
  "<script>alert(1)</script>",
  "&amp; already escaped",
  "non\u00a0breaking",
  "don't \"quote\" me",
  "释义：意外发现珍奇事物的本领",
  "emoji 🐱 & <b>",
  "line\nbreak\ttab",
  42,
  0,
  false,
  { toString: () => "<obj>" },
];

test("M2 zehEscapeHtml: byte-identical to the settings.js copy for every input", () => {
  const ctx = loadConfig();
  for (const input of ESCAPE_CORPUS) {
    ctx.__input = input;
    assert.equal(evalIn(ctx, "zehEscapeHtml(__input)"), oldSettingsCopy(input), JSON.stringify(String(input)));
  }
  assert.equal(evalIn(ctx, "zehEscapeHtml(null)"), "");
  assert.equal(evalIn(ctx, "zehEscapeHtml(undefined)"), "");
});

test("M2 zehEscapeHtml: an HTML parser reads back exactly what the mk-lookup/reader copy produced", () => {
  // The only difference to the old text-node copy is that " and ' are escaped too. Every call
  // site in mk-lookup.js and reader.js puts the result into innerHTML (element text or a
  // double-quoted attribute), where &quot; / &#39; decode to the same characters.
  const ctx = loadConfig();
  for (const input of ESCAPE_CORPUS) {
    ctx.__input = input;
    const shared = evalIn(ctx, "zehEscapeHtml(__input)");
    assert.equal(decodeEntities(shared), decodeEntities(oldTextNodeCopy(input)), JSON.stringify(String(input)));
    assert.equal(decodeEntities(shared), input == null ? "" : String(input));
    assert.doesNotMatch(shared, /[<>"']/, "nothing left that could open a tag or close an attribute");
  }
});

test("M2 escapeHtml: settings.js keeps its global escapeHtml name as an alias of the shared helper", async () => {
  const onChanged = createEvent();
  const local = createStorageArea({}, { onChanged });
  const page = await loadSettingsPage({ local, onChanged, sendMessage: async () => ({}) });
  for (const input of ESCAPE_CORPUS) {
    page.context.__input = input;
    assert.equal(page.evalIn("escapeHtml(__input)"), page.evalIn("zehEscapeHtml(__input)"));
  }
});

test("M2 escapeHtml: no first-party file keeps a private copy", () => {
  const settingsParts = scriptsFor("settings").filter((f) => f.startsWith("settings/"));
  for (const file of ["mk-lookup.js", "reader.js", "settings.js", ...settingsParts, "config.js"]) {
    const src = readSource(file);
    const copies = src.match(/\.textContent\s*=\s*String\(str\)|innerHTML\.replace\(\/"\/g/g) || [];
    assert.equal(copies.length, 0, `${file} still escapes HTML through its own DOM node`);
  }
  assert.doesNotMatch(readSource("mk-lookup.js"), /function escapeHtml\b/);
  assert.doesNotMatch(readSource("reader.js"), /function escapeHtml\b/);
  assert.match(readSource("config.js"), /function zehEscapeHtml\b/);
});

// ── Manekilex on/off subscription ───────────────────────────────────────────────────────────

/** config.js with a chrome.storage.local whose get() can report chrome.runtime.lastError. */
function enabledEnv(initial) {
  const onChanged = createEvent();
  const local = createStorageArea(initial || {}, { onChanged });
  const runtime = { lastError: undefined };
  const realGet = local.get;
  local.failNextGet = false;
  local.get = (keys, cb) => {
    if (!local.failNextGet) return realGet(keys, cb);
    local.failNextGet = false;
    setTimeout(() => {
      runtime.lastError = { message: "Extension context invalidated." };
      try {
        cb(undefined);
      } finally {
        runtime.lastError = undefined;
      }
    }, 0);
    return undefined;
  };
  const context = vm.createContext({ ...baseGlobals(), chrome: { storage: { local, onChanged }, runtime } });
  runFile(context, "config.js");
  const seen = [];
  context.__record = (v) => seen.push(v);
  return { context, local, onChanged, seen };
}

test("M2 zehSubscribeEnabled: delivers the stored value first, defaulting to on", async () => {
  for (const [stored, expected] of [
    [{}, true],
    [{ zehManekilexEnabled: true }, true],
    [{ zehManekilexEnabled: false }, false],
    [{ zehManekilexEnabled: 0 }, true], // only an explicit false turns Manekilex off, as before
  ]) {
    const env = enabledEnv(stored);
    evalIn(env.context, "zehSubscribeEnabled(__record)");
    await sleep(5);
    assert.deepEqual(env.seen, [expected], JSON.stringify(stored));
  }
});

test("M2 zehSubscribeEnabled: follows changes of the local key and ignores everything else", async () => {
  const env = enabledEnv({ zehManekilexEnabled: true });
  evalIn(env.context, "zehSubscribeEnabled(__record)");
  await sleep(5);
  await env.local.set({ zehManekilexEnabled: false });
  await env.local.set({ someOtherKey: 1 });
  env.onChanged.listeners.forEach((fn) => fn({ zehManekilexEnabled: { newValue: false } }, "sync"));
  await env.local.remove("zehManekilexEnabled"); // removed key → back to the default (on)
  await sleep(5);
  assert.deepEqual(env.seen, [true, false, true]);
});

test("M2 zehSubscribeEnabled: a failed initial read applies nothing; reload() reads again", async () => {
  const env = enabledEnv({ zehManekilexEnabled: false });
  env.local.failNextGet = true;
  const sub = evalIn(env.context, "zehSubscribeEnabled(__record)");
  await sleep(5);
  assert.deepEqual(env.seen, [], "nothing applied while chrome.runtime.lastError is set");
  sub.reload();
  await sleep(5);
  assert.deepEqual(env.seen, [false]);
});

test("M2 zehSubscribeEnabled: content.js, pdf-page-assistant.js and reader.js all use it", () => {
  for (const file of ["content.js", "pdf-page-assistant.js", "reader.js"]) {
    const src = readSource(file);
    assert.match(src, /zehSubscribeEnabled\(/, file);
    assert.doesNotMatch(src, /changes\[\s*(MK_ENABLED_KEY|key)\s*\]/, `${file} still has its own onChanged handler`);
  }
});

test("M2 zehSubscribeEnabled: the reader page follows the popup switch", async () => {
  const page = await loadReaderPage({ sections: 2, book: { id: "b1" }, storage: { zehManekilexEnabled: false } });
  await sleep(20);
  assert.equal(page.context.MKLookup.isGlobalEnabled(), false, "stored off → lookups off");
  await page.local.set({ zehManekilexEnabled: true });
  await sleep(20);
  assert.equal(page.context.MKLookup.isGlobalEnabled(), true, "switched on → lookups on");
});

// ── PDF URL detection ───────────────────────────────────────────────────────────────────────

const OLD_PDF_REGEX = /\.pdf($|[?#])/i;
const OLD_CHROME_PDF_VIEWER_PREFIX = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/";

/** background.js isPdfViewerUrl before M2. */
function oldBackgroundIsPdfViewerUrl(url) {
  if (!url) return false;
  if (url.startsWith(OLD_CHROME_PDF_VIEWER_PREFIX)) return true;
  return OLD_PDF_REGEX.test(url);
}

const PDF_URLS = [
  "https://example.test/paper.pdf",
  "https://example.test/paper.PDF",
  "https://example.test/paper.pdf?download=1",
  "https://example.test/paper.pdf#page=3",
  "https://example.test/paper.pdfx",
  "https://example.test/pdf/viewer",
  "https://example.test/paper.pdf/notes",
  `${OLD_CHROME_PDF_VIEWER_PREFIX}index.html?https://example.test/a.pdf`,
  "chrome-extension://other/index.html",
  "file:///C:/books/novel.pdf",
  "",
];

/** pathname + search, as content.js and pdf-page-assistant.js test it. */
const PDF_PATHS = ["/paper.pdf", "/paper.PdF?x=1", "/paper.pdf#p", "/paper.pdfs", "/pdf", "/a/b.pdf?", "", "/"];

test("M2 zehIsPdfViewerUrl: same answers as background.js isPdfViewerUrl for full URLs", () => {
  const ctx = loadConfig();
  for (const url of [...PDF_URLS, null, undefined]) {
    ctx.__url = url;
    assert.equal(evalIn(ctx, "zehIsPdfViewerUrl(__url)"), oldBackgroundIsPdfViewerUrl(url), String(url));
  }
});

test("M2 zehIsPdfViewerUrl: same answers as the content-script .pdf regex for pathname + search", () => {
  const ctx = loadConfig();
  for (const p of PDF_PATHS) {
    ctx.__url = p;
    assert.equal(evalIn(ctx, "zehIsPdfViewerUrl(__url)"), OLD_PDF_REGEX.test(p), p);
  }
});

test("M2 zehIsPdfViewerUrl: the service worker keeps isPdfViewerUrl as an alias; no copy of the regex remains", () => {
  // M4 moved the alias from background.js into a sw/ module; check every worker file.
  const workerFiles = getContext("service-worker").scripts.filter((f) => f !== "config.js");
  for (const file of ["content.js", "pdf-page-assistant.js", ...workerFiles]) {
    assert.doesNotMatch(readSource(file), /\\\.pdf\(\$\|\[\?#\]\)/, `${file} still has its own .pdf regex`);
  }
  const alias = /function isPdfViewerUrl\(url\)\s*\{\s*return zehIsPdfViewerUrl\(url\);/;
  assert.equal(workerFiles.filter((f) => alias.test(readSource(f))).length, 1, "exactly one worker file defines the alias");
});

// ── reader persist reasons ──────────────────────────────────────────────────────────────────

function loadBookStore() {
  const { indexedDB, IDBKeyRange } = createFakeIndexedDB();
  const context = vm.createContext({ ...baseGlobals(), indexedDB, IDBKeyRange, location: { search: "" } });
  context.window = context;
  runFile(context, "book-store.js");
  return context.ZEHBookStore;
}

test("M2 save reasons: one list, shared by book-store.js and reader.js", async () => {
  const store = loadBookStore();
  assert.deepEqual([...store.SAVE_ALLOWED_REASONS], ["scroll-debounce", "back-to-shelf", "toc-jump", "bookmark-jump"]);
  assert.ok(Object.isFrozen(store.SAVE_ALLOWED_REASONS));
  for (const r of store.SAVE_ALLOWED_REASONS) assert.equal(store.isSaveAllowedPersistReason(r), true, r);
  for (const r of ["", undefined, "resize", "relocated", "open-book", "SCROLL-DEBOUNCE"]) {
    assert.equal(store.isSaveAllowedPersistReason(r), false, String(r));
  }
  await store.addBook({ id: "b1", title: "A", fileBlob: { size: 1 } });
  const rejected = await store.updateBookProgress("b1", { progress: 0.5, persistReason: "resize" });
  assert.equal(rejected.reason, "disallowed-persist-reason");

  for (const file of ["book-store.js", "reader.js"]) {
    const defs = readSource(file).match(/new Set\(\["scroll-debounce"/g) || [];
    assert.ok(defs.length <= (file === "book-store.js" ? 1 : 0), `${file} defines the reason list ${defs.length} times`);
  }
  assert.match(readSource("reader.js"), /ZEHBookStore\.isSaveAllowedPersistReason\(/);
});
