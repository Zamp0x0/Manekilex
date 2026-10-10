/**
 * 设置页分区「流量统计」：按本地自然日聚合请求日志（F5），绘制 7 / 30 天折线图和全年热力图。
 *
 * 加载时只声明。usageLogs 由 settings.js 的 loadAll 填充，「数据」分区清空日志后也会改它。
 * 依赖：settings/core.js（mainBody、escapeHtml）、config.js / shared/providers.js（ZEH_PROVIDER_META）。
 */

let usageRangeDays = 7;
let usageLogs = [];

function filterLogsByDays(days) {
  const start = Date.now() - days * 86400000;
  return usageLogs.filter((l) => l.ts >= start);
}

/** 本地日历日 YYYY-MM-DD：用量图和热力图的格子都是本地午夜，日志也必须按本地日归档（不能用 toISOString 的 UTC 日期） */
function localDayKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function aggregateUsageBuckets(days) {
  const now = new Date();
  const buckets = [];

  if (days === 1) {
    const start = new Date(now);
    start.setMinutes(0, 0, 0);
    start.setHours(start.getHours() - 23);
    for (let i = 0; i < 24; i++) {
      const slot = new Date(start);
      slot.setHours(start.getHours() + i);
      const key = `${slot.getFullYear()}-${String(slot.getMonth() + 1).padStart(2, "0")}-${String(slot.getDate()).padStart(2, "0")} ${String(slot.getHours()).padStart(2, "0")}`;
      const label = `${String(slot.getHours()).padStart(2, "0")}`;
      buckets.push({ key, label, tooltipLabel: `${label}:00 - ${label}:59`, ts: slot.getTime(), byProvider: {} });
    }
    usageLogs.forEach((log) => {
      if (now.getTime() - log.ts > 86400000) return;
      const d = new Date(log.ts);
      d.setMinutes(0, 0, 0);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}`;
      const bucket = buckets.find((b) => b.key === key);
      if (!bucket) return;
      if (!bucket.byProvider[log.provider]) bucket.byProvider[log.provider] = { requests: 0, tokens: 0 };
      bucket.byProvider[log.provider].requests += 1;
      bucket.byProvider[log.provider].tokens += log.totalTokens || 0;
    });
    return buckets;
  }

  const dayCount = days === 7 ? 7 : 30;
  for (let i = dayCount - 1; i >= 0; i--) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - i);
    const key = localDayKey(d);
    buckets.push({
      key,
      label: key.slice(5),
      tooltipLabel: key,
      ts: d.getTime(),
      byProvider: {},
    });
  }

  usageLogs.forEach((log) => {
    if (now.getTime() - log.ts > dayCount * 86400000) return;
    const key = localDayKey(log.ts);
    const bucket = buckets.find((b) => b.key === key);
    if (!bucket) return;
    if (!bucket.byProvider[log.provider]) bucket.byProvider[log.provider] = { requests: 0, tokens: 0 };
    bucket.byProvider[log.provider].requests += 1;
    bucket.byProvider[log.provider].tokens += log.totalTokens || 0;
  });
  return buckets;
}

function drawUsageChart(canvas, buckets, days) {
  const wrap = canvas.parentElement;
  let tooltip = wrap.querySelector(".usage-chart-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.className = "usage-chart-tooltip";
    wrap.appendChild(tooltip);
  }

  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padding = { top: 20, right: 16, bottom: 32, left: 48 };
  const chartW = w - padding.left - padding.right;
  const chartH = h - padding.top - padding.bottom;

  const activeProviders = ZEH_PROVIDER_IDS.filter((pid) =>
    buckets.some((b) => (b.byProvider[pid]?.requests || 0) > 0)
  );

  if (buckets.length === 0 || activeProviders.length === 0) {
    ctx.fillStyle = "#8a6a45";
    ctx.font = "13px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("暂无数据，使用插件查词后会自动记录", w / 2, h / 2 - 8);
    ctx.font = "11px sans-serif";
    ctx.fillText("成功请求将按平台与日期显示在此", w / 2, h / 2 + 14);
    canvas._usagePoints = [];
    tooltip.classList.remove("visible");
    return;
  }

  let maxRequests = 1;
  buckets.forEach((bucket) => {
    activeProviders.forEach((pid) => {
      const v = bucket.byProvider[pid]?.requests || 0;
      if (v > maxRequests) maxRequests = v;
    });
  });

  const yTicks = 4;
  ctx.strokeStyle = "rgba(122, 74, 36, 0.15)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "#8a6a45";
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  for (let i = 0; i <= yTicks; i++) {
    const y = padding.top + (chartH * i) / yTicks;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(padding.left + chartW, y);
    ctx.stroke();
    const val = Math.round(maxRequests * (1 - i / yTicks));
    ctx.fillText(String(val), padding.left - 8, y);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  const labelStep = days === 30 ? 6 : days === 1 ? 3 : 1;
  buckets.forEach((bucket, i) => {
    if (i % labelStep !== 0 && i !== buckets.length - 1) return;
    const x = padding.left + (chartW * i) / Math.max(buckets.length - 1, 1);
    const labelText = days === 1 ? bucket.label : bucket.label;
    ctx.fillStyle = "#8a6a45";
    ctx.font = "10px sans-serif";
    ctx.fillText(labelText, x, h - 10);
  });

  const points = [];

  activeProviders.forEach((pid) => {
    const meta = ZEH_PROVIDER_META[pid];
    ctx.strokeStyle = meta.chartColor;
    ctx.lineWidth = 2;
    ctx.beginPath();
    buckets.forEach((bucket, i) => {
      const requests = bucket.byProvider[pid]?.requests || 0;
      const tokens = bucket.byProvider[pid]?.tokens || 0;
      const x = padding.left + (chartW * i) / Math.max(buckets.length - 1, 1);
      const y = padding.top + chartH - (requests / maxRequests) * chartH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
      points.push({
        x,
        y,
        day: bucket.tooltipLabel,
        provider: pid,
        providerName: meta.name,
        requests,
        tokens,
        color: meta.chartColor,
      });
    });
    ctx.stroke();

    buckets.forEach((bucket, i) => {
      const requests = bucket.byProvider[pid]?.requests || 0;
      const x = padding.left + (chartW * i) / Math.max(buckets.length - 1, 1);
      const y = padding.top + chartH - (requests / maxRequests) * chartH;
      ctx.beginPath();
      ctx.fillStyle = meta.chartColor;
      ctx.arc(x, y, requests > 0 ? 3.5 : 0, 0, Math.PI * 2);
      ctx.fill();
    });
  });

  canvas._usagePoints = points;
}

function setupUsageChartHover(canvas) {
  const wrap = canvas.parentElement;
  const tooltip = wrap.querySelector(".usage-chart-tooltip");
  if (!tooltip) return;

  const hide = () => tooltip.classList.remove("visible");

  canvas.onmousemove = (e) => {
    const points = canvas._usagePoints || [];
    if (!points.length) {
      hide();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    let best = null;
    let bestDist = 14;
    for (const p of points) {
      if (p.requests <= 0) continue;
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    if (!best) {
      hide();
      return;
    }
    const tokenLine = best.tokens > 0 ? `<br>Token：${best.tokens.toLocaleString()}` : "";
    tooltip.innerHTML = `<strong>${escapeHtml(best.day)}</strong><br>${escapeHtml(best.providerName)}<br>请求：${best.requests}${tokenLine}`;
    tooltip.classList.add("visible");
    const wrapRect = wrap.getBoundingClientRect();
    let left = e.clientX - wrapRect.left + 12;
    let top = e.clientY - wrapRect.top - 8;
    if (left + 160 > wrapRect.width) left = e.clientX - wrapRect.left - 170;
    if (top < 4) top = 4;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  };

  canvas.onmouseleave = hide;
}

function buildYearHeatmapData(year) {
  const map = {};
  usageLogs.forEach((log) => {
    const d = new Date(log.ts);
    if (d.getFullYear() !== year) return;
    const key = localDayKey(d);
    if (!map[key]) map[key] = { requests: 0, tokens: 0 };
    map[key].requests += 1;
    map[key].tokens += log.totalTokens || 0;
  });
  return map;
}

function getYearHeatmapWeeks(year) {
  const weeks = [];
  const start = new Date(year, 0, 1);
  start.setDate(start.getDate() - start.getDay());
  const endLimit = new Date(year, 11, 31);
  const cursor = new Date(start);
  while (weeks.length < 54) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      week.push(new Date(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
    const lastDay = week[6];
    if (lastDay >= endLimit && lastDay.getDay() === 6) break;
    if (cursor.getFullYear() > year && cursor.getMonth() > 0) break;
  }
  return weeks;
}

function heatEncouragement(count) {
  if (count <= 0) return "今天稍微休息一下也没关系";
  if (count <= 3) return "稳稳前进中";
  if (count <= 10) return "今天也在努力了";
  if (count <= 30) return "这天很努力哦";
  return "今天火力全开";
}

function heatColorByTokens(tokens) {
  if (tokens <= 0) return "#eee8dc";
  if (tokens <= 500) return "#cdecc8";
  if (tokens <= 3000) return "#8fd18b";
  if (tokens <= 10000) return "#43a85f";
  return "#1f7a3a";
}

const HEAT_LEGEND_LEVELS = [
  { sample: 0, label: "0 Token" },
  { sample: 250, label: "1 – 500 Token" },
  { sample: 1500, label: "501 – 3,000 Token" },
  { sample: 6000, label: "3,001 – 10,000 Token" },
  { sample: 15000, label: "10,001+ Token" },
];

function weekMonthIndex(week, year) {
  const ref = week[4];
  if (ref.getFullYear() === year) return ref.getMonth();
  const inYear = week.find((d) => d.getFullYear() === year);
  return inYear ? inYear.getMonth() : -1;
}

function buildMonthLabelCells(weeks, year) {
  const cells = [];
  let i = 0;
  while (i < weeks.length) {
    const month = weekMonthIndex(weeks[i], year);
    let span = 1;
    while (i + span < weeks.length && weekMonthIndex(weeks[i + span], year) === month) {
      span += 1;
    }
    const names = ["1月", "2月", "3月", "4月", "5月", "6月", "7月", "8月", "9月", "10月", "11月", "12月"];
    cells.push({ text: month >= 0 ? names[month] : "", span });
    i += span;
  }
  return cells;
}

function renderUsageHeatmap() {
  const year = new Date().getFullYear();
  const dayMap = buildYearHeatmapData(year);
  const weeks = getYearHeatmapWeeks(year);
  const monthCells = buildMonthLabelCells(weeks, year);

  const cells = [];
  weeks.forEach((week) => {
    week.forEach((day) => {
      const inYear = day.getFullYear() === year;
      const key = localDayKey(day);
      const stat = dayMap[key] || { requests: 0, tokens: 0 };
      cells.push({
        key,
        inYear,
        requests: inYear ? stat.requests : 0,
        tokens: inYear ? stat.tokens : 0,
        label: `${key} · ${stat.requests} 次 · ${(stat.tokens || 0).toLocaleString()} Token`,
        sub: inYear ? heatEncouragement(stat.requests) : "",
      });
    });
  });

  return `
    <div class="usage-heatmap-wrap" id="usageYearHeatmap">
      <div class="usage-heatmap-head">
        <span class="usage-heatmap-title">${year} 年活跃热力图</span>
      </div>
      <div class="heat-month-row" style="grid-template-columns: repeat(${weeks.length}, 1fr)">
        ${monthCells.map((m) => `<span class="heat-month-label" style="grid-column: span ${m.span}">${m.text}</span>`).join("")}
      </div>
      <div class="heat-grid" style="grid-template-columns: repeat(${weeks.length}, 1fr)">
        ${cells
          .map(
            (c) =>
              `<div class="usage-heat-cell ${c.inYear ? "" : "usage-heat-cell--pad"}" data-label="${escapeHtml(c.label)}"${c.sub ? ` data-sub="${escapeHtml(c.sub)}"` : ""} style="background:${c.inYear ? heatColorByTokens(c.tokens) : "transparent"}"></div>`
          )
          .join("")}
      </div>
      <div class="usage-heat-legend">
        <span>Less</span>
        ${HEAT_LEGEND_LEVELS.map(
          (lv) =>
            `<span class="usage-heat-dot" data-label="${escapeHtml(lv.label)}" style="background:${heatColorByTokens(lv.sample)}"></span>`
        ).join("")}
        <span>More</span>
      </div>
    </div>
  `;
}

function getUsageHeatTooltip() {
  let tooltip = document.getElementById("usageHeatTooltipFloat");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "usageHeatTooltipFloat";
    tooltip.className = "usage-heat-tooltip";
    document.body.appendChild(tooltip);
  }
  return tooltip;
}

function placeUsageHeatTooltip(tooltip, e) {
  const pad = 10;
  tooltip.style.position = "fixed";
  tooltip.style.left = "0px";
  tooltip.style.top = "0px";
  const tw = tooltip.offsetWidth || 160;
  const th = tooltip.offsetHeight || 40;
  let left = e.clientX + pad;
  let top = e.clientY - th - pad;
  if (left + tw > window.innerWidth - 8) left = e.clientX - tw - pad;
  if (top < 8) top = e.clientY + pad;
  if (top + th > window.innerHeight - 8) top = Math.max(8, e.clientY - th - pad);
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}

function setupYearHeatmapHover() {
  const wrap = document.getElementById("usageYearHeatmap");
  if (!wrap) return;
  const tooltip = getUsageHeatTooltip();

  const hide = () => tooltip.classList.remove("visible");

  const showHeatTooltip = (el, e) => {
    const main = el.dataset.label || "";
    const sub = el.dataset.sub || "";
    tooltip.textContent = sub ? `${main}\n${sub}` : main;
    tooltip.classList.add("visible");
    placeUsageHeatTooltip(tooltip, e);
    requestAnimationFrame(() => placeUsageHeatTooltip(tooltip, e));
  };

  const bindHeatTooltip = (el) => {
    el.addEventListener("mouseenter", (e) => showHeatTooltip(el, e));
    el.addEventListener("mousemove", (e) => {
      if (!tooltip.classList.contains("visible")) return;
      placeUsageHeatTooltip(tooltip, e);
    });
    el.addEventListener("mouseleave", hide);
  };

  wrap.querySelectorAll(".usage-heat-cell:not(.usage-heat-cell--pad)").forEach(bindHeatTooltip);
  wrap.querySelectorAll(".usage-heat-dot").forEach(bindHeatTooltip);
}

function renderUsage() {
  const floatTip = document.getElementById("usageHeatTooltipFloat");
  if (floatTip) floatTip.classList.remove("visible");

  const logs = filterLogsByDays(usageRangeDays);
  const totalReq = logs.length;
  const totalTokens = logs.reduce((s, l) => s + (l.totalTokens || 0), 0);
  const buckets = aggregateUsageBuckets(usageRangeDays);

  mainBody.innerHTML = `
    <div class="usage-toolbar">
      ${[1, 7, 30]
        .map(
          (d) =>
            `<button type="button" class="usage-tab ${usageRangeDays === d ? "active" : ""}" data-days="${d}">近 ${d === 1 ? "1 天" : d + " 天"}</button>`
        )
        .join("")}
    </div>
    <div class="usage-stats">
      <div class="stat-box"><strong>${totalReq}</strong><span>请求次数</span></div>
      <div class="stat-box"><strong>${totalTokens.toLocaleString()}</strong><span>Token 合计</span></div>
    </div>
    <div class="usage-main">
      <div class="usage-chart-wrap">
        <canvas id="usageChart"></canvas>
        <div class="usage-chart-tooltip"></div>
      </div>
      ${renderUsageHeatmap()}
    </div>
    <div class="legend">
      ${ZEH_PROVIDER_IDS.map((pid) => {
        const meta = ZEH_PROVIDER_META[pid];
        const hasData = logs.some((l) => l.provider === pid);
        if (!hasData) return "";
        return `<span class="legend-item"><span class="legend-color" style="background:${meta.chartColor}"></span>${escapeHtml(meta.name)}</span>`;
      }).join("")}
    </div>
    <p class="hint" style="margin-top:12px;color:#999;font-size:12px;">说明：统计来自本机记录，仅包含成功请求；切换模型后折线颜色对应各平台。</p>
  `;

  document.querySelectorAll(".usage-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      usageRangeDays = Number(btn.dataset.days);
      renderUsage();
    });
  });

  const canvas = document.getElementById("usageChart");
  drawUsageChart(canvas, buckets, usageRangeDays);
  setupUsageChartHover(canvas);
  setupYearHeatmapHover();
}
