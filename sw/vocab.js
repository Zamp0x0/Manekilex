/**
 * Service worker 模块：生词本写入（ADD / DELETE / REVIEW / MIGRATE）。
 *
 * 由 background.js 的 importScripts 列表加载。本文件只声明，加载时不调用任何 chrome API；
 * 安装 / 更新时的迁移由 background.js 的 onInstalled 监听调用 migrateVocabularyStorage()。
 * 依赖：vocab-review.js（词条与复习的纯函数）、sw/storage-queue.js（zehUpdateStorageList）、config.js（ZEH_STORAGE）。
 * 存储键与词条结构不变；每次修改都在队列里重新读取 storage。
 */

// ─── 生词本：唯一写入方（R-06 / R-12）─────────────────────────────────────────
// 页面（ADD_VOCAB）与设置页（DELETE_VOCAB / REVIEW_VOCAB / MIGRATE_VOCAB）都通过消息让 service worker 修改；
// 每次修改都在队列里重新读取 storage，不使用调用方手里的旧数组。
// Phase 4：一个词一个词条（contexts[] + review），纯函数在 vocab-review.js。
// 一次修改只迁移它改动的那个词条；其余词条由 migrateVocabularyStorage 统一迁移（只在有变化时写）。
const ZEH_VOCAB_MAX_ITEMS = 2000;

function mutateVocabulary(mutate) {
  return zehUpdateStorageList(ZEH_STORAGE.vocabulary, mutate);
}

async function addVocabularyItem(item) {
  const termKey = zehVocabTermKey(item);
  if (!item || typeof item !== "object" || !termKey) {
    return { ok: false, added: false, reason: "invalid", message: "缺少要保存的词条" };
  }
  try {
    return await mutateVocabulary((list) => {
      const savedAt = Date.now();
      // Phase 3 语境字段在这里统一限长、去掉非法类型，再拆成词条 + 语境
      const { lexical, context } = zehSplitVocabPayload(item, savedAt);
      const index = list.findIndex((v) => zehVocabTermKey(v) === termKey);

      if (index >= 0) {
        // 同一个词：不新建词条；新的原句追加为语境，同一原句只补全缺失信息。
        // 0.11.1：派生词合并去重；已有的可用助记不覆盖，只替换明显无效的。
        const migrated = zehMigrateVocabItem(list[index]).item;
        const lexicalMerge = zehMergeVocabLexical(migrated, lexical);
        const existing = lexicalMerge.item;
        const lexicalUpdated = lexicalMerge.changed ? { lexicalUpdated: true } : {};
        const keepLexical = () => {
          if (!lexicalMerge.changed) return undefined;
          list[index] = existing;
          return list;
        };
        if (!context) {
          return { list: keepLexical(), result: { ok: true, added: false, reason: "duplicate", ...lexicalUpdated } };
        }
        const merged = zehMergeVocabContext(existing.contexts, context, ZEH_VOCAB_MAX_CONTEXTS);
        const ref = { id: existing.id, serial: existing.serial, contextCount: merged.contexts.length };
        if (merged.status === "duplicate") {
          return {
            list: keepLexical(),
            result: { ok: true, added: false, contextAdded: false, reason: "duplicate", ...ref, ...lexicalUpdated },
          };
        }
        if (merged.status === "limit") {
          return {
            list: keepLexical(),
            result: {
              ok: true,
              added: false,
              contextAdded: false,
              reason: "context_limit",
              limit: ZEH_VOCAB_MAX_CONTEXTS,
              ...ref,
              ...lexicalUpdated,
            },
          };
        }
        list[index] = { ...existing, contexts: merged.contexts };
        const added = merged.status === "added";
        return {
          list,
          result: {
            ok: true,
            added: false,
            contextAdded: added,
            contextUpdated: !added,
            reason: added ? "context_added" : "context_updated",
            ...ref,
          },
        };
      }

      const maxSerial = list.reduce((m, v) => Math.max(m, v?.serial || 0), 0);
      const entry = {
        id: `${savedAt}-${Math.random().toString(36).slice(2, 8)}`,
        serial: maxSerial + 1,
        savedAt,
        savedAtLocal: zehFormatLocalTime(savedAt),
        ...lexical,
        contexts: context ? [context] : [],
        // 新词立即可复习
        review: zehNewReviewState(savedAt),
      };
      list.unshift(entry);

      // 生词本按 savedAt 新→旧排列（unshift 最新在 index 0）；只保留最新 2000 条
      return {
        list: list.slice(0, ZEH_VOCAB_MAX_ITEMS),
        result: { ok: true, added: true, contextAdded: Boolean(context), serial: entry.serial, id: entry.id },
      };
    });
  } catch (err) {
    console.warn("[Manekilex] add vocabulary failed", err);
    return { ok: false, added: false, reason: "error", message: err?.message || "保存失败" };
  }
}

async function deleteVocabularyItems(ids) {
  const idSet = new Set((Array.isArray(ids) ? ids : [ids]).filter(Boolean).map(String));
  if (!idSet.size) {
    return { ok: false, removed: 0, reason: "invalid", message: "缺少要删除的条目" };
  }
  try {
    return await mutateVocabulary((list) => {
      const next = list.filter((v) => !idSet.has(zehVocabItemId(v)));
      const removed = list.length - next.length;
      return { list: removed ? next : undefined, result: { ok: true, removed } };
    });
  } catch (err) {
    console.warn("[Manekilex] delete vocabulary failed", err);
    return { ok: false, removed: 0, reason: "error", message: err?.message || "删除失败" };
  }
}

/**
 * 记录一次复习评分：在队列里取最新列表 → 找到这个 id → 只更新它的 review。
 * expectedReviewCount（可选）与最新状态不一致时返回 stale（同一张卡已在别处评过），不重复计入。
 */
async function reviewVocabularyItem(id, rating, expectedReviewCount) {
  const targetId = typeof id === "string" || typeof id === "number" ? String(id) : "";
  if (!targetId || !ZEH_REVIEW_RATINGS.includes(rating)) {
    return { ok: false, reason: "invalid", message: "缺少词条或评分无效" };
  }
  try {
    return await mutateVocabulary((list) => {
      const index = list.findIndex((v) => zehVocabItemId(v) === targetId);
      if (index < 0) return { result: { ok: false, reason: "not_found", message: "该词已不在生词本" } };
      const item = zehMigrateVocabItem(list[index]).item;
      if (Number.isInteger(expectedReviewCount) && expectedReviewCount !== item.review.reviewCount) {
        return { result: { ok: false, reason: "stale", id: item.id, review: item.review } };
      }
      const review = zehScheduleReview(item.review, rating, Date.now());
      if (!review) return { result: { ok: false, reason: "invalid", message: "系统时间异常，未记录本次复习" } };
      list[index] = { ...item, review };
      return { list, result: { ok: true, id: item.id, review } };
    });
  } catch (err) {
    console.warn("[Manekilex] review vocabulary failed", err);
    return { ok: false, reason: "error", message: err?.message || "保存复习结果失败" };
  }
}

/** 把旧条目迁移为 v2（幂等）；全部已迁移时不写 storage。 */
async function migrateVocabularyStorage() {
  try {
    return await mutateVocabulary((list) => {
      const { list: next, changed } = zehMigrateVocabularyList(list);
      return { list: changed ? next : undefined, result: { ok: true, migrated: changed } };
    });
  } catch (err) {
    console.warn("[Manekilex] vocabulary migration failed", err);
    return { ok: false, migrated: 0, reason: "error", message: err?.message || "迁移失败" };
  }
}
