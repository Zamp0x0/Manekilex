/**
 * lookup/tts.js — 单词发音（M7 从 mk-lookup.js 拆出）。
 *
 * zehCreateLookupSpeech(host) 为一个查词控制器生成发音函数：挑选英语语音、监听 voiceschanged、
 * 用一次静音朗读预热 Web Speech API（减少第一次点「发音」的冷启动延迟），以及朗读文本。
 * 选中的语音与「已预热」标记留在工厂闭包里，每个控制器一份，与拆分前相同。
 * host（由 createController 提供）：
 *   win   控制器所在窗口（speechSynthesis / SpeechSynthesisUtterance 从这里取）
 * 加载：与 lookup/dom-helpers.js 一样只声明，所有查词宿主都在 mk-lookup.js 之前加载 lookup/ 下的文件。
 */

/**
 * 一个查词控制器的发音函数。
 * @param {{ win: Window }} host
 */
function zehCreateLookupSpeech(host) {
  const win = host.win;

  let ttsPreferredVoice = null;
  let ttsWarmStarted = false;

  // ── 发音预热（Web Speech API 冷启动优化）────────────────────────────────────

  function pickPreferredEnglishVoice(voices) {
    if (!voices?.length) return null;
    const en = voices.filter((v) => (v.lang || "").toLowerCase().startsWith("en"));
    if (!en.length) return null;
    return (
      en.find((v) => v.localService) ||
      en.find((v) => (v.lang || "").toLowerCase().startsWith("en-us")) ||
      en[0]
    );
  }

  function refreshSpeechVoices() {
    const synth = win.speechSynthesis;
    if (!synth) return;
    const voices = synth.getVoices();
    if (voices.length) {
      ttsPreferredVoice = pickPreferredEnglishVoice(voices);
    }
  }

  function warmSpeechSynthesis() {
    const synth = win.speechSynthesis;
    if (!synth) return;

    refreshSpeechVoices();

    if (ttsWarmStarted) return;
    ttsWarmStarted = true;

    const onVoicesChanged = () => refreshSpeechVoices();
    if (typeof synth.addEventListener === "function") {
      synth.addEventListener("voiceschanged", onVoicesChanged);
    } else {
      synth.onvoiceschanged = onVoicesChanged;
    }

    try {
      const utterance = new win.SpeechSynthesisUtterance("\u200b");
      utterance.volume = 0;
      utterance.rate = 10;
      utterance.lang = "en-US";
      if (ttsPreferredVoice) utterance.voice = ttsPreferredVoice;
      utterance.onend = () => refreshSpeechVoices();
      utterance.onerror = () => {};
      synth.speak(utterance);
      if (synth.paused) synth.resume();
    } catch {
      /* noop */
    }
  }

  function speakText(text) {
    if (!text) return;
    try {
      const synth = win.speechSynthesis;
      if (!synth) return;
      warmSpeechSynthesis();
      refreshSpeechVoices();
      synth.cancel();
      const utterance = new win.SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      utterance.rate = 0.92;
      if (ttsPreferredVoice) utterance.voice = ttsPreferredVoice;
      synth.speak(utterance);
      if (synth.paused) synth.resume();
    } catch {
      /* noop */
    }
  }

  return {
    warmSpeechSynthesis,
    speakText,
  };
}
