/**
 * 生词本 v2（Phase 4）：一个词条 = 一个词，词条下有多个语境 contexts[]，以及一份复习状态 review。
 *
 * 这里只有纯函数（不碰 chrome API），service worker（唯一写入方）与设置页（读取 / 展示）共用。
 * 依赖 config.js：zehCollapseText、zehNormalizeApostrophe、zehFnv1aHash、
 * zehSanitizeVocabContextFields、ZEH_CONTEXT_LIMITS。
 * 不在内容脚本里加载，网页每个 frame 不多解析这段代码。
 */

/** 每个词最多保存的语境数；满了以后新语境不再加入（已有语境仍可补全）。 */
const ZEH_VOCAB_MAX_CONTEXTS = 8;

/** 由服务端生成、页面传来的同名字段一律忽略 */
const ZEH_VOCAB_RESERVED_KEYS = ["id", "serial", "savedAt", "savedAtLocal", "contexts", "review"];

/** Phase 3 平铺在词条上的语境字段 → contexts[] 里的字段名（迁移 / 保存时归入语境） */
const ZEH_VOCAB_FLAT_CONTEXT_FIELDS = {
  context_sentence: "sentence",
  meaning_here: "meaning_here",
  pos_here: "pos_here",
  sentence_translation: "sentence_translation",
  synonyms: "synonyms",
  sourceType: "sourceType",
  pageTitle: "pageTitle",
  book: "book",
  pdf: "pdf",
};
const ZEH_VOCAB_FLAT_CONTEXT_KEYS = Object.keys(ZEH_VOCAB_FLAT_CONTEXT_FIELDS);

/** 同一语境再次保存时，可以补上的字段（只补缺失的，不覆盖已有内容） */
const ZEH_VOCAB_ENRICHABLE_CONTEXT_KEYS = [
  "meaning_here",
  "pos_here",
  "sentence_translation",
  "synonyms",
  "sourceType",
  "pageUrl",
  "pageTitle",
  "book",
  "pdf",
];

const ZEH_VOCAB_PAGE_URL_MAX = 2000;

const ZEH_REVIEW_RATINGS = ["again", "hard", "good", "easy"];

const ZEH_REVIEW_STATUSES = ["new", "learning", "review", "relearning"];

const ZEH_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 复习调度规则（SM-2 的简化版，确定性、无随机）。精确规则见 Phase 4 报告 §6。
 * 时间全部是毫秒时间戳（UTC 绝对时间），与本地时区无关。
 */
const ZEH_REVIEW_RULES = {
  againDelayMs: 10 * 60 * 1000,
  hardDelayMs: 30 * 60 * 1000,
  graduateGoodDays: 1,
  graduateEasyDays: 4,
  startEase: 2.5,
  minEase: 1.3,
  maxEase: 3.0,
  againEasePenalty: 0.2,
  hardEasePenalty: 0.15,
  easyEaseBonus: 0.15,
  hardMultiplier: 1.2,
  easyMultiplier: 1.3,
  lapseMultiplier: 0.5,
  maxIntervalDays: 365,
};

/** 合理的时钟范围：2000-01-01 ~ 2100-01-01（UTC）。超出范围的 now 不参与调度。 */
const ZEH_REVIEW_CLOCK_MIN = Date.UTC(2000, 0, 1);
const ZEH_REVIEW_CLOCK_MAX = Date.UTC(2100, 0, 1);

/** 一轮复习最多的卡片数 / 新词数（到期的词优先，新词按最新加入优先） */
const ZEH_REVIEW_SESSION_LIMITS = { maxCards: 100, maxNew: 20 };

// ─── 词条与语境 ──────────────────────────────────────────────────────────────

function zehVocabTermKey(item) {
  return String(item?.term || "").trim().toLowerCase();
}

/** 稳定 id：已有 id 原样使用；极旧的无 id 条目按编号 / 时间 / 词生成确定的 id。 */
function zehVocabItemId(item) {
  if (!item || typeof item !== "object") return "";
  if (item.id !== undefined && item.id !== null && String(item.id)) return String(item.id);
  return `legacy-${item.serial || 0}-${item.savedAt || 0}-${zehFnv1aHash(zehVocabTermKey(item))}`;
}

/** 语境身份：大小写、空白、引号样式、首尾引号与句末标点都不影响（同一句话只存一次）。 */
function zehVocabContextIdentity(sentence) {
  return zehNormalizeApostrophe(zehCollapseText(sentence))
    .toLowerCase()
    .replace(/[“”„‟″]/g, '"')
    .replace(/^["'(（[\s]+/, "")
    .replace(/[\s.!?。！？…"')）\]]+$/, "")
    .trim();
}

function zehVocabContextId(identity) {
  return `ctx-${zehFnv1aHash(`vocabctx:${identity}`)}`;
}

/**
 * 由（已清洗的）平铺字段生成一个语境；没有有效原句时返回 null。
 * flat 使用 Phase 3 的字段名（context_sentence …），输出使用 contexts[] 的字段名。
 */
function zehBuildVocabContext(flat, savedAt) {
  if (!flat || typeof flat.context_sentence !== "string") return null;
  const sentence = zehCollapseText(flat.context_sentence).slice(0, ZEH_CONTEXT_LIMITS.sentence);
  const identity = zehVocabContextIdentity(sentence);
  if (!identity) return null;
  const context = { id: zehVocabContextId(identity), sentence };
  ["meaning_here", "pos_here", "sentence_translation", "sourceType", "pageTitle"].forEach((key) => {
    if (typeof flat[key] === "string" && flat[key]) context[key] = flat[key];
  });
  if (typeof flat.pageUrl === "string" && flat.pageUrl) {
    context.pageUrl = flat.pageUrl.slice(0, ZEH_VOCAB_PAGE_URL_MAX);
  }
  if (flat.book && typeof flat.book === "object" && !Array.isArray(flat.book)) context.book = flat.book;
  if (flat.pdf && typeof flat.pdf === "object" && !Array.isArray(flat.pdf)) context.pdf = flat.pdf;
  // 0.11.1：同义词跟随这一句里的义项，存在语境上
  if (Array.isArray(flat.synonyms) && flat.synonyms.length) context.synonyms = flat.synonyms;
  if (zehIsReviewTimestamp(savedAt)) context.savedAt = savedAt;
  return context;
}

/**
 * 0.11.1 词条级词汇字段合并（同一个词再次保存时）：
 * - derivatives：已有的在前，新的补在后面，按词去重，最多 ZEH_LEXICAL_LIST_MAX 个；
 * - memory_tip：已有的助记可用就保留；没有或明显无效时才换成新的（连同 memory_tip_type）；
 * - synonyms（没有原句时存在词条上）：同样合并去重。
 * 返回 { item, changed }；没有变化时 item 就是传入的 existing。
 */
function zehMergeVocabLexical(existing, incoming) {
  if (!existing || typeof existing !== "object" || !incoming || typeof incoming !== "object") {
    return { item: existing, changed: false };
  }
  const term = existing.term || incoming.term || "";
  const patch = {};
  ["derivatives", "synonyms"].forEach((field) => {
    if (!Array.isArray(incoming[field]) || !incoming[field].length) return;
    const sanitize = field === "derivatives" ? zehSanitizeDerivatives : zehSanitizeSynonyms;
    const current = sanitize(existing[field], term);
    const next = zehMergeLexicalList(current, sanitize(incoming[field], term), ZEH_LEXICAL_LIST_MAX);
    if (JSON.stringify(next) !== JSON.stringify(existing[field] || [])) patch[field] = next;
  });
  if (!zehIsUsefulMemoryTip(existing.memory_tip, term, existing.short_meaning)) {
    const tip = zehNormalizeMemoryTip(incoming.memory_tip, incoming.memory_tip_type, term, existing.short_meaning);
    if (tip.memory_tip) {
      patch.memory_tip = tip.memory_tip;
      if (tip.memory_tip_type) patch.memory_tip_type = tip.memory_tip_type;
    }
  }
  if (!Object.keys(patch).length) return { item: existing, changed: false };
  const item = { ...existing, ...patch };
  if (patch.memory_tip && !patch.memory_tip_type) delete item.memory_tip_type;
  return { item, changed: true };
}

/**
 * 把页面传来的 ADD_VOCAB 负载拆成词条（词汇信息）与语境。
 * 保留字段（id / serial / review …）被丢弃；有原句时语境字段只放进语境，pageUrl 两边都留。
 */
function zehSplitVocabPayload(item, savedAt) {
  const clean = zehSanitizeVocabContextFields(item);
  const lexical = { ...clean };
  ZEH_VOCAB_RESERVED_KEYS.forEach((key) => delete lexical[key]);
  const context = zehBuildVocabContext(clean, savedAt);
  if (context) ZEH_VOCAB_FLAT_CONTEXT_KEYS.forEach((key) => delete lexical[key]);
  return { lexical, context };
}

/** 读取方使用：只返回有原句的语境（存储里的异常数据保留，但不展示） */
function zehValidVocabContexts(item) {
  const list = Array.isArray(item?.contexts) ? item.contexts : [];
  return list.filter((c) => c && typeof c === "object" && typeof c.sentence === "string" && c.sentence);
}

/**
 * 把一个语境合并进 contexts：
 * - 同一句（身份相同）：补上缺失字段 → updated；没有新信息 → duplicate；
 * - 新的一句：未满 max 时追加 → added；已满 → limit（不改动）。
 */
function zehMergeVocabContext(contexts, incoming, max) {
  const list = Array.isArray(contexts) ? contexts.slice() : [];
  const identity = zehVocabContextIdentity(incoming.sentence);
  const index = list.findIndex(
    (c) => c && typeof c.sentence === "string" && zehVocabContextIdentity(c.sentence) === identity
  );
  if (index >= 0) {
    const current = list[index];
    const filled = {};
    ZEH_VOCAB_ENRICHABLE_CONTEXT_KEYS.forEach((key) => {
      if (incoming[key] && !current[key]) filled[key] = incoming[key];
    });
    if (!Object.keys(filled).length) return { contexts: list, status: "duplicate", index };
    list[index] = { ...current, ...filled };
    return { contexts: list, status: "updated", index };
  }
  if (list.length >= max) return { contexts: list, status: "limit", index: -1 };
  list.push(incoming);
  return { contexts: list, status: "added", index: list.length - 1 };
}

// ─── 迁移（Phase 1–3 条目 → v2）─────────────────────────────────────────────

/**
 * 迁移一个词条（纯函数，幂等）：
 * - 没有 contexts 数组 → contexts: []；
 * - 有 Phase 3 平铺语境（context_sentence…）→ 归入 contexts，平铺字段移走；
 * - 没有 / 无效的 review → 新词状态（立即可复习）；
 * - id、serial、savedAt 与词汇字段保持原样。
 * 返回 { item, changed }；changed=false 时 item 与输入内容一致。异常条目（非对象）原样返回。
 */
function zehMigrateVocabItem(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { item: raw, changed: false };
  const item = { ...raw };
  let changed = false;

  if (item.id === undefined || item.id === null || !String(item.id)) {
    item.id = zehVocabItemId(item);
    changed = true;
  }
  if (!Array.isArray(item.contexts)) {
    item.contexts = [];
    changed = true;
  }
  if (typeof item.context_sentence === "string" && zehCollapseText(item.context_sentence)) {
    const flat = {};
    ZEH_VOCAB_FLAT_CONTEXT_KEYS.concat("pageUrl").forEach((key) => {
      if (key in item) flat[key] = item[key];
    });
    const context = zehBuildVocabContext(zehSanitizeVocabContextFields(flat), item.savedAt);
    if (context) {
      // 迁移不受语境上限限制，旧数据一条都不丢
      const max = Math.max(ZEH_VOCAB_MAX_CONTEXTS, item.contexts.length + 1);
      item.contexts = zehMergeVocabContext(item.contexts, context, max).contexts;
      // 只移走已经进入语境的字段；类型不对、没能迁移的旧字段原样保留
      Object.entries(ZEH_VOCAB_FLAT_CONTEXT_FIELDS).forEach(([flatKey, contextKey]) => {
        if (context[contextKey] !== undefined) delete item[flatKey];
      });
      changed = true;
    }
  }
  const review = zehSanitizeReviewState(item.review, zehIsReviewTimestamp(item.savedAt) ? item.savedAt : 0);
  if (JSON.stringify(review) !== JSON.stringify(item.review)) {
    item.review = review;
    changed = true;
  }
  return { item: changed ? item : raw, changed };
}

/** 迁移整个列表；只有至少一条变化时 changed > 0（调用方据此决定是否写回）。 */
function zehMigrateVocabularyList(list) {
  let changed = 0;
  const next = (Array.isArray(list) ? list : []).map((raw) => {
    const out = zehMigrateVocabItem(raw);
    if (out.changed) changed += 1;
    return out.item;
  });
  return { list: next, changed };
}

/** 设置页读取用：迁移后的有效词条（跳过非对象 / 没有词的异常数据，不写回）。 */
function zehNormalizeVocabularyList(list) {
  return zehMigrateVocabularyList(list).list.filter(
    (v) => v && typeof v === "object" && !Array.isArray(v) && zehVocabTermKey(v)
  );
}

// ─── 复习状态与调度 ──────────────────────────────────────────────────────────

function zehIsReviewTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= ZEH_REVIEW_CLOCK_MAX;
}

function zehIsValidReviewClock(now) {
  return typeof now === "number" && Number.isFinite(now) && now >= ZEH_REVIEW_CLOCK_MIN && now <= ZEH_REVIEW_CLOCK_MAX;
}

function zehRoundEase(value) {
  return Math.round(value * 100) / 100;
}

function zehNewReviewState(createdAt) {
  return zehSanitizeReviewState(null, zehIsReviewTimestamp(createdAt) ? createdAt : 0);
}

/**
 * 复习状态的规范形式：未知状态 → new，NaN / 负数 / 超范围的数字回到默认值或被夹住。
 * fallbackDueAt 用于缺失或无效的 dueAt（新词 = 加入时间，即立即可复习）。
 */
function zehSanitizeReviewState(review, fallbackDueAt) {
  const r = review && typeof review === "object" && !Array.isArray(review) ? review : {};
  const rules = ZEH_REVIEW_RULES;
  const num = (value, fallback) => (typeof value === "number" && Number.isFinite(value) ? value : fallback);
  const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
  return {
    status: ZEH_REVIEW_STATUSES.includes(r.status) ? r.status : "new",
    dueAt: zehIsReviewTimestamp(r.dueAt) ? r.dueAt : zehIsReviewTimestamp(fallbackDueAt) ? fallbackDueAt : 0,
    intervalDays: Math.min(rules.maxIntervalDays, Math.max(0, num(r.intervalDays, 0))),
    ease: Math.min(rules.maxEase, Math.max(rules.minEase, num(r.ease, rules.startEase))),
    reviewCount: count(r.reviewCount),
    lapseCount: count(r.lapseCount),
    lastReviewedAt: zehIsReviewTimestamp(r.lastReviewedAt) ? r.lastReviewedAt : null,
    lastRating: ZEH_REVIEW_RATINGS.includes(r.lastRating) ? r.lastRating : null,
  };
}

/**
 * 调度：(当前状态, 评分, now) → 新状态。纯函数；评分或 now 无效时返回 null。
 *
 * 学习阶段（new / learning / relearning）：
 *   Again → 10 分钟后，Hard → 30 分钟后（仍在学习）；
 *   Good → 毕业，1 天（relearning：回到降低后的间隔）；Easy → 毕业，4 天（relearning：间隔 ×1.3）。
 * 复习阶段（review，间隔 I 天，难度系数 E）：
 *   Again → 遗忘：lapse+1，E−0.2，间隔减半（至少 1 天），10 分钟后重学；
 *   Hard → E−0.15，max(I+1, round(I×1.2))；Good → max(I+1, round(I×E))；
 *   Easy → E+0.15，max(I+1, round(I×E×1.3))。间隔上限 365 天，E 在 1.3 ~ 3.0。
 */
function zehScheduleReview(state, rating, now) {
  if (!ZEH_REVIEW_RATINGS.includes(rating) || !zehIsValidReviewClock(now)) return null;
  const rules = ZEH_REVIEW_RULES;
  const s = zehSanitizeReviewState(state, now);
  const next = { ...s, reviewCount: s.reviewCount + 1, lastReviewedAt: now, lastRating: rating };
  const clampDays = (days) => Math.min(rules.maxIntervalDays, Math.max(1, Math.round(days)));
  const dueInDays = (days) => {
    next.intervalDays = days;
    next.dueAt = now + days * ZEH_DAY_MS;
  };

  if (s.status === "review") {
    const interval = Math.max(1, s.intervalDays);
    const ease = s.ease;
    if (rating === "again") {
      next.status = "relearning";
      next.lapseCount = s.lapseCount + 1;
      next.ease = zehRoundEase(Math.max(rules.minEase, ease - rules.againEasePenalty));
      next.intervalDays = clampDays(interval * rules.lapseMultiplier);
      next.dueAt = now + rules.againDelayMs;
    } else if (rating === "hard") {
      next.ease = zehRoundEase(Math.max(rules.minEase, ease - rules.hardEasePenalty));
      dueInDays(clampDays(Math.max(interval + 1, interval * rules.hardMultiplier)));
    } else if (rating === "good") {
      dueInDays(clampDays(Math.max(interval + 1, interval * ease)));
    } else {
      next.ease = zehRoundEase(Math.min(rules.maxEase, ease + rules.easyEaseBonus));
      dueInDays(clampDays(Math.max(interval + 1, interval * ease * rules.easyMultiplier)));
    }
    return next;
  }

  const relearning = s.status === "relearning";
  if (rating === "again" || rating === "hard") {
    next.status = relearning ? "relearning" : "learning";
    next.dueAt = now + (rating === "again" ? rules.againDelayMs : rules.hardDelayMs);
    if (!relearning) next.intervalDays = 0;
    return next;
  }
  next.status = "review";
  if (rating === "good") {
    dueInDays(relearning ? clampDays(s.intervalDays) : rules.graduateGoodDays);
  } else {
    const interval = Math.max(1, s.intervalDays);
    dueInDays(
      relearning
        ? clampDays(Math.max(interval + 1, interval * rules.easyMultiplier))
        : rules.graduateEasyDays
    );
  }
  return next;
}

/** 四个评分各自的结果（用于按钮上的「10 分钟 / 1 天」提示） */
function zehReviewPreview(state, now) {
  const out = {};
  ZEH_REVIEW_RATINGS.forEach((rating) => {
    out[rating] = zehScheduleReview(state, rating, now);
  });
  return out;
}

/** 间隔的中文显示：分钟 / 小时 / 天 / 个月 / 年 */
function zehFormatReviewDelay(ms) {
  const minutes = Math.max(1, Math.round((Number(ms) || 0) / 60000));
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  const days = Math.round(minutes / 1440);
  if (days < 60) return `${days} 天`;
  if (days < 365) return `${Math.round(days / 30)} 个月`;
  return `${Math.round((days / 365) * 10) / 10} 年`;
}

// ─── 复习队列 ────────────────────────────────────────────────────────────────

/** new：新词（总是可复习）；due：复习阶段已到期；learning：学习 / 重学已到期；future：未到期 */
function zehReviewBucket(review, now) {
  if (review.status === "new") return "new";
  if (review.dueAt > now) return "future";
  return review.status === "review" ? "due" : "learning";
}

function zehCompareVocabStable(a, b) {
  return (a.serial || 0) - (b.serial || 0) || (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0);
}

/**
 * 确定性的复习队列。顺序：到期复习（最早到期在前）→ 到期的学习 / 重学 → 新词（最新加入在前）。
 * 同一 dueAt 按编号、id 排序，不随机。session 是一轮复习的 id 列表（受 limits 限制）。
 * now 无效时视为没有到期（新词仍可复习）。
 */
function zehBuildReviewQueue(items, now, limits) {
  const lim = { ...ZEH_REVIEW_SESSION_LIMITS, ...(limits || {}) };
  const validClock = zehIsValidReviewClock(now);
  const buckets = { due: [], learning: [], new: [], future: [] };
  zehNormalizeVocabularyList(items).forEach((item) => {
    const bucket = validClock
      ? zehReviewBucket(item.review, now)
      : item.review.status === "new"
        ? "new"
        : "future";
    buckets[bucket].push(item);
  });
  const byDue = (a, b) => a.review.dueAt - b.review.dueAt || zehCompareVocabStable(a, b);
  buckets.due.sort(byDue);
  buckets.learning.sort(byDue);
  buckets.future.sort(byDue);
  buckets.new.sort((a, b) => zehCompareVocabStable(b, a));
  const ordered = [...buckets.due, ...buckets.learning, ...buckets.new.slice(0, Math.max(0, lim.maxNew))];
  return {
    session: ordered.slice(0, Math.max(0, lim.maxCards)).map((v) => v.id),
    counts: {
      due: buckets.due.length,
      learning: buckets.learning.length,
      new: buckets.new.length,
      future: buckets.future.length,
    },
    nextDueAt: buckets.future.length ? buckets.future[0].review.dueAt : null,
  };
}

/**
 * 复习卡片用哪个语境：contextIndex = reviewCount % 语境数。
 * 每复习一次换下一个语境（按保存顺序轮换），没有语境时返回 null。
 */
function zehPickReviewContext(item) {
  const list = zehValidVocabContexts(item);
  if (!list.length) return null;
  const count = item?.review?.reviewCount;
  const index = (Number.isInteger(count) && count >= 0 ? count : 0) % list.length;
  return { context: list[index], index, total: list.length };
}
