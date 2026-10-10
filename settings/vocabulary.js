/**
 * 设置页分区「生词本」：只读列表、搜索与筛选、导出（TXT / CSV / Markdown）、删除（经 service worker）。
 *
 * 加载时只声明。设置页从不直接写 zehVocabulary：删除走 DELETE_VOCAB，旧格式迁移走 MIGRATE_VOCAB（R-06）。
 * vocabulary 由 settings.js 的 loadAll 填充，storage 变化时由 handleVocabularyStorageChange 更新。
 * 依赖：settings/core.js（currentSection、mainBody、扩展失效保护、escapeHtml）、
 *       settings/review.js（updateReviewBadge、renderReviewStats、renderReviewView，storage 变化时刷新复习页）、
 *       vocab-review.js 与 config.js（词条规范化、复习字段）。
 */

let vocabulary = [];

// 生词本搜索状态：跨 renderVocabList 调用保持搜索词
const vocabState = {
  searchQuery: "",
  typeFilter: "all",
  _filteredList: [],
};

// ── 0.11.1 派生词 / 同义词 / 助记（列表、搜索、复习、导出共用）──────────────────

/** 单词 / 短语条目的助记只在过了质量门时显示（旧的硬拆字母助记不显示；代码术语等原样） */
function vocabUsefulMemoryTip(item) {
  const tip = typeof item?.memory_tip === "string" ? item.memory_tip.trim() : "";
  if (!tip) return "";
  const lexical = !item.queryType || item.queryType === "word" || item.queryType === "phrase";
  if (!lexical) return tip;
  return zehIsUsefulMemoryTip(tip, item.term, item.short_meaning) ? tip : "";
}

function vocabDerivatives(item) {
  return zehSanitizeDerivatives(item?.derivatives, item?.term);
}

/** 某个语境（或词条本身）的同义词 */
function vocabSynonymsOf(holder, term) {
  return zehSanitizeSynonyms(holder?.synonyms, term);
}

/** 词条的全部同义词：各语境的 + 词条上的，按词去重 */
function vocabAllSynonyms(item) {
  let all = [];
  zehValidVocabContexts(item).forEach((ctx) => {
    all = zehMergeLexicalList(all, vocabSynonymsOf(ctx, item.term), 50);
  });
  return zehMergeLexicalList(all, vocabSynonymsOf(item, item.term), 50);
}

/** decision n. 决定；决策 | decisive adj. 果断的 */
function formatDerivativesPlain(list) {
  return (Array.isArray(list) ? list : [])
    .map((d) => `${d.word}${d.pos ? ` ${d.pos}` : ""} ${d.zh}`)
    .join(" | ");
}

/** approve — 批准（更正式） | endorse — 认可 */
function formatSynonymsPlain(list) {
  return (Array.isArray(list) ? list : [])
    .map((syn) => `${syn.word} — ${syn.zh}${syn.nuance ? `（${syn.nuance}）` : ""}`)
    .join(" | ");
}

function formatVocabNote(item) {
  const lines = [
    `#${item.serial || "?"} 【${item.term}】`,
    `类型: ${item.queryType === "sentence" ? "句子" : "单词"}`,
    `时间: ${item.savedAtLocal || zehFormatLocalTime(item.savedAt)}`,
  ];

  if (item.pageUrl) {
    lines.push(`来源: ${item.pageUrl}`);
  }
  const sourceLabel = formatVocabSourceLabel(item);
  if (sourceLabel) lines.push(`出处: ${sourceLabel}`);
  lines.push("");

  if (item.queryType === "sentence") {
    if (item.translation) lines.push(`翻译: ${item.translation}`);
    if (item.nuance) lines.push(`语境: ${item.nuance}`);
    if (item.tone) lines.push(`语气: ${item.tone}`);
    if (item.grammar_notes) lines.push(`语法: ${item.grammar_notes}`);
    if (Array.isArray(item.key_phrases) && item.key_phrases.length) {
      lines.push(`重点: ${item.key_phrases.join("；")}`);
    }
    return lines.join("\n");
  }

  if (item.phonetic) lines.push(`音标: ${item.phonetic}`);
  if (item.part_of_speech) lines.push(`词性: ${item.part_of_speech}`);
  if (item.short_meaning) lines.push(`中文: ${item.short_meaning}`);
  lines.push(...formatVocabContextNoteLines(item));
  if (item.context_meaning) lines.push(`用法: ${item.context_meaning}`);
  const derivatives = formatDerivativesPlain(vocabDerivatives(item));
  if (derivatives) lines.push(`派生词: ${derivatives}`);
  const termSynonyms = formatSynonymsPlain(vocabSynonymsOf(item, item.term));
  if (termSynonyms) lines.push(`同义词: ${termSynonyms}`);
  if (Array.isArray(item.examples) && item.examples.length) {
    item.examples.forEach((ex, i) => {
      if (ex.en) lines.push(`例句${i + 1}: ${ex.en}`);
      if (ex.zh) lines.push(`翻译: ${ex.zh}`);
    });
  }
  const memoryTip = vocabUsefulMemoryTip(item);
  if (memoryTip) lines.push(`记忆: ${memoryTip}`);
  return lines.join("\n");
}

/** 出处：页面标题，或 EPUB 书名 · 章节，或 PDF 标题 · 第 N 页（词条或某个语境；没有时返回空） */
function formatVocabSourceLabel(item) {
  const book = item && typeof item.book === "object" && item.book ? item.book : null;
  if (book && (book.title || book.chapterTitle)) {
    return [book.title, book.chapterTitle].filter(Boolean).join(" · ");
  }
  const pdf = item && typeof item.pdf === "object" && item.pdf ? item.pdf : null;
  if (pdf && (pdf.title || pdf.fileName || pdf.page)) {
    const name = pdf.title || pdf.fileName || "PDF";
    return Number.isInteger(pdf.page) ? `${name} · 第 ${pdf.page} 页` : name;
  }
  return typeof item?.pageTitle === "string" ? item.pageTitle : "";
}

/** 一个语境的「当前语境 / 原句 / 原句翻译 / 出处」，按 Phase 3 的标签输出 */
function vocabContextFields(ctx) {
  return [
    ["当前语境", ctx.meaning_here || ""],
    ["原句", ctx.sentence || ""],
    ["原句翻译", ctx.sentence_translation || ""],
    ["同义词", formatSynonymsPlain(vocabSynonymsOf(ctx))],
    ["出处", formatVocabSourceLabel(ctx)],
  ].filter(([, value]) => value);
}

/** TXT：一个语境时与 Phase 3 相同；多个语境时每个前面加「语境 i/N:」并缩进 */
function formatVocabContextNoteLines(item) {
  const contexts = zehValidVocabContexts(item);
  const lines = (ctx, indent) => vocabContextFields(ctx).map(([label, value]) => `${indent}${label}: ${value}`);
  if (contexts.length === 1) return lines(contexts[0], "");
  return contexts.flatMap((ctx, i) => [`语境 ${i + 1}/${contexts.length}:`, ...lines(ctx, "  ")]);
}

/** Markdown：同上，多个语境时用「语境 i/N」加缩进的子列表 */
function formatVocabContextMarkdownLines(item) {
  const contexts = zehValidVocabContexts(item);
  const lines = (ctx, indent) => vocabContextFields(ctx).map(([label, value]) => `${indent}- **${label}**: ${value}`);
  if (contexts.length === 1) return lines(contexts[0], "");
  return contexts.flatMap((ctx, i) => [`- **语境 ${i + 1}/${contexts.length}**:`, ...lines(ctx, "  ")]);
}

/** CSV 单元格：一个语境时直接是值；多个语境时每行「[i] 值」（缺失写 —），列数不变 */
function vocabContextCsvCell(contexts, pick) {
  if (contexts.length === 1) return pick(contexts[0]) || "";
  return contexts.map((ctx, i) => `[${i + 1}] ${pick(ctx) || "—"}`).join("\n");
}

const VOCAB_EXPORT_META = {
  txt: { ext: "txt", mime: "text/plain;charset=utf-8", label: "TXT" },
  csv: { ext: "csv", mime: "text/csv;charset=utf-8", label: "CSV" },
  markdown: { ext: "md", mime: "text/markdown;charset=utf-8", label: "Markdown" },
};

function csvEscape(value) {
  let text = value == null ? "" : String(value);
  // 以 = + - @ 制表符或回车开头的文字会被表格软件当成公式（CSV 注入；语境句、AI 释义都可能来自网页）：
  // 前面加单引号，表格里按文本显示。数字（编号）不受影响。
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatExamplesPlain(examples) {
  if (!Array.isArray(examples) || examples.length === 0) {
    return "";
  }
  return examples
    .map((ex) => {
      const en = ex.en || "";
      const zh = ex.zh || "";
      return zh ? `${en} (${zh})` : en;
    })
    .join(" | ");
}

function formatKeyPhrasesPlain(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return "";
  }
  return items.join("；");
}

function exportVocabAsTxt(items) {
  const header = [
    "Manekilex 生词本",
    `导出时间: ${zehFormatLocalTime(Date.now())}`,
    `共 ${items.length} 条`,
    "",
  ].join("\n");
  const body = items.map((item) => formatVocabNote(item)).join("\n\n---\n\n");
  return `${header}${body}`;
}

function exportVocabAsCsv(items) {
  const headers = [
    "编号",
    "时间",
    "类型",
    "词条",
    "音标",
    "词性",
    "中文释义",
    "语境",
    "翻译",
    "语法",
    "重点词组",
    "语气",
    "例句",
    "记忆",
    "来源链接",
    // Phase 3：追加在末尾，旧列的位置不变
    "当前语境",
    "原句",
    "原句翻译",
    "出处",
    // 0.11.1：同样追加在末尾
    "派生词",
    "同义词",
  ];

  const rows = items.map((item) => {
    const isSentence = item.queryType === "sentence";
    const contexts = isSentence ? [] : zehValidVocabContexts(item);
    return [
      item.serial ?? "",
      item.savedAtLocal || zehFormatLocalTime(item.savedAt),
      isSentence ? "句子" : "单词",
      item.term || "",
      isSentence ? "" : item.phonetic || "",
      isSentence ? "" : item.part_of_speech || "",
      isSentence ? "" : item.short_meaning || "",
      isSentence ? item.nuance || "" : item.context_meaning || "",
      isSentence ? item.translation || "" : "",
      isSentence ? item.grammar_notes || "" : "",
      isSentence ? formatKeyPhrasesPlain(item.key_phrases) : "",
      isSentence ? item.tone || "" : "",
      isSentence ? "" : formatExamplesPlain(item.examples),
      isSentence ? "" : vocabUsefulMemoryTip(item),
      item.pageUrl || "",
      // Phase 3 的四列；多个语境时同一单元格内分行列出（Phase 4）
      vocabContextCsvCell(contexts, (ctx) => ctx.meaning_here),
      vocabContextCsvCell(contexts, (ctx) => ctx.sentence),
      vocabContextCsvCell(contexts, (ctx) => ctx.sentence_translation),
      contexts.length ? vocabContextCsvCell(contexts, formatVocabSourceLabel) : formatVocabSourceLabel(item),
      isSentence ? "" : formatDerivativesPlain(vocabDerivatives(item)),
      isSentence
        ? ""
        : contexts.some((ctx) => vocabSynonymsOf(ctx).length)
          ? vocabContextCsvCell(contexts, (ctx) => formatSynonymsPlain(vocabSynonymsOf(ctx)))
          : formatSynonymsPlain(vocabSynonymsOf(item, item.term)),
    ].map(csvEscape);
  });

  return `\uFEFF${[headers.map(csvEscape).join(","), ...rows.map((r) => r.join(","))].join("\n")}`;
}

function exportVocabAsMarkdown(items) {
  const lines = [
    "# Manekilex 生词本",
    "",
    `- 导出时间: ${zehFormatLocalTime(Date.now())}`,
    `- 词条数量: ${items.length}`,
    "",
  ];

  items.forEach((item) => {
    const typeLabel = item.queryType === "sentence" ? "句子" : "单词";
    lines.push(`## #${item.serial || "?"} ${item.term || ""}（${typeLabel}）`);
    lines.push("");
    lines.push(`- **时间**: ${item.savedAtLocal || zehFormatLocalTime(item.savedAt)}`);
    if (item.pageUrl) {
      lines.push(`- **来源**: [${item.pageUrl}](${item.pageUrl})`);
    }
    const sourceLabel = formatVocabSourceLabel(item);
    if (sourceLabel) lines.push(`- **出处**: ${sourceLabel}`);

    if (item.queryType === "sentence") {
      if (item.translation) lines.push(`- **翻译**: ${item.translation}`);
      if (item.nuance) lines.push(`- **语境**: ${item.nuance}`);
      if (item.tone) lines.push(`- **语气**: ${item.tone}`);
      if (item.grammar_notes) lines.push(`- **语法**: ${item.grammar_notes}`);
      if (Array.isArray(item.key_phrases) && item.key_phrases.length) {
        lines.push(`- **重点词组**: ${item.key_phrases.map((p) => `\`${p}\``).join("、")}`);
      }
    } else {
      if (item.phonetic) lines.push(`- **音标**: \`${item.phonetic}\``);
      if (item.part_of_speech) lines.push(`- **词性**: ${item.part_of_speech}`);
      if (item.short_meaning) lines.push(`- **中文**: ${item.short_meaning}`);
      lines.push(...formatVocabContextMarkdownLines(item));
      if (item.context_meaning) lines.push(`- **用法**: ${item.context_meaning}`);
      const derivatives = formatDerivativesPlain(vocabDerivatives(item));
      if (derivatives) lines.push(`- **派生词**: ${derivatives}`);
      const termSynonyms = formatSynonymsPlain(vocabSynonymsOf(item, item.term));
      if (termSynonyms) lines.push(`- **同义词**: ${termSynonyms}`);
      const memoryTip = vocabUsefulMemoryTip(item);
      if (memoryTip) lines.push(`- **记忆**: ${memoryTip}`);
      if (Array.isArray(item.examples) && item.examples.length) {
        lines.push("- **例句**:");
        item.examples.forEach((ex) => {
          lines.push(`  - ${ex.en || ""}${ex.zh ? ` — ${ex.zh}` : ""}`);
        });
      }
    }

    lines.push("");
    lines.push("---");
    lines.push("");
  });

  return lines.join("\n").trim() + "\n";
}

function buildVocabExport(items, format) {
  if (format === "csv") {
    return exportVocabAsCsv(items);
  }
  if (format === "markdown") {
    return exportVocabAsMarkdown(items);
  }
  return exportVocabAsTxt(items);
}

function downloadTextFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportVocabularyItems(items, format, mode) {
  if (!items.length) {
    alert("没有可导出的生词");
    return;
  }

  const meta = VOCAB_EXPORT_META[format] || VOCAB_EXPORT_META.txt;
  const content = buildVocabExport(items, format);
  const date = new Date().toISOString().slice(0, 10);
  const filename = `mk-vocab-${date}.${meta.ext}`;

  if (mode === "copy") {
    navigator.clipboard
      .writeText(content)
      .then(() => alert(`已复制 ${items.length} 条（${meta.label}）到剪贴板`))
      .catch(() => alert("复制失败，请改用下载导出"));
    return;
  }

  downloadTextFile(content, filename, meta.mime);
}

/**
 * 只更新 #vocabList 的内容。
 * 搜索框、导出控件不会被销毁，焦点不丢失。
 */
function vocabEntryKind(v) {
  return v.queryType === "sentence" ? "sentence" : "word";
}

function refreshVocabFilterLabels() {
  const wordCount = vocabulary.filter((v) => vocabEntryKind(v) === "word").length;
  const sentenceCount = vocabulary.length - wordCount;
  const counts = { all: vocabulary.length, word: wordCount, sentence: sentenceCount };
  const labels = { all: "全部", word: "单词", sentence: "句子" };

  document.querySelectorAll("[data-vocab-filter]").forEach((btn) => {
    const key = btn.dataset.vocabFilter;
    if (labels[key]) {
      btn.textContent = `${labels[key]} (${counts[key]})`;
    }
    btn.classList.toggle("active", key === vocabState.typeFilter);
  });
}

/** 一个语境：此处含义 + 原句 + 出处 */
function renderVocabContextLines(ctx) {
  const lines = [];
  if (ctx.meaning_here) {
    lines.push(`<div class="vocab-meaning-here"><span class="vocab-context-label">当前语境</span>${escapeHtml(ctx.meaning_here)}</div>`);
  }
  lines.push(`<div class="vocab-context">${escapeHtml(ctx.sentence)}</div>`);
  const synonyms = vocabSynonymsOf(ctx);
  if (synonyms.length) {
    lines.push(
      `<div class="vocab-lexical"><span class="vocab-context-label">同义词</span>${escapeHtml(
        synonyms.map((syn) => `${syn.word} — ${syn.zh}`).join("；")
      )}</div>`
    );
  }
  const source = formatVocabSourceLabel(ctx);
  if (source) {
    lines.push(`<div class="vocab-context-source">${escapeHtml(source)}</div>`);
  }
  return lines.join("");
}

/** 列表里的语境：第一个直接显示，其余收在可展开区域里（列表不会变得很长） */
function renderVocabContexts(v) {
  const contexts = zehValidVocabContexts(v);
  if (!contexts.length) return "";
  const [first, ...rest] = contexts;
  if (!rest.length) return renderVocabContextLines(first);
  const more = rest
    .map(
      (ctx, i) => `
        <div class="vocab-context-block">
          <span class="vocab-context-index">语境 ${i + 2}</span>
          ${renderVocabContextLines(ctx)}
          ${ctx.sentence_translation ? `<div class="vocab-context-translation">${escapeHtml(ctx.sentence_translation)}</div>` : ""}
        </div>`
    )
    .join("");
  return `${renderVocabContextLines(first)}
    <details class="vocab-contexts">
      <summary>查看其余 ${rest.length} 个语境</summary>
      ${more}
    </details>`;
}

/** 「N 个语境」标记（没有语境时不显示） */
function renderVocabContextCount(v) {
  const count = zehValidVocabContexts(v).length;
  return count ? `<span class="vocab-context-count">${count} 个语境</span>` : "";
}

/** 复习状态的简短说明（时间按本地时区显示） */
function formatVocabReviewMeta(v) {
  const review = v.review;
  if (!review) return "";
  if (review.status === "new") return "复习：新词，未复习";
  const due = review.dueAt <= Date.now() ? "已到期" : `下次 ${zehFormatLocalTime(review.dueAt)}`;
  return `复习：${due} · 已复习 ${review.reviewCount} 次`;
}

/**
 * 词条级的派生词 / 助记 / 同义词（没有原句时）紧凑显示；语境里的同义词跟着语境显示。
 */
function renderVocabLexical(v) {
  const rows = [];
  const derivatives = vocabDerivatives(v);
  if (derivatives.length) {
    rows.push(
      `<div class="vocab-lexical"><span class="vocab-context-label">派生词</span>${escapeHtml(
        derivatives.map((d) => `${d.word}${d.pos ? ` · ${d.pos}` : ""} ${d.zh}`).join("；")
      )}</div>`
    );
  }
  const termSynonyms = vocabSynonymsOf(v, v.term);
  if (termSynonyms.length) {
    rows.push(
      `<div class="vocab-lexical"><span class="vocab-context-label">同义词</span>${escapeHtml(
        termSynonyms.map((syn) => `${syn.word} — ${syn.zh}`).join("；")
      )}</div>`
    );
  }
  const memoryTip = vocabUsefulMemoryTip(v);
  if (memoryTip) {
    rows.push(`<div class="vocab-lexical"><span class="vocab-context-label">助记</span>${escapeHtml(memoryTip)}</div>`);
  }
  return rows.join("");
}

/** 搜索范围：词、释义、用法、出处、派生词 / 同义词（英文与中文），以及每一个语境的原句 / 此处含义 / 翻译 / 出处 */
function vocabSearchText(v) {
  const parts = [v.term, v.short_meaning, v.translation, v.context_meaning, v.note, formatVocabSourceLabel(v)];
  vocabDerivatives(v).forEach((d) => parts.push(d.word, d.zh));
  vocabAllSynonyms(v).forEach((syn) => parts.push(syn.word, syn.zh));
  zehValidVocabContexts(v).forEach((ctx) => {
    parts.push(ctx.sentence, ctx.meaning_here, ctx.sentence_translation, formatVocabSourceLabel(ctx));
  });
  return parts
    .filter((part) => typeof part === "string" && part)
    .join("\n")
    .toLowerCase();
}

function renderVocabList() {
  const q = vocabState.searchQuery.trim().toLowerCase();
  const typeFilter = vocabState.typeFilter || "all";
  const list = vocabulary.filter((v) => {
    if (typeFilter !== "all" && vocabEntryKind(v) !== typeFilter) return false;
    if (!q) return true;
    return vocabSearchText(v).includes(q);
  });
  vocabState._filteredList = list;

  refreshVocabFilterLabels();

  // 更新导出范围选项文字（不重建 select）
  const filteredOpt = document.querySelector("#exportScope option[value='filtered']");
  const allOpt = document.querySelector("#exportScope option[value='all']");
  if (filteredOpt) filteredOpt.textContent = `当前列表 (${list.length})`;
  if (allOpt) allOpt.textContent = `全部生词 (${vocabulary.length})`;

  const vocabListEl = document.getElementById("vocabList");
  if (!vocabListEl) return;

  vocabListEl.innerHTML =
    list.length === 0
      ? `<p class="vocab-empty">${
          vocabulary.length === 0
            ? "暂无生词。在网页查词后，点击面板底部「加入生词本」。"
            : typeFilter === "all" && !q
              ? "暂无生词。"
              : "当前筛选下暂无匹配项。"
        }</p>`
      : list
          .map(
            (v) => `
          <div class="vocab-item" data-id="${escapeHtml(v.id)}">
            <div class="vocab-item-top">
              <span class="vocab-serial">#${escapeHtml(String(v.serial || "?"))}</span>
              <span class="vocab-time">${escapeHtml(v.savedAtLocal || zehFormatLocalTime(v.savedAt))}</span>
            </div>
            <div class="vocab-item-head">
              <span class="vocab-term">${escapeHtml(v.term)}</span>
              <span class="vocab-item-tags">
                <span class="vocab-type">${v.queryType === "sentence" ? "句子" : "单词"}</span>
                ${renderVocabContextCount(v)}
              </span>
            </div>
            <div class="vocab-meaning">${escapeHtml(v.short_meaning || v.translation || "")}</div>
            ${renderVocabContexts(v)}
            ${renderVocabLexical(v)}
            <div class="vocab-review-meta">${escapeHtml(formatVocabReviewMeta(v))}</div>
            <div class="vocab-actions">
              <button type="button" class="vocab-copy" data-id="${escapeHtml(v.id)}">复制</button>
              <button type="button" class="vocab-del" data-id="${escapeHtml(v.id)}">删除</button>
            </div>
          </div>`
          )
          .join("");
}

/**
 * 删除由 service worker 在最新的 storage 数据上完成（R-06）：
 * 设置页不再把手里可能过期的数组写回，其他标签页刚加入的生词不会被抹掉。
 */
async function deleteVocabularyViaBackground(ids) {
  if (!isExtensionAlive()) {
    markExtensionDead();
    return { ok: false, message: "扩展已更新，请刷新本页" };
  }
  try {
    const resp = await chrome.runtime.sendMessage({ type: "DELETE_VOCAB", ids });
    if (resp?.ok) return resp;
    return { ok: false, message: resp?.message || "删除失败，请刷新设置页后重试" };
  } catch (error) {
    if (isInvalidatedError(error?.message)) markExtensionDead();
    return { ok: false, message: "删除失败：无法连接插件后台，请刷新设置页后重试" };
  }
}

/** 让 service worker 把旧条目迁移为 v2（幂等；已迁移时不写 storage）。失败不影响本页显示。 */
function requestVocabularyMigration() {
  if (!isExtensionAlive()) return;
  try {
    Promise.resolve(chrome.runtime.sendMessage({ type: "MIGRATE_VOCAB" })).catch(() => {});
  } catch {
    /* 后台不可达时下次打开再迁移 */
  }
}

/** 其他页面加入 / 删除 / 复习生词后同步本页（保留当前搜索、筛选与这一轮复习） */
function handleVocabularyStorageChange(changes, area) {
  if (area !== "local" || !changes[ZEH_STORAGE.vocabulary]) return;
  const next = changes[ZEH_STORAGE.vocabulary].newValue;
  vocabulary = zehNormalizeVocabularyList(Array.isArray(next) ? next : []);
  if (currentSection === "vocabulary" && document.getElementById("vocabList")) {
    renderVocabList();
  }
  if (currentSection === "review") {
    renderReviewStats();
    renderReviewView();
  }
  updateReviewBadge();
}

/**
 * 构建生词本区域的 shell（搜索框、导出控件）并绑定事件——每次切换到生词本 tab 时调用一次。
 * 搜索时只调用 renderVocabList()，不重建 shell，搜索框不会失焦。
 */
function renderVocabulary() {
  vocabState.searchQuery = "";
  vocabState.typeFilter = "all";
  vocabState._filteredList = [];

  mainBody.innerHTML = `
    <div class="vocab-intro">
      每条记录有<strong>全局编号</strong>与<strong>加入时的本地时间</strong>。可按单词 / 句子筛选，与搜索、导出联动。
    </div>
    <div class="vocab-toolbar">
      <input type="search" class="vocab-search" id="vocabSearch" placeholder="搜索单词、句子或释义…" />
    </div>
    <div class="vocab-type-filter data-cache-filter">
      <button type="button" class="data-filter-btn active" data-vocab-filter="all">全部</button>
      <button type="button" class="data-filter-btn" data-vocab-filter="word">单词</button>
      <button type="button" class="data-filter-btn" data-vocab-filter="sentence">句子</button>
    </div>
    <div class="vocab-export-bar">
      <label class="export-field">
        <span>格式</span>
        <select id="exportFormat">
          <option value="txt">TXT 纯文本</option>
          <option value="csv">CSV 表格</option>
          <option value="markdown">Markdown</option>
        </select>
      </label>
      <label class="export-field">
        <span>范围</span>
        <select id="exportScope">
          <option value="filtered">当前列表</option>
          <option value="all">全部生词</option>
        </select>
      </label>
      <button type="button" class="mk-btn mk-btn-primary mk-btn-md mk-btn-cat mk-btn-cat-right" id="exportVocabBtn">
        <img class="mk-btn-cat-img mk-btn-cat-sm" src="icons/css_4.png" alt="" />
        <span>下载文件</span>
      </button>
      <button type="button" class="mk-btn mk-btn-secondary mk-btn-md" id="copyVocabBtn">复制到剪贴板</button>
    </div>
    <p id="exportStatus" class="status-msg"></p>
    <div class="vocab-list" id="vocabList"></div>
  `;

  // ── 搜索：只更新列表，不重建 shell ──────────────────────────────────────────
  document.getElementById("vocabSearch").addEventListener("input", (e) => {
    vocabState.searchQuery = e.target.value;
    renderVocabList();
  });

  document.querySelectorAll("[data-vocab-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      vocabState.typeFilter = btn.dataset.vocabFilter || "all";
      renderVocabList();
    });
  });

  // ── 导出帮助函数 ────────────────────────────────────────────────────────────
  function getExportItems() {
    const scope = document.getElementById("exportScope")?.value || "filtered";
    return scope === "all" ? vocabulary.slice() : vocabState._filteredList.slice();
  }

  function showExportStatus(msg, type) {
    const el = document.getElementById("exportStatus");
    if (el) {
      el.textContent = msg;
      el.className = "status-msg " + (type || "");
    }
  }

  document.getElementById("exportVocabBtn").addEventListener("click", () => {
    const format = document.getElementById("exportFormat")?.value || "txt";
    const items = getExportItems();
    exportVocabularyItems(items, format, "download");
    const meta = VOCAB_EXPORT_META[format] || VOCAB_EXPORT_META.txt;
    showExportStatus(`已下载 ${items.length} 条（${meta.label}）`, "ok");
  });

  document.getElementById("copyVocabBtn").addEventListener("click", () => {
    const format = document.getElementById("exportFormat")?.value || "txt";
    const items = getExportItems();
    exportVocabularyItems(items, format, "copy");
  });

  // ── 删除 / 复制：事件委托到稳定的 #vocabList，不需要每次 render 重新绑定 ──
  document.getElementById("vocabList").addEventListener("click", async (e) => {
    const delBtn = e.target.closest(".vocab-del");
    if (delBtn) {
      const id = delBtn.dataset.id;
      const result = await deleteVocabularyViaBackground([id]);
      if (!result.ok) {
        alert(result.message || "删除失败，请刷新设置页后重试");
        return;
      }
      // 以 storage.onChanged 推来的最新列表为准；这里先移除本条，列表立即更新
      vocabulary = vocabulary.filter((v) => v.id !== id);
      renderVocabList(); // 只重绘列表，搜索框不失焦
      return;
    }

    const copyBtn = e.target.closest(".vocab-copy");
    if (copyBtn) {
      const item = vocabulary.find((v) => v.id === copyBtn.dataset.id);
      if (item) {
        navigator.clipboard.writeText(formatVocabNote(item));
      }
    }
  });

  // 初始渲染列表
  renderVocabList();
}
