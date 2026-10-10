/**
 * 设置页入口：启动加载（loadAll）、导航与页面级监听、顶栏时钟和每日一句。
 *
 * settings.html 最后加载本文件；各分区代码在 settings/ 下，按 settings.html 的顺序先加载：
 *   core → models → benchmark → appearance → usage → data → transcription → book-import → reading → vocabulary → review
 * 这些文件共享设置页的全局作用域，加载时只声明（benchmark.js 注册一个 beforeunload 除外），
 * 所有监听与首次渲染都在这里、在最后一个脚本执行时完成，顺序与拆分前相同。
 */

let localClockTimer = null;

async function loadAll() {
  await migrateIfNeeded();
  const data = await storageGet([
    ZEH_STORAGE.providers,
    ZEH_STORAGE.activeProvider,
    ZEH_STORAGE.usageLogs,
    ZEH_STORAGE.vocabulary,
    ZEH_STORAGE.theme,
  ]);
  providersState = zehMigrateProviderModels(data[ZEH_STORAGE.providers] || zehDefaultProviders());
  activeProvider = data[ZEH_STORAGE.activeProvider] || "openai";
  providersSnapshot = cloneProviders(providersState);
  usageLogs = data[ZEH_STORAGE.usageLogs] || [];
  // Phase 4：旧条目在内存里按 v2 读取；持久化迁移由 service worker 完成（设置页不写 zehVocabulary）
  vocabulary = zehNormalizeVocabularyList(data[ZEH_STORAGE.vocabulary] || []);
  requestVocabularyMigration();
  themeState = normalizeBallTheme(data[ZEH_STORAGE.theme] || {});
  applySettingsTheme(themeState);
  await loadBenchmarkState();
}

document.getElementById("nav").addEventListener("click", (e) => {
  const btn = e.target.closest(".nav-item");
  if (btn) {
    switchSection(btn.dataset.section);
  }
});

installInvalidationGuard();

try {
  chrome.storage.onChanged.addListener(handleVocabularyStorageChange);
  chrome.storage.onChanged.addListener(handleProviderStorageChange);
} catch {
  /* 扩展上下文失效时由 invalidation guard 处理 */
}

document.addEventListener("keydown", handleReviewKeydown);

loadAll().then(() => {
  if (extensionDead) {
    return;
  }
  switchSection(resolveInitialSection());
  updateReviewBadge();
  // 学习中的词 10 / 30 分钟后到期：每分钟刷新一次计数（只读，不写 storage）
  setInterval(() => {
    updateReviewBadge();
    if (currentSection === "review") {
      renderReviewStats();
      if (!reviewSession) renderReviewView();
    }
  }, 60 * 1000);
});

window.addEventListener("hashchange", () => {
  const hash = normalizeNavSection((location.hash || "").replace("#", ""));
  if (SECTION_META[hash] && hash !== currentSection) {
    switchSection(hash);
  }
});

window.addEventListener("focus", () => {
  if (currentSection === "reading") {
    renderBookshelf();
  }
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && currentSection === "reading") {
    renderBookshelf();
  }
});

function resolveCityFromTimezone() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const mapping = {
    "Australia/Sydney": "Sydney",
    "Europe/London": "London",
  };
  if (mapping[tz]) return mapping[tz];
  if (tz === "Asia/Shanghai" || tz.startsWith("Asia/")) return "Shanghai";
  if (tz.includes("/")) return tz.split("/")[1].replace(/_/g, " ");
  return "Local";
}

function updateLocalClock() {
  const timeEl = document.getElementById("mkClockTime");
  const cityEl = document.getElementById("mkClockCity");
  if (!timeEl || !cityEl) return;
  timeEl.textContent = new Date().toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  cityEl.textContent = resolveCityFromTimezone();
}

function renderDailyLines() {
  const enEl = document.getElementById("mkDailyEn");
  const authorEl = document.getElementById("mkDailyAuthor");
  if (!enEl || !authorEl) return;
  if (window.MK_DailyQuotes?.renderDailyQuote) {
    window.MK_DailyQuotes.renderDailyQuote(enEl, authorEl);
  }
}

function initLocalClock() {
  if (localClockTimer) clearInterval(localClockTimer);
  renderDailyLines();
  updateLocalClock();
  localClockTimer = setInterval(updateLocalClock, 1000);
}

initLocalClock();
