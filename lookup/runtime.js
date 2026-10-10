/**
 * lookup/runtime.js — 查词控制器与扩展后台之间的通道（M7 从 mk-lookup.js 拆出）。
 *
 * zehCreateLookupRuntime(host) 为一个查词控制器生成：
 *   - 扩展上下文失效防护：扩展被重新加载 / 更新后，旧页面里的内容脚本再调用 chrome.* 会抛
 *     「Extension context invalidated」；这里识别它，收起小球与面板，显示一次「请刷新页面」横幅。
 *     页面自己的同名错误不算，必须同时确认本扩展的 chrome.runtime 真的不可用。
 *   - safeSendMessage / safeStorageGet：带失效防护的 chrome.runtime.sendMessage 与 storage 读取。
 *   - isStaleQueryMessage：后台发回的 SHOW_RESULT / SHOW_ERROR / DICT_ENHANCED 是否不属于当前查询。
 *     后台把结果发回发起查询的 frame，扩展页面收 runtime 广播；每个控制器只认领自己当前的 queryId。
 * 失效标记与横幅留在工厂闭包里，每个控制器一份，与拆分前相同。
 * host（由 createController 提供）：
 *   win / uiDoc               控制器所在窗口与挂载 UI 的文档
 *   controllerId              控制器编号（只用于日志）
 *   invalidatedMessage        横幅文字
 *   getMountEl()              横幅挂载点
 *   currentQueryId()          控制器当前的查询编号
 *   clearPending()            把「查词进行中」标记清掉
 *   hideAll() / showErrorPanel(text)   控制器的面板函数
 * 加载：与 lookup/dom-helpers.js 一样只声明，所有查词宿主都在 mk-lookup.js 之前加载 lookup/ 下的文件。
 */

/**
 * 一个查词控制器的后台通道与失效防护。
 * @param {{ win: Window, uiDoc: Document, controllerId: string, invalidatedMessage: string, getMountEl: Function, currentQueryId: Function, clearPending: Function, hideAll: Function, showErrorPanel: Function }} host
 */
function zehCreateLookupRuntime(host) {
  const win = host.win;
  const uiDoc = host.uiDoc;
  const controllerId = host.controllerId;
  const EXT_INVALIDATED_MSG = host.invalidatedMessage;
  const getMountEl = host.getMountEl;
  const hideAll = host.hideAll;
  const showErrorPanel = host.showErrorPanel;

  let extensionDead = false;
  let refreshBannerEl = null;

  // ── 扩展上下文失效防护 ─────────────────────────────────────────────────────

  /** 只认 Chrome 的「Extension context invalidated」；页面自己的错误（如 "token invalidated"）不算 */
  function isInvalidatedError(message) {
    const msg = String(message || "");
    return /Extension context( was)? invalidated/i.test(msg);
  }

  /** 仅当有真实证据（错误信息或 chrome.runtime 已不可用）时才认为扩展上下文失效 */
  function isContextInvalidatedError(err) {
    const msg = err?.message || String(err || "");
    if (isInvalidatedError(msg)) return true;
    try {
      return !chrome.runtime?.id;
    } catch {
      return true;
    }
  }

  /** 非失效类异常（如渲染失败）只记录日志，不把整页查词标记为失效 */
  function handleControllerError(err, context) {
    if (isContextInvalidatedError(err)) {
      markExtensionDead();
      return true;
    }
    console.warn(`[Manekilex] ${context || "lookup"} failed`, err);
    return false;
  }

  function markExtensionDead(source) {
    // isExtensionAlive() 发现上下文失效时只置位 extensionDead；横幅在这里补上（只显示一次）。
    // 以前这里见到 extensionDead 就直接返回，导致扩展重载后的旧标签页永远不提示刷新（0.11.1）。
    if (extensionDead && refreshBannerEl) return;
    const first = !extensionDead;
    extensionDead = true;
    host.clearPending();
    if (first && source === "bubble-click") {
      console.warn("[Manekilex] extension context invalidated on bubble click", {
        controllerId,
      });
    }
    hideAll();
    showRefreshBanner();
  }

  function isExtensionAlive() {
    if (extensionDead) return false;
    try {
      return Boolean(chrome.runtime.getManifest());
    } catch {
      extensionDead = true;
      return false;
    }
  }

  function installInvalidationGuard() {
    // 页面里任何脚本的错误事件都会到这里：除了文字匹配，还要确认本扩展上下文真的不可用
    win.addEventListener(
      "error",
      (event) => {
        if (isInvalidatedError(event.message) && !isExtensionAlive()) {
          event.preventDefault();
          markExtensionDead();
        }
      },
      true
    );
    win.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason;
      const msg = reason?.message || String(reason || "");
      if (isInvalidatedError(msg) && !isExtensionAlive()) {
        event.preventDefault();
        markExtensionDead();
      }
    });
  }

  function showRefreshBanner() {
    if (refreshBannerEl) return;
    refreshBannerEl = uiDoc.createElement("div");
    refreshBannerEl.className = "zeh-refresh-banner";
    refreshBannerEl.setAttribute("data-mk-lookup-ui", "");
    refreshBannerEl.innerHTML =
      `<span>${EXT_INVALIDATED_MSG}</span>` +
      '<button type="button" class="zeh-refresh-banner-btn">刷新页面</button>';
    refreshBannerEl
      .querySelector(".zeh-refresh-banner-btn")
      .addEventListener("click", () => {
        win.location.reload();
      });
    getMountEl().appendChild(refreshBannerEl);
  }

  function safeStorageGet(keys, callback) {
    if (!isExtensionAlive()) {
      callback({});
      return;
    }
    try {
      chrome.storage.local.get(keys, (data) => {
        const err = chrome.runtime.lastError;
        if (err) {
          if (isInvalidatedError(err.message)) markExtensionDead();
          callback({});
          return;
        }
        callback(data || {});
      });
    } catch {
      markExtensionDead();
      callback({});
    }
  }

  function safeSendMessage(message, callback, options) {
    const onTransportError =
      options?.onTransportError ||
      ((text) => {
        host.clearPending();
        showErrorPanel(text);
      });
    if (!isExtensionAlive()) {
      host.clearPending();
      markExtensionDead();
      return;
    }
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const err = chrome.runtime.lastError;
        if (err) {
          if (isInvalidatedError(err.message)) {
            host.clearPending();
            markExtensionDead();
            return;
          }
          onTransportError("无法连接插件后台，请刷新页面或重新加载扩展。");
          return;
        }
        if (callback) callback(response);
      });
    } catch (err) {
      if (isContextInvalidatedError(err)) {
        host.clearPending();
        markExtensionDead();
        return;
      }
      console.warn("[Manekilex] sendMessage failed", err);
      onTransportError("无法连接插件后台，请刷新页面或重新加载扩展。");
    }
  }

  function isExtensionDead() {
    return extensionDead;
  }

  function refreshBanner() {
    return refreshBannerEl;
  }

  /**
   * 每个控制器只认领自己当前的查询（M3b 收紧）：
   *   - SHOW_RESULT / DICT_ENHANCED / 带 queryId 的 SHOW_ERROR 必须带非空字符串 queryId，且等于当前查询；
   *     缺 queryId、queryId 为 null、或当前没有查询（已关闭 / 已超时）一律算过期，不渲染。
   *   - 不带 queryId 的 SHOW_ERROR 是标签页级提示（PDF 查看器里右键查词时 Manekilex 已关闭），照常显示。
   * 后台已把查词结果只发回发起查询的 frame；扩展页面（PDF 阅读器、侧边栏）仍收 runtime 广播，靠这里区分。
   */
  function isStaleQueryMessage(message) {
    if (message.type === "SHOW_ERROR" && !("queryId" in message)) return false;
    const current = host.currentQueryId();
    return !(typeof message.queryId === "string" && message.queryId !== "" && message.queryId === current);
  }

  return {
    isExtensionDead,
    refreshBanner,
    isStaleQueryMessage,
    handleControllerError,
    markExtensionDead,
    isExtensionAlive,
    installInvalidationGuard,
    safeStorageGet,
    safeSendMessage,
  };
}
