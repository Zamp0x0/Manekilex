/**
 * Phase 3: capturing the sentence around a selected word / phrase.
 * Pure helpers (config.js) plus the page side (mk-lookup.js) on the fake DOM:
 * normal pages, inline markup, input / textarea, same-origin frames, EPUB-style
 * external documents, and the EXPLAIN payload that leaves the page.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("./helpers/extension-sandbox");
const {
  FakeDocument,
  createRange,
  createSelection,
  loadLookupController,
  disposeLookupControllers,
} = require("./helpers/fake-dom");

test.afterEach(() => disposeLookupControllers());

const cfg = loadConfig();
/** Values built inside the vm sandbox have another realm's prototypes; compare as plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function build(text, term, { queryType = "word", occurrence = 0, sourceType } = {}) {
  let at = -1;
  for (let i = 0; i <= occurrence; i += 1) at = text.indexOf(term, at + 1);
  assert.ok(at >= 0, `fixture must contain ${term}`);
  return cfg.zehBuildLookupContext({
    text,
    selectionStart: at,
    selectionEnd: at + term.length,
    term,
    queryType,
    sourceType,
  });
}

// ── pure extraction (config.js) ──────────────────────────────────────────────

test("normal sentence: the sentence around the word, plus neighbours when it is short", () => {
  const ctx = build("We sat on the bank of the river. The water was cold.", "bank");
  assert.equal(ctx.sentence, "We sat on the bank of the river.");
  assert.equal(ctx.nearbyText, "We sat on the bank of the river. The water was cold.");
  assert.equal(ctx.sourceType, "web");
});

test("word in the middle sentence of a paragraph", () => {
  const ctx = build(
    "My salary arrived on Friday. The bank approved my loan. Then I bought a car.",
    "bank"
  );
  assert.equal(ctx.sentence, "The bank approved my loan.");
  assert.equal(
    ctx.nearbyText,
    "My salary arrived on Friday. The bank approved my loan. Then I bought a car."
  );
});

test("word at the very beginning and at the very end of the text", () => {
  const start = build("Bank holidays are great for everyone. Shops close early.", "Bank");
  assert.equal(start.sentence, "Bank holidays are great for everyone.");

  const end = build("Yesterday they walked slowly along the bank", "bank");
  assert.equal(end.sentence, "Yesterday they walked slowly along the bank");
  assert.equal(end.nearbyText, undefined, "nothing else to add");
});

test("punctuation: ! ? quotes, abbreviations, initials and decimals", () => {
  assert.equal(build("Is the bank open today? I need cash.", "bank").sentence, "Is the bank open today?");
  assert.equal(build("Wow! The bank collapsed overnight! Nobody saw it.", "bank").sentence, "The bank collapsed overnight!");
  assert.equal(
    build('She said, "The bank is closed." Then she left.', "bank").sentence,
    'She said, "The bank is closed."'
  );
  assert.equal(
    build("Dr. Smith went to the bank on Monday. It was closed.", "bank").sentence,
    "Dr. Smith went to the bank on Monday."
  );
  assert.equal(
    build("J. K. Rowling visited the bank in town. Fans waited.", "bank").sentence,
    "J. K. Rowling visited the bank in town."
  );
  assert.equal(
    build("Rates rose 3.5 percent at the bank this week. Savers cheered.", "bank").sentence,
    "Rates rose 3.5 percent at the bank this week."
  );
  assert.equal(
    build('He shouted "run away!" and then ran to the bank. Later he rested.', "bank").sentence,
    'He shouted "run away!" and then ran to the bank.'
  );
});

test("a newline (block boundary) ends the sentence: headings are not glued on", () => {
  const ctx = build("Bank\nThe bank approved my loan.", "bank", { occurrence: 0 });
  assert.equal(ctx.sentence, "The bank approved my loan.");
  assert.doesNotMatch(ctx.nearbyText || "", /Bank\s*The/);
  // the heading itself has no context worth sending
  assert.equal(build("Bank\nThe bank approved my loan.", "Bank"), null);
});

test("a phrase gets context too; sentence / paragraph / code lookups never do", () => {
  const text = "Please look up the word before the meeting starts. Thanks.";
  const phrase = build(text, "look up", { queryType: "phrase" });
  assert.equal(phrase.sentence, "Please look up the word before the meeting starts.");
  for (const queryType of ["sentence", "paragraph", "code_term"]) {
    assert.equal(build(text, "look up", { queryType }), null, queryType);
  }
});

test("curly apostrophes in the page still match the selected term", () => {
  const ctx = build("They don’t trust the bank anymore after the crash.", "don’t");
  assert.equal(ctx.sentence, "They don't trust the bank anymore after the crash.");
});

test("a very long sentence is clipped around the word (bounded, with ellipses)", () => {
  const filler = "and the committee kept talking about many unrelated matters ".repeat(20);
  const text = `${filler}until the bank finally approved my loan ${filler}today.`;
  const ctx = build(text, "bank");
  assert.ok(ctx.sentence.length <= 400, `length ${ctx.sentence.length}`);
  assert.match(ctx.sentence, /^\.\.\..*bank finally approved.*\.\.\.$/);
});

test("missing context falls back to null (term absent, too few words, empty)", () => {
  assert.equal(build("Nothing about it here at all, just the bank.", "bank", { queryType: "word" }).sentence.includes("bank"), true);
  assert.equal(
    cfg.zehBuildLookupContext({ text: "No match here at all.", selectionStart: 0, selectionEnd: 2, term: "bank", queryType: "word" }),
    null
  );
  assert.equal(build("The bank.", "bank"), null, "a two-word fragment is not context");
  assert.equal(cfg.zehBuildLookupContext({ text: "", term: "bank", queryType: "word" }), null);
  assert.equal(cfg.zehBuildLookupContext(null), null);
});

// ── validation / bounding (used by both page and service worker) ────────────

test("zehNormalizeLookupContext bounds, whitelists and is idempotent", () => {
  const norm = (raw, term = "bank", qt = "word") => cfg.zehNormalizeLookupContext(raw, term, qt);
  const huge = `${"word ".repeat(300)} the bank approved my loan ${"word ".repeat(3000)}`;
  const big = norm({ sentence: huge, nearbyText: huge + huge, sourceType: "web" });
  assert.ok(big.sentence.length <= 400);
  assert.ok(!big.nearbyText || big.nearbyText.length <= 600);
  assert.match(big.sentence, /the bank approved my loan/);
  // input is hard-capped before any processing: a term past the cap is simply not found
  assert.equal(norm({ sentence: `${"word ".repeat(1000)} the bank approved my loan` }), null);

  const once = norm({
    sentence: "  The\u200b bank\napproved   my loan.\u0007 ",
    nearbyText: "Before. The bank approved my loan. After.",
    sourceType: "epub",
  });
  assert.equal(once.sentence, "The bank approved my loan.");
  assert.equal(once.sourceType, "epub");
  assert.deepEqual(plain(norm(once)), plain(once), "idempotent");
  assert.equal(norm(big).sentence, big.sentence, "idempotent after clipping");

  assert.equal(norm({ sentence: "The bank approved my loan.", sourceType: "evil" }).sourceType, "web");
  assert.equal(norm({ sentence: "The bank approved my loan.", nearbyText: "The bank approved my loan." }).nearbyText, undefined);
  for (const bad of [null, "The bank approved my loan.", ["x"], 42, { sentence: 7 }, { sentence: "" }]) {
    assert.equal(norm(bad), null, JSON.stringify(bad));
  }
  assert.equal(norm({ sentence: "The river was wide and slow." }), null, "term must be in the sentence");
  assert.equal(norm({ sentence: "The bank approved my loan." }, "bank", "sentence"), null);
});

// ── page side: capture through the bubble (mk-lookup.js) ─────────────────────

function el(document, tag, children) {
  const node = document.createElement(tag);
  (children || []).forEach((c) => node.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
  return node;
}

function textNodeContaining(root, needle) {
  const stack = [root];
  while (stack.length) {
    const n = stack.shift();
    if (n.nodeType === 3 && n.textContent.includes(needle)) return n;
    stack.push(...(n.children || []));
  }
  throw new Error(`no text node with ${needle}`);
}

function selectWord(env, node, word) {
  const at = node.textContent.indexOf(word);
  env.setSelection(createSelection(createRange(node, at, node, at + word.length)));
}

function controller(options) {
  return loadLookupController({ ...(options || {}), controllerOptions: { aggressiveBubbleMode: true, ...((options || {}).controllerOptions || {}) } });
}

/** Read the selection, show the bubble, click it; returns the EXPLAIN message. */
function lookUpSelection(env, getInfoOptions, extraTrigger) {
  const info = env.controller.getSelectionInfo(getInfoOptions);
  assert.ok(info && info.text, "selection must be readable");
  env.controller.presentTrigger({ ...info, releaseX: 40, releaseY: 30, ...(extraTrigger ? extraTrigger(info) : {}) });
  const trigger = env.document.querySelector(".zeh-trigger");
  assert.ok(trigger, "bubble shown");
  trigger.dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  const requests = env.explainRequests();
  assert.ok(requests.length, "EXPLAIN sent");
  return requests[requests.length - 1].message;
}

test("page: inline markup around the word is read as one sentence", () => {
  const env = controller();
  const d = env.document;
  const p = el(d, "p", ["Intro line here. We sat on the ", el(d, "b", ["bank"]), " of the ", el(d, "a", ["river"]), ". The water was cold."]);
  d.body.appendChild(p);
  selectWord(env, textNodeContaining(p, "bank"), "bank");
  const msg = lookUpSelection(env);
  assert.equal(msg.text, "bank");
  assert.deepEqual(plain(msg.context), {
    sentence: "We sat on the bank of the river.",
    sourceType: "web",
    nearbyText: "Intro line here. We sat on the bank of the river. The water was cold.",
  });
});

test("page: <br>, other paragraphs and <script> text never leak into the context", () => {
  const env = controller();
  const d = env.document;
  d.body.appendChild(el(d, "p", ["An unrelated paragraph that mentions secrets."]));
  const p = el(d, "p", [
    "Breaking news",
    el(d, "br"),
    "The bank approved my loan",
    el(d, "script", ["var token = 'abc';"]),
    " today.",
  ]);
  d.body.appendChild(p);
  d.body.appendChild(el(d, "p", ["Another unrelated paragraph."]));
  selectWord(env, textNodeContaining(p, "bank"), "bank");
  const msg = lookUpSelection(env);
  assert.equal(msg.context.sentence, "The bank approved my loan today.");
  const sent = JSON.stringify(msg);
  assert.doesNotMatch(sent, /token|secrets|unrelated|Breaking news The/);
});

test("page: textarea and text inputs use selectionStart / selectionEnd", () => {
  for (const tag of ["textarea", "input"]) {
    const env = controller();
    const d = env.document;
    const field = d.createElement(tag);
    if (tag === "input") field.type = "text";
    field.value = "Notes. The bank approved my loan yesterday. Then we celebrated.";
    field.selectionStart = field.value.indexOf("bank");
    field.selectionEnd = field.selectionStart + 4;
    d.body.appendChild(field);
    d.activeElement = field;
    const msg = lookUpSelection(env);
    assert.equal(msg.context.sentence, "The bank approved my loan yesterday.", tag);
    assert.equal(msg.context.sourceType, "field", tag);
    disposeLookupControllers();
  }
});

test("page: email fields are looked up without reading their value as context", () => {
  for (const type of ["email"]) {
    const env = controller();
    const d = env.document;
    const field = d.createElement("input");
    field.type = type;
    field.value = "The bank approved my loan yesterday afternoon.";
    field.selectionStart = field.value.indexOf("bank");
    field.selectionEnd = field.selectionStart + 4;
    d.body.appendChild(field);
    d.activeElement = field;
    const msg = lookUpSelection(env);
    assert.equal(msg.text, "bank");
    assert.equal(msg.context, undefined, type);
    disposeLookupControllers();
  }
});

test("F1: a selection inside a password field is never read (no text, no context)", () => {
  const env = controller();
  const d = env.document;
  const field = d.createElement("input");
  field.type = "password";
  field.value = "The bank approved my loan yesterday afternoon.";
  field.selectionStart = field.value.indexOf("bank");
  field.selectionEnd = field.selectionStart + 4;
  d.body.appendChild(field);
  d.activeElement = field;
  assert.equal(env.controller.isTextInputField(field), false);
  const info = env.controller.getSelectionInfo();
  assert.ok(!info || !info.text, "the password value must not become lookup text");
  const snapshotInfo = env.controller.getSelectionInfo({ fieldSnapshot: { el: field, start: field.selectionStart, end: field.selectionEnd } });
  assert.ok(!snapshotInfo || !snapshotInfo.text, "not even through an explicit field snapshot");
  assert.equal(env.explainRequests().length, 0);
});

test("page: a same-origin frame reads context from its own document", () => {
  const env = controller();
  env.window.top = {}; // the content script runs inside a subframe
  const d = env.document;
  const p = el(d, "p", ["Inside the frame the bank of the river flooded after the storm."]);
  d.body.appendChild(p);
  selectWord(env, p.children[0], "bank");
  const msg = lookUpSelection(env);
  assert.equal(msg.context.sentence, "Inside the frame the bank of the river flooded after the storm.");
  assert.equal(msg.context.sourceType, "iframe");
});

test("EPUB-style external document: context from the book text, location kept on the page only", () => {
  const env = controller({
    controllerOptions: {
      vocabContext: () => ({
        pageUrl: "chrome-extension://test-extension/reader.html?book=7",
        pageTitle: "River Tales",
        book: { id: "7", title: "River Tales", author: "A. Writer" },
      }),
    },
  });
  const bookDoc = new FakeDocument();
  const p = el(bookDoc, "p", ["Chapter text: she rowed to the bank and rested in the shade."]);
  bookDoc.body.appendChild(p);
  const at = p.children[0].textContent.indexOf("bank");
  const sel = createSelection(createRange(p.children[0], at, p.children[0], at + 4));
  const location = { chapterIndex: 2, chapterTitle: "Chapter 3", cfi: "epubcfi(/6/6!/4/2/1:30)" };
  // what reader.js passes to presentTrigger
  const msg = lookUpSelection(
    env,
    { externalSelection: sel, externalDoc: bookDoc, externalWin: { getSelection: () => sel, document: bookDoc } },
    (info) => ({
      range: null,
      source: "epub-selection-bubble",
      contextSource: { ...info.contextSource, sourceType: "epub" },
      contextLocation: location,
    })
  );
  assert.deepEqual(plain(msg.context), {
    sentence: "Chapter text: she rowed to the bank and rested in the shade.",
    sourceType: "epub",
  });
  assert.doesNotMatch(JSON.stringify(msg), /epubcfi|Chapter 3|River Tales|reader\.html/);

  env.deliver({
    type: "SHOW_RESULT",
    queryId: msg.queryId,
    queryType: "word",
    data: { queryType: "word", term: "bank", short_meaning: "岸；银行", meaning_here: "河岸" },
  });
  env.panel().querySelector(".zeh-panel-footer .mk-btn:nth-child(2)").dispatchEvent({ type: "click", stopPropagation() {} });
  const [{ message: add }] = env.messages("ADD_VOCAB");
  assert.equal(add.item.context_sentence, msg.context.sentence);
  assert.equal(add.item.sourceType, "epub");
  assert.deepEqual(plain(add.item.book), { id: "7", title: "River Tales", author: "A. Writer", ...location });
});

test("EXPLAIN carries only sentence / sourceType / nearbyText (no URL, title or page text)", () => {
  const env = controller();
  env.document.title = "Secret dashboard title";
  const d = env.document;
  const p = el(d, "p", ["Before that, the bank approved my loan quickly. Later we left."]);
  d.body.appendChild(p);
  d.body.appendChild(el(d, "p", ["Account number 1234 lives in another block."]));
  selectWord(env, p.children[0], "bank");
  const msg = lookUpSelection(env);
  assert.deepEqual(Object.keys(msg).sort(), ["context", "queryId", "queryType", "text", "type"]);
  assert.deepEqual(Object.keys(msg.context).sort(), ["nearbyText", "sentence", "sourceType"]);
  const sent = JSON.stringify(msg);
  assert.doesNotMatch(sent, /example\.test|Secret dashboard|Account number/);
});

test("sentence lookups, and lookups without a page selection, send no context", () => {
  const env = controller();
  const d = env.document;
  const p = el(d, "p", ["The bank approved my loan after a long review. We were relieved."]);
  d.body.appendChild(p);
  const node = p.children[0];
  env.setSelection(createSelection(createRange(node, 0, node, 46)));
  const sentenceMsg = lookUpSelection(env);
  assert.equal(sentenceMsg.queryType, "sentence");
  assert.equal(sentenceMsg.context, undefined);

  // PDF assistant / side panel path: lookupText(text) has no DOM selection to read
  env.controller.lookupText("bank");
  const last = env.explainRequests().at(-1).message;
  assert.equal(last.text, "bank");
  assert.equal(last.context, undefined);
});
