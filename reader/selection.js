/**
 * reader/selection.js — 书内选区（M8 从 reader.js 拆出，行为未改）。
 *
 * epub.js 把章节放在 iframe 里，选区坐标是 iframe 内的；查词的猫和右键菜单挂在阅读器顶层页面。
 * 本文件把两者接起来：
 *   - 划词（iframe mouseup）：用 MKLookup 控制器读选区（含句子语境），坐标换算到顶层，
 *     显示猫；语境的 sourceType 为 "epub"，章节序号 / 章节名 / CFI 只进生词本，不发给模型；
 *   - 右键（iframe contextmenu）：在选区（没有选区时用当前位置）处显示「添加书签」菜单，
 *     菜单点击时 reader.js 用 setContextTarget 记下的 { cfi, excerpt } 添加书签。
 *     Linux / macOS 的 Chrome 在按下右键（mousedown）时就发 contextmenu，松开时的 mouseup 不能把
 *     刚打开的菜单关掉；Windows 在 mouseup 之后才发 contextmenu。两种顺序都只在下一次按下时关闭。
 * host：
 *   lookup             reader.js 创建的 MKLookup 控制器
 *   position()         当前位置 { cfi, chapterLabel, spineIndex }
 *   ctxMenu()          右键菜单元素
 *   setContextTarget() 记下右键菜单对应的位置
 * 加载：reader.html 在 reader.js 之前加载 reader/ 下的文件；本文件只声明，加载时不做任何事。
 */

/**
 * 书内选区的两条出口：划词查词的猫、右键书签菜单。
 * @param {{ lookup: object, position: () => { cfi: string, chapterLabel: string, spineIndex: number }, ctxMenu: () => HTMLElement | null, setContextTarget: (target: { cfi: string, excerpt: string }) => void }} host
 */
function zehCreateReaderSelection(host) {
  const lookup = host.lookup;

  // ── 划词查词（iframe 选区 → 顶层坐标）──────────────────────────────────────────

  function iframeRect(contents) {
    try {
      const frame = contents.document.defaultView.frameElement;
      return frame.getBoundingClientRect();
    } catch {
      return { left: 0, top: 0 };
    }
  }

  /** 划词位置：章节序号 / 章节名 / CFI（取不到就省略，不影响查词） */
  function readSelectionLocation(contents, sel) {
    const loc = {};
    try {
      if (sel && sel.rangeCount) {
        const cfi = contents.cfiFromRange(sel.getRangeAt(0));
        if (cfi) loc.cfi = String(cfi);
      }
    } catch {
      /* noop */
    }
    const position = host.position();
    const index = Number.isInteger(contents?.sectionIndex) ? contents.sectionIndex : position.spineIndex;
    if (Number.isInteger(index) && index >= 0) loc.chapterIndex = index;
    if (position.chapterLabel) loc.chapterTitle = position.chapterLabel;
    return loc;
  }

  /** 这一次按下鼠标之后是否打开过右键菜单 */
  let menuOpenedSincePress = false;

  function onIframeMouseDown() {
    menuOpenedSincePress = false;
    hideCtxMenu();
  }

  function onIframeMouseUp(e, contents) {
    if (!menuOpenedSincePress) hideCtxMenu();
    setTimeout(() => {
      let sel;
      try {
        sel = contents.window.getSelection();
      } catch {
        return;
      }
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        if (lookup.hasTrigger() && !lookup.isPending()) lookup.removeTrigger();
        return;
      }

      const info = lookup.getSelectionInfo({
        externalSelection: sel,
        externalDoc: contents.document,
        externalWin: contents.window,
      });
      if (!info || !info.text || !info.text.trim()) {
        if (lookup.hasTrigger() && !lookup.isPending()) lookup.removeTrigger();
        return;
      }
      if (!zehHasEnglish(info.text)) return;

      const fr = iframeRect(contents);
      const r = info.rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
      const rect = {
        left: r.left + fr.left,
        right: r.right + fr.left,
        top: r.top + fr.top,
        bottom: r.bottom + fr.top,
        width: r.width ?? Math.max(0, r.right - r.left),
        height: r.height ?? Math.max(0, r.bottom - r.top),
      };
      const releaseX = e.clientX + fr.left;
      const releaseY = e.clientY + fr.top;

      lookup.presentTrigger({
        text: info.text,
        rect,
        range: null,
        releaseX,
        releaseY,
        originalText: info.originalText,
        selectionExpanded: info.selectionExpanded,
        source: "epub-selection-bubble",
        // 语境来自书中选区附近的原文；位置（章节 / CFI）只存进生词本，不发给模型
        contextSource: info.contextSource ? { ...info.contextSource, sourceType: "epub" } : null,
        contextLocation: readSelectionLocation(contents, sel),
      });
    }, 10);
  }

  function onIframeContextMenu(e, contents) {
    e.preventDefault();
    let cfi = "";
    let excerpt = "";
    try {
      const sel = contents.window.getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        cfi = contents.cfiFromRange(range);
        excerpt = sel.toString().slice(0, 80);
      }
    } catch {
      /* noop */
    }
    if (!cfi) {
      const position = host.position();
      cfi = position.cfi;
      excerpt = position.chapterLabel || "";
    }
    const fr = iframeRect(contents);
    showCtxMenu(e.clientX + fr.left, e.clientY + fr.top, cfi, excerpt);
  }

  function showCtxMenu(x, y, cfi, excerpt) {
    host.setContextTarget({ cfi, excerpt });
    const menu = host.ctxMenu();
    menu.style.left = Math.min(x, window.innerWidth - 160) + "px";
    menu.style.top = Math.min(y, window.innerHeight - 60) + "px";
    menu.hidden = false;
    menuOpenedSincePress = true;
  }

  function hideCtxMenu() {
    const menu = host.ctxMenu();
    if (menu) menu.hidden = true;
  }

  return {
    onIframeMouseDown,
    onIframeMouseUp,
    onIframeContextMenu,
    hideCtxMenu,
  };
}
