/**
 * reader/log.js — EPUB 阅读器的调试日志（M8 从 reader.js 拆出）。
 *
 * zehCreateReaderLog(host) 生成阅读器各处共用的日志函数。全部输出只在 reader.html?debug=1 时出现
 * （R-39），扩展错误页不会被正常阅读刷屏；位置链路（开书恢复、保存、resize）的日志带 [ZEH_POS] 前缀。
 * host：
 *   debug   是否为 ?debug=1
 * 加载：reader.html 在 reader.js 之前加载 reader/ 下的文件；本文件只声明，加载时不做任何事。
 */

/**
 * 阅读器的日志函数。
 * @param {{ debug: boolean }} host
 */
function zehCreateReaderLog(host) {
  const DEBUG_READER = Boolean(host.debug);

  function readerLog(label, data) {
    if (!DEBUG_READER) return;
    if (data !== undefined) console.log(`[Reader] ${label}`, data);
    else console.log(`[Reader] ${label}`);
  }

  function readerWarn(label, data) {
    if (!DEBUG_READER) return;
    if (data !== undefined) console.warn(`[Reader] ${label}`, data);
    else console.warn(`[Reader] ${label}`);
  }

  function reasonLabel(reason, fallback = "") {
    if (typeof reason === "string" && reason.trim()) return reason.trim();
    if (reason == null) return fallback;
    if (typeof reason === "object" && typeof reason.reason === "string") {
      return reason.reason;
    }
    return fallback || "unknown";
  }

  function posFmtProgress(p) {
    if (typeof p !== "number" || !Number.isFinite(p)) return "?";
    return `${(p * 100).toFixed(2)}%`;
  }

  function posFmtRatio(r) {
    if (typeof r !== "number" || !Number.isFinite(r)) return "?";
    return r.toFixed(4);
  }

  /** 位置链路：预期内的分支（开书恢复、resize 抑制等），用 log 不用 warn */
  function posDbg(tag, detail, data) {
    if (!DEBUG_READER) return;
    posLog(tag, detail, data);
  }

  /** 位置链路日志：仅 debug=1 时输出，避免污染扩展错误页 */
  function posLog(tag, detail, data) {
    if (!DEBUG_READER) return;
    const msg = detail ? `[ZEH_POS] ${tag} ${detail}` : `[ZEH_POS] ${tag}`;
    if (data !== undefined) console.log(msg, data);
    else console.log(msg);
  }

  /** 其余零散的 console.log 也只在 ?debug=1 时输出（R-39）；warn 保留 */
  function readerDebug(...args) {
    if (!DEBUG_READER) return;
    console.log(...args);
  }

  return {
    readerLog,
    readerWarn,
    reasonLabel,
    posFmtProgress,
    posFmtRatio,
    posDbg,
    posLog,
    readerDebug,
  };
}
