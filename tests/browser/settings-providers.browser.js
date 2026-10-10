/**
 * Provider settings in a real browser (npm run test:browser), after M9: the Settings page asks
 * the service worker to save (SAVE_PROVIDER_SETTINGS) and the worker is the only writer.
 *
 *   - a key, a model and an enabled provider typed on 模型与 API are stored, including when the
 *     worker was stopped before the save (the save wakes it), and a reload shows them again;
 *   - a page save and a benchmark "use this model" sent at the same moment both persist;
 *   - a stopped and woken worker reads exactly what was saved.
 *
 * Keys are made up; no provider is called.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { SKIP_REASON, until, launch } = require("./harness");

let env = null;

test.before(async () => {
  if (SKIP_REASON) return;
  env = await launch();
  console.log(`# browser: ${env.version} (major ${env.major})`);
});

test.after(async () => {
  if (env) await env.close();
});

const opts = { skip: SKIP_REASON || false, timeout: 90000 };

async function settingsPage() {
  const page = await env.ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  await page.goto(`${env.base}/settings.html#models`);
  await page.waitForSelector('.provider-key[data-id="moonshot"]', { timeout: 10000 });
  page.errors = errors;
  return page;
}

/** What chrome.storage.local holds, read by an extension page (the worker handle may be stale) */
const stored = (page) =>
  page.evaluate(async () => {
    const d = await chrome.storage.local.get(["zehProviders", "zehActiveProvider"]);
    return { providers: d.zehProviders, active: d.zehActiveProvider };
  });

/**
 * Stop the extension's service worker (CDP ServiceWorker.stopAllWorkers from an extension page's
 * session reaches it) and keep its status changes, so a test can tell that it ran again.
 */
async function stopWorker(page) {
  const cdp = await env.ctx.newCDPSession(page);
  const statuses = [];
  cdp.on("ServiceWorker.workerVersionUpdated", (e) => {
    for (const v of e.versions) if (v.scriptURL.endsWith("/background.js")) statuses.push(v.runningStatus);
  });
  await cdp.send("ServiceWorker.enable");
  await until(() => statuses.length > 0, 5000, "worker status");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await until(() => statuses.at(-1) === "stopped", 10000, "worker stopped");
  const stoppedAt = statuses.length;
  return {
    ranAgain: () => statuses.slice(stoppedAt).includes("running"),
    statuses,
    detach: () => cdp.detach().catch(() => {}),
  };
}

const statusText = (page) => page.evaluate(() => {
  const el = document.getElementById("saveStatus");
  return el ? { text: el.textContent, err: el.classList.contains("err") } : null;
});

test("settings: a provider typed and enabled while the worker is stopped is saved by the woken worker and shown after a reload", opts, async () => {
  const page = await settingsPage();
  const stop = await stopWorker(page);

  await page.fill('.provider-key[data-id="moonshot"]', "sk-browser-moon-test");
  await page.fill('.provider-model[data-id="moonshot"]', "kimi-browser-test");
  await page.evaluate(() => {
    const box = document.querySelector('.provider-enable[data-id="moonshot"]');
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await until(async () => (await stored(page)).active === "moonshot", 10000, "enabled and saved");
  assert.match((await statusText(page)).text, /已启用/);
  assert.equal((await statusText(page)).err, false);
  await until(stop.ranAgain, 5000, `worker started again (${stop.statuses.join(" → ")})`);

  const after = await stored(page);
  assert.equal(after.active, "moonshot");
  assert.equal(after.providers.moonshot.apiKey, "sk-browser-moon-test");
  assert.equal(after.providers.moonshot.model, "kimi-browser-test");
  assert.equal(after.providers.moonshot.enabled, true);
  assert.equal(after.providers.deepseek.enabled, false, "one enabled provider");
  assert.equal(after.providers.deepseek.apiKey, "browser-test-key", "other providers keep their keys");
  assert.deepEqual(Object.keys(after.providers).sort(), ["deepseek", "gemini", "groq", "moonshot", "openai", "siliconflow", "zhipu"]);
  await stop.detach();

  // stop it again: the reloaded page asks the woken worker to migrate (nothing to do) and shows what is stored
  const again = await stopWorker(page);
  await page.reload();
  await page.waitForSelector('.provider-key[data-id="moonshot"]', { timeout: 10000 });
  assert.equal(await page.inputValue('.provider-key[data-id="moonshot"]'), "sk-browser-moon-test");
  assert.equal(await page.inputValue('.provider-model[data-id="moonshot"]'), "kimi-browser-test");
  assert.equal(await page.isChecked('.provider-enable[data-id="moonshot"]'), true);
  await until(again.ranAgain, 10000, `worker started again (${again.statuses.join(" → ")})`);
  assert.deepEqual(await stored(page), after, "opening Settings changed nothing");
  await again.detach();
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("settings: a page save and a benchmark choice sent at the same moment both persist, also for a woken worker", opts, async () => {
  const page = await settingsPage();
  await page.fill('.provider-key[data-id="zhipu"]', "sk-browser-zhipu-test");
  const [saved, chosen] = await page.evaluate(() =>
    Promise.all([
      saveProviders(false),
      chrome.runtime.sendMessage({ type: "SET_PROVIDER_MODEL_FROM_BENCHMARK", providerId: "deepseek", model: "deepseek-v4-pro" }),
    ])
  );
  assert.equal(saved.ok, true);
  assert.equal(chosen.ok, true);
  const now = await stored(page);
  assert.equal(now.providers.zhipu.apiKey, "sk-browser-zhipu-test", "the page's edit");
  assert.equal(now.providers.deepseek.model, "deepseek-v4-pro", "the benchmark's model");
  assert.equal(now.active, "deepseek");
  assert.equal(now.providers.deepseek.enabled, true);
  assert.equal(Object.values(now.providers).filter((p) => p.enabled).length, 1);
  await until(async () => (await page.inputValue('.provider-model[data-id="deepseek"]')) === "deepseek-v4-pro", 5000, "the page shows the benchmark's model");

  // a woken worker builds its settings from the same storage (getAppSettings, what lookups use)
  const stop = await stopWorker(page);
  const info = await page.evaluate(() => chrome.runtime.sendMessage({ type: "GET_LIVE_TRANSCRIBE_PROVIDER_OPTIONS" }));
  await until(stop.ranAgain, 5000, `worker started again (${stop.statuses.join(" → ")})`);
  await stop.detach();
  assert.equal(info.ok, true);
  const byId = Object.fromEntries(info.options.map((o) => [o.id, o.model]));
  assert.equal(byId.deepseek, "deepseek-v4-pro");
  assert.equal(byId.zhipu, now.providers.zhipu.model);
  assert.deepEqual(await stored(page), now);
  assert.deepEqual(page.errors, []);
  await page.close();
});
