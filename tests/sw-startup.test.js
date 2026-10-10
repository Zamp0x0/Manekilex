/**
 * Service worker startup and restart, characterised before background.js is split into sw/
 * modules (M4). These tests pin what Chrome sees, so moving code between files cannot change it:
 *
 *   - which chrome.* calls the worker makes while its scripts are first evaluated, and in which
 *     order (listener registration, context menu setup, the storage reads of the two startup
 *     tasks: cache maintenance and benchmark resume);
 *   - that a fresh worker (Chrome stops an idle worker and starts a new one) answers from
 *     storage alone: nothing a lookup needs survives only in worker memory;
 *   - getAppSettings on a profile that still has the pre-provider settings keys.
 *
 * The recording worker below loads the real files from the manifest's importScripts list, with a
 * chrome object that logs every call. No network, no API key.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { getContext } = require("./helpers/load-order");
const {
  runFile,
  baseGlobals,
  createStorageArea,
  createEvent,
  loadBackground,
  evalIn,
  waitFor,
  sleep,
  openAIChatResponse,
} = require("./helpers/extension-sandbox");

/**
 * Boot the worker with a chrome object that records every call as "phase:path".
 * phase is "load" while the entry file (and its importScripts) is evaluated, then "async".
 */
function bootRecordingWorker(storage) {
  const calls = [];
  let phase = "load";
  const local = createStorageArea(storage || {});
  const session = createStorageArea();
  const areas = { local, session };

  function api(parts) {
    return new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === "then" || typeof prop === "symbol") return undefined;
        const next = [...parts, prop];
        const key = next.join(".");
        if (key === "runtime.id") return "test-extension";
        if (key === "runtime.lastError") return undefined;
        return api(next);
      },
      apply(_target, _this, args) {
        const key = parts.join(".");
        calls.push(`${phase}:${key}`);
        if (key === "runtime.getURL") return `chrome-extension://test-extension/${args[0] || ""}`;
        const area = parts[0] === "storage" ? areas[parts[1]] : null;
        if (area && typeof area[parts[2]] === "function") return area[parts[2]](...args);
        if (parts[parts.length - 1] === "addListener") return undefined;
        const callback = args.find((a) => typeof a === "function");
        if (callback) setTimeout(callback, 0);
        return Promise.resolve(undefined);
      },
    });
  }

  const context = vm.createContext({
    ...baseGlobals(),
    chrome: api([]),
    fetch: () => Promise.reject(new Error("no network in this test")),
  });
  context.self = context;
  context.globalThis = context;
  let evaluating = true;
  context.importScripts = (...files) => {
    if (!evaluating) throw new Error("importScripts() after the initial evaluation");
    files.forEach((f) => runFile(context, f));
  };
  try {
    runFile(context, getContext("service-worker").entry);
  } finally {
    evaluating = false;
    phase = "async";
  }
  return { calls, context, local };
}

test("startup: chrome calls during the first evaluation keep their order", () => {
  const { calls } = bootRecordingWorker();
  const atLoad = calls.filter((c) => c.startsWith("load:")).map((c) => c.slice(5));
  assert.deepEqual(atLoad, [
    // sw/tabs.js reads the extension page prefix while it is imported (a pure getter; before M4
    // this ran later, between the tab listeners, with the same result)
    "runtime.getURL",
    // initCacheMaintenance() and the benchmark resume start (their awaits continue later)
    "storage.local.get",
    "storage.local.get",
    "runtime.onInstalled.addListener",
    // setupContextMenus()
    "contextMenus.removeAll",
    // PDF viewer / side panel wiring
    "contextMenus.onClicked.addListener",
    "tabs.onUpdated.addListener",
    "tabs.onActivated.addListener",
    "tabs.onRemoved.addListener",
    // tab audio capture target tracking
    "tabs.onActivated.addListener",
    "tabs.onUpdated.addListener",
    // the message registry
    "runtime.onMessage.addListener",
  ]);
});

test("startup: after the first evaluation the worker only finishes its two storage reads", async () => {
  const { calls } = bootRecordingWorker();
  await sleep(30);
  const later = calls.filter((c) => c.startsWith("async:")).map((c) => c.slice(6));
  // removeAll's callback creates the menu item; the cache maintenance runs a daily cleanup on a
  // profile that never cleaned (two full reads, one meta write); nothing else happens on its own.
  assert.deepEqual(later.sort(), [
    "contextMenus.create",
    "storage.local.get",
    "storage.local.get",
    "storage.local.set",
  ]);
});

test("startup: a running benchmark job in storage is resumed by a fresh worker", async () => {
  const job = {
    jobId: "job-resume",
    status: "running",
    tasks: [],
    results: [],
    currentIndex: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  const { local } = bootRecordingWorker({ zehProviderBenchmarkJob: job, zehCacheCleanupMeta: { lastCleanupAt: Date.now() } });
  await waitFor(() => local.data.zehProviderBenchmarkJob?.status !== "running", 2000, "resumed job to finish");
  assert.equal(local.data.zehProviderBenchmarkJob.status, "completed");
});

test("startup: listeners exist as soon as the entry file returns (no listener added later)", async () => {
  const { calls } = bootRecordingWorker();
  await sleep(30);
  assert.deepEqual(
    calls.filter((c) => c.startsWith("async:") && c.endsWith(".addListener")),
    [],
    "a listener registered after the first evaluation misses the event that woke the worker"
  );
});

// ── restart: Chrome stops an idle worker; the next event starts a new one ─────────────────────

const SENTENCE = "The committee postponed the vote until the next quarterly meeting.";

function providerStorage() {
  return { zehActiveProvider: "deepseek", zehProviders: { deepseek: { enabled: true, apiKey: "test-key", model: "" } } };
}

function terminal(bg, queryId) {
  return bg.tabMessages.find(
    (m) => m.message.queryId === queryId && (m.message.type === "SHOW_RESULT" || m.message.type === "SHOW_ERROR")
  );
}

test("restart: a new worker over the same storage serves the cached result without a request", async () => {
  const onChanged = createEvent();
  const local = createStorageArea(providerStorage(), { onChanged });
  const fetchFirst = async () => openAIChatResponse(JSON.stringify({ term: SENTENCE, translation: "委员会推迟了投票。" }));
  const first = loadBackground({ local, onChanged, fetch: fetchFirst });
  await first.dispatch({ type: "EXPLAIN", text: SENTENCE, queryId: "q1" }, { tab: { id: 1 } });
  await waitFor(() => terminal(first, "q1"), 2000, "first result");
  assert.equal(terminal(first, "q1").message.type, "SHOW_RESULT");
  assert.equal(first.fetchCalls.length, 1);

  // The old worker's memory (pending lookups, dictionary, timers) is gone; only storage is shared.
  const second = loadBackground({ local, onChanged, fetch: async () => assert.fail("must not call the provider") });
  await second.dispatch({ type: "EXPLAIN", text: SENTENCE, queryId: "q2" }, { tab: { id: 1 } });
  await waitFor(() => terminal(second, "q2"), 2000, "cached result");
  const { message } = terminal(second, "q2");
  assert.equal(message.type, "SHOW_RESULT");
  assert.equal(message.data.translation, "委员会推迟了投票。");
  assert.equal(message.fromCache, true);
  assert.equal(second.fetchCalls.length, 0);
});

test("restart: vocabulary and review state written by one worker are read by the next", async () => {
  const local = createStorageArea({});
  const first = loadBackground({ local });
  const added = await first.dispatch({ type: "ADD_VOCAB", item: { term: "prayer", queryType: "word", short_meaning: "祈祷" } });
  assert.equal(added.ok, true);
  const id = local.data.zehVocabulary[0].id;

  const second = loadBackground({ local });
  const reviewed = await second.dispatch({ type: "REVIEW_VOCAB", id, rating: "good" });
  assert.equal(reviewed.ok, true);
  assert.equal(local.data.zehVocabulary.length, 1);
  assert.equal(local.data.zehVocabulary[0].review.reviewCount, 1);
});

// ── settings read path (getAppSettings + migrateLegacySettings) ─────────────────────────────

test("getAppSettings: a profile with only the old OpenAI keys becomes an OpenAI-only provider set", async () => {
  const bg = loadBackground({ storage: { openaiApiKey: "sk-old", openaiModel: "gpt-old-model" } });
  const settings = JSON.parse(JSON.stringify(await evalIn(bg.context, "getAppSettings()")));
  assert.equal(settings.activeProvider, "openai");
  assert.equal(settings.liveTranscribeProvider, "");
  assert.equal(settings.providers.openai.apiKey, "sk-old");
  assert.equal(settings.providers.openai.enabled, true);
  assert.equal(settings.providers.openai.model, "gpt-old-model");
  for (const [id, p] of Object.entries(settings.providers)) {
    if (id !== "openai") assert.equal(p.enabled, false, `${id} disabled`);
  }
  // Written once, with a theme; the old keys are left in place.
  assert.deepEqual(bg.local.data.zehProviders, settings.providers);
  assert.equal(bg.local.data.zehActiveProvider, "openai");
  assert.ok(bg.local.data.zehTheme, "default theme written");
  assert.equal(bg.local.data.openaiApiKey, "sk-old");
});

test("getAppSettings: an existing provider set is read as is and not rewritten", async () => {
  const providers = evalIn(loadBackground().context, "JSON.stringify(zehDefaultProviders())");
  const stored = JSON.parse(providers);
  stored.deepseek.apiKey = "k";
  stored.deepseek.enabled = true;
  const bg = loadBackground({
    storage: { zehProviders: stored, zehActiveProvider: "deepseek", zehTheme: { mode: "x" }, zehLiveTranscribeProvider: "deepseek" },
  });
  const settings = JSON.parse(JSON.stringify(await evalIn(bg.context, "getAppSettings()")));
  assert.equal(settings.activeProvider, "deepseek");
  assert.equal(settings.liveTranscribeProvider, "deepseek");
  assert.deepEqual(settings.providers, stored);
  assert.equal(bg.local.setCalls.filter((keys) => keys.includes("zehProviders")).length, 0);
});

// ── cache cleanup over the per-type limit ─────────────────────────────────────────────────────

test("cache cleanup: entries over a type's limit are removed least recently used first", async () => {
  const bg = loadBackground();
  const limit = evalIn(bg.context, 'zehGetCachePolicy("sentence").maxEntries');
  const now = Date.now();
  const rows = {};
  for (let i = 0; i < limit + 3; i++) {
    const key = evalIn(bg.context, `zehCacheV2StorageKey("sentence", ${30 + i}, "${(0xa0000000 + i).toString(16)}")`);
    rows[key] = { data: { translation: `t${i}` }, queryType: "sentence", createdAt: now, savedAt: now, lastAccessedAt: now - (limit + 3 - i) * 1000 };
  }
  Object.assign(bg.local.data, rows);
  const summary = JSON.parse(JSON.stringify(await evalIn(bg.context, 'cleanupLookupCache("manual")')));
  assert.equal(summary.beforeCount, limit + 3);
  assert.equal(summary.afterCount, limit);
  assert.equal(summary.deletedByType.sentence, 3);
  const left = Object.keys(bg.local.data).filter((k) => k in rows);
  const removed = Object.keys(rows).filter((k) => !left.includes(k));
  assert.deepEqual(removed.sort(), Object.keys(rows).slice(0, 3).sort(), "the three oldest accesses go");
  assert.equal(bg.local.data.zehCacheCleanupMeta.lastReason, "manual");
});
