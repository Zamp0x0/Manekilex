/**
 * A small HTML/XML parser and DOM subset for the importer tests (Phase 5).
 *
 * It implements just what importers/shared/html-sanitize.js and chapter-split.js use:
 * DOMParser (text/html with the usual void / auto-close rules, application/xhtml+xml strict),
 * nodeType / localName / childNodes / attributes / textContent, remove / insertBefore,
 * querySelector(All) for tag lists, [attr='v'], .class and #id, plus getElementsByTagName.
 * No dependency on jsdom so the suite stays offline and installs nothing.
 */
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style"]);
const BLOCK_CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure",
  "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "main", "nav", "ol", "p", "pre",
  "section", "table", "ul",
]);
const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®",
  mdash: "—", ndash: "–", hellip: "…", ldquo: "“", rdquo: "”", lsquo: "‘",
  rsquo: "’", ensp: " ", emsp: " ", middot: "·", times: "×", eacute: "é",
};
const XML_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text, strict) {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);?/g, (m, body) => {
    const terminated = m.endsWith(";");
    if (strict && !terminated) throw new Error(`bad entity ${m}`);
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) {
        if (strict) throw new Error(`bad entity ${m}`);
        return m;
      }
      return String.fromCodePoint(code);
    }
    const table = strict ? XML_ENTITIES : ENTITIES;
    if (body in table) return table[body];
    if (strict) throw new Error(`undefined entity ${m}`);
    return m;
  });
}

class MiniNode {
  constructor(nodeType, ownerDocument) {
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument || null;
    this.parentNode = null;
    this.childNodes = [];
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get firstChild() {
    return this.childNodes[0] || null;
  }
  get lastChild() {
    return this.childNodes[this.childNodes.length - 1] || null;
  }
  get nextSibling() {
    if (!this.parentNode) return null;
    const list = this.parentNode.childNodes;
    return list[list.indexOf(this) + 1] || null;
  }
  get previousSibling() {
    if (!this.parentNode) return null;
    const list = this.parentNode.childNodes;
    return list[list.indexOf(this) - 1] || null;
  }
  get textContent() {
    if (this.nodeType === 3 || this.nodeType === 4) return this.data;
    if (this.nodeType === 8) return this.data;
    return this.childNodes.map((c) => (c.nodeType === 8 ? "" : c.textContent)).join("");
  }
  set textContent(value) {
    this.childNodes.forEach((c) => (c.parentNode = null));
    this.childNodes = [];
    if (value != null && value !== "") this.appendChild(new MiniText(String(value), this.ownerDocument));
  }
  appendChild(node) {
    return this.insertBefore(node, null);
  }
  insertBefore(node, ref) {
    if (node.parentNode) node.parentNode.removeChild(node);
    const idx = ref ? this.childNodes.indexOf(ref) : -1;
    if (ref && idx === -1) throw new Error("insertBefore: reference node not found");
    if (idx === -1) this.childNodes.push(node);
    else this.childNodes.splice(idx, 0, node);
    node.parentNode = this;
    return node;
  }
  removeChild(node) {
    const idx = this.childNodes.indexOf(node);
    if (idx === -1) throw new Error("removeChild: not a child");
    this.childNodes.splice(idx, 1);
    node.parentNode = null;
    return node;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
}

class MiniText extends MiniNode {
  constructor(data, ownerDocument) {
    super(3, ownerDocument);
    this.data = data;
    this.nodeName = "#text";
  }
}

class MiniComment extends MiniNode {
  constructor(data, ownerDocument) {
    super(8, ownerDocument);
    this.data = data;
    this.nodeName = "#comment";
  }
}

function parseSelector(selector) {
  return String(selector)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((part) => {
      const m = part.match(/^([a-zA-Z][\w-]*|\*)?((?:[.#][\w-]+)*)((?:\[[^\]]+\])*)$/);
      if (!m) throw new Error(`mini-dom: unsupported selector "${part}"`);
      const tag = m[1] && m[1] !== "*" ? m[1].toLowerCase() : "";
      const classes = [];
      let id = "";
      (m[2] || "").replace(/([.#])([\w-]+)/g, (_, kind, name) => {
        if (kind === ".") classes.push(name);
        else id = name;
        return "";
      });
      const attrs = [];
      (m[3] || "").replace(/\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]/g, (_, name, a, b, c) => {
        attrs.push({ name: name.toLowerCase(), value: a !== undefined ? a : b !== undefined ? b : c });
        return "";
      });
      return { tag, classes, id, attrs };
    });
}

class MiniElement extends MiniNode {
  constructor(name, ownerDocument) {
    super(1, ownerDocument);
    this.localName = name;
    this.tagName = name.toUpperCase();
    this.nodeName = this.tagName;
    this._attrs = [];
  }
  get attributes() {
    return this._attrs.map((a) => ({ name: a.name, value: a.value }));
  }
  getAttribute(name) {
    const a = this._attrs.find((x) => x.name === String(name).toLowerCase());
    return a ? a.value : null;
  }
  hasAttribute(name) {
    return this.getAttribute(name) !== null;
  }
  setAttribute(name, value) {
    const key = String(name).toLowerCase();
    const a = this._attrs.find((x) => x.name === key);
    if (a) a.value = String(value);
    else this._attrs.push({ name: key, value: String(value) });
  }
  removeAttribute(name) {
    const key = String(name).toLowerCase();
    this._attrs = this._attrs.filter((x) => x.name !== key);
  }
  get id() {
    return this.getAttribute("id") || "";
  }
  get className() {
    return this.getAttribute("class") || "";
  }
  get children() {
    return this.childNodes.filter((c) => c.nodeType === 1);
  }
  get firstElementChild() {
    return this.children[0] || null;
  }
  matches(selector) {
    return parseSelector(selector).some((sel) => matchesSimple(this, sel));
  }
  querySelectorAll(selector) {
    const sels = parseSelector(selector);
    const out = [];
    walk(this, (el) => {
      if (el !== this && sels.some((sel) => matchesSimple(el, sel))) out.push(el);
    });
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  getElementsByTagName(name) {
    return this.querySelectorAll(name === "*" ? "*" : String(name).toLowerCase());
  }
  get innerHTML() {
    return this.childNodes.map(serializeHtml).join("");
  }
  get outerHTML() {
    return serializeHtml(this);
  }
}

function matchesSimple(el, sel) {
  if (sel.tag && el.localName !== sel.tag) return false;
  if (sel.id && el.id !== sel.id) return false;
  if (sel.classes.length) {
    const have = el.className.split(/\s+/).filter(Boolean);
    if (!sel.classes.every((c) => have.includes(c))) return false;
  }
  for (const a of sel.attrs) {
    const v = el.getAttribute(a.name);
    if (v === null) return false;
    if (a.value !== undefined && v !== a.value) return false;
  }
  return true;
}

function walk(node, fn) {
  if (node.nodeType === 1) fn(node);
  for (const child of node.childNodes.slice()) walk(child, fn);
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function serializeHtml(node) {
  if (node.nodeType === 3) return escapeHtml(node.data);
  if (node.nodeType === 8) return `<!--${node.data}-->`;
  if (node.nodeType !== 1) return node.childNodes.map(serializeHtml).join("");
  const attrs = node._attrs.map((a) => ` ${a.name}="${a.value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`).join("");
  if (VOID.has(node.localName)) return `<${node.localName}${attrs}>`;
  return `<${node.localName}${attrs}>${node.childNodes.map(serializeHtml).join("")}</${node.localName}>`;
}

class MiniDocument extends MiniNode {
  constructor() {
    super(9, null);
    this.nodeName = "#document";
    this.ownerDocument = this;
    this.documentElement = null;
    this.head = null;
    this.body = null;
  }
  createElement(name) {
    return new MiniElement(String(name).toLowerCase(), this);
  }
  createTextNode(text) {
    return new MiniText(String(text), this);
  }
  createComment(text) {
    return new MiniComment(String(text), this);
  }
  querySelectorAll(selector) {
    return this.documentElement ? this.documentElement.querySelectorAll(selector).concat(
      this.documentElement.matches(selector) ? [this.documentElement] : []
    ) : [];
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
  getElementsByTagName(name) {
    return this.querySelectorAll(name === "*" ? "*" : String(name).toLowerCase());
  }
}

// ── tokenizer / tree builder ───────────────────────────────────────────────────

const ATTR_RE = /\s*([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+)))?/y;

function parseStartTag(src, pos, strict) {
  // src[pos] === "<", src[pos+1] is a name start
  const nameMatch = src.slice(pos + 1).match(strict ? /^[A-Za-z_:][\w.:-]*/ : /^[A-Za-z][^\s/>]*/);
  if (!nameMatch) return null;
  const name = strict ? nameMatch[0] : nameMatch[0].toLowerCase();
  let i = pos + 1 + name.length;
  const attrs = [];
  const seen = new Set();
  for (;;) {
    const ws = src.slice(i).match(/^\s*/)[0].length;
    i += ws;
    if (i >= src.length) {
      if (strict) throw new Error(`unterminated start tag <${name}>`);
      return { name, attrs, selfClosing: false, end: src.length };
    }
    if (src[i] === ">") return { name, attrs, selfClosing: false, end: i + 1 };
    if (src.startsWith("/>", i)) return { name, attrs, selfClosing: true, end: i + 2 };
    if (strict && !ws) throw new Error(`missing whitespace in <${name}>`);
    ATTR_RE.lastIndex = i;
    const am = ATTR_RE.exec(src);
    if (!am || am.index !== i) {
      if (strict) throw new Error(`bad attribute in <${name}>`);
      i += 1;
      continue;
    }
    const aname = strict ? am[1] : am[1].toLowerCase();
    if (strict && (am[2] === undefined && am[3] === undefined)) throw new Error(`attribute ${aname} must be quoted`);
    if (strict && seen.has(aname)) throw new Error(`duplicate attribute ${aname}`);
    seen.add(aname);
    const raw = am[2] !== undefined ? am[2] : am[3] !== undefined ? am[3] : am[4] !== undefined ? am[4] : "";
    attrs.push({ name: aname, value: decodeEntities(raw, strict) });
    i = ATTR_RE.lastIndex;
  }
}

function parseHtml(src, strict) {
  const doc = new MiniDocument();
  const html = doc.createElement("html");
  const head = doc.createElement("head");
  const body = doc.createElement("body");
  doc.appendChild(html);
  if (!strict) {
    html.appendChild(head);
    html.appendChild(body);
    doc.documentElement = html;
    doc.head = head;
    doc.body = body;
  }
  // In strict (XML) mode the root comes from the source itself.
  const stack = [];
  let current = strict ? null : body;
  let rootCount = 0;

  function appendText(text) {
    if (!text) return;
    if (strict && !current) {
      if (text.trim()) throw new Error("text outside root element");
      return;
    }
    const target = current || body;
    const last = target.lastChild;
    const decoded = decodeEntities(text, strict);
    if (last && last.nodeType === 3) last.data += decoded;
    else target.appendChild(doc.createTextNode(decoded));
  }

  function openElement(name, attrs) {
    const el = doc.createElement(name);
    if (strict) el.localName = name; // keep case in XML mode
    attrs.forEach((a) => el._attrs.push({ name: a.name, value: a.value }));
    if (strict && !current) {
      if (rootCount) throw new Error("second root element");
      rootCount++;
      doc.appendChild(el);
      doc.documentElement = el;
      if (name === "html") {
        doc.body = null;
      }
    } else {
      (current || body).appendChild(el);
    }
    if (strict && name === "body") doc.body = el;
    if (strict && name === "head") doc.head = el;
    return el;
  }

  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      appendText(src.slice(i));
      break;
    }
    appendText(src.slice(i, lt));
    i = lt;
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i + 4);
      const content = end === -1 ? src.slice(i + 4) : src.slice(i + 4, end);
      if (strict && content.includes("--")) throw new Error("'--' in comment");
      if (current) current.appendChild(doc.createComment(content));
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (src.startsWith("<![CDATA[", i)) {
      const end = src.indexOf("]]>", i + 9);
      if (end === -1) throw new Error("unterminated CDATA");
      const target = current || body;
      target.appendChild(doc.createTextNode(src.slice(i + 9, end)));
      i = end + 3;
      continue;
    }
    if (src.startsWith("<?", i)) {
      const end = src.indexOf("?>", i + 2);
      if (end === -1) {
        if (strict) throw new Error("unterminated processing instruction");
        i = n;
        continue;
      }
      i = end + 2;
      continue;
    }
    if (src.startsWith("<!", i)) {
      const end = src.indexOf(">", i);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (src.startsWith("</", i)) {
      const end = src.indexOf(">", i);
      const rawName = end === -1 ? src.slice(i + 2) : src.slice(i + 2, end);
      const name = strict ? rawName.trim() : rawName.trim().toLowerCase();
      i = end === -1 ? n : end + 1;
      if (!strict && (name === "html" || name === "body")) {
        current = body;
        continue;
      }
      if (!strict && name === "head") {
        current = body;
        continue;
      }
      if (strict) {
        const open = stack.pop();
        if (!open || open.localName !== name) throw new Error(`mismatched end tag </${name}>`);
        current = stack[stack.length - 1] || null;
        continue;
      }
      const idx = stack.map((e) => e.localName).lastIndexOf(name);
      if (idx === -1) continue; // stray end tag
      stack.length = idx;
      current = stack[stack.length - 1] || body;
      continue;
    }
    const tag = parseStartTag(src, i, strict);
    if (!tag) {
      if (strict) throw new Error(`bad tag near offset ${i}`);
      appendText("<");
      i += 1;
      continue;
    }
    i = tag.end;
    const name = tag.name;
    if (!strict) {
      if (name === "html") continue;
      if (name === "head") {
        current = head;
        stack.length = 0;
        continue;
      }
      if (name === "body") {
        current = body;
        stack.length = 0;
        tag.attrs.forEach((a) => body.setAttribute(a.name, a.value));
        continue;
      }
      // auto-close rules
      const top = () => stack[stack.length - 1];
      if (BLOCK_CLOSES_P.has(name)) {
        const pIdx = stack.map((e) => e.localName).lastIndexOf("p");
        if (pIdx !== -1 && !stack.slice(pIdx + 1).some((e) => BLOCK_CLOSES_P.has(e.localName) && e.localName !== "p")) {
          stack.length = pIdx;
          current = stack[stack.length - 1] || (current === head ? head : body);
        }
      }
      if (name === "li" && top() && top().localName === "li") {
        stack.pop();
        current = stack[stack.length - 1] || body;
      }
      if ((name === "dt" || name === "dd") && top() && (top().localName === "dt" || top().localName === "dd")) {
        stack.pop();
        current = stack[stack.length - 1] || body;
      }
      if ((name === "td" || name === "th") && top() && (top().localName === "td" || top().localName === "th")) {
        stack.pop();
        current = stack[stack.length - 1] || body;
      }
      if (name === "tr") {
        while (top() && ["td", "th", "tr"].includes(top().localName)) stack.pop();
        current = stack[stack.length - 1] || body;
      }
    }
    const el = openElement(name, tag.attrs);
    if (strict) {
      if (!tag.selfClosing) {
        stack.push(el);
        current = el;
      } else {
        current = stack[stack.length - 1] || null;
      }
      continue;
    }
    if (VOID.has(name)) continue;
    if (RAW_TEXT.has(name)) {
      const close = src.toLowerCase().indexOf(`</${name}`, i);
      const rawContent = close === -1 ? src.slice(i) : src.slice(i, close);
      if (rawContent) el.appendChild(doc.createTextNode(rawContent));
      if (close === -1) {
        i = n;
      } else {
        const gt = src.indexOf(">", close);
        i = gt === -1 ? n : gt + 1;
      }
      continue;
    }
    stack.push(el);
    current = el;
  }
  if (strict) {
    if (stack.length) throw new Error(`unclosed element <${stack[stack.length - 1].localName}>`);
    if (!rootCount) throw new Error("no root element");
  }
  return doc;
}

class DOMParser {
  parseFromString(src, type) {
    const text = String(src || "");
    if (type === "text/html") return parseHtml(text, false);
    try {
      return parseHtml(text.replace(/^\uFEFF/, ""), true);
    } catch (err) {
      const doc = new MiniDocument();
      const root = doc.createElement("parsererror");
      root.appendChild(doc.createTextNode(err.message));
      doc.appendChild(root);
      doc.documentElement = root;
      return doc;
    }
  }
}

/** Globals to install into a vm context so the importer modules run as in a browser. */
function domGlobals() {
  const document = new DOMParser().parseFromString("<!doctype html><html><head></head><body></body></html>", "text/html");
  return { DOMParser, document, Node: MiniNode, Element: MiniElement };
}

module.exports = { DOMParser, MiniDocument, MiniElement, MiniText, MiniNode, domGlobals, decodeEntities };
