(function (global) {
  const { filenameToTitle, escapeXml, wrapChapterXhtml } = global.ZEHHtmlSanitize;
  const { countWords } = global.ZEHChapterSplit;

  const WORDS_PER_CHAPTER = 6000;

  function mergeParagraphs(paragraphs) {
    const merged = [];
    let buf = "";
    for (const p of paragraphs) {
      const t = p.trim();
      if (!t) {
        if (buf) {
          merged.push(buf);
          buf = "";
        }
        continue;
      }
      if (buf && buf.length < 80 && !/[.!?。！？]$/.test(buf)) {
        buf += " " + t;
      } else if (buf) {
        merged.push(buf);
        buf = t;
      } else {
        buf = t;
      }
    }
    if (buf) merged.push(buf);
    return merged;
  }

  function textToChapters(text, defaultTitle) {
    const blocks = String(text || "").replace(/\r\n/g, "\n").split(/\n\s*\n+/);
    const paragraphs = mergeParagraphs(blocks.flatMap((b) => b.split("\n")));
    if (!paragraphs.length) {
      return [
        {
          id: "chapter-1",
          title: defaultTitle || "正文",
          html: wrapChapterXhtml(defaultTitle, "<p></p>"),
        },
      ];
    }

    const chapters = [];
    let current = [];
    let currentWords = 0;
    let part = 1;

    function flush() {
      if (!current.length) return;
      const title = part === 1 && paragraphs.length <= 3 ? defaultTitle || "正文" : `Part ${part}`;
      const body =
        (part > 1 || title.startsWith("Part") ? `<h1>${escapeXml(title)}</h1>` : "") +
        current.map((p) => `<p>${escapeXml(p)}</p>`).join("\n");
      chapters.push({
        id: `chapter-${chapters.length + 1}`,
        title,
        html: wrapChapterXhtml(title, body),
      });
      current = [];
      currentWords = 0;
      part++;
    }

    for (const p of paragraphs) {
      const w = countWords(p);
      if (currentWords + w > WORDS_PER_CHAPTER && current.length) flush();
      current.push(p);
      currentWords += w;
    }
    flush();
    return chapters;
  }

  async function convertTxt(file, opts) {
    if (opts?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const text = await file.text();
    const title = filenameToTitle(file.name);
    const chapters = textToChapters(text, title);
    return {
      title,
      author: "Unknown",
      language: "zh-CN",
      sourceFormat: "txt",
      originalFilename: file.name,
      chapters,
      assets: [],
      warnings: [],
    };
  }

  global.ZEHTxtConverter = { convertTxt };
})(typeof window !== "undefined" ? window : globalThis);
