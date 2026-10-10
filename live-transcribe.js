/**
 * live-transcribe.js — 设置页「实时转译」：AssemblyAI Streaming + active provider 翻译
 */
(function () {
  const LOG = "[LiveTranscribe]";
  const STORAGE_KEY = typeof ZEH_STORAGE !== "undefined" ? ZEH_STORAGE.assemblyAI : "zehAssemblyAI";
  const SOURCE_STORAGE_KEY =
    typeof ZEH_STORAGE !== "undefined" ? ZEH_STORAGE.liveTranscribeSource : "zehLiveTranscribeSource";
  const PENDING_CAPTURE_KEY =
    typeof ZEH_STORAGE !== "undefined"
      ? ZEH_STORAGE.pendingTabAudioCapture
      : "zehPendingTabAudioCapture";
  const SOURCE_MIC = "microphone";
  const SOURCE_TAB = "tab";
  const PENDING_CAPTURE_TTL_MS = 45000;
  const TAB_CAPTURE_DENIED_MSG =
    "Chrome 拒绝捕获该标签页。请先切到目标标签页，再点击扩展图标启动捕获。";

  const SAMPLE_RATE = 16000;
  const PCM_CHUNK_SAMPLES = 1600; // 100ms → 3200 bytes
  const PCM_MIN_SAMPLES = 800; // 50ms
  const PCM_MAX_SAMPLES = 16000; // 1000ms
  const AGGREGATE_TIMEOUT_MS = 1500;
  const MIN_WORDS_FOR_TRANSLATE = 8;
  const MIC_LOW_THRESHOLD = 0.012;
  const MIC_LOW_WARN_MS = 5000;

  const TURN_MODE_PRECISE = "precise";
  const TURN_MODE_CAPTION = "caption";
  const LIVE_CAPTION_ENDPOINT_CONFIG = {
    maxLiveTurnMs: 8000,
    maxLiveTurnWords: 45,
    maxLiveTurnChars: 300,
    minForceIntervalMs: 3000,
    minTurnAgeBeforePunctuationForceMs: 1500,
  };
  const PARTIAL_TRANSLATE_MIN_INTERVAL_MS = 1200;
  const PARTIAL_TRANSLATE_MAX_INTERVAL_MS = 2000;
  const MIN_PARTIAL_WORDS_TO_TRANSLATE = 6;
  const MIN_NEW_WORDS_FOR_PARTIAL_TRANSLATE = 6;
  const HISTORY_VISIBLE_MAX = 20;

  const ENDPOINTING_PRESETS = {
    fast: {
      minTurnSilence: 100,
      maxTurnSilence: 600,
      endOfTurnConfidenceThreshold: 0.3,
    },
    standard: {
      minTurnSilence: 200,
      maxTurnSilence: 800,
      endOfTurnConfidenceThreshold: 0.35,
    },
    stable: {
      minTurnSilence: 400,
      maxTurnSilence: 1280,
      endOfTurnConfidenceThreshold: 0.4,
    },
  };

  const INVALID_ZH_MSG = "（翻译失败：模型未返回有效中文）";

  const FILLER_WORDS = new Set([
    "uh",
    "um",
    "er",
    "yeah",
    "or",
    "and",
    "so",
    "okay",
    "like",
    "well",
  ]);

  let mountedRoot = null;
  let pcmPending = new Int16Array(0);
  let dsPhase = 0;
  let inputSampleRate = 48000;
  let dsStep = 3;
  let firstAudioFrameLogged = false;
  let aggregateTimer = null;
  let micLowSince = 0;
  let micLowWarned = false;
  let pendingCaptureListener = null;
  let pendingCaptureStarting = false;
  let scrollTrackingBound = false;
  let partialTranslateTimer = null;

  /**
   * 每次开始录音建立一个会话，会话记录自己打开的 socket / 音频流 / AudioContext。
   * 停止、新的开始、提前返回都只释放这个会话自己的资源；旧会话的回调和 await 之后的步骤看到
   * 会话已结束就不再改动全局状态。
   */
  const SESSION_CANCELLED = "LIVE_TRANSCRIBE_SESSION_CANCELLED";
  let sessionSeq = 0;
  let activeSession = null;

  function beginSession() {
    endSession();
    activeSession = { id: ++sessionSeq, cancelled: false, ws: null, stream: null, audioContext: null };
    return activeSession;
  }

  function endSession() {
    const s = activeSession;
    activeSession = null;
    if (s) s.cancelled = true;
    return s;
  }

  function isCurrentSession(s) {
    return Boolean(s) && !s.cancelled && activeSession === s;
  }

  function sessionCancelledError() {
    const err = new Error("录音已停止");
    err.code = SESSION_CANCELLED;
    return err;
  }

  function ensureCurrentSession(s) {
    if (!isCurrentSession(s)) throw sessionCancelledError();
  }

  /** 关闭一个已结束会话打开的东西；全局 runtime 只在仍指向这些对象时才清空 */
  function releaseSession(s) {
    if (!s) return;
    const ws = s.ws;
    s.ws = null;
    if (ws) {
      if (runtime.ws === ws) runtime.ws = null;
      try {
        ws.close();
      } catch {
        /* noop */
      }
    }
    const stream = s.stream;
    s.stream = null;
    if (stream) {
      if (runtime.mediaStream === stream) runtime.mediaStream = null;
      stopTabPlaybackFor(stream);
      streamSafeStop(stream);
    }
    const ctx = s.audioContext;
    s.audioContext = null;
    if (ctx) {
      if (runtime.audioContext === ctx) runtime.audioContext = null;
      ctx.close().catch(() => {});
    }
  }

  const scrollState = {
    englishAutoScroll: true,
    chineseAutoScroll: true,
  };

  const appState = {
    assemblyConfig: null,
    isRecording: false,
    isPaused: false,
    wsConnected: false,
    micReady: false,
    translateInFlight: false,
    partialTranscript: "",
    pendingEnglishBuffer: "",
    englishHistory: [],
    chineseHistory: [],
    bilingualHistory: [],
    previousContext: [],
    micLevel: 0,
    lastFinalTimestamp: 0,
    lastSentTranscriptHash: "",
    sourceMode: SOURCE_MIC,
    capturedTabTitle: "",
    providerInfo: { name: "", model: "", hasKey: false, providerId: "" },
    currentTurnText: "",
    currentChineseText: "",
    lastPartialTranslateAt: 0,
    lastTranslatedPartialText: "",
    lastForceEndpointAt: 0,
    turnStartedAt: 0,
    partialTranslateSeq: 0,
  };

  const runtime = {
    mediaStream: null,
    audioContext: null,
    workletNode: null,
    sourceNode: null,
    playbackContext: null,
    playbackSource: null,
    playbackStream: null,
    ws: null,
    translateQueue: Promise.resolve(),
  };

  function $(sel) {
    return mountedRoot ? mountedRoot.querySelector(sel) : null;
  }

  function log(...args) {
    zehDebugLog(LOG, ...args);
  }

  function hashText(text) {
    const s = String(text || "")
      .trim()
      .toLowerCase();
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return String(h);
  }

  function countWords(text) {
    const t = String(text || "").trim();
    if (!t) return 0;
    return t.split(/\s+/).filter(Boolean).length;
  }

  function endsWithSentencePunct(text) {
    return /[.?!]\s*$/.test(String(text || "").trim());
  }

  function isFillerOnlyBuffer(text) {
    const words = String(text || "")
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (!words.length || words.length > 2) return false;
    return words.every((w) => FILLER_WORDS.has(w.replace(/[.,!?]+$/, "")));
  }

  function setStatus(text, type) {
    const el = $("#ltStatus");
    if (!el) return;
    el.textContent = text || "";
    el.className = "status-msg lt-status " + (type || "");
  }

  function setConnStatus(text, type) {
    const el = $("#ltConnStatus");
    if (!el) return;
    el.textContent = text || "未连接";
    el.className = "lt-meta-value " + (type || "");
  }

  function setInputStatus(text, type) {
    const el = $("#ltInputStatus");
    if (!el) return;
    el.textContent = text || "未开启";
    el.className = "lt-meta-value " + (type || "");
  }

  function getSourceMode() {
    const checked = mountedRoot?.querySelector('input[name="ltSourceMode"]:checked');
    return checked?.value === SOURCE_TAB ? SOURCE_TAB : SOURCE_MIC;
  }

  function setSourceModeDisabled(disabled) {
    mountedRoot?.querySelectorAll('input[name="ltSourceMode"]').forEach((el) => {
      el.disabled = Boolean(disabled);
    });
    mountedRoot
      ?.querySelectorAll('input[name="ltTurnMode"], input[name="ltEndpointingPreset"]')
      .forEach((el) => {
        el.disabled = Boolean(disabled);
      });
    setTranslateProviderDisabled(disabled);
  }

  function mergeAssemblyConfig(raw) {
    const defaults =
      typeof zehDefaultAssemblyAIConfig === "function"
        ? zehDefaultAssemblyAIConfig()
        : {
            apiKey: "",
            speechModel: "u3-rt-pro",
            sampleRate: SAMPLE_RATE,
            turnMode: TURN_MODE_PRECISE,
            endpointingPreset: "standard",
          };
    return { ...defaults, ...(raw || {}) };
  }

  function getTurnMode() {
    return appState.assemblyConfig?.turnMode === TURN_MODE_CAPTION
      ? TURN_MODE_CAPTION
      : TURN_MODE_PRECISE;
  }

  function resolveEndpointingConfig(cfg) {
    const merged = mergeAssemblyConfig(cfg);
    const presetKey = merged.endpointingPreset || "standard";
    const preset = ENDPOINTING_PRESETS[presetKey] || ENDPOINTING_PRESETS.standard;
    const speechModel = merged.speechModel || "u3-rt-pro";
    const isCaption = merged.turnMode === TURN_MODE_CAPTION;
    const modelLower = String(speechModel).toLowerCase();
    const isU3 = modelLower === "u3-rt-pro" || modelLower.includes("u3-rt-pro");

    if (isCaption && isU3) {
      return {
        speechModel: "u3-rt-pro",
        sampleRate: merged.sampleRate || SAMPLE_RATE,
        minTurnSilence: 96,
        maxTurnSilence: 416,
        endOfTurnConfidenceThreshold: 0.3,
        formatTurns: false,
        continuousPartials: true,
        interruptionDelay: 0,
        vadThreshold: 0.3,
        mode: "min_latency",
        languageCode: "en",
        turnMode: merged.turnMode || TURN_MODE_CAPTION,
        endpointingPreset: presetKey,
      };
    }

    if (isCaption) {
      return {
        speechModel,
        sampleRate: merged.sampleRate || SAMPLE_RATE,
        minTurnSilence: 160,
        maxTurnSilence: 400,
        endOfTurnConfidenceThreshold: 0.3,
        formatTurns: true,
        continuousPartials: true,
        interruptionDelay: 0,
        vadThreshold: 0.3,
        turnMode: merged.turnMode || TURN_MODE_CAPTION,
        endpointingPreset: presetKey,
      };
    }

    return {
      speechModel,
      sampleRate: merged.sampleRate || SAMPLE_RATE,
      minTurnSilence: merged.minTurnSilence ?? preset.minTurnSilence,
      maxTurnSilence: merged.maxTurnSilence ?? preset.maxTurnSilence,
      endOfTurnConfidenceThreshold:
        merged.endOfTurnConfidenceThreshold ?? preset.endOfTurnConfidenceThreshold,
      formatTurns: merged.formatTurns !== false,
      continuousPartials: merged.continuousPartials !== false,
      interruptionDelay: merged.interruptionDelay ?? 300,
      vadThreshold: merged.vadThreshold ?? 0.4,
      turnMode: merged.turnMode || TURN_MODE_PRECISE,
      endpointingPreset: presetKey,
    };
  }

  function countWordsAddedSince(prevText, newText) {
    const prev = String(prevText || "")
      .trim()
      .toLowerCase();
    const next = String(newText || "")
      .trim()
      .toLowerCase();
    if (!next) return 0;
    if (!prev) return countWords(newText);
    const prevWords = prev.split(/\s+/).filter(Boolean);
    const newWords = next.split(/\s+/).filter(Boolean);
    if (next.startsWith(prev)) {
      return Math.max(0, newWords.length - prevWords.length);
    }
    return newWords.length;
  }

  function syncTurnSettingsUI(cfg) {
    const merged = mergeAssemblyConfig(cfg);
    const turnMode = merged.turnMode || TURN_MODE_PRECISE;
    const preset = merged.endpointingPreset || "standard";
    mountedRoot?.querySelectorAll('input[name="ltTurnMode"]').forEach((el) => {
      el.checked = el.value === turnMode;
    });
    mountedRoot?.querySelectorAll('input[name="ltEndpointingPreset"]').forEach((el) => {
      el.checked = el.value === preset;
    });
  }

  async function saveTurnSettings() {
    if (appState.isRecording) return;
    const turnMode =
      mountedRoot?.querySelector('input[name="ltTurnMode"]:checked')?.value || TURN_MODE_PRECISE;
    const endpointingPreset =
      mountedRoot?.querySelector('input[name="ltEndpointingPreset"]:checked')?.value || "standard";
    const preset = ENDPOINTING_PRESETS[endpointingPreset] || ENDPOINTING_PRESETS.standard;
    const prev = mergeAssemblyConfig(appState.assemblyConfig || (await loadAssemblyAIConfig()));
    const cfg = {
      ...prev,
      turnMode,
      endpointingPreset,
      minTurnSilence: preset.minTurnSilence,
      maxTurnSilence: preset.maxTurnSilence,
      endOfTurnConfidenceThreshold: preset.endOfTurnConfidenceThreshold,
    };
    await chrome.storage.local.set({ [STORAGE_KEY]: cfg });
    appState.assemblyConfig = cfg;
    log("turn settings saved", { turnMode, endpointingPreset });
  }

  function truncateText(text, max) {
    const s = String(text || "").trim();
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + "…";
  }

  async function takePendingTabCapture() {
    const data = await chrome.storage.session.get([PENDING_CAPTURE_KEY]);
    const pending = data[PENDING_CAPTURE_KEY];
    await chrome.storage.session.remove([PENDING_CAPTURE_KEY]);
    if (!pending?.streamId) return null;
    if (Date.now() - (pending.createdAt || 0) > PENDING_CAPTURE_TTL_MS) {
      log("pending tab capture expired");
      return null;
    }
    return pending;
  }

  async function openTabStreamFromStreamId(streamId) {
    const attempts = [
      {
        audio: {
          mandatory: {
            chromeMediaSource: "tab",
            chromeMediaSourceId: streamId,
          },
        },
        video: false,
      },
      {
        audio: {
          chromeMediaSource: "tab",
          chromeMediaSourceId: streamId,
        },
        video: false,
      },
    ];

    let lastErr = null;
    for (const constraints of attempts) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (!stream?.getAudioTracks?.().length) {
          stream?.getTracks?.().forEach((t) => t.stop());
          throw new Error("标签页音频流为空");
        }
        return stream;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("无法打开标签页音频流");
  }

  function startTabPlayback(stream) {
    stopTabPlayback();
    runtime.playbackContext = new AudioContext();
    runtime.playbackStream = stream;
    runtime.playbackSource = runtime.playbackContext.createMediaStreamSource(stream);
    runtime.playbackSource.connect(runtime.playbackContext.destination);
    log("tab playback context started");
  }

  function stopTabPlayback() {
    if (runtime.playbackSource) {
      try {
        runtime.playbackSource.disconnect();
      } catch {
        /* noop */
      }
      runtime.playbackSource = null;
    }
    const ctx = runtime.playbackContext;
    runtime.playbackContext = null;
    runtime.playbackStream = null;
    if (ctx) {
      ctx.close().catch(() => {});
    }
  }

  /** 只在回放的正是这个流时停止回放（不碰另一个会话的回放） */
  function stopTabPlaybackFor(stream) {
    if (stream && runtime.playbackStream === stream) stopTabPlayback();
  }

  /** 开始前就返回时，释放 tryStartFromPendingTabCapture 已经打开的标签页流和回放 */
  function releasePreacquiredTabStream(opts) {
    const stream = opts && opts.preacquiredTabStream;
    if (!stream || runtime.mediaStream === stream) return;
    stopTabPlaybackFor(stream);
    streamSafeStop(stream);
  }

  async function applyTabSourceUi(pending) {
    const radio = mountedRoot?.querySelector(`input[name="ltSourceMode"][value="${SOURCE_TAB}"]`);
    if (radio) radio.checked = true;
    appState.sourceMode = SOURCE_TAB;
    await chrome.storage.local.set({ [SOURCE_STORAGE_KEY]: SOURCE_TAB });
    if (pending?.targetTabTitle) {
      const hint = $("#ltTabCaptureHint");
      if (hint) {
        hint.textContent = `已授权捕获：${truncateText(pending.targetTabTitle, 48)}`;
        hint.className = "lt-tab-hint ok";
      }
    }
  }

  async function tryStartFromPendingTabCapture() {
    if (pendingCaptureStarting || appState.isRecording) return false;

    const pending = await takePendingTabCapture();
    if (!pending?.streamId) return false;

    pendingCaptureStarting = true;
    log("consume pending tab capture", { tabId: pending.targetTabId });

    let stream = null;
    try {
      await applyTabSourceUi(pending);
      setStatus("正在打开标签页音频流…", "");

      stream = await openTabStreamFromStreamId(pending.streamId);
      appState.capturedTabTitle = pending.targetTabTitle || "";
      startTabPlayback(stream);

      await startRecording({
        preacquiredTabStream: stream,
        preacquiredTabTitle: pending.targetTabTitle || "",
      });
      return true;
    } catch (err) {
      const msg = String(err?.message || err || "");
      log("pending tab capture failed", msg);
      stopTabPlayback();
      streamSafeStop(stream);
      runtime.mediaStream = null;
      if (/Permission|NotAllowed|denied/i.test(msg)) {
        setStatus(TAB_CAPTURE_DENIED_MSG, "err");
      } else {
        setStatus(`标签页捕获失败：${msg.slice(0, 140)}`, "err");
      }
      setInputStatus("捕获失败", "err");
      return false;
    } finally {
      pendingCaptureStarting = false;
    }
  }

  function streamSafeStop(stream) {
    stream?.getTracks?.().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* noop */
      }
    });
  }

  function setupPendingCaptureListener() {
    if (pendingCaptureListener) return;
    pendingCaptureListener = (message) => {
      if (message?.type !== "TAB_AUDIO_CAPTURE_PENDING") return;
      tryStartFromPendingTabCapture();
    };
    chrome.runtime.onMessage.addListener(pendingCaptureListener);
  }

  function teardownPendingCaptureListener() {
    if (!pendingCaptureListener) return;
    chrome.runtime.onMessage.removeListener(pendingCaptureListener);
    pendingCaptureListener = null;
  }

  async function updateTabCaptureHint() {
    const hint = $("#ltTabCaptureHint");
    if (!hint) return;
    if (getSourceMode() !== SOURCE_TAB) {
      hint.textContent = "";
      hint.className = "lt-tab-hint";
      return;
    }
    try {
      const resp = await chrome.runtime.sendMessage({ type: "PREVIEW_TAB_CAPTURE_TARGET" });
      if (resp?.ok) {
        hint.textContent = `预览目标：${truncateText(resp.tabTitle, 48)}（须从扩展按钮授权）`;
        hint.className = "lt-tab-hint ok";
      } else {
        hint.textContent = resp?.message || "请切到目标网页后，从扩展图标启动捕获";
        hint.className = "lt-tab-hint warn";
      }
    } catch {
      hint.textContent = "请切到目标网页后，从扩展图标启动捕获";
      hint.className = "lt-tab-hint warn";
    }
  }

  async function loadSourceModePref() {
    const data = await chrome.storage.local.get([SOURCE_STORAGE_KEY]);
    const mode = data[SOURCE_STORAGE_KEY] === SOURCE_TAB ? SOURCE_TAB : SOURCE_MIC;
    const radio = mountedRoot?.querySelector(`input[name="ltSourceMode"][value="${mode}"]`);
    if (radio) radio.checked = true;
    appState.sourceMode = mode;
    await updateTabCaptureHint();
  }

  async function saveSourceModePref(mode) {
    await chrome.storage.local.set({ [SOURCE_STORAGE_KEY]: mode });
    appState.sourceMode = mode;
    await updateTabCaptureHint();
  }

  function setTranslateProviderDisabled(disabled) {
    const select = $("#ltTranslateProvider");
    if (!select) return;
    if (disabled || select.dataset.empty === "1") {
      select.disabled = true;
    } else {
      select.disabled = false;
    }
  }

  function updateProviderDisplay() {
    const select = $("#ltTranslateProvider");
    const hint = $("#ltProviderHint");
    const info = appState.providerInfo;

    if (select && info.providerId) {
      select.value = info.providerId;
    }

    if (hint) {
      if (!info.hasKey) {
        hint.textContent = "还没有配置任何模型。请先到「模型与 API」填写至少一个平台的 API Key。";
        hint.className = "lt-provider-hint warn";
      } else {
        hint.textContent = `当前：${info.name || info.providerId} · ${info.model || "—"}（与划词启用的模型相互独立）`;
        hint.className = "lt-provider-hint";
      }
    }
  }

  async function loadTranslateProviderOptions() {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "GET_LIVE_TRANSCRIBE_PROVIDER_OPTIONS",
      });
      const select = $("#ltTranslateProvider");
      if (!select) return;

      select.innerHTML = "";
      if (!resp?.ok || resp.empty || !resp.options?.length) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "还没有配置任何模型";
        select.appendChild(opt);
        select.disabled = true;
        select.dataset.empty = "1";
        appState.providerInfo = { name: "", model: "", hasKey: false, providerId: "" };
        updateProviderDisplay();
        return;
      }

      select.dataset.empty = "0";
      setTranslateProviderDisabled(appState.isRecording);

      resp.options.forEach((p) => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = `${p.name} · ${p.model}`;
        select.appendChild(opt);
      });

      const selectedId = resp.selectedId || resp.options[0].id;
      select.value = selectedId;
      const picked = resp.options.find((p) => p.id === selectedId) || resp.options[0];
      appState.providerInfo = {
        name: picked.name || picked.id,
        model: picked.model || "",
        hasKey: true,
        providerId: picked.id,
      };
      updateProviderDisplay();
    } catch (err) {
      log("translate provider options failed", err?.message);
    }
  }

  async function saveLiveTranscribeProvider(providerId) {
    const id = String(providerId || "").trim();
    if (!id) return;
    const resp = await chrome.runtime.sendMessage({
      type: "SET_LIVE_TRANSCRIBE_PROVIDER",
      providerId: id,
    });
    if (!resp?.ok) {
      setStatus(resp?.message || "保存翻译模型失败", "warn");
      return;
    }
    appState.providerInfo = {
      name: resp.providerName || id,
      model: resp.model || "",
      hasKey: true,
      providerId: id,
    };
    updateProviderDisplay();
  }

  /** @deprecated alias */
  async function loadProviderInfo() {
    return loadTranslateProviderOptions();
  }

  function updateMicLevelDisplay(level) {
    appState.micLevel = level;
    const textEl = $("#ltMicLevel");
    const barEl = $("#ltMicLevelBar");
    const pct = Math.min(100, Math.round(level * 400));
    if (textEl) textEl.textContent = `${pct}%`;
    if (barEl) barEl.style.width = `${pct}%`;
  }

  function isNearBottom(el, threshold = 80) {
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }

  function scrollToBottomIfNeeded(el, force = false) {
    if (!el) return;
    if (force || isNearBottom(el)) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight;
      });
    }
  }

  function setupAutoScrollTracking() {
    if (scrollTrackingBound) return;
    const enScroll = $("#ltEnglishScroll");
    const zhScroll = $("#ltChineseScroll");
    if (!enScroll && !zhScroll) return;
    scrollTrackingBound = true;
    enScroll?.addEventListener(
      "scroll",
      () => {
        scrollState.englishAutoScroll = isNearBottom(enScroll);
      },
      { passive: true }
    );
    zhScroll?.addEventListener(
      "scroll",
      () => {
        scrollState.chineseAutoScroll = isNearBottom(zhScroll);
      },
      { passive: true }
    );
  }

  function scrollAllTranscriptPanelsToBottom(force = false) {
    if (force) {
      scrollState.englishAutoScroll = true;
      scrollState.chineseAutoScroll = true;
    }
    scrollToBottomIfNeeded($("#ltEnglishScroll"), force || scrollState.englishAutoScroll);
    scrollToBottomIfNeeded($("#ltChineseScroll"), force || scrollState.chineseAutoScroll);
    scrollToBottomIfNeeded($("#ltCurrentEnScroll"), true);
    scrollToBottomIfNeeded($("#ltCurrentZhScroll"), true);
  }

  function updateLiveCurrentEnglish(text) {
    appState.currentTurnText = String(text || "");
    appState.partialTranscript = appState.currentTurnText;
    const el = $("#liveCurrentEnglish");
    if (el) el.textContent = appState.currentTurnText;
    scrollToBottomIfNeeded($("#ltCurrentEnScroll"), true);
  }

  function updateLiveCurrentChinese(text) {
    appState.currentChineseText = String(text || "");
    const el = $("#liveCurrentChinese");
    if (el) el.textContent = appState.currentChineseText;
    scrollToBottomIfNeeded($("#ltCurrentZhScroll"), true);
  }

  function clearLiveCurrentBoxes() {
    updateLiveCurrentEnglish("");
    updateLiveCurrentChinese("");
  }

  function clearPartialTranslateTimer() {
    if (partialTranslateTimer) {
      clearTimeout(partialTranslateTimer);
      partialTranslateTimer = null;
    }
  }

  function resetLiveTurnState() {
    appState.turnStartedAt = 0;
    appState.lastTranslatedPartialText = "";
    appState.currentTurnText = "";
    appState.currentChineseText = "";
    clearPartialTranslateTimer();
  }

  function normalizeTranscriptForMatch(text) {
    return String(text || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function getWordList(text) {
    return String(text || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  }

  function wordOverlapRatio(wordsA, wordsB) {
    const normalizeWordToken = (word) =>
      String(word || "")
        .toLowerCase()
        .replace(/[^\w']/g, "");
    const a = wordsA.map(normalizeWordToken).filter(Boolean);
    const b = wordsB.map(normalizeWordToken).filter(Boolean);
    if (!a.length || !b.length) return 0;
    const setB = new Set(b);
    let inter = 0;
    for (const w of a) {
      if (setB.has(w)) inter += 1;
    }
    return inter / Math.min(a.length, b.length);
  }

  function isDuplicateFinal(finalText) {
    const last = appState.bilingualHistory[appState.bilingualHistory.length - 1];
    if (!last) return false;
    const lastEn = normalizeTranscriptForMatch(last.cleanedEn || last.rawEn || "");
    const newEn = normalizeTranscriptForMatch(finalText);
    if (!newEn) return true;
    if (lastEn === newEn) return true;
    if (wordOverlapRatio(getWordList(lastEn), getWordList(newEn)) > 0.9) return true;
    if (lastEn.startsWith(newEn) && newEn.length < lastEn.length) return true;
    if (newEn.startsWith(lastEn) && lastEn.length < newEn.length) return true;
    return false;
  }

  function maybeForceEndpointByPartial(transcript) {
    if (getTurnMode() !== TURN_MODE_CAPTION) return;
    if (!runtime.ws || runtime.ws.readyState !== WebSocket.OPEN) return;

    const cfg = LIVE_CAPTION_ENDPOINT_CONFIG;
    const now = Date.now();
    if (now - appState.lastForceEndpointAt < cfg.minForceIntervalMs) return;

    const age = appState.turnStartedAt ? now - appState.turnStartedAt : 0;
    const words = countWords(transcript);
    const chars = transcript.length;
    const hasEndPunctuation = /[.!?]\s*$/.test(String(transcript || "").trim());

    if (
      age >= cfg.maxLiveTurnMs ||
      words >= cfg.maxLiveTurnWords ||
      chars >= cfg.maxLiveTurnChars ||
      (hasEndPunctuation && age >= cfg.minTurnAgeBeforePunctuationForceMs)
    ) {
      runtime.ws.send(JSON.stringify({ type: "ForceEndpoint" }));
      appState.lastForceEndpointAt = now;
      setStatus("已请求 AssemblyAI 结束当前句…", "");
      log("ForceEndpoint", { age, words, chars, hasEndPunctuation });
    }
  }

  function schedulePartialTranslation(text) {
    if (getTurnMode() !== TURN_MODE_CAPTION) return;
    clearPartialTranslateTimer();

    const now = Date.now();
    const sinceLast = now - appState.lastPartialTranslateAt;
    const delay = Math.max(
      0,
      Math.min(
        PARTIAL_TRANSLATE_MAX_INTERVAL_MS,
        sinceLast >= PARTIAL_TRANSLATE_MIN_INTERVAL_MS
          ? 0
          : PARTIAL_TRANSLATE_MIN_INTERVAL_MS - sinceLast
      )
    );

    partialTranslateTimer = setTimeout(() => {
      partialTranslateTimer = null;
      maybeTranslatePartialLive(appState.currentTurnText || text);
    }, delay);
  }

  function maybeTranslatePartialLive(text) {
    const t = String(text || "").trim();
    if (!t || getTurnMode() !== TURN_MODE_CAPTION) return;
    if (countWords(t) < MIN_PARTIAL_WORDS_TO_TRANSLATE) return;

    const newWords = countWordsAddedSince(appState.lastTranslatedPartialText, t);
    if (
      appState.lastTranslatedPartialText &&
      newWords < MIN_NEW_WORDS_FOR_PARTIAL_TRANSLATE
    ) {
      return;
    }

    appState.lastPartialTranslateAt = Date.now();
    appState.lastTranslatedPartialText = t;
    translatePartialLive(t);
  }

  async function translatePartialLive(text) {
    const seq = ++appState.partialTranslateSeq;
    try {
      const res = await chrome.runtime.sendMessage({
        type: "TRANSLATE_TRANSCRIPT",
        mode: "partial",
        currentText: text,
        previousContext: [...appState.previousContext],
      });
      if (seq !== appState.partialTranslateSeq) return;
      if (res?.ok) {
        const zh = sanitizeChineseForDisplay(res.translation || res.zh || res.text || "");
        if (zh) updateLiveCurrentChinese(zh);
      }
    } catch (err) {
      log("partial translate fail", err?.message || err);
    }
  }

  function onCaptionPartialTurn(transcript) {
    const text = String(transcript || "").trim();
    if (!text) return;
    if (!appState.turnStartedAt) appState.turnStartedAt = Date.now();

    updateLiveCurrentEnglish(text);
    schedulePartialTranslation(text);
    maybeForceEndpointByPartial(text);
  }

  function onCaptionFinalTurn(finalTranscript) {
    clearPartialTranslateTimer();
    appState.partialTranslateSeq += 1;

    const text = String(finalTranscript || "").trim();
    if (!text) {
      resetLiveTurnState();
      clearLiveCurrentBoxes();
      return;
    }

    updateLiveCurrentEnglish(text);

    if (isDuplicateFinal(text)) {
      log("final dedupe skip", text.slice(0, 48));
      resetLiveTurnState();
      clearLiveCurrentBoxes();
      return;
    }

    queueCaptionFinalTranslation(text);
  }

  function queueCaptionFinalTranslation(finalText) {
    const rawEn = String(finalText || "").trim();
    if (!rawEn) return;

    log("caption final translate", { len: rawEn.length });
    setStatus("正在翻译…", "");

    runtime.translateQueue = runtime.translateQueue
      .then(async () => {
        appState.translateInFlight = true;
        let resp;
        try {
          resp = await chrome.runtime.sendMessage({
            type: "TRANSLATE_TRANSCRIPT",
            mode: "final",
            currentText: rawEn,
            previousContext: [...appState.previousContext],
          });
        } catch (err) {
          appendBilingualHistory(rawEn, rawEn, buildTranslationErrorZh(null, err));
          resetLiveTurnState();
          clearLiveCurrentBoxes();
          return;
        }

        if (resp?.ok) {
          const cleaned = String(resp.cleaned_en || rawEn).trim();
          const zh = sanitizeChineseForDisplay(resp.translation || resp.text || resp.zh || "");
          if (!zh) {
            appendBilingualHistory(rawEn, cleaned || rawEn, buildTranslationErrorZh(
              { error: "model returned empty zh" },
              null
            ));
          } else {
            appendBilingualHistory(rawEn, cleaned, zh);
          }
          if (appState.isRecording) setStatus("正在录音…", "ok");
        } else {
          appendBilingualHistory(rawEn, rawEn, buildTranslationErrorZh(resp, null));
          setStatus(`翻译失败：${formatTranslationFailure(resp, null)}`, "err");
        }

        resetLiveTurnState();
        clearLiveCurrentBoxes();
      })
      .catch((err) => {
        appendBilingualHistory(rawEn, rawEn, buildTranslationErrorZh(null, err));
        resetLiveTurnState();
        clearLiveCurrentBoxes();
      })
      .finally(() => {
        appState.translateInFlight = false;
      });
  }

  function formatHistoryEntryTime(createdAt) {
    const d = createdAt ? new Date(createdAt) : new Date();
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function createHistoryItemElement(text, timeLabel, isWarn) {
    const item = document.createElement("div");
    item.className = "lt-history-item" + (isWarn ? " lt-history-item-warn" : "");
    const textNode = document.createElement("div");
    textNode.textContent = text;
    item.appendChild(textNode);
    if (timeLabel) {
      const timeEl = document.createElement("div");
      timeEl.className = "lt-history-item-time";
      timeEl.textContent = timeLabel;
      item.appendChild(timeEl);
    }
    return item;
  }

  function trimVisibleHistory(listEl) {
    while (listEl && listEl.children.length > HISTORY_VISIBLE_MAX) {
      listEl.removeChild(listEl.firstChild);
    }
  }

  function appendHistoryDom(entry) {
    const enList = $("#englishHistoryList");
    const zhList = $("#chineseHistoryList");
    const timeLabel = formatHistoryEntryTime(entry.createdAt);
    const enText = entry.cleanedEn || entry.rawEn || "";
    const zhText = resolveChineseDisplayText(entry.zh);
    const isWarn = zhText.startsWith("（翻译失败：");

    if (enList) {
      enList.appendChild(createHistoryItemElement(enText, timeLabel, false));
      trimVisibleHistory(enList);
      scrollToBottomIfNeeded($("#ltEnglishScroll"), scrollState.englishAutoScroll);
    }
    if (zhList) {
      zhList.appendChild(createHistoryItemElement(zhText, timeLabel, isWarn));
      trimVisibleHistory(zhList);
      scrollToBottomIfNeeded($("#ltChineseScroll"), scrollState.chineseAutoScroll);
    }
  }

  function renderHistory() {
    const enList = $("#englishHistoryList");
    const zhList = $("#chineseHistoryList");
    if (!enList || !zhList) return;

    enList.innerHTML = "";
    zhList.innerHTML = "";

    const start = Math.max(0, appState.bilingualHistory.length - HISTORY_VISIBLE_MAX);
    appState.bilingualHistory.slice(start).forEach((item) => {
      appendHistoryDom(item);
    });

    scrollToBottomIfNeeded($("#ltEnglishScroll"), true);
    scrollToBottomIfNeeded($("#ltChineseScroll"), true);
  }

  function formatTranslationFailure(resp, err) {
    if (resp?.error === "empty transcript") return "empty transcript";
    if (resp?.error === "no_provider") return "provider not configured";
    if (resp?.error === "empty model response") return "empty model response";
    if (resp?.error === "model returned empty zh") return "model returned empty zh";
    if (resp?.error === "JSON parse failed") return "JSON parse failed";
    if (resp?.error === "model did not return Chinese translation") {
      return "model did not return Chinese translation";
    }
    if (resp?.error === "empty translation") return "JSON parse failed";
    const msg = String(resp?.message || resp?.error || err?.message || "unknown error").trim();
    if (/timeout/i.test(msg)) return "timeout";
    if (/rate limit|429|too many/i.test(msg)) {
      if (/groq/i.test(msg)) return "Groq rate limit";
      return "rate limit";
    }
    if (/JSON parse|parse failed/i.test(msg)) return "JSON parse failed";
    if (/未返回有效中文|未返回中文/.test(msg)) return "model returned empty zh";
    return msg.slice(0, 120);
  }

  function buildTranslationErrorZh(resp, err) {
    return `（翻译失败：${formatTranslationFailure(resp, err)}）`;
  }

  function looksLikeJsonForDisplay(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    if (/^```(?:json)?/i.test(t)) return true;
    if (t.startsWith("{") && /"(?:cleaned_en|cleanedEn|zh|translation|cn)"/.test(t)) {
      return true;
    }
    if (/^\{[\s\S]*\}$/.test(t) && !/[\u4e00-\u9fff]/.test(t)) return true;
    return false;
  }

  function sanitizeChineseForDisplay(value) {
    const t = String(value || "").trim();
    if (!t) return null;
    if (t.startsWith("（翻译失败：") || t.startsWith("（临时字幕")) return t;
    if (/^```/.test(t)) return null;
    if (looksLikeJsonForDisplay(t)) return null;
    return t;
  }

  function resolveChineseDisplayText(value, fallbackError) {
    const sanitized = sanitizeChineseForDisplay(value);
    if (sanitized) return sanitized;
    if (fallbackError) return fallbackError;
    return INVALID_ZH_MSG;
  }

  function storeChineseTranslation(rawZh, resp, err) {
    const sanitized = sanitizeChineseForDisplay(rawZh);
    if (sanitized) return sanitized;
    if (String(rawZh || "").startsWith("（翻译失败：")) return String(rawZh).trim();
    return buildTranslationErrorZh(resp, err);
  }

  async function requestTranslation(rawEn, mode) {
    const payload = {
      type: "TRANSLATE_TRANSCRIPT",
      mode: mode || "final",
      currentText: rawEn,
      previousContext: [...appState.previousContext],
    };

    zehDebugLog("[LiveTranscribe] translating", { mode: payload.mode, len: rawEn.length });
    let res = await chrome.runtime.sendMessage(payload);
    zehDebugLog("[LiveTranscribe] translation result", res);

    if (!res?.ok && payload.mode === "final") {
      await new Promise((resolve) => setTimeout(resolve, 800));
      res = await chrome.runtime.sendMessage(payload);
      zehDebugLog("[LiveTranscribe] translation result (retry)", res);
    }

    return res;
  }

  function refreshTranscriptUI() {
    updateLiveCurrentEnglish(appState.currentTurnText || appState.partialTranscript);
    updateLiveCurrentChinese(appState.currentChineseText);
    renderHistory();
  }

  function resetPcmBuffer() {
    pcmPending = new Int16Array(0);
    dsPhase = 0;
    firstAudioFrameLogged = false;
  }

  function computeRms(float32) {
    if (!float32?.length) return 0;
    let sum = 0;
    for (let i = 0; i < float32.length; i++) sum += float32[i] * float32[i];
    return Math.sqrt(sum / float32.length);
  }

  function downsampleFloat32(float32) {
    const out = [];
    for (let i = 0; i < float32.length; i++) {
      dsPhase += 1;
      if (dsPhase < dsStep) continue;
      dsPhase -= dsStep;
      out.push(float32[i]);
    }
    return out;
  }

  function floatToInt16(floats) {
    const pcm = new Int16Array(floats.length);
    for (let i = 0; i < floats.length; i++) {
      const c = Math.max(-1, Math.min(1, floats[i]));
      pcm[i] = c < 0 ? c * 0x8000 : c * 0x7fff;
    }
    return pcm;
  }

  function appendPcmChunk(int16) {
    if (!int16?.length) return;
    const merged = new Int16Array(pcmPending.length + int16.length);
    merged.set(pcmPending);
    merged.set(int16, pcmPending.length);
    pcmPending = merged;
    flushPcmBuffer(false);
  }

  function sendPcmChunk(int16) {
    if (!int16?.length || !runtime.ws || runtime.ws.readyState !== WebSocket.OPEN) return;
    const count = Math.min(int16.length, PCM_MAX_SAMPLES);
    const slice = count === int16.length ? int16 : int16.subarray(0, count);
    const durationMs = Math.round((slice.length / SAMPLE_RATE) * 1000);
    log("send audio chunk", { samples: slice.length, bytes: slice.byteLength, durationMs });
    runtime.ws.send(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength));
  }

  function flushPcmBuffer(isFinal) {
    while (pcmPending.length >= PCM_CHUNK_SAMPLES) {
      const chunk = pcmPending.subarray(0, PCM_CHUNK_SAMPLES);
      pcmPending = pcmPending.subarray(PCM_CHUNK_SAMPLES);
      sendPcmChunk(chunk);
    }
    if (isFinal && pcmPending.length >= PCM_MIN_SAMPLES) {
      sendPcmChunk(pcmPending);
      pcmPending = new Int16Array(0);
    } else if (isFinal) {
      pcmPending = new Int16Array(0);
    }
  }

  function handleAudioLevel(rms) {
    updateMicLevelDisplay(rms);
    if (!appState.isRecording || !appState.micReady) return;

    if (rms < MIC_LOW_THRESHOLD) {
      if (!micLowSince) micLowSince = Date.now();
      if (!micLowWarned && Date.now() - micLowSince >= MIC_LOW_WARN_MS) {
        micLowWarned = true;
        const msg =
          appState.sourceMode === SOURCE_TAB
            ? "当前标签页可能没有播放声音"
            : "麦克风输入较低，请检查设备或靠近麦克风";
        setStatus(msg, "warn");
      }
    } else {
      micLowSince = 0;
      micLowWarned = false;
    }
  }

  function processFloatAudio(float32, rate) {
    if (!firstAudioFrameLogged) {
      firstAudioFrameLogged = true;
      log("first audio frame", { samples: float32.length, inputRate: rate });
    }
    handleAudioLevel(computeRms(float32));
    const down = downsampleFloat32(float32);
    if (down.length) {
      appendPcmChunk(floatToInt16(down));
    }
  }

  async function loadAssemblyAIConfig() {
    const data = await chrome.storage.local.get([STORAGE_KEY]);
    const cfg = mergeAssemblyConfig(data[STORAGE_KEY]);
    appState.assemblyConfig = cfg;
    return cfg;
  }

  async function saveAssemblyAIKey() {
    const input = $("#ltApiKey");
    const apiKey = (input?.value || "").trim();
    const prev = mergeAssemblyConfig(appState.assemblyConfig || (await loadAssemblyAIConfig()));
    if (!apiKey) {
      if (!prev.apiKey) {
        setStatus("请输入 AssemblyAI API Key", "warn");
        return;
      }
      // 清空输入框再保存 = 从本机删除 Key；其余转写设置保留
      const cleared = { ...prev, apiKey: "" };
      await chrome.storage.local.set({ [STORAGE_KEY]: cleared });
      appState.assemblyConfig = cleared;
      setStatus("已从本机删除 AssemblyAI Key", "ok");
      return;
    }
    const cfg = { ...prev, apiKey };
    await chrome.storage.local.set({ [STORAGE_KEY]: cfg });
    appState.assemblyConfig = cfg;
    setStatus("AssemblyAI Key 已保存到本机", "ok");
  }

  async function fetchTempToken() {
    log("fetch token");
    const resp = await chrome.runtime.sendMessage({ type: "GET_ASSEMBLYAI_TEMP_TOKEN" });
    if (!resp?.ok || !resp.token) {
      throw new Error(resp?.message || "获取 temporary token 失败");
    }
    return resp.token;
  }

  function buildWsUrl(token, cfg) {
    const ep = resolveEndpointingConfig(cfg);
    zehDebugLog("[LiveTranscribe] endpointing config", ep);

    const params = new URLSearchParams({
      sample_rate: String(ep.sampleRate),
      speech_model: ep.speechModel,
      token,
    });

    const model = String(ep.speechModel || "").toLowerCase();
    const isUniversal =
      model === "universal-streaming-english" || model.includes("universal-streaming");
    const isU3 = model === "u3-rt-pro" || model.includes("u3-rt-pro");

    if (isUniversal) {
      params.set("min_turn_silence", String(ep.minTurnSilence));
      params.set("max_turn_silence", String(ep.maxTurnSilence));
      params.set("end_of_turn_confidence_threshold", String(ep.endOfTurnConfidenceThreshold));
      if (ep.formatTurns) params.set("format_turns", "true");
      if (ep.vadThreshold != null) params.set("vad_threshold", String(ep.vadThreshold));
    } else if (isU3) {
      if (ep.mode) params.set("mode", ep.mode);
      if (ep.languageCode) params.set("language_code", ep.languageCode);
      params.set("min_turn_silence", String(ep.minTurnSilence));
      params.set("max_turn_silence", String(ep.maxTurnSilence));
      params.set("continuous_partials", "true");
      params.set("interruption_delay", String(ep.interruptionDelay ?? 0));
      if (ep.vadThreshold != null) params.set("vad_threshold", String(ep.vadThreshold));
    }

    return `wss://streaming.assemblyai.com/v3/ws?${params.toString()}`;
  }

  function wsUrlForLog(url) {
    return String(url).replace(/token=[^&]+/, "token=***");
  }

  function clearAggregateTimer() {
    if (aggregateTimer) {
      clearTimeout(aggregateTimer);
      aggregateTimer = null;
    }
  }

  function scheduleAggregateTimer() {
    clearAggregateTimer();
    if (!appState.pendingEnglishBuffer.trim()) return;
    aggregateTimer = setTimeout(() => {
      aggregateTimer = null;
      maybeTriggerTranslation(false);
    }, AGGREGATE_TIMEOUT_MS);
  }

  function shouldTranslateNow(force) {
    const buf = appState.pendingEnglishBuffer.trim();
    if (!buf) return false;
    if (force) return true;
    if (isFillerOnlyBuffer(buf)) return false;
    if (endsWithSentencePunct(buf)) return true;
    if (countWords(buf) >= MIN_WORDS_FOR_TRANSLATE) return true;
    if (
      appState.lastFinalTimestamp &&
      Date.now() - appState.lastFinalTimestamp >= AGGREGATE_TIMEOUT_MS
    ) {
      return true;
    }
    return false;
  }

  function maybeTriggerTranslation(force) {
    const buf = appState.pendingEnglishBuffer.trim();
    if (!buf) {
      if (force) setStatus("当前没有待翻译内容", "warn");
      return;
    }
    if (!shouldTranslateNow(force)) {
      scheduleAggregateTimer();
      return;
    }
    clearAggregateTimer();
    const textToTranslate = buf;
    appState.pendingEnglishBuffer = "";
    appState.lastSentTranscriptHash = "";
    queueTranslation(textToTranslate, { final: true });
  }

  function appendFinalToPending(transcript) {
    const t = String(transcript || "").trim();
    if (!t) return;

    const h = hashText(t);
    if (h === appState.lastSentTranscriptHash) {
      log("dedupe final transcript", t.slice(0, 40));
      return;
    }
    appState.lastSentTranscriptHash = h;

    if (appState.pendingEnglishBuffer.trim()) {
      appState.pendingEnglishBuffer += " " + t;
    } else {
      appState.pendingEnglishBuffer = t;
    }
    appState.lastFinalTimestamp = Date.now();
    maybeTriggerTranslation(false);
  }

  function handleWsMessage(raw) {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }

    if (data.type === "Begin") {
      log("Begin", data);
      setStatus("AssemblyAI 已开始转写", "ok");
      return;
    }

    if (data.type === "Termination") {
      log("Termination");
      setStatus("转写会话已结束", "warn");
      return;
    }

    if (data.type === "Error" || data.error) {
      const msg = data.error || data.message || "AssemblyAI 返回错误";
      log("Error", msg);
      const readable = String(msg).slice(0, 200);
      setStatus(
        /param|query|invalid|unsupported/i.test(readable)
          ? `AssemblyAI 参数错误：${readable}`
          : readable,
        "err"
      );
      stopRecording({ silent: true, reason: "assemblyai-error" });
      return;
    }

    if (data.type !== "Turn") return;

    const transcript = String(data.transcript || "").trim();
    log("Turn", { end_of_turn: data.end_of_turn, len: transcript.length });

    if (!transcript) return;

    if (!data.end_of_turn) {
      if (!appState.turnStartedAt) appState.turnStartedAt = Date.now();
      if (getTurnMode() === TURN_MODE_CAPTION) {
        onCaptionPartialTurn(transcript);
      } else {
        updateLiveCurrentEnglish(transcript);
      }
      return;
    }

    zehDebugLog("[LiveTranscribe] final turn", transcript);

    if (getTurnMode() === TURN_MODE_CAPTION) {
      onCaptionFinalTurn(transcript);
      return;
    }

    updateLiveCurrentEnglish(transcript);
    resetLiveTurnState();
    clearLiveCurrentBoxes();
    appendFinalToPending(transcript);
  }

  function appendBilingualHistory(rawEn, cleanedEn, zh) {
    const entry = {
      rawEn: String(rawEn || "").trim(),
      cleanedEn: String(cleanedEn || rawEn || "").trim(),
      zh: storeChineseTranslation(zh, null, null),
      createdAt: Date.now(),
      segmentType: "final",
    };
    appState.bilingualHistory.push(entry);
    appState.englishHistory.push(entry.cleanedEn || entry.rawEn);
    appState.chineseHistory.push(entry.zh);

    const ctxEn = entry.cleanedEn || entry.rawEn;
    if (ctxEn) {
      appState.previousContext.push(ctxEn);
      if (appState.previousContext.length > 2) {
        appState.previousContext = appState.previousContext.slice(-2);
      }
    }

    appendHistoryDom(entry);
  }

  /** @deprecated alias */
  function pushHistory(rawEn, cleanedEn, zh) {
    appendBilingualHistory(rawEn, cleanedEn, zh);
  }

  function queueTranslation(englishText, opts) {
    const options = opts || {};
    const rawEn = String(englishText || "").trim();
    if (!rawEn) return;

    if (isDuplicateFinal(rawEn)) {
      log("precise final dedupe skip", rawEn.slice(0, 48));
      return;
    }

    if (options.final) {
      zehDebugLog("[LiveTranscribe] final turn translate", rawEn);
    }

    log("trigger translate", { len: rawEn.length, final: Boolean(options.final) });
    setStatus("正在翻译…", "");

    runtime.translateQueue = runtime.translateQueue
      .then(async () => {
        appState.translateInFlight = true;
        let resp;
        try {
          resp = await requestTranslation(rawEn, "final");
        } catch (err) {
          const errZh = buildTranslationErrorZh(null, err);
          setStatus(`翻译失败：${formatTranslationFailure(null, err)}`, "err");
          pushHistory(rawEn, rawEn, errZh);
          log("translate fail", err);
          return;
        }

        if (resp?.ok) {
          const cleaned = String(resp.cleaned_en || rawEn).trim();
          const zh = sanitizeChineseForDisplay(resp.translation || resp.text || resp.zh || "");
          if (!zh) {
            const errZh = buildTranslationErrorZh(
              resp?.error ? resp : { error: "model returned empty zh" },
              null
            );
            setStatus("翻译失败：model returned empty zh", "err");
            pushHistory(rawEn, cleaned || rawEn, errZh);
            log("translate fail", "empty zh after ok");
            return;
          }
          pushHistory(rawEn, cleaned, zh);
          log("translate ok", { cleanedLen: cleaned.length, zhLen: zh.length });
          if (appState.isRecording) {
            setStatus("正在录音…", "ok");
          }
          return;
        }

        const failureLabel = formatTranslationFailure(resp, null);
        setStatus(`翻译失败：${failureLabel}`, "err");
        pushHistory(rawEn, rawEn, buildTranslationErrorZh(resp, null));
        log("translate fail", failureLabel);
      })
      .catch((err) => {
        const failureLabel = formatTranslationFailure(null, err);
        setStatus(`翻译失败：${failureLabel}`, "err");
        pushHistory(rawEn, rawEn, buildTranslationErrorZh(null, err));
      })
      .finally(() => {
        appState.translateInFlight = false;
      });
  }

  async function acquireMicrophoneStream() {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  }

  async function acquireTabStream() {
    const pending = await takePendingTabCapture();
    if (pending?.streamId) {
      appState.capturedTabTitle = pending.targetTabTitle || "";
      return openTabStreamFromStreamId(pending.streamId);
    }
    throw new Error(TAB_CAPTURE_DENIED_MSG);
  }

  async function setupAudioPipeline(tabMode, s) {
    ensureCurrentSession(s);
    const audioContext = new AudioContext();
    s.audioContext = audioContext;
    runtime.audioContext = audioContext;
    inputSampleRate = runtime.audioContext.sampleRate;
    dsStep = inputSampleRate / SAMPLE_RATE;
    log("AudioContext sampleRate", inputSampleRate);

    const workletUrl = chrome.runtime.getURL("live-transcribe-worklet.js");
    await audioContext.audioWorklet.addModule(workletUrl);
    ensureCurrentSession(s);

    runtime.sourceNode = runtime.audioContext.createMediaStreamSource(runtime.mediaStream);
    runtime.workletNode = new AudioWorkletNode(
      runtime.audioContext,
      "live-transcribe-pcm-processor"
    );

    runtime.workletNode.port.onmessage = (ev) => {
      if (!appState.isRecording || appState.isPaused) return;
      if (!runtime.ws || runtime.ws.readyState !== WebSocket.OPEN) return;
      const msg = ev.data;
      if (msg?.samples instanceof ArrayBuffer) {
        const rate = msg.inputRate || inputSampleRate;
        processFloatAudio(new Float32Array(msg.samples), rate);
      }
    };

    runtime.sourceNode.connect(runtime.workletNode);
    if (tabMode && !runtime.playbackSource) {
      startTabPlayback(runtime.mediaStream);
    }
  }

  async function startAudioInput(options, s) {
    const opts = options || {};
    ensureCurrentSession(s);
    const mode = opts.forceTabMode ? SOURCE_TAB : getSourceMode();
    appState.sourceMode = mode;
    setConnStatus("已连接", "ok");

    if (mode === SOURCE_TAB) {
      setStatus("AssemblyAI 已连接，正在打开标签页音频…", "");
      setInputStatus("准备捕获…", "");

      if (opts.preacquiredTabStream) {
        runtime.mediaStream = opts.preacquiredTabStream;
        if (opts.preacquiredTabTitle) {
          appState.capturedTabTitle = opts.preacquiredTabTitle;
        }
      } else {
        const tabStream = await acquireTabStream();
        s.stream = tabStream;
        ensureCurrentSession(s);
        runtime.mediaStream = tabStream;
        startTabPlayback(runtime.mediaStream);
      }

      log("tab capture stream ready");
      appState.micReady = true;
      const title = truncateText(appState.capturedTabTitle, 28);
      setInputStatus(title ? `正在捕获：${title}` : "正在捕获当前标签页声音", "ok");
      setStatus("标签页声音已捕获，正在发送音频…", "ok");
      await setupAudioPipeline(true, s);
      return;
    }

    setStatus("AssemblyAI 已连接，正在打开麦克风…", "");
    setInputStatus("准备中…", "");
    const micStream = await acquireMicrophoneStream();
    s.stream = micStream;
    ensureCurrentSession(s);
    runtime.mediaStream = micStream;
    log("getUserMedia success");
    appState.micReady = true;
    setInputStatus("麦克风已开启", "ok");
    setStatus("麦克风已开启，正在发送音频…", "ok");
    await setupAudioPipeline(false, s);
  }

  async function startRecording(options) {
    const startOpts = options || {};
    if (appState.isRecording) {
      releasePreacquiredTabStream(startOpts);
      return;
    }

    const cfg = await loadAssemblyAIConfig();
    if (!(cfg.apiKey || "").trim()) {
      releasePreacquiredTabStream(startOpts);
      setStatus("请先保存 AssemblyAI API Key", "warn");
      return;
    }

    await loadTranslateProviderOptions();
    if (!appState.providerInfo.hasKey) {
      releasePreacquiredTabStream(startOpts);
      setStatus("请先在「模型与 API」配置至少一个平台的 API Key，并选择翻译模型", "warn");
      return;
    }
    if (appState.isRecording) {
      releasePreacquiredTabStream(startOpts);
      return;
    }

    log("start recording", { sourceMode: getSourceMode() });
    const session = beginSession();
    if (startOpts.preacquiredTabStream) session.stream = startOpts.preacquiredTabStream;
    appState.isRecording = true;
    appState.wsConnected = false;
    appState.micReady = false;
    appState.capturedTabTitle = startOpts.preacquiredTabStream
      ? startOpts.preacquiredTabTitle || ""
      : "";
    micLowSince = 0;
    micLowWarned = false;
    resetPcmBuffer();
    resetLiveTurnState();
    appState.lastForceEndpointAt = 0;
    appState.partialTranslateSeq = 0;
    clearLiveCurrentBoxes();
    updateMicLevelDisplay(0);

    $("#ltStartBtn")?.setAttribute("disabled", "disabled");
    $("#ltStopBtn")?.removeAttribute("disabled");
    setSourceModeDisabled(true);
    setConnStatus("连接中…", "");
    setInputStatus("准备中…", "");

    try {
      setStatus("正在获取 AssemblyAI temporary token…", "");
      const token = await fetchTempToken();
      ensureCurrentSession(session);

      setStatus("正在连接 AssemblyAI…", "");
      const wsUrl = buildWsUrl(token, cfg);
      log("WebSocket connect", wsUrlForLog(wsUrl));

      await new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        session.ws = ws;
        runtime.ws = ws;
        ws.binaryType = "arraybuffer";

        ws.onopen = () => {
          if (!isCurrentSession(session)) {
            reject(sessionCancelledError());
            return;
          }
          log("WebSocket open");
          appState.wsConnected = true;
          resolve();
        };

        ws.onmessage = (ev) => {
          if (runtime.ws !== ws) return;
          if (typeof ev.data === "string") handleWsMessage(ev.data);
        };

        ws.onerror = () => {
          log("WebSocket error");
          reject(isCurrentSession(session) ? new Error("WebSocket 连接失败") : sessionCancelledError());
        };

        ws.onclose = (ev) => {
          log("WebSocket close", ev.code);
          // 握手还没完成就关闭：结束等待（已 resolve 时无效）
          reject(isCurrentSession(session) ? new Error("WebSocket 连接失败") : sessionCancelledError());
          // 旧 socket 的关闭事件不影响之后开始的新会话
          if (activeSession && activeSession !== session) return;
          appState.wsConnected = false;
          setConnStatus("已断开", "err");
          if (appState.isRecording) {
            setStatus("WebSocket 已断开", "err");
            stopRecording({ silent: true, reason: "ws-close" });
          }
        };
      });

      ensureCurrentSession(session);
      await startAudioInput(
        {
          preacquiredTabStream: startOpts.preacquiredTabStream,
          preacquiredTabTitle: startOpts.preacquiredTabTitle,
          forceTabMode: Boolean(startOpts.preacquiredTabStream),
        },
        session
      );
    } catch (err) {
      if (!isCurrentSession(session)) {
        // 已被停止或被新的开始取代：只释放这次开始自己打开的东西，不改界面
        releaseSession(session);
        log("start abandoned", err?.code === SESSION_CANCELLED ? "cancelled" : String(err?.message || err));
        return;
      }
      const msg = String(err?.message || err || "");
      const mode = appState.sourceMode || getSourceMode();
      if (/Permission|NotAllowed|denied/i.test(msg)) {
        if (mode === SOURCE_TAB) {
          setStatus(TAB_CAPTURE_DENIED_MSG, "err");
          setInputStatus("捕获失败", "err");
        } else {
          setStatus("麦克风权限被拒绝，请在 Chrome 站点设置中允许麦克风", "err");
          setInputStatus("权限被拒绝", "err");
        }
      } else if (msg === TAB_CAPTURE_DENIED_MSG || /Chrome 拒绝捕获/i.test(msg)) {
        setStatus(TAB_CAPTURE_DENIED_MSG, "err");
        setInputStatus("捕获失败", "err");
      } else if (/tabCapture|标签页|捕获|streamId|chrome:\/\//i.test(msg)) {
        setStatus(msg.slice(0, 180), "err");
        setInputStatus("捕获失败", "err");
      } else if (/token|AssemblyAI|Key/i.test(msg)) {
        setStatus(msg.slice(0, 160), "err");
      } else if (/WebSocket/i.test(msg)) {
        setStatus("WebSocket 连接失败", "err");
        setConnStatus("连接失败", "err");
      } else if (/没有可捕获|不支持 chrome\.tabCapture/i.test(msg)) {
        setStatus(msg.slice(0, 180), "err");
        setInputStatus("无可用标签页", "err");
      } else {
        setStatus(`无法开始录音：${msg.slice(0, 160)}`, "err");
      }
      log("start failed", msg);
      await stopRecording({ silent: true });
    }
  }

  function cleanupWs() {
    const ws = runtime.ws;
    runtime.ws = null;
    appState.wsConnected = false;
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "Terminate" }));
      }
    } catch {
      /* noop */
    }
    try {
      ws.close();
    } catch {
      /* noop */
    }
    setConnStatus("已断开", "");
  }

  async function cleanupAudio() {
    if (runtime.workletNode) {
      try {
        runtime.workletNode.port.onmessage = null;
        runtime.workletNode.disconnect();
      } catch {
        /* noop */
      }
      runtime.workletNode = null;
    }
    if (runtime.sourceNode) {
      try {
        runtime.sourceNode.disconnect();
      } catch {
        /* noop */
      }
      runtime.sourceNode = null;
    }
    if (runtime.mediaStream) {
      runtime.mediaStream.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          /* noop */
        }
      });
      runtime.mediaStream = null;
    }
    stopTabPlayback();
    if (runtime.audioContext) {
      try {
        await runtime.audioContext.close();
      } catch {
        /* noop */
      }
      runtime.audioContext = null;
    }
    appState.micReady = false;
    setInputStatus("未开启", "");
    updateMicLevelDisplay(0);
  }

  async function stopRecording(options) {
    const opts = options || {};
    const wasActive = appState.isRecording || runtime.ws || runtime.mediaStream;

    appState.isRecording = false;
    const session = endSession();
    clearAggregateTimer();

    if (runtime.workletNode?.port) {
      runtime.workletNode.port.onmessage = null;
    }

    flushPcmBuffer(true);
    cleanupWs();
    await cleanupAudio();
    releaseSession(session);
    resetPcmBuffer();

    $("#ltStartBtn")?.removeAttribute("disabled");
    $("#ltStopBtn")?.setAttribute("disabled", "disabled");
    setSourceModeDisabled(false);

    if (!wasActive) {
      if (!opts.silent) setStatus("已停止录音", "");
      return;
    }

    log("stop recording", opts.reason || "");
    if (!opts.silent) {
      setStatus("已停止录音", "");
    } else if (opts.reason === "ws-close") {
      setStatus("连接已断开，录音已停止", "err");
    }
  }

  function clearTranscripts() {
    clearAggregateTimer();
    clearPartialTranslateTimer();
    appState.partialTranscript = "";
    appState.pendingEnglishBuffer = "";
    appState.englishHistory = [];
    appState.chineseHistory = [];
    appState.bilingualHistory = [];
    appState.previousContext = [];
    appState.lastFinalTimestamp = 0;
    appState.lastSentTranscriptHash = "";
    appState.lastForceEndpointAt = 0;
    appState.partialTranslateSeq = 0;
    resetLiveTurnState();
    clearLiveCurrentBoxes();
    scrollState.englishAutoScroll = true;
    scrollState.chineseAutoScroll = true;
    refreshTranscriptUI();
    setStatus("已清空转写内容", "");
    log("cleared");
  }

  async function copyBilingual() {
    if (!appState.bilingualHistory.length) {
      setStatus("暂无双语内容可复制", "warn");
      return;
    }

    const lines = appState.bilingualHistory.map((item, i) => {
      const en = item.cleanedEn || item.rawEn || "";
      const zh =
        sanitizeChineseForDisplay(item.zh || item.translation || "") || INVALID_ZH_MSG;
      const time = formatHistoryEntryTime(item.createdAt);
      return `## ${i + 1}\nTime: ${time}\nEN: ${en}\nCN: ${zh}`;
    });
    const md = lines.join("\n\n");

    try {
      await navigator.clipboard.writeText(md);
      setStatus("双语内容已复制到剪贴板", "ok");
      log("copy bilingual", appState.bilingualHistory.length);
    } catch (err) {
      setStatus(`复制失败：${String(err?.message || err).slice(0, 80)}`, "err");
    }
  }

  function formatExportFileTimestamp(date) {
    const d = date || new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}-${pad(d.getMinutes())}`;
  }

  function formatExportGeneratedAt(date) {
    const d = date || new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function downloadMarkdownFile(filename, content) {
    const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function exportBilingualDoc() {
    if (!appState.bilingualHistory.length) {
      setStatus("暂无可导出的转译内容。", "warn");
      return;
    }

    const generatedAt = formatExportGeneratedAt(new Date());
    const sections = appState.bilingualHistory
      .map((item, i) => {
        const en = item.cleanedEn || item.rawEn || "";
        const zh =
          sanitizeChineseForDisplay(item.zh || item.translation || "") || INVALID_ZH_MSG;
        const time = formatHistoryEntryTime(item.createdAt);
        return `## ${i + 1}\n\nTime: ${time}\n\nEN: ${en}\n\nCN: ${zh}`;
      })
      .join("\n\n");
    const md = `# Manekilex Live Translation\n\nGenerated at: ${generatedAt}\n\n${sections}\n`;
    const filename = `manekilex-live-translation-bilingual-${formatExportFileTimestamp(new Date())}.md`;
    downloadMarkdownFile(filename, md);
    setStatus("双语文档已导出", "ok");
    log("export bilingual", appState.bilingualHistory.length);
  }

  function exportEnglishDoc() {
    const entries = appState.bilingualHistory
      .map((item) => ({
        en: (item.cleanedEn || item.rawEn || "").trim(),
        time: formatHistoryEntryTime(item.createdAt),
        segmentType: item.segmentType,
      }))
      .filter((item) => item.en);
    if (!entries.length) {
      setStatus("暂无可导出的转译内容。", "warn");
      return;
    }

    const generatedAt = formatExportGeneratedAt(new Date());
    const body = entries
      .map((item, i) => {
        return `${i + 1}. ${item.en}\n   Time: ${item.time}`;
      })
      .join("\n\n");
    const md = `# Manekilex English Transcript\n\nGenerated at: ${generatedAt}\n\n${body}\n`;
    const filename = `manekilex-live-translation-english-${formatExportFileTimestamp(new Date())}.md`;
    downloadMarkdownFile(filename, md);
    setStatus("英文文档已导出", "ok");
    log("export english", entries.length);
  }

  function bindEvents() {
    if (!mountedRoot || mountedRoot.dataset.ltBound) return;
    mountedRoot.dataset.ltBound = "1";

    $("#ltSaveKeyBtn")?.addEventListener("click", () => {
      saveAssemblyAIKey().catch((err) => setStatus(err?.message || "保存失败", "err"));
    });

    $("#ltTranslateProvider")?.addEventListener("change", (ev) => {
      if (appState.isRecording) return;
      saveLiveTranscribeProvider(ev.target.value).catch((err) =>
        setStatus(err?.message || "保存失败", "err")
      );
    });

    mountedRoot.querySelectorAll('input[name="ltSourceMode"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        if (appState.isRecording) return;
        saveSourceModePref(radio.value).catch(() => {});
      });
    });

    mountedRoot.querySelectorAll('input[name="ltTurnMode"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        if (appState.isRecording) return;
        saveTurnSettings().catch((err) => setStatus(err?.message || "保存失败", "err"));
      });
    });

    mountedRoot.querySelectorAll('input[name="ltEndpointingPreset"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        if (appState.isRecording) return;
        saveTurnSettings().catch((err) => setStatus(err?.message || "保存失败", "err"));
      });
    });

    $("#ltStartBtn")?.addEventListener("click", () => startRecording());
    $("#ltStopBtn")?.addEventListener("click", () => stopRecording());
    $("#ltTranslateBtn")?.addEventListener("click", () => maybeTriggerTranslation(true));
    $("#ltCopyBtn")?.addEventListener("click", () => copyBilingual());
    $("#ltExportBilingualBtn")?.addEventListener("click", () => exportBilingualDoc());
    $("#ltExportEnglishBtn")?.addEventListener("click", () => exportEnglishDoc());
    $("#ltClearBtn")?.addEventListener("click", () => clearTranscripts());
    $("#ltFollowLatestBtn")?.addEventListener("click", () => scrollAllTranscriptPanelsToBottom(true));
  }

  async function mount(root) {
    if (!root) return;
    mountedRoot = root;
    bindEvents();
    setupPendingCaptureListener();

    const cfg = await loadAssemblyAIConfig();
    const input = $("#ltApiKey");
    if (input && cfg.apiKey) input.value = cfg.apiKey;
    syncTurnSettingsUI(cfg);

    await loadProviderInfo();
    await loadSourceModePref();
    setConnStatus("未连接", "");
    setInputStatus("未开启", "");
    updateMicLevelDisplay(0);
    setupAutoScrollTracking();
    refreshTranscriptUI();
    setStatus("", "");

    await tryStartFromPendingTabCapture();
  }

  async function destroy() {
    await stopRecording({ silent: true });
    clearAggregateTimer();
    clearPartialTranslateTimer();
    teardownPendingCaptureListener();
    if (mountedRoot?.dataset) delete mountedRoot.dataset.ltBound;
    mountedRoot = null;
    scrollTrackingBound = false;
    runtime.translateQueue = Promise.resolve();
  }

  window.MKLiveTranscribe = { mount, destroy };
})();
