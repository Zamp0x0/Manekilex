/**
 * lookup/context.js — 查词语境采集（M7 从 mk-lookup.js 拆出）。
 *
 * zehCreateLookupContext(host) 为一个查词控制器生成语境函数：划词时只读选区所在段落附近有限长度的文本
 * （不扫描整页），记成快照；真正查词时用最终查询词在快照里定位句子，生成随 EXPLAIN 发出的 context。
 * 页面、iframe、Shadow DOM、输入框都走这里；PDF 增强阅读器的文本层也是普通 DOM，同样走这里。
 * host（由 createController 提供）：
 *   win                  控制器所在窗口（判断是否在子框架里，决定 sourceType 是 web 还是 iframe）
 *   resolveTextPoint(…)  lookup/selection.js 的文本定位函数
 * 依赖 config.js：zehContextUsesContext、zehBuildLookupContext、zehDebugLog。
 * 加载：与 lookup/dom-helpers.js 一样只声明，所有查词宿主都在 mk-lookup.js 之前加载 lookup/ 下的文件。
 */

/**
 * 一个查词控制器的语境采集函数。
 * @param {{ win: Window, resolveTextPoint: Function }} host
 */
function zehCreateLookupContext(host) {
  const win = host.win;
  const resolveTextPoint = host.resolveTextPoint;

  // ── 语境采集（Phase 3）：只读选区所在段落附近有限长度的文本，不扫描整页 ─────────

  const CONTEXT_BLOCK_TAGS = new Set([
    "P", "LI", "DD", "DT", "TD", "TH", "CAPTION", "FIGCAPTION", "BLOCKQUOTE", "PRE",
    "H1", "H2", "H3", "H4", "H5", "H6", "DIV", "SECTION", "ARTICLE", "MAIN", "ASIDE",
    "HEADER", "FOOTER", "NAV", "BODY", "TABLE", "UL", "OL", "DL", "FORM", "FIELDSET",
    "DETAILS", "SUMMARY", "ADDRESS",
  ]);
  const CONTEXT_SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TEXTAREA", "INPUT", "SELECT", "OPTION",
    "BUTTON", "SVG", "MATH", "IFRAME", "OBJECT", "CANVAS", "VIDEO", "AUDIO",
  ]);
  /** 每个方向最多访问的节点数（与字符上限一起保证开销有界） */
  const CONTEXT_MAX_NODES = 400;

  function isInSubframe() {
    try {
      return win.top !== win;
    } catch {
      return true;
    }
  }

  function contextSourceTypeFor(selectionSource) {
    if (
      selectionSource === "iframe" ||
      selectionSource === "active-iframe" ||
      selectionSource === "shadow"
    ) {
      return "iframe";
    }
    return isInSubframe() ? "iframe" : "web";
  }

  function contextTagOf(node) {
    return node && node.nodeType === 1 ? String(node.tagName || "").toUpperCase() : "";
  }

  function isContextSkipped(node) {
    if (!node || node.nodeType !== 1) return false;
    if (CONTEXT_SKIP_TAGS.has(contextTagOf(node))) return true;
    try {
      return Boolean(node.hasAttribute && node.hasAttribute("data-mk-lookup-ui"));
    } catch {
      return false;
    }
  }

  function isContextBreak(node) {
    const tag = contextTagOf(node);
    return tag === "BR" || tag === "HR" || CONTEXT_BLOCK_TAGS.has(tag);
  }

  /** 选区所在的最近块级祖先（段落 / 列表项 / 单元格 …）：附近文本只在它里面读取 */
  function findContextBlock(node) {
    let el = node && node.nodeType === 3 ? node.parentNode : node;
    let last = null;
    let depth = 0;
    while (el && el.nodeType === 1 && depth < 40) {
      if (CONTEXT_BLOCK_TAGS.has(contextTagOf(el))) return el;
      last = el;
      el = el.parentNode;
      depth += 1;
    }
    return last;
  }

  function contextNextNode(node, root, skipChildren) {
    if (!skipChildren && node.firstChild) return node.firstChild;
    let n = node;
    while (n && n !== root) {
      if (n.nextSibling) return n.nextSibling;
      n = n.parentNode;
    }
    return null;
  }

  function contextPrevNode(node, root) {
    if (!node || node === root) return null;
    let prev = node.previousSibling;
    if (prev) {
      while (prev.lastChild && !isContextSkipped(prev)) prev = prev.lastChild;
      return prev;
    }
    const parent = node.parentNode;
    return parent && parent !== root ? parent : null;
  }

  function readContextTextBefore(textNode, offset, root, limit) {
    let out = String(textNode.nodeValue || "").slice(0, offset);
    let node = textNode;
    let visited = 0;
    while (out.length < limit && visited < CONTEXT_MAX_NODES) {
      node = contextPrevNode(node, root);
      if (!node) break;
      visited += 1;
      if (node.nodeType === 3) out = String(node.nodeValue || "") + out;
      else if (isContextBreak(node)) out = "\n" + out;
    }
    return out.slice(-limit);
  }

  function readContextTextAfter(textNode, offset, root, limit) {
    let out = String(textNode.nodeValue || "").slice(offset);
    let node = textNode;
    let visited = 0;
    while (out.length < limit && visited < CONTEXT_MAX_NODES) {
      node = contextNextNode(node, root, isContextSkipped(node));
      if (!node) break;
      visited += 1;
      if (node.nodeType === 3) out += String(node.nodeValue || "");
      else if (!isContextSkipped(node) && isContextBreak(node)) out += "\n";
    }
    return out.slice(0, limit);
  }

  /** 选区 Range → 选区前后各至多 ZEH_CONTEXT_LIMITS.scan 个字符（来自选区真实所在的文档 / frame） */
  function captureRangeContextSnapshot(range, sourceType) {
    if (!range) return null;
    try {
      const startPt = resolveTextPoint(range.startContainer, range.startOffset, "start");
      const endPt = resolveTextPoint(range.endContainer, range.endOffset, "end");
      if (!startPt || !endPt || startPt.node.nodeType !== 3 || endPt.node.nodeType !== 3) {
        return null;
      }
      // 代码容器里只在该容器内读取（不跨出 PRE / CODE 读周围正文）；是否真的发语境由
      // zehBuildLookupContext 按所在行判断（0.11.1：普通英文句子也有语境，代码行没有）。
      const codeEl = zehFindCodeElement(startPt.node);
      if (codeEl && !codeEl.contains(endPt.node)) return null;
      const limit = ZEH_CONTEXT_LIMITS.scan;
      const middle = String(range.toString() || "");
      if (!middle || middle.length > limit) return null;
      const before = readContextTextBefore(
        startPt.node,
        startPt.offset,
        codeEl || findContextBlock(startPt.node),
        limit
      );
      const after = readContextTextAfter(
        endPt.node,
        endPt.offset,
        codeEl || findContextBlock(endPt.node),
        limit
      );
      const snapshot = {
        text: before + middle + after,
        start: before.length,
        end: before.length + middle.length,
        sourceType: sourceType || "web",
      };
      if (codeEl) snapshot.inCode = true;
      return snapshot;
    } catch (err) {
      zehDebugLog("[Manekilex] context capture skipped", err?.message || err);
      return null;
    }
  }

  /** input / textarea：用 selectionStart / selectionEnd 截取字段值的一段（密码、邮箱等字段不取） */
  function captureFieldContextSnapshot(el, start, end) {
    if (!el) return null;
    const tag = contextTagOf(el);
    const type = String(el.type || "text").toLowerCase();
    if (tag !== "TEXTAREA" && !(tag === "INPUT" && ["text", "search", ""].includes(type))) return null;
    const value = String(el.value || "");
    const s = Math.max(0, Math.min(start, end));
    const e = Math.max(start, end);
    if (!value || e > value.length || e - s > ZEH_CONTEXT_LIMITS.scan) return null;
    const from = Math.max(0, s - ZEH_CONTEXT_LIMITS.scan);
    const to = Math.min(value.length, e + ZEH_CONTEXT_LIMITS.scan);
    return { text: value.slice(from, to), start: s - from, end: e - from, sourceType: "field" };
  }

  /**
   * 调用方已经截好的文本窗口（PDF 阅读器按版面模型取选区所在段落）：只校验形状与长度，
   * 不在这里读取 DOM。text 最多是选区两侧各 scan 个字符加选区本身。
   */
  function acceptContextSnapshot(source) {
    const text = typeof source.text === "string" ? source.text : "";
    const start = source.start;
    const end = source.end;
    const limit = ZEH_CONTEXT_LIMITS.scan;
    if (!text || !Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < 0 || end <= start || end > text.length) return null;
    if (end - start > limit || text.length > end - start + 2 * limit) return null;
    const sourceType = ZEH_CONTEXT_SOURCE_TYPES.includes(source.sourceType) ? source.sourceType : "web";
    return { text, start, end, sourceType };
  }

  function captureContextSnapshot(info, text) {
    const source = info?.contextSource;
    if (!source || !text) return null;
    try {
      if (!zehContextUsesContext(zehDetectQueryType(text))) return null;
      if (source.kind === "range") {
        return captureRangeContextSnapshot(source.range, source.sourceType);
      }
      if (source.kind === "field") {
        return captureFieldContextSnapshot(source.el, source.start, source.end);
      }
      if (source.kind === "snapshot") {
        return acceptContextSnapshot(source);
      }
    } catch (err) {
      zehDebugLog("[Manekilex] context capture skipped", err?.message || err);
    }
    return null;
  }

  /** 查词时：用最终查询词在快照里定位句子；找不到就返回 null（照常查词，不带语境） */
  function buildLookupContextForQuery(snapshot, text, queryType) {
    if (!snapshot || !zehContextUsesContext(queryType)) return null;
    try {
      return zehBuildLookupContext({
        text: snapshot.text,
        selectionStart: snapshot.start,
        selectionEnd: snapshot.end,
        term: text,
        queryType,
        sourceType: snapshot.sourceType,
        inCode: Boolean(snapshot.inCode),
      });
    } catch (err) {
      zehDebugLog("[Manekilex] context build skipped", err?.message || err);
      return null;
    }
  }

  return {
    contextSourceTypeFor,
    captureContextSnapshot,
    buildLookupContextForQuery,
  };
}
