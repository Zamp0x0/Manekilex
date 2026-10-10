/**
 * provider-benchmark.js — 模型测速评分与汇总（无 HTTP / 无 storage）
 */
(function (global) {
  function hasCjk(text) {
    return /[\u4e00-\u9fff]/.test(String(text || ""));
  }

  function haystackFrom(parsed, rawText) {
    const parts = [];
    if (rawText) parts.push(String(rawText));
    if (parsed) {
      try {
        parts.push(JSON.stringify(parsed));
      } catch {
        /* noop */
      }
    }
    return parts.join("\n").toLowerCase();
  }

  function countKeywordHits(haystack, keywords) {
    const list = Array.isArray(keywords) ? keywords : [];
    if (!list.length) return { hit: 0, total: 0 };
    let hit = 0;
    for (const kw of list) {
      const k = String(kw || "").trim();
      if (!k) continue;
      if (/[\u4e00-\u9fff]/.test(k)) {
        if (haystack.includes(k)) hit++;
      } else if (haystack.includes(k.toLowerCase())) {
        hit++;
      }
    }
    return { hit, total: list.length };
  }

  function requiredFieldsOk(parsed, queryType) {
    if (!parsed || typeof parsed !== "object") return false;
    if (queryType === "sentence") {
      const hasTermOrTrans = !!(parsed.term || parsed.translation);
      const hasMeaning = !!(
        parsed.translation ||
        parsed.context_meaning ||
        parsed.nuance ||
        parsed.short_meaning
      );
      const hasExtra = !!(
        parsed.grammar_notes ||
        (Array.isArray(parsed.key_phrases) && parsed.key_phrases.length) ||
        parsed.nuance
      );
      return hasTermOrTrans && hasMeaning && hasExtra;
    }
    const hasTerm = !!(parsed.term || parsed.word);
    const hasMeaning = !!(parsed.short_meaning || parsed.context_meaning || parsed.translation);
    const hasExamples =
      (Array.isArray(parsed.examples) && parsed.examples.length > 0) ||
      !!parsed.example;
    return hasTerm && hasMeaning && hasExamples;
  }

  function chineseMeaningOk(parsed, rawText) {
    const fields = [
      parsed?.short_meaning,
      parsed?.context_meaning,
      parsed?.translation,
      parsed?.nuance,
    ];
    if (fields.some((f) => hasCjk(f))) return true;
    return hasCjk(rawText);
  }

  function conciseOk(rawText) {
    const len = String(rawText || "").length;
    return len > 0 && len <= 6000;
  }

  function scoreBenchmarkResult(parsed, rawText, benchmarkCase) {
    let score = 0;
    const queryType = benchmarkCase?.queryType || "word";
    const jsonParseOk = !!parsed;
    if (jsonParseOk) score += 20;

    const reqOk = requiredFieldsOk(parsed, queryType);
    if (reqOk) score += 20;

    if (chineseMeaningOk(parsed, rawText)) score += 20;

    const haystack = haystackFrom(parsed, rawText);
    const { hit, total } = countKeywordHits(haystack, benchmarkCase?.expectedKeywords);
    const expectedKeywordsHit = hit;
    const expectedKeywordsTotal = total;
    if (total > 0) {
      score += Math.round((hit / total) * 30);
    } else {
      score += 15;
    }

    if (conciseOk(rawText)) score += 10;

    return {
      qualityScore: Math.min(100, Math.max(0, score)),
      jsonParseOk,
      requiredFieldsOk: reqOk,
      expectedKeywordsHit,
      expectedKeywordsTotal,
    };
  }

  function categorizeBenchmarkError(status, message, extra) {
    const msg = String(message || "").slice(0, 300);
    if (extra === "timeout" || /timeout|aborted.*time/i.test(msg)) {
      return { errorCategory: "timeout", errorMessageShort: msg || "请求超时" };
    }
    if (status === 429) return { errorCategory: "rate_limited", errorMessageShort: msg || "429 限流" };
    if (status === 401 || status === 403)
      return { errorCategory: "auth", errorMessageShort: msg || "鉴权失败" };
    if (status === 404)
      return { errorCategory: "not_found", errorMessageShort: msg || "模型不存在或无权限" };
    if (status === 400)
      return { errorCategory: "bad_request", errorMessageShort: msg || "请求格式错误" };
    if (status >= 500)
      return { errorCategory: "server", errorMessageShort: msg || "服务端错误" };
    if (!status) return { errorCategory: "network", errorMessageShort: msg || "网络错误" };
    return { errorCategory: "unknown", errorMessageShort: msg || `HTTP ${status}` };
  }

  function computeSpeedScore(avgMs) {
    const ms = Number(avgMs) || 99999;
    if (ms <= 800) return 100;
    if (ms <= 1500) return 85;
    if (ms <= 2500) return 70;
    if (ms <= 4000) return 55;
    if (ms <= 7000) return 35;
    return 15;
  }

  /** 综合 Rank 排序：score ↓ → avgMs ↑ → quality ↓ → successRate ↓ */
  function compareBenchmarkRank(a, b) {
    const scoreDiff = (b.score || 0) - (a.score || 0);
    if (scoreDiff !== 0) return scoreDiff;
    const msA = a.avgMs ?? 99999;
    const msB = b.avgMs ?? 99999;
    if (msA !== msB) return msA - msB;
    const qualityDiff = (b.avgQualityScore || 0) - (a.avgQualityScore || 0);
    if (qualityDiff !== 0) return qualityDiff;
    return (b.successRate || 0) - (a.successRate || 0);
  }

  function rankBenchmarkSummaries(summaries) {
    const list = [...(summaries || [])].sort(compareBenchmarkRank);
    list.forEach((s, idx) => {
      s.rank = idx + 1;
    });
    return list;
  }

  function median(nums) {
    const arr = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (!arr.length) return null;
    const mid = Math.floor(arr.length / 2);
    return arr.length % 2 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
  }

  function percentile(nums, p) {
    const arr = nums.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (!arr.length) return null;
    const idx = Math.ceil((p / 100) * arr.length) - 1;
    return arr[Math.max(0, Math.min(arr.length - 1, idx))];
  }

  function summarizeModelResults(records) {
    const list = records || [];
    const successRows = list.filter((r) => r.success);
    const msList = successRows.map((r) => r.totalMs).filter(Number.isFinite);
    const qualityList = successRows.map((r) => r.qualityScore).filter(Number.isFinite);
    const avgMs = msList.length ? msList.reduce((a, b) => a + b, 0) / msList.length : null;
    const avgQualityScore = qualityList.length
      ? qualityList.reduce((a, b) => a + b, 0) / qualityList.length
      : 0;
    const successRate = list.length ? (successRows.length / list.length) * 100 : 0;
    const speedScore = computeSpeedScore(avgMs);
    const score = successRate * 0.3 + avgQualityScore * 0.4 + speedScore * 0.3;

    const errorsByCategory = {};
    list.filter((r) => !r.success).forEach((r) => {
      const cat = r.errorCategory || "unknown";
      errorsByCategory[cat] = (errorsByCategory[cat] || 0) + 1;
    });

    const sample = list[0] || {};
    return {
      providerId: sample.providerId,
      providerName: sample.providerName,
      model: sample.model,
      totalRequests: list.length,
      successRequests: successRows.length,
      failRequests: list.length - successRows.length,
      successRate: Math.round(successRate * 10) / 10,
      avgMs: avgMs != null ? Math.round(avgMs) : null,
      medianMs: median(msList) != null ? Math.round(median(msList)) : null,
      p90Ms: percentile(msList, 90) != null ? Math.round(percentile(msList, 90)) : null,
      minMs: msList.length ? Math.min(...msList) : null,
      maxMs: msList.length ? Math.max(...msList) : null,
      avgQualityScore: Math.round(avgQualityScore * 10) / 10,
      avgOutputChars:
        successRows.length
          ? Math.round(
              successRows.reduce((a, r) => a + (r.outputChars || 0), 0) / successRows.length
            )
          : 0,
      avgTotalTokens:
        successRows.length
          ? Math.round(
              successRows.reduce((a, r) => a + (r.totalTokens || 0), 0) / successRows.length
            )
          : 0,
      errorsByCategory,
      score: Math.round(score * 10) / 10,
      caseDetails: list,
    };
  }

  function buildRecommendations(summaries) {
    const ranked = rankBenchmarkSummaries(summaries);
    const ok = ranked.filter((s) => s.successRate >= 60);

    const speed = ok
      .filter((s) => s.avgQualityScore >= 60 && s.successRate >= 80)
      .sort((a, b) => (a.avgMs || 99999) - (b.avgMs || 99999));

    const balanced = ok
      .filter((s) => (s.avgMs || 99999) <= 4000 && s.avgQualityScore >= 70)
      .sort(compareBenchmarkRank);

    const quality = ok
      .filter((s) => s.successRate >= 80)
      .sort((a, b) => {
        const q = (b.avgQualityScore || 0) - (a.avgQualityScore || 0);
        if (q !== 0) return q;
        return (a.avgMs || 99999) - (b.avgMs || 99999);
      });

    const notRecommended = ranked.filter(
      (s) => s.successRate < 60 || (s.avgMs || 0) > 8000 || s.avgQualityScore < 50
    );

    return {
      speed: speed.slice(0, 5),
      balanced: balanced.slice(0, 5),
      quality: quality.slice(0, 5),
      notRecommended: notRecommended.slice(0, 8),
      ranked,
    };
  }

  function parseBenchmarkCustomModels(text) {
    const out = {};
    const warnings = [];
    String(text || "")
      .split(/\n/)
      .forEach((rawLine) => {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) return;
        const idx = line.indexOf(":");
        if (idx <= 0) {
          warnings.push(`跳过无效行: ${line.slice(0, 40)}`);
          return;
        }
        const pid = line.slice(0, idx).trim();
        const model = line.slice(idx + 1).trim();
        if (!pid || !model) return;
        if (!out[pid]) out[pid] = [];
        if (!out[pid].includes(model)) out[pid].push(model);
      });
    return { map: out, warnings };
  }

  function parseCustomModelsText(text) {
    return parseBenchmarkCustomModels(text).map;
  }

  function getBenchmarkModelsForCurrentProvider(activeProviderId, providers, customText) {
    const { map: customMap } = parseBenchmarkCustomModels(customText);
    const customModels = customMap[activeProviderId];

    if (customModels?.length) {
      return {
        providerIds: [activeProviderId],
        modelsByProvider: { [activeProviderId]: customModels },
        source: "custom-current-provider",
      };
    }

    const preset =
      typeof zehBenchmarkModelsForMode === "function"
        ? zehBenchmarkModelsForMode(activeProviderId, "current-provider")
        : ZEH_BENCHMARK_MODELS_QUICK[activeProviderId] || ZEH_BENCHMARK_MODELS[activeProviderId] || [];

    if (preset.length) {
      return {
        providerIds: [activeProviderId],
        modelsByProvider: { [activeProviderId]: [...preset] },
        source: "preset-current-provider",
      };
    }

    const model =
      providers?.[activeProviderId]?.model ||
      ZEH_PROVIDER_META?.[activeProviderId]?.defaultModel;

    return {
      providerIds: [activeProviderId],
      modelsByProvider: { [activeProviderId]: model ? [model] : [] },
      source: "current-model-only",
    };
  }

  function getModelsForProvider(providerId, customMap, mode, modelsByProviderOverride) {
    if (modelsByProviderOverride?.[providerId]?.length) {
      return [...modelsByProviderOverride[providerId]];
    }
    const m = mode || "quick";
    const base =
      typeof zehBenchmarkModelsForMode === "function"
        ? zehBenchmarkModelsForMode(providerId, m)
        : (ZEH_BENCHMARK_MODELS_QUICK[providerId] || ZEH_BENCHMARK_MODELS[providerId] || []);
    const extra = (customMap && customMap[providerId]) || [];
    return [...new Set([...base, ...extra].map((x) => String(x || "").trim()).filter(Boolean))];
  }

  function estimateTaskCount(mode, providerIds, customMap, modelsByProviderOverride) {
    const plan = ZEH_BENCHMARK_MODE_PLAN?.[mode] || ZEH_BENCHMARK_MODE_PLAN?.quick;
    const caseCount = plan?.caseIds?.length || ZEH_BENCHMARK_CASES.length;
    const reps = plan?.repetitions || 1;
    let models = 0;
    (providerIds || []).forEach((pid) => {
      models += getModelsForProvider(pid, customMap, mode, modelsByProviderOverride).length;
    });
    return models * caseCount * reps;
  }

  const BENCHMARK_MODEL_SOURCE_LABELS = {
    "custom-current-provider": "自定义当前 Provider 列表",
    "preset-current-provider": "预设列表",
    "current-model-only": "当前模型",
    "quick-preset": "快速预设",
    "full-preset": "完整预设",
  };

  function benchmarkModelSourceLabel(source) {
    return BENCHMARK_MODEL_SOURCE_LABELS[source] || source || "";
  }

  global.ZEHProviderBenchmark = {
    scoreBenchmarkResult,
    categorizeBenchmarkError,
    computeSpeedScore,
    compareBenchmarkRank,
    rankBenchmarkSummaries,
    summarizeModelResults,
    buildRecommendations,
    getModelsForProvider,
    getBenchmarkModelsForCurrentProvider,
    estimateTaskCount,
    parseBenchmarkCustomModels,
    parseCustomModelsText,
    benchmarkModelSourceLabel,
    median,
    percentile,
  };
})(typeof self !== "undefined" ? self : globalThis);
