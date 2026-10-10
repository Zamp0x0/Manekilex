(function (global) {
  const { loadPdfDocument, closePdfDocument, extractPageText, MIN_TEXT_CHARS, PAGES_PER_TEXT_CHAPTER } =
    global.ZEHPdfUtils;
  const { wrapChapterXhtml, escapeXml, filenameToTitle } = global.ZEHHtmlSanitize;
  const { validatePdfPages } = global.ZEHImportLimits;

  async function convertPdfText(file, opts) {
    const signal = opts?.signal;
    const onProgress = opts?.onProgress || (() => {});
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    onProgress({ stage: "parsing", message: "正在打开 PDF…" });
    const pdf = await loadPdfDocument(file);
    try {
      const numPages = pdf.numPages;
      const pageErr = validatePdfPages(numPages, "text");
      if (pageErr) throw new Error(pageErr);

      const pageTexts = [];
      for (let p = 1; p <= numPages; p++) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        onProgress({
          stage: "extracting",
          message: `正在提取文字：${p} / ${numPages} 页`,
          current: p,
          total: numPages,
        });
        const page = await pdf.getPage(p);
        const text = await extractPageText(page);
        pageTexts.push(text);
        page.cleanup();
      }

      const fullText = pageTexts.filter(Boolean).join("\n\n");
      if (fullText.replace(/\s/g, "").length < MIN_TEXT_CHARS) {
        throw new Error(
          "这个 PDF 可能是扫描版或图片型 PDF，文本模式无法提取有效文字，请尝试原貌模式。"
        );
      }

      const chapters = [];
      for (let start = 0; start < numPages; start += PAGES_PER_TEXT_CHAPTER) {
        const end = Math.min(start + PAGES_PER_TEXT_CHAPTER, numPages);
        const chunk = pageTexts.slice(start, end).filter(Boolean).join("\n\n");
        const part = Math.floor(start / PAGES_PER_TEXT_CHAPTER) + 1;
        const title = `PDF Text Part ${part}`;
        const paras = chunk.split(/\n\n+/).map((p) => `<p>${escapeXml(p)}</p>`).join("\n");
        const body = `<h1>${escapeXml(title)}</h1>${paras}`;
        chapters.push({
          id: `chapter-${chapters.length + 1}`,
          title,
          html: wrapChapterXhtml(title, body),
        });
      }

      return {
        title: filenameToTitle(file.name),
        author: "Unknown",
        language: "en",
        sourceFormat: "pdf",
        originalFilename: file.name,
        chapters,
        assets: [],
        warnings: ["PDF 文本模式：复杂排版、公式、图片可能丢失。"],
      };
    } finally {
      // 出错（页数超限、扫描件、取消）时也释放 worker
      await closePdfDocument(pdf);
    }
  }

  global.ZEHPdfTextConverter = { convertPdfText };
})(typeof window !== "undefined" ? window : globalThis);
