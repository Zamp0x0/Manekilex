/**
 * EXPLAIN orchestration in background.js (the real service-worker file, loaded with a
 * fake chrome API and fake fetch). Covers R-02 (timeouts, de-duplicated failures) and
 * R-36 (one error per rejected lookup).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadBackground,
  evalIn,
  waitFor,
  sleep,
  hangingFetch,
  jsonResponse,
  openAIChatResponse,
} = require("./helpers/extension-sandbox");

const SENTENCE = "The committee postponed the vote until the next quarterly meeting.";

function providerStorage(id = "deepseek") {
  return {
    zehActiveProvider: id,
    zehProviders: {
      [id]: { enabled: true, apiKey: "test-key", model: "" },
    },
  };
}

function explain(bg, { text = SENTENCE, queryId = "q1", tabId = 1 } = {}) {
  return bg.dispatch({ type: "EXPLAIN", text, queryId }, { tab: { id: tabId } });
}

function messagesFor(bg, tabId, type) {
  return bg.tabMessages.filter((m) => m.tabId === tabId && (!type || m.message.type === type));
}

function terminalFor(bg, tabId) {
  return bg.tabMessages.filter(
    (m) =>
      m.tabId === tabId && (m.message.type === "SHOW_RESULT" || m.message.type === "SHOW_ERROR")
  );
}

test("OpenAI-compatible: a hung provider is aborted and the lookup ends with SHOW_ERROR", async () => {
  const bg = loadBackground({ storage: providerStorage("deepseek"), fetch: hangingFetch });
  evalIn(bg.context, "ZEH_LOOKUP_PROVIDER_TIMEOUT_MS.sentence = 60");

  const response = await explain(bg);
  assert.equal(response.accepted, true);

  await waitFor(() => terminalFor(bg, 1).length > 0, 2000, "terminal message");
  const [{ message }] = terminalFor(bg, 1);
  assert.equal(message.type, "SHOW_ERROR");
  assert.equal(message.queryId, "q1");
  assert.match(message.message, /超时/);
  assert.equal(bg.fetchCalls.length, 1);
  assert.equal(bg.fetchCalls[0].init.signal.aborted, true, "fetch must be really aborted");
});

test("Gemini: a hung provider is aborted and the lookup ends with SHOW_ERROR", async () => {
  const bg = loadBackground({ storage: providerStorage("gemini"), fetch: hangingFetch });
  evalIn(bg.context, "ZEH_LOOKUP_PROVIDER_TIMEOUT_MS.sentence = 60");

  await explain(bg);
  await waitFor(() => terminalFor(bg, 1).length > 0, 2000, "terminal message");
  const [{ message }] = terminalFor(bg, 1);
  assert.equal(message.type, "SHOW_ERROR");
  assert.match(message.message, /超时/);
  assert.match(bg.fetchCalls[0].url, /generativelanguage\.googleapis\.com/);
  assert.equal(bg.fetchCalls[0].init.signal.aborted, true);
});

test("de-duplicated lookups: when the leader fails, every waiter gets SHOW_ERROR", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const bg = loadBackground({
    storage: providerStorage("deepseek"),
    fetch: async () => {
      await gate;
      return jsonResponse(500, { error: { message: "upstream exploded" } });
    },
  });

  const r1 = explain(bg, { tabId: 1, queryId: "a" });
  const r2 = explain(bg, { tabId: 2, queryId: "b" });
  assert.equal((await r1).accepted, true);
  assert.equal((await r2).accepted, true);
  await sleep(20);
  assert.equal(bg.fetchCalls.length, 1, "identical lookups share one provider request");
  release();

  await waitFor(
    () => terminalFor(bg, 1).length > 0 && terminalFor(bg, 2).length > 0,
    2000,
    "both tabs to settle"
  );
  for (const [tabId, queryId] of [
    [1, "a"],
    [2, "b"],
  ]) {
    const msgs = terminalFor(bg, tabId);
    assert.equal(msgs.length, 1, `tab ${tabId} gets exactly one terminal message`);
    assert.equal(msgs[0].message.type, "SHOW_ERROR");
    assert.equal(msgs[0].message.queryId, queryId);
  }
});

test("de-duplicated lookups: a leader timeout reaches every waiter", async () => {
  const bg = loadBackground({ storage: providerStorage("deepseek"), fetch: hangingFetch });
  evalIn(bg.context, "ZEH_LOOKUP_PROVIDER_TIMEOUT_MS.sentence = 80");

  await Promise.all([explain(bg, { tabId: 1, queryId: "a" }), explain(bg, { tabId: 2, queryId: "b" })]);
  await waitFor(
    () => terminalFor(bg, 1).length > 0 && terminalFor(bg, 2).length > 0,
    2000,
    "both tabs to settle"
  );
  assert.equal(bg.fetchCalls.length, 1);
  assert.equal(terminalFor(bg, 1)[0].message.type, "SHOW_ERROR");
  assert.equal(terminalFor(bg, 2)[0].message.type, "SHOW_ERROR");
  assert.match(terminalFor(bg, 2)[0].message.message, /超时/);
});

test("de-duplicated lookups: an unparseable reply (fallback) reaches every waiter", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const bg = loadBackground({
    storage: providerStorage("deepseek"),
    fetch: async () => {
      await gate;
      return openAIChatResponse("this is not json at all");
    },
  });
  await Promise.all([explain(bg, { tabId: 1, queryId: "a" }), explain(bg, { tabId: 2, queryId: "b" })]);
  await sleep(20);
  release();
  await waitFor(
    () => terminalFor(bg, 1).length > 0 && terminalFor(bg, 2).length > 0,
    2000,
    "both tabs to settle"
  );
  for (const tabId of [1, 2]) {
    const { message } = terminalFor(bg, tabId)[0];
    assert.equal(message.type, "SHOW_RESULT");
    assert.equal(message.fallback, true);
  }
});

test("de-duplicated lookups: success is shared and a later failure is retried, not stuck", async () => {
  let mode = "ok";
  let release;
  let gate = new Promise((r) => (release = r));
  const bg = loadBackground({
    storage: providerStorage("deepseek"),
    fetch: async () => {
      await gate;
      if (mode === "ok") {
        return openAIChatResponse(JSON.stringify({ term: SENTENCE, translation: "委员会推迟了投票。" }));
      }
      throw new TypeError("Failed to fetch");
    },
  });

  await Promise.all([explain(bg, { tabId: 1, queryId: "a" }), explain(bg, { tabId: 2, queryId: "b" })]);
  await sleep(20);
  release();
  await waitFor(
    () => terminalFor(bg, 1).length > 0 && terminalFor(bg, 2).length > 0,
    2000,
    "both tabs to settle"
  );
  assert.equal(bg.fetchCalls.length, 1);
  for (const tabId of [1, 2]) {
    const { message } = terminalFor(bg, tabId)[0];
    assert.equal(message.type, "SHOW_RESULT");
    assert.equal(message.data.translation, "委员会推迟了投票。");
  }

  // A different sentence on a failing network: error, then the same text again starts a
  // fresh request (the failed promise must not stay in the de-dup map).
  mode = "fail";
  gate = Promise.resolve();
  const other = "Another completely different sentence for the failure path.";
  await explain(bg, { tabId: 3, queryId: "c", text: other });
  await waitFor(() => terminalFor(bg, 3).length > 0, 2000, "tab 3 to settle");
  assert.equal(terminalFor(bg, 3)[0].message.type, "SHOW_ERROR");
  await explain(bg, { tabId: 3, queryId: "d", text: other });
  await waitFor(() => terminalFor(bg, 3).length > 1, 2000, "retry to settle");
  assert.equal(bg.fetchCalls.length, 3, "the retry issued a new provider request");
  assert.equal(terminalFor(bg, 3)[1].message.queryId, "d");
});

test("provider JSON that is not an object falls back to raw text instead of a broken result", async () => {
  for (const content of ["null", "[1, 2]", '"just a string"']) {
    const bg = loadBackground({
      storage: providerStorage("deepseek"),
      fetch: async () => openAIChatResponse(content),
    });
    await explain(bg);
    await waitFor(() => terminalFor(bg, 1).length > 0, 2000, "terminal message");
    const { message } = terminalFor(bg, 1)[0];
    assert.equal(message.type, "SHOW_RESULT", content);
    assert.equal(message.fallback, true, `${content} must use the raw-text fallback`);
  }
});

test("validation failure is reported once (sendResponse only, no extra SHOW_ERROR)", async () => {
  const bg = loadBackground({ storage: providerStorage("deepseek"), fetch: hangingFetch });
  const response = await explain(bg, { text: "   " });
  assert.equal(response.accepted, false);
  assert.ok(response.code);
  await sleep(20);
  assert.equal(messagesFor(bg, 1, "SHOW_ERROR").length, 0);
  assert.equal(bg.fetchCalls.length, 0);
});

test("disabled extension is reported once (sendResponse only, no extra SHOW_ERROR)", async () => {
  const bg = loadBackground({
    storage: { ...providerStorage("deepseek"), zehManekilexEnabled: false },
    fetch: hangingFetch,
  });
  const response = await explain(bg);
  assert.equal(response.accepted, false);
  assert.equal(response.code, "disabled");
  await sleep(20);
  assert.equal(messagesFor(bg, 1, "SHOW_ERROR").length, 0);
});

test("missing API key is reported once through sendResponse", async () => {
  const bg = loadBackground({
    storage: { zehActiveProvider: "deepseek", zehProviders: { deepseek: { enabled: true, apiKey: "" } } },
    fetch: hangingFetch,
  });
  const response = await explain(bg);
  assert.equal(response.accepted, false);
  assert.equal(response.code, "NO_API_KEY");
  await sleep(20);
  assert.equal(terminalFor(bg, 1).length, 0);
});

test("F2: an unexpected exception before the reply is answered with code INTERNAL and the real message", async () => {
  const bg = loadBackground({ storage: providerStorage("deepseek"), fetch: hangingFetch });
  // 读设置时抛错（例如 storage 损坏）：这是内部错误，不是“没配 API Key”
  bg.context.zehGetManekilexEnabledAsync = async () => {
    throw new Error("storage read exploded");
  };
  const response = await explain(bg);
  assert.equal(response.accepted, false);
  assert.equal(response.code, "INTERNAL");
  assert.match(response.message, /storage read exploded/);
  assert.notEqual(response.code, "NO_API_KEY");
  await sleep(20);
  assert.equal(terminalFor(bg, 1).length, 0, "reported once, through sendResponse only");
  assert.equal(bg.fetchCalls.length, 0);
});
