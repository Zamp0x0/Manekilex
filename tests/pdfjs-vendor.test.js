/**
 * PDF.js 6.4.299: what is vendored, how it is loaded, and the PDF import pipeline on top of it.
 *
 *   - lib/pdfjs/ holds exactly the files listed in lib/README.md, byte-identical (SHA-256) to
 *     pdfjs-dist@6.4.299; the 3.11.174 bundle is gone and nothing refers to it;
 *   - the vendored JS has no eval / new Function (the CVE-2024-4367 code path was removed in 6.x),
 *     and the scripting sandbox (pdf.sandbox, quickjs) is not shipped (CVE-2026-16633 needs it);
 *   - the extension page CSP allows local scripts and WebAssembly only;
 *   - pdf-reader/pdfjs-loader.js loads the local module and worker, checks the version and fixes
 *     the security options of every getDocument call;
 *   - the settings page PDF importer (text mode) converts a real PDF with the vendored library and
 *     releases the document afterwards, also when the conversion fails.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { pathToFileURL } = require("node:url");
const { ROOT, getContext, loadContextScripts } = require("./helpers/load-order");
const { baseGlobals, runFile } = require("./helpers/extension-sandbox");
const { pdfFixture } = require("./helpers/pdf-fixtures");

const PDFJS_DIR = path.join(ROOT, "lib", "pdfjs");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel));

function listFiles(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const abs = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(abs, base) : [path.relative(base, abs).split(path.sep).join("/")];
  });
}

/** The SHA-256 table in lib/README.md: { "pdfjs/build/pdf.min.mjs": "…" } */
function readmeHashes() {
  const text = read("lib/README.md").toString("utf8");
  const out = {};
  for (const m of text.matchAll(/^\| `(pdfjs\/[^`]+)` \| `([0-9a-f]{64})` \|$/gm)) out[m[1]] = m[2];
  return out;
}

test("pdfjs vendor: every hashed file matches lib/README.md and the version is 6.4.299", () => {
  const hashes = readmeHashes();
  assert.ok(Object.keys(hashes).length >= 8, "lib/README.md lists the PDF.js hashes");
  for (const [rel, sha] of Object.entries(hashes)) {
    const actual = crypto.createHash("sha256").update(read(`lib/${rel}`)).digest("hex");
    assert.equal(actual, sha, `lib/${rel} differs from the recorded pdfjs-dist@6.4.299 file`);
  }
  for (const rel of ["build/pdf.min.mjs", "build/pdf.worker.min.mjs", "web/pdf_viewer.mjs"]) {
    assert.match(read(`lib/pdfjs/${rel}`).toString("utf8"), /6\.4\.299/, `${rel} version`);
  }
});

test("pdfjs vendor: only the needed files are shipped (no sandbox, no quickjs, no source maps)", () => {
  const files = listFiles(PDFJS_DIR);
  const unexpected = files.filter(
    (f) =>
      !/^(LICENSE|build\/pdf(\.worker)?\.min\.mjs|web\/pdf_viewer\.(mjs|css)|web\/images\/[\w-]+\.(svg|gif)|wasm\/(jbig2|openjpeg|qcms_bg)\.wasm|wasm\/LICENSE_[A-Z0-9_]+)$/.test(f)
  );
  assert.deepEqual(unexpected, []);
  assert.ok(!files.some((f) => /sandbox|quickjs|\.map$/.test(f)));
  // the 3.11.174 bundle was replaced, not kept next to the new one
  assert.equal(fs.existsSync(path.join(ROOT, "lib", "pdf.min.js")), false);
  assert.equal(fs.existsSync(path.join(ROOT, "lib", "pdf.worker.min.js")), false);
});

test("pdfjs vendor: no eval or new Function in the shipped JavaScript", () => {
  for (const rel of ["build/pdf.min.mjs", "build/pdf.worker.min.mjs", "web/pdf_viewer.mjs"]) {
    const src = read(`lib/pdfjs/${rel}`).toString("utf8");
    assert.equal(/(^|[^.\w$])eval\s*\(/.test(src), false, `${rel}: eval(`);
    assert.equal(/new\s+Function\s*\(/.test(src), false, `${rel}: new Function(`);
  }
});

test("pdfjs vendor: no first-party file refers to the old bundle", () => {
  const { execFileSync } = require("node:child_process");
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => /\.(js|html|json)$/.test(f) && !f.startsWith("lib/") && !f.startsWith("tests/") && fs.existsSync(path.join(ROOT, f)));
  const hits = files.filter((f) => /lib\/pdf(\.worker)?\.min\.js|pdfjsLib\.getDocument/.test(read(f).toString("utf8")));
  assert.deepEqual(hits, []);
});

test("manifest: extension pages allow local scripts and WebAssembly only; PDF.js is not web-accessible", () => {
  const manifest = JSON.parse(read("manifest.json").toString("utf8"));
  const csp = manifest.content_security_policy.extension_pages;
  assert.equal(csp, "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';");
  assert.ok(!/unsafe-eval'|unsafe-inline|https?:|\*/.test(csp.replace("'wasm-unsafe-eval'", "")));
  assert.equal(manifest.content_security_policy.sandbox, undefined);
  const exposed = (manifest.web_accessible_resources || []).flatMap((w) => w.resources || []);
  assert.ok(!exposed.some((r) => r.startsWith("lib/")), `exposed to web pages: ${exposed.join(", ")}`);
});

test("extension pages: no inline or remote <script>, PDF.js is never a classic <script>", () => {
  for (const name of ["settings", "reader", "popup", "side-panel"]) {
    const ctx = getContext(name);
    for (const tag of ctx.tags) {
      assert.equal(tag.inline, false, `${ctx.declaredIn}:${tag.line} inline script`);
    }
    assert.ok(!ctx.scripts.some((f) => f.startsWith("lib/pdfjs/")), `${name} loads PDF.js through the loader`);
  }
});

// ── pdf-reader/pdfjs-loader.js ─────────────────────────────────────────────────────────────

function loaderSandbox() {
  const ctx = vm.createContext({
    ...baseGlobals(),
    chrome: { runtime: { getURL: (p) => `chrome-extension://test-ext/${p}` } },
  });
  ctx.window = ctx;
  runFile(ctx, "pdf-reader/pdfjs-loader.js");
  return ctx;
}

test("loader: imports the local module, checks its version and sets a local worker", async () => {
  const ctx = loaderSandbox();
  const seen = [];
  const fakeLib = { version: "6.4.299", GlobalWorkerOptions: {} };
  const lib = await ctx.ZEHPdfjs.loadLibrary(async (url) => {
    seen.push(url);
    return fakeLib;
  });
  assert.equal(lib, fakeLib);
  assert.deepEqual(seen, ["chrome-extension://test-ext/lib/pdfjs/build/pdf.min.mjs"]);
  assert.equal(fakeLib.GlobalWorkerOptions.workerSrc, "chrome-extension://test-ext/lib/pdfjs/build/pdf.worker.min.mjs");
  // second call reuses the same module
  assert.equal(await ctx.ZEHPdfjs.loadLibrary(async () => assert.fail("imported twice")), fakeLib);
});

test("loader: a wrong version is rejected and a failed load can be retried", async () => {
  const ctx = loaderSandbox();
  await assert.rejects(ctx.ZEHPdfjs.loadLibrary(async () => ({ version: "3.11.174", GlobalWorkerOptions: {} })), /6\.4\.299/);
  const ok = { version: "6.4.299", GlobalWorkerOptions: {} };
  assert.equal(await ctx.ZEHPdfjs.loadLibrary(async () => ok), ok);
});

test("loader: the viewer components load after the library is published as globalThis.pdfjsLib", async () => {
  const ctx = loaderSandbox();
  const lib = { version: "6.4.299", GlobalWorkerOptions: {} };
  const order = [];
  const { viewer } = await ctx.ZEHPdfjs.loadViewer(async (url) => {
    order.push([url.replace("chrome-extension://test-ext/", ""), ctx.pdfjsLib === lib]);
    return url.endsWith("pdf_viewer.mjs") ? { PDFViewer: function () {} } : lib;
  });
  assert.equal(typeof viewer.PDFViewer, "function");
  assert.deepEqual(order, [
    ["lib/pdfjs/build/pdf.min.mjs", false],
    ["lib/pdfjs/web/pdf_viewer.mjs", true],
  ]);
});

test("loader: documentParams keeps only the data source and fixes the security options", () => {
  const ctx = loaderSandbox();
  const data = new Uint8Array([1]);
  const params = ctx.ZEHPdfjs.documentParams({
    data,
    password: "pw",
    enableXfa: true,
    wasmUrl: "https://evil.example/wasm/",
    url: "https://evil.example/doc.pdf",
    cMapUrl: "https://evil.example/cmaps/",
    isEvalSupported: true,
  });
  assert.equal(params.data, data);
  assert.equal(params.password, "pw");
  assert.equal(params.enableXfa, false);
  assert.equal(params.wasmUrl, "chrome-extension://test-ext/lib/pdfjs/wasm/");
  for (const key of ["url", "cMapUrl", "isEvalSupported", "standardFontDataUrl", "httpHeaders", "withCredentials"]) {
    assert.equal(key in params, false, `${key} is not forwarded`);
  }
});

// ── settings page PDF import on the real library ────────────────────────────────────────────

const IMPORT_SUBSET = [
  "pdf-reader/pdfjs-loader.js",
  "importers/shared/import-limits.js",
  "importers/shared/html-sanitize.js",
  "importers/shared/pdf-utils.js",
  "importers/converters/pdf-text-converter.js",
];

/** The importer subset on a mini DOM; `opened` / `closed` record the documents the converter used. */
function importerSandbox() {
  const { domGlobals } = require("./helpers/mini-dom");
  const ctx = vm.createContext({
    ...baseGlobals(),
    ...domGlobals(),
    chrome: { runtime: { getURL: (p) => pathToFileURL(path.join(ROOT, p)).href } },
  });
  ctx.window = ctx;
  const opened = [];
  const closed = [];
  loadContextScripts(ctx, "settings", runFile, {
    only: IMPORT_SUBSET,
    afterEach(rel) {
      if (rel === "pdf-reader/pdfjs-loader.js") {
        // vm scripts cannot use import(); hand the loader Node's own import for the same file URLs.
        const realLoad = ctx.ZEHPdfjs.loadLibrary;
        ctx.ZEHPdfjs.loadLibrary = () => realLoad((url) => import(url));
      }
      if (rel === "importers/shared/pdf-utils.js") {
        // the converters destructure ZEHPdfUtils when they load, so wrap before they do
        const utils = ctx.ZEHPdfUtils;
        const realOpen = utils.loadPdfDocument;
        const realClose = utils.closePdfDocument;
        utils.loadPdfDocument = async (file) => {
          const pdf = await realOpen(file);
          opened.push(pdf);
          return pdf;
        };
        utils.closePdfDocument = async (pdf) => {
          closed.push(pdf);
          return realClose(pdf);
        };
      }
    },
  });
  return { ctx, opened, closed };
}

function fakeFile(name, bytes) {
  return { name, size: bytes.length, arrayBuffer: async () => Uint8Array.from(bytes).buffer };
}

async function quietly(fn) {
  const saved = { log: console.log, warn: console.warn };
  console.log = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    Object.assign(console, saved);
  }
}

test("PDF import (text mode): a real PDF converts with the vendored PDF.js 6.4.299", async () => {
  const { ctx, opened, closed } = importerSandbox();
  const { buildPdf, paragraph, wrapWords } = require("./helpers/pdf-builder");
  const body = "Incorporating external knowledge makes answers easier to verify. ".repeat(20);
  const bytes = buildPdf({ title: "Import", pages: [{ texts: paragraph(wrapWords(body, 440, 11), { x: 72, top: 720 }) }] });
  const book = await quietly(() => ctx.ZEHPdfTextConverter.convertPdfText(fakeFile("notes.pdf", bytes)));
  assert.equal(book.sourceFormat, "pdf");
  assert.equal(book.chapters.length, 1);
  assert.match(book.chapters[0].html, /Incorporating external knowledge/);
  assert.equal(opened.length, 1);
  assert.deepEqual(closed, opened, "the document is released after a successful import");
  assert.equal(opened[0].loadingTask.destroyed, true);
});

test("PDF import (text mode): an image-only PDF fails with the scanned-PDF message and is released", async () => {
  const { ctx, opened, closed } = importerSandbox();
  await assert.rejects(
    quietly(() => ctx.ZEHPdfTextConverter.convertPdfText(fakeFile("scan.pdf", pdfFixture("image-only.pdf")))),
    /扫描版或图片型 PDF/
  );
  assert.equal(opened.length, 1);
  assert.deepEqual(closed, opened);
  assert.equal(opened[0].loadingTask.destroyed, true, "loading task destroyed after the failure");
});

test("PDF import: a password-protected PDF reports the password error; a corrupt one the parse error", async () => {
  const { ctx } = importerSandbox();
  await assert.rejects(
    quietly(() => ctx.ZEHPdfUtils.loadPdfDocument(fakeFile("locked.pdf", pdfFixture("password.pdf")))),
    (err) => err && err.name === "PasswordException"
  );
  await assert.rejects(
    quietly(() => ctx.ZEHPdfUtils.loadPdfDocument(fakeFile("bad.pdf", pdfFixture("corrupt.pdf")))),
    (err) => err && err.name === "InvalidPDFException"
  );
});
