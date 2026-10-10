/**
 * The extension's script load order, read from the files Chrome itself reads.
 *
 * There is no build step: every execution context loads a list of classic scripts that
 * share one global scope. Those lists are declared in seven places (manifest.json, the
 * importScripts(...) call in background.js and five HTML pages). This module parses them so
 * tests never keep their own copy of a list. If a declaration changes, every sandbox that
 * loads the context follows automatically.
 *
 * Contexts:
 *   service-worker  manifest.background.service_worker + its top-level importScripts(...)
 *   content         manifest.content_scripts[0].js (every frame of every page)
 *   settings        <script src> in manifest.options_page
 *   reader          <script src> in reader.html (opened by settings.js via chrome.runtime.getURL)
 *   popup           <script src> in manifest.action.default_popup
 *   side-panel      <script src> in manifest.side_panel.default_path
 *   pdf-reader      <script src> in manifest.mime_types_handler["application/pdf"].handler_url
 *                   (the enhanced PDF reader; also opened directly for local files)
 */
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");

/** reader.html is the only extension page the manifest does not declare. */
const READER_PAGE = "reader.html";

const CONTEXT_NAMES = ["service-worker", "content", "settings", "reader", "popup", "side-panel", "pdf-reader"];

function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

function readManifest() {
  return JSON.parse(readText("manifest.json"));
}

/** "settings.html#usage" / "./popup.html?x" → "settings.html" / "popup.html" */
function pagePath(value) {
  return path.posix.normalize(String(value).split(/[?#]/)[0]).replace(/^\.\//, "");
}

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

/**
 * Parse a JS string literal starting at `source[i]` (' or "). Returns { value, end }.
 * Only simple escapes are needed for file names; anything unusual is rejected.
 */
function readStringLiteral(source, i) {
  const quote = source[i];
  let j = i + 1;
  let value = "";
  while (j < source.length && source[j] !== quote) {
    if (source[j] === "\\" || source[j] === "\n") {
      throw new Error(`unsupported escape or newline in string literal at offset ${j}`);
    }
    value += source[j];
    j += 1;
  }
  if (source[j] !== quote) throw new Error(`unterminated string literal at offset ${i}`);
  return { value, end: j + 1 };
}

/**
 * Read the importScripts(...) list of a classic service worker.
 *
 * Chrome only allows importScripts() during the worker's first synchronous evaluation, so the
 * call must be a top-level statement. The parser accepts exactly that shape: the call starts
 * at column 0 and every argument is a string literal. Any other occurrence outside a comment
 * (indented, computed arguments, inside a function) is an error, because the list could then
 * no longer be derived statically. The runtime test confirms the call really happens during
 * the synchronous evaluation of the entry file.
 *
 * @returns {{ scripts: string[], calls: { line: number, scripts: string[] }[] }}
 */
function parseImportScripts(source, file) {
  const calls = [];
  const re = /importScripts\s*\(/g;
  let m;
  while ((m = re.exec(source))) {
    const lineStart = source.lastIndexOf("\n", m.index - 1) + 1;
    const before = source.slice(lineStart, m.index);
    const trimmed = before.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    const line = lineOf(source, m.index);
    if (before !== "") {
      throw new Error(
        `${file}:${line}: importScripts must be a top-level statement starting at column 0 (found "${before}importScripts(")`
      );
    }
    let i = m.index + m[0].length;
    const scripts = [];
    for (;;) {
      while (/\s/.test(source[i])) i += 1;
      if (source[i] === ")") break;
      if (source[i] !== '"' && source[i] !== "'") {
        throw new Error(`${file}:${line}: importScripts arguments must be string literals`);
      }
      const lit = readStringLiteral(source, i);
      scripts.push(lit.value);
      i = lit.end;
      while (/\s/.test(source[i])) i += 1;
      if (source[i] === ",") i += 1;
      else if (source[i] !== ")") throw new Error(`${file}:${line}: unexpected "${source[i]}" in importScripts(...)`);
    }
    calls.push({ line, scripts });
  }
  return { scripts: calls.flatMap((c) => c.scripts), calls };
}

/** Parse the attributes of one start tag: { name: value } (valueless attributes → ""). */
function parseAttributes(text) {
  const attrs = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(text))) {
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return attrs;
}

/**
 * <script> elements of an HTML page in document order.
 * HTML comments are blanked (keeping offsets, so line numbers stay right).
 * @returns {{ src: string|null, attrs: object, inline: boolean, line: number }[]}
 */
function parseHtmlScripts(html) {
  const visible = html.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, " "));
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m;
  while ((m = re.exec(visible))) {
    const attrs = parseAttributes(m[1]);
    out.push({
      src: "src" in attrs ? attrs.src : null,
      attrs,
      inline: m[2].trim().length > 0,
      line: lineOf(visible, m.index),
    });
  }
  return out;
}

/** Resolve a script reference against the page that declares it ("lib/a.js" from "settings.html"). */
function resolveScriptPath(fromFile, src) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) {
    throw new Error(`${fromFile}: remote or absolute script URL is not allowed in an extension page: ${src}`);
  }
  const clean = src.split(/[?#]/)[0];
  const base = path.posix.dirname(fromFile);
  const resolved = clean.startsWith("/") ? clean.slice(1) : path.posix.join(base, clean);
  return path.posix.normalize(resolved);
}

function htmlContext(name, page) {
  const html = readText(page);
  const tags = parseHtmlScripts(html);
  return {
    name,
    kind: "page",
    declaredIn: page,
    scripts: tags.filter((t) => t.src != null).map((t) => resolveScriptPath(page, t.src)),
    tags,
  };
}

/**
 * Full description of one execution context.
 * @returns {{
 *   name: string,
 *   kind: "worker" | "content" | "page",
 *   declaredIn: string,
 *   scripts: string[],   files in the order their top-level declarations are instantiated
 *   tags?: object[],     page contexts: every <script> element, for attribute checks
 *   entry?: string,      service worker: the manifest entry file
 *   imports?: string[],  service worker: the importScripts(...) list
 *   group?: object,      content: the manifest content_scripts entry
 * }}
 */
function getContext(name) {
  const manifest = readManifest();
  switch (name) {
    case "service-worker": {
      const entry = manifest.background && manifest.background.service_worker;
      if (!entry) throw new Error("manifest.json has no background.service_worker");
      const { scripts: imports, calls } = parseImportScripts(readText(entry), entry);
      // The entry file is instantiated first; importScripts runs during its evaluation.
      return { name, kind: "worker", declaredIn: `manifest.json + ${entry}`, entry, imports, calls, scripts: [entry, ...imports] };
    }
    case "content": {
      const groups = manifest.content_scripts || [];
      if (groups.length !== 1) {
        throw new Error(`expected exactly one manifest content_scripts entry, found ${groups.length}; extend load-order.js`);
      }
      return { name, kind: "content", declaredIn: "manifest.json content_scripts[0].js", group: groups[0], scripts: [...(groups[0].js || [])] };
    }
    case "settings":
      return htmlContext(name, pagePath(manifest.options_page));
    case "reader":
      return htmlContext(name, READER_PAGE);
    case "popup":
      return htmlContext(name, pagePath(manifest.action.default_popup));
    case "side-panel":
      return htmlContext(name, pagePath(manifest.side_panel.default_path));
    case "pdf-reader": {
      const handler = manifest.mime_types_handler && manifest.mime_types_handler["application/pdf"];
      if (!handler || !handler.handler_url) throw new Error('manifest.json has no mime_types_handler["application/pdf"].handler_url');
      return htmlContext(name, pagePath(handler.handler_url));
    }
    default:
      throw new Error(`unknown execution context "${name}" (known: ${CONTEXT_NAMES.join(", ")})`);
  }
}

function getAllContexts() {
  return CONTEXT_NAMES.map(getContext);
}

/**
 * The authoritative script list of a context, optionally narrowed for a focused unit test.
 * `only` must be a subsequence of the real list (same files, same relative order), so a
 * subset can never drift from what Chrome loads: renaming or reordering a file breaks it.
 */
function scriptsFor(name, options) {
  const all = getContext(name).scripts;
  const only = options && options.only;
  if (!only) return all;
  let cursor = 0;
  for (const file of only) {
    const at = all.indexOf(file, cursor);
    if (at < 0) {
      throw new Error(
        `"${file}" is not loaded by ${name} after the previous subset entry; the real order is: ${all.join(", ")}`
      );
    }
    cursor = at + 1;
  }
  return [...only];
}

/**
 * Run a context's scripts in a vm context, in the declared order.
 * @param {(ctx: object, rel: string) => void} runFile  extension-sandbox runFile
 * @param {{
 *   only?: string[],                      subsequence of the real list (focused tests)
 *   substitute?: Record<string, (ctx: object) => void>,  run a test double instead of a file;
 *       each key must be in the list, so a double always sits exactly where the file loads
 *   beforeEach?: (rel: string, ctx: object) => void,
 *   afterEach?: (rel: string, ctx: object) => void,
 * }} [options]
 * @returns {string[]} the files that ran (substituted ones excluded)
 */
function loadContextScripts(ctx, name, runFile, options) {
  const opts = options || {};
  if (getContext(name).kind === "worker") {
    throw new Error("the service worker loads its imports through importScripts(); use loadBackground()");
  }
  const list = scriptsFor(name, opts);
  const substitute = opts.substitute || {};
  Object.keys(substitute).forEach((file) => {
    if (!list.includes(file)) throw new Error(`substitute "${file}" is not loaded by ${name}: ${list.join(", ")}`);
  });
  const ran = [];
  for (const file of list) {
    if (opts.beforeEach) opts.beforeEach(file, ctx);
    if (substitute[file]) substitute[file](ctx);
    else {
      runFile(ctx, file);
      ran.push(file);
    }
    if (opts.afterEach) opts.afterEach(file, ctx);
  }
  return ran;
}

module.exports = {
  ROOT,
  READER_PAGE,
  CONTEXT_NAMES,
  readManifest,
  parseImportScripts,
  parseHtmlScripts,
  resolveScriptPath,
  getContext,
  getAllContexts,
  scriptsFor,
  loadContextScripts,
};
