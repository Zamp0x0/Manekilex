/**
 * reader/bookmarks.js — 阅读器的书签面板（M8 从 reader.js 拆出，行为未改）。
 *
 * 书签存于 IndexedDB（ZEHBookStore 的 bookmarks 仓库），每条有 label、location（epubcfi）和
 * excerpt。添加时弹窗询问名称（默认取选中的文字或章节名）；面板列出本书全部书签，点名称跳转，
 * 也可重命名、删除。跳转本身（显示 CFI、同步章节与进度、按 bookmark-jump 保存位置）留在
 * reader.js 的 jumpTo。
 * host：
 *   els                 reader.js 的页面元素表（bookmarkPanel、bookmarkList）
 *   bookId              当前书的 id
 *   chapterLabel()      当前章节名（书签默认名称的后备）
 *   toast(text)         短暂提示
 *   jumpTo(cfi)         跳到书签位置
 *   themePanelMoved()   书签面板开 / 关后重新摆放配色面板
 * 加载：reader.html 在 reader.js 之前加载 reader/ 下的文件；本文件只声明，加载时不做任何事。
 */

/**
 * 书签的添加、列表、重命名 / 删除与书签面板的开关。
 * @param {{ els: object, bookId: string | null, chapterLabel: () => string, toast: (text: string) => void, jumpTo: (cfi: string) => Promise<void>, themePanelMoved: () => void }} host
 */
function zehCreateReaderBookmarks(host) {
  const els = host.els;
  const bookId = host.bookId;

  let isBookmarkPanelOpen = false;

  async function addBookmark(cfi, excerpt) {
    if (!cfi) {
      host.toast("无法定位当前位置");
      return;
    }
    const fallback = (excerpt && excerpt.trim()) || host.chapterLabel() || "书签";
    const label = window.prompt("书签名称", fallback.slice(0, 40));
    if (label === null) return; // 用户取消
    try {
      await ZEHBookStore.addBookmark({
        bookId,
        label: label.trim() || fallback,
        location: cfi,
        excerpt: excerpt || "",
      });
      if (isBookmarkPanelOpen) await renderBookmarks();
      host.toast("书签已添加");
    } catch {
      host.toast("保存书签失败");
    }
  }

  async function renderBookmarks() {
    let list = [];
    try {
      list = await ZEHBookStore.getBookmarks(bookId);
    } catch {
      /* noop */
    }
    if (!list.length) {
      els.bookmarkList.innerHTML = `<div class="bookmark-empty">暂无书签</div>`;
      return;
    }
    els.bookmarkList.innerHTML = list.map(bookmarkItemHtml).join("");
  }

  function bookmarkItemHtml(bm) {
    const excerpt = bm.excerpt
      ? `<div class="bookmark-item-excerpt">${zehEscapeHtml(bm.excerpt)}</div>`
      : "";
    return `
      <div class="bookmark-item" data-id="${zehEscapeHtml(bm.id)}">
        <div class="bookmark-item-label" data-jump="${zehEscapeHtml(bm.location)}" title="跳转">${zehEscapeHtml(bm.label)}</div>
        ${excerpt}
        <div class="bookmark-item-actions">
          <button type="button" class="bm-rename" data-id="${zehEscapeHtml(bm.id)}">重命名</button>
          <button type="button" class="bm-delete" data-id="${zehEscapeHtml(bm.id)}">删除</button>
        </div>
      </div>
    `;
  }

  async function onBookmarkListClick(e) {
    const labelEl = e.target.closest(".bookmark-item-label");
    if (labelEl) {
      host.jumpTo(labelEl.dataset.jump);
      return;
    }
    const renameBtn = e.target.closest(".bm-rename");
    if (renameBtn) {
      const id = renameBtn.dataset.id;
      const card = renameBtn.closest(".bookmark-item");
      const cur = card ? card.querySelector(".bookmark-item-label").textContent : "";
      const next = window.prompt("书签名称", cur);
      if (next === null) return;
      try {
        await ZEHBookStore.renameBookmark(id, next.trim() || cur);
        renderBookmarks();
      } catch {
        /* noop */
      }
      return;
    }
    const delBtn = e.target.closest(".bm-delete");
    if (delBtn) {
      try {
        await ZEHBookStore.deleteBookmark(delBtn.dataset.id);
        renderBookmarks();
      } catch {
        /* noop */
      }
    }
  }

  function showBookmarkPanel() {
    if (!els.bookmarkPanel) return;
    els.bookmarkPanel.hidden = false;
  }

  function hideBookmarkPanel() {
    isBookmarkPanelOpen = false;
    if (els.bookmarkPanel) els.bookmarkPanel.hidden = true;
  }

  async function toggleBookmarkPanel() {
    if (isBookmarkPanelOpen) {
      hideBookmarkPanel();
      host.themePanelMoved();
      return;
    }
    isBookmarkPanelOpen = true;
    await renderBookmarks();
    showBookmarkPanel();
    host.themePanelMoved();
  }

  /** 书签面板是否打开 */
  function bookmarkPanelOpen() {
    return isBookmarkPanelOpen;
  }

  return {
    addBookmark,
    onBookmarkListClick,
    hideBookmarkPanel,
    toggleBookmarkPanel,
    bookmarkPanelOpen,
  };
}
