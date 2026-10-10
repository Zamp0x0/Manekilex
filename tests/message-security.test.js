/**
 * M3b message security, end to end in the real service worker and the real lookup controller.
 *
 * Service worker:
 *   - a message with no route is refused explicitly (UNKNOWN_MESSAGE_TYPE / MALFORMED_MESSAGE),
 *     except the page-bound types (SHOW_RESULT …), which belong to page listeners and stay silent;
 *   - EXPLAIN needs a valid queryId, and a queryType (when sent) must be a real lookup type;
 *     a refused EXPLAIN spends no provider call and sends nothing to the tab;
 *   - lookup results go back to the document that asked (documentId, else frameId), not to every
 *     frame of the tab; extension pages without a tab (side panel, PDF reader) keep the runtime
 *     broadcast, and the tab-level "Manekilex is off" notice still reaches the whole tab.
 * Lookup controller:
 *   - SHOW_RESULT / DICT_ENHANCED / SHOW_ERROR with a queryId render only for the current query;
 *     a missing or null queryId no longer renders;
 *   - a SHOW_ERROR without a queryId (the tab-level notice) still renders.
 * Provider calls are stubbed; no real key or network request is used.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadBackground,
  extensionPageSender,
  contentScriptSender,
  evalIn,
  waitFor,
  sleep,
  openAIChatResponse,
} = require("./helpers/extension-sandbox");
const { loadLookupController, disposeLookupControllers } = require("./helpers/fake-dom");

const WITH_KEY = {
  zehActiveProvider: "deepseek",
  zehProviders: { deepseek: { enabled: true, apiKey: "test-key", model: "" } },
};
const DICTIONARY = {
  bank: { term: "bank", short_meaning: "银行；河岸", part_of_speech: "n.", enriched: true },
};
const FINANCE = { sentence: "The bank approved my loan.", sourceType: "web" };

const PAGE_BOUND = [
  "SHOW_RESULT",
  "SHOW_ERROR",
  "DICT_ENHANCED",
  "CONTEXT_ENHANCED",
  "PDF_PAGE_LOOKUP",
  "PDF_PAGE_COLLAPSE",
  "PDF_PAGE_SUPPRESS",
  "PDF_PAGE_RESTORE",
  "PDF_READER_LOOKUP",
  "TAB_AUDIO_CAPTURE_PENDING",
];

/** Call the real listener once and report its return value, whether it answered synchronously, and the answer. */
function callListener(bg, message, sender) {
  const [listener] = bg.chrome.runtime.onMessage.listeners;
  let answer = "none";
  let calls = 0;
  const returned = listener(message, sender, (payload) => {
    calls++;
    answer = JSON.parse(JSON.stringify(payload));
  });
  return { returned, calls, answer };
}

/** A content script in frame 3 of tab 1 (a cross-origin iframe, say), with its document id. */
const iframeSender = (extra) => ({
  ...contentScriptSender("https://frame.example.test/embed", 1),
  frameId: 3,
  documentId: "DOC-FRAME-3",
  ...(extra || {}),
});

test.afterEach(() => disposeLookupControllers());

// ── Service worker: messages without a route ────────────────────────────────────────────────

test("M3b: unknown and inherited-name types are refused explicitly, once, synchronously", () => {
  const bg = loadBackground();
  for (const type of ["NO_SUCH_TYPE", "toString", "constructor", "__proto__", "hasOwnProperty", "GET_ACTIVE_PROVIDER_INFO"]) {
    for (const sender of [extensionPageSender("settings.html"), iframeSender()]) {
      const r = callListener(bg, { type }, sender);
      assert.equal(r.returned, true, type);
      assert.equal(r.calls, 1, `${type} answered once`);
      assert.deepEqual(r.answer, { ok: false, accepted: false, code: "UNKNOWN_MESSAGE_TYPE" }, type);
    }
  }
});

test("M3b: malformed messages are refused explicitly", () => {
  const bg = loadBackground();
  for (const message of [{ type: 42 }, {}, null, undefined, "EXPLAIN", 7, []]) {
    const r = callListener(bg, message, iframeSender());
    assert.equal(r.returned, true, JSON.stringify(message));
    assert.deepEqual(r.answer, { ok: false, accepted: false, code: "MALFORMED_MESSAGE" }, JSON.stringify(message));
  }
});

test("M3b: page-bound types stay unanswered so they never race the page that handles them", () => {
  const bg = loadBackground();
  const registered = JSON.parse(evalIn(bg.context, "JSON.stringify(Object.keys(ZEH_PAGE_BOUND_MESSAGES).sort())"));
  assert.deepEqual(registered, [...PAGE_BOUND].sort(), "the list below matches the registry");
  for (const type of PAGE_BOUND) {
    for (const sender of [extensionPageSender("pdf-reader.html"), iframeSender()]) {
      const r = callListener(bg, { type, queryId: "q1" }, sender);
      assert.equal(r.returned, false, type);
      assert.equal(r.calls, 0, type);
    }
  }
});

// ── Service worker: EXPLAIN validation ──────────────────────────────────────────────────────

test("M3b: EXPLAIN without a valid queryId is refused before any provider call or tab message", async () => {
  let fetches = 0;
  const bg = loadBackground({ storage: WITH_KEY, fetch: async () => (fetches++, openAIChatResponse("{}")) });
  const bad = [undefined, null, "", 42, {}, "has space", "semi;colon", "x".repeat(81), "q_<script>"];
  for (const queryId of bad) {
    const message = { type: "EXPLAIN", text: "serendipity" };
    if (queryId !== undefined) message.queryId = queryId;
    const r = callListener(bg, message, iframeSender());
    assert.equal(r.returned, true, String(queryId));
    assert.equal(r.calls, 1, `${String(queryId)} answered synchronously`);
    assert.equal(r.answer.accepted, false);
    assert.equal(r.answer.code, "INVALID_QUERY_ID", String(queryId));
    assert.deepEqual(Object.keys(r.answer).sort(), ["accepted", "code", "message"], "same shape as other validation answers");
  }
  await sleep(20);
  assert.equal(fetches, 0, "no provider call");
  assert.equal(bg.tabMessages.length, 0, "nothing sent to the tab");
  assert.equal(bg.runtimeMessages.length, 0, "nothing broadcast");
});

test("M3b: queryIds the lookup controller generates (and the test ids in use) are accepted", async () => {
  const bg = loadBackground();
  for (const queryId of ["q_1760000000000_k3x9", "q_1760000000000_a", "q1", "q-1", "golden", "x".repeat(80)]) {
    const reply = await bg.dispatch({ type: "EXPLAIN", text: "Manekilex", queryId }, iframeSender());
    assert.equal(reply.accepted, true, queryId);
  }
});

test("M3b: EXPLAIN with an unknown queryType is refused; the five lookup types are accepted", async () => {
  const bg = loadBackground();
  for (const queryType of ["evil", "__proto__", "empty", "too_long", "", 5, true, {}]) {
    const r = callListener(bg, { type: "EXPLAIN", text: "Manekilex", queryId: "q1", queryType }, iframeSender());
    assert.equal(r.answer.code, "INVALID_QUERY_TYPE", JSON.stringify(queryType));
    assert.equal(r.answer.accepted, false);
  }
  for (const queryType of ["word", "phrase", "sentence", "paragraph", "code_term", undefined, null]) {
    const message = { type: "EXPLAIN", text: "Manekilex", queryId: "q1" };
    if (queryType !== undefined) message.queryType = queryType;
    const reply = await bg.dispatch(message, iframeSender());
    assert.equal(reply.accepted, true, String(queryType));
  }
});

test("M3b: text validation still answers first (empty text keeps its EMPTY code even without a queryId)", () => {
  const bg = loadBackground();
  const r = callListener(bg, { type: "EXPLAIN", text: "   " }, iframeSender());
  assert.equal(r.answer.code, "EMPTY");
});

// ── Service worker: where lookup results go ─────────────────────────────────────────────────

test("M3b: results go only to the document that asked (documentId first)", async () => {
  const bg = loadBackground();
  await bg.dispatch({ type: "EXPLAIN", text: "Manekilex", queryId: "q_frame" }, iframeSender());
  await waitFor(() => bg.tabMessages.length === 1, 2000, "result");
  const [sent] = bg.tabMessages;
  assert.equal(sent.tabId, 1);
  assert.equal(sent.message.type, "SHOW_RESULT");
  assert.equal(sent.message.queryId, "q_frame");
  assert.deepEqual(JSON.parse(JSON.stringify(sent.frame)), { documentId: "DOC-FRAME-3" });
});

test("M3b: without a documentId the frameId targets the frame; with neither the whole tab gets it as before", async () => {
  const bg = loadBackground();
  await bg.dispatch({ type: "EXPLAIN", text: "Manekilex", queryId: "q_a" }, iframeSender({ documentId: undefined }));
  await bg.dispatch({ type: "EXPLAIN", text: "Manekilex", queryId: "q_b" }, contentScriptSender("https://top.example.test/", 2));
  await bg.dispatch({ type: "EXPLAIN", text: "Manekilex", queryId: "q_c" }, { tab: { id: 4 } });
  await waitFor(() => bg.tabMessages.length === 3, 2000, "three results");
  const byQuery = Object.fromEntries(bg.tabMessages.map((m) => [m.message.queryId, m]));
  assert.deepEqual(JSON.parse(JSON.stringify(byQuery.q_a.frame)), { frameId: 3 });
  assert.equal(byQuery.q_a.tabId, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(byQuery.q_b.frame)), { frameId: 0 }, "top frame");
  assert.equal(byQuery.q_c.frame, undefined, "no frame information: the whole tab, as before");
});

test("M3b: the side panel and the PDF reader keep the runtime broadcast (no tab to target)", async () => {
  const bg = loadBackground();
  await bg.dispatch({ type: "EXPLAIN", text: "Manekilex", queryId: "q_panel" }, extensionPageSender("lookup-panel.html"));
  const reader = { ...extensionPageSender("pdf-reader.html?file=x"), tab: { id: 9 }, frameId: 0, documentId: "DOC-READER" };
  await bg.dispatch({ type: "EXPLAIN", text: "Manekilex", queryId: "q_reader" }, reader);
  await waitFor(() => bg.runtimeMessages.length === 2, 2000, "two broadcasts");
  assert.deepEqual(bg.runtimeMessages.map((m) => m.queryId).sort(), ["q_panel", "q_reader"]);
  assert.equal(bg.tabMessages.length, 0);
});

test("M3b: the context enhancement follows its base result to the same document", async () => {
  const bg = loadBackground({
    storage: WITH_KEY,
    dictionary: DICTIONARY,
    fetch: async () => openAIChatResponse(JSON.stringify({ meaning_here: "银行", pos_here: "名词" })),
  });
  await bg.dispatch({ type: "EXPLAIN", text: "bank", queryId: "q_ctx", context: FINANCE }, iframeSender());
  await waitFor(() => bg.tabMessages.some((m) => m.message.type === "CONTEXT_ENHANCED"), 2000, "enhancement");
  const types = bg.tabMessages.map((m) => m.message.type);
  assert.deepEqual(types, ["SHOW_RESULT", "CONTEXT_ENHANCED"]);
  for (const m of bg.tabMessages) {
    assert.deepEqual(JSON.parse(JSON.stringify(m.frame)), { documentId: "DOC-FRAME-3" }, m.message.type);
  }
});

test("M3b: the tab-level 'Manekilex is off' notice from the PDF context menu still reaches the whole tab", async () => {
  const bg = loadBackground({ storage: { zehManekilexEnabled: false } });
  const [onClicked] = bg.chrome.contextMenus.onClicked.listeners;
  onClicked({ menuItemId: "mk-lookup-selection", selectionText: "harbour" }, { id: 6, url: "https://papers.example.test/a.pdf" });
  await waitFor(() => bg.tabMessages.length === 1, 2000, "notice");
  const [sent] = bg.tabMessages;
  assert.equal(sent.tabId, 6);
  assert.equal(sent.message.type, "SHOW_ERROR");
  assert.equal("queryId" in sent.message, false, "no queryId: a notice for the tab, not a lookup answer");
  assert.equal(sent.frame, undefined);
});

// ── Lookup controller: claiming results ─────────────────────────────────────────────────────

const WORD = { queryType: "word", term: "harbour", short_meaning: "港口" };

function lookUp(env) {
  assert.equal(env.controller.lookupText("harbour"), true);
  return env.explainRequests().at(-1).message.queryId;
}

const showsResult = (env) => /港口/.test(env.panelBodyHtml() || "");

test("M3b controller: a SHOW_RESULT without a queryId, or with a null one, is not rendered", () => {
  const env = loadLookupController();
  lookUp(env);
  env.deliver({ type: "SHOW_RESULT", queryType: "word", fromDict: true, durationMs: 0, data: WORD });
  assert.equal(showsResult(env), false, "missing queryId");
  env.deliver({ type: "SHOW_RESULT", queryId: null, queryType: "word", fromDict: true, durationMs: 0, data: WORD });
  assert.equal(showsResult(env), false, "null queryId");
  env.deliver({ type: "SHOW_RESULT", queryId: "", queryType: "word", fromDict: true, durationMs: 0, data: WORD });
  assert.equal(showsResult(env), false, "empty queryId");
});

test("M3b controller: after the panel is closed, a null-queryId result does not reopen it", () => {
  const env = loadLookupController();
  lookUp(env);
  env.controller.hideAll();
  env.deliver({ type: "SHOW_RESULT", queryId: null, queryType: "word", fromDict: true, durationMs: 0, data: WORD });
  assert.equal(showsResult(env), false);
});

/** The panel's markup including in-place updates (the fake DOM keeps them on "virtual" children). */
function deepMarkup(el) {
  return [el._markup(), ...el.children.map(deepMarkup)].filter(Boolean).join("\n");
}

test("M3b controller: the current query's result still renders, and DICT_ENHANCED needs the same queryId", () => {
  const env = loadLookupController();
  const q = lookUp(env);
  env.deliver({ type: "SHOW_RESULT", queryId: q, queryType: "word", fromDict: true, durationMs: 0, data: WORD });
  assert.equal(showsResult(env), true);
  env.deliver({ type: "DICT_ENHANCED", providerName: "Forged", modelName: "forged-model", durationMs: 1 });
  env.deliver({ type: "DICT_ENHANCED", queryId: null, providerName: "Forged", modelName: "forged-model", durationMs: 1 });
  assert.doesNotMatch(deepMarkup(env.panel()), /forged-model/);
  env.deliver({ type: "DICT_ENHANCED", queryId: q, providerName: "DeepSeek", modelName: "deepseek-flash", durationMs: 1 });
  assert.match(deepMarkup(env.panel()), /deepseek-flash/);
});

test("M3b controller: SHOW_ERROR with a foreign or null queryId is ignored; without a queryId it is the tab notice", () => {
  const env = loadLookupController();
  const q = lookUp(env);
  env.deliver({ type: "SHOW_ERROR", queryId: "q_other", message: "别人的错误" });
  env.deliver({ type: "SHOW_ERROR", queryId: null, message: "空编号的错误" });
  assert.doesNotMatch(env.panelBodyHtml(), /别人的错误|空编号的错误/);
  env.deliver({ type: "SHOW_ERROR", queryId: q, message: "当前查询失败" });
  assert.match(env.panelBodyHtml(), /当前查询失败/);
  env.controller.hideAll();
  env.deliver({ type: "SHOW_ERROR", message: "Manekilex 已关闭" });
  assert.match(env.panelBodyHtml() || "", /Manekilex 已关闭/, "the tab-level notice renders with no query running");
});
