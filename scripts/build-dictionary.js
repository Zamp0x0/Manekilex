#!/usr/bin/env node
/**
 * scripts/build-dictionary.js
 *
 * 从以下来源生成 data/dictionary_core.json：
 *   dic/google-10000-english-usa.txt  （取前 GOOGLE_LIMIT 行）
 *   dic/The_Oxford_3000.txt
 *   dic/manual-core-words.txt          （手动补充核心学习词，可选）
 *   dic/wordfreq-en-25000-log.json （25000 高频词，JSON 数组）
 *   dic/ecdict.csv                     （流式解析，只保留白名单词）
 *
 * 输出格式（与 API 划词 JSON 对齐，forms/enriched 为本地扩展）：
 *   { term, phonetic, part_of_speech, short_meaning, context_meaning,
 *     examples[], memory_tip, common_collocations[], forms{}, enriched }
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse");

const { createEmptyApiEntry } = require("./dictionary-schema");
const { assertSafeToOverwrite, writeDictionaryAtomic } = require("./dictionary-file");

// ── 路径配置 ─────────────────────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, "..");
const GOOGLE_TXT = path.join(ROOT, "dic", "google-10000-english-usa.txt");
const OXFORD_TXT = path.join(ROOT, "dic", "The_Oxford_3000.txt");
const MANUAL_TXT = path.join(ROOT, "dic", "manual-core-words.txt");
const WORDFREQ_JSON = path.join(ROOT, "dic", "wordfreq-en-25000-log.json");
const ECDICT_CSV = path.join(ROOT, "dic", "ecdict.csv");
const OUT_DIR = path.join(ROOT, "data");
const OUT_FILE = path.join(OUT_DIR, "dictionary_core.json");

const GOOGLE_LIMIT = 8000;
/** 目标文件已含 enriched 数据时拒绝重建，除非显式给出该开关（会先写备份） */
const FORCE_OVERWRITE_FLAG = "--force-overwrite";
const forceOverwrite = process.argv.includes(FORCE_OVERWRITE_FLAG);
const MAX_MEANING_LEN = 80;
const MAX_DEFINITION_LEN = 160;
const SIZE_WARN_MB = 12;

// ── 词性映射表 ────────────────────────────────────────────────────────────────
const POS_MAP = {
  prep: "preposition",
  adv: "adverb",
  adj: "adjective",
  a: "adjective",
  n: "noun",
  v: "verb",
  vt: "transitive verb",
  vi: "intransitive verb",
  pron: "pronoun",
  conj: "conjunction",
  det: "determiner",
  num: "numeral",
  int: "interjection",
  interj: "interjection",
  aux: "auxiliary verb",
  modal: "modal verb",
  art: "article",
  abbr: "abbreviation",
};

// ── ECDICT exchange 字段映射 ───────────────────────────────────────────────────
// 格式：p:went/d:gone/i:going/3:goes/s:words/r:happier/t:happiest/0:lemma
const EXCHANGE_MAP = {
  p: "past",
  d: "past_participle",
  i: "ing",
  3: "third_person",
  s: "plural",
  r: "comparative",
  t: "superlative",
  0: "lemma",
};

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

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/**
 * 去除重音符号，使 naïve → naive，café → cafe。
 * 用于统一 dictionary key，保证重音变体也能命中。
 */
function stripDiacritics(str) {
  return String(str || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * ECDICT 里的换行可能是字面量 \n（两个字符），也可能是真换行。
 * 统一先转换成真换行再处理。
 */
function normalizeNewlines(raw) {
  return (raw || "").replace(/\\n/g, "\n").replace(/\r/g, "");
}

/** 规范化音标：包裹 /.../ */
function normalizePhonetic(raw) {
  let p = (raw || "").trim();
  if (!p) return "";
  if (!p.startsWith("/")) p = "/" + p;
  if (!p.endsWith("/")) p = p + "/";
  return p;
}

/**
 * 去重语义单元，保留原始顺序。
 * - trim
 * - 忽略空串
 * - 按精确匹配去重
 */
function dedupeMeanings(parts) {
  const seen = new Set();
  const result = [];
  for (const p of parts) {
    const s = p.trim();
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    result.push(s);
  }
  return result;
}

/**
 * 清洗 ECDICT translation 为 meaning_cn。
 *
 * 流程：
 * 1. 把字面 \n 转成真换行，按换行拆分得到各 POS 行。
 * 2. 去掉词性前缀 "prep. ", "a. " 等。
 * 3. 去掉 [网络], [机] 等来源标注。
 * 4. 对每一行再按中文逗号（，）拆分成最小语义单元。
 * 5. 全局去重（保留顺序）。
 * 6. 拼接，截断到 MAX_MEANING_LEN。
 */
function cleanTranslationToMeaningCn(raw) {
  if (!raw) return "";

  const lines = normalizeNewlines(raw)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      l = l.replace(/^[a-z]{1,6}\.\s+/i, ""); // 去词性前缀
      l = l.replace(/^\[[^\]]{1,10}\]\s*/g, ""); // 去 [网络] 等
      return l.trim();
    })
    .filter(Boolean);

  // 每行按中文逗号（，）或英文逗号+空格（", "）拆分为最小语义单元
  const allParts = [];
  for (const line of lines) {
    const subParts = line.split(/[，]|,\s+/).map((p) => p.trim()).filter(Boolean);
    allParts.push(...subParts);
  }

  const unique = dedupeMeanings(allParts);

  let result = unique.join("；");
  if (result.length > MAX_MEANING_LEN) {
    // 截断时不要截到分隔符中间
    let cut = result.slice(0, MAX_MEANING_LEN - 1);
    cut = cut.replace(/[；,，、]$/, "");
    result = cut + "…";
  }
  return result;
}

/** 清洗 definition → English 简短解释 */
function cleanDefinition(raw) {
  if (!raw) return "";
  const cleaned = normalizeNewlines(raw)
    .split("\n")
    .map((l) => l.replace(/^[a-z]\.\s+/i, "").trim())
    .filter(Boolean)
    .join("; ");
  if (cleaned.length > MAX_DEFINITION_LEN) {
    return cleaned.slice(0, MAX_DEFINITION_LEN - 3) + "...";
  }
  return cleaned;
}

/** 从 translation 行提取 pos */
function extractPos(translation, posField) {
  if (posField && posField.trim()) {
    const parts = posField
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean);
    const mapped = parts.map((p) => POS_MAP[p]).filter(Boolean);
    if (mapped.length > 0) return [...new Set(mapped)];
  }

  const lines = normalizeNewlines(translation).split("\n");
  const found = new Set();
  for (const line of lines) {
    const m = line.match(/^([a-z]+)\.\s/i);
    if (m) {
      const abbr = m[1].toLowerCase();
      if (POS_MAP[abbr]) found.add(POS_MAP[abbr]);
    }
  }
  return [...found];
}

/**
 * 解析 ECDICT exchange 字段 → forms 对象。
 * 示例：i:going/p:went/d:gone/3:goes
 */
function parseExchange(raw) {
  const forms = { ...EMPTY_FORMS };
  if (!raw || !raw.trim()) return forms;
  for (const part of raw.split("/")) {
    const colonIdx = part.indexOf(":");
    if (colonIdx < 0) continue;
    const key = part.slice(0, colonIdx).trim();
    const val = part.slice(colonIdx + 1).trim();
    const fieldName = EXCHANGE_MAP[key];
    if (fieldName && val) {
      forms[fieldName] = val;
    }
  }
  return forms;
}

// ── Step 1：读取 Google 词表（前 GOOGLE_LIMIT 行）──────────────────────────
function loadGoogleWords() {
  const text = fs.readFileSync(GOOGLE_TXT, "utf-8");
  const words = new Set();
  let count = 0;
  for (const line of text.split("\n")) {
    const w = line.trim().toLowerCase();
    if (!w || !/^[a-z]/.test(w)) continue;
    words.add(w);
    if (++count >= GOOGLE_LIMIT) break;
  }
  return words;
}

// ── Step 2：读取 Oxford 3000 词表 ────────────────────────────────────────────
function loadOxfordWords() {
  const text = fs.readFileSync(OXFORD_TXT, "utf-8");
  const words = new Set();
  for (const line of text.split("\n")) {
    const w = line.trim().toLowerCase();
    if (!w || !/[a-z]/.test(w)) continue;
    if (w.length > 40) continue;
    words.add(w);
    const firstWord = w.split(/\s+/)[0];
    if (firstWord && /^[a-z]+$/.test(firstWord)) {
      words.add(firstWord);
    }
  }
  return words;
}

// ── Step 2b：读取手动补充核心词表（可选）────────────────────────────────────
function loadManualWords() {
  if (!fs.existsSync(MANUAL_TXT)) {
    return new Set();
  }
  const text = fs.readFileSync(MANUAL_TXT, "utf-8");
  const words = new Set();
  for (const line of text.split("\n")) {
    const w = stripDiacritics(line.trim().toLowerCase());
    if (!w || w.startsWith("#") || !/^[a-z]/.test(w)) continue;
    words.add(w);
  }
  return words;
}

// ── Step 2c：读取 wordfreq 25000 词表 ───────────────────────────────────────
function loadWordfreqWords() {
  if (!fs.existsSync(WORDFREQ_JSON)) {
    return new Set();
  }
  const raw = JSON.parse(fs.readFileSync(WORDFREQ_JSON, "utf-8"));
  const words = new Set();
  for (const row of raw) {
    const w = String(row[0] || "").trim().toLowerCase();
    if (!w) continue;
    words.add(w);
  }
  return words;
}

// ── Step 3：流式解析 ECDICT，匹配白名单 ──────────────────────────────────────
async function buildDictionary(commonWords) {
  return new Promise((resolve, reject) => {
    const result = {};
    let matched = 0;
    let total = 0;

    const parser = parse({
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true,
    });

    parser.on("readable", () => {
      let record;
      while ((record = parser.read()) !== null) {
        total++;
        // 对 ECDICT word 也做重音去除：naïve → naive，保持 key 纯 ASCII
        const wordRaw = (record.word || "").trim().toLowerCase();
        const word = stripDiacritics(wordRaw);

        if (!word || !commonWords.has(word)) continue;
        if (!/^[a-z]/.test(word)) continue;
        if (result[word]) continue;

        const translation = record.translation || "";
        const definition = record.definition || "";
        const phonetic = record.phonetic || "";
        const posField = record.pos || "";
        const exchange = record.exchange || "";

        const short_meaning = cleanTranslationToMeaningCn(translation);
        const context_meaning = cleanDefinition(definition);
        const posArr = extractPos(translation, posField);
        const part_of_speech = posArr.join(", ");
        const phonetic_clean = normalizePhonetic(phonetic);
        const forms = parseExchange(exchange);

        result[word] = {
          term: word,
          phonetic: phonetic_clean,
          part_of_speech,
          short_meaning,
          context_meaning: context_meaning && context_meaning !== short_meaning ? context_meaning : "",
          examples: [],
          memory_tip: "",
          common_collocations: [],
          forms,
          enriched: false,
        };

        matched++;
      }
    });

    parser.on("error", reject);

    parser.on("end", () => {
      resolve({ result, matched, total });
    });

    fs.createReadStream(ECDICT_CSV, { encoding: "utf8" }).pipe(parser);
  });
}

// ── 主函数 ───────────────────────────────────────────────────────────────────
async function main() {
  console.log("=== Zamp English Dictionary Builder ===\n");

  // 安全闸：build 会从 ECDICT 重新生成全部条目（enriched:false），不能悄悄覆盖付费 enrich 过的数据
  const existing = assertSafeToOverwrite(OUT_FILE, { force: forceOverwrite, flagName: FORCE_OVERWRITE_FLAG });
  if (existing.enriched > 0) {
    console.warn(
      `⚠️  ${FORCE_OVERWRITE_FLAG}: replacing ${existing.entries} entries (${existing.enriched} enriched); a backup is written first.`
    );
  }

  const googleWords = loadGoogleWords();
  console.log(`Google words (limit ${GOOGLE_LIMIT}): ${googleWords.size}`);

  const oxfordWords = loadOxfordWords();
  console.log(`Oxford words: ${oxfordWords.size}`);

  const wordfreqWords = loadWordfreqWords();
  console.log(`Wordfreq words: ${wordfreqWords.size}`);

  const manualWords = loadManualWords();
  if (manualWords.size > 0) {
    console.log(`Manual core words: ${manualWords.size}`);
  } else {
    console.log("Manual core words: (file not found, skipped)");
  }

  const commonWords = new Set([
    ...googleWords,
    ...oxfordWords,
    ...manualWords,
    ...wordfreqWords,
  ]);
  console.log(`Merged common words: ${commonWords.size}`);

  console.log("\nParsing ECDICT CSV (this may take ~30s)...");
  const startMs = Date.now();
  const { result, matched, total } = await buildDictionary(commonWords);
  const elapsedSec = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(`ECDICT total records scanned: ${total}`);
  console.log(`ECDICT matched entries: ${matched}`);
  console.log(`Parsing time: ${elapsedSec}s`);

  const missing = [...commonWords]
    .filter((w) => !result[w])
    .sort();
  console.log(`\nMissing entries (will add empty stubs): ${missing.length}`);
  if (missing.length > 0) {
    console.log(`First 20 missing: ${missing.slice(0, 20).join(", ")}`);
    for (const w of missing) {
      result[w] = createEmptyApiEntry(w);
    }
  }

  // manual 词专项统计
  if (manualWords.size > 0) {
    const manualMatched = [...manualWords].filter((w) => result[w]);
    const manualMissing = [...manualWords].filter((w) => !result[w]);
    console.log(`\n── Manual words report ──`);
    console.log(`  total: ${manualWords.size}`);
    console.log(`  matched in ECDICT: ${manualMatched.length}`);
    if (manualMissing.length > 0) {
      console.log(`  NOT in ECDICT: ${manualMissing.join(", ")}`);
    } else {
      console.log(`  all manual words found in ECDICT ✅`);
    }
  }

  if (!fs.existsSync(OUT_DIR)) {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  }

  const written = writeDictionaryAtomic(OUT_FILE, result, {
    backup: existing.exists,
    serialize: (d) => JSON.stringify(d, null, 0),
  });
  if (written.backup) console.log(`Backup: ${written.backup}`);

  const sizeBytes = written.bytes;
  const sizeMB = (sizeBytes / 1024 / 1024).toFixed(2);

  console.log(`\nOutput: ${OUT_FILE}`);
  console.log(`Output entries: ${Object.keys(result).length}`);
  console.log(`Output size: ${sizeMB} MB`);

  if (parseFloat(sizeMB) > SIZE_WARN_MB) {
    console.warn(
      `\n⚠️  File exceeds ${SIZE_WARN_MB}MB. Consider reducing GOOGLE_LIMIT from ${GOOGLE_LIMIT} to 5000.`
    );
  } else {
    console.log("✅ File size OK.");
  }

  // 验证关键词条
  console.log("\n── 验证样本 ──");
  for (const w of ["after", "happy", "go", "run", "naive", "don't", "hobo"]) {
    const e = result[w];
    if (e) {
      console.log(
        `${w}: phonetic=${e.phonetic} | pos=${e.part_of_speech} | short_meaning="${e.short_meaning}"`
      );
      const f = e.forms;
      const hasForm = Object.values(f).some((v) => v);
      if (hasForm) console.log(`  forms: ${JSON.stringify(f)}`);
    } else {
      console.log(`${w}: NOT FOUND ❌`);
    }
  }
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
