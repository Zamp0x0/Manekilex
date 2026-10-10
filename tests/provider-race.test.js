/**
 * R-12 (persistProviders): a Settings tab saves its edits on top of the latest stored providers,
 * so a model chosen from the benchmark (service worker) or by another Settings tab survives.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackground, loadConfig, evalIn, createStorageArea, createEvent, waitFor } = require("./helpers/extension-sandbox");
const { loadSettingsPage } = require("./helpers/settings-page");

const PROVIDERS = "zehProviders";
const ACTIVE = "zehActiveProvider";

function providers(overrides) {
  const base = {
    openai: { apiKey: "sk-openai", model: "gpt-4o-mini", enabled: true },
    deepseek: { apiKey: "", model: "deepseek-chat", enabled: false },
  };
  return { ...base, ...(overrides || {}) };
}

test("zehMergeProviderEdits keeps local edits and takes everything else from storage", () => {
  const ctx = loadConfig();
  const merge = (stored, base, local) => JSON.parse(JSON.stringify(evalIn(ctx, "zehMergeProviderEdits")(stored, base, local, ["openai", "deepseek"])));
  const base = providers();
  const local = providers({ openai: { apiKey: "sk-new", model: "gpt-4o-mini", enabled: true } });
  const stored = providers({ deepseek: { apiKey: "", model: "deepseek-v4-pro", enabled: false } });
  const merged = merge(stored, base, local);
  assert.equal(merged.openai.apiKey, "sk-new", "local edit wins");
  assert.equal(merged.deepseek.model, "deepseek-v4-pro", "remote edit survives");
  assert.equal(merged.openai.model, "gpt-4o-mini");
  // unchanged locally, changed remotely on the same provider → remote wins
  const stored2 = providers({ openai: { apiKey: "sk-openai", model: "gpt-4.1", enabled: true } });
  assert.equal(merge(stored2, base, local).openai.model, "gpt-4.1");
  // extra fields in storage are preserved
  const stored3 = providers({ openai: { apiKey: "sk-openai", model: "gpt-4o-mini", enabled: true, note: "keep" } });
  assert.equal(merge(stored3, base, local).openai.note, "keep");
});

async function loadExtension(initial) {
  const onChanged = createEvent();
  const local = createStorageArea(initial, { onChanged });
  const bg = loadBackground({ local, onChanged });
  const settings = await loadSettingsPage({ local, onChanged, sendMessage: (m) => bg.dispatch(m) });
  return { bg, settings, local };
}

test("Settings save after the benchmark picked a model keeps that model and the active provider", async () => {
  const { bg, settings, local } = await loadExtension({ [PROVIDERS]: providers(), [ACTIVE]: "openai" });
  await waitFor(() => settings.evalIn("providersState.openai.apiKey") === "sk-openai", 2000, "settings loaded providers");

  // Service worker (benchmark "use this model") writes providers while Settings is open.
  const res = await bg.dispatch({ type: "SET_PROVIDER_MODEL_FROM_BENCHMARK", providerId: "deepseek", model: "deepseek-v4-pro" });
  assert.equal(res.ok, true);
  await waitFor(() => settings.evalIn("providersState.deepseek.model") === "deepseek-v4-pro", 2000, "storage change reached Settings");

  // The user edits the OpenAI key in this tab and the page autosaves.
  settings.evalIn('providersState.openai.apiKey = "sk-edited"');
  await settings.evalIn("persistProviders(false)");

  const stored = local.data[PROVIDERS];
  assert.equal(stored.openai.apiKey, "sk-edited", "local edit saved");
  assert.equal(stored.deepseek.model, "deepseek-v4-pro", "benchmark model not overwritten by stale state");
  assert.equal(stored.deepseek.enabled, true, "provider switched by the worker stays active");
  assert.equal(stored.openai.enabled, false);
  assert.equal(local.data[ACTIVE], "deepseek");
});

test("stale snapshot without a storage event still merges on save (two Settings tabs)", async () => {
  const { settings, local } = await loadExtension({ [PROVIDERS]: providers(), [ACTIVE]: "openai" });
  await waitFor(() => settings.evalIn("providersState.openai.apiKey") === "sk-openai", 2000, "loaded");
  // Another tab wrote directly (no event delivered here: simulate by mutating storage data silently).
  local.data[PROVIDERS] = providers({ deepseek: { apiKey: "sk-deep", model: "deepseek-chat", enabled: false } });
  settings.evalIn('providersState.openai.model = "gpt-4.1"');
  await settings.evalIn("persistProviders(false)");
  const stored = local.data[PROVIDERS];
  assert.equal(stored.openai.model, "gpt-4.1");
  assert.equal(stored.deepseek.apiKey, "sk-deep", "other tab's key kept");
  assert.equal(stored.openai.enabled, true);
  assert.equal(local.data[ACTIVE], "openai");
});

test("enabling a provider locally wins over the stored active provider", async () => {
  const { settings, local } = await loadExtension({ [PROVIDERS]: providers(), [ACTIVE]: "openai" });
  await waitFor(() => settings.evalIn("providersState.openai.apiKey") === "sk-openai", 2000, "loaded");
  settings.evalIn('providersState.deepseek.apiKey = "sk-deep"; providersState.deepseek.enabled = true; providersState.openai.enabled = false;');
  await settings.evalIn("persistProviders(false)");
  assert.equal(local.data[ACTIVE], "deepseek");
  assert.equal(local.data[PROVIDERS].deepseek.enabled, true);
  assert.equal(local.data[PROVIDERS].openai.enabled, false);
});
