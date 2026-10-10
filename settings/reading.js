/**
 * 设置页分区「阅读」：分区骨架、增强 PDF 阅读器开关（Chrome 151+ 的 chrome.mimeHandler，只读写用户偏好）、
 * 本地书架（渲染、改名、拖拽排序、删除）与打开 reader.html。
 *
 * 加载时只声明。导入流程在 settings/book-import.js。
 * 依赖：settings/core.js（mainBody、escapeHtml）、settings/book-import.js（handleBookUpload、cancelBookImport、bookImportAbort）、
 *       book-store.js（MKBookStore）。
 */

function renderReading() {
  if (bookImportAbort) {
    bookImportAbort.abort();
    bookImportAbort = null;
  }

  mainBody.innerHTML = `
    <div class="pdf-reader-card" id="pdfReaderCard">
      <div class="pdf-reader-card-head">
        <strong>增强 PDF 阅读器</strong>
        <label class="pdf-reader-switch">
          <input type="checkbox" id="pdfHandlerToggle" disabled />
          <span>用 Manekilex 打开网页里的 PDF</span>
        </label>
      </div>
      <p class="pdf-reader-status" id="pdfHandlerStatus">正在读取设置…</p>
      <p class="pdf-reader-desc">保留原排版阅读，选中英文后点小猫查词，可把生词连同所在页码存进生词本。文件只在本机浏览器里打开。</p>
      <button type="button" class="mk-btn mk-btn-secondary mk-btn-sm" id="openPdfReaderBtn">打开本地 PDF…</button>
    </div>
    <div class="reading-intro">
      <p>支持 <strong>EPUB / TXT / Markdown / HTML / DOCX / PDF</strong>。非 EPUB 会在<strong>本机浏览器</strong>内转换为 EPUB，不会上传服务器。</p>
      <p>PDF 支持<strong>文本模式</strong>（可划词，排版可能丢失）与<strong>原貌模式</strong>（保留排版，不可正常划词，文件较大）。暂不支持 OCR / MOBI / AZW3 / DJVU / CHM / DRM。</p>
    </div>
    <div class="reading-toolbar">
      <label class="mk-btn mk-btn-primary mk-btn-md mk-btn-cat mk-btn-cat-left reading-upload-btn">
        <img class="mk-btn-cat-img mk-btn-cat-md" src="icons/css_3.png" alt="" />
        <span>上传书籍</span>
        <input type="file" id="bookUpload" accept=".epub,.txt,.md,.markdown,.html,.htm,.docx,.pdf,application/epub+zip,text/plain,text/markdown,text/html,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden />
      </label>
      <span class="reading-hint" id="readingHint"></span>
    </div>
    <div class="book-import-progress" id="bookImportProgress" hidden>
      <div class="book-import-message" id="bookImportMessage">准备中…</div>
      <div class="book-import-bar-wrap"><div class="book-import-bar" id="bookImportBar"></div></div>
      <button type="button" class="mk-btn mk-btn-secondary mk-btn-sm" id="bookImportCancel">取消</button>
    </div>
    <div class="pdf-mode-dialog" id="pdfModeDialog" hidden>
      <div class="pdf-mode-card">
        <h3>选择 PDF 导入模式</h3>
        <button type="button" class="pdf-mode-option" data-pdf-mode="text">
          <strong>文本模式</strong>
          <span>适合可复制文字的 PDF。转换后可划词查词，但图片、公式、复杂排版可能丢失。</span>
        </button>
        <button type="button" class="pdf-mode-option" data-pdf-mode="image">
          <strong>原貌模式</strong>
          <span>每页转成图片，保留原 PDF 样子，但不能正常划词，文件较大，占用更多本地存储。</span>
        </button>
        <button type="button" class="mk-btn mk-btn-secondary mk-btn-sm pdf-mode-close">取消</button>
      </div>
    </div>
    <div class="book-rename-dialog" id="bookRenameDialog" hidden>
      <div class="book-rename-card">
        <h3>重命名图书</h3>
        <input type="text" class="book-rename-input" id="bookRenameInput" maxlength="200" placeholder="输入书名" />
        <div class="book-rename-actions">
          <button type="button" class="mk-btn mk-btn-primary mk-btn-sm" id="bookRenameSave">保存</button>
          <button type="button" class="mk-btn mk-btn-secondary mk-btn-sm" id="bookRenameCancel">取消</button>
        </div>
      </div>
    </div>
    <div class="bookshelf" id="bookshelf"></div>
  `;

  setupPdfReaderCard();

  const input = document.getElementById("bookUpload");
  input.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (file) await handleBookUpload(file);
  });

  document.getElementById("bookImportCancel")?.addEventListener("click", cancelBookImport);

  const shelf = document.getElementById("bookshelf");
  shelf.addEventListener("click", onBookshelfClick);
  setupBookRenameDialog();
  setupBookshelfDragDrop(shelf);

  renderBookshelf();
}

// ─── 增强 PDF 阅读器：Chrome 151+ 的 PDF 处理开关（chrome.mimeHandler）与手动打开入口 ─────────

const PDF_MIME_TYPE = "application/pdf";

/** Chrome 151+ 才有；旧版 Chrome 返回 null（manifest 里的 mime_types_handler 不起作用） */
function pdfMimeHandlerApi() {
  const api = (globalThis.chrome && chrome.mimeHandler) || (globalThis.browser && globalThis.browser.mimeHandler) || null;
  return api && typeof api.getMimeHandlerOptions === "function" && typeof api.setMimeHandlerOptions === "function"
    ? api
    : null;
}

function pdfHandlerStatusText(enabled) {
  return enabled
    ? "已开启：之后打开的 PDF 会用 Manekilex 阅读器显示（已经打开的 PDF 标签页需要刷新）。阅读器里随时可以切回 Chrome 自带查看器，在 Chrome 查看器里点右上角的猫咪即可回到 Manekilex 阅读器。"
    : "已关闭：PDF 由 Chrome 自带查看器显示，选中文字后可右键「Manekilex 查词」。";
}

async function setupPdfReaderCard() {
  const toggle = document.getElementById("pdfHandlerToggle");
  const status = document.getElementById("pdfHandlerStatus");
  document.getElementById("openPdfReaderBtn")?.addEventListener("click", () => {
    chrome.tabs.create({ url: chrome.runtime.getURL(ZEH_PDF_READER_PAGE) });
  });
  if (!toggle || !status) return;
  const api = pdfMimeHandlerApi();
  if (!api) {
    toggle.checked = false;
    toggle.disabled = true;
    status.textContent =
      "当前 Chrome 版本不支持让扩展接管 PDF（需要 Chrome 151 或更新版本）。网页里的 PDF 继续由 Chrome 自带查看器显示，选中文字后可右键「Manekilex 查词」；本地 PDF 可以用下面的按钮打开。";
    return;
  }
  try {
    const options = await api.getMimeHandlerOptions(PDF_MIME_TYPE);
    toggle.checked = options?.enabled !== false;
    toggle.disabled = false;
    status.textContent = pdfHandlerStatusText(toggle.checked);
  } catch (err) {
    toggle.disabled = true;
    status.textContent = `无法读取 PDF 打开方式：${err?.message || err}`;
    return;
  }
  toggle.addEventListener("change", async () => {
    const wanted = toggle.checked;
    toggle.disabled = true;
    try {
      await api.setMimeHandlerOptions(PDF_MIME_TYPE, { enabled: wanted });
      const now = await api.getMimeHandlerOptions(PDF_MIME_TYPE);
      toggle.checked = now?.enabled !== false;
      status.textContent = pdfHandlerStatusText(toggle.checked);
    } catch (err) {
      toggle.checked = !wanted;
      status.textContent = `设置没有生效：${err?.message || err}`;
    } finally {
      toggle.disabled = false;
    }
  });
}

function calculateProgressFromSpineRatio(spineIndex, ratio, totalSpineItems) {
  if (!Number.isInteger(spineIndex) || typeof ratio !== "number") return null;
  if (!totalSpineItems || totalSpineItems <= 0) return null;
  return (spineIndex + ratio) / totalSpineItems;
}

function bookshelfBookDebugFields(book) {
  return {
    bookId: book.id,
    title: book.title,
    progress: book.progress,
    currentSpineIndex: book.currentSpineIndex,
    chapterScrollRatio: book.chapterScrollRatio,
    derivedProgress: calculateProgressFromSpineRatio(
      book.currentSpineIndex,
      book.chapterScrollRatio,
      book.totalSpineItems
    ),
    totalSpineItems: book.totalSpineItems,
    lastReadAt: book.lastReadAt,
  };
}

function posFmtProgressSettings(p) {
  if (typeof p !== "number" || !Number.isFinite(p)) return "?";
  return `${(p * 100).toFixed(2)}%`;
}

function posFmtRatioSettings(r) {
  if (typeof r !== "number" || !Number.isFinite(r)) return "?";
  return r.toFixed(4);
}

function bookshelfPosLogLine(book) {
  const derived = calculateProgressFromSpineRatio(
    book.currentSpineIndex,
    book.chapterScrollRatio,
    book.totalSpineItems
  );
  return {
    line: `[ZEH_POS] settings card progress=${posFmtProgressSettings(book.progress)} ratio=${posFmtRatioSettings(book.chapterScrollRatio)} spine=${book.currentSpineIndex} derived=${posFmtProgressSettings(derived)}`,
    fields: bookshelfBookDebugFields(book),
  };
}

async function renderBookshelf() {
  const shelf = document.getElementById("bookshelf");
  if (!shelf) return;
  let books = [];
  try {
    books = await ZEHBookStore.getAllBooks();
  } catch {
    shelf.innerHTML = `<div class="bookshelf-empty">无法读取本地书库。</div>`;
    return;
  }
  if (!books.length) {
    shelf.innerHTML = `
      <div class="bookshelf-empty">
        <img class="bookshelf-empty-cat" src="icons/css_5.png" alt="" />
        <p>还没有书，上传一本书开始阅读。</p>
      </div>
    `;
    return;
  }
  for (const book of books) {
    const { line, fields } = bookshelfPosLogLine(book);
    zehDebugLog(line, fields);
  }
  shelf.innerHTML = books.map(bookCardHtml).join("");
  setupBookshelfDragDrop(shelf);
}

function bookCardHtml(book) {
  const cover = book.coverBlob
    ? `<img class="book-cover" src="${URL.createObjectURL(book.coverBlob)}" alt="" />`
    : `<div class="book-cover book-cover-placeholder">${escapeHtml((book.title || "?").slice(0, 1))}</div>`;
  const pctLabel = zehFormatProgressPct(book.progress);
  const pctBar = Math.min(100, Math.max(0, (Number(book.progress) || 0) * 100));
  const last = book.lastReadAt ? formatReadingTime(book.lastReadAt) : "未读";
  return `
    <div class="book-card" data-id="${escapeHtml(book.id)}" draggable="true">
      <button type="button" class="book-rename-btn" data-id="${escapeHtml(book.id)}" title="重命名" aria-label="重命名">
        <img src="icons/rename.png" alt="" />
      </button>
      <div class="book-cover-wrap">${cover}</div>
      <div class="book-title" title="${escapeHtml(book.title)}">${escapeHtml(book.title)}</div>
      <div class="book-author">${escapeHtml(book.author)}</div>
      <div class="book-progress"><div class="book-progress-bar" style="width:${pctBar}%"></div></div>
      <div class="book-meta">${pctLabel} · ${escapeHtml(last)}</div>
      <div class="mk-book-actions">
        <button type="button" class="mk-btn mk-btn-primary mk-btn-sm mk-btn-cat mk-btn-cat-left book-open" data-id="${escapeHtml(book.id)}">
          <img class="mk-btn-cat-img mk-btn-cat-sm" src="icons/css_5.png" alt="" />
          <span>继续阅读</span>
        </button>
        <button type="button" class="mk-btn mk-btn-danger mk-btn-sm book-delete" data-id="${escapeHtml(book.id)}">删除图书</button>
      </div>
    </div>
  `;
}

let bookRenameTargetId = null;

function setupBookRenameDialog() {
  const dialog = document.getElementById("bookRenameDialog");
  const input = document.getElementById("bookRenameInput");
  const saveBtn = document.getElementById("bookRenameSave");
  const cancelBtn = document.getElementById("bookRenameCancel");
  if (!dialog || !input || dialog.dataset.bound) return;
  dialog.dataset.bound = "1";

  const closeDialog = () => {
    dialog.hidden = true;
    bookRenameTargetId = null;
    input.value = "";
  };

  saveBtn?.addEventListener("click", async () => {
    if (!bookRenameTargetId) return;
    const title = input.value.trim();
    if (!title) {
      input.focus();
      return;
    }
    try {
      await ZEHBookStore.updateBookTitle(bookRenameTargetId, title);
      closeDialog();
      renderBookshelf();
    } catch {
      alert("重命名失败，请重试。");
    }
  });

  cancelBtn?.addEventListener("click", closeDialog);
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) closeDialog();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveBtn?.click();
    } else if (e.key === "Escape") {
      closeDialog();
    }
  });
}

function openBookRenameDialog(bookId, currentTitle) {
  const dialog = document.getElementById("bookRenameDialog");
  const input = document.getElementById("bookRenameInput");
  if (!dialog || !input) return;
  bookRenameTargetId = bookId;
  input.value = currentTitle || "";
  dialog.hidden = false;
  input.focus();
  input.select();
}

function setupBookshelfDragDrop(shelf) {
  if (!shelf || shelf.dataset.dragBound) return;
  shelf.dataset.dragBound = "1";

  let draggedId = null;

  const clearDropHints = () => {
    shelf.querySelectorAll(".book-card-drop-before, .book-card-drop-after").forEach((el) => {
      el.classList.remove("book-card-drop-before", "book-card-drop-after");
    });
  };

  shelf.addEventListener("dragstart", (e) => {
    const card = e.target.closest(".book-card");
    if (!card || e.target.closest("button")) {
      e.preventDefault();
      return;
    }
    draggedId = card.dataset.id;
    card.classList.add("book-card-dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", draggedId);
    const rect = card.getBoundingClientRect();
    e.dataTransfer.setDragImage(
      card,
      Math.min(e.clientX - rect.left, rect.width - 20),
      Math.min(e.clientY - rect.top, rect.height - 20)
    );
  });

  shelf.addEventListener("dragend", (e) => {
    const card = e.target.closest(".book-card");
    if (card) card.classList.remove("book-card-dragging");
    clearDropHints();
    draggedId = null;
  });

  shelf.addEventListener("dragover", (e) => {
    if (!draggedId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const card = e.target.closest(".book-card");
    if (!card || card.dataset.id === draggedId) {
      clearDropHints();
      return;
    }
    const rect = card.getBoundingClientRect();
    const before = e.clientX < rect.left + rect.width / 2;
    shelf.querySelectorAll(".book-card").forEach((c) => {
      if (c === card) {
        c.classList.toggle("book-card-drop-before", before);
        c.classList.toggle("book-card-drop-after", !before);
      } else {
        c.classList.remove("book-card-drop-before", "book-card-drop-after");
      }
    });
  });

  shelf.addEventListener("drop", async (e) => {
    e.preventDefault();
    clearDropHints();
    const targetCard = e.target.closest(".book-card");
    if (!targetCard || !draggedId || targetCard.dataset.id === draggedId) return;

    const cards = [...shelf.querySelectorAll(".book-card")];
    const ids = cards.map((c) => c.dataset.id);
    const fromIdx = ids.indexOf(draggedId);
    let toIdx = ids.indexOf(targetCard.dataset.id);
    if (fromIdx < 0 || toIdx < 0) return;

    const rect = targetCard.getBoundingClientRect();
    const insertBefore = e.clientX < rect.left + rect.width / 2;
    ids.splice(fromIdx, 1);
    if (fromIdx < toIdx) toIdx -= 1;
    if (!insertBefore) toIdx += 1;
    ids.splice(toIdx, 0, draggedId);

    try {
      await ZEHBookStore.reorderBooks(ids);
      renderBookshelf();
    } catch {
      alert("排序保存失败，请重试。");
    }
    draggedId = null;
  });
}

async function onBookshelfClick(e) {
  const renameBtn = e.target.closest(".book-rename-btn");
  if (renameBtn) {
    e.preventDefault();
    e.stopPropagation();
    const card = renameBtn.closest(".book-card");
    const title = card?.querySelector(".book-title")?.textContent || "";
    openBookRenameDialog(renameBtn.dataset.id, title);
    return;
  }
  const openBtn = e.target.closest(".book-open");
  if (openBtn) {
    openReader(openBtn.dataset.id);
    return;
  }
  const delBtn = e.target.closest(".book-delete");
  if (delBtn) {
    const card = delBtn.closest(".book-card");
    const title = (card && card.querySelector(".book-title")?.textContent) || "这本书";
    if (window.confirm(`确定删除《${title}》？书签也会一并删除。`)) {
      try {
        await ZEHBookStore.deleteBook(delBtn.dataset.id);
      } catch {
        /* noop */
      }
      renderBookshelf();
    }
  }
}

async function openReader(id) {
  const readerBase = chrome.runtime.getURL("reader.html");
  const readerUrl = `${readerBase}?id=${encodeURIComponent(id)}`;

  let freshBook = null;
  try {
    freshBook = await ZEHBookStore.getBook(id);
    const derived = freshBook
      ? calculateProgressFromSpineRatio(
          freshBook.currentSpineIndex,
          freshBook.chapterScrollRatio,
          freshBook.totalSpineItems
        )
      : null;
    zehDebugLog(
      `[ZEH_POS] continue fresh book progress=${posFmtProgressSettings(freshBook?.progress)} ratio=${posFmtRatioSettings(freshBook?.chapterScrollRatio)} spine=${freshBook?.currentSpineIndex} derived=${posFmtProgressSettings(derived)}`,
      freshBook ? bookshelfBookDebugFields(freshBook) : { bookId: id }
    );
  } catch {
    zehDebugLog("[ZEH_POS] continue fresh book error=getBook failed bookId=" + id);
  }

  try {
    const tabs = await chrome.tabs.query({});
    const existing = tabs.filter((tab) => {
      if (!tab.url || !tab.url.startsWith(readerBase)) return false;
      try {
        return new URL(tab.url).searchParams.get("id") === id;
      } catch {
        return false;
      }
    });

    for (const tab of existing) {
      if (tab.id == null) continue;
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        /* noop */
      }
    }
  } catch {
    /* fallback to create below */
  }

  zehDebugLog("[ZEH_POS] open fresh reader tab no reuse bookId=" + id);
  chrome.tabs.create({ url: readerUrl });
}

function formatReadingTime(ts) {
  const diff = Date.now() - ts;
  const min = 60 * 1000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    return "";
  }
}
