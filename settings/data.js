/**
 * 设置页分区「数据」：查词缓存统计与清理、清空 API 日志、清空阅读位置缓存、重置书架阅读进度。
 *
 * 加载时只声明。清理都经 service worker 消息完成（GET_LOOKUP_CACHE_STATS、CLEANUP_LOOKUP_CACHE、
 * CLEAR_USAGE_LOGS、CLEAR_READER_POSITION_CACHE），只有清除查词缓存直接删 storage 键。
 * 依赖：settings/core.js（currentSection、sectionRenderToken、mainBody、storageGet、storageRemove、escapeHtml）、
 *       settings/usage.js（usageLogs）、settings/reading.js（renderBookshelf）、book-store.js（MKBookStore）。
 */

function showDataStatus(msg, type) {
  const el = document.getElementById("dataStatus");
  if (el) {
    el.textContent = msg;
    el.className = "status-msg " + (type || "");
  }
}

function formatCacheBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

const CACHE_TYPE_LABELS = {
  word: "单词",
  phrase: "短语",
  sentence: "句子",
  paragraph: "段落",
  code_term: "技术术语",
};

const CACHE_TYPE_CLASS = {
  word: "data-type-word",
  phrase: "data-type-phrase",
  sentence: "data-type-sentence",
  paragraph: "data-type-paragraph",
  code_term: "data-type-code",
};

async function fetchLookupCacheStats() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "GET_LOOKUP_CACHE_STATS" });
    if (resp?.ok && resp.stats) return resp.stats;
  } catch {
    /* fallback below */
  }
  return {
    totalCount: 0,
    v2Count: 0,
    legacyCount: 0,
    expiredCount: 0,
    totalBytes: 0,
    byType: { word: 0, phrase: 0, sentence: 0, paragraph: 0, code_term: 0 },
    lastCleanupAt: 0,
    lastReason: "",
    lastSummary: null,
  };
}

async function loadLookupCacheEntries() {
  const all = await storageGet(null);
  const now = Date.now();
  const entries = [];

  Object.entries(all).forEach(([key, item]) => {
    if (!zehIsLookupCacheStorageKey(key) || !item?.data) return;
    const parsed = zehParseLookupCacheStorageKey(key);
    if (!parsed) return;

    const queryType = item.queryType || parsed.queryType || "word";
    const policy = zehGetCachePolicy(queryType);
    const createdAt = item.createdAt || item.savedAt || 0;
    if (createdAt && now - createdAt > policy.ttlMs) return;

    const data = item.data;
    entries.push({
      storageKey: key,
      queryType,
      term: data.term || item.normalizedText || (parsed.legacyTextKey || "").slice(0, 80),
      preview:
        data.translation ||
        data.short_meaning ||
        data.context_meaning ||
        data.chinese_explanation ||
        "",
      savedAt: item.lastAccessedAt || item.updatedAt || createdAt,
      source: item.source || "",
      approxSize: item.approxSize || 0,
    });
  });

  entries.sort((a, b) => b.savedAt - a.savedAt);
  return entries;
}

async function clearLookupCacheViaBackground() {
  try {
    const resp = await chrome.runtime.sendMessage({ type: "CLEAR_LOOKUP_CACHE" });
    if (resp?.ok) return resp.deletedCount || 0;
  } catch {
    /* fallback */
  }
  const all = await storageGet(null);
  const keys = Object.keys(all).filter((k) => zehIsLookupCacheStorageKey(k));
  if (!keys.length) return 0;
  await storageRemove(keys);
  return keys.length;
}

function cacheItemHtml(entry) {
  const typeLabel = CACHE_TYPE_LABELS[entry.queryType] || CACHE_TYPE_LABELS.word;
  const typeClass = CACHE_TYPE_CLASS[entry.queryType] || CACHE_TYPE_CLASS.word;
  const time = entry.savedAt ? zehFormatLocalTime(entry.savedAt) : "";
  const preview = entry.preview
    ? `<div class="data-cache-preview">${escapeHtml(entry.preview)}</div>`
    : "";
  const sizeHint = entry.approxSize ? `<span class="data-cache-size">${formatCacheBytes(entry.approxSize)}</span>` : "";
  return `
    <div class="data-cache-item" data-query-type="${escapeHtml(entry.queryType)}">
      <div class="data-cache-item-top">
        <span class="data-cache-type ${typeClass}">${typeLabel}</span>
        ${sizeHint}
        <span class="data-cache-time">${escapeHtml(time)}</span>
      </div>
      <div class="data-cache-term">${escapeHtml(entry.term)}</div>
      ${preview}
    </div>
  `;
}

async function renderData() {
  const renderToken = sectionRenderToken;
  mainBody.innerHTML = `<div class="data-loading">正在读取缓存…</div>`;

  const [entries, stats] = await Promise.all([loadLookupCacheEntries(), fetchLookupCacheStats()]);
  // 读取期间用户已切到别的分区：不能用数据页覆盖当前分区
  if (renderToken !== sectionRenderToken || currentSection !== "data") return;
  const byType = stats.byType || {};
  const lastCleanup = stats.lastCleanupAt ? zehFormatLocalTime(stats.lastCleanupAt) : "尚未清理";
  const lastDeleted = stats.lastSummary?.deletedCount;

  mainBody.innerHTML = `
    <div class="data-intro">
      <p>查词缓存保存在本机 <code>chrome.storage.local</code>，命中后不再请求 API。按类型分层 TTL，总容量约控制在 <strong>8 MB</strong> 内。</p>
      <p>清除查词缓存<strong>不会</strong>删除生词本、API Key 或 IndexedDB 中的 EPUB 书籍。</p>
    </div>
    <div class="data-storage-panel">
      <h3 class="data-storage-title">缓存与存储</h3>
      <div class="data-storage-grid">
        <div class="data-storage-card">
          <span class="data-storage-label">查词缓存</span>
          <strong class="data-storage-value">${stats.totalCount} 条</strong>
          <span class="data-storage-sub">${formatCacheBytes(stats.totalBytes)}${stats.expiredCount ? ` · ${stats.expiredCount} 条已过期` : ""}</span>
        </div>
        <div class="data-storage-card">
          <span class="data-storage-label">v2 / legacy</span>
          <strong class="data-storage-value">${stats.v2Count || 0} / ${stats.legacyCount || 0}</strong>
          <span class="data-storage-sub">v2 含 textLength 新键；legacy 为旧 zehCache:word:… 格式</span>
        </div>
        <div class="data-storage-card">
          <span class="data-storage-label">上次清理</span>
          <strong class="data-storage-value">${escapeHtml(lastCleanup)}</strong>
          <span class="data-storage-sub">${lastDeleted != null ? `删除 ${lastDeleted} 条` : stats.lastReason ? `原因：${escapeHtml(stats.lastReason)}` : ""}</span>
        </div>
      </div>
      <div class="data-type-stats">
        <span>单词 <strong>${byType.word || 0}</strong></span>
        <span>短语 <strong>${byType.phrase || 0}</strong></span>
        <span>句子 <strong>${byType.sentence || 0}</strong></span>
        <span>段落 <strong>${byType.paragraph || 0}</strong></span>
        <span>技术术语 <strong>${byType.code_term || 0}</strong></span>
      </div>
      <div class="data-storage-actions">
        <button type="button" class="mk-btn mk-btn-secondary mk-btn-md" id="cleanupExpiredCacheBtn">清理过期缓存</button>
        <button type="button" class="mk-btn mk-btn-danger mk-btn-md" id="clearCacheBtn" ${
          entries.length ? "" : "disabled"
        }>清空查词缓存</button>
        <button type="button" class="mk-btn mk-btn-secondary mk-btn-md" id="clearUsageLogsBtn">清空 API 日志</button>
      </div>
    </div>
    <div class="data-storage-panel data-reading-panel">
      <h3 class="data-storage-title">阅读位置与进度</h3>
      <p class="data-reading-hint">以下操作<strong>不会</strong>删除 EPUB 文件、封面、书签、生词本或 API Key。</p>
      <div class="data-reading-action">
        <p class="data-reading-desc">只清除临时定位缓存，<strong>不会</strong>清除书架上的阅读百分比。用于修复打开书籍时定位不准的问题。</p>
        <button type="button" class="mk-btn mk-btn-secondary mk-btn-md" id="clearReaderPosBtn">清空阅读位置缓存</button>
      </div>
      <div class="data-reading-action">
        <p class="data-reading-desc">将所有书架图书的阅读百分比重置为 0%，并清除最后阅读时间。不会删除 EPUB 文件和书签。</p>
        <button type="button" class="mk-btn mk-btn-danger mk-btn-md" id="resetAllReadingProgressBtn">重置所有书籍阅读进度</button>
      </div>
    </div>
    <div class="data-cache-filter">
      <button type="button" class="data-filter-btn active" data-filter="all">全部 (${entries.length})</button>
      <button type="button" class="data-filter-btn" data-filter="word">单词</button>
      <button type="button" class="data-filter-btn" data-filter="phrase">短语</button>
      <button type="button" class="data-filter-btn" data-filter="sentence">句子</button>
      <button type="button" class="data-filter-btn" data-filter="paragraph">段落</button>
      <button type="button" class="data-filter-btn" data-filter="code_term">技术术语</button>
    </div>
    <div class="data-cache-list" id="dataCacheList">
      ${
        entries.length
          ? entries.map(cacheItemHtml).join("")
          : '<p class="data-empty">暂无查词缓存。成功查词后会自动出现在这里。</p>'
      }
    </div>
    <p id="dataStatus" class="status-msg"></p>
  `;

  const listEl = document.getElementById("dataCacheList");
  const filterBtns = document.querySelectorAll(".data-filter-btn");

  filterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const filter = btn.dataset.filter;
      filterBtns.forEach((b) => b.classList.toggle("active", b === btn));
      listEl.querySelectorAll(".data-cache-item").forEach((item) => {
        const qt = item.dataset.queryType || "word";
        const show = filter === "all" || filter === qt;
        item.hidden = !show;
      });
      const visible = listEl.querySelectorAll(".data-cache-item:not([hidden])").length;
      let emptyEl = listEl.querySelector(".data-filter-empty");
      if (visible === 0 && entries.length > 0) {
        if (!emptyEl) {
          emptyEl = document.createElement("p");
          emptyEl.className = "data-empty data-filter-empty";
          emptyEl.textContent = "该分类下暂无缓存。";
          listEl.appendChild(emptyEl);
        }
        emptyEl.hidden = false;
      } else if (emptyEl) {
        emptyEl.hidden = true;
      }
    });
  });

  document.getElementById("cleanupExpiredCacheBtn")?.addEventListener("click", async () => {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "CLEANUP_LOOKUP_CACHE",
        reason: "manual",
      });
      if (resp?.ok) {
        const s = resp.summary;
        if (s?.skipped) {
          showDataStatus("已有清理任务正在运行，请稍后再试", "warn");
          return;
        }
        showDataStatus(
          `已清理：删除 ${s.deletedCount} 条（过期 ${s.deletedByType?.expired || 0}），剩余 ${s.afterCount} 条 · ${formatCacheBytes(s.afterBytes)}`,
          "ok"
        );
        renderData();
      } else {
        showDataStatus(resp?.message || "清理失败", "err");
      }
    } catch (error) {
      showDataStatus(error.message || "清理失败", "err");
    }
  });

  document.getElementById("clearCacheBtn")?.addEventListener("click", async () => {
    if (!entries.length) return;
    if (!window.confirm(`确定清除全部 ${entries.length} 条查词缓存？生词本与 API Key 不会受影响。`)) return;
    try {
      const n = await clearLookupCacheViaBackground();
      showDataStatus(`已清除 ${n} 条查词缓存`, "ok");
      renderData();
    } catch (error) {
      showDataStatus(error.message || "清除失败", "err");
    }
  });

  document.getElementById("clearUsageLogsBtn")?.addEventListener("click", async () => {
    if (!window.confirm("确定清空 API 调用日志？流量统计将归零。")) return;
    try {
      const resp = await chrome.runtime.sendMessage({ type: "CLEAR_USAGE_LOGS" });
      if (resp?.ok) {
        usageLogs = [];
        showDataStatus("已清空 API 日志", "ok");
      } else {
        showDataStatus(resp?.message || "清除失败", "err");
      }
    } catch (error) {
      showDataStatus(error.message || "清除失败", "err");
    }
  });

  document.getElementById("clearReaderPosBtn")?.addEventListener("click", async () => {
    if (
      !window.confirm(
        "确定清空临时阅读位置缓存？EPUB 书籍、书签、书架阅读百分比都不会删除。部分书籍下次打开时可能需要重新定位。"
      )
    ) {
      return;
    }
    try {
      const resp = await chrome.runtime.sendMessage({ type: "CLEAR_READER_POSITION_CACHE" });
      if (resp?.ok) {
        showDataStatus("已清空临时阅读位置缓存（书架百分比未变）", "ok");
      } else {
        showDataStatus(resp?.message || "清除失败", "err");
      }
    } catch (error) {
      showDataStatus(error.message || "清除失败", "err");
    }
  });

  document.getElementById("resetAllReadingProgressBtn")?.addEventListener("click", async () => {
    if (
      !window.confirm(
        "确定重置所有书籍阅读进度？这会把所有书架图书显示为未读/0%，但不会删除 EPUB 文件和书签。此操作不可恢复。"
      )
    ) {
      return;
    }
    try {
      const result = await ZEHBookStore.resetAllReadingProgress();
      try {
        await chrome.runtime.sendMessage({ type: "CLEAR_READER_POSITION_CACHE" });
      } catch {
        /* 位置缓存清理失败不阻断主流程 */
      }
      if (document.getElementById("bookshelf")) {
        await renderBookshelf();
      }
      showDataStatus(
        `已重置 ${result?.count ?? 0} 本书的阅读进度，书籍和书签未删除。`,
        "ok"
      );
    } catch (err) {
      console.warn("[Manekilex] reset reading progress failed", err);
      showDataStatus(err?.message || "重置阅读进度失败", "err");
    }
  });
}
