/**
 * reader/theme.js — 阅读器的纸张 / 背景配色（M8 从 reader.js 拆出，行为未改）。
 *
 * 配色只有两项：shellBg（阅读区外的底色）和 paperBg（书页底色），存于 zehReaderTheme；
 * 「配色」面板点选后立即保存并应用。应用时同时改顶层页面、epub.js 容器和章节 iframe 里
 * 透明 / 纯白的块；正在 resize 或切换宽度时不改 epub.js 主题（避免打断位置恢复），
 * 之后由 scheduleReaderThemeReapply 补上。
 * host：
 *   els                  reader.js 的页面元素表（themePanel、toggleThemeBtn、closeThemeBtn、bookmarkPanel）
 *   debug / readerDebug  ?debug=1 与调试输出
 *   rendition()          当前 epub.js rendition
 *   layoutBusy()         是否正在 resize / 恢复位置 / 切换宽度
 *   applyTypography()    重新应用正文排版主题
 *   bookmarkPanelOpen()  书签面板是否打开（配色面板摆在它下方）
 * 加载：reader.html 在 reader.js 之前加载 reader/ 下的文件；本文件只声明，加载时不做任何事。
 */

/**
 * 配色的状态、应用、保存与配色面板。
 * @param {{ els: object, debug: boolean, readerDebug: Function, rendition: () => object | null, layoutBusy: () => boolean, applyTypography: () => void, bookmarkPanelOpen: () => boolean }} host
 */
function zehCreateReaderTheme(host) {
  const els = host.els;
  const readerDebug = host.readerDebug;

  let isThemePanelOpen = false;

  const READER_THEME_DEFAULTS = { shellBg: "#f2f2f2", paperBg: "#fff8e8" };
  let currentReaderTheme = { ...READER_THEME_DEFAULTS };

  function applyReaderTheme(theme) {
    currentReaderTheme = {
      shellBg: READER_THEME_DEFAULTS.shellBg,
      paperBg: READER_THEME_DEFAULTS.paperBg,
      ...(theme || currentReaderTheme || {}),
    };

    const root = document.documentElement;
    root.style.setProperty("--reader-shell-bg", currentReaderTheme.shellBg);
    root.style.setProperty("--reader-paper-bg", currentReaderTheme.paperBg);

    const shellSelectors = ["html", "body", ".reader-root", ".reader-main", ".reader-stage"];
    shellSelectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        if (!el?.style) return;
        el.style.background = currentReaderTheme.shellBg;
        el.style.backgroundColor = currentReaderTheme.shellBg;
      });
    });

    const paperSelectors = [".reader-viewer", ".epub-container", ".epub-view", ".reader-viewer iframe"];
    paperSelectors.forEach((sel) => {
      document.querySelectorAll(sel).forEach((el) => {
        if (!el?.style) return;
        el.style.background = currentReaderTheme.paperBg;
        el.style.backgroundColor = currentReaderTheme.paperBg;
      });
    });

    const iframes = document.querySelectorAll(".reader-viewer iframe");
    iframes.forEach((iframe) => {
      try {
        const doc = iframe.contentDocument;
        if (!doc?.documentElement) return;

        doc.documentElement.style.background = currentReaderTheme.paperBg;
        doc.documentElement.style.backgroundColor = currentReaderTheme.paperBg;
        if (doc.body?.style) {
          doc.body.style.background = currentReaderTheme.paperBg;
          doc.body.style.backgroundColor = currentReaderTheme.paperBg;
        }

        const view = doc.defaultView;
        if (!view) return;

        doc.querySelectorAll("section, div, article, main, p").forEach((el) => {
          if (!el?.isConnected || !el.style) return;
          const computed = view.getComputedStyle(el);
          if (
            computed.backgroundColor === "rgba(0, 0, 0, 0)" ||
            computed.backgroundColor === "transparent" ||
            computed.backgroundColor === "rgb(255, 255, 255)"
          ) {
            el.style.backgroundColor = currentReaderTheme.paperBg;
          }
        });
      } catch (err) {
        if (host.debug) {
          console.warn("[ReaderTheme] iframe apply skipped", err);
        }
      }
    });

    if (host.rendition()?.themes && !host.layoutBusy()) {
      try {
        host.rendition().themes.override("body", {
          background: `${currentReaderTheme.paperBg} !important`,
        });
        host.applyTypography();
      } catch (err) {
        if (host.debug) {
          console.warn("[ReaderTheme] rendition theme skipped", err);
        }
      }
    }

    if (host.debug) {
      readerDebug("[ReaderTheme] applied", currentReaderTheme);
    }
  }

  function scheduleReaderThemeReapply() {
    if (host.layoutBusy()) {
      return;
    }
    setTimeout(() => {
      if (host.layoutBusy()) return;
      applyReaderTheme(currentReaderTheme);
    }, 50);
  }

  async function loadReaderThemePrefs() {
    try {
      const result = await new Promise((resolve) => {
        chrome.storage.local.get([ZEH_STORAGE.readerTheme], (data) => resolve(data || {}));
      });
      currentReaderTheme = {
        shellBg: READER_THEME_DEFAULTS.shellBg,
        paperBg: READER_THEME_DEFAULTS.paperBg,
        ...(result[ZEH_STORAGE.readerTheme] || {}),
      };
      if (host.debug) {
        readerDebug("[ReaderTheme] loaded", currentReaderTheme);
      }
      applyReaderTheme(currentReaderTheme);
      renderThemePanelSelection(currentReaderTheme);
    } catch {
      currentReaderTheme = { ...READER_THEME_DEFAULTS };
      applyReaderTheme(currentReaderTheme);
      renderThemePanelSelection(currentReaderTheme);
    }
  }

  async function saveReaderThemePrefs(theme) {
    currentReaderTheme = {
      shellBg: READER_THEME_DEFAULTS.shellBg,
      paperBg: READER_THEME_DEFAULTS.paperBg,
      ...(theme || {}),
    };
    try {
      await new Promise((resolve, reject) => {
        chrome.storage.local.set({ [ZEH_STORAGE.readerTheme]: currentReaderTheme }, () => {
          if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
          else resolve();
        });
      });
    } catch (err) {
      console.warn("[ReaderTheme] save failed", err);
    }
    if (host.debug) {
      readerDebug("[ReaderTheme] saved", currentReaderTheme);
    }
    applyReaderTheme(currentReaderTheme);
    renderThemePanelSelection(currentReaderTheme);
  }

  function renderThemePanelSelection(theme) {
    document.querySelectorAll(".theme-choice").forEach((btn) => {
      const type = btn.dataset.themeType;
      const color = btn.dataset.color;
      btn.classList.toggle("is-active", theme[type] === color);
    });
  }

  function updateThemePanelPosition() {
    if (!els.themePanel || els.themePanel.hidden) return;
    const bookmarkOpen =
      host.bookmarkPanelOpen() && els.bookmarkPanel && !els.bookmarkPanel.hidden;
    if (bookmarkOpen) {
      const rect = els.bookmarkPanel.getBoundingClientRect();
      els.themePanel.style.top = `${Math.round(rect.bottom + 12)}px`;
    } else {
      els.themePanel.style.top = "56px";
    }
    els.themePanel.style.right = "18px";
  }

  function showThemePanel() {
    if (!els.themePanel) return;
    els.themePanel.hidden = false;
    isThemePanelOpen = true;
    renderThemePanelSelection(currentReaderTheme);
    updateThemePanelPosition();
  }

  function hideThemePanel() {
    if (!els.themePanel) return;
    els.themePanel.hidden = true;
    isThemePanelOpen = false;
  }

  function toggleThemePanel() {
    if (isThemePanelOpen) hideThemePanel();
    else showThemePanel();
  }

  function setupThemePanel() {
    renderThemePanelSelection(currentReaderTheme);
    if (els.toggleThemeBtn) {
      els.toggleThemeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        toggleThemePanel();
      });
    }
    if (els.closeThemeBtn) {
      els.closeThemeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        hideThemePanel();
      });
    }
    document.querySelectorAll(".theme-choice").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const type = btn.dataset.themeType;
        const color = btn.dataset.color;
        if (!type || !color) return;

        if (host.debug) {
          readerDebug("[ReaderTheme] click", { type, color });
        }

        const next = {
          ...currentReaderTheme,
          [type]: color,
        };

        await saveReaderThemePrefs(next);
      });
    });
  }

  /** 当前配色（reader.js 排版主题与重新应用时读取） */
  function readerThemeNow() {
    return currentReaderTheme;
  }

  return {
    READER_THEME_DEFAULTS,
    readerThemeNow,
    applyReaderTheme,
    scheduleReaderThemeReapply,
    loadReaderThemePrefs,
    setupThemePanel,
    updateThemePanelPosition,
  };
}
