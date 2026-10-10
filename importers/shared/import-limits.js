/**
 * 书籍导入大小 / 页数限制（保守档）
 */
(function (global) {
  const LIMITS = {
    epub: { maxBytes: 100 * 1024 * 1024, label: "EPUB" },
    txt: { maxBytes: 20 * 1024 * 1024, label: "TXT" },
    md: { maxBytes: 20 * 1024 * 1024, label: "Markdown" },
    html: { maxBytes: 20 * 1024 * 1024, label: "HTML" },
    docx: { maxBytes: 50 * 1024 * 1024, label: "DOCX" },
    pdf_text: { maxBytes: 50 * 1024 * 1024, maxPages: 300, label: "PDF（文本模式）" },
    pdf_image: { maxBytes: 50 * 1024 * 1024, maxPages: 100, label: "PDF（原貌模式）" },
  };

  const UNSUPPORTED_EXT = new Set([
    "mobi",
    "azw3",
    "azw",
    "djvu",
    "chm",
    "rtf",
    "odt",
    "cbr",
    "cbz",
    "fb2",
    "prc",
  ]);

  const EXT_TO_FORMAT = {
    epub: "epub",
    txt: "txt",
    md: "md",
    markdown: "md",
    html: "html",
    htm: "html",
    docx: "docx",
    pdf: "pdf",
  };

  function formatBytes(n) {
    if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(0) + " MB";
    if (n >= 1024) return (n / 1024).toFixed(0) + " KB";
    return n + " B";
  }

  function detectBookFormat(file) {
    const name = (file && file.name) || "";
    const ext = name.includes(".") ? name.split(".").pop().toLowerCase() : "";
    if (UNSUPPORTED_EXT.has(ext)) return { format: "unsupported", ext };
    if (EXT_TO_FORMAT[ext]) return { format: EXT_TO_FORMAT[ext], ext };
    const mime = (file && file.type) || "";
    if (mime === "application/epub+zip") return { format: "epub", ext: "epub" };
    if (mime === "text/plain") return { format: "txt", ext: "txt" };
    if (mime === "text/html") return { format: "html", ext: "html" };
    if (mime === "application/pdf") return { format: "pdf", ext: "pdf" };
    if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
      return { format: "docx", ext: "docx" };
    return { format: "unknown", ext };
  }

  function validateFileSize(file, formatKey) {
    const lim = LIMITS[formatKey];
    if (!lim || !file) return null;
    if (file.size > lim.maxBytes) {
      return `${lim.label} 文件过大（${formatBytes(file.size)}），上限 ${formatBytes(lim.maxBytes)}。`;
    }
    return null;
  }

  function validatePdfPages(pageCount, pdfMode) {
    const key = pdfMode === "image" ? "pdf_image" : "pdf_text";
    const lim = LIMITS[key];
    if (!lim || pageCount <= lim.maxPages) return null;
    return `${lim.label} 页数过多（${pageCount} 页），上限 ${lim.maxPages} 页。`;
  }

  function unsupportedFormatMessage(ext) {
    return (
      `暂不支持 .${ext || "该"} 格式。请先使用 Calibre 等工具转换为 EPUB 后再导入 Manekilex。`
    );
  }

  global.ZEHImportLimits = {
    LIMITS,
    detectBookFormat,
    validateFileSize,
    validatePdfPages,
    unsupportedFormatMessage,
    formatBytes,
  };
})(typeof window !== "undefined" ? window : globalThis);
