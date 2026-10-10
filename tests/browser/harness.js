/**
 * Browser test harness: the real extension in a real Chromium / Chrome, local fixtures only.
 *
 *   - Playwright is not a dependency of the repository: it is resolved from MK_PLAYWRIGHT (a module
 *     path), the project, or the global npm root. Without it the browser tests are skipped with a
 *     message (never reported as passing).
 *   - The browser is MK_BROWSER_PATH (for example Chrome for Testing 151+, needed for the PDF MIME
 *     handler) or Playwright's own Chromium. MK_HEADED=1 runs headed (use xvfb-run on CI).
 *   - Every host name except localhost / 127.0.0.1 resolves to NOTFOUND, and provider calls are
 *     answered by a stub installed in the service worker, so nothing leaves the machine and no
 *     paid provider is ever called.
 *   - PDFs are the generated fixtures of tests/helpers/pdf-fixtures.js, served by a local HTTP
 *     server with Content-Type: application/pdf.
 *   - MK_EXTENSION_DIR loads the extension from another directory, for example the unpacked
 *     release archive of scripts/package-release.js; tests and fixtures still come from ROOT.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { execSync } = require("node:child_process");
const { pdfFixture, FIXTURE_NAMES } = require("../helpers/pdf-fixtures");

const ROOT = path.resolve(__dirname, "..", "..");
const EXTENSION_DIR = process.env.MK_EXTENSION_DIR ? path.resolve(process.env.MK_EXTENSION_DIR) : ROOT;

function loadPlaywright() {
  const candidates = [process.env.MK_PLAYWRIGHT, "playwright", "playwright-core"];
  try {
    const globalRoot = execSync("npm root -g", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    candidates.push(path.join(globalRoot, "playwright"), path.join(globalRoot, "playwright-core"));
  } catch {
    /* no npm on PATH */
  }
  for (const name of candidates.filter(Boolean)) {
    try {
      return require(name);
    } catch {
      /* try the next one */
    }
  }
  return null;
}

const playwright = loadPlaywright();
const SKIP_REASON = playwright ? "" : "Playwright not found (set MK_PLAYWRIGHT or install playwright globally)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, ms = 8000, label = "condition", step = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await Promise.resolve()
      .then(fn)
      .catch(() => false);
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms waiting for ${label}`);
    await sleep(step);
  }
}

/**
 * Local HTTP server: /fixtures/<name>.pdf as application/pdf, /page.html as a plain web page.
 * /expiring/<name>.pdf is the same PDF until its path is added to `expired` (then 410 Gone, an
 * HTML page, like an expired signed link). `ranges` records the paths requested with a Range header.
 * `pages` adds more HTML pages: { "/path.html": (url, port) => html }. The server listens on
 * 127.0.0.1; http://localhost:<port>/… reaches the same server from another origin (cross-origin
 * iframes).
 */
function startServer(pages = {}) {
  const requests = [];
  const ranges = [];
  const expired = new Set();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    requests.push(url.pathname);
    if (req.headers.range) ranges.push(url.pathname);
    const m = url.pathname.match(/^\/(?:fixtures|expiring)\/([\w-]+\.pdf)$/);
    if (m && FIXTURE_NAMES.includes(m[1])) {
      if (expired.has(url.pathname)) {
        res.writeHead(410, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        res.end("<!doctype html><title>Gone</title><p>This link has expired.</p>");
        return;
      }
      const body = pdfFixture(m[1]);
      res.writeHead(200, { "content-type": "application/pdf", "content-length": body.length, "cache-control": "no-store" });
      res.end(body);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(pages, url.pathname)) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(pages[url.pathname](url, server.address().port));
      return;
    }
    if (url.pathname === "/page.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end('<!doctype html><title>Plain page</title><p id="p1">The bank approved the loan quickly after a long review.</p>');
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        pdfUrl: (name) => `http://127.0.0.1:${port}/fixtures/${name}`,
        expiringUrl: (name) => `http://127.0.0.1:${port}/expiring/${name}`,
        requests,
        ranges,
        expired,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** A fixture written to a temporary file (for the file chooser) */
function fixtureFile(dir, name) {
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, pdfFixture(name));
  return file;
}

/**
 * Stub for every provider request made by the service worker: an OpenAI-compatible answer, and a
 * record of the prompt it received (so tests can check the sentence sent for context enhancement).
 * Installed again whenever the worker restarts. A test can set `__mkStub.respond(prompt)` to shape
 * the answer, and `__mkStub.hold = true` to keep answers waiting until `__mkStub.release(n)` lets the
 * n-th waiting request through (to make lookups overlap and finish in a chosen order).
 */
async function installProviderStub(sw) {
  await sw.evaluate(() => {
    if (globalThis.__mkStub) return;
    const realFetch = globalThis.fetch.bind(globalThis);
    const stub = { requests: [], waiting: [], hold: false };
    stub.release = (n) => {
      const entry = stub.waiting[n];
      if (entry && !entry.done) {
        entry.done = true;
        entry.go();
      }
    };
    globalThis.__mkStub = stub;
    globalThis.fetch = async (url, init) => {
      const href = String(url);
      if (href.startsWith(chrome.runtime.getURL(""))) return realFetch(url, init);
      let body = {};
      try {
        body = JSON.parse((init && init.body) || "{}");
      } catch {
        /* not JSON */
      }
      const prompt = (body.messages || []).map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
      stub.requests.push({ url: href.slice(0, 80), prompt });
      if (stub.hold) {
        await new Promise((go) => stub.waiting.push({ prompt, go, done: false }));
      }
      const content = JSON.stringify(typeof stub.respond === "function" ? stub.respond(prompt) : {
        term: "stub",
        phonetic: "",
        part_of_speech: "adjective",
        short_meaning: "桩释义",
        context_meaning: "桩说明",
        meaning_here: "桩此处含义",
        pos_here: "adjective",
        sentence_translation: "桩原句翻译",
        translation: "桩整句翻译",
        grammar_notes: "",
        key_phrases: [],
        examples: [],
        memory_tip: "",
        memory_tip_type: "none",
        derivatives: [],
        synonyms: [],
      });
      return new Response(
        JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };
  });
}

/**
 * Launch the browser with the extension loaded from the working tree (or MK_EXTENSION_DIR).
 * @returns {Promise<{ ctx, sw, id, base, major: number, version: string, close: Function, profile: string }>}
 */
async function launch() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mk-browser-"));
  const headed = process.env.MK_HEADED === "1";
  const ctx = await playwright.chromium.launchPersistentContext(profile, {
    headless: !headed,
    ...(process.env.MK_BROWSER_PATH ? { executablePath: process.env.MK_BROWSER_PATH } : { channel: "chromium" }),
    acceptDownloads: true,
    viewport: { width: 1200, height: 900 },
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  const close = async () => {
    await ctx.close().catch(() => {});
    fs.rmSync(profile, { recursive: true, force: true });
  };
  try {
    return await prepare(ctx, profile, close);
  } catch (err) {
    await close();
    throw err;
  }
}

async function prepare(ctx, profile, close) {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker", { timeout: 20000 });
  const id = new URL(sw.url()).host;
  // top-level const / let of the worker scripts are not properties of globalThis
  await until(() => sw.evaluate(() => typeof ZEH_MESSAGE_ROUTES !== "undefined" && Boolean(chrome.storage)), 10000, "service worker ready");
  await sleep(800); // onInstalled migrations
  const page = ctx.pages()[0] || (await ctx.newPage());
  const version = await page.evaluate(() => navigator.userAgentData?.getHighEntropyValues?.(["fullVersionList"]).then((v) => (v.fullVersionList || []).map((b) => `${b.brand} ${b.version}`).join("; ")) || navigator.userAgent);
  const major = Number((String(version).match(/(?:Chromium|Google Chrome|Chrome)[ /](\d+)/) || [])[1] || 0);
  await sw.evaluate(async () => {
    await chrome.storage.local.set({
      zehProviders: { deepseek: { enabled: true, apiKey: "browser-test-key", model: "deepseek-chat" } },
      zehActiveProvider: "deepseek",
    });
  });
  await installProviderStub(sw);
  return {
    ctx,
    sw,
    id,
    base: `chrome-extension://${id}`,
    major,
    version,
    profile,
    close,
  };
}

/** Record every runtime message an extension page sends (EXPLAIN / ADD_VOCAB …) */
const RECORD_MESSAGES = () => {
  window.__mkSent = [];
  const api = globalThis.chrome && chrome.runtime;
  if (!api || !api.sendMessage) return;
  const original = api.sendMessage.bind(api);
  api.sendMessage = (message, ...rest) => {
    try {
      window.__mkSent.push(JSON.parse(JSON.stringify(message)));
    } catch {
      /* not serialisable */
    }
    return original(message, ...rest);
  };
};

module.exports = {
  ROOT,
  EXTENSION_DIR,
  playwright,
  SKIP_REASON,
  sleep,
  until,
  startServer,
  fixtureFile,
  installProviderStub,
  launch,
  RECORD_MESSAGES,
};
