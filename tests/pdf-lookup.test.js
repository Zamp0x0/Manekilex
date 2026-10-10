/**
 * Cat lookup inside the enhanced PDF reader.
 *
 *   - pdf-reader/context.js builds a layout model from the real PDF.js text content of the generated
 *     fixtures: the sentence around a word, hyphenation, two columns that are never joined, headers
 *     and footers, tables / formulas and scanned pages (dictionary only, no context);
 *   - mk-lookup.js accepts that window as a "snapshot" context source (bounded, validated) and
 *     ADD_VOCAB carries sourceType "pdf" with { title, fileName, url, page };
 *   - config.js / vocab-review.js keep the pdf source through sanitizing and the review model, and
 *     never keep a query string, a fragment, credentials or a non-http(s) address;
 *   - the reader page wires the same lookup controller (no second implementation) and cleans it up.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { ROOT } = require("./helpers/load-order");
const { loadConfig, runFile, evalIn } = require("./helpers/extension-sandbox");
const { pdfFixture } = require("./helpers/pdf-fixtures");
const { loadLookupController, disposeLookupControllers } = require("./helpers/fake-dom");
const { loadPdfReaderPage } = require("./helpers/pdf-reader-page");
const { loadSettingsPage } = require("./helpers/settings-page");
const { createStorageArea, createEvent } = require("./helpers/extension-sandbox");

test.afterEach(() => disposeLookupControllers());

const plain = (value) => JSON.parse(JSON.stringify(value));

const cfg = loadConfig();
runFile(cfg, "pdf-reader/context.js");
const C = cfg.ZEHPdfContext;
const SCAN = evalIn(cfg, "ZEH_CONTEXT_LIMITS.scan");

let pdfjsLib = null;
async function pdfjs() {
  if (!pdfjsLib) {
    pdfjsLib = await import(pathToFileURL(path.join(ROOT, "lib/pdfjs/build/pdf.min.mjs")).href);
    pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(ROOT, "lib/pdfjs/build/pdf.worker.min.mjs")).href;
  }
  return pdfjsLib;
}

/** Real PDF.js text content of every page of a fixture → layout models */
async function models(name) {
  const lib = await pdfjs();
  const task = lib.getDocument({ data: new Uint8Array(pdfFixture(name)), isEvalSupported: false, enableXfa: false, verbosity: 0 });
  try {
    const doc = await task.promise;
    const out = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent(C.TEXT_CONTENT_PARAMS);
      out.push({ tc, model: C.buildPageModel(tc, { pageNumber: p, view: page.view }) });
    }
    return out;
  } finally {
    await task.destroy();
  }
}

/** Selection endpoints for `word` (n-th item containing it, 0-based) */
function pick(model, word, nth = 0) {
  const hits = model.items.filter((it) => it.str.includes(word));
  const it = hits[nth];
  assert.ok(it, `an item contains ${word}`);
  const at = it.str.indexOf(word);
  return [
    { item: it.index, offset: at },
    { item: it.index, offset: at + word.length },
  ];
}

const sentenceOf = (snap) => snap.text.slice(snap.start, snap.end);

test("context: a word in a wrapped single-column paragraph gets its paragraph (not the heading or header)", async () => {
  const [{ model }] = await models("single-column.pdf");
  const snap = C.snapshotForSelection(model, ...pick(model, "factual"));
  assert.ok(snap, "context available");
  assert.equal(snap.sourceType, "pdf");
  assert.equal(sentenceOf(snap), "factual");
  assert.match(snap.text, /Retrieval-augmented generation improves factual accuracy by incorporating external knowledge\./);
  assert.doesNotMatch(snap.text, /Introduction|Journal of Reproducible/);
  // the window is bounded by the scan limit on both sides
  assert.ok(snap.start <= SCAN && snap.text.length - snap.end <= SCAN);

  // the sentence the lookup would send is built by the shared helper from this window
  const ctx = cfg.zehBuildLookupContext({
    text: snap.text,
    selectionStart: snap.start,
    selectionEnd: snap.end,
    term: "factual",
    queryType: "word",
    sourceType: "pdf",
  });
  assert.equal(ctx.sentence, "Retrieval-augmented generation improves factual accuracy by incorporating external knowledge.");
  assert.equal(ctx.sourceType, "pdf");
});

test("context: two columns drawn line by line are never joined", async () => {
  const [{ model }] = await models("two-column.pdf");
  const left = C.snapshotForSelection(model, ...pick(model, "vector", 0));
  assert.ok(left, "left column has context");
  assert.match(left.text, /^Dense retrieval maps queries and passages into one vector space\./);
  assert.doesNotMatch(left.text, /Sparse|baselines|inspect|Hybrid/);
  const right = C.snapshotForSelection(model, ...pick(model, "baselines"));
  assert.ok(right, "right column has context");
  assert.match(right.text, /^Sparse methods count shared words instead\./);
  assert.doesNotMatch(right.text, /Dense|vector|collections/);
  // a selection from one column into the other has no single paragraph → dictionary only
  const [a] = pick(model, "Dense");
  const [, b] = pick(model, "Sparse");
  assert.equal(C.snapshotForSelection(model, a, b), null);
  assert.equal(C.textForSelection(model, a, b), "");
});

test("context: a word hyphenated across a line break is joined for the query and the context", async () => {
  const [{ model }] = await models("wrapped.pdf");
  const [a] = pick(model, "incorpo-");
  const rating = model.items.find((it) => it.str.startsWith("rating external"));
  const b = { item: rating.index, offset: "rating".length };
  assert.equal(C.textForSelection(model, a, b), "incorporating");
  const snap = C.snapshotForSelection(model, a, b);
  assert.equal(sentenceOf(snap), "incorporating");
  assert.match(snap.text, /by incorporating external knowledge into the prompt\./);
  // the second paragraph is its own block
  assert.doesNotMatch(snap.text, /Annotators/);
});

test("context: headers, page numbers, table cells and formulas give no context (dictionary only)", async () => {
  const [{ model: single }] = await models("single-column.pdf");
  assert.equal(C.snapshotForSelection(single, ...pick(single, "Reproducible")), null, "running header");
  assert.equal(C.snapshotForSelection(single, ...pick(single, "Introduction")), null, "heading");
  const [{ model: table }] = await models("table-formula.pdf");
  const unusable = table.blocks.filter((b) => !b.usable).map((b) => b.text);
  assert.ok(unusable.some((t) => /=|\d/.test(t)), "formula / numeric blocks are marked unusable");
  for (const block of table.blocks.filter((b) => !b.usable)) {
    const it = table.items.find((i) => i.block === table.blocks.indexOf(block) && /[A-Za-z]{2,}/.test(i.str));
    if (!it) continue;
    const m = it.str.match(/[A-Za-z]{2,}/);
    const a = { item: it.index, offset: m.index };
    const b = { item: it.index, offset: m.index + m[0].length };
    assert.equal(C.snapshotForSelection(table, a, b), null, `no context from "${block.text}"`);
  }
  // body sentences on the same page still have context
  assert.ok(table.blocks.some((b) => b.usable));
});

test("context: scanned / image-only pages have no text; a multi-page document keeps page numbers", async () => {
  const [{ tc, model }] = await models("image-only.pdf");
  assert.equal(C.textContentHasText(tc), false);
  assert.equal(model.hasText, false);
  const pages = await models("multi-page.pdf");
  assert.ok(pages.length > 1);
  pages.forEach(({ model: m }, i) => assert.equal(m.pageNumber, i + 1));
  // bad endpoints never throw
  assert.equal(C.snapshotForSelection(pages[0].model, { item: 9999, offset: 0 }, { item: 9999, offset: 2 }), null);
  assert.equal(C.snapshotForSelection(null, null, null), null);
});

// ── mk-lookup.js: snapshot context source and the vocabulary payload ─────────

function pdfController() {
  return loadLookupController({
    controllerOptions: {
      aggressiveBubbleMode: true,
      vocabContext: () => ({
        pageUrl: "https://papers.example.test/rag.pdf",
        pageTitle: "RAG survey",
        pdf: { title: "RAG survey", fileName: "rag.pdf", url: "https://papers.example.test/rag.pdf" },
      }),
    },
  });
}

/** What lookup-adapter.js hands to presentTrigger, then a click on the cat */
function lookUpSnapshot(env, payload) {
  env.controller.presentTrigger({ rect: { left: 10, top: 10, right: 60, bottom: 24, width: 50, height: 14 }, releaseX: 40, releaseY: 30, ...payload });
  const trigger = env.document.querySelector(".zeh-trigger");
  assert.ok(trigger, "cat shown");
  trigger.dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  const requests = env.explainRequests();
  assert.ok(requests.length, "EXPLAIN sent");
  return requests.at(-1).message;
}

const RAG = "Retrieval-augmented generation improves factual accuracy by incorporating external knowledge.";

test("lookup: a PDF snapshot becomes the sentence context; ADD_VOCAB carries the pdf source and page", () => {
  const env = pdfController();
  const text = `Large language models still invent facts. ${RAG} The retriever selects passages.`;
  const start = text.indexOf("factual");
  const msg = lookUpSnapshot(env, {
    text: "factual",
    source: "pdf-selection-bubble",
    contextSource: { kind: "snapshot", text, start, end: start + 7, sourceType: "pdf" },
    contextLocation: { page: 3 },
  });
  assert.equal(msg.text, "factual");
  assert.ok(Object.keys(msg.context).every((k) => ["nearbyText", "sentence", "sourceType"].includes(k)), "context fields whitelisted");
  assert.equal(msg.context.sentence, RAG);
  assert.equal(msg.context.sourceType, "pdf");
  assert.doesNotMatch(JSON.stringify(msg), /papers\.example|rag\.pdf|RAG survey/, "EXPLAIN carries no title or URL");

  env.deliver({
    type: "SHOW_RESULT",
    queryId: msg.queryId,
    queryType: "word",
    data: { queryType: "word", term: "factual", short_meaning: "事实的", meaning_here: "与事实相符的" },
  });
  env.panel().querySelector(".zeh-panel-footer .mk-btn:nth-child(2)").dispatchEvent({ type: "click", stopPropagation() {} });
  const [{ message: add }] = env.messages("ADD_VOCAB");
  assert.equal(add.item.sourceType, "pdf");
  assert.equal(add.item.context_sentence, RAG);
  assert.equal(add.item.pageUrl, "https://papers.example.test/rag.pdf");
  assert.deepEqual(plain(add.item.pdf), { title: "RAG survey", fileName: "rag.pdf", url: "https://papers.example.test/rag.pdf", page: 3 });
});

test("lookup: malformed or oversized snapshots are ignored (dictionary only, no crash)", () => {
  const scan = SCAN;
  const bad = [
    { kind: "snapshot", text: "", start: 0, end: 1 },
    { kind: "snapshot", text: "factual words here", start: 5, end: 2 },
    { kind: "snapshot", text: "factual words here", start: 0, end: 99 },
    { kind: "snapshot", text: "factual words here", start: "0", end: 7 },
    { kind: "snapshot", text: `${"x ".repeat(scan + 10)}factual${" y".repeat(scan + 10)}`, start: 2 * scan + 20, end: 2 * scan + 27 },
  ];
  for (const contextSource of bad) {
    const env = pdfController();
    const msg = lookUpSnapshot(env, { text: "factual", source: "pdf-selection-bubble", contextSource });
    assert.equal(msg.text, "factual");
    assert.equal(msg.context, undefined, JSON.stringify(contextSource).slice(0, 60));
    disposeLookupControllers();
  }
});

// ── storage: sanitizing and the review model keep only a safe pdf source ─────

test("vocab: the pdf source is sanitized (no query, fragment, credentials or local addresses) and bounded", () => {
  const c = loadConfig();
  const out = c.zehSanitizeVocabContextFields({
    sourceType: "pdf",
    pdf: {
      title: "  A   title\u0000 ",
      fileName: "x".repeat(400),
      page: 12,
      url: "https://user:pw@cdn.example.test/files/paper.pdf?X-Amz-Signature=abc&token=1#page=4",
      extra: "dropped",
    },
  });
  assert.equal(out.sourceType, "pdf");
  assert.deepEqual(plain(out.pdf), { title: "A title", fileName: "x".repeat(200), page: 12, url: "https://cdn.example.test/files/paper.pdf" });
  for (const url of ["file:///C:/Users/me/paper.pdf", "blob:chrome-extension://id/1", "data:application/pdf;base64,AAAA", "javascript:alert(1)", "not a url"]) {
    assert.equal(c.zehSanitizeVocabPdf({ url }), null, url);
  }
  assert.equal(c.zehSanitizeVocabPdf({ page: 0 }), null);
  assert.equal(c.zehSanitizeVocabPdf({ page: 1.5 }), null);
  assert.equal(c.zehSanitizeVocabPdf([1]), null);
  assert.equal(c.zehSanitizeVocabContextFields({ pdf: "nope" }).pdf, undefined);
  assert.equal(c.zehSanitizePdfSourceUrl(`https://a.test/${"p".repeat(2100)}`), "");
});

test("vocab: the review model keeps the pdf source on the saved context", () => {
  const ctx = loadConfig();
  runFile(ctx, "vocab-review.js");
  assert.ok(evalIn(ctx, "ZEH_VOCAB_FLAT_CONTEXT_KEYS").includes("pdf"));
  assert.ok(evalIn(ctx, "ZEH_VOCAB_ENRICHABLE_CONTEXT_KEYS").includes("pdf"));
  const built = ctx.zehBuildVocabContext(
    { context_sentence: RAG, sourceType: "pdf", pageTitle: "RAG survey", pdf: { title: "RAG survey", page: 2 } },
    Date.now()
  );
  assert.deepEqual(plain(built.pdf), { title: "RAG survey", page: 2 });
  assert.equal(built.sourceType, "pdf");
});

test("vocab: the vocabulary list names a PDF source as title · page", async () => {
  const onChanged = createEvent();
  const page = await loadSettingsPage({ local: createStorageArea({}, { onChanged }), onChanged, sendMessage: async () => undefined });
  const label = (item) => page.evalIn(`formatVocabSourceLabel(${JSON.stringify(item)})`);
  assert.equal(label({ pdf: { title: "RAG survey", page: 4 }, pageTitle: "ignored" }), "RAG survey · 第 4 页");
  assert.equal(label({ pdf: { fileName: "rag.pdf" } }), "rag.pdf");
  assert.equal(label({ pdf: { page: 2 } }), "PDF · 第 2 页");
  assert.equal(label({ pageTitle: "A web page" }), "A web page");
  assert.equal(label({ book: { title: "River Tales", chapterTitle: "Chapter 3" }, pdf: { title: "x" } }), "River Tales · Chapter 3");
});

// ── the reader page wires the shared controller ──────────────────────────────

test("reader page: one shared lookup controller, a layout model per rendered page, reset and cleanup", async () => {
  const env = loadPdfReaderPage();
  await env.app.ready;
  const lookup = env.app.lookup;
  assert.ok(lookup, "lookup adapter created");
  assert.equal(typeof env.window.MKLookup.createController, "function");
  assert.equal(env.window.MKLookupControllerCount ?? null, null, "no extra controller registry");

  // a rendered page: real text content from the fixture, a text layer whose spans match it
  const [{ tc }] = await models("single-column.pdf");
  const layer = env.document.createElement("div");
  layer.className = "textLayer";
  for (const it of tc.items) {
    if (typeof it.str !== "string" || it.str === "") continue;
    const span = env.document.createElement("span");
    span.setAttribute("role", "presentation");
    span.textContent = it.str;
    layer.appendChild(span);
  }
  const pageView = { pdfPage: { view: [0, 0, 612, 792], getTextContent: async () => tc }, textLayer: { div: layer } };
  await env.app.onTextLayerRendered(pageView, 1);
  assert.equal(lookup.modelCount, 1);
  assert.ok(lookup.modelFor(1).blocks.length > 1);

  await env.app.closeDocument();
  assert.equal(lookup.modelCount, 0, "models dropped with the document");
  env.app.destroy();
  assert.equal(lookup.modelCount, 0);
});
