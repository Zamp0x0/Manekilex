/**
 * R-06 / R-12: every vocabulary mutation runs in the service worker, one at a time,
 * on the latest stored list. Settings deletes through the worker and follows
 * storage.onChanged, so it can no longer erase words added elsewhere.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  loadBackground,
  createStorageArea,
  createEvent,
  evalIn,
  sleep,
  waitFor,
} = require("./helpers/extension-sandbox");
const { loadSettingsPage } = require("./helpers/settings-page");

const VOCAB = "zehVocabulary";

function word(term, extra) {
  return { term, queryType: "word", short_meaning: `${term} 的意思`, pageUrl: "https://example.test/a", ...extra };
}

function savedEntry(term, serial) {
  return {
    id: `saved-${serial}`,
    serial,
    savedAt: 1700000000000 + serial,
    savedAtLocal: "2023-11-14 22:13",
    ...word(term),
    examples: [{ en: `${term} example`, zh: "例句" }],
    memory_tip: "legacy field kept as-is",
  };
}

function terms(list) {
  return (list || []).map((v) => v.term);
}

/** Background + Settings page sharing one chrome.storage.local, like the real extension. */
async function loadExtension(initial) {
  const onChanged = createEvent();
  const local = createStorageArea(initial, { onChanged });
  const bg = loadBackground({ local, onChanged });
  const settings = await loadSettingsPage({ local, onChanged, sendMessage: (m) => bg.dispatch(m) });
  return { bg, settings, local, onChanged };
}

// ── service worker ───────────────────────────────────────────────────────────

test("ADD_VOCAB saves an entry with id / serial / time and keeps the payload fields", async () => {
  const bg = loadBackground({ storage: { [VOCAB]: [savedEntry("prayer", 4)] } });
  const res = await bg.dispatch({ type: "ADD_VOCAB", item: word("committee") });
  assert.equal(res.ok, true);
  assert.equal(res.added, true);
  assert.equal(res.serial, 5);
  const list = bg.local.data[VOCAB];
  assert.deepEqual(terms(list), ["committee", "prayer"], "newest first");
  assert.equal(list[0].id, res.id);
  assert.ok(list[0].savedAt && list[0].savedAtLocal);
  assert.equal(list[0].short_meaning, "committee 的意思");
  assert.deepEqual(list[1], savedEntry("prayer", 4), "existing entries untouched");
});

test("ADD_VOCAB still rejects duplicates (case-insensitive) without writing", async () => {
  const bg = loadBackground({ storage: { [VOCAB]: [savedEntry("Prayer", 1)] } });
  const writesBefore = bg.local.setCalls.length;
  const res = await bg.dispatch({ type: "ADD_VOCAB", item: word(" prayer ") });
  assert.deepEqual(res, { ok: true, added: false, reason: "duplicate" });
  assert.equal(bg.local.setCalls.length, writesBefore);
});

test("ADD_VOCAB with no term returns a clear invalid result", async () => {
  const bg = loadBackground();
  const res = await bg.dispatch({ type: "ADD_VOCAB", item: { term: "  " } });
  assert.equal(res.ok, false);
  assert.equal(res.added, false);
  assert.equal(res.reason, "invalid");
  assert.equal(bg.local.data[VOCAB], undefined);
});

test("R-12: near-simultaneous adds from several tabs are all kept with unique serials", async () => {
  const bg = loadBackground({ storage: { [VOCAB]: [savedEntry("prayer", 1)] } });
  const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"];
  const results = await Promise.all(
    words.map((t, i) => bg.dispatch({ type: "ADD_VOCAB", item: word(t) }, { tab: { id: i + 1 } }))
  );
  results.forEach((r) => assert.equal(r.added, true));
  const list = bg.local.data[VOCAB];
  assert.equal(list.length, words.length + 1);
  assert.deepEqual(new Set(terms(list)), new Set(["prayer", ...words]));
  const serials = list.map((v) => v.serial);
  assert.equal(new Set(serials).size, serials.length, "no duplicate serials");
  assert.deepEqual(results.map((r) => r.serial).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9]);
});

test("R-12: the same word added twice at once is saved once", async () => {
  const bg = loadBackground();
  const [a, b] = await Promise.all([
    bg.dispatch({ type: "ADD_VOCAB", item: word("echo") }),
    bg.dispatch({ type: "ADD_VOCAB", item: word("Echo") }),
  ]);
  assert.deepEqual([a.added, b.reason], [true, "duplicate"]);
  assert.equal(bg.local.data[VOCAB].length, 1);
});

test("R-06: DELETE_VOCAB removes only the requested entry", async () => {
  const bg = loadBackground({
    storage: { [VOCAB]: [savedEntry("alpha", 3), savedEntry("bravo", 2), savedEntry("charlie", 1)] },
  });
  const res = await bg.dispatch({ type: "DELETE_VOCAB", ids: ["saved-2"] });
  assert.deepEqual(res, { ok: true, removed: 1 });
  assert.deepEqual(terms(bg.local.data[VOCAB]), ["alpha", "charlie"]);
});

test("R-06: an add and a delete issued together both land", async () => {
  const bg = loadBackground({ storage: { [VOCAB]: [savedEntry("alpha", 2), savedEntry("bravo", 1)] } });
  const [added, deleted] = await Promise.all([
    bg.dispatch({ type: "ADD_VOCAB", item: word("charlie") }),
    bg.dispatch({ type: "DELETE_VOCAB", ids: ["saved-1"] }),
  ]);
  assert.equal(added.added, true);
  assert.equal(deleted.removed, 1);
  assert.deepEqual(terms(bg.local.data[VOCAB]), ["charlie", "alpha"]);
});

test("DELETE_VOCAB of an unknown id succeeds without rewriting storage", async () => {
  const bg = loadBackground({ storage: { [VOCAB]: [savedEntry("alpha", 1)] } });
  const writesBefore = bg.local.setCalls.length;
  assert.deepEqual(await bg.dispatch({ type: "DELETE_VOCAB", ids: ["missing"] }), { ok: true, removed: 0 });
  assert.equal(bg.local.setCalls.length, writesBefore);
  assert.equal((await bg.dispatch({ type: "DELETE_VOCAB", ids: [] })).ok, false);
});

test("a failed storage write returns ok:false and the queue keeps working", async () => {
  const bg = loadBackground({ storage: { [VOCAB]: [savedEntry("alpha", 1)] } });
  bg.local.failSetWith = new Error("QUOTA_BYTES quota exceeded");
  const add = await bg.dispatch({ type: "ADD_VOCAB", item: word("bravo") });
  assert.equal(add.ok, false);
  assert.equal(add.added, false);
  assert.equal(add.reason, "error");
  assert.match(add.message, /QUOTA_BYTES/);
  const del = await bg.dispatch({ type: "DELETE_VOCAB", ids: ["saved-1"] });
  assert.equal(del.ok, false);
  assert.deepEqual(terms(bg.local.data[VOCAB]), ["alpha"], "nothing changed");

  bg.local.failSetWith = null;
  const retry = await bg.dispatch({ type: "ADD_VOCAB", item: word("bravo") });
  assert.equal(retry.added, true);
  assert.deepEqual(terms(bg.local.data[VOCAB]), ["bravo", "alpha"]);
});

test("the vocabulary book still keeps only the newest 2000 entries", async () => {
  const existing = Array.from({ length: 2000 }, (_, i) => savedEntry(`w${i}`, 2000 - i));
  const bg = loadBackground({ storage: { [VOCAB]: existing } });
  const res = await bg.dispatch({ type: "ADD_VOCAB", item: word("newest") });
  assert.equal(res.serial, 2001);
  const list = bg.local.data[VOCAB];
  assert.equal(list.length, 2000);
  assert.equal(list[0].term, "newest");
  assert.equal(list[1999].term, "w1998");
});

test("R-12: concurrent usage-log appends are not lost, and clearing is ordered with them", async () => {
  const bg = loadBackground();
  await evalIn(bg.context, "Promise.all([1, 2, 3, 4, 5].map((i) => appendUsageLog({ ts: i })))");
  assert.deepEqual(bg.local.data.zehUsageLogs.map((l) => l.ts), [1, 2, 3, 4, 5]);

  const appendLate = evalIn(bg.context, "appendUsageLog({ ts: 6 })");
  const cleared = bg.dispatch({ type: "CLEAR_USAGE_LOGS" });
  await Promise.all([appendLate, cleared]);
  assert.deepEqual(bg.local.data.zehUsageLogs, [], "clear ran after the queued append");
});

test("settings migration with no providers no longer resets an existing vocabulary", async () => {
  const bg = loadBackground({ storage: { [VOCAB]: [savedEntry("alpha", 1)], zehUsageLogs: [{ ts: 1 }] } });
  await evalIn(bg.context, "migrateLegacySettings()");
  assert.ok(bg.local.data.zehProviders, "providers initialised");
  assert.deepEqual(terms(bg.local.data[VOCAB]), ["alpha"]);
  assert.equal(bg.local.data.zehUsageLogs.length, 1);
});

// ── Settings page ────────────────────────────────────────────────────────────

test("Settings shows words added in another tab while it is open (storage.onChanged)", async () => {
  const { bg, settings } = await loadExtension({ [VOCAB]: [savedEntry("alpha", 1)] });
  assert.deepEqual(terms(settings.vocabulary()), ["alpha"]);

  await bg.dispatch({ type: "ADD_VOCAB", item: word("bravo") });
  await waitFor(() => settings.vocabulary().length === 2, 1000, "settings sync");
  assert.deepEqual(terms(settings.vocabulary()), ["bravo", "alpha"]);
  assert.match(settings.listHtml(), /bravo/);
});

test("Settings keeps the current search when the list refreshes", async () => {
  const { bg, settings } = await loadExtension({ [VOCAB]: [savedEntry("alpha", 1)] });
  settings.setSearch("bra");
  await bg.dispatch({ type: "ADD_VOCAB", item: word("bravo") });
  await bg.dispatch({ type: "ADD_VOCAB", item: word("charlie") });
  await waitFor(() => settings.vocabulary().length === 3, 1000, "settings sync");
  assert.match(settings.listHtml(), /bravo/);
  assert.doesNotMatch(settings.listHtml(), /charlie|alpha/);
});

test("R-06: deleting in a stale Settings page does not erase a word added elsewhere", async () => {
  const { bg, settings, local } = await loadExtension({
    [VOCAB]: [savedEntry("alpha", 2), savedEntry("bravo", 1)],
  });
  settings.detachStorageListener(); // worst case: the page never saw the new word
  await bg.dispatch({ type: "ADD_VOCAB", item: word("charlie") }, { tab: { id: 9 } });
  assert.deepEqual(terms(settings.vocabulary()), ["alpha", "bravo"], "page is stale");

  await settings.clickDelete("saved-2"); // delete "alpha"
  assert.deepEqual(terms(local.data[VOCAB]), ["charlie", "bravo"], "charlie survives");
  assert.deepEqual(terms(settings.vocabulary()), ["bravo"]);
  assert.equal(settings.alerts.length, 0);
});

test("R-06: Settings delete goes through the service worker and never writes the array itself", async () => {
  const { settings, local } = await loadExtension({
    [VOCAB]: [savedEntry("alpha", 2), savedEntry("bravo", 1)],
  });
  await settings.clickDelete("saved-1");
  await sleep(5);
  assert.deepEqual(terms(local.data[VOCAB]), ["alpha"]);
  assert.equal(settings.pageSets.filter((keys) => keys.includes(VOCAB)).length, 0);
  assert.deepEqual(terms(settings.vocabulary()), ["alpha"]);
});

test("Settings shows a failed delete and keeps the entry", async () => {
  const { settings, local } = await loadExtension({ [VOCAB]: [savedEntry("alpha", 1)] });
  local.failSetWith = new Error("QUOTA_BYTES quota exceeded");
  await settings.clickDelete("saved-1");
  assert.equal(settings.alerts.length, 1);
  assert.match(settings.alerts[0], /QUOTA_BYTES|删除失败/);
  assert.deepEqual(terms(settings.vocabulary()), ["alpha"], "not removed from the page");
  assert.deepEqual(terms(local.data[VOCAB]), ["alpha"]);
});

test("Settings first-run migration does not write the vocabulary key", async () => {
  const onChanged = createEvent();
  const local = createStorageArea({ [VOCAB]: [savedEntry("alpha", 1)] }, { onChanged });
  const bg = loadBackground({ local, onChanged });
  const settings = await loadSettingsPage({ local, onChanged, sendMessage: (m) => bg.dispatch(m) });
  assert.ok(local.data.zehProviders, "migration ran");
  assert.equal(settings.pageSets.filter((keys) => keys.includes(VOCAB)).length, 0);
  assert.deepEqual(terms(local.data[VOCAB]), ["alpha"]);
});
