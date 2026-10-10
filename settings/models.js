/**
 * 设置页分区「模型与 API」：provider 配置的内存状态、表单同步、保存与旧版设置迁移的请求。
 *
 * 加载时只声明。providersState / activeProvider 由 settings.js 的 loadAll 填充。
 * M9：本页不再直接写 zehProviders / zehActiveProvider。保存时把上次读到的快照和当前编辑发给
 * service worker（SAVE_PROVIDER_SETTINGS），由它在唯一的写入队列里合并、写入，写入完成后才回复；
 * 旧版设置迁移同样请 worker 做（MIGRATE_PROVIDER_SETTINGS）。
 * 合并与启用规则（R-12）不变，只是搬到了 sw/settings.js 的 saveProviderSettings：
 * 本页刚启用的 provider 优先，否则沿用存储里已启用的第一个，都没有时回到 openai。
 * 依赖：settings/core.js（currentSection、mainBody、isExtensionAlive / markExtensionDead、escapeHtml）、
 *       settings/benchmark.js（renderBenchmarkPanel、refreshBenchmarkJobFromStorage，渲染时调用）、
 *       config.js / shared/providers.js（ZEH_PROVIDER_IDS、ZEH_PROVIDER_META、zehMergeProviderEdits 等）。
 */

let providersState = zehDefaultProviders();
/** 上次从存储读到 / 写入的 providers 快照：持久化时只覆盖相对它改过的字段（R-12） */
let providersSnapshot = zehDefaultProviders();

function cloneProviders(state) {
  return JSON.parse(JSON.stringify(state || {}));
}
let activeProvider = "openai";

let saveDebounceTimer = null;

/** 正在等 worker 回复的保存次数；期间收到的 provider 存储变化先记下，回复之后再处理 */
let providerSavesInFlight = 0;
let deferredProviderChanges = null;

let providerKeyErrorId = null;

/**
 * renderModels 正在替换表单。Chrome 会在移除带焦点的输入框时触发 blur，那时读到的是旧表单的值：
 * 这次 blur 不能保存，否则会把别处刚写入的配置（测速选择、另一个设置页）用旧值覆盖回去。
 */
let replacingProviderForm = false;

function syncProvidersFromDom() {
  if (currentSection !== "models") {
    return;
  }

  document.querySelectorAll(".provider-key").forEach((el) => {
    const id = el.dataset.id;
    providersState[id] = providersState[id] || {};
    providersState[id].apiKey = el.value;
  });

  document.querySelectorAll(".provider-model").forEach((el) => {
    const id = el.dataset.id;
    providersState[id] = providersState[id] || {};
    providersState[id].model = el.value;
  });
}

function scheduleAutoSave() {
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(() => {
    saveProviders(true);
  }, 500);
}

/** 向 service worker 发一条消息；扩展已更新（旧页面失效）时标记并给出可读的错误 */
async function sendProviderMessage(message) {
  if (!isExtensionAlive()) {
    markExtensionDead();
    throw new Error("扩展已更新，请刷新本页");
  }
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    if (isInvalidatedError(error?.message || "")) {
      markExtensionDead();
      throw new Error("扩展已更新，请刷新本页");
    }
    throw error;
  }
}

async function persistProviders(showMessage) {
  const sent = cloneProviders(providersState);
  providerSavesInFlight += 1;
  let response;
  try {
    response = await sendProviderMessage({
      type: "SAVE_PROVIDER_SETTINGS",
      base: cloneProviders(providersSnapshot),
      edits: sent,
    });
  } finally {
    providerSavesInFlight -= 1;
  }
  if (!response || response.ok !== true || !response.providers) {
    flushDeferredProviderChanges();
    throw new Error(response?.error || "保存失败，请刷新页面后重试");
  }

  // worker 已写入存储：以写入的结果为准，等回复期间本页又改过的字段保留
  providersState = zehMergeProviderEdits(response.providers, sent, providersState, ZEH_PROVIDER_IDS);
  providersSnapshot = cloneProviders(response.providers);
  activeProvider = response.activeProvider;
  flushDeferredProviderChanges();

  if (showMessage !== false) {
    showStatus(typeof showMessage === "string" ? showMessage : "已保存", "ok");
  }
}

function flushDeferredProviderChanges() {
  if (providerSavesInFlight > 0 || !deferredProviderChanges) return;
  const changes = deferredProviderChanges;
  deferredProviderChanges = null;
  handleProviderStorageChange(changes, "local");
}

/**
 * providers 被别处（service worker 测速写入 model、另一个设置页）改动时：
 * 把本页未保存的修改叠加到新状态上，再刷新表单，避免之后自动保存时用旧状态覆盖。
 */
function pickProviderChanges(changes) {
  const out = {};
  if (changes[ZEH_STORAGE.providers]) out[ZEH_STORAGE.providers] = changes[ZEH_STORAGE.providers];
  if (changes[ZEH_STORAGE.activeProvider]) out[ZEH_STORAGE.activeProvider] = changes[ZEH_STORAGE.activeProvider];
  return out;
}

function handleProviderStorageChange(changes, area) {
  if (area !== "local") return;
  const providerChange = changes[ZEH_STORAGE.providers];
  const activeChange = changes[ZEH_STORAGE.activeProvider];
  if (!providerChange && !activeChange) return;
  if (providerSavesInFlight > 0) {
    // 多半是本页这次保存自己的写入：等 worker 回复、快照更新之后再判断
    deferredProviderChanges = { ...(deferredProviderChanges || {}), ...pickProviderChanges(changes) };
    return;
  }
  const incoming = providerChange
    ? zehMigrateProviderModels(providerChange.newValue || zehDefaultProviders())
    : null;
  if (incoming && JSON.stringify(incoming) === JSON.stringify(providersSnapshot)) {
    if (activeChange && typeof activeChange.newValue === "string") {
      activeProvider = activeChange.newValue;
    }
    return; // 本页自己写入的
  }
  syncProvidersFromDom();
  if (incoming) {
    providersState = zehMergeProviderEdits(incoming, providersSnapshot, providersState, ZEH_PROVIDER_IDS);
    providersSnapshot = cloneProviders(incoming);
  }
  if (activeChange && typeof activeChange.newValue === "string") {
    activeProvider = activeChange.newValue;
  }
  if (currentSection === "models" && typeof renderModels === "function") {
    const focused = document.activeElement;
    const focusKey = focused && focused.dataset ? `${focused.className}|${focused.dataset.id}` : "";
    renderModels();
    if (focusKey) {
      const [cls, id] = focusKey.split("|");
      const again = document.querySelector(`.${cls.split(" ")[0]}[data-id="${id}"]`);
      if (again && typeof again.focus === "function") again.focus();
    }
  }
}

/** @returns {Promise<{ ok: true } | { ok: false, error: string }>} 失败时已在保存状态栏显示错误 */
async function persistProvidersSafe(showMessage) {
  try {
    await persistProviders(showMessage);
    return { ok: true };
  } catch (error) {
    const message = error?.message || "保存失败，请刷新页面后重试";
    showStatus(message, "err");
    return { ok: false, error: message };
  }
}

function showStatus(msg, type) {
  const el = document.getElementById("saveStatus");
  if (el) {
    el.textContent = msg;
    el.className = "status-msg " + (type || "");
  }
}

/**
 * 旧版设置（openaiApiKey / openaiModel）迁移成 zehProviders：由 service worker 完成（与它每次读设置前的
 * migrateLegacySettings 是同一个函数）。worker 不可达时不写任何东西，loadAll 照常按默认配置显示。
 */
async function migrateIfNeeded() {
  try {
    const response = await sendProviderMessage({ type: "MIGRATE_PROVIDER_SETTINGS" });
    if (response?.ok !== true) {
      console.warn("[Manekilex] provider settings migration did not finish", response?.error || "");
    }
  } catch (error) {
    console.warn("[Manekilex] provider settings migration unavailable", error?.message || error);
  }
}

function renderModels() {
  const cards = ZEH_PROVIDER_IDS.map((id) => {
    const meta = ZEH_PROVIDER_META[id];
    const cfg = providersState[id] || { apiKey: "", model: meta.defaultModel, enabled: false };
    const isActive = cfg.enabled;
    return `
      <div class="provider-card ${isActive ? "active" : ""}" data-provider="${id}">
        <div class="provider-head">
          <div class="provider-name">
            <span class="provider-dot" style="background:${meta.chartColor}"></span>
            <span class="provider-name-text">${escapeHtml(meta.name)}</span>
            ${
              providerKeyErrorId === id
                ? `<span class="provider-key-hint">请先输入 ${escapeHtml(meta.name)} Key</span>`
                : ""
            }
          </div>
          <label class="toggle" title="启用此模型">
            <input type="checkbox" class="provider-enable" data-id="${id}" ${isActive ? "checked" : ""} />
            <span class="toggle-slider"></span>
          </label>
        </div>
        <div class="field">
          <label>API Key</label>
          <input type="password" class="provider-key" data-id="${id}" value="${escapeHtml(cfg.apiKey)}" placeholder="填入 ${escapeHtml(meta.name)} Key" autocomplete="off" />
        </div>
        <div class="field">
          <label>模型名称</label>
          <input type="text" class="provider-model" data-id="${id}" value="${escapeHtml(cfg.model || meta.defaultModel)}" placeholder="${escapeHtml(meta.defaultModel)}" />
          <p class="hint">${escapeHtml(meta.modelHint)}</p>
        </div>
      </div>
    `;
  }).join("");

  replacingProviderForm = true;
  try {
    mainBody.innerHTML = `
      <div class="models-scroll">
        ${cards}
      </div>
      <div class="models-footer">
        <p id="saveStatus" class="status-msg"></p>
        <p class="hint">选择启用的平台后会自动保存；未填写 Key 的平台无法启用。</p>
      </div>
      <div id="benchmarkPanelMount"></div>
    `;
  } finally {
    replacingProviderForm = false;
  }

  renderBenchmarkPanel();
  refreshBenchmarkJobFromStorage();

  document.querySelectorAll(".provider-key, .provider-model").forEach((input) => {
    input.addEventListener("input", () => {
      syncProvidersFromDom();
      if (input.classList.contains("provider-key") && providerKeyErrorId === input.dataset.id) {
        providerKeyErrorId = null;
        input.closest(".provider-card")?.querySelector(".provider-key-hint")?.remove();
      }
      scheduleAutoSave();
    });
    input.addEventListener("blur", () => {
      if (replacingProviderForm || !input.isConnected) return;
      syncProvidersFromDom();
      saveProviders(true);
    });
  });

  document.querySelectorAll(".provider-enable").forEach((input) => {
    input.addEventListener("change", async (e) => {
      syncProvidersFromDom();
      const id = e.target.dataset.id;
      const meta = ZEH_PROVIDER_META[id];

      if (e.target.checked) {
        const apiKey = (providersState[id]?.apiKey || "").trim();
        if (!apiKey) {
          providerKeyErrorId = id;
          renderModels();
          return;
        }
        providerKeyErrorId = null;
        ZEH_PROVIDER_IDS.forEach((pid) => {
          providersState[pid] = providersState[pid] || {};
          providersState[pid].enabled = pid === id;
        });
        activeProvider = id;
        const successMsg = `已启用 ${meta.name}`;
        const saved = await saveProviders(false);
        renderModels();
        // renderModels 重建了保存状态栏：失败时重新显示错误，而不是成功提示
        if (saved.ok) showStatus(successMsg, "ok");
        else showStatus(saved.error, "err");
        return;
      } else {
        providersState[id].enabled = false;
        const anyEnabled = ZEH_PROVIDER_IDS.some((pid) => providersState[pid]?.enabled);
        if (!anyEnabled) {
          e.target.checked = true;
          providersState[id].enabled = true;
          activeProvider = id;
        }
      }
      renderModels();
    });
  });
}

async function saveProviders(message) {
  syncProvidersFromDom();
  let showMessage = "已保存";
  if (message === false) {
    showMessage = false;
  } else if (message === true) {
    showMessage = "已自动保存";
  } else if (typeof message === "string") {
    showMessage = message;
  }
  return persistProvidersSafe(showMessage);
}
