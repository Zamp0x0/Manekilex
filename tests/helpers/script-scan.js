/**
 * Static checks over a context's script list, without running product code.
 *
 * 1. checkGlobalDeclarations(): asks V8 itself whether the files can share one global scope.
 *    Each file is compiled as a classic script with `throw` inserted before its first
 *    statement. V8 still performs GlobalDeclarationInstantiation for the file (creating its
 *    top-level const / let / class / var / function bindings, and rejecting a name that is
 *    already declared) before the first statement throws, so no statement of the product code
 *    ever runs. This is exactly the check Chrome performs when it loads the next <script> /
 *    content script / importScripts() file into the same global scope.
 *
 * 2. tokenize() / referencedProjectGlobals(): a small JavaScript tokenizer, enough to find
 *    which project globals (zeh* / ZEH* / MK*) a first-party file reads. Used by the runtime
 *    test to confirm every such name exists once the context has finished loading.
 */
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { ROOT } = require("./load-order");

const STOP = "__mkLoadOrderStop__";

function readSource(rel) {
  let source = fs.readFileSync(path.join(ROOT, rel), "utf8");
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  return source;
}

/**
 * Insert `throw` after the directive prologue (so a file that starts with "use strict" keeps
 * its strictness) and on the same line (so V8's line numbers still match the file).
 */
function withEarlyThrow(source) {
  const prologue = /^(?:\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*(?:(["'])use strict\1\s*;?)?/.exec(source);
  const at = prologue ? prologue[0].length : 0;
  return `${source.slice(0, at)}throw ${STOP};${source.slice(at)}`;
}

function snapshotGlobals(context) {
  const out = new Map();
  for (const name of Object.getOwnPropertyNames(context)) {
    const desc = Object.getOwnPropertyDescriptor(context, name);
    out.set(name, desc && "value" in desc ? desc.value : desc);
  }
  return out;
}

/**
 * Instantiate the top-level declarations of `files` in order, in one fresh global scope.
 * @returns {{
 *   errors: { file: string, message: string }[],          SyntaxError (duplicate lexical
 *       declaration, lexical vs var/function clash, or invalid syntax for a classic script)
 *   overrides: { name: string, file: string, previous: string }[],  a later top-level
 *       function declaration silently replaced an earlier global function of the same name
 *   declaredBy: Map<string, string>,                       var/function global → file
 * }}
 */
function checkGlobalDeclarations(files, options) {
  const context = vm.createContext({});
  context[STOP] = Symbol("stop");
  const stop = context[STOP];
  const errors = [];
  const overrides = [];
  const declaredBy = new Map();
  const ignore = new Set([STOP, ...Object.getOwnPropertyNames(context)]);
  for (const file of files) {
    const before = snapshotGlobals(context);
    try {
      const source = (options && options.sources && options.sources[file]) || readSource(file);
      vm.runInContext(withEarlyThrow(source), context, { filename: path.join(ROOT, file) });
      errors.push({ file, message: "the early throw did not fire; the file was not checked" });
    } catch (err) {
      if (err !== stop) {
        errors.push({ file, message: `${err && err.name}: ${err && err.message}` });
        continue;
      }
    }
    const after = snapshotGlobals(context);
    for (const [name, value] of after) {
      if (ignore.has(name)) continue;
      if (!before.has(name)) {
        declaredBy.set(name, file);
      } else if (before.get(name) !== value && typeof value === "function") {
        overrides.push({ name, file, previous: declaredBy.get(name) || "(unknown)" });
        declaredBy.set(name, file);
      }
    }
  }
  return { errors, overrides, declaredBy };
}

const KEYWORDS_BEFORE_EXPRESSION = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw",
  "case", "do", "else", "yield", "await",
]);

/**
 * Minimal tokenizer: identifiers, punctuators, strings, template literals (with ${…}
 * expressions tokenized), regular expression literals and numbers; comments are dropped.
 * The regex-vs-division decision uses the previous significant token, which is reliable for
 * formatted first-party code (it is not used on the minified libraries).
 * @returns {{ type: string, value: string, index: number }[]}
 */
function tokenize(source) {
  const tokens = [];
  const braces = []; // "{" or "${" for each open brace
  let i = 0;
  const n = source.length;

  const regexAllowed = () => {
    const prev = tokens[tokens.length - 1];
    if (!prev) return true;
    if (prev.type === "ident") return KEYWORDS_BEFORE_EXPRESSION.has(prev.value);
    if (prev.type === "punct") return !(prev.value === ")" || prev.value === "]");
    return false; // after a string, number, regex or template
  };

  const readTemplateChunk = () => {
    // i is just after "`" or after the "}" closing a ${…}
    const start = i;
    while (i < n) {
      if (source[i] === "\\") {
        i += 2;
        continue;
      }
      if (source[i] === "`") {
        i += 1;
        tokens.push({ type: "template", value: source.slice(start, i - 1), index: start });
        return;
      }
      if (source[i] === "$" && source[i + 1] === "{") {
        tokens.push({ type: "template", value: source.slice(start, i), index: start });
        i += 2;
        braces.push("${");
        return;
      }
      i += 1;
    }
    throw new Error(`unterminated template literal at offset ${start}`);
  };

  while (i < n) {
    const c = source[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f" || c === "\v" || c === " " || c === "﻿") {
      i += 1;
    } else if (c === "/" && source[i + 1] === "/") {
      while (i < n && source[i] !== "\n") i += 1;
    } else if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      if (end < 0) throw new Error(`unterminated comment at offset ${i}`);
      i = end + 2;
    } else if (c === '"' || c === "'") {
      const start = i;
      i += 1;
      while (i < n && source[i] !== c) {
        if (source[i] === "\\") i += 1;
        else if (source[i] === "\n") throw new Error(`unterminated string at offset ${start}`);
        i += 1;
      }
      i += 1;
      tokens.push({ type: "string", value: source.slice(start + 1, i - 1), index: start });
    } else if (c === "`") {
      i += 1;
      readTemplateChunk();
    } else if (/[A-Za-z_$]/.test(c)) {
      const start = i;
      while (i < n && /[\w$]/.test(source[i])) i += 1;
      tokens.push({ type: "ident", value: source.slice(start, i), index: start });
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(source[i + 1] || ""))) {
      const start = i;
      while (i < n && /[\w.]/.test(source[i])) i += 1;
      tokens.push({ type: "number", value: source.slice(start, i), index: start });
    } else if (c === "/" && regexAllowed()) {
      const start = i;
      let inClass = false;
      i += 1;
      while (i < n) {
        const ch = source[i];
        if (ch === "\\") i += 2;
        else if (ch === "\n") throw new Error(`unterminated regular expression at offset ${start}`);
        else if (inClass) {
          if (ch === "]") inClass = false;
          i += 1;
        } else if (ch === "[") {
          inClass = true;
          i += 1;
        } else if (ch === "/") {
          i += 1;
          break;
        } else i += 1;
      }
      while (i < n && /[a-z]/i.test(source[i])) i += 1;
      tokens.push({ type: "regex", value: source.slice(start, i), index: start });
    } else if (c === "{") {
      braces.push("{");
      tokens.push({ type: "punct", value: "{", index: i });
      i += 1;
    } else if (c === "}") {
      const open = braces.pop();
      if (open === "${") {
        i += 1;
        readTemplateChunk();
      } else {
        tokens.push({ type: "punct", value: "}", index: i });
        i += 1;
      }
    } else if (c === "?" && source[i + 1] === "." && !/[0-9]/.test(source[i + 2] || "")) {
      tokens.push({ type: "punct", value: "?.", index: i });
      i += 2;
    } else if (c === "." && source[i + 1] === "." && source[i + 2] === ".") {
      tokens.push({ type: "punct", value: "...", index: i });
      i += 3;
    } else {
      tokens.push({ type: "punct", value: c, index: i });
      i += 1;
    }
  }
  return tokens;
}

/** Naming convention of the extension's own cross-file globals. */
const PROJECT_GLOBAL = /^(?:_?zeh[A-Z_]|ZEH|MK[A-Z])/;
const DECLARING = new Set(["const", "let", "var", "function", "class"]);
const GLOBAL_OBJECTS = new Set(["window", "self", "globalThis"]);

/**
 * Names that refer to the global object in a file: window / self / globalThis, plus the
 * parameter of a file-wide wrapper `(function (global) { … })(typeof window !== "undefined" ?
 * window : globalThis)`, the shape the importer and benchmark modules use.
 */
function globalAliases(tokens) {
  const out = new Set(GLOBAL_OBJECTS);
  const v = (k) => tokens[k] && tokens[k].value;
  if (v(0) === "(" && v(1) === "function" && v(2) === "(" && tokens[3] && tokens[3].type === "ident" && v(4) === ")") {
    out.add(tokens[3].value);
  }
  return out;
}

/**
 * Project globals (zeh* / ZEH* / MK*) that `rel` reads as free identifiers.
 * `window.X` / `self.X` / `globalThis.X` (and `global.X` inside a `(function (global) {…})(…)`
 * wrapper) count as reads of X; assigning one (window.X = …) counts as declaring X. Skipped: other property names (a.zehX, { zehX: … }), names the file
 * declares itself anywhere, and names used under `typeof` (feature checks that tolerate a
 * missing global).
 * @returns {Map<string, number>} name → line of first use
 */
function referencedProjectGlobals(rel) {
  const source = readSource(rel);
  const tokens = tokenize(source);
  const aliases = globalAliases(tokens);
  const declared = new Set();
  tokens.forEach((t, k) => {
    if (t.type === "ident" && DECLARING.has(t.value) && tokens[k + 1] && tokens[k + 1].type === "ident") {
      declared.add(tokens[k + 1].value);
    }
  });
  // window.MKLookup = … / self.ZEHBookStore = … publish a global: count it as declared here.
  const viaGlobalObject = (k) =>
    k >= 2 &&
    tokens[k - 1].type === "punct" &&
    (tokens[k - 1].value === "." || tokens[k - 1].value === "?.") &&
    tokens[k - 2].type === "ident" &&
    aliases.has(tokens[k - 2].value) &&
    !(tokens[k - 3] && tokens[k - 3].type === "punct" && (tokens[k - 3].value === "." || tokens[k - 3].value === "?."));
  tokens.forEach((t, k) => {
    const next = tokens[k + 1];
    const after = tokens[k + 2];
    const isAssignment = next && next.type === "punct" && next.value === "=" && !(after && after.type === "punct" && (after.value === "=" || after.value === ">"));
    if (t.type === "ident" && viaGlobalObject(k) && isAssignment) declared.add(t.value);
  });
  const used = new Map();
  tokens.forEach((t, k) => {
    if (t.type !== "ident" || !PROJECT_GLOBAL.test(t.value) || declared.has(t.value)) return;
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    if (prev && prev.type === "punct" && (prev.value === "." || prev.value === "?.") && !viaGlobalObject(k)) return;
    if (prev && prev.type === "ident" && prev.value === "typeof") return;
    if (next && next.type === "punct" && next.value === ":" && prev && prev.type === "punct" && (prev.value === "{" || prev.value === ",")) {
      return; // object literal key
    }
    if (!used.has(t.value)) used.set(t.value, source.slice(0, t.index).split("\n").length);
  });
  return used;
}

/**
 * Globals a first-party file creates: top-level const / let / var / function / class names
 * (brace depth 0) plus window.X / self.X / globalThis.X (or wrapper-parameter `global.X`)
 * assignments at any depth (the IIFE modules publish their API that way). Destructuring declarations are not expanded.
 * @returns {Set<string>}
 */
function declaredGlobals(rel, source) {
  const tokens = tokenize(source === undefined ? readSource(rel) : source);
  const aliases = globalAliases(tokens);
  const out = new Set();
  let depth = 0;
  tokens.forEach((t, k) => {
    if (t.type === "punct" && t.value === "{") depth += 1;
    else if (t.type === "punct" && t.value === "}") depth -= 1;
    const next = tokens[k + 1];
    if (depth === 0 && t.type === "ident" && DECLARING.has(t.value) && next && next.type === "ident") {
      out.add(next.value);
    }
    if (
      t.type === "ident" &&
      aliases.has(t.value) &&
      !(tokens[k - 1] && tokens[k - 1].type === "punct" && (tokens[k - 1].value === "." || tokens[k - 1].value === "?.")) &&
      next && next.type === "punct" && next.value === "." &&
      tokens[k + 2] && tokens[k + 2].type === "ident" &&
      tokens[k + 3] && tokens[k + 3].type === "punct" && tokens[k + 3].value === "=" &&
      !(tokens[k + 4] && tokens[k + 4].type === "punct" && (tokens[k + 4].value === "=" || tokens[k + 4].value === ">"))
    ) {
      out.add(tokens[k + 2].value);
    }
  });
  return out;
}

/** First-party files: everything outside lib/ (vendored third-party bundles). */
function isFirstParty(rel) {
  return !rel.startsWith("lib/");
}

module.exports = {
  readSource,
  withEarlyThrow,
  checkGlobalDeclarations,
  tokenize,
  referencedProjectGlobals,
  declaredGlobals,
  isFirstParty,
};
