/**
 * reader/progress.js — 阅读进度的计算（M8 从 reader.js 拆出，公式逐字未改）。
 *
 * 位置在书里只记两样：当前章节在 spine 里的序号 spineIndex，和章节内滚动比例 ratio（0 = 章首，
 * 1 = 章末）。全书进度 = (spineIndex + ratio) / spine 总数，结果夹在 0..1 之间；保存、恢复、
 * 工具栏百分比和书架进度条都用这一个公式。
 * host：
 *   book()   当前 epub.js 书对象（还没打开时为 null），只用来读 spine 长度
 * 加载：reader.html 在 reader.js 之前加载 reader/ 下的文件；本文件只声明，加载时不做任何事。
 */

/**
 * 进度公式与 spine 计数。
 * @param {{ book: () => object | null }} host
 */
function zehCreateReaderProgress(host) {
  function clampRatio(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(1, n));
  }

  function getTotalSpineItems() {
    const book = host.book();
    return book && book.spine ? book.spine.length : 0;
  }

  function calculateProgressFromSpineRatio(spineIndex, ratio, totalSpineItems) {
    const total =
      typeof totalSpineItems === "number" && totalSpineItems > 0
        ? totalSpineItems
        : getTotalSpineItems();
    if (total <= 0) return 0;
    return clampRatio((spineIndex + clampRatio(ratio)) / total);
  }

  function calculateProgressFromSpineAndRatio(spineIndex, ratio) {
    return calculateProgressFromSpineRatio(spineIndex, ratio, getTotalSpineItems());
  }

  function derivedProgressFromRecord(record, totalSpineItems) {
    if (!record || !Number.isInteger(record.currentSpineIndex)) return null;
    if (typeof record.chapterScrollRatio !== "number") return null;
    const total =
      typeof totalSpineItems === "number" && totalSpineItems > 0
        ? totalSpineItems
        : typeof record.totalSpineItems === "number" && record.totalSpineItems > 0
          ? record.totalSpineItems
          : getTotalSpineItems();
    if (total <= 0) return null;
    return calculateProgressFromSpineRatio(
      record.currentSpineIndex,
      record.chapterScrollRatio,
      total
    );
  }

  return {
    clampRatio,
    getTotalSpineItems,
    calculateProgressFromSpineRatio,
    calculateProgressFromSpineAndRatio,
    derivedProgressFromRecord,
  };
}
