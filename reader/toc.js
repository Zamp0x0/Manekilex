/**
 * reader/toc.js — 阅读器的目录列表（M8 从 reader.js 拆出，行为未改）。
 *
 * 把 epub.js 的 navigation.toc 摊平成一列按钮（最多三级缩进），每项按 href 找到对应的
 * spine 序号；阅读时按当前章节（spine 序号 + href）把最贴近的一项标为 is-active。
 * 目录跳转本身（jumpToTocItem：显示章节、锁住高亮、按 toc-jump 保存位置）和目录栏的开合
 * 留在 reader.js。每次读 host.book() / host.currentSpineIndex()，与拆分前读外层变量一致。
 * host：
 *   els                    reader.js 的页面元素表（readerTocList）
 *   readerDebug            ?debug=1 时的调试输出
 *   book()                 当前 epub.js Book
 *   currentSpineIndex()    当前章节的 spine 序号（找不到 href 时的后备）
 *   highlightLocked()      目录跳转进行中，暂不按滚动改高亮
 *   jumpToItem(item, i)    点目录项
 * 加载：reader.html 在 reader.js 之前加载 reader/ 下的文件；本文件只声明，加载时不做任何事。
 */

/**
 * 目录列表：摊平、渲染、href ↔ spine 对应与当前项高亮。
 * @param {{ els: object, readerDebug: Function, book: () => object | null, currentSpineIndex: () => number, highlightLocked: () => boolean, jumpToItem: (item: object, index: number) => Promise<void> }} host
 */
function zehCreateReaderToc(host) {
  const els = host.els;
  const readerDebug = host.readerDebug;

  let tocFlatItems = [];

  function flattenToc(items, depth = 0, out = []) {
    for (const item of items || []) {
      out.push({
        label: (item.label || item.title || "Untitled").trim(),
        href: item.href || "",
        depth,
      });
      if (item.subitems && item.subitems.length) {
        flattenToc(item.subitems, depth + 1, out);
      }
    }
    return out;
  }

  function enrichTocFlatItemsWithSpineIndex() {
    tocFlatItems = tocFlatItems.map((item) => ({
      ...item,
      spineIndex: spineIndexForHref(item.href),
    }));
  }

  function renderToc(toc) {
    const list = els.readerTocList;
    if (!list) return;

    tocFlatItems = flattenToc(toc);
    if (!tocFlatItems.length) {
      list.innerHTML = `<div class="reader-toc-empty">暂无目录</div>`;
      return;
    }

    if (host.book()?.spine) {
      enrichTocFlatItemsWithSpineIndex();
    }

    list.innerHTML = "";
    tocFlatItems.forEach((item, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `reader-toc-item depth-${Math.min(item.depth, 2)}`;
      btn.textContent = item.label;
      btn.dataset.href = item.href || "";
      btn.dataset.tocIndex = String(index);
      if (typeof item.spineIndex === "number") {
        btn.dataset.spineIndex = String(item.spineIndex);
      }
      btn.addEventListener("click", () => {
        void host.jumpToItem(item, index);
      });
      list.appendChild(btn);
    });

    readerDebug("[ReaderTOC] rendered", { count: tocFlatItems.length });
  }

  async function loadBookToc() {
    if (!host.book()) return;
    try {
      await host.book().ready;
      let toc = [];
      if (host.book().navigation && host.book().navigation.toc) {
        toc = host.book().navigation.toc;
      } else if (host.book().loaded && host.book().loaded.navigation) {
        const nav = await host.book().loaded.navigation;
        toc = (nav && nav.toc) || [];
      }
      renderToc(toc);
    } catch (err) {
      console.warn("[ReaderTOC] failed to load toc", err);
      renderToc([]);
    }
  }

  function normalizeTocHref(href) {
    if (!href) return "";
    try {
      return decodeURIComponent(href.split("#")[0]).replace(/\\/g, "/").toLowerCase();
    } catch {
      return href.split("#")[0].replace(/\\/g, "/").toLowerCase();
    }
  }

  function spineIndexForHref(href) {
    if (!host.book()?.spine || !href) return host.currentSpineIndex();
    const base = normalizeTocHref(href);
    for (let i = 0; i < host.book().spine.length; i++) {
      const item = host.book().spine.get(i);
      if (!item?.href) continue;
      const itemHref = normalizeTocHref(item.href);
      if (
        itemHref === base ||
        itemHref.endsWith("/" + base) ||
        base.endsWith("/" + itemHref) ||
        itemHref.endsWith(base)
      ) {
        return i;
      }
    }
    return host.currentSpineIndex();
  }

  function bestTocIndexForSpine(spineIndex, currentHref) {
    if (!tocFlatItems.length || !Number.isInteger(spineIndex)) return -1;

    const normCurrent = normalizeTocHref(currentHref);
    if (normCurrent) {
      for (let i = tocFlatItems.length - 1; i >= 0; i--) {
        const item = tocFlatItems[i];
        const itemSpine =
          typeof item.spineIndex === "number" ? item.spineIndex : spineIndexForHref(item.href);
        if (itemSpine !== spineIndex) continue;
        const normItem = normalizeTocHref(item.href);
        if (
          normCurrent === normItem ||
          normCurrent.endsWith("/" + normItem) ||
          normItem.endsWith("/" + normCurrent)
        ) {
          return i;
        }
      }
    }

    let bestIndex = -1;
    let bestSpine = -1;
    tocFlatItems.forEach((item, index) => {
      const itemSpine =
        typeof item.spineIndex === "number" ? item.spineIndex : spineIndexForHref(item.href);
      if (itemSpine <= spineIndex && itemSpine >= bestSpine) {
        bestSpine = itemSpine;
        bestIndex = index;
      }
    });
    return bestIndex;
  }

  function resolveTocIndexForItem(item, tocIndex) {
    if (typeof tocIndex === "number" && tocIndex >= 0) return tocIndex;
    if (!item?.href) return -1;
    const spineIndex =
      typeof item.spineIndex === "number" ? item.spineIndex : spineIndexForHref(item.href);
    return bestTocIndexForSpine(spineIndex, item.href);
  }

  function setActiveTocIndex(bestIndex) {
    if (bestIndex < 0) return;
    document.querySelectorAll(".reader-toc-item").forEach((btn) => {
      btn.classList.toggle("is-active", parseInt(btn.dataset.tocIndex, 10) === bestIndex);
    });
  }

  function highlightActiveTocBySpine(spineIndex, currentHref) {
    if (host.highlightLocked()) return;
    setActiveTocIndex(bestTocIndexForSpine(spineIndex, currentHref));
  }

  function highlightActiveTocByHref(currentHref) {
    if (!currentHref || host.highlightLocked()) return;
    highlightActiveTocBySpine(spineIndexForHref(currentHref), currentHref);
  }

  /** 目录项数（0 = 没有目录或尚未载入） */
  function tocItemCount() {
    return tocFlatItems.length;
  }

  return {
    loadBookToc,
    spineIndexForHref,
    resolveTocIndexForItem,
    setActiveTocIndex,
    highlightActiveTocBySpine,
    highlightActiveTocByHref,
    tocItemCount,
  };
}
