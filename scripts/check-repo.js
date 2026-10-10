#!/usr/bin/env node
/**
 * 只读的仓库检查（CI 与本地共用，无第三方依赖，Windows / Linux 均可运行）
 *
 * 用法:
 *   node scripts/check-repo.js              全部检查
 *   node scripts/check-repo.js syntax       对第一方 JS 运行 node --check（lib/ 除外）
 *   node scripts/check-repo.js manifest     manifest.json / package.json / package-lock.json 有效且版本一致
 *   node scripts/check-repo.js dictionary   data/dictionary_core.json 可解析，无空壳 / 垃圾 key / 中文词头
 *   node scripts/check-repo.js hygiene      仓库里没有报告、私有审计、备份、node_modules、明显的密钥
 *
 * 只读：不写文件、不联网、不调用付费 API。任何检查失败时退出码为 1。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

/** 已跟踪文件 + 未被 .gitignore 忽略的新文件（本地还没 git add 的文件也会被检查） */
function repoFiles() {
  const res = spawnSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`git ls-files failed: ${res.error ? res.error.message : res.stderr}`);
  }
  const files = new Set(res.stdout.split("\0").filter(Boolean));
  return [...files].filter((f) => fs.existsSync(path.join(ROOT, f)));
}

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
}

function checkSyntax(files) {
  const errors = [];
  const targets = files.filter((f) => /\.(c|m)?js$/.test(f) && !f.startsWith("lib/"));
  for (const f of targets) {
    const res = spawnSync(process.execPath, ["--check", path.join(ROOT, f)], { encoding: "utf8" });
    if (res.status !== 0) {
      const detail = String(res.stderr || res.error || "")
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .slice(0, 4)
        .join("\n    ");
      errors.push(`${f}:\n    ${detail}`);
    }
  }
  return { errors, note: `${targets.length} files` };
}

function checkManifest() {
  const errors = [];
  let manifest, pkg, lock;
  for (const [name, set] of [
    ["manifest.json", (j) => (manifest = j)],
    ["package.json", (j) => (pkg = j)],
    ["package-lock.json", (j) => (lock = j)],
  ]) {
    try {
      set(readJson(name));
    } catch (e) {
      errors.push(`${name}: invalid JSON (${e.message})`);
    }
  }
  if (errors.length) return { errors };

  if (manifest.manifest_version !== 3) errors.push(`manifest.json: manifest_version is ${manifest.manifest_version}, expected 3`);
  for (const key of ["name", "version"]) {
    if (!manifest[key]) errors.push(`manifest.json: missing "${key}"`);
  }
  if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version))) {
    errors.push(`manifest.json: version "${manifest.version}" is not a Chrome extension version`);
  }

  const versions = {
    "manifest.json version": manifest.version,
    "package.json version": pkg.version,
    "package-lock.json version": lock.version,
    'package-lock.json packages[""].version': lock.packages && lock.packages[""] && lock.packages[""].version,
  };
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8").match(/当前版本：\*\*([^*]+)\*\*/);
  if (readme) versions["README.md 当前版本"] = readme[1];
  for (const [where, v] of Object.entries(versions)) {
    if (v !== manifest.version) errors.push(`${where} is "${v}", manifest.json says "${manifest.version}"`);
  }
  if (lock.name !== pkg.name) errors.push(`package-lock.json name "${lock.name}" != package.json name "${pkg.name}"`);

  // manifest 引用的文件必须存在（通配符条目跳过）
  const refs = [];
  if (manifest.background && manifest.background.service_worker) refs.push(manifest.background.service_worker);
  for (const cs of manifest.content_scripts || []) refs.push(...(cs.js || []), ...(cs.css || []));
  for (const icons of [manifest.icons, manifest.action && manifest.action.default_icon]) {
    if (icons) refs.push(...Object.values(icons));
  }
  for (const page of [
    manifest.options_page,
    manifest.action && manifest.action.default_popup,
    manifest.side_panel && manifest.side_panel.default_path,
    ...Object.values(manifest.mime_types_handler || {}).map((h) => h && h.handler_url),
  ]) {
    if (page) refs.push(page.split("#")[0]);
  }
  for (const war of manifest.web_accessible_resources || []) refs.push(...(war.resources || []));
  for (const ref of refs) {
    if (ref.includes("*")) continue;
    if (!fs.existsSync(path.join(ROOT, ref))) errors.push(`manifest.json references missing file ${ref}`);
  }
  return { errors, note: `version ${manifest.version}, ${refs.length} manifest references` };
}

function checkDictionary() {
  const { readDictionary, validateDictionaryObject } = require("./dictionary-file");
  const { summarize } = require("./clean-dictionary-entries");
  const errors = [];
  const dict = readDictionary(path.join(ROOT, "data", "dictionary_core.json"));
  const validation = validateDictionaryObject(dict);
  if (!validation.ok) errors.push(...validation.errors.map((e) => `structure: ${e}`));
  const summary = summarize(dict);
  if (summary.entries === 0) errors.push("dictionary is empty");
  if (summary.emptyShells) errors.push(`${summary.emptyShells} empty shell entries`);
  if (summary.junkKeys) errors.push(`${summary.junkKeys} junk keys`);
  if (summary.cjkTermMismatches) errors.push(`${summary.cjkTermMismatches} CJK headword mismatches`);
  return { errors, note: `${summary.entries} entries` };
}

const FORBIDDEN_PATHS = [
  [/(^|\/)claude_report\//, "AI development report"],
  [/(^|\/)\.(cursor|claude|codex|continue|cline|windsurf)\//, "AI editor directory"],
  [/(^|\/)[^/]*_private_audit(\/|$)/, "private audit file"],
  [/(^|\/)node_modules\//, "node_modules"],
  [/\.(bak|backup|tmp|bundle|log)$/, "backup / temporary file"],
  [/\.(bak|tmp)-[^/]*$/, "backup / temporary file"],
  [/^data\/(enrich-progress|enrich-scan-report|enrich-audit-report|dictionary_core\.legacy)\.json$/, "dictionary tooling output"],
  [/^data\/\.enrich\.lock$/, "dictionary tooling lock"],
  [/^dic\/ecdict\.csv$/, "ECDICT source CSV (download it, do not commit it)"],
  [/(^|\/)\.env(\.(?!example$)[^/]*)?$/, "environment file"],
  [/\.(pem|key|p12|pfx)$/, "key file"],
];

const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\bsk-(?:proj-|ant-)?[A-Za-z0-9_]{32,}/, "OpenAI / DeepSeek / Anthropic style API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{40,}\b/, "GitHub fine-grained token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, "Slack token"],
  [/\bgsk_[A-Za-z0-9]{40,}\b/, "Groq API key"],
];

// 大体积数据与第三方压缩库不扫描密钥（不是手写文件，且会拖慢检查）
const SECRET_SCAN_SKIP = /^(lib\/|data\/dictionary_core\.json$|dic\/|poem\/)|\.(png|jpe?g|gif|ico|webp|woff2?|ttf|pdf)$/i;

function checkHygiene(files) {
  const errors = [];
  for (const f of files) {
    for (const [re, what] of FORBIDDEN_PATHS) {
      if (re.test(f)) errors.push(`${what} in repository: ${f}`);
    }
  }
  let scanned = 0;
  for (const f of files) {
    if (SECRET_SCAN_SKIP.test(f)) continue;
    const text = fs.readFileSync(path.join(ROOT, f), "utf8");
    scanned++;
    for (const [re, what] of SECRET_PATTERNS) {
      const m = text.match(re);
      if (m) {
        const line = text.slice(0, m.index).split("\n").length;
        errors.push(`possible ${what} in ${f}:${line} (value not shown)`);
      }
    }
  }
  return { errors, note: `${files.length} files, ${scanned} scanned for credentials` };
}

const CHECKS = {
  syntax: (files) => checkSyntax(files),
  manifest: () => checkManifest(),
  dictionary: () => checkDictionary(),
  hygiene: (files) => checkHygiene(files),
};

function main() {
  const wanted = process.argv.slice(2);
  const unknown = wanted.filter((n) => !CHECKS[n]);
  if (unknown.length) {
    console.error(`unknown check: ${unknown.join(", ")} (available: ${Object.keys(CHECKS).join(", ")})`);
    process.exit(2);
  }
  const names = wanted.length ? wanted : Object.keys(CHECKS);
  const files = repoFiles();
  let failed = 0;
  for (const name of names) {
    let result;
    try {
      result = CHECKS[name](files);
    } catch (e) {
      result = { errors: [e.message] };
    }
    if (result.errors.length) {
      failed++;
      console.error(`✗ ${name}: ${result.errors.length} problem(s)`);
      for (const e of result.errors) console.error(`  - ${e}`);
    } else {
      console.log(`✓ ${name}${result.note ? ` (${result.note})` : ""}`);
    }
  }
  if (failed) {
    console.error(`${failed} check(s) failed`);
    process.exit(1);
  }
}

main();
