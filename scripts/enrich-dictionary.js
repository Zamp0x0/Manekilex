#!/usr/bin/env node
/**
 * 批量 DeepSeek 填充 data/dictionary_core.json
 *
 * 用法:
 *   node scripts/enrich-dictionary.js --scan
 *   node scripts/enrich-dictionary.js --resume --all-missing --force --adaptive
 *   node scripts/enrich-dictionary.js --retry-failed --force --adaptive
 *   （默认 adaptive 100 并发；高并发降低 prompt 缓存命中率、更费钱）
 */

"use strict";

const fs = require("fs");
const path = require("path");
const {
  isEnrichedEntry,
  mergeEnrichIntoEntry,
  forceFillEntry,
  termsAlignWithKey,
} = require("./dictionary-schema");
const { isExplicitEnrichRun, writeDictionaryAtomic } = require("./dictionary-file");

const ROOT = path.resolve(__dirname, "..");
const DICT_FILE = path.join(ROOT, "data", "dictionary_core.json");
const WORDFREQ_FILE = path.join(ROOT, "dic", "wordfreq-en-25000-log.json");
const PROGRESS_FILE = path.join(ROOT, "data", "enrich-progress.json");
const SCAN_REPORT = path.join(ROOT, "data", "enrich-scan-report.json");
const LOCK_FILE = path.join(ROOT, "data", ".enrich.lock");

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

const WORD_PROMPT =
  '仅输出 JSON：{"term":"","phonetic":"","part_of_speech":"","short_meaning":"","context_meaning":"","examples":[{"en":"","zh":""}],"memory_tip":"","common_collocations":[]}。' +
  'short_meaning=简体中文释义（必填，禁止英文；专名/地名也须用中文说明，如「澳大利亚昆士兰的国家公园」）。' +
  'context_meaning=简体中文语境或补充说明（禁止英文）。examples 最多2条，zh 必须为中文；collocations 最多4个；memory_tip 用中文。';

const XINYADA_SYSTEM =
  WORD_PROMPT +
  "释义须信雅达：信-准确完整不增不减；雅-用词自然得体避免翻译腔；达-通顺流畅符合中文习惯。" +
  "所有字段必须填满，禁止空字符串。";

const STRICT_USER = (term) =>
  `请为英文词条「${term}」输出完整 JSON。short_meaning、context_meaning、memory_tip 必须简体中文；` +
  `examples 恰好2条且 zh 为地道中文；common_collocations 2~4个。`;

const FORCE_USER = (term, hint) =>
  `词条：${term}${hint ? `\n已有释义参考：${hint}` : ""}\n` +
  `务必输出完整 JSON，全部中文释义信雅达，examples 含 en+zh，memory_tip 必填。`;

function parseArgs(argv) {
  const opts = {
    concurrency: 100,
    adaptive: false,
    startConcurrency: 100,
    maxConcurrency: 100,
    minConcurrency: 20,
    limit: Infinity,
    resume: false,
    retryFailed: false,
    allMissing: false,
    force: false,
    scan: false,
    checkpoint: 200,
    keysFile: "",
    keys: [],
    confirmFullRun: false,
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--resume") opts.resume = true;
    else if (a === "--retry-failed") opts.retryFailed = true;
    else if (a === "--all-missing") opts.allMissing = true;
    else if (a === "--force") opts.force = true;
    else if (a === "--scan") opts.scan = true;
    else if (a === "--adaptive") opts.adaptive = true;
    else if (a === "--confirm-full-run") opts.confirmFullRun = true;
    else if (a === "--concurrency") opts.concurrency = Math.max(1, parseInt(argv[++i], 10) || 100);
    else if (a === "--start") opts.startConcurrency = Math.max(1, parseInt(argv[++i], 10) || 100);
    else if (a === "--max") opts.maxConcurrency = Math.max(1, parseInt(argv[++i], 10) || 100);
    else if (a === "--min") opts.minConcurrency = Math.max(1, parseInt(argv[++i], 10) || 20);
    else if (a === "--limit") opts.limit = Math.max(1, parseInt(argv[++i], 10) || 100);
    else if (a === "--checkpoint") opts.checkpoint = Math.max(1, parseInt(argv[++i], 10) || 200);
    else if (a === "--model") opts.model = argv[++i] || opts.model;
    else if (a === "--keys-file") opts.keysFile = argv[++i] || "";
    else if (a === "--keys") {
      opts.keys = String(argv[++i] || "")
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
    }
  }
  if (opts.force && !opts.adaptive && opts.concurrency === 100) {
    opts.adaptive = true;
    opts.startConcurrency = 100;
    opts.maxConcurrency = 100;
    opts.minConcurrency = 20;
  }
  return opts;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function atomicWrite(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

function isProcessAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readLock() {
  if (!fs.existsSync(LOCK_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(LOCK_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function acquireEnrichLock() {
  const existing = readLock();
  if (existing?.pid && existing.pid !== process.pid && isProcessAlive(existing.pid)) {
    throw new Error(
      `已有 enrich 进程在运行 (pid=${existing.pid}, started=${existing.startedAt || "?"})。` +
        `请先结束该进程，勿并行跑 enrich，否则会覆盖 dictionary_core.json。`
    );
  }
  atomicWrite(
    LOCK_FILE,
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      argv: process.argv.slice(2),
    })
  );
}

function verifyEnrichLock() {
  const lock = readLock();
  if (lock?.pid && lock.pid !== process.pid) {
    throw new Error(`enrich 锁已被其他进程占用 (pid=${lock.pid})，中止写入以防覆盖`);
  }
}

function releaseEnrichLock() {
  const lock = readLock();
  if (lock?.pid === process.pid) {
    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {
      /* ignore */
    }
  }
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) return { failed: {} };
  try {
    return JSON.parse(fs.readFileSync(PROGRESS_FILE, "utf-8"));
  } catch {
    return { failed: {} };
  }
}

function loadWordfreqOrder() {
  if (!fs.existsSync(WORDFREQ_FILE)) return [];
  const raw = JSON.parse(fs.readFileSync(WORDFREQ_FILE, "utf-8"));
  const order = [];
  const seen = new Set();
  for (const row of raw) {
    const w = String(row[0] || "").trim().toLowerCase();
    if (!w || seen.has(w)) continue;
    seen.add(w);
    order.push(w);
  }
  return order;
}

function scanDictionary(dict, priorFailed) {
  const entries = Object.entries(dict);
  const enriched = entries.filter(([, e]) => isEnrichedEntry(e));
  const missing = entries.filter(([, e]) => !isEnrichedEntry(e));
  const failedKeys = Object.keys(priorFailed || {});

  const reasonBuckets = {};
  for (const [k, reason] of Object.entries(priorFailed || {})) {
    const bucket = String(reason).includes("429")
      ? "rate_limit"
      : String(reason).includes("JSON")
        ? "parse_error"
        : String(reason).includes("未达 enriched")
          ? "validation_fail"
          : "other";
    reasonBuckets[bucket] = (reasonBuckets[bucket] || 0) + 1;
  }

  let withEcdictCn = 0;
  let emptyShort = 0;
  const failSamples = [];
  const missingSamples = [];

  for (const [k, e] of missing) {
    const short = String(e.short_meaning || "").trim();
    if (short && /[\u4e00-\u9fff]/.test(short)) withEcdictCn++;
    else emptyShort++;
    if (priorFailed[k] && failSamples.length < 30) {
      failSamples.push({ key: k, reason: priorFailed[k], short: short.slice(0, 40) });
    }
    if (!priorFailed[k] && missingSamples.length < 20) {
      missingSamples.push({ key: k, short: short.slice(0, 40) });
    }
  }

  return {
    scannedAt: new Date().toISOString(),
    total: entries.length,
    enriched: enriched.length,
    missing: missing.length,
    failedLogged: failedKeys.length,
    missingNotInFailLog: missing.length - failedKeys.filter((k) => !isEnrichedEntry(dict[k])).length,
    reasonBuckets,
    withEcdictCn,
    emptyShort,
    failSamples,
    missingSamples,
    failedKeys,
  };
}

function loadKeysFromFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (Array.isArray(raw.keys)) return raw.keys.map(String).filter(Boolean);
  if (Array.isArray(raw.failed)) return raw.failed.map((x) => String(x.key || x)).filter(Boolean);
  if (raw.anomalies && typeof raw.anomalies === "object") {
    return Object.keys(raw.anomalies);
  }
  return [];
}

function buildQueue(dict, wordfreqOrder, opts, priorFailed) {
  const explicitKeys = [
    ...opts.keys,
    ...(opts.keysFile ? loadKeysFromFile(path.resolve(opts.keysFile)) : []),
  ];
  if (explicitKeys.length) {
    const seen = new Set();
    return explicitKeys.filter((k) => {
      if (!dict[k] || seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  if (opts.retryFailed) {
    return Object.keys(priorFailed).filter((k) => dict[k] && !isEnrichedEntry(dict[k]));
  }

  if (opts.allMissing) {
    const order = [];
    const seen = new Set();
    for (const key of wordfreqOrder) {
      if (!dict[key] || isEnrichedEntry(dict[key])) continue;
      order.push(key);
      seen.add(key);
    }
    for (const key of Object.keys(dict).sort()) {
      if (seen.has(key) || isEnrichedEntry(dict[key])) continue;
      order.push(key);
    }
    return order;
  }

  const allKeys = new Set(Object.keys(dict));
  const pending = [];
  for (const key of wordfreqOrder) {
    if (!allKeys.has(key)) continue;
    if (opts.resume && isEnrichedEntry(dict[key])) continue;
    pending.push(key);
    allKeys.delete(key);
  }
  for (const key of [...allKeys].sort()) {
    if (opts.resume && isEnrichedEntry(dict[key])) continue;
    pending.push(key);
  }
  return pending;
}

function parseModelJson(rawText) {
  if (!rawText) throw new Error("模型返回为空");
  try {
    return JSON.parse(rawText);
  } catch {
    const match = rawText.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("无法解析 JSON");
  }
}

function validateMergeDetail(merged) {
  const missing = [];
  if (!merged.short_meaning || !/[\u4e00-\u9fff]/.test(merged.short_meaning)) {
    missing.push("short_meaning中文");
  }
  if (!Array.isArray(merged.examples) || merged.examples.length === 0) {
    missing.push("examples");
  }
  if (!merged.memory_tip || !/[\u4e00-\u9fff]/.test(merged.memory_tip)) {
    missing.push("memory_tip中文");
  }
  return missing;
}

async function callDeepSeek(apiKey, userContent, model, systemPrompt, on429) {
  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      const res = await fetch(DEEPSEEK_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userContent },
          ],
          temperature: 0.15,
          max_tokens: 480,
          response_format: { type: "json_object" },
        }),
      });

      const data = await res.json();

      if (res.status === 429) {
        on429?.();
        await sleep(Math.min(120000, 5000 * 2 ** attempt));
        continue;
      }

      if (!res.ok) {
        throw new Error(data?.error?.message || `HTTP ${res.status}`);
      }

      const rawText = data.choices?.[0]?.message?.content?.trim() || "";
      return parseModelJson(rawText);
    } catch (err) {
      lastErr = err;
      await sleep(Math.min(30000, 2000 * 2 ** attempt));
    }
  }
  throw lastErr || new Error("DeepSeek 请求失败");
}

function createAdaptiveScheduler(initial, min, max) {
  let limit = initial;
  let inFlight = 0;
  let last429At = 0;
  let successSince429 = 0;
  const waiters = [];

  function on429() {
    last429At = Date.now();
    successSince429 = 0;
    const next = Math.max(min, Math.floor(limit / 2));
    if (next < limit) {
      console.warn(`[adaptive] 429 → 并发 ${limit} → ${next}`);
      limit = next;
    }
  }

  function onSuccess() {
    successSince429++;
    if (successSince429 >= 300 && limit < max && Date.now() - last429At > 30000) {
      const next = Math.min(max, limit + Math.max(20, Math.floor(limit * 0.1)));
      if (next > limit) {
        console.log(`[adaptive] 稳定 → 并发 ${limit} → ${next}`);
        limit = next;
        successSince429 = 0;
      }
    }
  }

  async function acquire() {
    while (inFlight >= limit) {
      await new Promise((r) => waiters.push(r));
    }
    inFlight++;
  }

  function release() {
    inFlight--;
    const w = waiters.shift();
    if (w) w();
  }

  return { acquire, release, on429, onSuccess, currentLimit: () => limit };
}

async function fetchEnriched(apiKey, term, hint, model, force, on429) {
  const system = force ? XINYADA_SYSTEM : WORD_PROMPT;
  const attempts = force
    ? [
        FORCE_USER(term, hint),
        STRICT_USER(term),
        term,
      ]
    : [term, STRICT_USER(term)];

  let lastParsed = null;
  for (const userMsg of attempts) {
    try {
      lastParsed = await callDeepSeek(apiKey, userMsg, model, system, on429);
      return lastParsed;
    } catch {
      /* next attempt */
    }
  }
  if (lastParsed) return lastParsed;
  throw new Error("多次请求均未返回有效 JSON");
}

/**
 * 付费闸：没有明确范围（--keys / --keys-file / --retry-failed / --limit N）又没有
 * --confirm-full-run 时，直接拒绝；不会读词典、不会加锁、不会发任何请求。
 */
function ensureExplicitRun(opts) {
  if (opts.scan || isExplicitEnrichRun(opts)) return;
  console.error(
    "拒绝执行：这会对词典里全部未 enrich 的词条排队付费请求。\n" +
      "请明确范围：--keys a,b 或 --keys-file f 或 --retry-failed 或 --limit N；\n" +
      "确实要全量补全时加 --confirm-full-run（建议先 --scan 查看待处理数量）。"
  );
  process.exit(2);
}

async function main() {
  const opts = parseArgs(process.argv);
  ensureExplicitRun(opts);
  const priorProgress = loadProgress();
  const failedKeys = { ...(priorProgress.failed || {}) };

  const dict = JSON.parse(fs.readFileSync(DICT_FILE, "utf-8"));

  if (opts.scan) {
    const report = scanDictionary(dict, failedKeys);
    atomicWrite(SCAN_REPORT, JSON.stringify(report, null, 2));
    console.log("=== Enrich 扫描报告 ===");
    console.log(`总词条: ${report.total}`);
    console.log(`已 enrich: ${report.enriched}`);
    console.log(`未 enrich: ${report.missing}`);
    console.log(`fail 日志: ${report.failedLogged} 条`);
    console.log(`fail 原因分布:`, report.reasonBuckets);
    console.log(`未 enrich 有 ECDICT 中文: ${report.withEcdictCn}`);
    console.log(`未 enrich 无 short_meaning: ${report.emptyShort}`);
    console.log(`\nfail 样本（前10）:`);
    report.failSamples.slice(0, 10).forEach((s) => console.log(`  ${s.key}: ${s.reason}`));
    console.log(`\n报告已写入: ${SCAN_REPORT}`);
    return;
  }

  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || "";
  if (!apiKey.trim()) {
    console.error("请设置环境变量 DEEPSEEK_API_KEY");
    process.exit(1);
  }

  acquireEnrichLock();
  process.on("exit", releaseEnrichLock);

  console.log("=== Manekilex Dictionary Enrich ===");
  console.log(
    "省钱提示: 默认 100 并发；仅开一个终端；先 --scan 再决定是否补跑；勿重复 --all-missing"
  );
  console.log(`模型: ${opts.model}`);
  if (opts.force) console.log("模式: force 强行补全（信雅达）");
  if (opts.retryFailed) console.log("队列: 仅 fail 日志");
  if (opts.allMissing) console.log("队列: 全部未 enrich");
  if (opts.keys.length || opts.keysFile) {
    console.log(`队列: 指定词条 (${opts.keys.length || "file"} keys)`);
  }
  if (opts.adaptive) {
    console.log(`并发: adaptive ${opts.startConcurrency} → ${opts.maxConcurrency}`);
  } else {
    console.log(`并发: ${opts.concurrency}`);
  }

  const wordfreqOrder = loadWordfreqOrder();
  let queue = buildQueue(dict, wordfreqOrder, opts, failedKeys);
  if (Number.isFinite(opts.limit) && opts.limit < queue.length) {
    queue = queue.slice(0, opts.limit);
  }

  const alreadyEnriched = Object.values(dict).filter((e) => isEnrichedEntry(e)).length;
  console.log(`已 enrich: ${alreadyEnriched} · 待处理: ${queue.length}\n`);

  if (queue.length === 0) {
    console.log("没有待处理词条。");
    return;
  }

  const scheduler = opts.adaptive
    ? createAdaptiveScheduler(opts.startConcurrency, opts.minConcurrency, opts.maxConcurrency)
    : null;

  let done = 0;
  let ok = 0;
  let fail = 0;
  const startedAll = Date.now();
  let saving = false;
  let saveRequested = false;

  async function flushToDisk() {
    if (saving) {
      saveRequested = true;
      return;
    }
    saving = true;
    try {
      verifyEnrichLock();
      writeDictionaryAtomic(DICT_FILE, dict);
      atomicWrite(
        PROGRESS_FILE,
        JSON.stringify(
          {
            updatedAt: new Date().toISOString(),
            enriched: Object.values(dict).filter((e) => isEnrichedEntry(e)).length,
            failed: failedKeys,
            concurrency: scheduler ? scheduler.currentLimit() : opts.concurrency,
            model: opts.model,
            force: opts.force,
            lastDone: done,
          },
          null,
          2
        )
      );
    } finally {
      saving = false;
      if (saveRequested) {
        saveRequested = false;
        await flushToDisk();
      }
    }
  }

  async function processKey(key) {
    const existing = dict[key];
    const hint = String(existing?.short_meaning || "").slice(0, 80);
    const on429 = () => scheduler?.on429();

    try {
      let parsed = await fetchEnriched(
        apiKey,
        key,
        hint,
        opts.model,
        opts.force,
        on429
      );

      if (!termsAlignWithKey(key, parsed?.term)) {
        parsed = await fetchEnriched(apiKey, key, hint, opts.model, true, on429);
      }
      if (!termsAlignWithKey(key, parsed?.term)) {
        // 两次都答非所问：记为失败，不把别的词的释义写到这个 key 下（Phase 5，原来会强行 term=key）
        throw new Error(`模型返回的 term「${String(parsed?.term || "")}」与 key 不一致`);
      }

      let merged;
      if (opts.force) {
        merged = forceFillEntry(existing, parsed, key);
      } else {
        merged = mergeEnrichIntoEntry(existing, parsed, key);
        if (!merged.enriched) {
          const parsed2 = await fetchEnriched(apiKey, key, hint, opts.model, true, on429);
          merged = mergeEnrichIntoEntry(existing, parsed2, key);
        }
        if (!merged.enriched) {
          const missing = validateMergeDetail(merged);
          throw new Error(`未达 enriched 标准：${missing.join("、")}`);
        }
      }

      dict[key] = merged;
      delete failedKeys[key];
      ok++;
      scheduler?.onSuccess();
    } catch (err) {
      fail++;
      failedKeys[key] = err.message || String(err);
      if (fail <= 8 || fail % 50 === 0) {
        console.error(`[FAIL] ${key}: ${failedKeys[key]}`);
      }
    }

    done++;
    if (done % 100 === 0 || done === queue.length) {
      const rate = (done / Math.max(1, (Date.now() - startedAll) / 1000)).toFixed(1);
      const conc = scheduler ? scheduler.currentLimit() : opts.concurrency;
      console.log(`[${done}/${queue.length}] ok=${ok} fail=${fail} · ${rate}/s · conc=${conc}`);
    }

    if (ok > 0 && ok % opts.checkpoint === 0) {
      await flushToDisk();
      console.log(`  → checkpoint enriched=${Object.values(dict).filter((e) => isEnrichedEntry(e)).length}`);
    }
  }

  async function runFixed(n) {
    let qi = 0;
    await Promise.all(
      Array.from({ length: n }, async () => {
        while (true) {
          const i = qi++;
          if (i >= queue.length) break;
          await processKey(queue[i]);
        }
      })
    );
  }

  async function runAdaptive() {
    let qi = 0;
    const runners = Array.from({ length: opts.maxConcurrency }, async () => {
      while (true) {
        const i = qi++;
        if (i >= queue.length) break;
        await scheduler.acquire();
        try {
          await processKey(queue[i]);
        } finally {
          scheduler.release();
        }
      }
    });
    await Promise.all(runners);
  }

  const onExit = async () => {
    console.log("\n中断，保存中…");
    await flushToDisk();
    releaseEnrichLock();
    process.exit(0);
  };
  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);

  if (opts.adaptive) await runAdaptive();
  else await runFixed(opts.concurrency);

  await flushToDisk();
  releaseEnrichLock();

  const enrichedNow = Object.values(dict).filter((e) => isEnrichedEntry(e)).length;
  console.log("\n=== 完成 ===");
  console.log(`成功: ${ok} · 失败: ${fail} · 总 enriched: ${enrichedNow}/${Object.keys(dict).length}`);
  console.log(`剩余 fail: ${Object.keys(failedKeys).length}`);

  if (Object.keys(failedKeys).length > 0 && !opts.retryFailed) {
    console.log(`\n可执行: node scripts/enrich-dictionary.js --retry-failed --force --adaptive`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
