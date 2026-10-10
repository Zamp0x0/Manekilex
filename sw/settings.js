/**
 * Service worker 模块：读取设置与 provider 配置。
 *
 * 由 background.js 的 importScripts 列表加载。本文件只声明，加载时不调用任何 chrome API。
 * 依赖：config.js（ZEH_STORAGE、ZEH_PROVIDER_IDS、ZEH_PROVIDER_META、zehDefaultProviders、
 *       zehDefaultTheme、zehMigrateProviderModels）、chrome.storage.local（只在函数被调用时使用）。
 * 使用方：查词、语境增强、转写翻译、benchmark、onInstalled 监听、设置页保存（SAVE_PROVIDER_SETTINGS）。
 * migrateLegacySettings 每次 getAppSettings 都会运行（已迁移时不写入），行为与拆分前相同。
 *
 * M9：持久化的 provider 配置（zehProviders + zehActiveProvider）只由 service worker 写入。
 * 设置页保存、测速「使用此模型」和旧设置迁移都经过 zehWithProviderConfigLock 排队，
 * 每一次都是「读最新值 → 合并 → 写回」整体完成后才轮到下一次，同时发生的修改不会互相覆盖。
 */

// ─── provider 配置的唯一写入方（M9）────────────────────────────────────────────
let _providerConfigQueue = Promise.resolve();

/** 依次执行修改 provider 配置的任务；任务失败不影响后面的任务（失败由调用方回给页面） */
function zehWithProviderConfigLock(task) {
  const run = _providerConfigQueue.then(() => task());
  _providerConfigQueue = run.catch(() => {});
  return run;
}

/**
 * 还没有 zehProviders 时，用旧版设置（openaiApiKey / openaiModel）生成初始 provider 配置；
 * 已有配置时返回 null（不改动）。
 */
function legacyProviderPatch(data) {
  if (data[ZEH_STORAGE.providers]) return null;
  const providers = zehDefaultProviders();
  if (data[ZEH_STORAGE.openaiApiKey]) {
    providers.openai.apiKey = data[ZEH_STORAGE.openaiApiKey];
    providers.openai.enabled = true;
    ZEH_PROVIDER_IDS.forEach((id) => {
      if (id !== "openai") {
        providers[id].enabled = false;
      }
    });
  }
  if (data[ZEH_STORAGE.openaiModel]) {
    providers.openai.model = data[ZEH_STORAGE.openaiModel];
  }
  // 不再初始化 zehVocabulary / zehUsageLogs：读取方都把缺失当作 []，写 [] 只会有覆盖已有数据的风险
  return {
    [ZEH_STORAGE.providers]: providers,
    [ZEH_STORAGE.activeProvider]: "openai",
  };
}

/**
 * 设置页打开时的迁移（MIGRATE_PROVIDER_SETTINGS）：只做设置页原来 migrateIfNeeded 做的事，
 * 即还没有 zehProviders 时由旧版设置生成；已有配置时什么都不写。
 */
function migrateLegacyProviderSettings() {
  return zehWithProviderConfigLock(async () => {
    const data = await chrome.storage.local.get([
      ZEH_STORAGE.providers,
      ZEH_STORAGE.openaiApiKey,
      ZEH_STORAGE.openaiModel,
    ]);
    const patch = legacyProviderPatch(data);
    if (patch) await chrome.storage.local.set(patch);
  });
}

function migrateLegacySettings() {
  return zehWithProviderConfigLock(migrateLegacySettingsNow);
}

async function migrateLegacySettingsNow() {
  const data = await chrome.storage.local.get([
    ZEH_STORAGE.providers,
    ZEH_STORAGE.openaiApiKey,
    ZEH_STORAGE.openaiModel,
    ZEH_STORAGE.theme,
  ]);

  const patch = { ...legacyProviderPatch(data) };

  if (!data[ZEH_STORAGE.theme]) {
    patch[ZEH_STORAGE.theme] = zehDefaultTheme();
  }

  if (data[ZEH_STORAGE.providers]) {
    const migrated = zehMigrateProviderModels(data[ZEH_STORAGE.providers]);
    if (JSON.stringify(migrated) !== JSON.stringify(data[ZEH_STORAGE.providers])) {
      patch[ZEH_STORAGE.providers] = migrated;
    }
  }

  if (Object.keys(patch).length > 0) {
    await chrome.storage.local.set(patch);
  }
}

/** 设置页发来的 provider 编辑：每个 provider 都有一项，key 去掉首尾空白，模型名为空时用默认模型 */
function normalizeProviderEdits(edits) {
  const out = {};
  ZEH_PROVIDER_IDS.forEach((id) => {
    const entry = edits && edits[id] && typeof edits[id] === "object" ? edits[id] : {};
    out[id] = {
      ...entry,
      apiKey: String(entry.apiKey || "").trim(),
      model: String(entry.model || "").trim() || ZEH_PROVIDER_META[id].defaultModel,
    };
  });
  return out;
}

/**
 * 设置页「模型与 API」的保存（SAVE_PROVIDER_SETTINGS）。规则与原先设置页里的 persistProviders 相同（R-12）：
 * 以存储里的最新配置为底，只覆盖相对 base（设置页上次读到或写入的快照）改过的字段；
 * 启用规则：本页刚启用的 provider 优先，否则沿用已启用的第一个，都没有时回到 openai；
 * 最后只留一个 enabled，与 zehActiveProvider 一致。
 * 写入完成后才返回 { ok: true, providers, activeProvider }，写入失败时 reject。
 */
function saveProviderSettings(base, edits) {
  return zehWithProviderConfigLock(async () => {
    const snapshot = base || {};
    const local = zehMigrateProviderModels(normalizeProviderEdits(edits));
    const data = await chrome.storage.local.get([ZEH_STORAGE.providers]);
    const stored = zehMigrateProviderModels(data[ZEH_STORAGE.providers] || zehDefaultProviders());
    const providers = zehMergeProviderEdits(stored, snapshot, local, ZEH_PROVIDER_IDS);

    const enabledIds = ZEH_PROVIDER_IDS.filter((id) => providers[id]?.enabled);
    const locallyEnabled = enabledIds.find((id) => providers[id].enabled !== Boolean(snapshot[id]?.enabled));
    const enabled = locallyEnabled || enabledIds[0];
    let activeProvider;
    if (!enabled) {
      providers.openai.enabled = true;
      activeProvider = "openai";
    } else {
      activeProvider = enabled;
    }
    ZEH_PROVIDER_IDS.forEach((id) => {
      providers[id].enabled = id === activeProvider;
    });

    await chrome.storage.local.set({
      [ZEH_STORAGE.providers]: providers,
      [ZEH_STORAGE.activeProvider]: activeProvider,
    });
    return { ok: true, providers, activeProvider };
  });
}

async function getAppSettings() {
  await migrateLegacySettings();
  const data = await chrome.storage.local.get([
    ZEH_STORAGE.providers,
    ZEH_STORAGE.activeProvider,
    ZEH_STORAGE.liveTranscribeProvider,
  ]);

  return {
    providers: data[ZEH_STORAGE.providers] || zehDefaultProviders(),
    activeProvider: data[ZEH_STORAGE.activeProvider] || "openai",
    liveTranscribeProvider: data[ZEH_STORAGE.liveTranscribeProvider] || "",
  };
}

function listConfiguredProviders(appSettings) {
  const merged = zehMigrateProviderModels(appSettings.providers);
  return ZEH_PROVIDER_IDS.filter((id) =>
    Boolean(String(merged[id]?.apiKey || "").trim())
  ).map((id) => {
    const meta = ZEH_PROVIDER_META[id];
    const cfg = merged[id] || {};
    return {
      id,
      name: meta?.name || id,
      model: cfg.model || meta?.defaultModel || "",
    };
  });
}

function getProviderConfigById(appSettings, providerId) {
  if (!providerId || !ZEH_PROVIDER_IDS.includes(providerId)) return null;
  const merged = zehMigrateProviderModels(appSettings.providers);
  const meta = ZEH_PROVIDER_META[providerId];
  const cfg = merged[providerId] || {};
  return {
    id: providerId,
    meta,
    type: meta?.type || "openai-compatible",
    apiKey: cfg.apiKey || "",
    model: cfg.model || meta?.defaultModel || "",
  };
}

function resolveLiveTranscribeProviderId(appSettings) {
  const configured = listConfiguredProviders(appSettings);
  if (!configured.length) return "";
  const saved = String(appSettings.liveTranscribeProvider || "").trim();
  if (saved && configured.some((p) => p.id === saved)) return saved;
  return configured[0].id;
}

function getLiveTranscribeProviderConfig(appSettings) {
  const id = resolveLiveTranscribeProviderId(appSettings);
  if (!id) {
    return {
      id: "",
      meta: {},
      type: "openai-compatible",
      apiKey: "",
      model: "",
    };
  }
  return getProviderConfigById(appSettings, id);
}

function getActiveProviderConfig(appSettings) {
  const { providers, activeProvider } = appSettings;
  const merged = zehMigrateProviderModels(providers);
  const id = merged[activeProvider]?.enabled
    ? activeProvider
    : ZEH_PROVIDER_IDS.find((pid) => merged[pid]?.enabled) || "openai";
  const meta = ZEH_PROVIDER_META[id];
  const cfg = merged[id] || {};
  return {
    id,
    meta,
    type: meta.type || "openai-compatible",
    apiKey: cfg.apiKey || "",
    model: cfg.model || meta.defaultModel,
  };
}
