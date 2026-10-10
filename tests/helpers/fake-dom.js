/**
 * A deliberately tiny DOM stand-in, just enough to drive mk-lookup.js's controller
 * (bubble, panel shell, message handling, page lifecycle) under node:test.
 *
 * Elements created through innerHTML are not parsed. querySelector() returns a
 * stable "virtual" child when the selector's class appears in the element's markup,
 * so tests can read e.g. the panel body HTML that the controller rendered.
 */
const vm = require("node:vm");
const { baseGlobals, createEvent, runFile, withFallback } = require("./extension-sandbox");
const { loadContextScripts, scriptsFor } = require("./load-order");

class FakeEventTarget {
  constructor() {
    this._listeners = {};
  }
  addEventListener(type, fn) {
    (this._listeners[type] ||= []).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this._listeners[type] || [];
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatchEvent(event) {
    const evt = event || {};
    [...(this._listeners[evt.type] || [])].forEach((fn) => fn(evt));
    return true;
  }
  listenerCount(type) {
    return (this._listeners[type] || []).length;
  }
}

function parseCompound(selector) {
  const last = selector.trim().split(/\s+/).pop().replace(/:[a-z-]+\([^)]*\)/g, "");
  const classes = [...last.matchAll(/\.([\w-]+)/g)].map((m) => m[1]);
  const attrs = [...last.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)].map((m) => ({
    name: m[1],
    value: m[2],
  }));
  const tag = (last.match(/^([a-zA-Z][\w-]*|\*)/) || [])[1] || "";
  return { classes, attrs, tag: tag.toUpperCase() };
}

/** Tree navigation shared by text nodes and elements (Phase 3 context capture walks siblings). */
class FakeNode extends FakeEventTarget {
  get childNodes() {
    return this.children || [];
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get lastChild() {
    const list = this.childNodes;
    return list[list.length - 1] || null;
  }
  get nextSibling() {
    const siblings = this.parentElement ? this.parentElement.children : null;
    if (!siblings) return null;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  get previousSibling() {
    const siblings = this.parentElement ? this.parentElement.children : null;
    if (!siblings) return null;
    const i = siblings.indexOf(this);
    return i > 0 ? siblings[i - 1] : null;
  }
}
FakeNode.ELEMENT_NODE = 1;
FakeNode.TEXT_NODE = 3;

/** A text node with real offsets, so selection repair (config.js) can run against it. */
class FakeText extends FakeNode {
  constructor(text, ownerDocument) {
    super();
    this.nodeType = 3;
    this.textContent = String(text);
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
    this.children = [];
  }
  get parentNode() {
    return this.parentElement;
  }
  get nodeValue() {
    return this.textContent;
  }
  get isConnected() {
    return Boolean(this.parentElement?.isConnected);
  }
  remove() {
    FakeElement.prototype.remove.call(this);
  }
  matches() {
    return false;
  }
  _walk(out) {
    return out;
  }
}

class FakeElement extends FakeNode {
  constructor(tagName, ownerDocument) {
    super();
    this.nodeType = 1;
    this.tagName = String(tagName || "div").toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.parentElement = null;
    this._attrs = {};
    this._html = "";
    this._virtual = new Map();
    this.hidden = false;
    this.dataset = {};
    const style = {};
    style.setProperty = (k, v) => (style[k] = v);
    style.removeProperty = (k) => delete style[k];
    this.style = style;
    const self = this;
    this.classList = {
      add: (...c) => (self.className = [...new Set([...self._classes(), ...c])].join(" ")),
      remove: (...c) => (self.className = self._classes().filter((x) => !c.includes(x)).join(" ")),
      toggle: (c, force) => {
        const has = self._classes().includes(c);
        const want = force === undefined ? !has : force;
        if (want) self.classList.add(c);
        else self.classList.remove(c);
        return want;
      },
      contains: (c) => self._classes().includes(c),
    };
    this.className = "";
  }
  _classes() {
    return String(this.className || "").split(/\s+/).filter(Boolean);
  }
  get parentNode() {
    return this.parentElement;
  }
  get textContent() {
    return this._html.replace(/<[^>]*>/g, "");
  }
  set textContent(v) {
    this.innerHTML = String(v ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }
  get innerHTML() {
    return this._html;
  }
  set innerHTML(v) {
    this._html = String(v);
    this._virtual.clear();
  }
  get isConnected() {
    let n = this;
    while (n.parentElement) n = n.parentElement;
    return n === this.ownerDocument?.documentElement;
  }
  setAttribute(k, v) {
    this._attrs[k] = String(v);
    if (k.startsWith("data-")) {
      const key = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (key) this.dataset[key] = String(v);
    }
  }
  getAttribute(k) {
    if (k.startsWith("data-")) {
      const key = k.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      if (key in this.dataset) return this.dataset[key];
    }
    return k in this._attrs ? this._attrs[k] : null;
  }
  hasAttribute(k) {
    return this.getAttribute(k) !== null;
  }
  removeAttribute(k) {
    delete this._attrs[k];
  }
  appendChild(child) {
    if (child.parentElement) child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  prepend(child) {
    if (child.parentElement) child.remove();
    child.parentElement = this;
    this.children.unshift(child);
  }
  remove() {
    const p = this.parentElement;
    if (!p) return;
    const i = p.children.indexOf(this);
    if (i >= 0) p.children.splice(i, 1);
    this.parentElement = null;
  }
  contains(node) {
    let n = node;
    while (n) {
      if (n === this) return true;
      n = n.parentElement;
    }
    return false;
  }
  closest() {
    return null;
  }
  matches(selector) {
    const { classes, attrs, tag } = parseCompound(selector);
    if (tag === "*") return true;
    if (tag && tag !== this.tagName) return false;
    if (!tag && !classes.length && !attrs.length) return false;
    const mine = this._classes();
    if (!classes.every((c) => mine.includes(c))) return false;
    return attrs.every(({ name, value }) => {
      const actual = this.getAttribute(name);
      return value === undefined ? actual !== null : actual === value;
    });
  }
  _walk(out) {
    this.children.forEach((c) => {
      out.push(c);
      c._walk(out);
    });
    return out;
  }
  querySelectorAll(selector) {
    return this._walk([]).filter((el) => el.matches(selector));
  }
  _markup() {
    return [this._html, ...[...this._virtual.values()].map((v) => v._markup())].join("\n");
  }
  querySelector(selector) {
    const real = this.querySelectorAll(selector)[0];
    if (real) return real;
    const { classes } = parseCompound(selector);
    if (!classes.length || !this._markup().includes(classes[0])) return null;
    if (!this._virtual.has(selector)) {
      const v = new FakeElement("div", this.ownerDocument);
      v.className = classes.join(" ");
      this._virtual.set(selector, v);
    }
    return this._virtual.get(selector);
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, right: 120, bottom: 60, width: 120, height: 60 };
  }
  replaceChildren(...nodes) {
    [...this.children].forEach((c) => c.remove());
    this._html = "";
    nodes.forEach((n) => this.appendChild(n));
  }
  click() {
    this.dispatchEvent({ type: "click", target: this, preventDefault() {} });
  }
  focus() {}
  blur() {}
  select() {}
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.documentElement = new FakeElement("html", this);
    this.body = new FakeElement("body", this);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
    this.hidden = false;
    /** Every selector passed to document.querySelectorAll (R-22 tests watch for "*"). */
    this.queryLog = [];
  }
  createElement(tag) {
    return new FakeElement(tag, this);
  }
  createTextNode(text) {
    return new FakeText(text, this);
  }
  querySelectorAll(selector) {
    this.queryLog.push(selector);
    return this.documentElement.querySelectorAll(selector);
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  getElementById() {
    return null;
  }
  getSelection() {
    return null;
  }
}

const liveControllers = new Set();

/** Destroy every controller created by the loaders below (clears pending timers). */
function disposeLookupControllers() {
  liveControllers.forEach((c) => c.destroyController());
  liveControllers.clear();
}

const RANGE_RECT = { left: 10, top: 10, right: 60, bottom: 30, width: 50, height: 20 };

/** A Range over FakeText nodes (only what mk-lookup.js / config.js read). */
function createRange(startContainer, startOffset, endContainer, endOffset) {
  const sameNode = startContainer === endContainer;
  const range = {
    startContainer,
    startOffset,
    endContainer,
    endOffset,
    commonAncestorContainer: sameNode ? startContainer : startContainer.parentElement,
    get collapsed() {
      return sameNode && startOffset === endOffset;
    },
    toString() {
      if (sameNode) return startContainer.textContent.slice(startOffset, endOffset);
      return startContainer.textContent.slice(startOffset) + endContainer.textContent.slice(0, endOffset);
    },
    getBoundingClientRect: () => ({ ...RANGE_RECT }),
    getClientRects: () => [{ ...RANGE_RECT }],
    cloneRange: () => createRange(startContainer, startOffset, endContainer, endOffset),
    collapse() {},
  };
  return range;
}

/** A Selection holding one range (or none). */
function createSelection(range) {
  return {
    get rangeCount() {
      return range ? 1 : 0;
    },
    get isCollapsed() {
      return !range || range.collapsed;
    },
    anchorNode: range ? range.startContainer : null,
    getRangeAt(index) {
      if (!range || index !== 0) throw new Error("IndexSizeError");
      return range;
    },
    toString() {
      return range ? range.toString() : "";
    },
  };
}

/**
 * The content-script prefix most mk-lookup unit tests need: config.js, the page-side helpers,
 * the lookup/*.js parts and mk-lookup.js — everything the manifest loads up to mk-lookup.js.
 */
const CONTENT_SCRIPTS = scriptsFor("content");
const LOOKUP_CORE = CONTENT_SCRIPTS.slice(0, CONTENT_SCRIPTS.indexOf("mk-lookup.js") + 1);

/**
 * Build a page sandbox (fake window/document/chrome) and load a context's scripts into it,
 * in the order the extension declares them (tests/helpers/load-order.js).
 * @param {{
 *   storage?: object,       initial chrome.storage.local contents
 *   context?: string,       execution context to load (default "content", the web page)
 *   only?: string[],        focused subset of that context's list (default: LOOKUP_CORE)
 *   beforeEach?: Function,  (file, vmContext) hook, e.g. to instrument MKLookup before content.js
 *   location?: object,      overrides for window.location (href, protocol, pathname, search …)
 *   document?: FakeDocument use a prepared document (e.g. with the page's id'd elements)
 *   chromeApis?: object,    extra chrome.* namespaces the context uses (e.g. tabs for the popup)
 *   globals?: object,       extra globals of the context (e.g. MutationObserver)
 * }} [options]
 */
function createPageEnv(options) {
  const opts = options || {};
  const document = opts.document || new FakeDocument();
  const window = new FakeEventTarget();
  let currentSelection = null;
  const location = {
    href: "https://example.test/article",
    protocol: "https:",
    hostname: "example.test",
    pathname: "/article",
    search: "",
    reload() {},
    ...(opts.location || {}),
  };
  Object.assign(window, {
    document,
    innerWidth: 1280,
    innerHeight: 800,
    location,
    getSelection: () => currentSelection,
    getComputedStyle: () => ({}),
  });
  window.top = window;
  window.parent = window;
  document.defaultView = window;
  document.getSelection = () => currentSelection;

  const onMessage = createEvent();
  const onChanged = createEvent();
  const sent = [];
  const runtime = {
    id: "test-extension",
    lastError: undefined,
    onMessage,
    getURL: (p) => `chrome-extension://test-extension/${p}`,
    getManifest: () => ({ version: "0.0.0-test" }),
    // Like Chrome: with a callback it returns undefined; without one it returns a Promise,
    // which settles when the test answers through the recorded `cb`.
    sendMessage: (message, cb) => {
      if (typeof cb === "function") {
        sent.push({ message, cb });
        return undefined;
      }
      return new Promise((resolve) => sent.push({ message, cb: resolve }));
    },
  };
  const stored = { ...(opts.storage || {}) };
  const chrome = withFallback({
    runtime,
    storage: withFallback({
      local: {
        get: (keys, cb) => {
          const out = {};
          if (keys && typeof keys === "object" && !Array.isArray(keys)) {
            Object.entries(keys).forEach(([k, def]) => (out[k] = k in stored ? stored[k] : def));
          }
          setTimeout(() => cb(out), 0);
        },
        set: (_obj, cb) => cb && setTimeout(cb, 0),
      },
      onChanged,
    }),
    ...(opts.chromeApis || {}),
  });

  const context = vm.createContext({
    ...baseGlobals(),
    window,
    document,
    location,
    chrome,
    navigator: { userAgent: "node-test" },
    Element: FakeElement,
    Node: FakeNode,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    cancelAnimationFrame: (id) => clearTimeout(id),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
    ...(opts.globals || {}),
  });
  context.self = context;
  const loaded = loadContextScripts(context, opts.context || "content", runFile, {
    only: "only" in opts ? opts.only : LOOKUP_CORE,
    beforeEach: opts.beforeEach,
  });

  /** Put `text` into a paragraph and select [start, end) of it. */
  function selectText(text, start, end) {
    const p = document.createElement("p");
    const node = document.createTextNode(text);
    p.appendChild(node);
    document.body.appendChild(p);
    currentSelection = createSelection(createRange(node, start, node, end));
    return currentSelection;
  }

  return {
    context,
    loaded,
    window,
    document,
    chrome,
    runtime,
    sent,
    onChanged,
    selectText,
    /** A collapsed caret inside this document (a click or typing). */
    placeCaret(text = "typing in a long thread") {
      selectText(text, 3, 3);
    },
    clearSelection() {
      currentSelection = createSelection(null);
    },
    setSelection(selection) {
      currentSelection = selection;
    },
    messages: (type) => sent.filter((s) => s.message.type === type),
    explainRequests: () => sent.filter((s) => s.message.type === "EXPLAIN"),
    /** Deliver a runtime message (SHOW_RESULT / SHOW_ERROR …) to every content listener. */
    deliver(message) {
      onMessage.listeners.forEach((fn) => fn(message, {}, () => {}));
    },
    /** Fire chrome.storage.onChanged for the local area. */
    changeStorage(changes) {
      onChanged.listeners.forEach((fn) => fn(changes, "local"));
    },
    onMessageListenerCount: () => onMessage.listeners.length,
  };
}

function withPanelHelpers(env, controller) {
  liveControllers.add(controller);
  return Object.assign(env, {
    controller,
    /** Answer the n-th EXPLAIN request's sendMessage callback. */
    respond(index, response) {
      env.explainRequests()[index].cb(response);
    },
    panel() {
      return env.document.querySelector(".zeh-panel");
    },
    panelBodyHtml() {
      return this.panel()?.querySelector(".zeh-panel-body")?.innerHTML || "";
    },
    hasRefreshBanner() {
      return env.document.querySelectorAll(".zeh-refresh-banner").length > 0;
    },
  });
}

/**
 * Load LOOKUP_CORE (config.js, lookup/*.js, mk-lookup.js) into a sandbox with the fake DOM
 * and a fake chrome.
 * Returns the controller plus handles to drive runtime messages and page lifecycle.
 */
function loadLookupController(options) {
  const env = createPageEnv(options);
  const controller = env.window.MKLookup.createController({
    win: env.window,
    doc: env.document,
    ...((options && options.controllerOptions) || {}),
  });
  return withPanelHelpers(env, controller);
}

/**
 * Load the full web content-script list from manifest.json (config.js, mk-lookup.js,
 * pdf-page-assistant.js, content.js …) into a page sandbox.
 * `selectionReads` counts controller.getSelectionInfo() calls made by content.js.
 */
function loadContentScript(options) {
  const created = [];
  let selectionReads = 0;
  const instrument = (file, context) => {
    if (file !== "content.js") return;
    const api = context.window.MKLookup;
    const realCreate = api.createController;
    api.createController = (opts) => {
      const controller = realCreate(opts);
      const read = controller.getSelectionInfo;
      controller.getSelectionInfo = (...args) => {
        selectionReads += 1;
        return read(...args);
      };
      created.push(controller);
      return controller;
    };
  };
  const env = createPageEnv({ ...(options || {}), only: undefined, beforeEach: instrument });
  if (!env.loaded.includes("content.js")) throw new Error("content.js is not in the manifest content-script list");
  withPanelHelpers(env, created[0]);
  return Object.assign(env, {
    selectionReads: () => selectionReads,
    /** Dispatch a DOM event on the document (content.js listens in capture phase). */
    fire(type, init) {
      env.document.dispatchEvent({
        type,
        target: env.document.body,
        button: 0,
        clientX: 40,
        clientY: 30,
        ...(init || {}),
      });
    },
    setEnabled(enabled) {
      env.changeStorage({ zehManekilexEnabled: { newValue: enabled } });
    },
  });
}

module.exports = {
  LOOKUP_CORE,
  FakeNode,
  FakeElement,
  FakeText,
  FakeDocument,
  FakeEventTarget,
  createRange,
  createSelection,
  createPageEnv,
  loadLookupController,
  loadContentScript,
  disposeLookupControllers,
};
