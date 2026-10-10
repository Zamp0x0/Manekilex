/**
 * M5: config.js is split by consumer. config.js stays the core that every context loads first;
 * the parts only some contexts use live in two directories:
 *
 *   shared/  service worker and/or settings page only (provider tables, prompts, benchmark cases)
 *   lookup/  page-side lookup helpers (content script, reader, side panel)
 *
 * Rules, checked for whatever files the two directories contain (a new part needs no test edit):
 *   - every part on disk is loaded by some context, right after config.js;
 *   - content scripts and the popup load nothing from shared/; the service worker and the
 *     settings page load nothing from lookup/;
 *   - a part only declares: loading config.js and every part makes no chrome, network or timer call;
 *   - no name is declared twice across config.js and the parts;
 *   - no service worker file refers to a DOM global (window, document, Node, Range …): the
 *     page-side selection helpers live in lookup/, which the worker does not load.
 * That every context still finds each project global it uses is checked by
 * tests/load-order-runtime.test.js on the real script lists.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ROOT, getContext, CONTEXT_NAMES } = require("./helpers/load-order");
const { baseGlobals, runFile, configParts } = require("./helpers/extension-sandbox");
const { declaredGlobals, tokenize, readSource } = require("./helpers/script-scan");

const PART_DIRS = ["shared", "lookup"];
const isPart = (file) => PART_DIRS.some((dir) => file.startsWith(`${dir}/`));

function partsOnDisk() {
  const files = [];
  for (const dir of PART_DIRS) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) if (f.endsWith(".js")) files.push(`${dir}/${f}`);
  }
  return files.sort();
}

test("config split: every shared/ and lookup/ file is loaded, right after config.js", () => {
  const loaded = new Set();
  for (const name of CONTEXT_NAMES) {
    const scripts = getContext(name).scripts.filter((f) => f !== "background.js");
    const parts = scripts.filter(isPart);
    parts.forEach((f) => loaded.add(f));
    if (!parts.length) continue;
    assert.equal(scripts[0], "config.js", `${name}: config.js first`);
    assert.deepEqual(scripts.slice(1, 1 + parts.length), parts, `${name}: its parts follow config.js directly`);
  }
  assert.deepEqual([...loaded].sort(), partsOnDisk(), "a part no context loads is dead code");
});

test("config split: content scripts and the popup load no shared/ file; worker and settings no lookup/ file", () => {
  const loads = (name, dir) => getContext(name).scripts.filter((f) => f.startsWith(`${dir}/`));
  assert.deepEqual(loads("content", "shared"), []);
  assert.deepEqual(loads("popup", "shared"), []);
  assert.deepEqual(loads("popup", "lookup"), []);
  assert.deepEqual(loads("service-worker", "lookup"), []);
  assert.deepEqual(loads("settings", "lookup"), []);
});

test("config split: config.js and its parts only declare (no chrome, network or timer call while loading)", () => {
  const calls = [];
  const record = (name) => () => {
    calls.push(name);
    return 0;
  };
  const chrome = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then" || typeof prop === "symbol") return undefined;
      return chrome;
    },
    apply() {
      calls.push("chrome");
    },
  });
  const context = vm.createContext({
    ...baseGlobals(),
    chrome,
    fetch: record("fetch"),
    setTimeout: record("setTimeout"),
    setInterval: record("setInterval"),
  });
  configParts().forEach((file) => runFile(context, file));
  assert.deepEqual(calls, []);
});

test("config split: no name is declared twice across config.js and its parts", () => {
  const owner = new Map();
  const clashes = [];
  for (const file of configParts()) {
    for (const name of declaredGlobals(file)) {
      if (owner.has(name)) clashes.push(`${name}: ${owner.get(name)} and ${file}`);
      else owner.set(name, file);
    }
  }
  assert.deepEqual(clashes, []);
});

const DOM_GLOBALS = new Set([
  "window",
  "document",
  "Node",
  "Element",
  "HTMLElement",
  "Range",
  "Text",
  "NodeFilter",
  "getSelection",
  "getComputedStyle",
  "MutationObserver",
  "localStorage",
  "sessionStorage",
  "alert",
]);

/** Free uses of DOM globals in a file (not `x.window`, not an object key `window:`). */
function domGlobalUses(file) {
  const tokens = tokenize(readSource(file));
  const uses = [];
  tokens.forEach((t, k) => {
    if (t.type !== "ident" || !DOM_GLOBALS.has(t.value)) return;
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    if (prev && prev.type === "punct" && (prev.value === "." || prev.value === "?.")) return;
    if (next && next.type === "punct" && next.value === ":") return;
    uses.push(`${file}: ${t.value}`);
  });
  return uses;
}

test("config split: no service worker file refers to a DOM global", () => {
  const uses = getContext("service-worker").scripts.flatMap(domGlobalUses);
  assert.deepEqual(uses, []);
  // the scan does see them where they are
  assert.ok(partsOnDisk().filter((f) => f.startsWith("lookup/")).flatMap(domGlobalUses).length > 0);
});
