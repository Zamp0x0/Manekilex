/**
 * reader.js — 全屏 EPUB 阅读器
 *
 * - 用 epub.js 以滚动模式渲染 IndexedDB 中的电子书
 * - 保存阅读进度与位置（CFI）
 * - 右键 / 工具栏添加 CFI 书签，支持列表 / 跳转 / 重命名 / 删除
 * - 复用 mk-lookup.js 的划词查词（指向 epub iframe 的选区）
 *
 * 数据安全：书籍仅来自本机 IndexedDB；仅用户选中的词/句在点击小球后发送给后台。
 */
(function () {
  const DEBUG_READER = new URLSearchParams(location.search).get("debug") === "1";
  const SHOW_DEBUG_OVERLAY = DEBUG_READER;
  const { readerLog, readerWarn, reasonLabel, posFmtProgress, posFmtRatio, posDbg, posLog, readerDebug } =
    zehCreateReaderLog({ debug: DEBUG_READER });

  const dlog = readerLog;

  const {
    clampRatio,
    getTotalSpineItems,
    calculateProgressFromSpineRatio,
    calculateProgressFromSpineAndRatio,
    derivedProgressFromRecord,
  } = zehCreateReaderProgress({ book: () => book });

  const params = new URLSearchParams(location.search);
  const bookId = params.get("id");
  const readerSessionId =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  readerLog("boot", {
    href: location.href,
    bookId,
    DEBUG_READER,
    sessionId: readerSessionId,
  });

  let debugOverlayEl = null;
  let lastFlushReason = "";
  let lastSavedAt = 0;
  let _persistSeq = 0;
  let _lastClaimAt = 0;

  const els = {
    title: document.getElementById("readerTitle"),
    progress: document.getElementById("readerProgress"),
    viewer: document.getElementById("viewer"),
    message: document.getElementById("readerMessage"),
    backBtn: document.getElementById("backBtn"),
    fontDecBtn: document.getElementById("fontDecBtn"),
    fontIncBtn: document.getElementById("fontIncBtn"),
    fontSizeLabel: document.getElementById("fontSizeLabel"),
    widthNarrowBtn: document.getElementById("widthNarrowBtn"),
    widthNormalBtn: document.getElementById("widthNormalBtn"),
    widthWideBtn: document.getElementById("widthWideBtn"),
    addBookmarkBtn: document.getElementById("addBookmarkBtn"),
    toggleBookmarksBtn: document.getElementById("toggleBookmarksBtn"),
    closeBookmarksBtn: document.getElementById("closeBookmarksBtn"),
    bookmarkPanel: document.getElementById("bookmarkPanel"),
    bookmarkList: document.getElementById("bookmarkList"),
    ctxMenu: document.getElementById("ctxMenu"),
    ctxAddBookmark: document.getElementById("ctxAddBookmark"),
    toggleThemeBtn: document.getElementById("toggleThemeBtn"),
    themePanel: document.getElementById("themePanel"),
    closeThemeBtn: document.getElementById("closeThemeBtn"),
    readerLayout: document.getElementById("readerLayout"),
    readerTocPanel: document.getElementById("readerTocPanel"),
    readerTocList: document.getElementById("readerTocList"),
    readerTocToggleBtn: document.getElementById("readerTocToggleBtn"),
    readerTocCollapseBtn: document.getElementById("readerTocCollapseBtn"),
    readerTocExpandTab: document.getElementById("readerTocExpandTab"),
  };

  // 阅读偏好（默认舒适阅读参数）
  const READER_DEFAULTS = {
    fontSize: 20,
    fontFamily: "times-kaiti",
    lineHeight: 1.75,
    contentWidth: 1360,
    widthMode: "wide",
  };
  const WIDTH_MODES = {
    narrow: 900,
    normal: 1120,
    wide: 1360,
  };
  const VIEWPORT_GUTTER = 96;
  const READER_TOC_WIDTH = 260;
  const FONT_MIN = 14;
  const FONT_MAX = 30;
  const FONT_STEP = 2;
  let readerPrefs = { ...READER_DEFAULTS };

  let book = null;
  let rendition = null;
  let bookRecord = null;
  let currentCfi = "";
  let currentChapterLabel = "";
  let locationsReady = false;
  let scrollSaveTimer = null;
  let pendingCtx = { cfi: "", excerpt: "" };
  let navMap = null;
  let tocOpen = true;
  let tocJumpSeq = 0;
  let tocJumpCompletedSeq = 0;

  const {
    READER_THEME_DEFAULTS,
    readerThemeNow,
    applyReaderTheme,
    scheduleReaderThemeReapply,
    loadReaderThemePrefs,
    setupThemePanel,
    updateThemePanelPosition,
  } = zehCreateReaderTheme({
    els,
    debug: DEBUG_READER,
    readerDebug,
    rendition: () => rendition,
    layoutBusy: () => isResizeStateFrozen() || resizeRestoreInFlight || widthModeApplyInFlight,
    applyTypography: () => applyEpubTypographyTheme(),
    bookmarkPanelOpen: () => bookmarkPanelOpen(),
  });

  const { addBookmark, onBookmarkListClick, hideBookmarkPanel, toggleBookmarkPanel, bookmarkPanelOpen } = zehCreateReaderBookmarks({
    els,
    bookId,
    chapterLabel: () => currentChapterLabel,
    toast: (text) => showToast(text),
    jumpTo: (cfi) => jumpTo(cfi),
    themePanelMoved: () => updateThemePanelPosition(),
  });

  const {
    loadBookToc,
    spineIndexForHref,
    resolveTocIndexForItem,
    setActiveTocIndex,
    highlightActiveTocBySpine,
    highlightActiveTocByHref,
    tocItemCount,
  } = zehCreateReaderToc({
    els,
    readerDebug,
    book: () => book,
    currentSpineIndex: () => currentSpineIndex,
    highlightLocked: () => isTocJumpHighlightLocked(),
    jumpToItem: (item, index) => jumpToTocItem(item, index),
  });

  // 定位 / 章节状态
  let isProgrammaticDisplay = false;
  let currentSpineIndex = 0;
  let currentChapterScrollRatio = 0;
  let isRestoringPosition = false;
  let isRestoringOpenBookPosition = false;
  let lastUserScrollAt = 0;
  let lastUserPointerScrollAt = 0;
  let scrollContainerEl = null;
  let locationsGenTimer = null;
  let _scrollLogAt = 0;
  let chapterSwitchCooldownUntil = 0;
  let wheelBoundaryAccum = 0;
  let isResizingReader = false;
  let resizeLockUntil = 0;
  let lastUserWheelAt = 0;
  let isLeavingReader = false;
  let resizeDebounceTimer = null;
  let readerResizeObserver = null;
  const ANCHOR_SAMPLE_Y = [100, 160, 220, 300];
  let resizeSnapshot = null;
  let progressFrozenUntilUserScroll = false;
  let programmaticScrollLockUntil = 0;
  let scrollPersistCooldownUntil = 0;
  let suppressResizeRestoreUntil = 0;
  let suppressPersistAndResizeUntil = 0;
  let isOpeningOrRestoring = false;
  let restoreVisualReady = true;
  let isSectionSwitching = false;
  let storedRestoreProgress = null;
  let scrollSavePending = false;
  let lastPersistedSnapshot = null;
  let lastKnownScrollMetrics = null;
  let positionCacheWriteTimer = null;
  let isReaderResizing = false;
  let resizeStateFrozenUntil = 0;
  let resizeFrozenState = null;
  let resizeRestoreInFlight = false;
  let lastTocLayoutToggleAt = 0;
  const TOC_LAYOUT_RESIZE_SUPPRESS_MS = 1200;
  let pendingResizeSource = null;
  let resizePendingAfterFlight = false;
  let resizePendingSource = null;
  let lastAppliedLayoutSize = { w: 0, h: 0 };
  const RESIZE_DEBOUNCE_MS = 240;
  let widthModeDebounceTimer = null;
  let lastWidthModeChangeAt = 0;
  const WIDTH_MODE_DEBOUNCE_MS = 200;
  let pendingWidthModeApply = false;
  let widthModeApplyInFlight = false;
  let suppressLayoutResizeUntil = 0;
  const boundWheelTargets = new WeakSet();

  function canPersistPosition(reason, options = {}) {
    if (options.force === true && reason === "back-to-shelf") return true;
    return ZEHBookStore.isSaveAllowedPersistReason(reason);
  }

  function markProgrammaticScroll(source, ms = 1200) {
    programmaticScrollLockUntil = Date.now() + ms;
    if (source) {
      posLog("programmatic scroll lock", source);
    }
  }

  /** resize/restore/section 程序化滚动后，禁止 scroll-debounce 写入 IndexedDB */
  function markScrollPersistCooldown(source, ms = 3500) {
    scrollPersistCooldownUntil = Date.now() + ms;
    if (source) {
      posLog("scroll persist cooldown", `${source} ms=${ms}`);
    }
  }

  function beginRestoreVisual(savedProgress) {
    isOpeningOrRestoring = true;
    restoreVisualReady = false;
    isSectionSwitching = false;
    storedRestoreProgress = typeof savedProgress === "number" ? savedProgress : null;
    document.body.classList.add("reader-restoring");
    if (typeof storedRestoreProgress === "number") {
      renderProgress(storedRestoreProgress);
    }
  }

  function beginSectionSwitchVisual() {
    isSectionSwitching = true;
    const metrics = readLiveScrollMetricsForPersist("section-switch-pin");
    storedRestoreProgress =
      metrics.valid && Number.isFinite(metrics.progress)
        ? metrics.progress
        : calculateProgressFromSpineAndRatio(currentSpineIndex, currentChapterScrollRatio);
    if (typeof storedRestoreProgress === "number") {
      renderProgress(storedRestoreProgress);
    }
  }

  function endSectionSwitchVisual() {
    isSectionSwitching = false;
    storedRestoreProgress = null;
  }

  function isHardRestoring() {
    return isOpeningOrRestoring || isSectionSwitching || !restoreVisualReady;
  }

  function isSoftSuppressed() {
    return Date.now() < suppressPersistAndResizeUntil;
  }

  function markRestoreVisualReady() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          restoreVisualReady = true;
          isOpeningOrRestoring = false;
          isSectionSwitching = false;
          storedRestoreProgress = null;
          document.body.classList.remove("reader-restoring");
          document.body.classList.remove("reader-section-switching");
          readerDebug("[ZEH_POS] restore visual ready; wheel enabled");
          resolve();
        });
      });
    });
  }

  function isRealUserScrollRecently() {
    return Date.now() - lastUserScrollAt < 1500;
  }

  function releaseRestoreLocksForUserScroll(source) {
    const now = Date.now();
    lastUserScrollAt = now;

    if (now < suppressPersistAndResizeUntil) {
      readerDebug("[ZEH_POS] release soft suppress by user scroll", { source });
      suppressPersistAndResizeUntil = 0;
      suppressResizeRestoreUntil = 0;
    }

    if (isReaderResizing || now < resizeStateFrozenUntil) {
      readerDebug("[ZEH_POS] release resize freeze by user scroll", { source });
      isReaderResizing = false;
      resizeStateFrozenUntil = 0;
      resizeRestoreInFlight = false;
      resizeFrozenState = null;
    }

    if (now < programmaticScrollLockUntil) {
      programmaticScrollLockUntil = now;
    }
  }

  function noteUserScrollActivity(source) {
    const now = Date.now();
    lastUserScrollAt = now;
    if (source === "wheel") {
      lastUserWheelAt = now;
    }
    if (source === "scrollbar" || source === "pointer") {
      lastUserPointerScrollAt = now;
    }
    releaseRestoreLocksForUserScroll(source);
  }

  async function ensureRestoreVisualReady() {
    if (restoreVisualReady) return;
    await markRestoreVisualReady();
  }

  function loadPositionCacheForBook(id) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([ZEH_STORAGE.readerPositionCache], (data) => {
          const map = data && data[ZEH_STORAGE.readerPositionCache];
          resolve(map && map[id] ? map[id] : null);
        });
      } catch {
        resolve(null);
      }
    });
  }

  /** 这个标签页已知被别的阅读会话接管（另一个标签页后打开或后获得焦点） */
  function isReaderSessionSuperseded() {
    const active = bookRecord && bookRecord.activeReaderSessionId;
    return Boolean(active && active !== readerSessionId);
  }

  function applyPositionCacheToBookRecord(record, cache) {
    if (!record || !cache) return record;
    // 只认当前拥有这本书的会话写的缓存；旧标签页写的缓存即使更新也不用（旧缓存没有 sessionId，照旧使用）
    const owner = record.activeReaderSessionId;
    if (cache.sessionId && owner && cache.sessionId !== owner) {
      posDbg("ignore position cache from another session", "", { cacheSession: cache.sessionId, owner });
      return record;
    }
    const recordAt = record.lastReadAt || 0;
    const cacheAt = cache.savedAt || cache.lastReadAt || 0;
    if (cacheAt <= recordAt) return record;
    posDbg("apply newer position cache on init", "", {
      recordAt,
      cacheAt,
      recordProgress: record.progress,
      cacheProgress: cache.progress,
    });
    return {
      ...record,
      currentSpineIndex: cache.currentSpineIndex,
      chapterScrollRatio: cache.chapterScrollRatio,
      progress: cache.progress,
      currentLocation: cache.currentLocation || record.currentLocation,
      totalSpineItems: cache.totalSpineItems || record.totalSpineItems,
      lastReadAt: cacheAt,
    };
  }

  function writePositionCacheNow(metrics, reason) {
    if (!bookId || !metrics) return;
    if (isReaderSessionSuperseded()) {
      posDbg("skip position cache write", "session superseded", { reason });
      return;
    }
    const totalSpineItems = metrics.totalSpineItems || getTotalSpineItems();
    const progress =
      typeof metrics.progress === "number"
        ? metrics.progress
        : calculateProgressFromSpineRatio(
            metrics.spineIndex ?? currentSpineIndex,
            metrics.chapterScrollRatio,
            totalSpineItems
          );
    const now = Date.now();
    const payload = {
      bookId,
      currentSpineIndex: metrics.spineIndex ?? currentSpineIndex,
      chapterScrollRatio: metrics.chapterScrollRatio,
      progress,
      currentLocation: currentCfi || metrics.currentLocation || "",
      totalSpineItems,
      lastReadAt: now,
      savedAt: now,
      reason: reason || "cache",
      sessionId: readerSessionId,
    };
    try {
      chrome.storage.local.get([ZEH_STORAGE.readerPositionCache], (data) => {
        const map = (data && data[ZEH_STORAGE.readerPositionCache]) || {};
        map[bookId] = payload;
        chrome.storage.local.set({ [ZEH_STORAGE.readerPositionCache]: map });
      });
    } catch {
      /* noop */
    }
  }

  function schedulePositionCacheWrite(metrics, reason) {
    if (!metrics) return;
    lastKnownScrollMetrics = { ...metrics, valid: metrics.valid !== false };
    clearTimeout(positionCacheWriteTimer);
    positionCacheWriteTimer = setTimeout(() => {
      if (lastKnownScrollMetrics) {
        writePositionCacheNow(lastKnownScrollMetrics, reason || "scroll-cache");
      }
    }, 120);
  }

  function getLeavePersistMetrics() {
    const live = readLiveScrollMetricsForPersist("leave-check");
    if (live.valid) return live;
    if (lastKnownScrollMetrics) {
      const totalSpineItems =
        lastKnownScrollMetrics.totalSpineItems || getTotalSpineItems();
      const progress =
        typeof lastKnownScrollMetrics.progress === "number"
          ? lastKnownScrollMetrics.progress
          : calculateProgressFromSpineRatio(
              lastKnownScrollMetrics.spineIndex ?? currentSpineIndex,
              lastKnownScrollMetrics.chapterScrollRatio,
              totalSpineItems
            );
      return {
        ...lastKnownScrollMetrics,
        valid: true,
        progress,
        totalSpineItems,
      };
    }
    if (
      Number.isInteger(currentSpineIndex) &&
      typeof currentChapterScrollRatio === "number"
    ) {
      const totalSpineItems = getTotalSpineItems();
      return {
        valid: true,
        spineIndex: currentSpineIndex,
        chapterScrollRatio: currentChapterScrollRatio,
        progress: calculateProgressFromSpineRatio(
          currentSpineIndex,
          currentChapterScrollRatio,
          totalSpineItems
        ),
        totalSpineItems,
      };
    }
    return null;
  }

  function userHasPendingScrollSave() {
    const lastPersistAt = lastPersistedSnapshot?.at || bookRecord?.lastReadAt || 0;
    return lastUserScrollAt > lastPersistAt + 200;
  }

  function syncLastPersistedSnapshotFromRecord(record) {
    if (!record) {
      lastPersistedSnapshot = null;
      return;
    }
    if (
      !Number.isInteger(record.currentSpineIndex) ||
      typeof record.chapterScrollRatio !== "number"
    ) {
      return;
    }
    lastPersistedSnapshot = {
      spineIndex: record.currentSpineIndex,
      chapterScrollRatio: record.chapterScrollRatio,
      progress: typeof record.progress === "number" ? record.progress : null,
      at: record.lastReadAt || Date.now(),
    };
  }

  function hasUnsavedScrollPosition() {
    if (!bookId) return false;
    if (scrollSavePending || scrollSaveTimer) return true;
    if (userHasPendingScrollSave()) return true;

    const metrics = getLeavePersistMetrics();
    if (!metrics || !metrics.valid) return false;

    const base =
      lastPersistedSnapshot ||
      (bookRecord
        ? {
            spineIndex: bookRecord.currentSpineIndex,
            chapterScrollRatio: bookRecord.chapterScrollRatio,
            progress: bookRecord.progress,
          }
        : null);

    if (!base || !Number.isInteger(base.spineIndex)) {
      return Date.now() - lastUserScrollAt < 60000;
    }

    if (metrics.spineIndex !== base.spineIndex) return true;
    if (Math.abs(metrics.chapterScrollRatio - (base.chapterScrollRatio || 0)) > 0.003) {
      return true;
    }
    if (
      typeof base.progress === "number" &&
      Math.abs(metrics.progress - base.progress) > 0.003
    ) {
      return true;
    }
    return false;
  }

  function flushPendingScrollPersist(triggerReason) {
    if (!bookId || isLeavingReader) return;
    if (isHardRestoring() || isRestoringOpenBookPosition || isRestoringPosition) return;

    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = null;
    scrollSavePending = false;
    clearTimeout(positionCacheWriteTimer);
    positionCacheWriteTimer = null;

    const metrics = getLeavePersistMetrics();
    if (!metrics || !metrics.valid) return;

    writePositionCacheNow(metrics, triggerReason);

    if (!hasUnsavedScrollPosition()) {
      posDbg("leave position cache written", triggerReason);
      return;
    }

    posDbg("flush scroll persist on leave", "", {
      triggerReason,
      progress: posFmtProgress(metrics.progress),
      ratio: posFmtRatio(metrics.chapterScrollRatio),
    });
    void persistReadingPosition("scroll-debounce", {
      flushOnLeave: true,
      metricsOverride: metrics,
    });
  }

  function isResizeStateFrozen() {
    return isReaderResizing || Date.now() < resizeStateFrozenUntil;
  }

  function getPinnedResizeScrollElement() {
    if (resizeFrozenState?.pinnedScrollEl) {
      const el = resizeFrozenState.pinnedScrollEl;
      if (el.isConnected) return el;
    }
    return getScrollContainerForMetrics() || getReaderScrollElement();
  }

  function isPlausibleResizeRestoreScrollEl(scrollEl, frozen) {
    if (!scrollEl || !frozen) return false;
    const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    if (maxScroll <= 0) return false;
    if (typeof frozen.scrollHeight === "number" && frozen.scrollHeight > 500) {
      if (scrollEl.scrollHeight < frozen.scrollHeight * 0.45) {
        return false;
      }
    }
    return true;
  }

  function beginReaderResizeFreeze(reason) {
    const reasonText = reasonLabel(reason, "window-resize");
    const scrollEl = getScrollContainerForMetrics() || getReaderScrollElement();
    let chapterScrollRatio = currentChapterScrollRatio;
    let scrollTop = scrollEl ? scrollEl.scrollTop : null;
    let scrollHeight = scrollEl ? scrollEl.scrollHeight : null;
    let maxScroll = scrollEl
      ? Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight)
      : null;

    if (scrollEl && maxScroll > 0) {
      chapterScrollRatio = clampRatio(scrollTop / maxScroll);
      currentChapterScrollRatio = chapterScrollRatio;
    }

    const progress = calculateProgressFromSpineAndRatio(currentSpineIndex, chapterScrollRatio);
    resizeFrozenState = {
      reason: reasonText,
      startedAt: Date.now(),
      spineIndex: currentSpineIndex,
      chapterScrollRatio,
      progress,
      scrollTop,
      scrollHeight,
      maxScroll,
      pinnedScrollEl: scrollEl || null,
      cfi: currentCfi || null,
    };
    isReaderResizing = true;
    resizeStateFrozenUntil = Date.now() + 3500;
    posDbg("resize freeze begin", reasonText, {
      reason: resizeFrozenState.reason,
      progress: posFmtProgress(progress),
      spineIndex: resizeFrozenState.spineIndex,
      ratio: posFmtRatio(resizeFrozenState.chapterScrollRatio),
      scrollTop: resizeFrozenState.scrollTop,
    });
  }

  function getFrozenResizeScrollTarget(scrollEl, frozen) {
    if (!scrollEl || !frozen) return null;
    const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    if (maxScroll <= 0) {
      return typeof frozen.scrollTop === "number" ? frozen.scrollTop : null;
    }
    if (typeof frozen.chapterScrollRatio === "number") {
      return Math.round(clampRatio(frozen.chapterScrollRatio) * maxScroll);
    }
    return typeof frozen.scrollTop === "number" ? frozen.scrollTop : null;
  }

  function beginResizeVisualMask() {
    document.body.classList.add("reader-resize-pending");
  }

  function endResizeVisualMask() {
    document.body.classList.remove("reader-resize-pending");
  }

  function verifyFrozenScrollPosition(scrollEl, frozen, toleranceRatio = 0.012) {
    if (!scrollEl || !frozen || typeof frozen.chapterScrollRatio !== "number") return false;
    const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    if (maxScroll <= 0) return false;
    const liveRatio = scrollEl.scrollTop / maxScroll;
    return Math.abs(liveRatio - frozen.chapterScrollRatio) <= toleranceRatio;
  }

  async function applyFrozenScrollTopWithRetry(targetScrollTop, restoreReason, scrollElOptional) {
    const target =
      typeof targetScrollTop === "number" ? targetScrollTop : resizeFrozenState?.scrollTop;
    if (typeof target !== "number" || target < 0) return false;

    for (let attempt = 0; attempt < 6; attempt++) {
      const scrollEl =
        scrollElOptional || getPinnedResizeScrollElement() || getReaderScrollElement();
      if (!scrollEl) {
        await sleep(100);
        continue;
      }
      if (!isValidScrollElForResizeRestore(scrollEl)) {
        await sleep(100);
        continue;
      }
      if (!isPlausibleResizeRestoreScrollEl(scrollEl, resizeFrozenState)) {
        await sleep(100);
        continue;
      }
      markProgrammaticScroll(`resize-restore-scrollTop-${attempt}`);
      scrollEl.scrollTop = target;
      await raf2();
      const actual = scrollEl.scrollTop;
      if (Math.abs(actual - target) <= 120) {
        posDbg("resize scrollTop restored", restoreReason || "", {
          reason: restoreReason || "",
          target,
          actual,
          attempt,
        });
        return true;
      }
      await sleep(100);
    }

    console.warn("[ZEH_POS] resize scrollTop restore incomplete", {
      reason: restoreReason || "",
      target,
      actual: getReaderScrollElement()?.scrollTop,
    });
    return false;
  }

  function scheduleResizeScrollEnforcement(targetScrollTop, frozen) {
    if (typeof targetScrollTop !== "number") return;
    [150, 400, 800, 1500, 2500].forEach((delay) => {
      setTimeout(() => {
        const scrollEl = frozen?.pinnedScrollEl?.isConnected
          ? frozen.pinnedScrollEl
          : getScrollContainerForMetrics() || getReaderScrollElement();
        if (!scrollEl || !isValidScrollElForResizeRestore(scrollEl)) return;
        if (!isPlausibleResizeRestoreScrollEl(scrollEl, frozen)) return;
        const expected =
          frozen && typeof frozen.chapterScrollRatio === "number"
            ? getFrozenResizeScrollTarget(scrollEl, frozen)
            : targetScrollTop;
        const goal = typeof expected === "number" ? expected : targetScrollTop;
        if (Math.abs(scrollEl.scrollTop - goal) <= 80) return;
        markProgrammaticScroll("resize-late-enforce", 2000);
        scrollEl.scrollTop = goal;
        posDbg("resize late scrollTop enforce", "", {
          target: goal,
          actual: scrollEl.scrollTop,
          delay,
        });
        if (frozen && typeof frozen.progress === "number") {
          renderProgress(frozen.progress);
        }
      }, delay);
    });
  }

  async function revealAfterResizeRestore(reason, verified) {
    await raf2();
    const frozen = resizeFrozenState;
    const scrollEl = getPinnedResizeScrollElement();
    if (scrollEl && frozen && !verified) {
      const target = getFrozenResizeScrollTarget(scrollEl, frozen);
      if (typeof target === "number") {
        markProgrammaticScroll("resize-reveal-scrollTop", 1800);
        scrollEl.scrollTop = target;
        await raf2();
      }
    }
    if (scrollEl && frozen && !verifyFrozenScrollPosition(scrollEl, frozen)) {
      const target = getFrozenResizeScrollTarget(scrollEl, frozen);
      if (typeof target === "number") {
        await applyFrozenScrollTopWithRetry(target, reason || "resize-reveal", scrollEl);
      }
    }
    endResizeVisualMask();
  }

  function endReaderResizeFreeze(reason, options = {}) {
    const scrollEl = getPinnedResizeScrollElement();
    const frozen = resizeFrozenState;
    const visualTarget =
      scrollEl && frozen ? getFrozenResizeScrollTarget(scrollEl, frozen) : frozen?.scrollTop;

    if (frozen && scrollEl && typeof visualTarget === "number") {
      markProgrammaticScroll("resize-freeze-restore-scrollTop", 2800);
      scrollEl.scrollTop = visualTarget;
    }

    if (frozen) {
      currentSpineIndex = frozen.spineIndex;
      currentChapterScrollRatio = frozen.chapterScrollRatio;
    }

    const frozenProgress =
      frozen?.progress ??
      calculateProgressFromSpineAndRatio(currentSpineIndex, currentChapterScrollRatio);
    updateProgressUI(frozenProgress, "resize-freeze-restore");

    const verified = verifyFrozenScrollPosition(scrollEl, frozen);
    posDbg("resize freeze end", reason || frozen?.reason || "", {
      reason: reason || frozen?.reason || "",
      progress: posFmtProgress(frozenProgress),
      spineIndex: currentSpineIndex,
      ratio: posFmtRatio(currentChapterScrollRatio),
      scrollTop: scrollEl?.scrollTop,
      targetScrollTop: visualTarget,
      verified,
    });

    markScrollPersistCooldown("resize-end", 4500);
    markProgrammaticScroll("resize-complete", 2800);
    if (typeof visualTarget === "number" && !verified) {
      scheduleResizeScrollEnforcement(visualTarget, frozen);
    }

    resizeStateFrozenUntil = Date.now() + 2500;
    resizeRestoreInFlight = false;
    void revealAfterResizeRestore(reason, verified).finally(() => {
      setTimeout(() => {
        isReaderResizing = false;
        resizeFrozenState = null;
        if (resizePendingAfterFlight) {
          resizePendingAfterFlight = false;
          const queuedSource = resizePendingSource || "resize-queued";
          resizePendingSource = null;
          scheduleReaderResize(queuedSource);
        }
        if (pendingWidthModeApply) {
          void flushPendingWidthModeLayout();
        }
      }, 2200);
    });
  }

  function syncLiveProgressUI(metricsOrSource, reasonOptional) {
    if (isSectionSwitching) return;

    let metrics;
    let source;
    if (typeof metricsOrSource === "string") {
      source = metricsOrSource;
      metrics = readLiveScrollMetricsForPersist(source);
    } else {
      metrics = metricsOrSource;
      source = reasonOptional || "scroll-live";
    }
    if (!metrics || metrics.valid === false || !Number.isFinite(metrics.progress)) {
      return;
    }

    if (Number.isInteger(metrics.spineIndex)) {
      currentSpineIndex = metrics.spineIndex;
    }
    currentChapterScrollRatio = metrics.chapterScrollRatio;
    updateProgressUI(metrics.progress, source || "scroll-live");
  }

  async function waitForResizeRestoreMetrics(deadlineMs = 3200) {
    const frozen = resizeFrozenState;
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      await waitForRenditionStable("resize-restore");
      const scrollEl = getPinnedResizeScrollElement();
      if (!scrollEl) {
        await sleep(80);
        continue;
      }
      if (!isPlausibleResizeRestoreScrollEl(scrollEl, frozen)) {
        await sleep(80);
        continue;
      }
      const metrics = readLiveScrollMetricsForPersist("resize-check", { scrollEl });
      if (metrics.valid && metrics.maxScroll > 0) {
        return { scrollEl, metrics };
      }
      await sleep(80);
    }
    const scrollEl = getPinnedResizeScrollElement();
    const metrics = scrollEl
      ? readLiveScrollMetricsForPersist("resize-check", { scrollEl })
      : { valid: false, maxScroll: 0 };
    return { scrollEl, metrics };
  }

  async function completeResizeVisualRestore(beforeScrollTop, beforeSpine, anchorBefore, reason) {
    const frozen = resizeFrozenState;

    const { scrollEl, metrics } = await waitForResizeRestoreMetrics();
    if (!scrollEl) {
      endReaderResizeFreeze("no-scroll-el");
      return;
    }

    if (currentSpineIndex !== beforeSpine) {
      setCurrentSpineIndex(beforeSpine, "resize-keep-spine");
    }

    if (!metrics.valid || metrics.maxScroll <= 0) {
      posDbg("skip resize restore invalid metrics", "freeze state only", {
        frozen,
        metrics,
      });
      endReaderResizeFreeze("invalid-metrics");
      return;
    }

    const visualTarget = getFrozenResizeScrollTarget(scrollEl, frozen);
    let anchorApplied = false;

    if (anchorBefore) {
      const hasAnchorText =
        normalizeAnchorText(anchorBefore.prefix).length >= 8 ||
        normalizeAnchorText(anchorBefore.text).length >= 12;
      if (hasAnchorText && applyTextAnchorScroll(anchorBefore, { visualOnly: true, scrollEl })) {
        if (verifyFrozenScrollPosition(scrollEl, frozen)) {
          readerDebug("[ZEH_POS] resize text anchor restored");
          anchorApplied = true;
        } else {
          posDbg("resize text anchor rejected", "ratio drift after anchor", {
            frozenRatio: frozen?.chapterScrollRatio,
            liveScrollTop: scrollEl.scrollTop,
            maxScroll: metrics.maxScroll,
          });
        }
      }
    }

    if (!anchorApplied && typeof visualTarget === "number") {
      posDbg("resize restore frozen scroll target", reason || "", {
        visualTarget,
        beforeScrollTop,
        frozenRatio: frozen?.chapterScrollRatio,
        maxScroll: metrics.maxScroll,
      });
      await applyFrozenScrollTopWithRetry(visualTarget, reason || "frozen-visual-target", scrollEl);
    }

    endReaderResizeFreeze(reason || (anchorApplied ? "text-anchor" : "frozen-target"));
  }

  async function handleResizeVisualRestore(beforeScrollTop, beforeSpine, anchorBefore, reason) {
    if (isHardRestoring()) {
      posDbg("skip resize restore", "during hard restore");
      endReaderResizeFreeze("hard-restore-abort");
      return;
    }
    try {
      await completeResizeVisualRestore(beforeScrollTop, beforeSpine, anchorBefore, reason);
    } catch (err) {
      console.warn("[ZEH_POS] resize restore error", err);
      const scrollEl = getPinnedResizeScrollElement();
      await applyFrozenScrollTopWithRetry(beforeScrollTop, "resize-error", scrollEl);
      endReaderResizeFreeze("resize-error");
    }
  }

  function getScrollElResizeMetrics(scrollEl) {
    if (!scrollEl) return null;
    const clientHeight = scrollEl.clientHeight || 0;
    const scrollHeight = scrollEl.scrollHeight || 0;
    const maxScroll = scrollHeight - clientHeight;
    return {
      scrollEl,
      clientHeight,
      scrollHeight,
      maxScroll,
      scrollTop: scrollEl.scrollTop || 0,
    };
  }

  function isValidScrollElForResizeRestore(scrollEl) {
    const m = getScrollElResizeMetrics(scrollEl);
    if (!m) return false;
    return m.clientHeight > 0 && m.scrollHeight > m.clientHeight && m.maxScroll > 0;
  }

  function warnSkipResizeRestoreInvalidMetrics(scrollEl, context) {
    const m = scrollEl ? getScrollElResizeMetrics(scrollEl) : null;
    posDbg("skip resize restore invalid metrics", context || "", {
      context: context || "",
      scrollTop: m ? m.scrollTop : scrollEl?.scrollTop,
      scrollHeight: m ? m.scrollHeight : scrollEl?.scrollHeight,
      clientHeight: m ? m.clientHeight : scrollEl?.clientHeight,
      maxScroll: m ? m.maxScroll : null,
    });
  }

  function scheduleOpenRestoreSettle() {
    const until = Date.now() + 2500;
    if (until <= suppressPersistAndResizeUntil) {
      return;
    }
    suppressResizeRestoreUntil = until;
    suppressPersistAndResizeUntil = until;
    posDbg("suppress resize restore after open restore", `until=${until}`);
  }

  function canTriggerScrollDebouncePersist() {
    const now = Date.now();
    const pendingUserSave = userHasPendingScrollSave();

    if (isHardRestoring() || isResizeStateFrozen()) {
      posDbg("skip scroll persist", "during restore/soft suppress");
      return false;
    }
    if (isSoftSuppressed() && !pendingUserSave) {
      posDbg("skip scroll persist", "during restore/soft suppress");
      return false;
    }
    if (now < scrollPersistCooldownUntil && !pendingUserSave) {
      posDbg("skip scroll persist", "during post-resize cooldown");
      return false;
    }
    if (now < programmaticScrollLockUntil && !pendingUserSave) {
      posDbg("skip scroll persist", "during programmatic scroll");
      return false;
    }
    if (isProgressStateFrozen()) {
      return false;
    }
    if (now - lastUserScrollAt > 1500) {
      posDbg("skip scroll persist", "no recent user scroll");
      return false;
    }
    if (!hasRecentUserScrollForProgress()) {
      posDbg("skip scroll persist", "no recent user scroll");
      return false;
    }
    return true;
  }

  function isProgressStateFrozen() {
    if (isRestoringOpenBookPosition) return false;
    return isResizeLocked() || progressFrozenUntilUserScroll;
  }

  function noteUserInitiatedScroll(reason) {
    if (!progressFrozenUntilUserScroll && !isResizeLocked()) return;
    if (isResizeLocked()) return;
    progressFrozenUntilUserScroll = false;
    resizeSnapshot = null;
    const metrics = readLiveScrollMetricsForPersist(reason || "user-scroll");
    if (metrics.valid) {
      currentChapterScrollRatio = metrics.chapterScrollRatio;
      renderProgress(metrics.progress);
    }
    updateDebugOverlay();
  }

  function renderProgress(progress) {
    els.progress.textContent = zehFormatProgressPct(progress);
  }

  function isResizeLocked() {
    return isResizingReader || Date.now() < resizeLockUntil;
  }

  function hasRecentUserScrollForProgress() {
    const now = Date.now();
    return (
      now - lastUserWheelAt < 1200 ||
      now - lastUserPointerScrollAt < 1200 ||
      now - lastUserScrollAt < 1200
    );
  }

  function hasRecentUserWheel() {
    return Date.now() - lastUserWheelAt < 300;
  }

  function canSwitchSection(direction, reason) {
    if (isHardRestoring() || isSoftSuppressed()) {
      posDbg("block section switch", "during restore");
      return false;
    }
    if (isResizeLocked()) {
      readerLog("skip section switch during resize", { direction, reason });
      return false;
    }
    const recentWheel = hasRecentUserWheel();
    if (!recentWheel) {
      return false;
    }
    readerLog("section switch allowed", { direction, reason, recentWheel });
    return true;
  }

  const CHAPTER_EDGE_THRESHOLD = 24;
  const CHAPTER_SWITCH_COOLDOWN_MS = 600;
  const BOUNDARY_WHEEL_DELTA = 72;

  const DISPLAY_REASONS = new Set([
    "open-book-start",
    "open-book-restore-spine-ratio",
    "open-book-restore-section",
    "open-book-restore-cfi",
    "continue-reading",
    "bookmark-jump",
    "toc-jump",
    "font-size-change",
    "section-prev",
    "section-next",
  ]);

  // 查词控制器：UI 挂在阅读器顶层文档，选区来自 epub iframe
  const lookup = window.MKLookup.createController({
    win: window,
    doc: document,
    mountEl: document.documentElement,
    vocabContext: () => ({
      pageUrl: location.href,
      pageTitle: bookRecord ? bookRecord.title : "",
      book: bookRecord
        ? { id: String(bookRecord.id || bookId || ""), title: bookRecord.title || "", author: bookRecord.author || "" }
        : null,
    }),
  });

  const { onIframeMouseDown, onIframeMouseUp, onIframeContextMenu, hideCtxMenu } = zehCreateReaderSelection({
    lookup,
    position: () => ({ cfi: currentCfi, chapterLabel: currentChapterLabel, spineIndex: currentSpineIndex }),
    ctxMenu: () => els.ctxMenu,
    setContextTarget: (target) => {
      pendingCtx = target;
    },
  });

  // Manekilex 总开关（弹窗右上角）：关闭时阅读器内也不查词
  zehSubscribeEnabled((enabled) => {
    window.MKLookup?.setGlobalEnabled?.(enabled);
  });

  function showMessage(text) {
    if (!els.message) return;
    els.message.textContent = text;
    els.message.hidden = false;
  }

  function hideMessage() {
    if (els.message) els.message.hidden = true;
  }

  function logLoadedPersistedPosition(record, phase) {
    if (!record) return;
    readerLog("loaded stored position", positionLogFields(record, phase || "init"));
  }

  /**
   * 从 IndexedDB 重读书籍记录。阅读位置以「更新的那一份」为准：
   * init 时叠加过的 chrome.storage 位置缓存，以及内存里更新的位置，不能被较旧的库记录冲掉（R-24）。
   */
  async function refreshBookRecordFromStore(phase) {
    if (!bookId) return null;
    try {
      const fresh = await ZEHBookStore.getBook(bookId);
      if (fresh) {
        let next = fresh;
        const positionCache = await loadPositionCacheForBook(bookId);
        if (positionCache) {
          next = applyPositionCacheToBookRecord(next, positionCache);
        }
        if (bookRecord && (bookRecord.lastReadAt || 0) > (next.lastReadAt || 0)) {
          next = {
            ...next,
            currentSpineIndex: bookRecord.currentSpineIndex,
            chapterScrollRatio: bookRecord.chapterScrollRatio,
            progress: bookRecord.progress,
            currentLocation: bookRecord.currentLocation || next.currentLocation,
            totalSpineItems: bookRecord.totalSpineItems || next.totalSpineItems,
            lastReadAt: bookRecord.lastReadAt,
          };
        }
        bookRecord = next;
        logLoadedPersistedPosition(next, phase);
        return next;
      }
      return fresh;
    } catch {
      return null;
    }
  }

  function ensureDebugOverlay() {
    if (!SHOW_DEBUG_OVERLAY || debugOverlayEl) return;
    debugOverlayEl = document.createElement("div");
    debugOverlayEl.className = "reader-debug-overlay";
    debugOverlayEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(debugOverlayEl);
    updateDebugOverlay();
  }

  function updateDebugOverlay() {
    if (!SHOW_DEBUG_OVERLAY) return;
    ensureDebugOverlay();
    if (!debugOverlayEl) return;
    const { scrollTop } = readLiveScrollMetrics();
    const progress =
      progressFrozenUntilUserScroll && resizeSnapshot
        ? resizeSnapshot.progress
        : calculateProgressFromSpineAndRatio(currentSpineIndex, currentChapterScrollRatio);
    debugOverlayEl.textContent = [
      `book:${bookId || "?"}`,
      `sess:…${String(readerSessionId).slice(-6)}`,
      `spine:${progressFrozenUntilUserScroll && resizeSnapshot ? resizeSnapshot.spineIndex : currentSpineIndex}`,
      `ratio:${(progressFrozenUntilUserScroll && resizeSnapshot ? resizeSnapshot.chapterScrollRatio : currentChapterScrollRatio || 0).toFixed(3)}`,
      `prog:${zehFormatProgressPct(progress)}${progressFrozenUntilUserScroll ? " (frozen)" : ""}`,
      `scrollTop:${Math.round(scrollTop)}`,
      `flush:${lastFlushReason || "-"}`,
      `saved:${lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString() : "-"}`,
    ].join(" | ");
  }

  // ── 启动 ─────────────────────────────────────────────────────────────────────

  async function init() {
    ensureDebugOverlay();
    if (!bookId) {
      showMessage("缺少书籍参数，请从书架重新打开。");
      return;
    }
    try {
      bookRecord = await ZEHBookStore.getBook(bookId);
      const positionCache = await loadPositionCacheForBook(bookId);
      if (positionCache) {
        bookRecord = applyPositionCacheToBookRecord(bookRecord, positionCache);
      }
    } catch {
      showMessage("无法读取本地书库。");
      return;
    }
    if (!bookRecord) {
      showMessage("找不到这本书，可能已被删除。");
      return;
    }

    logLoadedPersistedPosition(bookRecord, "init");
    syncLastPersistedSnapshotFromRecord(bookRecord);

    readerDebug("[ZEH_POS] init start bookId=" + (bookId || "?"));
    await debugStoredBook("init-start-before-restore");
    debugPositionSnapshot("init-start-before-restore");

    els.title.textContent = bookRecord.title || "未命名书籍";
    document.title = `${bookRecord.title || "阅读"} · Manekilex Reader`;

    if (typeof bookRecord.currentSpineIndex === "number") {
      currentSpineIndex = bookRecord.currentSpineIndex;
    }
    const initDerived = derivedProgressFromRecord(bookRecord, bookRecord.totalSpineItems);
    if (typeof initDerived === "number") {
      renderProgress(initDerived);
    } else if (typeof bookRecord.progress === "number") {
      renderProgress(bookRecord.progress);
    }

    await loadReaderPrefs();
    await loadReaderThemePrefs();
    loadTocOpenPref();
    updateFontSizeUI();
    updateWidthModeUI();
    setupThemePanel();
    setupTocPanel();
    applyReaderLayout();
    hideBookmarkPanel();

    try {
      const buf = await bookRecord.fileBlob.arrayBuffer();
      await openBook(buf);
    } catch (err) {
      showMessage("打开 EPUB 失败：" + ((err && err.message) || "文件损坏"));
    }
  }

  // ── 阅读偏好 ──────────────────────────────────────────────────────────────────

  async function claimReaderSession(reason) {
    if (!bookId) return;
    const now = Date.now();
    if (now - _lastClaimAt < 300 && reason === "visibility-visible") return;
    _lastClaimAt = now;
    try {
      const updated = await ZEHBookStore.claimActiveReaderSession(bookId, readerSessionId);
      if (updated && bookRecord) {
        bookRecord.activeReaderSessionId = readerSessionId;
      }
      readerLog("claim active session", { reason, readerSessionId });
    } catch (err) {
      readerWarn("claim active session failed", { reason, err });
    }
  }

  function loadReaderPrefs() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([ZEH_STORAGE.readerPrefs], (data) => {
          const saved = (data && data[ZEH_STORAGE.readerPrefs]) || {};
          readerPrefs = { ...READER_DEFAULTS, ...saved };
          normalizeReaderPrefs();
          resolve();
        });
      } catch {
        readerPrefs = { ...READER_DEFAULTS };
        normalizeReaderPrefs();
        resolve();
      }
    });
  }

  function normalizeReaderPrefs() {
    readerPrefs.fontSize = clampFontSize(readerPrefs.fontSize);
    const mode = readerPrefs.widthMode;
    if (mode && WIDTH_MODES[mode]) {
      readerPrefs.contentWidth = WIDTH_MODES[mode];
      return;
    }
    const w = Number(readerPrefs.contentWidth) || READER_DEFAULTS.contentWidth;
    if (w <= WIDTH_MODES.narrow + 80) readerPrefs.widthMode = "narrow";
    else if (w <= WIDTH_MODES.normal + 80) readerPrefs.widthMode = "normal";
    else readerPrefs.widthMode = "wide";
    readerPrefs.contentWidth = WIDTH_MODES[readerPrefs.widthMode];
  }

  function getReaderMainAvailableWidth() {
    const main = els.viewer?.closest(".reader-main") || document.querySelector(".reader-main");
    if (main && main.clientWidth > 0) {
      return main.clientWidth;
    }
    const tocWidth = tocOpen ? READER_TOC_WIDTH : 0;
    return Math.max(320, window.innerWidth - VIEWPORT_GUTTER - tocWidth);
  }

  function getEffectiveReaderWidth() {
    const preferred = readerPrefs.contentWidth || WIDTH_MODES.wide;
    return Math.min(preferred, getReaderMainAvailableWidth());
  }

  function syncChapterScrollRatioFromLiveScroll() {
    const scrollEl = getScrollContainerForMetrics() || getReaderScrollElement();
    if (!scrollEl) return;
    const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    if (maxScroll > 0) {
      currentChapterScrollRatio = scrollEl.scrollTop / maxScroll;
    }
  }

  function saveReaderPrefs() {
    try {
      chrome.storage.local.set({
        [ZEH_STORAGE.readerPrefs]: { ...readerPrefs, tocOpen },
      });
    } catch {
      /* noop */
    }
  }

  // ── 目录 TOC ──────────────────────────────────────────────────────────────────

  function loadTocOpenPref() {
    tocOpen = readerPrefs.tocOpen !== false;
    applyTocOpenState(false);
  }

  async function setTocOpen(nextOpen) {
    tocOpen = nextOpen !== false;
    readerPrefs.tocOpen = tocOpen;
    applyTocOpenState(true);
    saveReaderPrefs();
  }

  const VIEWPORT_RESIZE_SOURCES = new Set(["window-resize", "ResizeObserver"]);

  function shouldUseCssOnlyViewportLayout(resizeReason) {
    return VIEWPORT_RESIZE_SOURCES.has(resizeReason);
  }

  function shouldUseCssOnlyLayout(resizeReason) {
    return shouldUseCssOnlyViewportLayout(resizeReason);
  }

  async function restoreScrollRatioAfterCssLayout(ratio, reason, options = {}) {
    if (options.stable) {
      await waitForRenditionStable(reason || "css-layout");
    } else {
      await raf2();
      if (options.waitMs !== 0) {
        await sleep(typeof options.waitMs === "number" ? options.waitMs : 80);
      }
    }
    const scrollEl = getScrollContainerForMetrics() || getReaderScrollElement();
    if (!scrollEl || !scrollEl.isConnected) return;
    const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
    if (maxScroll <= 0) return;
    const target = Math.round(clampRatio(ratio) * maxScroll);
    markProgrammaticScroll(`${reason || "css-layout"}-ratio`, 1000);
    scrollEl.scrollTop = target;
    currentChapterScrollRatio = scrollEl.scrollTop / maxScroll;
    updateProgressUI(
      calculateProgressFromSpineAndRatio(currentSpineIndex, currentChapterScrollRatio),
      reason || "width-mode"
    );
    if (options.reapplyTheme !== false) {
      scheduleReaderThemeReapply();
    }
  }

  function measureViewerLayoutSize() {
    if (!els.viewer) return null;
    void els.viewer.offsetWidth;
    const w = els.viewer.clientWidth;
    const h = els.viewer.clientHeight;
    if (w < 100 || h < 100) return null;
    return { w, h };
  }

  function reflowEpubToViewerSize() {
    if (!rendition || !els.viewer) return null;
    const size = measureViewerLayoutSize();
    if (!size) return null;
    resetEpubContainerInlineWidth();
    rendition.resize(size.w, size.h);
    applyEpubTypographyTheme();
    lastAppliedLayoutSize = { w: size.w, h: size.h };
    return size;
  }

  /** 宽度模式：清除 stale inline 宽度并检测是否需要 epub resize */
  function prepareWidthModeReflow() {
    if (!rendition || !els.viewer) return null;
    resetEpubContainerInlineWidth();
    void els.viewer.offsetWidth;
    const size = measureViewerLayoutSize();
    if (!size) return null;
    const container = rendition.manager?.container;
    const containerW = container?.clientWidth || 0;
    const needsEpubResize = Math.abs(containerW - size.w) > 4;
    return { ...size, needsEpubResize };
  }

  function applyWidthModeTypography() {
    applyEpubTypographyTheme();
    const size = measureViewerLayoutSize();
    if (size) {
      lastAppliedLayoutSize = { w: size.w, h: size.h };
    }
  }

  async function applyCssOnlyLayoutReflow(resizeReason) {
    if (!rendition || !els.viewer || widthModeApplyInFlight) return;

    const size = measureViewerLayoutSize();
    if (!size) return;

    const dw = Math.abs(size.w - lastAppliedLayoutSize.w);
    const dh = Math.abs(size.h - lastAppliedLayoutSize.h);
    if (dw < 2 && dh < 2) return;

    syncChapterScrollRatioFromLiveScroll();
    const ratio = currentChapterScrollRatio;
    const spine = currentSpineIndex;

    reflowEpubToViewerSize();
    await restoreScrollRatioAfterCssLayout(ratio, resizeReason);
    setCurrentSpineIndex(spine, reasonLabel(resizeReason, "css-layout"));
    readerLog("css-only reflow", {
      reason: resizeReason,
      w: size.w,
      h: size.h,
      dw,
      dh,
    });
  }

  function applyImmediateFrozenScrollRestore() {
    const scrollEl = getPinnedResizeScrollElement();
    const frozen = resizeFrozenState;
    if (!scrollEl || !frozen) return;
    const target = getFrozenResizeScrollTarget(scrollEl, frozen);
    if (typeof target !== "number") return;
    markProgrammaticScroll("resize-immediate-scrollTop", 1800);
    scrollEl.scrollTop = target;
  }

  function shouldSkipResizeForTocToggle(resizeReason) {
    if (Date.now() - lastTocLayoutToggleAt >= TOC_LAYOUT_RESIZE_SUPPRESS_MS) return false;
    return resizeReason !== "width-mode" && resizeReason !== "window-resize";
  }

  function applyTocOpenState(refreshLayout) {
    if (refreshLayout) {
      syncChapterScrollRatioFromLiveScroll();
      lastTocLayoutToggleAt = Date.now();
    }
    if (els.readerLayout) {
      els.readerLayout.classList.toggle("toc-collapsed", !tocOpen);
    }
    if (els.readerTocToggleBtn) {
      els.readerTocToggleBtn.textContent = tocOpen ? "目录" : "展开目录";
    }
    if (els.readerTocExpandTab) {
      els.readerTocExpandTab.hidden = tocOpen;
    }
    const w = getEffectiveReaderWidth();
    document.documentElement.style.setProperty("--reader-content-width", `${w}px`);
  }

  function setupTocPanel() {
    if (els.readerTocToggleBtn) {
      els.readerTocToggleBtn.addEventListener("click", (e) => {
        e.preventDefault();
        void setTocOpen(!tocOpen);
      });
    }
    if (els.readerTocCollapseBtn) {
      els.readerTocCollapseBtn.addEventListener("click", (e) => {
        e.preventDefault();
        void setTocOpen(false);
      });
    }
    if (els.readerTocExpandTab) {
      els.readerTocExpandTab.addEventListener("click", (e) => {
        e.preventDefault();
        void setTocOpen(true);
      });
    }
  }

  function isTocJumpHighlightLocked() {
    return tocJumpSeq > tocJumpCompletedSeq;
  }

  function isActiveTocJump(seq) {
    return seq === tocJumpSeq;
  }

  async function jumpToTocItem(item, tocIndex) {
    if (!item || !item.href || !rendition) return;

    const seq = ++tocJumpSeq;
    const targetTocIndex = resolveTocIndexForItem(item, tocIndex);

    readerDebug("[ReaderTOC] jump", { label: item.label, seq, targetTocIndex });

    ensureTocJumpVisualReady();
    markProgrammaticScroll("toc-jump");
    releaseRestoreLocksForUserScroll("toc-jump");

    const spineIndex =
      typeof item.spineIndex === "number" ? item.spineIndex : spineIndexForHref(item.href);

    if (targetTocIndex >= 0) {
      setActiveTocIndex(targetTocIndex);
    }
    setCurrentSpineIndex(spineIndex, "toc-jump");
    currentChapterScrollRatio = 0;
    updateProgressUI(calculateProgressFromSpineAndRatio(spineIndex, 0), "toc-jump");

    try {
      await safeDisplay(item.href, "toc-jump");
      if (!isActiveTocJump(seq)) return;

      const ready = await waitForTocJumpReady(seq);
      if (!ready || !isActiveTocJump(seq)) return;

      const scroller = getReaderScrollElement();
      if (scroller) {
        markProgrammaticScroll("toc-jump-scrollTop", 800);
        scroller.scrollTop = 0;
      }

      currentChapterScrollRatio = 0;

      const metrics = readLiveScrollMetricsForPersist("toc-jump");
      if (metrics && metrics.valid !== false && Number.isFinite(metrics.progress)) {
        syncLiveProgressUI(metrics, "toc-jump");
      }

      if (!isActiveTocJump(seq)) return;

      if (targetTocIndex >= 0) {
        setActiveTocIndex(targetTocIndex);
      }
      void persistReadingPosition("toc-jump");
    } finally {
      if (isActiveTocJump(seq)) {
        tocJumpCompletedSeq = seq;
      }
    }
  }

  function clampFontSize(size) {
    const n = Number(size) || READER_DEFAULTS.fontSize;
    return Math.max(FONT_MIN, Math.min(FONT_MAX, Math.round(n)));
  }

  function updateFontSizeUI() {
    if (els.fontSizeLabel) els.fontSizeLabel.textContent = `${readerPrefs.fontSize}px`;
  }

  function updateWidthModeUI() {
    const mode = readerPrefs.widthMode || "wide";
    for (const btn of [els.widthNarrowBtn, els.widthNormalBtn, els.widthWideBtn]) {
      if (!btn) continue;
      btn.classList.toggle("is-active", btn.dataset.mode === mode);
    }
  }

  function applyReaderLayout(options = {}) {
    const w = getEffectiveReaderWidth();
    document.documentElement.style.setProperty("--reader-content-width", `${w}px`);
    document.documentElement.style.setProperty("--reader-viewport-gutter", `${VIEWPORT_GUTTER}px`);

    const keepPosition = options.reason === "resize";
    const resizeReason = reasonLabel(
      options.resizeReason || options.reason,
      "layout"
    );

    if (shouldSkipResizeForTocToggle(resizeReason)) {
      return;
    }

    if (keepPosition && rendition && (isRestoringOpenBookPosition || isRestoringPosition)) {
      posDbg("skip layout resize", "during position restore");
      return;
    }

    if (keepPosition && rendition) {
      if (isHardRestoring()) {
        posDbg("skip resize restore", "during hard restore");
        return;
      }
      if (Date.now() < suppressResizeRestoreUntil) {
        posDbg("skip resize restore", "after open restore");
        return;
      }

      if (resizeRestoreInFlight || isReaderResizing) {
        posDbg("skip layout resize restore", "already in flight");
        resizePendingAfterFlight = true;
        resizePendingSource = resizeReason;
        return;
      }

      const layoutHeight =
        els.viewer?.clientHeight || Math.max(400, window.innerHeight - 52);
      const dw = Math.abs(w - lastAppliedLayoutSize.w);
      const dh = Math.abs(layoutHeight - lastAppliedLayoutSize.h);
      if (dw < 2 && dh < 2) {
        return;
      }

      if (shouldUseCssOnlyLayout(resizeReason)) {
        void applyCssOnlyLayoutReflow(resizeReason);
        return;
      }

      const scrollEl = getScrollContainerForMetrics() || getReaderScrollElement();
      syncChapterScrollRatioFromLiveScroll();
      const beforeScrollTop = scrollEl ? scrollEl.scrollTop : 0;
      const beforeSpine = currentSpineIndex;
      const anchorBefore = captureVisibleTextAnchor({ silent: true });

      beginResizeVisualMask();
      if (els.viewer) {
        void els.viewer.offsetWidth;
      }

      resizeRestoreInFlight = true;
      beginReaderResizeFreeze(resizeReason);

      if (els.viewer) {
        try {
          applyEpubLayoutDimensions(w, layoutHeight);
          applyImmediateFrozenScrollRestore();
        } catch {
          /* noop */
        }
      }

      requestAnimationFrame(() => {
        void handleResizeVisualRestore(
          beforeScrollTop,
          beforeSpine,
          anchorBefore,
          resizeReason
        );
      });
      return;
    }

    if (!els.viewer || !rendition) return;
    try {
      reflowEpubToViewerSize();
    } catch {
      /* noop */
    }
  }

  async function applyWidthModeLayout() {
    if (!rendition || !els.viewer) {
      endResizeVisualMask();
      return;
    }
    if (widthModeApplyInFlight) {
      pendingWidthModeApply = true;
      return;
    }

    widthModeApplyInFlight = true;
    suppressLayoutResizeUntil = Date.now() + 1200;
    let usedVisualMask = false;
    try {
      document.documentElement.style.setProperty(
        "--reader-content-width",
        `${getEffectiveReaderWidth()}px`
      );
      await raf2();

      syncChapterScrollRatioFromLiveScroll();
      const ratio = currentChapterScrollRatio;
      const spine = currentSpineIndex;

      const result = prepareWidthModeReflow();
      if (!result) return;

      if (result.needsEpubResize) {
        usedVisualMask = true;
        beginResizeVisualMask();
        await raf2();
        rendition.resize(result.w, result.h);
        applyWidthModeTypography();
        await waitForRenditionStable("width-mode");
      } else {
        applyWidthModeTypography();
        await raf2();
      }

      await restoreScrollRatioAfterCssLayout(ratio, "width-mode", {
        waitMs: result.needsEpubResize ? 80 : 0,
        reapplyTheme: false,
      });

      const size = measureViewerLayoutSize();
      const container = rendition.manager?.container;
      if (size && container && Math.abs(container.clientWidth - size.w) > 12) {
        if (!usedVisualMask) {
          usedVisualMask = true;
          beginResizeVisualMask();
        }
        resetEpubContainerInlineWidth();
        rendition.resize(size.w, size.h);
        applyEpubTypographyTheme();
        lastAppliedLayoutSize = { w: size.w, h: size.h };
        await waitForRenditionStable("width-mode-retry");
        await restoreScrollRatioAfterCssLayout(ratio, "width-mode-retry", {
          waitMs: 80,
          reapplyTheme: false,
        });
      }

      setCurrentSpineIndex(spine, "width-mode");
      updateProgressUI(
        calculateProgressFromSpineAndRatio(currentSpineIndex, currentChapterScrollRatio),
        "width-mode"
      );
      await raf2();
      readerLog("width mode applied", {
        mode: readerPrefs.widthMode,
        w: result.w,
        h: result.h,
        resized: result.needsEpubResize,
        containerW: rendition.manager?.container?.clientWidth,
      });
    } catch (err) {
      readerWarn("width mode layout failed", err);
    } finally {
      widthModeApplyInFlight = false;
      if (usedVisualMask) {
        endResizeVisualMask();
      }
      if (pendingWidthModeApply) {
        pendingWidthModeApply = false;
        void applyWidthModeLayout();
      }
    }
  }

  function changeWidthMode(mode) {
    if (!WIDTH_MODES[mode] || mode === readerPrefs.widthMode) return;

    readerPrefs.widthMode = mode;
    readerPrefs.contentWidth = WIDTH_MODES[mode];
    updateWidthModeUI();

    suppressLayoutResizeUntil = Date.now() + WIDTH_MODE_DEBOUNCE_MS + 800;
    document.documentElement.style.setProperty(
      "--reader-content-width",
      `${getEffectiveReaderWidth()}px`
    );
    if (rendition && els.viewer) {
      resetEpubContainerInlineWidth();
      void els.viewer.offsetWidth;
    }

    const now = Date.now();
    const debounceMs = now - lastWidthModeChangeAt < 350 ? WIDTH_MODE_DEBOUNCE_MS : 60;
    lastWidthModeChangeAt = now;

    clearTimeout(widthModeDebounceTimer);
    widthModeDebounceTimer = setTimeout(() => {
      widthModeDebounceTimer = null;
      pendingWidthModeApply = true;
      void flushPendingWidthModeLayout();
    }, debounceMs);
  }

  async function flushPendingWidthModeLayout() {
    if (!pendingWidthModeApply) return;
    pendingWidthModeApply = false;
    await applyWidthModeLayout();
    saveReaderPrefs();
  }

  function resetEpubContainerInlineWidth() {
    if (!els.viewer) return;
    els.viewer
      .querySelectorAll('[class*="epub-container"], [class*="epub-view"], .epub-container, iframe')
      .forEach((el) => {
        el.style.width = "";
        el.style.maxWidth = "";
        el.style.minWidth = "";
        el.style.left = "";
        el.style.transform = "";
        el.style.marginLeft = "";
        el.style.marginRight = "";
      });
  }

  function applyEpubLayoutDimensions(w, layoutHeight) {
    if (!rendition || !els.viewer) return;
    document.documentElement.style.setProperty("--reader-content-width", `${w}px`);
    void els.viewer.offsetWidth;
    reflowEpubToViewerSize();
  }

  // EPUB 正文阅读排版：英文默认 Times，中文 fallback 楷体
  function buildReaderTheme() {
    return {
      body: {
        "font-family":
          '"Times New Roman", Times, "KaiTi", "STKaiti", "Kaiti SC", serif !important',
        "line-height": `${readerPrefs.lineHeight} !important`,
        "letter-spacing": "0.01em !important",
        "word-spacing": "0.04em !important",
        color: "#111827 !important",
        background: `${readerThemeNow().paperBg || READER_THEME_DEFAULTS.paperBg} !important`,
        // 正文内边距放在 iframe 内（容器不留 padding，避免扰乱滚动测算）
        margin: "0 !important",
        padding: "24px 32px !important",
      },
      p: {
        margin: "0 0 1.1em !important",
        "text-align": "left !important",
        "line-height": `${readerPrefs.lineHeight} !important`,
      },
      "h1, h2, h3": {
        "line-height": "1.35 !important",
        margin: "1.4em 0 0.8em !important",
      },
    };
  }

  function applyEpubTypographyTheme() {
    if (!rendition?.themes) return;
    if (isResizeStateFrozen() || resizeRestoreInFlight || widthModeApplyInFlight) return;
    const views = rendition.manager?.views;
    if (views && typeof views.length === "number" && views.length === 0) return;
    try {
      rendition.themes.register("zamp-default", buildReaderTheme());
      rendition.themes.select("zamp-default");
      rendition.themes.fontSize(`${readerPrefs.fontSize}px`);
    } catch {
      /* noop — iframe 切换/resize 时 epub.js 可能短暂不可用 */
    }
  }

  function changeFontSize(delta) {
    const next = clampFontSize(readerPrefs.fontSize + delta);
    if (next === readerPrefs.fontSize) return;
    readerPrefs.fontSize = next;
    updateFontSizeUI();
    if (rendition) {
      try {
        rendition.themes.fontSize(`${readerPrefs.fontSize}px`);
      } catch {
        /* noop */
      }
    }
    saveReaderPrefs();
  }

  // ── 单章节滚动 / 边界切章（default manager，无 continuous prepend）────────────────

  /** 持久化/恢复用的固定 scroll 容器（不依赖 scrollTop 启发式，避免章首误判） */
  function getScrollContainerForMetrics() {
    if (!rendition || !rendition.manager) return els.viewer || null;
    const m = rendition.manager;
    const preferred = m.container || (m.stage && m.stage.container);
    if (preferred && preferred.scrollHeight > preferred.clientHeight + 1) {
      return preferred;
    }
    return getReaderScrollElement();
  }

  /** 真实滚动容器：优先选用当前 scrollTop 最大的可滚动元素 */
  function getReaderScrollElement() {
    if (!rendition || !rendition.manager) return els.viewer || null;
    const m = rendition.manager;
    const candidates = [m.container, m.stage && m.stage.container, els.viewer].filter(Boolean);
    let best = null;
    let bestTop = -1;
    for (const el of candidates) {
      if (!el || el === window) continue;
      const top = el.scrollTop || 0;
      const scrollable = el.scrollHeight > el.clientHeight + 1;
      if (scrollable && top >= bestTop) {
        best = el;
        bestTop = top;
      }
    }
    if (best) return best;
    for (const el of candidates) {
      if (el && el !== window && el.scrollHeight > el.clientHeight + 1) return el;
    }
    return m.container || els.viewer || null;
  }

  const ANCHOR_BLOCK_TAGS = new Set([
    "P",
    "DIV",
    "H1",
    "H2",
    "H3",
    "H4",
    "SECTION",
    "LI",
    "BLOCKQUOTE",
  ]);

  function normalizeAnchorText(text) {
    return (text || "").replace(/\s+/g, " ").trim();
  }

  function getActiveReaderContentDocument() {
    if (!rendition) return null;
    try {
      const contents =
        typeof rendition.getContents === "function" ? rendition.getContents() : null;
      if (contents && contents.length) {
        const doc = contents[0].document || contents[0].contentDocument;
        if (doc && doc.body) return doc;
      }
    } catch {
      /* noop */
    }
    try {
      const iframe = els.viewer && els.viewer.querySelector("iframe");
      if (iframe && iframe.contentDocument && iframe.contentDocument.body) {
        return iframe.contentDocument;
      }
    } catch {
      /* noop */
    }
    return null;
  }

  function findBlockAncestor(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      if (ANCHOR_BLOCK_TAGS.has(node.tagName)) {
        const t = normalizeAnchorText(node.textContent);
        if (t.length >= 8) return node;
      }
      node = node.parentElement;
    }
    return el && el.nodeType === 1 ? el : null;
  }

  function elementTopInScrollContainer(element, scrollEl) {
    if (!element || !scrollEl) return 0;
    return element.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top;
  }

  function fallbackFirstVisibleBlock(contentDoc, scrollEl) {
    const root = contentDoc && contentDoc.body;
    if (!root || !scrollEl) return null;
    const scrollRect = scrollEl.getBoundingClientRect();
    const viewportBottom = scrollRect.top + scrollEl.clientHeight;
    const blocks = root.querySelectorAll("p, div, h1, h2, h3, h4, section, li, blockquote");
    for (const block of blocks) {
      const t = normalizeAnchorText(block.textContent);
      if (t.length < 30) continue;
      const rect = block.getBoundingClientRect();
      if (rect.bottom > scrollRect.top + 40 && rect.top < viewportBottom) {
        return { element: block, contentDoc, scrollEl };
      }
    }
    return null;
  }

  function resolveHitAtViewportPoint(scrollEl, yOffset) {
    if (!scrollEl) return null;
    const scrollRect = scrollEl.getBoundingClientRect();
    const x = scrollRect.left + scrollEl.clientWidth * 0.25;
    const y = scrollRect.top + (typeof yOffset === "number" ? yOffset : 120);
    const contentDoc = getActiveReaderContentDocument();

    if (contentDoc) {
      try {
        const frameEl = contentDoc.defaultView && contentDoc.defaultView.frameElement;
        if (frameEl) {
          const fr = frameEl.getBoundingClientRect();
          const lx = x - fr.left;
          const ly = y - fr.top;
          if (lx >= 0 && ly >= 0 && lx <= fr.width && ly <= fr.height) {
            const hit = contentDoc.elementFromPoint(lx, ly);
            if (hit && hit !== contentDoc.documentElement) {
              return { element: hit, contentDoc, scrollEl };
            }
          }
        }
      } catch {
        /* noop */
      }
    }

    try {
      const hit = document.elementFromPoint(x, y);
      if (hit && hit.tagName === "IFRAME" && hit.contentDocument) {
        const fr = hit.getBoundingClientRect();
        const idoc = hit.contentDocument;
        const inner = idoc.elementFromPoint(x - fr.left, y - fr.top);
        if (inner) return { element: inner, contentDoc: idoc, scrollEl };
      }
      if (hit) return { element: hit, contentDoc: contentDoc || document, scrollEl };
    } catch {
      /* noop */
    }

    return null;
  }

  function captureVisibleTextAnchor(options = {}) {
    const silent = options.silent === true;
    const scrollEl = getReaderScrollElement();
    const scrollTop = scrollEl ? scrollEl.scrollTop : 0;
    const liveRatio = getLiveChapterScrollRatio(scrollEl);

    const base = {
      spineIndex: currentSpineIndex,
      text: "",
      prefix: "",
      middle: "",
      offsetTopBefore: 0,
      scrollTopBefore: scrollTop,
      ratioBefore: liveRatio,
    };

    if (!scrollEl) return base;

    let block = null;
    for (const yOffset of ANCHOR_SAMPLE_Y) {
      const hit = resolveHitAtViewportPoint(scrollEl, yOffset);
      if (!hit || !hit.element) continue;
      const candidate = findBlockAncestor(hit.element);
      const text = normalizeAnchorText(candidate && candidate.textContent);
      if (text.length >= 30) {
        block = candidate;
        break;
      }
    }

    if (!block) {
      const fallback = fallbackFirstVisibleBlock(getActiveReaderContentDocument(), scrollEl);
      if (fallback && fallback.element) {
        block = findBlockAncestor(fallback.element);
      }
    }

    if (!block) {
      if (!silent) {
        readerLog("resize anchor captured", {
          spineIndex: base.spineIndex,
          textPreview: "",
          offsetTopBefore: 0,
          scrollTopBefore: base.scrollTopBefore,
          ratioBefore: base.ratioBefore,
        });
      }
      return base;
    }

    const text = normalizeAnchorText(block.textContent);
    const prefix = text.slice(0, 80);
    const middle =
      text.length > 160 ? text.slice(80, 160) : text.slice(Math.floor(text.length / 3), Math.floor((text.length * 2) / 3));
    const offsetTopBefore = elementTopInScrollContainer(block, scrollEl);

    const anchor = {
      spineIndex: currentSpineIndex,
      text: text.slice(0, 240),
      prefix,
      middle,
      offsetTopBefore,
      scrollTopBefore: scrollTop,
      ratioBefore: liveRatio,
    };

    if (!silent) {
      readerLog("resize anchor captured", {
        spineIndex: anchor.spineIndex,
        textPreview: prefix.slice(0, 40),
        offsetTopBefore,
        scrollTopBefore: anchor.scrollTopBefore,
        ratioBefore: anchor.ratioBefore,
      });
    }

    return anchor;
  }

  function buildAnchorSearchNeedles(anchor) {
    const needles = [];
    const prefix = normalizeAnchorText(anchor.prefix);
    const middle = normalizeAnchorText(anchor.middle);
    const text = normalizeAnchorText(anchor.text);
    if (prefix.length >= 10) needles.push({ text: prefix, kind: "prefix" });
    if (middle.length >= 12) needles.push({ text: middle, kind: "middle" });
    if (text.length >= 20) {
      needles.push({ text: text.slice(0, 80), kind: "text80" });
      needles.push({ text: text.slice(0, 40), kind: "text40" });
    }
    return needles;
  }

  function findElementByAnchor(contentDoc, anchor, scrollEl) {
    if (!contentDoc || !contentDoc.body || !anchor) return null;
    const needles = buildAnchorSearchNeedles(anchor);
    if (!needles.length) return null;

    const refTop =
      typeof anchor.offsetTopBefore === "number"
        ? anchor.offsetTopBefore
        : typeof anchor.offsetTop === "number"
          ? anchor.offsetTop
          : 0;

    const blocks = contentDoc.body.querySelectorAll(
      "p, div, h1, h2, h3, h4, section, li, blockquote"
    );
    let best = null;
    let bestDist = Infinity;

    for (const needle of needles) {
      for (const block of blocks) {
        const blockText = normalizeAnchorText(block.textContent);
        let matched = false;
        if (needle.kind === "prefix") {
          matched = blockText.startsWith(needle.text) || blockText.includes(needle.text);
        } else if (needle.kind === "middle") {
          matched = blockText.includes(needle.text);
        } else {
          matched = blockText.includes(needle.text);
        }
        if (!matched) continue;
        const top = elementTopInScrollContainer(block, scrollEl);
        const dist = Math.abs(top - refTop);
        if (dist < bestDist) {
          bestDist = dist;
          best = block;
        }
      }
      if (best) return best;
    }
    return null;
  }

  function applyTextAnchorScroll(anchor, options = {}) {
    if (!anchor) return false;
    const visualOnly = options.visualOnly === true;

    const scrollEl =
      options.scrollEl ||
      (isResizeStateFrozen() || resizeRestoreInFlight
        ? getPinnedResizeScrollElement()
        : getReaderScrollElement());
    if (!scrollEl) return false;

    const refTop =
      typeof anchor.offsetTopBefore === "number"
        ? anchor.offsetTopBefore
        : typeof anchor.offsetTop === "number"
          ? anchor.offsetTop
          : 0;

    const contentDoc = getActiveReaderContentDocument();
    const target = findElementByAnchor(contentDoc, anchor, scrollEl);

    if (target) {
      if (!isValidScrollElForResizeRestore(scrollEl)) {
        warnSkipResizeRestoreInvalidMetrics(scrollEl, "text-anchor-scroll");
        return false;
      }
      markProgrammaticScroll("text-anchor-scroll");
      let currentTop = elementTopInScrollContainer(target, scrollEl);
      let delta = currentTop - refTop;
      scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop + delta);

      currentTop = elementTopInScrollContainer(target, scrollEl);
      const residual = currentTop - refTop;
      if (Math.abs(residual) > 4) {
        scrollEl.scrollTop = Math.max(0, scrollEl.scrollTop + residual);
      }

      if (visualOnly) {
        const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
        const expectedRatio =
          typeof anchor.ratioBefore === "number"
            ? anchor.ratioBefore
            : resizeFrozenState && typeof resizeFrozenState.chapterScrollRatio === "number"
              ? resizeFrozenState.chapterScrollRatio
              : null;
        if (maxScroll > 0 && typeof expectedRatio === "number") {
          const liveRatio = scrollEl.scrollTop / maxScroll;
          if (Math.abs(liveRatio - expectedRatio) > 0.012) {
            posDbg("resize text anchor ratio mismatch", "", {
              expectedRatio,
              liveRatio,
              scrollTop: scrollEl.scrollTop,
            });
            return false;
          }
        }
      }
      return true;
    }

    if (visualOnly) {
      posDbg("resize anchor not found", "keep current scrollTop");
      return false;
    }

    const fallbackRatio =
      typeof options.fallbackRatio === "number"
        ? options.fallbackRatio
        : typeof anchor.ratioBefore === "number"
          ? anchor.ratioBefore
          : typeof anchor.chapterScrollRatio === "number"
            ? anchor.chapterScrollRatio
            : resizeSnapshot
              ? resizeSnapshot.chapterScrollRatio
              : null;
    if (fallbackRatio !== null) {
      if (!isValidScrollElForResizeRestore(scrollEl)) {
        warnSkipResizeRestoreInvalidMetrics(scrollEl, "text-anchor-fallback-ratio");
        return false;
      }
      markProgrammaticScroll("text-anchor-fallback-ratio");
      readerLog("resize anchor not found fallback ratio", {
        ratioBefore: fallbackRatio,
        visualOnly,
      });
      const { clientHeight, scrollHeight } = scrollMetrics(scrollEl);
      const maxScroll = Math.max(0, scrollHeight - clientHeight);
      setReaderScrollTop(fallbackRatio * maxScroll);
      if (!visualOnly) {
        currentChapterScrollRatio = clampRatio(fallbackRatio);
      }
    }
    return false;
  }

  function setCurrentSpineIndex(nextIndex, reason) {
    if (typeof nextIndex !== "number" || nextIndex < 0) return;
    if (nextIndex === currentSpineIndex) return;
    const from = currentSpineIndex;
    currentSpineIndex = nextIndex;
    readerLog("current spine changed", { from, to: nextIndex, reason });
  }

  function getLiveChapterScrollRatio(el) {
    const target = el || getReaderScrollElement();
    if (!target) return currentChapterScrollRatio || 0;
    const { scrollTop, clientHeight, scrollHeight } = scrollMetrics(target);
    const maxScroll = scrollHeight - clientHeight;
    if (maxScroll <= 0) return 0;
    return clampRatio(scrollTop / maxScroll);
  }

  function positionLogFields(record, phase) {
    const totalSpineItems =
      typeof record?.totalSpineItems === "number" && record.totalSpineItems > 0
        ? record.totalSpineItems
        : getTotalSpineItems() || record?.totalSpineItems;
    const derivedProgress = derivedProgressFromRecord(record, totalSpineItems);
    return {
      phase,
      bookId: record?.id || bookId,
      progress: record?.progress,
      currentSpineIndex: record?.currentSpineIndex,
      chapterScrollRatio: record?.chapterScrollRatio,
      derivedProgress,
      totalSpineItems: totalSpineItems || undefined,
      lastReadAt: record?.lastReadAt,
    };
  }

  function getToolbarProgressText() {
    return els.progress ? els.progress.textContent : "";
  }

  function debugPositionSnapshot(reason, extra) {
    const scrollEl = getReaderScrollElement();
    const spineIndex = currentSpineIndex;
    const scrollTop = scrollEl ? scrollEl.scrollTop : null;
    const scrollHeight = scrollEl ? scrollEl.scrollHeight : null;
    const clientHeight = scrollEl ? scrollEl.clientHeight : null;
    const maxScroll =
      scrollEl && scrollHeight != null && clientHeight != null
        ? Math.max(0, scrollHeight - clientHeight)
        : null;
    const ratio = maxScroll > 0 ? scrollTop / maxScroll : 0;
    const totalSpineItems = getTotalSpineItems();
    const derivedProgress = calculateProgressFromSpineRatio(spineIndex, ratio, totalSpineItems);
    const currentProgress = calculateProgressFromSpineRatio(
      currentSpineIndex,
      currentChapterScrollRatio,
      totalSpineItems
    );

    readerDebug(
      `[ZEH_POS] snapshot reason=${reason} progress=${posFmtProgress(derivedProgress)} ratio=${posFmtRatio(ratio)} spine=${spineIndex} scrollTop=${scrollTop}`,
      {
        reason,
        bookId,
        spineIndex,
        currentSpineIndex,
        currentChapterScrollRatio,
        currentProgress,
        uiProgressText: getToolbarProgressText(),
        scrollTop,
        scrollHeight,
        clientHeight,
        maxScroll,
        liveRatio: ratio,
        derivedProgress,
        totalSpineItems,
        latestCfi: currentCfi,
        isRestoringOpenBookPosition,
        isResizeLocked: isResizeLocked(),
        progressFrozenUntilUserScroll,
        scrollElTag: scrollEl
          ? scrollEl.id ||
            (scrollEl.className && String(scrollEl.className).split(" ")[0]) ||
            scrollEl.tagName
          : null,
        ...(extra || {}),
      }
    );
  }

  async function debugStoredBook(reason) {
    if (!bookId) {
      readerDebug("[ZEH_POS] stored book reason=" + reason + " error=no bookId");
      return null;
    }
    let stored = null;
    try {
      stored = await ZEHBookStore.getBook(bookId);
    } catch (err) {
      readerDebug(
        "[ZEH_POS] stored book reason=" + reason + " error=" + (err && err.message ? err.message : String(err))
      );
      return null;
    }
    if (!stored) {
      readerDebug("[ZEH_POS] stored book reason=" + reason + " error=book not found");
      return null;
    }
    const totalSpineItems = getTotalSpineItems() || stored.totalSpineItems;
    const derivedProgress = calculateProgressFromSpineRatio(
      stored.currentSpineIndex,
      stored.chapterScrollRatio,
      totalSpineItems
    );

    readerDebug(
      `[ZEH_POS] stored book reason=${reason} progress=${posFmtProgress(stored.progress)} ratio=${posFmtRatio(stored.chapterScrollRatio)} spine=${stored.currentSpineIndex} derived=${posFmtProgress(derivedProgress)}`,
      {
        reason,
        bookId,
        progress: stored.progress,
        currentSpineIndex: stored.currentSpineIndex,
        chapterScrollRatio: stored.chapterScrollRatio,
        derivedProgress,
        totalSpineItems,
        lastReadAt: stored.lastReadAt,
        currentLocation: stored.currentLocation,
        readingAnchor: stored.readingAnchor
          ? {
              spineIndex: stored.readingAnchor.spineIndex,
              progress: stored.readingAnchor.progress,
              chapterScrollRatio: stored.readingAnchor.chapterScrollRatio,
              prefix: stored.readingAnchor.prefix,
            }
          : null,
        progressMatchesDerived:
          typeof stored.progress === "number" && typeof derivedProgress === "number"
            ? Math.abs(stored.progress - derivedProgress) <= 0.002
            : null,
      }
    );
    return stored;
  }

  function scrollMetrics(el) {
    if (!el || el === window) {
      return {
        scrollTop: window.scrollY || 0,
        clientHeight: window.innerHeight,
        scrollHeight: document.documentElement.scrollHeight,
      };
    }
    return {
      scrollTop: el.scrollTop || 0,
      clientHeight: el.clientHeight || 0,
      scrollHeight: el.scrollHeight || 0,
    };
  }

  function setReaderScrollTop(top) {
    const el = getReaderScrollElement();
    if (!el) return;
    if (
      (isResizeLocked() || progressFrozenUntilUserScroll) &&
      !isValidScrollElForResizeRestore(el)
    ) {
      warnSkipResizeRestoreInvalidMetrics(el, "setReaderScrollTop");
      return;
    }
    markProgrammaticScroll("setReaderScrollTop");
    const v = Math.max(0, top);
    if (el === window) window.scrollTo(0, v);
    else el.scrollTop = v;
  }

  function isAtChapterTop(el) {
    if (isResizeLocked()) return false;
    const { scrollTop } = scrollMetrics(el);
    return scrollTop <= CHAPTER_EDGE_THRESHOLD;
  }

  function isAtChapterBottom(el) {
    if (isResizeLocked()) return false;
    const { scrollTop, clientHeight, scrollHeight } = scrollMetrics(el);
    if (scrollHeight <= clientHeight + 1) return true;
    return scrollTop + clientHeight >= scrollHeight - CHAPTER_EDGE_THRESHOLD;
  }

  function isRecentUserScroll() {
    return Date.now() - lastUserScrollAt < 1500;
  }

  function isScrollLayoutReady(scrollEl) {
    if (!scrollEl || scrollEl.clientHeight <= 0) return false;
    const scrollHeight = scrollEl.scrollHeight || 0;
    if (scrollHeight <= 0) return false;
    const maxScroll = Math.max(0, scrollHeight - scrollEl.clientHeight);
    return maxScroll > 0 || scrollHeight <= scrollEl.clientHeight + 1;
  }

  function ensureTocJumpVisualReady() {
    if (isOpeningOrRestoring || isSectionSwitching || !restoreVisualReady) return;
    document.body.classList.remove("reader-restoring");
    document.body.classList.remove("reader-section-switching");
    endResizeVisualMask();
  }

  async function waitForTocJumpReady(seq) {
    await waitAfterSectionDisplay(200);
    await raf2();
    const deadline = Date.now() + 400;
    while (Date.now() < deadline) {
      if (!isActiveTocJump(seq)) return false;
      const scrollEl = getReaderScrollElement();
      if (isScrollLayoutReady(scrollEl)) return true;
      await sleep(40);
    }
    return isActiveTocJump(seq);
  }

  function waitAfterSectionDisplay(maxWaitMs = 500) {
    return new Promise((resolve) => {
      if (!rendition) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(fallback);
        try {
          rendition.off("rendered", onRendered);
        } catch {
          /* noop */
        }
        resolve();
      };
      const onRendered = () => done();
      const fallback = setTimeout(done, maxWaitMs);
      rendition.on("rendered", onRendered);
    });
  }

  function nextAnimationFrame() {
    return new Promise((resolve) => requestAnimationFrame(resolve));
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function raf2() {
    await nextAnimationFrame();
    await nextAnimationFrame();
  }

  async function waitForRenditionStable(phase) {
    const label = phase || "default";
    await raf2();
    await waitAfterSectionDisplay();

    const deadline = Date.now() + (label === "toc-jump" ? 800 : 3000);
    let stableCount = 0;
    let lastScrollHeight = null;
    let lastClientHeight = null;

    while (Date.now() < deadline) {
      const scrollEl =
        label === "resize-restore" || isReaderResizing || resizeRestoreInFlight
          ? getPinnedResizeScrollElement()
          : getScrollContainerForMetrics();
      const scrollHeight = scrollEl ? scrollEl.scrollHeight : 0;
      const clientHeight = scrollEl ? scrollEl.clientHeight : 0;
      const maxScroll = scrollEl ? Math.max(0, scrollHeight - clientHeight) : 0;
      const ready = isScrollLayoutReady(scrollEl);
      const plausible =
        label !== "resize-restore" ||
        !resizeFrozenState ||
        isPlausibleResizeRestoreScrollEl(scrollEl, resizeFrozenState);

      const dimensionsStable =
        ready &&
        plausible &&
        lastScrollHeight !== null &&
        Math.abs(scrollHeight - lastScrollHeight) < 2 &&
        Math.abs(clientHeight - lastClientHeight) < 2;

      if (dimensionsStable) {
        stableCount += 1;
      } else if (ready && plausible) {
        stableCount = 1;
      } else {
        stableCount = 0;
      }

      lastScrollHeight = scrollHeight;
      lastClientHeight = clientHeight;

      posLog(
        "wait stable tick",
        `phase=${label} stableCount=${stableCount} scrollH=${scrollHeight} clientH=${clientHeight} maxScroll=${maxScroll}`
      );

      const stableRequired = maxScroll > 0 ? 3 : 2;
      if (stableCount >= stableRequired && scrollEl) {
        posLog(
          "wait stable done",
          `phase=${label} scrollH=${scrollHeight} maxScroll=${maxScroll}`
        );
        return scrollEl;
      }

      await sleep(100);
    }

    const scrollEl = getScrollContainerForMetrics();
    posLog("wait stable done", `phase=${label} timeout fallback`);
    return scrollEl;
  }

  function resolveScrollElForMetrics(options = {}) {
    if (options.scrollEl) return options.scrollEl;
    const live = getReaderScrollElement();
    if (live && isScrollLayoutReady(live)) {
      return live;
    }
    return getScrollContainerForMetrics();
  }

  const QUIET_INVALID_METRICS_REASONS = new Set([
    "section-switch-pin",
    "width-mode",
    "width-mode-retry",
    "toc-jump",
    "resize-check",
    "restore-final",
    "restore-initial",
  ]);

  /** 从真实 scroll 容器读取位置（保存 / 恢复校验唯一来源） */
  function readLiveScrollMetricsForPersist(reason, options = {}) {
    const scrollEl = resolveScrollElForMetrics(options);
    if (!scrollEl) {
      return { valid: false, scrollEl: null };
    }
    const scrollTop = scrollEl.scrollTop;
    const clientHeight = scrollEl.clientHeight;
    const scrollHeight = scrollEl.scrollHeight;
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    const spineIndex = currentSpineIndex;
    const chapterScrollRatio = maxScroll > 0 ? clampRatio(scrollTop / maxScroll) : 0;
    const totalSpineItems = getTotalSpineItems();
    const progress = calculateProgressFromSpineRatio(
      spineIndex,
      chapterScrollRatio,
      totalSpineItems
    );
    const valid =
      clientHeight > 0 &&
      scrollHeight > 0 &&
      (maxScroll > 0 || scrollHeight <= clientHeight + 1);

    if (reason) {
      readerLog("live metrics", {
        reason,
        spineIndex,
        scrollTop,
        scrollHeight,
        clientHeight,
        maxScroll,
        chapterScrollRatio,
        progress,
        derivedProgress: progress,
        totalSpineItems,
      });
    }

    if (
      !valid &&
      reason &&
      !QUIET_INVALID_METRICS_REASONS.has(reason) &&
      !isRestoringPosition &&
      !isRestoringOpenBookPosition &&
      !widthModeApplyInFlight &&
      !isSoftSuppressed() &&
      Date.now() >= suppressPersistAndResizeUntil
    ) {
      readerWarn("invalid scroll metrics", {
        reason,
        scrollHeight,
        clientHeight,
        maxScroll,
      });
    }

    return {
      valid,
      scrollEl,
      scrollTop,
      clientHeight,
      scrollHeight,
      maxScroll,
      spineIndex,
      chapterScrollRatio,
      progress,
      totalSpineItems,
    };
  }

  async function restoreBySpineRatio(saved, reason) {
    const spineIndex = saved.currentSpineIndex ?? saved.spineIndex;
    const targetRatio =
      typeof saved.chapterScrollRatio === "number"
        ? clampRatio(saved.chapterScrollRatio)
        : null;
    const savedProgress = saved.progress;

    if (!Number.isInteger(spineIndex) || spineIndex < 0 || targetRatio === null || !book?.spine) {
      return false;
    }

    const sec = book.spine.get(spineIndex);
    if (!sec?.href) {
      return false;
    }

    posLog(
      "restore start",
      `progress=${posFmtProgress(savedProgress)} ratio=${posFmtRatio(targetRatio)} spine=${spineIndex} reason=${reason || ""}`,
      { reason, saved }
    );
    await debugStoredBook("restore-start");
    debugPositionSnapshot("restore-start-before-display");

    isRestoringPosition = true;
    markScrollPersistCooldown("restore-start", 6000);
    setCurrentSpineIndex(spineIndex, reason);

    try {
      await safeDisplay(sec.href, "open-book-restore-spine-ratio");
      posLog("display done but visual hidden during restore", "");
      debugPositionSnapshot("after-safeDisplay-before-scrollTop");

      await waitForRenditionStable("restore-initial");

      let scrollEl = getScrollContainerForMetrics();
      if (!scrollEl) {
        posLog("restore failed", "no scroll container");
        return false;
      }
      debugPositionSnapshot("after-wait-stable-before-set-scrollTop", {
        savedRatio: targetRatio,
      });

      let maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      let targetScrollTop = targetRatio * maxScroll;
      markProgrammaticScroll("restore-set-scrollTop-pass1");
      scrollEl.scrollTop = targetScrollTop;
      await raf2();
      posLog(
        "restore set scrollTop",
        `pass=1 target=${Math.round(targetScrollTop)} actual=${Math.round(scrollEl.scrollTop)} ratio=${posFmtRatio(maxScroll > 0 ? scrollEl.scrollTop / maxScroll : 0)}`
      );

      maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      targetScrollTop = targetRatio * maxScroll;
      markProgrammaticScroll("restore-set-scrollTop-pass2");
      scrollEl.scrollTop = targetScrollTop;
      await raf2();
      posLog(
        "restore set scrollTop",
        `pass=2 target=${Math.round(targetScrollTop)} actual=${Math.round(scrollEl.scrollTop)}`
      );

      await ensureRestoreVisualReady();
      readerDebug("[ZEH_POS] restore visual ready early; wheel enabled");

      await sleep(250);
      maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      targetScrollTop = targetRatio * maxScroll;
      const actualRatioBeforeFinal = maxScroll > 0 ? scrollEl.scrollTop / maxScroll : 0;

      if (Math.abs(actualRatioBeforeFinal - targetRatio) > 0.01) {
        console.warn(
          `[ZEH_POS] restore drift before final correction targetRatio=${posFmtRatio(targetRatio)} actualRatio=${posFmtRatio(actualRatioBeforeFinal)} scrollTop=${scrollEl.scrollTop} targetScrollTop=${Math.round(targetScrollTop)} maxScroll=${maxScroll}`
        );
        markProgrammaticScroll("restore-set-scrollTop-pass3");
        scrollEl.scrollTop = targetScrollTop;
        await raf2();
        posLog(
          "restore set scrollTop",
          `pass=3-after-250ms target=${Math.round(targetScrollTop)} actual=${Math.round(scrollEl.scrollTop)}`
        );
      }

      await sleep(500);
      maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);
      targetScrollTop = targetRatio * maxScroll;
      const actualRatio = maxScroll > 0 ? scrollEl.scrollTop / maxScroll : 0;

      if (Math.abs(actualRatio - targetRatio) > 0.01) {
        console.warn(
          `[ZEH_POS] restore drift before retry correction targetRatio=${posFmtRatio(targetRatio)} actualRatio=${posFmtRatio(actualRatio)} scrollTop=${scrollEl.scrollTop} targetScrollTop=${Math.round(targetScrollTop)} maxScroll=${maxScroll}`
        );
        markProgrammaticScroll("restore-set-scrollTop-pass4");
        scrollEl.scrollTop = targetScrollTop;
        await raf2();
        posLog(
          "restore set scrollTop",
          `pass=4-after-500ms target=${Math.round(targetScrollTop)} actual=${Math.round(scrollEl.scrollTop)}`
        );
      }

      const finalMetrics = readLiveScrollMetricsForPersist("restore-final", { scrollEl });
      if (finalMetrics.valid) {
        currentSpineIndex = spineIndex;
        currentChapterScrollRatio = finalMetrics.chapterScrollRatio;
        updateProgressUI(finalMetrics.progress, "restore-final");
      }

      posLog(
        "restore final",
        `progress=${posFmtProgress(finalMetrics.progress)} ratio=${posFmtRatio(finalMetrics.chapterScrollRatio)} scrollTop=${finalMetrics.scrollTop} targetRatio=${posFmtRatio(targetRatio)}`,
        finalMetrics
      );

      await debugStoredBook("restore-done");
      debugPositionSnapshot("restore-done", {
        savedRatio: targetRatio,
        savedProgress,
        actualRatio: finalMetrics.chapterScrollRatio,
        actualProgress: finalMetrics.progress,
      });

      updateDebugOverlay();
      await ensureRestoreVisualReady();
      scheduleOpenRestoreSettle();
      return Boolean(finalMetrics.valid);
    } catch (err) {
      readerWarn("restore by spine ratio failed", { reason, err });
      posLog("restore failed", String(err && err.message ? err.message : err));
      return false;
    } finally {
      isRestoringPosition = false;
    }
  }

  async function finishSectionSwitch(direction, persistReason) {
    markScrollPersistCooldown("section-switch");
    const totalSpineItems = getTotalSpineItems();
    let lastMetrics = null;

    for (let attempt = 0; attempt <= 2; attempt++) {
      if (attempt > 0) {
        await sleep(150);
      }
      await waitAfterSectionDisplay(200);
      await raf2();

      const scrollEl = getScrollContainerForMetrics() || getReaderScrollElement();
      if (!scrollEl || !isScrollLayoutReady(scrollEl)) {
        continue;
      }

      const maxScroll = Math.max(0, scrollEl.scrollHeight - scrollEl.clientHeight);

      if (direction === "next") {
        markProgrammaticScroll("section-next-scrollTop", 800);
        scrollEl.scrollTop = 0;
      } else if (maxScroll > 0) {
        markProgrammaticScroll("section-prev-scrollTop", 800);
        scrollEl.scrollTop = maxScroll;
      } else {
        markProgrammaticScroll("section-prev-scrollTop-short", 800);
        scrollEl.scrollTop = 0;
      }
      await raf2();

      const metrics = readLiveScrollMetricsForPersist(null, { scrollEl });
      if (!metrics.valid) {
        continue;
      }

      if (direction === "prev" && maxScroll === 0) {
        metrics.chapterScrollRatio = 1;
        metrics.progress = calculateProgressFromSpineRatio(
          metrics.spineIndex,
          1,
          totalSpineItems
        );
      }

      lastMetrics = metrics;
      if (
        direction === "prev" &&
        maxScroll > 0 &&
        metrics.chapterScrollRatio < 0.9 &&
        attempt < 2
      ) {
        continue;
      }
      break;
    }

    if (!lastMetrics || !lastMetrics.valid) {
      return null;
    }

    currentChapterScrollRatio = lastMetrics.chapterScrollRatio;
    posLog("section switch done", `direction=${direction} progress=${posFmtProgress(lastMetrics.progress)}`, {
      reason: persistReason,
      spineIndex: lastMetrics.spineIndex,
      scrollTop: lastMetrics.scrollTop,
      maxScroll: lastMetrics.maxScroll,
      chapterScrollRatio: lastMetrics.chapterScrollRatio,
      progress: lastMetrics.progress,
      derivedProgress: calculateProgressFromSpineRatio(
        lastMetrics.spineIndex,
        lastMetrics.chapterScrollRatio,
        totalSpineItems
      ),
      totalSpineItems,
    });
    updateDebugOverlay();
    return lastMetrics;
  }

  function getAdjacentSection(direction) {
    if (!book || !book.spine) return null;
    const cur = book.spine.get(currentSpineIndex);
    if (!cur) return null;
    try {
      if (direction === "next" && typeof cur.next === "function") return cur.next();
      if (direction === "prev" && typeof cur.prev === "function") return cur.prev();
    } catch {
      /* noop */
    }
    return null;
  }

  async function goNextSection(reason) {
    if (!rendition || Date.now() < chapterSwitchCooldownUntil) return;
    if (!canSwitchSection("next", reason || "section-next")) return;
    const next = getAdjacentSection("next");
    if (!next) return;
    chapterSwitchCooldownUntil = Date.now() + CHAPTER_SWITCH_COOLDOWN_MS;
    wheelBoundaryAccum = 0;
    dlog("section-next", { index: next.index, href: next.href });
    beginSectionSwitchVisual();
    try {
      await safeDisplay(next.href, "section-next");
      setCurrentSpineIndex(next.index, "section-next");
      highlightActiveTocBySpine(next.index, next.href);
      const metrics = await finishSectionSwitch("next", "section-next-done");
      if (metrics) {
        currentChapterScrollRatio = metrics.chapterScrollRatio;
        updateProgressUI(metrics.progress, "section-switch-done");
      }
    } catch (err) {
      dlog("section-next failed", err);
    } finally {
      endSectionSwitchVisual();
    }
  }

  async function goPreviousSection(reason) {
    if (!rendition || Date.now() < chapterSwitchCooldownUntil) return;
    if (!canSwitchSection("prev", reason || "section-prev")) return;
    const prev = getAdjacentSection("prev");
    if (!prev) return;
    chapterSwitchCooldownUntil = Date.now() + CHAPTER_SWITCH_COOLDOWN_MS;
    wheelBoundaryAccum = 0;
    dlog("section-prev", { index: prev.index, href: prev.href });
    beginSectionSwitchVisual();
    try {
      await safeDisplay(prev.href, "section-prev");
      setCurrentSpineIndex(prev.index, "section-prev");
      highlightActiveTocBySpine(prev.index, prev.href);
      const metrics = await finishSectionSwitch("prev", "section-prev-done");
      if (metrics) {
        currentChapterScrollRatio = metrics.chapterScrollRatio;
        updateProgressUI(metrics.progress, "section-switch-done");
      }
    } catch (err) {
      dlog("section-prev failed", err);
    } finally {
      endSectionSwitchVisual();
    }
  }

  function onReaderScroll() {
    const metrics = readLiveScrollMetricsForPersist("scroll-live");
    const programmaticScroll =
      Date.now() < programmaticScrollLockUntil &&
      !isRealUserScrollRecently() &&
      (isRestoringPosition || isProgrammaticDisplay || isRestoringOpenBookPosition);

    if (
      metrics &&
      metrics.valid &&
      Number.isFinite(metrics.progress) &&
      !isSectionSwitching
    ) {
      if (!programmaticScroll || isRealUserScrollRecently()) {
        syncLiveProgressUI(metrics, "scroll-live");
        if (isRealUserScrollRecently() && tocItemCount() && !isTocJumpHighlightLocked()) {
          highlightActiveTocBySpine(
            Number.isInteger(metrics.spineIndex) ? metrics.spineIndex : currentSpineIndex
          );
        }
      }
    }

    if (isRealUserScrollRecently()) {
      releaseRestoreLocksForUserScroll("scroll");
      if (metrics && metrics.valid) {
        schedulePositionCacheWrite(metrics, "scroll-track");
      }
      if (!isProgressStateFrozen()) {
        scheduleScrollSave();
      }
    } else if (isResizeLocked()) {
      readerLog("scroll during resize - no section switch", {
        currentSpineIndex: resizeSnapshot ? resizeSnapshot.spineIndex : currentSpineIndex,
        chapterScrollRatio: resizeSnapshot
          ? resizeSnapshot.chapterScrollRatio
          : currentChapterScrollRatio,
      });
    }

    if (DEBUG_READER) {
      const debugScrollNow = Date.now();
      if (debugScrollNow - _scrollLogAt > 250) {
        _scrollLogAt = debugScrollNow;
        const el = getReaderScrollElement();
        const { scrollTop } = scrollMetrics(el);
        dlog("scroll", { scrollTop, spineIndex: currentSpineIndex });
      }
    }
    deferLocationsGeneration();
  }

  /**
   * 滚轮：章节内自然滚动；仅在顶/底边界继续滚时切章。
   * 不 display / 不 prev / 不 restore / 不做 continuous prepend correction。
   */
  function onWheelForward(e) {
    if (e.ctrlKey || e.metaKey) return;
    if (lookup.isOurElement(e.target)) return;

    const scroller = getReaderScrollElement();
    if (!scroller || scroller === window) return;

    const deltaY = e.deltaY;
    if (deltaY === 0) return;

    noteUserScrollActivity("wheel");
    if (!isResizeLocked()) {
      noteUserInitiatedScroll("wheel");
    }

    const atTop = isAtChapterTop(scroller);
    const atBottom = isAtChapterBottom(scroller);

    if (isHardRestoring() || isResizeStateFrozen()) {
      const isIframeDocEarly = e.currentTarget && e.currentTarget.defaultView !== window;
      if (isIframeDocEarly) {
        e.preventDefault();
        e.stopPropagation();
        scroller.scrollTop = scroller.scrollTop + deltaY;
        if (!isSectionSwitching) {
          const wheelMetrics = readLiveScrollMetricsForPersist("scroll-live");
          if (wheelMetrics && wheelMetrics.valid) {
            syncLiveProgressUI(wheelMetrics, "scroll-live");
          }
        }
      }
      deferLocationsGeneration();
      return;
    }

    if (isResizeLocked()) {
      if ((atTop && deltaY < 0) || (atBottom && deltaY > 0)) {
        e.preventDefault();
        e.stopPropagation();
        readerLog("skip section switch during resize", {
          direction: deltaY < 0 ? "prev" : "next",
        });
        return;
      }
    }

    // 章节边界：累积一小段滚轮量后再切章，避免误触
    if (atTop && deltaY < 0) {
      e.preventDefault();
      e.stopPropagation();
      wheelBoundaryAccum += deltaY;
      if (
        Math.abs(wheelBoundaryAccum) >= BOUNDARY_WHEEL_DELTA &&
        Date.now() >= chapterSwitchCooldownUntil
      ) {
        goPreviousSection("wheel-at-top");
      }
      return;
    }

    if (atBottom && deltaY > 0) {
      e.preventDefault();
      e.stopPropagation();
      wheelBoundaryAccum += deltaY;
      if (wheelBoundaryAccum >= BOUNDARY_WHEEL_DELTA && Date.now() >= chapterSwitchCooldownUntil) {
        goNextSection("wheel-at-bottom");
      }
      return;
    }

    wheelBoundaryAccum = 0;

    const isIframeDoc = e.currentTarget && e.currentTarget.defaultView !== window;
    if (isIframeDoc) {
      e.preventDefault();
      e.stopPropagation();
      const { scrollTop } = scrollMetrics(scroller);
      scroller.scrollTop = scrollTop + deltaY;
      const wheelMetrics = readLiveScrollMetricsForPersist("scroll-live");
      if (wheelMetrics && wheelMetrics.valid) {
        syncLiveProgressUI(wheelMetrics, "scroll-live");
      }
      if (isRealUserScrollRecently()) {
        scheduleScrollSave();
      }
    }

    if (DEBUG_READER) {
      const { scrollTop } = scrollMetrics(scroller);
      dlog("wheel", {
        deltaY,
        scrollTop,
        atTop,
        atBottom,
        spineIndex: currentSpineIndex,
      });
    }

    deferLocationsGeneration();
  }

  function onReaderPointerScrollStart() {
    noteUserScrollActivity("scrollbar");
    if (!isResizeLocked()) {
      noteUserInitiatedScroll("scrollbar");
    }
  }

  function bindReaderResizeObserver() {
    if (!els.viewer || !window.ResizeObserver || readerResizeObserver) return;
    readerResizeObserver = new ResizeObserver(() => {
      scheduleReaderResize("ResizeObserver");
    });
    readerResizeObserver.observe(els.viewer);
  }

  async function waitForViewerDimensionsStable(timeoutMs = 900) {
    const deadline = Date.now() + timeoutMs;
    let lastW = null;
    let lastH = null;
    let stableTicks = 0;

    while (Date.now() < deadline) {
      const el = els.viewer;
      if (!el || el.clientWidth <= 0 || el.clientHeight <= 0) {
        stableTicks = 0;
        await sleep(40);
        continue;
      }
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (
        lastW !== null &&
        Math.abs(w - lastW) < 2 &&
        Math.abs(h - lastH) < 2
      ) {
        stableTicks += 1;
        if (stableTicks >= 3) return true;
      } else {
        stableTicks = w > 0 && h > 0 ? 1 : 0;
      }
      lastW = w;
      lastH = h;
      await sleep(40);
    }
    return true;
  }

  async function executeScheduledReaderResize() {
    const source = pendingResizeSource || "window-resize";
    pendingResizeSource = null;
    if (!rendition) return;
    if (shouldSkipResizeForTocToggle(source)) return;

    await waitForViewerDimensionsStable();
    applyReaderLayout({ reason: "resize", resizeReason: source });
  }

  function scheduleReaderResize(source) {
    if (widthModeApplyInFlight || Date.now() < suppressLayoutResizeUntil) {
      return;
    }
    pendingResizeSource = source || pendingResizeSource || "window-resize";
    clearTimeout(resizeDebounceTimer);
    resizeDebounceTimer = setTimeout(() => {
      void executeScheduledReaderResize();
    }, RESIZE_DEBOUNCE_MS);
  }

  function bindWheelTarget(target) {
    if (!target || target === window || boundWheelTargets.has(target)) return;
    boundWheelTargets.add(target);
    target.addEventListener("wheel", onWheelForward, { passive: false, capture: true });
  }

  function bindWheelForwarding() {
    bindWheelTarget(getReaderScrollElement());
  }

  function bindReaderScrollListener() {
    const container = getReaderScrollElement();
    if (!container || container === scrollContainerEl) return;
    if (scrollContainerEl && scrollContainerEl !== window) {
      scrollContainerEl.removeEventListener("scroll", onReaderScroll);
    }
    scrollContainerEl = container;
    if (container !== window) {
      container.addEventListener("scroll", onReaderScroll, { passive: true });
      container.removeEventListener("pointerdown", onReaderPointerScrollStart);
      container.addEventListener("pointerdown", onReaderPointerScrollStart, { passive: true });
    }
    dlog("scroll listener bound", container.id || container.className || "container");
  }

  function shouldBlockDisplay(reason) {
    if (!DISPLAY_REASONS.has(reason)) {
      readerWarn("blocked invalid display reason", { reason });
      return true;
    }
    const allowedDuringScroll = [
      "bookmark-jump",
      "toc-jump",
      "section-prev",
      "section-next",
      "open-book-restore-section",
      "open-book-restore-cfi",
    ];
    if (isRecentUserScroll() && !allowedDuringScroll.includes(reason)) {
      return true;
    }
    return false;
  }

  /** 唯一允许调用 rendition.display() 的入口 */
  async function safeDisplay(cfiOrHref, reason) {
    if (!rendition) return;
    if (isResizeLocked() && reason !== "toc-jump" && reason !== "bookmark-jump") {
      readerLog("blocked display during resize", {
        reason,
        cfi: cfiOrHref || "",
      });
      return;
    }
    dlog("display", { reason, target: cfiOrHref || "(start)" });

    if (shouldBlockDisplay(reason)) {
      dlog("display blocked", { reason });
      return;
    }

    isProgrammaticDisplay = true;
    chapterSwitchCooldownUntil = Date.now() + CHAPTER_SWITCH_COOLDOWN_MS;
    try {
      await rendition.display(cfiOrHref || undefined);
      if (reason === "section-prev" || reason === "section-next") {
        applyEpubTypographyTheme();
        applyReaderTheme(readerThemeNow());
      } else {
        scheduleReaderThemeReapply();
      }
    } finally {
      setTimeout(() => {
        isProgrammaticDisplay = false;
      }, 500);
    }
  }

  async function openBookAtSavedLocation() {
    isRestoringOpenBookPosition = true;
    progressFrozenUntilUserScroll = false;
    resizeSnapshot = null;

    try {
      await nextAnimationFrame();
      await nextAnimationFrame();
      await refreshBookRecordFromStore("before-restore");
      await claimReaderSession("openBook");

      const saved = {
        currentSpineIndex: bookRecord?.currentSpineIndex,
        chapterScrollRatio: bookRecord?.chapterScrollRatio,
        progress: bookRecord?.progress,
      };
      const pinnedProgress =
        typeof saved.progress === "number"
          ? saved.progress
          : derivedProgressFromRecord(bookRecord, bookRecord?.totalSpineItems);
      beginRestoreVisual(pinnedProgress);

      if (
        Number.isInteger(saved.currentSpineIndex) &&
        saved.currentSpineIndex >= 0 &&
        typeof saved.chapterScrollRatio === "number"
      ) {
        const ok = await restoreBySpineRatio(saved, "open-book");
        if (ok) return;
      }

      readerLog("restore by spine ratio fallback start", { reason: "open-book-start" });
      await safeDisplay(null, "open-book-start");
    } finally {
      isRestoringOpenBookPosition = false;
      if (!restoreVisualReady) {
        await markRestoreVisualReady();
        scheduleOpenRestoreSettle();
      }
    }
  }

  async function openBook(arrayBuffer) {
    readerLog("open book", {
      bookId,
      savedCurrentSpineIndex: bookRecord ? bookRecord.currentSpineIndex : undefined,
      savedChapterScrollRatio: bookRecord ? bookRecord.chapterScrollRatio : undefined,
      savedProgress: bookRecord ? bookRecord.progress : undefined,
      savedCurrentLocation: bookRecord ? bookRecord.currentLocation : undefined,
    });
    ensureDebugOverlay();
    hideBookmarkPanel();

    book = ePub(arrayBuffer);

    // 单章节纵向滚动：default manager，无 continuous prepend，边界切章由 goNext/Previous 负责
    rendition = book.renderTo("viewer", {
      flow: "scrolled-doc",
      manager: "default",
      width: "100%",
      height: "100%",
      spread: "none",
      allowScriptedContent: false,
    });

    rendition.started
      .then(() => {
        bindReaderScrollListener();
        bindWheelForwarding();
        bindReaderResizeObserver();
        applyReaderLayout();
        rendition.on("rendered", () => {
          bindReaderScrollListener();
          bindWheelForwarding();
          scheduleReaderThemeReapply();
        });
      })
      .catch(() => {});

    applyEpubTypographyTheme();
    applyReaderTheme(readerThemeNow());

    rendition.hooks.content.register((contents) => {
      const idoc = contents.document;
      scheduleReaderThemeReapply();
      idoc.addEventListener("mouseup", (e) => onIframeMouseUp(e, contents));
      idoc.addEventListener("contextmenu", (e) => onIframeContextMenu(e, contents));
      idoc.addEventListener(
        "scroll",
        () => {
          if (lookup.hasTrigger() && !lookup.isPending()) lookup.removeTrigger();
        },
        true
      );
      idoc.addEventListener("mousedown", onIframeMouseDown);
      bindReaderContentDoc(idoc);
      bindWheelTarget(idoc);
    });

    rendition.on("relocated", onRelocated);
    rendition.on("relocated", () => {
      scheduleReaderThemeReapply();
    });

    openBookAtSavedLocation()
      .then(() => {
        hideMessage();
        deferLocationsGeneration();
      })
      .catch(() => {
        safeDisplay(null, "open-book-start")
          .then(() => {
            hideMessage();
            deferLocationsGeneration();
          })
          .catch(() => {
            showMessage("无法渲染该 EPUB。");
          });
      });

    book.loaded.navigation
      .then((nav) => {
        navMap = nav;
        void loadBookToc();
      })
      .catch(() => {
        void loadBookToc();
      });
  }

  // 生成 locations 以计算阅读进度（较重；等用户停止滚动后再后台进行）
  function deferLocationsGeneration() {
    clearTimeout(locationsGenTimer);
    locationsGenTimer = setTimeout(() => {
      if (isRecentUserScroll()) {
        deferLocationsGeneration();
        return;
      }
      startLocationsGeneration();
    }, 4000);
  }

  function startLocationsGeneration() {
    if (locationsReady || !book) return;
    dlog("locations.generate start");
    book.ready
      .then(() => book.locations.generate(1600))
      .then(() => {
        locationsReady = true;
        dlog("locations.generate done");
        if (currentCfi) updateProgressFromCfi(currentCfi);
      })
      .catch(() => {});
  }

  function chapterLabelForHref(href) {
    if (!navMap || !href) return "";
    try {
      const item = navMap.get(href) || navMap.get(href.split("#")[0]);
      return item ? item.label.trim() : "";
    } catch {
      return "";
    }
  }

  // ── 进度 ─────────────────────────────────────────────────────────────────────

  function onRelocated(location) {
    if (!location || !location.start) {
      dlog("relocated empty");
      return;
    }

    const newCfi = location.start.cfi;
    if (!newCfi) {
      dlog("relocated missing cfi");
      return;
    }

    if (isResizeStateFrozen()) {
      posDbg("ignore relocated during resize", `cfi=${newCfi}`);
      return;
    }

    currentCfi = newCfi;

    if (location.start.href) {
      currentChapterLabel = chapterLabelForHref(location.start.href) || currentChapterLabel;
      highlightActiveTocByHref(location.start.href);
    }

    if (isRestoringOpenBookPosition) {
      posLog("ignore relocated during restore", `cfi=${newCfi}`);
      return;
    }

    if (isHardRestoring() || isSoftSuppressed() || isResizeLocked()) {
      posDbg("ignore relocated during restore/resize", `cfi=${newCfi}`);
      return;
    }

    posLog("relocated", `cfi=${newCfi} isRestoring=${isRestoringOpenBookPosition}`);
  }

  function updateProgressFromCfi() {
    updateProgressUI(calculateGlobalProgress(), "cfi");
  }

  function updateProgressUI(progress, reason) {
    const source = reasonLabel(reason, "unknown");

    if (isSectionSwitching && source !== "section-switch-done") {
      if (typeof storedRestoreProgress === "number") {
        renderProgress(storedRestoreProgress);
      }
      return;
    }

    const allowDuringHardRestore =
      source === "restore-final" || source === "section-switch-done";
    const allowDuringResizeFreeze = source === "resize-freeze-restore";
    const userLiveScroll = source === "scroll-live" && isRealUserScrollRecently();
    const allowImmediateProgress =
      userLiveScroll ||
      source === "toc-jump" ||
      source === "bookmark-jump" ||
      source === "width-mode" ||
      allowDuringHardRestore ||
      allowDuringResizeFreeze;

    if (isResizeStateFrozen() && !allowImmediateProgress) {
      const frozenProgress =
        resizeFrozenState?.progress ??
        calculateProgressFromSpineAndRatio(currentSpineIndex, currentChapterScrollRatio);
      posDbg("skip UI progress update during resize freeze", source, {
        reason: source,
        attemptedProgress: progress,
        frozenProgress: posFmtProgress(frozenProgress),
      });
      renderProgress(frozenProgress);
      return;
    }

    if (isHardRestoring() && !allowImmediateProgress) {
      const pinned =
        typeof storedRestoreProgress === "number"
          ? storedRestoreProgress
          : typeof bookRecord?.progress === "number"
            ? bookRecord.progress
            : progress;
      readerLog("skip progress UI update during hard restore", {
        reason: source,
        attemptedProgress: progress,
        pinnedProgress: pinned,
      });
      renderProgress(pinned);
      return;
    }
    if (
      isSoftSuppressed() &&
      source !== "restore-final" &&
      source !== "section-switch-done" &&
      source !== "scroll-live" &&
      source !== "toc-jump" && source !== "bookmark-jump"
    ) {
      posDbg("skip UI progress update", "resize-suppressed", {
        reason: source,
        attemptedProgress: progress,
      });
      return;
    }
    if (isProgressStateFrozen() && source !== "scroll-live" && source !== "toc-jump" && source !== "bookmark-jump") {
      posDbg("skip UI progress update", "progress-frozen", {
        reason: source,
        attemptedProgress: progress,
      });
      return;
    }
    if (DEBUG_READER) {
      posLog(
        "UI progress update",
        `source=${source} progress=${posFmtProgress(progress)}`,
        { reason: source }
      );
    }
    renderProgress(progress);
  }

  function calculateGlobalProgress() {
    if (progressFrozenUntilUserScroll && resizeSnapshot) {
      return resizeSnapshot.progress;
    }
    const ratio = getLiveChapterScrollRatio(getReaderScrollElement());
    return calculateProgressFromSpineAndRatio(currentSpineIndex, ratio);
  }

  function applyProgressPatchToBookRecord(patch) {
    if (!bookRecord) return;
    if (typeof patch.progress === "number") bookRecord.progress = patch.progress;
    if (patch.currentLocation !== undefined) bookRecord.currentLocation = patch.currentLocation;
    if (typeof patch.currentSpineIndex === "number") {
      bookRecord.currentSpineIndex = patch.currentSpineIndex;
    }
    if (typeof patch.chapterScrollRatio === "number") {
      bookRecord.chapterScrollRatio = patch.chapterScrollRatio;
    }
    if (typeof patch.totalSpineItems === "number") {
      bookRecord.totalSpineItems = patch.totalSpineItems;
    }
    if (patch.readingAnchor) bookRecord.readingAnchor = patch.readingAnchor;
    if (patch.lastReadAt) bookRecord.lastReadAt = patch.lastReadAt;
  }

  function readLiveScrollMetrics(options = {}) {
    const allowMutateRatio = options.allowMutateRatio === true;
    const scrollEl = getReaderScrollElement();
    if (!scrollEl) {
      return {
        scrollEl: null,
        scrollTop: 0,
        clientHeight: 0,
        scrollHeight: 0,
        maxScroll: 0,
        ratio: currentChapterScrollRatio || 0,
        liveRatio: currentChapterScrollRatio || 0,
        scrollElTag: "none",
      };
    }
    const scrollTop = scrollEl.scrollTop;
    const clientHeight = scrollEl.clientHeight;
    const scrollHeight = scrollEl.scrollHeight;
    const maxScroll = Math.max(0, scrollHeight - clientHeight);
    const liveRatio = maxScroll > 0 ? clampRatio(scrollTop / maxScroll) : 0;
    if ((!isProgressStateFrozen() && !isResizeStateFrozen()) || allowMutateRatio) {
      currentChapterScrollRatio = liveRatio;
    }
    const ratio =
      (isProgressStateFrozen() || isResizeStateFrozen()) && !allowMutateRatio
        ? resizeFrozenState
          ? resizeFrozenState.chapterScrollRatio
          : resizeSnapshot
            ? resizeSnapshot.chapterScrollRatio
            : currentChapterScrollRatio
        : liveRatio;
    const scrollElTag =
      scrollEl.id ||
      (scrollEl.className && String(scrollEl.className).split(" ")[0]) ||
      scrollEl.tagName;
    return {
      scrollEl,
      scrollTop,
      clientHeight,
      scrollHeight,
      maxScroll,
      ratio,
      liveRatio,
      scrollElTag,
    };
  }

  function scheduleScrollSave() {
    if (isHardRestoring() || isResizeStateFrozen()) {
      return;
    }
    if (isProgressStateFrozen()) {
      return;
    }
    if (!hasRecentUserScrollForProgress()) {
      return;
    }
    scrollSavePending = true;
    clearTimeout(scrollSaveTimer);
    scrollSaveTimer = setTimeout(async () => {
      scrollSavePending = false;
      if (isRestoringPosition || isProgrammaticDisplay || isRestoringOpenBookPosition) {
        return;
      }
      if (!canTriggerScrollDebouncePersist()) {
        return;
      }
      debugPositionSnapshot("scroll-debounce-before-persist");
      await persistReadingPosition("scroll-debounce");
    }, 300);
  }

  async function persistReadingPosition(reason, options = {}) {
    const force = options.force === true || options.forceWrite === true;
    const flushOnLeave = options.flushOnLeave === true;
    const metricsOverride = options.metricsOverride || null;
    if (!bookId) return false;

    if (
      !force &&
      !flushOnLeave &&
      (isHardRestoring() || isSoftSuppressed()) &&
      reason === "scroll-debounce"
    ) {
      posDbg("skip scroll persist", "during restore/soft suppress");
      return false;
    }

    if (
      flushOnLeave &&
      (isHardRestoring() || isRestoringOpenBookPosition || isRestoringPosition)
    ) {
      posDbg("skip leave flush", "during restore");
      return false;
    }

    if (!canPersistPosition(reason, options)) {
      const totalSpineItems = getTotalSpineItems();
      const memProgress = calculateProgressFromSpineRatio(
        currentSpineIndex,
        currentChapterScrollRatio,
        totalSpineItems
      );
      console.warn(
        `[ZEH_POS] skip persist disallowed reason=${reason} progress=${posFmtProgress(memProgress)} spine=${currentSpineIndex} ratio=${posFmtRatio(currentChapterScrollRatio)}`,
        { reason, options, currentSpineIndex, currentChapterScrollRatio, currentProgress: memProgress }
      );
      return false;
    }

    if (reason === "scroll-debounce" && !flushOnLeave && !canTriggerScrollDebouncePersist()) {
      return false;
    }

    if (isProgressStateFrozen() && reason !== "back-to-shelf" && reason !== "toc-jump" && reason !== "bookmark-jump" && !flushOnLeave) {
      posLog("skip persist during resize", `reason=${reason}`);
      return false;
    }

    posLog("persist start", `reason=${reason}`);

    const metrics =
      metricsOverride && metricsOverride.valid !== false
        ? metricsOverride
        : readLiveScrollMetricsForPersist(reason);
    if (!metrics || metrics.valid === false) {
      readerWarn("skip persist invalid metrics", { reason });
      return false;
    }

    const mySeq = ++_persistSeq;
    const {
      scrollTop,
      maxScroll,
      spineIndex: spineIndexForSave,
      chapterScrollRatio: ratio,
      totalSpineItems,
    } = metrics;
    const progress = calculateProgressFromSpineRatio(
      spineIndexForSave,
      ratio,
      totalSpineItems
    );
    const derivedProgress = progress;
    const loc = currentCfi || "";
    const now = Date.now();

    const patch = {
      progress,
      derivedProgress,
      currentLocation: loc,
      currentSpineIndex: spineIndexForSave,
      chapterScrollRatio: ratio,
      totalSpineItems,
      lastReadAt: now,
      updatedBySessionId: readerSessionId,
      forceWrite: force,
    };
    readerDebug(
      `[ZEH_POS] persist patch reason=${reason} progress=${posFmtProgress(progress)} ratio=${posFmtRatio(ratio)} spine=${spineIndexForSave}`,
      { reason, patch, scrollTop, maxScroll }
    );

    const activeSessionId = bookRecord && bookRecord.activeReaderSessionId;
    const isActive = !activeSessionId || activeSessionId === readerSessionId;

    if (!isActive) {
      readerWarn("skip persist inactive session", {
        reason,
        readerSessionId,
        activeReaderSessionId: activeSessionId,
      });
      return false;
    }

    if (reason === "back-to-shelf" || reason === "scroll-debounce") {
      lastFlushReason = reason;
    }

    try {
      const result = await ZEHBookStore.updateBookProgress(
        bookId,
        {
          progress,
          currentLocation: loc,
          currentSpineIndex: spineIndexForSave,
          chapterScrollRatio: ratio,
          totalSpineItems,
          lastReadAt: now,
          updatedBySessionId: readerSessionId,
          forceWrite: force,
          persistReason: reason,
        },
        { readerSessionId, force, persistReason: reason }
      );

      if (mySeq !== _persistSeq) {
        readerLog("persist superseded", { reason, mySeq, latestSeq: _persistSeq });
        return false;
      }

      if (result && result.skipped) {
        if (result.reason === "stale-session" && bookRecord && result.book && result.book.activeReaderSessionId) {
          bookRecord.activeReaderSessionId = result.book.activeReaderSessionId;
        }
        readerWarn("skip flush stale session", {
          reason: result.reason,
          flushReason: reason,
          bookId,
          readerSessionId,
          activeReaderSessionId: result.book && result.book.activeReaderSessionId,
        });
        return false;
      }

      lastSavedAt = now;
      if (bookRecord) bookRecord.activeReaderSessionId = readerSessionId;

      posLog(
        "persisted position",
        `reason=${reason} progress=${posFmtProgress(progress)} ratio=${posFmtRatio(ratio)} spine=${spineIndexForSave} derived=${posFmtProgress(derivedProgress)}`,
        {
          reason,
          currentSpineIndex: spineIndexForSave,
          chapterScrollRatio: ratio,
          progress,
          derivedProgress,
          totalSpineItems,
          scrollTop,
          maxScroll,
        }
      );

      applyProgressPatchToBookRecord({
        progress,
        currentLocation: loc,
        currentSpineIndex: spineIndexForSave,
        chapterScrollRatio: ratio,
        totalSpineItems,
        lastReadAt: now,
      });
      lastPersistedSnapshot = {
        spineIndex: spineIndexForSave,
        chapterScrollRatio: ratio,
        progress,
        at: now,
      };
      writePositionCacheNow(
        {
          spineIndex: spineIndexForSave,
          chapterScrollRatio: ratio,
          progress,
          totalSpineItems,
        },
        reason
      );
      await debugStoredBook("persist-after-" + reason);
      updateDebugOverlay();
      return true;
    } catch (err) {
      readerWarn("persist failed", { reason, err });
      return false;
    }
  }

  // ── 书签 ───────────────────────────────────────────────────────────────────────

  /** CFI 所在的 spine 序号（epub.js 的 spine.get 接受 epubcfi(...)），解析失败返回 -1 */
  function spineIndexForCfi(cfi) {
    if (!book || !book.spine || !cfi) return -1;
    try {
      const section = book.spine.get(cfi);
      if (section && Number.isInteger(section.index) && section.index >= 0) return section.index;
    } catch {
      /* noop */
    }
    return -1;
  }

  /** 书签跳转：显示后同步 currentSpineIndex / 进度，并按 bookmark-jump 原因持久化（R-09） */
  async function jumpTo(cfi) {
    if (!cfi || !rendition) return;
    lastUserScrollAt = 0;
    wheelBoundaryAccum = 0;
    releaseRestoreLocksForUserScroll("bookmark-jump");
    try {
      await safeDisplay(cfi, "bookmark-jump");
    } catch {
      showToast("该书签位置已失效");
      return;
    }
    const spineIndex = spineIndexForCfi(cfi);
    if (spineIndex >= 0) {
      setCurrentSpineIndex(spineIndex, "bookmark-jump");
      highlightActiveTocBySpine(spineIndex, book?.spine?.get(spineIndex)?.href || "");
    }
    const metrics = readLiveScrollMetricsForPersist("bookmark-jump");
    if (metrics && metrics.valid !== false && Number.isFinite(metrics.progress)) {
      currentChapterScrollRatio = metrics.chapterScrollRatio;
      syncLiveProgressUI(metrics, "bookmark-jump");
    }
    void persistReadingPosition("bookmark-jump");
  }

  let toastTimer = null;
  function showToast(text) {
    showMessage(text);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideMessage, 1800);
  }

  // ── 查词面板：点击外部关闭（含 EPUB iframe）────────────────────────────────────

  // 判断点击目标是否落在查词 UI（小球 / 面板 / 其按钮 / 刷新横幅）内
  function isInsideZehUI(target) {
    if (lookup.isOurElement(target)) return true;
    return Boolean(
      target &&
        typeof target.closest === "function" &&
        target.closest(".zeh-trigger, .zeh-panel, .zeh-refresh-banner, [data-zeh-ui]")
    );
  }

  // 顶层 reader 文档：结果面板已显示且非 loading 时，点击面板外部则关闭
  function handleOutsidePointerDown(event) {
    if (lookup.hasPanel()) {
      if (lookup.isPending()) return;
      if (isInsideZehUI(event.target)) return;
      lookup.hideAll();
    }
    if (bookmarkPanelOpen() && els.bookmarkPanel && !els.bookmarkPanel.hidden) {
      if (els.bookmarkPanel.contains(event.target)) return;
      if (els.toggleBookmarksBtn && els.toggleBookmarksBtn.contains(event.target)) return;
      hideBookmarkPanel();
      updateThemePanelPosition();
    }
  }

  // EPUB iframe 文档：面板挂在外层，iframe 内任何点击都属于“外部点击”
  function handleReaderIframePointerDown() {
    if (!lookup.hasPanel()) return;
    if (lookup.isPending()) return;
    lookup.hideAll();
  }

  // 防止 epub.js 反复 rendered 时对同一 document 重复绑定
  const boundReaderDocs = new WeakSet();
  function bindReaderContentDoc(idoc) {
    if (!idoc || boundReaderDocs.has(idoc)) return;
    boundReaderDocs.add(idoc);
    idoc.addEventListener("pointerdown", handleReaderIframePointerDown, true);
  }

  // ── 事件绑定 ───────────────────────────────────────────────────────────────────

  // capture=true 更早触发，避免被 selection / 子元素吃掉；pointerdown 比 click 更可靠
  document.addEventListener("pointerdown", handleOutsidePointerDown, true);

  els.backBtn.addEventListener("click", async (e) => {
    e.preventDefault();
    els.backBtn.disabled = true;
    isLeavingReader = true;
    try {
      clearTimeout(scrollSaveTimer);
      posLog("back to shelf before persist", "");
      debugPositionSnapshot("back-to-shelf-before-persist");
      await debugStoredBook("back-to-shelf-before-persist");
      await persistReadingPosition("back-to-shelf", { force: true });
      posLog("back to shelf after persist", "");
      debugPositionSnapshot("back-to-shelf-after-persist");
      await debugStoredBook("back-to-shelf-after-persist");
      const stored = await ZEHBookStore.getBook(bookId);
      if (stored) {
        readerDebug(
          `[ZEH_POS] back-to-shelf stored final progress=${posFmtProgress(stored.progress)} ratio=${posFmtRatio(stored.chapterScrollRatio)} spine=${stored.currentSpineIndex}`,
          stored
        );
      }
      const totalSpineItems = stored?.totalSpineItems || getTotalSpineItems();
      const derivedProgress = derivedProgressFromRecord(stored, totalSpineItems);
      readerLog("verify stored position", {
        currentSpineIndex: stored?.currentSpineIndex,
        chapterScrollRatio: stored?.chapterScrollRatio,
        progress: stored?.progress,
        derivedProgress,
        totalSpineItems,
        lastReadAt: stored?.lastReadAt,
      });
      if (
        stored &&
        typeof stored.progress === "number" &&
        typeof derivedProgress === "number" &&
        Math.abs(stored.progress - derivedProgress) > 0.002
      ) {
        readerWarn("ERROR stored progress mismatch ratio", {
          progress: stored.progress,
          derivedProgress,
          currentSpineIndex: stored.currentSpineIndex,
          chapterScrollRatio: stored.chapterScrollRatio,
          totalSpineItems,
        });
      }

      const settingsUrl = chrome.runtime.getURL("settings.html#reading");
      const settingsBase = chrome.runtime.getURL("settings.html");
      const tabs = await chrome.tabs.query({});
      const settingsTab = tabs.find(
        (tab) => tab.url && tab.url.startsWith(settingsBase)
      );
      if (settingsTab && settingsTab.id != null) {
        await chrome.tabs.update(settingsTab.id, { active: true, url: settingsUrl });
        if (settingsTab.windowId != null) {
          await chrome.windows.update(settingsTab.windowId, { focused: true });
        }
      } else {
        await chrome.tabs.create({ url: settingsUrl });
      }

      let closed = false;
      try {
        const currentTab = await chrome.tabs.getCurrent();
        if (currentTab && currentTab.id != null) {
          await chrome.tabs.remove(currentTab.id);
          closed = true;
        }
      } catch {
        /* fallback below */
      }
      if (!closed) {
        window.close();
      }
    } catch {
      location.href = chrome.runtime.getURL("settings.html#reading");
    }
  });

  els.fontDecBtn.addEventListener("click", () => changeFontSize(-FONT_STEP));
  els.fontIncBtn.addEventListener("click", () => changeFontSize(FONT_STEP));

  if (els.widthNarrowBtn) {
    els.widthNarrowBtn.addEventListener("click", () => changeWidthMode("narrow"));
  }
  if (els.widthNormalBtn) {
    els.widthNormalBtn.addEventListener("click", () => changeWidthMode("normal"));
  }
  if (els.widthWideBtn) {
    els.widthWideBtn.addEventListener("click", () => changeWidthMode("wide"));
  }

  els.addBookmarkBtn.addEventListener("click", () => {
    addBookmark(currentCfi, currentChapterLabel);
  });

  els.toggleBookmarksBtn.addEventListener("click", () => {
    toggleBookmarkPanel();
  });

  els.closeBookmarksBtn.addEventListener("click", hideBookmarkPanel);
  els.bookmarkList.addEventListener("click", onBookmarkListClick);

  els.ctxAddBookmark.addEventListener("click", () => {
    hideCtxMenu();
    addBookmark(pendingCtx.cfi, pendingCtx.excerpt);
  });

  // 点击空白处关闭右键菜单
  document.addEventListener("mousedown", (e) => {
    if (els.ctxMenu && !els.ctxMenu.hidden && !els.ctxMenu.contains(e.target)) {
      hideCtxMenu();
    }
  });

  // 顶层 capture scroll：移除遗留小球（阅读滚动由 bindReaderScrollListener 追踪）
  window.addEventListener(
    "scroll",
    () => {
      if (lookup.hasTrigger() && !lookup.isPending()) lookup.removeTrigger();
    },
    { passive: true, capture: true }
  );

  window.addEventListener(
    "resize",
    () => {
      scheduleReaderResize("window-resize");
    },
    { passive: true }
  );

  // 离开页面：刷新前 flush 未落盘的 scroll-debounce
  window.addEventListener("pagehide", () => {
    flushPendingScrollPersist("pagehide");
  });
  window.addEventListener("beforeunload", () => {
    flushPendingScrollPersist("beforeunload");
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      if (!isLeavingReader) {
        flushPendingScrollPersist("visibility-hidden");
      }
    } else {
      claimReaderSession("visibility-visible");
    }
  });

  init();
})();
