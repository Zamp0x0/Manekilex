/**
 * 设置页分区「复习」：按间隔重复复习生词本，评分经 service worker（REVIEW_VOCAB）写入。
 *
 * 加载时只声明。键盘快捷键由 settings.js 注册（document keydown → handleReviewKeydown）。
 * 依赖：settings/core.js（currentSection、mainBody、扩展失效保护、escapeHtml）、
 *       settings/vocabulary.js（vocabulary 与词条格式化函数）、vocab-review.js（队列与调度）。
 */

// ─── 复习（Phase 4）──────────────────────────────────────────────────────────
// 一轮复习 = 开始时按队列规则取一份 id 快照（到期 → 学习中 → 新词）。
// storage 更新只刷新词条内容与计数，不重排、不重置这一轮；被删除的词到它时跳过。
// 评分经 service worker（REVIEW_VOCAB）写入，成功后才进入下一张；失败时停在当前卡片，可以重试。
let reviewSession = null;

const REVIEW_RATING_LABELS = { again: "重来", hard: "困难", good: "良好", easy: "简单" };

function computeReviewQueue() {
  return zehBuildReviewQueue(vocabulary, Date.now());
}

function findVocabById(id) {
  return vocabulary.find((v) => v.id === id) || null;
}

/** 侧栏「复习」上的数字 = 下一轮的卡片数（到期 + 最多 20 个新词） */
function updateReviewBadge() {
  const badge = document.getElementById("reviewNavBadge");
  if (!badge) return;
  const size = computeReviewQueue().session.length;
  badge.textContent = size > 99 ? "99+" : String(size);
  badge.hidden = size === 0;
}

function startReviewSession() {
  reviewSession = {
    ids: computeReviewQueue().session,
    index: 0,
    revealed: false,
    pending: false,
    reviewed: 0,
    notice: "",
    error: "",
  };
  renderReviewStats();
  renderReviewView();
}

function endReviewSession() {
  reviewSession = null;
  renderReviewStats();
  renderReviewView();
}

/** 跳过已在别处删除的词（这一轮的其余顺序不变） */
function skipMissingReviewCards() {
  const s = reviewSession;
  if (!s) return;
  let skipped = 0;
  while (s.index < s.ids.length && !findVocabById(s.ids[s.index])) {
    s.index += 1;
    skipped += 1;
  }
  if (skipped) {
    s.revealed = false;
    s.notice = `已跳过 ${skipped} 个已删除的词`;
  }
}

function currentReviewItem() {
  const s = reviewSession;
  if (!s) return null;
  skipMissingReviewCards();
  return s.index < s.ids.length ? findVocabById(s.ids[s.index]) : null;
}

function revealReviewCard() {
  if (!reviewSession || reviewSession.revealed || !currentReviewItem()) return;
  reviewSession.revealed = true;
  renderReviewView();
}

function advanceReviewSession(notice) {
  const s = reviewSession;
  s.index += 1;
  s.revealed = false;
  s.pending = false;
  s.error = "";
  s.notice = notice || "";
  renderReviewStats();
  renderReviewView();
  updateReviewBadge();
}

/** 评分：只在 service worker 确认写入后前进；失败保留卡片与错误提示 */
async function rateReviewCard(rating) {
  const s = reviewSession;
  const item = currentReviewItem();
  if (!s || !item || !s.revealed || s.pending || !ZEH_REVIEW_RATINGS.includes(rating)) return;
  s.pending = true;
  s.error = "";
  renderReviewView();
  let resp;
  try {
    if (!isExtensionAlive()) throw new Error("扩展已更新，请刷新本页");
    resp = await chrome.runtime.sendMessage({
      type: "REVIEW_VOCAB",
      id: item.id,
      rating,
      expectedReviewCount: item.review.reviewCount,
    });
  } catch (error) {
    if (isInvalidatedError(error?.message)) markExtensionDead();
    resp = { ok: false, message: error?.message };
  }
  if (reviewSession !== s) return;
  if (resp?.ok || resp?.reason === "stale") {
    // 先用返回的新状态更新本地（storage.onChanged 随后会推来同样的数据）
    const review = resp.review;
    if (review) vocabulary = vocabulary.map((v) => (v.id === item.id ? { ...v, review } : v));
    if (resp.ok) s.reviewed += 1;
    advanceReviewSession(resp.ok ? "" : "这个词刚在其他页面复习过，已跳过");
    return;
  }
  if (resp?.reason === "not_found") {
    advanceReviewSession("这个词已被删除，已跳过");
    return;
  }
  s.pending = false;
  s.error = `保存失败：${resp?.message || "无法连接插件后台"}。本次评分未记录，请重试。`;
  renderReviewView();
}

function handleReviewAction(action, rating) {
  if (action === "start") startReviewSession();
  else if (action === "reveal") revealReviewCard();
  else if (action === "rate") rateReviewCard(rating);
  else if (action === "finish") endReviewSession();
}

/** 键盘：空格 / 回车 显示答案；显示后 1–4 = 重来 / 困难 / 良好 / 简单（可选） */
function handleReviewKeydown(e) {
  if (currentSection !== "review" || !reviewSession || e.ctrlKey || e.metaKey || e.altKey) return;
  const tag = String(e.target?.tagName || "").toUpperCase();
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || e.target?.isContentEditable) return;
  if (!reviewSession.revealed && (e.key === " " || e.key === "Enter")) {
    e.preventDefault?.();
    revealReviewCard();
    return;
  }
  const rating = reviewSession.revealed ? ZEH_REVIEW_RATINGS[Number(e.key) - 1] : null;
  if (rating) {
    e.preventDefault?.();
    rateReviewCard(rating);
  }
}

function renderReviewStats() {
  const el = document.getElementById("reviewStats");
  if (!el || currentSection !== "review") return;
  const q = computeReviewQueue();
  const stat = (key, label, value) =>
    `<div class="review-stat" data-review-stat="${key}"><span class="review-stat-value">${value}</span><span class="review-stat-label">${label}</span></div>`;
  el.innerHTML = [
    stat("due", "到期", q.counts.due + q.counts.learning),
    stat("new", "新词", q.counts.new),
    stat("reviewed", "本次已复习", reviewSession ? reviewSession.reviewed : 0),
    stat("future", "未到期", q.counts.future),
  ].join("");
}

function renderReviewOverview() {
  const q = computeReviewQueue();
  if (!q.session.length) {
    const next = q.nextDueAt
      ? `<p class="review-next">下一个到期：${escapeHtml(zehFormatLocalTime(q.nextDueAt))}</p>`
      : "";
    const hint = vocabulary.length ? "" : `<p class="review-hint">在网页查词后点击「加入生词本」，新词会出现在这里。</p>`;
    return `<div class="review-empty"><p class="review-empty-title">今天没有需要复习的单词</p>${next}${hint}</div>`;
  }
  const dueInSession = Math.min(q.counts.due + q.counts.learning, q.session.length);
  return `
    <div class="review-start">
      <p>本轮 <strong>${q.session.length}</strong> 个：到期 ${dueInSession} · 新词 ${q.session.length - dueInSession}</p>
      <button type="button" class="mk-btn mk-btn-primary mk-btn-md" data-review-action="start">开始复习</button>
    </div>`;
}

function renderReviewFinished() {
  const s = reviewSession;
  const q = computeReviewQueue();
  const more = q.session.length
    ? `<button type="button" class="mk-btn mk-btn-primary mk-btn-md" data-review-action="start">继续复习（${q.session.length}）</button>`
    : `<p class="review-empty-title">今天没有需要复习的单词</p>`;
  return `
    <div class="review-done">
      <p>本轮完成：复习了 <strong>${s.reviewed}</strong> 个词。${s.notice ? escapeHtml(s.notice) : ""}</p>
      ${more}
      <button type="button" class="mk-btn mk-btn-secondary mk-btn-md" data-review-action="finish">返回</button>
    </div>`;
}

function highlightReviewTerm(sentence, term) {
  const text = escapeHtml(sentence);
  const needle = escapeHtml(String(term || "").trim());
  if (!needle) return text;
  return text.replace(new RegExp(zehEscapeRegExp(needle), "gi"), (m) => `<mark>${m}</mark>`);
}

function reviewSection(label, html, extraClass) {
  return `<div class="review-section${extraClass ? ` ${extraClass}` : ""}"><div class="review-label">${label}</div><div class="review-text">${html}</div></div>`;
}

/** 卡片背面：基础释义 → 一个语境（按复习次数轮换）→ 派生词 → 同义词 → 助记 → 例句 */
function renderReviewBack(item) {
  const parts = [];
  const basic = item.short_meaning || item.translation || "";
  parts.push(reviewSection("基础释义", basic ? escapeHtml(basic) : "（无）"));

  const picked = zehPickReviewContext(item);
  if (picked) {
    const ctx = picked.context;
    const label = picked.total > 1 ? `当前语境 · ${picked.index + 1}/${picked.total}` : "当前语境";
    const meaning = ctx.meaning_here
      ? escapeHtml(ctx.meaning_here)
      : `<span class="review-fallback">保存时还没有此处含义，参考上面的基础释义</span>`;
    const source = formatVocabSourceLabel(ctx);
    parts.push(`
      <div class="review-section review-context" data-context-id="${escapeHtml(ctx.id || "")}">
        <div class="review-label">${label}</div>
        <div class="review-meaning-here">${meaning}</div>
        <div class="review-sentence">${highlightReviewTerm(ctx.sentence, item.term)}</div>
        ${ctx.sentence_translation ? `<div class="review-translation">${escapeHtml(ctx.sentence_translation)}</div>` : ""}
        ${source ? `<div class="review-source">${escapeHtml(source)}</div>` : ""}
      </div>`);
  } else if (item.context_meaning) {
    parts.push(reviewSection("用法", escapeHtml(item.context_meaning)));
  }
  if (item.queryType === "sentence" && item.grammar_notes) {
    parts.push(reviewSection("语法", escapeHtml(item.grammar_notes)));
  }
  // 0.11.1：派生词、此语境的同义词（没有时用词条上的）与可用助记，都只在翻面后显示
  const derivatives = vocabDerivatives(item);
  if (derivatives.length) {
    parts.push(
      reviewSection(
        "派生词",
        derivatives
          .map((d) => `<div class="review-lexical-row"><b>${escapeHtml(d.word)}</b>${d.pos ? ` · ${escapeHtml(d.pos)}` : ""} ${escapeHtml(d.zh)}</div>`)
          .join("")
      )
    );
  }
  const reviewSynonyms = picked?.context && vocabSynonymsOf(picked.context).length
    ? vocabSynonymsOf(picked.context)
    : vocabSynonymsOf(item, item.term);
  if (reviewSynonyms.length) {
    parts.push(
      reviewSection(
        "同义词",
        reviewSynonyms
          .map(
            (syn) =>
              `<div class="review-lexical-row"><b>${escapeHtml(syn.word)}</b> — ${escapeHtml(syn.zh)}${
                syn.nuance ? `<span class="review-example-zh">${escapeHtml(syn.nuance)}</span>` : ""
              }</div>`
          )
          .join("")
      )
    );
  }
  const memoryTip = vocabUsefulMemoryTip(item);
  if (memoryTip) parts.push(reviewSection("助记", escapeHtml(memoryTip)));
  const examples = (Array.isArray(item.examples) ? item.examples : []).filter((ex) => ex && (ex.en || ex.zh)).slice(0, 2);
  if (examples.length) {
    const list = examples
      .map((ex) => `<li>${escapeHtml(ex.en || "")}${ex.zh ? `<span class="review-example-zh">${escapeHtml(ex.zh)}</span>` : ""}</li>`)
      .join("");
    parts.push(reviewSection("例句", `<ul class="review-examples">${list}</ul>`));
  }
  return `<div class="review-back">${parts.join("")}</div>`;
}

function renderReviewRatings(item) {
  const now = Date.now();
  const preview = zehReviewPreview(item.review, now);
  const disabled = reviewSession.pending ? " disabled" : "";
  const buttons = ZEH_REVIEW_RATINGS.map((rating, i) => {
    const next = preview[rating];
    const delay = next ? zehFormatReviewDelay(next.dueAt - now) : "";
    return `<button type="button" class="review-rate review-rate-${rating}" data-review-action="rate" data-rating="${rating}"${disabled}>
        <span class="review-rate-label">${REVIEW_RATING_LABELS[rating]}</span>
        <span class="review-rate-delay">${delay}</span>
        <span class="review-rate-key">${i + 1}</span>
      </button>`;
  }).join("");
  return `<div class="review-ratings">${buttons}</div>`;
}

function renderReviewCard(item) {
  const s = reviewSession;
  const progress = `
    <div class="review-progress">
      <span class="review-progress-count">${s.index + 1} / ${s.ids.length}</span>
      ${s.notice ? `<span class="review-notice">${escapeHtml(s.notice)}</span>` : ""}
    </div>`;
  const meta = [item.phonetic, item.part_of_speech].filter(Boolean).map(escapeHtml).join(" · ");
  const front = `
    <div class="review-front">
      <div class="review-term${item.queryType === "sentence" ? " review-term-sentence" : ""}">${escapeHtml(item.term)}</div>
      ${meta ? `<div class="review-meta">${meta}</div>` : ""}
    </div>`;
  if (!s.revealed) {
    return `
      <div class="review-card" data-review-state="front">
        ${progress}${front}
        <div class="review-actions">
          <button type="button" class="mk-btn mk-btn-primary mk-btn-md" data-review-action="reveal">显示答案</button>
          <span class="review-key-hint">空格 / 回车</span>
        </div>
      </div>`;
  }
  const error = s.error ? `<p class="status-msg err review-error">${escapeHtml(s.error)}</p>` : "";
  return `
    <div class="review-card" data-review-state="back">
      ${progress}${front}${renderReviewBack(item)}${renderReviewRatings(item)}${error}
    </div>`;
}

function renderReviewView() {
  const view = document.getElementById("reviewView");
  if (!view || currentSection !== "review") return;
  if (!reviewSession) {
    view.innerHTML = renderReviewOverview();
    return;
  }
  const item = currentReviewItem();
  view.innerHTML = item ? renderReviewCard(item) : renderReviewFinished();
}

/** 复习区域的 shell；切换走再回来时，这一轮的进度还在 */
function renderReview() {
  mainBody.innerHTML = `
    <div class="review-stats" id="reviewStats"></div>
    <div class="review-view" id="reviewView"></div>
  `;
  const view = document.getElementById("reviewView");
  if (!view.dataset.bound) {
    view.dataset.bound = "1";
    view.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-review-action]");
      if (!btn || btn.disabled) return;
      handleReviewAction(btn.dataset.reviewAction, btn.dataset.rating);
    });
  }
  renderReviewStats();
  renderReviewView();
}
