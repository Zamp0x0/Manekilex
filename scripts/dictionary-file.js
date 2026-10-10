/**
 * dictionary_core.json 的读写安全工具（Phase 5）
 *
 * - readDictionary(file)：读取并解析，非对象即抛错
 * - validateDictionaryObject(dict)：结构校验 + 统计（entries / enriched / usable）
 * - writeDictionaryAtomic(file, dict, { backup })：写临时文件 → 重新解析校验 → 可选备份 → rename
 * - assertSafeToOverwrite(file, { force })：目标已有 enriched 数据时拒绝覆盖，除非显式 --force-overwrite
 * - isExplicitEnrichRun(opts)：enrich 脚本必须给出明确队列范围或 --confirm-full-run 才会排队付费请求
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ENTRY_STRING_FIELDS = ["term", "phonetic", "part_of_speech", "short_meaning", "context_meaning", "memory_tip"];

function readDictionary(file) {
  const raw = fs.readFileSync(file, "utf-8");
  const dict = JSON.parse(raw);
  if (!dict || typeof dict !== "object" || Array.isArray(dict)) {
    throw new Error(`${file} is not a JSON object`);
  }
  return dict;
}

function entryIsUsable(entry) {
  if (!entry || typeof entry !== "object") return false;
  return Boolean(String(entry.short_meaning || "").trim() || String(entry.context_meaning || "").trim());
}

function entryIsEnriched(entry) {
  return Boolean(entry && entry.enriched === true);
}

/** 返回 { ok, errors, counts }；errors 最多记录 20 条 */
function validateDictionaryObject(dict) {
  const errors = [];
  const counts = { entries: 0, enriched: 0, usable: 0, emptyShells: 0 };
  if (!dict || typeof dict !== "object" || Array.isArray(dict)) {
    return { ok: false, errors: ["dictionary is not an object"], counts };
  }
  for (const [key, entry] of Object.entries(dict)) {
    counts.entries++;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      if (errors.length < 20) errors.push(`${key}: entry is not an object`);
      continue;
    }
    for (const f of ENTRY_STRING_FIELDS) {
      if (f in entry && typeof entry[f] !== "string") {
        if (errors.length < 20) errors.push(`${key}: ${f} is not a string`);
      }
    }
    if ("examples" in entry && !Array.isArray(entry.examples)) {
      if (errors.length < 20) errors.push(`${key}: examples is not an array`);
    }
    if ("common_collocations" in entry && !Array.isArray(entry.common_collocations)) {
      if (errors.length < 20) errors.push(`${key}: common_collocations is not an array`);
    }
    if ("forms" in entry && (!entry.forms || typeof entry.forms !== "object" || Array.isArray(entry.forms))) {
      if (errors.length < 20) errors.push(`${key}: forms is not an object`);
    }
    if (entryIsEnriched(entry)) counts.enriched++;
    if (entryIsUsable(entry)) counts.usable++;
    else counts.emptyShells++;
  }
  return { ok: errors.length === 0, errors, counts };
}

function hasEnrichedData(dict) {
  return Object.values(dict || {}).some(entryIsEnriched);
}

function backupPath(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${file}.bak-${stamp}`;
}

/**
 * 原子写入：先写 <file>.tmp-<pid>，重新读回解析并校验，再（可选）备份旧文件，最后 rename 覆盖。
 * 任一步失败都不会留下半截的 dictionary_core.json。
 */
function writeDictionaryAtomic(file, dict, options = {}) {
  const validation = validateDictionaryObject(dict);
  if (!validation.ok) {
    throw new Error(`refusing to write invalid dictionary: ${validation.errors.slice(0, 3).join("; ")}`);
  }
  const json = typeof options.serialize === "function" ? options.serialize(dict) : JSON.stringify(dict);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, json, "utf-8");
  try {
    const reread = JSON.parse(fs.readFileSync(tmp, "utf-8"));
    const check = validateDictionaryObject(reread);
    if (!check.ok || check.counts.entries !== validation.counts.entries) {
      throw new Error("temp file failed re-validation");
    }
    let backup = "";
    if (options.backup && fs.existsSync(file)) {
      backup = options.backupPath || backupPath(file);
      fs.copyFileSync(file, backup);
    }
    fs.renameSync(tmp, file);
    return { bytes: Buffer.byteLength(json, "utf8"), counts: validation.counts, backup };
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* noop */
    }
    throw err;
  }
}

/**
 * 目标文件已存在且含 enriched 数据时拒绝覆盖（除非 force）。
 * 返回 { exists, enriched, entries }；拒绝时抛错，错误信息说明需要哪个开关。
 */
function assertSafeToOverwrite(file, options = {}) {
  const info = { exists: false, enriched: 0, entries: 0 };
  if (!fs.existsSync(file)) return info;
  info.exists = true;
  let dict;
  try {
    dict = readDictionary(file);
  } catch {
    // 已损坏 / 非对象：覆盖不会丢失有效数据
    return info;
  }
  info.entries = Object.keys(dict).length;
  info.enriched = Object.values(dict).filter(entryIsEnriched).length;
  if (info.enriched > 0 && !options.force) {
    throw new Error(
      `${path.basename(file)} already contains ${info.enriched} enriched entries (of ${info.entries}). ` +
        `Refusing to overwrite. Re-run with ${options.flagName || "--force-overwrite"} to replace it ` +
        `(a backup copy is written first).`
    );
  }
  return info;
}

/**
 * enrich 是否给出了明确范围：--keys / --keys-file / --retry-failed / --limit N，
 * 或显式 --confirm-full-run。只有 --resume / --all-missing / 无参数都不算。
 */
function isExplicitEnrichRun(opts) {
  if (!opts) return false;
  if (opts.confirmFullRun) return true;
  if (Array.isArray(opts.keys) && opts.keys.length) return true;
  if (opts.keysFile) return true;
  if (opts.retryFailed) return true;
  if (Number.isFinite(opts.limit) && opts.limit > 0) return true;
  return false;
}

module.exports = {
  readDictionary,
  validateDictionaryObject,
  writeDictionaryAtomic,
  assertSafeToOverwrite,
  hasEnrichedData,
  isExplicitEnrichRun,
  entryIsUsable,
  entryIsEnriched,
  backupPath,
};
