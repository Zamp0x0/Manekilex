/**
 * pdf-reader/app.js — 增强 PDF 阅读器的启动与生命周期
 *
 * 启动：
 *   - Chrome 151+ 且本页面是 Chrome 打开 application/pdf 时载入的（getStreamInfo 有 streamUrl）
 *     → 读取数据流一次，显示 PDF；出错时说明原因，并提供「用 Chrome 自带查看器打开」
 *     （abortAndFallbackToNativeHandler，只在这个入口显示，不自动跳转，不会循环）。
 *   - 其他情况（旧版 Chrome、从设置页打开）→ 显示「打开本地 PDF」，文件只在内存里读取。
 *
 * 状态：landing（选择文件）/ loading / password / error / ready，任何时候都有可操作的出口，
 * 读取与解析都有停滞超时，不会一直转圈。
 *
 * 资源：换文件或关闭页面时，取消渲染、销毁 PDF.js 文档与 worker（loadingTask.destroy）、
 * 释放下载 / 打印用的 Blob URL、清除计时器与事件监听。不保存文件，不记录阅读位置，不上传。
 *
 * 依赖：config.js、pdf-reader/pdfjs-loader.js、document.js、viewer.js、toolbar.js；
 * 查词另需 mk-lookup.js 与 pdf-reader/lookup-adapter.js（缺少时阅读器照常可用，只是不能查词）。
 * 暴露 window.ZEHPdfReaderApp。
 */
(function (global) {
  const doc = global.document;
  const D = global.ZEHPdfDocument;
  /** getStreamInfo 多久没有结果就当作不是 MIME 处理入口 */
  const STREAM_INFO_TIMEOUT_MS = 8000;
  /** 解析阶段多久没有进展算作停滞 */
  const PARSE_STALL_MS = 90000;
  /** 扫描件检测：抽查前几页 */
  const SCAN_SAMPLE_PAGES = 3;
  const RESIZE_DEBOUNCE_MS = 150;
  const BLOB_URL_TTL_MS = 60000;

  const $ = (id) => doc.getElementById(id);
  const els = {
    container: $("viewerContainer"),
    viewer: $("viewer"),
    statePanel: $("statePanel"),
    landing: $("landingState"),
    landingNote: $("landingNote"),
    landingOpenBtn: $("landingOpenBtn"),
    loading: $("loadingState"),
    loadingText: $("loadingText"),
    passwordForm: $("passwordForm"),
    passwordPrompt: $("passwordPrompt"),
    passwordInput: $("passwordInput"),
    passwordCancelBtn: $("passwordCancelBtn"),
    error: $("errorState"),
    errorText: $("errorText"),
    errorDetail: $("errorDetail"),
    errorNativeBtn: $("errorNativeBtn"),
    errorOpenBtn: $("errorOpenBtn"),
    notice: $("notice"),
    printContainer: $("printContainer"),
  };

  const ac = new AbortController();
  const listen = (target, type, fn, opts) => target?.addEventListener(type, fn, { ...(opts || {}), signal: ac.signal });
  const timers = new Set();
  const blobUrls = new Set();

  const state = {
    mode: "idle", // "stream" | "file" | "idle"
    view: "landing",
    source: null, // { kind, fileName, url, displayUrl, tabId, embedded }
    title: "",
    loadingTask: null,
    pdfDocument: null,
    viewer: null,
    generation: 0,
    mimeHandler: null,
    tabId: null, // 本页所在标签页：数据流入口来自 getStreamInfo，本地文件入口来自 tabs.getCurrent
    announced: false, // 已告诉后台本标签页的 PDF 由阅读器接管（旧右上角猫球隐藏）
    passwordHandlers: null,
    printing: null,
    destroyed: false,
    lastError: null,
  };

  function later(fn, ms) {
    const id = setTimeout(() => {
      timers.delete(id);
      fn();
    }, ms);
    timers.add(id);
    return id;
  }

  function cancelTimer(id) {
    if (id == null) return;
    clearTimeout(id);
    timers.delete(id);
  }

  // ── 界面状态 ──────────────────────────────────────────────────────────────────

  function showView(view) {
    state.view = view;
    els.statePanel.hidden = view === "ready";
    els.landing.hidden = view !== "landing";
    els.loading.hidden = view !== "loading";
    els.passwordForm.hidden = view !== "password";
    els.error.hidden = view !== "error";
    doc.body.dataset.view = view;
  }

  function showLoading(text) {
    els.loadingText.textContent = text;
    showView("loading");
  }

  function canFallBackToNative() {
    return state.mode === "stream" && Boolean(state.mimeHandler?.abortAndFallbackToNativeHandler);
  }

  function showError(message, detail) {
    state.lastError = { message, detail: detail || "" };
    els.errorText.textContent = message;
    els.errorDetail.textContent = detail || "";
    els.errorDetail.hidden = !detail;
    els.errorNativeBtn.hidden = !canFallBackToNative();
    showView("error");
  }

  function showNotice(text, kind) {
    els.notice.textContent = text || "";
    els.notice.dataset.kind = kind || "info";
    els.notice.hidden = !text;
  }

  function formatBytes(n) {
    if (!(n > 0)) return "";
    if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  // ── PDF.js 与查看器 ──────────────────────────────────────────────────────────

  async function ensurePdfjs() {
    try {
      return await global.ZEHPdfjs.loadViewer();
    } catch (err) {
      throw D.readerError("LIBRARY_FAILED", err?.message);
    }
  }

  function ensureViewer(lib, components) {
    if (state.viewer) return state.viewer;
    state.viewer = global.ZEHPdfViewer.create({
      lib,
      components,
      container: els.container,
      viewerEl: els.viewer,
      onPagesInit: (count) => toolbar.setPage(1, count),
      onPageChange: (page, total) => toolbar.setPage(page, total),
      onScaleChange: (scale, preset) => toolbar.setScale(scale, preset),
      onFindUpdate: (update) => toolbar.setFindResult(update),
      onTextLayerRendered: (pageView, pageNumber) => app.onTextLayerRendered(pageView, pageNumber),
    });
    return state.viewer;
  }

  /** 关闭当前文档：取消渲染、销毁 PDF.js 文档与 worker、释放打印图片。查看器本身保留复用。 */
  async function closeDocument() {
    state.generation += 1;
    if (state.printing) state.printing.abort();
    state.printing = null;
    els.printContainer.replaceChildren();
    const task = state.loadingTask;
    state.loadingTask = null;
    state.pdfDocument = null;
    state.passwordHandlers = null;
    els.passwordInput.value = "";
    if (state.viewer) state.viewer.setDocument(null);
    toolbar.setDocumentControls(false);
    toolbar.setTitle("");
    showNotice("");
    app.onDocumentClosed();
    if (task) {
      try {
        await task.destroy();
      } catch {
        /* noop */
      }
    }
  }

  async function documentTitle(pdfDocument, fallback) {
    try {
      const meta = await pdfDocument.getMetadata();
      const title = String(meta?.info?.Title || "").replace(/\s+/g, " ").trim();
      // 很多 PDF 的 Title 是生成工具留下的占位（Microsoft Word - xxx.doc、untitled）
      if (title && !/^(untitled|microsoft word|document\d*)\b/i.test(title)) return title.slice(0, 300);
    } catch {
      /* noop */
    }
    return fallback;
  }

  /** 抽查前几页都没有文字 → 提示扫描件需要 OCR（本扩展不做 OCR） */
  async function checkScanned(pdfDocument, gen) {
    const pages = Math.min(SCAN_SAMPLE_PAGES, pdfDocument.numPages);
    try {
      for (let p = 1; p <= pages; p++) {
        const page = await pdfDocument.getPage(p);
        const tc = await page.getTextContent();
        if (gen !== state.generation) return false;
        if (tc.items.some((it) => typeof it.str === "string" && /\S/.test(it.str))) return false;
      }
    } catch {
      return false;
    }
    if (gen !== state.generation) return false;
    showNotice(
      "这份 PDF 没有可选中的文字，看起来是扫描件或图片。查词需要先做文字识别（OCR），Manekilex 暂不提供 OCR；仍可阅读、缩放、打印。",
      "warn"
    );
    return true;
  }

  function updateEntryButtons(pdfDocument) {
    const tb = toolbar.els;
    tb.nativeBtn.hidden = !canFallBackToNative();
    // 页数过多时扩展内不打印：MIME 入口改用 Chrome 自带查看器打印，手动打开时隐藏按钮
    const printable = pdfDocument.numPages <= global.ZEHPdfViewer.PRINT_MAX_PAGES;
    tb.printBtn.hidden = !printable && !canFallBackToNative();
    tb.printBtn.title = printable ? "打印" : "页数较多，改用 Chrome 自带查看器打印";
  }

  /**
   * 把 PDF 数据交给 PDF.js 并显示。data 交给 PDF.js 后本页面不再持有。
   * @returns {Promise<boolean>} 是否成功显示
   */
  async function openData(data, source) {
    await closeDocument();
    const gen = state.generation;
    state.source = source;
    showLoading("正在解析 PDF…");
    let lib;
    let components;
    try {
      ({ lib, viewer: components } = await ensurePdfjs());
    } catch (err) {
      if (gen === state.generation) showError(D.classifyError(err).message, err?.detail);
      return false;
    }
    if (gen !== state.generation) return false;

    let passwordCancelled = false;
    let stallTimer = null;
    const armStall = () => {
      cancelTimer(stallTimer);
      stallTimer = later(() => {
        if (gen !== state.generation || state.view === "password") return;
        closeDocument().then(() => showError("PDF 解析长时间没有进展，已停止。"));
      }, PARSE_STALL_MS);
    };
    const { loadingTask, promise } = D.openDocument(lib, data, {
      onProgress: (loaded, total) => {
        armStall();
        if (gen !== state.generation || state.view !== "loading") return;
        const pct = total > 0 ? ` ${Math.min(100, Math.round((loaded / total) * 100))}%` : "";
        els.loadingText.textContent = `正在解析 PDF…${pct}`;
      },
      onPassword: (kind, submit, cancel) => {
        if (gen !== state.generation) return;
        cancelTimer(stallTimer);
        state.passwordHandlers = {
          submit: (pw) => {
            showLoading("正在解密…");
            armStall();
            submit(pw);
          },
          cancel: () => {
            passwordCancelled = true;
            cancel();
          },
        };
        els.passwordPrompt.textContent =
          kind === "incorrect" ? "密码不正确，请重新输入。" : "这个 PDF 受密码保护，请输入打开密码。";
        els.passwordInput.value = "";
        showView("password");
        els.passwordInput.focus();
      },
    });
    data = null;
    state.loadingTask = loadingTask;
    armStall();

    let pdfDocument;
    try {
      pdfDocument = await promise;
    } catch (err) {
      cancelTimer(stallTimer);
      if (gen !== state.generation) return false;
      state.loadingTask = null;
      state.passwordHandlers = null;
      const info = passwordCancelled ? { message: D.MESSAGES.PASSWORD_CANCELLED } : D.classifyError(err);
      showError(info.message, passwordCancelled ? "" : String(err?.message || "").slice(0, 200));
      try {
        await loadingTask.destroy();
      } catch {
        /* noop */
      }
      return false;
    }
    cancelTimer(stallTimer);
    if (gen !== state.generation) {
      loadingTask.destroy();
      return false;
    }
    state.passwordHandlers = null;
    els.passwordInput.value = "";
    state.pdfDocument = pdfDocument;
    state.title = await documentTitle(pdfDocument, source.fileName || "PDF");
    if (gen !== state.generation) return false;
    doc.title = `${state.title} · Manekilex PDF`;

    const viewer = ensureViewer(lib, components);
    viewer.setDocument(pdfDocument);
    toolbar.setDocumentControls(true);
    toolbar.setTitle(state.title);
    toolbar.setPage(1, pdfDocument.numPages);
    updateEntryButtons(pdfDocument);
    showView("ready");
    app.onDocumentOpened(pdfDocument);
    els.container.focus({ preventScroll: true });
    checkScanned(pdfDocument, gen);
    return true;
  }

  // ── 两个入口 ──────────────────────────────────────────────────────────────────

  async function openFile(file) {
    state.mode = state.mode === "stream" ? "stream" : "file";
    showLoading("正在读取文件…");
    let result;
    try {
      result = await D.readFile(file);
    } catch (err) {
      await closeDocument();
      showError(D.classifyError(err).message, err?.detail);
      return false;
    }
    // 打开本地文件后，Chrome 自带查看器回退只对原来的数据流有意义，不再显示
    state.mode = "file";
    return openData(result.data, result.provenance);
  }

  function withTimeout(promise, ms) {
    let id;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        id = later(() => reject(new Error("timeout")), ms);
      }),
    ]).finally(() => cancelTimer(id));
  }

  async function bootStream(source) {
    state.mode = "stream";
    showLoading("正在读取 PDF…");
    let result;
    try {
      result = await source.read();
    } catch (err) {
      showError(D.classifyError(err).message, err?.detail);
      return false;
    }
    return openData(result.data, result.provenance);
  }

  // ── 与后台的协作：旧猫球隐藏、右键查词 ────────────────────────────────────────

  /** 数据流入口：告诉后台这个标签页的 PDF 由阅读器显示（后台让旧的右上角猫球隐藏） */
  function announceReaderTab(active) {
    if (active === state.announced || !Number.isInteger(state.tabId)) return;
    state.announced = active;
    try {
      Promise.resolve(chrome.runtime.sendMessage({ type: "PDF_READER_STATE", active, tabId: state.tabId })).catch(() => {});
    } catch {
      /* 扩展已重新加载 */
    }
  }

  /** 本地文件入口：记下自己所在的标签页，右键查词按它认领 */
  function rememberCurrentTab() {
    try {
      Promise.resolve(chrome.tabs?.getCurrent?.())
        .then((tab) => {
          if (state.tabId == null && Number.isInteger(tab?.id)) state.tabId = tab.id;
        })
        .catch(() => {});
    } catch {
      /* noop */
    }
  }

  /** 后台转来的右键查词（PDF_READER_LOOKUP）：只认领发给本标签页的，交给同一个查词控制器 */
  function onRuntimeMessage(message, sender, sendResponse) {
    if (!message || message.type !== "PDF_READER_LOOKUP" || state.destroyed) return false;
    if (sender && sender.id && sender.id !== chrome.runtime.id) return false;
    if (!Number.isInteger(state.tabId) || message.tabId !== state.tabId || !lookup) return false;
    const ok = Boolean(lookup.lookupText(String(message.text || "")));
    sendResponse({ ok });
    return false;
  }

  function showLanding(note) {
    state.mode = "file";
    els.landingNote.textContent = note || "";
    els.landingNote.hidden = !note;
    showView("landing");
  }

  async function boot() {
    state.mimeHandler = D.getMimeHandler();
    if (!state.mimeHandler) {
      rememberCurrentTab();
      showLanding("");
      return "file";
    }
    const source = D.createStreamSource({
      mimeHandler: state.mimeHandler,
      onProgress: (loaded) => {
        if (state.view === "loading") els.loadingText.textContent = `正在读取 PDF… ${formatBytes(loaded)}`;
      },
    });
    let info = null;
    try {
      info = await withTimeout(source.info(), STREAM_INFO_TIMEOUT_MS);
    } catch {
      info = null;
    }
    if (state.destroyed) return "destroyed";
    if (!info) {
      // 手动打开的页面（不是 Chrome 打开 PDF 时载入的）：没有数据流可读
      rememberCurrentTab();
      showLanding("");
      return "file";
    }
    if (Number.isInteger(info.tabId) && info.tabId >= 0) state.tabId = info.tabId;
    announceReaderTab(true);
    await bootStream(source);
    return "stream";
  }

  // ── 工具栏动作 ────────────────────────────────────────────────────────────────

  function rememberBlobUrl(url) {
    blobUrls.add(url);
    later(() => {
      URL.revokeObjectURL(url);
      blobUrls.delete(url);
    }, BLOB_URL_TTL_MS);
  }

  /** 下载原文件：PDF.js 手里的原始字节（不含任何修改） */
  async function download() {
    const pdfDocument = state.pdfDocument;
    if (!pdfDocument) return false;
    try {
      const bytes = await pdfDocument.getData();
      if (pdfDocument !== state.pdfDocument) return false;
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
      rememberBlobUrl(url);
      const a = doc.createElement("a");
      a.href = url;
      a.download = /\.pdf$/i.test(state.source?.fileName || "") ? state.source.fileName : `${state.title || "document"}.pdf`;
      a.rel = "noopener";
      a.hidden = true;
      doc.body.appendChild(a);
      a.click();
      a.remove();
      return true;
    } catch (err) {
      showNotice(`下载失败：${err?.message || err}`, "warn");
      return false;
    }
  }

  async function fallBackToNative() {
    if (!canFallBackToNative()) return false;
    try {
      await closeDocument();
      announceReaderTab(false);
      await state.mimeHandler.abortAndFallbackToNativeHandler();
      return true;
    } catch (err) {
      showError("无法切换到 Chrome 自带的 PDF 查看器。", String(err?.message || err));
      return false;
    }
  }

  async function print() {
    const pdfDocument = state.pdfDocument;
    if (!pdfDocument || !state.viewer || state.printing) return false;
    if (pdfDocument.numPages > global.ZEHPdfViewer.PRINT_MAX_PAGES) {
      if (!canFallBackToNative()) return false;
      if (global.confirm(`这份 PDF 有 ${pdfDocument.numPages} 页，改用 Chrome 自带查看器打印？`)) return fallBackToNative();
      return false;
    }
    const printing = new AbortController();
    state.printing = printing;
    try {
      const result = await state.viewer.print(els.printContainer, {
        signal: printing.signal,
        onProgress: (p, total) => showNotice(`正在准备打印：第 ${p} / ${total} 页…`, "info"),
      });
      if (state.printing === printing) showNotice(result.ok || result.reason === "cancelled" ? "" : "打印准备失败。", "warn");
      return result.ok;
    } finally {
      if (state.printing === printing) state.printing = null;
    }
  }

  // ── 事件 ──────────────────────────────────────────────────────────────────────

  const toolbar = global.ZEHPdfToolbar.create({
    doc,
    getViewer: () => (state.pdfDocument ? state.viewer : null),
    actions: { openFile, download, print, native: fallBackToNative },
  });

  listen(els.landingOpenBtn, "click", () => toolbar.els.fileInput.click());
  listen(els.errorOpenBtn, "click", () => toolbar.els.fileInput.click());
  listen(els.errorNativeBtn, "click", fallBackToNative);
  listen(els.passwordForm, "submit", (e) => {
    e.preventDefault();
    const pw = els.passwordInput.value;
    els.passwordInput.value = "";
    state.passwordHandlers?.submit(pw);
  });
  listen(els.passwordCancelBtn, "click", () => state.passwordHandlers?.cancel());

  // 拖放本地 PDF
  listen(doc, "dragover", (e) => {
    if (e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }
  });
  listen(doc, "drop", (e) => {
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    e.preventDefault();
    openFile(file);
  });

  let resizeTimer = null;
  listen(global, "resize", () => {
    cancelTimer(resizeTimer);
    resizeTimer = later(() => state.viewer?.refreshScale(), RESIZE_DEBOUNCE_MS);
  });

  function destroy() {
    if (state.destroyed) return;
    state.destroyed = true;
    announceReaderTab(false);
    closeDocument();
    state.viewer?.destroy();
    state.viewer = null;
    toolbar.destroy();
    app.onDestroy();
    try {
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      /* noop */
    }
    timers.forEach((id) => clearTimeout(id));
    timers.clear();
    blobUrls.forEach((url) => URL.revokeObjectURL(url));
    blobUrls.clear();
    ac.abort();
  }

  try {
    chrome.runtime.onMessage.addListener(onRuntimeMessage);
  } catch {
    /* noop */
  }

  listen(global, "pagehide", (e) => {
    if (!e.persisted) destroy();
  });

  // 小猫查词：同一个查词控制器（mk-lookup.js），经 lookup-adapter.js 接入 PDF 文本层
  function createLookup() {
    if (!global.ZEHPdfLookupAdapter || !global.MKLookup) return null;
    try {
      return global.ZEHPdfLookupAdapter.create({
        container: els.container,
        getSource: () =>
          state.pdfDocument
            ? { title: state.title, fileName: state.source?.fileName || "", url: state.source?.url || "" }
            : null,
        readerUrl: chrome.runtime.getURL(ZEH_PDF_READER_PAGE),
      });
    } catch (err) {
      zehDebugLog("[Manekilex] PDF lookup unavailable", err?.message || err);
      return null;
    }
  }
  const lookup = createLookup();

  const app = {
    state,
    els,
    toolbar,
    boot,
    openFile,
    openData,
    closeDocument,
    download,
    print,
    fallBackToNative,
    destroy,
    lookup,
    /** 文档生命周期钩子：查词适配在这里建版面模型、换文档时清空、页面关闭时销毁 */
    onTextLayerRendered(pageView, pageNumber) {
      return lookup?.onTextLayerRendered(pageView, pageNumber);
    },
    onDocumentOpened() {},
    onDocumentClosed() {
      lookup?.reset();
    },
    onDestroy() {
      lookup?.destroy();
    },
    get timerCount() {
      return timers.size;
    },
    get blobUrlCount() {
      return blobUrls.size;
    },
  };
  global.ZEHPdfReaderApp = app;
  app.ready = boot();
})(window);
