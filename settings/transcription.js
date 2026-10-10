/**
 * 设置页分区「实时转译」：只负责渲染界面骨架并把它交给 live-transcribe.js（window.MKLiveTranscribe）。
 *
 * 离开本分区时由 settings/core.js 的 switchSection 调用 MKLiveTranscribe.destroy()。
 * 依赖：settings/core.js（mainBody）、live-transcribe.js（在 settings.html 里先于本文件加载）。
 */

function renderLiveTranscribe() {
  mainBody.innerHTML = `
    <div class="lt-layout">
      <aside class="lt-sidebar">
        <div class="lt-card">
          <h3 class="lt-card-title">AI 配置</h3>
          <p class="lt-card-desc">AssemblyAI Key 保存在本机 <code>chrome.storage.local</code>；WebSocket 使用 temporary token，不会在前端暴露 Key。清空输入框后点「保存 Key」即从本机删除。</p>
          <label class="lt-label" for="ltApiKey">AssemblyAI API Key</label>
          <input type="password" id="ltApiKey" class="lt-input lt-input-full" autocomplete="off" placeholder="在此粘贴 AssemblyAI API Key" spellcheck="false" />
          <div class="lt-actions lt-actions-col">
            <button type="button" class="mk-btn mk-btn-secondary mk-btn-sm lt-btn-full" id="ltSaveKeyBtn">保存 Key</button>
          </div>
          <label class="lt-label" for="ltTranslateProvider">翻译模型</label>
          <select id="ltTranslateProvider" class="lt-input lt-input-full lt-select" aria-label="实时转译翻译模型"></select>
          <p class="lt-provider-hint" id="ltProviderHint">仅列出已在「模型与 API」配置 Key 的平台，与划词启用的模型相互独立。</p>
          <dl class="lt-meta-list">
            <div class="lt-meta-row">
              <dt>AssemblyAI</dt>
              <dd class="lt-meta-value" id="ltConnStatus">未连接</dd>
            </div>
            <div class="lt-meta-row">
              <dt>音频输入</dt>
              <dd class="lt-meta-value" id="ltInputStatus">未开启</dd>
            </div>
            <div class="lt-meta-row">
              <dt>输入音量</dt>
              <dd class="lt-meta-value lt-mic-level-wrap">
                <span id="ltMicLevel">0%</span>
                <div class="lt-mic-level-bar-track"><div class="lt-mic-level-bar" id="ltMicLevelBar"></div></div>
              </dd>
            </div>
          </dl>
        </div>

        <div class="lt-card">
          <h3 class="lt-card-title">录音控制</h3>
          <p class="lt-card-desc">中文翻译使用下方所选模型；与「模型与 API」里划词启用的 provider 无关，不走查词缓存。</p>
          <fieldset class="lt-turn-field">
            <legend class="lt-label">翻译模式</legend>
            <label class="lt-source-option">
              <input type="radio" name="ltTurnMode" value="precise" checked />
              <span>精确模式（仅 final 句翻译）</span>
            </label>
            <label class="lt-source-option">
              <input type="radio" name="ltTurnMode" value="caption" />
              <span>字幕模式（英文/中文实时同传窗口）</span>
            </label>
          </fieldset>
          <fieldset class="lt-turn-field">
            <legend class="lt-label">断句速度</legend>
            <label class="lt-source-option">
              <input type="radio" name="ltEndpointingPreset" value="fast" />
              <span>快速</span>
            </label>
            <label class="lt-source-option">
              <input type="radio" name="ltEndpointingPreset" value="standard" checked />
              <span>标准</span>
            </label>
            <label class="lt-source-option">
              <input type="radio" name="ltEndpointingPreset" value="stable" />
              <span>稳定</span>
            </label>
            <p class="lt-turn-hint">断句速度影响 AssemblyAI 何时判定一句话结束。字幕模式下，英文 partial 和中文 partial 实时刷新；当内容过长或检测到句末时，会自动要求 AssemblyAI 结束当前句。</p>
          </fieldset>
          <fieldset class="lt-source-field">
            <legend class="lt-label">输入来源</legend>
            <label class="lt-source-option">
              <input type="radio" name="ltSourceMode" value="microphone" checked />
              <span>麦克风</span>
            </label>
            <label class="lt-source-option">
              <input type="radio" name="ltSourceMode" value="tab" />
              <span>标签页声音</span>
            </label>
            <p class="lt-tab-capture-guide">标签页捕获须先切到目标网页，点击 Manekilex 扩展图标 →「捕获当前标签页声音」。若此处直接开始失败，请从扩展按钮授权。</p>
            <p class="lt-tab-hint" id="ltTabCaptureHint"></p>
          </fieldset>
          <div class="lt-actions lt-actions-col">
            <button type="button" class="mk-btn mk-btn-primary mk-btn-sm lt-btn-full" id="ltStartBtn">开始录音</button>
            <button type="button" class="mk-btn mk-btn-secondary mk-btn-sm lt-btn-full" id="ltStopBtn" disabled>停止录音</button>
            <button type="button" class="mk-btn mk-btn-secondary mk-btn-sm lt-btn-full" id="ltTranslateBtn">翻译当前句</button>
            <button type="button" class="mk-btn mk-btn-secondary mk-btn-sm lt-btn-full" id="ltCopyBtn">复制双语</button>
            <button type="button" class="mk-btn mk-btn-secondary mk-btn-sm lt-btn-full" id="ltExportBilingualBtn">导出双语文档</button>
            <button type="button" class="mk-btn mk-btn-secondary mk-btn-sm lt-btn-full" id="ltExportEnglishBtn">导出英文文档</button>
            <button type="button" class="mk-btn mk-btn-secondary mk-btn-sm lt-btn-full" id="ltClearBtn">清空</button>
          </div>
          <div class="status-msg lt-status" id="ltStatus"></div>
        </div>
      </aside>

      <div class="lt-main">
        <div class="lt-card lt-transcript-card lt-transcript-panel">
          <div class="lt-transcript-panel-header">
            <h3 class="lt-card-title">English Transcript</h3>
            <button type="button" class="mk-btn mk-btn-secondary mk-btn-sm lt-follow-btn" id="ltFollowLatestBtn" title="滚动到最新字幕">跟随最新</button>
          </div>
          <div class="lt-live-current-label">当前英文</div>
          <div class="lt-live-current-scroll" id="ltCurrentEnScroll">
            <div class="lt-live-current-box" id="liveCurrentEnglish" aria-live="polite"></div>
          </div>
          <div class="lt-history-label">最近英文</div>
          <div class="lt-transcript-panel-body" id="ltEnglishScroll">
            <div class="lt-history-list" id="englishHistoryList"></div>
          </div>
        </div>

        <div class="lt-card lt-transcript-card lt-transcript-panel">
          <div class="lt-transcript-panel-header">
            <h3 class="lt-card-title">中文翻译</h3>
          </div>
          <div class="lt-live-current-label">当前中文</div>
          <div class="lt-live-current-scroll" id="ltCurrentZhScroll">
            <div class="lt-live-current-box lt-live-current-zh" id="liveCurrentChinese" aria-live="polite"></div>
          </div>
          <div class="lt-history-label">最近中文</div>
          <div class="lt-transcript-panel-body" id="ltChineseScroll">
            <div class="lt-history-list" id="chineseHistoryList"></div>
          </div>
        </div>
      </div>
    </div>
  `;

  window.MKLiveTranscribe?.mount?.(mainBody);
}
