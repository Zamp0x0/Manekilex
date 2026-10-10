/**
 * dictionary_core.json 词条 schema（与 API 划词 JSON 对齐，forms/enriched 为本地扩展字段）
 */
"use strict";

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

function createEmptyApiEntry(term) {
  return {
    term,
    phonetic: "",
    part_of_speech: "",
    short_meaning: "",
    context_meaning: "",
    examples: [],
    memory_tip: "",
    common_collocations: [],
    forms: { ...EMPTY_FORMS },
    enriched: false,
  };
}

function isEnrichedEntry(entry) {
  if (!entry) return false;
  if (entry.enriched === true) return true;
  const examples = Array.isArray(entry.examples) ? entry.examples : [];
  const memoryTip = String(entry.memory_tip || "").trim();
  const short = String(entry.short_meaning || "").trim();
  return !!(
    examples.length > 0 &&
    examples.every((e) => e && String(e.en || "").trim() && String(e.zh || "").trim()) &&
    memoryTip &&
    /[\u4e00-\u9fff]/.test(memoryTip) &&
    short &&
    /[\u4e00-\u9fff]/.test(short)
  );
}

function hasCjk(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ""));
}

function normalizeLookupTerm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/['']/g, "'")
    .replace(/\s+/g, " ");
}

function termsAlignWithKey(key, term) {
  const a = normalizeLookupTerm(key);
  const b = normalizeLookupTerm(term);
  if (!b) return true;
  if (a === b) return true;
  if (a.replace(/\./g, "") === b.replace(/\./g, "")) return true;
  if (a.replace(/'/g, "") === b.replace(/'/g, "")) return true;
  return false;
}

function exampleMentionsTerm(exampleEn, term) {
  const en = String(exampleEn || "").toLowerCase();
  const t = normalizeLookupTerm(term);
  if (!en || !t) return false;
  if (en.includes(t)) return true;
  const parts = t.split(" ");
  if (parts.length > 1 && parts.every((p) => en.includes(p))) return true;
  if (t.length >= 4 && en.includes(t.slice(0, Math.max(3, t.length - 1)))) return true;
  return false;
}

function pickChinese(...candidates) {
  for (const c of candidates) {
    const t = String(c || "").trim();
    if (t && hasCjk(t)) return t;
  }
  for (const c of candidates) {
    const t = String(c || "").trim();
    if (t) return t;
  }
  return "";
}

function shouldPreferAiShortMeaning(existing) {
  const s = String(existing || "").trim();
  if (!s || !hasCjk(s)) return true;
  if (s.length > 55) return true;
  if (/\\r|\\n/.test(s)) return true;
  if ((s.match(/；/g) || []).length >= 4) return true;
  return false;
}

/** 将 DeepSeek 返回的 word JSON 合并进词典条目（与 runtime normalizeDictEntry 对齐） */
function mergeEnrichIntoEntry(existing, apiParsed, key) {
  const base = existing && typeof existing === "object" ? existing : createEmptyApiEntry(key);
  const parsed = apiParsed && typeof apiParsed === "object" ? apiParsed : {};
  const canonicalTerm = String(key).trim() || key;
  const useParsedContent = termsAlignWithKey(key, parsed.term);

  const examples = useParsedContent && Array.isArray(parsed.examples)
    ? parsed.examples
        .slice(0, 2)
        .map((e) => ({
          en: String(e?.en || "").trim(),
          zh: String(e?.zh || "").trim(),
        }))
        .filter((e) => e.en && e.zh && hasCjk(e.zh))
    : Array.isArray(base.examples)
      ? base.examples
          .slice(0, 2)
          .map((e) => ({
            en: String(e?.en || "").trim(),
            zh: String(e?.zh || "").trim(),
          }))
          .filter(
            (e) =>
              e.en &&
              e.zh &&
              hasCjk(e.zh) &&
              exampleMentionsTerm(e.en, canonicalTerm)
          )
      : [];

  const memoryTip = useParsedContent ? String(parsed.memory_tip || "").trim() : "";
  const collocations =
    useParsedContent && Array.isArray(parsed.common_collocations)
      ? parsed.common_collocations.map((c) => String(c || "").trim()).filter(Boolean).slice(0, 4)
      : [];

  const shortMeaning = shouldPreferAiShortMeaning(base.short_meaning)
    ? pickChinese(parsed.short_meaning, base.short_meaning)
    : pickChinese(base.short_meaning, parsed.short_meaning);
  let contextMeaning = useParsedContent ? pickChinese(parsed.context_meaning) : "";
  if (contextMeaning && contextMeaning === shortMeaning) {
    contextMeaning = "";
  }

  const merged = {
    term: canonicalTerm,
    phonetic: String(
      (useParsedContent ? parsed.phonetic : "") || base.phonetic || ""
    ).trim(),
    part_of_speech: String(
      (useParsedContent ? parsed.part_of_speech : "") || base.part_of_speech || ""
    ).trim(),
    short_meaning: shortMeaning,
    context_meaning: contextMeaning,
    examples,
    memory_tip: hasCjk(memoryTip) ? memoryTip : "",
    common_collocations: collocations,
    forms:
      base.forms && typeof base.forms === "object"
        ? { ...EMPTY_FORMS, ...base.forms }
        : { ...EMPTY_FORMS },
    enriched: false,
  };

  merged.enriched = isEnrichedEntry(merged);
  return merged;
}

/**
 * 强行补全：在 merge 基础上用 API 片段 + 已有 ECDICT 中文兜底，保证 enriched: true
 * 用于 fail 重试；例句/记忆仍尽量来自模型，不造英文例句
 */
function forceFillEntry(existing, apiParsed, key) {
  const merged = mergeEnrichIntoEntry(existing, apiParsed, key);
  const parsed = apiParsed && typeof apiParsed === "object" ? apiParsed : {};
  const term = String(key).trim() || key;
  merged.term = term;
  const useParsedContent = termsAlignWithKey(key, parsed.term);

  if (!useParsedContent) {
    merged.context_meaning = "";
    merged.common_collocations = [];
    merged.examples = merged.examples.filter((e) => exampleMentionsTerm(e.en, term));
    if (merged.short_meaning) {
      merged.memory_tip = `「${term}」→ ${merged.short_meaning.split("；")[0].slice(0, 24)}`;
    }
  }

  if (!hasCjk(merged.short_meaning)) {
    merged.short_meaning = pickChinese(
      useParsedContent ? parsed.short_meaning : "",
      useParsedContent ? parsed.context_meaning : "",
      existing?.short_meaning,
      ...(useParsedContent && Array.isArray(parsed.examples)
        ? parsed.examples.map((e) => e?.zh)
        : []),
      useParsedContent ? parsed.memory_tip : ""
    );
  }

  if (!merged.examples.length) {
    const fromApi = (useParsedContent && Array.isArray(parsed.examples) ? parsed.examples : [])
      .map((e) => ({ en: String(e?.en || "").trim(), zh: String(e?.zh || "").trim() }))
      .filter((e) => e.en && e.zh && hasCjk(e.zh));
    if (fromApi.length) merged.examples = fromApi.slice(0, 2);
  }

  if (!hasCjk(merged.memory_tip)) {
    const tip = useParsedContent ? String(parsed.memory_tip || "").trim() : "";
    if (hasCjk(tip)) {
      merged.memory_tip = tip;
    } else if (merged.short_meaning) {
      merged.memory_tip = `「${term}」→ ${merged.short_meaning.split("；")[0].slice(0, 24)}`;
    }
  }

  if (!merged.context_meaning && useParsedContent && hasCjk(parsed.context_meaning)) {
    let ctx = String(parsed.context_meaning).trim();
    if (ctx !== merged.short_meaning) merged.context_meaning = ctx;
  }

  if (
    !merged.common_collocations.length &&
    useParsedContent &&
    Array.isArray(parsed.common_collocations)
  ) {
    merged.common_collocations = parsed.common_collocations
      .map((c) => String(c || "").trim())
      .filter(Boolean)
      .slice(0, 4);
  }

  if (!merged.phonetic && useParsedContent && parsed.phonetic) {
    merged.phonetic = String(parsed.phonetic).trim();
  }
  if (!merged.part_of_speech && useParsedContent && parsed.part_of_speech) {
    merged.part_of_speech = String(parsed.part_of_speech).trim();
  }

  merged.examples = merged.examples.filter(
    (e) => exampleMentionsTerm(e.en, term) || term.split(/\s+/).length > 1
  );

  merged.enriched = true;
  return merged;
}

/** 旧 ECDICT 格式 → API 对齐格式 */
function legacyToApiEntry(entry, key) {
  if (
    entry &&
    typeof entry.term === "string" &&
    entry.short_meaning !== undefined &&
    !entry.word &&
    !entry.meaning_cn
  ) {
    return normalizeApiEntry(entry, key);
  }

  const short = String(entry?.short_meaning || entry?.meaning_cn || "").trim();
  let context = String(entry?.context_meaning || entry?.simple_explanation_cn || "").trim();
  if (!context || context === short) {
    context = "";
  }

  const partOfSpeech =
    typeof entry?.part_of_speech === "string"
      ? entry.part_of_speech
      : Array.isArray(entry?.pos)
        ? entry.pos.join(", ")
        : "";

  const examples = Array.isArray(entry?.examples) ? entry.examples : [];
  const memoryTip = String(entry?.memory_tip || entry?.memory_tip_cn || "").trim();
  const collocations = Array.isArray(entry?.common_collocations)
    ? entry.common_collocations
    : Array.isArray(entry?.collocations)
      ? entry.collocations
      : [];

  const normalized = {
    term: String(entry?.term || entry?.word || key).trim() || key,
    phonetic: String(entry?.phonetic || "").trim(),
    part_of_speech: partOfSpeech,
    short_meaning: short,
    context_meaning: context,
    examples,
    memory_tip: memoryTip,
    common_collocations: collocations,
    forms:
      entry?.forms && typeof entry.forms === "object"
        ? { ...EMPTY_FORMS, ...entry.forms }
        : { ...EMPTY_FORMS },
    enriched: isEnrichedEntry({
      term: String(entry?.term || entry?.word || key).trim() || key,
      short_meaning: short,
      context_meaning: context,
      examples,
      memory_tip: memoryTip,
      enriched: entry?.enriched,
    }),
  };

  return normalized;
}

function normalizeApiEntry(entry, key) {
  const short = String(entry.short_meaning || "").trim();
  let context = String(entry.context_meaning || "").trim();
  if (!context || context === short) {
    context = "";
  }

  const examples = Array.isArray(entry.examples) ? entry.examples : [];
  const memoryTip = String(entry.memory_tip || "").trim();

  return {
    term: String(entry.term || key).trim() || key,
    phonetic: String(entry.phonetic || "").trim(),
    part_of_speech: String(entry.part_of_speech || "").trim(),
    short_meaning: short,
    context_meaning: context,
    examples,
    memory_tip: memoryTip,
    common_collocations: Array.isArray(entry.common_collocations)
      ? entry.common_collocations
      : [],
    forms:
      entry.forms && typeof entry.forms === "object"
        ? { ...EMPTY_FORMS, ...entry.forms }
        : { ...EMPTY_FORMS },
    enriched: isEnrichedEntry({
      term: String(entry.term || key).trim() || key,
      short_meaning: short,
      context_meaning: context,
      examples,
      memory_tip: memoryTip,
      enriched: entry.enriched,
    }),
  };
}

module.exports = {
  EMPTY_FORMS,
  createEmptyApiEntry,
  legacyToApiEntry,
  normalizeApiEntry,
  termsAlignWithKey,
  isEnrichedEntry,
  mergeEnrichIntoEntry,
  forceFillEntry,
  termsAlignWithKey,
};
