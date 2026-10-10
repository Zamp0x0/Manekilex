/**
 * Enhanced PDF reader, Phases 1–2: how the page is registered, where its bytes come from, the
 * states it shows, and what it releases.
 *
 *   - manifest: application/pdf → pdf-reader.html with can_embed false, no new permission, the
 *     page is not web-accessible, and the extension-page CSP is unchanged;
 *   - document.js: the MIME stream is fetched exactly once from streamUrl (never originalUrl),
 *     size / stall / HTTP / non-PDF failures each have their own message, and provenance keeps
 *     only scheme + host + path of an http(s) address;
 *   - app.js on a fake PDF.js: older Chrome → file picker, Chrome 151+ → stream → document,
 *     password / corrupt / scanned states, the native fallback only on the MIME path and only on a
 *     click, download through a Blob URL, and every task / URL / timer released on close;
 *   - settings: the "use Manekilex for PDFs" switch reads and writes the native handler option and
 *     explains when the browser cannot do it.
 * The real PDF.js renderer runs in the browser checks (tests/browser/); here it is replaced.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ROOT, getContext } = require("./helpers/load-order");
const { baseGlobals, runFile, createStorageArea, createEvent } = require("./helpers/extension-sandbox");
const { loadPdfReaderPage } = require("./helpers/pdf-reader-page");
const { loadSettingsPage } = require("./helpers/settings-page");
const { disposeLookupControllers } = require("./helpers/fake-dom");

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await tick(5);
  }
  assert.fail(`timed out waiting for ${label}`);
}

const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n% fake body for the reader tests\n%%EOF");

// ── manifest and page declaration ─────────────────────────────────────────────────────────

test("manifest: application/pdf is handled by pdf-reader.html with can_embed false and nothing else widened", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.mime_types_handler, {
    "application/pdf": { handler_url: "pdf-reader.html", can_embed: false },
  });
  assert.deepEqual(manifest.permissions, ["storage", "unlimitedStorage", "tabs", "contextMenus", "sidePanel", "tabCapture", "activeTab"]);
  assert.ok(!manifest.permissions.some((p) => /declarativeNetRequest|webRequest|downloads|<all_urls>/.test(p)));
  assert.ok(!(manifest.host_permissions || []).some((h) => h === "<all_urls>" || h.startsWith("*://") || h.startsWith("file:")));
  const exposed = (manifest.web_accessible_resources || []).flatMap((w) => w.resources || []);
  assert.ok(!exposed.some((r) => r.startsWith("pdf-reader")), "the reader page is not web-accessible");
  assert.equal(manifest.content_security_policy.extension_pages, "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';");
  assert.equal(fs.existsSync(path.join(ROOT, "pdf-reader.html")), true);
});

test("pdf-reader.html: local classic scripts, config.js first, PDF.js only through the loader", () => {
  const ctx = getContext("pdf-reader");
  assert.equal(ctx.declaredIn, "pdf-reader.html");
  assert.equal(ctx.scripts[0], "config.js");
  for (const tag of ctx.tags) assert.equal(tag.inline, false);
  assert.ok(!ctx.scripts.some((f) => f.startsWith("lib/pdfjs/")));
  assert.ok(ctx.scripts.includes("pdf-reader/pdfjs-loader.js"));
  assert.equal(ctx.scripts[ctx.scripts.length - 1], "pdf-reader/app.js", "the app starts after every module it uses");
  const html = fs.readFileSync(path.join(ROOT, "pdf-reader.html"), "utf8");
  assert.doesNotMatch(html, /https?:\/\//, "no remote resource");
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "no inline event handler");
});

// ── document.js ───────────────────────────────────────────────────────────────────────────

function documentSandbox() {
  const ctx = vm.createContext({ ...baseGlobals() });
  ctx.window = ctx;
  runFile(ctx, "config.js");
  runFile(ctx, "pdf-reader/document.js");
  return ctx.ZEHPdfDocument;
}

function streamResponse(chunks, { status = 200, length } = {}) {
  let i = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === "content-length" && length != null ? String(length) : null) },
    body: {
      getReader: () => ({
        read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
      }),
    },
  };
}

const STREAM_INFO = {
  mimeType: "application/pdf",
  originalUrl: "https://user:secret@papers.example.org/files/rag%20notes.pdf?token=abc#page=2",
  streamUrl: "chrome-extension://test-extension/stream/1234",
  responseHeaders: {},
  tabId: 7,
  embedded: false,
};

test("document: no chrome.mimeHandler (Chrome < 151) means no MIME path", () => {
  const D = documentSandbox();
  assert.equal(D.getMimeHandler({ chrome: {} }), null);
  assert.equal(D.getMimeHandler({ chrome: { mimeHandler: {} } }), null);
  const api = { getStreamInfo: async () => STREAM_INFO };
  assert.equal(D.getMimeHandler({ chrome: { mimeHandler: api } }), api);
  assert.equal(D.getMimeHandler({ browser: { mimeHandler: api } }), api, "the documented browser.* namespace works too");
});

test("document: the stream is fetched once, from streamUrl, without credentials", async () => {
  const D = documentSandbox();
  const fetches = [];
  const source = D.createStreamSource({
    mimeHandler: { getStreamInfo: async () => STREAM_INFO },
    fetchImpl: async (url, init) => {
      fetches.push({ url, init });
      return streamResponse([PDF_BYTES.slice(0, 10), PDF_BYTES.slice(10)]);
    },
  });
  const { data, provenance } = await source.read();
  assert.deepEqual([...data], [...PDF_BYTES]);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, STREAM_INFO.streamUrl, "originalUrl is never requested again");
  assert.equal(fetches[0].init.credentials, "omit");
  await assert.rejects(source.read(), (err) => err.code === "STREAM_ALREADY_READ");
  assert.equal(fetches.length, 1);
  assert.equal(provenance.kind, "stream");
  assert.equal(provenance.url, "https://papers.example.org/files/rag%20notes.pdf", "no query, fragment or credentials");
  assert.equal(provenance.fileName, "rag notes.pdf");
  assert.equal(provenance.tabId, 7);
});

test("document: stream failures are explained, never retried", async () => {
  const D = documentSandbox();
  const make = (fetchImpl, extra) =>
    D.createStreamSource({ mimeHandler: { getStreamInfo: async () => STREAM_INFO }, fetchImpl, ...(extra || {}) });

  await assert.rejects(make(async () => streamResponse([], { status: 404 })).read(), (e) => e.code === "STREAM_FAILED" && /HTTP 404/.test(e.detail));
  await assert.rejects(make(async () => { throw new TypeError("Failed to fetch"); }).read(), (e) => e.code === "STREAM_FAILED");
  await assert.rejects(make(async () => streamResponse([new TextEncoder().encode("<html>login</html>")])).read(), (e) => e.code === "NOT_PDF");
  await assert.rejects(make(async () => streamResponse([])).read(), (e) => e.code === "EMPTY");
  await assert.rejects(make(async () => streamResponse([PDF_BYTES], { length: 10 }), { maxBytes: 5 }).read(), (e) => e.code === "TOO_LARGE");
  await assert.rejects(make(async () => streamResponse([PDF_BYTES, PDF_BYTES]), { maxBytes: PDF_BYTES.length + 1 }).read(), (e) => e.code === "TOO_LARGE");
  await assert.rejects(
    D.createStreamSource({ mimeHandler: { getStreamInfo: async () => ({ originalUrl: "x" }) } }).read(),
    (e) => e.code === "STREAM_UNAVAILABLE"
  );
  // a stream that stops delivering bytes is aborted after the stall window
  const stalled = make(
    (url, init) =>
      new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    { stallMs: 20 }
  );
  await assert.rejects(stalled.read(), (e) => e.code === "STREAM_STALLED");
});

test("document: file names and provenance never keep secrets", () => {
  const D = documentSandbox();
  assert.equal(D.fileNameFromDisposition('attachment; filename="report.pdf"'), "report.pdf");
  assert.equal(D.fileNameFromDisposition("inline; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf"), "报告.pdf");
  assert.equal(D.fileNameFromDisposition('attachment; filename="..\\..\\evil.pdf"'), "evil.pdf");
  const p = D.provenanceFromStream({ ...STREAM_INFO, responseHeaders: { "Content-Disposition": 'inline; filename="paper.pdf"' } });
  assert.equal(p.fileName, "paper.pdf");
  assert.equal(D.provenanceFromStream({ originalUrl: "file:///C:/Users/me/secret.pdf" }).url, "", "local paths are not stored");
  assert.equal(D.provenanceFromStream({ originalUrl: "blob:https://x/1" }).url, "");
  assert.equal(D.looksLikePdf(new TextEncoder().encode("garbage\n%PDF-1.4")), true);
  assert.equal(D.looksLikePdf(new TextEncoder().encode("PK\u0003\u0004")), false);
});

test("document: local files are read in memory and checked", async () => {
  const D = documentSandbox();
  const file = (name, bytes, type = "application/pdf") => ({ name, type, size: bytes.length, arrayBuffer: async () => bytes.buffer.slice(0) });
  const ok = await D.readFile(file("C:\\fakepath\\notes.pdf", PDF_BYTES));
  assert.equal(ok.provenance.kind, "file");
  assert.equal(ok.provenance.fileName, "notes.pdf");
  assert.equal(ok.provenance.url, "");
  await assert.rejects(D.readFile(file("a.docx", PDF_BYTES, "application/msword")), (e) => e.code === "NOT_PDF");
  await assert.rejects(D.readFile(file("a.pdf", new TextEncoder().encode("hello"))), (e) => e.code === "NOT_PDF");
  await assert.rejects(D.readFile({ ...file("big.pdf", PDF_BYTES), size: D.MAX_BYTES + 1 }), (e) => e.code === "TOO_LARGE");
  assert.equal(D.classifyError({ name: "InvalidPDFException" }).code, "INVALID_PDF");
  assert.equal(D.classifyError({ name: "PasswordException" }).code, "PASSWORD_CANCELLED");
  assert.equal(D.classifyError(new Error("boom")).code, "UNKNOWN");
});

// ── app.js on a fake PDF.js ──────────────────────────────────────────────────────────────────

/** A PDF.js stand-in: getDocument tasks, documents, and the four viewer components the app uses. */
function fakePdfjs(options) {
  const opts = options || {};
  const tasks = [];
  const viewers = [];
  const makeDoc = () => ({
    numPages: opts.numPages || 3,
    getMetadata: async () => ({ info: { Title: opts.title || "" } }),
    getPage: async () => ({ getTextContent: async () => ({ items: opts.scanned ? [] : [{ str: "Hello world" }] }) }),
    getData: async () => PDF_BYTES,
  });
  const lib = {
    version: "6.4.299",
    AnnotationMode: { ENABLE: 1 },
    AnnotationEditorType: { DISABLE: -1 },
    PasswordResponses: { NEED_PASSWORD: 1, INCORRECT_PASSWORD: 2 },
    getDocument(params) {
      const task = { params, destroyed: false, onPassword: null, onProgress: null };
      task.promise = new Promise((resolve, reject) => {
        task.destroy = async () => {
          task.destroyed = true;
          reject(Object.assign(new Error("Worker was destroyed"), { name: "AbortException" }));
        };
        setTimeout(() => {
          if (opts.failWith) return reject(opts.failWith);
          if (opts.password) {
            const ask = (reason) =>
              task.onPassword((pw) => (pw === opts.password ? resolve(makeDoc()) : setTimeout(() => ask(2), 0)), reason);
            return ask(1);
          }
          resolve(makeDoc());
        }, 0);
      });
      tasks.push(task);
      return task;
    },
  };
  class PDFViewer {
    constructor(o) {
      this.options = o;
      this.docs = [];
      this.pdfDocument = null;
      this.currentPageNumber = 1;
      this.currentScaleValue = "auto";
      viewers.push(this);
    }
    setDocument(doc) {
      this.docs.push(doc);
      this.pdfDocument = doc;
    }
    get pagesCount() {
      return this.pdfDocument ? this.pdfDocument.numPages : 0;
    }
    nextPage() {}
    previousPage() {}
    increaseScale() {}
    decreaseScale() {}
    update() {}
  }
  const components = {
    EventBus: class {
      constructor() {
        this.dispatched = [];
      }
      on() {}
      dispatch(name, data) {
        this.dispatched.push({ name, data });
      }
    },
    PDFLinkService: class {
      constructor(o) {
        this.options = o;
      }
      setViewer() {}
      setDocument() {}
    },
    PDFFindController: class {},
    LinkTarget: { BLANK: 2 },
    PDFViewer,
  };
  return { lib, components, tasks, viewers, load: async () => ({ lib, viewer: components }) };
}

function mimeHandlerDouble(info) {
  const calls = { getStreamInfo: 0, fallback: 0 };
  return {
    calls,
    api: {
      getStreamInfo: async () => {
        calls.getStreamInfo += 1;
        if (info instanceof Error) throw info;
        return info;
      },
      abortAndFallbackToNativeHandler: async () => {
        calls.fallback += 1;
      },
    },
  };
}

function okFetch(log) {
  return async (url, init) => {
    log.push(url);
    return streamResponse([PDF_BYTES]);
  };
}

test("app: on Chrome without chrome.mimeHandler the reader offers the file picker and loads nothing", async (t) => {
  const pdfjs = fakePdfjs();
  const fetches = [];
  const page = loadPdfReaderPage({ pdfjs: pdfjs.load, fetch: okFetch(fetches) });
  t.after(() => page.app.destroy());
  assert.equal(await page.app.ready, "file");
  assert.equal(page.app.state.view, "landing");
  assert.equal(page.document.getElementById("statePanel").hidden, false);
  assert.equal(page.document.getElementById("landingState").hidden, false);
  assert.deepEqual(fetches, []);
  assert.equal(pdfjs.tasks.length, 0, "PDF.js is not loaded until a file is chosen");
  // nothing that needs a document is usable yet, and the native fallback is not offered
  for (const id of ["prevPageBtn", "nextPageBtn", "zoomInBtn", "downloadBtn", "printBtn", "findToggleBtn"]) {
    assert.equal(page.document.getElementById(id).disabled, true, id);
  }
  assert.equal(page.document.getElementById("nativeBtn").hidden, true);
});

test("app: Chrome 151+ MIME path reads the stream once, shows the document and offers the native viewer", async (t) => {
  const pdfjs = fakePdfjs({ title: "Retrieval Notes", numPages: 4 });
  const fetches = [];
  const mime = mimeHandlerDouble(STREAM_INFO);
  const page = loadPdfReaderPage({ mimeHandler: mime.api, pdfjs: pdfjs.load, fetch: okFetch(fetches) });
  t.after(() => page.app.destroy());
  assert.equal(await page.app.ready, "stream");
  assert.equal(page.app.state.view, "ready");
  assert.deepEqual(fetches, [STREAM_INFO.streamUrl]);
  assert.equal(mime.calls.getStreamInfo, 1);
  assert.equal(pdfjs.tasks.length, 1);
  const params = pdfjs.tasks[0].params;
  assert.equal(params.enableXfa, false);
  assert.equal("url" in params, false, "PDF.js gets the bytes, never the original URL");
  assert.equal(page.document.title, "Retrieval Notes · Manekilex PDF");
  assert.equal(page.document.getElementById("docTitle").textContent, "Retrieval Notes");
  assert.equal(page.document.getElementById("pageCount").textContent, "/ 4");
  assert.equal(page.document.getElementById("downloadBtn").disabled, false);
  assert.equal(page.document.getElementById("nativeBtn").hidden, false);
  assert.equal(page.document.getElementById("printBtn").hidden, false);
  assert.equal(mime.calls.fallback, 0, "never switches to the native viewer on its own");
  assert.equal(page.app.state.source.url, "https://papers.example.org/files/rag%20notes.pdf");
  // viewer options that keep PDF scripts, forms and attachments out
  const viewer = pdfjs.viewers[0];
  assert.equal(viewer.options.annotationMode, 1);
  assert.equal(viewer.options.annotationEditorMode, -1);
  assert.equal(viewer.options.enableAutoLinking, false);
  assert.equal(viewer.options.scriptingManager, undefined);
  assert.equal(viewer.options.downloadManager, undefined);
  assert.equal(viewer.options.linkService.options.externalLinkRel, "noopener noreferrer nofollow");

  page.document.getElementById("nativeBtn").click();
  await until(() => mime.calls.fallback === 1, "native fallback");
  assert.equal(pdfjs.tasks[0].destroyed, true, "the document is released before Chrome takes over");
});

test("app: a stream failure explains itself and offers the native viewer, without redirecting", async (t) => {
  const pdfjs = fakePdfjs();
  const mime = mimeHandlerDouble(STREAM_INFO);
  const page = loadPdfReaderPage({
    mimeHandler: mime.api,
    pdfjs: pdfjs.load,
    fetch: async () => streamResponse([], { status: 403 }),
  });
  t.after(() => page.app.destroy());
  await page.app.ready;
  assert.equal(page.app.state.view, "error");
  assert.match(page.document.getElementById("errorText").textContent, /读取 PDF 数据失败/);
  assert.equal(page.document.getElementById("errorNativeBtn").hidden, false);
  assert.equal(page.document.getElementById("errorOpenBtn").hidden, false);
  assert.equal(mime.calls.fallback, 0);
  assert.equal(pdfjs.tasks.length, 0);
  page.document.getElementById("errorNativeBtn").click();
  await until(() => mime.calls.fallback === 1, "fallback on click");
});

test("app: Chrome 151+ page opened directly (no stream) falls back to the file picker", async (t) => {
  const pdfjs = fakePdfjs();
  const mime = mimeHandlerDouble(new Error("Not a MIME handler frame"));
  const page = loadPdfReaderPage({ mimeHandler: mime.api, pdfjs: pdfjs.load });
  t.after(() => page.app.destroy());
  assert.equal(await page.app.ready, "file");
  assert.equal(page.app.state.view, "landing");
  assert.equal(page.document.getElementById("nativeBtn").hidden, true);
});

function pdfFile(name = "notes.pdf") {
  return { name, type: "application/pdf", size: PDF_BYTES.length, arrayBuffer: async () => PDF_BYTES.buffer.slice(0) };
}

test("app: a password-protected PDF asks for the password, retries, and never stores it", async (t) => {
  const pdfjs = fakePdfjs({ password: "manekilex" });
  const page = loadPdfReaderPage({ pdfjs: pdfjs.load });
  t.after(() => page.app.destroy());
  await page.app.ready;
  const opened = page.app.openFile(pdfFile());
  await until(() => page.app.state.view === "password", "password prompt");
  assert.match(page.document.getElementById("passwordPrompt").textContent, /受密码保护/);
  const input = page.document.getElementById("passwordInput");
  const form = page.document.getElementById("passwordForm");
  input.value = "wrong";
  form.dispatchEvent({ type: "submit", preventDefault() {} });
  assert.equal(input.value, "", "the field is cleared right after submit");
  await until(() => page.app.state.view === "password" && /不正确/.test(page.document.getElementById("passwordPrompt").textContent), "retry prompt");
  input.value = "manekilex";
  form.dispatchEvent({ type: "submit", preventDefault() {} });
  assert.equal(await opened, true);
  assert.equal(page.app.state.view, "ready");
  assert.equal(input.value, "");
  assert.equal(page.app.state.passwordHandlers, null);
  const kept = JSON.stringify([page.app.state.source, page.app.state.title, page.app.state.lastError]);
  assert.equal(kept.includes("manekilex"), false, "the password is not kept in app state");
});

test("app: cancelling the password releases the document and says why", async (t) => {
  const pdfjs = fakePdfjs({ password: "manekilex" });
  const page = loadPdfReaderPage({ pdfjs: pdfjs.load });
  t.after(() => page.app.destroy());
  await page.app.ready;
  const opened = page.app.openFile(pdfFile());
  await until(() => page.app.state.view === "password", "password prompt");
  page.document.getElementById("passwordCancelBtn").click();
  assert.equal(await opened, false);
  assert.equal(page.app.state.view, "error");
  assert.match(page.document.getElementById("errorText").textContent, /需要密码/);
  assert.equal(pdfjs.tasks[0].destroyed, true);
});

test("app: a corrupt PDF shows a clear error instead of loading forever", async (t) => {
  const pdfjs = fakePdfjs({ failWith: Object.assign(new Error("Invalid PDF structure."), { name: "InvalidPDFException" }) });
  const page = loadPdfReaderPage({ pdfjs: pdfjs.load });
  t.after(() => page.app.destroy());
  await page.app.ready;
  assert.equal(await page.app.openFile(pdfFile("broken.pdf")), false);
  assert.equal(page.app.state.view, "error");
  assert.match(page.document.getElementById("errorText").textContent, /不是有效的 PDF/);
  assert.equal(page.document.getElementById("errorNativeBtn").hidden, true, "no native viewer for a local file");
});

test("app: a PDF without any text gets the OCR notice", async (t) => {
  const pdfjs = fakePdfjs({ scanned: true });
  const page = loadPdfReaderPage({ pdfjs: pdfjs.load });
  t.after(() => page.app.destroy());
  await page.app.ready;
  await page.app.openFile(pdfFile("scan.pdf"));
  const notice = page.document.getElementById("notice");
  await until(() => notice.hidden === false, "OCR notice");
  assert.match(notice.textContent, /OCR/);
  assert.match(notice.textContent, /暂不提供 OCR/);
});

test("app: opening another file releases the previous document; download uses a revocable Blob URL", async (t) => {
  const pdfjs = fakePdfjs({ title: "First" });
  const page = loadPdfReaderPage({ pdfjs: pdfjs.load });
  t.after(() => page.app.destroy());
  await page.app.ready;
  await page.app.openFile(pdfFile("a.pdf"));
  await page.app.openFile(pdfFile("b.pdf"));
  assert.equal(pdfjs.tasks.length, 2);
  assert.equal(pdfjs.tasks[0].destroyed, true, "the first document and its worker are destroyed");
  assert.equal(pdfjs.tasks[1].destroyed, false);
  assert.equal(pdfjs.viewers.length, 1, "one viewer is reused");
  const clicked = [];
  const origCreate = page.document.createElement.bind(page.document);
  page.document.createElement = (tag) => {
    const el = origCreate(tag);
    if (tag === "a") el.click = () => clicked.push({ href: el.href, download: el.download, rel: el.rel });
    return el;
  };
  assert.equal(await page.app.download(), true);
  assert.equal(clicked.length, 1);
  assert.equal(clicked[0].download, "b.pdf");
  assert.match(clicked[0].href, /^blob:/);
  assert.equal(page.blobs.size, 1);
  assert.equal(page.blobs.get(clicked[0].href).type, "application/pdf");

  page.app.destroy();
  await tick();
  assert.equal(pdfjs.tasks[1].destroyed, true, "closing the page destroys the open document");
  assert.equal(page.blobs.size, 0, "Blob URLs are revoked");
  assert.equal(page.app.timerCount, 0, "no timer survives");
  assert.equal(page.app.state.viewer, null);
});

test("app: pagehide (not bfcache) runs the same cleanup", async () => {
  const pdfjs = fakePdfjs();
  const page = loadPdfReaderPage({ pdfjs: pdfjs.load });
  await page.app.ready;
  await page.app.openFile(pdfFile());
  page.window.dispatchEvent({ type: "pagehide", persisted: false });
  await tick();
  assert.equal(page.app.state.destroyed, true);
  assert.equal(pdfjs.tasks[0].destroyed, true);
  disposeLookupControllers();
});

// ── settings: the native handler switch ───────────────────────────────────────────────────────

async function readingSettings(mimeHandler) {
  const onChanged = createEvent();
  const page = await loadSettingsPage({
    local: createStorageArea({}, { onChanged }),
    onChanged,
    sendMessage: async () => undefined,
  });
  page.context.chrome.mimeHandler = mimeHandler;
  await page.evalIn("setupPdfReaderCard()");
  return page;
}

test("settings: the PDF switch reflects and changes Chrome's native handler option", async () => {
  const calls = [];
  let enabled = true;
  const api = {
    getMimeHandlerOptions: async (mime) => {
      calls.push(["get", mime]);
      return { enabled };
    },
    setMimeHandlerOptions: async (mime, opts) => {
      calls.push(["set", mime, opts.enabled]);
      enabled = opts.enabled;
    },
  };
  const page = await readingSettings(api);
  const toggle = page.document.getElementById("pdfHandlerToggle");
  const status = page.document.getElementById("pdfHandlerStatus");
  assert.equal(toggle.checked, true);
  assert.equal(toggle.disabled, false);
  assert.match(status.textContent, /已开启/);
  toggle.checked = false;
  toggle.dispatchEvent({ type: "change" });
  await until(() => calls.some((c) => c[0] === "set"), "set call");
  await until(() => /已关闭/.test(status.textContent), "status update");
  assert.deepEqual(calls.filter((c) => c[0] === "set"), [["set", "application/pdf", false]]);
  assert.equal(enabled, false);
  assert.equal(toggle.checked, false);
});

test("settings: an older Chrome gets an honest compatibility message and a disabled switch", async () => {
  const page = await readingSettings(undefined);
  const toggle = page.document.getElementById("pdfHandlerToggle");
  assert.equal(toggle.disabled, true);
  assert.equal(toggle.checked, false);
  assert.match(page.document.getElementById("pdfHandlerStatus").textContent, /Chrome 151/);
  assert.match(page.document.getElementById("pdfHandlerStatus").textContent, /右键/);
});
