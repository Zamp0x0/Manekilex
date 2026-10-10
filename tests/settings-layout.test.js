/**
 * 0.11.1 Settings → 模型与 API layout regression (structural).
 *
 * Root cause of the overlapping provider cards: `.main` is a column flexbox capped at 100vh and
 * `.main-body` had the default flex-shrink: 1, so on a short window the body was squeezed to the
 * viewport height while the cards kept their natural height and spilled over its bottom border;
 * the sticky `.models-footer` then floated over the card list. The fix keeps the body at its
 * content height and puts the footer back in normal flow after the cards.
 *
 * Real-browser check (Chromium, documented in the 0.11.1 report): at 1280×900, 1280×600,
 * 900×700 and 700×600 every card sits inside .main-body, no two cards overlap, no input
 * escapes its card and the footer is below the last card.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createStorageArea, createEvent, runFile, loadBackground } = require("./helpers/extension-sandbox");
const { loadSettingsPage } = require("./helpers/settings-page");

const css = fs.readFileSync(path.join(__dirname, "..", "settings.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** Declarations of every top-level rule whose selector list contains exactly `selector`. */
function rules(selector) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(css))) {
    const selectors = m[1].split(",").map((s) => s.trim());
    if (selectors.includes(selector)) out.push(m[2]);
  }
  return out;
}

function declared(selector, property) {
  const values = [];
  rules(selector).forEach((body) => {
    body.split(";").forEach((decl) => {
      const [prop, ...rest] = decl.split(":");
      if (prop && prop.trim() === property) values.push(rest.join(":").trim());
    });
  });
  return values;
}

test("the settings body keeps its content height inside the 100vh column", () => {
  assert.deepEqual(declared(".main", "max-height"), ["100vh"], "precondition: capped column");
  assert.deepEqual(declared(".main-body", "flex-shrink"), ["0"]);
  // stretch sections (vocabulary / data / transcribe) still fill and scroll inside
  assert.deepEqual(declared(".main-body.section-stretch", "min-height"), ["0"]);
});

test("provider cards and the models footer use normal flow: no sticky / absolute / fixed heights", () => {
  for (const selector of [".models-footer", ".models-scroll", ".provider-card", ".provider-card .field", ".field"]) {
    for (const value of declared(selector, "position")) {
      assert.ok(!/sticky|absolute|fixed/.test(value), `${selector} position: ${value}`);
    }
    assert.deepEqual(declared(selector, "height"), [], `${selector} has no fixed height`);
    assert.deepEqual(declared(selector, "max-height"), [], `${selector} has no max-height`);
  }
  for (const value of declared(".provider-card", "overflow")) {
    assert.notEqual(value, "hidden", "inputs are not clipped by the card");
  }
});

test("renderModels: cards first, then the save status footer, then the benchmark panel", async () => {
  const onChanged = createEvent();
  const local = createStorageArea({}, { onChanged });
  const page = await loadSettingsPage({ local, onChanged, sendMessage: async () => ({}) });
  runFile(page.context, "provider-benchmark.js"); // settings.html loads it before settings.js
  page.evalIn("renderModels()");
  const html = page.evalIn("mainBody.innerHTML");
  const cards = html.indexOf('class="models-scroll"');
  const footer = html.indexOf('class="models-footer"');
  const bench = html.indexOf('id="benchmarkPanelMount"');
  assert.ok(cards >= 0 && footer > cards, "footer after the cards");
  assert.ok(bench > footer, "benchmark after the footer");
  const ids = [...html.matchAll(/data-provider="([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, JSON.parse(page.evalIn("JSON.stringify(ZEH_PROVIDER_IDS)")), "one card per provider, OpenAI → Gemini");
  assert.match(html, /value="gpt-6-luna"/);
  assert.match(html, /value="deepseek-flash"/);
  assert.doesNotMatch(html, /style="[^"]*(position|height)/, "no inline positioning / heights on cards");
});

// ── F4: attribute-safe escaping ─────────────────────────────────────────────────────────────

/**
 * Start tags of `html` with their attributes, read the way the browser's tokenizer reads them:
 * a double-quoted value ends at the next `"`, whatever follows it. Entities are decoded.
 */
function browserStartTags(html) {
  const decode = (v) =>
    v
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  const out = [];
  const tagRe = /<([a-zA-Z][\w-]*)\b([^>]*)>/g;
  let m;
  while ((m = tagRe.exec(html))) {
    const attrs = {};
    const attrRe = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    let a;
    while ((a = attrRe.exec(m[2]))) {
      const name = a[1].toLowerCase();
      if (!(name in attrs)) attrs[name] = decode(a[2] ?? a[3] ?? a[4] ?? "");
    }
    out.push({ tag: m[1].toLowerCase(), attrs, classes: (attrs.class || "").split(/\s+/) });
  }
  return out;
}

const QUOTED_MODEL = `my "fast" model's v2`;

/** Settings saves the providers through the service worker (M9): a real worker on the same storage */
function withProviderWorker(local, onChanged, other) {
  const bg = loadBackground({ local, onChanged });
  return (message) =>
    ["SAVE_PROVIDER_SETTINGS", "MIGRATE_PROVIDER_SETTINGS"].includes(message && message.type) ? bg.dispatch(message) : other(message);
}

async function modelsPageWith(providers) {
  const onChanged = createEvent();
  const local = createStorageArea({ zehActiveProvider: "openai", zehProviders: providers }, { onChanged });
  const page = await loadSettingsPage({ local, onChanged, sendMessage: withProviderWorker(local, onChanged, async () => ({})) });
  runFile(page.context, "provider-benchmark.js");
  page.evalIn("currentSection = 'models'; renderModels()");
  return { page, local };
}

test("F4: a model name containing quotes renders intact and survives the provider autosave", async () => {
  const { page, local } = await modelsPageWith({ openai: { enabled: true, apiKey: "test-key", model: QUOTED_MODEL } });
  const tags = browserStartTags(page.evalIn("mainBody.innerHTML"));
  const modelInput = tags.find((t) => t.classes.includes("provider-model") && t.attrs["data-id"] === "openai");
  assert.ok(modelInput, "openai model input rendered");
  assert.equal(modelInput.attrs.value, QUOTED_MODEL, "the browser would show the whole model name");

  // 浏览器里自动保存读的是输入框的 value：把浏览器解析出的输入框放进页面，再保存
  for (const t of tags.filter((x) => x.tag === "input" && (x.classes.includes("provider-model") || x.classes.includes("provider-key")))) {
    const el = page.document.createElement("input");
    el.className = t.attrs.class;
    el.setAttribute("data-id", t.attrs["data-id"]);
    el.value = t.attrs.value;
    page.document.body.appendChild(el);
  }
  await page.evalIn("saveProviders(false)");
  const { zehProviders } = await local.get("zehProviders");
  assert.equal(zehProviders.openai.model, QUOTED_MODEL);
  assert.equal(zehProviders.openai.apiKey, "test-key");
});

test("F4: a book title and benchmark model containing quotes stay intact in attributes", async () => {
  const { page } = await modelsPageWith({});
  const title = `The "Quoted" Book — Author's Cut`;
  const card = browserStartTags(page.evalIn(`bookCardHtml(${JSON.stringify({ id: "b1", title, author: "A" })})`));
  assert.equal(card.find((t) => t.classes.includes("book-title")).attrs.title, title);

  const escaped = page.evalIn(`escapeHtml(${JSON.stringify(`a"b'c<d>&e`)})`);
  const [btn] = browserStartTags(`<button data-model="${escaped}" title='${escaped}'>`);
  assert.equal(btn.attrs["data-model"], `a"b'c<d>&e`);
  assert.equal(btn.attrs.title, `a"b'c<d>&e`);
});

// ── F8: async section renders and visible save errors ───────────────────────────────────────

const { waitFor, sleep } = require("./helpers/extension-sandbox");

const QUOTA = "QUOTA_BYTES quota exceeded";

async function settingsPage({ providers, sendMessage, hash = "#vocabulary" } = {}) {
  const onChanged = createEvent();
  const local = createStorageArea(
    {
      zehActiveProvider: "openai",
      zehProviders: providers || {
        openai: { enabled: true, apiKey: "test-key", model: "" },
        deepseek: { enabled: false, apiKey: "test-key-2", model: "" },
      },
    },
    { onChanged }
  );
  const sent = [];
  const page = await loadSettingsPage({
    local,
    onChanged,
    hash,
    sendMessage: withProviderWorker(local, onChanged, async (message) => {
      sent.push(message);
      return sendMessage ? sendMessage(message) : { ok: true };
    }),
  });
  runFile(page.context, "provider-benchmark.js");
  const body = () => page.evalIn("mainBody.innerHTML");
  const status = () => page.document.getElementById("saveStatus");
  return { page, local, sent, body, status };
}

test("F8: switching from Data to Models while Data is still loading leaves Models in place", async () => {
  let releaseStats;
  const { page, body } = await settingsPage({
    sendMessage: (message) =>
      message.type === "GET_LOOKUP_CACHE_STATS"
        ? new Promise((resolve) => {
            releaseStats = () => resolve({ ok: true, stats: { totalCount: 3, totalBytes: 10, byType: {} } });
          })
        : { ok: true },
  });
  page.evalIn("switchSection('data')");
  assert.match(body(), /data-loading/);
  await waitFor(() => typeof releaseStats === "function", 2000, "cache stats request");

  page.evalIn("switchSection('models')");
  assert.match(body(), /class="models-scroll"/);

  releaseStats(); // Data's reads finish after the user has left the section
  await sleep(20);
  assert.equal(page.evalIn("currentSection"), "models");
  assert.match(body(), /class="models-scroll"/, "Models is still shown");
  assert.doesNotMatch(body(), /data-storage-panel/, "Data did not overwrite Models");
});

test("F8: Data still renders when the user stays on it", async () => {
  const { page, body } = await settingsPage({
    sendMessage: (message) =>
      message.type === "GET_LOOKUP_CACHE_STATS" ? { ok: true, stats: { totalCount: 3, totalBytes: 10, byType: {} } } : { ok: true },
  });
  page.evalIn("switchSection('data')");
  await waitFor(() => /data-storage-panel/.test(body()), 2000, "data section");
  assert.match(body(), /3 条/);
});

test("F8: saveProviders reports failure and enabling a provider keeps the save error visible", async () => {
  const { page, local, status } = await settingsPage();
  const toggle = page.document.createElement("input");
  toggle.className = "provider-enable";
  toggle.setAttribute("data-id", "deepseek");
  page.document.body.appendChild(toggle); // renderModels binds its change handler to it
  page.evalIn("switchSection('models')");

  local.failSetWith = new Error(QUOTA);
  status().textContent = "";
  toggle.checked = true;
  toggle.dispatchEvent({ type: "change", target: toggle });
  await waitFor(() => status().textContent, 2000, "save status");
  await sleep(10);
  assert.match(status().textContent, /QUOTA_BYTES/, "the save error is shown");
  assert.match(status().className, /\berr\b/);
  assert.doesNotMatch(status().textContent, /已启用/, "no success message after a failed save");

  const result = await page.evalIn("saveProviders(false)");
  assert.equal(result.ok, false);
  assert.match(result.error, /QUOTA_BYTES/);
  local.failSetWith = null;
  assert.equal((await page.evalIn("saveProviders(false)")).ok, true);
});

test("F8: a failing save when leaving Models is reported, and a failing save stops the benchmark start", async () => {
  const { page, local, sent, status } = await settingsPage();
  page.evalIn("switchSection('models')");
  local.failSetWith = new Error(QUOTA);

  page.evalIn("switchSection('vocabulary')");
  await waitFor(() => page.alerts.length > 0, 2000, "error notice after leaving Models");
  assert.match(page.alerts[0], /QUOTA_BYTES/);

  page.evalIn("switchSection('models')");
  status().textContent = "";
  await page.evalIn("startProviderBenchmark('quick')");
  assert.equal(sent.filter((m) => m.type === "START_PROVIDER_BENCHMARK").length, 0, "benchmark not started");
  assert.match(status().textContent, /QUOTA_BYTES/);
  assert.match(status().className, /\berr\b/);

  local.failSetWith = null;
  await page.evalIn("startProviderBenchmark('quick')");
  assert.equal(sent.filter((m) => m.type === "START_PROVIDER_BENCHMARK").length, 1, "starts once the save works");
});
