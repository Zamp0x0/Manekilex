/**
 * pdf-reader/selection.js — 文本层 DOM 与版面模型之间的对应
 *
 * PDF.js 的文本层为每个有文字的 textContent 条目生成一个 span[role="presentation"]（顺序相同，
 * str 为空的条目不生成）。文本层渲染完成后，tagTextLayer 按顺序给每个 span 写上 data-mk-i
 * （条目序号）；数量或文字对不上时不标记，这一页的选区就只按词典查（不猜）。
 *
 * mapRange 把浏览器选区（Range）换成 { pageNumber, a, b }，a / b 是 { item, offset }：
 * 条目序号 + 该条目原始字符串里的字符偏移。查找高亮会在 span 里再包一层，这里按文字长度累加，
 * 不依赖具体的 DOM 结构。选区跨页时返回 null。
 *
 * 依赖：无。暴露 window.ZEHPdfSelection。
 */
(function (global) {
  const SPAN_SELECTOR = 'span[role="presentation"]';
  const TAGGED_SELECTOR = 'span[role="presentation"][data-mk-i]';

  /** 给文本层的 span 写上条目序号；返回是否成功 */
  function tagTextLayer(layerDiv, model) {
    if (!layerDiv || !model) return false;
    const spans = layerDiv.querySelectorAll(SPAN_SELECTOR);
    const expected = model.items.filter((it) => it.str !== "");
    let ok = spans.length === expected.length;
    for (let i = 0; ok && i < spans.length; i++) {
      if (spans[i].textContent !== expected[i].str) ok = false;
    }
    if (!ok) {
      layerDiv.dataset.mkMapped = "0";
      return false;
    }
    for (let i = 0; i < spans.length; i++) spans[i].dataset.mkI = String(expected[i].index);
    layerDiv.dataset.mkMapped = "1";
    if (model.pageNumber) layerDiv.dataset.mkPage = String(model.pageNumber);
    return true;
  }

  function elementOf(node) {
    return node && node.nodeType === 1 ? node : node?.parentElement || null;
  }

  function layerOf(node) {
    const el = elementOf(node);
    return el ? el.closest(".textLayer") : null;
  }

  function pageNumberOf(layer) {
    const page = layer?.closest?.(".page");
    const n = Number(page?.dataset?.pageNumber || layer?.dataset?.mkPage);
    return Number.isInteger(n) && n > 0 ? n : null;
  }

  /** span 内（container, offset）之前的文字长度（查找高亮会在 span 里再包一层，用 Range 计算不受影响） */
  function offsetInSpan(span, container, offset) {
    try {
      const r = span.ownerDocument.createRange();
      r.setStart(span, 0);
      r.setEnd(container, offset);
      return r.toString().length;
    } catch {
      return null;
    }
  }

  /**
   * 浏览器选区 → { pageNumber, layer, a, b }；不在已标记的文本层里、跨页、找不到条目时返回 null。
   */
  function mapRange(range) {
    if (!range || range.collapsed) return null;
    const startLayer = layerOf(range.startContainer);
    const endLayer = layerOf(range.endContainer);
    const layer = startLayer || endLayer;
    if (!layer || (startLayer && endLayer && startLayer !== endLayer)) return null;
    if (!startLayer || !endLayer) return null;
    if (layer.dataset.mkMapped !== "1") return null;
    const spans = layer.querySelectorAll(TAGGED_SELECTOR);
    let first = null;
    let last = null;
    for (const span of spans) {
      if (!range.intersectsNode(span)) {
        if (first) break;
        continue;
      }
      if (!first) first = span;
      last = span;
    }
    if (!first || !last) return null;
    const aOff = first.contains(range.startContainer) ? offsetInSpan(first, range.startContainer, range.startOffset) : 0;
    const bOff = last.contains(range.endContainer)
      ? offsetInSpan(last, range.endContainer, range.endOffset)
      : last.textContent.length;
    if (aOff == null || bOff == null) return null;
    return {
      pageNumber: pageNumberOf(layer),
      layer,
      a: { item: Number(first.dataset.mkI), offset: aOff },
      b: { item: Number(last.dataset.mkI), offset: bOff },
      multiItem: first !== last,
    };
  }

  global.ZEHPdfSelection = { tagTextLayer, mapRange, SPAN_SELECTOR };
})(typeof window !== "undefined" ? window : globalThis);
