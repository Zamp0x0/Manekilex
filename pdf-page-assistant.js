/**
 * pdf-page-assistant.js — 浏览器内 PDF 页（https://…pdf）右上角猫球 + 查词面板
 * 注入在同一标签页内，非独立窗口。
 *
 * 只服务 Chrome 自带 PDF 查看器（以及旧版 Chrome）：PDF 由 Manekilex 增强阅读器接管时，阅读器里有
 * 自己的划词小猫，这里的猫球先保持隐藏，等后台确认（PDF_PAGE_ASSISTANT_READY 的 suppressed /
 * PDF_PAGE_SUPPRESS）后整体隐藏、不响应查词；切回 Chrome 自带查看器时由 PDF_PAGE_RESTORE 恢复。
 *
 * 点击猫球 = 回到增强阅读器（Chrome 151+）：先问后台能不能用（PDF_PAGE_ENHANCED status：版本、
 * 设置开关、链接类型），再用一次同源的 1 字节请求确认这个链接还能取到 PDF，然后在同一标签页重新加载，
 * 由 Chrome 的 MIME 处理再次交给阅读器。不能重新打开时（过期链接、表单提交生成、本地文件、开关关闭、
 * 旧版 Chrome）不离开当前页面，只显示原因和可用的办法（打开设置 / 在增强阅读器里手动打开本地 PDF）。
 */
(function () {
  function isBrowserPdfPage() {
    if (location.protocol === "chrome-extension:" || location.protocol === "chrome:") return false;
    const path = location.pathname + location.search;
    if (zehIsPdfViewerUrl(path)) return true;
    if (document.contentType === "application/pdf") return true;
    return false;
  }

  /** Chrome 直连 .pdf 时 embed 子帧视口在工具栏下方，不能用来定位猫球 */
  function isChromePdfEmbedSubframe() {
    if (window === window.top) return false;
    try {
      const parentPath = window.parent.location.pathname + window.parent.location.search;
      if (!zehIsPdfViewerUrl(parentPath)) return false;
      return window.parent.location.href.split("#")[0] !== location.href.split("#")[0];
    } catch {
      return false;
    }
  }

  if (!isBrowserPdfPage()) return;
  // 所有 PDF 帧都标记，避免 content.js 在 embed 子帧再挂划词小球
  window.__ZEH_PDF_PAGE__ = true;
  if (isChromePdfEmbedSubframe()) return;
  if (document.getElementById("zeh-pdf-assistant")) return;

  const BALL_TOP = 36;
  const BALL_RIGHT = 54;

  const root = document.createElement("div");
  root.id = "zeh-pdf-assistant";
  // 等后台回复确认这个标签页没有被增强阅读器接管后再显示
  root.hidden = true;
  root.style.setProperty("--zeh-pdf-ball-top", BALL_TOP + "px");
  root.style.setProperty("--zeh-pdf-ball-right", BALL_RIGHT + "px");
  const ballEl = document.createElement("button");
  ballEl.type = "button";
  ballEl.className = "zeh-pdf-assistant-ball";
  ballEl.id = "zehPdfBall";
  ballEl.title = "Manekilex 查词";
  const ballImg = document.createElement("img");
  ballImg.src = chrome.runtime.getURL("icons/icon128.png");
  ballImg.alt = "";
  ballEl.appendChild(ballImg);
  const mountEl = document.createElement("div");
  mountEl.className = "zeh-pdf-assistant-mount";
  mountEl.id = "zehPdfMount";
  const noticeEl = document.createElement("div");
  noticeEl.className = "zeh-pdf-assistant-notice";
  noticeEl.setAttribute("role", "status");
  noticeEl.hidden = true;
  root.appendChild(ballEl);
  root.appendChild(mountEl);
  root.appendChild(noticeEl);
  (document.body || document.documentElement).appendChild(root);

  ballEl.style.setProperty("position", "fixed", "important");
  ballEl.style.setProperty("top", BALL_TOP + "px", "important");
  ballEl.style.setProperty("right", BALL_RIGHT + "px", "important");
  mountEl.style.setProperty("position", "fixed", "important");
  mountEl.style.setProperty("right", BALL_RIGHT + "px", "important");
  mountEl.style.setProperty("top", BALL_TOP + 48 + 8 + "px", "important");

  const ballBtn = ballEl;

  const controller = window.MKLookup.createController({
    win: window,
    doc: document,
    mountEl,
  });

  let manekilexEnabled = true;
  /** 增强 PDF 阅读器接管了这个标签页：猫球与面板都不出现 */
  let suppressed = false;

  function setSuppressed(value) {
    suppressed = Boolean(value);
    if (suppressed) {
      collapsePanel();
      hideNotice();
    }
    root.hidden = suppressed;
    if (!suppressed) refreshEnhancedStatus();
  }

  function applyManekilexEnabled(enabled) {
    manekilexEnabled = enabled !== false;
    window.MKLookup.setGlobalEnabled(manekilexEnabled);
    if (ballBtn) ballBtn.hidden = !manekilexEnabled;
    if (!manekilexEnabled) collapsePanel();
  }

  zehSubscribeEnabled(applyManekilexEnabled);

  function expandPanel() {
    root.classList.add("expanded");
  }

  function collapsePanel() {
    root.classList.remove("expanded");
    controller.hideAll();
  }

  function runLookup(text) {
    if (!manekilexEnabled || suppressed) return false;
    if (!text || !controller.lookupText(text)) return false;
    hideNotice();
    expandPanel();
    return true;
  }

  // ── 回到增强阅读器 ─────────────────────────────────────────────────────────

  /** 同源确认请求多久没有结果算作取不到 */
  const PROBE_TIMEOUT_MS = 8000;
  /** 调用 reload 后多久页面还在，说明 Chrome 没有重新加载（例如取消了重新提交表单） */
  const RELOAD_WATCHDOG_MS = 10000;
  const BALL_TITLE = "Manekilex 查词";
  const BALL_TITLE_ENHANCED = "用 Manekilex 增强阅读器打开这份 PDF";

  const NOTICES = {
    unsupported: {
      text: "这个 Chrome 版本不能让 Manekilex 接管网页里的 PDF（需要 Chrome 151 或更新版本）。在这里选中文字后右键「Manekilex 查词」即可查词；本地 PDF 可以在增强阅读器里手动打开。",
      actions: ["open-file"],
    },
    disabled: {
      text: "「用 Manekilex 打开 PDF」已在设置中关闭，所以 PDF 由 Chrome 自带查看器显示。可以在设置的「阅读」里重新开启。",
      actions: ["open-settings"],
    },
    "local-file": {
      text: "这是本地文件，Manekilex 不能直接重新读取它。请在增强阅读器里重新选择这个文件。",
      actions: ["open-file"],
    },
    source: {
      text: "这份 PDF 不是普通的网页链接（例如嵌在网页里，或由页面临时生成），无法在增强阅读器中重新打开。可以先用 Chrome 查看器的下载按钮保存，再在增强阅读器里打开。",
      actions: ["open-file"],
    },
    unavailable: {
      text: "无法重新取得这份 PDF：链接可能已过期、需要重新登录，或是提交表单生成的。当前页面保持不变；可以先用 Chrome 查看器的下载按钮保存，再在增强阅读器里打开。",
      actions: ["open-file"],
    },
    "not-reloaded": {
      text: "Chrome 没有重新加载这个页面（例如取消了重新提交表单），PDF 仍由 Chrome 自带查看器显示。",
      actions: ["open-file"],
    },
    error: {
      text: "暂时无法切换到增强阅读器，请稍后再试；也可以在增强阅读器里手动打开本地 PDF。",
      actions: ["open-file"],
    },
  };
  const NOTICE_ACTION_LABELS = { "open-file": "打开本地 PDF", "open-settings": "打开设置" };

  let reopening = false;
  let reloadWatchdog = 0;

  function hideNotice() {
    noticeEl.hidden = true;
    noticeEl.replaceChildren();
    delete noticeEl.dataset.reason;
  }

  function runNoticeAction(action) {
    hideNotice();
    const message =
      action === "open-settings"
        ? { type: "OPEN_SETTINGS", section: "reading" }
        : { type: "PDF_PAGE_ENHANCED", action: "open-file" };
    Promise.resolve(chrome.runtime.sendMessage(message)).catch(() => {});
  }

  function showNotice(reason) {
    const notice = NOTICES[reason] || NOTICES.error;
    collapsePanel();
    hideNotice();
    noticeEl.dataset.reason = NOTICES[reason] ? reason : "error";
    const text = document.createElement("p");
    text.className = "zeh-pdf-assistant-notice-text";
    text.textContent = notice.text;
    const actions = document.createElement("div");
    actions.className = "zeh-pdf-assistant-notice-actions";
    for (const action of notice.actions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "zeh-pdf-assistant-notice-btn";
      btn.dataset.action = action;
      btn.textContent = NOTICE_ACTION_LABELS[action];
      btn.addEventListener("click", () => runNoticeAction(action));
      actions.appendChild(btn);
    }
    const close = document.createElement("button");
    close.type = "button";
    close.className = "zeh-pdf-assistant-notice-btn zeh-pdf-assistant-notice-close";
    close.dataset.action = "close";
    close.textContent = "知道了";
    close.addEventListener("click", hideNotice);
    actions.appendChild(close);
    noticeEl.appendChild(text);
    noticeEl.appendChild(actions);
    noticeEl.hidden = false;
  }

  /** 后台判断这个页面能不能交给增强阅读器：{ available, reason } */
  async function requestEnhancedStatus() {
    try {
      const reply = await chrome.runtime.sendMessage({ type: "PDF_PAGE_ENHANCED", action: "status" });
      if (reply && reply.ok) return { available: reply.available === true, reason: reply.reason || null };
    } catch {
      /* 后台没有应答 */
    }
    return { available: false, reason: "error" };
  }

  /** 显示前预先问一次，只用来给猫球换提示文字；点击时会重新确认 */
  function refreshEnhancedStatus() {
    requestEnhancedStatus().then((status) => {
      root.dataset.enhanced = status.available ? "available" : status.reason || "error";
      ballBtn.title = status.available ? BALL_TITLE_ENHANCED : BALL_TITLE;
    });
  }

  /**
   * 重新加载前确认链接还能取到 PDF：同源 GET，只要 1 个字节（Range），不缓存，拿到响应头就取消。
   * 过期 / 需要登录 / 表单提交生成（GET 被拒）都会在这里失败，页面不会被换成错误页。
   */
  async function probeSource() {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
    try {
      const res = await fetch(location.href, {
        method: "GET",
        headers: { Range: "bytes=0-0" },
        cache: "no-store",
        credentials: "same-origin",
        redirect: "follow",
        signal: abort.signal,
      });
      const type = String(res.headers.get("content-type") || "").toLowerCase();
      const disposition = String(res.headers.get("content-disposition") || "").toLowerCase();
      Promise.resolve(res.body?.cancel()).catch(() => {});
      return (res.status === 200 || res.status === 206) && type.includes("application/pdf") && !disposition.startsWith("attachment");
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  function setReopening(value) {
    reopening = value;
    ballBtn.classList.toggle("is-busy", value);
    if (value) ballBtn.setAttribute("aria-busy", "true");
    else ballBtn.removeAttribute("aria-busy");
  }

  async function reopenInEnhancedReader() {
    if (reopening) return;
    setReopening(true);
    hideNotice();
    const status = await requestEnhancedStatus();
    if (!status.available) {
      setReopening(false);
      showNotice(status.reason);
      return;
    }
    if (!(await probeSource())) {
      setReopening(false);
      showNotice("unavailable");
      return;
    }
    // 同一标签页重新加载：Chrome 的 MIME 处理再次把这份 PDF 交给增强阅读器（不新增历史记录）
    clearTimeout(reloadWatchdog);
    reloadWatchdog = setTimeout(() => {
      setReopening(false);
      showNotice("not-reloaded");
    }, RELOAD_WATCHDOG_MS);
    location.reload();
  }

  ballBtn.addEventListener("click", () => {
    if (root.classList.contains("expanded")) {
      collapsePanel();
    } else if (!noticeEl.hidden) {
      hideNotice();
    } else {
      reopenInEnhancedReader();
    }
  });

  function bindPanelCloseToCollapse() {
    const closeBtn = mountEl.querySelector(".zeh-panel-close");
    if (!closeBtn || closeBtn.dataset.pdfBound) return;
    closeBtn.dataset.pdfBound = "1";
    closeBtn.addEventListener("click", () => {
      setTimeout(() => collapsePanel(), 0);
    });
  }

  const observer = new MutationObserver(bindPanelCloseToCollapse);
  observer.observe(mountEl, { childList: true, subtree: true });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || typeof message.type !== "string") return;
    if (message.type === "PDF_PAGE_SUPPRESS") {
      setSuppressed(true);
      return;
    }
    if (message.type === "PDF_PAGE_RESTORE") {
      setSuppressed(false);
      return;
    }
    if (suppressed) return;
    if (message.type === "PDF_PAGE_LOOKUP") {
      if (!manekilexEnabled) return;
      if (message.text) runLookup(message.text);
      else expandPanel();
    } else if (message.type === "PDF_PAGE_COLLAPSE") {
      collapsePanel();
    } else if (message.type === "SHOW_ERROR") {
      expandPanel();
    }
  });

  chrome.runtime
    .sendMessage({ type: "PDF_PAGE_ASSISTANT_READY" })
    .then((reply) => setSuppressed(Boolean(reply && reply.suppressed)))
    .catch(() => setSuppressed(false));

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) collapsePanel();
  });
})();
