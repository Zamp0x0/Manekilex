/**
 * B. Runtime bootstrap checks: each execution context's real scripts run, in the declared order,
 * in a node:vm sandbox shaped like that context (worker global, web page, extension page).
 *
 * What this proves: every file's top-level code runs without throwing given the globals its
 * context provides, the files earlier in the list really create what later files use, and the
 * listeners / page wiring each context needs exist once loading finishes.
 * What it cannot prove: rendering, CSS, layout, real DOM events, HTML parsing of innerHTML
 * (so pdf-page-assistant.js's PDF-page branch is not run), Chrome API argument validation
 * (unknown chrome.* members resolve to a permissive stub) and the vendored libraries' behaviour
 * beyond their top-level evaluation.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");

const { getContext, loadContextScripts } = require("./helpers/load-order");
const { referencedProjectGlobals, isFirstParty } = require("./helpers/script-scan");
const { loadBackground, createStorageArea, createEvent, runFile, sleep, waitFor } = require("./helpers/extension-sandbox");
const { createPageEnv, loadContentScript, disposeLookupControllers } = require("./helpers/fake-dom");
const { loadSettingsPage } = require("./helpers/settings-page");
const { loadReaderPage } = require("./helpers/reader-page");
const { loadPopupPage, loadSidePanelPage } = require("./helpers/extension-pages");

test.afterEach(() => disposeLookupControllers());

/**
 * Project globals (zeh* / ZEH* / MK*) used by the loaded first-party files that do not exist
 * once loading finished. A name counts as present when it resolves as a free identifier in the
 * context, or as a property of `win` (the page sandboxes keep `window` as its own object).
 */
function unresolvedProjectGlobals(vmContext, loaded, win) {
  const missing = [];
  for (const file of loaded) {
    if (!isFirstParty(file)) continue;
    for (const [name, line] of referencedProjectGlobals(file)) {
      const free = vm.runInContext(`typeof ${name}`, vmContext) !== "undefined";
      const onWindow = win && win[name] !== undefined;
      if (!free && !onWindow) missing.push(`${file}:${line} ${name}`);
    }
  }
  return missing;
}

/** Global property names each vendored library added (a library that failed to attach adds none). */
function recordLibraryGlobals() {
  const added = {};
  let before = null;
  return {
    added,
    hook(file, ctx) {
      const now = new Set(Object.getOwnPropertyNames(ctx));
      if (!isFirstParty(file)) added[file] = [...now].filter((k) => before && !before.has(k));
      before = now;
    },
  };
}

const DOM_GLOBALS = ["window", "document", "Node", "Element", "HTMLElement", "localStorage", "sessionStorage", "alert"];

// ── service worker ──────────────────────────────────────────────────────────────────────────

test("service worker: boots from the manifest entry, imports its list, and has no DOM globals", () => {
  const ctx = getContext("service-worker");
  const bg = loadBackground();
  assert.equal(bg.entry, ctx.entry);
  assert.deepEqual(bg.importedScripts, ctx.imports, "importScripts() ran a different list than background.js declares");
  for (const name of DOM_GLOBALS) {
    assert.equal(vm.runInContext(`typeof ${name}`, bg.context), "undefined", `${name} must not exist in a worker`);
  }
  assert.deepEqual(unresolvedProjectGlobals(bg.context, ctx.scripts, null), []);
});

test("service worker: event listeners are registered during the first synchronous evaluation", () => {
  const bg = loadBackground();
  // Chrome only wakes a worker for events whose listeners exist after the first evaluation.
  assert.ok(bg.chrome.runtime.onMessage.listeners.length >= 1, "no runtime.onMessage listener at startup");
  assert.ok(bg.chrome.runtime.onInstalled.listeners.length >= 1, "no runtime.onInstalled listener at startup");
  assert.ok(bg.chrome.tabs.onUpdated.listeners.length >= 1, "no tabs.onUpdated listener at startup");
});

test("service worker: importScripts() after the initial evaluation is rejected, like in Chrome", () => {
  const bg = loadBackground();
  assert.throws(() => bg.context.importScripts("config.js"), /after the worker's initial evaluation/);
});

// ── content scripts ─────────────────────────────────────────────────────────────────────────

test("content scripts: the manifest list loads on a web page and wires the lookup", async () => {
  const ctx = getContext("content");
  const env = loadContentScript();
  assert.deepEqual(env.loaded, ctx.scripts);
  assert.equal(typeof env.window.MKLookup.createController, "function");
  assert.ok(env.onMessageListenerCount() >= 1, "content.js registered no runtime.onMessage listener");
  // pdf-page-assistant.js returns early on a non-PDF page. Its PDF branch builds its UI with
  // innerHTML and then looks the parts up by id, which this fake DOM cannot parse, so that
  // branch is left to manual testing in Chrome rather than faked here.
  assert.equal(env.window.__ZEH_PDF_PAGE__, undefined);
  assert.deepEqual(unresolvedProjectGlobals(env.context, env.loaded, env.window), []);
  await sleep(5);
});

test("content scripts: a missing dependency fails loudly (mk-lookup.js left out)", () => {
  const all = getContext("content").scripts;
  assert.throws(
    () => createPageEnv({ only: all.filter((f) => f !== "mk-lookup.js") }),
    (err) => /MKLookup|createController/.test(String(err && err.message)),
    "content.js must not load silently without the lookup controller it depends on"
  );
});

// ── Settings page ───────────────────────────────────────────────────────────────────────────

test("settings page: every settings.html script runs in order and the page initialises", async () => {
  const ctx = getContext("settings");
  const onChanged = createEvent();
  const local = createStorageArea({}, { onChanged });
  const libs = recordLibraryGlobals();
  const page = await loadSettingsPage({
    local,
    onChanged,
    sendMessage: async () => undefined,
    afterEach: libs.hook,
  });
  assert.deepEqual(page.loaded, ctx.scripts);
  for (const lib of ctx.scripts.filter((f) => !isFirstParty(f))) {
    assert.ok(libs.added[lib] && libs.added[lib].length > 0, `${lib} created no global`);
  }
  assert.deepEqual(unresolvedProjectGlobals(page.context, page.loaded, null), []);
  assert.ok(page.fetched.every((url) => url.startsWith("chrome-extension://test-extension/")), page.fetched.join(", "));
});

// ── Reader page ─────────────────────────────────────────────────────────────────────────────

test("reader page: every reader.html script runs in order and the reader opens a book", async () => {
  const ctx = getContext("reader");
  const libs = recordLibraryGlobals();
  const reader = await loadReaderPage({ sections: 3, afterEach: libs.hook });
  assert.deepEqual(reader.loaded, ctx.scripts);
  assert.equal(typeof reader.realEpub, "function", "lib/epub.min.js did not define ePub");
  for (const lib of ctx.scripts.filter((f) => !isFirstParty(f))) {
    assert.ok(libs.added[lib] && libs.added[lib].length > 0, `${lib} created no global`);
  }
  assert.deepEqual(unresolvedProjectGlobals(reader.context, reader.loaded, null), []);
  await waitFor(() => reader.epub.displays.length >= 1, 5000, "reader.js asking the rendition to display the book");
});

// ── Toolbar popup ───────────────────────────────────────────────────────────────────────────

test("popup: every popup.html script runs against the page's real element ids", async () => {
  const ctx = getContext("popup");
  const popup = loadPopupPage({ storage: { zehManekilexEnabled: false } });
  assert.deepEqual(popup.loaded, ctx.scripts);
  assert.deepEqual(unresolvedProjectGlobals(popup.context, popup.loaded, popup.window), []);
  assert.equal(popup.document.getElementById("openSettings").listenerCount("click"), 1);
  assert.equal(popup.document.getElementById("captureTabAudio").listenerCount("click"), 1);
  await waitFor(() => popup.document.getElementById("manekilexDisabledHint").hidden === false, 5000, "popup reading the enabled flag");
  assert.equal(popup.tabQueries.length, 1);
  assert.equal(popup.document.getElementById("manekilexEnabledToggle").checked, false, "stored enabled flag not applied");
  assert.equal(popup.document.getElementById("manekilexDisabledHint").hidden, false);
});

// ── Side panel ──────────────────────────────────────────────────────────────────────────────

test("side panel: every lookup-panel.html script runs and mounts the lookup panel", async () => {
  const ctx = getContext("side-panel");
  const panel = loadSidePanelPage();
  assert.deepEqual(panel.loaded, ctx.scripts);
  assert.deepEqual(unresolvedProjectGlobals(panel.context, panel.loaded, panel.window), []);
  assert.ok(panel.document.body.classList.contains("mode-panel"));
  assert.ok(panel.onMessageListenerCount() >= 1, "lookup-panel.js registered no runtime.onMessage listener");
  await sleep(5);
});

test("side panel protocol: ?text= starts one lookup and the panel renders the reply for that query", async () => {
  const panel = loadSidePanelPage({ search: "?text=serendipity" });
  await waitFor(() => panel.messages("EXPLAIN").length === 1, 2000, "EXPLAIN from the side panel");
  const [sent] = panel.messages("EXPLAIN");
  assert.equal(sent.message.text, "serendipity");
  assert.ok(sent.message.queryId, "the lookup carries a queryId");
  assert.ok(panel.document.body.classList.contains("mode-panel"));
  assert.equal(panel.document.getElementById("pdfPanelWrap").hidden, false);
  assert.equal(panel.document.getElementById("lookupPanelEmpty").hidden, true, "the empty state is replaced by the lookup");
  assert.equal(panel.document.getElementById("lookupPanelHint").hidden, false);

  panel.deliver({
    type: "SHOW_RESULT",
    queryId: sent.message.queryId,
    queryType: "word",
    data: { term: "serendipity", short_meaning: "意外发现珍奇事物的本领" },
  });
  const html = () => panel.document.querySelector(".zeh-panel")?.querySelector(".zeh-panel-body")?.innerHTML || "";
  await waitFor(() => /意外发现珍奇事物的本领/.test(html()), 2000, "result rendered in the side panel");
  await sleep(5);
});

test("side panel protocol: without ?text= the panel opens empty; no window-mode messages exist any more", async () => {
  // ?mode=pdf and the PDF_ASSISTANT_* messages belonged to a floating PDF window that nothing opens.
  const panel = loadSidePanelPage({ search: "?mode=pdf" });
  assert.ok(panel.document.body.classList.contains("mode-panel"), "always the panel, never the ball");
  assert.equal(panel.document.getElementById("pdfPanelWrap").hidden, false);
  assert.notEqual(panel.document.getElementById("lookupPanelEmpty").hidden, true, "the empty state stays visible");
  panel.deliver({ type: "PDF_ASSISTANT_COLLAPSE" });
  assert.ok(panel.document.body.classList.contains("mode-panel"));
  await sleep(20);
  assert.equal(panel.messages("EXPLAIN").length, 0, "no lookup without text");
  assert.deepEqual(
    panel.sent.map((s) => s.message.type).filter((t) => /^PDF_ASSISTANT_/.test(t)),
    [],
    "the side panel sends no PDF_ASSISTANT_* messages"
  );
});

// ── the sandboxes themselves ────────────────────────────────────────────────────────────────

test("loadContextScripts: substitutes must name a file the context really loads", () => {
  const ctx = vm.createContext({});
  assert.throws(
    () => loadContextScripts(ctx, "popup", runFile, { substitute: { "lib/epub.min.js": () => {} } }),
    /not loaded by popup/
  );
  assert.throws(() => loadContextScripts(ctx, "service-worker", runFile), /loadBackground/);
});
