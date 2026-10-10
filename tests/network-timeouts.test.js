/**
 * F7: transcript translation and the AssemblyAI token request give up after a timeout.
 *
 * These fetches (background.js callOpenAICompatibleTranslatePlain / callGeminiTranslatePlain /
 * callOpenAICompatibleTranslateJson / callGeminiTranslateJson / getAssemblyAITemporaryToken) had
 * no AbortSignal, so a connection that never answers left live transcription waiting forever.
 * The fake fetch below never answers by itself and only rejects when its signal aborts, like a
 * real fetch on a dead connection. Timeouts are shortened through networkTimeoutMs().
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackground } = require("./helpers/extension-sandbox");

const SHORT_MS = 40;
const DEADLINE_MS = 1500;

function neverAnswers(signals) {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init && init.signal;
      signals.push(signal || null);
      if (!signal) return; // no signal: hangs forever (the bug)
      signal.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    });
}

function backgroundFor(providerId, signals) {
  const bg = loadBackground({
    storage: {
      zehProviders: { [providerId]: { enabled: true, apiKey: "test-key", model: "" } },
      zehLiveTranscribeProvider: providerId,
      zehAssemblyAI: { apiKey: "test-assembly-key" },
    },
    fetch: neverAnswers(signals),
  });
  bg.context.networkTimeoutMs = () => SHORT_MS;
  return bg;
}

/** Resolve with the reply, or fail if nothing settles before the deadline. */
function withDeadline(promise, label) {
  let timer;
  const deadline = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: still waiting after ${DEADLINE_MS}ms (no timeout)`)), DEADLINE_MS);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

const CASES = [
  { providerId: "deepseek", mode: "partial", fn: "callOpenAICompatibleTranslatePlain" },
  { providerId: "gemini", mode: "partial", fn: "callGeminiTranslatePlain" },
  { providerId: "deepseek", mode: "final", fn: "callOpenAICompatibleTranslateJson" },
  { providerId: "gemini", mode: "final", fn: "callGeminiTranslateJson" },
];

for (const { providerId, mode, fn } of CASES) {
  test(`F7: ${fn} (${providerId}, ${mode}) ends with a timeout code when the provider never answers`, async () => {
    const signals = [];
    const bg = backgroundFor(providerId, signals);
    const reply = await withDeadline(
      bg.dispatch({ type: "TRANSLATE_TRANSCRIPT", currentText: "We sat on the bank of the river.", mode }),
      fn
    );
    assert.equal(reply.ok, false);
    assert.equal(reply.code, "NETWORK_TIMEOUT");
    assert.match(reply.message, /超时/);
    const name = providerId === "gemini" ? "Gemini" : "DeepSeek";
    assert.equal(reply.message.split(name).length - 1, 1, `provider name once: ${reply.message}`);
    assert.equal(signals.length, 1, "one request");
    assert.ok(signals[0], "the request had an AbortSignal");
    assert.equal(signals[0].aborted, true);
  });
}

test("F7: the AssemblyAI temporary token request ends with a timeout code", async () => {
  const signals = [];
  const bg = backgroundFor("deepseek", signals);
  const err = await withDeadline(
    bg.context.getAssemblyAITemporaryToken().then(
      () => assert.fail("must not resolve"),
      (e) => e
    ),
    "getAssemblyAITemporaryToken"
  );
  assert.equal(err.code, "NETWORK_TIMEOUT");
  assert.match(err.message, /AssemblyAI/);
  assert.ok(signals[0] && signals[0].aborted, "request aborted");

  const reply = await withDeadline(bg.dispatch({ type: "GET_ASSEMBLYAI_TEMP_TOKEN" }), "GET_ASSEMBLYAI_TEMP_TOKEN");
  assert.equal(reply.ok, false);
  assert.match(reply.message, /超时/);
});

test("F7: real timeouts are finite and long enough for a slow provider", () => {
  const bg = loadBackground();
  for (const kind of ["translatePartial", "translateFinal", "assemblyaiToken"]) {
    const ms = bg.context.networkTimeoutMs(kind);
    assert.ok(Number.isFinite(ms) && ms >= 10000 && ms <= 60000, `${kind}: ${ms}`);
  }
});

test("F7: answering providers still translate (the timeout is cleared, Gemini still retries a 400)", async () => {
  const { jsonResponse, openAIChatResponse } = require("./helpers/extension-sandbox");
  const zh = "我们坐在河岸上。";
  const bodies = [];
  const bg = loadBackground({
    storage: {
      zehProviders: { deepseek: { enabled: true, apiKey: "test-key", model: "" }, gemini: { enabled: true, apiKey: "test-key", model: "" } },
      zehLiveTranscribeProvider: "deepseek",
    },
    fetch: async (url, init) => {
      assert.ok(init.signal, "every request carries a signal");
      bodies.push(JSON.parse(init.body));
      if (String(url).includes("generativelanguage")) {
        if (init.body.includes("responseMimeType")) return jsonResponse(400, { error: { message: "mime not supported" } });
        return jsonResponse(200, { candidates: [{ content: { parts: [{ text: JSON.stringify({ cleaned_en: "x", translation: zh }) }] } }] });
      }
      return openAIChatResponse(zh);
    },
  });
  const partial = await bg.dispatch({ type: "TRANSLATE_TRANSCRIPT", currentText: "We sat on the bank.", mode: "partial" });
  assert.equal(partial.ok, true, partial.message);
  assert.equal(partial.translation, zh);

  await bg.local.set({ zehLiveTranscribeProvider: "gemini" });
  const final = await bg.dispatch({ type: "TRANSLATE_TRANSCRIPT", currentText: "We sat on the bank.", mode: "final" });
  assert.equal(final.ok, true, final.message);
  assert.equal(final.translation, zh);
  assert.equal(bodies.length, 3, "one OpenAI-compatible call, then Gemini with and without the JSON mime type");
});
