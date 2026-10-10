#!/usr/bin/env node
/**
 * 1. 将 dictionary_core.json 转为 API 对齐格式
 * 2. 从 dic/wordfreq-en-25000-log.json 补入缺失词条（仅 term + 空字段）
 *
 * 用法: node scripts/migrate-dictionary-format.js
 */

"use strict";

const fs = require("fs");
const path = require("path");
const {
  createEmptyApiEntry,
  legacyToApiEntry,
} = require("./dictionary-schema");
const { assertSafeToOverwrite, writeDictionaryAtomic } = require("./dictionary-file");

const FORCE_OVERWRITE_FLAG = "--force-overwrite";
const forceOverwrite = process.argv.includes(FORCE_OVERWRITE_FLAG);

const ROOT = path.resolve(__dirname, "..");
const DICT_FILE = path.join(ROOT, "data", "dictionary_core.json");
const WORDFREQ_FILE = path.join(ROOT, "dic", "wordfreq-en-25000-log.json");

function loadWordfreqTerms() {
  const raw = JSON.parse(fs.readFileSync(WORDFREQ_FILE, "utf-8"));
  if (!Array.isArray(raw)) {
    throw new Error("wordfreq JSON must be an array");
  }
  const terms = [];
  const seen = new Set();
  for (const row of raw) {
    const term = String(row[0] || "").trim().toLowerCase();
    if (!term || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms;
}

function main() {
  console.log("=== Migrate dictionary_core.json to API format ===\n");

  if (!fs.existsSync(DICT_FILE)) {
    throw new Error(`Dictionary not found: ${DICT_FILE}`);
  }

  const legacyDict = JSON.parse(fs.readFileSync(DICT_FILE, "utf-8"));
  const legacyKeys = Object.keys(legacyDict);
  console.log(`Existing entries: ${legacyKeys.length}`);

  const result = {};
  let converted = 0;

  for (const key of legacyKeys) {
    result[key] = legacyToApiEntry(legacyDict[key], key);
    converted++;
  }

  const wordfreqTerms = loadWordfreqTerms();
  console.log(`Wordfreq terms: ${wordfreqTerms.length}`);

  let added = 0;
  for (const term of wordfreqTerms) {
    if (result[term]) continue;
    result[term] = createEmptyApiEntry(term);
    added++;
  }

  const existing = assertSafeToOverwrite(DICT_FILE, { force: forceOverwrite, flagName: FORCE_OVERWRITE_FLAG });
  const written = writeDictionaryAtomic(DICT_FILE, result, { backup: existing.exists });
  if (written.backup) console.log(`Backup: ${written.backup}`);

  const sizeMB = (written.bytes / 1024 / 1024).toFixed(2);
  const enriched = Object.values(result).filter((e) => e.enriched).length;
  const withMeaning = Object.values(result).filter((e) => e.short_meaning).length;

  console.log(`\nConverted legacy entries: ${converted}`);
  console.log(`Added from wordfreq: ${added}`);
  console.log(`Total entries: ${Object.keys(result).length}`);
  console.log(`With short_meaning (ECDICT): ${withMeaning}`);
  console.log(`Enriched (examples+memory): ${enriched}`);
  console.log(`Output: ${DICT_FILE}`);
  console.log(`Output size: ${sizeMB} MB`);

  console.log("\n── Sample migrated (happy) ──");
  console.log(JSON.stringify(result.happy, null, 2));

  console.log("\n── Sample new empty (hobo) ──");
  console.log(JSON.stringify(result.hobo, null, 2));
}

main();
