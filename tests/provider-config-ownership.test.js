/**
 * M9: who writes the persisted provider configuration (zehProviders + zehActiveProvider), and what
 * survives when several writers act at once. Since M9 the service worker is the only writer, and
 * every write goes through one queue (zehWithProviderConfigLock in sw/settings.js):
 *
 *   sw/settings.js   saveProviderSettings          ← settings/models.js persistProviders (SAVE_PROVIDER_SETTINGS)
 *   sw/settings.js   migrateLegacyProviderSettings ← settings/models.js migrateIfNeeded (MIGRATE_PROVIDER_SETTINGS)
 *   sw/settings.js   migrateLegacySettings         ← every getAppSettings (lookups, benchmark), onInstalled
 *   sw/benchmark.js  setProviderModelFromBenchmark ← SET_PROVIDER_MODEL_FROM_BENCHMARK
 *
 * Readers: settings.js loadAll, settings/models.js handleProviderStorageChange, sw/settings.js
 * getAppSettings (lookups, context enhancement, transcription, benchmark).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackground, evalIn, createStorageArea, createEvent, waitFor } = require("./helpers/extension-sandbox");
const { loadSettingsPage } = require("./helpers/settings-page");

const PROVIDERS = "zehProviders";
const ACTIVE = "zehActiveProvider";
const plain = (v) => JSON.parse(JSON.stringify(v));

/** A complete stored configuration (every provider id, current default models): no migration needed */
function providers(overrides) {
  return {
    openai: { apiKey: "sk-openai-test", model: "gpt-6-luna", enabled: true },
    deepseek: { apiKey: "sk-deep-test", model: "deepseek-flash", enabled: false },
    moonshot: { apiKey: "", model: "kimi-k2.6", enabled: false },
    zhipu: { apiKey: "", model: "glm-4-flash", enabled: false },
    siliconflow: { apiKey: "", model: "deepseek-ai/DeepSeek-V4-Flash", enabled: false },
    groq: { apiKey: "", model: "openai/gpt-oss-20b", enabled: false },
    gemini: { apiKey: "", model: "gemini-3.5-flash-lite", enabled: false },
    ...(overrides || {}),
  };
}

/**
 * A worker and Settings pages on one chrome.storage.local. `hold()` makes the worker's next read
 * of zehProviders wait until the returned release() is called (the moment between its read and
 * its write). `openPage()` opens another Settings page on the same extension.
 */
async function loadExtension(initial) {
  const onChanged = createEvent();
  const local = createStorageArea(initial, { onChanged });
  let gate = null;
  const workerLocal = {
    get: async (keys, cb) => {
      const value = await local.get(keys);
      if (gate && [].concat(keys || []).includes(PROVIDERS)) {
        const g = gate;
        gate = null;
        g.reached();
        await g.wait;
      }
      if (typeof cb === "function") return void cb(value);
      return value;
    },
    set: (...a) => local.set(...a),
    remove: (...a) => local.remove(...a),
  };
  const bg = loadBackground({ local: workerLocal, onChanged });
  const openPage = async () => {
    const page = await loadSettingsPage({ local, onChanged, sendMessage: (m) => bg.dispatch(m), hash: "#models" });
    await waitFor(() => page.evalIn("providersState.openai.apiKey") === "sk-openai-test", 2000, "settings loaded providers");
    return page;
  };
  const settings = await openPage();
  return {
    bg,
    settings,
    local,
    onChanged,
    openPage,
    hold() {
      let release;
      let reached;
      const reachedP = new Promise((r) => (reached = r));
      gate = { wait: new Promise((r) => (release = r)), reached };
      return { reached: reachedP, release: () => release() };
    },
  };
}

const providerWrites = (local) => local.setCalls.filter((k) => k.includes(PROVIDERS));

test("M9: the Settings page never writes the provider keys; the worker saves them and answers after the write", async () => {
  const { settings, local } = await loadExtension({ [PROVIDERS]: providers(), [ACTIVE]: "openai" });
  const before = providerWrites(local).length;
  settings.evalIn('providersState.openai.model = "gpt-4.1"; providersState.openai.apiKey = "  sk-spaced-test  ";');
  const result = plain(await settings.evalIn("saveProviders(true)"));
  assert.equal(result.ok, true);
  assert.deepEqual(settings.pageSets, [], "the page itself wrote nothing");
  assert.deepEqual(providerWrites(local).slice(before), [[PROVIDERS, ACTIVE]], "one write by the worker");
  assert.equal(local.data[PROVIDERS].openai.model, "gpt-4.1");
  assert.equal(local.data[PROVIDERS].openai.apiKey, "sk-spaced-test", "the key is trimmed, as before");
  assert.equal(local.data[ACTIVE], "openai");
  assert.equal(settings.evalIn("providersState.openai.apiKey"), "sk-spaced-test", "the page shows what was stored");
  assert.match(settings.document.getElementById("saveStatus").textContent, /保存/);
  assert.doesNotMatch(settings.document.getElementById("saveStatus").className, /err/);
});

test("M9: a benchmark choice made while a page save is in flight survives the save (and later autosaves)", async () => {
  const ext = await loadExtension({ [PROVIDERS]: providers(), [ACTIVE]: "openai" });
  const { bg, settings, local } = ext;
  settings.evalIn('providersState.openai.apiKey = "sk-edited-test"');
  const gate = ext.hold();
  const saving = settings.evalIn("persistProviders(false)");
  await gate.reached; // the worker has read storage for the page's save and not yet written
  const choosing = bg.dispatch({ type: "SET_PROVIDER_MODEL_FROM_BENCHMARK", providerId: "deepseek", model: "deepseek-v4-pro" });
  gate.release();
  await saving;
  assert.equal((await choosing).ok, true);
  assert.equal(local.data[PROVIDERS].openai.apiKey, "sk-edited-test", "the page's edit is kept");
  assert.equal(local.data[PROVIDERS].deepseek.model, "deepseek-v4-pro", "the benchmark's model is kept");
  assert.equal(local.data[ACTIVE], "deepseek", "the benchmark's choice is the active provider");
  await waitFor(() => settings.evalIn("activeProvider") === "deepseek", 2000, "page sees the benchmark choice");
  assert.equal(settings.evalIn("providersState.deepseek.model"), "deepseek-v4-pro");
  // the page's next autosave does not bring back its older view
  await settings.evalIn("persistProviders(false)");
  assert.equal(local.data[ACTIVE], "deepseek");
  assert.equal(local.data[PROVIDERS].deepseek.model, "deepseek-v4-pro");
  assert.equal(local.data[PROVIDERS].openai.apiKey, "sk-edited-test");
});

test("M9: a page save based on a view older than a benchmark choice keeps the choice (R-12 unchanged)", async () => {
  const { bg, settings, local } = await loadExtension({ [PROVIDERS]: providers(), [ACTIVE]: "openai" });
  settings.evalIn('providersState.moonshot.apiKey = "sk-moon-test"');
  // the page's snapshot predates the choice: simulate a page that has not handled the change yet
  settings.evalIn("providerSavesInFlight += 1");
  assert.equal((await bg.dispatch({ type: "SET_PROVIDER_MODEL_FROM_BENCHMARK", providerId: "deepseek", model: "deepseek-v4-pro" })).ok, true);
  settings.evalIn("providerSavesInFlight -= 1");
  const base = plain(settings.evalIn("providersSnapshot"));
  assert.equal(base.openai.enabled, true, "the page still believes openai is active");
  const response = plain(await bg.dispatch({ type: "SAVE_PROVIDER_SETTINGS", base, edits: plain(settings.evalIn("providersState")) }));
  assert.equal(response.ok, true);
  assert.equal(local.data[ACTIVE], "deepseek");
  assert.equal(local.data[PROVIDERS].deepseek.model, "deepseek-v4-pro");
  assert.equal(local.data[PROVIDERS].moonshot.apiKey, "sk-moon-test");
});

test("M9: two Settings pages saving at the same moment both keep their edits", async () => {
  const ext = await loadExtension({ [PROVIDERS]: providers(), [ACTIVE]: "openai" });
  const { settings, local } = ext;
  const other = await ext.openPage();
  settings.evalIn('providersState.openai.apiKey = "sk-tab-a-test"');
  other.evalIn('providersState.zhipu.apiKey = "sk-tab-b-test"; providersState.groq.model = "llama-test"');
  await Promise.all([settings.evalIn("persistProviders(false)"), other.evalIn("persistProviders(false)")]);
  assert.equal(local.data[PROVIDERS].openai.apiKey, "sk-tab-a-test");
  assert.equal(local.data[PROVIDERS].zhipu.apiKey, "sk-tab-b-test");
  assert.equal(local.data[PROVIDERS].groq.model, "llama-test");
  assert.equal(local.data[ACTIVE], "openai");
  await waitFor(() => settings.evalIn("providersState.zhipu.apiKey") === "sk-tab-b-test", 2000, "page A sees page B's save");
  await waitFor(() => other.evalIn("providersState.openai.apiKey") === "sk-tab-a-test", 2000, "page B sees page A's save");
});

test("M9: legacy settings are migrated by the worker, with the same result as its own migration; the page writes nothing", async () => {
  const legacy = { openaiApiKey: "sk-legacy-test", openaiModel: "gpt-4o-mini" };
  const swLocal = createStorageArea({ ...legacy });
  const bg = loadBackground({ local: swLocal });
  await evalIn(bg.context, "migrateLegacySettings()");

  const onChanged = createEvent();
  const local = createStorageArea({ ...legacy }, { onChanged });
  const worker = loadBackground({ local, onChanged });
  const settings = await loadSettingsPage({ local, onChanged, sendMessage: (m) => worker.dispatch(m) });
  await waitFor(() => Boolean(local.data[PROVIDERS]), 2000, "migration through the worker");

  assert.deepEqual(plain(local.data[PROVIDERS]), plain(swLocal.data[PROVIDERS]));
  assert.equal(local.data[ACTIVE], "openai");
  assert.equal(local.data[PROVIDERS].openai.apiKey, "sk-legacy-test");
  assert.equal(local.data[PROVIDERS].openai.enabled, true);
  assert.equal(local.data[PROVIDERS].openai.model, plain(evalIn(bg.context, "zehMigrateProviderModels")({ openai: { model: "gpt-4o-mini" } })).openai.model);
  assert.equal(local.data.openaiApiKey, "sk-legacy-test", "the legacy keys stay in place");
  assert.deepEqual(settings.pageSets, []);
  await waitFor(() => settings.evalIn("providersState.openai.apiKey") === "sk-legacy-test", 2000, "page shows the migrated key");
});

test("M9: with no worker answering, opening Settings on legacy settings writes nothing and shows the defaults", async () => {
  const onChanged = createEvent();
  const local = createStorageArea({ openaiApiKey: "sk-legacy-test" }, { onChanged });
  const settings = await loadSettingsPage({ local, onChanged, sendMessage: async () => undefined, hash: "#models" });
  await waitFor(() => settings.evalIn("typeof providersState.openai === 'object'"), 2000, "page loaded");
  assert.deepEqual(local.setCalls, []);
  assert.equal(local.data[PROVIDERS], undefined);
});

test("M9: an existing configuration is never rewritten by either migration", async () => {
  const stored = providers({ zhipu: { apiKey: "", model: "glm-4-flash", enabled: false, note: "kept" } });
  const { bg, settings, local } = await loadExtension({ [PROVIDERS]: stored, [ACTIVE]: "openai", openaiApiKey: "sk-old-test" });
  const before = providerWrites(local).length;
  await evalIn(bg.context, "getAppSettings()");
  await settings.evalIn("migrateIfNeeded()");
  assert.equal(providerWrites(local).length, before);
  assert.deepEqual(plain(local.data[PROVIDERS]), plain(stored));
});

test("M9: the worker completes an incomplete stored configuration (missing ids) on its next read", async () => {
  const partial = { openai: { apiKey: "sk-openai-test", model: "gpt-6-luna", enabled: true } };
  const local = createStorageArea({ [PROVIDERS]: partial, [ACTIVE]: "openai" });
  const bg = loadBackground({ local });
  await evalIn(bg.context, "getAppSettings()");
  assert.deepEqual(Object.keys(local.data[PROVIDERS]).sort(), Object.keys(providers()).sort());
  assert.equal(local.data[PROVIDERS].openai.apiKey, "sk-openai-test");
  assert.equal(local.data[PROVIDERS].deepseek.enabled, false);
});

test("M9: a failed write is reported as an error, never as saved, and the queue keeps working", async () => {
  const { bg, settings, local } = await loadExtension({ [PROVIDERS]: providers(), [ACTIVE]: "openai" });
  local.failSetWith = new Error("QUOTA_BYTES quota exceeded");
  settings.evalIn('providersState.openai.model = "gpt-4.1"');
  const result = plain(await settings.evalIn("saveProviders(true)"));
  assert.equal(result.ok, false);
  const status = settings.document.getElementById("saveStatus");
  assert.match(status.textContent, /quota/i);
  assert.match(status.className, /err/);
  assert.equal(local.data[PROVIDERS].openai.model, "gpt-6-luna", "nothing was written");
  local.failSetWith = null;
  assert.equal((await bg.dispatch({ type: "SET_PROVIDER_MODEL_FROM_BENCHMARK", providerId: "groq", model: "llama-test" })).ok, true);
  assert.equal(local.data[ACTIVE], "groq", "a failed task does not block the next one");
});

test("M9: a worker that does not answer, or an extension that was reloaded, is an error, never 已保存", async () => {
  const onChanged = createEvent();
  const local = createStorageArea({ [PROVIDERS]: providers(), [ACTIVE]: "openai" }, { onChanged });
  let reply = async () => undefined;
  const settings = await loadSettingsPage({ local, onChanged, sendMessage: (m) => reply(m), hash: "#models" });
  await waitFor(() => settings.evalIn("providersState.openai.apiKey") === "sk-openai-test", 2000, "settings loaded providers");
  settings.evalIn('providersState.openai.model = "gpt-4.1"');
  const silent = plain(await settings.evalIn("saveProviders(true)"));
  assert.equal(silent.ok, false);
  assert.match(settings.document.getElementById("saveStatus").textContent, /保存失败/);
  reply = async () => {
    throw new Error("Extension context invalidated.");
  };
  const reloaded = plain(await settings.evalIn("saveProviders(true)"));
  assert.equal(reloaded.ok, false);
  assert.match(settings.document.getElementById("saveStatus").textContent, /扩展已更新/);
  assert.ok(settings.document.querySelector(".settings-reload-banner"), "the reload banner is shown");
  assert.deepEqual(local.setCalls, []);
});

test("M9: SAVE_PROVIDER_SETTINGS is validated and only accepted from extension pages", async () => {
  const local = createStorageArea({ [PROVIDERS]: providers(), [ACTIVE]: "openai" });
  const bg = loadBackground({ local });
  for (const bad of [{}, { base: providers() }, { base: [], edits: providers() }, { base: providers(), edits: "x" }]) {
    const r = plain(await bg.dispatch({ type: "SAVE_PROVIDER_SETTINGS", ...bad }));
    assert.deepEqual(r, { ok: false, code: "INVALID_PROVIDER_SETTINGS", error: "无效的模型设置" });
  }
  const fromWeb = await bg.dispatch(
    { type: "SAVE_PROVIDER_SETTINGS", base: providers(), edits: providers({ openai: { apiKey: "sk-evil-test", model: "x", enabled: true } }) },
    { id: "test-extension", url: "https://example.com/", tab: { id: 7, url: "https://example.com/" }, frameId: 0 }
  );
  assert.notEqual(fromWeb && fromWeb.ok, true);
  assert.deepEqual(local.setCalls, []);
  assert.equal(local.data[PROVIDERS].openai.apiKey, "sk-openai-test");
});

test("M9: a worker started later reads exactly what was saved", async () => {
  const { settings, local } = await loadExtension({ [PROVIDERS]: providers(), [ACTIVE]: "openai" });
  settings.evalIn('providersState.deepseek.model = "deepseek-v4-pro"; providersState.deepseek.enabled = true; providersState.openai.enabled = false;');
  const saved = plain(await settings.evalIn("saveProviders(false)"));
  assert.equal(saved.ok, true);
  const fresh = loadBackground({ local }); // a restarted worker on the same storage
  const app = plain(await evalIn(fresh.context, "getAppSettings()"));
  assert.equal(app.activeProvider, "deepseek");
  assert.equal(app.providers.deepseek.model, "deepseek-v4-pro");
  assert.equal(app.providers.deepseek.enabled, true);
  assert.equal(app.providers.openai.enabled, false);
  assert.equal(app.providers.openai.apiKey, "sk-openai-test");
});
