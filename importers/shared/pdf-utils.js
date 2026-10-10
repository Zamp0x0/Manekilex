(function (global) {
  /** PDF.js 由 pdf-reader/pdfjs-loader.js 按需加载（6.x 只有 ES module，没有全局 pdfjsLib） */
  async function ensurePdfJs() {
    if (!global.ZEHPdfjs) throw new Error("PDF 解析库未加载");
    try {
      return await global.ZEHPdfjs.loadLibrary();
    } catch (err) {
      throw new Error(`PDF 解析库加载失败：${(err && err.message) || err}`);
    }
  }

  async function loadPdfDocument(file) {
    const pdfjs = await ensurePdfJs();
    const data = new Uint8Array(await file.arrayBuffer());
    // 安全选项（XFA 关闭、wasm 只从本地加载）统一由 ZEHPdfjs.documentParams 固定，见 lib/README.md
    const loadingTask = pdfjs.getDocument(global.ZEHPdfjs.documentParams({ data }));
    return loadingTask.promise;
  }

  /** 释放文档和 worker（PDF.js 6.x 起由 loadingTask.destroy() 负责，PDFDocumentProxy 不再有 destroy） */
  async function closePdfDocument(pdf) {
    if (!pdf) return;
    try {
      if (pdf.loadingTask && typeof pdf.loadingTask.destroy === "function") await pdf.loadingTask.destroy();
      else if (typeof pdf.destroy === "function") await pdf.destroy();
    } catch {
      /* 已经销毁 */
    }
  }

  function cleanExtractedText(raw) {
    let t = String(raw || "");
    t = t.replace(/\u00ad/g, "");
    t = t.replace(/[ \t]+/g, " ");
    t = t.replace(/(\w)-\s+(\w)/g, "$1$2");
    const lines = t
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    const filtered = lines.filter((line) => {
      if (/^\d{1,4}$/.test(line)) return false;
      if (/^page\s+\d+$/i.test(line)) return false;
      return line.length > 1;
    });
    return filtered.join("\n\n");
  }

  async function extractPageText(page) {
    const content = await page.getTextContent();
    const raw = content.items.map((item) => item.str || "").join(" ");
    return cleanExtractedText(raw);
  }

  global.ZEHPdfUtils = {
    ensurePdfJs,
    loadPdfDocument,
    closePdfDocument,
    cleanExtractedText,
    extractPageText,
    MIN_TEXT_CHARS: 500,
    PAGES_PER_TEXT_CHAPTER: 10,
    JPEG_QUALITY: 0.85,
    RENDER_SCALE: 1.5,
  };
})(typeof window !== "undefined" ? window : globalThis);
