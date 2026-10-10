/**
 * 设置页分区「阅读」中的导入：EPUB 校验与入库、其它格式（TXT / Markdown / HTML / DOCX / PDF）经 importers/ 转成 EPUB、
 * PDF 导入模式对话框、进度条与取消。
 *
 * 加载时只声明。书籍只保存在本机 IndexedDB（book-store.js），不上传。
 * 依赖：importers/*（MKBookImporter 等）、book-store.js、lib/epub.min.js、lib/jszip.min.js、
 *       settings/reading.js（renderBookshelf）。
 */

// ─── 阅读：本地书架（EPUB + 多格式转换）────────────────────────────────────────

let bookImportAbort = null;
let bookImportSession = 0;

function throwIfAborted(signal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

function whenAborted(signal) {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
      once: true,
    });
  });
}

function raceAbort(signal, promise) {
  if (!signal) return promise;
  throwIfAborted(signal);
  return Promise.race([promise, whenAborted(signal)]);
}

function cancelBookImport() {
  bookImportSession += 1;
  if (bookImportAbort) {
    bookImportAbort.abort();
    bookImportAbort = null;
  }
  const hint = document.getElementById("readingHint");
  if (hint) hint.textContent = "已取消导入";
  setImportProgress(false);
}

function setImportProgress(visible, data) {
  const panel = document.getElementById("bookImportProgress");
  const msg = document.getElementById("bookImportMessage");
  const bar = document.getElementById("bookImportBar");
  const cancelBtn = document.getElementById("bookImportCancel");
  if (!panel) return;
  panel.hidden = !visible;
  if (msg && data?.message) msg.textContent = data.message;
  if (bar && data?.total) {
    const pct = Math.round(((data.current || 0) / data.total) * 100);
    bar.style.width = pct + "%";
    bar.parentElement.hidden = false;
  } else if (bar?.parentElement) {
    bar.parentElement.hidden = true;
    bar.style.width = "0%";
  }
  if (cancelBtn) cancelBtn.disabled = !visible;
}

function showPdfModeDialog() {
  return new Promise((resolve) => {
    const overlay = document.getElementById("pdfModeDialog");
    if (!overlay) {
      resolve(null);
      return;
    }
    overlay.hidden = false;

    function cleanup(choice) {
      overlay.hidden = true;
      overlay.querySelectorAll("[data-pdf-mode]").forEach((btn) => {
        btn.onclick = null;
      });
      const closeBtn = overlay.querySelector(".pdf-mode-close");
      if (closeBtn) closeBtn.onclick = null;
      resolve(choice);
    }

    overlay.querySelectorAll("[data-pdf-mode]").forEach((btn) => {
      btn.onclick = () => cleanup(btn.dataset.pdfMode);
    });
    const closeBtn = overlay.querySelector(".pdf-mode-close");
    if (closeBtn) closeBtn.onclick = () => cleanup(null);
  });
}

async function validateEpubFile(file, signal) {
  throwIfAborted(signal);
  let buf;
  try {
    buf = await raceAbort(signal, file.arrayBuffer());
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    throw new Error(
      "无法读取该文件。若保存在 OneDrive，请先在资源管理器中右键 →「始终保留在此设备上」，再重新导入。"
    );
  }
  throwIfAborted(signal);
  if (typeof JSZip === "undefined") return buf;
  try {
    const zip = await raceAbort(signal, JSZip.loadAsync(buf));
    if (!zip.file("META-INF/container.xml")) {
      throw new Error("不是有效的 EPUB（缺少 META-INF/container.xml）。");
    }
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    if (err && /META-INF|不是有效/.test(err.message || "")) throw err;
    throw new Error(
      "EPUB 文件已损坏或 ZIP 结构异常，无法导入。请用 Calibre「转换书籍」重新生成 EPUB，或从可靠来源重新下载。"
    );
  }
  return buf;
}

async function parseEpubMeta(file, signal) {
  const buf = await validateEpubFile(file, signal);
  throwIfAborted(signal);
  const book = ePub(buf);
  let title = "";
  let author = "";
  let coverBlob = null;
  try {
    await raceAbort(
      signal,
      Promise.race([
        book.ready,
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("EPUB 解析超时，文件可能过大或已损坏。")), 90000);
        }),
      ])
    );
    throwIfAborted(signal);
    const md = (book.packaging && book.packaging.metadata) || {};
    title = md.title || "";
    author = md.creator || md.author || "";
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    /* 元数据缺失时退回文件名 */
  }
  try {
    throwIfAborted(signal);
    const coverUrl = await raceAbort(signal, book.coverUrl());
    if (coverUrl) {
      const resp = await raceAbort(signal, fetch(coverUrl));
      coverBlob = await raceAbort(signal, resp.blob());
    }
  } catch (err) {
    if (err && err.name === "AbortError") throw err;
    /* 无封面 */
  } finally {
    try {
      book.destroy();
    } catch {
      /* noop */
    }
  }
  return { title, author, coverBlob };
}

async function ingestEpubBlob(epubBlob, meta, signal, session) {
  throwIfAborted(signal);
  const hint = document.getElementById("readingHint");
  const file =
    epubBlob instanceof File
      ? epubBlob
      : new File([epubBlob], (meta && meta.filename) || "book.epub", {
          type: "application/epub+zip",
        });

  if (hint) hint.textContent = "正在导入书架…";
  setImportProgress(true, { message: "正在导入书架…" });

  const parsed = await parseEpubMeta(file, signal);
  throwIfAborted(signal);
  if (session != null && session !== bookImportSession) return;

  await ZEHBookStore.addBook({
    title: (meta && meta.title) || parsed.title || file.name.replace(/\.epub$/i, ""),
    author: (meta && meta.author) || parsed.author || "未知作者",
    format: "epub",
    coverBlob: parsed.coverBlob || null,
    fileBlob: file,
    sourceFormat: (meta && meta.sourceFormat) || "epub",
    originalFilename: (meta && meta.originalFilename) || file.name,
    convertMode: (meta && meta.convertMode) || null,
    convertedAt: meta && meta.convertedAt ? meta.convertedAt : meta && meta.sourceFormat && meta.sourceFormat !== "epub" ? Date.now() : null,
  });

  if (session != null && session !== bookImportSession) return;

  if (hint) hint.textContent = "";
  setImportProgress(false);
  renderBookshelf();
}

async function handleBookUpload(file) {
  const hint = document.getElementById("readingHint");
  if (!file || !window.ZEHBookImporter) {
    if (hint) hint.textContent = "导入模块未加载，请刷新设置页。";
    return;
  }

  bookImportSession += 1;
  const session = bookImportSession;
  bookImportAbort = new AbortController();
  const signal = bookImportAbort.signal;

  try {
    setImportProgress(true, { message: "正在读取文件…" });
    if (hint) hint.textContent = "";

    const { format } = ZEHBookImporter.detectBookFormat(file);
    let pdfMode = null;
    if (format === "pdf") {
      setImportProgress(false);
      pdfMode = await showPdfModeDialog();
      if (!pdfMode) {
        if (hint) hint.textContent = "已取消 PDF 导入";
        return;
      }
      setImportProgress(true, { message: "准备转换 PDF…" });
    }

    const result = await ZEHBookImporter.importBookFile(file, {
      pdfMode,
      signal,
      onProgress: (p) => {
        setImportProgress(true, {
          message: p.message || "处理中…",
          current: p.current,
          total: p.total,
        });
      },
    });

    if (signal.aborted || session !== bookImportSession) return;

    if (result.format === "epub") {
      await ingestEpubBlob(
        result.file,
        {
          sourceFormat: "epub",
          originalFilename: file.name,
        },
        signal,
        session
      );
    } else {
      const nb = result.normalizedBook || {};
      if (result.warnings?.length) {
        console.info("[BookImport warnings]", result.warnings);
      }
      await ingestEpubBlob(
        result.epubBlob,
        {
          title: nb.title,
          author: nb.author,
          sourceFormat: nb.sourceFormat || result.format,
          originalFilename: file.name,
          convertMode: result.convertMode,
          convertedAt: Date.now(),
          filename: file.name.replace(/\.[^.]+$/i, "") + ".epub",
        },
        signal,
        session
      );
      if (result.warnings?.length && hint) {
        hint.textContent = result.warnings[0];
      }
    }

    if (session !== bookImportSession) return;

    setImportProgress(true, { message: "完成" });
    setTimeout(() => setImportProgress(false), 800);
  } catch (err) {
    if (err && err.name === "AbortError") {
      if (hint) hint.textContent = "已取消导入";
    } else {
      const msg = (err && err.message) || "转换失败";
      if (hint) hint.textContent = msg;
      alert(msg);
    }
    setImportProgress(false);
  } finally {
    bookImportAbort = null;
  }
}
