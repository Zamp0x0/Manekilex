/**
 * Whitespace at the ends of a selection is not part of the selected word (lookup/selection.js).
 *
 * On Windows a double-click selects the word and the space after it ("harbour "). The partial-word
 * expansion used to scan outwards from the untrimmed ends and took the next word in as well
 * ("harbour was"). These tests run the real zehCreateLookupSelection on a small DOM with Range and
 * TreeWalker: page selections in one text node, selections across text nodes (the cross-node
 * fallback of aggressiveBubbleMode), and input / textarea selections. For each case the returned
 * text, Range and offsets must describe the same characters.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("./helpers/extension-sandbox");

// ── a minimal DOM: text nodes, elements, Range, TreeWalker ─────────────────────

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

class TNode {
  constructor(nodeType) {
    this.nodeType = nodeType;
    this.parentNode = null;
    this.childNodes = [];
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === ELEMENT_NODE ? this.parentNode : null;
  }
  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
  remove() {
    if (!this.parentNode) return;
    const list = this.parentNode.childNodes;
    list.splice(list.indexOf(this), 1);
    this.parentNode = null;
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
}

class TText extends TNode {
  constructor(data) {
    super(TEXT_NODE);
    this.data = data;
  }
  get textContent() {
    return this.data;
  }
}

class TElement extends TNode {
  constructor(tagName, doc) {
    super(ELEMENT_NODE);
    this.tagName = tagName.toUpperCase();
    this.ownerDocument = doc;
    this.style = {};
    this.attributes = {};
  }
  setAttribute(name, value) {
    this.attributes[name] = value;
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join("");
  }
  set textContent(value) {
    this.childNodes = [];
    this.appendChild(new TText(String(value)));
  }
  getBoundingClientRect() {
    // the input-field mirror measures its marker span: record what it was asked to measure
    if (this.ownerDocument) this.ownerDocument.measured.push(this.textContent);
    return { left: 0, top: 0, right: 40, bottom: 20, width: 40, height: 20 };
  }
}

/** Text nodes under `root` in document order */
function textNodes(root) {
  const out = [];
  const walk = (n) => {
    if (n.nodeType === TEXT_NODE) out.push(n);
    n.childNodes.forEach(walk);
  };
  walk(root);
  return out;
}

class TRange {
  constructor(doc) {
    this.doc = doc;
  }
  setStart(node, offset) {
    this.startContainer = node;
    this.startOffset = offset;
  }
  setEnd(node, offset) {
    this.endContainer = node;
    this.endOffset = offset;
  }
  get collapsed() {
    return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
  }
  get commonAncestorContainer() {
    for (let n = this.startContainer; n; n = n.parentNode) if (n.contains(this.endContainer)) return n;
    return this.doc.body;
  }
  toString() {
    // only text-node boundaries are used by these tests
    const nodes = textNodes(this.doc.body);
    const from = nodes.indexOf(this.startContainer);
    const to = nodes.indexOf(this.endContainer);
    let s = "";
    for (let i = from; i <= to; i++) {
      const t = nodes[i].data;
      s += t.slice(i === from ? this.startOffset : 0, i === to ? this.endOffset : t.length);
    }
    return s;
  }
  getBoundingClientRect() {
    return { left: 10, top: 10, right: 60, bottom: 30, width: 50, height: 20 };
  }
  getClientRects() {
    return [this.getBoundingClientRect()];
  }
}

class TDocument {
  constructor() {
    this.body = new TElement("body", this);
    this.documentElement = this.body;
    this.measured = [];
  }
  createElement(tag) {
    return new TElement(tag, this);
  }
  createTextNode(data) {
    return new TText(data);
  }
  createRange() {
    return new TRange(this);
  }
  createTreeWalker(root) {
    const nodes = textNodes(root);
    return {
      currentNode: root,
      nextNode() {
        const i = nodes.indexOf(this.currentNode);
        const next = nodes[i + 1] || null;
        if (next) this.currentNode = next;
        return next;
      },
      previousNode() {
        const i = nodes.indexOf(this.currentNode);
        const prev = i > 0 ? nodes[i - 1] : null;
        if (prev) this.currentNode = prev;
        return prev;
      },
    };
  }
}

function selectionOf(range) {
  return {
    rangeCount: 1,
    get isCollapsed() {
      return range.collapsed;
    },
    getRangeAt: () => range,
    toString: () => range.toString(),
  };
}

const cfg = loadConfig();
cfg.Node = { TEXT_NODE, ELEMENT_NODE };
cfg.NodeFilter = { SHOW_TEXT: 4 };

function lookupSelection(doc, aggressiveBubbleMode = false) {
  return cfg.zehCreateLookupSelection({
    win: { location: { hostname: "example.test" }, getComputedStyle: () => ({}) },
    doc,
    aggressiveBubbleMode,
    rangeRectAdapter: null,
    adaptViewportRect: (r) => r,
  });
}

/** A paragraph made of `parts` (one text node each); select [start, end) of the joined text. */
function pageSelection(parts, start, end) {
  const doc = new TDocument();
  const p = doc.body.appendChild(doc.createElement("p"));
  const nodes = parts.map((t) => {
    const span = p.appendChild(doc.createElement("span"));
    return span.appendChild(doc.createTextNode(t));
  });
  const point = (at) => {
    let rest = at;
    for (const n of nodes) {
      if (rest <= n.data.length) return [n, rest];
      rest -= n.data.length;
    }
    throw new Error("offset outside the text");
  };
  const range = doc.createRange();
  range.setStart(...point(start));
  range.setEnd(...point(end));
  return { doc, selection: selectionOf(range) };
}

/** What the lookup controller does with expandPartialWordSelection (mk-lookup.js buildPageSelectionInfo) */
function lookupTextAndRange(parts, selected, { aggressive = false } = {}) {
  const text = parts.join("");
  const start = text.indexOf(selected);
  assert.ok(start >= 0, `"${selected}" is in "${text}"`);
  const { doc, selection } = pageSelection(parts, start, start + selected.length);
  const sel = lookupSelection(doc, aggressive);
  const result = sel.expandPartialWordSelection(selection, doc);
  const lookup = result.expanded ? result.text.trim() : sel.extractSelectionText(selection);
  const range = result.range || selection.getRangeAt(0);
  return { lookup, rangeText: range.toString(), expanded: result.expanded };
}

const ARTICLE = "The old harbour was busy at dawn.";

// ── one text node (ordinary web pages) ─────────────────────────────────────────

test("a word with surrounding whitespace is looked up alone, and the Range covers only the word", () => {
  for (const selected of ["harbour ", " harbour", " harbour "]) {
    const got = lookupTextAndRange([ARTICLE], selected);
    assert.equal(got.lookup, "harbour", JSON.stringify(selected));
    assert.equal(got.rangeText, "harbour", `Range for ${JSON.stringify(selected)}`);
    assert.equal(got.expanded, false, `${JSON.stringify(selected)} needs no expansion`);
  }
});

test("half a word is still expanded to the whole word, also with a trailing space", () => {
  for (const selected of ["harb", "arbo", "bour"]) {
    const got = lookupTextAndRange([ARTICLE], selected);
    assert.equal(got.lookup, "harbour", selected);
    assert.equal(got.rangeText, "harbour", `Range for ${selected}`);
    assert.equal(got.expanded, true);
  }
  // "bour " (end of a word plus the space): expands left only, never into "was"
  const got = lookupTextAndRange([ARTICLE], "bour ");
  assert.equal(got.lookup, "harbour");
  assert.equal(got.rangeText, "harbour");
});

test("real phrases, punctuation and whitespace-only selections are not expanded", () => {
  const cases = [
    ["harbour was", "harbour was"],
    [" harbour was ", "harbour was"],
    ["old harbour", "old harbour"],
    ["dawn.", "dawn."],
    ["busy at dawn", "busy at dawn"],
  ];
  for (const [selected, expected] of cases) {
    const got = lookupTextAndRange([ARTICLE], selected);
    assert.equal(got.lookup, expected, JSON.stringify(selected));
    assert.equal(got.rangeText, expected, `Range for ${JSON.stringify(selected)}`);
    assert.equal(got.expanded, false, `${JSON.stringify(selected)} is not expanded`);
  }
  const { doc, selection } = pageSelection([ARTICLE], 3, 4); // the space between The and old
  const result = lookupSelection(doc).expandPartialWordSelection(selection, doc);
  assert.equal(result.expanded, false);
  assert.equal(result.range, null, "a whitespace-only selection gets no Range");
});

test("a single letter between spaces stays a single letter", () => {
  const got = lookupTextAndRange(["I said a word."], " a ");
  assert.equal(got.lookup, "a");
  assert.equal(got.rangeText, "a");
  assert.equal(got.expanded, false);
});

// ── across text nodes (aggressiveBubbleMode fallback: Feishu / ChatGPT editors) ───

test("cross-node fallback: whitespace at the ends does not pull in the neighbouring word", () => {
  // "The old harbour was busy" split inside the word: harb|our was
  const parts = ["The old harb", "our was busy at dawn."];
  for (const selected of ["harbour ", " harbour", " harbour "]) {
    const got = lookupTextAndRange(parts, selected, { aggressive: true });
    assert.equal(got.lookup, "harbour", JSON.stringify(selected));
    assert.equal(got.rangeText, "harbour", `Range for ${JSON.stringify(selected)}`);
  }
  // the whitespace itself sits in another node: word|" "|next
  const spaced = ["The old harbour", " ", "was busy"];
  const got = lookupTextAndRange(spaced, "harbour ", { aggressive: true });
  assert.equal(got.lookup, "harbour");
  assert.equal(got.rangeText, "harbour");
});

test("cross-node fallback still completes half a word split across nodes", () => {
  const parts = ["The old harb", "our was busy at dawn."];
  const got = lookupTextAndRange(parts, "rbou", { aggressive: true });
  assert.equal(got.expanded, true);
  assert.equal(got.lookup, "harbour");
  assert.equal(got.rangeText, "harbour");
  const phrase = lookupTextAndRange(parts, "harbour was", { aggressive: true });
  assert.equal(phrase.lookup, "harbour was", "a real two-word selection stays two words");
});

// ── input / textarea ──────────────────────────────────────────────────────────

function fieldInfo(tagName, value, selected) {
  const doc = new TDocument();
  const el = doc.body.appendChild(doc.createElement(tagName));
  el.value = value;
  el.type = "text";
  el.getBoundingClientRect = () => ({ left: 0, top: 0, right: 300, bottom: 30, width: 300, height: 30 });
  const start = value.indexOf(selected);
  assert.ok(start >= 0);
  const info = lookupSelection(doc).getFieldSelectionInfo(el, start, start + selected.length);
  return { info, value, measured: doc.measured };
}

test("input and textarea: surrounding whitespace is dropped from the text, the offsets and the measured rect", () => {
  for (const tag of ["input", "textarea"]) {
    for (const selected of ["harbour ", " harbour", " harbour "]) {
      const { info, value, measured } = fieldInfo(tag, ARTICLE, selected);
      const label = `${tag} ${JSON.stringify(selected)}`;
      assert.equal(info.text, "harbour", label);
      assert.equal(value.slice(info.contextSource.start, info.contextSource.end), "harbour", `${label} offsets`);
      assert.deepEqual(measured, ["harbour"], `${label} rect is measured on the word`);
      assert.equal(info.selectionExpanded, false, label);
    }
    const half = fieldInfo(tag, ARTICLE, "harb");
    assert.equal(half.info.text, "harbour", `${tag} half word`);
    assert.equal(half.info.selectionExpanded, true);
    const phrase = fieldInfo(tag, ARTICLE, "harbour was");
    assert.equal(phrase.info.text, "harbour was", `${tag} phrase`);
    assert.equal(phrase.value.slice(phrase.info.contextSource.start, phrase.info.contextSource.end), "harbour was");
  }
});
