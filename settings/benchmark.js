/**
 * 设置页「模型与 API」中的测速面板：读取 / 轮询 service worker 的测速任务，渲染结果、导出与取消。
 *
 * 加载时唯一的副作用是注册 beforeunload（离开页面时停止轮询），与拆分前相同。
 * 依赖：settings/core.js（storageGet、isExtensionAlive、escapeHtml）、
 *       settings/models.js（providersState、activeProvider、showStatus、renderModels、saveProviders）、
 *       provider-benchmark.js 与 shared/benchmark-cases.js（打分与候选模型）。
 */

const benchmarkState = {
  job: null,
  jobId: null,
  lastResult: null,
  customModelsText: "",
  expandedDetailKey: null,
  pollTimer: null,
  cancelInFlight: false,
};

function benchmarkStatusLabel(status) {
  const map = {
    running: "运行中",
    completed: "已完成",
    cancelled: "已取消",
    failed: "失败",
  };
  return map[status] || status || "未开始";
}

function jobToBenchmarkResult(job) {
  if (!job) return null;
  const buildFromResults = (results, partial) => {
    const byKey = new Map();
    (results || []).forEach((r) => {
      const k = `${r.providerId}\0${r.model}`;
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(r);
    });
    const summaries = ZEHProviderBenchmark.rankBenchmarkSummaries(
      [...byKey.values()].map((rows) => ZEHProviderBenchmark.summarizeModelResults(rows))
    );
    return {
      runId: job.jobId,
      jobId: job.jobId,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      mode: job.mode,
      modelSource: job.modelSource,
      cancelled: job.status === "cancelled",
      partial,
      records: results,
      summaries,
      recommendations: ZEHProviderBenchmark.buildRecommendations(summaries),
      error: job.error,
    };
  };

  if (job.summary?.summaries?.length) {
    return {
      runId: job.jobId,
      jobId: job.jobId,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      mode: job.mode,
      modelSource: job.modelSource,
      cancelled: job.status === "cancelled",
      records: job.results,
      summaries: job.summary.summaries,
      recommendations: job.summary.recommendations,
      error: job.error,
    };
  }
  if (job.results?.length) {
    return buildFromResults(job.results, job.status === "running");
  }
  return null;
}

function getBenchmarkProvidersWithKeys() {
  return ZEH_PROVIDER_IDS.filter((id) => (providersState[id]?.apiKey || "").trim());
}

function resolveActiveProviderIdForBenchmark() {
  syncProvidersFromDom();
  const enabled = ZEH_PROVIDER_IDS.find((id) => providersState[id]?.enabled);
  return enabled || activeProvider || null;
}

function estimateBenchmarkTasksHint(mode) {
  const customText = benchmarkState.customModelsText;
  const plan = ZEH_BENCHMARK_MODE_PLAN[mode];
  let count;

  if (mode === "current-provider") {
    const pid = resolveActiveProviderIdForBenchmark();
    if (!pid) return "请先启用一个模型厂商";
    const selection = ZEHProviderBenchmark.getBenchmarkModelsForCurrentProvider(
      pid,
      providersState,
      customText
    );
    const models = selection.modelsByProvider[pid]?.length || 0;
    const caseCount = plan?.caseIds?.length || ZEH_BENCHMARK_CASES.length;
    count = models * caseCount * (plan?.repetitions || 1);
  } else {
    const custom = ZEHProviderBenchmark.parseCustomModelsText(customText);
    count = ZEHProviderBenchmark.estimateTaskCount(mode, getBenchmarkProvidersWithKeys(), custom);
  }

  return `约 ${count} 次请求${plan?.timeoutMs ? ` · 单次超时 ${plan.timeoutMs / 1000}s` : ""}`;
}

function benchmarkModelSourceLine(jobOrResult) {
  const src = jobOrResult?.modelSource;
  if (!src) return "";
  const label = ZEHProviderBenchmark.benchmarkModelSourceLabel(src);
  return label ? ` · 模型来源：${label}` : "";
}

async function loadBenchmarkState() {
  const data = await storageGet([
    ZEH_STORAGE.providerBenchmarkLast,
    ZEH_STORAGE.providerBenchmarkJob,
    ZEH_STORAGE.providerBenchmarkCustomModels,
  ]);
  benchmarkState.lastResult = data[ZEH_STORAGE.providerBenchmarkLast] || null;
  benchmarkState.job = data[ZEH_STORAGE.providerBenchmarkJob] || null;
  benchmarkState.jobId = benchmarkState.job?.jobId || null;
  benchmarkState.customModelsText = formatBenchmarkCustomModelsText(
    data[ZEH_STORAGE.providerBenchmarkCustomModels] || {}
  );
  if (benchmarkState.job?.status === "running") {
    startBenchmarkPolling();
  }
}

function formatBenchmarkCustomModelsText(customMap) {
  const lines = [];
  Object.entries(customMap || {}).forEach(([pid, models]) => {
    (models || []).forEach((m) => {
      if (m) lines.push(`${pid}:${m}`);
    });
  });
  return lines.join("\n");
}

function formatBenchmarkExportFilename() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `zeh-provider-benchmark-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
}

function sanitizeBenchmarkExport(result) {
  if (!result) return null;
  const copy = JSON.parse(JSON.stringify(result));
  const strip = (obj) => {
    if (!obj || typeof obj !== "object") return;
    delete obj.apiKey;
    if (Array.isArray(obj)) obj.forEach(strip);
    else Object.values(obj).forEach((v) => typeof v === "object" && strip(v));
  };
  strip(copy);
  return copy;
}

function formatBenchmarkErrors(errorsByCategory) {
  if (!errorsByCategory || !Object.keys(errorsByCategory).length) return "—";
  return Object.entries(errorsByCategory)
    .map(([k, v]) => `${k}:${v}`)
    .join(", ");
}

function formatBenchmarkMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "—";
  return `${Math.round(ms)}ms`;
}

function renderBenchmarkRecommendations(rec) {
  if (!rec) return "";
  const block = (title, items, cls) => {
    if (!items?.length) {
      return `<div class="bench-rec-block"><h4>${escapeHtml(title)}</h4><p class="hint">暂无符合规则的推荐</p></div>`;
    }
    const rows = items
      .map(
        (s) =>
          `<li><strong>${escapeHtml(s.providerName || s.providerId)}</strong> · ${escapeHtml(s.model)} · 质量 ${s.avgQualityScore} · ${formatBenchmarkMs(s.avgMs)} · 综合 ${s.score}</li>`
      )
      .join("");
    return `<div class="bench-rec-block ${cls || ""}"><h4>${escapeHtml(title)}</h4><ul class="bench-rec-list">${rows}</ul></div>`;
  };
  return `
    <div class="bench-recommendations">
      ${block("极速查词推荐", rec.speed, "rec-speed")}
      ${block("平衡默认推荐", rec.balanced, "rec-balanced")}
      ${block("高质量语境推荐", rec.quality, "rec-quality")}
      ${block("不推荐", rec.notRecommended, "rec-bad")}
    </div>
  `;
}

function renderBenchmarkResultsTable(result) {
  const summaries = result?.summaries || [];
  if (!summaries.length) {
    return `<p class="hint">暂无测速结果。点击上方按钮开始测试。</p>`;
  }

  const rows = summaries
    .map((s) => {
      const key = `${s.providerId}\0${s.model}`;
      const expanded = benchmarkState.expandedDetailKey === key;
      const detailRows = (s.caseDetails || [])
        .map(
          (c) => `
          <tr>
            <td>${escapeHtml(c.caseId)}</td>
            <td>${c.success ? "✓" : "✗"}</td>
            <td>${formatBenchmarkMs(c.totalMs)}</td>
            <td>${c.qualityScore ?? "—"}</td>
            <td>${c.expectedKeywordsHit ?? 0}/${c.expectedKeywordsTotal ?? 0}</td>
            <td class="bench-preview">${escapeHtml(c.rawPreview || c.errorMessageShort || "—")}</td>
          </tr>`
        )
        .join("");

      return `
        <tr class="bench-row" data-key="${escapeHtml(key)}">
          <td>${s.rank ?? "—"}</td>
          <td>${escapeHtml(s.providerName || s.providerId)}</td>
          <td class="bench-model-cell">${escapeHtml(s.model)}</td>
          <td>${s.successRequests}/${s.totalRequests}</td>
          <td>${formatBenchmarkMs(s.avgMs)}</td>
          <td>${formatBenchmarkMs(s.medianMs)}</td>
          <td>${formatBenchmarkMs(s.p90Ms)}</td>
          <td>${s.avgQualityScore ?? "—"}</td>
          <td><strong>${s.score ?? "—"}</strong></td>
          <td class="bench-errors">${escapeHtml(formatBenchmarkErrors(s.errorsByCategory))}</td>
          <td class="bench-actions">
            <button type="button" class="mk-btn mk-btn-sm bench-set-default" data-provider="${escapeHtml(s.providerId)}" data-model="${escapeHtml(s.model)}">设为默认</button>
            <button type="button" class="mk-btn mk-btn-sm bench-toggle-detail" data-key="${escapeHtml(key)}">${expanded ? "收起" : "详情"}</button>
            <button type="button" class="mk-btn mk-btn-sm bench-copy-model" data-model="${escapeHtml(s.model)}">复制</button>
          </td>
        </tr>
        ${
          expanded
            ? `<tr class="bench-detail-row"><td colspan="11">
                <table class="bench-detail-table">
                  <thead><tr><th>Case</th><th>OK</th><th>耗时</th><th>质量</th><th>关键词</th><th>预览 / 错误</th></tr></thead>
                  <tbody>${detailRows}</tbody>
                </table>
              </td></tr>`
            : ""
        }`;
    })
    .join("");

  const meta = result.cancelled
    ? `<p class="bench-meta warn">上次测速已取消（部分结果已保留）</p>`
    : result.partial
      ? `<p class="bench-meta warn">测速进行中，以下为已完成部分的临时汇总</p>`
      : result.finishedAt
        ? `<p class="bench-meta">完成于 ${escapeHtml(zehFormatLocalTime(result.finishedAt))} · 模式 ${escapeHtml(result.mode || "")}${escapeHtml(benchmarkModelSourceLine(result))}</p>`
        : result.error
          ? `<p class="bench-meta warn">测速失败：${escapeHtml(result.error)}</p>`
          : "";

  return `
    ${meta}
    ${renderBenchmarkRecommendations(result.recommendations)}
    <div class="bench-table-wrap">
      <table class="bench-table">
        <thead>
          <tr>
            <th>Rank</th><th>Provider</th><th>Model</th><th>Success</th>
            <th>Avg</th><th>Median</th><th>P90</th><th>Quality</th><th>Score</th><th>Errors</th><th>操作</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function updateBenchmarkStatusDom() {
  const statusEl = document.getElementById("benchmarkStatus");
  const progressEl = document.getElementById("benchmarkProgress");
  const cancelBtn = document.getElementById("benchmarkCancelBtn");
  const resumeBanner = document.getElementById("benchmarkResumeBanner");
  if (!statusEl) return;

  const job = benchmarkState.job;
  const isRunning = job?.status === "running";

  if (resumeBanner) {
    resumeBanner.hidden = !isRunning;
  }

  if (isRunning) {
    const elapsed = job.startedAt ? Math.round((Date.now() - job.startedAt) / 1000) : 0;
    statusEl.textContent =
      `状态：${benchmarkStatusLabel(job.status)}${benchmarkModelSourceLine(job)} · ${job.currentProvider || "—"} / ${job.currentModel || "—"} / ${job.currentCaseId || "—"} · 进度 ${job.completedTasks || 0} / ${job.totalTasks || 0} · 已用时 ${elapsed}s`;
    if (progressEl && job.totalTasks) {
      progressEl.style.width = `${Math.round(((job.completedTasks || 0) / job.totalTasks) * 100)}%`;
    }
    if (cancelBtn) cancelBtn.disabled = false;
  } else if (job?.status === "cancelled") {
    statusEl.textContent = `状态：已取消 · 已完成 ${job.completedTasks || 0} / ${job.totalTasks || 0}`;
    if (progressEl) progressEl.style.width = "0%";
    if (cancelBtn) cancelBtn.disabled = true;
  } else if (job?.status === "failed") {
    statusEl.textContent = `状态：失败 · ${job.error || "未知错误"}`;
    if (progressEl) progressEl.style.width = "0%";
    if (cancelBtn) cancelBtn.disabled = true;
  } else if (job?.status === "completed") {
    statusEl.textContent = `状态：已完成 · ${job.completedTasks || 0} / ${job.totalTasks || 0}${benchmarkModelSourceLine(job)}`;
    if (progressEl) progressEl.style.width = "100%";
    if (cancelBtn) cancelBtn.disabled = true;
  } else {
    statusEl.textContent = benchmarkState.lastResult ? "上次测速结果见下方表格" : "尚未运行测速";
    if (progressEl) progressEl.style.width = "0%";
    if (cancelBtn) cancelBtn.disabled = true;
  }
}

function getBenchmarkDisplayResult() {
  const jobResult = jobToBenchmarkResult(benchmarkState.job);
  if (jobResult?.summaries?.length || jobResult?.partial) return jobResult;
  return benchmarkState.lastResult;
}

function renderBenchmarkPanel() {
  const mount = document.getElementById("benchmarkPanelMount");
  if (!mount) return;

  const isRunning = benchmarkState.job?.status === "running";
  const hasResult = Boolean(getBenchmarkDisplayResult()?.summaries?.length || benchmarkState.lastResult);
  const displayResult = getBenchmarkDisplayResult();

  mount.innerHTML = `
    <details class="benchmark-panel" open>
      <summary class="benchmark-summary">模型测速 Benchmark</summary>
      <div class="benchmark-body">
        <p class="hint benchmark-note">测速会使用你本地保存的 API Key 轮流请求多个模型。不会上传 API Key 到 Manekilex 服务器。测速会消耗各平台免费额度或余额。</p>
        <p id="benchmarkResumeBanner" class="bench-meta warn" ${isRunning ? "" : "hidden"}>检测到进行中的 benchmark 任务，正在恢复进度…</p>
        <div class="benchmark-actions">
          <button type="button" class="mk-btn mk-btn-primary" id="benchQuickBtn" ${isRunning ? "disabled" : ""} title="${escapeHtml(estimateBenchmarkTasksHint("quick"))}">快速测速</button>
          <button type="button" class="mk-btn mk-btn-primary" id="benchStandardBtn" ${isRunning ? "disabled" : ""} title="${escapeHtml(estimateBenchmarkTasksHint("standard"))}">标准测速</button>
          <button type="button" class="mk-btn" id="benchFullBtn" ${isRunning ? "disabled" : ""} title="${escapeHtml(estimateBenchmarkTasksHint("full"))}">完整测速</button>
          <button type="button" class="mk-btn" id="benchCurrentBtn" ${isRunning ? "disabled" : ""} title="${escapeHtml(estimateBenchmarkTasksHint("current-provider"))}">只测当前 Provider</button>
          <button type="button" class="mk-btn" id="benchExportBtn" ${hasResult ? "" : "disabled"}>导出结果 JSON</button>
          <button type="button" class="mk-btn" id="benchClearBtn" ${hasResult || benchmarkState.job ? "" : "disabled"}>清空测速结果</button>
          <button type="button" class="mk-btn mk-btn-danger" id="benchmarkCancelBtn" ${isRunning ? "" : "disabled"}>取消</button>
        </div>
        <p class="hint">快速 ≈ ${escapeHtml(estimateBenchmarkTasksHint("quick"))} · 标准 ≈ ${escapeHtml(estimateBenchmarkTasksHint("standard"))} · 完整 ≈ ${escapeHtml(estimateBenchmarkTasksHint("full"))}（按已配置 Key 的 provider 估算）</p>
        <div class="benchmark-status-wrap">
          <div class="benchmark-progress-track"><div class="benchmark-progress-bar" id="benchmarkProgress"></div></div>
          <p id="benchmarkStatus" class="benchmark-status">尚未运行测速</p>
        </div>
        <div class="field benchmark-custom-models">
          <label>自定义 Benchmark 模型（每行 <code>providerId:模型名</code>）</label>
          <p class="hint">只测当前 Provider 时，会自动从下面列表中筛选当前 providerId 的模型。例如当前启用 Groq，则只测试 <code>groq:</code> 开头的模型。</p>
          <textarea id="benchmarkCustomModels" rows="6" placeholder="groq:openai/gpt-oss-20b
groq:llama-3.3-70b-versatile
groq:qwen/qwen3-32b
groq:qwen/qwen3-27b
groq:openai/gpt-oss-120b
openai:gpt-6-luna
deepseek:deepseek-flash">${escapeHtml(benchmarkState.customModelsText)}</textarea>
        </div>
        <div id="benchmarkResults">${renderBenchmarkResultsTable(displayResult)}</div>
      </div>
    </details>
  `;

  updateBenchmarkStatusDom();
  wireBenchmarkPanelEvents();
}

function wireBenchmarkPanelEvents() {
  const mount = document.getElementById("benchmarkPanelMount");
  if (!mount) return;
  if (mount.dataset.wired === "1") return;
  mount.dataset.wired = "1";

  mount.addEventListener("click", async (e) => {
    const quick = e.target.closest("#benchQuickBtn");
    const standard = e.target.closest("#benchStandardBtn");
    const full = e.target.closest("#benchFullBtn");
    const current = e.target.closest("#benchCurrentBtn");
    const exportBtn = e.target.closest("#benchExportBtn");
    const clearBtn = e.target.closest("#benchClearBtn");
    const cancelBtn = e.target.closest("#benchmarkCancelBtn");
    const setDefault = e.target.closest(".bench-set-default");
    const toggleDetail = e.target.closest(".bench-toggle-detail");
    const copyModel = e.target.closest(".bench-copy-model");

    if (quick) return startProviderBenchmark("quick");
    if (standard) return startProviderBenchmark("standard");
    if (full) {
      if (!confirm("完整测速请求量较大、耗时较长，可能消耗较多 API 额度。确定继续？")) return;
      return startProviderBenchmark("full");
    }
    if (current) return startProviderBenchmark("current-provider");
    if (cancelBtn) {
      if (benchmarkState.cancelInFlight) return;
      if (!confirm("确定取消正在进行的测速？已完成的结果会保留。")) return;
      return cancelProviderBenchmark();
    }

    if (exportBtn) {
      const payload = sanitizeBenchmarkExport(getBenchmarkDisplayResult() || benchmarkState.lastResult);
      if (!payload) return;
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = formatBenchmarkExportFilename();
      a.click();
      URL.revokeObjectURL(url);
      return;
    }

    if (clearBtn) {
      if (!confirm("确定清空本地保存的测速任务与结果？")) return;
      stopBenchmarkPolling();
      try {
        await chrome.runtime.sendMessage({ type: "CLEAR_PROVIDER_BENCHMARK" });
      } catch {
        await chrome.storage.local.remove([
          ZEH_STORAGE.providerBenchmarkLast,
          ZEH_STORAGE.providerBenchmarkJob,
        ]);
      }
      benchmarkState.lastResult = null;
      benchmarkState.job = null;
      benchmarkState.jobId = null;
      benchmarkState.expandedDetailKey = null;
      renderBenchmarkPanel();
      return;
    }

    if (setDefault) {
      const pid = setDefault.dataset.provider;
      const model = setDefault.dataset.model;
      if (!pid || !model) return;
      try {
        const resp = await chrome.runtime.sendMessage({
          type: "SET_PROVIDER_MODEL_FROM_BENCHMARK",
          providerId: pid,
          model,
        });
        if (resp?.ok) {
          providersState[pid] = providersState[pid] || {};
          providersState[pid].model = model;
          ZEH_PROVIDER_IDS.forEach((id) => {
            providersState[id] = providersState[id] || {};
            providersState[id].enabled = id === pid;
          });
          activeProvider = pid;
          renderModels();
          showStatus(`已将 ${ZEH_PROVIDER_META[pid]?.name || pid} 默认模型设为 ${model}`, "ok");
        } else {
          showStatus(resp?.error || "设置失败", "err");
        }
      } catch (err) {
        showStatus(err?.message || "设置失败", "err");
      }
      return;
    }

    if (toggleDetail) {
      const key = toggleDetail.dataset.key;
      benchmarkState.expandedDetailKey = benchmarkState.expandedDetailKey === key ? null : key;
      const resultsEl = document.getElementById("benchmarkResults");
      if (resultsEl) resultsEl.innerHTML = renderBenchmarkResultsTable(getBenchmarkDisplayResult());
      return;
    }

    if (copyModel) {
      const model = copyModel.dataset.model;
      if (model) navigator.clipboard.writeText(model);
    }
  });

  const customTa = document.getElementById("benchmarkCustomModels");
  if (customTa) {
    customTa.addEventListener("blur", async () => {
      benchmarkState.customModelsText = customTa.value;
      const { map: parsed } = ZEHProviderBenchmark.parseBenchmarkCustomModels(customTa.value);
      try {
        await chrome.runtime.sendMessage({
          type: "SAVE_BENCHMARK_CUSTOM_MODELS",
          models: parsed,
        });
      } catch {
        /* noop */
      }
    });
  }
}

async function pollBenchmarkJobStatus() {
  if (!isExtensionAlive()) return;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_PROVIDER_BENCHMARK_STATUS" });
    if (!resp?.ok) return;
    const job = resp.job;
    benchmarkState.job = job;
    benchmarkState.jobId = job?.jobId || null;

    if (job?.status === "running") {
      updateBenchmarkStatusDom();
      const resultsEl = document.getElementById("benchmarkResults");
      const partial = jobToBenchmarkResult(job);
      if (resultsEl && partial?.summaries?.length) {
        resultsEl.innerHTML = renderBenchmarkResultsTable(partial);
      }
      return;
    }

    stopBenchmarkPolling();

    if (job && (job.status === "completed" || job.status === "cancelled" || job.status === "failed")) {
      const data = await storageGet([ZEH_STORAGE.providerBenchmarkLast]);
      benchmarkState.lastResult = data[ZEH_STORAGE.providerBenchmarkLast] || jobToBenchmarkResult(job);
      renderBenchmarkPanel();
    }
  } catch {
    /* noop */
  }
}

function startBenchmarkPolling() {
  stopBenchmarkPolling();
  pollBenchmarkJobStatus();
  benchmarkState.pollTimer = setInterval(pollBenchmarkJobStatus, 1000);
}

function stopBenchmarkPolling() {
  if (benchmarkState.pollTimer) {
    clearInterval(benchmarkState.pollTimer);
    benchmarkState.pollTimer = null;
  }
}

async function refreshBenchmarkJobFromStorage() {
  const data = await storageGet([
    ZEH_STORAGE.providerBenchmarkJob,
    ZEH_STORAGE.providerBenchmarkLast,
  ]);
  benchmarkState.job = data[ZEH_STORAGE.providerBenchmarkJob] || null;
  benchmarkState.jobId = benchmarkState.job?.jobId || null;
  if (!benchmarkState.job || benchmarkState.job.status !== "running") {
    benchmarkState.lastResult = data[ZEH_STORAGE.providerBenchmarkLast] || benchmarkState.lastResult;
  }
  if (benchmarkState.job?.status === "running") {
    updateBenchmarkStatusDom();
    startBenchmarkPolling();
  }
}

async function startProviderBenchmark(mode) {
  if (benchmarkState.job?.status === "running") return;
  syncProvidersFromDom();
  const saved = await saveProviders(false);
  // 设置没保存成功就不测速（测速读的是存储里的配置）；错误已显示在保存状态栏
  if (!saved.ok) return;

  const customTa = document.getElementById("benchmarkCustomModels");
  if (customTa) {
    benchmarkState.customModelsText = customTa.value;
    const { map: parsed } = ZEHProviderBenchmark.parseBenchmarkCustomModels(customTa.value);
    try {
      await chrome.runtime.sendMessage({ type: "SAVE_BENCHMARK_CUSTOM_MODELS", models: parsed });
    } catch {
      /* noop */
    }
  }

  if (mode === "current-provider") {
    const pid = resolveActiveProviderIdForBenchmark();
    if (!pid || !ZEH_PROVIDER_IDS.some((id) => providersState[id]?.enabled)) {
      showStatus("请先启用一个模型厂商", "err");
      return;
    }
    if (!(providersState[pid]?.apiKey || "").trim()) {
      showStatus("当前 Provider 未填写 API Key。", "err");
      return;
    }
  }

  const startOptions = { mode };
  if (mode === "current-provider") {
    startOptions.customText = benchmarkState.customModelsText;
    startOptions.activeProviderId = resolveActiveProviderIdForBenchmark();
  }

  try {
    const resp = await chrome.runtime.sendMessage({
      type: "START_PROVIDER_BENCHMARK",
      options: startOptions,
    });
    if (!resp?.ok) {
      showStatus(resp?.error || "测速启动失败", "err");
      return;
    }
    benchmarkState.jobId = resp.jobId;
    benchmarkState.job = {
      jobId: resp.jobId,
      status: "running",
      mode,
      modelSource: resp.modelSource,
      totalTasks: resp.totalTasks,
      completedTasks: 0,
      startedAt: Date.now(),
    };
    renderBenchmarkPanel();
    startBenchmarkPolling();
  } catch (err) {
    showStatus(err?.message || "测速启动失败", "err");
  }
}

async function cancelProviderBenchmark() {
  if (benchmarkState.cancelInFlight) return;
  if (benchmarkState.job?.status !== "running") return;

  benchmarkState.cancelInFlight = true;
  const cancelBtn = document.getElementById("benchmarkCancelBtn");
  if (cancelBtn) {
    cancelBtn.disabled = true;
    cancelBtn.textContent = "取消中…";
  }

  stopBenchmarkPolling();
  try {
    await chrome.runtime.sendMessage({ type: "CANCEL_PROVIDER_BENCHMARK" });
    await refreshBenchmarkJobFromStorage();
  } catch {
    try {
      await refreshBenchmarkJobFromStorage();
    } catch {
      /* noop */
    }
  } finally {
    benchmarkState.cancelInFlight = false;
  }

  renderBenchmarkPanel();
  if (benchmarkState.job?.status === "cancelled") {
    showStatus("测速已取消", "ok");
  }
}

window.addEventListener("beforeunload", () => {
  stopBenchmarkPolling();
});
