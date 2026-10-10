/**
 * Service worker 模块：查词用的 provider 客户端（OpenAI 兼容接口与 Gemini）。
 *
 * 由 background.js 的 importScripts 列表加载。本文件只声明，加载时不调用任何 chrome API、不发请求。
 * 内容：请求体构建、带超时的原始请求（callOpenAICompatibleRaw / callGeminiRaw）、模型 JSON 解析、
 * 错误规范化与脱敏、查词结果收尾（finalizeProviderCallResult）。benchmark 也用这里的原始请求。
 * 依赖：config.js（provider 元数据与请求参数、超时、提示词）、provider-benchmark.js（categorizeBenchmarkError）、
 *       sw/storage-queue.js（appendUsageLog）。
 * 转写翻译的请求在 sw/transcribe.js，协议细节没有在这一批合并（行为不变）。
 */

function normalizeProviderParsed(parsed, queryType) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("模型返回的 JSON 不是对象");
  }
  parsed.queryType = queryType;
  if (queryType === "sentence" || queryType === "paragraph" || queryType === "code_term") {
    return parsed;
  }
  return zehNormalizeWordResult({
    ...parsed,
    queryType: queryType === "phrase" ? "phrase" : "word",
  });
}

function zehLookupTruncatedHint(queryType, providerName) {
  const limit = ZEH_LOOKUP_LIMITS[queryType] || ZEH_LOOKUP_LIMITS.sentence;
  const kind =
    queryType === "paragraph"
      ? "段落"
      : queryType === "sentence"
        ? "句子"
        : queryType === "code_term"
          ? "技术术语"
          : queryType === "phrase"
            ? "短语"
            : "单词";
  return `模型输出被截断，选区可能过长。${kind}解释最多 ${limit} 字，请缩短后重试。若是 ${providerName}，也可尝试换模型。`;
}

function zehStripJsonFence(rawText) {
  const t = String(rawText || "").trim();
  const m = t.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  return m ? m[1].trim() : t;
}

function sanitizeProviderErrorMessage(msg) {
  return String(msg || "")
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/sk-[a-zA-Z0-9_-]{10,}/gi, "sk-[redacted]")
    .replace(/key=[^&\s]+/gi, "key=[redacted]")
    .slice(0, 220);
}

function zehNormalizeProviderError(provider, status, data) {
  const rawMsg =
    data?.error?.message ||
    data?.message ||
    (typeof data?.error === "string" ? data.error : "") ||
    "";

  let msg = "";

  if (status === 401 || status === 403) {
    msg = "API Key 无效、余额不足、项目无权限，或该服务未启用。";
  } else if (status === 429) {
    msg = "请求太频繁或免费额度已达到限制，请稍后再试或切换模型。";
  } else if (status === 404) {
    msg = "模型不存在、模型名写错，或当前账号无权限使用该模型。";
  } else if (status === 400) {
    msg = "请求格式错误，请检查模型名、Provider 配置或 JSON 输出格式支持。";
  } else {
    msg = `模型服务请求失败：HTTP ${status}`;
  }

  const modelName = provider?.model || provider?.meta?.defaultModel || "";

  if (provider?.id === "deepseek" && /deepseek-chat|deepseek-reasoner|deepseek-v4-flash/i.test(modelName)) {
    msg += " 当前模型名属于旧兼容名，建议改用 deepseek-flash。";
  }

  if (provider?.id === "siliconflow" && status === 404) {
    msg += " SiliconFlow 模型 ID 需要完整路径，例如 deepseek-ai/DeepSeek-V4-Flash。";
  }

  if (provider?.id === "gemini" && (status === 401 || status === 403)) {
    msg += " 请检查 Google AI Studio API key 是否属于当前项目，或该地区/项目是否可用。";
  }

  if (rawMsg) {
    msg += ` 原始信息：${String(rawMsg).slice(0, 220)}`;
  }

  return new Error(msg);
}

function parseModelJson(rawText) {
  const cleaned = zehStripJsonFence(rawText);
  if (!cleaned) {
    throw new Error("模型返回为空");
  }
  try {
    return JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw new Error("无法解析模型返回的 JSON");
  }
}

/**
 * @param {object} [request] 可选：{ systemPrompt, userText, maxTokens, kind }（Phase 3 语境请求）。
 *   不传时与以前一样：按 queryType 选系统提示词，用户消息就是选中文本。
 */
async function callProvider(provider, selectedText, queryType, request) {
  if (provider.type === "gemini" || provider.id === "gemini") {
    return callGeminiProvider(provider, selectedText, queryType, request);
  }
  return callOpenAICompatibleProvider(provider, selectedText, queryType, request);
}

function finalizeProviderCallResult(provider, selectedText, queryType, rawText, finishReason, durationMs) {
  const { id, meta, model } = provider;
  const modelName = model || meta.defaultModel;
  const providerName = meta.name;
  const truncated = finishReason === "length" || finishReason === "MAX_TOKENS";
  const softLimit = Math.floor((ZEH_LOOKUP_LIMITS[queryType] || ZEH_LOOKUP_LIMITS.sentence) * 0.75);

  if (rawText) {
    try {
      const parsed = parseModelJson(rawText);
      const data = normalizeProviderParsed(parsed, queryType);
      return { ok: true, data, rawText, provider: id, providerName, modelName, durationMs };
    } catch {
      /* 解析失败时再看是否因截断 */
    }
  }

  if (truncated) {
    return {
      ok: false,
      fallback: true,
      term: selectedText.length > 120 ? selectedText.slice(0, 120) + "…" : selectedText,
      rawText:
        selectedText.length > softLimit
          ? zehLookupTruncatedHint(queryType, providerName)
          : `模型输出被截断（${providerName}）。若是推理模型，请确认查词已关闭 thinking（DeepSeek 推荐 deepseek-flash），或换一个模型再试。`,
      provider: id,
      providerName,
      modelName,
      queryType,
      durationMs,
    };
  }

  try {
    const parsed = parseModelJson(rawText);
    const data = normalizeProviderParsed(parsed, queryType);
    return { ok: true, data, rawText, provider: id, providerName, modelName, durationMs };
  } catch (parseError) {
    const tooLong = selectedText.length > softLimit;
    return {
      ok: false,
      fallback: true,
      term: selectedText.length > 120 ? selectedText.slice(0, 120) + "…" : selectedText,
      rawText: tooLong
        ? zehLookupTruncatedHint(queryType, providerName)
        : rawText || String(parseError.message),
      provider: id,
      providerName,
      modelName,
      queryType,
      durationMs,
    };
  }
}

function buildOpenAIChatBodyFromMessages(provider, systemPrompt, userText, queryType, maxTokens) {
  const { id, meta, model } = provider;
  const modelName = model || meta.defaultModel;
  const body = {
    model: modelName,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
    temperature: 0.1,
    max_tokens: maxTokens || zehMaxTokens(queryType, userText.length),
    response_format: { type: "json_object" },
  };
  zehApplyProviderRequestOptions(body, id, modelName);
  return body;
}

async function callOpenAICompatibleRaw(provider, systemPrompt, userText, options = {}) {
  const { id, meta, apiKey, model } = provider;
  const queryType = options.queryType || "word";
  const signal = options.signal;

  if (!apiKey) {
    const err = new Error(`请先在设置 → 模型与 API 中配置 ${meta.name} 的 API Key`);
    const cat = ZEHProviderBenchmark.categorizeBenchmarkError(0, err.message);
    return { ok: false, ...cat, totalMs: 0 };
  }

  const t0 = Date.now();
  let ttfbMs = null;
  try {
    const response = await fetch(meta.baseUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(
        buildOpenAIChatBodyFromMessages(provider, systemPrompt, userText, queryType, options.maxTokens)
      ),
      signal,
    });
    ttfbMs = Date.now() - t0;
    const data = await response.json().catch(() => ({}));
    const totalMs = Date.now() - t0;
    const bodyMs = Math.max(0, totalMs - (ttfbMs || 0));

    if (!response.ok) {
      const err = zehNormalizeProviderError(provider, response.status, data);
      const cat = ZEHProviderBenchmark.categorizeBenchmarkError(response.status, err.message);
      return { ok: false, status: response.status, ...cat, totalMs, ttfbMs, bodyMs };
    }

    const usage = data.usage || {};
    const choice = data?.choices?.[0];
    const rawText = choice?.message?.content?.trim() || "";
    if (!rawText) {
      const cat = ZEHProviderBenchmark.categorizeBenchmarkError(
        0,
        "Provider returned empty content"
      );
      return { ok: false, status: response.status, ...cat, totalMs, ttfbMs, bodyMs };
    }
    return {
      ok: true,
      status: response.status,
      rawText,
      finishReason: choice?.finish_reason || null,
      totalMs,
      ttfbMs,
      bodyMs,
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
      totalTokens: usage.total_tokens || 0,
    };
  } catch (err) {
    const totalMs = Date.now() - t0;
    if (err && err.name === "AbortError") {
      return {
        ok: false,
        aborted: true,
        totalMs,
        errorCategory: "cancelled",
        errorMessageShort: "已取消",
      };
    }
    const cat = ZEHProviderBenchmark.categorizeBenchmarkError(0, err.message);
    return { ok: false, status: 0, ...cat, totalMs, ttfbMs };
  }
}

async function callGeminiRaw(provider, systemPrompt, userText, options = {}) {
  const { meta, apiKey, model } = provider;
  const modelName = model || meta.defaultModel;
  const queryType = options.queryType || "word";
  const maxTokens = options.maxTokens ?? zehMaxTokens(queryType, userText.length);
  const signal = options.signal;
  const t0 = Date.now();

  if (!apiKey) {
    const cat = ZEHProviderBenchmark.categorizeBenchmarkError(0, "缺少 API Key");
    return { ok: false, ...cat, totalMs: 0 };
  }

  async function doFetch(includeJsonMime) {
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const generationConfig = { temperature: 0.1, maxOutputTokens: maxTokens };
    if (includeJsonMime) generationConfig.responseMimeType = "application/json";

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userText }] }],
        generationConfig,
      }),
      signal,
    });
    const data = await response.json().catch(() => ({}));
    return { response, data };
  }

  try {
    let { response, data } = await doFetch(true);
    if (!response.ok && response.status === 400) {
      ({ response, data } = await doFetch(false));
    }
    const ttfbMs = Date.now() - t0;
    const totalMs = Date.now() - t0;
    const bodyMs = Math.max(0, totalMs - ttfbMs);

    if (!response.ok) {
      const err = zehNormalizeProviderError(provider, response.status, data);
      const cat = ZEHProviderBenchmark.categorizeBenchmarkError(response.status, err.message);
      return { ok: false, status: response.status, ...cat, totalMs, ttfbMs, bodyMs };
    }

    const rawText =
      data?.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || "")
        .join("")
        .trim() || "";

    if (!rawText) {
      const cat = ZEHProviderBenchmark.categorizeBenchmarkError(0, "Gemini 返回为空");
      return { ok: false, ...cat, totalMs, ttfbMs, bodyMs };
    }

    const um = data.usageMetadata || {};
    return {
      ok: true,
      status: response.status,
      rawText,
      finishReason: data?.candidates?.[0]?.finishReason || null,
      totalMs,
      ttfbMs,
      bodyMs,
      promptTokens: um.promptTokenCount || 0,
      completionTokens: um.candidatesTokenCount || 0,
      totalTokens: um.totalTokenCount || 0,
    };
  } catch (err) {
    const totalMs = Date.now() - t0;
    if (err && err.name === "AbortError") {
      return {
        ok: false,
        aborted: true,
        totalMs,
        errorCategory: "cancelled",
        errorMessageShort: "已取消",
      };
    }
    const cat = ZEHProviderBenchmark.categorizeBenchmarkError(0, err.message);
    return { ok: false, status: 0, ...cat, totalMs };
  }
}

async function callOpenAICompatibleProvider(provider, selectedText, queryType, request) {
  const { id, meta, apiKey, model } = provider;

  if (!apiKey) {
    throw new Error(`请先在设置 → 模型与 API 中配置 ${meta.name} 的 API Key`);
  }

  const timeoutMs = zehLookupProviderTimeoutMs(queryType);
  const timeout = zehCreateTimeoutSignal(timeoutMs);
  let raw;
  try {
    raw = await callOpenAICompatibleRaw(
      provider,
      request?.systemPrompt || zehBuildSystemPrompt(queryType),
      request?.userText || selectedText,
      {
        queryType,
        signal: timeout.signal,
        maxTokens: request?.maxTokens,
      }
    );
  } finally {
    timeout.cleanup();
  }

  if (!raw.ok) {
    if (timeout.timedOut()) throw zehLookupTimeoutError(timeoutMs, meta.name);
    throw new Error(raw.errorMessageShort || `${meta.name} 请求失败`);
  }

  await appendUsageLog({
    ts: Date.now(),
    provider: id,
    model: model || meta.defaultModel,
    queryType,
    kind: request?.kind || "lookup",
    promptTokens: raw.promptTokens || 0,
    completionTokens: raw.completionTokens || 0,
    totalTokens: raw.totalTokens || 0,
    durationMs: raw.totalMs,
    success: true,
  });

  return finalizeProviderCallResult(
    provider,
    selectedText,
    queryType,
    raw.rawText,
    raw.finishReason,
    raw.totalMs
  );
}

async function callGeminiProvider(provider, selectedText, queryType, request) {
  const { id, meta, apiKey, model } = provider;
  const modelName = model || meta.defaultModel;

  if (!apiKey) {
    throw new Error(`请先在设置 → 模型与 API 中配置 ${meta.name} 的 API Key`);
  }

  const timeoutMs = zehLookupProviderTimeoutMs(queryType);
  const timeout = zehCreateTimeoutSignal(timeoutMs);
  let raw;
  try {
    raw = await callGeminiRaw(
      provider,
      request?.systemPrompt || zehBuildSystemPrompt(queryType),
      request?.userText || selectedText,
      {
        queryType,
        signal: timeout.signal,
        maxTokens: request?.maxTokens,
      }
    );
  } finally {
    timeout.cleanup();
  }

  if (!raw.ok) {
    if (timeout.timedOut()) throw zehLookupTimeoutError(timeoutMs, meta?.name || "Gemini");
    throw new Error(raw.errorMessageShort || "Gemini 请求失败");
  }

  await appendUsageLog({
    ts: Date.now(),
    provider: id,
    model: modelName,
    queryType,
    kind: request?.kind || "lookup",
    promptTokens: raw.promptTokens || 0,
    completionTokens: raw.completionTokens || 0,
    totalTokens: raw.totalTokens || 0,
    durationMs: raw.totalMs,
    success: true,
  });

  return finalizeProviderCallResult(
    provider,
    selectedText,
    queryType,
    raw.rawText,
    raw.finishReason,
    raw.totalMs
  );
}
