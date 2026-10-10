/**
 * R-22: content.js must not read the selection, repair it, or scan the whole DOM
 * while Manekilex is disabled, and a plain caret move must not trigger the
 * full-document iframe / shadow-root scan.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadContentScript,
  disposeLookupControllers,
  createRange,
  createSelection,
} = require("./helpers/fake-dom");
const { sleep } = require("./helpers/extension-sandbox");

test.afterEach(() => disposeLookupControllers());

const SELECTION_EVENTS = ["selectionchange", "pointerup", "mouseup", "select"];

function fullScans(env) {
  return env.document.queryLog.filter((s) => s === "*" || s === "iframe").length;
}

async function fireSelectionEvents(env) {
  SELECTION_EVENTS.forEach((type) => env.fire(type));
  await sleep(220); // past the selectionchange debounce and the aggressive-mode retries
}

test("R-22: disabled — selection events do no selection reads, scans or key requests", async () => {
  const env = loadContentScript({ storage: { zehManekilexEnabled: false } });
  await sleep(5); // initial enabled-flag read
  assert.equal(env.window.MKLookup.isGlobalEnabled(), false);

  env.selectText("Please look upward now", 7, 14);
  await fireSelectionEvents(env);
  env.clearSelection();
  await fireSelectionEvents(env);

  assert.equal(env.selectionReads(), 0, "getSelectionInfo never called");
  assert.equal(fullScans(env), 0, 'no querySelectorAll("*") / iframe scan');
  assert.equal(env.messages("GET_DICT_KEY_LIST").length, 0);
  assert.equal(env.controller.hasTrigger(), false);
});

test("R-22: re-enabling restores the bubble on the next selection", async () => {
  const env = loadContentScript({ storage: { zehManekilexEnabled: false } });
  await sleep(5);
  env.setEnabled(true);

  env.selectText("The committee postponed the vote.", 4, 13);
  env.fire("pointerdown");
  env.fire("pointerup");
  await sleep(60);
  assert.ok(env.selectionReads() > 0);
  assert.equal(env.controller.hasTrigger(), true);
  assert.equal(env.controller.getPendingLookupText(), "committee");
});

test("R-22: disabling while a selection is pending stops the delayed work", async () => {
  const env = loadContentScript();
  await sleep(5);
  env.selectText("The committee postponed the vote.", 4, 13);
  env.fire("selectionchange");
  env.setEnabled(false);
  const reads = env.selectionReads();
  await sleep(220);
  assert.equal(env.selectionReads(), reads, "debounced handler bails out once disabled");
  assert.equal(env.controller.hasTrigger(), false);
});

test("R-22: a caret move (collapsed selection) skips the full-document scan", async () => {
  const env = loadContentScript();
  await sleep(5);
  env.placeCaret();
  for (let i = 0; i < 5; i += 1) env.fire("selectionchange"); // typing
  env.fire("pointerup"); // a plain click
  await sleep(220);
  assert.ok(env.selectionReads() > 0, "selection is still read while enabled");
  assert.equal(fullScans(env), 0);
});

test("R-22: with no selection in this document the iframe fallback still runs", async () => {
  const env = loadContentScript();
  await sleep(5);

  // A same-origin child frame that holds the real selection (e.g. an about:blank editor).
  const childDoc = new env.document.constructor();
  const p = childDoc.createElement("p");
  const node = childDoc.createTextNode("Inside the frame we postponed it.");
  p.appendChild(node);
  childDoc.body.appendChild(p);
  const childWin = {
    document: childDoc,
    getSelection: () => createSelection(createRange(node, 20, node, 29)),
  };
  const iframe = env.document.createElement("iframe");
  iframe.contentWindow = childWin;
  env.document.body.appendChild(iframe);

  env.clearSelection(); // rangeCount === 0 in the top document
  const info = env.controller.getSelectionInfo();
  assert.ok(fullScans(env) > 0, "deep probe still scans for frames");
  assert.equal(info?.text, "postponed");
});

test("R-22: a caret in the top document still finds the selection of a focused iframe", async () => {
  const env = loadContentScript();
  await sleep(5);
  const childDoc = new env.document.constructor();
  const node = childDoc.createTextNode("We postponed it.");
  childDoc.body.appendChild(node);
  const iframe = env.document.createElement("iframe");
  iframe.contentWindow = {
    document: childDoc,
    getSelection: () => createSelection(createRange(node, 3, node, 12)),
  };
  env.document.body.appendChild(iframe);

  env.placeCaret(); // the top document keeps an old caret …
  env.document.activeElement = iframe; // … while focus is inside the frame
  const info = env.controller.getSelectionInfo();
  assert.equal(info?.text, "postponed");
  assert.equal(fullScans(env), 0, "found through the focused frame, no full scan");
});

test("F1: selecting inside <input type=password> shows no bubble and sends nothing", async () => {
  const env = loadContentScript();
  await sleep(5);
  const field = env.document.createElement("input");
  field.type = "password";
  field.value = "hunter2 serendipity secret";
  field.selectionStart = field.value.indexOf("serendipity");
  field.selectionEnd = field.selectionStart + "serendipity".length;
  env.document.body.appendChild(field);
  env.document.activeElement = field;
  env.fire("pointerdown", { target: field });
  env.fire("pointerup", { target: field });
  env.fire("select", { target: field });
  env.fire("selectionchange");
  await sleep(220);
  assert.equal(env.controller.hasTrigger(), false, "no bubble for a password field");
  assert.equal(env.explainRequests().length, 0, "no EXPLAIN request");
  const leaked = env.sent.filter((s) => JSON.stringify(s.message).includes("serendipity"));
  assert.deepEqual(leaked, [], "the password value never leaves the page");
});
