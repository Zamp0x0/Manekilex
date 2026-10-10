/**
 * Batch 6: every third-party or data file in the repository has a recorded origin.
 *
 *   - lib/ holds only the four libraries hashed in lib/README.md, its README and lib/pdfjs/
 *     (whose files tests/pdfjs-vendor.test.js checks one by one); each hash still matches;
 *   - every tracked file under data/, dic/, poem/, icons/ and assets/ is named in data/README.md or
 *     THIRD_PARTY_NOTICES.md, so a new word list, quote file or image cannot slip in silently;
 *   - the files whose redistribution rights are unverified are never part of the extension archive.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel));

/** Tracked files when Git is available, otherwise the files on disk (minus ignored local ones) */
function filesUnder(dir) {
  const res = spawnSync("git", ["ls-files", "-z", "--", dir], { cwd: ROOT, encoding: "utf8" });
  if (res.status === 0 && res.stdout) return res.stdout.split("\0").filter(Boolean);
  const walk = (rel) =>
    fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true }).flatMap((e) => {
      const child = `${rel}/${e.name}`;
      return e.isDirectory() ? walk(child) : [child];
    });
  return walk(dir).filter((f) => f !== "icons/lucky.png" && f !== "dic/ecdict.csv");
}

function libHashes() {
  const out = {};
  for (const m of read("lib/README.md").toString("utf8").matchAll(/^\| `([a-z.]+\.js)` \| `([0-9a-f]{64})` \|$/gm)) out[m[1]] = m[2];
  return out;
}

test("provenance: lib/ holds only recorded libraries, and each one matches its recorded SHA-256", () => {
  const hashes = libHashes();
  assert.deepEqual(Object.keys(hashes).sort(), ["epub.min.js", "jszip.min.js", "mammoth.browser.min.js", "marked.min.js"]);
  for (const [name, sha] of Object.entries(hashes)) {
    assert.equal(crypto.createHash("sha256").update(read(`lib/${name}`)).digest("hex"), sha, `lib/${name}`);
  }
  const unexpected = filesUnder("lib").filter((f) => !f.startsWith("lib/pdfjs/") && f !== "lib/README.md" && !(f.slice(4) in hashes));
  assert.deepEqual(unexpected, [], "every file in lib/ is listed in lib/README.md");
  const notices = read("THIRD_PARTY_NOTICES.md").toString("utf8");
  for (const name of Object.keys(hashes)) assert.ok(notices.includes(`lib/${name}`), `THIRD_PARTY_NOTICES.md names lib/${name}`);
});

test("provenance: every data file, word list, quote collection and image is documented", () => {
  const docs = read("data/README.md").toString("utf8") + "\n" + read("THIRD_PARTY_NOTICES.md").toString("utf8");
  const named = (file) => {
    if (docs.includes(`\`${file}\``)) return true;
    // the image tables name files in a group: `icons/css_1.png` … `css_5.png`, `icon32.png`
    const base = path.posix.basename(file);
    return file.startsWith("icons/") && (docs.includes(`\`${base}\``) || /^css_\d\.png$/.test(base));
  };
  const files = ["data", "dic", "poem", "icons", "assets"].flatMap(filesUnder).filter((f) => !f.endsWith("README.md"));
  assert.ok(files.length >= 15);
  assert.deepEqual(files.filter((f) => !named(f)), [], "undocumented data or image files");
});

test("provenance: the unverified word lists and quotes never reach the extension archive", () => {
  const { selectFiles, EXCLUDED_PENDING_RIGHTS } = require("../scripts/package-release");
  const entries = ["dic/google-10000-english-usa.txt", "dic/The_Oxford_3000.txt", "dic/wordfreq-en-25000-log.json", "poem/quotes.json", "assets/icon-source.png", "icons/icon16.png", "manifest.json"].map(
    (p) => ({ path: p, blob: "0", mode: "100644", type: "blob" })
  );
  assert.deepEqual(selectFiles(entries).map((e) => e.path), ["icons/icon16.png", "manifest.json"]);
  const readme = read("data/README.md").toString("utf8");
  for (const p of EXCLUDED_PENDING_RIGHTS) assert.match(readme, new RegExp(p.replace(/[./]/g, "\\$&")));
});
