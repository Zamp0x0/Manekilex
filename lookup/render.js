/**
 * lookup/render.js — 查词面板的 HTML 与复制文本（M7 从 mk-lookup.js 拆出）。
 *
 * zehCreateLookupRenderer(host) 为一个查词控制器生成渲染函数：单词 / 短语 / 句子 / 段落 / 代码术语结果、
 * 「当前语境」与例句区块、派生词 / 同义词 / 助记、耗时与来源标签、结果类型判断、「复制」用的纯文本。
 * 这些函数只拼字符串、不读写 DOM、不发消息；写进面板、绑定按钮仍由 mk-lookup.js 完成。
 * host（由 createController 提供，均为读取函数）：
 *   cachedText()        当前查询的文本（结果里缺 term 时用）
 *   cachedQueryType()   当前查询类型（结果里缺 queryType 时用）
 *   lookupContext()     本次查询带的语境（句子、来源类型），没有时为 null
 *   extensionAsset(p)   扩展内图片的 URL（彩蛋面板用）
 * 依赖 config.js：zehEscapeHtml、zehNormalizeWordResult、zehIsUsefulMemoryTip 等。
 * 加载：与 lookup/dom-helpers.js 一样只声明，内容脚本、EPUB 阅读器、PDF 阅读器、侧边栏都紧跟 config.js 加载 lookup/ 下的文件，
 * 都在 mk-lookup.js 之前。
 */

/**
 * 一个查词控制器的渲染函数。
 * @param {{ cachedText: Function, cachedQueryType: Function, lookupContext: Function, extensionAsset: Function }} host
 */
function zehCreateLookupRenderer(host) {
  const extensionAsset = host.extensionAsset;

  const QUERY_TYPE_LABELS = {
    word: "单词解释",
    phrase: "短语解释",
    sentence: "句子解释",
    paragraph: "段落解释",
    code_term: "技术术语解释",
  };

  function queryTypeLabel(queryType) {
    return QUERY_TYPE_LABELS[queryType] || QUERY_TYPE_LABELS.word;
  }

  function resolveResultKind(data) {
    const qt = data?.queryType || host.cachedQueryType();
    if (qt === "paragraph") return "paragraph";
    if (qt === "sentence") return "sentence";
    if (qt === "phrase") return "phrase";
    if (qt === "word") return "word";
    if (qt === "code_term" || isCodeTermShape(data)) return "code_term";
    if (data?.summary && !data?.short_meaning) return "paragraph";
    if (data?.translation && !data?.short_meaning) return "sentence";
    return "word";
  }

  function isCodeTermShape(data) {
    return Boolean(
      data?.chinese_explanation ||
        data?.category ||
        (Array.isArray(data?.breakdown) && data.breakdown.length) ||
        data?.example
    );
  }

  function isCodeTermResult(data) {
    return resolveResultKind(data) === "code_term";
  }

  function isParagraphResult(data) {
    return resolveResultKind(data) === "paragraph";
  }

  function isSentenceResult(data) {
    return resolveResultKind(data) === "sentence";
  }

  function formatWordNote(data) {
    const term = data.term || host.cachedText();
    const lines = [`【${term}】`, ""];
    if (data.phonetic) lines.push(`音标: ${data.phonetic}`);
    if (data.part_of_speech) lines.push(`词性: ${data.part_of_speech}`);
    if (data.short_meaning) lines.push(`基础释义: ${data.short_meaning}`);
    if (data.meaning_here) lines.push(`当前语境: ${data.meaning_here}`);
    if (host.lookupContext()?.sentence) lines.push(`原句: ${host.lookupContext().sentence}`);
    if (data.sentence_translation) lines.push(`原句翻译: ${data.sentence_translation}`);
    if (data.context_meaning) lines.push(`用法: ${data.context_meaning}`);
    lines.push("");
    if (Array.isArray(data.examples)) {
      data.examples.forEach((ex, i) => {
        if (ex.en) lines.push(`例句${i + 1}: ${ex.en}`);
        if (ex.zh) lines.push(`翻译: ${ex.zh}`);
        lines.push("");
      });
    }
    if (Array.isArray(data.derivatives) && data.derivatives.length) {
      lines.push(
        `派生词: ${data.derivatives.map((d) => `${d.word}${d.pos ? ` ${d.pos}` : ""} ${d.zh}`).join("；")}`
      );
    }
    if (Array.isArray(data.synonyms) && data.synonyms.length) {
      lines.push(`同义词: ${data.synonyms.map((syn) => `${syn.word} ${syn.zh}`).join("；")}`);
    }
    if (data.memory_tip) lines.push(`助记: ${data.memory_tip}`);
    if (Array.isArray(data.common_collocations) && data.common_collocations.length > 0) {
      lines.push(`搭配: ${data.common_collocations.join(", ")}`);
    }
    return lines.join("\n").trim();
  }

  function formatSentenceNote(data) {
    const term = data.term || host.cachedText();
    const lines = [`【${term}】`, ""];
    if (data.translation) lines.push(`翻译: ${data.translation}`);
    if (data.nuance) lines.push(`语境: ${data.nuance}`);
    if (data.tone) lines.push(`语气: ${data.tone}`);
    if (data.grammar_notes) lines.push(`语法: ${data.grammar_notes}`);
    if (Array.isArray(data.key_phrases) && data.key_phrases.length > 0) {
      lines.push(`重点: ${data.key_phrases.join("；")}`);
    }
    return lines.join("\n").trim();
  }

  function formatParagraphNote(data) {
    const term = data.term || host.cachedText();
    const lines = [`【${term}】`, ""];
    if (data.summary) lines.push(`概要: ${data.summary}`);
    if (data.translation) lines.push(`翻译: ${data.translation}`);
    if (data.nuance) lines.push(`细微含义: ${data.nuance}`);
    if (data.tone) lines.push(`语气: ${data.tone}`);
    if (data.grammar_notes) lines.push(`语法: ${data.grammar_notes}`);
    if (Array.isArray(data.difficult_phrases) && data.difficult_phrases.length > 0) {
      lines.push("难懂短语:");
      data.difficult_phrases.forEach((item) => {
        if (typeof item === "string") {
          lines.push(`- ${item}`);
          return;
        }
        const phrase = item.phrase || "";
        const meaning = item.meaning || "";
        const note = item.note || "";
        lines.push(`- ${phrase}${meaning ? `: ${meaning}` : ""}${note ? `（${note}）` : ""}`);
      });
    }
    return lines.join("\n").trim();
  }

  function formatCodeTermNote(data) {
    const term = data.term || host.cachedText();
    const lines = [`【${term}】`, ""];
    if (data.category) lines.push(`类别: ${data.category}`);
    if (data.short_meaning) lines.push(`概括: ${data.short_meaning}`);
    if (data.chinese_explanation) lines.push(`解释: ${data.chinese_explanation}`);
    if (Array.isArray(data.breakdown) && data.breakdown.length) {
      lines.push("结构拆解:");
      data.breakdown.forEach((item) => {
        if (!item) return;
        lines.push(`- ${item.part || ""}${item.meaning ? `: ${item.meaning}` : ""}`);
      });
    }
    if (data.example?.en || data.example?.zh) {
      lines.push(`例句: ${data.example.en || ""}`);
      if (data.example.zh) lines.push(`翻译: ${data.example.zh}`);
    }
    if (Array.isArray(data.related_terms) && data.related_terms.length) {
      lines.push(`相关: ${data.related_terms.join(", ")}`);
    }
    return lines.join("\n").trim();
  }

  function formatNoteText(data) {
    if (isCodeTermResult(data)) return formatCodeTermNote(data);
    if (isParagraphResult(data)) return formatParagraphNote(data);
    return isSentenceResult(data) ? formatSentenceNote(data) : formatWordNote(data);
  }

  function renderDuration(durationMs, source, extra) {
    const parts = [];
    const { providerName, modelName } = extra || {};
    if (source === "cache") {
      parts.push("⚡ 缓存");
    } else if (source === "dictionary") {
      parts.push("📖 词典");
    } else {
      const providerLabel = [providerName, modelName].filter(Boolean).join(" · ");
      if (providerLabel) parts.push(providerLabel);
      if (durationMs) parts.push(`${(durationMs / 1000).toFixed(1)}s`);
    }
    if (!parts.length) return "";
    return `<div class="zeh-duration">${parts.map(zehEscapeHtml).join(" · ")}</div>`;
  }

  function renderMetaChips(data) {
    const chips = [];
    if (data.phonetic) {
      chips.push(`<span class="zeh-chip">${zehEscapeHtml(data.phonetic)}</span>`);
    }
    if (data.part_of_speech) {
      chips.push(`<span class="zeh-chip zeh-chip-pos">${zehEscapeHtml(data.part_of_speech)}</span>`);
    }
    if (data.tone) {
      chips.push(`<span class="zeh-chip zeh-chip-pos">${zehEscapeHtml(data.tone)}</span>`);
    }
    if (chips.length === 0) return "";
    return `<div class="zeh-meta">${chips.join("")}</div>`;
  }

  /** 例句区始终渲染一个容器（无例句时 hidden），语境增强可以原地替换为同义项例句 */
  function renderExamples(examples) {
    const inner = renderExamplesInner(examples);
    return `<div class="zeh-section zeh-examples-section"${inner ? "" : " hidden"}>${inner}</div>`;
  }

  function renderExamplesInner(examples) {
    const valid = (Array.isArray(examples) ? examples : []).filter((ex) => {
      const en = String(ex?.en || "").trim();
      const zh = String(ex?.zh || "").trim();
      return en || zh;
    });
    if (valid.length === 0) return "";
    const items = valid
      .map(
        (ex) => `
          <div class="zeh-example">
            ${ex.en ? `<div class="zeh-example-en">${zehEscapeHtml(ex.en)}</div>` : ""}
            ${ex.zh ? `<div class="zeh-example-zh">${zehEscapeHtml(ex.zh)}</div>` : ""}
          </div>
        `
      )
      .join("");
    return `
          <div class="zeh-section-title">例句</div>
          ${items}
      `;
  }

  /**
   * 0.11.1 派生词 / 同义词 / 助记：区块始终有容器（为空时 hidden），语境增强到达后原地填充，
   * 不重建面板。kind：derivatives | synonyms | memory。
   */
  function renderLexicalSection(kind, word) {
    const inner = renderLexicalInner(kind, word);
    return `<div class="zeh-section zeh-lexical-section zeh-${kind}-section"${inner ? "" : " hidden"}>${inner}</div>`;
  }

  function renderLexicalInner(kind, word) {
    const term = word?.term || host.cachedText();
    if (kind === "memory") {
      const tip = String(word?.memory_tip || "").trim();
      return tip
        ? `<div class="zeh-section-title">助记</div><div class="zeh-memory">${zehEscapeHtml(tip)}</div>`
        : "";
    }
    if (kind === "derivatives") {
      const rows = zehSanitizeDerivatives(word?.derivatives, term).map(
        (d) =>
          `<div class="zeh-lex-row"><span class="zeh-lex-word">${zehEscapeHtml(d.word)}</span> · ${
            d.pos ? `<span class="zeh-lex-pos">${zehEscapeHtml(d.pos)}</span> ` : ""
          }${zehEscapeHtml(d.zh)}</div>`
      );
      return rows.length ? `<div class="zeh-section-title">派生词</div>${rows.join("")}` : "";
    }
    const rows = zehSanitizeSynonyms(word?.synonyms, term).map(
      (syn) =>
        `<div class="zeh-lex-row"><span class="zeh-lex-word">${zehEscapeHtml(syn.word)}</span> — ${zehEscapeHtml(syn.zh)}${
          syn.nuance ? `<span class="zeh-lex-nuance">${zehEscapeHtml(syn.nuance)}</span>` : ""
        }</div>`
    );
    return rows.length ? `<div class="zeh-section-title">同义词</div>${rows.join("")}` : "";
  }

  function isEmptyWordResult(data) {
    const word = typeof zehNormalizeWordResult === "function" ? zehNormalizeWordResult(data) : data;
    const hasMeaning =
      Boolean(String(word?.short_meaning || "").trim()) ||
      Boolean(String(word?.context_meaning || "").trim()) ||
      Boolean(String(word?.english_gloss || "").trim());
    const hasExamples = (Array.isArray(word?.examples) ? word.examples : []).some(
      (ex) => String(ex?.en || "").trim() || String(ex?.zh || "").trim()
    );
    return !hasMeaning && !hasExamples;
  }

  function renderKeyPhrases(items) {
    if (!Array.isArray(items) || items.length === 0) return "";
    const tags = items.map((item) => `<span class="zeh-tag">${zehEscapeHtml(item)}</span>`).join("");
    return `
        <div class="zeh-section">
          <div class="zeh-section-title">重点词组</div>
          <div class="zeh-tags">${tags}</div>
        </div>
      `;
  }

  function renderCollocations(items) {
    if (!Array.isArray(items) || items.length === 0) return "";
    const tags = items.map((item) => `<span class="zeh-tag">${zehEscapeHtml(item)}</span>`).join("");
    return `
        <div class="zeh-section">
          <div class="zeh-section-title">常见搭配</div>
          <div class="zeh-tags">${tags}</div>
        </div>
      `;
  }

  function renderDifficultPhrases(items) {
    if (!Array.isArray(items) || items.length === 0) return "";
    const rows = items
      .map((item) => {
        if (item == null) return "";
        if (typeof item === "string") {
          return `<div class="zeh-example"><div class="zeh-example-en">${zehEscapeHtml(item)}</div></div>`;
        }
        const phrase = item.phrase || "";
        const meaning = item.meaning || "";
        const note = item.note || "";
        return `
          <div class="zeh-example">
            <div class="zeh-example-en">${zehEscapeHtml(phrase)}</div>
            ${meaning ? `<div class="zeh-example-zh">${zehEscapeHtml(meaning)}</div>` : ""}
            ${note ? `<div class="zeh-context-text">${zehEscapeHtml(note)}</div>` : ""}
          </div>`;
      })
      .join("");
    return `
        <div class="zeh-section">
          <div class="zeh-section-title">难懂短语</div>
          ${rows}
        </div>
      `;
  }

  function isEmptyCodeTermResult(data) {
    const explain = String(data?.chinese_explanation || data?.short_meaning || "").trim();
    const hasExplain = Boolean(explain) && (zehHasCjk(explain) || explain.length > 2);
    const hasBreakdown =
      Array.isArray(data?.breakdown) &&
      data.breakdown.some((item) => String(item?.part || item?.meaning || "").trim());
    const ex = data?.example;
    const hasExample = Boolean(ex && (String(ex.en || "").trim() || String(ex.zh || "").trim()));
    return !hasExplain && !hasBreakdown && !hasExample;
  }

  function renderCodeTermBreakdown(items) {
    if (!Array.isArray(items) || items.length === 0) return "";
    const rows = items
      .filter((item) => item && (item.part || item.meaning))
      .map(
        (item) => `
          <div class="zeh-example">
            <div class="zeh-example-en">${zehEscapeHtml(item.part || "")}</div>
            ${item.meaning ? `<div class="zeh-example-zh">${zehEscapeHtml(item.meaning)}</div>` : ""}
          </div>`
      )
      .join("");
    if (!rows) return "";
    return `
        <div class="zeh-section">
          <div class="zeh-section-title">结构拆解</div>
          ${rows}
        </div>
      `;
  }

  function renderCodeTermExample(example) {
    if (!example) return "";
    const en = String(example.en || "").trim();
    const zh = String(example.zh || "").trim();
    if (!en && !zh) return "";
    return `
        <div class="zeh-section">
          <div class="zeh-section-title">例句</div>
          <div class="zeh-example">
            ${en ? `<div class="zeh-example-en">${zehEscapeHtml(en)}</div>` : ""}
            ${zh ? `<div class="zeh-example-zh">${zehEscapeHtml(zh)}</div>` : ""}
          </div>
        </div>
      `;
  }

  function renderRelatedTerms(items) {
    if (!Array.isArray(items) || items.length === 0) return "";
    const tags = items.map((item) => `<span class="zeh-tag">${zehEscapeHtml(item)}</span>`).join("");
    return `
        <div class="zeh-section">
          <div class="zeh-section-title">相关术语</div>
          <div class="zeh-tags">${tags}</div>
        </div>
      `;
  }

  function renderCodeTermResult(data, durationMs, source, extra) {
    const term = data.term || host.cachedText();
    const summary = data.short_meaning || "";
    const explain = data.chinese_explanation || "";
    const emptyHint = isEmptyCodeTermResult(data)
      ? `<div class="zeh-section"><div class="zeh-error">没有查到解释，请稍后重试或切换模型。</div></div>`
      : "";
    const chips = [];
    if (data.category) {
      chips.push(`<span class="zeh-chip zeh-chip-pos">${zehEscapeHtml(data.category)}</span>`);
    }
    const meta = chips.length ? `<div class="zeh-meta">${chips.join("")}</div>` : "";
    return `
        <div class="zeh-result">
          <div class="zeh-term-header">
            <div class="zeh-term">${zehEscapeHtml(term)}</div>
            ${meta}
          </div>
          ${
          summary
            ? `<div class="zeh-section zeh-section-highlight">
                  <div class="zeh-section-title">概括</div>
                  <div class="zeh-meaning">${zehEscapeHtml(summary)}</div>
                </div>`
            : ""
        }
          ${
          explain
            ? `<div class="zeh-section zeh-section-highlight">
                  <div class="zeh-section-title">中文解释</div>
                  <div class="zeh-context-text">${zehEscapeHtml(explain)}</div>
                </div>`
            : !summary && !emptyHint
              ? `<div class="zeh-section zeh-section-highlight">
                    <div class="zeh-section-title">中文解释</div>
                    <div class="zeh-context-text">${zehEscapeHtml(term)}</div>
                  </div>`
              : ""
        }
          ${renderCodeTermBreakdown(data.breakdown)}
          ${renderCodeTermExample(data.example)}
          ${renderRelatedTerms(data.related_terms)}
          ${emptyHint}
          ${renderDuration(durationMs, source, extra)}
        </div>
      `;
  }

  function renderManekilexSpecialResult() {
    return `
        <div class="zeh-result mk-manekilex-egg">
          <div class="mk-manekilex-danmaku" aria-hidden="true"></div>
          <div class="mk-manekilex-hero">
            <img class="mk-manekilex-lucky mk-manekilex-lucky-left" src="${extensionAsset("icons/lucky1.png")}" alt="" width="335" height="335" decoding="async" />
            <div class="mk-manekilex-logo">ZAMP</div>
            <img class="mk-manekilex-lucky mk-manekilex-lucky-right" src="${extensionAsset("icons/lucky2.png")}" alt="" width="365" height="365" decoding="async" />
          </div>
        </div>
      `;
  }

  /** 原句里高亮选中词（只高亮离开头最近的一处，忽略大小写） */
  function renderSourceSentence(sentence, term) {
    const text = String(sentence || "");
    const hit = typeof zehFindTermInText === "function" ? zehFindTermInText(text, term, 0, 0) : null;
    if (!hit) return zehEscapeHtml(text);
    return (
      zehEscapeHtml(text.slice(0, hit.start)) +
      `<mark class="zeh-source-term">${zehEscapeHtml(text.slice(hit.start, hit.end))}</mark>` +
      zehEscapeHtml(text.slice(hit.end))
    );
  }

  /**
   * 「当前语境」区块内容。state：
   * - source：有原句、没有语境释义（未配置模型等）→ 只显示原句
   * - pending：基础结果已显示，正在分析此处含义
   * - done：显示此处含义（+ 词性 / 原句翻译）
   * - failed：分析失败或超时，基础释义保持可用
   */
  function renderContextSectionInner(word, state, meta) {
    const ctx = host.lookupContext();
    const term = word.term || host.cachedText();
    const sentenceHtml = ctx?.sentence
      ? `<div class="zeh-source-sentence">${renderSourceSentence(ctx.sentence, term)}</div>`
      : "";
    if (state === "source") {
      return `<div class="zeh-section-title">原句</div>${sentenceHtml}`;
    }
    let body = "";
    if (state === "pending") {
      body = `<div class="zeh-context-pending"><div class="zeh-spinner zeh-spinner-sm"></div><span>正在分析当前语境…</span></div>`;
    } else if (state === "failed") {
      body = `<div class="zeh-context-note">当前语境暂时无法分析，基础释义仍可使用。</div>`;
    } else {
      const pos = word.pos_here
        ? `<span class="zeh-chip zeh-chip-pos zeh-context-pos">${zehEscapeHtml(word.pos_here)}</span>`
        : "";
      body = `<div class="zeh-context-meaning">${pos}${zehEscapeHtml(word.meaning_here || "")}</div>`;
    }
    const translation =
      state === "done" && word.sentence_translation
        ? `<div class="zeh-source-translation">${zehEscapeHtml(word.sentence_translation)}</div>`
        : "";
    const metaLabel = state === "done" ? contextMetaLabel(meta) : "";
    const metaHtml = metaLabel ? `<div class="zeh-context-meta">${zehEscapeHtml(metaLabel)}</div>` : "";
    return `<div class="zeh-section-title">当前语境</div>${body}${sentenceHtml}${translation}${metaHtml}`;
  }

  function contextMetaLabel(meta) {
    if (!meta) return "";
    if (meta.fromCache) return "⚡ 缓存";
    const parts = [];
    const label = [meta.providerName, meta.modelName].filter(Boolean).join(" · ");
    if (label) parts.push(label);
    if (meta.durationMs) parts.push(`${(meta.durationMs / 1000).toFixed(1)}s`);
    return parts.join(" · ");
  }

  function renderContextSection(word, state, meta) {
    if (!state || state === "none") return "";
    return `<div class="zeh-section zeh-context-section" data-context-state="${zehEscapeHtml(state)}">${renderContextSectionInner(word, state, meta)}</div>`;
  }

  function renderWordResult(data, durationMs, source, extra) {
    const word = typeof zehNormalizeWordResult === "function" ? zehNormalizeWordResult(data) : data;
    const term = word.term || host.cachedText();
    const meaningBlock = word.short_meaning
      ? `<div class="zeh-section zeh-section-highlight">
            <div class="zeh-section-title">基础释义</div>
            <div class="zeh-meaning">${zehEscapeHtml(word.short_meaning)}</div>
          </div>`
      : "";
    const emptyHint = isEmptyWordResult(word)
      ? `<div class="zeh-section">
            <div class="zeh-error">模型未返回有效释义。代码/标识符可尝试选中更短片段，或选中整句英文。</div>
          </div>`
      : "";
    return `
        <div class="zeh-result">
          <div class="zeh-term-header">
            <div class="zeh-term">${zehEscapeHtml(term)}</div>
            ${renderMetaChips(word)}
          </div>
          ${meaningBlock}
          ${renderContextSection(word, extra?.contextState || "none", extra?.contextMeta)}
          ${
          word.context_meaning && zehHasCjk(word.context_meaning)
            ? `<div class="zeh-section">
                  <div class="zeh-section-title">用法说明</div>
                  <div class="zeh-context-text">${zehEscapeHtml(word.context_meaning)}</div>
                </div>`
            : ""
        }
          ${
          word.english_gloss
            ? `<div class="zeh-section">
                  <div class="zeh-section-title">英文释义</div>
                  <div class="zeh-context-text">${zehEscapeHtml(word.english_gloss)}</div>
                </div>`
            : ""
        }
          ${renderLexicalSection("derivatives", word)}
          ${renderLexicalSection("synonyms", word)}
          ${renderExamples(word.examples)}
          ${renderLexicalSection("memory", word)}
          ${renderCollocations(word.common_collocations)}
          ${emptyHint}
          ${renderDuration(durationMs, source, extra)}
        </div>
      `;
  }

  function renderSentenceResult(data, durationMs, source, extra) {
    return `
        <div class="zeh-result">
          <div class="zeh-term-header">
            <div class="zeh-term zeh-term-sentence">${zehEscapeHtml(data.term || host.cachedText())}</div>
            ${renderMetaChips(data)}
          </div>
          ${
          data.translation
            ? `<div class="zeh-section zeh-section-highlight">
                  <div class="zeh-section-title">翻译</div>
                  <div class="zeh-meaning">${zehEscapeHtml(data.translation)}</div>
                </div>`
            : ""
        }
          ${
          data.nuance || data.context_meaning
            ? `<div class="zeh-section">
                  <div class="zeh-section-title">语境含义</div>
                  <div class="zeh-context-text">${zehEscapeHtml(data.nuance || data.context_meaning)}</div>
                </div>`
            : ""
        }
          ${
          data.grammar_notes
            ? `<div class="zeh-section">
                  <div class="zeh-section-title">语法 / 结构</div>
                  <div class="zeh-grammar">${zehEscapeHtml(data.grammar_notes)}</div>
                </div>`
            : ""
        }
          ${renderKeyPhrases(data.key_phrases)}
          ${renderDuration(durationMs, source, extra)}
        </div>
      `;
  }

  function renderParagraphResult(data, durationMs, source, extra) {
    const preview =
      data.term && data.term.length < (host.cachedText() || "").length
        ? data.term
        : host.cachedText().length > 220
          ? host.cachedText().slice(0, 220) + "…"
          : host.cachedText();
    return `
        <div class="zeh-result">
          <div class="zeh-term-header">
            <div class="zeh-term zeh-term-sentence">${zehEscapeHtml(preview)}</div>
            ${renderMetaChips(data)}
          </div>
          ${
          data.summary
            ? `<div class="zeh-section">
                  <div class="zeh-section-title">概要</div>
                  <div class="zeh-context-text">${zehEscapeHtml(data.summary)}</div>
                </div>`
            : ""
        }
          ${
          data.translation
            ? `<div class="zeh-section zeh-section-highlight">
                  <div class="zeh-section-title">翻译</div>
                  <div class="zeh-meaning">${zehEscapeHtml(data.translation)}</div>
                </div>`
            : ""
        }
          ${renderDifficultPhrases(data.difficult_phrases)}
          ${
          data.grammar_notes
            ? `<div class="zeh-section">
                  <div class="zeh-section-title">语法要点</div>
                  <div class="zeh-grammar">${zehEscapeHtml(data.grammar_notes)}</div>
                </div>`
            : ""
        }
          ${
          data.nuance
            ? `<div class="zeh-section">
                  <div class="zeh-section-title">细微含义</div>
                  <div class="zeh-context-text">${zehEscapeHtml(data.nuance)}</div>
                </div>`
            : ""
        }
          ${renderDuration(durationMs, source, extra)}
        </div>
      `;
  }

  return {
    queryTypeLabel,
    resolveResultKind,
    isCodeTermResult,
    isParagraphResult,
    isSentenceResult,
    formatNoteText,
    renderDuration,
    renderExamplesInner,
    renderLexicalInner,
    renderCodeTermResult,
    renderManekilexSpecialResult,
    renderContextSectionInner,
    renderWordResult,
    renderSentenceResult,
    renderParagraphResult,
  };
}
