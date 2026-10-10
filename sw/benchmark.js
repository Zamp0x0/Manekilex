/**
 * Service worker 模块：provider benchmark 任务（开始、逐条执行、取消、清除、按结果设置模型）。
 *
 * 由 background.js 的 importScripts 列表加载。本文件只声明，加载时不调用任何 chrome API；
 * worker 启动时恢复进行中任务的那段代码留在 background.js。
 * 依赖：provider-benchmark.js（评分与推荐）、sw/settings.js（读取配置；按结果设置模型时用 zehWithProviderConfigLock
 *       与设置页保存排队）、sw/provider-client.js（原始请求）、
 *       config.js（benchmark 用例与 storage 键）。
 * 任务状态只存在 storage；benchmarkJobRuntime 只记录当前 worker 内正在运行的循环，重启后由恢复逻辑重新开始。
 */

// ─── Provider Benchmark (job + checkpoint) ───────────────────────────────────

let benchmarkJobRuntime = {
  jobId: null,
  abortController: null,
  running: false,
};

function benchmarkSafeError(err) {
  return String(err?.message || err || "未知错误").slice(0, 300);
}

function benchmarkSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadBenchmarkJobFromStorage() {
  const data = await chrome.storage.local.get([ZEH_STORAGE.providerBenchmarkJob]);
  return data[ZEH_STORAGE.providerBenchmarkJob] || null;
}

async function saveBenchmarkJob(job) {
  job.updatedAt = Date.now();
  await chrome.storage.local.set({ [ZEH_STORAGE.providerBenchmarkJob]: job });
}

/**
 * 测速循环保存自己手里的 job 副本：只有存储里仍是同一个 job 且仍在运行时才写入。
 * 已取消（或已被新 job 替换）时不写，返回 false，循环应停止，不能把 running 写回去。
 */
async function saveRunningBenchmarkJob(job, signal) {
  if (signal?.aborted) return false;
  const stored = await loadBenchmarkJobFromStorage();
  if (signal?.aborted) return false;
  if (!stored || stored.jobId !== job.jobId || stored.status !== "running") return false;
  await saveBenchmarkJob(job);
  return true;
}

function sanitizeBenchmarkJobForClient(job) {
  if (!job) return null;
  const copy = { ...job };
  delete copy.tasks;
  return copy;
}

function createBenchmarkCombinedSignal(parentSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const onAbort = () => {
    clearTimeout(timer);
    controller.abort();
  };

  if (parentSignal) {
    if (parentSignal.aborted) onAbort();
    else parentSignal.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => clearTimeout(timer),
    wasTimeout: () => timedOut && !parentSignal?.aborted,
  };
}

function getBenchmarkThrottleMs(providerId, lastErrorCategory) {
  if (lastErrorCategory === "rate_limited") {
    return 5000 + Math.floor(Math.random() * 5000);
  }
  if (providerId === "gemini") return 800;
  if (providerId === "siliconflow" || providerId === "zhipu" || providerId === "moonshot") {
    return 1000;
  }
  return 600;
}

function buildBenchmarkTaskList(mode, providers, mergedCustom, providerIds, modelsByProviderOverride) {
  const plan = ZEH_BENCHMARK_MODE_PLAN[mode] || ZEH_BENCHMARK_MODE_PLAN.quick;
  const caseIds = zehBenchmarkCaseIdsForMode(mode);
  const cases = ZEH_BENCHMARK_CASES.filter((c) => caseIds.includes(c.id));
  const tasks = [];

  for (const pid of providerIds) {
    if (!(providers[pid]?.apiKey || "").trim()) continue;
    if (!ZEH_PROVIDER_META[pid]) continue;
    const models = ZEHProviderBenchmark.getModelsForProvider(
      pid,
      mergedCustom,
      mode,
      modelsByProviderOverride
    );
    for (const model of models) {
      for (const benchmarkCase of cases) {
        for (let rep = 0; rep < plan.repetitions; rep++) {
          tasks.push({
            providerId: pid,
            model,
            caseId: benchmarkCase.id,
            rep,
          });
        }
      }
    }
  }
  return tasks;
}

function resolveBenchmarkActiveProviderId(appSettings, providers) {
  const merged = zehMigrateProviderModels(providers);
  const active = appSettings?.activeProvider;
  if (active && merged[active]?.enabled) return active;
  return ZEH_PROVIDER_IDS.find((pid) => merged[pid]?.enabled) || null;
}

function buildBenchmarkSummaryFromResults(results) {
  const byKey = new Map();
  (results || []).forEach((r) => {
    const key = `${r.providerId}\0${r.model}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  });
  const summaries = ZEHProviderBenchmark.rankBenchmarkSummaries(
    [...byKey.values()].map((rows) => ZEHProviderBenchmark.summarizeModelResults(rows))
  );
  const recommendations = ZEHProviderBenchmark.buildRecommendations(summaries);
  return { summaries, recommendations };
}

async function runSingleBenchmarkRequest(benchProvider, benchmarkCase, jobId, rep, signal, timeoutMs) {
  const startedAt = Date.now();
  const base = {
    jobId,
    providerId: benchProvider.id,
    providerName: benchProvider.meta.name,
    model: benchProvider.model,
    caseId: benchmarkCase.id,
    queryType: benchmarkCase.queryType,
    textLength: benchmarkCase.text.length,
    repetition: rep,
  };

  if (signal?.aborted) {
    return {
      ...base,
      success: false,
      startedAt,
      finishedAt: Date.now(),
      totalMs: 0,
      errorCategory: "cancelled",
      errorMessageShort: "已取消",
      qualityScore: 0,
      jsonParseOk: false,
      requiredFieldsOk: false,
      expectedKeywordsHit: 0,
      expectedKeywordsTotal: benchmarkCase.expectedKeywords?.length || 0,
      rawPreview: "",
    };
  }

  const combined = createBenchmarkCombinedSignal(signal, timeoutMs);
  const systemPrompt = zehBuildSystemPrompt(benchmarkCase.queryType);
  let raw;
  try {
    raw =
      benchProvider.type === "gemini" || benchProvider.id === "gemini"
        ? await callGeminiRaw(benchProvider, systemPrompt, benchmarkCase.text, {
            queryType: benchmarkCase.queryType,
            signal: combined.signal,
          })
        : await callOpenAICompatibleRaw(benchProvider, systemPrompt, benchmarkCase.text, {
            queryType: benchmarkCase.queryType,
            signal: combined.signal,
          });
  } finally {
    combined.cleanup();
  }

  if (combined.wasTimeout()) {
    return {
      ...base,
      success: false,
      errorCategory: "timeout",
      errorMessageShort: `请求超时（>${timeoutMs}ms）`,
      startedAt,
      finishedAt: Date.now(),
      totalMs: Date.now() - startedAt,
      ttfbMs: null,
      bodyMs: null,
      parseMs: 0,
      outputChars: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      jsonParseOk: false,
      requiredFieldsOk: false,
      expectedKeywordsHit: 0,
      expectedKeywordsTotal: benchmarkCase.expectedKeywords?.length || 0,
      qualityScore: 0,
      rawPreview: "",
    };
  }

  const finishedAt = Date.now();
  const parseStart = Date.now();
  let parsed = null;
  if (raw.ok && raw.rawText) {
    try {
      parsed = parseModelJson(raw.rawText);
    } catch {
      /* parse failed — scored below */
    }
  }
  const parseMs = Date.now() - parseStart;

  if (!raw.ok) {
    const isCancelled =
      raw.errorCategory === "cancelled" || raw.aborted || signal?.aborted;
    return {
      ...base,
      success: false,
      errorCategory: isCancelled ? "cancelled" : raw.errorCategory || "unknown",
      errorMessageShort: String(raw.errorMessageShort || "失败").slice(0, 300),
      startedAt,
      finishedAt,
      totalMs: raw.totalMs || finishedAt - startedAt,
      ttfbMs: raw.ttfbMs ?? null,
      bodyMs: raw.bodyMs ?? null,
      parseMs,
      outputChars: 0,
      promptTokens: raw.promptTokens || 0,
      completionTokens: raw.completionTokens || 0,
      totalTokens: raw.totalTokens || 0,
      jsonParseOk: false,
      requiredFieldsOk: false,
      expectedKeywordsHit: 0,
      expectedKeywordsTotal: benchmarkCase.expectedKeywords?.length || 0,
      qualityScore: 0,
      rawPreview: "",
    };
  }

  const scoreInfo = ZEHProviderBenchmark.scoreBenchmarkResult(parsed, raw.rawText, benchmarkCase);
  const rawPreview = String(raw.rawText || "").slice(0, 300);
  const jsonFailed = !scoreInfo.jsonParseOk;

  return {
    ...base,
    success: !jsonFailed,
    errorCategory: jsonFailed ? "parse_failed" : "",
    errorMessageShort: jsonFailed ? "JSON 解析失败" : "",
    startedAt,
    finishedAt,
    totalMs: raw.totalMs,
    ttfbMs: raw.ttfbMs ?? null,
    bodyMs: raw.bodyMs ?? null,
    parseMs,
    outputChars: rawPreview.length,
    promptTokens: raw.promptTokens || 0,
    completionTokens: raw.completionTokens || 0,
    totalTokens: raw.totalTokens || 0,
    jsonParseOk: scoreInfo.jsonParseOk,
    requiredFieldsOk: scoreInfo.requiredFieldsOk,
    expectedKeywordsHit: scoreInfo.expectedKeywordsHit,
    expectedKeywordsTotal: scoreInfo.expectedKeywordsTotal,
    qualityScore: scoreInfo.qualityScore,
    rawPreview,
  };
}

async function finalizeBenchmarkJob(job, status) {
  job.status = status;
  job.finishedAt = Date.now();
  job.summary = buildBenchmarkSummaryFromResults(job.results);
  await saveBenchmarkJob(job);

  const lastPayload = {
    runId: job.jobId,
    jobId: job.jobId,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    mode: job.mode,
    modelSource: job.modelSource,
    cancelled: status === "cancelled",
    records: job.results,
    summaries: job.summary.summaries,
    recommendations: job.summary.recommendations,
  };
  await chrome.storage.local.set({ [ZEH_STORAGE.providerBenchmarkLast]: lastPayload });
  return lastPayload;
}

async function runBenchmarkJobLoop(jobId) {
  if (benchmarkJobRuntime.running && benchmarkJobRuntime.jobId === jobId) return;
  // 本循环自己的 AbortController：新 job 启动后 benchmarkJobRuntime 会指向新 job
  const controller = new AbortController();
  benchmarkJobRuntime.running = true;
  benchmarkJobRuntime.jobId = jobId;
  benchmarkJobRuntime.abortController = controller;

  try {
    let job = await loadBenchmarkJobFromStorage();
    if (!job || job.jobId !== jobId) return;
    if (job.status !== "running") return;

    const appSettings = await getAppSettings();
    const providers = zehMigrateProviderModels(appSettings.providers);
    const plan = ZEH_BENCHMARK_MODE_PLAN[job.mode] || ZEH_BENCHMARK_MODE_PLAN.quick;
    const timeoutMs = plan.timeoutMs;
    const caseById = Object.fromEntries(ZEH_BENCHMARK_CASES.map((c) => [c.id, c]));
    const tasks = job.tasks || [];
    let startIndex = job.completedTasks || 0;
    let lastErrorCategory = null;

    for (let i = startIndex; i < tasks.length; i++) {
      job = await loadBenchmarkJobFromStorage();
      if (!job || job.jobId !== jobId || job.status !== "running") break;

      const task = tasks[i];
      const cfg = providers[task.providerId];
      const meta = ZEH_PROVIDER_META[task.providerId];
      const benchmarkCase = caseById[task.caseId];
      if (!cfg?.apiKey?.trim() || !meta || !benchmarkCase) {
        job.completedTasks = i + 1;
        if (!(await saveRunningBenchmarkJob(job, controller.signal))) break;
        continue;
      }

      job.currentProvider = meta.name;
      job.currentModel = task.model;
      job.currentCaseId = task.caseId;
      if (!(await saveRunningBenchmarkJob(job, controller.signal))) break;

      const benchProvider = {
        id: task.providerId,
        meta,
        type: meta.type || "openai-compatible",
        apiKey: cfg.apiKey,
        model: task.model,
      };

      const record = await runSingleBenchmarkRequest(
        benchProvider,
        benchmarkCase,
        jobId,
        task.rep,
        controller.signal,
        timeoutMs
      );

      if (!job.results) job.results = [];
      job.results.push(record);
      job.completedTasks = i + 1;
      lastErrorCategory = record.errorCategory || null;
      // 请求期间可能已取消：重新读状态，已取消就不保存这份过期副本
      if (!(await saveRunningBenchmarkJob(job, controller.signal))) break;

      job = await loadBenchmarkJobFromStorage();
      if (!job || job.jobId !== jobId || job.status !== "running") break;

      if (i < tasks.length - 1) {
        const delay = getBenchmarkThrottleMs(task.providerId, lastErrorCategory);
        await benchmarkSleep(delay);
      }
    }

    job = await loadBenchmarkJobFromStorage();
    if (!job || job.jobId !== jobId) return;

    // 终态（completed / cancelled 已收尾 / failed）不再改写
    if (job.status === "running" && !controller.signal.aborted) {
      await finalizeBenchmarkJob(job, "completed");
    } else if (job.status === "cancelled" && !job.finishedAt) {
      await finalizeBenchmarkJob(job, "cancelled");
    }
  } catch (err) {
    const job = await loadBenchmarkJobFromStorage();
    if (job && job.jobId === jobId && job.status === "cancelled" && !job.finishedAt) {
      await finalizeBenchmarkJob(job, "cancelled");
    } else if (job && job.jobId === jobId && job.status === "running") {
      job.status = "failed";
      job.error = benchmarkSafeError(err);
      job.finishedAt = Date.now();
      if (job.results?.length) {
        job.summary = buildBenchmarkSummaryFromResults(job.results);
        await chrome.storage.local.set({
          [ZEH_STORAGE.providerBenchmarkLast]: {
            runId: job.jobId,
            jobId: job.jobId,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt,
            mode: job.mode,
            cancelled: false,
            records: job.results,
            summaries: job.summary?.summaries || [],
            recommendations: job.summary?.recommendations || {},
            error: job.error,
          },
        });
      }
      await saveBenchmarkJob(job);
    }
  } finally {
    // 只清理自己的运行状态：取消后马上启动的新 job 已经换上了自己的 jobId / AbortController
    if (benchmarkJobRuntime.jobId === jobId) {
      benchmarkJobRuntime.running = false;
      benchmarkJobRuntime.jobId = null;
      benchmarkJobRuntime.abortController = null;
    }
  }
}

async function startBenchmarkJob(options) {
  if (benchmarkJobRuntime.running) {
    const existing = await loadBenchmarkJobFromStorage();
    if (existing?.status === "running") {
      throw new Error("已有测速任务在运行，请等待完成或取消后再试");
    }
  }

  const mode = options?.mode || "quick";
  const appSettings = await getAppSettings();
  const providers = zehMigrateProviderModels(appSettings.providers);

  const storedCustom = await chrome.storage.local.get([ZEH_STORAGE.providerBenchmarkCustomModels]);
  const mergedCustom = {
    ...(storedCustom[ZEH_STORAGE.providerBenchmarkCustomModels] || {}),
  };

  let providerIds = options?.providerIds;
  let modelsByProviderOverride = options?.modelsByProvider || null;
  let modelSource = mode === "full" ? "full-preset" : "quick-preset";

  if (mode === "current-provider") {
    const activeId =
      options?.activeProviderId || resolveBenchmarkActiveProviderId(appSettings, providers);
    if (!activeId) {
      throw new Error("请先启用一个模型厂商");
    }
    if (!(providers[activeId]?.apiKey || "").trim()) {
      throw new Error("当前 Provider 未填写 API Key。");
    }
    const customText = options?.customText ?? "";
    const selection = ZEHProviderBenchmark.getBenchmarkModelsForCurrentProvider(
      activeId,
      providers,
      customText
    );
    providerIds = selection.providerIds;
    modelsByProviderOverride = selection.modelsByProvider;
    modelSource = selection.source;
  } else if (!providerIds?.length) {
    providerIds = ZEH_PROVIDER_IDS.filter((id) => (providers[id]?.apiKey || "").trim());
  }

  const tasks = buildBenchmarkTaskList(
    mode,
    providers,
    mergedCustom,
    providerIds,
    modelsByProviderOverride
  );
  if (!tasks.length) {
    throw new Error("没有可测速的任务：请配置 API Key，或检查自定义模型列表");
  }

  const jobId = `bench_${Date.now()}`;
  const job = {
    jobId,
    status: "running",
    startedAt: Date.now(),
    finishedAt: null,
    updatedAt: Date.now(),
    mode,
    modelSource,
    totalTasks: tasks.length,
    completedTasks: 0,
    currentProvider: "",
    currentModel: "",
    currentCaseId: "",
    results: [],
    summary: null,
    error: null,
    tasks,
  };

  await saveBenchmarkJob(job);
  runBenchmarkJobLoop(jobId);
  return { jobId, totalTasks: tasks.length, mode, modelSource };
}

async function cancelBenchmarkJob() {
  const job = await loadBenchmarkJobFromStorage();
  if (!job || job.status !== "running") {
    return { ok: true, cancelled: false };
  }
  // 先同步中止这个 job 的在途请求，再写入 cancelled：循环保存前会看到 aborted，不会把 running 写回
  if (benchmarkJobRuntime.jobId === job.jobId && benchmarkJobRuntime.abortController) {
    benchmarkJobRuntime.abortController.abort();
  }
  job.status = "cancelled";
  await saveBenchmarkJob(job);
  return { ok: true, cancelled: true, jobId: job.jobId };
}

async function clearBenchmarkData() {
  await chrome.storage.local.remove([
    ZEH_STORAGE.providerBenchmarkJob,
    ZEH_STORAGE.providerBenchmarkLast,
  ]);
  return { ok: true };
}

async function setProviderModelFromBenchmark(providerId, model) {
  if (!providerId || !model || !ZEH_PROVIDER_META[providerId]) {
    throw new Error("无效的 provider 或模型名");
  }
  // 与设置页保存排同一条队列（sw/settings.js，M9）：读到的总是上一次写入之后的配置
  return zehWithProviderConfigLock(async () => {
    const data = await chrome.storage.local.get([ZEH_STORAGE.providers]);
    const providers = zehMigrateProviderModels(data[ZEH_STORAGE.providers] || zehDefaultProviders());
    providers[providerId] = providers[providerId] || {};
    providers[providerId].model = model;
    ZEH_PROVIDER_IDS.forEach((id) => {
      providers[id] = providers[id] || {};
      providers[id].enabled = id === providerId;
    });
    await chrome.storage.local.set({
      [ZEH_STORAGE.providers]: providers,
      [ZEH_STORAGE.activeProvider]: providerId,
    });
    return { ok: true, providerId, model };
  });
}
