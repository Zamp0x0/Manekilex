/**
 * Service worker 模块：运行时消息注册表（M3 的 25 条消息原样从 background.js 移来；M9 加了两条 provider 配置消息）。
 *
 * 由 background.js 的 importScripts 列表最后加载。本文件只声明：注册表、页面方向消息清单、
 * 两个发送方集合和 zehAuthorizeMessage。唯一的 chrome.runtime.onMessage 监听仍在 background.js，
 * 在 worker 第一次同步执行时注册，按 type 查表（查不到时由 zehUnroutedMessageResponse 决定是否拒绝）、
 * 做发送方检查和可选校验后调用 route.handle，
 * 并原样返回它的结果（true = 异步 sendResponse，保持消息通道）。
 * 依赖：前面所有 sw/ 模块里的 handler（handleExplain、addVocabularyItem、startBenchmarkJob 等），
 * 只在收到消息时调用，加载时不读取。
 */

// ─── 运行时消息注册表（M3）──────────────────────────────────────────────────────
// Service Worker 接收的每一种消息都在这里登记一次：
//   from      谁可以发：
//               "any"            内容脚本（任意网页）和扩展自己的页面都可以
//               "extension-page" 只接受扩展自己的页面（settings / popup / reader / lookup-panel），
//                                删除、复习、迁移、清缓存、provider / benchmark / 转译等
//                                「改数据或花钱」的操作都在这一类（Phase 5 发送方边界）
//   payload   handler 读取的字段（说明用，不做强制校验）
//   senders   发出这条消息的文件
//   validate  可选：handler 之前的校验，返回 { ok: true, value } 或 { ok: false, response }
//             （response 原样回给发送方）
//   handle(message, sender, sendResponse, validated)
//             返回值就是监听器的返回值：true = 保持消息通道（异步 sendResponse；同步已回复的也照旧返回 true）
// 找不到路由的消息（M3b，见 zehUnroutedMessageResponse）：格式不对或未登记的类型同步回明确的拒绝；
// 发往页面的类型（ZEH_PAGE_BOUND_MESSAGES）不是给 worker 的，保持沉默（监听器返回 false），
// 以免和真正处理它的页面抢着回复。
const ZEH_MESSAGE_ROUTES = new Map([
  [
    "EXPLAIN",
    {
      from: "any",
      payload: "{ text, queryId, queryType?, context? }",
      senders: ["mk-lookup.js"],
      validate(message) {
        const validation = zehValidateLookupText(message.text);
        if (!validation.ok) {
          // 只通过 sendResponse 回复发起方；不再额外广播 SHOW_ERROR，避免同一错误渲染两次
          return { ok: false, response: { accepted: false, code: validation.code, message: validation.message } };
        }
        // M3b：结果只能按 queryId 认领，没有有效 queryId 的查询不花模型调用
        if (!zehIsLookupQueryId(message.queryId)) {
          return { ok: false, response: { accepted: false, code: "INVALID_QUERY_ID", message: ZEH_INVALID_LOOKUP_MESSAGE } };
        }
        if (message.queryType != null && !ZEH_CACHE_QUERY_TYPES.includes(message.queryType)) {
          return { ok: false, response: { accepted: false, code: "INVALID_QUERY_TYPE", message: ZEH_INVALID_LOOKUP_MESSAGE } };
        }
        return { ok: true, value: validation };
      },
      handle: (message, sender, sendResponse, validation) => handleExplain(message, sender, sendResponse, validation),
    },
  ],
  [
    "ADD_VOCAB",
    {
      from: "any",
      payload: "{ item }",
      senders: ["mk-lookup.js"],
      handle(message, sender, sendResponse) {
        addVocabularyItem(message.item)
          .then((result) => sendResponse(result))
          .catch(() => sendResponse({ ok: false, added: false, reason: "error" }));
        return true;
      },
    },
  ],
  [
    "OPEN_SETTINGS",
    {
      from: "any",
      payload: "{ section? }",
      senders: ["mk-lookup.js", "popup.js", "pdf-page-assistant.js"],
      handle(message, sender, sendResponse) {
        openExtensionSettings(message.section || "usage");
        sendResponse({ ok: true });
        return true;
      },
    },
  ],
  [
    "PDF_PAGE_ASSISTANT_READY",
    {
      from: "any",
      payload: "{}（sender.tab 是 PDF 页标签）",
      senders: ["pdf-page-assistant.js"],
      handle(message, sender, sendResponse) {
        // 这个标签页的 PDF 正由增强阅读器显示：旧猫球保持隐藏（suppressed）
        const suppressed = Boolean(sender.tab?.id && pdfReaderTabIds.has(sender.tab.id));
        if (sender.tab?.id && !suppressed) {
          pdfOverlayTabIds.add(sender.tab.id);
          lastPdfOverlayTabId = sender.tab.id;
        }
        sendResponse(suppressed ? { ok: true, suppressed: true } : { ok: true });
        return true;
      },
    },
  ],
  [
    "PDF_PAGE_ENHANCED",
    {
      from: "any",
      payload: '{ action: "status" | "open-file" }（sender.tab 是 Chrome 自带查看器里的 PDF 页）',
      senders: ["pdf-page-assistant.js"],
      handle(message, sender, sendResponse) {
        if (message.action === "status") {
          getPdfEnhancedReopenStatus(sender)
            .then((status) => sendResponse({ ok: true, ...status }))
            .catch(() => sendResponse({ ok: false }));
        } else if (message.action === "open-file") {
          openPdfReaderForFile(sender).then((ok) => sendResponse({ ok }));
        } else {
          sendResponse({ ok: false });
        }
        return true;
      },
    },
  ],
  [
    "PDF_READER_STATE",
    {
      from: "extension-page",
      payload: "{ active: boolean, tabId: number }（tabId 来自 getStreamInfo；只接受 pdf-reader.html）",
      senders: ["pdf-reader/app.js"],
      handle(message, sender, sendResponse) {
        const ok = isPdfReaderUrl(sender.url) && setPdfReaderTab(message.tabId, message.active === true);
        sendResponse({ ok });
        return true;
      },
    },
  ],
  [
    "GET_DICT_KEY_LIST",
    {
      from: "any",
      payload: "{}",
      senders: ["lookup/dom-helpers.js"],
      handle(message, sender, sendResponse) {
        getDictionaryKeyList()
          .then((keys) => sendResponse(keys ? { ok: true, keys } : { ok: false, keys: [] }))
          .catch(() => sendResponse({ ok: false, keys: [] }));
        return true;
      },
    },
  ],
  [
    "START_PROVIDER_BENCHMARK",
    {
      from: "extension-page",
      payload: "{ options? }",
      senders: ["settings/benchmark.js"],
      handle(message, sender, sendResponse) {
        startBenchmarkJob(message.options || {})
          .then((result) => sendResponse({ ok: true, ...result }))
          .catch((err) => sendResponse({ ok: false, error: benchmarkSafeError(err) }));
        return true;
      },
    },
  ],
  [
    "GET_PROVIDER_BENCHMARK_STATUS",
    {
      from: "extension-page",
      payload: "{}",
      senders: ["settings/benchmark.js"],
      handle(message, sender, sendResponse) {
        loadBenchmarkJobFromStorage()
          .then((job) => sendResponse({ ok: true, job: sanitizeBenchmarkJobForClient(job) }))
          .catch((err) => sendResponse({ ok: false, error: benchmarkSafeError(err) }));
        return true;
      },
    },
  ],
  [
    "CANCEL_PROVIDER_BENCHMARK",
    {
      from: "extension-page",
      payload: "{}",
      senders: ["settings/benchmark.js"],
      handle(message, sender, sendResponse) {
        cancelBenchmarkJob()
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ ok: false, error: benchmarkSafeError(err) }));
        return true;
      },
    },
  ],
  [
    "CLEAR_PROVIDER_BENCHMARK",
    {
      from: "extension-page",
      payload: "{}",
      senders: ["settings/benchmark.js"],
      handle(message, sender, sendResponse) {
        clearBenchmarkData()
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ ok: false, error: benchmarkSafeError(err) }));
        return true;
      },
    },
  ],
  [
    "SET_PROVIDER_MODEL_FROM_BENCHMARK",
    {
      from: "extension-page",
      payload: "{ providerId, model }",
      senders: ["settings/benchmark.js"],
      handle(message, sender, sendResponse) {
        setProviderModelFromBenchmark(message.providerId, message.model)
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ ok: false, error: benchmarkSafeError(err) }));
        return true;
      },
    },
  ],
  [
    "SAVE_PROVIDER_SETTINGS",
    {
      from: "extension-page",
      payload: "{ base, edits }",
      senders: ["settings/models.js"],
      // M9：provider 配置只由 worker 写入；页面送来上次读到的快照 base 和当前编辑 edits
      validate(message) {
        const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
        if (!isPlainObject(message.base) || !isPlainObject(message.edits)) {
          return { ok: false, response: { ok: false, code: "INVALID_PROVIDER_SETTINGS", error: "无效的模型设置" } };
        }
        return { ok: true, value: { base: message.base, edits: message.edits } };
      },
      handle(message, sender, sendResponse, validated) {
        saveProviderSettings(validated.base, validated.edits)
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "保存失败，请刷新页面后重试" }));
        return true;
      },
    },
  ],
  [
    "MIGRATE_PROVIDER_SETTINGS",
    {
      from: "extension-page",
      payload: "{}",
      senders: ["settings/models.js"],
      handle(message, sender, sendResponse) {
        migrateLegacyProviderSettings()
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: err?.message || "迁移失败" }));
        return true;
      },
    },
  ],
  [
    "SAVE_BENCHMARK_CUSTOM_MODELS",
    {
      from: "extension-page",
      payload: "{ models }",
      senders: ["settings/benchmark.js"],
      handle(message, sender, sendResponse) {
        chrome.storage.local
          .set({ [ZEH_STORAGE.providerBenchmarkCustomModels]: message.models || {} })
          .then(() => sendResponse({ ok: true }))
          .catch(() => sendResponse({ ok: false }));
        return true;
      },
    },
  ],
  [
    "DELETE_VOCAB",
    {
      from: "extension-page",
      payload: "{ ids }",
      senders: ["settings/vocabulary.js"],
      handle(message, sender, sendResponse) {
        deleteVocabularyItems(message.ids)
          .then((result) => sendResponse(result))
          .catch(() => sendResponse({ ok: false, removed: 0, reason: "error" }));
        return true;
      },
    },
  ],
  [
    "REVIEW_VOCAB",
    {
      from: "extension-page",
      payload: "{ id, rating, expectedReviewCount? }",
      senders: ["settings/review.js"],
      handle(message, sender, sendResponse) {
        reviewVocabularyItem(message.id, message.rating, message.expectedReviewCount)
          .then((result) => sendResponse(result))
          .catch(() => sendResponse({ ok: false, reason: "error" }));
        return true;
      },
    },
  ],
  [
    "MIGRATE_VOCAB",
    {
      from: "extension-page",
      payload: "{}",
      senders: ["settings/vocabulary.js"],
      handle(message, sender, sendResponse) {
        migrateVocabularyStorage()
          .then((result) => sendResponse(result))
          .catch(() => sendResponse({ ok: false, migrated: 0, reason: "error" }));
        return true;
      },
    },
  ],
  [
    "GET_LOOKUP_CACHE_STATS",
    {
      from: "extension-page",
      payload: "{}",
      senders: ["settings/data.js"],
      handle(message, sender, sendResponse) {
        getLookupCacheStats()
          .then((stats) => sendResponse({ ok: true, stats }))
          .catch((err) => sendResponse({ ok: false, message: err?.message || "读取失败" }));
        return true;
      },
    },
  ],
  [
    "CLEANUP_LOOKUP_CACHE",
    {
      from: "extension-page",
      payload: "{ reason? }",
      senders: ["settings/data.js"],
      handle(message, sender, sendResponse) {
        cleanupLookupCache(message.reason || "manual")
          .then((summary) => sendResponse({ ok: true, summary }))
          .catch((err) => sendResponse({ ok: false, message: err?.message || "清理失败" }));
        return true;
      },
    },
  ],
  [
    "CLEAR_LOOKUP_CACHE",
    {
      from: "extension-page",
      payload: "{}",
      senders: ["settings/data.js"],
      handle(message, sender, sendResponse) {
        clearAllLookupCache()
          .then((deletedCount) => sendResponse({ ok: true, deletedCount }))
          .catch((err) => sendResponse({ ok: false, message: err?.message || "清除失败" }));
        return true;
      },
    },
  ],
  [
    "CLEAR_USAGE_LOGS",
    {
      from: "extension-page",
      payload: "{}",
      senders: ["settings/data.js"],
      handle(message, sender, sendResponse) {
        zehUpdateStorageList(ZEH_STORAGE.usageLogs, () => ({ list: [] }))
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, message: err?.message || "清除失败" }));
        return true;
      },
    },
  ],
  [
    "CLEAR_READER_POSITION_CACHE",
    {
      from: "extension-page",
      payload: "{}",
      senders: ["settings/data.js"],
      handle(message, sender, sendResponse) {
        chrome.storage.local
          .remove([ZEH_STORAGE.readerPositionCache])
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, message: err?.message || "清除失败" }));
        return true;
      },
    },
  ],
  [
    "GET_ASSEMBLYAI_TEMP_TOKEN",
    {
      from: "extension-page",
      payload: "{}",
      senders: ["live-transcribe.js"],
      handle(message, sender, sendResponse) {
        getAssemblyAITemporaryToken()
          .then((token) => sendResponse({ ok: true, token }))
          .catch((err) => sendResponse({ ok: false, message: err?.message || "获取 token 失败" }));
        return true;
      },
    },
  ],
  [
    "GET_LIVE_TRANSCRIBE_PROVIDER_OPTIONS",
    {
      from: "extension-page",
      payload: "{}",
      senders: ["live-transcribe.js"],
      handle(message, sender, sendResponse) {
        getLiveTranscribeProviderOptions()
          .then((info) => sendResponse(info))
          .catch((err) => sendResponse({ ok: false, message: err?.message || "读取失败" }));
        return true;
      },
    },
  ],
  [
    "SET_LIVE_TRANSCRIBE_PROVIDER",
    {
      from: "extension-page",
      payload: "{ providerId }",
      senders: ["live-transcribe.js"],
      handle(message, sender, sendResponse) {
        setLiveTranscribeProvider(message.providerId)
          .then((result) => sendResponse(result))
          .catch((err) => sendResponse({ ok: false, message: err?.message || "保存失败" }));
        return true;
      },
    },
  ],
  [
    "PREVIEW_TAB_CAPTURE_TARGET",
    {
      from: "extension-page",
      payload: "{}",
      senders: ["live-transcribe.js"],
      handle(message, sender, sendResponse) {
        previewTabCaptureTarget()
          .then((info) => sendResponse(info))
          .catch((err) => sendResponse({ ok: false, message: err?.message || "预览失败" }));
        return true;
      },
    },
  ],
  [
    "START_TAB_AUDIO_CAPTURE_FROM_ACTIVE_TAB",
    {
      from: "extension-page",
      payload: "{ … }（整条消息交给 startTabAudioCaptureFromActiveTab）",
      senders: ["popup.js"],
      handle(message, sender, sendResponse) {
        startTabAudioCaptureFromActiveTab(message)
          .then((info) => sendResponse({ ok: true, ...info }))
          .catch((err) => sendResponse({ ok: false, message: err?.message || "标签页捕获失败" }));
        return true;
      },
    },
  ],
  [
    "TRANSLATE_TRANSCRIPT",
    {
      from: "extension-page",
      payload: "{ currentText | text, previousContext?, mode? }",
      senders: ["live-transcribe.js"],
      validate(message) {
        const currentText = (message.currentText || message.text || "").trim();
        if (!currentText) {
          return { ok: false, response: { ok: false, error: "empty transcript", message: "没有可翻译的文本" } };
        }
        return { ok: true, value: currentText };
      },
      handle(message, sender, sendResponse, currentText) {
        const previousContext = message.previousContext || [];
        translateTranscriptWithContext(currentText, previousContext, message.mode)
          .then((result) => sendResponse(result))
          .catch((err) => {
            const readable = sanitizeProviderErrorMessage(err?.message || "翻译失败");
            sendResponse({ ok: false, error: readable, message: readable });
          });
        return true;
      },
    },
  ],
]);

/**
 * Service Worker 发给页面的消息（不经过上面的监听器）：类型 → 处理它的文件。
 * 只是登记，便于核对；发送方式见 sendToTab（有 tabId 发到标签页，否则发给扩展页面）。
 */
const ZEH_PAGE_BOUND_MESSAGES = Object.freeze({
  SHOW_RESULT: ["mk-lookup.js"],
  SHOW_ERROR: ["mk-lookup.js", "pdf-page-assistant.js"],
  DICT_ENHANCED: ["mk-lookup.js"],
  CONTEXT_ENHANCED: ["mk-lookup.js"],
  PDF_PAGE_LOOKUP: ["pdf-page-assistant.js"],
  PDF_PAGE_COLLAPSE: ["pdf-page-assistant.js"],
  PDF_PAGE_SUPPRESS: ["pdf-page-assistant.js"],
  PDF_PAGE_RESTORE: ["pdf-page-assistant.js"],
  PDF_READER_LOOKUP: ["pdf-reader/app.js"],
  TAB_AUDIO_CAPTURE_PENDING: ["live-transcribe.js"],
});

/** EXPLAIN 的 queryId：查词控制器生成的 q_<时间>_<随机>，这里只要求是短的安全字符串（M3b） */
const ZEH_LOOKUP_QUERY_ID_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
const ZEH_INVALID_LOOKUP_MESSAGE = "查词请求无效，请重新选中文本再试。";

function zehIsLookupQueryId(queryId) {
  return typeof queryId === "string" && ZEH_LOOKUP_QUERY_ID_PATTERN.test(queryId);
}

/** 监听器按 type 找路由；格式不对的消息没有路由 */
function zehMessageRoute(message) {
  if (!message || typeof message !== "object" || typeof message.type !== "string") return undefined;
  return ZEH_MESSAGE_ROUTES.get(message.type);
}

/**
 * 找不到路由时回什么（M3b 默认拒绝）。null = 不回复（监听器返回 false）。
 * 扩展里没有页面之间互发的 runtime 消息，worker 也收不到自己的广播，
 * 所以除发往页面的类型外，worker 收到的未登记消息一定是错的或伪造的。
 */
function zehUnroutedMessageResponse(message) {
  if (!message || typeof message !== "object" || typeof message.type !== "string") {
    return { ok: false, accepted: false, code: "MALFORMED_MESSAGE" };
  }
  if (Object.prototype.hasOwnProperty.call(ZEH_PAGE_BOUND_MESSAGES, message.type)) return null;
  return { ok: false, accepted: false, code: "UNKNOWN_MESSAGE_TYPE" };
}

// 发送方检查读的两个集合，由注册表推出（名字保持 Phase 5 的写法）
const ZEH_CONTENT_SCRIPT_MESSAGE_TYPES = new Set(
  [...ZEH_MESSAGE_ROUTES].filter(([, route]) => route.from === "any").map(([type]) => type)
);

const ZEH_EXTENSION_PAGE_MESSAGE_TYPES = new Set(
  [...ZEH_MESSAGE_ROUTES].filter(([, route]) => route.from === "extension-page").map(([type]) => type)
);

/** sender 是否扩展自己的页面（chrome-extension://<本扩展 id>/…），而不是注入网页的内容脚本 */
function zehIsExtensionPageSender(sender) {
  if (!sender || typeof sender !== "object") return false;
  if (sender.id && sender.id !== chrome.runtime.id) return false;
  const url = String(sender.url || "");
  if (!url) return false;
  return url.startsWith(chrome.runtime.getURL(""));
}

/**
 * 消息是否允许由该 sender 发起。只对已登记的类型调用（未登记的先由 zehUnroutedMessageResponse 拒绝）。
 * @returns {{ allowed: boolean, reason?: string }}
 */
function zehAuthorizeMessage(type, sender) {
  if (ZEH_CONTENT_SCRIPT_MESSAGE_TYPES.has(type)) return { allowed: true };
  if (ZEH_EXTENSION_PAGE_MESSAGE_TYPES.has(type)) {
    if (zehIsExtensionPageSender(sender)) return { allowed: true };
    return { allowed: false, reason: "extension_page_only" };
  }
  return { allowed: true };
}
