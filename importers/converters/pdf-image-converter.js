(function (global) {
  const { loadPdfDocument, closePdfDocument, JPEG_QUALITY, RENDER_SCALE } = global.ZEHPdfUtils;
  const { wrapChapterXhtml, escapeXml, filenameToTitle } = global.ZEHHtmlSanitize;
  const { validatePdfPages } = global.ZEHImportLimits;

  function padPage(n) {
    return String(n).padStart(3, "0");
  }

  async function renderPageToBlob(page) {
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext("2d", { alpha: false });
    await page.render({ canvasContext: ctx, viewport }).promise;
    const blob = await new Promise((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("页面渲染失败"))),
        "image/jpeg",
        JPEG_QUALITY
      );
    });
    canvas.width = 0;
    canvas.height = 0;
    return blob;
  }

  async function convertPdfImage(file, opts) {
    const signal = opts?.signal;
    const onProgress = opts?.onProgress || (() => {});
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

    onProgress({ stage: "parsing", message: "正在打开 PDF…" });
    const pdf = await loadPdfDocument(file);
    try {
      const numPages = pdf.numPages;
      const pageErr = validatePdfPages(numPages, "image");
      if (pageErr) throw new Error(pageErr);

      const assets = [];
      const chapters = [];

      for (let p = 1; p <= numPages; p++) {
        if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
        onProgress({
          stage: "rendering",
          message: `正在渲染 PDF：${p} / ${numPages} 页`,
          current: p,
          total: numPages,
        });

        const page = await pdf.getPage(p);
        const blob = await renderPageToBlob(page);
        page.cleanup();

        const imgName = `page-${padPage(p)}.jpg`;
        const assetPath = `images/${imgName}`;
        assets.push({ path: assetPath, blob, mediaType: "image/jpeg" });

        const title = `Page ${p}`;
        const body =
          `<div class="pdf-page"><img src="../${assetPath}" alt="${escapeXml(title)}"/></div>`;
        chapters.push({
          id: `chapter-${p}`,
          title,
          html: wrapChapterXhtml(title, body),
        });

        await new Promise((r) => setTimeout(r, 0));
      }

      return {
        title: filenameToTitle(file.name),
        author: "Unknown",
        language: "en",
        sourceFormat: "pdf",
        originalFilename: file.name,
        chapters,
        assets,
        warnings: [
          "PDF 原貌模式：每页为图片，文件较大，无法正常划词查词。",
          "原貌模式会占用较多本地存储空间。",
        ],
      };
    } finally {
      // 出错（页数超限、扫描件、取消）时也释放 worker
      await closePdfDocument(pdf);
    }
  }

  global.ZEHPdfImageConverter = { convertPdfImage };
})(typeof window !== "undefined" ? window : globalThis);
