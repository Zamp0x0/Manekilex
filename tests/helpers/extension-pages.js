/**
 * Sandboxes for the two small extension pages: the toolbar popup and the lookup side panel.
 *
 * Both pages wire themselves up at load by looking up elements by id, so the fake document is
 * built from the page's real HTML: every element with an id attribute exists (with its tag,
 * class, type, hidden and checked state) and getElementById() returns null for anything else,
 * exactly like the browser. A script that dereferences an id the page no longer has fails here
 * the same way it fails in Chrome. Layout, CSS and real events are not modelled.
 */
const fs = require("node:fs");
const path = require("node:path");
const { FakeDocument, createPageEnv } = require("./fake-dom");
const { ROOT, getContext } = require("./load-order");

/** Start tags carrying an id attribute, in document order (HTML comments ignored). */
function elementsWithId(html) {
  const visible = html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));
  const out = [];
  const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(visible))) {
    const attrs = {};
    const attrRe = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a;
    while ((a = attrRe.exec(m[2]))) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    if (attrs.id) out.push({ tag: m[1].toLowerCase(), attrs });
  }
  return out;
}

/** A FakeDocument holding the id'd elements of `page` (e.g. "popup.html"). */
function pageDocument(page) {
  const document = new FakeDocument();
  const byId = new Map();
  for (const { tag, attrs } of elementsWithId(fs.readFileSync(path.join(ROOT, page), "utf8"))) {
    if (byId.has(attrs.id)) throw new Error(`${page}: duplicate id "${attrs.id}"`);
    const el = document.createElement(tag);
    el.id = attrs.id;
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    if (attrs.class) el.className = attrs.class;
    if (attrs.type) el.type = attrs.type;
    el.hidden = "hidden" in attrs;
    el.disabled = "disabled" in attrs;
    if (tag === "input") el.checked = "checked" in attrs;
    document.body.appendChild(el);
    byId.set(attrs.id, el);
  }
  document.getElementById = (id) => byId.get(String(id)) || null;
  document.ids = [...byId.keys()];
  return document;
}

/** chrome.tabs for the popup: one active tab, both callback and promise forms. */
function fakeTabs(activeTab) {
  const queries = [];
  return {
    queries,
    api: {
      query(queryInfo, cb) {
        queries.push(queryInfo);
        const tabs = activeTab ? [activeTab] : [];
        if (typeof cb === "function") {
          setTimeout(() => cb(tabs), 0);
          return undefined;
        }
        return Promise.resolve(tabs);
      },
    },
  };
}

/**
 * Load the toolbar popup (manifest.action.default_popup) with every script it declares.
 * @param {{ storage?: object, activeTab?: object, beforeEach?: Function }} [options]
 */
function loadPopupPage(options) {
  const opts = options || {};
  const page = getContext("popup").declaredIn;
  const tabs = fakeTabs(opts.activeTab === undefined ? { id: 7, url: "https://example.test/", title: "Example" } : opts.activeTab);
  const env = createPageEnv({
    context: "popup",
    only: undefined,
    beforeEach: (file, ctx) => {
      // window.close() exists in every extension page; popup.js calls it after a click.
      if (!ctx.window.close) {
        ctx.window.close = () => {
          ctx.window.closedByPage = true;
        };
      }
      if (opts.beforeEach) opts.beforeEach(file, ctx);
    },
    storage: opts.storage,
    document: pageDocument(page),
    location: { href: `chrome-extension://test-extension/${page}`, protocol: "chrome-extension:", hostname: "test-extension", pathname: `/${page}`, search: "" },
    chromeApis: { tabs: tabs.api },
  });
  return { ...env, page, tabQueries: tabs.queries, closed: () => env.window.closedByPage === true };
}

/** MutationObserver that only records what it was asked to observe (no DOM mutation events). */
class RecordingMutationObserver {
  constructor(callback) {
    this.callback = callback;
    this.targets = [];
  }
  observe(target, init) {
    this.targets.push({ target, init });
  }
  disconnect() {
    this.targets = [];
  }
  takeRecords() {
    return [];
  }
}

/**
 * Load the lookup side panel (manifest.side_panel.default_path) with every script it declares.
 * @param {{ search?: string, storage?: object, beforeEach?: Function }} [options]
 *   search: e.g. "?text=word" (the only parameter lookup-panel.js reads)
 */
function loadSidePanelPage(options) {
  const opts = options || {};
  const page = getContext("side-panel").declaredIn;
  const search = opts.search || "";
  const env = createPageEnv({
    context: "side-panel",
    only: undefined,
    beforeEach: opts.beforeEach,
    storage: opts.storage,
    document: pageDocument(page),
    location: {
      href: `chrome-extension://test-extension/${page}${search}`,
      protocol: "chrome-extension:",
      hostname: "test-extension",
      pathname: `/${page}`,
      search,
    },
    globals: { MutationObserver: RecordingMutationObserver },
  });
  return { ...env, page };
}

module.exports = { elementsWithId, pageDocument, loadPopupPage, loadSidePanelPage, RecordingMutationObserver };
