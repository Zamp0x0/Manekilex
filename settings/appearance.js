/**
 * 设置页隐藏分区「小球颜色」（appearance）：导航里没有入口，#appearance 会被 normalizeNavSection 改成 usage，
 * 只能由 switchSection("appearance") 打开。保留原样。
 *
 * 依赖：settings/core.js（themeState、mainBody、storageSet、applySettingsTheme、normalizeBallTheme）。
 */

function showThemeStatus(msg, type) {
  const el = document.getElementById("themeStatus");
  if (el) {
    el.textContent = msg;
    el.className = "status-msg " + (type || "");
  }
}

function renderAppearance() {
  const t = normalizeBallTheme(themeState);

  mainBody.innerHTML = `
    <div class="theme-grid">
      <div class="theme-block">
        <h3>小球颜色</h3>
        <p class="theme-note">自定义划词小球颜色，其他界面使用 Manekilex 固定品牌色。</p>
        <div class="theme-row">
          <label>渐变起点 <input type="color" id="ballStart" value="${t.ballStart}" /></label>
          <label>渐变终点 <input type="color" id="ballEnd" value="${t.ballEnd}" /></label>
          <label>预览 <span class="theme-preview-ball" id="previewBall"></span></label>
        </div>
      </div>
    </div>
    <div class="theme-actions mk-save-ball-row">
      <button type="button" class="mk-btn mk-btn-primary mk-btn-md mk-btn-cat mk-btn-cat-left mk-save-ball-btn" id="saveThemeBtn">
        <img class="mk-btn-cat-img mk-btn-cat-md" src="icons/css_1.png" alt="" />
        <span>保存小球颜色</span>
      </button>
      <button type="button" class="mk-btn mk-btn-secondary mk-btn-md" id="resetThemeBtn">恢复默认</button>
    </div>
    <p id="themeStatus" class="status-msg"></p>
  `;

  const els = {
    ballStart: document.getElementById("ballStart"),
    ballEnd: document.getElementById("ballEnd"),
    previewBall: document.getElementById("previewBall"),
    themeStatus: document.getElementById("themeStatus"),
  };

  function updatePreview() {
    themeState = normalizeBallTheme({
      ballStart: els.ballStart.value,
      ballEnd: els.ballEnd.value,
    });
    els.previewBall.style.background = `linear-gradient(135deg, ${themeState.ballStart}, ${themeState.ballEnd})`;
    applySettingsTheme(themeState);
  }

  updatePreview();

  [els.ballStart, els.ballEnd].forEach((input) => {
    input.addEventListener("input", () => {
      updatePreview();
    });
  });

  document.getElementById("saveThemeBtn").addEventListener("click", async () => {
    updatePreview();
    try {
      await storageSet({ [ZEH_STORAGE.theme]: themeState });
      applySettingsTheme(themeState);
      showThemeStatus("小球颜色已保存，刷新网页后划词即可看到效果", "ok");
    } catch (error) {
      showThemeStatus(error.message || "保存失败，请刷新页面后重试", "err");
    }
  });

  document.getElementById("resetThemeBtn").addEventListener("click", async () => {
    themeState = normalizeBallTheme(zehDefaultTheme());
    try {
      await storageSet({ [ZEH_STORAGE.theme]: themeState });
      applySettingsTheme(themeState);
      renderAppearance();
    } catch (error) {
      showThemeStatus(error.message || "重置失败，请刷新页面后重试", "err");
    }
  });
}
