const ZEH_STORAGE = {
  providers: "zehProviders",
  activeProvider: "zehActiveProvider",
  usageLogs: "zehUsageLogs",
  vocabulary: "zehVocabulary",
  theme: "zehTheme",
  readerPrefs: "zehReaderPrefs",
  readerTheme: "zehReaderTheme",
  readerPositionCache: "zehReaderPositionCache",
  openaiApiKey: "openaiApiKey",
  openaiModel: "openaiModel",
  providerBenchmarkLast: "zehProviderBenchmarkLast",
  providerBenchmarkJob: "zehProviderBenchmarkJob",
  providerBenchmarkCustomModels: "zehProviderBenchmarkCustomModels",
  assemblyAI: "zehAssemblyAI",
  liveTranscribeSource: "zehLiveTranscribeSource",
  liveTranscribeProvider: "zehLiveTranscribeProvider",
  pendingTabAudioCapture: "zehPendingTabAudioCapture",
  enabled: "zehManekilexEnabled",
};

const ZEH_MANEKILEX_ENABLED_DEFAULT = true;

const ZEH_MANEKILEX_DISABLED_MESSAGE =
  "Manekilex 已关闭，请先在扩展弹窗右上角开启 Manekilex。";

function zehGetManekilexEnabled(callback) {
  const key = ZEH_STORAGE.enabled;
  if (typeof chrome === "undefined" || !chrome.storage?.local) {
    callback(ZEH_MANEKILEX_ENABLED_DEFAULT);
    return;
  }
  chrome.storage.local.get({ [key]: ZEH_MANEKILEX_ENABLED_DEFAULT }, (result) => {
    callback(result[key] !== false);
  });
}

function zehGetManekilexEnabledAsync() {
  return new Promise((resolve) => {
    zehGetManekilexEnabled(resolve);
  });
}

/**
 * 订阅 Manekilex 总开关（弹窗右上角）：先读一次存储值，之后跟随 chrome.storage.local 的变化。
 * callback 收到布尔值：只有显式存的 false 才是关闭；键不存在 / 被删除都按默认开启。
 * 读取失败（chrome.runtime.lastError，例如扩展已重载）时不回调。
 * 返回 { reload }：重新读一次存储值（content.js 从 bfcache 恢复时用）。
 */
function zehSubscribeEnabled(callback) {
  const key = ZEH_STORAGE.enabled;
  function reload() {
    chrome.storage.local.get({ [key]: ZEH_MANEKILEX_ENABLED_DEFAULT }, (result) => {
      if (chrome.runtime?.lastError) return;
      callback(result[key] !== false);
    });
  }
  reload();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[key]) return;
    callback(changes[key].newValue !== false);
  });
  return { reload };
}

/** Chrome 内置 PDF 查看器（扩展页）的 URL 前缀 */
const ZEH_CHROME_PDF_VIEWER_PREFIX = "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/";

/**
 * 是否是浏览器里打开的 PDF：Chrome 内置 PDF 查看器，或路径以 .pdf 结尾（后面可跟 ? 或 #）。
 * 既可传完整 URL（background.js），也可传 pathname + search（content.js、pdf-page-assistant.js）。
 */
function zehIsPdfViewerUrl(url) {
  if (!url) return false;
  if (String(url).startsWith(ZEH_CHROME_PDF_VIEWER_PREFIX)) return true;
  return /\.pdf($|[?#])/i.test(url);
}

/** 增强 PDF 阅读器页面（manifest mime_types_handler 的 handler_url，也是手动打开的入口） */
const ZEH_PDF_READER_PAGE = "pdf-reader.html";
const ZEH_PDF_SOURCE_URL_MAX = 2000;

/**
 * PDF 来源地址：只保留 http(s) 的协议 + 主机 + 路径。查询串与 # 片段（签名、令牌、会话参数常在这里）
 * 和用户名密码一律去掉；其他协议（file: / blob: / data: …）返回 ""。
 */
function zehSanitizePdfSourceUrl(value) {
  if (typeof value !== "string" || !value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    return "";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "";
  const out = `${url.protocol}//${url.host}${url.pathname}`;
  return out.length > ZEH_PDF_SOURCE_URL_MAX ? "" : out;
}

/** 划词 API 结果缓存（chrome.storage.local） */
const ZEH_LOOKUP_CACHE_PREFIX = "zehCache:";
const ZEH_LOOKUP_CACHE_V2_PREFIX = "zehCache:v2:";
const ZEH_CACHE_CLEANUP_META_KEY = "zehCacheCleanupMeta";

const ZEH_CACHE_DAY_MS = 24 * 60 * 60 * 1000;
const ZEH_CACHE_CLEANUP_DAILY_MS = ZEH_CACHE_DAY_MS;
const ZEH_CACHE_CLEANUP_PERIODIC_MS = 6 * 60 * 60 * 1000;
const ZEH_CACHE_ACCESS_UPDATE_THROTTLE_MS = 10 * 60 * 1000;
const ZEH_CACHE_TOTAL_MAX_BYTES = 8 * 1024 * 1024;
const ZEH_CACHE_VERSION = 2;

const ZEH_CACHE_QUERY_TYPES = ["word", "phrase", "sentence", "paragraph", "code_term"];

const ZEH_CACHE_POLICY = {
  word: {
    ttlMs: 30 * ZEH_CACHE_DAY_MS,
    maxEntries: 1200,
    maxEntrySize: 8 * 1024,
  },
  phrase: {
    ttlMs: 30 * ZEH_CACHE_DAY_MS,
    maxEntries: 800,
    maxEntrySize: 12 * 1024,
  },
  code_term: {
    ttlMs: 30 * ZEH_CACHE_DAY_MS,
    maxEntries: 500,
    maxEntrySize: 12 * 1024,
  },
  sentence: {
    ttlMs: 14 * ZEH_CACHE_DAY_MS,
    maxEntries: 400,
    maxEntrySize: 20 * 1024,
  },
  paragraph: {
    ttlMs: 7 * ZEH_CACHE_DAY_MS,
    maxEntries: 150,
    maxEntrySize: 30 * 1024,
  },
};

/** 超出总容量时的删除优先级（先删 paragraph，最后 word） */
const ZEH_CACHE_EVICTION_ORDER = ["paragraph", "sentence", "phrase", "code_term", "word"];

/** FNV-1a 32-bit → 8 位 hex */
function zehFnv1aHash(text) {
  let hash = 2166136261;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function zehCacheTextHash(queryType, normalizedText) {
  return zehFnv1aHash(`${queryType}\0${normalizedText}`);
}

/** 缓存用 normalizedText：短词 lowerCase；句子/段落保留大小写 */
function zehNormalizeTextForCache(queryType, text) {
  let t = zehNormalizeApostrophe(String(text || ""))
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
  if (queryType === "word" || queryType === "phrase" || queryType === "code_term") {
    return zehCanonicalLookupKey(t);
  }
  return t;
}

function zehCacheV2StorageKey(queryType, textLength, textHash) {
  return `${ZEH_LOOKUP_CACHE_V2_PREFIX}${queryType}:${textLength}:${textHash}`;
}

/** 旧 v2 键（无 textLength），仅用于读取兼容 */
function zehCacheV2StorageKeyShort(queryType, textHash) {
  return `${ZEH_LOOKUP_CACHE_V2_PREFIX}${queryType}:${textHash}`;
}

function zehLegacyLookupCacheStorageKey(queryType, text) {
  const canonical = zehCanonicalLookupKey(text);
  return `${ZEH_LOOKUP_CACHE_PREFIX}${queryType}:${canonical}`;
}

function zehIsLookupCacheStorageKey(key) {
  if (!key || key === ZEH_CACHE_CLEANUP_META_KEY) return false;
  if (key.startsWith(ZEH_LOOKUP_CACHE_V2_PREFIX)) return true;
  if (!key.startsWith(ZEH_LOOKUP_CACHE_PREFIX)) return false;
  const rest = key.slice(ZEH_LOOKUP_CACHE_PREFIX.length);
  if (rest.startsWith("v2:")) return true;
  const qt = rest.split(":")[0];
  return ZEH_CACHE_QUERY_TYPES.includes(qt);
}

function zehClassifyCacheStorageKey(key) {
  if (!key || key === ZEH_CACHE_CLEANUP_META_KEY) return null;
  if (key.startsWith(ZEH_LOOKUP_CACHE_V2_PREFIX)) return "v2";
  if (key.startsWith(ZEH_LOOKUP_CACHE_PREFIX)) return "legacy";
  return null;
}

function zehParseLookupCacheStorageKey(key) {
  if (key.startsWith(ZEH_LOOKUP_CACHE_V2_PREFIX)) {
    const parts = key.slice(ZEH_LOOKUP_CACHE_V2_PREFIX.length).split(":");
    if (parts.length < 2 || !ZEH_CACHE_QUERY_TYPES.includes(parts[0])) return null;
    const queryType = parts[0];
    if (
      parts.length >= 3 &&
      /^\d+$/.test(parts[1]) &&
      /^[0-9a-f]{8}$/i.test(parts[2])
    ) {
      const parsed = {
        version: 2,
        format: "v2-length",
        queryType,
        textLength: Number(parts[1]),
        textHash: parts[2],
      };
      // Phase 3 语境结果：…:{textHash}:c{contextHash}
      if (parts.length >= 4 && /^c[0-9a-f]{8}$/i.test(parts[3])) {
        parsed.contextHash = parts[3].slice(1);
      }
      return parsed;
    }
    if (parts.length === 2 && /^[0-9a-f]{8}$/i.test(parts[1])) {
      return {
        version: 2,
        format: "v2-short",
        queryType,
        textHash: parts[1],
      };
    }
    return null;
  }
  if (key.startsWith(ZEH_LOOKUP_CACHE_PREFIX)) {
    const rest = key.slice(ZEH_LOOKUP_CACHE_PREFIX.length);
    if (rest.startsWith("v2:")) return null;
    const colon = rest.indexOf(":");
    if (colon <= 0) return null;
    return {
      version: 1,
      format: "legacy",
      queryType: rest.slice(0, colon),
      legacyTextKey: rest.slice(colon + 1),
    };
  }
  return null;
}

function zehGetCachePolicy(queryType) {
  return ZEH_CACHE_POLICY[queryType] || ZEH_CACHE_POLICY.word;
}

function zehClipCacheString(value, maxLen) {
  const s = String(value || "").trim();
  if (!s || s.length <= maxLen) return s;
  return s.slice(0, maxLen) + "…";
}

/** 裁剪缓存 data，去掉 raw 字段并按 queryType 限制长度/条数 */
function zehTrimCacheResultData(queryType, data) {
  if (!data || typeof data !== "object") return data;
  const out = { ...data };
  delete out.rawText;
  delete out.rawPreview;
  delete out.raw_response;

  const qt = queryType || "word";

  if (qt === "paragraph") {
    if (out.translation) out.translation = zehClipCacheString(out.translation, 5000);
    if (out.summary) out.summary = zehClipCacheString(out.summary, 300);
    if (out.grammar_notes) out.grammar_notes = zehClipCacheString(out.grammar_notes, 500);
    if (out.nuance) out.nuance = zehClipCacheString(out.nuance, 500);
    if (out.tone) out.tone = zehClipCacheString(out.tone, 200);
  } else if (qt === "sentence") {
    if (out.translation) out.translation = zehClipCacheString(out.translation, 1500);
    if (out.grammar_notes) out.grammar_notes = zehClipCacheString(out.grammar_notes, 500);
    if (out.nuance) out.nuance = zehClipCacheString(out.nuance, 500);
    if (out.tone) out.tone = zehClipCacheString(out.tone, 200);
  } else {
    if (out.short_meaning) out.short_meaning = zehClipCacheString(out.short_meaning, 500);
    if (out.context_meaning) out.context_meaning = zehClipCacheString(out.context_meaning, 800);
    if (out.meaning_here) out.meaning_here = zehClipCacheString(out.meaning_here, 600);
    if (out.pos_here) out.pos_here = zehClipCacheString(out.pos_here, 60);
    if (out.sentence_translation) {
      out.sentence_translation = zehClipCacheString(out.sentence_translation, 600);
    }
    if (out.chinese_explanation) {
      out.chinese_explanation = zehClipCacheString(out.chinese_explanation, 2000);
    }
  }

  if (Array.isArray(out.difficult_phrases)) {
    out.difficult_phrases = out.difficult_phrases.slice(0, 5).map((item) => ({
      phrase: zehClipCacheString(item?.phrase, 120),
      meaning: zehClipCacheString(item?.meaning, 300),
      note: zehClipCacheString(item?.note, 300),
    }));
  }
  if (Array.isArray(out.key_phrases)) {
    out.key_phrases = out.key_phrases.slice(0, 5);
  }
  if (Array.isArray(out.examples)) {
    out.examples = out.examples.slice(0, 3).map((ex) => ({
      en: zehClipCacheString(ex?.en, 300),
      zh: zehClipCacheString(ex?.zh, 300),
    }));
  }
  if (Array.isArray(out.breakdown)) {
    out.breakdown = out.breakdown.slice(0, qt === "word" || qt === "phrase" || qt === "code_term" ? 8 : 6);
  }
  if (Array.isArray(out.related_terms)) {
    const relatedMax =
      qt === "paragraph" || qt === "word" || qt === "phrase" || qt === "code_term" ? 8 : 5;
    out.related_terms = out.related_terms.slice(0, relatedMax);
  }
  if (Array.isArray(out.common_collocations)) {
    out.common_collocations = out.common_collocations.slice(0, 6);
  }
  if (Array.isArray(out.derivatives)) out.derivatives = out.derivatives.slice(0, 5);
  if (Array.isArray(out.synonyms)) out.synonyms = out.synonyms.slice(0, 5);
  if (typeof out.memory_tip === "string") out.memory_tip = zehClipCacheString(out.memory_tip, 300);

  return out;
}

function zehEstimateCacheEntryBytes(entry) {
  try {
    return JSON.stringify(entry).length;
  } catch {
    return 0;
  }
}

function zehBuildCacheEntry(queryType, normalizedText, textHash, data, meta = {}) {
  const trimmedData = zehTrimCacheResultData(queryType, data);
  const now = Date.now();
  const entry = {
    version: ZEH_CACHE_VERSION,
    queryType,
    normalizedText,
    textHash,
    data: trimmedData,
    source: meta.source || "unknown",
    model: meta.model || "",
    createdAt: meta.createdAt || now,
    updatedAt: now,
    lastAccessedAt: meta.lastAccessedAt || now,
    hitCount: meta.hitCount || 0,
    textLength: normalizedText.length,
    approxSize: 0,
  };
  if (meta.contextHash) {
    // 语境结果：键里只有 hash；这里保存规范化后的语境文本，读取时核对，避免 hash 碰撞串用
    entry.contextHash = meta.contextHash;
    entry.contextIdentity = meta.contextIdentity || "";
  }
  entry.approxSize = zehEstimateCacheEntryBytes(entry);
  return entry;
}

function zehMigrateLegacyCacheEntry(storageKey, legacyItem, queryType, normalizedText, textHash) {
  const now = Date.now();
  const savedAt = legacyItem.savedAt || legacyItem.createdAt || now;
  const entry = zehBuildCacheEntry(queryType, normalizedText, textHash, legacyItem.data, {
    source: legacyItem.source || "legacy",
    model: legacyItem.model || "",
    createdAt: savedAt,
    lastAccessedAt: legacyItem.lastAccessedAt || savedAt,
    hitCount: legacyItem.hitCount || 0,
  });
  return entry;
}

function zehLookupCacheDedupKey(queryType, text) {
  const normalized = zehNormalizeTextForCache(queryType, text);
  const hash = zehCacheTextHash(queryType, normalized);
  return `${queryType}:${hash}`;
}

const ZEH_MEMORY_TIP_TYPES = [
  "morphology",
  "etymology",
  "word_family",
  "sound",
  "association",
  "contrast",
  "none",
];

function zehHasCjk(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ""));
}

function zehIsMostlyLatin(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (zehHasCjk(t)) return false;
  return /[a-zA-Z]/.test(t);
}

function zehPickChineseMeaning(...candidates) {
  for (const c of candidates) {
    const t = String(c || "").trim();
    if (t && zehHasCjk(t)) return t;
  }
  for (const c of candidates) {
    const t = String(c || "").trim();
    if (t) return t;
  }
  return "";
}

/** 纠正模型把英文填进 short_meaning / context_meaning 的情况 */
function zehNormalizeWordResult(data) {
  if (
    !data ||
    data.queryType === "sentence" ||
    data.queryType === "paragraph" ||
    data.queryType === "code_term" ||
    data.translation
  ) {
    return data;
  }

  const out = { ...data, queryType: data.queryType === "phrase" ? "phrase" : "word" };
  let short = String(out.short_meaning || "").trim();
  let context = String(out.context_meaning || "").trim();
  let englishGloss = String(out.english_gloss || "").trim();

  if (zehIsMostlyLatin(short)) {
    if (context && zehHasCjk(context)) {
      short = context;
      context = "";
    } else {
      const exZh = Array.isArray(out.examples)
        ? out.examples.map((e) => String(e.zh || "").trim()).find((zh) => zehHasCjk(zh))
        : "";
      if (exZh) {
        englishGloss = englishGloss || [out.short_meaning, context].filter(Boolean).join("；");
        short = exZh;
      } else {
        englishGloss = englishGloss || [short, context].filter(Boolean).join("；");
        short = "";
        context = "";
      }
    }
  }

  if (context && zehIsMostlyLatin(context)) {
    englishGloss = englishGloss || context;
    context = "";
  }

  out.short_meaning = short;
  out.context_meaning = context;
  if (englishGloss) out.english_gloss = englishGloss;
  else delete out.english_gloss;

  // 0.11.1：助记过质量门（明显无效的旧助记不显示），派生词 / 同义词结构化并限长
  if ("memory_tip" in out || "memory_tip_type" in out) {
    const tip = zehNormalizeMemoryTip(out.memory_tip, out.memory_tip_type, out.term, short);
    out.memory_tip = tip.memory_tip;
    if (tip.memory_tip_type) out.memory_tip_type = tip.memory_tip_type;
    else delete out.memory_tip_type;
  }
  ["derivatives", "synonyms"].forEach((field) => {
    if (!(field in out)) return;
    const list =
      field === "derivatives"
        ? zehSanitizeDerivatives(out[field], out.term)
        : zehSanitizeSynonyms(out[field], out.term);
    if (list.length) out[field] = list;
    else delete out[field];
  });

  return out;
}

/** 划词选区长度分层限制（字符） */
const ZEH_LOOKUP_LIMITS = {
  word: 100,
  phrase: 300,
  code_term: 300,
  sentence: 1000,
  paragraph: 2500,
  hard: 3000,
};

/** 常见 Web/JS/CSS/API 技术词（小写匹配；不含普通英文 hyphen 词） */
const ZEH_CODE_TECH_TERMS = [
  "selectedtext",
  "cached selectedtext",
  "aggressivebubblemode",
  "stoppropagation",
  "stopimmediatepropagation",
  "preventdefault",
  "addeventlistener",
  "sendresponse",
  "sendmessage",
  "pointerdown",
  "mousedown",
  "mouseup",
  "selectionchange",
  "contenteditable",
  "abortcontroller",
  "service worker",
  "message channel",
  "shadow dom",
];

const ZEH_CSS_LIKE_TERMS = [
  "z-index",
  "pointer-events",
  "user-select",
  "box-shadow",
  "border-radius",
  "line-height",
  "font-size",
];

function isLikelySentence(text) {
  const t = String(text || "").trim();
  const len = t.length;
  const wordCount = zehCountEnglishWords(t);

  // foo.bar() / accounts.get / Node.js：没有空格的点路径是代码，不是句子（0.11.1）
  if (/^[A-Za-z_$][\w$]+(?:\.[A-Za-z_$][\w$]+)+(?:\([^()\s]*\))?;?$/.test(t)) return false;
  if (/[.!?。！？；;：:]/.test(t)) return true;
  if (/,/.test(t) && wordCount >= 6) return true;
  if (wordCount >= 10) return true;
  if (len >= 160 && wordCount >= 6) return true;
  return false;
}

/** @returns {string|null} */
function zehGetCodeTermReason(text) {
  const t = String(text || "").trim();
  const len = t.length;
  const wordCount = zehCountEnglishWords(t);

  if (!t || !zehHasEnglish(t)) return null;
  if (len > 120) return null;
  if (wordCount > 5) return null;
  if (isLikelySentence(t)) return null;

  if (/[a-z][A-Z]/.test(t)) return "camelCase";
  if (/[A-Za-z]+_[A-Za-z0-9_]+/.test(t)) return "snake_case";
  if (/[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+/.test(t)) return "dot_path";
  if (/[A-Za-z_$][\w$]*\s*\(/.test(t)) return "function_call";

  const lower = t.toLowerCase();
  const techHit = ZEH_CODE_TECH_TERMS.find((term) => lower.includes(term));
  if (techHit) return `tech_term:${techHit}`;

  if (ZEH_CSS_LIKE_TERMS.includes(lower)) return `css_property:${lower}`;

  return null;
}

function isCodeLikeTerm(text) {
  return zehGetCodeTermReason(text) != null;
}

/** 统计英文词数（不依赖空格；支持连字符/撇号） */
function zehCountEnglishWords(text) {
  const t = String(text || "").trim();
  if (!t) return 0;
  const matches = t.match(/[a-zA-Z]+(?:[''-][a-zA-Z]+)*/g);
  return matches ? matches.length : 0;
}

function zehDetectQueryType(text) {
  const clean = zehNormalizeLookupText(text);
  const len = clean.length;
  const wordCount = zehCountEnglishWords(clean);

  if (!clean) return "empty";
  if (len > ZEH_LOOKUP_LIMITS.hard) return "too_long";

  if (len > ZEH_LOOKUP_LIMITS.sentence) return "paragraph";

  if (isLikelySentence(clean)) return "sentence";

  if (isCodeLikeTerm(clean)) return "code_term";

  if (wordCount === 1 && len <= ZEH_LOOKUP_LIMITS.word) return "word";
  if (wordCount <= 8 && len <= ZEH_LOOKUP_LIMITS.phrase) return "phrase";

  if (len <= ZEH_LOOKUP_LIMITS.sentence) return "sentence";

  return "paragraph";
}

function zehLogDetectedQueryType(clean, queryType) {
  const wordCount = zehCountEnglishWords(clean);
  zehDebugLog("[Manekilex] detected queryType", {
    queryType,
    textLength: clean.length,
    wordCount,
    textPreview: clean.slice(0, 120),
  });
  if (queryType === "code_term") {
    const reason = zehGetCodeTermReason(clean);
    if (reason) zehDebugLog("[Manekilex] code_term reason", reason);
  }
}

function zehUsesDictionary(queryType) {
  return queryType === "word" || queryType === "phrase";
}

// ── 查词生命周期：超时 / 并发去重 / 终态消息 / 结果容错（Phase 1）────────────

/** 查词 provider 请求超时（毫秒）。超时后用 AbortController 中止 fetch，查词进入错误终态。 */
const ZEH_LOOKUP_PROVIDER_TIMEOUT_MS = {
  word: 20000,
  phrase: 20000,
  code_term: 25000,
  sentence: 30000,
  paragraph: 45000,
};

/** 页面侧兜底超时的余量：词典冷加载、缓存读写、消息往返。必须大于 0，保证后台先超时。 */
const ZEH_LOOKUP_CLIENT_TIMEOUT_GRACE_MS = 15000;

const ZEH_LOOKUP_TIMEOUT_CODE = "LOOKUP_TIMEOUT";
const ZEH_LOOKUP_GENERIC_ERROR_MESSAGE = "没有查到解释，请稍后重试或切换模型。";

function zehLookupProviderTimeoutMs(queryType) {
  return ZEH_LOOKUP_PROVIDER_TIMEOUT_MS[queryType] || ZEH_LOOKUP_PROVIDER_TIMEOUT_MS.word;
}

function zehLookupClientTimeoutMs(queryType) {
  return zehLookupProviderTimeoutMs(queryType) + ZEH_LOOKUP_CLIENT_TIMEOUT_GRACE_MS;
}

function zehLookupTimeoutMessage(timeoutMs, providerName) {
  const seconds = Math.round((Number(timeoutMs) || 0) / 1000);
  const who = providerName ? `${providerName} ` : "";
  return `${who}请求超时（>${seconds}s），请稍后重试或切换模型。`;
}

function zehLookupTimeoutError(timeoutMs, providerName) {
  const err = new Error(zehLookupTimeoutMessage(timeoutMs, providerName));
  err.code = ZEH_LOOKUP_TIMEOUT_CODE;
  return err;
}

/**
 * 创建一个到时自动 abort 的 signal。
 * 调用方必须在请求结束后 cleanup()；timedOut() 区分「超时」与其他失败。
 */
function zehCreateTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
    timedOut: () => timedOut,
  };
}

/**
 * 并发去重：同一 key 已在请求中则共享同一个 Promise（成功和失败都共享）。
 * 请求结束（无论成败）后自动从 map 移除，下一次查询会重新发起。
 * @returns {{ leader: boolean, promise: Promise }}
 */
function zehShareInflightLookup(map, key, factory) {
  if (map.has(key)) return { leader: false, promise: map.get(key) };
  const promise = Promise.resolve().then(factory);
  map.set(key, promise);
  const clear = () => {
    if (map.get(key) === promise) map.delete(key);
  };
  promise.then(clear, clear);
  return { leader: true, promise };
}

/** 把 provider 调用的 Promise 归一成终态 outcome，永不 reject。 */
function zehSettleLookupOutcome(promise) {
  return Promise.resolve(promise).then(
    (result) => ({ status: result?.fallback ? "fallback" : "ok", result }),
    (error) => ({ status: "error", error })
  );
}

/**
 * 根据 outcome 生成发给页面的终态消息。原始请求和所有去重等待者都走这里，
 * 所以它们得到同样的成功 / 失败结果。返回 null 表示页面已处于终态（词典结果已显示）。
 * @param {{status: "ok"|"fallback"|"error", result?: object, error?: Error}} outcome
 * @param {{queryId: string|null, queryType: string, hasDictEntry: boolean}} ctx
 */
function zehLookupOutcomeMessage(outcome, ctx) {
  const { queryId = null, queryType, hasDictEntry = false } = ctx || {};
  const status = outcome?.status;
  const result = outcome?.result || {};

  if (status === "ok") {
    if (hasDictEntry) {
      // 词典结果已显示：只更新状态栏，不重新渲染面板主体
      return {
        type: "DICT_ENHANCED",
        queryId,
        durationMs: result.durationMs,
        providerName: result.providerName,
        modelName: result.modelName,
      };
    }
    return {
      type: "SHOW_RESULT",
      queryId,
      queryType,
      durationMs: result.durationMs,
      providerName: result.providerName,
      modelName: result.modelName,
      data: result.data,
    };
  }

  // 词典结果已显示时，AI 增强失败不再打扰页面
  if (hasDictEntry) return null;

  if (status === "fallback") {
    return {
      type: "SHOW_RESULT",
      queryId,
      queryType,
      fallback: true,
      durationMs: result.durationMs,
      providerName: result.providerName,
      modelName: result.modelName,
      data: {
        term: result.term,
        rawText: result.rawText || ZEH_LOOKUP_GENERIC_ERROR_MESSAGE,
        queryType,
      },
    };
  }

  const error = outcome?.error;
  const message =
    error?.code === ZEH_LOOKUP_TIMEOUT_CODE
      ? String(error.message || zehLookupTimeoutMessage(zehLookupProviderTimeoutMs(queryType)))
      : ZEH_LOOKUP_GENERIC_ERROR_MESSAGE;
  return { type: "SHOW_ERROR", queryId, message };
}

const ZEH_RESULT_ARRAY_FIELDS = [
  "examples",
  "common_collocations",
  "key_phrases",
  "difficult_phrases",
  "breakdown",
  "related_terms",
  "derivatives",
  "synonyms",
];
const ZEH_RESULT_TAG_FIELDS = ["common_collocations", "key_phrases", "related_terms"];
const ZEH_RESULT_OBJECT_ITEM_FIELDS = ["examples", "breakdown"];

/**
 * 渲染前的结果容错：模型可能返回 null / 非对象 / 列表里夹 null 或对象。
 * 只做结构修正（去掉空项、把标签列表项转成字符串），不改动正常字段的内容。
 */
function zehSanitizeLookupResult(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const out = { ...data };

  ZEH_RESULT_ARRAY_FIELDS.forEach((field) => {
    if (!(field in out)) return;
    const value = out[field];
    if (value == null) {
      delete out[field];
      return;
    }
    out[field] = (Array.isArray(value) ? value : [value]).filter((item) => item != null);
  });

  ZEH_RESULT_TAG_FIELDS.forEach((field) => {
    if (!Array.isArray(out[field])) return;
    out[field] = out[field]
      .map((item) =>
        typeof item === "object"
          ? String(item.phrase || item.term || item.text || item.en || "")
          : String(item)
      )
      .filter((item) => item.trim());
  });

  ZEH_RESULT_OBJECT_ITEM_FIELDS.forEach((field) => {
    if (!Array.isArray(out[field])) return;
    out[field] = out[field].filter((item) => typeof item === "object");
  });

  if (Array.isArray(out.difficult_phrases)) {
    out.difficult_phrases = out.difficult_phrases.filter(
      (item) => typeof item === "string" || typeof item === "object"
    );
  }

  if (out.example != null && typeof out.example !== "object") {
    delete out.example;
  }

  return out;
}

/** 查词前校验：空文本、硬上限、类型与分层长度 */
function zehValidateLookupText(text) {
  const normalized = zehNormalizeLookupText(text);
  if (!normalized) {
    return { ok: false, code: "EMPTY", message: "请先选中要解释的文本。" };
  }
  if (!zehHasEnglish(normalized)) {
    return { ok: false, code: "NO_ENGLISH", message: "未检测到英文，请选中英文内容后再查。" };
  }
  if (normalized.length > ZEH_LOOKUP_LIMITS.hard) {
    return {
      ok: false,
      code: "TEXT_TOO_LONG",
      normalized,
      message:
        "选中文本太长。Manekilex 更适合解释单词、句子和短段落，请缩短到 3000 字符以内。",
    };
  }

  const queryType = zehDetectQueryType(normalized);
  zehLogDetectedQueryType(normalized, queryType);

  if (queryType === "empty") {
    return { ok: false, code: "EMPTY", message: "请先选中要解释的文本。" };
  }
  if (queryType === "too_long") {
    return {
      ok: false,
      code: "TEXT_TOO_LONG",
      queryType,
      normalized,
      message: "这段文字太长，请选中更短的一段再解释。",
    };
  }

  const limit = ZEH_LOOKUP_LIMITS[queryType];
  if (normalized.length > limit) {
    return {
      ok: false,
      code: "TEXT_TOO_LONG",
      queryType,
      normalized,
      limit,
      message: "这段文字太长，请选中更短的一段再解释。",
    };
  }

  return { ok: true, normalized, text: normalized, queryType, limit };
}

// ── 调试日志开关（Phase 5）：noisy 的 console.debug 统一走这里；warn / error 不受影响 ──
// 开发时把 ZEH_DEBUG_LOGS 改为 true；Reader 页另有 ?debug=1 的位置链路日志。
const ZEH_DEBUG_LOGS = false;

function zehDebugLog(...args) {
  if (!ZEH_DEBUG_LOGS) return;
  console.debug(...args);
}

/**
 * 词典条目是否「可用」：不能只信 enriched:true，必须有中文释义内容。
 * 空壳（只有 term 与 enriched 标记，没有释义）按未命中处理，交给模型兜底，且不写入缓存。
 */
function zehIsDictEntryUsable(entry) {
  if (!entry || typeof entry !== "object") return false;
  if (entry.specialEntry === true || entry.source === "special") return true;
  const short = String(entry.short_meaning || entry.meaning_cn || "").trim();
  const context = String(entry.context_meaning || entry.simple_explanation_cn || "").trim();
  return Boolean(short || context);
}

// 词性缩写 → 统一拼写（仅展示层；词典文件本身不做批量改写）
const ZEH_POS_ALIASES = {
  n: "noun",
  "n.": "noun",
  v: "verb",
  "v.": "verb",
  vt: "verb",
  "vt.": "verb",
  vi: "verb",
  "vi.": "verb",
  adj: "adjective",
  "adj.": "adjective",
  "a.": "adjective",
  adv: "adverb",
  "adv.": "adverb",
  "ad.": "adverb",
  prep: "preposition",
  "prep.": "preposition",
  conj: "conjunction",
  "conj.": "conjunction",
  pron: "pronoun",
  "pron.": "pronoun",
  num: "numeral",
  "num.": "numeral",
  int: "interjection",
  "int.": "interjection",
  interj: "interjection",
  "interj.": "interjection",
  abbr: "abbreviation",
  "abbr.": "abbreviation",
  art: "article",
  "art.": "article",
  aux: "auxiliary verb",
  "aux.": "auxiliary verb",
  "aux. v.": "auxiliary verb",
  det: "determiner",
  "det.": "determiner",
  "modal v.": "modal verb",
  "phr.": "phrase",
  "phr. v.": "phrasal verb",
  "phrasal v.": "phrasal verb",
};

/** 把词性字符串按分隔符（括号内不拆）拆成若干项 */
function zehSplitPartOfSpeech(raw) {
  const parts = [];
  let depth = 0;
  let buf = "";
  const text = String(raw || "");
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(" || ch === "（") depth++;
    else if (ch === ")" || ch === "）") depth = Math.max(0, depth - 1);
    const isSep = depth === 0 && (ch === "," || ch === "，" || ch === "、" || ch === ";" || ch === "；" || ch === "/" || ch === "&");
    if (isSep) {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  parts.push(buf);
  return parts.map((p) => p.replace(/\s+/g, " ").trim()).filter(Boolean);
}

/**
 * 展示层词性归一：去多余空白、统一分隔符为「, 」、展开常见英文缩写（n. → noun）。
 * 中文词性（名词 / 动词…）保持原样，只去重。
 */
function zehNormalizePartOfSpeech(pos) {
  const raw = String(pos || "").replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const out = [];
  for (const part of zehSplitPartOfSpeech(raw)) {
    const key = part.toLowerCase().replace(/ and$/, "");
    const mapped = ZEH_POS_ALIASES[key] || key;
    if (!out.includes(mapped)) out.push(mapped);
  }
  return out.join(", ");
}

function zehIsDictEntryEnriched(entry) {
  if (!entry) return false;
  if (!zehIsDictEntryUsable(entry)) return false;
  if (entry.enriched === true) return true;
  const examples = Array.isArray(entry.examples) ? entry.examples : [];
  const memoryTip = String(entry.memory_tip || entry.memory_tip_cn || "").trim();
  const short = String(entry.short_meaning || entry.meaning_cn || "").trim();
  return !!(
    examples.length > 0 &&
    memoryTip &&
    zehHasCjk(memoryTip) &&
    short &&
    zehHasCjk(short)
  );
}

// ── 语境查词（Phase 3）：选中词 + 所在句子 → 此处含义 ─────────────────────────
// 页面只在选区附近读取有限长度的文本；后台用同一套函数再次校验 / 限长，不信任页面传来的长度。

const ZEH_CONTEXT_LIMITS = {
  /** 发送给模型 / 保存到生词本的句子最大字符数（超长时以选中词为中心截取） */
  sentence: 400,
  /** 附近文本（前后各一句）最大字符数 */
  nearby: 600,
  /** 页面侧在选区两侧各最多读取的字符数 */
  scan: 600,
  /** 句子短于此长度时才附带前后句 */
  shortSentence: 120,
  /** 句子至少要比选中词多几个英文词才算有语境 */
  minExtraWords: 2,
  /** 后台对传入字符串做任何处理前的硬截断 */
  rawInput: 4000,
};

const ZEH_CONTEXT_SOURCE_TYPES = ["web", "iframe", "field", "epub", "pdf"];

/** 句点后不算句子结束的常见缩写（小写，不含末尾的点） */
const ZEH_CONTEXT_ABBREVIATIONS = new Set([
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "mt", "vs", "etc", "e.g", "i.e", "cf",
  "inc", "ltd", "co", "corp", "fig", "vol", "approx", "dept", "est", "u.s", "u.k", "a.m",
  "p.m", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

const ZEH_CONTEXT_CLOSERS_RE = /["'\u201D\u2019)\]\u300D\u300F]/;

function zehContextUsesContext(queryType) {
  return queryType === "word" || queryType === "phrase";
}

/** 规范化语境文本：撇号、NFKC、控制字符 / 零宽字符 → 空格，合并空白。 */
function zehCleanContextText(text) {
  return zehNormalizeApostrophe(String(text || ""))
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function zehEscapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 转义后可放进元素内容和带引号的属性值（value="…" / title='…'）。
 * 与浏览器序列化文本节点（div.textContent → innerHTML）相同：& U+00A0 < >，另外转义两种引号。
 */
function zehEscapeHtml(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/\u00a0/g, "&nbsp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function zehIsAsciiWordChar(ch) {
  return Boolean(ch) && /[A-Za-z0-9]/.test(ch);
}

/**
 * 在 text 中找 term（忽略大小写，空白可不同）。优先完整单词匹配，其次任意匹配；
 * 多处命中时取离 [hintStart, hintEnd) 最近的一处。
 * @returns {{start: number, end: number} | null}
 */
function zehFindTermInText(text, term, hintStart, hintEnd) {
  const source = String(text || "");
  const t = String(term || "").trim();
  if (!source || !t) return null;
  const pattern = zehEscapeRegExp(zehNormalizeApostrophe(t)).replace(/\s+/g, "\\s+");
  let re;
  try {
    re = new RegExp(pattern, "gi");
  } catch {
    return null;
  }
  const hs = Number.isFinite(hintStart) ? hintStart : 0;
  const he = Number.isFinite(hintEnd) ? hintEnd : hs;
  let bestWhole = null;
  let bestAny = null;
  const distance = (m) => (m.end < hs ? hs - m.end : m.start > he ? m.start - he : 0);
  let match;
  let guard = 0;
  while ((match = re.exec(source)) && guard < 200) {
    guard += 1;
    if (!match[0]) {
      re.lastIndex += 1;
      continue;
    }
    const m = { start: match.index, end: match.index + match[0].length };
    const whole =
      (!zehIsAsciiWordChar(t[0]) || !zehIsAsciiWordChar(source[m.start - 1])) &&
      (!zehIsAsciiWordChar(t[t.length - 1]) || !zehIsAsciiWordChar(source[m.end]));
    if (whole && (!bestWhole || distance(m) < distance(bestWhole))) bestWhole = m;
    if (!bestAny || distance(m) < distance(bestAny)) bestAny = m;
  }
  return bestWhole || bestAny;
}

/** text[i] 处的终止符（. ! ? 。 ！ ？ …）是否真的结束了一个句子。 */
function zehIsSentenceEndAt(text, i) {
  const ch = text[i];
  if (ch === "\u3002" || ch === "\uFF01" || ch === "\uFF1F") return true;
  if (ch !== "." && ch !== "!" && ch !== "?" && ch !== "\u2026") return false;
  let j = i + 1;
  while (j < text.length && ZEH_CONTEXT_CLOSERS_RE.test(text[j])) j++;
  if (j < text.length && !/\s/.test(text[j])) return false; // 3.14 / example.com / loan.Bank
  let next = j;
  while (next < text.length && text[next] !== "\n" && /\s/.test(text[next])) next++;
  if (/[a-z]/.test(text[next] || "")) return false; // 句子继续：He said "stop!" and left.
  if (ch !== ".") return true;
  let k = i - 1;
  while (k >= 0 && /[A-Za-z.]/.test(text[k])) k--;
  const word = text.slice(k + 1, i).toLowerCase();
  if (!word) return true;
  if (ZEH_CONTEXT_ABBREVIATIONS.has(word)) return false;
  if (/^[a-z]$/.test(word) && /[A-Z]/.test(text[i - 1])) return false; // 姓名缩写 J. K. Rowling
  return true;
}

/** 以 [start, end) 为中心向两侧找句子边界；换行是硬边界。 */
function zehSentenceBounds(text, start, end) {
  let s = Math.max(0, start);
  while (s > 0) {
    const ch = text[s - 1];
    if (ch === "\n") break;
    if (zehIsSentenceEndAt(text, s - 1)) break;
    s--;
  }
  let e = Math.min(text.length, Math.max(end, s));
  while (e < text.length) {
    const ch = text[e];
    if (ch === "\n") break;
    if (zehIsSentenceEndAt(text, e)) {
      e++;
      while (e < text.length && ZEH_CONTEXT_CLOSERS_RE.test(text[e])) e++;
      break;
    }
    e++;
  }
  return { start: s, end: e };
}

/**
 * 以 [spanStart, spanEnd) 为中心截取不超过 maxLen 的片段，截断处加 ...（尽量落在词边界）。
 * 用 ASCII "..."：NFKC 会把 U+2026 展开成三个点，用它会让二次规范化改变长度。
 */
function zehClipAroundSpan(text, spanStart, spanEnd, maxLen) {
  const t = String(text || "");
  if (t.length <= maxLen) return t;
  const budget = Math.max(0, maxLen - 6);
  const spanLen = Math.max(0, spanEnd - spanStart);
  const side = Math.max(0, Math.floor((budget - spanLen) / 2));
  let from = Math.max(0, spanStart - side);
  let to = Math.min(t.length, from + budget);
  from = Math.max(0, Math.min(from, to - budget));
  if (from > 0) {
    const space = t.indexOf(" ", from);
    if (space !== -1 && space < spanStart) from = space + 1;
  }
  if (to < t.length) {
    const space = t.lastIndexOf(" ", to);
    if (space > spanEnd) to = space;
  }
  return `${from > 0 ? "..." : ""}${t.slice(from, to).trim()}${to < t.length ? "..." : ""}`;
}

function zehContextTermIndex(text, term) {
  const hit = zehFindTermInText(text, term, 0, 0);
  return hit ? hit.start : -1;
}

/**
 * 校验并限长一个语境对象（页面发送前、后台收到后都调用）。不可用时返回 null，查词照常进行。
 * @returns {{sentence: string, nearbyText?: string, sourceType: string} | null}
 */
function zehNormalizeLookupContext(raw, term, queryType) {
  if (!zehContextUsesContext(queryType)) return null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const cleanTerm = zehNormalizeLookupText(term);
  if (!cleanTerm) return null;

  const rawSentence = typeof raw.sentence === "string" ? raw.sentence : "";
  let sentence = zehCleanContextText(rawSentence.slice(0, ZEH_CONTEXT_LIMITS.rawInput));
  if (!sentence) return null;
  let termAt = zehContextTermIndex(sentence, cleanTerm);
  if (termAt < 0) return null;
  if (sentence.length > ZEH_CONTEXT_LIMITS.sentence) {
    sentence = zehClipAroundSpan(
      sentence,
      termAt,
      termAt + cleanTerm.length,
      ZEH_CONTEXT_LIMITS.sentence
    );
    termAt = zehContextTermIndex(sentence, cleanTerm);
    if (termAt < 0) return null;
  }
  if (
    zehCountEnglishWords(sentence) - zehCountEnglishWords(cleanTerm) <
    ZEH_CONTEXT_LIMITS.minExtraWords
  ) {
    return null;
  }

  const out = {
    sentence,
    sourceType: ZEH_CONTEXT_SOURCE_TYPES.includes(raw.sourceType) ? raw.sourceType : "web",
  };

  const rawNearby = typeof raw.nearbyText === "string" ? raw.nearbyText : "";
  let nearby = zehCleanContextText(rawNearby.slice(0, ZEH_CONTEXT_LIMITS.rawInput));
  if (nearby && nearby.length > ZEH_CONTEXT_LIMITS.nearby) {
    let at = nearby.indexOf(sentence);
    let len = sentence.length;
    if (at < 0) {
      at = zehContextTermIndex(nearby, cleanTerm);
      len = cleanTerm.length;
    }
    nearby =
      at >= 0
        ? zehClipAroundSpan(nearby, at, at + len, ZEH_CONTEXT_LIMITS.nearby)
        : nearby.slice(0, ZEH_CONTEXT_LIMITS.nearby);
  }
  if (nearby && nearby.length > sentence.length && nearby !== sentence) {
    out.nearbyText = nearby;
  }
  return out;
}

/**
 * 从一段原文 + 选区位置构造语境（页面侧使用）。text 是选区附近的有限窗口，
 * selectionStart / selectionEnd 是选区在 text 中的位置，term 是最终查询词。
 */
function zehBuildLookupContext(input) {
  const opts = input || {};
  if (!zehContextUsesContext(opts.queryType)) return null;
  const raw = zehNormalizeApostrophe(String(opts.text || ""));
  const term = zehNormalizeLookupText(opts.term);
  if (!raw || !term) return null;

  const selStart = Math.max(0, Math.min(raw.length, Number(opts.selectionStart) || 0));
  const selEnd = Math.max(selStart, Math.min(raw.length, Number(opts.selectionEnd) || selStart));
  const winStart = Math.max(0, selStart - ZEH_CONTEXT_LIMITS.scan);
  const winEnd = Math.min(raw.length, selEnd + ZEH_CONTEXT_LIMITS.scan);
  const text = raw.slice(winStart, winEnd);

  const hit = zehFindTermInText(text, term, selStart - winStart, selEnd - winStart);
  if (!hit) return null;
  const bounds = zehSentenceBounds(text, hit.start, hit.end);
  let sentence = text.slice(bounds.start, bounds.end);

  // 代码块（PRE / CODE）里的普通英文：只取选中词所在的那一行里的句子，不带附近文本；
  // 这一行本身像代码（const bank = …;）时不发语境，按代码词查（0.11.1）。
  if (opts.inCode) {
    const lineStart = text.lastIndexOf("\n", hit.start - 1) + 1;
    const lineEndAt = text.indexOf("\n", hit.end);
    const line = text.slice(lineStart, lineEndAt < 0 ? text.length : lineEndAt);
    if (zehLooksLikeCodeLine(zehStripCodeCommentMarkers(line))) return null;
    sentence = zehStripCodeCommentMarkers(sentence);
    return zehNormalizeLookupContext({ sentence, sourceType: opts.sourceType }, term, opts.queryType);
  }

  let nearbyText = "";
  if (zehCleanContextText(sentence).length < ZEH_CONTEXT_LIMITS.shortSentence) {
    let from = bounds.start;
    let to = bounds.end;
    if (from > 0 && text[from - 1] !== "\n") {
      from = zehSentenceBounds(text, from - 1, from - 1).start;
    }
    let next = to;
    while (next < text.length && text[next] !== "\n" && /\s/.test(text[next])) next++;
    if (next < text.length && text[next] !== "\n" && (to === 0 || text[to - 1] !== "\n")) {
      to = zehSentenceBounds(text, next, next).end;
    }
    if (from < bounds.start || to > bounds.end) nearbyText = text.slice(from, to);
  }

  return zehNormalizeLookupContext(
    { sentence, nearbyText, sourceType: opts.sourceType },
    term,
    opts.queryType
  );
}

/** 语境身份：只由真正影响释义的文本决定（大小写 / 空白不敏感）。 */
function zehContextIdentity(context) {
  if (!context || !context.sentence) return "";
  const norm = (t) => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
  return `${norm(context.sentence)}\u0000${norm(context.nearbyText)}`;
}

function zehLookupContextHash(context) {
  const identity = zehContextIdentity(context);
  return identity ? zehFnv1aHash(`ctx\u0000${identity}`) : "";
}

/**
 * 语境结果的缓存键：通用键 + `:c{语境 hash}`。键里只放 hash，不放原文。
 * 例：zehCache:v2:word:4:1a2b3c4d:c5e6f7a8b
 */
function zehContextCacheStorageKey(queryType, text, context) {
  const normalizedText = zehNormalizeTextForCache(queryType, text);
  const textHash = zehCacheTextHash(queryType, normalizedText);
  return `${zehCacheV2StorageKey(queryType, normalizedText.length, textHash)}:c${zehLookupContextHash(context)}`;
}

/** 语境查询的并发去重键：同一词 + 同一语境才共享请求。 */
function zehContextDedupKey(queryType, text, context) {
  return `${zehLookupCacheDedupKey(queryType, text)}:c${zehLookupContextHash(context)}`;
}

/** 语境增强结果：只保留需要的字段并限长；没有 meaning_here 视为无效。 */
function zehNormalizeContextEnhancement(data, term) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const pick = (value, max) => (typeof value === "string" ? zehClipCacheString(value, max) : "");
  const meaning = pick(data.meaning_here, 600);
  if (!meaning) return null;
  const examples = (Array.isArray(data.examples) ? data.examples : [])
    .filter((ex) => ex && typeof ex === "object")
    .map((ex) => ({ en: pick(ex.en, 300), zh: pick(ex.zh, 300) }))
    .filter((ex) => ex.en || ex.zh)
    .slice(0, 2);
  const out = { meaning_here: meaning, examples };
  const pos = pick(data.pos_here, 60);
  if (pos) out.pos_here = pos;
  const translation = pick(data.sentence_translation, 600);
  if (translation) out.sentence_translation = translation;
  const tip = zehNormalizeMemoryTip(data.memory_tip, data.memory_tip_type, term);
  if (tip.memory_tip) {
    out.memory_tip = tip.memory_tip;
    out.memory_tip_type = tip.memory_tip_type;
  }
  const derivatives = zehSanitizeDerivatives(data.derivatives, term);
  if (derivatives.length) out.derivatives = derivatives;
  const synonyms = zehSanitizeSynonyms(data.synonyms, term);
  if (synonyms.length) out.synonyms = synonyms;
  return out;
}

/**
 * 把增强字段合并进基础结果：基础释义不变；例句换成与此处义项一致的例句（有的话）；
 * 同义词跟随此处义项（整组替换）；派生词与已有的合并去重；已有的可用助记保留，
 * 没有或明显无效时才用增强结果里的助记。
 */
function zehMergeContextEnhancement(base, enhancement) {
  const merged = { ...(base && typeof base === "object" ? base : {}) };
  const term = merged.term || "";
  merged.meaning_here = enhancement.meaning_here;
  if (enhancement.pos_here) merged.pos_here = enhancement.pos_here;
  else delete merged.pos_here;
  if (enhancement.sentence_translation) merged.sentence_translation = enhancement.sentence_translation;
  else delete merged.sentence_translation;
  if (Array.isArray(enhancement.examples) && enhancement.examples.length) {
    merged.examples = enhancement.examples;
  }
  const derivatives = zehMergeLexicalList(
    zehSanitizeDerivatives(enhancement.derivatives, term),
    zehSanitizeDerivatives(merged.derivatives, term),
    ZEH_LEXICAL_LIST_MAX
  );
  if (derivatives.length) merged.derivatives = derivatives;
  else delete merged.derivatives;
  const synonyms = zehSanitizeSynonyms(enhancement.synonyms, term);
  if (synonyms.length) merged.synonyms = synonyms;
  const baseTip = zehNormalizeMemoryTip(merged.memory_tip, merged.memory_tip_type, term);
  const nextTip = baseTip.memory_tip
    ? baseTip
    : zehNormalizeMemoryTip(enhancement.memory_tip, enhancement.memory_tip_type, term);
  if (nextTip.memory_tip) {
    merged.memory_tip = nextTip.memory_tip;
    if (nextTip.memory_tip_type) merged.memory_tip_type = nextTip.memory_tip_type;
    else delete merged.memory_tip_type;
  } else {
    merged.memory_tip = "";
    delete merged.memory_tip_type;
  }
  return merged;
}

// ── 0.11.1 派生词 / 同义词 / 助记质量 ─────────────────────────────────────────

/** 派生词、同义词各最多保留的条数 */
const ZEH_LEXICAL_LIST_MAX = 5;

function zehLexicalKey(word) {
  return String(word || "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function zehLexicalWord(value, maxLen) {
  const word = zehCollapseText(typeof value === "string" ? value : "");
  if (!word || word.length > maxLen) return "";
  return /^[A-Za-z][A-Za-z'’ .-]*$/.test(word) ? word : "";
}

/** 派生词：{word,pos,zh}，必须是英文词 + 中文释义；去掉与原词相同、仅大小写或 -s/-es 复数的条目。 */
function zehSanitizeDerivatives(list, term) {
  const termKey = zehLexicalKey(term);
  const seen = new Set();
  const out = [];
  (Array.isArray(list) ? list : []).forEach((item) => {
    if (out.length >= ZEH_LEXICAL_LIST_MAX || !item || typeof item !== "object") return;
    const word = zehLexicalWord(item.word, 40);
    const zh = zehCollapseText(typeof item.zh === "string" ? item.zh : "").slice(0, 60);
    if (!word || !zehHasCjk(zh)) return;
    const key = zehLexicalKey(word);
    if (!key || seen.has(key)) return;
    if (termKey && (key === termKey || key === `${termKey}s` || key === `${termKey}es`)) return;
    seen.add(key);
    const entry = { word, zh };
    const pos = zehCollapseText(typeof item.pos === "string" ? item.pos : "").slice(0, 20);
    if (pos) entry.pos = pos;
    out.push(entry);
  });
  return out;
}

/** 同义词：{word,zh,nuance?}，英文词或短语 + 中文；去掉与原词相同的条目。 */
function zehSanitizeSynonyms(list, term) {
  const termKey = zehLexicalKey(term);
  const seen = new Set();
  const out = [];
  (Array.isArray(list) ? list : []).forEach((item) => {
    if (out.length >= ZEH_LEXICAL_LIST_MAX || !item || typeof item !== "object") return;
    const word = zehLexicalWord(item.word, 60);
    const zh = zehCollapseText(typeof item.zh === "string" ? item.zh : "").slice(0, 60);
    if (!word || !zehHasCjk(zh)) return;
    const key = zehLexicalKey(word);
    if (!key || key === termKey || seen.has(key)) return;
    seen.add(key);
    const entry = { word, zh };
    const nuance = zehCollapseText(typeof item.nuance === "string" ? item.nuance : "").slice(0, 80);
    if (nuance) entry.nuance = nuance;
    out.push(entry);
  });
  return out;
}

/** 按 word 合并两组（前一组优先），去重并限长。 */
function zehMergeLexicalList(primary, secondary, max) {
  const seen = new Set();
  const out = [];
  [primary, secondary].forEach((list) => {
    (Array.isArray(list) ? list : []).forEach((item) => {
      const key = zehLexicalKey(item?.word);
      if (!key || seen.has(key) || out.length >= (max || ZEH_LEXICAL_LIST_MAX)) return;
      seen.add(key);
      out.push(item);
    });
  });
  return out;
}

/** 单字母拆分片段后的说明里出现这些词，说明它是真实的词形变化（复数 s、过去式 d 等） */
const ZEH_MEMORY_MORPH_GLOSS_RE =
  /复数|后缀|前缀|词尾|过去|分词|第三人称|所有格|比较级|最高级|名词|动词|形容词|副词|词性|变形|时态/;
/** a- / e- 是真实存在的单字母前缀：说明是这类意思时保留 */
const ZEH_MEMORY_LETTER_PREFIX_RE = /出|向外|外|无|不|非|否定|加强|朝|向|在.{0,3}上|使/;

/**
 * 旧词典助记的保守质量门（0.11.1）：只拒绝明显的垃圾，拿不准就保留。
 * 拒绝：硬拆单个字母的 "+" 拆分（a（一个）+ band、ban + k）、「字母 x 像…」、只重复拼写、
 * 极短（不足 6 个有效字符）、占位符、与释义完全相同。
 */
function zehIsUsefulMemoryTip(tip, term, meaning) {
  const text = zehCollapseText(typeof tip === "string" ? tip : "");
  if (!text) return false;
  if (/^(无|暂无|没有|略|空|待补充|待定|none|n\/a|null|undefined|todo|tbd|-+|\.+|…+)$/i.test(text)) {
    return false;
  }
  const meaningful = text.replace(/[\s\p{P}\p{S}]/gu, "");
  if (meaningful.length < 6) return false;
  const termLetters = String(term || "").toLowerCase().replace(/[^a-z]/g, "");
  if (!zehHasCjk(text) && termLetters && text.toLowerCase().replace(/[^a-z]/g, "") === termLetters) {
    return false;
  }
  if (meaning && zehCollapseText(meaning) === text) return false;
  if (
    termLetters.length > 2 &&
    /(字母\s*['"‘’“”]?[A-Za-z]['"‘’“”]?\s*(像|形似|形状|看起来))|(像\s*(个)?字母\s*['"‘’“”]?[A-Za-z](?![A-Za-z]))/.test(text)
  ) {
    return false;
  }
  if (/[+＋]/.test(text) && zehHasForcedLetterSplit(text)) return false;
  return true;
}

/** "+" 拆分里有没有被硬拆出来的单个字母（词尾的复数 s / 过去式 d / 后缀 y，以及 a- e- 前缀除外）。 */
function zehHasForcedLetterSplit(text) {
  const gloss = "(?:\\s*(?:（([^）]{0,20})）|\\(([^)]{0,20})\\)))?";
  const chain = new RegExp(
    `[A-Za-z][A-Za-z'-]*${gloss}(?:\\s*[+＋]\\s*[A-Za-z][A-Za-z'-]*${gloss})+`,
    "g"
  );
  const piece = new RegExp(`([A-Za-z][A-Za-z'-]*)${gloss}`, "g");
  let match;
  while ((match = chain.exec(text))) {
    const parts = [];
    let p;
    piece.lastIndex = 0;
    while ((p = piece.exec(match[0]))) parts.push({ word: p[1], gloss: p[2] || p[3] || "" });
    for (let i = 0; i < parts.length; i += 1) {
      const { word, gloss: g } = parts[i];
      if (word.length !== 1) continue;
      if (g && ZEH_MEMORY_MORPH_GLOSS_RE.test(g)) continue;
      const letter = word.toLowerCase();
      if (i === parts.length - 1 && i > 0 && (letter === "s" || letter === "d" || letter === "y")) continue;
      if (i === 0 && (letter === "a" || letter === "e") && g && ZEH_MEMORY_LETTER_PREFIX_RE.test(g)) {
        continue;
      }
      return true;
    }
  }
  return false;
}

/** 规范化 {memory_tip, memory_tip_type}：type=none 或未过质量门 → 空助记；未知类型丢掉类型。 */
function zehNormalizeMemoryTip(tip, type, term, meaning) {
  const cleanType = ZEH_MEMORY_TIP_TYPES.includes(type) ? type : "";
  const text = zehClipCacheString(zehCollapseText(typeof tip === "string" ? tip : ""), 300);
  if (cleanType === "none" || !zehIsUsefulMemoryTip(text, term, meaning)) {
    return { memory_tip: "", memory_tip_type: text ? "none" : cleanType === "none" ? "none" : "" };
  }
  return { memory_tip: text, memory_tip_type: cleanType };
}

/**
 * 语境增强的终态消息（每个请求方各一条）。失败时 ok:false，页面保留已显示的基础结果。
 * @param {{status: "ok"|"fallback"|"error", result?: object, error?: Error}} outcome
 */
function zehContextEnhancedMessage(outcome, ctx) {
  const { queryId = null, contextHash = "" } = ctx || {};
  const enhancement = outcome?.status === "ok" ? outcome.result?.enhancement : null;
  if (enhancement) {
    const result = outcome.result;
    return {
      type: "CONTEXT_ENHANCED",
      queryId,
      contextHash,
      ok: true,
      data: enhancement,
      durationMs: result.durationMs,
      providerName: result.providerName,
      modelName: result.modelName,
    };
  }
  const reason =
    outcome?.status === "error" && outcome.error?.code === ZEH_LOOKUP_TIMEOUT_CODE
      ? "timeout"
      : outcome?.status === "error" && outcome.error?.code !== "CONTEXT_UNPARSEABLE"
        ? "error"
        : "unparseable";
  return { type: "CONTEXT_ENHANCED", queryId, contextHash, ok: false, reason };
}

/** 生词本里语境相关字段的类型与长度上限（后台写入前统一清洗，旧条目不受影响）。 */
const ZEH_VOCAB_CONTEXT_STRING_LIMITS = {
  context_sentence: ZEH_CONTEXT_LIMITS.sentence,
  meaning_here: 600,
  pos_here: 60,
  sentence_translation: 600,
  pageTitle: 300,
};

const ZEH_VOCAB_BOOK_STRING_LIMITS = { id: 120, title: 300, author: 200, chapterTitle: 300, cfi: 600 };

const ZEH_VOCAB_PDF_STRING_LIMITS = { title: 300, fileName: 200 };

/** 生词本里的 PDF 来源 { title?, fileName?, page?, url? }；无效时返回 null */
function zehSanitizeVocabPdf(pdf) {
  if (!pdf || typeof pdf !== "object" || Array.isArray(pdf)) return null;
  const clean = {};
  Object.entries(ZEH_VOCAB_PDF_STRING_LIMITS).forEach(([key, max]) => {
    if (typeof pdf[key] === "string" && zehCollapseText(pdf[key])) {
      clean[key] = zehCollapseText(pdf[key]).slice(0, max);
    }
  });
  if (Number.isInteger(pdf.page) && pdf.page >= 1 && pdf.page <= 100000) clean.page = pdf.page;
  const url = zehSanitizePdfSourceUrl(pdf.url);
  if (url) clean.url = url;
  return Object.keys(clean).length ? clean : null;
}

/** 只去掉控制字符并合并空白（不做 NFKC，保留中文全角标点）。 */
function zehCollapseText(text) {
  return String(text || "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function zehSanitizeVocabContextFields(item) {
  if (!item || typeof item !== "object") return item;
  const out = { ...item };
  Object.entries(ZEH_VOCAB_CONTEXT_STRING_LIMITS).forEach(([key, max]) => {
    if (!(key in out)) return;
    const value = typeof out[key] === "string" ? zehCollapseText(out[key]).slice(0, max) : "";
    if (value) out[key] = value;
    else delete out[key];
  });
  if ("sourceType" in out && !ZEH_CONTEXT_SOURCE_TYPES.includes(out.sourceType)) {
    delete out.sourceType;
  }
  // 0.11.1 词汇字段：派生词 / 同义词结构化限长；单词 / 短语的助记过质量门，类型白名单
  ["derivatives", "synonyms"].forEach((field) => {
    if (!(field in out)) return;
    const list =
      field === "derivatives"
        ? zehSanitizeDerivatives(out[field], out.term)
        : zehSanitizeSynonyms(out[field], out.term);
    if (list.length) out[field] = list;
    else delete out[field];
  });
  const lexicalType = !out.queryType || out.queryType === "word" || out.queryType === "phrase";
  if (lexicalType && ("memory_tip" in out || "memory_tip_type" in out)) {
    const tip = zehNormalizeMemoryTip(out.memory_tip, out.memory_tip_type, out.term, out.short_meaning);
    out.memory_tip = tip.memory_tip;
    if (tip.memory_tip && tip.memory_tip_type) out.memory_tip_type = tip.memory_tip_type;
    else delete out.memory_tip_type;
  } else if ("memory_tip_type" in out) {
    delete out.memory_tip_type;
  }
  if ("book" in out) {
    const book = out.book;
    if (!book || typeof book !== "object" || Array.isArray(book)) {
      delete out.book;
    } else {
      const clean = {};
      Object.entries(ZEH_VOCAB_BOOK_STRING_LIMITS).forEach(([key, max]) => {
        if (typeof book[key] === "string" && zehCollapseText(book[key])) {
          clean[key] = zehCollapseText(book[key]).slice(0, max);
        }
      });
      if (Number.isInteger(book.chapterIndex) && book.chapterIndex >= 0) {
        clean.chapterIndex = book.chapterIndex;
      }
      if (Object.keys(clean).length) out.book = clean;
      else delete out.book;
    }
  }
  if ("pdf" in out) {
    const pdf = zehSanitizeVocabPdf(out.pdf);
    if (pdf) out.pdf = pdf;
    else delete out.pdf;
  }
  return out;
}

function zehDefaultTheme() {
  return {
    ballStart: "#e4a72f",
    ballEnd: "#d83424",
    headerStart: "#d83424",
    headerEnd: "#a82018",
    accent: "#d83424",
  };
}

function zehFormatLocalTime(ts) {
  try {
    return new Date(ts).toLocaleString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return String(ts);
  }
}

/** 阅读进度 0~1 → 百分比字符串，保留两位小数 */
function zehFormatProgressPct(progress) {
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  if (p <= 0) return "0.00%";
  const pct = p * 100;
  if (pct > 0 && pct < 0.01) return "0.01%";
  return `${pct.toFixed(2)}%`;
}

// ─── 选区文本工具（content.js / reader 共用，通过 mk-lookup.js）────────────────

/** 弯引号 / 其他撇号变体 → ASCII `'` */
const ZEH_APOSTROPHE_RE =
  /[\u2018\u2019\u201A\u201B\u2032\u2035\u0060\u00B4\u02BC\u02B9\uFF07\u275C\u05F3]/g;

/** 缩略词 → 展开式（用于词典别名查找；展开式取较常见的一种） */
const ZEH_CONTRACTION_EXPANDED = {
  "i'm": "i am",
  "you're": "you are",
  "we're": "we are",
  "they're": "they are",
  "he's": "he is",
  "she's": "she is",
  "it's": "it is",
  "that's": "that is",
  "there's": "there is",
  "what's": "what is",
  "who's": "who is",
  "where's": "where is",
  "when's": "when is",
  "why's": "why is",
  "how's": "how is",
  "here's": "here is",
  "don't": "do not",
  "doesn't": "does not",
  "didn't": "did not",
  "can't": "cannot",
  "couldn't": "could not",
  "won't": "will not",
  "wouldn't": "would not",
  "shouldn't": "should not",
  "mustn't": "must not",
  "isn't": "is not",
  "aren't": "are not",
  "wasn't": "was not",
  "weren't": "were not",
  "hasn't": "has not",
  "haven't": "have not",
  "hadn't": "had not",
  "i've": "i have",
  "you've": "you have",
  "we've": "we have",
  "they've": "they have",
  "i'll": "i will",
  "you'll": "you will",
  "he'll": "he will",
  "she'll": "she will",
  "we'll": "we will",
  "they'll": "they will",
  "it'll": "it will",
  "that'll": "that will",
  "i'd": "i would",
  "you'd": "you would",
  "he'd": "he would",
  "she'd": "she would",
  "we'd": "we would",
  "they'd": "they would",
  "it'd": "it would",
  "let's": "let us",
};

const ZEH_EXPANDED_CONTRACTION = Object.create(null);
for (const [contraction, expanded] of Object.entries(ZEH_CONTRACTION_EXPANDED)) {
  if (!ZEH_EXPANDED_CONTRACTION[expanded]) {
    ZEH_EXPANDED_CONTRACTION[expanded] = contraction;
  }
}

/**
 * 漏写撇号时不能盲目映射的 bare 形（本身是独立词条，如 wont≠won't、its≠it's）。
 * 未列入者若去掉撇号后等于某缩略词，则视为漏撇号 typo → 标准缩略形。
 */
const ZEH_BARE_CONTRACTION_AMBIGUOUS = new Set([
  "im",
  "youre",
  "were",
  "theyre",
  "hes",
  "shes",
  "its",
  "theres",
  "cant",
  "wont",
  "wouldnt",
  "arent",
  "ill",
  "hell",
  "shell",
  "well",
  "id",
  "shed",
  "wed",
  "lets",
]);

const ZEH_BARE_CONTRACTION_ALIAS = Object.create(null);
for (const contraction of Object.keys(ZEH_CONTRACTION_EXPANDED)) {
  const bare = contraction.replace(/'/g, "");
  if (bare === contraction || ZEH_BARE_CONTRACTION_AMBIGUOUS.has(bare)) continue;
  ZEH_BARE_CONTRACTION_ALIAS[bare] = contraction;
}

function zehNormalizeApostrophe(text) {
  return String(text || "").replace(ZEH_APOSTROPHE_RE, "'");
}

/**
 * 纠正撇号位置错误：i'am / I'am / you'are → i'm / you're
 * 去掉撇号后若等于某缩略词展开式（去空格），则映射到该缩略词。
 */
function zehFixMisplacedContractionApostrophe(key) {
  if (!key || !key.includes("'")) return null;
  const parts = key.split("'");
  if (parts.length !== 2) return null;
  const [left, right] = parts;
  if (!left || !right) return null;
  const joined = left + right;
  for (const [contraction, expanded] of Object.entries(ZEH_CONTRACTION_EXPANDED)) {
    if (expanded.replace(/\s+/g, "") === joined) {
      return contraction;
    }
  }
  return null;
}

/** 漏写撇号：dont / Dont → don't（不处理 wont/its 等歧义词） */
function zehFixMissingContractionApostrophe(key) {
  if (!key || key.includes("'")) return null;
  return ZEH_BARE_CONTRACTION_ALIAS[key] || null;
}

function zehTitleCaseToken(token) {
  if (!token) return token;
  return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
}

/**
 * 大小写变体：全小写 / 全大写 / 首字母大写（其余小写）。
 * 词典 key 虽多为小写，仍作为未命中时的兜底尝试；多词短语按词分别变换。
 */
function zehCaseLookupKeyVariants(text) {
  const base = zehNormalizeLookupKey(text);
  if (!base) return [];

  const parts = base.split(" ").filter(Boolean);
  if (!parts.length) return [];

  const lower = parts.join(" ");
  const upper = parts.map((p) => p.toUpperCase()).join(" ");
  const title = parts.map((p) => zehTitleCaseToken(p)).join(" ");

  return [...new Set([lower, upper, title])];
}

/** 查词 key：统一引号、NFKC、空白、小写 */
function zehNormalizeLookupKey(text) {
  return zehNormalizeApostrophe(String(text || ""))
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** 是否 Manekilex 品牌彩蛋查询（manekilex / maneki / 常见拼写等） */
function zehIsManekilexTerm(text) {
  const key = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (!key) return false;
  if (key === "manekilex" || key === "makenilex" || key === "manekile" || key === "manekil") {
    return true;
  }
  if (key.startsWith("maneki") && key.length >= 5 && key.length <= 11) return true;
  if (key.startsWith("manekil") && key.length >= 7 && key.length <= 11) return true;
  return false;
}

/** 缓存 / 去重用的 canonical key（优先缩略词，与 wordfreq 词典 key 一致） */
function zehCanonicalLookupKey(text) {
  const key = zehNormalizeLookupKey(text);
  const misplaced = zehFixMisplacedContractionApostrophe(key);
  if (misplaced) return misplaced;
  const missing = zehFixMissingContractionApostrophe(key);
  if (missing) return missing;
  return ZEH_EXPANDED_CONTRACTION[key] || key;
}

/** 词典查找依次尝试的 key（去重，canonical 优先） */
function zehLookupKeyVariants(text) {
  const key = zehNormalizeLookupKey(text);
  const misplaced = zehFixMisplacedContractionApostrophe(key);
  const missing = zehFixMissingContractionApostrophe(key);
  const canonical = zehCanonicalLookupKey(text);
  const variants = [canonical, key];
  if (misplaced) variants.push(misplaced);
  if (missing) variants.push(missing);

  const expandedFromCanonical = ZEH_CONTRACTION_EXPANDED[canonical];
  if (expandedFromCanonical) {
    variants.push(expandedFromCanonical);
  }
  const expandedFromKey = ZEH_CONTRACTION_EXPANDED[key];
  if (expandedFromKey) {
    variants.push(expandedFromKey);
  }
  const contractionFromKey = ZEH_EXPANDED_CONTRACTION[key];
  if (contractionFromKey) {
    variants.push(contractionFromKey);
  }

  for (const caseKey of zehCaseLookupKeyVariants(text)) {
    variants.push(caseKey);
  }

  return [...new Set(variants.filter(Boolean))];
}

function zehHasEnglish(text) {
  return /[a-zA-Z]/.test(text || "");
}

/** 代码块里的一行：去掉行首注释符（// # * /* -- ; <!--）和行尾 *\/ -->，剩下的才是要判断的文字。 */
function zehStripCodeCommentMarkers(line) {
  return String(line || "")
    .replace(/^\s*(?:\/\/+|\/\*+|\*+|#+(?!include|define|import)|--|;+|<!--)\s*/, "")
    .replace(/\s*(?:\*\/|-->)\s*$/, "")
    .trim();
}

/**
 * 代码块里的一行是不是代码（是代码 → 不发语境，按代码词查）。只看明显的代码信号；
 * 判断不了的普通英文句子（The bank approved my loan.）返回 false。
 */
function zehLooksLikeCodeLine(line) {
  const t = String(line || "").trim();
  if (!t) return true;
  if (zehCountEnglishWords(t) < 3) return true;
  if (/[{};]\s*$/.test(t) || /^[{}\])]/.test(t)) return true;
  if (/=>|===?|!==?|&&|\|\||::|->|<\/?[A-Za-z][\w-]*[\s>]/.test(t)) return true;
  if (/[\w\])]\s*[-+*/%|&]?=\s*\S/.test(t)) return true;
  if (/[A-Za-z_$][\w$]*\(/.test(t)) return true;
  if (/\b[A-Za-z_$][\w$]+\.[A-Za-z_$][\w$]+\b/.test(t)) return true;
  if (/\b[a-z]+[A-Z][A-Za-z0-9]*\b|\b[A-Za-z0-9]+_[A-Za-z0-9_]+\b/.test(t)) return true;
  if (
    /^(?:const|let|var|def|function|import|export|package|using|namespace|public|private|protected|static|async|await|fn|func|elif|#include|#define|SELECT|INSERT|UPDATE|DELETE)\b/.test(t)
  ) {
    return true;
  }
  const symbols = (t.match(/[{}[\]()<>=;$&|\\`^~]/g) || []).length;
  return symbols / t.length > 0.08;
}

/**
 * 规范化最终查询文本：trim、合并空白、去掉首尾标点（保留词中的连字符/单引号）。
 */
function zehNormalizeLookupText(text) {
  let t = zehNormalizeApostrophe(String(text || ""))
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
  t = t.replace(/^[^a-zA-Z0-9]+/, "").replace(/[^a-zA-Z0-9]+$/, "");
  return t;
}
