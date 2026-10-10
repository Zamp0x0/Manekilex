/**
 * Service worker 模块：实时转写用到的请求（字幕翻译、AssemblyAI 临时 token、转写翻译用的 provider 选择）。
 *
 * 由 background.js 的 importScripts 列表加载。本文件只声明，加载时不调用任何 chrome API、不发请求。
 * 依赖：sw/settings.js（getAppSettings、转写 provider 的选择）、sw/provider-client.js（zehStripJsonFence、
 *       错误规范化与脱敏）、config.js（ZEH_STORAGE）。网络请求都有超时（ZEH_NETWORK_TIMEOUT_MS）。
 * 标签页音频捕获（tabCapture）不在本文件。
 */

function extractTranslateTranscriptJsonObject(rawText) {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) return null;

  const fencedFull = zehStripJsonFence(trimmed);
  if (fencedFull) {
    try {
      return JSON.parse(fencedFull);
    } catch {
      /* continue */
    }
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    /* continue */
  }

  const blockMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (blockMatch) {
    try {
      return JSON.parse(blockMatch[1].trim());
    } catch {
      /* continue */
    }
  }

  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch) {
    try {
      return JSON.parse(objMatch[0]);
    } catch {
      /* continue */
    }
  }

  return null;
}

const ZEH_TRANSLATE_PARTIAL_INSTRUCTION = `Translate this live English partial transcript into natural Chinese.
It may be incomplete; translate the understandable part naturally.
Do not explain.
Return Chinese only.`;

const ZEH_TRANSLATE_TRANSCRIPT_JSON_INSTRUCTION = `You are translating live English speech transcript into natural Chinese.

The transcript may contain minor speech recognition errors.
Lightly correct obvious ASR mistakes only when the intended meaning is clear.
Do not invent new meaning.
Use previous context only to understand the current transcript.
Do not explain.

You must return valid JSON only.

Return valid JSON only:
{
  "cleaned_en": "corrected English transcript here",
  "zh": "natural Chinese translation here"
}

Rules:
- "zh" must be non-empty natural Chinese.
- If the transcript is incomplete, still translate the understandable part.
- Do not return empty strings.
- Do not return explanations.
- Do not copy the schema with empty values.
- Never return {"cleaned_en":"","zh":""}.
- Do not wrap the JSON in markdown.`;

function buildTranslateTranscriptUserMessage(currentText, previousContext) {
  const ctx = Array.isArray(previousContext)
    ? previousContext.filter(Boolean).join("\n")
    : String(previousContext || "").trim();
  const parts = [];
  if (ctx) {
    parts.push("Previous context:", ctx, "");
  }
  parts.push("Current transcript:", String(currentText || "").trim());
  return parts.join("\n");
}

function containsChinese(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ""));
}

function looksLikeJson(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (/^```(?:json)?\s*[\s\S]*```$/i.test(t)) return true;
  if (t.startsWith("{") && /"(?:cleaned_en|cleanedEn|zh|translation|cn)"/.test(t)) {
    return true;
  }
  if (/^\{[\s\S]*\}$/.test(t) && !containsChinese(t)) return true;
  return false;
}

function stripCodeFence(text) {
  const t = String(text || "").trim();
  const block = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (block) return block[1].trim();
  return zehStripJsonFence(t);
}

function tryParseTranslationJson(text) {
  const stripped = stripCodeFence(text);
  if (!stripped) return null;
  try {
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
    /* continue */
  }
  return extractTranslateTranscriptJsonObject(stripped);
}

function isUsableTranslationZh(zh) {
  const t = String(zh || "").trim();
  if (!t) return false;
  if (looksLikeJson(t)) return false;
  return containsChinese(t);
}

function sanitizeTranslationPayload(rawModelText, currentText) {
  const current = String(currentText || "").trim();
  const raw = String(rawModelText || "").trim();

  if (!raw) {
    return { ok: false, error: "empty model response", message: "模型返回为空" };
  }

  zehDebugLog("[LiveTranscribe:bg] model raw preview", raw.slice(0, 200));

  const parsed = tryParseTranslationJson(raw);
  if (parsed) {
    const cleanedEn = String(parsed.cleaned_en || parsed.cleanedEn || current).trim() || current;
    const zh = String(parsed.zh || parsed.translation || parsed.cn || "").trim();
    if (isUsableTranslationZh(zh)) {
      return { ok: true, cleaned_en: cleanedEn, translation: zh };
    }
    return {
      ok: false,
      error: "model returned empty zh",
      message: "模型未返回有效中文",
      cleaned_en: cleanedEn || current,
    };
  }

  const stripped = stripCodeFence(raw);
  if (containsChinese(stripped) && !looksLikeJson(stripped)) {
    return { ok: true, cleaned_en: current, translation: stripped };
  }

  if (looksLikeJson(raw) || looksLikeJson(stripped)) {
    return { ok: false, error: "JSON parse failed", message: "JSON 解析失败" };
  }

  return {
    ok: false,
    error: "model did not return Chinese translation",
    message: "模型未返回中文翻译",
  };
}

// ── 转译翻译 / AssemblyAI token 的网络超时：连接卡住时不能让实时转译一直等下去 ──
const ZEH_NETWORK_TIMEOUT_CODE = "NETWORK_TIMEOUT";
const ZEH_NETWORK_TIMEOUT_MS = {
  translatePartial: 15000,
  translateFinal: 30000,
  assemblyaiToken: 15000,
};

function networkTimeoutMs(kind) {
  return ZEH_NETWORK_TIMEOUT_MS[kind] || 30000;
}

function networkTimeoutError(timeoutMs, label) {
  const seconds = Math.round(timeoutMs / 1000);
  const err = new Error(`${label ? `${label} ` : ""}请求超时（>${seconds}s），请检查网络后重试。`);
  err.code = ZEH_NETWORK_TIMEOUT_CODE;
  return err;
}

/** fetch 并读出 JSON，整个过程受超时约束；超时抛出 code = NETWORK_TIMEOUT 的错误 */
async function fetchJsonWithTimeout(url, init, kind, label) {
  const timeoutMs = networkTimeoutMs(kind);
  const timeout = zehCreateTimeoutSignal(timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: timeout.signal });
    const data = await response.json().catch(() => ({}));
    if (timeout.timedOut()) throw networkTimeoutError(timeoutMs, label);
    return { response, data };
  } catch (err) {
    if (timeout.timedOut()) throw networkTimeoutError(timeoutMs, label);
    throw err;
  } finally {
    timeout.cleanup();
  }
}

/** 翻译函数的失败结果：超时带上 code，页面可以区分超时和其它错误 */
function translateFailure(err, prefix) {
  const readable = sanitizeProviderErrorMessage(err?.message || "翻译请求失败");
  const out = { ok: false, error: readable, message: `${prefix}: ${readable}` };
  if (err?.code === ZEH_NETWORK_TIMEOUT_CODE) out.code = err.code;
  return out;
}

async function callOpenAICompatibleTranslatePlain(
  provider,
  systemPrompt,
  userText,
  currentText,
  maxTokens = 256
) {
  const { id, meta, apiKey, model } = provider;
  const modelName = model || meta.defaultModel;
  const sourceText = String(currentText || "").trim();

  if (!apiKey) {
    return {
      ok: false,
      error: "no_provider",
      message: "provider not configured",
    };
  }

  const body = {
    model: modelName,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
    temperature: 0.2,
    max_tokens: maxTokens,
  };
  zehApplyProviderRequestOptions(body, id, modelName);

  try {
    const { response, data } = await fetchJsonWithTimeout(
      meta.baseUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      "translatePartial"
    );
    if (!response.ok) {
      const err = zehNormalizeProviderError(provider, response.status, data);
      const readable = sanitizeProviderErrorMessage(err.message);
      const prefix = id === "groq" ? "Groq" : meta?.name || id;
      return {
        ok: false,
        error: readable,
        message: `${prefix}: ${readable}`,
      };
    }
    const rawText = data?.choices?.[0]?.message?.content?.trim() || "";
    if (!rawText) {
      return { ok: false, error: "empty model response", message: "模型返回为空" };
    }
    if (containsChinese(rawText) && !looksLikeJson(rawText)) {
      return { ok: true, cleaned_en: sourceText, translation: rawText.trim() };
    }
    return {
      ok: false,
      error: "model did not return Chinese translation",
      message: "模型未返回中文翻译",
    };
  } catch (err) {
    return translateFailure(err, id === "groq" ? "Groq" : meta?.name || id);
  }
}

async function callGeminiTranslatePlain(provider, systemPrompt, userText, currentText, maxTokens = 256) {
  const { meta, apiKey, model } = provider;
  const modelName = model || meta.defaultModel;
  const sourceText = String(currentText || "").trim();

  if (!apiKey) {
    return {
      ok: false,
      error: "no_provider",
      message: "provider not configured",
    };
  }

  const url = `${meta.baseUrl}/${modelName}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    systemInstruction: { parts: [{ text: systemPrompt }] },
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: maxTokens,
    },
  };

  try {
    const { response, data } = await fetchJsonWithTimeout(
      url,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      "translatePartial"
    );
    if (!response.ok) {
      const readable = sanitizeProviderErrorMessage(
        data?.error?.message || `Gemini HTTP ${response.status}`
      );
      return { ok: false, error: readable, message: `Gemini: ${readable}` };
    }
    const rawText = data?.candidates?.[0]?.content?.parts
      ?.map((p) => p.text || "")
      .join("")
      .trim();
    if (!rawText) {
      return { ok: false, error: "empty model response", message: "模型返回为空" };
    }
    if (containsChinese(rawText) && !looksLikeJson(rawText)) {
      return { ok: true, cleaned_en: sourceText, translation: rawText.trim() };
    }
    return {
      ok: false,
      error: "model did not return Chinese translation",
      message: "模型未返回中文翻译",
    };
  } catch (err) {
    return translateFailure(err, "Gemini");
  }
}

async function callOpenAICompatibleTranslateJson(provider, systemPrompt, userText, currentText) {
  const { id, meta, apiKey, model } = provider;
  const modelName = model || meta.defaultModel;
  const sourceText = String(currentText || "").trim();

  if (!apiKey) {
    return {
      ok: false,
      error: "no_provider",
      message: "provider not configured",
    };
  }

  const body = {
    model: modelName,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userText },
    ],
    temperature: 0.2,
    max_tokens: 1024,
    response_format: { type: "json_object" },
  };
  zehApplyProviderRequestOptions(body, id, modelName);

  try {
    const { response, data } = await fetchJsonWithTimeout(
      meta.baseUrl,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      "translateFinal"
    );
    if (!response.ok) {
      const err = zehNormalizeProviderError(provider, response.status, data);
      const readable = sanitizeProviderErrorMessage(err.message);
      const prefix = id === "groq" ? "Groq" : meta?.name || id;
      return {
        ok: false,
        error: readable,
        message: `${prefix}: ${readable}`,
      };
    }
    const rawText = data?.choices?.[0]?.message?.content?.trim() || "";
    if (!rawText) {
      return { ok: false, error: "empty model response", message: "模型返回为空" };
    }
    return sanitizeTranslationPayload(rawText, sourceText);
  } catch (err) {
    return translateFailure(err, id === "groq" ? "Groq" : meta?.name || id);
  }
}

async function callGeminiTranslateJson(provider, systemPrompt, userText, currentText) {
  const { id, meta, apiKey, model } = provider;
  const modelName = model || meta.defaultModel;
  const sourceText = String(currentText || "").trim();

  if (!apiKey) {
    return {
      ok: false,
      error: "no_provider",
      message: "provider not configured",
    };
  }

  const endpoint =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  async function doFetch(includeJsonMime) {
    const generationConfig = { temperature: 0.2, maxOutputTokens: 1024 };
    if (includeJsonMime) generationConfig.responseMimeType = "application/json";
    return fetchJsonWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userText }] }],
          generationConfig,
        }),
      },
      "translateFinal"
    );
  }

  try {
    let { response, data } = await doFetch(true);
    if (!response.ok && response.status === 400) {
      ({ response, data } = await doFetch(false));
    }
    if (!response.ok) {
      const err = zehNormalizeProviderError(provider, response.status, data);
      const readable = sanitizeProviderErrorMessage(err.message);
      return {
        ok: false,
        error: readable,
        message: `Gemini: ${readable}`,
      };
    }
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const rawText = parts
      .map((p) => p.text || "")
      .join("")
      .trim();
    if (!rawText) {
      return { ok: false, error: "empty model response", message: "模型返回为空" };
    }
    return sanitizeTranslationPayload(rawText, sourceText);
  } catch (err) {
    return translateFailure(err, "Gemini");
  }
}

async function translateTranscriptPartial(currentText, previousContext) {
  const text = String(currentText || "").trim();
  if (!text) {
    return { ok: false, error: "empty transcript", message: "没有可翻译的文本" };
  }

  const appSettings = await getAppSettings();
  const provider = getLiveTranscribeProviderConfig(appSettings);
  const model = provider.model || provider.meta?.defaultModel || "";

  zehDebugLog("[LiveTranscribe:bg] TRANSLATE_TRANSCRIPT partial", {
    length: text.length,
    provider: provider.id,
    model,
  });

  if (!provider.apiKey) {
    return {
      ok: false,
      error: "no_provider",
      message: "provider not configured",
    };
  }

  const userMessage = buildTranslateTranscriptUserMessage(text, previousContext);

  const result =
    provider.type === "gemini" || provider.id === "gemini"
      ? await callGeminiTranslatePlain(
          provider,
          ZEH_TRANSLATE_PARTIAL_INSTRUCTION,
          userMessage,
          text,
          256
        )
      : await callOpenAICompatibleTranslatePlain(
          provider,
          ZEH_TRANSLATE_PARTIAL_INSTRUCTION,
          userMessage,
          text,
          256
        );

  if (result.ok) {
    const translation = String(result.translation || "").trim();
    if (!isUsableTranslationZh(translation)) {
      return {
        ok: false,
        error: "model returned empty zh",
        message: "模型未返回有效中文",
      };
    }
    return { ok: true, translation, text: translation };
  }

  return {
    ok: false,
    error: result.error || "translation failed",
    message: result.message || result.error || "翻译失败",
    ...(result.code ? { code: result.code } : {}),
  };
}

async function translateTranscriptWithContext(currentText, previousContext, mode) {
  const text = String(currentText || "").trim();
  if (!text) {
    return { ok: false, error: "empty transcript", message: "没有可翻译的文本" };
  }

  if (mode === "partial") {
    return translateTranscriptPartial(text, previousContext);
  }

  const appSettings = await getAppSettings();
  const provider = getLiveTranscribeProviderConfig(appSettings);
  const model = provider.model || provider.meta?.defaultModel || "";

  zehDebugLog("[LiveTranscribe:bg] TRANSLATE_TRANSCRIPT", {
    hasCurrentText: Boolean(text),
    length: text.length,
    provider: provider.id,
    model,
    mode: mode || "final",
  });

  if (!provider.apiKey) {
    return {
      ok: false,
      error: "no_provider",
      message: "provider not configured",
    };
  }

  const userMessage = buildTranslateTranscriptUserMessage(text, previousContext);

  const result =
    provider.type === "gemini" || provider.id === "gemini"
      ? await callGeminiTranslateJson(
          provider,
          ZEH_TRANSLATE_TRANSCRIPT_JSON_INSTRUCTION,
          userMessage,
          text
        )
      : await callOpenAICompatibleTranslateJson(
          provider,
          ZEH_TRANSLATE_TRANSCRIPT_JSON_INSTRUCTION,
          userMessage,
          text
        );

  if (result.ok) {
    const translation = String(result.translation || "").trim();
    const cleanedEn = String(result.cleaned_en || text).trim();
    if (!isUsableTranslationZh(translation)) {
      return {
        ok: false,
        error: "model returned empty zh",
        message: "模型未返回有效中文",
        cleaned_en: cleanedEn,
      };
    }
    return {
      ok: true,
      cleaned_en: cleanedEn,
      translation,
      text: translation,
    };
  }

  return {
    ok: false,
    error: result.error || "translation failed",
    message: result.message || result.error || "翻译失败",
    cleaned_en: result.cleaned_en,
    ...(result.code ? { code: result.code } : {}),
  };
}

async function getLiveTranscribeProviderOptions() {
  const appSettings = await getAppSettings();
  const options = listConfiguredProviders(appSettings);
  const selectedId = resolveLiveTranscribeProviderId(appSettings);
  const selected = options.find((p) => p.id === selectedId);
  return {
    ok: true,
    options,
    selectedId: selectedId || "",
    selectedName: selected?.name || "",
    selectedModel: selected?.model || "",
    empty: options.length === 0,
  };
}

async function setLiveTranscribeProvider(providerId) {
  const id = String(providerId || "").trim();
  const appSettings = await getAppSettings();
  const configured = listConfiguredProviders(appSettings);
  if (!configured.length) {
    return { ok: false, message: "还没有配置任何模型" };
  }
  if (!id || !configured.some((p) => p.id === id)) {
    return { ok: false, message: "所选模型未配置 API Key" };
  }
  await chrome.storage.local.set({ [ZEH_STORAGE.liveTranscribeProvider]: id });
  const picked = configured.find((p) => p.id === id);
  return {
    ok: true,
    providerId: id,
    providerName: picked?.name || id,
    model: picked?.model || "",
  };
}

async function getAssemblyAIConfig() {
  const data = await chrome.storage.local.get([ZEH_STORAGE.assemblyAI]);
  const cfg = data[ZEH_STORAGE.assemblyAI];
  if (cfg && typeof cfg === "object") return cfg;
  return zehDefaultAssemblyAIConfig();
}

async function getAssemblyAITemporaryToken() {
  const cfg = await getAssemblyAIConfig();
  const apiKey = String(cfg.apiKey || "").trim();
  if (!apiKey) {
    throw new Error("请先在实时转译页面保存 AssemblyAI API Key");
  }

  const url =
    "https://streaming.assemblyai.com/v3/token?expires_in_seconds=60&max_session_duration_seconds=1800";
  const { response, data } = await fetchJsonWithTimeout(
    url,
    { method: "GET", headers: { Authorization: apiKey } },
    "assemblyaiToken",
    "AssemblyAI"
  );
  if (!response.ok) {
    const msg =
      data?.error ||
      data?.message ||
      (typeof data === "string" ? data : "") ||
      `HTTP ${response.status}`;
    throw new Error(String(msg).slice(0, 220));
  }
  const token = data?.token || data?.access_token;
  if (!token) {
    throw new Error("AssemblyAI 未返回 temporary token");
  }
  return token;
}
