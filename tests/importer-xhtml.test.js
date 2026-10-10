/**
 * R-05: Markdown / HTML / DOCX-style imports must produce well-formed XHTML chapters.
 * Chapters are split on the DOM (balanced markup), content before the first heading is kept,
 * sanitization still removes scripts / handlers, and the EPUB builder refuses malformed chapters.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadImporters, fakeFile } = require("./helpers/importer-sandbox");

function assertWellFormed(api, chapter) {
  assert.equal(api.sanitize.xmlWellFormedError(chapter.html), "", `${chapter.id} text check`);
  assert.equal(api.xmlParseError(chapter.html), "", `${chapter.id} XML parse`);
}

const MD_FIXTURE = [
  "Opening lines before any heading, with **bold** and a [link](https://example.test/a?b=1&c=2).",
  "",
  "# Chapter One",
  "",
  "Fish & chips <3 — AT&T. Entities: &copy; &nbsp; &amp;lt;",
  "",
  "![cover](images/cover.png)",
  "",
  "---",
  "",
  "soft  ",
  "break",
  "",
  "<div class=\"raw\"><h2>Raw HTML heading</h2><p>raw <em>html</em> paragraph<br>second line</p></div>",
  "",
  "# Chapter Two",
  "",
  "中文段落，带标点。 Emoji 😀 and accents: café, naïve. Code: `a < b && c > d`.",
  "",
  "<p>unclosed paragraph in markdown",
  "",
  "## Section 2.1",
  "",
  "* item one",
  "* item two",
].join("\n");

test("Markdown: headings, image / hr / br, raw HTML, entities and Unicode → well-formed chapters", async () => {
  const api = loadImporters();
  const book = await api.markdown.convertMarkdown(fakeFile("my-book.md", MD_FIXTURE));
  assert.equal(book.chapters.length, 3, "preface + two h1 chapters");
  book.chapters.forEach((ch) => assertWellFormed(api, ch));

  const [preface, one, two] = book.chapters;
  assert.equal(preface.title, "my book", "content before the first heading becomes a chapter named after the book");
  assert.match(api.chapterText(preface.html), /^Opening lines before any heading/);
  assert.match(api.bodyOf(preface.html), /href="https:\/\/example\.test\/a\?b=1&amp;c=2"/, "attribute & escaped");

  const oneBody = api.bodyOf(one.html);
  assert.match(oneBody, /<img src="images\/cover\.png" alt="cover"\/>/, "void img self-closed");
  assert.match(oneBody, /<hr\/>/, "void hr self-closed");
  assert.match(oneBody, /soft<br\/>break/, "void br self-closed");
  assert.match(oneBody, /Fish &amp; chips &lt;3 — AT&amp;T/, "text escaped");
  assert.match(oneBody, new RegExp("© " + String.fromCharCode(160) + " &amp;lt;"), "entities decoded once (nbsp → U+00A0) and re-escaped");
  assert.match(oneBody, /<h2>Raw HTML heading<\/h2><p>raw <em>html<\/em> paragraph<br\/>second line<\/p>/, "raw HTML block kept and balanced");
  assert.doesNotMatch(oneBody, /<div/, "wrapper div around the raw heading was unwrapped");

  const twoBody = api.bodyOf(two.html);
  assert.match(twoBody, /中文段落，带标点。 Emoji 😀 and accents: café, naïve/, "Unicode preserved");
  assert.match(twoBody, /<code>a &lt; b &amp;&amp; c &gt; d<\/code>/);
  assert.match(twoBody, /<p>unclosed paragraph in markdown<\/p>/, "unclosed <p> from raw HTML is closed");
  assert.match(twoBody, /<ul>\s*<li>item one<\/li>\s*<li>item two<\/li>\s*<\/ul>/);
  assert.equal(book.warnings.length, 0);
});

test("HTML: nested divs around headings split into balanced chapters without losing text", async () => {
  const api = loadImporters();
  const html = `<!doctype html><html><head><title>T</title><style>p{color:red}</style></head><body>
<div id="wrap"><div class="inner">
  <p>Before the first heading.</p>
  <h1>First</h1>
  <p>Para 1 <span>inline</span></p>
  <div><div><h1>Second</h1><p>Para 2</p></div><p>Para 2b</p></div>
  <h1>Third</h1>
  <table><tr><td>cell &amp; more</td><td>2</td></tr></table>
</div></div>
</body></html>`;
  const book = await api.html.convertHtml(fakeFile("nested.html", html));
  book.chapters.forEach((ch) => assertWellFormed(api, ch));
  assert.deepEqual(Array.from(book.chapters, (c) => c.title), ["nested", "First", "Second", "Third"]);
  const texts = Array.from(book.chapters, (c) => api.chapterText(c.html).replace(/\s+/g, ""));
  assert.equal(texts[0], "Beforethefirstheading.");
  assert.equal(texts[1], "FirstPara1inline");
  assert.equal(texts[2], "SecondPara2Para2b");
  assert.equal(texts[3], "Thirdcell&more2");
  assert.match(api.bodyOf(book.chapters[3].html), /<table><tr><td>cell &amp; more<\/td><td>2<\/td><\/tr><\/table>/);
});

test("DOCX-style HTML (mammoth output) keeps data images, footnote links and tables, well-formed", async () => {
  const api = loadImporters();
  const mammothHtml =
    `<h1>Title</h1><p>Body <strong>bold</strong> and <em>em</em>.<sup><a href="#footnote-1" id="footnote-ref-1">[1]</a></sup></p>` +
    `<p><img src="data:image/png;base64,iVBORw0KGgo=" alt="" /></p>` +
    `<table><tr><td><p>a</p></td><td><p>b</p></td></tr></table>` +
    `<h1>Next</h1><p>Second chapter text</p>` +
    `<ol><li id="footnote-1"><p>Footnote <a href="#footnote-ref-1">↑</a></p></li></ol>`;
  const book = await api.html.convertHtml(fakeFile("report.html", mammothHtml));
  book.chapters.forEach((ch) => assertWellFormed(api, ch));
  assert.deepEqual(Array.from(book.chapters, (c) => c.title), ["Title", "Next"]);
  const first = api.bodyOf(book.chapters[0].html);
  assert.match(first, /<img src="data:image\/png;base64,iVBORw0KGgo=" alt=""\/>/, "data: image kept");
  assert.match(first, /<sup><a href="#footnote-1" id="footnote-ref-1">\[1\]<\/a><\/sup>/);
  assert.match(api.bodyOf(book.chapters[1].html), /<li id="footnote-1"><p>Footnote <a href="#footnote-ref-1">↑<\/a><\/p><\/li>/);
});

test("sanitization still removes scripts, styles, iframes, event handlers and javascript: URLs", async () => {
  const api = loadImporters();
  const html = `<h1>Safe</h1><script>alert(1)</script><style>p{}</style><iframe src="https://evil.test"></iframe>` +
    `<p onclick="x()" style="color:red" class="k" data-x="1">text</p>` +
    `<a href="javascript:alert(1)">bad link</a> <a href="https://ok.test/">ok</a>` +
    `<img src="javascript:alert(1)"> <img src="data:text/html;base64,AAAA"> <form><input value="x"></form>` +
    `<object data="x"></object><embed src="y"><noscript>n</noscript><custom-tag><b>kept inner</b></custom-tag>`;
  const book = await api.html.convertHtml(fakeFile("unsafe.html", html));
  const body = api.bodyOf(book.chapters[0].html);
  assertWellFormed(api, book.chapters[0]);
  for (const bad of ["<script", "alert(1)", "<style", "<iframe", "onclick", "style=", "data-x", "javascript:", "data:text/html", "<form", "<input", "<object", "<embed", "<noscript", "custom-tag"]) {
    assert.ok(!body.includes(bad), `must not contain ${bad}`);
  }
  assert.match(body, /<p class="k">text<\/p>/, "allowed attributes kept");
  assert.match(body, /<a href="https:\/\/ok\.test\/">ok<\/a>/);
  assert.match(body, /<b>kept inner<\/b>/, "unknown element unwrapped, children kept");
  assert.match(body, /<img\/>/, "img with javascript: src loses the src but stays well-formed");
});

test("control characters are stripped and text with no headings stays one chapter", async () => {
  const api = loadImporters();
  const book = await api.html.convertHtml(fakeFile("plain.html", "<p>bad\u0001char \u0000here</p><p>ok</p>"));
  assert.equal(book.chapters.length, 1);
  assert.equal(book.chapters[0].title, "plain");
  assertWellFormed(api, book.chapters[0]);
  assert.match(api.bodyOf(book.chapters[0].html), /<p>badchar here<\/p><p>ok<\/p>/);
});

test("long text without headings is split by word count into well-formed parts", async () => {
  const api = loadImporters();
  const words = Array.from({ length: 1300 }, (_, i) => `w${i}`).join(" ");
  const chapters = api.split.buildChaptersFromHtml(`<p>${words}</p>`, { wordsPerChapter: 500, partPrefix: "Part" });
  assert.equal(chapters.length, 3);
  chapters.forEach((ch) => assertWellFormed(api, ch));
  assert.deepEqual(Array.from(chapters, (c) => c.title), ["Part 1", "Part 2", "Part 3"]);
});

test("TXT converter output is well-formed too (shared wrapChapterXhtml / escapeXml)", async () => {
  const api = loadImporters();
  const book = await api.txt.convertTxt(fakeFile("notes.txt", "Line one & <two>\n\nSecond paragraph \"quoted\" 中文\n"));
  book.chapters.forEach((ch) => assertWellFormed(api, ch));
  assert.match(api.bodyOf(book.chapters[0].html), /Line one &amp; &lt;two&gt;/);
});

test("EPUB builder validates every chapter and refuses a malformed one", async () => {
  const api = loadImporters();
  const good = api.sanitize.wrapChapterXhtml("ok", "<p>fine<br/></p>");
  const bad = api.sanitize.wrapChapterXhtml("broken", "<p>unclosed <b>bold</p>");
  await assert.rejects(
    api.builder.buildEpubBlob({ title: "t", chapters: [{ id: "chapter-1", title: "ok", html: good }, { id: "chapter-2", title: "broken", html: bad }] }),
    /章节「broken」的 XHTML 不合法/
  );
  const blob = await api.builder.buildEpubBlob({ title: "t", chapters: [{ id: "chapter-1", title: "ok", html: good }] });
  assert.ok(blob.files["OEBPS/chapters/chapter-1.xhtml"]);
  assert.equal(blob.files["mimetype"].content, "application/epub+zip");
});

test("importBookFile for Markdown runs the whole pipeline and zips validated chapters", async () => {
  const api = loadImporters();
  const result = await api.importer.importBookFile(fakeFile("guide.md", MD_FIXTURE), {});
  assert.equal(result.format, "md");
  const names = Object.keys(result.epubBlob.files);
  assert.ok(names.includes("OEBPS/content.opf") && names.includes("OEBPS/nav.xhtml"));
  assert.equal(names.filter((n) => n.startsWith("OEBPS/chapters/")).length, 3);
  for (const n of names.filter((x) => x.endsWith(".xhtml"))) {
    assert.equal(api.sanitize.xmlWellFormedError(result.epubBlob.files[n].content), "", n);
  }
});

test("xmlWellFormedError catches the classic HTML-in-XHTML mistakes", () => {
  const api = loadImporters({ marked: false });
  const err = api.sanitize.xmlWellFormedError;
  assert.equal(err('<?xml version="1.0"?><!DOCTYPE html><html><body><p>a &amp; b<br/></p></body></html>'), "");
  assert.match(err("<html><body><p>a<br></p></body></html>"), /mismatched end tag/);
  assert.match(err("<html><body><p>AT&T</p></body></html>"), /bad entity/);
  assert.match(err("<html><body><p>a &nbsp; b</p></body></html>"), /bad entity/);
  assert.match(err('<html><body><img src=x.png /></body></html>'), /unquoted attribute/);
  assert.match(err('<html><body><p id="a" id="b">x</p></body></html>'), /duplicate attribute/);
  assert.match(err("<html></html><html></html>"), /second root/);
  assert.match(err("<html><body><p>open</body></html>"), /mismatched end tag/);
  assert.match(err("<html><body>\u0001</body></html>"), /invalid control character/);
  assert.match(err("<html><body><p>1 < 2</p></body></html>"), /unescaped <|bad start tag/);
});
