/**
 * pdf-reader/context.js — PDF 页面文本的版面模型与查词语境（纯函数，不碰 DOM / chrome API）
 *
 * 输入是 PDF.js page.getTextContent({ includeMarkedContent: true, disableNormalization: true })
 * 的结果（与文本层 TextLayerBuilder 使用的参数相同），坐标全部是 PDF 用户空间单位，
 * 与缩放、滚动、设备像素比无关。
 *
 *   items   与文本层 span 一一对应：textContent.items 里有 str 的条目（markedContent 条目跳过），
 *           按出现顺序编号；str 为空的条目不会出现在 DOM 里，也不参与版面。
 *   lines   同一基线、水平相邻的条目；水平间隔过大（栏间距、表格单元格）另起一行。
 *   blocks  上下相邻、字号接近、水平范围重叠的行组成的段落。两栏版面的左右两栏水平范围
 *           不重叠，永远不会被拼进同一段；标题、页眉页脚因字号或垂直间距不同而单独成段。
 *
 * 段落文本：行与行之间加空格；行尾「字母-」+ 下一行小写字母开头视为断词连字符，去掉后直接相连。
 * 每个条目记录它在段落文本中的位置，选区（条目 + 字符偏移）由此换算成段落文本里的区间。
 *
 * 语境只取选区所在的那一段，最多前后各 ZEH_CONTEXT_LIMITS.scan 个字符，不跨段、不跨页、
 * 永远不会把整份文档发出去。无法确定时（跨段、表格、公式、竖排文字）返回 null，只按词典查。
 *
 * 依赖：config.js（ZEH_CONTEXT_LIMITS）。暴露 window.ZEHPdfContext。
 */
(function (global) {
  /** 同一行：基线差不超过字号的这个比例 */
  const SAME_LINE_DY = 0.5;
  /** 同一行内两段文字的水平间隔超过字号的这个倍数 → 不再是同一行（栏间距 / 表格） */
  const MAX_INLINE_GAP = 1.5;
  /** 行内间隔超过字号的这个比例且两侧都没有空白时补一个空格 */
  const SPACE_GAP = 0.12;
  /** 同一段：上下两行的基线距离在字号的这个范围内 */
  const MIN_LINE_STEP = 0.5;
  const MAX_LINE_STEP = 1.9;
  /** 同一段：两行字号之比不超过 */
  const MAX_SIZE_RATIO = 1.25;
  /** 新行向前最多查看几个段落（两栏交错绘制时左右栏的段落交替出现） */
  const BLOCK_LOOKBACK = 6;
  /** 少于这么多英文词的段落不提供语境（标题、页码、表格单元格） */
  const MIN_BLOCK_WORDS = 6;
  /** 字母占非空白字符的比例低于此值视为公式 / 表格数字，不提供语境 */
  const MIN_LETTER_RATIO = 0.6;
  /** 只有一行、且落在页面顶部 / 底部这个比例以内的段落视为页眉页脚 */
  const FURNITURE_BAND = 0.07;

  const HYPHEN_END_RE = /[A-Za-z][-‐­]$/;
  const LOWER_START_RE = /^[a-z]/;

  function scanLimit() {
    return typeof ZEH_CONTEXT_LIMITS === "object" && ZEH_CONTEXT_LIMITS.scan > 0 ? ZEH_CONTEXT_LIMITS.scan : 600;
  }

  function normalizeText(str) {
    return String(str).normalize("NFKC");
  }

  /** 原始字符串前 k 个字符规范化后的长度（NFKC 会把 ﬁ 之类的连字展开） */
  function normalizedOffset(raw, k) {
    if (k <= 0) return 0;
    if (k >= raw.length) return normalizeText(raw).length;
    return normalizeText(raw.slice(0, k)).length;
  }

  function finite(n, fallback) {
    return Number.isFinite(n) ? n : fallback;
  }

  /** textContent → 与文本层 span 顺序一致的条目列表 */
  function collectItems(textContent) {
    const raw = Array.isArray(textContent?.items) ? textContent.items : [];
    const items = [];
    for (const it of raw) {
      if (!it || typeof it.str !== "string") continue; // markedContent 条目没有 str，文本层也跳过
      const t = Array.isArray(it.transform) && it.transform.length === 6 ? it.transform : [1, 0, 0, 1, 0, 0];
      const h = Math.hypot(finite(t[2], 0), finite(t[3], 0)) || finite(it.height, 0) || 1;
      const angle = Math.atan2(finite(t[1], 0), finite(t[0], 1));
      items.push({
        index: items.length,
        str: it.str,
        norm: normalizeText(it.str),
        x: finite(t[4], 0),
        y: finite(t[5], 0),
        w: Math.max(0, finite(it.width, 0)),
        h,
        eol: Boolean(it.hasEOL),
        rotated: Math.abs(angle) > 0.01,
        line: -1,
        block: -1,
        start: -1,
        kept: 0,
      });
    }
    return items;
  }

  function isBlank(s) {
    return !/\S/.test(s);
  }

  function lineOf(first) {
    return { items: [first], x0: first.x, x1: first.x + first.w, y: first.y, h: first.h, rotated: first.rotated };
  }

  function joinsLine(line, prev, it) {
    if (prev.eol || line.rotated || it.rotated) return false;
    const size = Math.max(prev.h, it.h);
    if (Math.abs(it.y - prev.y) > SAME_LINE_DY * size) return false;
    const gap = it.x - (prev.x + prev.w);
    if (gap < -0.5 * size) return false; // 回到左边：下一行（或另一栏）
    return gap <= MAX_INLINE_GAP * size;
  }

  function buildLines(items) {
    const lines = [];
    let line = null;
    let prev = null; // 当前行最后一个有文字的条目
    for (const it of items) {
      if (it.str === "") continue;
      if (isBlank(it.str)) {
        // 空白条目只作分隔符：跟在当前行后面，不单独起行
        if (line) {
          line.items.push(it);
          if (it.eol) prev = { ...prev, eol: true };
        }
        continue;
      }
      if (line && prev && joinsLine(line, prev, it)) {
        line.items.push(it);
        line.x1 = Math.max(line.x1, it.x + it.w);
        line.h = Math.max(line.h, it.h);
      } else {
        line = lineOf(it);
        lines.push(line);
      }
      prev = it;
    }
    lines.forEach((l, i) => l.items.forEach((it) => (it.line = i)));
    return lines;
  }

  function joinsBlock(prevLine, line) {
    if (prevLine.rotated || line.rotated) return false;
    const big = Math.max(prevLine.h, line.h);
    const small = Math.min(prevLine.h, line.h) || big;
    if (big / small > MAX_SIZE_RATIO) return false;
    const step = prevLine.y - line.y;
    if (step < MIN_LINE_STEP * big || step > MAX_LINE_STEP * big) return false;
    const margin = 0.5 * big;
    return line.x0 < prevLine.x1 - margin && line.x1 > prevLine.x0 + margin;
  }

  function buildBlocks(lines) {
    const blocks = [];
    lines.forEach((line, li) => {
      let target = null;
      for (let k = blocks.length - 1; k >= 0 && k >= blocks.length - BLOCK_LOOKBACK; k--) {
        const b = blocks[k];
        if (joinsBlock(lines[b.lines[b.lines.length - 1]], line)) {
          target = b;
          break;
        }
      }
      if (!target) {
        target = { lines: [], text: "", rotated: line.rotated };
        blocks.push(target);
      }
      target.lines.push(li);
    });
    return blocks;
  }

  /** 拼出段落文本，并记录每个条目在其中的起点（start）与保留的字符数（kept） */
  function assembleBlock(block, blockIndex, lines) {
    let text = "";
    let prevLineItems = null;
    for (const li of block.lines) {
      const line = lines[li];
      let lineText = "";
      const placed = [];
      let prev = null;
      for (const it of line.items) {
        if (prev && !isBlank(it.str)) {
          const gap = it.x - (prev.x + prev.w);
          const tail = lineText.slice(-1);
          if (gap > SPACE_GAP * Math.max(prev.h, it.h) && tail && !/\s/.test(tail) && !/^\s/.test(it.norm)) {
            lineText += " ";
          }
        }
        placed.push({ it, at: lineText.length });
        lineText += it.norm;
        if (!isBlank(it.str)) prev = it;
      }
      if (prevLineItems) {
        if (HYPHEN_END_RE.test(text) && LOWER_START_RE.test(lineText)) {
          // 断词连字符：去掉，与下一行直接相连
          text = text.slice(0, -1);
          const last = prevLineItems[prevLineItems.length - 1];
          if (last) last.it.kept = Math.max(0, last.it.kept - 1);
        } else if (!/\s$/.test(text) && !/^\s/.test(lineText)) {
          text += " ";
        }
      }
      const base = text.length;
      for (const p of placed) {
        p.it.block = blockIndex;
        p.it.start = base + p.at;
        p.it.kept = p.it.norm.length;
      }
      text += lineText;
      prevLineItems = placed.filter((p) => !isBlank(p.it.str));
    }
    block.text = text;
    return block;
  }

  function englishWordCount(text) {
    const m = String(text).match(/[A-Za-z][A-Za-z'’-]*/g);
    return m ? m.length : 0;
  }

  function letterRatio(text) {
    const chars = String(text).replace(/\s+/g, "");
    if (!chars) return 0;
    const letters = chars.match(/[A-Za-z]/g);
    return (letters ? letters.length : 0) / chars.length;
  }

  /** 页眉页脚：只有一行，且基线落在页面顶部 / 底部的窄带里（view = page.view，PDF 用户空间） */
  function isPageFurniture(block, lines, view) {
    if (!Array.isArray(view) || view.length !== 4 || block.lines.length !== 1) return false;
    const bottom = Math.min(view[1], view[3]);
    const height = Math.abs(view[3] - view[1]);
    if (!(height > 0)) return false;
    const rel = (lines[block.lines[0]].y - bottom) / height;
    return rel < FURNITURE_BAND || rel > 1 - FURNITURE_BAND;
  }

  /** 这一段能否作为语境：竖排、页眉页脚、太短（标题 / 页码 / 单元格）、像公式或数字表的都不行 */
  function blockUsable(block) {
    if (!block || block.rotated || block.furniture) return false;
    if (englishWordCount(block.text) < MIN_BLOCK_WORDS) return false;
    return letterRatio(block.text) >= MIN_LETTER_RATIO;
  }

  /**
   * 一页的版面模型。
   * @param {object} textContent PDF.js getTextContent 的结果
   * @param {{ pageNumber?: number, view?: number[] }} [options] view：page.view（用于识别页眉页脚）
   */
  function buildPageModel(textContent, options) {
    const items = collectItems(textContent);
    const lines = buildLines(items);
    const blocks = buildBlocks(lines);
    blocks.forEach((b, i) => {
      assembleBlock(b, i, lines);
      b.text = b.text.replace(/\s+$/, "");
      b.furniture = isPageFurniture(b, lines, options?.view);
      b.usable = blockUsable(b);
    });
    const pageNumber = Number.isInteger(options?.pageNumber) && options.pageNumber > 0 ? options.pageNumber : null;
    return { pageNumber, items, lines, blocks, hasText: items.some((it) => !isBlank(it.str)) };
  }

  /** 选区端点（条目序号 + 原始字符偏移）→ { block, offset }；端点无效时 null */
  function resolvePoint(model, point) {
    if (!model || !point) return null;
    const it = model.items[point.item];
    if (!it || it.block < 0) return null;
    const raw = Math.max(0, Math.min(it.str.length, Number(point.offset) || 0));
    const k = Math.min(normalizedOffset(it.str, raw), it.kept);
    return { block: it.block, offset: it.start + k };
  }

  /** 选区在段落文本里的区间；跨段或端点无效时 null */
  function resolveSpan(model, a, b) {
    const p = resolvePoint(model, a);
    const q = resolvePoint(model, b);
    if (!p || !q || p.block !== q.block) return null;
    const start = Math.min(p.offset, q.offset);
    const end = Math.max(p.offset, q.offset);
    if (end <= start) return null;
    return { block: model.blocks[p.block], start, end };
  }

  /** 选区对应的文字（同一段内，断词已合并）；跨段时返回 ""，调用方改用浏览器选区文字 */
  function textForSelection(model, a, b) {
    const span = resolveSpan(model, a, b);
    if (!span) return "";
    return span.block.text.slice(span.start, span.end).replace(/\s+/g, " ").trim();
  }

  /**
   * 语境快照 { text, start, end, sourceType: "pdf" }：选区所在段落中、选区前后各至多 scan 个字符。
   * 跨段 / 跨页 / 段落不可用 / 选区过长时返回 null（只查词典，不带语境）。
   */
  function snapshotForSelection(model, a, b) {
    const span = resolveSpan(model, a, b);
    if (!span || !span.block.usable) return null;
    const limit = scanLimit();
    if (span.end - span.start > limit) return null;
    const text = span.block.text;
    const from = Math.max(0, span.start - limit);
    const to = Math.min(text.length, span.end + limit);
    return { text: text.slice(from, to), start: span.start - from, end: span.end - from, sourceType: "pdf" };
  }

  /** 页面有没有可选中的文字（扫描件 / 纯图片页没有） */
  function textContentHasText(textContent) {
    const raw = Array.isArray(textContent?.items) ? textContent.items : [];
    return raw.some((it) => it && typeof it.str === "string" && /\S/.test(it.str));
  }

  global.ZEHPdfContext = {
    buildPageModel,
    resolveSpan,
    textForSelection,
    snapshotForSelection,
    textContentHasText,
    TEXT_CONTENT_PARAMS: Object.freeze({ includeMarkedContent: true, disableNormalization: true }),
  };
})(typeof window !== "undefined" ? window : globalThis);
