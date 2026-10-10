/**
 * Load the real importer modules (html-sanitize, chapter-split, epub-builder, converters)
 * into a vm context backed by the mini DOM, like settings.html does in the browser.
 * JSZip is replaced by a recorder so tests see what would be zipped without zipping.
 */
const vm = require("node:vm");
const { baseGlobals, runFile } = require("./extension-sandbox");
const { domGlobals } = require("./mini-dom");
const { loadContextScripts } = require("./load-order");

/**
 * The importer modules in settings.html's order. A focused subset of the Settings page:
 * loadContextScripts() checks it is a subsequence of the real <script> list, so a renamed or
 * reordered importer breaks this helper instead of silently testing a stale order.
 */
const IMPORTER_SUBSET = [
  "lib/marked.min.js",
  "importers/shared/import-limits.js",
  "importers/shared/html-sanitize.js",
  "importers/shared/chapter-split.js",
  "importers/epub-builder.js",
  "importers/converters/txt-converter.js",
  "importers/converters/markdown-converter.js",
  "importers/converters/html-converter.js",
  "importers/book-importer.js",
];

class FakeJSZip {
  constructor() {
    this.files = {};
  }
  file(name, content, opts) {
    this.files[name] = { content, opts: opts || {} };
  }
  async generateAsync() {
    return { size: Object.keys(this.files).length, type: "application/epub+zip", files: this.files };
  }
}

function loadImporters(options) {
  const opts = options || {};
  const context = vm.createContext({
    ...baseGlobals(),
    ...domGlobals(),
    crypto: { randomUUID: () => "00000000-0000-4000-8000-000000000000" },
    JSZip: FakeJSZip,
    Blob: globalThis.Blob,
    TextEncoder: globalThis.TextEncoder,
    TextDecoder: globalThis.TextDecoder,
  });
  context.window = context;
  context.self = context;
  context.globalThis = context;
  const only = opts.marked === false ? IMPORTER_SUBSET.filter((f) => f !== "lib/marked.min.js") : IMPORTER_SUBSET;
  loadContextScripts(context, "settings", runFile, { only });
  const api = {
    context,
    sanitize: context.ZEHHtmlSanitize,
    split: context.ZEHChapterSplit,
    builder: context.ZEHEpubBuilder,
    markdown: context.ZEHMarkdownConverter,
    html: context.ZEHHtmlConverter,
    txt: context.ZEHTxtConverter,
    importer: context.ZEHBookImporter,
    DOMParser: context.DOMParser,
    /** Parse a chapter with the strict XML parser; "" when well-formed, else the error. */
    xmlParseError(xhtml) {
      const doc = new context.DOMParser().parseFromString(xhtml, "application/xhtml+xml");
      const errs = doc.getElementsByTagName("parsererror");
      return errs.length ? errs[0].textContent : "";
    },
    /** Body text of a chapter, whitespace collapsed (for "nothing was lost" checks). */
    chapterText(xhtml) {
      const doc = new context.DOMParser().parseFromString(xhtml, "application/xhtml+xml");
      const body = doc.getElementsByTagName("body")[0];
      return (body ? body.textContent : "").replace(/\s+/g, " ").trim();
    },
    bodyOf(xhtml) {
      const m = xhtml.match(/<body>\n([\s\S]*)\n<\/body>/);
      return m ? m[1] : "";
    },
  };
  return api;
}

/** Minimal File stand-in: converters only use .name, .text() and .arrayBuffer(). */
function fakeFile(name, text) {
  return {
    name,
    size: Buffer.byteLength(text, "utf8"),
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  };
}

module.exports = { loadImporters, fakeFile, FakeJSZip };
