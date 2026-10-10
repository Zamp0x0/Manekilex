/**
 * Service worker 模块：本地词典（data/dictionary_core.json）。
 *
 * 由 background.js 的 importScripts 列表加载。本文件只声明，加载时不调用任何 chrome API，也不加载词典：
 * 词典在第一次需要时才 fetch（R-04），失败不缓存、下次重试。
 * 依赖：config.js（zehLookupKeyVariants 等词头规范化、zehNormalizeWordResult、zehUsesDictionary）。
 * 内存状态（_dictMap、_dictFormIndex、_dictKeyList 及加载中的 Promise）在 worker 重启后丢失，
 * 下次查词时重新加载。
 */

// ─── 本地词典（从 data/dictionary_core.json 异步加载）────────────────────────
// 按需加载（R-04）：service worker 启动时不再预热；加载失败不缓存，下次调用重试
let _dictMap = null;
let _dictFormIndex = null;
let _dictKeyList = null;
let _zehDictionaryRaw = null;
let _zehDictionaryLoadPromise = null;
let _dictMapLoadPromise = null;

function buildDictFormIndex(map) {
  const index = new Map();
  for (const [key, entry] of map) {
    const forms = entry?.forms;
    if (!forms || typeof forms !== "object") continue;
    for (const formVal of Object.values(forms)) {
      const formKey = String(formVal || "")
        .trim()
        .toLowerCase();
      if (!formKey || formKey === key || index.has(formKey)) continue;
      index.set(formKey, entry);
    }
  }
  return index;
}

/** 加载 dictionary_core.json 原始对象；失败时 throw，且不缓存失败结果 */
async function zehLoadDictionary() {
  if (_zehDictionaryRaw !== null) return _zehDictionaryRaw;
  if (_zehDictionaryLoadPromise) return _zehDictionaryLoadPromise;

  _zehDictionaryLoadPromise = (async () => {
    try {
      const url = chrome.runtime.getURL("data/dictionary_core.json");
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to load dictionary_core.json: ${res.status}`);
      }
      const data = await res.json();
      if (!data || typeof data !== "object" || Array.isArray(data)) {
        throw new Error("dictionary_core.json is not an object");
      }
      _zehDictionaryRaw = data;
      return _zehDictionaryRaw;
    } finally {
      _zehDictionaryLoadPromise = null;
    }
  })();

  return _zehDictionaryLoadPromise;
}

/**
 * 词典 Map 缓存（仅 word/phrase 查词与划词 repair 使用）；内部调用 zehLoadDictionary。
 * 失败时返回空 Map 但不缓存，下一次调用会重新加载。
 */
async function loadDictionaryOnce() {
  if (_dictMap !== null) return _dictMap;
  if (_dictMapLoadPromise) return _dictMapLoadPromise;

  _dictMapLoadPromise = (async () => {
    try {
      const data = await zehLoadDictionary();
      const map = new Map(Object.entries(data));
      _dictFormIndex = buildDictFormIndex(map);
      _dictMap = map;
      zehDebugLog("[ZEH dict] loaded", map.size, "entries");
      return _dictMap;
    } catch (err) {
      console.warn("[Manekilex] dictionary load failed; will retry on next use", err);
      return new Map();
    } finally {
      _dictMapLoadPromise = null;
    }
  })();

  return _dictMapLoadPromise;
}

/** GET_DICT_KEY_LIST 的 key 数组：加载成功后复用同一份，不在每次请求时重建 */
async function getDictionaryKeyList() {
  const map = await loadDictionaryOnce();
  if (!map.size) return null;
  if (!_dictKeyList) _dictKeyList = [...map.keys()];
  return _dictKeyList;
}

/**
 * 去除重音符号：naïve → naive，café → cafe
 * 只去掉 combining diacritics，保留连字符、单引号等。
 */
function stripDiacritics(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

async function getDictionaryEntry(text) {
  if (!text) return null;

  const special = getManekilexSpecialEntry(text);
  if (special) return special;

  try {
    const map = await loadDictionaryOnce();
    const keys = zehLookupKeyVariants(text);

    for (const key of keys) {
      const hit = map.get(key) || map.get(stripDiacritics(key));
      if (hit) return hit;
    }

    if (_dictFormIndex) {
      for (const key of keys) {
        const hit = _dictFormIndex.get(key);
        if (hit) return hit;
      }
    }
  } catch (err) {
    console.warn("[Manekilex] dictionary lookup failed", err);
  }
  return null;
}

// forms 的空值模板（与 build-dictionary.js 保持一致）
const EMPTY_FORMS = {
  past: "",
  past_participle: "",
  plural: "",
  third_person: "",
  ing: "",
  comparative: "",
  superlative: "",
  lemma: "",
};

/**
 * 将 dictionary_core.json 格式转换为 UI render 所需格式
 * 避免修改 renderWordResult 等现有函数
 */
/**
 * 本地 special entry：Manekilex 品牌词（不写入 dictionary_core.json）
 */
function getManekilexSpecialEntry(text) {
  if (!zehIsManekilexTerm(text)) return null;

  return {
    term: "Manekilex",
    word: "Manekilex",
    phonetic: "",
    part_of_speech: "",
    short_meaning: "Zamp开发的一款ai翻译/阅读/实时语音转写Chrome插件",
    context_meaning: "",
    examples: [],
    memory_tip: "",
    common_collocations: [],
    forms: { ...EMPTY_FORMS },
    source: "special",
    specialEntry: true,
    queryType: "word",
  };
}

function normalizeDictEntry(entry, term) {
  const isSpecial = entry?.specialEntry === true || entry?.source === "special";
  const shortMeaning = entry.short_meaning ?? entry.meaning_cn ?? "";
  const rawContext = entry.context_meaning ?? entry.simple_explanation_cn ?? "";
  const contextMeaning =
    rawContext && rawContext !== shortMeaning ? rawContext : "";

  const partOfSpeech =
    typeof entry.part_of_speech === "string"
      ? entry.part_of_speech
      : Array.isArray(entry.pos) && entry.pos.length > 0
        ? entry.pos.join(", ")
        : "";

  return {
    term: entry.term || entry.word || term,
    phonetic: entry.phonetic || "",
    part_of_speech: zehNormalizePartOfSpeech(partOfSpeech),
    short_meaning: shortMeaning,
    context_meaning: contextMeaning,
    examples: Array.isArray(entry.examples) ? entry.examples : [],
    // 旧词典助记先过质量门：明显无效的（硬拆字母等）不显示，留给语境增强补上（0.11.1）
    memory_tip: zehNormalizeMemoryTip(
      entry.memory_tip ?? entry.memory_tip_cn ?? "",
      entry.memory_tip_type,
      entry.term || entry.word || term,
      shortMeaning
    ).memory_tip,
    common_collocations:
      entry.common_collocations ??
      (Array.isArray(entry.collocations) ? entry.collocations : []),
    forms: entry.forms && typeof entry.forms === "object" ? entry.forms : { ...EMPTY_FORMS },
    queryType: "word",
    source: isSpecial ? "special" : "dictionary",
    specialEntry: isSpecial,
  };
}

function mergeDictionaryAndAIResult(dictEntry, aiResult) {
  const merged = {
    term: aiResult.term || dictEntry.term,
    phonetic: dictEntry.phonetic || aiResult.phonetic || "",
    part_of_speech: dictEntry.part_of_speech || aiResult.part_of_speech || "",
    short_meaning: zehPickChineseMeaning(aiResult.short_meaning, dictEntry.short_meaning),
    context_meaning: zehPickChineseMeaning(aiResult.context_meaning, dictEntry.context_meaning) || "",
    examples:
      aiResult.examples && aiResult.examples.length > 0
        ? aiResult.examples
        : dictEntry.examples || [],
    memory_tip: zehPickChineseMeaning(aiResult.memory_tip, dictEntry.memory_tip) || "",
    memory_tip_type: aiResult.memory_tip ? aiResult.memory_tip_type : undefined,
    derivatives: aiResult.derivatives,
    synonyms: aiResult.synonyms,
    common_collocations:
      aiResult.common_collocations && aiResult.common_collocations.length > 0
        ? aiResult.common_collocations
        : dictEntry.common_collocations || [],
    forms: dictEntry.forms || aiResult.forms || { ...EMPTY_FORMS },
    queryType: aiResult.queryType || dictEntry.queryType,
    source: "openai",
  };
  if (merged.memory_tip_type === undefined) delete merged.memory_tip_type;
  if (merged.derivatives === undefined) delete merged.derivatives;
  if (merged.synonyms === undefined) delete merged.synonyms;
  if (zehIsMostlyLatin(aiResult.short_meaning) || zehIsMostlyLatin(aiResult.context_meaning)) {
    const enParts = [aiResult.short_meaning, aiResult.context_meaning].filter((t) => zehIsMostlyLatin(t));
    if (enParts.length) merged.english_gloss = enParts.join("；");
  }
  return zehNormalizeWordResult(merged);
}

/**
 * 是否应查本地词典：仅 word / phrase。
 * Cache 永远先查，不受此函数影响。
 */
function shouldUseDictionary(queryType) {
  return typeof zehUsesDictionary === "function"
    ? zehUsesDictionary(queryType)
    : queryType === "word" || queryType === "phrase";
}
