/**
 * M4: the service worker is split into sw/*.js files loaded by background.js's importScripts list.
 * Rules every sw/ module follows (checked here for whatever modules the list contains, so adding
 * a module needs no test edit):
 *
 *   - every sw/*.js file on disk is in the import list, after config.js and the two shared pure
 *     modules, and nothing in sw/ is loaded by a page or a content script;
 *   - a module only declares: loading the whole import list registers no listener and makes no
 *     storage, tab, menu, network or timer call (startup work and listener registration stay in
 *     background.js, during its first synchronous evaluation);
 *   - a module does not use, while it loads, a name that a later file declares (each prefix of the
 *     import list loads on its own);
 *   - no name is declared by two service worker files;
 *   - background.js itself declares nothing: it imports, starts the startup tasks and registers
 *     the listeners.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ROOT, getContext, CONTEXT_NAMES } = require("./helpers/load-order");
const { runFile, baseGlobals } = require("./helpers/extension-sandbox");
const { declaredGlobals } = require("./helpers/script-scan");

const worker = getContext("service-worker");
const swModules = worker.imports.filter((f) => f.startsWith("sw/"));

/** A worker global whose chrome, fetch and timers record every call instead of acting. */
function recordingWorkerGlobal() {
  const calls = [];
  function api(parts) {
    return new Proxy(function () {}, {
      get(_target, prop) {
        if (prop === "then" || typeof prop === "symbol") return undefined;
        if (parts.join(".") === "runtime" && prop === "id") return "test-extension";
        return api([...parts, prop]);
      },
      apply(_target, _this, args) {
        const key = parts.join(".");
        calls.push(key);
        if (key === "runtime.getURL") return `chrome-extension://test-extension/${args[0] || ""}`;
        return undefined;
      },
    });
  }
  const record = (name) => () => {
    calls.push(name);
    return 0;
  };
  const context = vm.createContext({
    ...baseGlobals(),
    chrome: api([]),
    fetch: record("fetch"),
    setTimeout: record("setTimeout"),
    setInterval: record("setInterval"),
    queueMicrotask: record("queueMicrotask"),
  });
  context.self = context;
  context.globalThis = context;
  return { context, calls };
}

test("sw modules: every sw/*.js file is imported by the worker, after the shared modules", () => {
  const onDisk = fs.existsSync(path.join(ROOT, "sw"))
    ? fs.readdirSync(path.join(ROOT, "sw")).filter((f) => f.endsWith(".js")).map((f) => `sw/${f}`)
    : [];
  assert.deepEqual([...onDisk].sort(), [...swModules].sort(), "a sw/ file that is not imported is dead code");
  const firstSw = worker.imports.findIndex((f) => f.startsWith("sw/"));
  if (firstSw >= 0) {
    assert.ok(worker.imports.slice(firstSw).every((f) => f.startsWith("sw/")), "sw/ modules load last");
    for (const shared of ["config.js", "provider-benchmark.js", "vocab-review.js"]) {
      assert.ok(worker.imports.indexOf(shared) < firstSw, `${shared} loads before the sw/ modules`);
    }
  }
  for (const name of CONTEXT_NAMES.filter((n) => n !== "service-worker")) {
    const leaked = getContext(name).scripts.filter((f) => f.startsWith("sw/"));
    assert.deepEqual(leaked, [], `${name} must not load service worker modules`);
  }
});

test("sw modules: loading every import makes no chrome, network or timer call except getURL", () => {
  const { context, calls } = recordingWorkerGlobal();
  for (const file of worker.imports) runFile(context, file);
  assert.deepEqual(
    calls.filter((c) => c !== "runtime.getURL"),
    [],
    "startup work and listener registration belong in background.js"
  );
});

test("sw modules: each prefix of the import list loads without names declared later", () => {
  for (let i = 0; i < worker.imports.length; i++) {
    const { context } = recordingWorkerGlobal();
    const prefix = worker.imports.slice(0, i + 1);
    assert.doesNotThrow(() => prefix.forEach((f) => runFile(context, f)), `loading up to ${worker.imports[i]}`);
  }
});

test("sw modules: no name is declared by two service worker files", () => {
  const owner = new Map();
  const clashes = [];
  for (const file of worker.scripts) {
    for (const name of declaredGlobals(file)) {
      if (owner.has(name)) clashes.push(`${name}: ${owner.get(name)} and ${file}`);
      else owner.set(name, file);
    }
  }
  assert.deepEqual(clashes, []);
});

test("sw modules: the entry file only wires (imports, startup calls, listeners), it declares nothing", () => {
  const entry = fs.readFileSync(path.join(ROOT, worker.entry), "utf8");
  const declarations = entry.split(/\r?\n/).filter((line) => /^(async\s+)?(function|const|let|var|class)\b/.test(line));
  assert.deepEqual(declarations, [], "declarations belong in a sw/ module");
  assert.equal((entry.match(/onMessage\.addListener\(/g) || []).length, 1, "the single message listener stays here");
});
