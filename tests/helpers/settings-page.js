/**
 * Load the Settings page into a sandbox with a permissive fake DOM:
 * document.getElementById() creates the element on first use, so the page's top-level
 * wiring runs. By default every <script> of settings.html runs, in the page's own order
 * (vendored libraries, importers, live-transcribe.js, settings.js); `only` narrows that to a
 * subsequence of the real list for a focused test.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { FakeDocument, FakeEventTarget, FakeElement, FakeNode } = require("./fake-dom");
const { baseGlobals, runFile, withFallback, waitFor } = require("./extension-sandbox");
const { createFakeIndexedDB } = require("./fake-indexeddb");
const { ROOT, loadContextScripts } = require("./load-order");

const EXTENSION_ORIGIN = "chrome-extension://test-extension/";

/**
 * fetch() for packaged extension files only (daily-lines.js reads poem/quotes.json).
 * Anything else rejects: a settings test must never reach the network.
 */
function packagedFileFetch(fetched) {
  return async (input) => {
    const url = String(input && input.url ? input.url : input);
    fetched.push(url);
    if (!url.startsWith(EXTENSION_ORIGIN)) throw new TypeError(`test sandbox: network fetch blocked (${url})`);
    const rel = path.posix.normalize(decodeURIComponent(url.slice(EXTENSION_ORIGIN.length).split(/[?#]/)[0]));
    const file = path.join(ROOT, rel);
    if (rel.startsWith("..") || !fs.existsSync(file)) {
      return { ok: false, status: 404, json: async () => null, text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
    }
    const body = fs.readFileSync(file);
    return {
      ok: true,
      status: 200,
      json: async () => JSON.parse(body.toString("utf8")),
      text: async () => body.toString("utf8"),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
}

/**
 * @param {{
 *   local: object,            chrome.storage.local (share it with loadBackground)
 *   onChanged: object,        chrome.storage.onChanged event
 *   sendMessage: Function,    chrome.runtime.sendMessage (e.g. background.dispatch)
 *   hash?: string,
 *   only?: string[],          subsequence of settings.html's script list (default: all of it)
 *   beforeEach?: Function,    (file, vmContext) hook before each script
 *   afterEach?: Function,     (file, vmContext) hook after each script
 * }} options
 */
async function loadSettingsPage(options) {
  const opts = options || {};
  const document = new FakeDocument();
  const byId = new Map();
  document.getElementById = (id) => {
    if (!byId.has(id)) {
      const el = document.createElement("div");
      el.id = id;
      byId.set(id, el);
    }
    return byId.get(id);
  };

  const pageSets = [];
  const local = {
    get: (...args) => opts.local.get(...args),
    set: (items, cb) => {
      pageSets.push(Object.keys(items));
      return opts.local.set(items, cb);
    },
    remove: (...args) => opts.local.remove(...args),
  };
  const alerts = [];
  const events = new FakeEventTarget();
  const chrome = withFallback({
    runtime: withFallback({
      id: "test-extension",
      lastError: undefined,
      getManifest: () => ({ version: "0.0.0-test" }),
      getURL: (p) => `chrome-extension://test-extension/${p}`,
      sendMessage: (message) => opts.sendMessage(message),
    }),
    storage: withFallback({ local, onChanged: opts.onChanged }),
  });

  const fetched = [];
  const { indexedDB, IDBKeyRange } = createFakeIndexedDB();
  const context = vm.createContext({
    ...baseGlobals(),
    fetch: packagedFileFetch(fetched),
    indexedDB,
    IDBKeyRange,
    setInterval: () => 0, // the header clock would keep the test process alive
    clearInterval: () => {},
    document,
    chrome,
    location: { hash: opts.hash || "#vocabulary", href: "chrome-extension://test-extension/settings.html" },
    history: { replaceState() {} },
    sessionStorage: { getItem: () => null, setItem() {} },
    navigator: { clipboard: { writeText: async () => {} }, userAgent: "node-test" },
    alert: (msg) => alerts.push(String(msg)),
    confirm: () => true,
    Element: FakeElement,
    Node: FakeNode,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
  });
  context.window = context;
  context.self = context;
  const loaded = loadContextScripts(context, "settings", runFile, {
    only: opts.only,
    beforeEach: opts.beforeEach,
    afterEach: opts.afterEach,
  });

  const evalIn = (code) => vm.runInContext(code, context);
  await waitFor(() => evalIn("currentSection") === (opts.hash || "#vocabulary").slice(1), 2000, "settings section");

  return {
    context,
    document,
    alerts,
    pageSets,
    loaded,
    fetched,
    /** Evaluate code inside the page (reaches top-level let / const bindings of settings.js). */
    evalIn,
    /** The page's in-memory vocabulary array. */
    vocabulary: () => evalIn("vocabulary"),
    listHtml: () => document.getElementById("vocabList").innerHTML,
    /** Click the 删除 button of entry `id` (event delegation on #vocabList). */
    async clickDelete(id) {
      const list = document.getElementById("vocabList");
      const target = { closest: (sel) => (sel === ".vocab-del" ? { dataset: { id } } : null) };
      const handlers = list._listeners.click || [];
      await Promise.all(handlers.map((fn) => fn({ target })));
    },
    setSearch(query) {
      evalIn(`vocabState.searchQuery = ${JSON.stringify(query)}`);
    },
    /** Stop reacting to storage changes, i.e. a page that missed every update. */
    detachStorageListener() {
      opts.onChanged.removeListener(evalIn("handleVocabularyStorageChange"));
    },
  };
}

module.exports = { loadSettingsPage };
