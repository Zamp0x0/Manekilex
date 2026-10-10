(function (global) {
  const { filenameToTitle } = global.ZEHHtmlSanitize;

  async function convertDocx(file, opts) {
    if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (typeof mammoth === "undefined") throw new Error("DOCX 解析库未加载");

    const buf = await file.arrayBuffer();
    const result = await mammoth.convertToHtml({ arrayBuffer: buf });
    const html = result.value || "";
    const warnings = (result.messages || [])
      .filter((m) => m.type === "warning")
      .map((m) => m.message);

    warnings.push("DOCX 复杂排版（表格、脚注、部分图片）第一版可能丢失。");

    const fakeFile = {
      name: file.name.replace(/\.docx$/i, ".html"),
      text: async () => html,
    };
    const book = await global.ZEHHtmlConverter.convertHtml(fakeFile, opts);
    book.sourceFormat = "docx";
    book.originalFilename = file.name;
    book.title = filenameToTitle(file.name);
    book.warnings = [...(book.warnings || []), ...warnings];
    return book;
  }

  global.ZEHDocxConverter = { convertDocx };
})(typeof window !== "undefined" ? window : globalThis);
