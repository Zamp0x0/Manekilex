const pdfHint = document.getElementById("pdfHint");
const captureTabStatus = document.getElementById("captureTabStatus");
const manekilexEnabledToggle = document.getElementById("manekilexEnabledToggle");
const manekilexDisabledHint = document.getElementById("manekilexDisabledHint");

const ENABLED_KEY = ZEH_STORAGE.enabled;

function setCaptureStatus(text, type) {
  if (!captureTabStatus) return;
  captureTabStatus.textContent = text || "";
  captureTabStatus.className = "capture-status" + (type ? ` ${type}` : "");
}

function updateManekilexToggleUI(enabled) {
  const on = enabled !== false;
  if (manekilexEnabledToggle) manekilexEnabledToggle.checked = on;
  if (manekilexDisabledHint) manekilexDisabledHint.hidden = on;
}

document.getElementById("openSettings").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "OPEN_SETTINGS", section: "usage" });
  window.close();
});

manekilexEnabledToggle?.addEventListener("change", () => {
  const enabled = manekilexEnabledToggle.checked;
  chrome.storage.local.set({ [ENABLED_KEY]: enabled }, () => {
    updateManekilexToggleUI(enabled);
  });
});

chrome.storage.local.get({ [ENABLED_KEY]: ZEH_MANEKILEX_ENABLED_DEFAULT }, (result) => {
  updateManekilexToggleUI(result[ENABLED_KEY]);
});

document.getElementById("captureTabAudio").addEventListener("click", async () => {
  setCaptureStatus("正在授权捕获…", "");
  const btn = document.getElementById("captureTabAudio");
  btn.disabled = true;

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || "";

    if (!tab?.id || !/^https?:/i.test(url)) {
      setCaptureStatus("请在普通网页标签页中启动捕获", "warn");
      btn.disabled = false;
      return;
    }

    const resp = await chrome.runtime.sendMessage({
      type: "START_TAB_AUDIO_CAPTURE_FROM_ACTIVE_TAB",
      targetTabId: tab.id,
      targetTabTitle: tab.title || "",
      targetTabUrl: url,
    });

    if (!resp?.ok) {
      setCaptureStatus(resp?.message || "捕获启动失败", "err");
      btn.disabled = false;
      return;
    }

    window.close();
  } catch (err) {
    setCaptureStatus(String(err?.message || err || "捕获启动失败"), "err");
    btn.disabled = false;
  }
});

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  const url = tabs[0]?.url || "";
  const isPdf =
    url.startsWith("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/") ||
    /\.pdf($|[?#])/i.test(url);
  if (isPdf && pdfHint) pdfHint.hidden = false;
});
