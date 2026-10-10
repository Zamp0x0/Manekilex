/**
 * Service worker 模块：storage 列表的串行读改写。
 *
 * 由 background.js 的 importScripts 列表加载。本文件只声明，加载时不调用任何 chrome API。
 * 依赖：config.js（ZEH_STORAGE）、chrome.storage.local（只在函数被调用时使用）。
 * 使用方：生词本写入（mutateVocabulary）、用量日志（appendUsageLog）、CLEAR_USAGE_LOGS 消息。
 */

// ─── 串行的 storage 列表写入（R-06 / R-12）────────────────────────────────────
// 同一个 key 的 read-modify-write 在 service worker 内排队执行，并发写入不会互相覆盖。
const _storageUpdateQueues = new Map();

/**
 * 在队列中读取 storage[key] 列表，交给 mutate(list) 处理。
 * mutate 返回 { list, result }：list 为新数组时写回（undefined 表示不写），result 原样返回。
 * 写入失败时 reject，调用方负责把失败告诉 UI。
 */
function zehUpdateStorageList(key, mutate) {
  const prev = _storageUpdateQueues.get(key) || Promise.resolve();
  const run = prev.then(async () => {
    const data = await chrome.storage.local.get([key]);
    const current = Array.isArray(data[key]) ? data[key] : [];
    const outcome = mutate(current.slice()) || {};
    if (Array.isArray(outcome.list)) {
      await chrome.storage.local.set({ [key]: outcome.list });
    }
    return outcome.result;
  });
  const settled = run.catch(() => {});
  _storageUpdateQueues.set(key, settled);
  settled.then(() => {
    if (_storageUpdateQueues.get(key) === settled) _storageUpdateQueues.delete(key);
  });
  return run;
}

async function appendUsageLog(entry) {
  await zehUpdateStorageList(ZEH_STORAGE.usageLogs, (logs) => {
    logs.push(entry);
    return { list: logs.slice(-500) };
  });
}
