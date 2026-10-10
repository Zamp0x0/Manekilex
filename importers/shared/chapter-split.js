/**
 * 按标题或字数拆分章节（Phase 5：在 DOM 上拆分，而不是在 HTML 字符串上切片）
 *
 * 字符串切片会把嵌套 <div> 里的标题切成不配对的片段，而且第一个标题之前的内容会丢。
 * 现在先把包着标题的容器（div/section/…）展开，让 h1–h3 成为 body 的直接子节点，
 * 再按直接子节点切分：每段都是完整节点，序列化后天然配对；首个标题前的内容单独成章。
 */
(function (global) {
  const { extractBodyHtml, wrapChapterXhtml, escapeXml, sanitizeHtmlToBody, serializeXhtml } =
    global.ZEHHtmlSanitize;

  const DEFAULT_WORDS_PER_CHAPTER = 6000;
  const HEADING_TAGS = ["h1", "h2", "h3"];
  /** 包着标题时会被展开的容器 */
  const WRAPPER_TAGS = new Set([
    "div",
    "section",
    "article",
    "main",
    "header",
    "footer",
    "aside",
    "nav",
    "center",
    "span",
    "font",
    "details",
  ]);

  function tagOf(node) {
    return node && node.nodeType === 1 ? String(node.localName || node.tagName || "").toLowerCase() : "";
  }

  function stripTags(html) {
    const body = sanitizeHtmlToBody(`<div>${String(html || "")}</div>`);
    return body ? String(body.textContent || "").trim() : "";
  }

  function countWords(text) {
    return String(text || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean).length;
  }

  function serializeNodes(nodes) {
    const parts = [];
    nodes.forEach((n) => serializeXhtml(n, parts));
    return parts.join("").trim();
  }

  function hasVisibleContent(nodes) {
    return nodes.some((n) => {
      if (n.nodeType === 3) return Boolean(String(n.data || n.textContent || "").trim());
      if (n.nodeType !== 1) return false;
      if (String(n.textContent || "").trim()) return true;
      const tag = tagOf(n);
      if (tag === "img" || tag === "hr" || tag === "table") return true;
      return typeof n.querySelector === "function" && Boolean(n.querySelector("img, table"));
    });
  }

  function containsHeading(el) {
    if (!el || el.nodeType !== 1 || typeof el.querySelector !== "function") return false;
    return Boolean(el.querySelector(HEADING_TAGS.join(", ")));
  }

  /**
   * 把包含标题的容器展开为它的子节点，重复直到 body 的直接子节点里再没有这种容器。
   * 只动包着标题的容器，其余结构原样保留。
   */
  function hoistHeadings(body) {
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 50) {
      changed = false;
      const kids = Array.from(body.childNodes || []);
      for (const kid of kids) {
        const tag = tagOf(kid);
        if (!tag || !WRAPPER_TAGS.has(tag) || HEADING_TAGS.includes(tag)) continue;
        if (!containsHeading(kid)) continue;
        const inner = Array.from(kid.childNodes || []);
        inner.forEach((n) => body.insertBefore(n, kid));
        kid.remove();
        changed = true;
      }
    }
  }

  function headingLevel(node) {
    const tag = tagOf(node);
    const idx = HEADING_TAGS.indexOf(tag);
    return idx === -1 ? 0 : idx + 1;
  }

  function splitByWordCount(html, wordsPerChapter, titlePrefix) {
    const plain = stripTags(html);
    const words = plain.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return [{ title: titlePrefix || "Part 1", html: `<p>${escapeXml("")}</p>` }];
    }
    const chapters = [];
    const size = Math.max(500, wordsPerChapter || DEFAULT_WORDS_PER_CHAPTER);
    for (let i = 0; i < words.length; i += size) {
      const chunk = words.slice(i, i + size).join(" ");
      const idx = Math.floor(i / size) + 1;
      chapters.push({
        title: `${titlePrefix || "Part"} ${idx}`,
        html: `<h1>${escapeXml(`${titlePrefix || "Part"} ${idx}`)}</h1><p>${escapeXml(chunk)}</p>`,
      });
    }
    return chapters;
  }

  /**
   * 按标题拆分（DOM 级）。返回 null 表示没有可用标题。
   * @param {Element} body 已清洗的 body
   * @param {string} prefaceTitle 首个标题之前的内容所用的章节标题
   */
  function splitByHeadingsDom(body, prefaceTitle) {
    hoistHeadings(body);
    const kids = Array.from(body.childNodes || []);
    const levels = kids.map(headingLevel).filter(Boolean);
    if (!levels.length) return null;
    const splitLevel = Math.min(...levels);

    const chapters = [];
    let current = null;
    let preface = [];
    for (const node of kids) {
      if (headingLevel(node) === splitLevel) {
        if (current) chapters.push(current);
        current = {
          title: String(node.textContent || "").replace(/\s+/g, " ").trim() || "Section",
          nodes: [node],
        };
      } else if (current) {
        current.nodes.push(node);
      } else {
        preface.push(node);
      }
    }
    if (current) chapters.push(current);
    if (!chapters.length) return null;

    const out = chapters.map((ch) => ({ title: ch.title, html: serializeNodes(ch.nodes) }));
    if (hasVisibleContent(preface)) {
      out.unshift({ title: prefaceTitle || "前言", html: serializeNodes(preface) });
    }
    return out;
  }

  /**
   * @param {string} bodyHtml 已清洗的 body XHTML 片段（extractBodyHtml 的输出）
   * @param {object} opts
   * @returns {{ id, title, html }[]}
   */
  function buildChaptersFromHtml(bodyHtml, opts) {
    const options = opts || {};
    const prefix = options.partPrefix || "Part";
    const wordsPer = options.wordsPerChapter || DEFAULT_WORDS_PER_CHAPTER;
    const preferHeadings = options.preferHeadings !== false;
    const defaultTitle = options.defaultTitle || "正文";

    let rawChapters = null;
    if (preferHeadings) {
      const body = sanitizeHtmlToBody(`<div>${String(bodyHtml || "")}</div>`);
      if (body) rawChapters = splitByHeadingsDom(body, defaultTitle);
    }
    if (!rawChapters || rawChapters.length === 0) {
      if (countWords(stripTags(bodyHtml)) > wordsPer) {
        rawChapters = splitByWordCount(bodyHtml, wordsPer, prefix);
      } else {
        rawChapters = [{ title: defaultTitle, html: extractBodyHtml(bodyHtml) }];
      }
    }

    return rawChapters.map((ch, i) => ({
      id: `chapter-${i + 1}`,
      title: ch.title || `${prefix} ${i + 1}`,
      html: wrapChapterXhtml(ch.title, ch.html),
    }));
  }

  global.ZEHChapterSplit = {
    buildChaptersFromHtml,
    splitByWordCount,
    splitByHeadingsDom,
    hoistHeadings,
    countWords,
    stripTags,
    DEFAULT_WORDS_PER_CHAPTER,
  };
})(typeof window !== "undefined" ? window : globalThis);
