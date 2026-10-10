/**
 * Global surface of each execution context: the top-level names its scripts leave behind once
 * the context has finished loading, captured from the real declared script lists.
 *
 *   global   own properties added to the global object (var / function declarations,
 *            window.X = … / global.X = … assignments, vendored libraries) and, in the page
 *            sandboxes that keep `window` as its own object, properties added to `window`
 *   lexical  top-level const / let / class bindings of first-party files: they share the
 *            context's scope but are not properties of the global object. Found with the
 *            tokenizer (brace depth 0) and kept only if the name really resolves in the loaded
 *            context. Destructuring declarations and lexical bindings inside the minified
 *            libraries are not listed.
 *
 * The snapshot is a characterization: it records what exists today so that moving code between
 * files (refactor phases) cannot silently add, drop or rename a name another file relies on.
 */
const vm = require("node:vm");
const { getContext } = require("./load-order");
const { tokenize, readSource, isFirstParty } = require("./script-scan");
const { loadBackground, createStorageArea, createEvent } = require("./extension-sandbox");
const { createPageEnv, disposeLookupControllers } = require("./fake-dom");
const { loadSettingsPage } = require("./settings-page");
const { loadReaderPage } = require("./reader-page");
const { loadPopupPage, loadSidePanelPage } = require("./extension-pages");
const { loadPdfReaderPage } = require("./pdf-reader-page");

const LEXICAL = new Set(["const", "let", "class"]);

/** Top-level const / let / class names of one file (brace depth 0). */
function topLevelLexicalNames(rel) {
  const tokens = tokenize(readSource(rel));
  const out = [];
  let depth = 0;
  tokens.forEach((t, k) => {
    if (t.type === "punct" && t.value === "{") depth += 1;
    else if (t.type === "punct" && t.value === "}") depth -= 1;
    else if (depth === 0 && t.type === "ident" && LEXICAL.has(t.value)) {
      const next = tokens[k + 1];
      if (next && next.type === "ident") out.push(next.value);
    }
  });
  return out;
}

/** Records the global object's (and window's) own property names before the first script. */
function baselineRecorder() {
  let baseline = null;
  return {
    hook(_file, ctx) {
      if (baseline) return;
      baseline = new Set(Object.getOwnPropertyNames(ctx));
      if (ctx.window && ctx.window !== ctx) {
        Object.getOwnPropertyNames(ctx.window).forEach((n) => baseline.add(`window.${n}`));
      }
    },
    get: () => baseline,
  };
}

function surfaceOf(vmContext, win, baseline, loaded) {
  const global = new Set();
  Object.getOwnPropertyNames(vmContext).forEach((n) => {
    if (!baseline.has(n)) global.add(n);
  });
  if (win && win !== vmContext) {
    Object.getOwnPropertyNames(win).forEach((n) => {
      if (!baseline.has(`window.${n}`)) global.add(n);
    });
  }
  const lexical = new Set();
  for (const file of loaded) {
    if (!isFirstParty(file)) continue;
    for (const name of topLevelLexicalNames(file)) {
      if (global.has(name)) continue;
      let resolves = false;
      try {
        resolves = vm.runInContext(`typeof ${name} !== "undefined" || (() => { ${name}; return true; })()`, vmContext);
      } catch {
        resolves = false;
      }
      if (resolves) lexical.add(name);
    }
  }
  return { global: [...global].sort(), lexical: [...lexical].sort() };
}

/** Load one context from its real script list and return its { global, lexical } surface. */
async function captureSurface(name) {
  const rec = baselineRecorder();
  switch (name) {
    case "service-worker": {
      const bg = loadBackground();
      return surfaceOf(bg.context, null, new Set(bg.sandboxGlobals), getContext(name).scripts);
    }
    case "content": {
      const env = createPageEnv({ context: "content", only: undefined, beforeEach: rec.hook });
      const out = surfaceOf(env.context, env.window, rec.get(), env.loaded);
      disposeLookupControllers();
      return out;
    }
    case "settings": {
      const onChanged = createEvent();
      const page = await loadSettingsPage({
        local: createStorageArea({}, { onChanged }),
        onChanged,
        sendMessage: async () => undefined,
        beforeEach: rec.hook,
      });
      return surfaceOf(page.context, null, rec.get(), page.loaded);
    }
    case "reader": {
      const reader = await loadReaderPage({ sections: 2, beforeEach: rec.hook });
      return surfaceOf(reader.context, null, rec.get(), reader.loaded);
    }
    case "popup": {
      const popup = loadPopupPage({ beforeEach: rec.hook });
      return surfaceOf(popup.context, popup.window, rec.get(), popup.loaded);
    }
    case "side-panel": {
      const panel = loadSidePanelPage({ beforeEach: rec.hook });
      const out = surfaceOf(panel.context, panel.window, rec.get(), panel.loaded);
      disposeLookupControllers();
      return out;
    }
    case "pdf-reader": {
      const reader = loadPdfReaderPage({ beforeEach: rec.hook });
      await reader.app.ready;
      const out = surfaceOf(reader.context, reader.window, rec.get(), reader.loaded);
      reader.app.destroy();
      disposeLookupControllers();
      return out;
    }
    default:
      throw new Error(`unknown context ${name}`);
  }
}

module.exports = { captureSurface, topLevelLexicalNames };
