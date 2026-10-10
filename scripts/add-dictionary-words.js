#!/usr/bin/env node
/** 从 ECDICT 向已有 dictionary_core.json 增量添加词条，保留原有 enriched 数据 */
"use strict";

const fs = require("fs");
const readline = require("readline");
const path = require("path");
const { createEmptyApiEntry } = require("./dictionary-schema");
const { readDictionary, writeDictionaryAtomic } = require("./dictionary-file");

const ROOT = path.resolve(__dirname, "..");
const DICT_FILE = path.join(ROOT, "data", "dictionary_core.json");
const ECDICT_CSV = path.join(ROOT, "dic", "ecdict.csv");

const words = process.argv.slice(2).map((w) => w.trim().toLowerCase()).filter(Boolean);
if (!words.length) {
  console.error("Usage: node scripts/add-dictionary-words.js word1 word2 ...");
  process.exit(1);
}

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

function parseExchange(raw) {
  const forms = createEmptyApiEntry("").forms;
  if (!raw?.trim()) return forms;
  for (const part of raw.split("/")) {
    const m = part.match(/^([^:]+):(.+)$/);
    if (!m) continue;
    const field = EXCHANGE_MAP[m[1]];
    if (field) forms[field] = m[2].trim();
  }
  return forms;
}

function cleanTranslationToMeaningCn(translation) {
  const t = String(translation || "")
    .replace(/\\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const first = t.split(/[;；]/)[0]?.trim() || t;
  return first.slice(0, 80);
}

const dict = readDictionary(DICT_FILE);
const wordSet = new Set(words.filter((w) => !dict[w]));
if (!wordSet.size) {
  console.log("All words already in dictionary.");
  process.exit(0);
}

console.log("Adding:", [...wordSet].join(", "));

function parseCsvLine(line) {
  const cols = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (ch === "," && !inQuotes) {
      cols.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  cols.push(cur);
  return cols;
}

async function main() {
  const rl = readline.createInterface({
    input: fs.createReadStream(ECDICT_CSV, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let header = null;
  let added = 0;

  for await (const line of rl) {
    if (!header) {
      header = parseCsvLine(line);
      continue;
    }
    if (!wordSet.size) break;
    const cols = parseCsvLine(line);
    const record = Object.fromEntries(header.map((h, i) => [h, cols[i] || ""]));
    const word = String(record.word || "").trim().toLowerCase();
    if (!wordSet.has(word)) continue;

    dict[word] = {
      term: word,
      phonetic: record.phonetic || "",
      part_of_speech: String(record.pos || "verb").trim() || "verb",
      short_meaning: cleanTranslationToMeaningCn(record.translation),
      context_meaning: "",
      examples: [],
      memory_tip: "",
      common_collocations: [],
      forms: parseExchange(record.exchange || ""),
      enriched: false,
    };
    wordSet.delete(word);
    added++;
  }

  for (const w of wordSet) {
    dict[w] = createEmptyApiEntry(w);
    added++;
    console.warn("ECDICT miss, added stub:", w);
  }

  const written = writeDictionaryAtomic(DICT_FILE, dict, { backup: true });
  console.log(`Backup: ${written.backup}`);
  console.log(`Done. Added ${added}. Total entries: ${Object.keys(dict).length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
