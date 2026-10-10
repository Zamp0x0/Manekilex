/**
 * F5: usage chart and year heatmap count each lookup on the user's local calendar day.
 *
 * Both used to key days with Date#toISOString() (a UTC date) while the buckets and heatmap cells
 * are local midnights. In any time zone east of UTC a local midnight is the previous UTC date, so
 * every bucket was labelled one day early and a log was counted on the wrong day.
 *
 * Each test sets the zone explicitly; node --test runs every file in its own process.
 */
process.env.TZ = "Asia/Shanghai";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createStorageArea, createEvent } = require("./helpers/extension-sandbox");
const { loadSettingsPage } = require("./helpers/settings-page");

const DAY = 86400000;

function localKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function at(base, hours, minutes = 0) {
  const d = new Date(base);
  d.setHours(hours, minutes, 0, 0);
  return d;
}

function log(ts, totalTokens = 100) {
  return { ts: ts.getTime(), provider: "deepseek", model: "deepseek-flash", totalTokens, queryType: "word" };
}

async function pageWithLogs(logs) {
  const onChanged = createEvent();
  const local = createStorageArea({ zehUsageLogs: logs }, { onChanged });
  return loadSettingsPage({ local, onChanged, sendMessage: async () => ({}) });
}

/** The heatmap's data-label of every cell, in grid order (weeks of 7 days from the Sunday before Jan 1). */
function heatmapLabels(html) {
  return [...html.matchAll(/class="usage-heat-cell[^"]*" data-label="([^"]*)"/g)].map((m) => m[1]);
}

function heatmapIndex(day) {
  const start = new Date(day.getFullYear(), 0, 1);
  start.setDate(start.getDate() - start.getDay());
  let i = 0;
  const cursor = new Date(start);
  while (localKey(cursor) !== localKey(day)) {
    cursor.setDate(cursor.getDate() + 1);
    i += 1;
  }
  return i;
}

for (const zone of ["Asia/Shanghai", "America/Los_Angeles"]) {
  test(`F5 (${zone}): a lookup at 09:00 local time is counted on that local day in the 7- and 30-day chart`, async () => {
    process.env.TZ = zone;
    const yesterday = new Date(Date.now() - DAY);
    const morning = at(yesterday, 9);
    const evening = at(yesterday, 23, 30);
    const page = await pageWithLogs([log(morning, 100), log(evening, 50)]);
    for (const days of [7, 30]) {
      const buckets = page.evalIn(`JSON.stringify(aggregateUsageBuckets(${days}))`);
      const list = JSON.parse(buckets);
      assert.equal(list.length, days);
      const day = list.find((b) => b.ts === at(yesterday, 0).getTime());
      assert.ok(day, "a bucket starts at yesterday's local midnight");
      assert.equal(day.key, localKey(yesterday), "bucket key is the local date");
      assert.equal(day.label, localKey(yesterday).slice(5));
      assert.deepEqual(day.byProvider.deepseek, { requests: 2, tokens: 150 }, `${days}-day chart`);
      const total = list.reduce((n, b) => n + (b.byProvider.deepseek?.requests || 0), 0);
      assert.equal(total, 2, "no log is counted twice or lost");
      const today = list[list.length - 1];
      assert.equal(today.key, localKey(new Date()), "the last bucket is today");
    }
  });

  test(`F5 (${zone}): the year heatmap puts a 09:00 lookup in that local day's cell`, async () => {
    process.env.TZ = zone;
    const year = new Date().getFullYear();
    const day = new Date(year, 0, 15);
    const page = await pageWithLogs([log(at(day, 9), 700), log(at(day, 23, 30), 300)]);
    const labels = heatmapLabels(page.evalIn("renderUsageHeatmap()"));
    const cell = labels[heatmapIndex(day)];
    assert.match(cell, new RegExp(`^${localKey(day)} · 2 次 · 1,000 Token$`));
    const counted = labels.filter((l) => !/ · 0 次 · /.test(l));
    assert.deepEqual(counted, [cell], "exactly one cell has requests");
  });
}
