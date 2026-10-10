/**
 * P0-C: golden contracts. The strings and shapes other systems depend on are pinned to files in
 * tests/fixtures/golden/, so a refactor cannot change them by accident:
 *
 *   prompts.json         system prompts per query type, context prompts and their user payloads
 *   request-bodies.json  what EXPLAIN really sends to each provider (URL without the key + JSON
 *                        body), and the per-model request adjustments
 *   query-types.json     zehDetectQueryType on sample inputs
 *   key-variants.json    zehLookupKeyVariants on sample words
 *   cache-keys.json      lookup cache keys (v2, legacy, context, de-duplication)
 *
 * The cache keys are storage keys of existing users' data: changing them orphans their cache.
 * A phase that changes a contract on purpose regenerates the files in the same commit:
 *
 *   UPDATE_GOLDEN=1 node --test tests/golden-contracts.test.js
 *
 * The fake fetch answers every request with a fixed reply; no network and no API key is used.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  loadConfig,
  loadBackground,
  evalIn,
  waitFor,
  jsonResponse,
  openAIChatResponse,
  contentScriptSender,
} = require("./helpers/extension-sandbox");

const DIR = path.join(__dirname, "fixtures", "golden");
const UPDATE = process.env.UPDATE_GOLDEN === "1";
const API_KEY = "golden-test-key";

function golden(name, actual) {
  const file = path.join(DIR, `${name}.json`);
  const plain = JSON.parse(JSON.stringify(actual));
  if (UPDATE) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(plain, null, 1)}\n`);
    return;
  }
  assert.ok(fs.existsSync(file), `missing ${path.relative(process.cwd(), file)}; run with UPDATE_GOLDEN=1`);
  assert.deepEqual(plain, JSON.parse(fs.readFileSync(file, "utf8")));
}

const cfg = loadConfig();
const call = (expr) => JSON.parse(JSON.stringify(evalIn(cfg, expr)));

const QUERY_TYPES = ["word", "phrase", "code_term", "sentence", "paragraph"];
const CONTEXT = {
  sentence: "We sat on the bank of the river and watched the boats.",
  nearbyText: "It was a warm afternoon. We sat on the bank of the river and watched the boats.",
  sourceType: "web",
};

// ── prompts ────────────────────────────────────────────────────────────────────────────────

function promptTable() {
  const out = { system: {}, maxTokens: {}, context: {} };
  for (const qt of [...QUERY_TYPES, "unknown"]) {
    out.system[qt] = call(`zehBuildSystemPrompt(${JSON.stringify(qt)})`);
    out.maxTokens[qt] = call(`[zehMaxTokens(${JSON.stringify(qt)}, 40), zehMaxTokens(${JSON.stringify(qt)}, 2000)]`);
  }
  const ctx = JSON.stringify(CONTEXT);
  out.context.lookupWord = call(`zehBuildContextLookupRequest("bank", "word", ${ctx})`);
  out.context.lookupPhrase = call(`zehBuildContextLookupRequest("sat on", "phrase", ${ctx})`);
  out.context.enhance = call(`zehBuildContextEnhanceRequest("bank", "word", ${ctx}, "银行；河岸", false)`);
  out.context.enhanceWithTip = call(`zehBuildContextEnhanceRequest("bank", "word", ${ctx}, "银行；河岸", true)`);
  return out;
}

test("golden: system prompts, token limits and context prompts", () => {
  golden("prompts", promptTable());
});

// ── query types ────────────────────────────────────────────────────────────────────────────

const QUERY_SAMPLES = [
  "",
  "   ",
  "bank",
  "Bank",
  "serendipity",
  "don't",
  "rock'n'roll",
  "e-mail",
  "U.S.",
  "take off",
  "look forward to",
  "in spite of the weather",
  "useEffect",
  "snake_case_name",
  "Array.prototype.map",
  "npm install --save-dev",
  "<div class=\"x\">",
  "HTTP/2",
  "42",
  "3.14 meters",
  "银行",
  "银行 bank",
  "The committee postponed the vote.",
  "the committee postponed the vote until the next quarterly meeting of the board",
  "Is this a question?",
  "Wait! Stop!",
  "It rained. We stayed inside and read books all afternoon long.",
  "a ".repeat(200).trim(),
  "x".repeat(5000),
  "https://example.com/path?q=1",
];

test("golden: zehDetectQueryType on sample inputs", () => {
  golden(
    "query-types",
    QUERY_SAMPLES.map((text) => ({
      text: text.length > 80 ? `${text.slice(0, 40)}…(${text.length} chars)` : text,
      type: call(`zehDetectQueryType(${JSON.stringify(text)})`),
    }))
  );
});

// ── dictionary key variants ────────────────────────────────────────────────────────────────

const KEY_SAMPLES = [
  "bank",
  "Bank",
  "BANK",
  "NASA",
  "iPhone",
  "don't",
  "dont",
  "don’t",
  "Don't",
  "can't",
  "cant",
  "won't",
  "it's",
  "its",
  "I'm",
  "im",
  "ain't",
  "o'clock",
  "rock'n'roll",
  "e-mail",
  "well-being",
  "U.S.",
  "Mr.",
  "  spaced   out  ",
  "café",
  "ﬁnance",
  "children's",
  "students'",
  "they'd've",
  "Take Off",
];

test("golden: zehLookupKeyVariants on sample words", () => {
  golden(
    "key-variants",
    KEY_SAMPLES.map((text) => ({ text, variants: call(`zehLookupKeyVariants(${JSON.stringify(text)})`) }))
  );
});

// ── cache keys ─────────────────────────────────────────────────────────────────────────────

const CACHE_SAMPLES = [
  ["word", "Bank"],
  ["word", "don’t"],
  ["phrase", "Take  Off"],
  ["code_term", "useEffect"],
  ["sentence", "The committee postponed the vote."],
  ["paragraph", "It rained.  We stayed inside and read books all afternoon long."],
];

test("golden: lookup cache key formats", () => {
  const ctx = JSON.stringify(CONTEXT);
  const rows = CACHE_SAMPLES.map(([qt, text]) => {
    const q = JSON.stringify(qt);
    const t = JSON.stringify(text);
    const normalized = call(`zehNormalizeTextForCache(${q}, ${t})`);
    const hash = call(`zehCacheTextHash(${q}, ${JSON.stringify(normalized)})`);
    return {
      queryType: qt,
      text,
      normalized,
      hash,
      v2: call(`zehCacheV2StorageKey(${q}, ${normalized.length}, ${JSON.stringify(hash)})`),
      v2Short: call(`zehCacheV2StorageKeyShort(${q}, ${JSON.stringify(hash)})`),
      legacy: call(`zehLegacyLookupCacheStorageKey(${q}, ${t})`),
      dedup: call(`zehLookupCacheDedupKey(${q}, ${t})`),
      context: call(`zehContextCacheStorageKey(${q}, ${t}, ${ctx})`),
      contextDedup: call(`zehContextDedupKey(${q}, ${t}, ${ctx})`),
    };
  });
  golden("cache-keys", {
    prefixes: call("[ZEH_LOOKUP_CACHE_PREFIX, ZEH_LOOKUP_CACHE_V2_PREFIX]"),
    contextHash: call(`zehLookupContextHash(${ctx})`),
    rows,
  });
});

// ── provider request bodies ────────────────────────────────────────────────────────────────

const FAKE_ANSWER = JSON.stringify({
  term: "bank",
  phonetic: "/bæŋk/",
  part_of_speech: "n.",
  short_meaning: "河岸",
  meaning_here: "河岸",
  translation: "测试译文",
  examples: [],
});

function geminiResponse(text) {
  return jsonResponse(200, {
    candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  });
}

/** Send one EXPLAIN through the real service worker and return every provider request it made. */
async function captureExplain(providerId, model, message) {
  const requests = [];
  const bg = loadBackground({
    storage: {
      zehActiveProvider: providerId,
      zehProviders: { [providerId]: { enabled: true, apiKey: API_KEY, model } },
    },
    fetch: async (url, init) => {
      requests.push({
        method: init && init.method,
        url: String(url).split(encodeURIComponent(API_KEY)).join("<API_KEY>"),
        body: JSON.parse(init.body),
      });
      return providerId === "gemini" ? geminiResponse(FAKE_ANSWER) : openAIChatResponse(FAKE_ANSWER);
    },
  });
  await bg.dispatch({ type: "EXPLAIN", queryId: "golden", ...message }, contentScriptSender());
  await waitFor(
    () => bg.tabMessages.some((m) => m.message.type === "SHOW_RESULT" || m.message.type === "SHOW_ERROR"),
    3000,
    `${providerId} answer`
  );
  for (const r of requests) {
    assert.ok(!JSON.stringify(r).includes(API_KEY), "the API key must never be in a request body");
  }
  return requests;
}

/** Replace any prompt text that prompts.json already pins with a short reference. */
function withPromptRefs(value, prompts) {
  const refs = new Map();
  Object.entries(prompts.system).forEach(([qt, text]) => refs.has(text) || refs.set(text, `{{system:${qt}}}`));
  Object.entries(prompts.context).forEach(([name, req]) => refs.has(req.systemPrompt) || refs.set(req.systemPrompt, `{{context:${name}}}`));
  return JSON.parse(JSON.stringify(value), (_k, v) => (typeof v === "string" && refs.has(v) ? refs.get(v) : v));
}

const EXPLAIN_CASES = {
  word: { text: "serendipity" },
  sentence: { text: "The committee postponed the vote until the next quarterly meeting." },
  wordInContext: { text: "bank", context: CONTEXT },
};

const MODEL_ADJUSTMENTS = {
  openai: ["gpt-6-luna", "gpt-5-mini", "o3", "gpt-4.1-mini"],
  deepseek: ["deepseek-flash", "deepseek-reasoner"],
  moonshot: ["kimi-k2.6", "kimi-k3", "moonshot-v1-8k"],
  zhipu: ["glm-4-flash", "glm-4.7-flash"],
  siliconflow: ["deepseek-ai/DeepSeek-V4-Flash", "Qwen/Qwen3-8B"],
  groq: ["openai/gpt-oss-20b", "qwen/qwen3-32b", "llama-3.3-70b-versatile"],
  gemini: ["gemini-3.5-flash-lite"],
};

test("golden: provider request bodies for EXPLAIN and per-model adjustments", async () => {
  const prompts = promptTable();
  const providerIds = call("ZEH_PROVIDER_IDS");
  const explain = {};
  for (const id of providerIds) {
    explain[id] = {};
    for (const [name, message] of Object.entries(EXPLAIN_CASES)) {
      explain[id][name] = withPromptRefs(await captureExplain(id, "", message), prompts);
    }
  }
  const adjustments = {};
  for (const [id, models] of Object.entries(MODEL_ADJUSTMENTS)) {
    adjustments[id] = {};
    for (const model of models) {
      const body = { model, messages: [], temperature: 0.1, max_tokens: 750 };
      adjustments[id][model] = call(`zehApplyProviderRequestOptions(${JSON.stringify(body)}, ${JSON.stringify(id)}, ${JSON.stringify(model)})`);
    }
  }
  golden("request-bodies", { explain, adjustments });
});
