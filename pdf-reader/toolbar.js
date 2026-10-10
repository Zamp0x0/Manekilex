/**
 * pdf-reader/toolbar.js — 工具栏、查找栏与键盘 / 鼠标快捷键
 *
 * 只把界面操作转给 viewer.js 与 app.js 提供的动作；没有文档时，需要文档的按钮全部禁用，
 * 只在当前入口真正可用时才显示的按钮（Chrome 自带查看器、打印）由 app.js 决定是否显示。
 *
 * 快捷键（焦点不在输入框时）：
 *   Ctrl/⌘ + = / -  放大 / 缩小（不触发浏览器整页缩放）   Ctrl/⌘ + 0  自动缩放
 *   Ctrl/⌘ + F     查找；查找框里 Enter / Shift+Enter 下一个 / 上一个；Esc 关闭
 *   N / J / →      下一页        P / K / ←   上一页        Home / End  首页 / 末页
 *   Ctrl/⌘ + 滚轮  缩放
 *
 * 依赖：无（viewer / actions 由调用方传入）。暴露 window.ZEHPdfToolbar。
 */
(function (global) {
  const IDS = [
    "openFileBtn",
    "fileInput",
    "prevPageBtn",
    "nextPageBtn",
    "pageInput",
    "pageCount",
    "zoomOutBtn",
    "zoomInBtn",
    "scaleSelect",
    "customScaleOption",
    "findToggleBtn",
    "downloadBtn",
    "printBtn",
    "nativeBtn",
    "docTitle",
    "findBar",
    "findInput",
    "findPrevBtn",
    "findNextBtn",
    "findStatus",
    "findCloseBtn",
  ];

  /** 没有文档时禁用的控件 */
  const NEEDS_DOC = [
    "prevPageBtn",
    "nextPageBtn",
    "pageInput",
    "zoomOutBtn",
    "zoomInBtn",
    "scaleSelect",
    "findToggleBtn",
    "downloadBtn",
    "printBtn",
  ];

  function isEditable(target) {
    if (!target || target.nodeType !== 1) return false;
    const tag = target.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
  }

  /**
   * @param {{
   *   doc: Document,
   *   getViewer: () => (object|null),
   *   actions: { openFile: (file: File) => void, download: () => void, print: () => void, native: () => void },
   * }} options
   */
  function create(options) {
    const doc = options.doc;
    const els = {};
    IDS.forEach((id) => (els[id] = doc.getElementById(id)));
    const ac = new AbortController();
    const listen = (target, type, fn, opts) => target?.addEventListener(type, fn, { ...(opts || {}), signal: ac.signal });
    const viewer = () => {
      const v = options.getViewer();
      return v && v.pageCount > 0 ? v : null;
    };
    let hasDocument = false;

    function setDocumentControls(enabled) {
      hasDocument = enabled;
      NEEDS_DOC.forEach((id) => {
        if (els[id]) els[id].disabled = !enabled;
      });
      if (!enabled) {
        if (els.pageInput) els.pageInput.value = "";
        if (els.pageCount) els.pageCount.textContent = "/ 0";
        closeFind();
      }
    }

    function setTitle(text) {
      if (els.docTitle) {
        els.docTitle.textContent = text || "";
        els.docTitle.title = text || "";
      }
    }

    function setPage(pageNumber, total) {
      if (els.pageInput && doc.activeElement !== els.pageInput) els.pageInput.value = String(pageNumber || "");
      if (els.pageCount) els.pageCount.textContent = `/ ${total || 0}`;
      if (els.prevPageBtn) els.prevPageBtn.disabled = !hasDocument || pageNumber <= 1;
      if (els.nextPageBtn) els.nextPageBtn.disabled = !hasDocument || pageNumber >= total;
    }

    function setScale(scale, preset) {
      const select = els.scaleSelect;
      if (!select) return;
      const custom = els.customScaleOption;
      const wanted = preset || String(Math.round(scale * 100) / 100);
      const match = [...select.options].find((o) => o !== custom && o.value === wanted);
      if (match) {
        if (custom) custom.hidden = true;
        select.value = match.value;
      } else if (custom) {
        custom.hidden = false;
        custom.value = "custom";
        custom.textContent = `${Math.round(scale * 100)}%`;
        select.value = "custom";
      }
    }

    function openFind() {
      if (!hasDocument || !els.findBar) return;
      els.findBar.hidden = false;
      els.findInput?.focus();
      els.findInput?.select();
    }

    function closeFind() {
      if (!els.findBar || els.findBar.hidden) return;
      els.findBar.hidden = true;
      if (els.findStatus) els.findStatus.textContent = "";
      options.getViewer()?.clearFind();
    }

    function runFind(previous) {
      const v = viewer();
      if (!v) return;
      v.find(els.findInput.value, { again: true, previous });
    }

    /** viewer.js 的查找结果回调 */
    function setFindResult(update) {
      if (!els.findStatus) return;
      const query = els.findInput?.value || "";
      if (!query) {
        els.findStatus.textContent = "";
        return;
      }
      const counts = update.matchesCount;
      if (update.state === 1 /* NOT_FOUND */) {
        els.findStatus.textContent = "没有找到";
        return;
      }
      if (counts && counts.total > 0) {
        els.findStatus.textContent = `${counts.current || 0} / ${counts.total}`;
      } else if (update.state === 3 /* PENDING */) {
        els.findStatus.textContent = "查找中…";
      }
    }

    function goToTypedPage() {
      const v = viewer();
      if (!v) return;
      if (!v.goTo(els.pageInput.value)) els.pageInput.value = String(v.page);
      els.pageInput.blur();
    }

    listen(els.openFileBtn, "click", () => els.fileInput?.click());
    listen(els.fileInput, "change", () => {
      const file = els.fileInput.files && els.fileInput.files[0];
      els.fileInput.value = "";
      if (file) options.actions.openFile(file);
    });
    listen(els.prevPageBtn, "click", () => viewer()?.prev());
    listen(els.nextPageBtn, "click", () => viewer()?.next());
    listen(els.pageInput, "keydown", (e) => {
      if (e.key === "Enter") goToTypedPage();
      if (e.key === "Escape") {
        const v = viewer();
        if (v) els.pageInput.value = String(v.page);
        els.pageInput.blur();
      }
    });
    listen(els.pageInput, "change", goToTypedPage);
    listen(els.zoomInBtn, "click", () => viewer()?.zoomIn());
    listen(els.zoomOutBtn, "click", () => viewer()?.zoomOut());
    listen(els.scaleSelect, "change", () => {
      if (els.scaleSelect.value !== "custom") viewer()?.setScale(els.scaleSelect.value);
    });
    listen(els.findToggleBtn, "click", () => (els.findBar?.hidden ? openFind() : closeFind()));
    listen(els.findInput, "input", () => {
      const v = viewer();
      if (v) v.find(els.findInput.value, {});
    });
    listen(els.findInput, "keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        runFind(e.shiftKey);
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeFind();
      }
    });
    listen(els.findPrevBtn, "click", () => runFind(true));
    listen(els.findNextBtn, "click", () => runFind(false));
    listen(els.findCloseBtn, "click", closeFind);
    listen(els.downloadBtn, "click", () => options.actions.download());
    listen(els.printBtn, "click", () => options.actions.print());
    listen(els.nativeBtn, "click", () => options.actions.native());

    listen(doc, "keydown", (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && (e.key === "f" || e.key === "F")) {
        if (!hasDocument) return;
        e.preventDefault();
        openFind();
        return;
      }
      if (mod && !e.altKey && ["=", "+", "-", "_", "0"].includes(e.key)) {
        const v = viewer();
        if (!v) return;
        e.preventDefault();
        if (e.key === "0") v.setScale("auto");
        else if (e.key === "-" || e.key === "_") v.zoomOut();
        else v.zoomIn();
        return;
      }
      if (mod && (e.key === "p" || e.key === "P")) {
        if (!hasDocument || !els.printBtn || els.printBtn.hidden) return;
        e.preventDefault();
        options.actions.print();
        return;
      }
      if (mod || e.altKey || isEditable(e.target)) return;
      const v = viewer();
      if (!v) return;
      switch (e.key) {
        case "n":
        case "j":
        case "ArrowRight":
          v.next();
          e.preventDefault();
          break;
        case "p":
        case "k":
        case "ArrowLeft":
          v.prev();
          e.preventDefault();
          break;
        case "Home":
          v.first();
          e.preventDefault();
          break;
        case "End":
          v.last();
          e.preventDefault();
          break;
        default:
          break;
      }
    });

    // Ctrl/⌘ + 滚轮缩放（passive: false 才能阻止浏览器整页缩放）
    listen(
      doc.getElementById("viewerContainer"),
      "wheel",
      (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        const v = viewer();
        if (!v) return;
        e.preventDefault();
        if (e.deltaY < 0) v.zoomIn();
        else if (e.deltaY > 0) v.zoomOut();
      },
      { passive: false }
    );

    setDocumentControls(false);

    return {
      els,
      setDocumentControls,
      setTitle,
      setPage,
      setScale,
      setFindResult,
      openFind,
      closeFind,
      destroy: () => ac.abort(),
    };
  }

  global.ZEHPdfToolbar = { create, IDS, NEEDS_DOC };
})(typeof window !== "undefined" ? window : globalThis);
