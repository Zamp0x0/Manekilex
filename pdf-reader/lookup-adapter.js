/**
 * pdf-reader/lookup-adapter.js — 把 PDF 阅读器里的划词接到现有的查词控制器（mk-lookup.js）
 *
 * 不复制查词逻辑：小猫气泡、查词面板、词典优先、语境增强、发音、复制、加入生词本、queryId
 * 过期保护全部来自 MKLookup.createController。这里只做 PDF 特有的三件事：
 *   1. 文本层渲染完成后建立该页的版面模型（context.js），并给文本层 span 标上条目序号；
 *   2. 选区 → 条目 + 偏移 → 所在段落里的语境窗口（kind: "snapshot"），跨段 / 跨页时不带语境；
 *      选区跨过换行或断词时，查询文字取版面模型里合并后的文字（不会把两栏拼在一起）；
 *   3. 生词本出处：{ title, fileName, url（只含协议 + 主机 + 路径）}，页码在划词当下记录。
 *
 * 依赖：config.js、mk-lookup.js、pdf-reader/context.js、pdf-reader/selection.js。
 * 暴露 window.ZEHPdfLookupAdapter。
 */
(function (global) {
  const MODEL_CACHE_SIZE = 24;
  const SELECTION_DEBOUNCE_MS = 80;

  /**
   * @param {{
   *   container: HTMLElement,                 PDF 滚动容器（#viewerContainer）
   *   getSource: () => ({ title?: string, fileName?: string, url?: string } | null),
   *   readerUrl: string,                      没有可保存的原地址时用作 pageUrl
   * }} options
   */
  function create(options) {
    const { container } = options;
    const ac = new AbortController();
    const listen = (target, type, fn, opts) => target.addEventListener(type, fn, { ...(opts || {}), signal: ac.signal });

    const lookup = global.MKLookup.createController({
      win: global,
      doc: global.document,
      mountEl: global.document.documentElement,
      vocabContext: () => {
        const src = options.getSource() || {};
        const pdf = {};
        if (src.title) pdf.title = src.title;
        if (src.fileName) pdf.fileName = src.fileName;
        if (src.url) pdf.url = src.url;
        return { pageUrl: src.url || options.readerUrl, pageTitle: src.title || src.fileName || "", pdf };
      },
    });

    zehSubscribeEnabled((enabled) => {
      global.MKLookup?.setGlobalEnabled?.(enabled);
    });

    const models = new Map(); // pageNumber → model（最近使用的在后）
    let generation = 0;
    let selectionTimer = null;
    let pointerSelecting = false;
    let lastRelease = { x: undefined, y: undefined, t: 0 };

    function rememberModel(pageNumber, model) {
      models.delete(pageNumber);
      models.set(pageNumber, model);
      while (models.size > MODEL_CACHE_SIZE) models.delete(models.keys().next().value);
    }

    function modelFor(pageNumber) {
      const model = models.get(pageNumber);
      if (model) rememberModel(pageNumber, model);
      return model || null;
    }

    /** PDFViewer 的 textlayerrendered：为这一页建模型并标记 span */
    async function onTextLayerRendered(pageView, pageNumber) {
      const gen = generation;
      const pdfPage = pageView?.pdfPage;
      const layerDiv = pageView?.textLayer?.div;
      if (!pdfPage || !layerDiv) return;
      try {
        let model = models.get(pageNumber);
        if (!model) {
          const tc = await pdfPage.getTextContent(global.ZEHPdfContext.TEXT_CONTENT_PARAMS);
          if (gen !== generation) return;
          model = global.ZEHPdfContext.buildPageModel(tc, { pageNumber, view: pdfPage.view });
        }
        rememberModel(pageNumber, model);
        global.ZEHPdfSelection.tagTextLayer(layerDiv, model);
      } catch (err) {
        zehDebugLog("[Manekilex] PDF text model skipped", err?.message || err);
      }
    }

    function selectionInsideViewer(range) {
      try {
        return Boolean(range && container.contains(range.commonAncestorContainer));
      } catch {
        return false;
      }
    }

    /**
     * 当前选区 → 小猫气泡。返回交给 presentTrigger 的参数（测试用），没有可查的选区时返回 null。
     */
    function presentFromSelection(releaseX, releaseY) {
      const info = lookup.getSelectionInfo({ skipDeep: true });
      if (!info || !info.text || !info.range || !selectionInsideViewer(info.range)) {
        if (lookup.hasTrigger() && !lookup.isPending() && !lookup.shouldKeepTriggerVisible()) lookup.removeTrigger();
        return null;
      }
      const mapped = global.ZEHPdfSelection.mapRange(info.range);
      const model = mapped && mapped.pageNumber ? modelFor(mapped.pageNumber) : null;
      let text = info.text;
      let snapshot = null;
      if (mapped && model) {
        if (mapped.multiItem) {
          const joined = global.ZEHPdfContext.textForSelection(model, mapped.a, mapped.b);
          if (joined && zehHasEnglish(joined)) text = joined;
        }
        snapshot = global.ZEHPdfContext.snapshotForSelection(model, mapped.a, mapped.b);
      }
      if (!zehHasEnglish(text)) return null;
      const payload = {
        text,
        rect: info.rect,
        range: info.range,
        releaseX,
        releaseY,
        originalText: info.originalText,
        selectionExpanded: info.selectionExpanded,
        source: "pdf-selection-bubble",
        contextSource: snapshot ? { kind: "snapshot", ...snapshot } : null,
        contextLocation: mapped && mapped.pageNumber ? { page: mapped.pageNumber } : null,
      };
      lookup.presentTrigger(payload);
      return payload;
    }

    function insideLookupUi(e) {
      try {
        return lookup.isInsideLookupUI(e.target, e);
      } catch {
        return false;
      }
    }

    function onPointerDown(e) {
      if (insideLookupUi(e) || lookup.isBubblePointerActive?.()) return;
      pointerSelecting = e.button === undefined || e.button === 0;
      if (lookup.hasPanel()) {
        lookup.hideAll();
        pointerSelecting = false;
        return;
      }
      if (!lookup.shouldKeepTriggerVisible()) lookup.removeTriggerAndClearCache();
    }

    function onPointerUp(e) {
      pointerSelecting = false;
      if (insideLookupUi(e)) return;
      if (e.button !== undefined && e.button !== 0) return;
      if (lookup.wasTriggerJustActivated?.()) return;
      if (!container.contains(e.target)) return;
      lastRelease = { x: e.clientX, y: e.clientY, t: Date.now() };
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        if (lookup.hasPanel() && lookup.isPending()) return;
        presentFromSelection(e.clientX, e.clientY);
      }, 30);
    }

    /** 键盘扩展选区（Shift + 方向键）也出气泡；拖选过程中不打扰 */
    function onSelectionChange() {
      if (pointerSelecting) return;
      clearTimeout(selectionTimer);
      selectionTimer = setTimeout(() => {
        if (lookup.hasPanel()) return;
        const recent = Date.now() - lastRelease.t < 400;
        presentFromSelection(recent ? lastRelease.x : undefined, recent ? lastRelease.y : undefined);
      }, SELECTION_DEBOUNCE_MS);
    }

    listen(global.document, "pointerdown", onPointerDown, { capture: true });
    listen(global.document, "pointerup", onPointerUp, { capture: true });
    listen(global.document, "selectionchange", onSelectionChange);
    listen(container, "scroll", () => lookup.scheduleTriggerPositionUpdate(), { passive: true });
    listen(global, "resize", () => lookup.scheduleTriggerPositionUpdate(), { passive: true });

    /** 换文档：清空模型与气泡 / 面板（同一个控制器继续使用） */
    function reset() {
      generation += 1;
      models.clear();
      clearTimeout(selectionTimer);
      try {
        lookup.hideAll();
        lookup.removeTriggerAndClearCache();
      } catch {
        /* noop */
      }
    }

    function destroy() {
      reset();
      ac.abort();
      lookup.destroyController();
    }

    return {
      lookup,
      onTextLayerRendered,
      presentFromSelection,
      lookupText: (text) => lookup.lookupText(text),
      reset,
      destroy,
      modelFor,
      get modelCount() {
        return models.size;
      },
    };
  }

  global.ZEHPdfLookupAdapter = { create };
})(typeof window !== "undefined" ? window : globalThis);
