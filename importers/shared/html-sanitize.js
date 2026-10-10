/**
 * HTML 清洗与 XHTML 安全输出（Phase 5 重写）
 *
 * 之前用 body.innerHTML 把清洗后的 DOM 序列化成 HTML 再塞进 .xhtml，<br>、<img> 等空元素不自闭合、
 * 实体写法不合 XML，epub.js 以 XML 解析章节时可能整章失败。现在：
 *   1. DOMParser 解析（text/html，容错）→ 清洗（移除脚本/样式/表单等，属性白名单）
 *   2. 自己按 XML 规则遍历 DOM 序列化：文本/属性转义、空元素 <br/>、标签小写、非法控制字符剔除
 *   3. 生成 EPUB 前再用 isWellFormedXml 校验（浏览器里还会用 DOMParser application/xhtml+xml 复核）
 */
(function (global) {
  const BLOCK_TAGS = new Set([
    "p",
    "div",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "blockquote",
    "ul",
    "ol",
    "li",
    "pre",
    "hr",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "br",
    "img",
    "strong",
    "em",
    "b",
    "i",
    "code",
    "span",
    "a",
    "sub",
    "sup",
  ]);

  /** 允许保留的元素；其余元素只保留子节点（unwrap） */
  const ALLOWED_TAGS = new Set([
    ...BLOCK_TAGS,
    "section",
    "article",
    "main",
    "header",
    "footer",
    "aside",
    "nav",
    "figure",
    "figcaption",
    "caption",
    "tfoot",
    "col",
    "colgroup",
    "dl",
    "dt",
    "dd",
    "small",
    "u",
    "s",
    "del",
    "ins",
    "mark",
    "cite",
    "q",
    "abbr",
    "time",
    "kbd",
    "var",
    "samp",
    "dfn",
    "address",
    "details",
    "summary",
    "center",
    "tt",
    "big",
    "wbr",
  ]);

  /** 连同子节点一起删除的元素 */
  const DROP_TAGS = new Set([
    "script",
    "style",
    "iframe",
    "object",
    "embed",
    "form",
    "noscript",
    "link",
    "meta",
    "title",
    "head",
    "template",
    "input",
    "button",
    "select",
    "textarea",
    "option",
    "video",
    "audio",
    "canvas",
    "svg",
    "math",
    "base",
    "applet",
    "frame",
    "frameset",
    "slot",
  ]);

  const VOID_TAGS = new Set(["br", "hr", "img", "col", "wbr"]);

  const GLOBAL_ATTRS = new Set(["id", "class", "title", "lang", "dir"]);
  const TAG_ATTRS = {
    a: ["href", "target", "rel"],
    img: ["src", "alt", "width", "height"],
    td: ["colspan", "rowspan", "scope", "align", "valign"],
    th: ["colspan", "rowspan", "scope", "align", "valign"],
    ol: ["start", "type", "reversed"],
    li: ["value"],
    table: ["border", "cellpadding", "cellspacing", "width", "summary"],
    col: ["span", "width"],
    colgroup: ["span", "width"],
    q: ["cite"],
    blockquote: ["cite"],
    time: ["datetime"],
    details: ["open"],
    abbr: [],
  };

  /** XML 1.0 不允许的字符（控制字符、FFFE/FFFF、孤立代理对） */
  const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

  const INVALID_XML_CHARS_TEST = new RegExp(INVALID_XML_CHARS.source);

  function stripInvalidXmlChars(text) {
    return String(text || "").replace(INVALID_XML_CHARS, (m) => {
      // 第三个分支会吞掉前一个正常字符，补回来
      if (m.length === 2 && !/[\uD800-\uDBFF]/.test(m[0])) return m[0];
      return "";
    });
  }

  function escapeXml(text) {
    return stripInvalidXmlChars(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeXmlText(text) {
    return stripInvalidXmlChars(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function escapeXmlAttr(text) {
    return escapeXml(text).replace(/[\r\n\t]+/g, " ");
  }

  function isSafeUrl(name, value) {
    const v = String(value || "").trim().replace(/[\u0000- ]/g, "").toLowerCase();
    if (!v) return true;
    if (/^(javascript|vbscript|file):/.test(v)) return false;
    if (v.startsWith("data:")) {
      return name === "src" && /^data:image\/(png|jpe?g|gif|webp|svg\+xml|bmp);/.test(v);
    }
    return true;
  }

  function attrAllowed(tag, name, value) {
    if (name.startsWith("on") || name.startsWith("xmlns") || name === "style") return false;
    if (name.includes(":")) return false;
    if (!GLOBAL_ATTRS.has(name) && !(TAG_ATTRS[tag] || []).includes(name)) return false;
    if (name === "href" || name === "src") return isSafeUrl(name, value);
    return true;
  }

  function attributeEntries(el) {
    const out = [];
    const attrs = el.attributes;
    if (!attrs) return out;
    for (let i = 0; i < attrs.length; i++) {
      const a = attrs[i];
      if (!a || !a.name) continue;
      out.push([String(a.name).toLowerCase(), a.value == null ? "" : String(a.value)]);
    }
    return out;
  }

  function elementTag(el) {
    return String(el.localName || el.tagName || "").toLowerCase();
  }

  /**
   * 把 DOM 节点序列化为合法 XHTML 片段：
   * 只输出白名单元素与属性，空元素自闭合，文本/属性按 XML 转义。
   */
  function serializeXhtml(node, out) {
    const parts = out || [];
    if (!node) return parts;
    const type = node.nodeType;
    if (type === 3 || type === 4) {
      parts.push(escapeXmlText(node.data != null ? node.data : node.textContent || ""));
      return parts;
    }
    if (type === 9 || type === 11) {
      const kids = node.childNodes || [];
      for (let i = 0; i < kids.length; i++) serializeXhtml(kids[i], parts);
      return parts;
    }
    if (type !== 1) return parts;

    const tag = elementTag(node);
    if (DROP_TAGS.has(tag)) return parts;
    const kids = node.childNodes || [];
    if (!ALLOWED_TAGS.has(tag)) {
      for (let i = 0; i < kids.length; i++) serializeXhtml(kids[i], parts);
      return parts;
    }

    const seen = new Set();
    let open = `<${tag}`;
    for (const [name, value] of attributeEntries(node)) {
      if (seen.has(name) || !attrAllowed(tag, name, value)) continue;
      seen.add(name);
      open += ` ${name}="${escapeXmlAttr(value)}"`;
    }
    if (VOID_TAGS.has(tag)) {
      parts.push(`${open}/>`);
      return parts;
    }
    parts.push(`${open}>`);
    for (let i = 0; i < kids.length; i++) serializeXhtml(kids[i], parts);
    parts.push(`</${tag}>`);
    return parts;
  }

  function serializeChildrenXhtml(node) {
    const parts = [];
    const kids = (node && node.childNodes) || [];
    for (let i = 0; i < kids.length; i++) serializeXhtml(kids[i], parts);
    return parts.join("");
  }

  function parseHtmlDocument(html) {
    return new DOMParser().parseFromString(String(html || ""), "text/html");
  }

  /** 解析 HTML 并返回清洗后的 body 元素（危险元素已删除；属性在序列化时再过滤） */
  function sanitizeHtmlToBody(html) {
    const doc = parseHtmlDocument(html);
    const body = doc.body || doc.documentElement;
    if (!body) return null;
    const selector = [...DROP_TAGS].join(", ");
    body.querySelectorAll(selector).forEach((n) => n.remove());
    return body;
  }

  /**
   * 清洗 HTML 字符串，返回合法 XHTML 片段（body 内容）
   */
  function sanitizeHtmlString(html) {
    const body = sanitizeHtmlToBody(html);
    if (!body) return escapeXmlText(html);
    return serializeChildrenXhtml(body).trim();
  }

  function extractBodyHtml(html) {
    const trimmed = String(html || "").trim();
    return sanitizeHtmlString(trimmed);
  }

  function wrapChapterXhtml(title, bodyInnerHtml, cssHref) {
    const safeTitle = escapeXml(title || "Chapter");
    const cssLink = cssHref || "../styles/book.css";
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!DOCTYPE html>\n` +
      `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">\n` +
      `<head>\n` +
      `<meta charset="UTF-8"/>\n` +
      `<title>${safeTitle}</title>\n` +
      `<link rel="stylesheet" type="text/css" href="${cssLink}"/>\n` +
      `</head>\n` +
      `<body>\n` +
      bodyInnerHtml +
      `\n</body>\n</html>`
    );
  }

  function filenameToTitle(filename) {
    return String(filename || "Untitled")
      .replace(/\.[^.]+$/, "")
      .replace(/[_-]+/g, " ")
      .trim() || "Untitled";
  }

  // ── XML 良构性校验（不依赖 DOM，Node 测试与浏览器共用）────────────────────────

  const XML_NAME_RE = /^[A-Za-z_:][\w.:-]*/;
  const ENTITY_RE = /&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g;

  function textProblem(text) {
    const leftovers = text.replace(ENTITY_RE, "");
    if (leftovers.includes("&")) return "unescaped & (bad entity)";
    if (leftovers.includes("<")) return "unescaped <";
    if (INVALID_XML_CHARS_TEST.test(text)) return "invalid control character";
    return "";
  }

  /**
   * 返回第一个良构性错误的描述；"" 表示通过。
   * 检查：标签配对、属性引号与重复、实体、根元素唯一、注释/PI/DOCTYPE 结构、非法字符。
   */
  function xmlWellFormedError(xml) {
    const s = String(xml || "").replace(/^\uFEFF/, "");
    const stack = [];
    let roots = 0;
    let i = 0;
    const n = s.length;
    while (i < n) {
      const lt = s.indexOf("<", i);
      const text = lt === -1 ? s.slice(i) : s.slice(i, lt);
      if (text) {
        const p = textProblem(text);
        if (p) return `${p} near offset ${i}`;
        if (!stack.length && text.trim()) return `text outside root element near offset ${i}`;
      }
      if (lt === -1) break;
      i = lt;
      if (s.startsWith("<?", i)) {
        const end = s.indexOf("?>", i + 2);
        if (end === -1) return "unterminated processing instruction";
        i = end + 2;
        continue;
      }
      if (s.startsWith("<!--", i)) {
        const end = s.indexOf("-->", i + 4);
        if (end === -1) return "unterminated comment";
        if (s.slice(i + 4, end).includes("--")) return "'--' inside comment";
        i = end + 3;
        continue;
      }
      if (s.startsWith("<![CDATA[", i)) {
        if (!stack.length) return "CDATA outside root";
        const end = s.indexOf("]]>", i + 9);
        if (end === -1) return "unterminated CDATA";
        i = end + 3;
        continue;
      }
      if (s.startsWith("<!DOCTYPE", i) || s.startsWith("<!doctype", i)) {
        if (stack.length || roots) return "DOCTYPE after root element";
        const end = s.indexOf(">", i);
        if (end === -1) return "unterminated DOCTYPE";
        i = end + 1;
        continue;
      }
      if (s.startsWith("</", i)) {
        const end = s.indexOf(">", i);
        if (end === -1) return "unterminated end tag";
        const name = s.slice(i + 2, end).trim();
        if (!XML_NAME_RE.test(name) || name.match(XML_NAME_RE)[0] !== name) return `bad end tag </${name}>`;
        const open = stack.pop();
        if (open !== name) return `mismatched end tag </${name}> (expected </${open || "none"}>)`;
        i = end + 1;
        continue;
      }
      // start tag
      const m = s.slice(i + 1).match(XML_NAME_RE);
      if (!m) return `bad start tag near offset ${i}`;
      const name = m[0];
      let j = i + 1 + name.length;
      const seen = new Set();
      for (;;) {
        const ws = s.slice(j).match(/^\s*/)[0].length;
        j += ws;
        if (j >= n) return `unterminated start tag <${name}>`;
        if (s[j] === ">" || s.startsWith("/>", j)) break;
        if (!ws) return `missing whitespace before attribute in <${name}>`;
        const am = s.slice(j).match(XML_NAME_RE);
        if (!am) return `bad attribute name in <${name}>`;
        const aname = am[0];
        if (seen.has(aname)) return `duplicate attribute ${aname} in <${name}>`;
        seen.add(aname);
        j += aname.length;
        j += s.slice(j).match(/^\s*/)[0].length;
        if (s[j] !== "=") return `attribute ${aname} without value in <${name}>`;
        j += 1;
        j += s.slice(j).match(/^\s*/)[0].length;
        const quote = s[j];
        if (quote !== '"' && quote !== "'") return `unquoted attribute ${aname} in <${name}>`;
        const close = s.indexOf(quote, j + 1);
        if (close === -1) return `unterminated attribute ${aname} in <${name}>`;
        const value = s.slice(j + 1, close);
        const p = textProblem(value);
        if (p) return `${p} in attribute ${aname} of <${name}>`;
        j = close + 1;
      }
      if (!stack.length) {
        if (roots) return `second root element <${name}>`;
        roots++;
      }
      if (s.startsWith("/>", j)) {
        i = j + 2;
      } else {
        stack.push(name);
        i = j + 1;
      }
    }
    if (stack.length) return `unclosed element <${stack[stack.length - 1]}>`;
    if (!roots) return "no root element";
    return "";
  }

  function isWellFormedXml(xml) {
    return xmlWellFormedError(xml) === "";
  }

  /**
   * 章节 XHTML 校验：先走纯文本检查，再（有 DOMParser 时）用 XML 解析器复核 parsererror。
   * 返回错误描述；"" 表示通过。
   */
  function validateChapterXhtml(xhtml) {
    const err = xmlWellFormedError(xhtml);
    if (err) return err;
    if (typeof DOMParser === "function") {
      try {
        const doc = new DOMParser().parseFromString(xhtml, "application/xhtml+xml");
        const pe = doc && doc.getElementsByTagName ? doc.getElementsByTagName("parsererror") : [];
        if (pe && pe.length) return (pe[0].textContent || "XML parse error").trim().slice(0, 200);
      } catch (e) {
        return e && e.message ? e.message : "XML parse error";
      }
    }
    return "";
  }

  global.ZEHHtmlSanitize = {
    escapeXml,
    escapeXmlText,
    escapeXmlAttr,
    stripInvalidXmlChars,
    sanitizeHtmlToBody,
    sanitizeHtmlString,
    serializeXhtml,
    serializeChildrenXhtml,
    extractBodyHtml,
    wrapChapterXhtml,
    filenameToTitle,
    xmlWellFormedError,
    isWellFormedXml,
    validateChapterXhtml,
    BLOCK_TAGS,
    ALLOWED_TAGS,
    VOID_TAGS,
    DROP_TAGS,
  };
})(typeof window !== "undefined" ? window : globalThis);
