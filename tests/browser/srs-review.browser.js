/**
 * Vocabulary review (SRS) in a real browser (npm run test:browser): the three reliability cases of
 * the Version B closure, against the real service worker and chrome.storage.local.
 *
 *   - duplicate submission: the same rating sent twice for the same card state (a double click or a
 *     retry) is counted once; the second answer is "stale";
 *   - concurrent conflict: two Settings pages rate the same card at the same moment; exactly one
 *     rating is stored, and the page that lost shows the "reviewed elsewhere, skipped" notice;
 *   - worker restart: a rating sent to a stopped worker wakes it and is stored once; a retry of the
 *     old request after the restart is refused as stale, and the state survives another restart.
 *
 * Local only: no provider is called.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { SKIP_REASON, until, launch } = require("./harness");

let env = null;

test.before(async () => {
  if (SKIP_REASON) return;
  env = await launch();
  console.log(`# browser: ${env.version} (major ${env.major})`);
});

test.after(async () => {
  if (env) await env.close();
});

const opts = { skip: SKIP_REASON || false, timeout: 90000 };

async function settingsPage(section = "review") {
  const page = await env.ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e.message || e)));
  await page.goto(`${env.base}/settings.html#${section}`);
  await page.waitForFunction(() => typeof chrome !== "undefined" && chrome.runtime && chrome.storage);
  page.errors = errors;
  return page;
}

const send = (page, message) => page.evaluate((m) => chrome.runtime.sendMessage(m), message);

/** The stored card for a term, read by an extension page */
const card = (page, term) =>
  page.evaluate(async (t) => {
    const d = await chrome.storage.local.get("zehVocabulary");
    return (d.zehVocabulary || []).find((v) => v.term === t) || null;
  }, term);

async function addTerm(page, term) {
  const r = await send(page, { type: "ADD_VOCAB", item: { term, queryType: "word", short_meaning: `${term} meaning`, context_sentence: `A sentence with ${term}.` } });
  assert.equal(r.ok, true, `ADD_VOCAB ${term}: ${JSON.stringify(r)}`);
  const c = await card(page, term);
  assert.ok(c && c.id && c.review, `${term} stored with an id and review state`);
  assert.equal(c.review.reviewCount, 0);
  return c;
}

/** Stop the extension's service worker (CDP from an extension page's session) and watch it restart */
async function stopWorker(page) {
  const cdp = await env.ctx.newCDPSession(page);
  const statuses = [];
  cdp.on("ServiceWorker.workerVersionUpdated", (e) => {
    for (const v of e.versions) if (v.scriptURL.endsWith("/background.js")) statuses.push(v.runningStatus);
  });
  await cdp.send("ServiceWorker.enable");
  await until(() => statuses.length > 0, 5000, "worker status");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await until(() => statuses.at(-1) === "stopped", 10000, "worker stopped");
  const stoppedAt = statuses.length;
  return {
    ranAgain: () => statuses.slice(stoppedAt).includes("running"),
    statuses,
    detach: () => cdp.detach().catch(() => {}),
  };
}

test("srs: the same rating sent twice for one card state is counted once", opts, async () => {
  const page = await settingsPage();
  const c = await addTerm(page, "ledger");
  const msg = { type: "REVIEW_VOCAB", id: c.id, rating: "good", expectedReviewCount: 0 };
  const [a, b] = await Promise.all([send(page, msg), send(page, msg)]);
  const answers = [a, b].map((r) => (r.ok ? "ok" : r.reason)).sort();
  assert.deepEqual(answers, ["ok", "stale"], JSON.stringify([a, b]));
  // a later retry of the same request (for example after a lost answer) is refused too
  const retry = await send(page, msg);
  assert.equal(retry.ok, false);
  assert.equal(retry.reason, "stale");
  assert.equal(retry.review.reviewCount, 1, "stale answer carries the stored state");
  const after = await card(page, "ledger");
  assert.equal(after.review.reviewCount, 1, "one rating stored");
  assert.deepEqual(page.errors, []);
  await page.close();
});

test("srs: two Settings pages rating the same card at the same moment store one rating; the other page skips it", opts, async () => {
  const setup = await settingsPage();
  await addTerm(setup, "quorum");
  await setup.close();

  const [p1, p2] = [await settingsPage(), await settingsPage()];
  for (const p of [p1, p2]) {
    await p.click('[data-review-action="start"]');
    await p.waitForSelector('[data-review-action="reveal"]');
  }
  const termOn = (p) => p.evaluate(() => document.querySelector(".review-term")?.textContent);
  assert.equal(await termOn(p1), await termOn(p2), "both pages show the same card");
  const term = await termOn(p1);
  assert.equal(term, "quorum", "the only due card");
  const before = (await card(p1, term)).review.reviewCount;
  for (const p of [p1, p2]) await p.click('[data-review-action="reveal"]');
  await Promise.all([p1.click('[data-rating="good"]'), p2.click('[data-rating="hard"]')]);

  const notices = async (p) => p.evaluate(() => document.body.innerText);
  await until(async () => /跳过/.test(await notices(p1)) || /跳过/.test(await notices(p2)), 10000, "one page shows the skipped notice");
  const skipped = [/这个词刚在其他页面复习过，已跳过/.test(await notices(p1)), /这个词刚在其他页面复习过，已跳过/.test(await notices(p2))];
  assert.equal(skipped.filter(Boolean).length, 1, "exactly one page lost the race");
  const after = await card(p1, term);
  assert.equal(after.review.reviewCount, before + 1, "exactly one rating stored");
  for (const p of [p1, p2]) {
    assert.deepEqual(p.errors, []);
    await p.close();
  }
});

test("srs: a card rated on one Settings page and then rated on another page that still shows it is skipped there, not counted twice", opts, async () => {
  const setup = await settingsPage();
  await addTerm(setup, "tariff");
  await setup.close();
  const [p1, p2] = [await settingsPage(), await settingsPage()];
  for (const p of [p1, p2]) {
    await p.click('[data-review-action="start"]');
    await p.waitForSelector('[data-review-action="reveal"]');
    assert.equal(await p.evaluate(() => document.querySelector(".review-term")?.textContent), "tariff");
    await p.click('[data-review-action="reveal"]');
  }
  await p1.click('[data-rating="good"]');
  await until(async () => (await card(p1, "tariff")).review.reviewCount === 1, 10000, "first rating stored");
  // the second page has received the storage change (its word list shows the new count) and still shows the card
  await until(() => p2.evaluate(() => vocabulary.find((v) => v.term === "tariff")?.review?.reviewCount === 1), 10000, "second page refreshed");
  assert.equal(await p2.evaluate(() => document.querySelector(".review-term")?.textContent), "tariff");
  await p2.click('[data-rating="hard"]');
  await until(() => p2.evaluate(() => /这个词刚在其他页面复习过，已跳过/.test(document.body.innerText)), 10000, "skipped notice on the second page");
  assert.equal((await card(p1, "tariff")).review.reviewCount, 1, "one rating stored");
  for (const p of [p1, p2]) {
    assert.deepEqual(p.errors, []);
    await p.close();
  }
});

test("srs: a rating sent to a stopped worker is stored once; a retry after the restart is stale; state survives another restart", opts, async () => {
  const page = await settingsPage();
  const c = await addTerm(page, "tenure");
  const stop = await stopWorker(page);
  const msg = { type: "REVIEW_VOCAB", id: c.id, rating: "easy", expectedReviewCount: 0 };
  const first = await send(page, msg);
  assert.equal(first.ok, true, JSON.stringify(first));
  await until(stop.ranAgain, 10000, `worker started again (${stop.statuses.join(" → ")})`);
  await stop.detach();
  const stored = await card(page, "tenure");
  assert.equal(stored.review.reviewCount, 1);
  assert.deepEqual(stored.review, first.review, "the stored state is the one the worker answered with");

  // the worker restarts again; the page retries the old request (its answer was lost): refused, not double counted
  const again = await stopWorker(page);
  const retry = await send(page, msg);
  assert.equal(retry.ok, false);
  assert.equal(retry.reason, "stale");
  await until(again.ranAgain, 10000, `worker started again (${again.statuses.join(" → ")})`);
  await again.detach();
  assert.deepEqual((await card(page, "tenure")).review, first.review, "unchanged by the retry");

  // the next real rating, with the current count, is stored by the restarted worker
  const next = await send(page, { type: "REVIEW_VOCAB", id: c.id, rating: "good", expectedReviewCount: 1 });
  assert.equal(next.ok, true, JSON.stringify(next));
  assert.equal((await card(page, "tenure")).review.reviewCount, 2);
  assert.deepEqual(page.errors, []);
  await page.close();
});
