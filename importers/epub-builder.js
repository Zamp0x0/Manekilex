/**
 * 将 normalized book 打包为标准 EPUB Blob（epub.js 可读）
 */
(function (global) {
  const BOOK_CSS = `
body { font-family: Georgia, "Times New Roman", "PingFang SC", "Microsoft YaHei", serif; line-height: 1.65; margin: 1em; color: #222; }
h1, h2, h3 { line-height: 1.3; margin: 1.2em 0 0.6em; }
p { margin: 0.6em 0; text-indent: 0; }
blockquote { margin: 1em 1.5em; color: #444; border-left: 3px solid #ccc; padding-left: 1em; }
ul, ol { margin: 0.6em 0 0.6em 1.5em; }
img { max-width: 100%; height: auto; }
.pdf-page { text-align: center; margin: 0; padding: 0; }
.pdf-page img { width: 100%; height: auto; display: block; margin: 0 auto; }
pre, code { font-family: Consolas, monospace; font-size: 0.95em; }
`.trim();

  function escapeOpf(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function uuid() {
    return "urn:uuid:" + crypto.randomUUID();
  }

  function buildNavXhtml(chapters) {
    const items = chapters
      .map(
        (ch, i) =>
          `<li><a href="chapters/${ch.id}.xhtml">${escapeOpf(ch.title || "Chapter " + (i + 1))}</a></li>`
      )
      .join("\n");
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<!DOCTYPE html>\n` +
      `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">\n` +
      `<head><meta charset="UTF-8"/><title>目录</title></head>\n` +
      `<body>\n<nav epub:type="toc" id="toc"><ol>\n${items}\n</ol></nav>\n</body>\n</html>`
    );
  }

  function buildNcx(chapters, bookId) {
    const navPoints = chapters
      .map(
        (ch, i) =>
          `    <navPoint id="navPoint-${i + 1}" playOrder="${i + 1}">\n` +
          `      <navLabel><text>${escapeOpf(ch.title)}</text></navLabel>\n` +
          `      <content src="chapters/${ch.id}.xhtml"/>\n` +
          `    </navPoint>`
      )
      .join("\n");
    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">\n` +
      `<head>\n<meta name="dtb:uid" content="${bookId}"/>\n` +
      `<meta name="dtb:depth" content="1"/>\n` +
      `<meta name="dtb:totalPageCount" content="0"/>\n` +
      `<meta name="dtb:maxPageNumber" content="0"/>\n</head>\n` +
      `<docTitle><text>${escapeOpf(chapters[0]?.title || "Book")}</text></docTitle>\n` +
      `<navMap>\n${navPoints}\n</navMap>\n</ncx>`
    );
  }

  function buildContentOpf(book, chapters, assets, bookId) {
    const title = escapeOpf(book.title || "Untitled");
    const author = escapeOpf(book.author || "Unknown");
    const lang = escapeOpf(book.language || "zh-CN");
    const modified = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

    const manifestItems = [
      `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`,
      `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`,
      `<item id="style" href="styles/book.css" media-type="text/css"/>`,
    ];
    const spineItems = [];

    chapters.forEach((ch) => {
      const href = `chapters/${ch.id}.xhtml`;
      manifestItems.push(
        `<item id="${ch.id}" href="${href}" media-type="application/xhtml+xml"/>`
      );
      spineItems.push(`<itemref idref="${ch.id}"/>`);
    });

    (assets || []).forEach((a, i) => {
      const aid = `asset-${i + 1}`;
      a._epubId = aid;
      manifestItems.push(
        `<item id="${aid}" href="${a.path}" media-type="${escapeOpf(a.mediaType || "image/jpeg")}"/>`
      );
    });

    return (
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="BookId">\n` +
      `<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">\n` +
      `<dc:identifier id="BookId">${bookId}</dc:identifier>\n` +
      `<dc:title>${title}</dc:title>\n` +
      `<dc:creator>${author}</dc:creator>\n` +
      `<dc:language>${lang}</dc:language>\n` +
      `<meta property="dcterms:modified">${modified}</meta>\n` +
      `</metadata>\n` +
      `<manifest>\n${manifestItems.join("\n")}\n</manifest>\n` +
      `<spine toc="ncx">\n${spineItems.join("\n")}\n</spine>\n` +
      `</package>`
    );
  }

  async function buildEpubBlob(normalizedBook) {
    if (!global.JSZip) throw new Error("JSZip 未加载");
    const book = normalizedBook || {};
    const chapters = book.chapters || [];
    if (!chapters.length) throw new Error("没有可生成的章节内容");

    // 生成前校验每一章都是良构 XHTML（epub.js 以 XML 解析章节，一处未闭合就整章空白）
    const validate = global.ZEHHtmlSanitize && global.ZEHHtmlSanitize.validateChapterXhtml;
    if (typeof validate === "function") {
      for (const ch of chapters) {
        const err = validate(ch.html);
        if (err) {
          throw new Error(`章节「${ch.title || ch.id}」的 XHTML 不合法：${err}`);
        }
      }
    }

    const zip = new JSZip();
    const bookId = uuid();

    zip.file("mimetype", "application/epub+zip", { compression: "STORE" });

    zip.file(
      "META-INF/container.xml",
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n` +
        `<rootfiles>\n` +
        `<rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>\n` +
        `</rootfiles>\n</container>`
    );

    chapters.forEach((ch) => {
      zip.file(`OEBPS/chapters/${ch.id}.xhtml`, ch.html);
    });

    (book.assets || []).forEach((a) => {
      if (a.path && a.blob) zip.file(`OEBPS/${a.path}`, a.blob);
    });

    zip.file("OEBPS/styles/book.css", BOOK_CSS);
    zip.file("OEBPS/nav.xhtml", buildNavXhtml(chapters));
    zip.file("OEBPS/toc.ncx", buildNcx(chapters, bookId));
    zip.file(
      "OEBPS/content.opf",
      buildContentOpf(book, chapters, book.assets, bookId)
    );

    const blob = await zip.generateAsync({
      type: "blob",
      mimeType: "application/epub+zip",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    return blob;
  }

  global.ZEHEpubBuilder = { buildEpubBlob, BOOK_CSS };
})(typeof window !== "undefined" ? window : globalThis);
