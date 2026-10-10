(function (global) {
  const { filenameToTitle, extractBodyHtml } = global.ZEHHtmlSanitize;
  const { buildChaptersFromHtml } = global.ZEHChapterSplit;

  async function convertMarkdown(file, opts) {
    if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (typeof marked === "undefined") throw new Error("Markdown 解析库未加载");

    const md = await file.text();
    const html = marked.parse(md, { async: false });
    const bodyHtml = extractBodyHtml(html);
    const title = filenameToTitle(file.name);
    const chapters = buildChaptersFromHtml(bodyHtml, {
      defaultTitle: title,
      partPrefix: "Part",
    });
    const warnings = [];
    if (/<img[^>]+src=["']https?:/i.test(bodyHtml)) {
      warnings.push("Markdown 中的远程图片可能无法在 EPUB 中显示。");
    }
    return {
      title,
      author: "Unknown",
      language: "zh-CN",
      sourceFormat: "md",
      originalFilename: file.name,
      chapters,
      assets: [],
      warnings,
    };
  }

  global.ZEHMarkdownConverter = { convertMarkdown };
})(typeof window !== "undefined" ? window : globalThis);
