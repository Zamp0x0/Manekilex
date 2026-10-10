/**
 * 页面侧查词模块：选区修复、代码块判定和词典 key 集合（M5，从 config.js 移来，名字不变）。
 *
 * 加载方：网页内容脚本（manifest.json content_scripts）、阅读器（reader.html）和侧边栏
 * （lookup-panel.html），都在 config.js 之后、mk-lookup.js 之前。service worker、设置页和弹出页
 * 不加载：这里的函数读取 DOM 节点、Range、window / document。
 * 本文件只声明；词典 key 集合在第一次调用 zehEnsureDictKeys 时才向 service worker 请求。
 * 依赖：config.js（zehLookupKeyVariants、zehNormalizeLookupText 等纯函数）。
 */

function zehIsWordChar(ch) {
  return /[a-zA-Z0-9'\u2018\u2019\u201B\u2032\u02BC\uFF07_]/.test(ch);
}

/** 选区是否在 code / pre 等代码容器内 */
function zehIsInsideCodeElement(node) {
  return Boolean(zehFindCodeElement(node));
}

function zehIsCodeClassElement(el) {
  if (!el || !el.classList || !el.classList.length) return false;
  for (const cls of el.classList) {
    const c = String(cls).toLowerCase();
    if (
      c.includes("code") ||
      c.includes("hljs") ||
      c.includes("prism") ||
      c.includes("monaco") ||
      c.includes("cm-line")
    ) {
      return true;
    }
  }
  return false;
}

/**
 * 最近的代码容器元素（code / pre / kbd / samp 或代码高亮类名），没有时返回 null。
 * 语境采集用它限定读取范围：CODE/SAMP/KBD（PRE 里的 CODE 也算，避开代码块标题栏），
 * 其次整个 PRE，最后才是高亮 span 等类名元素。
 */
function zehFindCodeElement(node) {
  let el = node && node.nodeType === 3 ? node.parentElement : node;
  let classHit = null;
  let tagHit = null;
  let depth = 0;
  while (el && depth < 60) {
    const tag = (el.tagName || "").toLowerCase();
    if (tag === "pre") return tagHit || el;
    if (!tagHit && (tag === "code" || tag === "kbd" || tag === "samp")) tagHit = el;
    if (!classHit && !tagHit && zehIsCodeClassElement(el)) classHit = el;
    el = el.parentElement;
    depth += 1;
  }
  return tagHit || classHit;
}

/**
 * repair 把选区扩进同一 camelCase 标识符时（如 isInside → isInsideLookupUI），应保留用户原选区。
 */
function zehIsIdentifierExpansion(raw, repaired) {
  if (/\s/.test(raw) || /\s/.test(repaired)) return false;
  const rawCore = String(raw || "").replace(/[^A-Za-z0-9_$]/g, "");
  const repCore = String(repaired || "").replace(/[^A-Za-z0-9_$]/g, "");
  if (!rawCore || !repCore || rawCore === repCore) return false;
  if (repCore.length <= rawCore.length) return false;
  if (repCore.startsWith(rawCore) || repCore.endsWith(rawCore)) {
    return /[A-Za-z]/.test(repCore);
  }
  return false;
}

/** 从 offset 向左找到当前单词开头，返回截断的前缀字符串。 */
function zehGetLeftFragment(text, offset) {
  let i = offset - 1;
  while (i >= 0 && zehIsWordChar(text[i])) i--;
  return text.slice(i + 1, offset);
}

/** 从 offset 向右找到当前单词结尾，返回截断的后缀字符串。 */
function zehGetRightFragment(text, offset) {
  let i = offset;
  while (i < text.length && zehIsWordChar(text[i])) i++;
  return text.slice(offset, i);
}

function zehAnyDictKeyInSet(dictKeys, text) {
  if (!dictKeys || !text) return false;
  for (const k of zehLookupKeyVariants(text)) {
    if (dictKeys.has(k)) return true;
  }
  return false;
}

let _zehDictKeySet = null;
let _zehDictKeyLoading = false;
const _zehDictKeyWaiters = [];

/** 同一标签页的同源 frame 共享已加载的 key 集合（挂在同源顶层 document 上，与气泡归属标记同一做法） */
const ZEH_DICT_KEY_SHARED_PROP = "__manekilexDictKeySet";

function zehDictKeyShareHost() {
  try {
    if (typeof window === "undefined" || typeof document === "undefined") return null;
    const topWin = window.top;
    if (topWin && topWin !== window) return topWin.document || null; // 跨域访问会 throw
    return document;
  } catch {
    return null;
  }
}

function zehReadSharedDictKeys() {
  try {
    const shared = zehDictKeyShareHost()?.[ZEH_DICT_KEY_SHARED_PROP];
    return shared && typeof shared.has === "function" && shared.size > 0 ? shared : null;
  } catch {
    return null;
  }
}

function zehPublishSharedDictKeys(set) {
  try {
    const host = zehDictKeyShareHost();
    if (host && !host[ZEH_DICT_KEY_SHARED_PROP]) host[ZEH_DICT_KEY_SHARED_PROP] = set;
  } catch {
    /* noop */
  }
}

/**
 * 按需加载词典 key 集合（R-04：不在页面加载时请求，只在划词 repair 真正需要时调用）。
 * 供划词 repair 判断「已是完整词条」时不强行补全后缀。
 * 加载失败不缓存，下次调用会重试；callback(set | null)。
 */
function zehEnsureDictKeys(callback) {
  const keys = zehGetDictKeysSync();
  if (keys) {
    if (callback) callback(keys);
    return;
  }
  if (callback) _zehDictKeyWaiters.push(callback);
  if (_zehDictKeyLoading) return;

  const finish = (list) => {
    _zehDictKeyLoading = false;
    if (Array.isArray(list) && list.length) {
      _zehDictKeySet = new Set(list);
      zehPublishSharedDictKeys(_zehDictKeySet);
    }
    _zehDictKeyWaiters.splice(0).forEach((fn) => {
      try {
        fn(_zehDictKeySet);
      } catch {
        /* noop */
      }
    });
  };

  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    finish(null);
    return;
  }
  _zehDictKeyLoading = true;
  try {
    chrome.runtime.sendMessage({ type: "GET_DICT_KEY_LIST" }, (resp) => {
      const err = chrome.runtime.lastError;
      finish(!err && resp?.ok !== false ? resp?.keys : null);
    });
  } catch {
    finish(null);
  }
}

function zehGetDictKeysSync() {
  if (!_zehDictKeySet) _zehDictKeySet = zehReadSharedDictKeys();
  return _zehDictKeySet;
}

/**
 * 利用 Range 的 start/end Text 节点向外扩展到完整单词边界，再 normalize。
 * 若用户已选中词典内独立词条（如 prayer），即使页面更长（prayers）也不强行补后缀。
 */
function zehRepairSelectionWithContext(range, rawText, dictKeys) {
  const keys = dictKeys || _zehDictKeySet;
  const rawNorm = zehNormalizeLookupText(rawText);

  if (range && zehIsInsideCodeElement(range.commonAncestorContainer)) {
    return rawNorm;
  }

  let repairedText = rawText;

  const startNode = range.startContainer;
  if (startNode && startNode.nodeType === Node.TEXT_NODE) {
    const nodeText = startNode.textContent || "";
    const startOffset = range.startOffset;
    if (
      startOffset > 0 &&
      zehIsWordChar(nodeText[startOffset - 1]) &&
      startOffset < nodeText.length &&
      zehIsWordChar(nodeText[startOffset])
    ) {
      const leftFrag = zehGetLeftFragment(nodeText, startOffset);
      if (leftFrag) repairedText = leftFrag + repairedText;
    }
  }

  const endNode = range.endContainer;
  if (endNode && endNode.nodeType === Node.TEXT_NODE) {
    const nodeText = endNode.textContent || "";
    const endOffset = range.endOffset;
    if (
      endOffset > 0 &&
      endOffset < nodeText.length &&
      zehIsWordChar(nodeText[endOffset - 1]) &&
      zehIsWordChar(nodeText[endOffset])
    ) {
      const rightFrag = zehGetRightFragment(nodeText, endOffset);
      if (rightFrag) repairedText = repairedText + rightFrag;
    }
  }

  const rawNormFinal = zehNormalizeLookupText(rawText);
  const repairedNorm = zehNormalizeLookupText(repairedText);
  if (
    keys &&
    rawNormFinal &&
    repairedNorm &&
    rawNormFinal !== repairedNorm &&
    zehAnyDictKeyInSet(keys, rawNormFinal)
  ) {
    return rawNormFinal;
  }

  if (rawNormFinal && repairedNorm && zehIsIdentifierExpansion(rawNormFinal, repairedNorm)) {
    return rawNormFinal;
  }

  return repairedNorm;
}
