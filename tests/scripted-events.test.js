/**
 * Batch 6: the cat and its panel live in the web page's own DOM, so the page can dispatch events on
 * them. An event the page made up (isTrusted === false) must not look a word up with the user's
 * provider key, save a word or open settings; real input still does. Verified in Chrome 155 before
 * the fix: a page script that selected its own text and called cat.click() caused a provider
 * request and could read the result from the panel.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRange, createSelection, loadLookupController, disposeLookupControllers } = require("./helpers/fake-dom");

test.afterEach(() => disposeLookupControllers());

const event = (type, isTrusted) => ({ type, isTrusted, preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });

function presentCat(env) {
  const text = "The committee will deliberate before it decides anything.";
  const p = env.document.createElement("p");
  const node = env.document.createTextNode(text);
  p.appendChild(node);
  env.document.body.appendChild(p);
  const at = text.indexOf("deliberate");
  env.setSelection(createSelection(createRange(node, at, node, at + "deliberate".length)));
  env.controller.presentTrigger({ ...env.controller.getSelectionInfo(), releaseX: 40, releaseY: 30 });
  return env.document.querySelector(".zeh-trigger");
}

test("scripted events: a page-made click or pointerup on the cat starts no lookup; a real one does", () => {
  const env = loadLookupController({ controllerOptions: { aggressiveBubbleMode: true } });
  const cat = presentCat(env);
  cat.dispatchEvent(event("pointerup", false));
  cat.dispatchEvent(event("click", false));
  assert.equal(env.explainRequests().length, 0, "no EXPLAIN for scripted events");
  assert.ok(env.document.querySelector(".zeh-trigger"), "the cat is still there for the user");

  cat.dispatchEvent(event("click", true));
  assert.equal(env.explainRequests().length, 1);
  assert.equal(env.explainRequests()[0].message.text, "deliberate");
});

test("scripted events: the panel's 加入生词本 and settings buttons ignore page-made clicks", () => {
  const env = loadLookupController({ controllerOptions: { aggressiveBubbleMode: true } });
  presentCat(env).dispatchEvent(event("click", true));
  const { message, cb } = env.explainRequests()[0];
  env.deliver({
    type: "SHOW_RESULT",
    queryId: message.queryId,
    queryType: "word",
    durationMs: 0,
    fromDict: true,
    data: { queryType: "word", term: "deliberate", short_meaning: "故意的；深思熟虑", examples: [] },
  });
  if (typeof cb === "function") cb({ ok: true });

  const vocab = env.panel().querySelector(".zeh-panel-footer .mk-btn:nth-child(2)");
  const settings = env.panel().querySelector(".zeh-panel-settings");
  vocab.dispatchEvent(event("click", false));
  settings.dispatchEvent(event("click", false));
  assert.equal(env.messages("ADD_VOCAB").length, 0, "no ADD_VOCAB for a scripted click");
  assert.equal(env.messages("OPEN_SETTINGS").length, 0, "no OPEN_SETTINGS for a scripted click");

  vocab.dispatchEvent(event("click", true));
  settings.dispatchEvent(event("click", true));
  assert.equal(env.messages("ADD_VOCAB").length, 1);
  assert.equal(env.messages("ADD_VOCAB")[0].message.item.term, "deliberate");
  assert.equal(env.messages("OPEN_SETTINGS").length, 1);
});
