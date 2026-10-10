/**
 * 0.11.1: natural-language sentences inside PRE / CODE get bounded context (the selected line's
 * sentence only, never neighbouring lines); real code lines and code terms get none.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadConfig } = require("./helpers/extension-sandbox");
const {
  createRange,
  createSelection,
  loadLookupController,
  disposeLookupControllers,
} = require("./helpers/fake-dom");

test.afterEach(() => disposeLookupControllers());

const cfg = loadConfig();
const plain = (value) => JSON.parse(JSON.stringify(value));

const CODE_BLOCK = [
  "The bank approved my loan.",
  "We sat on the bank of the river.",
  "const bank = accounts.get(id);",
  "// The bank closed early today.",
].join("\n");

function buildInCode(text, term, occurrence) {
  let at = -1;
  for (let i = 0; i <= (occurrence || 0); i += 1) at = text.indexOf(term, at + 1);
  assert.ok(at >= 0);
  return cfg.zehBuildLookupContext({
    text,
    selectionStart: at,
    selectionEnd: at + term.length,
    term,
    queryType: cfg.zehDetectQueryType(term),
    inCode: true,
  });
}

test("code-line detector: prose stays prose, real code is code", () => {
  const prose = [
    "The bank approved my loan.",
    "We sat on the bank of the river.",
    "For example, the class will return tomorrow.",
    "The bank (a big one) approved it.",
  ];
  const code = [
    "const bank = accounts.get(id);",
    "foo.bar()",
    "return bank;",
    "if (bank) {",
    "x => x + 1",
    '<div class="bank">',
    "bank_account approved by the manager today",
    "import bank from river",
  ];
  prose.forEach((line) => assert.equal(cfg.zehLooksLikeCodeLine(line), false, line));
  code.forEach((line) => assert.equal(cfg.zehLooksLikeCodeLine(line), true, line));
  assert.equal(cfg.zehStripCodeCommentMarkers("// The bank closed early today."), "The bank closed early today.");
  assert.equal(cfg.zehStripCodeCommentMarkers("/* We sat on the bank. */"), "We sat on the bank.");
  assert.equal(cfg.zehStripCodeCommentMarkers("# We sat on the bank."), "We sat on the bank.");
});

test("PRE/CODE: each English line gets its own sentence, no neighbouring lines, different cache keys", () => {
  const loan = buildInCode(CODE_BLOCK, "bank", 0);
  const river = buildInCode(CODE_BLOCK, "bank", 1);
  assert.deepEqual(plain(loan), { sentence: "The bank approved my loan.", sourceType: "web" });
  assert.deepEqual(plain(river), { sentence: "We sat on the bank of the river.", sourceType: "web" });
  assert.notEqual(cfg.zehLookupContextHash(loan), cfg.zehLookupContextHash(river));
  assert.notEqual(
    cfg.zehContextCacheStorageKey("word", "bank", loan),
    cfg.zehContextCacheStorageKey("word", "bank", river)
  );
  // the enhancement request for each carries only its own sentence
  const loanReq = JSON.parse(cfg.zehBuildContextEnhanceRequest("bank", "word", loan, "银行").userText);
  const riverReq = JSON.parse(cfg.zehBuildContextEnhanceRequest("bank", "word", river, "银行").userText);
  assert.equal(loanReq.sentence, "The bank approved my loan.");
  assert.equal(riverReq.sentence, "We sat on the bank of the river.");
  assert.equal(loanReq.nearby, undefined);
  assert.equal(riverReq.nearby, undefined);
});

test("PRE/CODE: a real code line gives no context; a comment line is read as prose", () => {
  assert.equal(buildInCode(CODE_BLOCK, "bank", 2), null);
  assert.equal(buildInCode(CODE_BLOCK, "accounts"), null);
  assert.deepEqual(plain(buildInCode(CODE_BLOCK, "bank", 3)), {
    sentence: "The bank closed early today.",
    sourceType: "web",
  });
  // code-shaped selections are code_term lookups: never any context
  assert.equal(cfg.zehDetectQueryType("foo.bar()"), "code_term");
  assert.equal(cfg.zehDetectQueryType("accounts.get"), "code_term");
  assert.equal(
    cfg.zehBuildLookupContext({
      text: "foo.bar() is called here every time.",
      selectionStart: 0,
      selectionEnd: 9,
      term: "foo.bar()",
      queryType: "code_term",
    }),
    null
  );
});

// ── page side (mk-lookup.js) ────────────────────────────────────────────────

function el(document, tag, children) {
  const node = document.createElement(tag);
  (children || []).forEach((c) => node.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
  return node;
}

function lookUp(env, node, word, occurrence) {
  let at = -1;
  for (let i = 0; i <= (occurrence || 0); i += 1) at = node.textContent.indexOf(word, at + 1);
  env.setSelection(createSelection(createRange(node, at, node, at + word.length)));
  const info = env.controller.getSelectionInfo();
  env.controller.presentTrigger({ ...info, releaseX: 40, releaseY: 30 });
  const trigger = env.document.querySelector(".zeh-trigger");
  assert.ok(trigger, "bubble shown");
  trigger.dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  const msg = env.explainRequests().at(-1).message;
  env.controller.closePanel?.();
  return msg;
}

function controller() {
  return loadLookupController({ controllerOptions: { aggressiveBubbleMode: true } });
}

test("page: words in a PRE > CODE block get the selected line's sentence; code lines get none", () => {
  const cases = [
    { occurrence: 0, expected: "The bank approved my loan." },
    { occurrence: 1, expected: "We sat on the bank of the river." },
    { occurrence: 2, expected: undefined },
  ];
  for (const c of cases) {
    const env = controller();
    const d = env.document;
    d.body.appendChild(el(d, "p", ["Unrelated prose before the block mentions secrets."]));
    const code = el(d, "code", [CODE_BLOCK]);
    const pre = el(d, "pre", [el(d, "div", ["text Copy code"]), code]);
    d.body.appendChild(pre);
    d.body.appendChild(el(d, "p", ["Unrelated prose after the block."]));
    const msg = lookUp(env, code.children[0], "bank", c.occurrence);
    assert.equal(msg.text, "bank");
    assert.equal(msg.queryType, "word");
    assert.equal(msg.context?.sentence, c.expected, `occurrence ${c.occurrence}`);
    if (msg.context) assert.equal(msg.context.nearbyText, undefined, "never the whole block");
    assert.doesNotMatch(JSON.stringify(msg), /secrets|Unrelated|Copy code|accounts/);
  }
});

test("page: inline <code> inside a paragraph never borrows the paragraph as context", () => {
  const env = controller();
  const d = env.document;
  const p = el(d, "p", ["Call the ", el(d, "code", ["bank"]), " helper before you approve the loan."]);
  d.body.appendChild(p);
  const msg = lookUp(env, p.children[1].children[0], "bank");
  assert.equal(msg.text, "bank");
  assert.equal(msg.context, undefined);
});

test("page: ordinary paragraphs keep their Phase 3 context unchanged", () => {
  const env = controller();
  const d = env.document;
  const p = el(d, "p", ["We sat on the bank of the river. The water was cold."]);
  d.body.appendChild(p);
  const msg = lookUp(env, p.children[0], "bank");
  assert.deepEqual(plain(msg.context), {
    sentence: "We sat on the bank of the river.",
    sourceType: "web",
    nearbyText: "We sat on the bank of the river. The water was cold.",
  });
});
