/**
 * Load the reader page into a sandbox with a permissive DOM: every <script> of reader.html runs
 * in the page's own order (real book-store.js on the fake IndexedDB, real mk-lookup.js).
 * lib/epub.min.js is evaluated too, but its `ePub` factory is then replaced by a fake: the real
 * one needs a browser layout engine (iframes, ranges, CSS) to render anything. Only navigation /
 * persistence is exercised: which section the rendition was asked to display, and what the
 * reader wrote back to the store.
 */
const vm = require("node:vm");
const { baseGlobals, runFile, createStorageArea, createEvent, withFallback } = require("./extension-sandbox");
const { createFakeIndexedDB } = require("./fake-indexeddb");
const { loadContextScripts, scriptsFor } = require("./load-order");

/** The page script that starts the reader; the store is seeded just before it runs. */
const READER_ENTRY = "reader.js";
const EPUB_LIBRARY = "lib/epub.min.js";

function permissiveElement(tag, doc) {
  const listeners = {};
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    nodeType: 1,
    ownerDocument: doc,
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains: () => false,
    },
    hidden: false,
    disabled: false,
    textContent: "",
    value: "",
    title: "",
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    clientWidth: 0,
    offsetWidth: 0,
    offsetHeight: 0,
    children: [],
    childNodes: [],
    parentElement: null,
    _listeners: listeners,
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] || []).filter((f) => f !== fn);
    },
    dispatchEvent(event) {
      (listeners[event.type] || []).slice().forEach((fn) => fn(event));
      return true;
    },
    appendChild(child) {
      el.children.push(child);
      return child;
    },
    insertBefore: (child) => child,
    removeChild: (child) => child,
    remove() {},
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    hasAttribute: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0, bottom: 0, right: 0 }),
    focus() {},
    blur() {},
    click() {},
    scrollIntoView() {},
  };
  // assigning markup replaces the rendered children (renderToc clears the list with innerHTML = "")
  let markup = "";
  Object.defineProperty(el, "innerHTML", {
    get: () => markup,
    set(value) {
      markup = String(value);
      el.children.length = 0;
    },
    enumerable: true,
  });
  return el;
}

function createDocument() {
  const byId = new Map();
  const listeners = {};
  const doc = {
    nodeType: 9,
    title: "",
    hidden: false,
    activeElement: null,
    _listeners: listeners,
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, permissiveElement("div", doc));
      return byId.get(id);
    },
    createElement: (tag) => permissiveElement(tag, doc),
    createTextNode: (t) => ({ nodeType: 3, data: t, textContent: t }),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
    dispatchEvent(event) {
      (listeners[event.type] || []).slice().forEach((fn) => fn(event));
      return true;
    },
  };
  doc.body = permissiveElement("body", doc);
  doc.documentElement = permissiveElement("html", doc);
  doc.head = permissiveElement("head", doc);
  return doc;
}

/** Fake epub.js: `spine` with N sections, CFI → spine index by the /6/N step, display recorder. */
function createFakeEpub(sectionCount) {
  const sections = Array.from({ length: sectionCount }, (_, i) => ({
    index: i,
    href: `chapters/chapter-${i + 1}.xhtml`,
    idref: `chapter-${i + 1}`,
    cfiBase: `/6/${(i + 1) * 2}`,
    next() {
      return sections[i + 1] || null;
    },
    prev() {
      return sections[i - 1] || null;
    },
  }));
  const displays = [];
  const handlers = {};
  const book = {
    ready: Promise.resolve(),
    loaded: { navigation: Promise.resolve({ toc: sections.map((s) => ({ href: s.href, label: `Ch ${s.index + 1}` })) }) },
    spine: {
      length: sections.length,
      get(target) {
        if (typeof target === "number") return sections[target] || null;
        const s = String(target || "");
        const cfi = s.match(/^epubcfi\(\/6\/(\d+)/);
        if (cfi) return sections[parseInt(cfi[1], 10) / 2 - 1] || null;
        return sections.find((x) => s === x.href || s.endsWith(x.href)) || null;
      },
    },
    locations: { generate: async () => [], length: () => 0, percentageFromCfi: () => 0 },
    renderTo(target, opts) {
      const rendition = {
        started: Promise.resolve(),
        settings: opts,
        manager: null,
        hooks: { content: { register() {} }, render: { register() {} } },
        themes: { register() {}, select() {}, fontSize() {}, override() {}, default() {} },
        on(event, fn) {
          (handlers[event] ||= []).push(fn);
        },
        off() {},
        async display(what) {
          displays.push(what === undefined ? "(start)" : what);
          const section = book.spine.get(what === undefined ? 0 : what) || sections[0];
          (handlers.rendered || []).forEach((fn) => fn(section, { document: null }));
          (handlers.relocated || []).forEach((fn) =>
            fn({ start: { cfi: `epubcfi(${section.cfiBase}!/4/2/1:0)`, href: section.href, index: section.index } })
          );
          return section;
        },
        resize() {},
        getContents: () => [],
        currentLocation: () => null,
        destroy() {},
      };
      book.rendition = rendition;
      return rendition;
    },
  };
  return { book, sections, displays, handlers };
}

/**
 * @param {object} opts
 * @param {object} opts.book        record to seed in the store (id defaults to "b1")
 * @param {number} opts.sections    number of spine items in the fake EPUB
 * @param {object} opts.storage     initial chrome.storage.local (e.g. zehReaderPositionCache)
 * @param {string} opts.search      location.search (defaults to ?id=<book id>)
 * @param {Function} opts.beforeEach (file, vmContext) hook before each script
 * @param {Function} opts.afterEach (file, vmContext) hook after each script
 * @param {object} opts.shared     another page's `shared` (same IndexedDB and chrome.storage),
 *                                 to open the same book in a second reader tab
 * @param {string} opts.sessionId  this tab's reader session id (crypto.randomUUID)
 */
async function loadReaderPage(opts) {
  const options = opts || {};
  const bookId = (options.book && options.book.id) || "b1";
  const shared = options.shared || (() => {
    const db = createFakeIndexedDB();
    const changed = createEvent();
    return { ...db, onChanged: changed, local: createStorageArea(options.storage || {}, { onChanged: changed }) };
  })();
  const { indexedDB, IDBKeyRange, onChanged, local } = shared;
  const runtimeMessages = [];
  const document = createDocument();
  const viewer = document.getElementById("viewer");
  viewer.scrollHeight = 2000;
  viewer.clientHeight = 800;
  viewer.clientWidth = 600;
  const epub = createFakeEpub(options.sections || 5);

  const chrome = withFallback({
    runtime: withFallback({
      id: "test-extension",
      lastError: undefined, // Chrome sets it only inside a failed callback; mk-lookup.js reads it
      getURL: (p) => `chrome-extension://test-extension/${p}`,
      sendMessage: (m) => {
        runtimeMessages.push(m);
        return Promise.resolve(undefined);
      },
      onMessage: createEvent(),
    }),
    storage: withFallback({ local, onChanged }),
    tabs: withFallback({ query: () => Promise.resolve([]) }),
  });

  const context = vm.createContext({
    ...baseGlobals(),
    chrome,
    document,
    indexedDB,
    IDBKeyRange,
    DOMException: globalThis.DOMException,
    location: { search: options.search || `?id=${bookId}`, href: `chrome-extension://test-extension/reader.html?id=${bookId}`, hash: "" },
    history: { replaceState() {}, pushState() {} },
    innerWidth: 1200,
    innerHeight: 900,
    devicePixelRatio: 1,
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
    ResizeObserver: class {
      observe() {}
      disconnect() {}
      unobserve() {}
    },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    // mk-lookup.js tests `target instanceof Node`: the permissive elements are not DOM nodes
    Node: class Node {
      static ELEMENT_NODE = 1;
      static TEXT_NODE = 3;
    },
    crypto: { randomUUID: () => options.sessionId || "reader-session-test" },
    prompt: () => null,
    confirm: () => true,
    alert() {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: "node-test", clipboard: { writeText: async () => {} } },
  });
  context.window = context;
  context.self = context;
  context.globalThis = context;
  context.addEventListener = (type, fn) => document.addEventListener(type, fn);
  context.removeEventListener = () => {};
  context.dispatchEvent = (e) => document.dispatchEvent(e);

  // Everything before reader.js, then seed the store, then reader.js and anything after it.
  const all = scriptsFor("reader");
  const entryAt = all.indexOf(READER_ENTRY);
  if (entryAt < 0) throw new Error(`reader.html no longer loads ${READER_ENTRY}: ${all.join(", ")}`);
  let realEpub = null;
  let lookupOptions = null;
  const swapEpub = (file, ctx) => {
    if (options.afterEach) options.afterEach(file, ctx);
    if (file !== EPUB_LIBRARY) return;
    realEpub = ctx.ePub;
    ctx.ePub = () => epub.book;
  };
  const loaded = loadContextScripts(context, "reader", runFile, {
    only: all.slice(0, entryAt),
    beforeEach: options.beforeEach,
    afterEach: swapEpub,
  });
  if (typeof realEpub !== "function") throw new Error(`${EPUB_LIBRARY} did not define the ePub factory`);

  epub.book.renderTo = ((orig) => (target, o) => {
    const r = orig(target, o);
    r.manager = { container: viewer };
    return r;
  })(epub.book.renderTo);

  const store = context.ZEHBookStore;
  if (!options.shared) await store.addBook({
    id: bookId,
    title: "Test Book",
    fileBlob: { size: 1, arrayBuffer: async () => new ArrayBuffer(8) },
    ...(options.book || {}),
  });
  if (options.book && options.book.lastReadAt) {
    // addBook keeps lastReadAt; progress fields go through updateBookProgress semantics
  }
  if (options.bookmarks && !options.shared) {
    for (const bm of options.bookmarks) await store.addBookmark({ bookId, ...bm });
  }

  const createController = context.MKLookup.createController;
  context.MKLookup.createController = (o) => {
    lookupOptions = o;
    return createController(o);
  };

  loaded.push(...loadContextScripts(context, "reader", runFile, {
    only: all.slice(entryAt),
    beforeEach: options.beforeEach,
    afterEach: swapEpub,
  }));

  return {
    context,
    document,
    store,
    indexedDB,
    local,
    epub,
    viewer,
    runtimeMessages,
    loaded,
    realEpub,
    shared,
    record: async () => store.getBook(bookId),
    /** The options reader.js passed to MKLookup.createController */
    lookupOptions: () => lookupOptions,
    /** Run every click listener of the element with this id and wait for them */
    async click(id) {
      const el = document.getElementById(id);
      await Promise.all((el._listeners.click || []).map((fn) => fn({ type: "click", target: el, currentTarget: el, preventDefault() {}, stopPropagation() {} })));
    },
    /** A wheel event on the scroll container (what a mouse wheel or trackpad sends) */
    wheel(deltaY) {
      viewer.dispatchEvent({ type: "wheel", deltaY, target: viewer, currentTarget: viewer, ctrlKey: false, metaKey: false, preventDefault() {}, stopPropagation() {} });
    },
    /** Move the scroll container and send its scroll event */
    scrollTo(top) {
      viewer.scrollTop = top;
      viewer.dispatchEvent({ type: "scroll", target: viewer });
    },
    /** Switch the tab to hidden or visible and send visibilitychange */
    setHidden(hidden) {
      document.hidden = hidden;
      document.dispatchEvent({ type: "visibilitychange", target: document });
    },
    /** Fire a window-level page lifecycle event (pagehide, beforeunload). */
    fire(type) {
      document.dispatchEvent({ type, target: document, preventDefault() {} });
    },
    /** Click the reader's "back to shelf" button and wait for its handler. */
    async clickBack() {
      const btn = document.getElementById("backBtn");
      await Promise.all((btn._listeners.click || []).map((fn) => fn({ type: "click", preventDefault() {} })));
    },
    /** Simulate clicking a bookmark's label in the bookmark panel. */
    clickBookmark(cfi) {
      const list = document.getElementById("bookmarkList");
      const target = { closest: (sel) => (sel === ".bookmark-item-label" ? { dataset: { jump: cfi } } : null) };
      list.dispatchEvent({ type: "click", target, preventDefault() {} });
    },
  };
}

module.exports = { loadReaderPage, createFakeEpub };
