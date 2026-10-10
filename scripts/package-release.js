#!/usr/bin/env node
/**
 * scripts/package-release.js — 生成可复现的扩展压缩包（私有预览版，不得分发）
 *
 * 用法:
 *   node scripts/package-release.js                 从 HEAD 打包到 dist/
 *   node scripts/package-release.js --ref <commit>  从指定提交打包
 *   node scripts/package-release.js --out <dir>     输出目录（默认 dist/）
 *   node scripts/package-release.js --verify <zip>  只校验已有压缩包，不打包
 *   node scripts/package-release.js --list          只打印将要打包的文件
 *
 * 可复现：文件内容直接从 Git 提交里读取（不读工作区），所以换行符、未提交的修改、被忽略的本地文件
 * （如 icons/lucky.png）都不会进包；条目按路径排序，时间戳取提交时间，权限固定，使用不压缩的
 * STORE 方式（不同 Node / zlib 版本的 deflate 输出可能不同）。同一提交在任何系统上得到同一个 SHA-256。
 *
 * 只读仓库：不联网、不调用任何 API、不上传、不发布。输出文件名和包内 NOT_FOR_DISTRIBUTION.txt
 * 都标明这是私有构建，在许可与安全阻塞项解决前不得分发。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");

/** 扩展运行时需要的目录（整目录打包，下面的排除规则仍然生效） */
const RUNTIME_DIRS = ["importers/", "lib/", "lookup/", "pdf-reader/", "reader/", "settings/", "shared/", "sw/", "icons/"];
/** 根目录只打包这些类型的文件，外加下面列出的单个文件 */
const ROOT_FILE_RE = /^[^/]+\.(js|html|css)$/;
const EXTRA_FILES = ["manifest.json", "LICENSE", "THIRD_PARTY_NOTICES.md", "data/dictionary_core.json", "data/README.md"];

/**
 * 运行时会读取、但许可尚未核实的文件：不进包。代码对它们缺失时有退路（daily-lines.js 失败时显示内置句子）。
 * 解决许可问题后从这里移除，并在 NOT_FOR_DISTRIBUTION 说明里同步更新。
 */
const EXCLUDED_PENDING_RIGHTS = ["poem/quotes.json"];

/** 任何情况下都不能进包的路径（测试、开发工具、报告、本地素材、密钥） */
const FORBIDDEN = [
  /(^|\/)tests?\//,
  /^scripts\//,
  /^docs\//,
  /^dic\//,
  /^assets\//,
  /^\.github\//,
  /(^|\/)node_modules\//,
  /(^|\/)\.[^/]+$/, // 点文件：.env、.gitignore、.gitattributes …
  /(^|\/)\.git\//,
  /_private_audit/,
  /\.(bundle|bak|backup|tmp|log|pem|key|map|zip|crx)$/i,
  /^icons\/lucky\.png$/,
  /^package(-lock)?\.json$/,
  /(^|\/)(claude_report|\.cursor|\.claude)\//,
  /REPORT|AUDIT/,
];

const MARKER = "NOT_FOR_DISTRIBUTION.txt";

function git(args, opts = {}) {
  const res = spawnSync("git", args, { cwd: ROOT, maxBuffer: 1 << 30, ...opts });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.error ? res.error.message : String(res.stderr)}`);
  }
  return res.stdout;
}

/** 提交里的所有文件：[{ path, blob }] */
function treeFiles(commit) {
  const out = git(["ls-tree", "-r", "-z", "--full-tree", commit]).toString("utf8");
  return out
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const [meta, p] = line.split("\t");
      const [mode, type, blob] = meta.split(" ");
      return { path: p, blob, mode, type };
    })
    .filter((e) => e.type === "blob");
}

function isForbidden(p) {
  return FORBIDDEN.some((re) => re.test(p));
}

/** 按规则从提交的文件里选出要打包的文件 */
function selectFiles(entries) {
  const chosen = [];
  for (const e of entries) {
    const p = e.path;
    if (EXCLUDED_PENDING_RIGHTS.includes(p)) continue;
    const wanted = EXTRA_FILES.includes(p) || ROOT_FILE_RE.test(p) || RUNTIME_DIRS.some((d) => p.startsWith(d));
    if (!wanted) continue;
    if (isForbidden(p) && !EXTRA_FILES.includes(p)) continue;
    if (e.mode === "120000") throw new Error(`符号链接不能打包：${p}`);
    chosen.push(e);
  }
  return chosen.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

function readBlobs(entries) {
  // 一次 cat-file --batch 读出全部内容
  const input = entries.map((e) => e.blob).join("\n") + "\n";
  const out = git(["cat-file", "--batch"], { input });
  const map = new Map();
  let pos = 0;
  for (const e of entries) {
    const nl = out.indexOf(0x0a, pos);
    const header = out.slice(pos, nl).toString("utf8").split(" ");
    const size = Number(header[2]);
    if (header[0] !== e.blob || header[1] !== "blob") throw new Error(`unexpected cat-file output for ${e.path}`);
    map.set(e.path, out.slice(nl + 1, nl + 1 + size));
    pos = nl + 1 + size + 1;
  }
  return map;
}

// ── 引用检查：manifest、HTML、importScripts、代码里的扩展内路径 ─────────────────

/** manifest 直接引用的文件 */
function manifestRefs(manifest) {
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
  return refs;
}

/** 生成的 EPUB 内部路径等，不是扩展里的文件 */
const NON_PACKAGE_REFS = new Set(["styles/book.css", "ch.html"]);

/** 从 HTML / JS / CSS 文本里找出指向扩展内文件的相对路径 */
function textRefs(file, text) {
  const refs = new Set();
  if (file.endsWith(".html")) {
    for (const m of text.matchAll(/\b(?:src|href)\s*=\s*"([^"#?:]+)"/g)) refs.add(m[1]);
  }
  if (file.endsWith(".js")) {
    const m = text.match(/importScripts\(([\s\S]*?)\)/);
    if (m) for (const s of m[1].matchAll(/"([^"]+)"/g)) refs.add(s[1]);
    for (const s of text.matchAll(/getURL\(\s*["'`]([^"'`$#?]+)["'`#?]/g)) refs.add(s[1]);
    // 写在字符串里的扩展内路径（图片、库、数据）
    for (const s of text.matchAll(/["'`]((?:icons|lib|data|poem|lookup|reader|settings|shared|sw|importers|pdf-reader)\/[A-Za-z0-9_./-]+\.(?:png|js|mjs|json|css|html|wasm))["'`]/g)) {
      refs.add(s[1]);
    }
  }
  if (file === "pdf-reader/pdfjs-loader.js") {
    const base = (text.match(/const BASE = "([^"]+)"/) || [])[1];
    for (const s of text.matchAll(/:\s*"((?:build|web)\/[^"]+)"/g)) refs.add(base + s[1]);
  }
  return [...refs].filter((r) => !/^(https?:|data:|blob:|chrome|mailto:|#)/.test(r) && !NON_PACKAGE_REFS.has(r));
}

/**
 * 检查一组 { path → Buffer }，返回错误列表。打包前和 --verify 共用。
 */
function verifyContents(files) {
  const errors = [];
  const paths = [...files.keys()];
  const has = (p) => files.has(p);

  for (const p of paths) {
    if (p === MARKER) continue;
    if (isForbidden(p) && !EXTRA_FILES.includes(p)) errors.push(`不允许进包的文件：${p}`);
    if (EXCLUDED_PENDING_RIGHTS.includes(p)) errors.push(`许可未核实的文件进了包：${p}`);
    if (p.includes("\\") || p.startsWith("/") || p.split("/").includes("..")) errors.push(`非法路径：${p}`);
  }
  for (const required of [MARKER, "manifest.json", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    if (!has(required)) errors.push(`缺少 ${required}`);
  }
  if (!has("manifest.json")) return errors;

  let manifest;
  try {
    manifest = JSON.parse(files.get("manifest.json").toString("utf8"));
  } catch (e) {
    return errors.concat(`manifest.json 无法解析：${e.message}`);
  }
  if (manifest.manifest_version !== 3) errors.push("manifest_version 不是 3");
  if (!/^\d+(\.\d+){0,3}$/.test(String(manifest.version))) errors.push(`版本号 ${manifest.version} 不合法`);
  if (manifest.key) errors.push("manifest 里不应有 key 字段");
  if (manifest.update_url) errors.push("manifest 里不应有 update_url 字段");

  for (const ref of manifestRefs(manifest)) {
    if (!has(ref)) errors.push(`manifest 引用的文件不在包里：${ref}`);
  }
  for (const war of manifest.web_accessible_resources || []) {
    for (const pattern of war.resources || []) {
      const re = new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*") + "$");
      if (!paths.some((p) => re.test(p))) errors.push(`web_accessible_resources "${pattern}" 没有匹配的文件`);
    }
  }
  // lib/ 的许可证必须随包
  if (paths.some((p) => p.startsWith("lib/pdfjs/")) && !has("lib/pdfjs/LICENSE")) errors.push("缺少 lib/pdfjs/LICENSE");
  for (const p of paths.filter((x) => /^lib\/pdfjs\/wasm\/[^/]+\.wasm$/.test(x))) {
    const name = path.basename(p, ".wasm").replace(/_bg$/, "").toUpperCase();
    if (!has(`lib/pdfjs/wasm/LICENSE_${name}`)) errors.push(`缺少 ${p} 的许可证 LICENSE_${name}`);
  }

  for (const p of paths) {
    if (!/\.(html|js)$/.test(p) || p.startsWith("lib/")) continue;
    for (const ref of textRefs(p, files.get(p).toString("utf8"))) {
      // 页面都在根目录；getURL 与 service worker 的 importScripts 都相对扩展根目录
      const resolved = path.posix.normalize(ref);
      if (EXCLUDED_PENDING_RIGHTS.includes(resolved)) continue; // 有退路，见上
      if (!has(resolved)) errors.push(`${p} 引用的 ${resolved} 不在包里`);
    }
  }
  return errors;
}

// ── 最小 ZIP 写入 / 读取（STORE，不压缩） ───────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** ZIP 使用 DOS 时间（本地时间、2 秒精度）；这里固定按 UTC 换算 */
function dosDateTime(date) {
  const y = Math.max(1980, date.getUTCFullYear());
  const time = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const day = ((y - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();
  return { time, day };
}

function buildZip(files, date) {
  const { time, day } = dosDateTime(date);
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(0, 8); // STORE
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  if (offset > 0xffffffff || files.size > 0xffff) throw new Error("压缩包超过 ZIP32 上限");
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

/** 读回 STORE 压缩包，校验 CRC 与大小，返回 Map(path → Buffer) */
function readZip(buf) {
  const endPos = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endPos < 0) throw new Error("不是 ZIP 文件");
  const count = buf.readUInt16LE(endPos + 10);
  let pos = buf.readUInt32LE(endPos + 16);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error("中央目录损坏");
    const method = buf.readUInt16LE(pos + 10);
    const crc = buf.readUInt32LE(pos + 16);
    const size = buf.readUInt32LE(pos + 24);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.slice(pos + 46, pos + 46 + nameLen).toString("utf8");
    if (method !== 0) throw new Error(`${name}：只支持 STORE 条目`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const data = buf.slice(start, start + size);
    if (crc32(data) !== crc) throw new Error(`${name}：CRC 不符`);
    if (files.has(name)) throw new Error(`重复条目：${name}`);
    files.set(name, data);
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

// ── 主流程 ──────────────────────────────────────────────────────────────────────

function markerText({ version, commit, date, excluded }) {
  return [
    "Manekilex — PRIVATE BUILD — NOT FOR DISTRIBUTION",
    "Manekilex 私有构建 —— 不得分发",
    "",
    `Version: ${version}`,
    `Commit: ${commit}`,
    `Commit date (UTC): ${date.toISOString()}`,
    "",
    "This archive is for private testing only. Do not publish it, upload it to the Chrome Web Store,",
    "attach it to a GitHub release or share it, until the licensing and security blockers recorded",
    "by the maintainer have been resolved.",
    "",
    "Left out on purpose (redistribution rights not verified):",
    ...excluded.map((p) => `  - ${p}`),
    "",
    "Licences: LICENSE (Manekilex, MIT) and THIRD_PARTY_NOTICES.md (bundled libraries and data).",
    "",
  ].join("\n");
}

function packageFromCommit(ref = "HEAD") {
  const commit = git(["rev-parse", "--verify", `${ref}^{commit}`]).toString("utf8").trim();
  const date = new Date(Number(git(["show", "-s", "--format=%ct", commit]).toString("utf8").trim()) * 1000);
  const all = treeFiles(commit);
  const chosen = selectFiles(all);
  const blobs = readBlobs(chosen);
  const manifest = JSON.parse(blobs.get("manifest.json").toString("utf8"));
  const excluded = EXCLUDED_PENDING_RIGHTS.filter((p) => all.some((e) => e.path === p));
  const files = new Map([[MARKER, Buffer.from(markerText({ version: manifest.version, commit, date, excluded }), "utf8")]]);
  for (const e of chosen) files.set(e.path, blobs.get(e.path));
  const sorted = new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return { commit, date, version: manifest.version, files: sorted, excluded };
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function archiveName(version, commit) {
  return `manekilex-${version}-${commit.slice(0, 7)}-PRIVATE-NOT-FOR-DISTRIBUTION.zip`;
}

function main(argv) {
  const arg = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  if (argv.includes("--verify")) {
    const zipPath = path.resolve(arg("--verify"));
    const buf = fs.readFileSync(zipPath);
    const files = readZip(buf);
    const errors = verifyContents(files);
    console.log(`${path.basename(zipPath)}: ${files.size} files, sha256 ${sha256(buf)}`);
    if (errors.length) {
      for (const e of errors) console.error(`  ✗ ${e}`);
      return 1;
    }
    console.log("  ✓ contents verified");
    return 0;
  }

  const pkg = packageFromCommit(arg("--ref") || "HEAD");
  if (argv.includes("--list")) {
    for (const [p, data] of pkg.files) console.log(`${String(data.length).padStart(10)}  ${p}`);
    return 0;
  }

  const errors = verifyContents(pkg.files);
  if (errors.length) {
    for (const e of errors) console.error(`✗ ${e}`);
    return 1;
  }
  const zip = buildZip(pkg.files, pkg.date);
  // 写完再读回来校验一次
  const reread = readZip(zip);
  if (reread.size !== pkg.files.size || [...pkg.files].some(([p, d]) => !reread.get(p) || !reread.get(p).equals(d))) {
    console.error("✗ 读回的压缩包与输入不一致");
    return 1;
  }

  const outDir = path.resolve(arg("--out") || path.join(ROOT, "dist"));
  fs.mkdirSync(outDir, { recursive: true });
  const name = archiveName(pkg.version, pkg.commit);
  const zipPath = path.join(outDir, name);
  fs.writeFileSync(zipPath, zip);
  const digest = sha256(zip);
  fs.writeFileSync(`${zipPath}.sha256`, `${digest}  ${name}\n`);
  const listing = [...pkg.files].map(([p, d]) => `${sha256(d)}  ${String(d.length).padStart(9)}  ${p}`).join("\n");
  fs.writeFileSync(path.join(outDir, name.replace(/\.zip$/, ".files.txt")), listing + "\n");

  const total = [...pkg.files.values()].reduce((n, d) => n + d.length, 0);
  console.log(`commit   ${pkg.commit}`);
  console.log(`version  ${pkg.version}`);
  console.log(`files    ${pkg.files.size} (${total} bytes)`);
  console.log(`excluded ${pkg.excluded.join(", ") || "(none)"}`);
  console.log(`archive  ${path.relative(ROOT, zipPath) || zipPath}`);
  console.log(`sha256   ${digest}`);
  console.log("PRIVATE BUILD — NOT FOR DISTRIBUTION");
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    console.error(`✗ ${err.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  EXCLUDED_PENDING_RIGHTS,
  MARKER,
  selectFiles,
  verifyContents,
  packageFromCommit,
  buildZip,
  readZip,
  crc32,
  archiveName,
  sha256,
};
