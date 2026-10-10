/**
 * content.js — 网页划词适配层
 *
 * 查词 UI 在 mk-lookup.js（MKLookup.createController）。
 * 本文件只负责把顶层文档的 mouseup / mousedown / selectionchange / scroll 等
 * 事件接到共享控制器上。reader.js 用同一个控制器指向 EPUB iframe。
 */
(function () {
  if (window.__ZEH_PDF_PAGE__) return;
  // 同一个 content-script 世界只启动一次：脚本被重复执行时不再挂第二套监听器（0.11.1）
  if (window.__MK_CONTENT_BOOTSTRAPPED__) return;

  function isSameOriginWindow(win) {
    try {
      if (!win) return false;
      void win.location.href;
      void win.document;
      return true;
    } catch {
      return false;
    }
  }

  function safeAddEventListener(target, type, handler, options, label) {
    try {
      if (!target || typeof target.addEventListener !== "function") return false;
      target.addEventListener(type, handler, options);
      return true;
    } catch (err) {
      zehDebugLog("[Manekilex] skip addEventListener due to cross-origin", {
        type,
        label: label || "",
        message: String(err?.message || err).slice(0, 160),
      });
      return false;
    }
  }

  try {
    if (isSameOriginWindow(window.top)) {
      const topPath = window.top.location.pathname + window.top.location.search;
      if (zehIsPdfViewerUrl(topPath)) return;
    }
  } catch {
    /* cross-origin top — not a direct browser PDF tab */
  }

  function detectAggressiveBubbleMode() {
    const host = (location.hostname || "").toLowerCase();
    return (
      host === "chatgpt.com" ||
      host === "chat.openai.com" ||
      host === "feishu.cn" ||
      host.endsWith(".feishu.cn") ||
      host === "larksuite.com" ||
      host.endsWith(".larksuite.com")
    );
  }

  const aggressiveBubbleMode = detectAggressiveBubbleMode();

  /** iframe 内选词时把面板挂到顶层窗口（仅同源）；跨域则回退当前 frame */
  function resolveLookupUiHost(localWin) {
    let offsetLeft = 0;
    let offsetTop = 0;
    let uiWin = localWin;
    let uiDoc = localWin.document;
    let uiMountEl = localWin.document.body || localWin.document.documentElement;
    let canUseTop = false;

    try {
      let w = localWin;

      while (w !== w.top) {
        const parentWin = w.parent;

        if (!isSameOriginWindow(parentWin)) {
          canUseTop = false;
          break;
        }

        const frame = w.frameElement;
        if (!frame) {
          canUseTop = false;
          break;
        }

        const fr = frame.getBoundingClientRect();
        offsetLeft += fr.left;
        offsetTop += fr.top;

        w = parentWin;
      }

      if (w === localWin.top && w !== localWin && isSameOriginWindow(w)) {
        uiWin = w;
        uiDoc = w.document;
        uiMountEl = uiDoc.body || uiDoc.documentElement;
        canUseTop = true;
      }
    } catch {
      uiWin = localWin;
      uiDoc = localWin.document;
      uiMountEl = localWin.document.body || localWin.document.documentElement;
      offsetLeft = 0;
      offsetTop = 0;
      canUseTop = false;
    }

    return {
      uiWin,
      uiDoc,
      uiMountEl,
      viewportRectOffset: canUseTop ? { left: offsetLeft, top: offsetTop } : { left: 0, top: 0 },
      isTopHost: canUseTop,
      isCrossOriginFrame: localWin !== localWin.top && !canUseTop,
    };
  }

  window.__MK_CONTENT_BOOTSTRAPPED__ = true;

  const uiHost = resolveLookupUiHost(window);

  let loggedCrossOriginFallback = false;
  if (uiHost.isCrossOriginFrame && !loggedCrossOriginFallback) {
    zehDebugLog("[Manekilex] cross-origin frame fallback to local UI host", {
      host: location.hostname,
    });
    loggedCrossOriginFallback = true;
  }

  const controller = window.MKLookup.createController({
    win: window,
    doc: document,
    uiDoc: uiHost.uiDoc,
    viewportWin: uiHost.uiWin,
    mountEl: uiHost.uiMountEl,
    bubbleMountEl: uiHost.uiMountEl,
    viewportRectOffset: uiHost.viewportRectOffset,
    aggressiveBubbleMode,
  });

  let lastMouseRelease = { x: 0, y: 0, t: 0 };
  let selectionChangeTimer = null;
  let pointerSelecting = false;
  /** pointerSelecting 置位时间：拖选在窗口外松手时收不到 pointerup，过期后自动复位 */
  let pointerSelectingSince = 0;
  const POINTER_SELECTING_MAX_MS = 8000;
  let lastPointerUpAt = 0;
  let lastFieldSnapshot = null;
  let hideTriggerTimer = null;

  function isInsideLookupUI(e) {
    return controller.isInsideLookupUI(e?.target, e);
  }

  /** 全局关闭时跳过一切选区读取 / repair / 深度扫描（R-22） */
  function isLookupEnabled() {
    return window.MKLookup.isGlobalEnabled();
  }

  /**
   * 扩展被重新加载 / 更新后，本页的旧 content script 已失效（Chrome 不会给已打开的页面重新注入）。
   * 以前这里静默返回，小球「莫名消失」；现在用户一选中文字就给出「请刷新页面」横幅（只显示一次）。
   */
  function noticeInvalidatedOnSelection() {
    try {
      const text = String(document.getSelection?.()?.toString() || "").trim();
      const field = document.activeElement;
      const fieldHasSelection =
        field &&
        typeof field.selectionStart === "number" &&
        field.selectionEnd > field.selectionStart;
      if (text || fieldHasSelection) controller.markExtensionDead();
    } catch {
      /* noop */
    }
  }

  function buildFieldSnapshotFromTarget(target) {
    if (!target || !controller.isTextInputField(target)) return null;
    const start = target.selectionStart;
    const end = target.selectionEnd;
    if (start == null || end == null || start === end) return null;
    return { el: target, start, end };
  }

  function presentSelectionTrigger(releaseX, releaseY, fieldSnapshot) {
    if (!isLookupEnabled()) return;
    const snapshot = fieldSnapshot || lastFieldSnapshot;
    const info = controller.getSelectionInfo(snapshot ? { fieldSnapshot: snapshot } : undefined);
    if (!info?.text) {
      if (!controller.shouldKeepTriggerVisible()) {
        controller.removeTriggerAndClearCache();
      }
      return;
    }

    controller.storeSelectionSnapshot(info, "web-selection-bubble");
    const payload = { ...info, source: "web-selection-bubble" };
    if (releaseX !== undefined && releaseY !== undefined) {
      payload.releaseX = releaseX + uiHost.viewportRectOffset.left;
      payload.releaseY = releaseY + uiHost.viewportRectOffset.top;
    }
    controller.presentTrigger(payload);
  }

  function scheduleAggressiveSelectionRetries(releaseX, releaseY, fieldSnapshot) {
    if (!aggressiveBubbleMode) return;
    [50, 150].forEach((ms) => {
      setTimeout(() => {
        if (!controller.isExtensionAlive()) return;
        if (controller.hasPanel() || controller.hasTrigger()) return;
        presentSelectionTrigger(releaseX, releaseY, fieldSnapshot);
      }, ms);
    });
  }

  function syncCaptureSelection(fieldSnapshot) {
    const info = controller.getSelectionInfo(
      fieldSnapshot ? { fieldSnapshot } : undefined
    );
    if (info?.text) {
      controller.storeSelectionSnapshot(info, "web-selection-sync");
    }
    return info;
  }

  function tryPresentAfterPointerUp(releaseX, releaseY, fieldSnapshot) {
    if (controller.hasPanel() && controller.isPending()) return;

    if (controller.hasPanel()) {
      const info = controller.getSelectionInfo(
        fieldSnapshot ? { fieldSnapshot } : undefined
      );
      if (!info) return;
      controller.hideAll();
    }

    presentSelectionTrigger(releaseX, releaseY, fieldSnapshot);
    scheduleAggressiveSelectionRetries(releaseX, releaseY, fieldSnapshot);
  }

  function scheduleHideTriggerOnBlankPointer() {
    const delay = controller.getDocumentHideDelayMs();
    clearTimeout(hideTriggerTimer);
    hideTriggerTimer = setTimeout(() => {
      hideTriggerTimer = null;
      if (controller.hasPanel() || controller.isPending()) return;
      if (controller.isBubblePointerActive?.()) return;
      if (controller.shouldKeepTriggerVisible()) return;
      controller.removeTriggerAndClearCache();
    }, delay);
  }

  function onPointerUp(e) {
    if (!isLookupEnabled()) {
      pointerSelecting = false;
      return;
    }
    if (!controller.isExtensionAlive()) {
      noticeInvalidatedOnSelection();
      return;
    }
    // 任何按键松开都结束「正在拖选」状态（以前右键松开时提前 return，导致之后键盘选区不再出小球）
    pointerSelecting = false;
    if (isInsideLookupUI(e)) return;
    if (e.button !== undefined && e.button !== 0) return;
    // 点小球那一下的 mouseup（小球已移除，事件落在 body 上）不是新的选区
    if (controller.wasTriggerJustActivated?.()) return;

    const now = Date.now();
    if (now - lastPointerUpAt < 40) return;
    lastPointerUpAt = now;

    const releaseX = e.clientX;
    const releaseY = e.clientY;
    lastMouseRelease = { x: releaseX, y: releaseY, t: Date.now() };
    pointerSelecting = false;

    const fieldSnapshot =
      buildFieldSnapshotFromTarget(e.target) || controller.captureFieldSelectionSnapshot();
    lastFieldSnapshot = fieldSnapshot;

    if (fieldSnapshot) {
      syncCaptureSelection(fieldSnapshot);
      tryPresentAfterPointerUp(releaseX, releaseY, fieldSnapshot);
      return;
    }

    syncCaptureSelection(null);

    const delay = aggressiveBubbleMode ? 0 : 30;
    setTimeout(() => {
      if (!controller.isExtensionAlive()) return;
      tryPresentAfterPointerUp(releaseX, releaseY, null);
      scheduleAggressiveSelectionRetries(releaseX, releaseY, null);
    }, delay);
  }

  function onMouseUp(e) {
    onPointerUp(e);
  }

  function onPointerDown(e) {
    if (!controller.isExtensionAlive()) return;
    if (isInsideLookupUI(e) || controller.isBubblePointerActive?.()) {
      clearTimeout(hideTriggerTimer);
      return;
    }

    // 只有左键才可能开始拖选；右键 / 中键按下不再把 pointerSelecting 置位（松开时可能收不到 pointerup）
    pointerSelecting = e.button === undefined || e.button === 0;
    pointerSelectingSince = Date.now();
    lastFieldSnapshot = null;
    clearTimeout(hideTriggerTimer);

    if (controller.hasPanel()) {
      controller.hideAll();
      pointerSelecting = false;
      lastFieldSnapshot = null;
      return;
    }

    if (controller.getDocumentHideDelayMs() > 0) {
      scheduleHideTriggerOnBlankPointer();
      return;
    }

    controller.removeTriggerAndClearCache();
  }

  function onMouseDown(e) {
    onPointerDown(e);
  }

  function runSelectionChangePresent() {
    if (!isLookupEnabled()) return;
    if (controller.hasPanel() && controller.isPending()) return;
    if (pointerSelecting && Date.now() - pointerSelectingSince > POINTER_SELECTING_MAX_MS) {
      pointerSelecting = false;
    }
    if (pointerSelecting) return;

    const liveSnapshot = controller.captureFieldSelectionSnapshot();
    if (liveSnapshot) lastFieldSnapshot = liveSnapshot;

    const info = controller.getSelectionInfo(
      lastFieldSnapshot ? { fieldSnapshot: lastFieldSnapshot } : undefined
    );

    if (info?.text && !controller.hasPanel()) {
      const recentMouse = Date.now() - lastMouseRelease.t < 400;
      presentSelectionTrigger(
        recentMouse ? lastMouseRelease.x : undefined,
        recentMouse ? lastMouseRelease.y : undefined,
        lastFieldSnapshot
      );
    } else if (!info?.text && !controller.hasPanel()) {
      if (controller.shouldKeepTriggerVisible()) return;
      controller.removeTrigger();
    }
  }

  function onSelectionChange() {
    if (!isLookupEnabled()) return;
    if (controller.hasPanel() && controller.isPending()) return;

    clearTimeout(selectionChangeTimer);

    if (aggressiveBubbleMode) {
      [50, 150].forEach((ms) => {
        setTimeout(() => {
          if (!controller.isExtensionAlive()) return;
          runSelectionChangePresent();
        }, ms);
      });
    }

    const debounceMs = aggressiveBubbleMode ? 100 : 60;
    selectionChangeTimer = setTimeout(() => {
      if (!controller.isExtensionAlive()) return;
      runSelectionChangePresent();
    }, debounceMs);
  }

  function onTabInactive() {
    clearTimeout(hideTriggerTimer);
    controller.hideAll();
    lastFieldSnapshot = null;
  }

  function onFieldSelect(e) {
    if (!isLookupEnabled() || !controller.isExtensionAlive()) return;
    if (isInsideLookupUI(e)) return;

    const fieldSnapshot =
      buildFieldSnapshotFromTarget(e.target) || controller.captureFieldSelectionSnapshot();
    if (!fieldSnapshot) return;
    lastFieldSnapshot = fieldSnapshot;

    const recentMouse = Date.now() - lastMouseRelease.t < 400;
    const releaseX = recentMouse ? lastMouseRelease.x : undefined;
    const releaseY = recentMouse ? lastMouseRelease.y : undefined;

    if (controller.hasPanel() && controller.isPending()) return;
    if (controller.hasPanel()) controller.hideAll();
    presentSelectionTrigger(releaseX, releaseY, fieldSnapshot);
  }

  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("pointerup", onPointerUp, true);
  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("select", onFieldSelect, true);
  document.addEventListener("selectionchange", onSelectionChange, true);

  document.addEventListener("scroll", controller.scheduleTriggerPositionUpdate, {
    passive: true,
    capture: true,
  });

  safeAddEventListener(
    window,
    "resize",
    controller.scheduleTriggerPositionUpdate,
    { passive: true },
    "local-window"
  );

  if (uiHost.uiWin && uiHost.uiWin !== window && uiHost.isTopHost) {
    safeAddEventListener(
      uiHost.uiWin,
      "resize",
      controller.scheduleTriggerPositionUpdate,
      { passive: true },
      "uiHost-window"
    );
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      onTabInactive();
      return;
    }
    if (!controller.isExtensionAlive()) {
      controller.markExtensionDead();
    }
  });

  // 控制器的销毁 / bfcache 保留由 mk-lookup.js 按 event.persisted 处理（R-01）
  window.addEventListener("pagehide", onTabInactive);

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && controller.hasPanel()) {
        controller.hideAll();
      }
    },
    true
  );

  function syncManekilexEnabled(enabled) {
    window.MKLookup.setGlobalEnabled(enabled !== false);
  }

  function loadManekilexEnabled() {
    manekilexEnabled.reload();
  }

  window.addEventListener("pageshow", (event) => {
    if (!event.persisted) return;
    // 从 bfcache 恢复：同一个控制器继续使用；清掉离开前残留的指针 / 选区状态
    pointerSelecting = false;
    lastFieldSnapshot = null;
    clearTimeout(hideTriggerTimer);
    clearTimeout(selectionChangeTimer);
    if (!controller.isExtensionAlive()) {
      controller.markExtensionDead();
      return;
    }
    // 页面在 bfcache 中时可能错过开关变化，恢复后重新同步
    try {
      loadManekilexEnabled();
    } catch {
      controller.markExtensionDead();
    }
  });

  // 先读一次总开关，之后跟随弹窗切换（config.js）
  const manekilexEnabled = zehSubscribeEnabled(syncManekilexEnabled);
})();
