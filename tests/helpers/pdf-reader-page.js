/**
 * Load the enhanced PDF reader page (manifest mime_types_handler handler_url) into a sandbox.
 *
 * Every <script> of pdf-reader.html runs in the page's own order on a fake document built from
 * the page's real HTML (every element with an id exists; see extension-pages.js). PDF.js itself
 * needs a browser (canvas, workers, layout), so the page's import() of lib/pdfjs is replaced by
 * a test double through `pdfjs`: the loader's loadViewer() resolves to whatever the test passes
 * (or rejects, by default, exactly like a vm script whose import() cannot load a module).
 *
 * `mimeHandler` is the chrome.mimeHandler double (Chrome 151+); omit it for an older Chrome.
 */
const { createPageEnv } = require("./fake-dom");
const { pageDocument } = require("./extension-pages");
const { getContext } = require("./load-order");

/**
 * @param {{
 *   mimeHandler?: object,
 *   pdfjs?: () => Promise<{ lib: object, viewer: object }>,
 *   fetch?: Function,
 *   storage?: object,
 *   beforeEach?: Function,
 *   globals?: object,
 * }} [options]
 */
function loadPdfReaderPage(options) {
  const opts = options || {};
  const page = getContext("pdf-reader").declaredIn;
  const blobs = new Map();
  let blobSeq = 0;
  const URLWithBlobs = class extends URL {};
  URLWithBlobs.createObjectURL = (blob) => {
    const url = `blob:chrome-extension://test-extension/${++blobSeq}`;
    blobs.set(url, blob);
    return url;
  };
  URLWithBlobs.revokeObjectURL = (url) => blobs.delete(url);
  const env = createPageEnv({
    context: "pdf-reader",
    only: undefined,
    beforeEach: (file, ctx) => {
      if (!ctx.__pdfReaderSetup) {
        ctx.__pdfReaderSetup = true;
        ctx.window.print = () => (ctx.window.printed = (ctx.window.printed || 0) + 1);
        ctx.window.confirm = () => false;
      }
      // pdfjs-loader.js has run: swap its module loader before the app starts
      if (file === "pdf-reader/document.js" && opts.pdfjs) ctx.window.ZEHPdfjs.loadViewer = opts.pdfjs;
      if (opts.beforeEach) opts.beforeEach(file, ctx);
    },
    storage: opts.storage,
    document: pageDocument(page),
    location: {
      href: `chrome-extension://test-extension/${page}`,
      protocol: "chrome-extension:",
      hostname: "test-extension",
      pathname: `/${page}`,
      search: "",
    },
    // an older Chrome has no chrome.mimeHandler at all (the sandbox's catch-all API must not stand in)
    chromeApis: { mimeHandler: opts.mimeHandler || undefined },
    globals: {
      URL: URLWithBlobs,
      Blob,
      fetch: opts.fetch || (async () => {
        throw new Error("network disabled in tests");
      }),
      ...(opts.globals || {}),
    },
  });
  return { ...env, page, blobs, app: env.window.ZEHPdfReaderApp };
}

module.exports = { loadPdfReaderPage };
