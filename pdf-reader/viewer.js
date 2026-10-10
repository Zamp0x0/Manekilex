/**
 * pdf-reader/viewer.js — 在 PDF.js 6.4.299 的 PDFViewer 组件上包一层，只暴露阅读器用到的操作。
 *
 * PDFViewer 自带：连续多页、只渲染可见页附近的页面（懒渲染）、滚出缓冲区的页面释放画布、
 * 新渲染开始前取消旧的渲染任务、缩放时保持当前位置。这里不另写一套。
 *
 * 安全相关的固定选项：
 *   - 不传 scriptingManager → 不执行 PDF 里的 JavaScript（enableScripting = false）
 *   - annotationMode = ENABLE：只渲染链接与注释外观，不生成可填写的表单
 *   - annotationEditorMode = DISABLE：不能在页面上编辑 / 添加注释
 *   - 不传 downloadManager：PDF 内嵌附件不会被打开或下载
 *   - 外部链接一律在新标签页打开，rel = noopener noreferrer nofollow；PDF.js 只为 http(s) /
 *     mailto / tel 等安全协议生成链接，javascript: 之类的地址不会成为可点击链接
 *   - enableAutoLinking = false：正文里看起来像网址的文字不自动变成链接
 *
 * 依赖：PDF.js 核心库与查看器组件（由 pdfjs-loader.js 加载后传入）。暴露 window.ZEHPdfViewer。
 */
(function (global) {
  const DEFAULT_SCALE = "auto";
  const SCALE_PRESETS = ["auto", "page-fit", "page-width", "page-actual"];
  /** 单张画布的最大像素数（约 16M）：超过后用 CSS 放大，避免高倍缩放时占用过多内存 */
  const MAX_CANVAS_PIXELS = 2 ** 24;
  /** 打印：150 DPI；页数超过上限时不在扩展内打印 */
  const PRINT_DPI = 150;
  const PRINT_MAX_PAGES = 300;

  /**
   * @param {{
   *   lib: object, components: object,
   *   container: HTMLDivElement, viewerEl: HTMLDivElement,
   *   onPagesInit?: Function, onPageChange?: Function, onScaleChange?: Function,
   *   onFindUpdate?: Function, onTextLayerRendered?: Function, onPagesDestroy?: Function,
   * }} options
   */
  function create(options) {
    const { lib, components, container, viewerEl } = options;
    const ac = new AbortController();
    const signal = ac.signal;
    const eventBus = new components.EventBus();
    const linkService = new components.PDFLinkService({
      eventBus,
      externalLinkTarget: components.LinkTarget.BLANK,
      externalLinkRel: "noopener noreferrer nofollow",
    });
    const findController = new components.PDFFindController({
      linkService,
      eventBus,
      updateMatchesCountOnProgress: true,
    });
    const pdfViewer = new components.PDFViewer({
      container,
      viewer: viewerEl,
      eventBus,
      linkService,
      findController,
      textLayerMode: 1,
      annotationMode: lib.AnnotationMode.ENABLE,
      annotationEditorMode: lib.AnnotationEditorType.DISABLE,
      enableAutoLinking: false,
      maxCanvasPixels: MAX_CANVAS_PIXELS,
      abortSignal: signal,
    });
    linkService.setViewer(pdfViewer);

    let pdfDocument = null;
    let lastQuery = "";
    let destroyed = false;

    const on = (name, fn) => eventBus.on(name, fn, { signal });
    on("pagesinit", () => {
      pdfViewer.currentScaleValue = DEFAULT_SCALE;
      options.onPagesInit?.(pdfViewer.pagesCount);
    });
    on("pagechanging", (evt) => options.onPageChange?.(evt.pageNumber, pdfViewer.pagesCount));
    on("scalechanging", (evt) => options.onScaleChange?.(evt.scale, evt.presetValue || ""));
    on("updatefindmatchescount", (evt) => options.onFindUpdate?.({ matchesCount: evt.matchesCount }));
    on("updatefindcontrolstate", (evt) =>
      options.onFindUpdate?.({ state: evt.state, previous: evt.previous, matchesCount: evt.matchesCount })
    );
    on("textlayerrendered", (evt) => {
      if (evt.error) return;
      options.onTextLayerRendered?.(evt.source, evt.pageNumber);
    });
    on("pagerender", (evt) => options.onPageRender?.(evt.pageNumber));

    function setDocument(doc) {
      pdfDocument = doc;
      // PDFViewer 在首页就绪后自己把文档交给查找控制器
      pdfViewer.setDocument(doc);
      linkService.setDocument(doc, null);
    }

    function goTo(pageNumber) {
      if (!pdfDocument) return false;
      const n = Math.round(Number(pageNumber));
      if (!Number.isFinite(n) || n < 1 || n > pdfViewer.pagesCount) return false;
      pdfViewer.currentPageNumber = n;
      return true;
    }

    function setScale(value) {
      if (!pdfDocument) return;
      if (SCALE_PRESETS.includes(value)) {
        pdfViewer.currentScaleValue = value;
        return;
      }
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) pdfViewer.currentScaleValue = String(n);
    }

    /** 窗口尺寸变化后重新套用「适合宽度 / 适合页面」等预设（固定百分比保持不变） */
    function refreshScale() {
      if (!pdfDocument) return;
      const preset = pdfViewer.currentScaleValue;
      if (SCALE_PRESETS.includes(preset)) pdfViewer.currentScaleValue = preset;
      pdfViewer.update();
    }

    function find(query, opts) {
      const q = String(query || "");
      const o = opts || {};
      if (!pdfDocument) return;
      if (!q) {
        clearFind();
        return;
      }
      eventBus.dispatch("find", {
        source: null,
        type: q === lastQuery && o.again ? "again" : "",
        query: q,
        caseSensitive: false,
        entireWord: false,
        highlightAll: true,
        findPrevious: Boolean(o.previous),
        matchDiacritics: false,
      });
      lastQuery = q;
    }

    function clearFind() {
      lastQuery = "";
      eventBus.dispatch("findbarclose", { source: null });
    }

    /**
     * 打印：把每页按 150 DPI 渲染成图片放进打印容器，调用浏览器打印，结束后释放图片。
     * 返回 { ok, reason }；页数过多时不打印（调用方提示用 Chrome 自带查看器打印）。
     */
    async function print(printContainer, hooks) {
      const h = hooks || {};
      if (!pdfDocument) return { ok: false, reason: "no-document" };
      const total = pdfDocument.numPages;
      if (total > PRINT_MAX_PAGES) return { ok: false, reason: "too-many-pages", limit: PRINT_MAX_PAGES };
      const doc = pdfDocument;
      const urls = [];
      const release = () => {
        urls.splice(0).forEach((u) => URL.revokeObjectURL(u));
        printContainer.replaceChildren();
      };
      try {
        for (let p = 1; p <= total; p++) {
          if (destroyed || doc !== pdfDocument || h.signal?.aborted) {
            release();
            return { ok: false, reason: "cancelled" };
          }
          h.onProgress?.(p, total);
          const page = await doc.getPage(p);
          const viewport = page.getViewport({ scale: PRINT_DPI / 72 });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, canvas.width, canvas.height);
          await page.render({ canvasContext: ctx, viewport, intent: "print" }).promise;
          const blob = await new Promise((resolve) => canvas.toBlob(resolve));
          canvas.width = 0;
          canvas.height = 0;
          page.cleanup();
          if (!blob) throw new Error("render-failed");
          const url = URL.createObjectURL(blob);
          urls.push(url);
          const wrap = document.createElement("div");
          wrap.className = "mk-print-page";
          const img = document.createElement("img");
          img.alt = "";
          img.src = url;
          wrap.appendChild(img);
          printContainer.appendChild(wrap);
        }
        await Promise.all(
          [...printContainer.querySelectorAll("img")].map((img) => (img.decode ? img.decode().catch(() => {}) : null))
        );
        if (destroyed || doc !== pdfDocument) {
          release();
          return { ok: false, reason: "cancelled" };
        }
        global.addEventListener("afterprint", release, { once: true });
        global.print();
        return { ok: true };
      } catch (err) {
        release();
        return { ok: false, reason: "error", message: err?.message || String(err) };
      }
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      try {
        // 取消所有渲染任务、释放页面画布与文本层，并让查找控制器放下文档
        pdfViewer.setDocument(null);
      } catch {
        /* noop */
      }
      try {
        linkService.setDocument(null);
      } catch {
        /* noop */
      }
      pdfDocument = null;
      ac.abort();
      viewerEl.replaceChildren();
    }

    return {
      eventBus,
      pdfViewer,
      linkService,
      findController,
      setDocument,
      goTo,
      next: () => pdfViewer.nextPage(),
      prev: () => pdfViewer.previousPage(),
      first: () => goTo(1),
      last: () => goTo(pdfViewer.pagesCount),
      zoomIn: () => pdfDocument && pdfViewer.increaseScale(),
      zoomOut: () => pdfDocument && pdfViewer.decreaseScale(),
      setScale,
      refreshScale,
      find,
      clearFind,
      print,
      destroy,
      get page() {
        return pdfViewer.currentPageNumber;
      },
      get pageCount() {
        return pdfViewer.pagesCount;
      },
      get scale() {
        return pdfViewer.currentScale;
      },
      get scaleValue() {
        return pdfViewer.currentScaleValue;
      },
      get destroyed() {
        return destroyed;
      },
    };
  }

  global.ZEHPdfViewer = { create, SCALE_PRESETS, DEFAULT_SCALE, PRINT_MAX_PAGES };
})(typeof window !== "undefined" ? window : globalThis);
