/**
 * Service worker 模块：查词流程（EXPLAIN）。
 *
 * 由 background.js 的 importScripts 列表加载。本文件只声明，加载时不调用任何 chrome API。
 * handleExplain 是 EXPLAIN 消息的处理函数：校验后的文本 → 总开关 → 特殊词 → 词典 → 缓存 → provider，
 * 先用 sendResponse 回「已受理」，结果再用 sendToTab 发回发起查询的 frame（扩展页面用 runtime 广播）；语境增强在基础结果之后单独发送。
 * 依赖：sw/settings.js、sw/cache.js、sw/dictionary.js、sw/provider-client.js、sendToTab（发回标签页）、
 *       config.js（查询类型、上下文请求、超时）。
 * pendingLookups 只在一个 worker 生命周期内合并相同的进行中请求；worker 重启后丢失不影响正确性。
 */

function logLookupFailed(details) {
  zehDebugLog("[Manekilex] lookup failed", details);
}

// ─── 并发去重 —— 同一个 cacheKey 正在请求中时，后续请求共享同一个 Promise ───────
const pendingLookups = new Map();

/**
 * 调用 provider，并把成功结果（与词典合并后）写入缓存。
 * 返回值由原始请求和所有去重等待者共享；失败时 reject（含超时）。
 */
async function runProviderLookup(provider, selectedText, queryType, dictEntry, context = null) {
  // 有语境时用带语境的提示词（选中词 + 句子），结果按语境单独缓存
  const request = context ? zehBuildContextLookupRequest(selectedText, queryType, context) : null;
  const result = await callProvider(provider, selectedText, queryType, request);
  if (result.fallback) return result;

  // 合并词典字段（仅 word/phrase 且词典命中时 merge）
  let finalData;
  if (queryType === "sentence" || queryType === "paragraph" || queryType === "code_term") {
    finalData = result.data;
  } else if (dictEntry) {
    finalData = mergeDictionaryAndAIResult(dictEntry, result.data);
  } else {
    finalData = zehNormalizeWordResult(result.data);
  }
  await setCacheLookup(
    queryType,
    selectedText,
    finalData,
    {
      id: result.provider,
      model: result.modelName,
    },
    context
  );
  return { ...result, data: finalData };
}

/**
 * 语境增强（Phase 3）：基础结果（词典 / 通用缓存）已显示，只请求「此处含义」。
 * 成功时把合并后的完整结果写入语境缓存；无法解析视为失败（页面保留基础结果）。
 */
async function runContextEnhancement(provider, selectedText, queryType, context, baseData) {
  const basic = zehNormalizeWordResult({ ...(baseData || {}), queryType });
  // 已有可用助记（过了质量门）就不再让模型写，省输出；没有或无效时由这一次请求补上
  const request = zehBuildContextEnhanceRequest(
    selectedText,
    queryType,
    context,
    basic.short_meaning,
    Boolean(basic.memory_tip)
  );
  const result = await callProvider(provider, selectedText, queryType, request);
  const enhancement = result.fallback
    ? null
    : zehNormalizeContextEnhancement(result.data, basic.term || selectedText);
  if (!enhancement) {
    const err = new Error("语境增强结果无法解析");
    err.code = "CONTEXT_UNPARSEABLE";
    throw err;
  }
  const merged = zehMergeContextEnhancement(basic, enhancement);
  await setCacheLookup(
    queryType,
    selectedText,
    merged,
    { id: result.provider, model: result.modelName },
    context
  );
  return { ...result, data: merged, enhancement };
}

/** 当前 provider 配置了 API Key 时返回它，否则 null（没有模型就不做语境增强）。 */
async function getContextEnhanceProvider() {
  try {
    const provider = getActiveProviderConfig(await getAppSettings());
    return provider?.apiKey?.trim() ? provider : null;
  } catch {
    return null;
  }
}

/** 发起（或加入同一语境正在进行的）增强请求，并给这个请求方发一条 CONTEXT_ENHANCED。 */
async function sendContextEnhancement({ tabId, frame, queryId, queryType, selectedText, context, provider, baseData }) {
  const contextHash = zehLookupContextHash(context);
  let message;
  try {
    const key = `enhance:${zehContextDedupKey(queryType, selectedText, context)}`;
    const { leader, promise } = zehShareInflightLookup(pendingLookups, key, () =>
      runContextEnhancement(provider, selectedText, queryType, context, baseData)
    );
    const outcome = await zehSettleLookupOutcome(promise);
    if (leader) {
      zehDebugLog("[ZEH context]", {
        term: selectedText,
        contextHash,
        status: outcome.status,
        message: outcome.status === "error" ? safeErrorMessage(outcome.error) : undefined,
      });
    }
    message = zehContextEnhancedMessage(outcome, { queryId, contextHash });
  } catch (err) {
    console.warn("[Manekilex] context enhancement failed", err);
    message = { type: "CONTEXT_ENHANCED", queryId, contextHash, ok: false, reason: "error" };
  }
  // 绝不发 SHOW_ERROR：基础结果已在页面上，失败只让页面收起「分析中」提示
  sendToTab(tabId, message, frame);
}

/** EXPLAIN：词典 / 缓存 / provider 查词；sendResponse 只回「已受理」，结果用 sendToTab 发回页面 */
function handleExplain(message, sender, sendResponse, validation) {
  // 增强 PDF 阅读器可能作为 PDF 标签页里的 MIME 处理页运行，不一定收得到 tabs.sendMessage：
  // 结果改用 runtime 广播发给扩展页面，页面按 queryId 认领（其他页面忽略）
  const tabId = isPdfReaderUrl(sender.url) ? null : sender.tab?.id;
  // M3b：在标签页里时只发回发起查询的那个 frame（同一标签页的其他 frame 收不到）
  const frame = lookupReplyFrame(sender, tabId);
  const reply = (resultMessage) => sendToTab(tabId, resultMessage, frame);
  const queryType = message.queryType || validation.queryType;
  const selectedText = validation.normalized;
  const queryId = message.queryId || null;
  // Phase 3：语境只用于 word / phrase；页面传来的语境在这里重新校验、限长（不可用 → null，照常查词）
  const context = zehNormalizeLookupContext(message.context, selectedText, queryType);
  const contextHash = context ? zehLookupContextHash(context) : "";
  const dedupKey = context
    ? zehContextDedupKey(queryType, selectedText, context)
    : zehLookupCacheDedupKey(queryType, selectedText);
  const useDictionary = shouldUseDictionary(queryType);
  const startMs = Date.now();
  let responded = false;

  (async () => {
    try {
      const manekilexEnabled = await zehGetManekilexEnabledAsync();
      if (!manekilexEnabled) {
        if (!responded) {
          sendResponse({
            accepted: false,
            code: "disabled",
            message: ZEH_MANEKILEX_DISABLED_MESSAGE,
          });
          responded = true;
        }
        return;
      }

      // ── 0. Manekilex 彩蛋：优先于缓存与 API，并覆盖旧缓存 ────────────────
      const manekilexEntry = getManekilexSpecialEntry(selectedText);
      if (manekilexEntry) {
        const dictEntry = normalizeDictEntry(manekilexEntry, selectedText);
        sendResponse({ accepted: true, queryType, fromSpecial: true });
        responded = true;
        reply({
          type: "SHOW_RESULT",
          queryId,
          queryType,
          durationMs: 0,
          fromDict: true,
          data: dictEntry,
        });
        await setCacheLookup(queryType, selectedText, zehNormalizeWordResult(dictEntry), {
          id: "special",
          model: "",
        });
        zehDebugLog("[ZEH lookup]", {
          normalizedText: selectedText,
          hitCache: false,
          hitDictionary: true,
          source: "special",
          elapsedMs: Date.now() - startMs,
        });
        return;
      }

      // ── 1a. 同一词 + 同一语境的结果已缓存：直接返回完整的语境结果 ─────────
      if (context) {
        const contextCached = await getCacheLookup(queryType, selectedText, context);
        if (contextCached) {
          sendResponse({ accepted: true, queryType, fromCache: true });
          responded = true;
          reply({
            type: "SHOW_RESULT",
            queryId,
            queryType,
            durationMs: 0,
            fromCache: true,
            contextHash,
            data: { ...contextCached.data, queryType },
          });
          zehDebugLog("[ZEH lookup]", {
            normalizedText: zehNormalizeTextForCache(queryType, selectedText),
            cacheKey: contextCached.storageKey,
            hitCache: true,
            contextual: true,
            calledOpenAI: false,
            source: "context-cache",
            elapsedMs: Date.now() - startMs,
          });
          return;
        }
      }

      // ── 1b. 命中通用缓存，直接返回，不走 API 也不走词典；有语境时再异步增强 ──
      const cached = await getCacheLookup(queryType, selectedText);
      if (cached) {
        const enhanceProvider = context ? await getContextEnhanceProvider() : null;
        sendResponse({ accepted: true, queryType, fromCache: true });
        responded = true;
        reply({
          type: "SHOW_RESULT",
          queryId,
          queryType,
          durationMs: 0,
          fromCache: true,
          contextPending: Boolean(enhanceProvider),
          data: { ...cached.data, queryType },
        });
        zehDebugLog("[ZEH lookup]", {
          normalizedText: zehNormalizeTextForCache(queryType, selectedText),
          cacheKey: zehCacheV2StorageKey(
            queryType,
            zehNormalizeTextForCache(queryType, selectedText).length,
            zehCacheTextHash(queryType, zehNormalizeTextForCache(queryType, selectedText))
          ),
          useDictionary,
          hitCache: true,
          hitDictionary: false,
          calledOpenAI: false,
          source: "cache",
          contextHash: contextHash || undefined,
          elapsedMs: Date.now() - startMs,
        });
        if (enhanceProvider) {
          await sendContextEnhancement({
            tabId,
            frame,
            queryId,
            queryType,
            selectedText,
            context,
            provider: enhanceProvider,
            baseData: cached.data,
          });
        }
        return;
      }

      // ── 2. 读取 API 配置 ──────────────────────────────────────────────────
      const appSettings = await getAppSettings();
      const provider = getActiveProviderConfig(appSettings);
      // 有语境且配置了模型：词典结果先显示，再异步分析「此处含义」
      const canEnhanceContext = Boolean(context && provider.apiKey?.trim());

      // ── 3. 命中本地词典（sentence/paragraph 跳过），立刻显示，再后台增强 ──
      // 空壳条目（enriched:true 但没有释义）按未命中处理：交给模型兜底，也不写入缓存
      const foundDictEntry = useDictionary ? await getDictionaryEntry(selectedText) : null;
      const dictEntryEmpty = Boolean(foundDictEntry) && !zehIsDictEntryUsable(foundDictEntry);
      const rawDictEntry = dictEntryEmpty ? null : foundDictEntry;
      const dictEntry = rawDictEntry ? normalizeDictEntry(rawDictEntry, selectedText) : null;

      if (dictEntry) {
        const dictEnriched = zehIsDictEntryEnriched(rawDictEntry);
        const enhanceDictEntry = canEnhanceContext && !dictEntry.specialEntry;
        sendResponse({ accepted: true, queryType });
        responded = true;
        reply({
          type: "SHOW_RESULT",
          queryId,
          queryType,
          durationMs: 0,
          fromDict: true,
          contextPending: enhanceDictEntry,
          data: dictEntry,
        });
        zehDebugLog("[ZEH lookup]", {
          normalizedText: zehNormalizeTextForCache(queryType, selectedText),
          cacheKey: dedupKey,
          useDictionary,
          hitCache: false,
          hitDictionary: true,
          dictEnriched,
          contextHash: contextHash || undefined,
          calledOpenAI: enhanceDictEntry || (dictEnriched ? false : !!provider.apiKey?.trim()),
          source: dictEntry.specialEntry
            ? "special"
            : dictEnriched
              ? "dictionary-enriched"
              : "dictionary",
          elapsedMs: Date.now() - startMs,
        });
        // 词典命中不再复制进查词缓存（R-27）：词典本身就是本地快路径，缓存只保存模型结果
        if (enhanceDictEntry) {
          // 词典结果已经可用：增强失败也只发 ok:false，页面保留词典结果
          await sendContextEnhancement({
            tabId,
            frame,
            queryId,
            queryType,
            selectedText,
            context,
            provider,
            baseData: dictEntry,
          });
          return;
        }
        if (dictEnriched) return;
        // 未 enrich：无 API Key 则只展示词典结果
        if (!provider.apiKey?.trim()) return;
        // 有 API Key，继续走 API 增强（不 return，继续往下）
      } else {
        let missReason = "not_in_dictionary";
        if (!useDictionary) {
          missReason = "query_type_skips_dictionary";
        } else if (dictEntryEmpty) {
          missReason = "dictionary_entry_empty";
        } else {
          try {
            const dictLoaded = (await loadDictionaryOnce()).size > 0;
            missReason = dictLoaded ? "not_in_dictionary" : "dictionary_not_loaded";
          } catch {
            missReason = "dictionary_not_loaded";
          }
        }
        zehDebugLog("[ZEH dict miss]", {
          normalizedText: zehNormalizeTextForCache(queryType, selectedText),
          dictionaryHasKey: false,
          useDictionary,
          reason: missReason,
        });

        // 无词典 & 无 API Key → 报错
        if (!provider.apiKey?.trim()) {
          sendResponse({
            accepted: false,
            code: "NO_API_KEY",
            message: `请先在设置 → 模型与 API 中配置 ${provider.meta.name} 的 API Key`,
          });
          responded = true;
          return;
        }
        sendResponse({ accepted: true, queryType });
        responded = true;
      }

      // ── 4. 并发去重 + 调用 API：相同 dedupKey 正在请求则共享同一个结果 ──────
      // 原始请求和去重等待者都会收到成功或失败的终态消息（不会无限转圈）。
      const { leader, promise } = zehShareInflightLookup(pendingLookups, dedupKey, () =>
        runProviderLookup(provider, selectedText, queryType, dictEntry, context)
      );
      const outcome = await zehSettleLookupOutcome(promise);

      if (leader) {
        if (outcome.status === "fallback" && !dictEntry) {
          logLookupFailed({
            queryType,
            textPreview: selectedText.slice(0, 80),
            providerId: outcome.result.provider,
            model: outcome.result.modelName,
            errorCategory: "parse_fallback",
          });
        } else if (outcome.status === "error" && !dictEntry) {
          logLookupFailed({
            queryType,
            textPreview: selectedText.slice(0, 80),
            providerId: provider?.id,
            model: provider?.model,
            errorCategory: outcome.error?.code === ZEH_LOOKUP_TIMEOUT_CODE ? "timeout" : "api_error",
            message: safeErrorMessage(outcome.error),
          });
        } else if (outcome.status === "ok") {
          zehDebugLog("[ZEH lookup]", {
            normalizedText: zehNormalizeTextForCache(queryType, selectedText),
            cacheKey: dedupKey,
            useDictionary,
            hitCache: false,
            hitDictionary: !!dictEntry,
            calledOpenAI: true,
            contextHash: contextHash || undefined,
            source: dictEntry ? "dict+openai" : context ? "openai+context" : "openai",
            elapsedMs: Date.now() - startMs,
          });
        }
      }

      const terminalMessage = zehLookupOutcomeMessage(outcome, {
        queryId,
        queryType,
        hasDictEntry: Boolean(dictEntry),
      });
      if (terminalMessage) reply(terminalMessage);

    } catch (error) {
      console.warn("[Manekilex] EXPLAIN failed", error);
      if (!responded) {
        // code 让页面区分“内部错误”和“没配 API Key”（只有 NO_API_KEY 才显示设置按钮）
        sendResponse({
          accepted: false,
          ok: false,
          code: "INTERNAL",
          message: safeErrorMessage(error),
          error: safeErrorMessage(error),
        });
      } else {
        reply({
          type: "SHOW_ERROR",
          queryId,
          message: safeErrorMessage(error) || "请求失败，请稍后重试",
        });
      }
    }
  })();

  return true;
}
