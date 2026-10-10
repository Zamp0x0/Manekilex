/**
 * 设置页核心：分区元数据与导航、各分区共用的页面状态、扩展失效保护、storage 包装、页面主题。
 *
 * 由 settings.html 在 settings/ 各分区文件之前加载（设置页的脚本共享一个全局作用域）。
 * 加载时只声明并读取三个固定节点（mainBody / sectionTitle / sectionDesc），不注册监听、不读存储。
 * 依赖：config.js（zehEscapeHtml、zehDefaultTheme）；switchSection 调用的各分区渲染函数
 *       （renderModels、renderUsage 等）在点击时才用到，届时所有 settings/ 文件都已加载。
 * 使用方：settings/ 下所有分区文件与 settings.js 启动代码。
 */

const SECTION_META = {
  appearance: {
    title: "小球颜色",
    desc: "自定义划词小球颜色，其他界面使用 Manekilex 固定品牌色。",
  },
  models: {
    title: "模型与 API",
    desc: "配置各平台 Key，同一时间仅启用一个模型。",
  },
  usage: {
    title: "流量统计",
    desc: "基于本机记录的请求日志，统计各模型用量。",
  },
  vocabulary: {
    title: "生词本",
    desc: "保存查过的单词/句子，便于复习与导出。",
  },
  review: {
    title: "复习",
    desc: "按间隔重复复习生词本：先回忆，再显示答案并评分，下次复习时间由评分决定。",
  },
  data: {
    title: "数据",
    desc: "查看与清理查词缓存、阅读位置缓存；可单独重置书架阅读进度（不删 EPUB 与书签）。",
  },
  "live-transcribe": {
    title: "实时转译",
    desc: "麦克风英文实时转写（AssemblyAI），并用当前启用的模型翻译为中文。Key 仅保存在本机。",
  },
  reading: {
    title: "阅读",
    desc: "上传 EPUB / TXT / Markdown / HTML / DOCX / PDF，本机转换为 EPUB 后阅读。书籍仅保存在本机。",
  },
};

let currentSection = "usage";

let themeState = zehDefaultTheme();

/** 每次 switchSection 加一：异步渲染 await 回来后先核对，用户已切走就不再写 mainBody */
let sectionRenderToken = 0;

const mainBody = document.getElementById("mainBody");
const sectionTitle = document.getElementById("sectionTitle");
const sectionDesc = document.getElementById("sectionDesc");

const MAIN_BODY_STRETCH_SECTIONS = new Set(["vocabulary", "data", "live-transcribe"]);

function setMainBodyStretch(section) {
  mainBody.classList.toggle("section-stretch", MAIN_BODY_STRETCH_SECTIONS.has(section));
}

let extensionDead = false;
let reloadBannerEl = null;

function isInvalidatedError(message) {
  const msg = message || "";
  return msg.includes("invalidated") || msg.includes("Extension context");
}

function isExtensionAlive() {
  if (extensionDead) {
    return false;
  }
  try {
    return Boolean(chrome.runtime.getManifest());
  } catch {
    extensionDead = true;
    return false;
  }
}

function showSettingsReloadBanner() {
  if (reloadBannerEl) {
    return;
  }
  reloadBannerEl = document.createElement("div");
  reloadBannerEl.className = "settings-reload-banner";
  reloadBannerEl.innerHTML =
    "<span>扩展已更新，请刷新本页后继续使用设置中心。</span>" +
    '<button type="button" class="settings-reload-btn">刷新页面</button>';
  reloadBannerEl.querySelector(".settings-reload-btn").addEventListener("click", () => {
    location.reload();
  });
  document.body.prepend(reloadBannerEl);
}

function markExtensionDead() {
  if (extensionDead) {
    return;
  }
  extensionDead = true;
  showSettingsReloadBanner();
}

function installInvalidationGuard() {
  window.addEventListener(
    "error",
    (event) => {
      if (isInvalidatedError(event.message)) {
        event.preventDefault();
        markExtensionDead();
      }
    },
    true
  );

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    const msg = reason?.message || String(reason || "");
    if (isInvalidatedError(msg)) {
      event.preventDefault();
      markExtensionDead();
    }
  });
}

async function storageGet(keys) {
  if (!isExtensionAlive()) {
    markExtensionDead();
    return {};
  }
  try {
    return await chrome.storage.local.get(keys);
  } catch (error) {
    if (isInvalidatedError(error.message)) {
      markExtensionDead();
    }
    return {};
  }
}

async function storageSet(items) {
  if (!isExtensionAlive()) {
    markExtensionDead();
    throw new Error("扩展已更新，请刷新本页");
  }
  try {
    await chrome.storage.local.set(items);
  } catch (error) {
    if (isInvalidatedError(error.message)) {
      markExtensionDead();
    }
    throw error;
  }
}

/** 设置页一直用的全局名，保留为 config.js zehEscapeHtml 的别名（内容和带引号的属性值都可用） */
function escapeHtml(str) {
  return zehEscapeHtml(str);
}

function applySettingsTheme(theme) {
  const defaults = zehDefaultTheme();
  const t = {
    ballStart: theme?.ballStart || defaults.ballStart,
    ballEnd: theme?.ballEnd || defaults.ballEnd,
  };
  const root = document.documentElement;
  root.style.setProperty("--settings-accent", defaults.accent);
  root.style.setProperty("--settings-accent-start", defaults.headerStart);
  root.style.setProperty("--settings-accent-end", defaults.headerEnd);
  root.style.setProperty("--settings-ball-start", t.ballStart);
  root.style.setProperty("--settings-ball-end", t.ballEnd);

  const brandDot = document.querySelector(".brand-dot");
  if (brandDot) {
    brandDot.style.background = t.ballEnd;
  }
}

function normalizeBallTheme(theme) {
  const defaults = zehDefaultTheme();
  return {
    ballStart: theme?.ballStart || defaults.ballStart,
    ballEnd: theme?.ballEnd || defaults.ballEnd,
  };
}

const MK_LAST_SECTION_KEY = "mkSettingsSection";

function normalizeNavSection(section) {
  if (section === "appearance") return "usage";
  return section;
}

function resolveInitialSection() {
  const hash = normalizeNavSection((location.hash || "").replace("#", ""));
  if (SECTION_META[hash]) return hash;
  try {
    const saved = sessionStorage.getItem(MK_LAST_SECTION_KEY);
    if (saved && SECTION_META[saved]) return saved;
  } catch {
    /* noop */
  }
  return "usage";
}

function switchSection(section) {
  if (!SECTION_META[section]) return;
  if (currentSection === "live-transcribe" && section !== "live-transcribe") {
    window.MKLiveTranscribe?.destroy?.();
  }
  if (currentSection === "models" && section !== "models") {
    syncProvidersFromDom();
    // 离开后保存状态栏已不在页面上：保存失败时单独提示，不能悄悄丢掉
    persistProvidersSafe("已自动保存").then((result) => {
      if (!result.ok) alert(`模型与 API 设置未保存：${result.error}`);
    });
  }

  currentSection = section;
  sectionRenderToken += 1;
  try {
    sessionStorage.setItem(MK_LAST_SECTION_KEY, section);
  } catch {
    /* noop */
  }
  const newHash = `#${section}`;
  if (location.hash !== newHash) {
    history.replaceState(null, "", newHash);
  }
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.section === section);
  });
  const meta = SECTION_META[section];
  sectionTitle.textContent = meta.title;
  sectionDesc.textContent = meta.desc;
  setMainBodyStretch(section);

  if (section === "appearance") {
    renderAppearance();
  } else if (section === "models") {
    renderModels();
  } else if (section === "usage") {
    renderUsage();
  } else if (section === "vocabulary") {
    renderVocabulary();
  } else if (section === "review") {
    renderReview();
  } else if (section === "data") {
    renderData();
  } else if (section === "live-transcribe") {
    renderLiveTranscribe();
  } else if (section === "reading") {
    renderReading();
  }
}

async function storageRemove(keys) {
  if (!isExtensionAlive()) {
    markExtensionDead();
    throw new Error("扩展已更新，请刷新本页");
  }
  try {
    await chrome.storage.local.remove(keys);
  } catch (error) {
    if (isInvalidatedError(error.message)) {
      markExtensionDead();
    }
    throw error;
  }
}
