/**
 * lookup/egg.js — Manekilex 彩蛋动画（M7 从 mk-lookup.js 拆出）。
 *
 * zehCreateLookupEasterEgg(host) 为一个查词控制器生成彩蛋函数：判断结果是否触发彩蛋、预载图片、
 * 等面板布局稳定后启动弹幕与掉落动画，以及面板关闭时清掉计时器和动画节点。
 * 动画状态（计时器、弹幕调度器、测量节点）留在工厂闭包里，每个控制器一份，与拆分前相同。
 * host（由 createController 提供）：
 *   win / uiDoc          控制器所在窗口与挂载面板的文档
 *   cachedText()         当前查询的文本（结果缺 term 时判断彩蛋用）
 *   cachedRect()         当前选区矩形（彩蛋面板变高后重新定位用）
 *   panel()              当前结果面板，没有时为 null
 *   positionNearRect(…)  控制器的面板定位函数
 *   extensionAsset(p)    扩展内图片的 URL
 * 加载：与 lookup/dom-helpers.js 一样只声明，所有查词宿主都在 mk-lookup.js 之前加载 lookup/ 下的文件。
 */

/**
 * 一个查词控制器的 Manekilex 彩蛋。
 * @param {{ win: Window, uiDoc: Document, cachedText: Function, cachedRect: Function, panel: Function, positionNearRect: Function, extensionAsset: Function }} host
 */
function zehCreateLookupEasterEgg(host) {
  const win = host.win;
  const uiDoc = host.uiDoc;
  const positionNearRect = host.positionNearRect;
  const extensionAsset = host.extensionAsset;

  // ── Manekilex 彩蛋动画 ────────────────────────────────────────────────────

  const MANEKILEX_EGG_EMOJIS = [
    "🐱", "😺", "😸", "😻", "😽", "🐈", "🐈‍⬛", "🧧", "🪙", "💰", "💸", "💵", "💴", "💶", "💷",
    "💎", "🏆", "🍀", "✨", "🌟", "⭐", "💫", "🎊", "🎉", "🧨", "🏮", "🔮", "🙏", "🎆", "🎇",
  ];
  const MANEKILEX_EGG_MAX_LIVE = 56;
  const MANEKILEX_EGG_SPAWN_MS = 220;
  let manekilexEggSpawnTimer = null;
  let manekilexEggLayer = null;

  const MANEKILEX_BARRAGE_LANES = 18;
  const MANEKILEX_BARRAGE_TOP_START = 40;
  const MANEKILEX_BARRAGE_BOTTOM_PAD = 20;
  const MANEKILEX_BARRAGE_TICK_MS = 180;
  const MANEKILEX_BARRAGE_MAX_LIVE = 88;
  const MANEKILEX_BARRAGE_DURATION_MIN = 9;
  const MANEKILEX_BARRAGE_DURATION_MAX = 14;
  const MANEKILEX_BARRAGE_SAFE_GAP_MIN = 80;
  const MANEKILEX_BARRAGE_SAFE_GAP_MAX = 160;
  const MANEKILEX_BARRAGE_LANE_JITTER_MIN = 600;
  const MANEKILEX_BARRAGE_LANE_JITTER_MAX = 1800;
  let manekilexBarrageScheduler = null;
  let manekilexBarrageMeasureEl = null;
  let manekilexBarrageLayout = {
    lanes: MANEKILEX_BARRAGE_LANES,
    topStart: MANEKILEX_BARRAGE_TOP_START,
    laneHeight: 42,
  };
  let manekilexFinalizeToken = 0;

  const MANEKILEX_PRELOAD_ASSETS = [
    "icons/lucky1.png",
    "icons/lucky2.png",
    "icons/css_5.png",
  ];

  const MANEKILEX_BLESSINGS = [
    "财源滚滚", "招财进宝", "金玉满堂", "富贵吉祥", "吉祥如意", "大吉大利",
    "心想事成", "万事如意", "一本万利", "日进斗金", "八方来财", "步步高升",
    "前程似锦", "鸿运当头", "好运连连", "财运亨通", "年年有余", "岁岁平安",
    "福星高照", "紫气东来", "蒸蒸日上", "事业高升", "学业进步", "平安喜乐",
    "顺风顺水", "所愿皆成", "富贵满堂", "喜气洋洋", "春风得意", "福气满满",
    "吉星高照", "喜事连连", "万象更新", "福运绵长", "财气冲天", "鸿运连年",
    "福禄双全", "好运常在", "财来运转", "顺遂无忧", "瑞气盈门", "金榜题名",
    "平步青云", "大展宏图", "福满人间", "诸事顺遂", "时来运转", "好运爆棚",
    "喜从天降", "福到运到", "吉庆有余", "财福双至", "好运加倍", "吉祥满满",
    "恭喜发财", "财源广进", "富贵安康", "天天好运", "顺顺利利", "开门见喜",
    "发财暴富", "事业腾飞", "学业有成", "一路生花", "灵感满满", "好运加身",
    "逢考必过", "读啥会啥", "写啥过啥", "发财暴击", "快乐翻倍", "欧气满满",
    "福气加倍", "喜发大财", "星星高照", "利是大吉", "福禄寿喜", "五福临门",
    "龙马精神", "马到成功", "百业兴旺", "门庭生辉", "花开富贵", "竹报平安",
  ];
  const MANEKILEX_BARRAGE_EMOJI = ["🧧", "🪙", "💰", "✨", "🌟", "🎉", "🍀", "🏮"];

  function isManekilexEggResult(result) {
    if (shouldPlayManekilexEasterEgg(result)) return true;
    if (typeof zehIsManekilexTerm === "function") {
      const term = result?.term || result?.word || host.cachedText() || "";
      return zehIsManekilexTerm(term);
    }
    return false;
  }

  function shouldPlayManekilexEasterEgg(result) {
    if (!result || typeof result !== "object") return false;
    const term = String(result.term || result.word || "")
      .trim();
    if (typeof zehIsManekilexTerm === "function" && zehIsManekilexTerm(term)) return true;
    if (result.source === "special") return true;
    if (result.specialEntry === true) return true;
    return false;
  }

  function cleanupManekilexEasterEgg(targetPanel) {
    manekilexFinalizeToken += 1;
    destroyManekilexBarrageScheduler();
    manekilexBarrageLayout = {
      lanes: MANEKILEX_BARRAGE_LANES,
      topStart: MANEKILEX_BARRAGE_TOP_START,
      laneHeight: 42,
    };
    if (manekilexBarrageMeasureEl) {
      manekilexBarrageMeasureEl.remove();
      manekilexBarrageMeasureEl = null;
    }
    if (manekilexEggSpawnTimer) {
      clearInterval(manekilexEggSpawnTimer);
      manekilexEggSpawnTimer = null;
    }
    manekilexEggLayer = null;
    if (targetPanel) {
      targetPanel.classList.remove("mk-manekilex-panel", "mk-manekilex-ready");
      delete targetPanel.dataset.eggRainStarted;
      targetPanel.querySelectorAll(".mk-easter-egg-layer, .mk-easter-egg").forEach((el) => {
        el.remove();
      });
      const eggEl = targetPanel.querySelector(".mk-manekilex-egg");
      if (eggEl) {
        eggEl.classList.remove("mk-manekilex-ready");
        delete eggEl.dataset.danmakuStarted;
        delete eggEl.dataset.mkBarrageFontSize;
        eggEl.querySelector(".mk-manekilex-danmaku")?.replaceChildren();
      }
    }
  }

  function nextAnimationFrame() {
    return new Promise((resolve) => win.requestAnimationFrame(resolve));
  }

  function waitForImage(img) {
    if (!img) return Promise.resolve();
    if (img.complete && img.naturalWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
      img.addEventListener("load", resolve, { once: true });
      img.addEventListener("error", resolve, { once: true });
    });
  }

  function preloadManekilexAssetUrls() {
    return Promise.allSettled(
      MANEKILEX_PRELOAD_ASSETS.map((path) => {
        const img = new Image();
        img.decoding = "async";
        img.src = extensionAsset(path);
        return waitForImage(img);
      })
    );
  }

  async function waitForManekilexLayout(eggEl, maxAttempts = 10) {
    for (let i = 0; i < maxAttempts; i += 1) {
      const danmakuEl = eggEl.querySelector(".mk-manekilex-danmaku");
      const width = danmakuEl?.offsetWidth || eggEl.offsetWidth;
      const height = danmakuEl?.offsetHeight || eggEl.offsetHeight;
      if (width >= 400 && height >= 320) return true;
      await nextAnimationFrame();
    }
    return false;
  }

  function markManekilexEggReady(eggEl, targetPanel) {
    if (!eggEl) return;
    eggEl.classList.add("mk-manekilex-ready");
    targetPanel?.classList.add("mk-manekilex-ready");
  }

  function startManekilexBarrageOnce(eggEl) {
    if (!eggEl?.isConnected) return;
    if (eggEl.dataset.danmakuStarted === "1") return;

    const danmakuEl = eggEl.querySelector(".mk-manekilex-danmaku");
    if (!danmakuEl) return;

    const height = danmakuEl.offsetHeight || eggEl.offsetHeight;
    const width = danmakuEl.offsetWidth || eggEl.offsetWidth;
    if (height < 320 || width < 400) {
      win.requestAnimationFrame(() => startManekilexBarrageOnce(eggEl));
      return;
    }

    eggEl.dataset.danmakuStarted = "1";
    delete danmakuEl.dataset.mkBarrageFontSize;
    startManekilexBarrage(danmakuEl);
  }

  function startManekilexEggRain(targetPanel) {
    if (!targetPanel) return;
    if (win.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (targetPanel.dataset.eggRainStarted === "1") return;
    targetPanel.dataset.eggRainStarted = "1";

    const layer = uiDoc.createElement("div");
    layer.className = "mk-easter-egg-layer";
    layer.setAttribute("aria-hidden", "true");
    targetPanel.appendChild(layer);
    manekilexEggLayer = layer;

    function spawnBatch() {
      if (!manekilexEggLayer || !host.panel() || !host.panel().contains(layer)) return;
      const batch = 2 + Math.floor(Math.random() * 4);
      for (let i = 0; i < batch; i++) spawnManekilexEggPiece(layer);
    }

    spawnBatch();
    manekilexEggSpawnTimer = win.setInterval(spawnBatch, MANEKILEX_EGG_SPAWN_MS);
  }

  async function finalizeManekilexEasterEggPanel(targetPanel) {
    if (!targetPanel) return;

    const token = ++manekilexFinalizeToken;
    targetPanel.classList.add("mk-manekilex-panel");

    const eggEl = targetPanel.querySelector(".mk-manekilex-egg");
    if (!eggEl) return;

    eggEl.classList.remove("mk-manekilex-ready");
    targetPanel.classList.remove("mk-manekilex-ready");
    delete eggEl.dataset.danmakuStarted;
    delete targetPanel.dataset.eggRainStarted;

    const heroImgs = [...eggEl.querySelectorAll("img")];
    const headerCat = targetPanel.querySelector(".zeh-panel-header-cat");
    const domImgs = headerCat ? [...heroImgs, headerCat] : heroImgs;

    await Promise.allSettled([preloadManekilexAssetUrls(), ...domImgs.map(waitForImage)]);
    if (token !== manekilexFinalizeToken || !targetPanel.isConnected) return;

    await nextAnimationFrame();
    await nextAnimationFrame();
    if (token !== manekilexFinalizeToken || !targetPanel.isConnected) return;

    positionNearRect(
      targetPanel,
      host.cachedRect() || { right: 100, bottom: 100, top: 80, left: 80 },
      true
    );

    await waitForManekilexLayout(eggEl);
    if (token !== manekilexFinalizeToken || !targetPanel.isConnected) return;

    markManekilexEggReady(eggEl, targetPanel);

    positionNearRect(
      targetPanel,
      host.cachedRect() || { right: 100, bottom: 100, top: 80, left: 80 },
      true
    );

    startManekilexBarrageOnce(eggEl);
    startManekilexEggRain(targetPanel);
  }

  function shuffleManekilexArray(list) {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }

  function pickManekilexBarrageEmoji() {
    return MANEKILEX_BARRAGE_EMOJI[Math.floor(Math.random() * MANEKILEX_BARRAGE_EMOJI.length)];
  }

  function pickManekilexBarrageText() {
    const base = MANEKILEX_BLESSINGS[Math.floor(Math.random() * MANEKILEX_BLESSINGS.length)];
    const roll = Math.random();
    if (roll < 0.08) {
      return `${pickManekilexBarrageEmoji()}${pickManekilexBarrageEmoji()}${base}`;
    }
    if (roll < 0.33) {
      return `${pickManekilexBarrageEmoji()}${base}`;
    }
    return base;
  }

  function syncManekilexBarrageLayout(danmakuEl) {
    if (!danmakuEl) return 1000;

    const width = danmakuEl.offsetWidth || danmakuEl.parentElement?.offsetWidth || 1000;
    const height = danmakuEl.offsetHeight || danmakuEl.parentElement?.offsetHeight || 760;
    danmakuEl.style.setProperty("--mk-panel-w", `${width}px`);

    const topStart = MANEKILEX_BARRAGE_TOP_START;
    const bottomPad = MANEKILEX_BARRAGE_BOTTOM_PAD;
    const lanes = MANEKILEX_BARRAGE_LANES;
    const usable = Math.max(320, height - topStart - bottomPad);
    const laneHeight = Math.max(38, usable / lanes);

    manekilexBarrageLayout = { lanes, topStart, laneHeight };
    return width;
  }

  function ensureManekilexBarrageMeasureEl(danmakuEl) {
    if (manekilexBarrageMeasureEl?.isConnected) return manekilexBarrageMeasureEl;

    const probe = uiDoc.createElement("span");
    probe.className = "mk-manekilex-danmaku-item mk-manekilex-danmaku-measure";
    probe.style.visibility = "hidden";
    probe.style.position = "absolute";
    probe.style.left = "-9999px";
    probe.style.top = "0";
    probe.style.animation = "none";
    probe.style.pointerEvents = "none";
    danmakuEl.appendChild(probe);
    manekilexBarrageMeasureEl = probe;
    return probe;
  }

  function measureManekilexBarrageText(danmakuEl, text) {
    const probe = ensureManekilexBarrageMeasureEl(danmakuEl);
    probe.textContent = text;
    return probe.getBoundingClientRect().width || 0;
  }

  function createManekilexBarrageLanes(danmakuEl) {
    syncManekilexBarrageLayout(danmakuEl);
    const layout = manekilexBarrageLayout;
    const now = performance.now();

    return Array.from({ length: layout.lanes }, (_, index) => ({
      index,
      top: layout.topStart + index * layout.laneHeight,
      nextAt: now + Math.random() * 1200,
      lastSpawnAt: 0,
    }));
  }

  function refreshManekilexBarrageLaneTops(scheduler) {
    syncManekilexBarrageLayout(scheduler.danmakuEl);
    const layout = manekilexBarrageLayout;
    scheduler.lanes.forEach((lane) => {
      lane.top = layout.topStart + lane.index * layout.laneHeight;
    });
  }

  function scheduleManekilexLaneNext(lane, separationMs) {
    const jitter =
      MANEKILEX_BARRAGE_LANE_JITTER_MIN +
      Math.random() * (MANEKILEX_BARRAGE_LANE_JITTER_MAX - MANEKILEX_BARRAGE_LANE_JITTER_MIN);
    lane.nextAt = performance.now() + separationMs + jitter * 0.35 + Math.random() * 420;
  }

  function countManekilexLiveDanmaku(danmakuEl) {
    if (!danmakuEl) return 0;
    let count = 0;
    for (const child of danmakuEl.children) {
      if (child.classList?.contains("mk-manekilex-danmaku-measure")) continue;
      count += 1;
    }
    return count;
  }

  function spawnManekilexDanmakuInLane(scheduler, lane) {
    const danmakuEl = scheduler.danmakuEl;
    if (!danmakuEl?.isConnected) return false;
    if (countManekilexLiveDanmaku(danmakuEl) >= MANEKILEX_BARRAGE_MAX_LIVE) return false;

    const text = pickManekilexBarrageText();
    const panelW = syncManekilexBarrageLayout(danmakuEl);
    const textW = measureManekilexBarrageText(danmakuEl, text);
    const duration =
      MANEKILEX_BARRAGE_DURATION_MIN +
      Math.random() * (MANEKILEX_BARRAGE_DURATION_MAX - MANEKILEX_BARRAGE_DURATION_MIN);
    const safeGap =
      MANEKILEX_BARRAGE_SAFE_GAP_MIN +
      Math.random() * (MANEKILEX_BARRAGE_SAFE_GAP_MAX - MANEKILEX_BARRAGE_SAFE_GAP_MIN);
    const travelDistance = panelW + textW;
    const speedPxPerSec = travelDistance / duration;
    const separationMs = ((textW + safeGap) / speedPxPerSec) * 1000;

    const item = uiDoc.createElement("span");
    item.className = "mk-manekilex-danmaku-item";
    item.textContent = text;
    item.style.top = `${lane.top}px`;
    item.style.animationDuration = `${duration.toFixed(2)}s`;
    item.style.animationDelay = "0s";
    item.style.opacity = String(0.72 + Math.random() * 0.12);
    item.addEventListener(
      "animationend",
      () => {
        item.remove();
      },
      { once: true }
    );
    danmakuEl.appendChild(item);

    lane.lastSpawnAt = performance.now();
    scheduler.lastLaneIndex = lane.index;
    scheduleManekilexLaneNext(lane, separationMs);
    return true;
  }

  function pickManekilexAvailableLanes(scheduler) {
    const now = performance.now();
    const ready = scheduler.lanes.filter((lane) => now >= lane.nextAt);
    if (ready.length === 0) return [];

    shuffleManekilexArray(ready);

    if (scheduler.lastLaneIndex >= 0 && ready.length > 1) {
      ready.sort((a, b) => {
        const distA = Math.abs(a.index - scheduler.lastLaneIndex);
        const distB = Math.abs(b.index - scheduler.lastLaneIndex);
        const scoreA = distA + Math.random() * 1.6;
        const scoreB = distB + Math.random() * 1.6;
        return scoreB - scoreA;
      });
    }

    return ready;
  }

  function tickManekilexBarrageScheduler() {
    const scheduler = manekilexBarrageScheduler;
    if (!scheduler) return;

    const danmakuEl = scheduler.danmakuEl;
    if (!danmakuEl?.isConnected || !host.panel()?.classList.contains("mk-manekilex-panel")) {
      destroyManekilexBarrageScheduler();
      return;
    }

    refreshManekilexBarrageLaneTops(scheduler);

    const available = pickManekilexAvailableLanes(scheduler);
    if (available.length === 0) return;

    const spawnCount = Math.min(1 + Math.floor(Math.random() * 3), available.length);

    for (let i = 0; i < spawnCount; i += 1) {
      if (countManekilexLiveDanmaku(danmakuEl) >= MANEKILEX_BARRAGE_MAX_LIVE) break;
      spawnManekilexDanmakuInLane(scheduler, available[i]);
    }
  }

  function destroyManekilexBarrageScheduler() {
    if (manekilexBarrageScheduler?.timerId) {
      clearInterval(manekilexBarrageScheduler.timerId);
    }
    manekilexBarrageScheduler = null;
  }

  function startManekilexBarrage(danmakuEl) {
    if (!danmakuEl || win.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const height = danmakuEl.offsetHeight || danmakuEl.parentElement?.offsetHeight || 0;
    const width = danmakuEl.offsetWidth || danmakuEl.parentElement?.offsetWidth || 0;
    if (height < 320 || width < 400) return;

    destroyManekilexBarrageScheduler();

    const lanes = createManekilexBarrageLanes(danmakuEl);
    const now = performance.now();

    shuffleManekilexArray(lanes)
      .slice(0, Math.min(10, lanes.length))
      .forEach((lane) => {
        lane.nextAt = now + Math.random() * 500;
      });

    manekilexBarrageScheduler = {
      danmakuEl,
      lanes,
      lastLaneIndex: -1,
      timerId: win.setInterval(tickManekilexBarrageScheduler, MANEKILEX_BARRAGE_TICK_MS),
    };

    tickManekilexBarrageScheduler();
  }

  function spawnManekilexEggPiece(layer) {
    const piece = uiDoc.createElement("span");
    piece.className = "mk-easter-egg-fall mk-easter-egg";
    piece.textContent =
      MANEKILEX_EGG_EMOJIS[Math.floor(Math.random() * MANEKILEX_EGG_EMOJIS.length)];
    piece.style.left = `${2 + Math.random() * 96}%`;
    const size = 16 + Math.floor(Math.random() * 14);
    piece.style.fontSize = `${size}px`;
    piece.style.setProperty("--mk-drift", String(Math.random()));
    const duration = 2.6 + Math.random() * 2.4;
    piece.style.animationDuration = `${duration.toFixed(2)}s`;
    piece.style.animationDelay = `${(Math.random() * 0.4).toFixed(2)}s`;
    piece.addEventListener(
      "animationend",
      () => {
        piece.remove();
      },
      { once: true }
    );
    layer.appendChild(piece);
    while (layer.children.length > MANEKILEX_EGG_MAX_LIVE) {
      layer.firstChild?.remove();
    }
  }

  return {
    isManekilexEggResult,
    cleanupManekilexEasterEgg,
    finalizeManekilexEasterEggPanel,
  };
}
