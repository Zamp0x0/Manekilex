/**
 * 0.11.1 provider refresh: new defaults (gpt-6-luna, deepseek-flash), exact-match migration of
 * old Manekilex defaults only (custom models are never touched), and the smallest per-provider
 * Chat Completions adaptations. No real network: fetch is a stub.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadConfig,
  loadBackground,
  evalIn,
  waitFor,
  openAIChatResponse,
} = require("./helpers/extension-sandbox");

const cfg = loadConfig();
const plain = (value) => JSON.parse(JSON.stringify(value));
const meta = (id) => evalIn(cfg, `ZEH_PROVIDER_META[${JSON.stringify(id)}]`);

test("defaults: OpenAI gpt-6-luna, DeepSeek deepseek-flash; SiliconFlow / GLM unchanged; hints name them", () => {
  assert.equal(meta("openai").defaultModel, "gpt-6-luna");
  assert.equal(meta("openai").fastModel, "gpt-6-luna");
  assert.equal(meta("deepseek").defaultModel, "deepseek-flash");
  assert.equal(meta("deepseek").fastModel, "deepseek-flash");
  assert.equal(meta("siliconflow").defaultModel, "deepseek-ai/DeepSeek-V4-Flash", "no guessed V4.1 id");
  assert.equal(meta("zhipu").defaultModel, "glm-4-flash");
  assert.match(meta("openai").modelHint, /gpt-6-luna/);
  assert.match(meta("deepseek").modelHint, /deepseek-flash/);
  assert.match(meta("deepseek").modelHint, /deepseek-v4-flash 只是旧兼容别名/);
  const providers = cfg.zehDefaultProviders();
  assert.equal(providers.openai.model, "gpt-6-luna");
  assert.equal(providers.deepseek.model, "deepseek-flash");
});

test("migration: empty → new default; old Manekilex default → new default; anything else preserved", () => {
  const out = plain(
    cfg.zehMigrateProviderModels({
      openai: { apiKey: "k", model: "gpt-4.1-mini" },
      deepseek: { apiKey: "k", model: "deepseek-v4-flash" },
      groq: { apiKey: "k", model: "" },
      gemini: { apiKey: "k", model: "gemini-2.5-flash-lite" },
      moonshot: { apiKey: "k", model: "my-private-kimi" },
      zhipu: { apiKey: "k", model: "glm-4.7-flash" },
      siliconflow: { apiKey: "k", model: "Qwen/Qwen3-8B" },
    })
  );
  assert.equal(out.openai.model, "gpt-6-luna");
  assert.equal(out.deepseek.model, "deepseek-flash");
  assert.equal(out.groq.model, meta("groq").defaultModel);
  assert.equal(out.gemini.model, "gemini-2.5-flash-lite", "existing users keep 2.5 flash-lite");
  assert.equal(out.moonshot.model, "my-private-kimi", "custom names untouched");
  assert.equal(out.zhipu.model, "glm-4.7-flash");
  assert.equal(out.siliconflow.model, "Qwen/Qwen3-8B");
  assert.equal(out.openai.apiKey, "k", "keys untouched");

  for (const [id, model] of [
    ["openai", "gpt-4.1-nano"],
    ["openai", "gpt-4o"],
    ["deepseek", "deepseek-v4-pro"],
    ["deepseek", "DeepSeek-Chat"],
    ["openai", " my-fine-tune "],
  ]) {
    const migrated = plain(cfg.zehMigrateProviderModels({ [id]: { model } }));
    assert.equal(migrated[id].model, model, `${id}:${model} preserved (exact match only)`);
  }
  for (const old of ["deepseek-chat", "deepseek-reasoner"]) {
    assert.equal(plain(cfg.zehMigrateProviderModels({ deepseek: { model: old } })).deepseek.model, "deepseek-flash");
  }
  // idempotent
  const twice = plain(cfg.zehMigrateProviderModels(cfg.zehMigrateProviderModels({ openai: { model: "gpt-4.1-mini" } })));
  assert.equal(twice.openai.model, "gpt-6-luna");
});

function bodyFor(id, model, extra) {
  const body = { model, messages: [], temperature: 0.1, max_tokens: 700, response_format: { type: "json_object" }, ...(extra || {}) };
  return plain(cfg.zehApplyProviderRequestOptions(body, id, model));
}

test("request adaptations: smallest change per provider, Chat Completions + JSON mode kept", () => {
  const luna = bodyFor("openai", "gpt-6-luna");
  assert.equal(luna.max_completion_tokens, 700);
  assert.equal("max_tokens" in luna, false);
  assert.equal(luna.reasoning_effort, "none");
  assert.deepEqual(luna.response_format, { type: "json_object" });

  const legacy = bodyFor("openai", "gpt-4.1-mini");
  assert.equal(legacy.max_tokens, 700, "older OpenAI models unchanged");
  assert.equal("reasoning_effort" in legacy, false);
  assert.equal(legacy.temperature, 0.1);

  const gpt5 = bodyFor("openai", "gpt-5-mini");
  assert.equal(gpt5.max_completion_tokens, 700);
  assert.equal("temperature" in gpt5, false, "reasoning models reject custom temperature");

  assert.deepEqual(bodyFor("deepseek", "deepseek-flash").thinking, { type: "disabled" });
  assert.equal(bodyFor("deepseek", "deepseek-flash").max_tokens, 700);

  const kimi = bodyFor("moonshot", "kimi-k2.6");
  assert.equal("temperature" in kimi, false);
  assert.equal(kimi.max_completion_tokens, 700);
  assert.deepEqual(kimi.thinking, { type: "disabled" });
  assert.equal(bodyFor("moonshot", "moonshot-v1-8k").temperature, 0.1);

  assert.deepEqual(bodyFor("zhipu", "glm-4.7-flash").thinking, { type: "disabled" });
  assert.equal("thinking" in bodyFor("zhipu", "glm-4-flash"), false);
  assert.equal(bodyFor("siliconflow", "deepseek-ai/DeepSeek-V4-Flash").enable_thinking, false);
  assert.equal("enable_thinking" in bodyFor("siliconflow", "Qwen/Qwen2.5-7B-Instruct"), false);
  assert.equal(bodyFor("groq", "openai/gpt-oss-20b").reasoning_effort, "low");
  assert.equal(bodyFor("groq", "qwen/qwen3-32b").reasoning_effort, "none");
  assert.equal("reasoning_effort" in bodyFor("groq", "llama-3.3-70b-versatile"), false);
  assert.equal(cfg.zehApplyProviderRequestOptions(null, "openai", "gpt-6-luna"), null);
});

test("service worker: a lookup with the default OpenAI model sends the adapted body (stub fetch, no paid call)", async () => {
  const bg = loadBackground({
    storage: {
      zehActiveProvider: "openai",
      zehProviders: { openai: { enabled: true, apiKey: "test-key", model: "" } },
    },
    fetch: async () =>
      openAIChatResponse(JSON.stringify({ term: "serendipity", short_meaning: "意外发现美好事物的运气", examples: [] })),
  });
  await bg.dispatch({ type: "EXPLAIN", text: "serendipity", queryId: "q1" }, { tab: { id: 1 } });
  await waitFor(() => bg.fetchCalls.length === 1, 2000, "provider request");
  const body = JSON.parse(bg.fetchCalls[0].init.body);
  assert.equal(body.model, "gpt-6-luna");
  assert.equal(body.reasoning_effort, "none");
  assert.ok(body.max_completion_tokens > 0);
  assert.equal(body.max_tokens, undefined);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.match(bg.fetchCalls[0].url, /api\.openai\.com\/v1\/chat\/completions/, "Chat Completions, not Responses");
});

test("benchmark lists use only the documented ids", () => {
  const quick = plain(evalIn(cfg, "ZEH_BENCHMARK_MODELS_QUICK"));
  const full = plain(evalIn(cfg, "ZEH_BENCHMARK_MODELS_FULL"));
  assert.equal(quick.openai[0], "gpt-6-luna");
  assert.equal(quick.deepseek[0], "deepseek-flash");
  for (const lists of [quick, full]) {
    assert.ok(!lists.groq.includes("llama-3.1-8b-instant"), "retired Groq model removed");
    assert.ok(!lists.deepseek.includes("deepseek-v4-flash"), "compatibility alias is not benchmarked twice");
    Object.values(lists).forEach((models) => assert.equal(new Set(models).size, models.length, "no duplicates"));
  }
});
