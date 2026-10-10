/**
 * A. Static load-order checks for every execution context.
 *
 * The lists come from the files Chrome reads (tests/helpers/load-order.js). No product statement
 * runs here: the global-scope check lets V8 instantiate each file's top-level declarations and
 * stops before the first statement (tests/helpers/script-scan.js).
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  ROOT,
  READER_PAGE,
  CONTEXT_NAMES,
  readManifest,
  getContext,
  parseImportScripts,
  parseHtmlScripts,
  scriptsFor,
} = require("./helpers/load-order");
const {
  readSource,
  checkGlobalDeclarations,
  referencedProjectGlobals,
  declaredGlobals,
  isFirstParty,
} = require("./helpers/script-scan");

/** fs.existsSync is case-insensitive on Windows and macOS; Chrome's packed extension is not. */
function existsWithExactCase(rel) {
  let dir = ROOT;
  for (const part of rel.split("/")) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
    if (!fs.readdirSync(dir).includes(part)) return false;
    dir = path.join(dir, part);
  }
  return fs.statSync(dir).isFile();
}

/** name → index of the first file in `files` that creates that global. */
function declarationIndex(files) {
  const at = new Map();
  files.forEach((file, i) => {
    if (!isFirstParty(file)) return;
    for (const name of declaredGlobals(file)) if (!at.has(name)) at.set(name, i);
  });
  // var / function globals of vendored libraries and anything the tokenizer missed
  for (const [name, file] of checkGlobalDeclarations(files).declaredBy) {
    if (!at.has(name)) at.set(name, files.indexOf(file));
  }
  return at;
}

test("all seven execution contexts are declared and non-empty", () => {
  assert.deepEqual(CONTEXT_NAMES, ["service-worker", "content", "settings", "reader", "popup", "side-panel", "pdf-reader"]);
  for (const name of CONTEXT_NAMES) {
    const ctx = getContext(name);
    assert.ok(ctx.scripts.length > 0, `${name}: no scripts declared in ${ctx.declaredIn}`);
  }
});

for (const name of CONTEXT_NAMES) {
  test(`${name}: every declared script exists (exact case) and is listed once`, () => {
    const { scripts, declaredIn } = getContext(name);
    const missing = scripts.filter((rel) => !existsWithExactCase(rel));
    assert.deepEqual(missing, [], `${declaredIn} references files that do not exist`);
    const dupes = scripts.filter((rel, i) => scripts.indexOf(rel) !== i);
    assert.deepEqual(dupes, [], `${declaredIn} loads a file twice (its top-level const/let would collide)`);
  });

  test(`${name}: the scripts can share one global scope (no duplicate top-level declaration)`, () => {
    const { scripts } = getContext(name);
    const { errors, overrides } = checkGlobalDeclarations(scripts);
    assert.deepEqual(errors, [], "a file fails GlobalDeclarationInstantiation when loaded after the previous ones");
    assert.deepEqual(overrides, [], "a later top-level function silently replaces an earlier global function");
  });

  test(`${name}: project globals each first-party file uses are created by a file loaded before it`, () => {
    const ctx = getContext(name);
    const at = declarationIndex(ctx.scripts);
    const problems = [];
    ctx.scripts.forEach((file, i) => {
      if (!isFirstParty(file)) return;
      for (const [global, line] of referencedProjectGlobals(file)) {
        const where = at.get(global);
        if (where === undefined) problems.push(`${file}:${line} uses ${global}, which no script of ${name} creates`);
        // In the worker, importScripts() runs inside the entry file's evaluation, so the entry
        // may use its imports; the runtime test checks the call really precedes that use.
        else if (where > i && !(ctx.kind === "worker" && file === ctx.entry)) {
          problems.push(`${file}:${line} uses ${global}, created later by ${ctx.scripts[where]}`);
        }
      }
    });
    assert.deepEqual(problems, []);
  });
}

test("page contexts: every <script> is an external, classic, in-order script", () => {
  for (const name of CONTEXT_NAMES) {
    const ctx = getContext(name);
    if (ctx.kind !== "page") continue;
    for (const tag of ctx.tags) {
      const where = `${ctx.declaredIn}:${tag.line}`;
      assert.ok(tag.src, `${where}: inline <script> (blocked by the MV3 extension CSP)`);
      assert.equal(tag.inline, false, `${where}: <script src> with inline content`);
      // async / defer / modules change execution order or give the file its own scope
      for (const attr of ["async", "defer", "nomodule"]) {
        assert.ok(!(attr in tag.attrs), `${where}: ${attr} changes when ${tag.src} runs`);
      }
      const type = (tag.attrs.type || "").trim().toLowerCase();
      assert.ok(type === "" || type === "text/javascript", `${where}: type="${type}" is not a classic script`);
    }
  }
});

test("service worker: classic worker whose imports are one top-level importScripts list", () => {
  const manifest = readManifest();
  assert.notEqual(manifest.background.type, "module", "a module worker cannot use importScripts()");
  const ctx = getContext("service-worker");
  assert.equal(ctx.calls.length, 1, "expected a single importScripts(...) call in the entry file");
  assert.ok(ctx.imports.length > 0);
  assert.deepEqual(ctx.scripts, [ctx.entry, ...ctx.imports]);
  // Nothing the worker needs may come from a DOM-only page script.
  for (const rel of ctx.imports) assert.ok(!rel.endsWith(".html"), rel);
});

test("content scripts: one group in the isolated world, with page CSS files that exist", () => {
  const { group } = getContext("content");
  assert.ok(Array.isArray(group.matches) && group.matches.length > 0);
  assert.ok(!group.world || group.world === "ISOLATED", "content.js relies on the isolated world's chrome.* APIs");
  const missingCss = (group.css || []).filter((rel) => !existsWithExactCase(rel));
  assert.deepEqual(missingCss, []);
});

test("config.js is the first script of every page and the first worker import", () => {
  for (const name of CONTEXT_NAMES) {
    const ctx = getContext(name);
    const first = ctx.kind === "worker" ? ctx.imports[0] : ctx.scripts[0];
    assert.equal(first, "config.js", `${name}: shared constants must load before any consumer`);
  }
});

test("M7: every lookup host loads the same lookup/ parts, in the same order, before mk-lookup.js", () => {
  const hosts = CONTEXT_NAMES.filter((name) => scriptsFor(name).includes("mk-lookup.js"));
  assert.deepEqual(hosts, ["content", "reader", "side-panel", "pdf-reader"]);
  const partsOf = (name) => scriptsFor(name).filter((f) => f.startsWith("lookup/"));
  const reference = partsOf("content");
  assert.ok(reference.length > 1, "lookup/dom-helpers.js plus the mk-lookup parts");
  for (const name of hosts) {
    const scripts = scriptsFor(name);
    assert.deepEqual(partsOf(name), reference, `${name}: same lookup/ parts as the content scripts`);
    assert.ok(scripts.indexOf(reference.at(-1)) < scripts.indexOf("mk-lookup.js"), `${name}: parts load before mk-lookup.js`);
  }
});

test("M8: only the EPUB reader loads reader/ parts, all of them, after its libraries and right before reader.js", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  for (const name of CONTEXT_NAMES.filter((n) => n !== "reader")) {
    assert.deepEqual(scriptsFor(name).filter((f) => f.startsWith("reader/")), [], `${name} loads no reader/ part`);
  }
  const scripts = scriptsFor("reader");
  const parts = scripts.filter((f) => f.startsWith("reader/"));
  const onDisk = fs.readdirSync(path.join(__dirname, "..", "reader")).filter((f) => f.endsWith(".js")).map((f) => `reader/${f}`);
  assert.deepEqual([...parts].sort(), onDisk.sort(), "every reader/ file is loaded, and nothing else under reader/");
  const entry = scripts.indexOf("reader.js");
  assert.equal(entry, scripts.length - 1, "reader.js runs last");
  assert.deepEqual(scripts.slice(entry - parts.length, entry), parts, "the parts load together, right before reader.js");
  for (const lib of ["config.js", "lib/epub.min.js", "book-store.js", "mk-lookup.js"]) {
    assert.ok(scripts.indexOf(lib) < scripts.indexOf(parts[0]), `${lib} loads before the reader parts`);
  }
});

test("reader.html, the one page the manifest does not declare, is still the page settings opens", () => {
  assert.match(readSource("settings/reading.js"), new RegExp(`getURL\\(\\s*["']${READER_PAGE.replace(".", "\\.")}["']`));
});

test("scriptsFor(): a focused subset must keep the real files and order", () => {
  const all = scriptsFor("settings");
  assert.deepEqual(scriptsFor("settings", { only: ["config.js", "settings.js"] }), ["config.js", "settings.js"]);
  assert.throws(() => scriptsFor("settings", { only: ["settings.js", "config.js"] }), /real order/);
  assert.throws(() => scriptsFor("settings", { only: ["no-such-file.js"] }), /not loaded by settings/);
  assert.equal(all[all.length - 1], "settings.js");
});

// ── Parser and checker self-tests on synthetic inputs (never on product files) ─────────────

test("parseImportScripts accepts only a top-level call with literal arguments", () => {
  const ok = parseImportScripts('// importScripts("old.js")\nimportScripts("a.js", \'b.js\');\nfoo();\n', "sw.js");
  assert.deepEqual(ok.scripts, ["a.js", "b.js"]);
  assert.deepEqual(ok.calls, [{ line: 2, scripts: ["a.js", "b.js"] }]);
  assert.throws(() => parseImportScripts('function f() {\n  importScripts("late.js");\n}\n', "sw.js"), /top-level/);
  assert.throws(() => parseImportScripts("importScripts(name);\n", "sw.js"), /string literals/);
});

test("parseHtmlScripts reads tags in order and ignores commented-out ones", () => {
  const tags = parseHtmlScripts(
    '<head>\n<!-- <script src="old.js"></script> -->\n<script src="a.js"></script>\n<script defer src=\'b.js\'></script>\n<script>inline()</script>\n</head>'
  );
  assert.deepEqual(tags.map((t) => t.src), ["a.js", "b.js", null]);
  assert.deepEqual(tags.map((t) => t.line), [3, 4, 5]);
  assert.ok("defer" in tags[1].attrs);
  assert.equal(tags[2].inline, true);
});

test("checkGlobalDeclarations flags a duplicate const and a function override without running code", () => {
  const sources = {
    "a.js": 'const SHARED = 1;\nfunction helper() { return "a"; }\nthrow new Error("must not run");\n',
    "b.js": "let other = 2;\nconst SHARED = 3;\n",
    "c.js": 'function helper() { return "c"; }\n',
  };
  const { errors, overrides } = checkGlobalDeclarations(["a.js", "b.js", "c.js"], { sources });
  assert.equal(errors.length, 1);
  assert.equal(errors[0].file, "b.js");
  assert.match(errors[0].message, /SyntaxError: Identifier 'SHARED' has already been declared/);
  assert.deepEqual(overrides, [{ name: "helper", file: "c.js", previous: "a.js" }]);
});

test("checkGlobalDeclarations keeps a file's 'use strict' and flags a let/var clash", () => {
  const sources = {
    "a.js": '"use strict";\nvar count = 0;\n',
    "b.js": "let count = 1;\n",
  };
  const { errors } = checkGlobalDeclarations(["a.js", "b.js"], { sources });
  assert.deepEqual(errors.map((e) => e.file), ["b.js"]);
});
