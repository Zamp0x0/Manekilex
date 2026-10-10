/**
 * Service worker 模块：标签页、PDF 查看器、侧边栏和标签页音频捕获。
 *
 * 由 background.js 的 importScripts 列表加载。本文件只声明；加载时唯一的 chrome 调用是
 * chrome.runtime.getURL("")（同步取扩展页面前缀，无副作用）。右键菜单的创建和全部 tabs / contextMenus
 * 监听仍由 background.js 在第一次同步执行时完成。
 * 依赖：config.js（zehIsPdfViewerUrl、ZEH_STORAGE）。
 * 内存状态（pdfOverlayTabIds、lastPdfOverlayTabId、lastCapturableTabId）在 worker 重启后丢失：
 * 只影响 PDF 小球的收起提示和「上一个可捕获标签页」的猜测，捕获时会重新查询当前标签页。
 */

function safeErrorMessage(err) {
  return String(err?.message || err || "Unknown error").slice(0, 300);
}

function isTabClosedError(err) {
  const msg = String(err?.message || err || "");
  return (
    msg.includes("No tab with id") ||
    msg.includes("Receiving end does not exist") ||
    msg.includes("Could not establish connection")
  );
}

/**
 * 有 tabId 时发到标签页的内容脚本 / 扩展页面，否则 runtime 广播给扩展页面。
 * frame（可选，{ documentId } 或 { frameId }）把消息限定在标签页里的一个文档；不给就发给整个标签页。
 */
function sendToTab(tabId, message, frame) {
  if (!tabId) {
    chrome.runtime.sendMessage(message).catch(() => {});
    return;
  }
  const sent = frame ? chrome.tabs.sendMessage(tabId, message, frame) : chrome.tabs.sendMessage(tabId, message);
  sent.catch((err) => {
    if (isTabClosedError(err)) {
      zehDebugLog("[Manekilex] tab already closed, ignore", tabId);
      return;
    }
    zehDebugLog("[Manekilex] sendMessage failed", safeErrorMessage(err));
  });
}

/**
 * M3b：查词结果只发回发起 EXPLAIN 的那个文档。只有发起方的控制器持有这个 queryId，
 * 别的 frame 收到也只会丢弃；限定 frame 后，别的 frame 根本收不到（不会被同 queryId 误认领）。
 * 优先 documentId（frame 导航后旧文档的结果不会落到新文档上），其次 frameId；都没有就照旧发整个标签页。
 */
function lookupReplyFrame(sender, tabId) {
  if (!tabId) return null;
  if (typeof sender?.documentId === "string" && sender.documentId) return { documentId: sender.documentId };
  if (Number.isInteger(sender?.frameId) && sender.frameId >= 0) return { frameId: sender.frameId };
  return null;
}

function openExtensionSettings(section) {
  chrome.tabs.create({
    url: chrome.runtime.getURL(`settings.html${section ? `#${section}` : ""}`),
  });
}

async function focusOrOpenLiveTranscribeSettings() {
  const settingsBase = chrome.runtime.getURL("settings.html");
  const targetUrl = `${settingsBase}#live-transcribe`;
  const allTabs = await chrome.tabs.query({});
  const existing = allTabs.find((t) => t.url?.startsWith(settingsBase));
  if (existing?.id) {
    await chrome.tabs.update(existing.id, { active: true, url: targetUrl });
    if (existing.windowId != null) {
      await chrome.windows.update(existing.windowId, { focused: true });
    }
    return existing.id;
  }
  const created = await chrome.tabs.create({ url: targetUrl });
  return created.id;
}

async function savePendingTabAudioCapture(payload) {
  await chrome.storage.session.set({
    [ZEH_STORAGE.pendingTabAudioCapture]: {
      ...payload,
      createdAt: Date.now(),
    },
  });
}

async function startTabAudioCaptureFromActiveTab(payload) {
  const targetTabId = payload?.targetTabId;
  if (!targetTabId) {
    throw new Error("没有指定目标标签页");
  }

  if (!chrome.tabCapture?.getMediaStreamId) {
    throw new Error("浏览器不支持 chrome.tabCapture（请使用 Chrome 116+）");
  }

  let tab;
  try {
    tab = await chrome.tabs.get(targetTabId);
  } catch {
    throw new Error("目标标签页不存在或已关闭");
  }

  if (!isCapturableWebTab(tab)) {
    throw new Error("请在普通网页标签页中启动捕获");
  }

  const streamId = await getTabCaptureStreamId(targetTabId);
  const captureMeta = {
    streamId,
    targetTabId,
    targetTabTitle: payload?.targetTabTitle || tab.title || "",
    targetTabUrl: payload?.targetTabUrl || tab.url || "",
  };

  await savePendingTabAudioCapture(captureMeta);
  zehDebugLog("[LiveTranscribe:bg] pending tab capture saved", {
    tabId: targetTabId,
    title: (captureMeta.targetTabTitle || "").slice(0, 60),
  });

  const settingsTabId = await focusOrOpenLiveTranscribeSettings();
  if (settingsTabId) {
    chrome.tabs.sendMessage(settingsTabId, { type: "TAB_AUDIO_CAPTURE_PENDING" }).catch(() => {});
  }

  return {
    targetTabId,
    targetTabTitle: captureMeta.targetTabTitle,
  };
}

let pdfOverlayTabIds = new Set();
let lastPdfOverlayTabId = null;
/** 正由增强 PDF 阅读器（pdf-reader.html，Chrome 151+ MIME 处理）显示 PDF 的标签页 */
let pdfReaderTabIds = new Set();

function isPdfViewerUrl(url) {
  return zehIsPdfViewerUrl(url);
}

/** 增强 PDF 阅读器页面自己的地址（标签页、帧或消息发送方） */
function isPdfReaderUrl(url) {
  return typeof url === "string" && url.startsWith(chrome.runtime.getURL(ZEH_PDF_READER_PAGE));
}

/**
 * 阅读器报告自己在某个标签页里接管 / 不再接管 PDF：接管时让该页旧的右上角猫球隐藏（pdf-page-assistant.js），
 * 结束时（切回 Chrome 自带查看器、关闭）恢复，右键查词照旧走旧的面板。
 */
function setPdfReaderTab(tabId, active) {
  if (!Number.isInteger(tabId) || tabId < 0) return false;
  if (active) {
    pdfReaderTabIds.add(tabId);
    pdfOverlayTabIds.delete(tabId);
    if (lastPdfOverlayTabId === tabId) lastPdfOverlayTabId = null;
    sendToTab(tabId, { type: "PDF_PAGE_SUPPRESS" });
  } else {
    if (!pdfReaderTabIds.delete(tabId)) return true;
    sendToTab(tabId, { type: "PDF_PAGE_RESTORE" });
  }
  chrome.tabs
    .get(tabId)
    .then((tab) => updatePdfTabHint(tabId, tab.url))
    .catch(() => {});
  return true;
}

/**
 * Chrome 自带查看器里的旧猫球问：这个 PDF 能不能交回增强阅读器（同一标签页重新加载，再次走 MIME 处理）。
 * 只看 Chrome 版本（chrome.mimeHandler，151+）、用户的「用 Manekilex 打开 PDF」开关（只读，不修改）、
 * 发送方帧与链接类型；能不能真正取到 PDF 由页面里的同源确认请求决定。
 * @returns {Promise<{ available: boolean, reason: null | "unsupported" | "disabled" | "active" | "local-file" | "source" }>}
 */
async function getPdfEnhancedReopenStatus(sender) {
  const api = globalThis.chrome && chrome.mimeHandler;
  if (!api || typeof api.getMimeHandlerOptions !== "function") return { available: false, reason: "unsupported" };
  let options = null;
  try {
    options = await api.getMimeHandlerOptions("application/pdf");
  } catch {
    return { available: false, reason: "unsupported" };
  }
  if (options && options.enabled === false) return { available: false, reason: "disabled" };
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId)) return { available: false, reason: "source" };
  if (pdfReaderTabIds.has(tabId)) return { available: false, reason: "active" };
  // 嵌在网页里的 PDF（子帧）不由 MIME 处理接管（manifest can_embed: false）
  if (sender.frameId !== 0) return { available: false, reason: "source" };
  let protocol = "";
  try {
    protocol = new URL(sender.url).protocol;
  } catch {
    return { available: false, reason: "source" };
  }
  if (protocol === "file:") return { available: false, reason: "local-file" };
  if (protocol !== "https:" && protocol !== "http:") return { available: false, reason: "source" };
  return { available: true, reason: null };
}

/** 旧猫球的「打开本地 PDF」：在发起的标签页旁边打开阅读器（手动选择文件，文件只在内存里读取） */
function openPdfReaderForFile(sender) {
  const tab = sender?.tab;
  const props = { url: chrome.runtime.getURL(ZEH_PDF_READER_PAGE) };
  if (Number.isInteger(tab?.index)) props.index = tab.index + 1;
  if (Number.isInteger(tab?.id)) props.openerTabId = tab.id;
  return Promise.resolve(chrome.tabs.create(props)).then(
    () => true,
    () => false
  );
}

/** 右键菜单是否点在增强阅读器里（独立标签页里打开的本地文件，或接管了网页 PDF 的标签页） */
function isPdfReaderContext(info, tab) {
  if ([info?.frameUrl, info?.pageUrl, tab?.url].some(isPdfReaderUrl)) return true;
  return Boolean(tab?.id && pdfReaderTabIds.has(tab.id));
}

/** 右键查词交给阅读器里同一个查词控制器；没有阅读器应答时改用侧边栏 */
async function dispatchPdfReaderLookup(text, tab) {
  const normalized = buildLookupText(text);
  if (!normalized) return false;
  try {
    const reply = await chrome.runtime.sendMessage({ type: "PDF_READER_LOOKUP", tabId: tab?.id ?? null, text: normalized });
    if (reply && reply.ok) return true;
  } catch {
    /* 没有阅读器页面在听 */
  }
  return openSidePanelLookup(normalized);
}

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "mk-lookup-selection",
      title: 'Manekilex 查词「%s」',
      contexts: ["selection"],
    });
  });
}

function buildLookupText(text) {
  const raw = String(text || "").trim();
  const normalized = zehNormalizeLookupText(raw);
  if (!normalized || !/[a-zA-Z]/.test(normalized)) return null;
  return normalized;
}

/** 侧边栏页面路径：lookup-panel.js 从 ?text= 读取要查的文字（超过查词上限的部分不会被查，先截断） */
function sidePanelLookupPath(text) {
  const capped = String(text || "").slice(0, ZEH_LOOKUP_LIMITS.hard);
  return `lookup-panel.html?text=${encodeURIComponent(capped)}`;
}

async function openSidePanelLookup(text) {
  const normalized = buildLookupText(text);
  if (!normalized) return false;
  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active?.id) {
    await chrome.sidePanel.setOptions({
      tabId: active.id,
      path: sidePanelLookupPath(normalized),
      enabled: true,
    });
    await chrome.sidePanel.open({ tabId: active.id });
  }
  return true;
}

async function dispatchPdfLookup(text, tab) {
  const enabled = await zehGetManekilexEnabledAsync();
  if (!enabled) {
    if (tab?.id) {
      sendToTab(tab.id, {
        type: "SHOW_ERROR",
        message: ZEH_MANEKILEX_DISABLED_MESSAGE,
      });
    }
    return false;
  }

  const normalized = buildLookupText(text);
  if (!normalized) {
    console.warn("[Manekilex] PDF lookup skipped: empty or non-english", text);
    return false;
  }

  if (tab?.id && pdfOverlayTabIds.has(tab.id)) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "PDF_PAGE_LOOKUP", text: normalized });
      lastPdfOverlayTabId = tab.id;
      return true;
    } catch {
      pdfOverlayTabIds.delete(tab.id);
    }
  }

  if (tab?.id) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "PDF_PAGE_LOOKUP", text: normalized });
      pdfOverlayTabIds.add(tab.id);
      lastPdfOverlayTabId = tab.id;
      return true;
    } catch {
      /* content script 不可用（如 chrome 内置 PDF 扩展页）*/
    }
  }

  return openSidePanelLookup(normalized);
}

function collapsePdfOverlayTab(tabId) {
  if (!tabId) return;
  chrome.tabs.sendMessage(tabId, { type: "PDF_PAGE_COLLAPSE" }).catch(() => {});
}

function updatePdfTabHint(tabId, url) {
  if (!tabId || tabId < 0) return;
  if (isPdfViewerUrl(url)) {
    chrome.action.setBadgeBackgroundColor({ color: "#d83424", tabId });
    chrome.action.setBadgeText({ text: "PDF", tabId });
    chrome.action.setTitle({
      tabId,
      title: pdfReaderTabIds.has(tabId)
        ? "Manekilex：在 PDF 阅读器里选中英文，点旁边的小猫查词"
        : "Manekilex：PDF 右上角猫球，选中后右键查词",
    });
  } else {
    chrome.action.setBadgeText({ text: "", tabId });
    chrome.action.setTitle({ tabId, title: "Manekilex 设置" });
  }
}

/* ── 实时转译：标签页音频捕获 ─────────────────────────────── */

const EXTENSION_PAGE_PREFIX = chrome.runtime.getURL("").replace(/\/$/, "");
let lastCapturableTabId = null;

function isOwnExtensionTab(tab) {
  const url = tab?.url || "";
  return url.startsWith(EXTENSION_PAGE_PREFIX);
}

function isCapturableWebTab(tab) {
  if (!tab?.id) return false;
  const url = tab.url || "";
  if (!url || url === "about:blank") return false;
  if (/^(chrome|chrome-extension|edge|devtools|about):/i.test(url)) return false;
  if (isOwnExtensionTab(tab)) return false;
  return /^https?:/i.test(url);
}

function rememberCapturableTab(tab) {
  if (isCapturableWebTab(tab)) {
    lastCapturableTabId = tab.id;
  }
}

async function resolveTabCaptureTarget() {
  if (!chrome.tabCapture?.getMediaStreamId) {
    throw new Error("浏览器不支持 chrome.tabCapture（请使用 Chrome 116+）");
  }

  const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (active && isCapturableWebTab(active)) {
    return { tabId: active.id, title: active.title || active.url || "" };
  }

  if (lastCapturableTabId != null) {
    try {
      const tab = await chrome.tabs.get(lastCapturableTabId);
      if (isCapturableWebTab(tab)) {
        return { tabId: tab.id, title: tab.title || tab.url || "" };
      }
    } catch {
      lastCapturableTabId = null;
    }
  }

  const tabs = await chrome.tabs.query({ currentWindow: true });
  const candidates = tabs.filter(isCapturableWebTab);
  if (!candidates.length) {
    throw new Error(
      "没有可捕获的标签页。请先在视频/会议页播放声音，当前页不能是 chrome:// 或扩展页"
    );
  }

  candidates.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const pick = candidates[0];
  return { tabId: pick.id, title: pick.title || pick.url || "" };
}

function getTabCaptureStreamId(targetTabId, consumerTabId) {
  return new Promise((resolve, reject) => {
    const options = { targetTabId };
    if (consumerTabId) options.consumerTabId = consumerTabId;

    chrome.tabCapture.getMediaStreamId(options, (streamId) => {
      const err = chrome.runtime.lastError;
      if (err) {
        reject(new Error(err.message || "tabCapture.getMediaStreamId 失败"));
        return;
      }
      if (!streamId) {
        reject(new Error("tabCapture 返回空 streamId，目标标签页可能无法捕获"));
        return;
      }
      resolve(streamId);
    });
  });
}

async function previewTabCaptureTarget() {
  try {
    const target = await resolveTabCaptureTarget();
    return { ok: true, tabId: target.tabId, tabTitle: target.title };
  } catch (err) {
    return { ok: false, message: err?.message || "无法解析捕获目标" };
  }
}
