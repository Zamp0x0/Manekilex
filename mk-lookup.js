/**
 * mk-lookup.js — 划词查词的共享控制器（Manekilex）
 *
 * 暴露 window.MKLookup.createController({...})。网页 content.js、EPUB reader.js、PDF 增强阅读器
 * pdf-reader.js、侧边栏 lookup-panel.js 共用同一个控制器：小球与面板的生命周期、查词流程
 * （EXPLAIN → SHOW_RESULT / SHOW_ERROR / DICT_ENHANCED / CONTEXT_ENHANCED）、超时、bfcache、
 * 生词本（ADD_VOCAB）和对外 API 都在这里。
 *
 * M7 把与生命周期无关的部分拆到 lookup/ 下，每个文件是一个只声明的工厂函数，
 * createController 为每个控制器各调用一次（状态留在各自的闭包里）：
 *   lookup/render.js     结果面板的 HTML 与复制文本            zehCreateLookupRenderer
 *   lookup/egg.js        Manekilex 彩蛋动画                    zehCreateLookupEasterEgg
 *   lookup/tts.js        发音与 Web Speech 预热                zehCreateLookupSpeech
 *   lookup/selection.js  读取与修正选区（iframe / Shadow DOM / 输入框 / 半个单词）  zehCreateLookupSelection
 *   lookup/context.js    选区附近的句子（查词语境）            zehCreateLookupContext
 *   lookup/runtime.js    与后台的通道、扩展失效防护、queryId 认领  zehCreateLookupRuntime
 * 所有查词宿主（manifest 内容脚本、reader.html、lookup-panel.html、pdf-reader.html）都按同一顺序
 * 在本文件之前加载这些文件；tests/load-order-static.test.js 检查顺序一致。
 *
 * 依赖 config.js：ZEH_STORAGE、zehDefaultTheme、zehDetectQueryType、
 * zehHasEnglish、zehNormalizeLookupText、zehCanonicalLookupKey；
 * lookup/dom-helpers.js：zehRepairSelectionWithContext、zehEnsureDictKeys。
 */
(function () {
  const HITBOX_SIZE = 32; // 可点击热区（button 元素本身）
  const PANEL_GAP = 8;
  const TRIGGER_ACTIVATE_DELAY_MS = 180;
  const EXT_INVALIDATED_MSG =
    "Manekilex 已更新或上下文失效，请刷新当前页面后重试。";
  const ACTIVE_BUBBLE_KEY = "__manekilexActiveBubbleControllerId";
  const BUBBLE_STALE_MS = 60000;
  const TRIGGER_ACTIVATE_DEBOUNCE_MS = 350;

  const activeLookupControllers = new Set();
  let globalLookupEnabled = true;

  function applyGlobalLookupEnabled(enabled) {
    globalLookupEnabled = enabled !== false;
    if (!globalLookupEnabled) {
      activeLookupControllers.forEach((ctrl) => {
        try {
          ctrl.hideAll();
          ctrl.removeTriggerAndClearCache();
        } catch {
          /* noop */
        }
      });
    }
  }

  function isGlobalLookupEnabled() {
    return globalLookupEnabled;
  }

  /**
   * 创建一个查词控制器，绑定到指定的 window / document / 挂载点。
   * @param {Object} options
   * @param {Window} [options.win]   读取选区/视口尺寸/语音的窗口，默认 window
   * @param {Document} [options.doc] 创建/挂载元素的文档，默认 document
   * @param {Element} [options.mountEl] 挂载小球/面板/横幅的元素，默认 uiDoc.documentElement
   * @param {Document} [options.uiDoc] 创建面板/小球 DOM 的文档（可与 doc 不同，如 iframe 挂顶层）
   * @param {Window} [options.viewportWin] 面板定位用的视口窗口（默认与 win 相同）
   * @param {{left?: number, top?: number}} [options.viewportRectOffset] 选区坐标 → viewportWin 的偏移
   * @param {Function} [options.vocabContext] () => ({ pageUrl, pageTitle })，加入生词本时的来源信息
   * @param {Function} [options.rangeRectAdapter] (range) => DOMRect，把 range 转为视口坐标矩形（默认 getBoundingClientRect + offset）
   */
  function createController(options) {
    const opts = options || {};
    const win = opts.win || window;
    const doc = opts.doc || document;
    const uiDoc = opts.uiDoc || doc;
    const viewportWin = opts.viewportWin || win;
    const viewportRectOffset = opts.viewportRectOffset || { left: 0, top: 0 };
    // 挂载点按需解析（0.11.1）：Turbo / pjax 类 SPA 会整体替换 <body>，初始化时记下的元素
    // 会脱离文档；此时退回当前文档的 body / documentElement，小球和面板不会挂到看不见的旧节点上。
    const configuredMountEl = opts.mountEl || null;
    const configuredBubbleMountEl = opts.bubbleMountEl || null;
    function liveUiRoot() {
      return uiDoc.body || uiDoc.documentElement;
    }
    function getMountEl() {
      const el = configuredMountEl && configuredMountEl.isConnected ? configuredMountEl : null;
      return el || (configuredMountEl ? liveUiRoot() : uiDoc.documentElement);
    }
    function getBubbleMountEl() {
      if (configuredBubbleMountEl && configuredBubbleMountEl.isConnected) return configuredBubbleMountEl;
      return uiDoc.body || getMountEl();
    }
    const aggressiveBubbleMode = Boolean(opts.aggressiveBubbleMode);
    const vocabContext =
      opts.vocabContext ||
      (() => ({
        pageUrl: win.location.href,
        pageTitle: String(uiDoc.title || doc.title || "").trim(),
      }));
    const controllerId = `mk-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    function adaptViewportRect(rect) {
      if (!rect) return null;
      const ox = viewportRectOffset.left || 0;
      const oy = viewportRectOffset.top || 0;
      if (!ox && !oy) return rect;
      const left = rect.left + ox;
      const top = rect.top + oy;
      const right = (rect.right ?? left + rect.width) + ox;
      const bottom = (rect.bottom ?? top + rect.height) + oy;
      return {
        left,
        top,
        right,
        bottom,
        width: rect.width ?? right - left,
        height: rect.height ?? bottom - top,
      };
    }

    function eventViewportPoint(e) {
      if (!e || e.clientX == null || e.clientY == null) return null;
      let x = e.clientX;
      let y = e.clientY;
      const eventWin = e.view || win;
      if (eventWin === viewportWin) return { x, y };
      try {
        let w = eventWin;
        while (w && w !== viewportWin) {
          const frame = w.frameElement;
          if (!frame) break;
          const fr = frame.getBoundingClientRect();
          x += fr.left;
          y += fr.top;
          w = w.parent;
        }
      } catch {
        /* noop */
      }
      return { x, y };
    }

    const rangeRectAdapter =
      opts.rangeRectAdapter ||
      ((range) => adaptViewportRect(range.getBoundingClientRect()));

    const SELECTION_CACHE_TTL_MS = 10000;
    const SELECTION_STALE_GRACE_MS = 5000;
    const triggerActivateDelayMs = aggressiveBubbleMode ? 0 : TRIGGER_ACTIVATE_DELAY_MS;

    let triggerEl = null;
    let panelEl = null;
    let cachedText = "";
    let cachedRect = null;
    let cachedRange = null;
    let cachedFieldEl = null;
    let cachedQueryType = "word";
    let selectionCache = { text: "", rect: null, time: 0, source: "" };
    let pendingLookupText = "";
    let bubblePointerActive = false;
    let destroyed = false;
    let triggerActivatedAt = 0;
    let lookupToastTimer = null;

    // 结果面板的 HTML 与复制文本：lookup/render.js（只拼字符串，不碰 DOM）
    const {
      queryTypeLabel,
      resolveResultKind,
      isCodeTermResult,
      isParagraphResult,
      isSentenceResult,
      formatNoteText,
      renderDuration,
      renderExamplesInner,
      renderLexicalInner,
      renderCodeTermResult,
      renderManekilexSpecialResult,
      renderContextSectionInner,
      renderWordResult,
      renderSentenceResult,
      renderParagraphResult,
    } = zehCreateLookupRenderer({
      cachedText: () => cachedText,
      cachedQueryType: () => cachedQueryType,
      lookupContext: () => currentLookupContext,
      extensionAsset,
    });

    // Manekilex 彩蛋动画：lookup/egg.js（状态留在工厂闭包里，每个控制器一份）
    const { isManekilexEggResult, cleanupManekilexEasterEgg, finalizeManekilexEasterEggPanel } = zehCreateLookupEasterEgg({
      win,
      uiDoc,
      cachedText: () => cachedText,
      cachedRect: () => cachedRect,
      panel: () => panelEl,
      positionNearRect,
      extensionAsset,
    });

    // 发音与 Web Speech 预热：lookup/tts.js
    const { warmSpeechSynthesis, speakText } = zehCreateLookupSpeech({ win });

    // 读取与修正选区（iframe / Shadow DOM / 输入框 / 半个单词）：lookup/selection.js
    const {
      resolveTextPoint,
      expandPartialWordSelection,
      isTextInputElement,
      getTextInputSelectionRect,
      getFieldSelectionInfo,
      findTextInputAncestor,
      captureFieldSelectionSnapshot,
      resolveRangeViewportRect,
      isSelectionRangeConnected,
      extractSelectionText,
      getSelectionDeep,
      getSelectionTextDeep,
      adjustRectForFrameOffset,
      getSelectionRange,
    } = zehCreateLookupSelection({ win, doc, aggressiveBubbleMode, rangeRectAdapter, adaptViewportRect });

    // 查词语境（选区附近的句子）：lookup/context.js
    const { contextSourceTypeFor, captureContextSnapshot, buildLookupContextForQuery } = zehCreateLookupContext({ win, resolveTextPoint });

    // 与后台的通道、扩展上下文失效防护、queryId 认领：lookup/runtime.js
    const {
      isExtensionDead,
      refreshBanner,
      isStaleQueryMessage,
      handleControllerError,
      markExtensionDead,
      isExtensionAlive,
      installInvalidationGuard,
      safeStorageGet,
      safeSendMessage,
    } = zehCreateLookupRuntime({
      win,
      uiDoc,
      controllerId,
      invalidatedMessage: EXT_INVALIDATED_MSG,
      getMountEl,
      currentQueryId: () => currentQueryId,
      clearPending: () => {
        explainPending = false;
      },
      hideAll,
      showErrorPanel,
    });

    function stopLookupPropagation(e) {
      if (!e) return;
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === "function") {
        e.stopImmediatePropagation();
      }
    }

    function stopLookupEvent(e) {
      if (!e) return;
      e.preventDefault();
      stopLookupPropagation(e);
    }

    function normalizeSelectionRect(rect) {
      if (!rect) return null;
      return {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    }

    function isSelectionCacheFresh(maxAgeMs) {
      const maxAge = maxAgeMs == null ? SELECTION_CACHE_TTL_MS : maxAgeMs;
      const age = Date.now() - (selectionCache.time || 0);
      return Boolean(selectionCache.text) && age >= 0 && age < maxAge;
    }

    function writeSelectionCache(info, source) {
      const text = String(info?.text || "").trim();
      if (!text) return null;

      const rect = normalizeSelectionRect(info.rect);
      selectionCache = {
        text,
        rect,
        time: Date.now(),
        source: source || "web-selection",
        fieldEl: info.fieldEl || null,
        range: info.range || null,
        // Phase 3：在划词当下读取选区附近的有限文本（DOM 以后可能变化）；查词时再按最终词构造语境
        contextSnapshot: captureContextSnapshot(info, text),
        contextLocation: info.contextLocation || null,
      };
      cachedText = text;
      pendingLookupText = text;
      if (rect) cachedRect = rect;
      cachedRange = info.range || null;
      cachedFieldEl = info.fieldEl || null;

      zehDebugLog("[Manekilex] selection captured", {
        originalText: info.originalText != null ? info.originalText : text,
        expandedText: text,
        expanded: Boolean(info.selectionExpanded),
        textLength: text.length,
        textPreview: text.slice(0, 80),
        rect,
        source: selectionCache.source,
      });
      return selectionCache;
    }

    function storeSelectionSnapshot(info, source) {
      if (!info?.text) return null;
      return writeSelectionCache(info, source || "web-selection-sync");
    }

    function getPendingLookupTextFromBubble() {
      if (triggerEl?.dataset?.lookupText) {
        return String(triggerEl.dataset.lookupText).trim();
      }
      const bubbles = uiDoc.querySelectorAll(
        ".zeh-trigger.mk-lookup-bubble[data-lookup-text]"
      );
      let bestText = "";
      let bestTs = 0;
      for (const bubble of bubbles) {
        if (bubble.style.display === "none") continue;
        const ts = Number(bubble.dataset.lookupTs || 0);
        const text = String(bubble.dataset.lookupText || "").trim();
        if (text && ts >= bestTs) {
          bestTs = ts;
          bestText = text;
        }
      }
      return bestText;
    }

    function getPendingLookupText() {
      const fromCache = String(
        pendingLookupText || selectionCache.text || cachedText || ""
      ).trim();
      if (fromCache) return fromCache;
      return getPendingLookupTextFromBubble();
    }

    function countBubblesInUi() {
      return uiDoc.querySelectorAll(".zeh-trigger.mk-lookup-bubble").length;
    }

    function syncBubbleDataset(text, queryType) {
      if (!triggerEl) return;
      const pendingText = String(
        text || pendingLookupText || selectionCache.text || cachedText || ""
      ).trim();
      if (!pendingText) return;
      let qt = queryType || cachedQueryType || "word";
      try {
        const validation = zehValidateLookupText(pendingText);
        if (validation.ok && validation.queryType) qt = validation.queryType;
      } catch {
        /* noop */
      }
      triggerEl.dataset.controllerId = controllerId;
      triggerEl.dataset.lookupText = pendingText;
      triggerEl.dataset.lookupTs = String(Date.now());
      triggerEl.dataset.queryType = qt;
    }

    function clearActiveBubbleOwnerIfNeeded() {
      try {
        if (uiDoc[ACTIVE_BUBBLE_KEY] === controllerId) {
          delete uiDoc[ACTIVE_BUBBLE_KEY];
        }
      } catch {
        /* noop */
      }
    }

    function removeOwnedBubblesFromUi() {
      uiDoc
        .querySelectorAll(`.mk-lookup-bubble[data-controller-id="${controllerId}"]`)
        .forEach((el) => {
          if (el === triggerEl) triggerEl = null;
          el.remove();
        });
    }

    function claimActiveBubble() {
      try {
        const prev = uiDoc[ACTIVE_BUBBLE_KEY];
        if (prev && prev !== controllerId) {
          uiDoc.querySelectorAll(".zeh-trigger.mk-lookup-bubble").forEach((bubble) => {
            if (bubble.dataset.controllerId !== controllerId) bubble.remove();
          });
        }
        uiDoc[ACTIVE_BUBBLE_KEY] = controllerId;
      } catch {
        /* noop */
      }
    }

    function cleanupStaleBubbles() {
      const bubbles = [...uiDoc.querySelectorAll(".zeh-trigger.mk-lookup-bubble")];
      const now = Date.now();
      for (const bubble of bubbles) {
        const ts = Number(bubble.dataset.lookupTs || 0);
        const owner = bubble.dataset.controllerId;
        if (owner === controllerId && bubble === triggerEl) continue;
        if (owner === controllerId && bubble !== triggerEl) {
          bubble.remove();
          continue;
        }
        if (!panelEl && (!ts || now - ts > BUBBLE_STALE_MS)) {
          bubble.remove();
        }
      }
      const remaining = [...uiDoc.querySelectorAll(".zeh-trigger.mk-lookup-bubble")];
      if (remaining.length > 1) {
        remaining
          .sort(
            (a, b) => Number(b.dataset.lookupTs || 0) - Number(a.dataset.lookupTs || 0)
          )
          .slice(1)
          .forEach((bubble) => bubble.remove());
      }
      if (!triggerEl) {
        const newest = uiDoc.querySelector(".zeh-trigger.mk-lookup-bubble");
        if (newest?.dataset?.controllerId === controllerId) {
          triggerEl = newest;
        }
      }
    }

    function showLookupToast(message) {
      clearTimeout(lookupToastTimer);
      uiDoc.querySelectorAll(".zeh-lookup-toast").forEach((el) => el.remove());
      const toastEl = uiDoc.createElement("div");
      toastEl.className = "zeh-lookup-toast";
      toastEl.setAttribute("data-mk-lookup-ui", "");
      toastEl.textContent = message;
      (uiDoc.body || getMountEl()).appendChild(toastEl);
      lookupToastTimer = setTimeout(() => {
        toastEl.remove();
        lookupToastTimer = null;
      }, 3200);
    }

    function clearSelectionCache() {
      selectionCache = { text: "", rect: null, time: 0, source: "" };
    }

    function isPointerOverLookupUI(e) {
      const point = eventViewportPoint(e);
      if (!point) return false;
      const pad = 6;
      const x = point.x;
      const y = point.y;
      if (triggerEl && triggerEl.style.display !== "none") {
        const r = triggerEl.getBoundingClientRect();
        if (
          x >= r.left - pad &&
          x <= r.right + pad &&
          y >= r.top - pad &&
          y <= r.bottom + pad
        ) {
          return true;
        }
      }
      const bubbles = uiDoc.querySelectorAll(".zeh-trigger.mk-lookup-bubble");
      for (const bubble of bubbles) {
        if (bubble.style.display === "none") continue;
        const r = bubble.getBoundingClientRect();
        if (
          x >= r.left - pad &&
          x <= r.right + pad &&
          y >= r.top - pad &&
          y <= r.bottom + pad
        ) {
          return true;
        }
      }
      if (panelEl) {
        const r = panelEl.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
      }
      const banner = refreshBanner();
      if (banner) {
        const r = banner.getBoundingClientRect();
        if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
      }
      return false;
    }

    function isInsideLookupUI(target, event) {
      if (event && isPointerOverLookupUI(event)) return true;
      if (!target || !(target instanceof Node)) return false;
      const banner = refreshBanner();
      if (
        (triggerEl && triggerEl.contains(target)) ||
        (panelEl && panelEl.contains(target)) ||
        (banner && banner.contains(target))
      ) {
        return true;
      }
      if (typeof target.closest === "function") {
        if (target.closest("[data-mk-lookup-ui]")) return true;
      }
      if (typeof target.composedPath === "function") {
        return target.composedPath().some((node) => {
          if (!(node instanceof Node)) return false;
          return (
            (triggerEl && (node === triggerEl || triggerEl.contains(node))) ||
            (panelEl && (node === panelEl || panelEl.contains(node))) ||
            (banner && (node === banner || banner.contains(node))) ||
            (node instanceof Element && node.hasAttribute?.("data-mk-lookup-ui"))
          );
        });
      }
      return false;
    }

    let triggerClickableAt = 0;
    let triggerClickRetryTimer = null;
    let explainPending = false;
    let dismissedWhileLoading = false;
    let currentTheme = zehDefaultTheme();
    let currentQueryId = null;
    let lookupTimeoutTimer = null;
    // Phase 3：当前查词的语境（页面采集，仅 word/phrase）、当前结果、等待中的语境增强
    let currentLookupContext = null;
    let currentLookupLocation = null;
    let currentResultRef = null;
    let contextPendingQueryId = null;
    let contextTimeoutTimer = null;
    let _scrollRafPending = false;

    // 词典 key 集合不在初始化时请求（R-04），见 requestDictKeysForRepair

    // ── 主题 ─────────────────────────────────────────────────────────────────

    function applyTheme(theme) {
      currentTheme = { ...zehDefaultTheme(), ...(theme || {}) };
      paintThemeVars(getMountEl(), currentTheme);
      if (triggerEl) paintThemeVars(triggerEl, currentTheme);
      if (panelEl) paintThemeVars(panelEl, currentTheme);
    }

    function paintThemeVars(el, theme) {
      el.style.setProperty("--zeh-ball-start", theme.ballStart);
      el.style.setProperty("--zeh-ball-end", theme.ballEnd);
      el.style.setProperty("--zeh-header-start", theme.headerStart);
      el.style.setProperty("--zeh-header-end", theme.headerEnd);
      el.style.setProperty("--zeh-accent", theme.accent);
    }

    function loadTheme() {
      if (!isExtensionAlive()) {
        applyTheme(zehDefaultTheme());
        return;
      }
      safeStorageGet([ZEH_STORAGE.theme], (data) => {
        applyTheme(data[ZEH_STORAGE.theme]);
      });
    }

    /**
     * 首次需要词典保护时加载 key 集合；加载完成后，若仍是同一选区且尚未开始查询，
     * 用词典保护重新计算一次（如选中 look up 于 "look upward" 时保留 look up）。
     */
    function requestDictKeysForRepair(range, rawText, repairedText) {
      if (!globalLookupEnabled || destroyed) return;
      zehEnsureDictKeys((keys) => {
        if (!keys || destroyed || explainPending || panelEl) return;
        if (selectionCache.range !== range || selectionCache.text !== repairedText) return;
        let protectedText;
        try {
          protectedText = zehRepairSelectionWithContext(range, rawText, keys);
        } catch {
          return;
        }
        if (!protectedText || protectedText === repairedText) return;
        selectionCache = { ...selectionCache, text: protectedText };
        cachedText = protectedText;
        pendingLookupText = protectedText;
        syncBubbleDataset(protectedText);
        zehDebugLog("[Manekilex] selection repair kept dictionary term", {
          repairedText,
          protectedText,
        });
      });
    }

    function buildPageSelectionInfo(selection, selectionDoc, context) {
      const ctx = context || {};
      const frameOffset = ctx.frameOffset;
      const selectionSource = ctx.source;

      if (!selection || selection.isCollapsed) return null;
      const rawSelectionText = extractSelectionText(selection);
      if (!rawSelectionText) return null;

      const selDoc = selectionDoc || doc;
      const partialExpand = expandPartialWordSelection(selection, selDoc);
      const rawText = partialExpand.expanded ? partialExpand.text.trim() : rawSelectionText;

      let range = partialExpand.range || getSelectionRange(selection);
      if (!range || !isSelectionRangeConnected(range)) return null;

      const dictKeys = zehGetDictKeysSync();
      let text;
      try {
        text = zehRepairSelectionWithContext(range, rawText, dictKeys);
      } catch {
        text = zehNormalizeLookupText(rawText);
      }
      if (!text || !zehHasEnglish(text)) return null;
      // 词典 key 只在 repair 改动了用户选区时才有作用：此时才按需加载（R-04）
      if (!dictKeys && text !== zehNormalizeLookupText(rawText)) {
        requestDictKeysForRepair(range, rawText, text);
      }

      let rect = partialExpand.expanded ? partialExpand.rect : null;
      if (!rect) rect = resolveRangeViewportRect(range);
      if (rect && frameOffset && (frameOffset.left || frameOffset.top)) {
        rect = adjustRectForFrameOffset(rect, frameOffset);
      }

      const rawTrimmed = rawSelectionText.trim();
      if (rawTrimmed !== text && !partialExpand.expanded) {
        zehDebugLog("[Manekilex] selection repair", { rawText: rawTrimmed, repairedText: text });
      }

      if (selectionSource) {
        zehDebugLog("[Manekilex] selection source:", selectionSource, {
          textPreview: text.slice(0, 80),
          controllerId,
        });
      }

      return {
        text,
        rect,
        range,
        originalText: partialExpand.originalText || rawSelectionText,
        selectionExpanded: partialExpand.expanded,
        selectionSource,
        contextSource: { kind: "range", range, sourceType: contextSourceTypeFor(selectionSource) },
      };
    }

    function getSelectionInfo(options) {
      // 全局关闭时不读选区、不做 repair / 深度扫描（R-22）
      if (!globalLookupEnabled) return null;
      const opts = options || {};
      const selDoc = opts.externalDoc || opts.selectionDoc || doc;
      const selWin = opts.externalWin || opts.selectionWin || win;
      const externalSelection = opts.externalSelection || opts.selection;
      const fieldSnapshot = opts.fieldSnapshot;
      const skipDeep = Boolean(opts.skipDeep);

      if (fieldSnapshot && fieldSnapshot.el) {
        const snapInfo = getFieldSelectionInfo(
          fieldSnapshot.el,
          fieldSnapshot.start,
          fieldSnapshot.end
        );
        if (snapInfo) return snapInfo;
      }

      const active = selDoc.activeElement;
      if (isTextInputElement(active)) {
        const fieldInfo = getFieldSelectionInfo(active);
        if (fieldInfo) return fieldInfo;
      }

      if (!externalSelection && !skipDeep) {
        const deep = getSelectionDeep();
        if (deep) {
          const deepInfo = buildPageSelectionInfo(deep.selection, deep.selectionDoc, {
            frameOffset: deep.frameOffset,
            source: deep.source,
          });
          if (deepInfo) return deepInfo;
        }
      }

      const selection = externalSelection || selWin.getSelection();
      const range = getSelectionRange(selection);
      if (range) {
        const inputEl = findTextInputAncestor(range.commonAncestorContainer);
        if (inputEl) {
          const fieldInfo = getFieldSelectionInfo(inputEl);
          if (fieldInfo) return fieldInfo;
        }
      }

      const info = buildPageSelectionInfo(selection, selDoc);
      if (!info && !externalSelection && !fieldSnapshot) {
        zehDebugLog("[Manekilex] selection empty after deep read", {
          controllerId,
          frameHost: win.location?.hostname || "",
        });
      }
      return info;
    }

    function isOurElement(target, event) {
      return isInsideLookupUI(target, event);
    }

    function shouldKeepTriggerVisible() {
      if (!triggerEl) return false;
      return isSelectionCacheFresh(SELECTION_STALE_GRACE_MS);
    }

    function removeTrigger() {
      removeOwnedBubblesFromUi();
      triggerEl = null;
      clearActiveBubbleOwnerIfNeeded();
      bubblePointerActive = false;
    }

    function removeTriggerAndClearCache() {
      if (bubblePointerActive || explainPending || panelEl) return;
      removeTrigger();
      clearSelectionCache();
      cachedText = "";
      cachedRect = null;
      cachedRange = null;
      cachedFieldEl = null;
      pendingLookupText = "";
    }

    function removePanel() {
      if (panelEl) {
        cleanupManekilexEasterEgg(panelEl);
        panelEl.remove();
        panelEl = null;
      }
    }

    function hideAll() {
      if (explainPending) dismissedWhileLoading = true;
      currentQueryId = null;
      clearLookupTimeout();
      bubblePointerActive = false;
      clearTimeout(lookupToastTimer);
      lookupToastTimer = null;
      try {
        win.speechSynthesis.cancel();
      } catch {
        /* noop */
      }
      removePanel();
      removeTrigger();
      clearSelectionCache();
      resetContextState();
      cachedText = "";
      cachedRect = null;
      cachedRange = null;
      cachedFieldEl = null;
      pendingLookupText = "";
      cachedQueryType = "word";
      explainPending = false;
    }

    function openSettings() {
      safeSendMessage({ type: "OPEN_SETTINGS", section: "models" });
    }

    function isTriggerClickAllowed() {
      return Date.now() >= triggerClickableAt;
    }

    function armTriggerActivationDelay(reset) {
      if (!reset && triggerEl && Date.now() < triggerClickableAt) return;
      triggerClickableAt = Date.now() + triggerActivateDelayMs;
      if (!triggerEl) return;
      triggerEl.style.pointerEvents = "auto";
      triggerEl.style.cursor = "pointer";
    }

    // ── 面板定位 / 外壳 ─────────────────────────────────────────────────────────

    function positionNearRect(el, rect, preferBelow) {
      const margin = 12;
      const elRect = el.getBoundingClientRect();
      let left = rect.right + PANEL_GAP;
      let top = preferBelow ? rect.bottom + PANEL_GAP : rect.top - elRect.height - PANEL_GAP;

      if (left + elRect.width > viewportWin.innerWidth - margin) {
        left = rect.left - elRect.width - PANEL_GAP;
      }
      if (left < margin) left = margin;
      if (left + elRect.width > viewportWin.innerWidth - margin) {
        left = Math.max(margin, viewportWin.innerWidth - elRect.width - margin);
      }
      if (top + elRect.height > viewportWin.innerHeight - margin) {
        top = viewportWin.innerHeight - elRect.height - margin;
      }
      if (top < margin) top = margin;

      el.style.left = left + "px";
      el.style.top = top + "px";
    }

    function extensionAsset(path) {
      if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
        return chrome.runtime.getURL(path);
      }
      return path;
    }

    /**
     * 网页脚本合成的事件（isTrusted 为 false）：小球和面板挂在网页自己的 DOM 里，网页可以对它们
     * dispatchEvent / click()。这类事件不能替用户查词（花用户的 Key）、加入生词本或打开设置。
     * 只有浏览器生成的真实输入（鼠标、触摸、键盘）才算用户操作。
     */
    function isScriptedEvent(e) {
      return Boolean(e) && e.isTrusted === false;
    }

    function bindPanelHeaderEvents() {
      panelEl.querySelector(".zeh-panel-settings").addEventListener("click", (e) => {
        if (isScriptedEvent(e)) return;
        e.stopPropagation();
        openSettings();
      });
      panelEl.querySelector(".zeh-panel-close").addEventListener("click", hideAll);
      panelEl.addEventListener("mousedown", (e) => e.stopPropagation());
      panelEl.addEventListener("mouseup", (e) => e.stopPropagation());
    }

    function createPanelShell() {
      warmSpeechSynthesis();
      removePanel();
      panelEl = uiDoc.createElement("div");
      panelEl.className = "zeh-panel";
      panelEl.dataset.mkLookupUi = "1";
      panelEl.setAttribute("data-mk-lookup-ui", "");
      panelEl.dataset.queryType = cachedQueryType || "word";
      // 面板属于哪次查询：迟到的语境增强只更新同一次查询的面板
      panelEl.dataset.queryId = currentQueryId || "";
      panelEl.innerHTML = `
        <div class="zeh-panel-header">
          <span class="zeh-panel-title">Manekilex</span>
          <img class="zeh-panel-header-cat" src="${extensionAsset("icons/css_5.png")}" alt="" />
          <div class="zeh-panel-header-right">
            <div class="zeh-panel-actions">
              <button type="button" class="zeh-panel-settings" title="设置">&#9881;</button>
              <button type="button" class="zeh-panel-close" title="关闭">×</button>
            </div>
          </div>
        </div>
        <div class="zeh-panel-body"></div>
        <div class="zeh-panel-footer" hidden></div>
      `;
      bindPanelHeaderEvents();
      paintThemeVars(panelEl, currentTheme);
      paintThemeVars(getMountEl(), currentTheme);
      getMountEl().appendChild(panelEl);

      const anchor = cachedRect || { right: 100, bottom: 100, top: 80, left: 80 };
      positionNearRect(panelEl, anchor, true);
    }

    function setPanelBody(html, showFooter) {
      if (!panelEl) return;
      panelEl.querySelector(".zeh-panel-body").innerHTML = html;

      const footer = panelEl.querySelector(".zeh-panel-footer");
      if (showFooter) {
        footer.hidden = false;
        footer.className = "zeh-panel-footer mk-panel-actions";
        footer.innerHTML = `
          <button type="button" class="mk-btn mk-btn-secondary mk-btn-sm">发音</button>
          <button type="button" class="mk-btn mk-btn-secondary mk-btn-sm">加入生词本</button>
          <button type="button" class="mk-btn mk-btn-primary mk-btn-sm">复制</button>
        `;
      } else {
        footer.hidden = true;
        footer.innerHTML = "";
      }
      positionNearRect(panelEl, cachedRect || { right: 100, bottom: 100, top: 80, left: 80 }, true);
      requestAnimationFrame(() => {
        if (panelEl) {
          positionNearRect(panelEl, cachedRect || { right: 100, bottom: 100, top: 80, left: 80 }, true);
        }
      });
    }

    // ── 复制 / 发音 / 生词本 ────────────────────────────────────────────────────

    function vocabPayload(data) {
      const ctx = vocabContext() || {};
      const base = {
        term: data.term || cachedText,
        queryType: data.queryType || cachedQueryType,
        pageUrl: ctx.pageUrl || win.location.href,
      };
      if (ctx.pageTitle) base.pageTitle = ctx.pageTitle;
      // EPUB：书籍信息来自阅读器；章节 / CFI 是划词当下记录的位置
      if (ctx.book && typeof ctx.book === "object") {
        base.book = { ...ctx.book, ...(currentLookupLocation || {}) };
      }
      // PDF：文件信息来自 PDF 阅读器；页码是划词当下记录的位置
      if (ctx.pdf && typeof ctx.pdf === "object") {
        base.pdf = { ...ctx.pdf, ...(currentLookupLocation || {}) };
        base.sourceType = "pdf";
      }

      if (isCodeTermResult(data)) {
        const exampleEn = data.example?.en || "";
        const exampleZh = data.example?.zh || "";
        return {
          ...base,
          short_meaning: data.chinese_explanation || data.short_meaning || "",
          context_meaning: data.category || "",
          examples: exampleEn || exampleZh ? [{ en: exampleEn, zh: exampleZh }] : [],
          memory_tip: Array.isArray(data.related_terms) ? data.related_terms.join(", ") : "",
        };
      }

      if (isParagraphResult(data)) {
        return {
          ...base,
          translation: data.translation || "",
          grammar_notes: data.grammar_notes || "",
          key_phrases: Array.isArray(data.difficult_phrases)
            ? data.difficult_phrases.map((item) =>
                typeof item === "string" ? item : item.phrase || item.meaning || ""
              )
            : [],
          tone: data.tone || "",
          nuance: data.nuance || data.summary || "",
          short_meaning: data.summary || data.translation || "",
        };
      }

      if (isSentenceResult(data)) {
        return {
          ...base,
          translation: data.translation || "",
          grammar_notes: data.grammar_notes || "",
          key_phrases: data.key_phrases || [],
          tone: data.tone || "",
          nuance: data.nuance || "",
          short_meaning: data.translation || "",
        };
      }
      const wordItem = {
        ...base,
        phonetic: data.phonetic || "",
        part_of_speech: data.part_of_speech || "",
        short_meaning: data.short_meaning || "",
        context_meaning: data.context_meaning || "",
        examples: data.examples || [],
        memory_tip: data.memory_tip || "",
      };
      // Phase 3：保存原句与此处含义（以后的复习卡片会用到）
      if (currentLookupContext?.sentence) {
        wordItem.context_sentence = currentLookupContext.sentence;
        wordItem.sourceType = currentLookupContext.sourceType;
      }
      if (data.meaning_here) wordItem.meaning_here = data.meaning_here;
      if (data.pos_here) wordItem.pos_here = data.pos_here;
      if (data.sentence_translation) wordItem.sentence_translation = data.sentence_translation;
      // 0.11.1：派生词 / 助记类型存在词条上；同义词随原句存进语境（没有原句时存在词条上）
      if (data.memory_tip && data.memory_tip_type) wordItem.memory_tip_type = data.memory_tip_type;
      if (Array.isArray(data.derivatives) && data.derivatives.length) wordItem.derivatives = data.derivatives;
      if (Array.isArray(data.synonyms) && data.synonyms.length) wordItem.synonyms = data.synonyms;
      return wordItem;
    }

    function bindResultActions(resultRef) {
      const latest = () => resultRef.data;
      const speakBtn = panelEl.querySelector(".zeh-panel-footer .mk-btn:nth-child(1)");
      const copyBtn = panelEl.querySelector(".zeh-panel-footer .mk-btn:nth-child(3)");
      const vocabBtn = panelEl.querySelector(".zeh-panel-footer .mk-btn:nth-child(2)");

      if (speakBtn) {
        speakBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          speakText(latest().term || cachedText);
        });
      }

      if (vocabBtn) {
        vocabBtn.addEventListener("click", (e) => {
          if (isScriptedEvent(e)) return;
          e.stopPropagation();
          const originalLabel = "加入生词本";
          const showVocabResult = (label) => {
            vocabBtn.textContent = label;
            setTimeout(() => {
              vocabBtn.textContent = originalLabel;
            }, 1600);
          };
          let item;
          try {
            item = vocabPayload(latest());
          } catch (err) {
            console.warn("[Manekilex] vocab payload failed", err);
            showVocabResult("加入失败");
            return;
          }
          // 写入由 service worker 串行完成（R-06 / R-12）；后台不可达时只在按钮上提示，不替换结果面板
          safeSendMessage(
            { type: "ADD_VOCAB", item },
            (res) => {
              if (res?.added) {
                showVocabResult(`已加入 #${res.serial || ""} ✓`.trim());
              } else if (res?.contextAdded) {
                // Phase 4：同一个词在新句子里 → 追加为该词的新语境
                showVocabResult(res.contextCount ? `已添加新语境（共 ${res.contextCount} 个）✓` : "已添加新语境 ✓");
              } else if (res?.contextUpdated) {
                showVocabResult("已补全语境 ✓");
              } else if (res?.reason === "context_limit") {
                showVocabResult("语境已满");
              } else if (res?.reason === "duplicate") {
                showVocabResult("已在生词本");
              } else {
                showVocabResult("加入失败");
              }
            },
            { onTransportError: () => showVocabResult("加入失败") }
          );
        });
      }

      if (copyBtn) {
        copyBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          const originalLabel = "复制";
          navigator.clipboard
            .writeText(formatNoteText(latest()))
            .then(() => {
              copyBtn.textContent = "已复制 ✓";
              setTimeout(() => {
                copyBtn.textContent = originalLabel;
              }, 1600);
            })
            .catch(() => {
              copyBtn.textContent = "失败";
              setTimeout(() => {
                copyBtn.textContent = originalLabel;
              }, 1600);
            });
        });
      }
    }

    // ── loading / 结果渲染 ──────────────────────────────────────────────────────

    function showLoadingPanel(options) {
      const loadOpts = options || {};
      if (!globalLookupEnabled) return;
      if (explainPending && !panelEl) {
        explainPending = false;
      }
      if (explainPending) return;
      if (!isExtensionAlive()) {
        markExtensionDead();
        return;
      }
      try {
        resetContextState();
        const queryText = getPendingLookupText();
        if (!queryText) {
          console.warn("[Manekilex] lookup aborted: no pending selection text");
          showLookupToast("选中文本已失效，请重新划词。");
          return;
        }
        const validation = zehValidateLookupText(queryText);
        if (!validation.ok) {
          createPanelShell();
          showErrorPanel(validation.message);
          return;
        }
        cachedText = validation.normalized;
        pendingLookupText = cachedText;
        cachedQueryType = validation.queryType;
        currentLookupContext = buildLookupContextForQuery(
          loadOpts.contextSnapshot,
          cachedText,
          cachedQueryType
        );
        currentLookupLocation = loadOpts.contextLocation || null;

        zehDebugLog("[Manekilex] opening lookup panel", {
          text: cachedText.slice(0, 80),
          queryType: cachedQueryType,
        });

        dismissedWhileLoading = false;
        explainPending = true;
        currentQueryId = `q_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const queryId = currentQueryId;
        armLookupTimeout(queryId, cachedQueryType);

        createPanelShell();
        const titleEl = panelEl.querySelector(".zeh-panel-title");
        if (titleEl) titleEl.textContent = queryTypeLabel(cachedQueryType);
        const isLongForm =
          cachedQueryType === "sentence" ||
          cachedQueryType === "paragraph" ||
          cachedQueryType === "code_term";
        const termClass = isLongForm
          ? "zeh-term zeh-term-sentence zeh-term-loading"
          : "zeh-term zeh-term-loading";
        setPanelBody(`
        <div class="zeh-loading-wrap">
          <div class="${termClass}">${zehEscapeHtml(cachedText)}</div>
          <div class="zeh-loading">
            <div class="zeh-spinner"></div>
            <span>正在${queryTypeLabel(cachedQueryType)}…</span>
          </div>
        </div>
      `);

        const explainMessage = {
          type: "EXPLAIN",
          text: cachedText,
          queryType: cachedQueryType,
          queryId,
        };
        // 只发送选中词所在的句子（+ 短句时的前后句），不发送 URL / 标题 / 整页内容
        if (currentLookupContext) {
          explainMessage.context = {
            sentence: currentLookupContext.sentence,
            sourceType: currentLookupContext.sourceType,
          };
          if (currentLookupContext.nearbyText) {
            explainMessage.context.nearbyText = currentLookupContext.nearbyText;
          }
        }

        safeSendMessage(
          explainMessage,
          (response) => {
            // 旧查询的回调（已按 Esc 关闭或已有更新的查词）不能重新打开 / 覆盖面板
            if (!isCurrentPendingQuery(queryId)) return;
            if (response?.accepted) return;
            // 只有后台明确回复 NO_API_KEY 才引导去设置；其它拒绝（含没有 code 的）显示真实错误
            if (response?.code === "NO_API_KEY") {
              showConfigErrorPanel(response.message || "请先在设置中配置 API Key");
            } else {
              showErrorPanel(response?.message || response?.error || "查词失败，请稍后重试");
            }
          },
          {
            onTransportError: (text) => {
              if (!isCurrentPendingQuery(queryId)) return;
              showErrorPanel(text);
            },
          }
        );
        zehDebugLog("[Manekilex] EXPLAIN sent", {
          textLength: cachedText.length,
          textPreview: cachedText.slice(0, 80),
          queryType: cachedQueryType,
          contextSentence: currentLookupContext?.sentence || null,
        });
      } catch (err) {
        explainPending = false;
        clearLookupTimeout();
        if (!handleControllerError(err, "open lookup panel")) {
          safeShowErrorPanel("查词面板打开失败，请重新划词。");
        }
      }
    }

    function clearLookupTimeout() {
      clearTimeout(lookupTimeoutTimer);
      lookupTimeoutTimer = null;
    }

    function clearContextTimeout() {
      clearTimeout(contextTimeoutTimer);
      contextTimeoutTimer = null;
    }

    /** 新查词 / 关闭 / 生命周期重置：丢弃语境与等待中的增强（迟到的 CONTEXT_ENHANCED 会被忽略） */
    function resetContextState() {
      clearContextTimeout();
      contextPendingQueryId = null;
      currentResultRef = null;
      currentLookupContext = null;
      currentLookupLocation = null;
    }

    /** 语境增强的页面侧兜底：超时后收起「分析中」，基础结果保持不变 */
    function armContextTimeout(queryId, queryType) {
      clearContextTimeout();
      const timeoutMs =
        typeof zehLookupClientTimeoutMs === "function" ? zehLookupClientTimeoutMs(queryType) : 35000;
      contextTimeoutTimer = setTimeout(() => {
        contextTimeoutTimer = null;
        if (contextPendingQueryId !== queryId || currentQueryId !== queryId) return;
        contextPendingQueryId = null;
        updateContextSection("failed");
      }, timeoutMs);
    }

    function isCurrentPendingQuery(queryId) {
      return Boolean(queryId) && queryId === currentQueryId && explainPending;
    }

    /** 页面侧兜底超时：后台没有回任何终态消息时停止转圈，并忽略此查询之后的迟到消息 */
    function armLookupTimeout(queryId, queryType) {
      clearLookupTimeout();
      const timeoutMs =
        typeof zehLookupClientTimeoutMs === "function" ? zehLookupClientTimeoutMs(queryType) : 60000;
      lookupTimeoutTimer = setTimeout(() => {
        lookupTimeoutTimer = null;
        if (!isCurrentPendingQuery(queryId)) return;
        currentQueryId = null;
        safeShowErrorPanel(
          typeof zehLookupTimeoutMessage === "function"
            ? zehLookupTimeoutMessage(timeoutMs)
            : "请求超时，请稍后重试或切换模型。"
        );
      }, timeoutMs);
    }

    /** 渲染兜底：错误面板本身也不能抛出异常 */
    function safeShowErrorPanel(message) {
      try {
        showErrorPanel(message);
      } catch (err) {
        explainPending = false;
        clearLookupTimeout();
        handleControllerError(err, "render error panel");
      }
    }

    /** 结果渲染失败：显示可恢复的错误 + 原始数据，不标记扩展失效 */
    function showRenderErrorPanel(data) {
      explainPending = false;
      clearLookupTimeout();
      let raw = "";
      try {
        raw = JSON.stringify(data, null, 2) || "";
      } catch {
        raw = String(data ?? "");
      }
      if (raw.length > 2000) raw = raw.slice(0, 2000) + "…";
      try {
        if (!panelEl) createPanelShell();
        const preview = cachedText.length > 160 ? cachedText.slice(0, 160) + "…" : cachedText;
        setPanelBody(`
          <div class="zeh-result">
            <div class="zeh-term zeh-term-sentence">${zehEscapeHtml(preview)}</div>
            <div class="zeh-error">结果显示失败（模型返回格式异常），请重新查词或切换模型。</div>
            ${raw ? `<pre class="zeh-fallback">${zehEscapeHtml(raw)}</pre>` : ""}
          </div>
        `);
      } catch (err) {
        handleControllerError(err, "render fallback panel");
      }
    }

    /** 侧边栏 / 右键查词等无选区场景：直接按文本发起查词 */
    function lookupText(text) {
      if (!globalLookupEnabled) return false;
      const validation = zehValidateLookupText(String(text || ""));
      if (!validation.ok) {
        if (validation.code === "NO_ENGLISH") return false;
        explainPending = false;
        dismissedWhileLoading = false;
        currentQueryId = null;
        cachedText = validation.normalized || String(text || "").trim();
        cachedRect = { left: 0, top: 0, right: 120, bottom: 40, width: 120, height: 40 };
        cachedRange = null;
        cachedFieldEl = null;
        removePanel();
        createPanelShell();
        showErrorPanel(validation.message);
        return true;
      }
      explainPending = false;
      dismissedWhileLoading = false;
      currentQueryId = null;
      cachedText = validation.normalized;
      pendingLookupText = cachedText;
      cachedRect = { left: 0, top: 0, right: 120, bottom: 40, width: 120, height: 40 };
      cachedRange = null;
      cachedFieldEl = null;
      removePanel();
      showLoadingPanel();
      return true;
    }

    function updateLexicalSections(word) {
      if (!panelEl) return;
      ["derivatives", "synonyms", "memory"].forEach((kind) => {
        const section = panelEl.querySelector(`.zeh-${kind}-section`);
        if (!section) return;
        const inner = renderLexicalInner(kind, word);
        section.innerHTML = inner;
        section.hidden = !inner;
      });
    }

    /** 语境增强到达 / 失败：只替换「当前语境」区块，不重建面板、不动底部按钮 */
    function updateContextSection(state, meta) {
      if (!panelEl || !currentResultRef) return;
      const section = panelEl.querySelector(".zeh-context-section");
      if (!section) return;
      const word =
        typeof zehNormalizeWordResult === "function"
          ? zehNormalizeWordResult(currentResultRef.data)
          : currentResultRef.data;
      section.innerHTML = renderContextSectionInner(word, state, meta);
      section.dataset.contextState = state;
      keepPanelInViewport();
    }

    function updateExamplesSection(examples) {
      if (!panelEl) return;
      const section = panelEl.querySelector(".zeh-examples-section");
      if (!section) return;
      const inner = renderExamplesInner(examples);
      section.innerHTML = inner;
      section.hidden = !inner;
      keepPanelInViewport();
    }

    function keepPanelInViewport() {
      requestAnimationFrame(() => {
        if (panelEl) {
          positionNearRect(panelEl, cachedRect || { right: 100, bottom: 100, top: 80, left: 80 }, true);
        }
      });
    }

    /**
     * CONTEXT_ENHANCED：只更新仍在等待增强的当前查询。关闭 / 换词 / 超时之后迟到的增强一律丢弃，
     * 也绝不重新打开面板；失败时只收起「分析中」，已显示的基础结果不变。
     */
    function applyContextEnhancement(message) {
      if (!globalLookupEnabled) return;
      const queryId = message.queryId;
      if (!queryId || queryId !== currentQueryId || queryId !== contextPendingQueryId) return;
      contextPendingQueryId = null;
      clearContextTimeout();
      if (!panelEl || panelEl.dataset.queryId !== queryId) return;
      if (!currentResultRef || currentResultRef.queryId !== queryId) return;
      const term = currentResultRef.data?.term || cachedText;
      const enhancement = message.ok ? zehNormalizeContextEnhancement(message.data, term) : null;
      if (!enhancement) {
        updateContextSection("failed");
        return;
      }
      currentResultRef.data = zehMergeContextEnhancement(currentResultRef.data, enhancement);
      updateContextSection("done", {
        providerName: message.providerName,
        modelName: message.modelName,
        durationMs: message.durationMs,
      });
      if (enhancement.examples.length) updateExamplesSection(currentResultRef.data.examples);
      updateLexicalSections(currentResultRef.data);
    }

    function showResultPanel(data, fallback, durationMs, source, extra) {
      explainPending = false;
      clearLookupTimeout();
      clearContextTimeout();
      contextPendingQueryId = null;
      currentResultRef = null;
      if (typeof zehSanitizeLookupResult === "function") {
        data = zehSanitizeLookupResult(data);
      } else if (!data || typeof data !== "object") {
        data = {};
      }
      if (!panelEl) createPanelShell();

      if (fallback) {
        const raw = data.rawText || "";
        const preview = (data.term || cachedText || "").slice(0, 160);
        const friendly =
          raw.includes("没有查到解释") ||
          raw.includes("请稍后重试") ||
          raw.includes("解析失败") ||
          raw.includes("模型输出被截断");
        if (!raw.trimStart().startsWith("{") || friendly) {
          setPanelBody(`
            <div class="zeh-result">
              <div class="zeh-term zeh-term-sentence">${zehEscapeHtml(preview)}${preview.length < (data.term || cachedText || "").length ? "…" : ""}</div>
              <div class="zeh-error">${zehEscapeHtml(friendly ? raw : raw || "没有查到解释，请稍后重试或切换模型。")}</div>
              ${renderDuration(durationMs, source, extra)}
            </div>
          `);
          return;
        }
        setPanelBody(`
          <div class="zeh-result">
            <div class="zeh-term">${zehEscapeHtml(data.term || cachedText.slice(0, 120))}</div>
            <div class="zeh-error">JSON 解析失败，以下为原始返回：</div>
            <pre class="zeh-fallback">${zehEscapeHtml(raw)}</pre>
            ${renderDuration(durationMs, source, extra)}
          </div>
        `);
        return;
      }

      if (!data.queryType) data.queryType = cachedQueryType;

      if (isManekilexEggResult(data)) {
        if (panelEl) {
          panelEl.dataset.queryType = "word";
          panelEl.classList.add("mk-manekilex-panel");
          const titleEl = panelEl.querySelector(".zeh-panel-title");
          if (titleEl) titleEl.textContent = "Manekilex";
        }
        setPanelBody(renderManekilexSpecialResult(), false);
        void finalizeManekilexEasterEggPanel(panelEl);
        return;
      }

      const kind = resolveResultKind(data);
      if (panelEl) {
        panelEl.dataset.queryType = data.queryType || cachedQueryType;
        const titleEl = panelEl.querySelector(".zeh-panel-title");
        if (titleEl) titleEl.textContent = queryTypeLabel(data.queryType || cachedQueryType);
      }

      let html;
      let contextState = "none";
      if (kind === "code_term") {
        html = renderCodeTermResult(data, durationMs, source, extra);
      } else if (kind === "paragraph") {
        html = renderParagraphResult(data, durationMs, source, extra);
      } else if (kind === "sentence") {
        html = renderSentenceResult(data, durationMs, source, extra);
      } else {
        if (String(data.meaning_here || "").trim()) contextState = "done";
        else if (currentLookupContext && extra?.contextPending) contextState = "pending";
        else if (currentLookupContext) contextState = "source";
        const contextMeta =
          contextState === "done"
            ? source === "cache"
              ? { fromCache: true }
              : { providerName: extra?.providerName, modelName: extra?.modelName, durationMs }
            : null;
        html = renderWordResult(data, durationMs, source, { ...extra, contextState, contextMeta });
      }

      // 结果对象可被语境增强原地更新；按钮（生词本 / 复制）读取的是最新数据
      currentResultRef = { queryId: currentQueryId, data };
      setPanelBody(html, true);
      bindResultActions(currentResultRef);
      if (contextState === "pending" && currentQueryId) {
        contextPendingQueryId = currentQueryId;
        armContextTimeout(currentQueryId, data.queryType || cachedQueryType);
      }
    }

    function updateDictEnhancedStatus(providerName, modelName, durationMs) {
      if (!panelEl) return;
      const durationEl = panelEl.querySelector(".zeh-duration");
      if (!durationEl) return;
      const parts = [];
      const label = [providerName, modelName].filter(Boolean).join(" · ");
      if (label) parts.push(label);
      if (durationMs) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
      parts.push("AI增强已缓存");
      durationEl.textContent = parts.join(" · ");
    }

    function showConfigErrorPanel(message) {
      explainPending = false;
      clearLookupTimeout();
      if (!panelEl) createPanelShell();
      setPanelBody(`
        <div class="zeh-result">
          <div class="zeh-term">${zehEscapeHtml(cachedText)}</div>
          <div class="zeh-error">${zehEscapeHtml(message)}</div>
          <button type="button" class="mk-btn mk-btn-primary mk-btn-settings-inline">前往设置填写 API Key</button>
        </div>
      `);
      const settingsBtn = panelEl.querySelector(".mk-btn-settings-inline");
      if (settingsBtn) {
        settingsBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          openSettings();
        });
      }
    }

    function showErrorPanel(message) {
      explainPending = false;
      clearLookupTimeout();
      if (!panelEl) createPanelShell();
      const preview =
        cachedText.length > 160 ? cachedText.slice(0, 160) + "…" : cachedText;
      setPanelBody(`
        <div class="zeh-result">
          <div class="zeh-term zeh-term-sentence">${zehEscapeHtml(preview)}</div>
          <div class="zeh-error">${zehEscapeHtml(message)}</div>
        </div>
      `);
    }

    // ── 小球定位 / 点击 ─────────────────────────────────────────────────────────

    function bindTriggerEvents(el) {
      const onPointerDown = (e) => {
        if (e.pointerType === "touch") e.preventDefault();
        stopLookupPropagation(e);
        bubblePointerActive = true;
        zehDebugLog("[Manekilex] bubble pointerdown", { controllerId });
      };
      const onMouseDown = (e) => {
        stopLookupPropagation(e);
        bubblePointerActive = true;
        zehDebugLog("[Manekilex] bubble mousedown", { controllerId });
      };
      const activateTrigger = (e, reason) => {
        if (isScriptedEvent(e)) return;
        if (e) stopLookupEvent(e);
        const now = Date.now();
        if (now - triggerActivatedAt < TRIGGER_ACTIVATE_DEBOUNCE_MS) return;
        triggerActivatedAt = now;
        onTriggerClick(e, reason);
      };
      el.addEventListener("pointerdown", onPointerDown, true);
      el.addEventListener("mousedown", onMouseDown, true);
      el.addEventListener(
        "pointerup",
        (e) => {
          activateTrigger(e, "pointerup");
        },
        true
      );
      el.addEventListener(
        "click",
        (e) => {
          activateTrigger(e, "click");
        },
        true
      );
    }

    function positionTriggerAtRect(rect, releaseX, releaseY) {
      if (!triggerEl) return false;

      const MARGIN = 8;
      let left;
      let top;

      if (releaseX !== undefined && releaseY !== undefined) {
        const OX = 8;
        const OY = 8;
        left = releaseX + OX;
        top = releaseY + OY;
        if (left + HITBOX_SIZE > viewportWin.innerWidth - MARGIN) {
          left = releaseX - HITBOX_SIZE - OX;
        }
        if (top + HITBOX_SIZE > viewportWin.innerHeight - MARGIN) {
          top = releaseY - HITBOX_SIZE - OY;
        }
      } else if (rect && (rect.width > 0 || rect.height > 0)) {
        left = Math.min(rect.right + 8, viewportWin.innerWidth - HITBOX_SIZE - MARGIN);
        top = Math.min(rect.bottom + 8, viewportWin.innerHeight - HITBOX_SIZE - MARGIN);
        if (top + HITBOX_SIZE > viewportWin.innerHeight - MARGIN) {
          top = Math.max(MARGIN, rect.top - HITBOX_SIZE - 8);
        }
        if (left + HITBOX_SIZE > viewportWin.innerWidth - MARGIN) {
          left = Math.max(MARGIN, rect.left - HITBOX_SIZE - 8);
        }
      } else {
        return false;
      }

      left = Math.max(MARGIN, Math.min(left, viewportWin.innerWidth - HITBOX_SIZE - MARGIN));
      top = Math.max(MARGIN, Math.min(top, viewportWin.innerHeight - HITBOX_SIZE - MARGIN));

      triggerEl.style.left = left + "px";
      triggerEl.style.top = top + "px";
      zehDebugLog("[Manekilex] bubble shown", { left, top });
      return true;
    }

    /**
     * 显示触发小球。
     * releaseX / releaseY：松手点视口坐标（可选），优先用它定位（贴近鼠标）。
     * 没有时退回选区 rect 右下角。
     */
    function presentTrigger(info) {
      warmSpeechSynthesis();
      if (!globalLookupEnabled || destroyed) return;
      const { text, rect, releaseX, releaseY } = info || {};
      if (!text) return;

      cleanupStaleBubbles();
      claimActiveBubble();

      const prevText = cachedText || selectionCache.text;
      writeSelectionCache(info, info?.source || "web-selection-bubble");
      const isNewTrigger = !triggerEl;

      if (!triggerEl) {
        triggerEl = uiDoc.createElement("button");
        triggerEl.className = "zeh-trigger mk-lookup-bubble";
        triggerEl.type = "button";
        triggerEl.setAttribute("data-mk-lookup-ui", "");
        triggerEl.setAttribute("aria-label", "用 Manekilex 解释选中文本");
        triggerEl.title = "用 Manekilex 解释选中文本";
        triggerEl.style.cursor = "pointer";
        triggerEl.style.pointerEvents = "auto";
        bindTriggerEvents(triggerEl);
        paintThemeVars(triggerEl, currentTheme);
        getBubbleMountEl().appendChild(triggerEl);
      } else if (triggerEl.parentElement !== getBubbleMountEl()) {
        getBubbleMountEl().appendChild(triggerEl);
      }

      if (!positionTriggerAtRect(rect || cachedRect, releaseX, releaseY)) {
        removeTrigger();
        return;
      }

      triggerEl.style.display = "block";
      triggerEl.style.cursor = "pointer";
      triggerEl.style.pointerEvents = "auto";
      syncBubbleDataset(text, info?.queryType);
      armTriggerActivationDelay(isNewTrigger || prevText !== text);
    }

    function isRangeValid(range) {
      if (!range) return false;
      try {
        return range.startContainer.isConnected;
      } catch {
        return false;
      }
    }

    function updateTriggerPositionFromSelection() {
      if (!triggerEl || explainPending) return;

      if (cachedFieldEl) {
        if (!cachedFieldEl.isConnected) {
          if (shouldKeepTriggerVisible() && selectionCache.rect) {
            positionTriggerAtRect(selectionCache.rect);
            return;
          }
          removeTrigger();
          return;
        }
        try {
          const rect =
            getTextInputSelectionRect(cachedFieldEl) ||
            adaptViewportRect(cachedFieldEl.getBoundingClientRect());
          if (rect.bottom < 0 || rect.top > viewportWin.innerHeight) {
            triggerEl.style.display = "none";
            return;
          }
          triggerEl.style.display = "block";
          positionTriggerAtRect(rect);
        } catch {
          if (shouldKeepTriggerVisible() && selectionCache.rect) {
            positionTriggerAtRect(selectionCache.rect);
            return;
          }
          removeTrigger();
        }
        return;
      }

      if (!isRangeValid(cachedRange)) {
        if (shouldKeepTriggerVisible() && selectionCache.rect) {
          triggerEl.style.display = "block";
          positionTriggerAtRect(selectionCache.rect);
          return;
        }
        removeTrigger();
        return;
      }
      try {
        const rect = rangeRectAdapter(cachedRange);
        const viewportRect = resolveRangeViewportRect(cachedRange) || rect;
        if (!viewportRect || (viewportRect.width === 0 && viewportRect.height === 0)) {
          if (shouldKeepTriggerVisible() && selectionCache.rect) {
            positionTriggerAtRect(selectionCache.rect);
            return;
          }
          removeTrigger();
          return;
        }
        if (viewportRect.bottom < 0 || viewportRect.top > viewportWin.innerHeight) {
          triggerEl.style.display = "none";
          return;
        }
        triggerEl.style.display = "block";
        positionTriggerAtRect(viewportRect);
      } catch {
        if (shouldKeepTriggerVisible() && selectionCache.rect) {
          positionTriggerAtRect(selectionCache.rect);
          return;
        }
        removeTrigger();
      }
    }

    function scheduleTriggerPositionUpdate() {
      if (_scrollRafPending) return;
      _scrollRafPending = true;
      requestAnimationFrame(() => {
        _scrollRafPending = false;
        updateTriggerPositionFromSelection();
      });
    }

    function onTriggerClick(e, reason) {
      zehDebugLog("[Manekilex] bubble activate", {
        reason: reason || "unknown",
        controllerId,
        hasSelectionCache: Boolean(selectionCache?.text),
        datasetText: triggerEl?.dataset?.lookupText?.slice(0, 80),
        bubbleCount: countBubblesInUi(),
      });

      if (!globalLookupEnabled || destroyed) return;
      if (isExtensionDead() || !isExtensionAlive()) {
        markExtensionDead("bubble-click");
        return;
      }
      if (!isTriggerClickAllowed()) {
        const pending = getPendingLookupText();
        if (!triggerClickRetryTimer && triggerEl && pending) {
          const wait = Math.max(16, triggerClickableAt - Date.now());
          triggerClickRetryTimer = setTimeout(() => {
            triggerClickRetryTimer = null;
            onTriggerClick(null, "retry");
          }, wait);
        }
        return;
      }
      if (triggerClickRetryTimer) {
        clearTimeout(triggerClickRetryTimer);
        triggerClickRetryTimer = null;
      }

      const text = getPendingLookupText();
      if (!text) {
        console.warn("[Manekilex] bubble click ignored: no pending selection text", {
          controllerId,
          hasTrigger: Boolean(triggerEl),
          triggerDataset: triggerEl?.dataset ? { ...triggerEl.dataset } : null,
          bubbleCount: countBubblesInUi(),
        });
        removeTrigger();
        showLookupToast("选中文本已失效，请重新划词。");
        return;
      }

      cachedText = text;
      pendingLookupText = text;
      cachedRect = selectionCache.rect || cachedRect;
      cachedRange = selectionCache.range || cachedRange;
      cachedFieldEl = selectionCache.fieldEl || cachedFieldEl;
      if (triggerEl?.dataset?.queryType) {
        cachedQueryType = triggerEl.dataset.queryType;
      }

      zehDebugLog("[Manekilex] opening lookup panel", {
        text: text.slice(0, 80),
        queryType: cachedQueryType,
        source: "web-selection-bubble",
      });

      const contextSnapshot = selectionCache.contextSnapshot || null;
      const contextLocation = selectionCache.contextLocation || null;
      dismissedWhileLoading = false;
      explainPending = false;
      bubblePointerActive = true;
      removeTrigger();
      showLoadingPanel({ contextSnapshot, contextLocation });
    }

    // ── 消息监听 ─────────────────────────────────────────────────────────────────

    function handleRuntimeMessage(message) {
      if (!message || typeof message !== "object") return;
      try {
        if (message.type === "SHOW_RESULT") {
          if (!globalLookupEnabled) return;
          if (isStaleQueryMessage(message)) return;
          if (dismissedWhileLoading) {
            dismissedWhileLoading = false;
            explainPending = false;
            return;
          }
          if (!panelEl && cachedText) createPanelShell();
          if (message.queryType) cachedQueryType = message.queryType;
          const src = message.fromCache ? "cache" : message.fromDict ? "dictionary" : null;
          const extra = {
            providerName: message.providerName || null,
            modelName: message.modelName || null,
          };
          zehDebugLog("[ZEH lookup]", {
            normalizedText: zehNormalizeTextForCache(cachedQueryType, cachedText),
            cacheKey: zehCacheV2StorageKey(
              cachedQueryType,
              zehNormalizeTextForCache(cachedQueryType, cachedText).length,
              zehCacheTextHash(
                cachedQueryType,
                zehNormalizeTextForCache(cachedQueryType, cachedText)
              )
            ),
            hitCache: !!message.fromCache,
            hitDictionary: !!message.fromDict,
            calledOpenAI: !message.fromCache && !message.fromDict,
            source: src || "openai",
            providerName: extra.providerName,
            modelName: extra.modelName,
          });
          showResultPanel(message.data, message.fallback, message.durationMs, src, {
            ...extra,
            contextPending: Boolean(message.contextPending),
          });
        } else if (message.type === "CONTEXT_ENHANCED") {
          applyContextEnhancement(message);
        } else if (message.type === "DICT_ENHANCED") {
          if (isStaleQueryMessage(message)) return;
          updateDictEnhancedStatus(message.providerName, message.modelName, message.durationMs);
        } else if (message.type === "SHOW_ERROR") {
          if (isStaleQueryMessage(message)) return;
          if (dismissedWhileLoading) {
            dismissedWhileLoading = false;
            explainPending = false;
            return;
          }
          if (!panelEl && cachedText) createPanelShell();
          showErrorPanel(message.message);
        }
      } catch (err) {
        // 渲染异常（如模型字段格式异常）≠ 扩展上下文失效：显示可恢复的错误，后续查词照常可用
        if (handleControllerError(err, `render ${message.type}`)) return;
        if (message.type === "SHOW_RESULT") {
          showRenderErrorPanel(message.data);
        } else if (message.type === "SHOW_ERROR") {
          safeShowErrorPanel(String(message.message || "请求失败，请稍后重试"));
        }
      }
    }

    function installListeners() {
      if (!isExtensionAlive()) return;
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          try {
            if (!isExtensionAlive()) return;
            if (area === "local" && changes[ZEH_STORAGE.theme]) {
              applyTheme(changes[ZEH_STORAGE.theme].newValue);
            }
          } catch (err) {
            handleControllerError(err, "apply theme");
          }
        });
      } catch {
        markExtensionDead();
      }
      try {
        chrome.runtime.onMessage.addListener(handleRuntimeMessage);
      } catch {
        markExtensionDead();
      }
    }

    // ── 初始化 ─────────────────────────────────────────────────────────────────

    installInvalidationGuard();
    installListeners();
    loadTheme();
    setTimeout(() => warmSpeechSynthesis(), 0);

    /** 清空所有 UI 与查词状态；进行中的查询作废（迟到的结果按 queryId 丢弃） */
    function resetLookupState() {
      clearTimeout(triggerClickRetryTimer);
      triggerClickRetryTimer = null;
      clearTimeout(lookupToastTimer);
      lookupToastTimer = null;
      clearLookupTimeout();
      removePanel();
      removeTrigger();
      clearSelectionCache();
      resetContextState();
      cachedText = "";
      cachedRect = null;
      cachedRange = null;
      cachedFieldEl = null;
      pendingLookupText = "";
      bubblePointerActive = false;
      explainPending = false;
      dismissedWhileLoading = false;
      currentQueryId = null;
    }

    function destroyController() {
      if (destroyed) return;
      destroyed = true;
      activeLookupControllers.delete(controllerApi);
      resetLookupState();
    }

    /**
     * 页面生命周期（R-01）：
     * - pagehide(persisted=true)：页面进入 back/forward cache，只清空状态，不销毁控制器；
     * - pagehide(persisted=false)：真正卸载，销毁控制器；
     * - pageshow(persisted=true)：从 bfcache 恢复，复用同一个控制器（监听器仍在，不会重复注册）。
     * 不再监听 beforeunload：它可能被取消（"离开此网站？"），页面会继续存活。
     */
    function handlePageHide(event) {
      if (event?.persisted) {
        resetLookupState();
        return;
      }
      destroyController();
    }

    function handlePageShow(event) {
      if (!event?.persisted) return;
      resetLookupState();
      if (destroyed) {
        destroyed = false;
        activeLookupControllers.add(controllerApi);
      }
    }

    win.addEventListener("pagehide", handlePageHide);
    win.addEventListener("pageshow", handlePageShow);

    const controllerApi = {
      getSelectionInfo,
      getSelectionTextDeep,
      getSelectionDeep,
      captureFieldSelectionSnapshot,
      storeSelectionSnapshot,
      getPendingLookupText,
      isTextInputField: isTextInputElement,
      lookupText,
      presentTrigger,
      removeTrigger,
      removeTriggerAndClearCache,
      removePanel,
      hideAll,
      isOurElement,
      isInsideLookupUI,
      shouldKeepTriggerVisible,
      isSelectionCacheFresh,
      isBubblePointerActive: () => bubblePointerActive,
      /**
       * 刚刚点了小球（同一次点击）：小球在 pointerup 时已被移除，紧随其后的 mouseup 会落到
       * body 上。content.js 据此忽略这次 mouseup，否则词典 / 缓存秒回时刚打开的面板会被当成
       * 「新选区」关掉、小球又出现（0.11.1）。
       */
      wasTriggerJustActivated: () => Date.now() - triggerActivatedAt < TRIGGER_ACTIVATE_DEBOUNCE_MS,
      cancelBubblePointerActive: () => {
        bubblePointerActive = false;
      },
      scheduleTriggerPositionUpdate,
      updateTriggerPositionFromSelection,
      markExtensionDead,
      isExtensionAlive,
      applyTheme,
      hasTrigger: () => Boolean(triggerEl),
      hasPanel: () => Boolean(panelEl),
      isPending: () => explainPending,
      getCachedText: () => cachedText || selectionCache.text,
      isAggressiveBubbleMode: () => aggressiveBubbleMode,
      getDocumentHideDelayMs: () => (aggressiveBubbleMode ? 100 : 0),
      destroyController,
      getControllerId: () => controllerId,
    };

    activeLookupControllers.add(controllerApi);
    return controllerApi;
  }

  window.MKLookup = {
    createController,
    setGlobalEnabled: applyGlobalLookupEnabled,
    isGlobalEnabled: isGlobalLookupEnabled,
  };
})();
