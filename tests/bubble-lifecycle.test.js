/**
 * 0.11.1 selection bubble lifecycle (content.js + mk-lookup.js on the fake DOM):
 * repeated lookups, OFF → ON, bfcache restore, SPA body replacement, streamed content,
 * textarea / input[type=text|search], idempotent bootstrap, pointer state that used to get
 * stuck, and an invalidated (reloaded) extension that now tells the user to refresh.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadContentScript, disposeLookupControllers } = require("./helpers/fake-dom");
const vm = require("node:vm");
const { runFile, sleep, waitFor } = require("./helpers/extension-sandbox");

test.afterEach(() => disposeLookupControllers());

const triggers = (env) => env.document.querySelectorAll(".zeh-trigger");

async function boot(options) {
  const env = loadContentScript(options);
  await sleep(5); // enabled flag read
  return env;
}

/** Mouse-select [word] inside a fresh paragraph and release; returns after the bubble timers. */
async function mouseSelect(env, text, word, at) {
  const start = text.indexOf(word);
  env.selectText(text, start, start + word.length);
  env.fire("pointerdown", at);
  env.fire("pointerup", at);
  await sleep(60);
}

/** Pointer position away from the fake 120×60 element rects (so it is not "over the bubble"). */
const ELSEWHERE = { clientX: 600, clientY: 400 };

/** Click the bubble (it becomes clickable shortly after it appears) and return the EXPLAIN. */
async function clickBubble(env) {
  const [trigger] = triggers(env);
  assert.ok(trigger, "bubble shown");
  const before = env.explainRequests().length;
  trigger.dispatchEvent({ type: "click", preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} });
  await waitFor(() => env.explainRequests().length > before, 2000, "EXPLAIN sent");
  return env.explainRequests().at(-1).message;
}

function answer(env, message) {
  env.deliver({
    type: "SHOW_RESULT",
    queryId: message.queryId,
    queryType: "word",
    durationMs: 0,
    fromDict: true,
    data: { queryType: "word", term: message.text, short_meaning: "释义" },
  });
}

test("three words in a row on the same page, no refresh: one bubble each time, new queryIds", async () => {
  const env = await boot();
  const ids = new Set();
  for (const word of ["committee", "postponed", "decision"]) {
    await mouseSelect(env, "The committee postponed the decision until Friday.", word);
    assert.equal(triggers(env).length, 1, `exactly one bubble for ${word}`);
    const msg = await clickBubble(env);
    assert.equal(msg.text, word);
    ids.add(msg.queryId);
    answer(env, msg);
    assert.equal(env.controller.hasPanel(), true);
    env.fire("keydown", { key: "Escape" }); // Esc closes the panel
    assert.equal(env.controller.hasPanel(), false);
    await sleep(380); // past the bubble's double-activation guard
  }
  assert.equal(ids.size, 3);
});

test("a fast dictionary / cache answer is not closed by the mouseup of the same bubble click", async () => {
  // Chromium: the bubble is removed on pointerup, so the click's mouseup lands on <body>. That
  // mouseup used to count as a new selection: if SHOW_RESULT had already arrived (dictionary or
  // cache hit), the fresh panel was closed and the bubble came back ("needs another click").
  const env = await boot();
  for (const word of ["committee", "postponed", "decision"]) {
    await mouseSelect(env, "The committee postponed the decision until Friday.", word, ELSEWHERE);
    await sleep(380); // the bubble becomes clickable
    const [trigger] = triggers(env);
    assert.ok(trigger, `bubble for ${word}`);
    const stop = { preventDefault() {}, stopPropagation() {}, stopImmediatePropagation() {} };
    trigger.dispatchEvent({ type: "pointerdown", button: 0, ...stop });
    trigger.dispatchEvent({ type: "pointerup", button: 0, ...stop });
    const msg = env.explainRequests().at(-1).message;
    assert.equal(msg.text, word);
    answer(env, msg); // instant dictionary hit
    env.fire("mouseup", { target: env.document.body, ...ELSEWHERE });
    await sleep(80);
    assert.equal(env.controller.hasPanel(), true, `panel for ${word} stays open`);
    assert.equal(triggers(env).length, 0, "no bubble comes back");
    env.fire("keydown", { key: "Escape" });
    await sleep(380);
  }
});

test("OFF → ON without a refresh: the next selection shows the bubble and looks up", async () => {
  const env = await boot();
  env.setEnabled(false);
  await mouseSelect(env, "The bank approved my loan.", "bank");
  assert.equal(triggers(env).length, 0);
  env.setEnabled(true);
  await mouseSelect(env, "We sat on the bank of the river.", "river");
  assert.equal(triggers(env).length, 1);
  assert.equal((await clickBubble(env)).text, "river");
});

test("back / forward cache: pagehide(persisted) then pageshow(persisted) keeps one working controller", async () => {
  const env = await boot();
  await mouseSelect(env, "The bank approved my loan.", "bank");
  env.window.dispatchEvent({ type: "pagehide", persisted: true });
  assert.equal(triggers(env).length, 0, "state cleared on the way into bfcache");
  env.window.dispatchEvent({ type: "pageshow", persisted: true });
  await sleep(5);
  await mouseSelect(env, "We sat on the bank of the river.", "river");
  assert.equal(triggers(env).length, 1, "no duplicate bubble");
  assert.equal((await clickBubble(env)).text, "river");
});

test("SPA navigation that replaces <body>: the bubble mounts on the live body", async () => {
  const env = await boot();
  await mouseSelect(env, "First page text about the committee.", "committee");
  assert.equal(triggers(env).length, 1);
  env.fire("pointerdown"); // leave the page

  const d = env.document;
  const oldBody = d.body;
  oldBody.remove();
  const newBody = d.createElement("body");
  d.documentElement.appendChild(newBody);
  d.body = newBody;

  await mouseSelect(env, "Second route mentions a different decision.", "decision", ELSEWHERE);
  const shown = triggers(env);
  assert.equal(shown.length, 1, "bubble visible in the connected document");
  assert.equal(shown[0].parentElement, newBody);
  assert.equal((await clickBubble(env)).text, "decision");
});

test("streamed content added after load (ChatGPT replies) is selectable without a refresh", async () => {
  const env = await boot({});
  const reply = env.document.createElement("div");
  env.document.body.appendChild(reply);
  for (let i = 0; i < 3; i += 1) {
    const p = env.document.createElement("p");
    p.appendChild(env.document.createTextNode(`Streamed chunk ${i} explains the serendipity of it.`));
    reply.appendChild(p);
  }
  await mouseSelect(env, "A brand new streamed answer about serendipity.", "serendipity");
  assert.equal(triggers(env).length, 1);
  assert.equal((await clickBubble(env)).text, "serendipity");
});

test("textarea, input[type=text] and input[type=search] (normal search boxes, chat composers)", async () => {
  for (const [tag, type] of [["textarea"], ["input", "text"], ["input", "search"]]) {
    const env = await boot();
    const field = env.document.createElement(tag);
    if (type) field.type = type;
    field.value = "Please explain the word ubiquitous in this sentence.";
    field.selectionStart = field.value.indexOf("ubiquitous");
    field.selectionEnd = field.selectionStart + "ubiquitous".length;
    env.document.body.appendChild(field);
    env.document.activeElement = field;
    env.fire("pointerdown", { target: field });
    env.fire("pointerup", { target: field });
    await sleep(60);
    assert.equal(triggers(env).length, 1, `${tag}${type ? `[${type}]` : ""}`);
    assert.equal((await clickBubble(env)).text, "ubiquitous");
    disposeLookupControllers();
  }
});

test("running content.js twice in the same page adds no second set of listeners", async () => {
  const env = await boot();
  const before = {
    messages: env.onMessageListenerCount(),
    pointerup: env.document.listenerCount("pointerup"),
    selectionchange: env.document.listenerCount("selectionchange"),
  };
  runFile(env.context, "content.js");
  assert.equal(env.onMessageListenerCount(), before.messages);
  assert.equal(env.document.listenerCount("pointerup"), before.pointerup);
  assert.equal(env.document.listenerCount("selectionchange"), before.selectionchange);
  await mouseSelect(env, "The committee postponed the vote.", "committee");
  assert.equal(triggers(env).length, 1, "still exactly one bubble");
});

test("a right-click no longer leaves the page 'still selecting': keyboard selections show the bubble", async () => {
  const env = await boot();
  env.fire("pointerdown", { button: 2 });
  env.fire("pointerup", { button: 2 });
  const text = "Shift+arrow keys select the word meticulous here.";
  env.selectText(text, text.indexOf("meticulous"), text.indexOf("meticulous") + "meticulous".length);
  env.fire("selectionchange");
  await sleep(120);
  assert.equal(triggers(env).length, 1);
  assert.equal((await clickBubble(env)).text, "meticulous");
});

test("a drag released outside the window recovers once the stale pointer state expires", async () => {
  const env = await boot();
  const PageDate = vm.runInContext("Date", env.context);
  const realNow = PageDate.now;
  try {
    env.fire("pointerdown"); // no pointerup: released outside the window
    const text = "Keyboard selection of the word ephemeral later on.";
    env.selectText(text, text.indexOf("ephemeral"), text.indexOf("ephemeral") + "ephemeral".length);
    env.fire("selectionchange");
    await sleep(120);
    assert.equal(triggers(env).length, 0, "still considered a drag right away");
    const shifted = realNow() + 9000;
    PageDate.now = () => shifted;
    env.fire("selectionchange");
    await sleep(120);
    assert.equal(triggers(env).length, 1);
  } finally {
    PageDate.now = realNow;
  }
});

test("a page error that merely mentions 'invalidated' does not disable a live extension", async () => {
  const env = await boot();
  env.window.dispatchEvent({ type: "error", message: "Extension context invalidated (from another extension)", preventDefault() {} });
  await mouseSelect(env, "The bank approved my loan.", "bank");
  assert.equal(triggers(env).length, 1);
  assert.equal(env.hasRefreshBanner(), false);
});

test("after an extension reload the old tab says 'refresh' on the next selection (no silent failure)", async () => {
  const env = await boot();
  env.runtime.getManifest = () => {
    throw new Error("Extension context invalidated.");
  };
  await mouseSelect(env, "The bank approved my loan.", "bank");
  assert.equal(triggers(env).length, 0, "the dead script cannot look anything up");
  assert.equal(env.hasRefreshBanner(), true, "the user is told to refresh this tab");
  assert.equal(env.explainRequests().length, 0);
  await mouseSelect(env, "We sat on the bank of the river.", "river");
  assert.equal(env.document.querySelectorAll(".zeh-refresh-banner").length, 1, "banner shown once");
});
