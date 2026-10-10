// 加载顺序：config.js、shared/ 共享模块与两个纯函数模块在前，sw/ 模块在后（都只声明，不在加载时执行）。
// 下面的顶层代码负责启动任务和注册全部事件监听，必须在 worker 第一次同步执行时完成。
importScripts(
  "config.js",
  "shared/providers.js",
  "shared/prompts.js",
  "shared/benchmark-cases.js",
  "provider-benchmark.js",
  "vocab-review.js",
  "sw/storage-queue.js",
  "sw/settings.js",
  "sw/cache.js",
  "sw/dictionary.js",
  "sw/provider-client.js",
  "sw/lookup.js",
  "sw/vocab.js",
  "sw/transcribe.js",
  "sw/benchmark.js",
  "sw/tabs.js",
  "sw/router.js"
);

initCacheMaintenance();

(async function resumeBenchmarkJobOnStartup() {
  try {
    const job = await loadBenchmarkJobFromStorage();
    if (job?.status === "running") {
      runBenchmarkJobLoop(job.jobId);
    }
  } catch {
    /* noop */
  }
})();

chrome.runtime.onInstalled.addListener(() => {
  migrateLegacySettings();
  setupContextMenus();
  // 安装 / 更新 / 重新加载扩展时把生词本迁移到 v2（已迁移则不写）
  migrateVocabularyStorage();
});

setupContextMenus();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "mk-lookup-selection") return;
  const text = info.selectionText || "";
  const inReader = isPdfReaderContext(info, tab);
  if (!inReader && !isPdfViewerUrl(tab?.url)) return;

  zehGetManekilexEnabled((enabled) => {
    if (!enabled) {
      if (tab?.id) {
        sendToTab(tab.id, {
          type: "SHOW_ERROR",
          message: ZEH_MANEKILEX_DISABLED_MESSAGE,
        });
      }
      return;
    }
    (inReader ? dispatchPdfReaderLookup(text, tab) : dispatchPdfLookup(text, tab)).catch((err) => {
      console.error("[Manekilex] dispatchPdfLookup failed", err);
    });
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    updatePdfTabHint(tabId, tab.url);
  }
  if (changeInfo.url && !isPdfViewerUrl(tab.url)) {
    pdfOverlayTabIds.delete(tabId);
    pdfReaderTabIds.delete(tabId);
    if (lastPdfOverlayTabId === tabId) lastPdfOverlayTabId = null;
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    updatePdfTabHint(activeInfo.tabId, tab.url);

    if (lastPdfOverlayTabId && lastPdfOverlayTabId !== activeInfo.tabId) {
      collapsePdfOverlayTab(lastPdfOverlayTabId);
    }

    if (isPdfViewerUrl(tab.url)) {
      lastPdfOverlayTabId = activeInfo.tabId;
    } else {
      lastPdfOverlayTabId = null;
    }
  } catch {
    /* noop */
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  pdfOverlayTabIds.delete(tabId);
  pdfReaderTabIds.delete(tabId);
  if (lastPdfOverlayTabId === tabId) lastPdfOverlayTabId = null;
  if (lastCapturableTabId === tabId) lastCapturableTabId = null;
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then(rememberCapturableTab).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if ((changeInfo.url || changeInfo.status === "complete") && tab?.active) {
    rememberCapturableTab(tab);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const route = zehMessageRoute(message);
  if (!route) {
    const refusal = zehUnroutedMessageResponse(message);
    if (!refusal) return false;
    zehDebugLog("[Manekilex] rejected unrouted message", refusal.code, String(message?.type ?? "").slice(0, 60));
    sendResponse(refusal);
    return true;
  }

  const auth = zehAuthorizeMessage(message.type, sender);
  if (!auth.allowed) {
    console.warn("[Manekilex] rejected message from non-extension sender", {
      type: message.type,
      senderUrl: String(sender?.url || "").slice(0, 120),
    });
    sendResponse({ ok: false, accepted: false, code: "FORBIDDEN_SENDER", reason: auth.reason });
    return true;
  }

  let validated;
  if (route.validate) {
    const check = route.validate(message);
    if (!check.ok) {
      sendResponse(check.response);
      return true;
    }
    validated = check.value;
  }
  return route.handle(message, sender, sendResponse, validated);
});
