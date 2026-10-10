/**
 * P0-B: global-surface characterization for every execution context.
 *
 * tests/fixtures/global-surface.json records, per context, the top-level names the real script
 * list leaves behind (tests/helpers/global-surface.js explains what is counted). A refactor that
 * moves code between files must keep this snapshot identical; a phase that adds or removes a
 * name on purpose updates the fixture in the same commit:
 *
 *   UPDATE_GLOBAL_SURFACE=1 node --test tests/global-surface.test.js
 *
 * and the diff of the fixture shows exactly which names changed.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { CONTEXT_NAMES } = require("./helpers/load-order");
const { captureSurface } = require("./helpers/global-surface");

const FIXTURE = path.join(__dirname, "fixtures", "global-surface.json");
const UPDATE = process.env.UPDATE_GLOBAL_SURFACE === "1";

const snapshot = fs.existsSync(FIXTURE) ? JSON.parse(fs.readFileSync(FIXTURE, "utf8")) : {};
const captured = {};

function diff(expected, actual) {
  const want = new Set(expected || []);
  const have = new Set(actual);
  return {
    added: actual.filter((n) => !want.has(n)),
    removed: [...want].filter((n) => !have.has(n)),
  };
}

for (const name of CONTEXT_NAMES) {
  test(`global surface: ${name} matches the committed snapshot`, async () => {
    const surface = await captureSurface(name);
    captured[name] = surface;
    if (UPDATE) return;
    assert.ok(snapshot[name], `no snapshot for ${name}; run with UPDATE_GLOBAL_SURFACE=1`);
    for (const kind of ["global", "lexical"]) {
      const { added, removed } = diff(snapshot[name][kind], surface[kind]);
      assert.deepEqual({ added, removed }, { added: [], removed: [] }, `${name} ${kind} names changed`);
    }
  });
}

test("global surface: names shared across contexts come from the same file everywhere", async () => {
  // config.js is loaded first in every context, so its names appear in every surface.
  const all = CONTEXT_NAMES.map((n) => captured[n] || snapshot[n]);
  const inAll = (name) => all.every((s) => s.global.includes(name) || s.lexical.includes(name));
  for (const name of ["ZEH_STORAGE", "zehDetectQueryType", "zehLookupKeyVariants", "zehEscapeHtml"]) {
    assert.ok(inAll(name), `${name} should be visible in every context`);
  }
  // M5: the prompts moved to shared/prompts.js, which only the service worker loads.
  const owners = CONTEXT_NAMES.filter((n, i) => all[i].global.includes("zehBuildSystemPrompt"));
  assert.deepEqual(owners, ["service-worker"]);
});

test.after(() => {
  if (!UPDATE) return;
  const ordered = {};
  CONTEXT_NAMES.forEach((n) => (ordered[n] = captured[n]));
  fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
  fs.writeFileSync(FIXTURE, `${JSON.stringify(ordered, null, 1)}\n`);
});
