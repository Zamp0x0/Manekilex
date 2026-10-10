#!/usr/bin/env node
/**
 * scripts/clean-dictionary-entries.js — 词典数据清理（Phase 5，确定性，可重复运行）
 *
 * 只做三类明确安全的修正，其余（词性拼写、缩写 key 等）一律不动：
 *   1. 空壳条目：enriched:true 但 short_meaning / context_meaning / examples / memory_tip 全空 → 删除
 *      （运行时已把它们当未命中处理；删掉后行为一致，文件更小）
 *   2. 占位数字 / 纯符号 key：如 "00th"、"0,000"、"©"、"♪"、单个带重音字母 → 删除
 *      （用户选中的文本经 zehNormalizeLookupKey 后不可能等于这些 key，等于不可达）
 *   3. term 与 key 不一致且 term 是中文（taiwan → 台湾）：term 改回 key；拼音 phonetic 清空
 *      （其余 term/key 差异如 thats → that's、p.m → p.m.、raped → rape 是有意的别名，保留）
 *
 * 用法：
 *   node scripts/clean-dictionary-entries.js            # 只报告，不写文件
 *   node scripts/clean-dictionary-entries.js --write    # 写回（先备份，原子写入）
 */
"use strict";

const path = require("path");
const { readDictionary, writeDictionaryAtomic, entryIsUsable } = require("./dictionary-file");

const ROOT = path.resolve(__dirname, "..");
const DICT_FILE = process.env.MANEKILEX_DICT_FILE || path.join(ROOT, "data", "dictionary_core.json");
const WRITE = process.argv.includes("--write");

const CJK_RE = /[一-鿿]/;
const PINYIN_TONE_RE = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]/i;

function normalizeKey(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/[‘’‛′ʼ＇]/g, "'")
    .replace(/\s+/g, " ");
}

function isEmptyShell(entry) {
  if (!entry || typeof entry !== "object") return true;
  const examples = Array.isArray(entry.examples) ? entry.examples.filter((e) => e && String(e.en || "").trim()) : [];
  return !entryIsUsable(entry) && examples.length === 0 && !String(entry.memory_tip || "").trim();
}

/** 占位数字（语料里数字被替换成 0 后留下的 "00th" / "0,000"）或没有任何字母的 key */
function isJunkKey(key) {
  if (/^\d+$/.test(key)) return false; // 0、1、2… 是真正的数词条目
  if (!/[a-z]/i.test(key)) return true; // 纯符号 / 纯标点 / 数字加标点 / 单个带重音字母
  return /0{2,}/.test(key) || /^0,/.test(key) || /,0/.test(key);
}

function isCjkTermMismatch(key, entry) {
  const term = String(entry?.term || "");
  return Boolean(term) && CJK_RE.test(term) && normalizeKey(term) !== normalizeKey(key);
}

function looksLikePinyin(phonetic) {
  const p = String(phonetic || "").trim();
  if (!p) return false;
  if (PINYIN_TONE_RE.test(p)) return true;
  return /^[a-z]+( [a-z]+)*$/i.test(p) && !/[ˈˌːəɪʊæɒʌθðʃʒŋ]/.test(p);
}

function cleanDictionary(dict) {
  const removedEmpty = [];
  const removedJunk = [];
  const fixedTerms = [];
  const out = {};
  for (const [key, entry] of Object.entries(dict)) {
    if (isEmptyShell(entry)) {
      removedEmpty.push(key);
      continue;
    }
    if (isJunkKey(key)) {
      removedJunk.push(key);
      continue;
    }
    if (isCjkTermMismatch(key, entry)) {
      const next = { ...entry, term: key };
      if (looksLikePinyin(entry.phonetic)) next.phonetic = "";
      fixedTerms.push({ key, from: entry.term, phoneticCleared: next.phonetic !== entry.phonetic });
      out[key] = next;
      continue;
    }
    out[key] = entry;
  }
  return { dict: out, removedEmpty, removedJunk, fixedTerms };
}

function summarize(dict) {
  const values = Object.values(dict);
  return {
    entries: values.length,
    enriched: values.filter((e) => e && e.enriched === true).length,
    emptyShells: values.filter(isEmptyShell).length,
    junkKeys: Object.keys(dict).filter(isJunkKey).length,
    cjkTermMismatches: Object.entries(dict).filter(([k, e]) => isCjkTermMismatch(k, e)).length,
  };
}

function main() {
  const dict = readDictionary(DICT_FILE);
  const before = summarize(dict);
  const result = cleanDictionary(dict);
  const after = summarize(result.dict);
  console.log("before:", before);
  console.log("after: ", after);
  console.log(`removed empty shells: ${result.removedEmpty.length}`);
  console.log(`removed junk keys: ${result.removedJunk.length}`);
  console.log(`fixed CJK terms: ${result.fixedTerms.length}`);
  console.log("empty shells:", result.removedEmpty.join(" "));
  console.log("junk keys:", result.removedJunk.join(" "));
  console.log("fixed terms:", result.fixedTerms.map((f) => `${f.key}(${f.from})`).join(" "));
  if (!WRITE) {
    console.log("\n(dry run; add --write to apply)");
    return;
  }
  const written = writeDictionaryAtomic(DICT_FILE, result.dict, { backup: true });
  console.log(`\nwritten: ${DICT_FILE} (${written.bytes} bytes), backup: ${written.backup}`);
}

if (require.main === module) {
  main();
}

module.exports = { cleanDictionary, isEmptyShell, isJunkKey, isCjkTermMismatch, looksLikePinyin, summarize };
