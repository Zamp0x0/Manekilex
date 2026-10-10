/**
 * Phase 5 dictionary toolchain safety: atomic validated writes, refusal to overwrite enriched
 * data, enrich refusing an unbounded paid run, and the deterministic cleanup rules.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const dictFile = require("../scripts/dictionary-file");
const clean = require("../scripts/clean-dictionary-entries");

const ROOT = path.resolve(__dirname, "..");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "manekilex-dict-"));
}

const ENRICHED = { term: "bank", short_meaning: "银行", examples: [{ en: "a", zh: "b" }], memory_tip: "记", enriched: true };
const SHELL = { term: "jj", short_meaning: "", examples: [], memory_tip: "", enriched: true };

test("writeDictionaryAtomic: validates, writes a backup, leaves no temp file, refuses invalid data", () => {
  const dir = tmpDir();
  const file = path.join(dir, "dictionary_core.json");
  fs.writeFileSync(file, JSON.stringify({ old: ENRICHED }));
  const res = dictFile.writeDictionaryAtomic(file, { bank: ENRICHED, jj: SHELL }, { backup: true });
  assert.equal(res.counts.entries, 2);
  assert.equal(res.counts.enriched, 2);
  assert.equal(res.counts.emptyShells, 1);
  assert.ok(fs.existsSync(res.backup), "backup written");
  assert.deepEqual(JSON.parse(fs.readFileSync(res.backup, "utf-8")), { old: ENRICHED });
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf-8"))), ["bank", "jj"]);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes(".tmp")), [], "no temp file left");

  assert.throws(() => dictFile.writeDictionaryAtomic(file, { bad: "not an object" }), /refusing to write invalid dictionary/);
  assert.throws(() => dictFile.writeDictionaryAtomic(file, ["array"]), /refusing to write invalid dictionary/);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, "utf-8"))), ["bank", "jj"], "target untouched after refusal");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes(".tmp")), []);
});

test("assertSafeToOverwrite: refuses enriched data unless forced; allows missing or unenriched files", () => {
  const dir = tmpDir();
  const file = path.join(dir, "dictionary_core.json");
  assert.deepEqual(dictFile.assertSafeToOverwrite(file), { exists: false, enriched: 0, entries: 0 });
  fs.writeFileSync(file, JSON.stringify({ bank: { ...ENRICHED, enriched: false } }));
  assert.equal(dictFile.assertSafeToOverwrite(file).enriched, 0);
  fs.writeFileSync(file, JSON.stringify({ bank: ENRICHED, jj: SHELL }));
  assert.throws(() => dictFile.assertSafeToOverwrite(file), /already contains 2 enriched entries[\s\S]*--force-overwrite/);
  assert.throws(() => dictFile.assertSafeToOverwrite(file, { flagName: "--yes-really" }), /--yes-really/);
  assert.equal(dictFile.assertSafeToOverwrite(file, { force: true }).enriched, 2);
  // the real production file is protected too
  assert.throws(() => dictFile.assertSafeToOverwrite(path.join(ROOT, "data", "dictionary_core.json")), /Refusing to overwrite/);
});

test("isExplicitEnrichRun: only bounded queues or --confirm-full-run count", () => {
  const f = dictFile.isExplicitEnrichRun;
  assert.equal(f({}), false);
  assert.equal(f({ resume: true }), false);
  assert.equal(f({ allMissing: true, force: true, adaptive: true }), false);
  assert.equal(f({ limit: Infinity }), false);
  assert.equal(f({ keys: ["bank"] }), true);
  assert.equal(f({ keysFile: "list.txt" }), true);
  assert.equal(f({ retryFailed: true }), true);
  assert.equal(f({ limit: 50 }), true);
  assert.equal(f({ allMissing: true, confirmFullRun: true }), true);
});

test("node scripts/enrich-dictionary.js without a bounded queue exits before touching anything", () => {
  for (const args of [[], ["--resume"], ["--all-missing", "--force", "--adaptive"]]) {
    const run = spawnSync(process.execPath, ["scripts/enrich-dictionary.js", ...args], {
      cwd: ROOT,
      env: { ...process.env, DEEPSEEK_API_KEY: "test-key-never-used" },
      encoding: "utf-8",
      timeout: 20000,
    });
    assert.equal(run.status, 2, `args ${args.join(" ")}: ${run.stderr}`);
    assert.match(run.stderr, /拒绝执行/);
    assert.match(run.stderr, /--confirm-full-run/);
  }
  assert.ok(!fs.existsSync(path.join(ROOT, "data", ".enrich.lock")), "no lock file created");
});

test("clean-dictionary-entries rules are deterministic and leave real words alone", () => {
  const input = {
    bank: ENRICHED,
    jj: SHELL,
    "00pm": { term: "00pm", short_meaning: "下午…点", enriched: true },
    "0,000": { term: "0,000", short_meaning: "千", enriched: true },
    "©": { term: "©", short_meaning: "版权符号", enriched: true },
    "7": { term: "7", short_meaning: "七", enriched: true },
    taiwan: { term: "台湾", phonetic: "Táiwān", short_meaning: "台湾", enriched: true },
    socrates: { term: "苏格拉底", phonetic: "sū gé lā dǐ", short_meaning: "古希腊哲学家", enriched: true },
    thats: { term: "that's", phonetic: "/ðæts/", short_meaning: "那是", enriched: true },
    café: { term: "café", short_meaning: "咖啡馆", enriched: true },
    "p.m": { term: "p.m.", short_meaning: "下午", enriched: true },
    "o_o": { term: "o_o", short_meaning: "表情", enriched: true },
  };
  const first = clean.cleanDictionary(input);
  assert.deepEqual(first.removedEmpty, ["jj"]);
  assert.deepEqual(first.removedJunk, ["00pm", "0,000", "©"]);
  assert.deepEqual(first.fixedTerms.map((f) => f.key), ["taiwan", "socrates"]);
  assert.equal(first.dict.taiwan.term, "taiwan");
  assert.equal(first.dict.taiwan.phonetic, "", "pinyin cleared");
  assert.equal(first.dict.socrates.phonetic, "");
  assert.equal(first.dict.thats.term, "that's", "apostrophe aliases kept");
  assert.equal(first.dict.thats.phonetic, "/ðæts/");
  assert.ok(first.dict["7"] && first.dict["café"] && first.dict["p.m"] && first.dict["o_o"]);
  const second = clean.cleanDictionary(first.dict);
  assert.deepEqual(second.dict, first.dict, "idempotent");
  assert.equal(second.removedEmpty.length + second.removedJunk.length + second.fixedTerms.length, 0);
});

test("the shipped dictionary has no empty shells, junk keys or CJK headwords left", () => {
  const dict = dictFile.readDictionary(path.join(ROOT, "data", "dictionary_core.json"));
  const summary = clean.summarize(dict);
  assert.equal(summary.emptyShells, 0);
  assert.equal(summary.junkKeys, 0);
  assert.equal(summary.cjkTermMismatches, 0);
  assert.ok(summary.entries > 25000);
  assert.equal(dict.taiwan.term, "taiwan");
  assert.equal(dict.jj, undefined);
  assert.ok(dict.bank && dict.bank.short_meaning);
});
