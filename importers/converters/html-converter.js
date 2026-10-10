(function (global) {
  const { filenameToTitle, extractBodyHtml } = global.ZEHHtmlSanitize;
  const { buildChaptersFromHtml } = global.ZEHChapterSplit;

  async function convertHtml(file, opts) {
    if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const raw = await file.text();
    const bodyHtml = extractBodyHtml(raw);
    const title = filenameToTitle(file.name);
    const chapters = buildChaptersFromHtml(bodyHtml, {
      defaultTitle: title,
      partPrefix: "Part",
    });
    const warnings = [];
    if (/<img[^>]+src=["']https?:/i.test(bodyHtml)) {
      warnings.push("HTML 中的远程图片第一版不保证显示，建议转为 EPUB 或使用本地 HTML。");
    }
    return {
      title,
      author: "Unknown",
      language: "en",
      sourceFormat: "html",
      originalFilename: file.name,
      chapters,
      assets: [],
      warnings,
    };
  }

  global.ZEHHtmlConverter = { convertHtml };
})(typeof window !== "undefined" ? window : globalThis);
