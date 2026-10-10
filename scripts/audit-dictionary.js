#!/usr/bin/env node
/**
 * 词典质检：结构检查 + DeepSeek 语义校验（张冠李戴、释义离谱等）
 *
 * 用法:
 *   node scripts/audit-dictionary.js --structural
 *   node scripts/audit-dictionary.js --semantic --adaptive   （默认 100 并发；全量语义质检很费 API）
 *   node scripts/audit-dictionary.js --all --adaptive
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { isEnrichedEntry, termsAlignWithKey } = require("./dictionary-schema");

const ROOT = path.resolve(__dirname, "..");
const DICT_FILE = path.join(ROOT, "data", "dictionary_core.json");
const AUDIT_REPORT = path.join(ROOT, "data", "enrich-audit-report.json");
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";

const AUDIT_SYSTEM =
  "你是英汉词典质检员。判断给定英文词条与其中文释义是否对应正确。" +
  "若释义张冠李戴、完全无关、明显错词（如 apple 译成香蕉）、或仅翻译了无关义项，则 ok=false。" +
  "专有名词/缩写/数字词条允许意译，但须与词条相关。" +
  '仅输出 JSON：{"ok":true} 或 {"ok":false,"reason":"10字内原因"}';

function parseArgs(argv) {
  const opts = {
    structural: false,
    semantic: false,
    all: false,
    adaptive: false,
    startConcurrency: 100,
    maxConcurrency: 100,
    minConcurrency: 20,
    concurrency: 100,
    limit: Infinity,
    enrichedOnly: true,
    model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--structural") opts.structural = true;
    else if (a === "--semantic") opts.semantic = true;
    else if (a === "--all") opts.all = true;
    else if (a === "--adaptive") opts.adaptive = true;
    else if (a === "--all-entries") opts.enrichedOnly = false;
    else if (a === "--start") opts.startConcurrency = Math.max(1, parseInt(argv[++i], 10) || 100);
    else if (a === "--max") opts.maxConcurrency = Math.max(1, parseInt(argv[++i], 10) || 100);
    else if (a === "--min") opts.minConcurrency = Math.max(1, parseInt(argv[++i], 10) || 20);
    else if (a === "--concurrency") opts.concurrency = Math.max(1, parseInt(argv[++i], 10) || 100);
    else if (a === "--limit") opts.limit = Math.max(1, parseInt(argv[++i], 10) || 100);
    else if (a === "--model") opts.model = argv[++i] || opts.model;
  }
  if (opts.all) {
    opts.structural = true;
    opts.semantic = true;
    opts.enrichedOnly = false;
  }
  if (!opts.structural && !opts.semantic) opts.structural = true;
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

function normalizeTerm(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/['']/g, "'");
}

function exampleMentionsTerm(exampleEn, term) {
  const en = String(exampleEn || "").toLowerCase();
  const t = normalizeTerm(term);
  if (!en || !t) return false;
  if (en.includes(t)) return true;
  if (t.length >= 4 && en.includes(t.slice(0, Math.max(3, t.length - 1)))) return true;
  return false;
}

function structuralCheck(key, entry, opts) {
  const issues = [];
  const term = String(entry?.term || key).trim();
  const short = String(entry?.short_meaning || "").trim();
  const memory = String(entry?.memory_tip || "").trim();
  const examples = Array.isArray(entry?.examples) ? entry.examples : [];

  if (!isEnrichedEntry(entry)) {
    if (!opts.enrichedOnly) {
      issues.push({ type: "not_enriched", detail: "未达 enriched 标准" });
    }
    return issues;
  }

  if (!termsAlignWithKey(key, term)) {
    issues.push({ type: "term_key_mismatch", detail: `term=${term} key=${key}` });
  }

  if (entry?.enriched === true && !isEnrichedEntry(entry)) {
    issues.push({ type: "enriched_flag_invalid", detail: "enriched=true 但字段不完整" });
  }

  if (short && !/[\u4e00-\u9fff]/.test(short)) {
    issues.push({ type: "short_not_chinese", detail: short.slice(0, 40) });
  }

  if (isEnrichedEntry(entry)) {
    if (!memory || !/[\u4e00-\u9fff]/.test(memory)) {
      issues.push({ type: "memory_not_chinese", detail: memory.slice(0, 40) });
    }
    if (examples.length === 0) {
      issues.push({ type: "no_examples", detail: "" });
    } else {
      for (const ex of examples) {
        if (!String(ex?.zh || "").trim() || !/[\u4e00-\u9fff]/.test(ex.zh)) {
          issues.push({ type: "example_zh_invalid", detail: JSON.stringify(ex).slice(0, 60) });
          break;
        }
      }
      const hasMention = examples.some((ex) => exampleMentionsTerm(ex.en, term));
      if (!hasMention && term.length >= 3 && /^[a-z]/i.test(term)) {
        issues.push({ type: "example_term_absent", detail: examples[0]?.en?.slice(0, 50) || "" });
      }
    }
  }

  return issues;
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
    limit = Math.max(min, Math.floor(limit / 2));
  }

  function onSuccess() {
    successSince429++;
    if (successSince429 >= 300 && limit < max && Date.now() - last429At > 30000) {
      limit = Math.min(max, limit + Math.max(20, Math.floor(limit * 0.1)));
      successSince429 = 0;
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

async function callAudit(apiKey, key, entry, model, on429) {
  const term = String(entry?.term || key).trim();
  const short = String(entry?.short_meaning || "").trim();
  const ctx = String(entry?.context_meaning || "").trim();
  const ex0 = entry?.examples?.[0];
  const userContent =
    `词条: ${term}\n` +
    `short_meaning: ${short}\n` +
    (ctx ? `context_meaning: ${ctx}\n` : "") +
    (ex0 ? `例句: ${ex0.en} / ${ex0.zh}\n` : "");

  let lastErr;
  for (let attempt = 0; attempt < 6; attempt++) {
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
            { role: "system", content: AUDIT_SYSTEM },
            { role: "user", content: userContent },
          ],
          temperature: 0,
          max_tokens: 80,
          response_format: { type: "json_object" },
        }),
      });

      const data = await res.json();
      if (res.status === 429) {
        on429?.();
        await sleep(Math.min(120000, 5000 * 2 ** attempt));
        continue;
      }
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);

      const raw = data.choices?.[0]?.message?.content?.trim() || "";
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const m = raw.match(/\{[\s\S]*\}/);
        parsed = m ? JSON.parse(m[0]) : { ok: false, reason: "解析失败" };
      }
      return parsed;
    } catch (err) {
      lastErr = err;
      await sleep(Math.min(30000, 2000 * 2 ** attempt));
    }
  }
  throw lastErr || new Error("audit 请求失败");
}

async function runSemanticAudit(keys, dict, opts) {
  const apiKey = process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_KEY || "";
  if (!apiKey.trim()) {
    console.error("语义质检需要 DEEPSEEK_API_KEY");
    process.exit(1);
  }

  const scheduler = opts.adaptive
    ? createAdaptiveScheduler(opts.startConcurrency, opts.minConcurrency, opts.maxConcurrency)
    : null;

  const anomalies = {};
  let done = 0;
  let bad = 0;
  const started = Date.now();

  async function auditOne(key) {
    const entry = dict[key];
    try {
      const result = await callAudit(apiKey, key, entry, opts.model, () => scheduler?.on429());
      if (result?.ok !== true) {
        bad++;
        anomalies[key] = {
          source: "semantic",
          reason: result?.reason || "释义不匹配",
          short_meaning: entry?.short_meaning || "",
          term: entry?.term || key,
        };
      }
      scheduler?.onSuccess();
    } catch (err) {
      bad++;
      anomalies[key] = {
        source: "semantic_error",
        reason: err.message || String(err),
        short_meaning: entry?.short_meaning || "",
        term: entry?.term || key,
      };
    }
    done++;
    if (done % 200 === 0 || done === keys.length) {
      const rate = (done / Math.max(1, (Date.now() - started) / 1000)).toFixed(1);
      const conc = scheduler ? scheduler.currentLimit() : opts.concurrency;
      console.log(`[audit ${done}/${keys.length}] bad=${bad} · ${rate}/s · conc=${conc}`);
    }
  }

  if (scheduler) {
    let qi = 0;
    await Promise.all(
      Array.from({ length: opts.maxConcurrency }, async () => {
        while (true) {
          const i = qi++;
          if (i >= keys.length) break;
          await scheduler.acquire();
          try {
            await auditOne(keys[i]);
          } finally {
            scheduler.release();
          }
        }
      })
    );
  } else {
    let qi = 0;
    await Promise.all(
      Array.from({ length: opts.concurrency }, async () => {
        while (true) {
          const i = qi++;
          if (i >= keys.length) break;
          await auditOne(keys[i]);
        }
      })
    );
  }

  return anomalies;
}

async function main() {
  const opts = parseArgs(process.argv);
  const dict = JSON.parse(fs.readFileSync(DICT_FILE, "utf-8"));
  const allKeys = Object.keys(dict);
  const structuralKeys = opts.enrichedOnly
    ? allKeys.filter((k) => isEnrichedEntry(dict[k]))
    : allKeys;
  const limitedKeys =
    Number.isFinite(opts.limit) && opts.limit < structuralKeys.length
      ? structuralKeys.slice(0, opts.limit)
      : structuralKeys;

  console.log("=== Manekilex Dictionary Audit ===");
  if (opts.semantic) {
    console.log("省钱提示: 全量 --semantic 约 2.5 万次 API；优先 --structural（免费），语义仅扫可疑词");
  }
  console.log(`词条总数: ${allKeys.length} · 待检: ${limitedKeys.length}`);

  const anomalies = {};
  const structuralByType = {};

  if (opts.structural) {
    console.log("\n--- 结构质检 ---");
    for (const key of limitedKeys) {
      const issues = structuralCheck(key, dict[key], opts);
      if (!issues.length) continue;
      anomalies[key] = {
        source: "structural",
        issues,
        short_meaning: dict[key]?.short_meaning || "",
        term: dict[key]?.term || key,
      };
      for (const iss of issues) {
        structuralByType[iss.type] = (structuralByType[iss.type] || 0) + 1;
      }
    }
    console.log(`结构异常: ${Object.keys(anomalies).length} 条`);
    console.log("类型分布:", structuralByType);
  }

  if (opts.semantic) {
    const semanticKeys = allKeys.filter((k) => isEnrichedEntry(dict[k]));
    const toAudit = semanticKeys.filter((k) => !anomalies[k] || anomalies[k].source === "structural");
    console.log(`\n--- 语义质检 (${toAudit.length} 条) ---`);
    if (opts.adaptive) {
      console.log(`并发: adaptive ${opts.startConcurrency} → ${opts.maxConcurrency}`);
    }
    const semanticBad = await runSemanticAudit(toAudit, dict, opts);
    for (const [k, v] of Object.entries(semanticBad)) {
      if (anomalies[k]) {
        anomalies[k].semantic = v;
      } else {
        anomalies[k] = v;
      }
    }
  }

  const report = {
    auditedAt: new Date().toISOString(),
    total: allKeys.length,
    checked: limitedKeys.length,
    anomalyCount: Object.keys(anomalies).length,
    structuralByType,
    keys: Object.keys(anomalies),
    anomalies,
    samples: Object.entries(anomalies)
      .slice(0, 20)
      .map(([k, v]) => ({ key: k, ...v })),
  };

  atomicWrite(AUDIT_REPORT, JSON.stringify(report, null, 2));

  console.log("\n=== 质检完成 ===");
  console.log(`异常词条: ${report.anomalyCount}`);
  console.log(`报告: ${AUDIT_REPORT}`);
  if (report.anomalyCount > 0) {
    console.log("\n样本:");
    report.samples.slice(0, 8).forEach((s) => {
      const reason =
        s.reason ||
        (s.issues && s.issues.map((i) => i.type).join(", ")) ||
        (s.semantic && s.semantic.reason) ||
        "?";
      console.log(`  ${s.key}: ${reason} · ${(s.short_meaning || "").slice(0, 30)}`);
    });
    console.log(
      `\n修复: node scripts/enrich-dictionary.js --keys-file data/enrich-audit-report.json --force --adaptive`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
