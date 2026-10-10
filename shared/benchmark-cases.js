/**
 * 共享模块：provider benchmark 的候选模型、模式计划和测试用例（M5，从 config.js 移来，名字不变）。
 *
 * 加载方：service worker（background.js 的 importScripts，benchmark 任务）和设置页
 * （settings.html，测速面板与 provider-benchmark.js）。内容脚本、阅读器、侧边栏和弹出页不加载。
 * 必须在 config.js 之后、provider-benchmark.js 之前加载；本文件只声明。
 * 依赖：无。
 */

/** Provider Benchmark — quick / standard 候选（少量模型） */
const ZEH_BENCHMARK_MODELS_QUICK = {
  openai: ["gpt-6-luna", "gpt-4.1-mini"],
  deepseek: ["deepseek-flash", "deepseek-v4-pro"],
  groq: [
    "openai/gpt-oss-20b",
    "llama-3.3-70b-versatile",
    "qwen/qwen3-32b",
    "qwen/qwen3-27b",
    "openai/gpt-oss-120b",
  ],
  gemini: ["gemini-3.5-flash-lite", "gemini-2.5-flash-lite"],
  zhipu: ["glm-4-flash", "glm-4.7-flash"],
  siliconflow: [
    "deepseek-ai/DeepSeek-V4-Flash",
    "Qwen/Qwen3.5-4B",
    "Qwen/Qwen3.5-9B",
    "zai-org/GLM-4.7-Flash",
  ],
  moonshot: ["kimi-k2.6", "moonshot-v1-8k"],
};

/** Provider Benchmark — full 模式扩展列表 */
const ZEH_BENCHMARK_MODELS_FULL = {
  openai: ["gpt-6-luna", "gpt-4.1-mini", "gpt-4o-mini"],
  deepseek: ["deepseek-flash", "deepseek-v4-pro", "deepseek-chat"],
  groq: [
    "llama-3.3-70b-versatile",
    "qwen/qwen3-32b",
    "qwen/qwen3-27b",
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
  ],
  gemini: ["gemini-3.5-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash"],
  zhipu: ["glm-4-flash", "glm-4.5-flash", "glm-4.7-flash", "glm-4-plus"],
  moonshot: ["kimi-k2.6", "moonshot-v1-8k"],
  siliconflow: [
    "deepseek-ai/DeepSeek-V4-Flash",
    "Pro/deepseek-ai/DeepSeek-V4-Flash",
    "deepseek-ai/DeepSeek-V3.2",
    "deepseek-ai/DeepSeek-V3.2-Exp",
    "zai-org/GLM-4.7-Flash",
    "Pro/zai-org/GLM-4.7",
    "Qwen/Qwen3.5-4B",
    "Qwen/Qwen3.5-9B",
    "Qwen/Qwen3.5-122B-A10B",
    "MiniMaxAI/MiniMax-M2.5",
    "moonshotai/Kimi-K2.7-Code",
  ],
};

/** @deprecated 兼容旧引用，等同 FULL 列表 */
const ZEH_BENCHMARK_MODELS = ZEH_BENCHMARK_MODELS_FULL;

const ZEH_BENCHMARK_MODE_PLAN = {
  quick: {
    modelSet: "quick",
    caseIds: ["word_simple", "phrase_abbrev", "phrase_idiom"],
    repetitions: 1,
    timeoutMs: 10000,
    label: "快速测速",
  },
  standard: {
    modelSet: "quick",
    caseIds: null,
    repetitions: 1,
    timeoutMs: 15000,
    label: "标准测速",
  },
  full: {
    modelSet: "full",
    caseIds: null,
    repetitions: 2,
    timeoutMs: 20000,
    label: "完整测速",
  },
  "current-provider": {
    modelSet: "quick",
    caseIds: ["word_simple", "phrase_abbrev", "phrase_idiom"],
    repetitions: 1,
    timeoutMs: 15000,
    label: "只测当前 Provider",
  },
};

function zehBenchmarkCaseIdsForMode(mode) {
  const plan = ZEH_BENCHMARK_MODE_PLAN[mode] || ZEH_BENCHMARK_MODE_PLAN.quick;
  if (plan.caseIds) return plan.caseIds;
  return ZEH_BENCHMARK_CASES.map((c) => c.id);
}

function zehBenchmarkModelsForMode(providerId, mode) {
  const plan = ZEH_BENCHMARK_MODE_PLAN[mode] || ZEH_BENCHMARK_MODE_PLAN.quick;
  const map = plan.modelSet === "full" ? ZEH_BENCHMARK_MODELS_FULL : ZEH_BENCHMARK_MODELS_QUICK;
  return map[providerId] || [];
}

const ZEH_BENCHMARK_CASES = [
  {
    id: "word_simple",
    queryType: "word",
    text: "grave",
    expectedKeywords: ["严重", "坟墓", "庄重"],
    note: "一词多义基础词",
  },
  {
    id: "phrase_abbrev",
    queryType: "sentence",
    text: "Japan WCup Soccer Reaction",
    expectedKeywords: ["日本", "世界杯", "足球", "反应"],
    note: "缩写 + 专有短语，测试是否把 WCup 理解成 World Cup",
  },
  {
    id: "phrase_idiom",
    queryType: "sentence",
    text: "He finally let the cat out of the bag.",
    expectedKeywords: ["泄露", "秘密"],
    note: "习语测试",
  },
  {
    id: "novel_sentence",
    queryType: "sentence",
    text: "He was not the sort of man to be easily moved by fear, yet the silence of the room unsettled him.",
    expectedKeywords: ["害怕", "沉默", "不安"],
    note: "小说句子语境解释",
  },
  {
    id: "proper_noun_fantasy",
    queryType: "sentence",
    text: "Frodo left the Shire and began his journey toward Mordor.",
    expectedKeywords: ["Frodo", "Shire", "Mordor", "专有"],
    note: "奇幻专有名词，不应乱翻译",
  },
];
