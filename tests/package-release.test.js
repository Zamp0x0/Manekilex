/**
 * Batch 6: scripts/package-release.js builds the private release archive from a Git commit. The
 * archive must be byte-for-byte reproducible, contain every file the manifest, the pages and the
 * service worker load, carry the licences, and never contain tests, tooling, local files or the
 * data whose redistribution rights are not verified.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { spawnSync } = require("node:child_process");

const pkg = require("../scripts/package-release");

const ROOT = path.resolve(__dirname, "..");
const hasGit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT }).status === 0;
const SKIP = hasGit ? false : "needs a Git checkout";

let cached;
function headPackage() {
  if (!cached) cached = pkg.packageFromCommit("HEAD");
  return cached;
}

test("package: two builds of the same commit give the same bytes, and the archive reads back intact", { skip: SKIP }, () => {
  const a = headPackage();
  const b = pkg.packageFromCommit(a.commit);
  const zipA = pkg.buildZip(a.files, a.date);
  const zipB = pkg.buildZip(b.files, b.date);
  assert.equal(pkg.sha256(zipA), pkg.sha256(zipB));
  const back = pkg.readZip(zipA);
  assert.deepEqual([...back.keys()], [...a.files.keys()], "entries are written in sorted order");
  for (const [p, data] of a.files) assert.ok(back.get(p).equals(data), p);
  assert.deepEqual(pkg.verifyContents(back), []);
  assert.match(pkg.archiveName(a.version, a.commit), /^manekilex-\d+(\.\d+)*-[0-9a-f]{7}-PRIVATE-NOT-FOR-DISTRIBUTION\.zip$/);
});

test("package: contents come from the commit, not the working tree; only runtime files and licences", { skip: SKIP }, () => {
  const { files, commit } = headPackage();
  const paths = [...files.keys()];
  const tracked = new Set(spawnSync("git", ["ls-tree", "-r", "--name-only", commit], { cwd: ROOT, encoding: "utf8" }).stdout.split("\n"));
  for (const p of paths) {
    if (p === pkg.MARKER) continue;
    assert.ok(tracked.has(p), `${p} is tracked in ${commit}`);
  }
  for (const p of paths) {
    assert.doesNotMatch(p, /^(tests|scripts|docs|dic|assets|\.github|node_modules|poem)\//, p);
    assert.doesNotMatch(p, /(^|\/)\./, `${p}: no dotfiles`);
    if (p.endsWith(".md")) assert.ok(["THIRD_PARTY_NOTICES.md", "data/README.md", "lib/README.md"].includes(p), `${p}: no other docs`);
  }
  assert.ok(!files.has("icons/lucky.png"), "the local-only image is never packaged");
  assert.ok(!files.has("package.json") && !files.has("package-lock.json"));
  for (const p of ["manifest.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "lib/pdfjs/LICENSE", "data/dictionary_core.json", "data/README.md"]) {
    assert.ok(files.has(p), `${p} is packaged`);
  }
  // every working-tree byte difference (CRLF checkouts on Windows) is irrelevant: blobs are read from Git
  const manifestBlob = spawnSync("git", ["show", `${commit}:manifest.json`], { cwd: ROOT }).stdout;
  assert.ok(files.get("manifest.json").equals(manifestBlob));
});

test("package: everything the manifest, the pages and the service worker load is inside", { skip: SKIP }, () => {
  const { files } = headPackage();
  const manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  const sw = files.get(manifest.background.service_worker).toString("utf8");
  const imported = [...sw.match(/importScripts\(([\s\S]*?)\)/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(imported.length >= 10);
  for (const p of imported) assert.ok(files.has(p), `service worker imports ${p}`);
  for (const cs of manifest.content_scripts) for (const p of [...cs.js, ...cs.css]) assert.ok(files.has(p), p);
  for (const page of ["settings.html", "reader.html", "pdf-reader.html", "popup.html", "lookup-panel.html"]) {
    const html = files.get(page).toString("utf8");
    for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) assert.ok(files.has(m[1]), `${page} loads ${m[1]}`);
  }
  for (const p of ["lib/pdfjs/build/pdf.min.mjs", "lib/pdfjs/build/pdf.worker.min.mjs", "lib/pdfjs/web/pdf_viewer.mjs", "lib/pdfjs/wasm/openjpeg.wasm", "live-transcribe-worklet.js"]) {
    assert.ok(files.has(p), p);
  }
});

test("package: the unverified quote collection stays out, and the marker says so", { skip: SKIP }, () => {
  const { files, commit } = headPackage();
  assert.deepEqual(pkg.EXCLUDED_PENDING_RIGHTS, ["poem/quotes.json"]);
  assert.ok(!files.has("poem/quotes.json"));
  const marker = files.get(pkg.MARKER).toString("utf8");
  assert.match(marker, /NOT FOR DISTRIBUTION/);
  assert.match(marker, new RegExp(`Commit: ${commit}`));
  assert.match(marker, /- poem\/quotes\.json/);
});

test("package: verification rejects tests, local files, unverified data, missing licences and missing scripts", { skip: SKIP }, () => {
  const { files } = headPackage();
  const variant = (mutate) => {
    const copy = new Map(files);
    mutate(copy);
    return pkg.verifyContents(copy);
  };
  assert.deepEqual(pkg.verifyContents(files), []);
  assert.ok(variant((m) => m.set("tests/x.test.js", Buffer.from(""))).some((e) => /tests\/x\.test\.js/.test(e)));
  assert.ok(variant((m) => m.set("icons/lucky.png", Buffer.from(""))).some((e) => /icons\/lucky\.png/.test(e)));
  assert.ok(variant((m) => m.set("poem/quotes.json", Buffer.from("[]"))).some((e) => /poem\/quotes\.json/.test(e)));
  assert.ok(variant((m) => m.set(".env", Buffer.from("X=1"))).some((e) => /\.env/.test(e)));
  assert.ok(variant((m) => m.delete("THIRD_PARTY_NOTICES.md")).some((e) => /THIRD_PARTY_NOTICES/.test(e)));
  assert.ok(variant((m) => m.delete("lib/pdfjs/wasm/LICENSE_QCMS")).some((e) => /LICENSE_QCMS/.test(e)));
  assert.ok(variant((m) => m.delete("sw/router.js")).some((e) => /sw\/router\.js/.test(e)));
  assert.ok(variant((m) => m.delete("reader/toc.js")).some((e) => /reader\.html .*reader\/toc\.js/.test(e)));
  assert.ok(variant((m) => m.delete(pkg.MARKER)).some((e) => /NOT_FOR_DISTRIBUTION/.test(e)));
  const withKey = JSON.parse(files.get("manifest.json").toString("utf8"));
  withKey.key = "MIIB";
  assert.ok(variant((m) => m.set("manifest.json", Buffer.from(JSON.stringify(withKey)))).some((e) => /key/.test(e)));
});

test("package: a damaged archive fails to read", { skip: SKIP }, () => {
  const tiny = new Map([["a.txt", Buffer.from("hello")]]);
  const zip = pkg.buildZip(tiny, new Date(Date.UTC(2026, 0, 2, 3, 4, 6)));
  assert.equal(pkg.readZip(zip).get("a.txt").toString(), "hello");
  assert.equal(pkg.crc32(Buffer.from("123456789")), 0xcbf43926);
  const bad = Buffer.from(zip);
  bad[30 + "a.txt".length] ^= 0xff; // first data byte
  assert.throws(() => pkg.readZip(bad), /CRC/);
});

test("package: without poem/quotes.json the settings page falls back to its built-in line", async () => {
  const context = vm.createContext({
    window: {},
    chrome: { runtime: { getURL: (p) => `chrome-extension://test/${p}` } },
    fetch: async () => ({ ok: false, status: 404 }),
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, "daily-lines.js"), "utf8"), context);
  const quotes = context.window.MK_DailyQuotes;
  const en = { textContent: "" };
  const author = { textContent: "" };
  await quotes.renderDailyQuote(en, author);
  assert.equal(en.textContent, quotes.DEFAULT.text);
  assert.equal(author.textContent, `— ${quotes.DEFAULT.author}`);
});
