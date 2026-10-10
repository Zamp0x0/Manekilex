/**
 * M8: reader/toc.js keeps the reader's table of contents as it was in reader.js: the nested toc
 * flattened into one list (depth classes up to 2), each entry matched to a spine index by its href
 * (fragment dropped, decoded, case-insensitive, either path may be the suffix of the other), and
 * the entry for the current chapter marked is-active unless a table-of-contents jump holds the
 * highlight.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

/** Just enough DOM for the list: buttons appended to one container */
function tinyDom() {
  const list = {
    children: [],
    set innerHTML(html) {
      this.children = [];
      this.html = html;
    },
    get innerHTML() {
      return this.html || "";
    },
    appendChild(el) {
      this.children.push(el);
      this.html = "";
    },
  };
  const document = {
    createElement() {
      const classes = new Set();
      const listeners = {};
      return {
        dataset: {},
        set className(v) {
          classes.clear();
          String(v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
        },
        get className() {
          return [...classes].join(" ");
        },
        classList: {
          toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
          contains: (c) => classes.has(c),
        },
        addEventListener: (type, fn) => (listeners[type] = fn),
        click() {
          listeners.click && listeners.click();
        },
      };
    },
    querySelectorAll(selector) {
      assert.equal(selector, ".reader-toc-item");
      return list.children;
    },
  };
  return { list, document };
}

const SPINE = ["OEBPS/Text/ch1.xhtml", "OEBPS/Text/ch2.xhtml", "OEBPS/Text/Chapter%203.xhtml", "OEBPS/Text/ch4.xhtml"];

function loadToc({ locked = false } = {}) {
  const { list, document } = tinyDom();
  const context = vm.createContext({ document, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "reader", "toc.js"), "utf8"), context, { filename: "reader/toc.js" });
  const state = { book: null, spineIndex: 0, locked, jumps: [] };
  const api = context.zehCreateReaderToc({
    els: { readerTocList: list },
    readerDebug: () => {},
    book: () => state.book,
    currentSpineIndex: () => state.spineIndex,
    highlightLocked: () => state.locked,
    jumpToItem: async (item, index) => state.jumps.push([item.label, index]),
  });
  const openBook = (toc) => {
    state.book = {
      ready: Promise.resolve(),
      navigation: { toc },
      spine: { length: SPINE.length, get: (i) => ({ href: SPINE[i], index: i }) },
    };
  };
  const active = () => list.children.filter((b) => b.classList.contains("is-active")).map((b) => b.textContent);
  return { api, list, state, openBook, active };
}

const TOC = [
  { label: "  One ", href: "Text/ch1.xhtml" },
  {
    label: "Two",
    href: "Text/ch2.xhtml",
    subitems: [
      { label: "Two, part A", href: "Text/ch2.xhtml#a", subitems: [{ label: "Deep", href: "Text/ch2.xhtml#deep", subitems: [{ label: "Deeper", href: "Text/ch2.xhtml#deeper" }] }] },
    ],
  },
  { label: "Three", href: "TEXT/Chapter 3.xhtml" },
  { title: "Four (title only)", href: "ch4.xhtml#start" },
];

test("M8 toc: the nested toc becomes one list; depth classes stop at 2; each entry knows its spine index", async () => {
  const { api, list, openBook } = loadToc();
  openBook(TOC);
  await api.loadBookToc();
  assert.equal(api.tocItemCount(), 7);
  assert.deepEqual(
    list.children.map((b) => [b.textContent, b.className, b.dataset.spineIndex, b.dataset.tocIndex]),
    [
      ["One", "reader-toc-item depth-0", "0", "0"],
      ["Two", "reader-toc-item depth-0", "1", "1"],
      ["Two, part A", "reader-toc-item depth-1", "1", "2"],
      ["Deep", "reader-toc-item depth-2", "1", "3"],
      ["Deeper", "reader-toc-item depth-2", "1", "4"],
      ["Three", "reader-toc-item depth-0", "2", "5"],
      ["Four (title only)", "reader-toc-item depth-0", "3", "6"],
    ]
  );
});

test("M8 toc: href matching drops the fragment, decodes, ignores case; no match falls back to the current chapter", async () => {
  const { api, state, openBook } = loadToc();
  openBook(TOC);
  assert.equal(api.spineIndexForHref("Text/ch2.xhtml#a"), 1);
  assert.equal(api.spineIndexForHref("text/chapter 3.xhtml"), 2);
  assert.equal(api.spineIndexForHref("OEBPS/Text/ch4.xhtml"), 3);
  state.spineIndex = 2;
  assert.equal(api.spineIndexForHref("missing.xhtml"), 2, "unknown href: the current chapter");
  assert.equal(api.spineIndexForHref(""), 2);
});

test("M8 toc: the current chapter's entry is highlighted: the last entry with the chapter's file, else the last one before it", async () => {
  const { api, openBook, active } = loadToc();
  openBook(TOC);
  await api.loadBookToc();
  // fragments are dropped, so every entry of chapter 2 matches its file; the last one wins
  api.highlightActiveTocBySpine(1, "OEBPS/Text/ch2.xhtml");
  assert.deepEqual(active(), ["Deeper"]);
  api.highlightActiveTocByHref("OEBPS/Text/ch4.xhtml");
  assert.deepEqual(active(), ["Four (title only)"]);
  api.highlightActiveTocBySpine(2, "");
  assert.deepEqual(active(), ["Three"], "no href: the last entry whose chapter is not after this one");
  assert.equal(api.resolveTocIndexForItem({ href: "Text/ch2.xhtml" }), 4);
  assert.equal(api.resolveTocIndexForItem({ href: "Text/ch2.xhtml" }, 4), 4, "an explicit index wins");
});

test("M8 toc: a click jumps through the host; a held highlight is left alone; no toc shows an empty note", async () => {
  const { api, list, state, openBook, active } = loadToc();
  openBook(TOC);
  await api.loadBookToc();
  list.children[5].click();
  assert.deepEqual(state.jumps, [["Three", 5]]);
  api.setActiveTocIndex(0);
  state.locked = true;
  api.highlightActiveTocBySpine(3, "OEBPS/Text/ch4.xhtml");
  assert.deepEqual(active(), ["One"], "a toc jump in progress keeps its own highlight");

  openBook([]);
  await api.loadBookToc();
  assert.equal(api.tocItemCount(), 0);
  assert.match(list.innerHTML, /暂无目录/);
});
