/**
 * 统一书籍导入入口
 */
(function (global) {
  const { detectBookFormat, validateFileSize, unsupportedFormatMessage } =
    global.ZEHImportLimits;

  async function convertToNormalizedBook(file, format, options) {
    const opts = options || {};
    const signal = opts.signal;

    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    switch (format) {
      case "txt":
        return global.ZEHTxtConverter.convertTxt(file, opts);
      case "md":
        return global.ZEHMarkdownConverter.convertMarkdown(file, opts);
      case "html":
        return global.ZEHHtmlConverter.convertHtml(file, opts);
      case "docx":
        return global.ZEHDocxConverter.convertDocx(file, opts);
      case "pdf": {
        const mode = opts.pdfMode === "image" ? "image" : "text";
        const sizeKey = mode === "image" ? "pdf_image" : "pdf_text";
        const sizeErr = validateFileSize(file, sizeKey);
        if (sizeErr) throw new Error(sizeErr);
        if (mode === "image") return global.ZEHPdfImageConverter.convertPdfImage(file, opts);
        return global.ZEHPdfTextConverter.convertPdfText(file, opts);
      }
      default:
        throw new Error("不支持的转换格式：" + format);
    }
  }

  /**
   * @param {File} file
   * @param {object} options
   * @param {function} options.onProgress
   * @param {AbortSignal} options.signal
   * @param {string} options.pdfMode - 'text' | 'image'
   * @returns {Promise<{ format, epubBlob?, normalizedBook?, warnings? }>}
   */
  async function importBookFile(file, options) {
    const opts = options || {};
    const onProgress = opts.onProgress || (() => {});

    onProgress({ stage: "reading", message: "正在读取文件…" });

    const { format, ext } = detectBookFormat(file);

    if (format === "unsupported") {
      throw new Error(unsupportedFormatMessage(ext));
    }
    if (format === "unknown") {
      throw new Error("当前格式暂不支持。请使用 EPUB、TXT、Markdown、HTML、DOCX 或 PDF。");
    }

    if (format === "epub") {
      const err = validateFileSize(file, "epub");
      if (err) throw new Error(err);
      onProgress({ stage: "done", message: "EPUB 已就绪" });
      return { format: "epub", file, warnings: [] };
    }

    const sizeKey =
      format === "pdf"
        ? opts.pdfMode === "image"
          ? "pdf_image"
          : "pdf_text"
        : format;
    const sizeErr = validateFileSize(file, sizeKey);
    if (sizeErr) throw new Error(sizeErr);

    onProgress({ stage: "converting", message: `正在解析 ${format.toUpperCase()}…` });
    const normalizedBook = await convertToNormalizedBook(file, format, opts);

    if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");

    onProgress({ stage: "building", message: "正在生成 EPUB…" });
    const epubBlob = await global.ZEHEpubBuilder.buildEpubBlob(normalizedBook);

    onProgress({ stage: "built", message: "EPUB 已生成" });

    return {
      format,
      epubBlob,
      normalizedBook,
      warnings: normalizedBook.warnings || [],
      convertMode: format === "pdf" ? opts.pdfMode || "text" : null,
    };
  }

  global.ZEHBookImporter = { importBookFile, convertToNormalizedBook, detectBookFormat };
})(typeof window !== "undefined" ? window : globalThis);
