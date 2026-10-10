/**
 * lookup/selection.js — 读取与修正选区（M7 从 mk-lookup.js 拆出）。
 *
 * zehCreateLookupSelection(host) 为一个查词控制器生成选区函数：
 *   - 跨 iframe / 同源子框架 / Shadow DOM 找到真正的选区（getSelectionDeep、getSelectionRange）；
 *   - 把选区转成视口矩形（resolveRangeViewportRect，PDF 阅读器等宿主可通过 rangeRectAdapter 换算坐标）；
 *   - 输入框 / 文本域里的选区（getFieldSelectionInfo、镜像元素测量光标矩形）；
 *   - 只选中半个单词时扩展到完整单词，包括复杂编辑器里跨文本节点的情况（expandPartialWordSelection）。
 * 这些函数只读 DOM，不改控制器状态、不显示小球、不发消息；小球与面板的生命周期仍在 mk-lookup.js。
 * host（由 createController 提供）：
 *   win / doc               控制器所在窗口与读取选区的文档
 *   aggressiveBubbleMode    宿主是否要求「选中即出小球」（影响跨节点扩展的触发条件）
 *   rangeRectAdapter(r)     把 Range 换算成视口矩形
 *   adaptViewportRect(r)    把元素矩形加上宿主给的视口偏移
 * 加载：与 lookup/dom-helpers.js 一样只声明，所有查词宿主都在 mk-lookup.js 之前加载 lookup/ 下的文件。
 */

/**
 * 一个查词控制器的选区函数。
 * @param {{ win: Window, doc: Document, aggressiveBubbleMode: boolean, rangeRectAdapter: Function, adaptViewportRect: Function }} host
 */
function zehCreateLookupSelection(host) {
  const win = host.win;
  const doc = host.doc;
  const aggressiveBubbleMode = host.aggressiveBubbleMode;
  const rangeRectAdapter = host.rangeRectAdapter;
  const adaptViewportRect = host.adaptViewportRect;

  // ── 小工具 ─────────────────────────────────────────────────────────────────

  /** 英文/代码 token 内可扩展字符（含连字符、点号，供部分选词扩展） */
  function isPartialExpandWordChar(ch) {
    if (!ch) return false;
    return /[A-Za-z0-9'\u2019\u2018\u2032\u02BC\uFF07_$.\-]/.test(ch);
  }

  function shouldAttemptPartialWordExpand(selectedText) {
    const t = String(selectedText || "");
    if (!t.trim() || t.length > 40) return false;
    if (/[\r\n]/.test(t)) return false;
    if (/\s/.test(t)) return false;
    if (/[.!?。！？;；:：,，]/.test(t)) return false;
    return true;
  }

  function logPartialExpansion(mode, originalText, expandedText, expanded, sameNode) {
    let host = "";
    try {
      host = win.location?.hostname || "";
    } catch {
      /* noop */
    }
    zehDebugLog("[Manekilex] partial expansion", {
      mode,
      originalText: String(originalText || "").slice(0, 80),
      expandedText: String(expandedText || "").slice(0, 80),
      expanded: Boolean(expanded),
      sameNode: Boolean(sameNode),
      host,
    });
  }

  const CROSS_EXPAND_MAX_CHARS = 80;
  const CROSS_EXPAND_MAX_NODES = 12;
  const CROSS_EXPAND_MAX_RESULT = 100;

  /** 复杂编辑器（飞书/ChatGPT）短选区跨 node 扩展 */
  function shouldAttemptCrossTextExpand(selectedText) {
    const raw = String(selectedText || "");
    const t = raw.trim();
    if (!t || t.length > 60) return false;
    if (/[\r\n]/.test(raw)) return false;
    if (/[.!?。！？;；:：]/.test(raw)) return false;
    if (/[,，]/.test(raw)) return false;
    if (typeof zehCountEnglishWords === "function" && zehCountEnglishWords(t) > 6) return false;
    return true;
  }

  function getExpansionRoot(range, useDoc) {
    let root = range.commonAncestorContainer;
    if (root.nodeType === Node.TEXT_NODE) root = root.parentNode;
    if (!root || root.nodeType !== Node.ELEMENT_NODE) {
      return useDoc.body || useDoc.documentElement;
    }
    return root;
  }

  function getFirstTextNodeInSubtree(node) {
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE && (node.textContent || "").length) return node;
    for (let i = 0; i < node.childNodes.length; i++) {
      const found = getFirstTextNodeInSubtree(node.childNodes[i]);
      if (found) return found;
    }
    return null;
  }

  function getLastTextNodeInSubtree(node) {
    if (!node) return null;
    if (node.nodeType === Node.TEXT_NODE && (node.textContent || "").length) return node;
    for (let i = node.childNodes.length - 1; i >= 0; i--) {
      const found = getLastTextNodeInSubtree(node.childNodes[i]);
      if (found) return found;
    }
    return null;
  }

  function resolveTextPoint(container, offset, side) {
    if (container.nodeType === Node.TEXT_NODE) {
      const len = (container.textContent || "").length;
      return { node: container, offset: Math.max(0, Math.min(offset, len)) };
    }
    if (container.nodeType !== Node.ELEMENT_NODE) return null;

    if (side === "start") {
      if (offset < container.childNodes.length) {
        const n = getFirstTextNodeInSubtree(container.childNodes[offset]);
        if (n) return { node: n, offset: 0 };
      }
      if (offset > 0) {
        const n = getLastTextNodeInSubtree(container.childNodes[offset - 1]);
        if (n) return { node: n, offset: (n.textContent || "").length };
      }
      return null;
    }

    if (offset > 0) {
      const n = getLastTextNodeInSubtree(container.childNodes[offset - 1]);
      if (n) return { node: n, offset: (n.textContent || "").length };
    }
    if (offset < container.childNodes.length) {
      const n = getFirstTextNodeInSubtree(container.childNodes[offset]);
      if (n) return { node: n, offset: 0 };
    }
    return null;
  }

  function findAdjacentTextNode(textNode, root, useDoc, direction) {
    if (!textNode || !root.contains(textNode)) return null;
    try {
      const walker = useDoc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      walker.currentNode = textNode;
      let steps = 0;
      while (steps < CROSS_EXPAND_MAX_NODES) {
        const next =
          direction === "prev" ? walker.previousNode() : walker.nextNode();
        if (!next) return null;
        if ((next.textContent || "").length > 0) return next;
        steps++;
      }
    } catch {
      /* noop */
    }
    return null;
  }

  function getCharBeforeTextPoint(node, offset, root, useDoc) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || "";
      if (offset > 0) return text[offset - 1];
      const prev = findAdjacentTextNode(node, root, useDoc, "prev");
      if (prev) {
        const t = prev.textContent || "";
        return t.length ? t[t.length - 1] : "";
      }
      return "";
    }
    return "";
  }

  function getCharAfterTextPoint(node, offset, root, useDoc) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || "";
      if (offset < text.length) return text[offset];
      const next = findAdjacentTextNode(node, root, useDoc, "next");
      if (next) {
        const t = next.textContent || "";
        return t.length ? t[0] : "";
      }
      return "";
    }
    return "";
  }

  function scanLeftWordPrefix(startNode, startOffset, root, useDoc) {
    const prefix = [];
    let curNode = startNode;
    let curOffset = startOffset;
    let nodesVisited = 0;
    let rangeStartNode = startNode;
    let rangeStartOffset = startOffset;

    while (curNode && nodesVisited <= CROSS_EXPAND_MAX_NODES && prefix.length < CROSS_EXPAND_MAX_CHARS) {
      if (curNode.nodeType !== Node.TEXT_NODE) break;
      const text = curNode.textContent || "";
      let i = curOffset - 1;
      while (i >= 0 && prefix.length < CROSS_EXPAND_MAX_CHARS) {
        const ch = text[i];
        if (!isPartialExpandWordChar(ch)) {
          rangeStartNode = curNode;
          rangeStartOffset = i + 1;
          return {
            prefix: prefix.reverse().join(""),
            startNode: rangeStartNode,
            startOffset: rangeStartOffset,
          };
        }
        prefix.push(ch);
        i--;
      }
      rangeStartNode = curNode;
      rangeStartOffset = 0;
      const prev = findAdjacentTextNode(curNode, root, useDoc, "prev");
      if (!prev) {
        return {
          prefix: prefix.reverse().join(""),
          startNode: rangeStartNode,
          startOffset: rangeStartOffset,
        };
      }
      curNode = prev;
      curOffset = (curNode.textContent || "").length;
      rangeStartNode = curNode;
      rangeStartOffset = 0;
      nodesVisited++;
    }
    return {
      prefix: prefix.reverse().join(""),
      startNode: rangeStartNode,
      startOffset: rangeStartOffset,
    };
  }

  function scanRightWordSuffix(endNode, endOffset, root, useDoc) {
    const suffix = [];
    let curNode = endNode;
    let curOffset = endOffset;
    let nodesVisited = 0;
    let rangeEndNode = endNode;
    let rangeEndOffset = endOffset;

    while (curNode && nodesVisited <= CROSS_EXPAND_MAX_NODES && suffix.length < CROSS_EXPAND_MAX_CHARS) {
      if (curNode.nodeType !== Node.TEXT_NODE) break;
      const text = curNode.textContent || "";
      let i = curOffset;
      while (i < text.length && suffix.length < CROSS_EXPAND_MAX_CHARS) {
        const ch = text[i];
        if (!isPartialExpandWordChar(ch)) {
          rangeEndNode = curNode;
          rangeEndOffset = i;
          return {
            suffix: suffix.join(""),
            endNode: rangeEndNode,
            endOffset: rangeEndOffset,
          };
        }
        suffix.push(ch);
        i++;
      }
      rangeEndNode = curNode;
      rangeEndOffset = text.length;
      const next = findAdjacentTextNode(curNode, root, useDoc, "next");
      if (!next) {
        return {
          suffix: suffix.join(""),
          endNode: rangeEndNode,
          endOffset: rangeEndOffset,
        };
      }
      curNode = next;
      curOffset = 0;
      rangeEndNode = curNode;
      rangeEndOffset = 0;
      nodesVisited++;
    }
    return {
      suffix: suffix.join(""),
      endNode: rangeEndNode,
      endOffset: rangeEndOffset,
    };
  }

  /**
   * 飞书 / ChatGPT 等复杂编辑器：短选区跨 Text node 左右扩展到完整词。
   */
  function expandAcrossTextNodesForShortSelection(selection, useDoc, originalText) {
    const noop = {
      text: originalText,
      expanded: false,
      originalText,
      rect: null,
      range: null,
    };
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return noop;
    if (!shouldAttemptCrossTextExpand(originalText)) return noop;

    let range;
    try {
      range = selection.getRangeAt(0);
    } catch {
      return noop;
    }
    if (!range || range.startOffset === range.endOffset) return noop;

    const root = getExpansionRoot(range, useDoc);
    const startPoint = resolveTextPoint(range.startContainer, range.startOffset, "start");
    const endPoint = resolveTextPoint(range.endContainer, range.endOffset, "end");
    if (!startPoint || !endPoint) return noop;

    const trimmedOrig = String(originalText || "").trim();
    const leftChar = getCharBeforeTextPoint(startPoint.node, startPoint.offset, root, useDoc);
    const rightChar = getCharAfterTextPoint(endPoint.node, endPoint.offset, root, useDoc);

    if (
      trimmedOrig.length === 1 &&
      /[A-Za-z]/.test(trimmedOrig) &&
      !isPartialExpandWordChar(leftChar) &&
      !isPartialExpandWordChar(rightChar)
    ) {
      logPartialExpansion("none", originalText, originalText, false, false);
      return noop;
    }

    const left = scanLeftWordPrefix(startPoint.node, startPoint.offset, root, useDoc);
    const right = scanRightWordSuffix(endPoint.node, endPoint.offset, root, useDoc);

    const expandedText = `${left.prefix}${originalText}${right.suffix}`.replace(/\s+/g, " ").trim();
    if (!expandedText || !zehHasEnglish(expandedText)) return noop;
    if (expandedText.length > CROSS_EXPAND_MAX_RESULT) return noop;
    if (expandedText === trimmedOrig || expandedText === originalText.trim()) return noop;
    if (!expandedText.toLowerCase().includes(trimmedOrig.toLowerCase())) return noop;

    try {
      const expandedRange = useDoc.createRange();
      expandedRange.setStart(left.prefix ? left.startNode : startPoint.node, left.prefix ? left.startOffset : startPoint.offset);
      expandedRange.setEnd(right.suffix ? right.endNode : endPoint.node, right.suffix ? right.endOffset : endPoint.offset);

      let rect = resolveRangeViewportRect(expandedRange);
      if (!rect) rect = resolveRangeViewportRect(range);

      const sameNode = range.startContainer === range.endContainer;
      logPartialExpansion("cross-text-node", originalText, expandedText, true, sameNode);

      return {
        text: expandedText,
        expanded: true,
        originalText,
        rect,
        range: expandedRange,
      };
    } catch {
      return noop;
    }
  }

  /**
   * 在单个 Text node 内将选区扩展到完整 word/token 边界。
   * @returns {{ start: number, end: number, text: string, expanded: boolean, originalText: string }}
   */
  function expandWordOffsetsInText(nodeText, startOffset, endOffset, originalSlice) {
    const originalText = originalSlice != null ? String(originalSlice) : nodeText.slice(startOffset, endOffset);
    let start = Math.min(startOffset, endOffset);
    let end = Math.max(startOffset, endOffset);
    const selectedRaw = nodeText.slice(start, end);
    const trimmedSelected = selectedRaw.trim();

    if (!shouldAttemptPartialWordExpand(trimmedSelected)) {
      return { start: startOffset, end: endOffset, text: originalText, expanded: false, originalText };
    }

    const leftChar = start > 0 ? nodeText[start - 1] : "";
    const rightChar = end < nodeText.length ? nodeText[end] : "";

    // 独立单字母：左右都是 token 边界 → 不扩展
    if (
      trimmedSelected.length === 1 &&
      /[A-Za-z]/.test(trimmedSelected) &&
      !isPartialExpandWordChar(leftChar) &&
      !isPartialExpandWordChar(rightChar)
    ) {
      logPartialExpansion("none", originalText, originalText, false, true);
      return { start: startOffset, end: endOffset, text: originalText, expanded: false, originalText };
    }

    while (start > 0 && isPartialExpandWordChar(nodeText[start - 1])) start--;
    while (end < nodeText.length && isPartialExpandWordChar(nodeText[end])) end++;

    const expandedText = nodeText.slice(start, end);
    const trimmedOrig = originalText.trim();
    const trimmedExp = expandedText.trim();
    if (!trimmedExp || !zehHasEnglish(trimmedExp)) {
      return { start: startOffset, end: endOffset, text: originalText, expanded: false, originalText };
    }
    if (trimmedExp.length > 80) {
      return { start: startOffset, end: endOffset, text: originalText, expanded: false, originalText };
    }
    if (
      trimmedExp.toLowerCase() === trimmedOrig.toLowerCase() ||
      zehNormalizeLookupText(trimmedOrig) === zehNormalizeLookupText(trimmedExp)
    ) {
      return { start: startOffset, end: endOffset, text: originalText, expanded: false, originalText };
    }
    if (!trimmedExp.toLowerCase().includes(trimmedOrig.toLowerCase())) {
      return { start: startOffset, end: endOffset, text: originalText, expanded: false, originalText };
    }

    logPartialExpansion("single-text-node", trimmedOrig, trimmedExp, true, true);
    return { start, end, text: expandedText, expanded: true, originalText };
  }

  /**
   * 用户只选中单词一部分时，扩展到完整单词/token。
   * @param {Selection|null} selection
   * @param {Document} [selectionDoc] 选区所在 document（EPUB iframe 须传入 iframe document）
   * @returns {{ text: string, expanded: boolean, originalText: string, rect: DOMRect|null, range: Range|null }}
   */
  function expandPartialWordSelection(selection, selectionDoc) {
    const useDoc = selectionDoc || doc;
    const originalText = selection ? extractSelectionText(selection) : "";
    const noop = {
      text: originalText,
      expanded: false,
      originalText,
      rect: null,
      range: null,
    };
    if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return noop;

    let range;
    try {
      range = selection.getRangeAt(0);
    } catch {
      return noop;
    }
    if (!range || range.startOffset === range.endOffset) return noop;

    const sameNode = range.startContainer === range.endContainer;

    // 单 Text node 扩展（普通网页）
    if (
      sameNode &&
      range.startContainer.nodeType === Node.TEXT_NODE &&
      shouldAttemptPartialWordExpand(originalText)
    ) {
      const node = range.startContainer;
      const nodeText = node.textContent || "";
      const expanded = expandWordOffsetsInText(
        nodeText,
        range.startOffset,
        range.endOffset,
        originalText
      );
      if (expanded.expanded) {
        try {
          const expandedRange = useDoc.createRange();
          expandedRange.setStart(node, expanded.start);
          expandedRange.setEnd(node, expanded.end);
          let rect = resolveRangeViewportRect(expandedRange);
          if (!rect) rect = resolveRangeViewportRect(range);
          return {
            text: expanded.text,
            expanded: true,
            originalText,
            rect,
            range: expandedRange,
          };
        } catch {
          /* fall through to cross-text fallback if enabled */
        }
      }
    }

    // 飞书 / ChatGPT 等：跨 Text node 短选区 fallback
    if (aggressiveBubbleMode && shouldAttemptCrossTextExpand(originalText)) {
      const cross = expandAcrossTextNodesForShortSelection(selection, useDoc, originalText);
      if (cross.expanded) return cross;
    }

    return noop;
  }

  /** input/textarea 内部分单词扩展 */
  function expandPartialWordInField(field, start, end) {
    const selStart = Math.min(start, end);
    const selEnd = Math.max(start, end);
    const value = String(field.value || "");
    const rawSlice = value.slice(selStart, selEnd);
    const expanded = expandWordOffsetsInText(value, selStart, selEnd, rawSlice);
    return {
      start: expanded.expanded ? expanded.start : selStart,
      end: expanded.expanded ? expanded.end : selEnd,
      text: expanded.text,
      expanded: expanded.expanded,
      originalText: rawSlice,
    };
  }

  function isTextInputElement(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === "TEXTAREA") return true;
    if (tag === "INPUT") {
      const type = (el.type || "text").toLowerCase();
      // 不含 password：密码字段的内容不能显示、发给模型或写入缓存
      return ["text", "search", "url", "email", "tel", ""].includes(type);
    }
    return false;
  }

  /** input / textarea 内选中：getSelection() 无效，需读 selectionStart/End */
  function copyFieldMirrorStyles(field, mirror) {
    const style = win.getComputedStyle(field);
    const props = [
      "direction",
      "boxSizing",
      "borderTopWidth",
      "borderRightWidth",
      "borderBottomWidth",
      "borderLeftWidth",
      "borderStyle",
      "paddingTop",
      "paddingRight",
      "paddingBottom",
      "paddingLeft",
      "fontStyle",
      "fontVariant",
      "fontWeight",
      "fontStretch",
      "fontSize",
      "fontFamily",
      "textAlign",
      "textTransform",
      "textIndent",
      "letterSpacing",
      "wordSpacing",
      "tabSize",
      "lineHeight",
    ];
    for (const prop of props) {
      mirror.style[prop] = style[prop];
    }
    mirror.style.whiteSpace = field.tagName === "TEXTAREA" ? "pre-wrap" : "pre";
    mirror.style.wordWrap = field.tagName === "TEXTAREA" ? "break-word" : "normal";
    mirror.style.overflowWrap = field.tagName === "TEXTAREA" ? "break-word" : "normal";
  }

  /** 用镜像 div 测量 input/textarea 内选区的视口坐标（非整框 rect） */
  function getTextInputSelectionRect(field, startOverride, endOverride) {
    const start = startOverride ?? field.selectionStart;
    const end = endOverride ?? field.selectionEnd;
    if (start == null || end == null || start === end) return null;

    const selStart = Math.min(start, end);
    const selEnd = Math.max(start, end);
    const value = String(field.value || "");
    const fieldRect = field.getBoundingClientRect();
    if (!fieldRect.width && !fieldRect.height) return null;

    const mirror = doc.createElement("div");
    mirror.setAttribute("aria-hidden", "true");
    mirror.style.position = "fixed";
    mirror.style.visibility = "hidden";
    mirror.style.pointerEvents = "none";
    mirror.style.zIndex = "-1";
    mirror.style.left = fieldRect.left + "px";
    mirror.style.top = fieldRect.top + "px";
    mirror.style.width = fieldRect.width + "px";
    mirror.style.height = fieldRect.height + "px";
    mirror.style.overflow = "hidden";
    mirror.style.borderColor = "transparent";
    copyFieldMirrorStyles(field, mirror);

    const before = doc.createTextNode(value.slice(0, selStart));
    const marker = doc.createElement("span");
    marker.textContent = value.slice(selStart, selEnd) || "\u200b";
    const after = doc.createTextNode(value.slice(selEnd));
    mirror.appendChild(before);
    mirror.appendChild(marker);
    mirror.appendChild(after);

    (doc.body || doc.documentElement).appendChild(mirror);
    mirror.scrollLeft = field.scrollLeft || 0;
    mirror.scrollTop = field.scrollTop || 0;

    const markerRect = marker.getBoundingClientRect();
    mirror.remove();

    if (!markerRect.width && !markerRect.height) {
      return adaptViewportRect({
        left: fieldRect.left,
        right: fieldRect.left + 1,
        top: fieldRect.top,
        bottom: fieldRect.bottom,
        width: 1,
        height: fieldRect.height,
      });
    }
    return adaptViewportRect({
      left: markerRect.left,
      right: markerRect.right,
      top: markerRect.top,
      bottom: markerRect.bottom,
      width: markerRect.width,
      height: markerRect.height,
    });
  }

  function getFieldSelectionInfo(el, startOverride, endOverride) {
    if (!isTextInputElement(el)) return null;
    const start = startOverride ?? el.selectionStart;
    const end = endOverride ?? el.selectionEnd;
    if (start == null || end == null || start === end) return null;

    const expandedField = expandPartialWordInField(el, start, end);
    const rawText = expandedField.text;
    if (!rawText || !rawText.trim()) return null;

    const text = zehNormalizeLookupText(rawText);
    if (!text || !zehHasEnglish(text)) return null;

    const rect = getTextInputSelectionRect(el, expandedField.start, expandedField.end);
    if (!rect) return null;

    if (expandedField.expanded) {
      logPartialExpansion("single-text-node", expandedField.originalText, text, true, true);
    }

    return {
      text,
      rect,
      range: null,
      fieldEl: el,
      originalText: expandedField.originalText,
      selectionExpanded: expandedField.expanded,
      contextSource: {
        kind: "field",
        el,
        start: expandedField.start,
        end: expandedField.end,
      },
    };
  }

  function findTextInputAncestor(node) {
    let el = node && node.nodeType === 3 ? node.parentElement : node;
    while (el) {
      if (isTextInputElement(el)) return el;
      el = el.parentElement;
    }
    return null;
  }

  function captureFieldSelectionSnapshot() {
    const active = doc.activeElement;
    if (!isTextInputElement(active)) return null;
    const start = active.selectionStart;
    const end = active.selectionEnd;
    if (start == null || end == null || start === end) return null;
    return { el: active, start, end };
  }

  /** 合并 Range 内多个 client rect（ChatGPT / ProseMirror 等常出现主 rect 为 0） */
  function mergeClientRects(rectList) {
    const rects = [...rectList].filter((r) => r && (r.width > 0 || r.height > 0));
    if (!rects.length) return null;
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const r of rects) {
      left = Math.min(left, r.left);
      top = Math.min(top, r.top);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    }
    return {
      left,
      top,
      right,
      bottom,
      width: right - left,
      height: bottom - top,
    };
  }

  /** 解析选区视口矩形：getBoundingClientRect → getClientRects → collapse 点 */
  function resolveRangeViewportRect(range) {
    if (!range) return null;
    try {
      const primary = rangeRectAdapter(range);
      if (primary && (primary.width > 0 || primary.height > 0)) return primary;
    } catch {
      /* noop */
    }
    try {
      const merged = mergeClientRects(range.getClientRects());
      if (merged) return adaptViewportRect(merged);
    } catch {
      /* noop */
    }
    try {
      const endRange = range.cloneRange();
      endRange.collapse(false);
      const endRect = rangeRectAdapter(endRange);
      if (endRect && (endRect.width > 0 || endRect.height > 0)) return endRect;
      if (endRect && (endRect.top !== 0 || endRect.left !== 0)) {
        return {
          left: endRect.left,
          top: endRect.top,
          right: endRect.right || endRect.left + 1,
          bottom: endRect.bottom || endRect.top + 18,
          width: endRect.width || 1,
          height: endRect.height || 18,
        };
      }
    } catch {
      /* noop */
    }
    return null;
  }

  function isSelectionRangeConnected(range) {
    if (!range) return false;
    try {
      const node = range.startContainer;
      if (!node) return false;
      if (node.nodeType === 3) return Boolean(node.parentElement && node.parentElement.isConnected);
      return Boolean(node.isConnected);
    } catch {
      return false;
    }
  }

  // ── 深度选区读取（iframe / shadow / composed ranges）────────────────────────

  function isSameOriginWindowAccessible(targetWin) {
    if (!targetWin) return false;
    try {
      void targetWin.document;
      return true;
    } catch {
      return false;
    }
  }

  function extractSelectionText(selection) {
    if (!selection || selection.isCollapsed) return "";
    let text = String(selection.toString() || "").trim();
    if (text) return text;
    if (typeof selection.getComposedRanges === "function") {
      try {
        const ranges = selection.getComposedRanges();
        if (ranges?.length) {
          text = ranges
            .map((range) => {
              try {
                return range.toString();
              } catch {
                return "";
              }
            })
            .join("")
            .trim();
        }
      } catch {
        /* noop */
      }
    }
    if (text) return text;
    try {
      if (selection.rangeCount > 0) {
        text = String(selection.getRangeAt(0).toString() || "").trim();
      }
    } catch {
      /* noop */
    }
    return text;
  }

  function probeWindowSelection(selWin, source, frameOffset) {
    if (!isSameOriginWindowAccessible(selWin)) return null;
    try {
      const selection = selWin.getSelection();
      const text = extractSelectionText(selection);
      if (!text) return null;
      return {
        text,
        source,
        selection,
        selectionWin: selWin,
        selectionDoc: selWin.document,
        frameOffset: frameOffset || { left: 0, top: 0 },
      };
    } catch {
      return null;
    }
  }

  function probeIframeElement(iframe, source, parentOffset) {
    if (!iframe || iframe.tagName !== "IFRAME") return null;
    try {
      const childWin = iframe.contentWindow;
      if (!isSameOriginWindowAccessible(childWin)) return null;
      const fr = iframe.getBoundingClientRect();
      const offset = {
        left: (parentOffset?.left || 0) + fr.left,
        top: (parentOffset?.top || 0) + fr.top,
      };
      const direct = probeWindowSelection(childWin, source, offset);
      if (direct) return direct;
      return probeIframesInDocument(childWin.document, offset);
    } catch {
      return null;
    }
  }

  function probeIframesInDocument(rootDoc, parentOffset) {
    if (!rootDoc) return null;
    let iframes;
    try {
      iframes = rootDoc.querySelectorAll("iframe");
    } catch {
      return null;
    }
    for (const iframe of iframes) {
      const found = probeIframeElement(iframe, "iframe", parentOffset);
      if (found) return found;
    }
    return null;
  }

  function probeActiveIframe(rootDoc, parentOffset) {
    try {
      const active = rootDoc.activeElement;
      if (active?.tagName === "IFRAME") {
        return probeIframeElement(active, "active-iframe", parentOffset);
      }
    } catch {
      /* noop */
    }
    return null;
  }

  function walkShadowHost(host, parentOffset, depth) {
    if (!host || depth > 12) return null;
    const shadowRoot = host.shadowRoot;
    if (!shadowRoot) return null;

    try {
      const active = shadowRoot.activeElement;
      if (active?.tagName === "IFRAME") {
        const found = probeIframeElement(active, "shadow", parentOffset);
        if (found) return found;
      }
      if (active?.shadowRoot) {
        const nested = walkShadowHost(active, parentOffset, depth + 1);
        if (nested) return nested;
      }
    } catch {
      /* noop */
    }

    try {
      const nodes = shadowRoot.querySelectorAll("*");
      for (const node of nodes) {
        if (node.shadowRoot) {
          const found = walkShadowHost(node, parentOffset, depth + 1);
          if (found) return found;
        }
        if (node.tagName === "IFRAME") {
          const found = probeIframeElement(node, "shadow", parentOffset);
          if (found) return found;
        }
      }
    } catch {
      /* noop */
    }
    return null;
  }

  function probeShadowRootsInDocument(rootDoc, parentOffset) {
    if (!rootDoc) return null;
    try {
      const active = rootDoc.activeElement;
      if (active?.shadowRoot) {
        const found = walkShadowHost(active, parentOffset, 0);
        if (found) return found;
      }
    } catch {
      /* noop */
    }
    try {
      const all = rootDoc.querySelectorAll("*");
      for (const el of all) {
        if (!el.shadowRoot) continue;
        const found = walkShadowHost(el, parentOffset, 0);
        if (found) return found;
      }
    } catch {
      /* noop */
    }
    return null;
  }

  /**
   * 本文档持有折叠光标（普通点击 / 输入时移动光标）且焦点不在 iframe 或 shadow host 内：
   * 用户当前的选区就在这里，其他 frame 里的选区只可能是旧的，不必全文档扫描（R-22）。
   */
  function isCaretInThisDocument() {
    try {
      const selection = win.getSelection();
      if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) return false;
      const active = doc.activeElement;
      if (!active) return true;
      if (active.tagName === "IFRAME" || active.tagName === "FRAME") return false;
      return !active.shadowRoot;
    } catch {
      return false;
    }
  }

  function getSelectionDeep() {
    const baseOffset = { left: 0, top: 0 };

    const main = probeWindowSelection(win, "main", baseOffset);
    if (main) return main;

    const activeIframe = probeActiveIframe(doc, baseOffset);
    if (activeIframe) return activeIframe;

    if (isCaretInThisDocument()) return null;

    const iframeHit = probeIframesInDocument(doc, baseOffset);
    if (iframeHit) return iframeHit;

    const shadowHit = probeShadowRootsInDocument(doc, baseOffset);
    if (shadowHit) return shadowHit;

    return null;
  }

  function getSelectionTextDeep() {
    return getSelectionDeep()?.text?.trim() || "";
  }

  function adjustRectForFrameOffset(rect, frameOffset) {
    if (!rect || !frameOffset) return rect;
    const ox = frameOffset.left || 0;
    const oy = frameOffset.top || 0;
    if (!ox && !oy) return rect;
    return {
      left: rect.left + ox,
      top: rect.top + oy,
      right: rect.right + ox,
      bottom: rect.bottom + oy,
      width: rect.width,
      height: rect.height,
    };
  }

  function getSelectionRange(selection) {
    if (!selection || selection.rangeCount === 0) return null;
    try {
      const range = selection.getRangeAt(0);
      const text = extractSelectionText(selection);
      if (text) return range;
    } catch {
      /* noop */
    }
    if (typeof selection.getComposedRanges === "function") {
      try {
        const composed = selection.getComposedRanges();
        if (composed && composed.length) return composed[0];
      } catch {
        /* noop */
      }
    }
    try {
      return selection.getRangeAt(0);
    } catch {
      return null;
    }
  }

  return {
    resolveTextPoint,
    expandPartialWordSelection,
    isTextInputElement,
    getTextInputSelectionRect,
    getFieldSelectionInfo,
    findTextInputAncestor,
    captureFieldSelectionSnapshot,
    resolveRangeViewportRect,
    isSelectionRangeConnected,
    extractSelectionText,
    getSelectionDeep,
    getSelectionTextDeep,
    adjustRectForFrameOffset,
    getSelectionRange,
  };
}
