/**
 * M6 characterisation: every Settings section, visited twice in two different orders.
 *
 * Splitting settings.js into settings/*.js must not change what a section renders or how
 * navigation behaves. For each section this checks the title and description, the URL hash,
 * the active nav item, the saved section, and the element ids and data-action values of the
 * section markup against tests/fixtures/settings-sections.json (recorded from the single-file
 * settings.js before the split). Each visit is also checked for exceptions, unhandled
 * rejections, alerts and storage writes: the page itself writes nothing; leaving 模型与 API asks the
 * service worker to save the providers (M9: the worker is their only writer).
 *
 * Regenerate the fixture only for an intended markup change:
 *   UPDATE_SETTINGS_SECTIONS=1 node --test tests/settings-sections.test.js
 */
process.env.TZ = "Asia/Shanghai";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createStorageArea, createEvent, waitFor, loadBackground } = require("./helpers/extension-sandbox");
const { loadSettingsPage } = require("./helpers/settings-page");

const FIXTURE = path.join(__dirname, "fixtures", "settings-sections.json");
const UPDATE = process.env.UPDATE_SETTINGS_SECTIONS === "1";
const DAY = 86400000;

function storage() {
  const now = Date.now();
  return {
    zehProviders: {
      openai: { enabled: false, apiKey: "", model: "" },
      deepseek: { enabled: true, apiKey: "sk-test-not-real", model: "" },
    },
    zehActiveProvider: "deepseek",
    zehUsageLogs: [
      { ts: now - DAY, provider: "deepseek", model: "deepseek-flash", totalTokens: 120, queryType: "word" },
      { ts: now - 2 * DAY, provider: "deepseek", model: "deepseek-flash", totalTokens: 300, queryType: "sentence" },
    ],
    zehVocabulary: [
      {
        id: "v1",
        serial: 1,
        savedAt: now - DAY,
        term: "harbour",
        queryType: "word",
        short_meaning: "港口",
        contexts: [{ id: "c1", sentence: "The ship left the harbour.", pageTitle: "Sea" }],
      },
    ],
  };
}

/** Background replies the sections ask for; anything else gets an empty ok. */
async function sendMessage(message) {
  switch (message && message.type) {
    case "GET_LOOKUP_CACHE_STATS":
      return { ok: true, stats: { totalEntries: 0, totalBytes: 0, expiredCount: 0, byType: {} }, entries: [] };
    case "GET_PROVIDER_BENCHMARK_STATUS":
      return { ok: true, job: null };
    default:
      return { ok: true };
  }
}

function markupSignature(html) {
  return {
    ids: [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]),
    actions: [...new Set([...html.matchAll(/\sdata-action="([^"]+)"/g)].map((m) => m[1]))].sort(),
  };
}

/**
 * The fake DOM has no canvas: give the usage chart a wrapper and a 2D context that draws nothing.
 * 实时转译 also checks chrome.storage.session for a pending tab-audio capture.
 */
function prepareFakeDom(context) {
  const canvas = context.document.getElementById("usageChart");
  context.document.createElement("div").appendChild(canvas);
  const noop = () => {};
  const ctx2d = new Proxy({}, { get: (_t, key) => (key === "measureText" ? () => ({ width: 10 }) : noop), set: () => true });
  canvas.getContext = () => ctx2d;
  context.chrome.storage.session = { get: async () => ({}), remove: async () => {}, set: async () => {} };
}

/** The provider messages go to a real worker on the same storage (it alone writes the providers) */
const PROVIDER_MESSAGES = new Set(["SAVE_PROVIDER_SETTINGS", "MIGRATE_PROVIDER_SETTINGS"]);

async function openPage() {
  const onChanged = createEvent();
  const local = createStorageArea(storage(), { onChanged });
  const bg = loadBackground({ local, onChanged });
  const workerMessages = [];
  let prepared = false;
  const page = await loadSettingsPage({
    local,
    onChanged,
    sendMessage: (message) => {
      if (!PROVIDER_MESSAGES.has(message && message.type)) return sendMessage(message);
      workerMessages.push(message.type);
      return bg.dispatch(message);
    },
    hash: "#usage",
    beforeEach: (_file, context) => {
      if (prepared) return;
      prepared = true;
      prepareFakeDom(context);
    },
  });
  // the initial section is "usage" before loadAll() finishes too: wait for its own switchSection
  await waitFor(() => page.document.getElementById("sectionTitle").textContent === "流量统计", 2000, "initial section");
  const errors = [];
  page.context.addEventListener("error", (e) => errors.push(e && e.message));
  page.context.addEventListener("unhandledrejection", (e) => errors.push(String(e && e.reason)));
  return { page, errors, local, workerMessages };
}

async function visit(page, section) {
  page.evalIn(`switchSection(${JSON.stringify(section)})`);
  await waitFor(
    () => page.evalIn("currentSection") === section && page.evalIn("mainBody.innerHTML").length > 0,
    2000,
    `section ${section}`
  );
  // let async renderers (data, reading, benchmark) settle
  await new Promise((r) => setTimeout(r, 30));
  return page.evalIn("mainBody.innerHTML");
}

test("M6: every section renders the same markup in two different visiting orders", async () => {
  const { page, errors } = await openPage();
  const sections = JSON.parse(page.evalIn("JSON.stringify(Object.keys(SECTION_META))"));
  assert.deepEqual(sections, ["appearance", "models", "usage", "vocabulary", "review", "data", "live-transcribe", "reading"]);

  const signatures = {};
  const orders = [sections, [...sections].reverse()];
  for (const order of orders) {
    for (const section of order) {
      const html = await visit(page, section);
      const meta = JSON.parse(page.evalIn(`JSON.stringify(SECTION_META[${JSON.stringify(section)}])`));
      assert.equal(page.document.getElementById("sectionTitle").textContent, meta.title, section);
      assert.equal(page.document.getElementById("sectionDesc").textContent, meta.desc, section);
      const sig = markupSignature(html);
      if (signatures[section]) {
        assert.deepEqual(sig, signatures[section], `${section} renders the same markup on the second visit`);
      }
      signatures[section] = sig;
    }
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(page.alerts, []);

  if (UPDATE) {
    fs.writeFileSync(FIXTURE, JSON.stringify(signatures, null, 2) + "\n");
    return;
  }
  const expected = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  assert.deepEqual(signatures, expected);
});

test("M6: navigation keeps the hash, the active nav item and the saved section in step", async () => {
  const { page } = await openPage();
  const saved = [];
  page.context.sessionStorage.setItem = (key, value) => saved.push([key, value]);
  let hash = "#usage";
  page.context.history.replaceState = (_s, _t, url) => {
    hash = url;
  };
  page.context.location.hash = "#usage";
  Object.defineProperty(page.context.location, "hash", { get: () => hash, configurable: true });
  const navItems = ["models", "usage", "reading"].map((section) => {
    const el = page.document.createElement("button");
    el.className = "nav-item";
    el.dataset.section = section;
    return el;
  });
  page.document.querySelectorAll = (sel) => (sel === ".nav-item" ? navItems : []);

  for (const section of ["reading", "models", "usage"]) {
    await visit(page, section);
    assert.equal(hash, `#${section}`);
    assert.deepEqual(saved.at(-1), ["mkSettingsSection", section]);
    assert.deepEqual(
      navItems.filter((el) => el.classList.contains("active")).map((el) => el.dataset.section),
      [section]
    );
  }
  // unknown sections and the hidden appearance alias are not navigable from the hash
  assert.equal(page.evalIn("normalizeNavSection('appearance')"), "usage");
  page.evalIn("switchSection('nope')");
  assert.equal(page.evalIn("currentSection"), "usage");
});

test("M6: visiting sections writes nothing; leaving 模型与 API has the worker save the providers", async () => {
  const { page, local, workerMessages } = await openPage();
  const providerWrites = () => local.setCalls.filter((keys) => keys.includes("zehProviders"));
  for (const section of ["usage", "vocabulary", "review", "data", "reading", "live-transcribe", "appearance"]) {
    await visit(page, section);
  }
  assert.deepEqual(page.pageSets, [], "no section writes storage just by rendering");
  assert.deepEqual(providerWrites(), []);
  await visit(page, "models");
  await visit(page, "usage");
  await waitFor(() => providerWrites().length > 0, 2000, "providers saved on leaving models");
  assert.deepEqual(providerWrites(), [["zehProviders", "zehActiveProvider"]]);
  assert.deepEqual(workerMessages, ["MIGRATE_PROVIDER_SETTINGS", "SAVE_PROVIDER_SETTINGS"]);
  assert.deepEqual(page.pageSets, [], "the page itself still writes nothing");
  // provider precedence unchanged: the stored active provider stays active
  assert.equal(page.evalIn("activeProvider"), "deepseek");
});

test("M6: settings/*.js only declare at load time; settings.js, loaded last, wires the page", async () => {
  const onChanged = createEvent();
  const local = createStorageArea(storage(), { onChanged });
  const effects = [];
  let current = null;
  const record = (what) => effects.push([current, what]);
  const readLocal = local.get.bind(local);
  local.get = (...args) => {
    record("storage.get");
    return readLocal(...args);
  };
  await loadSettingsPage({
    local,
    onChanged,
    sendMessage: async (message) => {
      record(`message ${message && message.type}`);
      return sendMessage(message);
    },
    hash: "#usage",
    beforeEach: (file, context) => {
      if (current === null) {
        prepareFakeDom(context);
        const winAdd = context.addEventListener;
        context.addEventListener = (type, ...rest) => {
          record(`window ${type}`);
          return winAdd(type, ...rest);
        };
        const docAdd = context.document.addEventListener.bind(context.document);
        context.document.addEventListener = (type, ...rest) => {
          record(`document ${type}`);
          return docAdd(type, ...rest);
        };
      }
      current = file;
    },
  });
  const parts = effects.filter(([file]) => file.startsWith("settings/"));
  assert.deepEqual(parts, [["settings/benchmark.js", "window beforeunload"]]);
  const entry = () => effects.filter(([file]) => file === "settings.js").map(([, what]) => what);
  // loadAll first asks the worker to migrate old settings (M9), then reads storage
  await waitFor(() => entry().includes("storage.get"), 2000, "loadAll reads storage");
  assert.ok(entry().indexOf("message MIGRATE_PROVIDER_SETTINGS") < entry().indexOf("storage.get"));
  for (const expected of ["window error", "window unhandledrejection", "document keydown", "window hashchange", "window focus", "document visibilitychange", "storage.get"]) {
    assert.ok(entry().includes(expected), `settings.js: ${expected}`);
  }
});
