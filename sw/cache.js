/**
 * Service worker 模块：查词结果缓存 v2（读取、写入、统计、清理）。
 *
 * 由 background.js 的 importScripts 列表加载。本文件只声明，加载时不调用任何 chrome API；
 * 启动时的每日清理由 background.js 调用 initCacheMaintenance() 发起。
 * 依赖：config.js（缓存键格式、过期策略、ZEH_CACHE_*）、chrome.storage.local。
 * 内存状态（访问时间节流表、清理进行中标记、定期清理计时器）只是优化：worker 重启后丢失不影响正确性，
 * 缓存内容只存在 storage 里。
 */

// ─── 查询结果缓存 v2 ─────────────────────────────────────────────────────────
const _cacheAccessWriteAt = new Map();
let zehCacheCleanupRunning = false;

async function readAllLookupCacheEntries() {
  const all = await chrome.storage.local.get(null);
  const rows = [];
  for (const [key, item] of Object.entries(all || {})) {
    if (!zehIsLookupCacheStorageKey(key) || !item?.data) continue;
    const parsed = zehParseLookupCacheStorageKey(key);
    if (!parsed) continue;
    const queryType =
      item.queryType || parsed.queryType || (parsed.version === 1 ? parsed.queryType : "word");
    const createdAt = item.createdAt || item.savedAt || 0;
    const lastAccessedAt = item.lastAccessedAt || item.savedAt || createdAt;
    rows.push({
      storageKey: key,
      queryType,
      item,
      createdAt,
      lastAccessedAt,
      approxSize: item.approxSize || zehEstimateCacheEntryBytes(item),
      version: item.version || parsed.version || 1,
      cacheFormat: zehClassifyCacheStorageKey(key),
    });
  }
  return rows;
}

function isCacheEntryExpired(entry, queryType) {
  const policy = zehGetCachePolicy(queryType);
  const createdAt = entry.createdAt || entry.savedAt || 0;
  return !createdAt || Date.now() - createdAt > policy.ttlMs;
}

async function maybeUpdateCacheAccess(storageKey, entry) {
  const now = Date.now();
  const lastWrite = _cacheAccessWriteAt.get(storageKey) || 0;
  if (now - lastWrite < ZEH_CACHE_ACCESS_UPDATE_THROTTLE_MS) return entry;
  _cacheAccessWriteAt.set(storageKey, now);
  const updated = {
    ...entry,
    lastAccessedAt: now,
    hitCount: (entry.hitCount || 0) + 1,
    updatedAt: now,
  };
  updated.approxSize = zehEstimateCacheEntryBytes(updated);
  try {
    await chrome.storage.local.set({ [storageKey]: updated });
  } catch {
    /* 访问统计写失败不影响返回 */
  }
  return updated;
}

async function migrateCacheEntryToCurrentFormat(sourceKey, legacyItem, queryType, text) {
  const normalizedText = zehNormalizeTextForCache(queryType, text);
  const textHash = zehCacheTextHash(queryType, normalizedText);
  const textLength = normalizedText.length;
  const newKey = zehCacheV2StorageKey(queryType, textLength, textHash);
  const oldV2Key = zehCacheV2StorageKeyShort(queryType, textHash);
  const legacyKey = zehLegacyLookupCacheStorageKey(queryType, text);
  if (sourceKey === newKey) return;
  try {
    const migrated = zehMigrateLegacyCacheEntry(
      sourceKey,
      legacyItem,
      queryType,
      normalizedText,
      textHash
    );
    await chrome.storage.local.set({ [newKey]: migrated });
    const toRemove = new Set([sourceKey, oldV2Key, legacyKey]);
    toRemove.delete(newKey);
    if (toRemove.size) {
      await chrome.storage.local.remove([...toRemove]);
    }
  } catch {
    /* lazy migrate 失败可忽略 */
  }
}

/**
 * 语境结果缓存（Phase 3）：键 = 通用键 + `:c{语境 hash}`，条目里保存语境文本用于核对。
 * 与通用缓存共用同一 queryType 的 TTL / 条数 / 容量清理策略。
 */
async function getContextCacheLookup(queryType, text, context) {
  try {
    const storageKey = zehContextCacheStorageKey(queryType, text, context);
    const raw = await chrome.storage.local.get([storageKey]);
    const item = raw[storageKey];
    if (!item?.data) return null;
    if (item.contextIdentity !== zehContextIdentity(context)) return null;
    if (isCacheEntryExpired(item, queryType)) {
      chrome.storage.local.remove([storageKey]).catch(() => {});
      return null;
    }
    const accessed = await maybeUpdateCacheAccess(storageKey, item);
    const data = zehNormalizeWordResult({ ...accessed.data, queryType });
    return { storageKey, data: { ...data, queryType }, entry: accessed };
  } catch {
    return null;
  }
}

async function getCacheLookup(queryType, text, context) {
  if (context) return getContextCacheLookup(queryType, text, context);
  try {
    const normalizedText = zehNormalizeTextForCache(queryType, text);
    const textHash = zehCacheTextHash(queryType, normalizedText);
    const textLength = normalizedText.length;
    const v2Key = zehCacheV2StorageKey(queryType, textLength, textHash);
    const v2OldKey = zehCacheV2StorageKeyShort(queryType, textHash);
    const legacyKey = zehLegacyLookupCacheStorageKey(queryType, text);

    const raw = await chrome.storage.local.get([v2Key, v2OldKey, legacyKey]);
    let storageKey = null;
    let item = null;
    if (raw[v2Key]?.data) {
      storageKey = v2Key;
      item = raw[v2Key];
    } else if (raw[v2OldKey]?.data) {
      storageKey = v2OldKey;
      item = raw[v2OldKey];
    } else if (raw[legacyKey]?.data) {
      storageKey = legacyKey;
      item = raw[legacyKey];
    }
    if (!item?.data) return null;

    const qt = item.queryType || queryType;
    if (isCacheEntryExpired(item, qt)) {
      chrome.storage.local.remove([storageKey]).catch(() => {});
      return null;
    }

    if (storageKey !== v2Key) {
      migrateCacheEntryToCurrentFormat(storageKey, item, qt, text).catch(() => {});
    }

    const accessed = await maybeUpdateCacheAccess(storageKey, item);
    let data = accessed.data;
    if (data && zehUsesDictionary(qt)) {
      data = zehNormalizeWordResult(data);
    }
    return { storageKey, data: { ...data, queryType: qt }, entry: accessed };
  } catch {
    return null;
  }
}

async function setCacheLookup(queryType, text, resultData, provider = {}, context = null) {
  try {
    const normalizedText = zehNormalizeTextForCache(queryType, text);
    const textHash = zehCacheTextHash(queryType, normalizedText);
    const textLength = normalizedText.length;
    const policy = zehGetCachePolicy(queryType);
    const v2Key = context
      ? zehContextCacheStorageKey(queryType, text, context)
      : zehCacheV2StorageKey(queryType, textLength, textHash);
    const v2OldKey = zehCacheV2StorageKeyShort(queryType, textHash);
    const legacyKey = zehLegacyLookupCacheStorageKey(queryType, text);

    let data = resultData;
    if (zehUsesDictionary(queryType)) {
      data = zehNormalizeWordResult(data);
    }
    data = zehTrimCacheResultData(queryType, data);

    const entry = zehBuildCacheEntry(queryType, normalizedText, textHash, data, {
      source: provider.id || provider.source || "unknown",
      model: provider.model || provider.modelName || "",
      contextHash: context ? zehLookupContextHash(context) : "",
      contextIdentity: context ? zehContextIdentity(context) : "",
    });

    if (entry.approxSize > policy.maxEntrySize) {
      zehDebugLog("[Manekilex] cache skip oversize", {
        reason: "oversize_after_trim",
        queryType,
        approxSize: entry.approxSize,
        maxEntrySize: policy.maxEntrySize,
        textLength,
      });
      schedulePeriodicCacheCleanup();
      return false;
    }

    await chrome.storage.local.set({ [v2Key]: entry });

    // 旧格式键只属于通用结果；写语境结果时不能删掉通用缓存
    const staleKeys = context ? new Set() : new Set([v2OldKey, legacyKey]);
    staleKeys.delete(v2Key);
    if (staleKeys.size) {
      chrome.storage.local.remove([...staleKeys]).catch(() => {});
    }

    schedulePeriodicCacheCleanup();
    return true;
  } catch (err) {
    zehDebugLog("[Manekilex] cache write failed", err?.message || err);
    return false;
  }
}

async function getLookupCacheStats() {
  const rows = await readAllLookupCacheEntries();
  const byType = { word: 0, phrase: 0, sentence: 0, paragraph: 0, code_term: 0 };
  let totalBytes = 0;
  let expiredCount = 0;
  let v2Count = 0;
  let legacyCount = 0;

  rows.forEach((row) => {
    const qt = row.queryType;
    if (byType[qt] != null) byType[qt] += 1;
    totalBytes += row.approxSize;
    if (isCacheEntryExpired(row.item, qt)) expiredCount += 1;
    if (row.cacheFormat === "v2") v2Count += 1;
    else if (row.cacheFormat === "legacy") legacyCount += 1;
  });

  const metaData = await chrome.storage.local.get([ZEH_CACHE_CLEANUP_META_KEY]);
  const meta = metaData[ZEH_CACHE_CLEANUP_META_KEY] || {};

  return {
    totalCount: rows.length,
    v2Count,
    legacyCount,
    expiredCount,
    totalBytes,
    byType,
    lastCleanupAt: meta.lastCleanupAt || 0,
    lastReason: meta.lastReason || "",
    lastSummary: meta.lastSummary || null,
  };
}

async function clearAllLookupCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all || {}).filter((k) => zehIsLookupCacheStorageKey(k));
  if (!keys.length) return 0;
  await chrome.storage.local.remove(keys);
  return keys.length;
}

async function cleanupLookupCache(reason = "manual") {
  if (zehCacheCleanupRunning) {
    return { skipped: true, reason: "already_running" };
  }

  zehCacheCleanupRunning = true;
  try {
  const rows = await readAllLookupCacheEntries();
  const beforeCount = rows.length;
  let beforeBytes = 0;
  rows.forEach((r) => {
    beforeBytes += r.approxSize;
  });

  const deletedByType = {
    word: 0,
    phrase: 0,
    sentence: 0,
    paragraph: 0,
    code_term: 0,
    expired: 0,
    oversize: 0,
  };
  const keysToDelete = new Set();

  // 1. 过期
  rows.forEach((row) => {
    if (isCacheEntryExpired(row.item, row.queryType)) {
      keysToDelete.add(row.storageKey);
      deletedByType.expired += 1;
      if (deletedByType[row.queryType] != null) deletedByType[row.queryType] += 1;
    }
  });

  let survivors = rows.filter((r) => !keysToDelete.has(r.storageKey));

  // 2. 按 queryType maxEntries（最久未访问优先删）
  ZEH_CACHE_QUERY_TYPES.forEach((qt) => {
    const policy = zehGetCachePolicy(qt);
    const group = survivors
      .filter((r) => r.queryType === qt)
      .sort((a, b) => (a.lastAccessedAt || 0) - (b.lastAccessedAt || 0));
    const excess = group.length - policy.maxEntries;
    if (excess <= 0) return;
    group.slice(0, excess).forEach((row) => {
      keysToDelete.add(row.storageKey);
      deletedByType[qt] += 1;
    });
  });

  survivors = survivors.filter((r) => !keysToDelete.has(r.storageKey));

  // 3. 总容量
  const sumBytes = (list) => list.reduce((n, r) => n + r.approxSize, 0);
  let totalBytes = sumBytes(survivors);
  if (totalBytes > ZEH_CACHE_TOTAL_MAX_BYTES) {
    const ordered = ZEH_CACHE_EVICTION_ORDER.flatMap((qt) =>
      survivors
        .filter((r) => r.queryType === qt)
        .sort((a, b) => (a.lastAccessedAt || 0) - (b.lastAccessedAt || 0))
    );
    for (const row of ordered) {
      if (totalBytes <= ZEH_CACHE_TOTAL_MAX_BYTES) break;
      if (keysToDelete.has(row.storageKey)) continue;
      keysToDelete.add(row.storageKey);
      deletedByType[row.queryType] += 1;
      totalBytes -= row.approxSize;
    }
  }

  if (keysToDelete.size) {
    await chrome.storage.local.remove([...keysToDelete]);
  }

  const afterRows = await readAllLookupCacheEntries();
  const afterCount = afterRows.length;
  const afterBytes = afterRows.reduce((n, r) => n + r.approxSize, 0);
  const summary = {
    reason,
    beforeCount,
    afterCount,
    deletedCount: keysToDelete.size,
    beforeBytes,
    afterBytes,
    deletedByType,
  };

  await chrome.storage.local.set({
    [ZEH_CACHE_CLEANUP_META_KEY]: {
      lastCleanupAt: Date.now(),
      lastReason: reason,
      lastSummary: summary,
    },
  });

  zehDebugLog("[Manekilex] cache cleanup", summary);
  return summary;
  } finally {
    zehCacheCleanupRunning = false;
  }
}

let _periodicCleanupTimer = null;

function schedulePeriodicCacheCleanup() {
  if (_periodicCleanupTimer) return;
  _periodicCleanupTimer = setTimeout(async () => {
    _periodicCleanupTimer = null;
    try {
      const metaData = await chrome.storage.local.get([ZEH_CACHE_CLEANUP_META_KEY]);
      const last = metaData[ZEH_CACHE_CLEANUP_META_KEY]?.lastCleanupAt || 0;
      if (Date.now() - last >= ZEH_CACHE_CLEANUP_PERIODIC_MS) {
        await cleanupLookupCache("periodic");
      }
    } catch {
      /* ignore */
    }
  }, 0);
}

async function initCacheMaintenance() {
  try {
    const metaData = await chrome.storage.local.get([ZEH_CACHE_CLEANUP_META_KEY]);
    const last = metaData[ZEH_CACHE_CLEANUP_META_KEY]?.lastCleanupAt || 0;
    if (Date.now() - last >= ZEH_CACHE_CLEANUP_DAILY_MS) {
      await cleanupLookupCache("daily");
    }
  } catch {
    /* ignore */
  }
}
