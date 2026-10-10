/**
 * Minimal sandboxes for running extension scripts under `node --test`.
 *
 * The extension has no build step: config.js, background.js and mk-lookup.js are
 * classic scripts that rely on browser / chrome globals. These helpers load the
 * real files into a `vm` context with small fakes, so tests exercise the shipped
 * code rather than copies of it.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ROOT, getContext, CONTEXT_NAMES } = require("./load-order");

function quietConsole() {
  if (process.env.MK_TEST_DEBUG) return console;
  const noop = () => {};
  return { log: noop, debug: noop, info: noop, warn: noop, error: noop };
}

function runFile(context, relPath) {
  const file = path.join(ROOT, relPath);
  vm.runInContext(fs.readFileSync(file, "utf8"), context, { filename: file });
}

function baseGlobals() {
  return {
    console: quietConsole(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    AbortController,
    AbortSignal,
    DOMException,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    structuredClone,
  };
}

/**
 * config.js followed by the shared/ and lookup/ files split out of it in M5, in the order the
 * contexts load them: every pure helper that used to live in config.js, in one realm. A focused
 * test realm, not a real execution context (no context loads all of them).
 */
function configParts() {
  const parts = ["config.js"];
  for (const name of CONTEXT_NAMES) {
    for (const file of getContext(name).scripts) {
      if (/^(shared|lookup)\//.test(file) && !parts.includes(file)) parts.push(file);
    }
  }
  return parts;
}

/** Load configParts() (pure helpers; a focused subset, not a real execution context). */
function loadConfig() {
  const context = vm.createContext(baseGlobals());
  configParts().forEach((file) => runFile(context, file));
  return context;
}

/** Evaluate an expression inside a sandbox (reaches top-level const bindings). */
function evalIn(context, code) {
  return vm.runInContext(code, context);
}

/** Permissive stub: any property is itself, any call resolves to undefined. */
const anyApi = new Proxy(function () {}, {
  get(_target, prop) {
    if (prop === "then") return undefined;
    return anyApi;
  },
  apply() {
    return Promise.resolve(undefined);
  },
});

function withFallback(obj) {
  return new Proxy(obj, {
    get(target, prop) {
      if (prop in target) return target[prop];
      return anyApi;
    },
  });
}

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => listeners.push(fn),
    removeListener: (fn) => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
  };
}

/**
 * In-memory chrome.storage area.
 * @param {object} [initial]
 * @param {{ onChanged?: ReturnType<typeof createEvent>, areaName?: string }} [options]
 *   onChanged: fired asynchronously after set/remove, like Chrome does.
 * Set `area.failSetWith = new Error(...)` to make the next set() calls reject (quota, …).
 */
function createStorageArea(initial, options) {
  const opts = options || {};
  const data = { ...(initial || {}) };
  function read(keys) {
    if (keys == null) return { ...data };
    if (typeof keys === "string") return keys in data ? { [keys]: data[keys] } : {};
    if (Array.isArray(keys)) {
      const out = {};
      keys.forEach((k) => {
        if (k in data) out[k] = data[k];
      });
      return out;
    }
    const out = {};
    Object.entries(keys).forEach(([k, def]) => {
      out[k] = k in data ? data[k] : def;
    });
    return out;
  }
  const settle = (value, cb) => {
    if (typeof cb === "function") {
      setTimeout(() => cb(value), 0);
      return undefined;
    }
    return Promise.resolve(value);
  };
  const notify = (changes) => {
    if (!opts.onChanged || !Object.keys(changes).length) return;
    setTimeout(() => {
      opts.onChanged.listeners.forEach((fn) => fn(changes, opts.areaName || "local"));
    }, 0);
  };
  const area = {
    data,
    failSetWith: null,
    setCalls: [],
    get: (keys, cb) => settle(structuredClone(read(keys)), cb),
    set: (obj, cb) => {
      area.setCalls.push(Object.keys(obj));
      if (area.failSetWith) return Promise.reject(area.failSetWith);
      const changes = {};
      Object.entries(structuredClone(obj)).forEach(([k, v]) => {
        changes[k] = { oldValue: data[k], newValue: v };
        data[k] = v;
      });
      notify(structuredClone(changes));
      return settle(undefined, cb);
    },
    remove: (keys, cb) => {
      const changes = {};
      [].concat(keys).forEach((k) => {
        if (k in data) changes[k] = { oldValue: data[k] };
        delete data[k];
      });
      notify(changes);
      return settle(undefined, cb);
    },
    clear: (cb) => {
      Object.keys(data).forEach((k) => delete data[k]);
      return settle(undefined, cb);
    },
  };
  return area;
}

/**
 * Load the service worker with a fake chrome API and a fake fetch.
 * The entry file comes from manifest.json (background.service_worker); its own top-level
 * importScripts(...) call loads the rest, so the sandbox follows the real declaration.
 * importScripts() is only allowed during that first synchronous evaluation, like in Chrome.
 * The worker global has no window / document / DOM constructors.
 * @param {{
 *   storage?: object,
 *   local?: ReturnType<typeof createStorageArea>,  share one storage area with a page sandbox
 *   onChanged?: ReturnType<typeof createEvent>,
 *   fetch?: Function,
 *   dictionary?: object | ((attempt: number) => object),  dictionary_core.json body, or a
 *     function returning a fetch Response per attempt (default: 404)
 *   mimeHandler?: object | null,  chrome.mimeHandler (Chrome 151+); null for an older Chrome
 * }} options
 */
function loadBackground(options) {
  const opts = options || {};
  const onMessage = createEvent();
  const onChanged = opts.onChanged || createEvent();
  const tabMessages = [];
  const runtimeMessages = [];
  const local = opts.local || createStorageArea(opts.storage, { onChanged });
  const session = createStorageArea();

  const chrome = withFallback({
    runtime: withFallback({
      id: "test-extension",
      lastError: undefined,
      onMessage,
      onInstalled: createEvent(),
      onStartup: createEvent(),
      getURL: (p) => `chrome-extension://test-extension/${p}`,
      getManifest: () => ({ version: "0.0.0-test" }),
      sendMessage: (message) => {
        runtimeMessages.push(message);
        // opts.runtimeReply(message): what an extension page answers (default: nobody answers)
        return Promise.resolve(opts.runtimeReply ? opts.runtimeReply(message) : undefined);
      },
    }),
    contextMenus: withFallback({ onClicked: createEvent() }),
    // opts.mimeHandler: chrome.mimeHandler of Chrome 151+ (null / {} = an older Chrome without it)
    ...("mimeHandler" in opts ? { mimeHandler: opts.mimeHandler } : {}),
    storage: withFallback({
      local,
      session,
      onChanged,
    }),
    tabs: withFallback({
      sendMessage: (tabId, message, frame) => {
        // frame: { documentId } / { frameId } when the worker targets one document (M3b)
        tabMessages.push(frame ? { tabId, message, frame } : { tabId, message });
        return Promise.resolve(undefined);
      },
      query: () => Promise.resolve([]),
      onUpdated: createEvent(),
      onActivated: createEvent(),
      onRemoved: createEvent(),
    }),
  });

  const fetchCalls = [];
  const dictionaryFetches = [];
  const fetchImpl = (url, init) => {
    const href = String(url);
    if (href.includes("dictionary_core.json")) {
      dictionaryFetches.push(href);
      if (typeof opts.dictionary === "function") {
        return Promise.resolve(opts.dictionary(dictionaryFetches.length));
      }
      if (opts.dictionary) return Promise.resolve(jsonResponse(200, opts.dictionary));
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    }
    fetchCalls.push({ url: href, init });
    if (!opts.fetch) return Promise.reject(new Error(`unexpected fetch ${href}`));
    return opts.fetch(href, init, fetchCalls.length);
  };

  const context = vm.createContext({
    ...baseGlobals(),
    chrome,
    fetch: fetchImpl,
  });
  context.self = context;
  context.globalThis = context;
  const { entry } = getContext("service-worker");
  /** Globals the sandbox itself provides, before any product script runs. */
  const sandboxGlobals = Object.getOwnPropertyNames(context);
  const importedScripts = [];
  let evaluating = true;
  context.importScripts = (...files) => {
    if (!evaluating) throw new Error("importScripts() called after the worker's initial evaluation");
    files.forEach((f) => {
      importedScripts.push(f);
      runFile(context, f);
    });
  };
  try {
    runFile(context, entry);
  } finally {
    evaluating = false;
  }

  /**
   * Dispatch a runtime message the way Chrome would; resolves with the sendResponse payload,
   * JSON-serialised like a real extension message.
   */
  function dispatch(message, sender) {
    // Default sender: one of the extension's own pages (Settings). Content-script tests pass
    // their own sender (a tab with a web URL), like Chrome does.
    const effectiveSender = sender || extensionPageSender("settings.html");
    return new Promise((resolve) => {
      let responded = false;
      const sendResponse = (payload) => {
        if (responded) throw new Error("sendResponse called twice");
        responded = true;
        resolve(payload === undefined ? undefined : JSON.parse(JSON.stringify(payload)));
      };
      const keepsChannelOpen = onMessage.listeners
        .map((fn) => fn(message, effectiveSender, sendResponse))
        .some((ret) => ret === true);
      // Like Chrome: no listener kept the channel open and none answered → the caller gets undefined
      if (!keepsChannelOpen && !responded) {
        responded = true;
        resolve(undefined);
      }
    });
  }

  return {
    context,
    chrome,
    entry,
    importedScripts,
    sandboxGlobals,
    local,
    onChanged,
    tabMessages,
    runtimeMessages,
    fetchCalls,
    dictionaryFetches,
    dispatch,
  };
}

/** Poll until predicate() is truthy (default 2 s). */
async function waitFor(predicate, timeoutMs = 2000, label = "condition") {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** fetch() that never resolves until its AbortSignal fires (a hung provider). */
function hangingFetch(_url, init) {
  return new Promise((_resolve, reject) => {
    const signal = init && init.signal;
    if (!signal) return; // would hang forever: the bug this guards against
    signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function openAIChatResponse(content) {
  return jsonResponse(200, {
    choices: [{ message: { content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

/** chrome.runtime.MessageSender for one of the extension's own pages (settings / popup / reader). */
function extensionPageSender(page) {
  return { id: "test-extension", url: `chrome-extension://test-extension/${page || "settings.html"}` };
}

/** chrome.runtime.MessageSender for a content script injected into a web page. */
function contentScriptSender(pageUrl, tabId) {
  const url = pageUrl || "https://example.test/article";
  return { id: "test-extension", url, tab: { id: tabId || 1, url }, frameId: 0 };
}

module.exports = {
  ROOT,
  extensionPageSender,
  contentScriptSender,
  configParts,
  loadConfig,
  loadBackground,
  evalIn,
  runFile,
  baseGlobals,
  createEvent,
  createStorageArea,
  withFallback,
  anyApi,
  waitFor,
  sleep,
  hangingFetch,
  jsonResponse,
  openAIChatResponse,
};
