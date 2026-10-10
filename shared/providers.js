/**
 * 共享模块：provider 元数据与 provider 设置（M5，从 config.js 移来，名字不变）。
 *
 * 加载方：service worker（background.js 的 importScripts）和设置页（settings.html，含实时转写
 * live-transcribe.js）。内容脚本、阅读器、侧边栏和弹出页不加载本文件。
 * 必须在 config.js 之后加载；本文件只声明，不读 storage、不发请求。
 * 依赖：无（只用自己的常量）。
 */

/** AssemblyAI 实时转写默认配置（Key 由用户在设置页填写） */
function zehDefaultAssemblyAIConfig() {
  return {
    apiKey: "",
    speechModel: "u3-rt-pro",
    sampleRate: 16000,
    minTurnSilence: 200,
    maxTurnSilence: 800,
    endOfTurnConfidenceThreshold: 0.35,
    formatTurns: true,
    continuousPartials: true,
    interruptionDelay: 300,
    turnMode: "precise",
    endpointingPreset: "standard",
  };
}

const ZEH_PROVIDER_META = {
  openai: {
    id: "openai",
    name: "OpenAI",
    type: "openai-compatible",
    chartColor: "#111111",
    defaultModel: "gpt-6-luna",
    fastModel: "gpt-6-luna",
    baseUrl: "https://api.openai.com/v1/chat/completions",
    modelHint: "推荐 gpt-6-luna（快速、低成本，查词自动关闭推理）；gpt-4.1-mini 仍可手动填写",
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    type: "openai-compatible",
    chartColor: "#2f6df6",
    defaultModel: "deepseek-flash",
    fastModel: "deepseek-flash",
    baseUrl: "https://api.deepseek.com/v1/chat/completions",
    modelHint: "推荐 deepseek-flash（查词已自动关闭 thinking）；deepseek-v4-flash 只是旧兼容别名",
  },
  moonshot: {
    id: "moonshot",
    name: "Moonshot",
    type: "openai-compatible",
    chartColor: "#8b5cf6",
    defaultModel: "kimi-k2.6",
    fastModel: "kimi-k2.6",
    baseUrl: "https://api.moonshot.cn/v1/chat/completions",
    modelHint: "推荐 kimi-k2.6（查词自动关闭 thinking；温度由平台固定）；kimi-k2-turbo-preview 已下线",
  },
  zhipu: {
    id: "zhipu",
    name: "智谱 GLM",
    type: "openai-compatible",
    chartColor: "#10b981",
    defaultModel: "glm-4-flash",
    fastModel: "glm-4-flash",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    modelHint: "推荐 glm-4-flash；也可用 glm-4.7-flash（免费，查词自动关闭 thinking）",
  },
  siliconflow: {
    id: "siliconflow",
    name: "SiliconFlow",
    type: "openai-compatible",
    chartColor: "#e45b35",
    defaultModel: "deepseek-ai/DeepSeek-V4-Flash",
    fastModel: "deepseek-ai/DeepSeek-V4-Flash",
    baseUrl: "https://api.siliconflow.cn/v1/chat/completions",
    modelHint: "推荐 deepseek-ai/DeepSeek-V4-Flash（查词自动关闭 thinking）；也可从硅基流动模型广场复制完整模型 ID",
  },
  groq: {
    id: "groq",
    name: "Groq",
    type: "openai-compatible",
    chartColor: "#f97316",
    defaultModel: "openai/gpt-oss-20b",
    fastModel: "openai/gpt-oss-20b",
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    modelHint: "推荐 openai/gpt-oss-20b（llama-3.1-8b-instant 已停用）；也可用 qwen/qwen3-32b",
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    type: "gemini",
    chartColor: "#4285f4",
    defaultModel: "gemini-3.5-flash-lite",
    fastModel: "gemini-3.5-flash-lite",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/models",
    modelHint: "推荐 gemini-3.5-flash-lite；已在用的 gemini-2.5-flash-lite 会保留（2.5 系列仅对老用户开放）",
  },
};

const ZEH_PROVIDER_IDS = [
  "openai",
  "deepseek",
  "moonshot",
  "zhipu",
  "siliconflow",
  "groq",
  "gemini",
];

/**
 * 旧默认模型名 → 新推荐（仅精确匹配时迁移，不覆盖用户自定义）。
 * 0.11.1：只迁移「Manekilex 以前的默认值」或官方已下线 / 只剩兼容别名的 ID；
 * 其他用户手填的模型名一律保留。
 */
const ZEH_PROVIDER_MODEL_MIGRATIONS = {
  openai: {
    "gpt-4.1-mini": "gpt-6-luna",
  },
  deepseek: {
    "deepseek-chat": "deepseek-flash",
    "deepseek-reasoner": "deepseek-flash",
    "deepseek-v4-flash": "deepseek-flash",
  },
  moonshot: {
    "kimi-k2-turbo-preview": "kimi-k2.6",
  },
  groq: {
    "llama-3.1-8b-instant": "openai/gpt-oss-20b",
  },
  siliconflow: {
    "deepseek-ai/DeepSeek-V3": "deepseek-ai/DeepSeek-V4-Flash",
    "Pro/deepseek-ai/DeepSeek-V3": "deepseek-ai/DeepSeek-V4-Flash",
    "deepseek-ai/DeepSeek-R1": "deepseek-ai/DeepSeek-V4-Flash",
    "Qwen/Qwen2.5-7B-Instruct": "deepseek-ai/DeepSeek-V4-Flash",
  },
};

/**
 * 各平台 / 模型的请求字段差异（0.11.1）。只做最小适配，Chat Completions 路径不变：
 * - OpenAI GPT-5 及以后 / o 系列：用 max_completion_tokens；gpt-6 系列显式 reasoning_effort:"none"
 *   （此时 temperature 仍可用），其余推理模型去掉 temperature。
 * - DeepSeek：关闭 thinking。
 * - Moonshot kimi-k2.5+ / k3：温度由平台固定（传其他值会报错）→ 不发 temperature，
 *   用 max_completion_tokens；kimi-k2.x 关闭 thinking（k3 总是推理，不传）。
 * - 智谱 glm-4.5 ~ 4.9：关闭 thinking。SiliconFlow DeepSeek-V4：enable_thinking=false。
 * - Groq qwen3：reasoning_effort:"none"；gpt-oss：reasoning_effort:"low"（最低档）。
 * 返回同一个 body（原地修改）。
 */
function zehApplyProviderRequestOptions(body, providerId, modelName) {
  if (!body || typeof body !== "object") return body;
  const model = String(modelName || body.model || "").trim().toLowerCase();
  const useCompletionTokens = () => {
    if (body.max_tokens != null) {
      body.max_completion_tokens = body.max_tokens;
      delete body.max_tokens;
    }
  };
  switch (providerId) {
    case "openai":
      if (/^(gpt-[5-9]|o\d)/.test(model)) {
        useCompletionTokens();
        if (/^gpt-6/.test(model)) body.reasoning_effort = "none";
        else delete body.temperature;
      }
      break;
    case "deepseek":
      body.thinking = { type: "disabled" };
      break;
    case "moonshot":
      if (/^kimi-k(2\.[5-9]|[3-9])/.test(model)) {
        delete body.temperature;
        useCompletionTokens();
        if (/^kimi-k2\./.test(model)) body.thinking = { type: "disabled" };
      }
      break;
    case "zhipu":
      if (/^glm-4\.[5-9]/.test(model)) body.thinking = { type: "disabled" };
      break;
    case "siliconflow":
      if (/deepseek-v4/.test(model)) body.enable_thinking = false;
      break;
    case "groq":
      if (/^qwen\/qwen3/.test(model)) body.reasoning_effort = "none";
      else if (/^openai\/gpt-oss/.test(model)) body.reasoning_effort = "low";
      break;
    default:
      break;
  }
  return body;
}

/**
 * 把设置页的本地修改合并到「最新存储状态」上（Phase 5，R-12 persistProviders）。
 * 只覆盖本页相对 base（上次读到 / 写入的快照）真正改过的字段；其余字段取 stored（可能被
 * 另一个设置页或 service worker 改过）。返回新对象，不改入参。
 */
const ZEH_PROVIDER_EDIT_FIELDS = ["apiKey", "model", "enabled"];

function zehMergeProviderEdits(stored, base, local, ids) {
  const providerIds = Array.isArray(ids) && ids.length ? ids : Object.keys(local || {});
  const merged = {};
  for (const id of providerIds) {
    const storedEntry = (stored && stored[id]) || {};
    const baseEntry = (base && base[id]) || {};
    const localEntry = (local && local[id]) || {};
    const next = { ...storedEntry };
    for (const field of ZEH_PROVIDER_EDIT_FIELDS) {
      const changedLocally = (localEntry[field] ?? "") !== (baseEntry[field] ?? "");
      if (changedLocally) next[field] = localEntry[field];
      else if (!(field in next) && field in localEntry) next[field] = localEntry[field];
    }
    merged[id] = next;
  }
  return merged;
}

function zehDefaultProviders() {
  const providers = {};
  ZEH_PROVIDER_IDS.forEach((id) => {
    const meta = ZEH_PROVIDER_META[id];
    providers[id] = {
      apiKey: "",
      model: meta.defaultModel,
      enabled: id === "openai",
    };
  });
  return providers;
}

/** 补全 storage 中缺失的新 provider 条目 */
function zehEnsureAllProviders(providers) {
  const out = { ...(providers || {}) };
  ZEH_PROVIDER_IDS.forEach((id) => {
    const meta = ZEH_PROVIDER_META[id];
    if (!out[id]) {
      out[id] = { apiKey: "", model: meta.defaultModel, enabled: false };
    }
  });
  return out;
}

/** 空 model 填默认；旧默认 model 名温和迁移 */
function zehMigrateProviderModels(providers) {
  const out = zehEnsureAllProviders(providers);
  ZEH_PROVIDER_IDS.forEach((id) => {
    const meta = ZEH_PROVIDER_META[id];
    const cfg = out[id] || {};
    let model = String(cfg.model || "").trim();
    if (!model) {
      cfg.model = meta.defaultModel;
    } else {
      const migrations = ZEH_PROVIDER_MODEL_MIGRATIONS[id];
      if (migrations && migrations[model]) {
        cfg.model = migrations[model];
      }
    }
    out[id] = cfg;
  });
  return out;
}
