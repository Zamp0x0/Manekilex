/**
 * Phase 4 Settings → 复习: the real settings.js and background.js share one storage area.
 * The answer stays hidden until it is revealed, ratings go through REVIEW_VOCAB and only
 * then move to the next card, storage updates elsewhere do not reset the session, and a
 * failed save keeps the card so the rating can be retried.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { loadBackground, createStorageArea, createEvent, evalIn, waitFor } = require("./helpers/extension-sandbox");
const { loadSettingsPage } = require("./helpers/settings-page");

const VOCAB = "zehVocabulary";
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function review(extra) {
  return {
    status: "new",
    dueAt: NOW - DAY,
    intervalDays: 0,
    ease: 2.5,
    reviewCount: 0,
    lapseCount: 0,
    lastReviewedAt: null,
    lastRating: null,
    ...(extra || {}),
  };
}

function fixture() {
  return [
    {
      id: "bank",
      serial: 3,
      savedAt: NOW - DAY,
      term: "bank",
      queryType: "word",
      phonetic: "/bæŋk/",
      part_of_speech: "noun",
      short_meaning: "银行；河岸",
      memory_tip: "bank → 银行 / 岸",
      examples: [{ en: "She works at a bank.", zh: "她在银行工作。" }],
      contexts: [
        {
          id: "ctx-finance",
          sentence: "The bank approved my loan.",
          meaning_here: "此处指金融机构：银行",
          sentence_translation: "银行批准了我的贷款。",
          pageTitle: "Money News",
        },
        {
          id: "ctx-river",
          sentence: "We sat on the bank of the river.",
          meaning_here: "此处指河岸",
          sentence_translation: "我们坐在河岸上。",
          pageTitle: "River Walks",
        },
      ],
      review: review(),
    },
    {
      id: "zebra",
      serial: 2,
      savedAt: NOW - 9 * DAY,
      term: "zebra",
      queryType: "word",
      short_meaning: "斑马",
      contexts: [],
      review: review({ status: "review", intervalDays: 4, dueAt: NOW + 2 * DAY, reviewCount: 3 }),
    },
    {
      id: "apple",
      serial: 1,
      savedAt: NOW - 10 * DAY,
      term: "apple",
      queryType: "word",
      short_meaning: "苹果",
      context_meaning: "常见水果",
      contexts: [],
      review: review({ status: "review", intervalDays: 2, dueAt: NOW - HOUR, reviewCount: 2 }),
    },
  ];
}

async function setup(list) {
  const onChanged = createEvent();
  const local = createStorageArea({ [VOCAB]: list || fixture() }, { onChanged });
  const bg = loadBackground({ local, onChanged });
  const sent = [];
  const settings = await loadSettingsPage({
    local,
    onChanged,
    hash: "#review",
    sendMessage: (m) => {
      sent.push(m.type);
      return bg.dispatch(m);
    },
  });
  const run = (code) => vm.runInContext(code, settings.context);
  const setNow = (t) => {
    evalIn(bg.context, `Date.now = () => ${t}`);
    run(`Date.now = () => ${t}`);
  };
  setNow(NOW);
  run("renderReview()");
  const el = (id) => settings.document.getElementById(id);
  const view = () => el("reviewView").innerHTML;
  const stat = (key) => Number((el("reviewStats").innerHTML.match(new RegExp(`data-review-stat="${key}"><span class="review-stat-value">(\\d+)`)) || [])[1]);
  const session = () => JSON.parse(run("JSON.stringify(reviewSession)"));
  const click = (action, rating) => {
    const target = {
      closest: (sel) => (sel === "[data-review-action]" ? { dataset: { reviewAction: action, rating }, disabled: false } : null),
    };
    (el("reviewView")._listeners.click || []).forEach((fn) => fn({ target }));
  };
  const key = (k, tagName = "BODY") =>
    settings.document.dispatchEvent({ type: "keydown", key: k, target: { tagName }, preventDefault() {} });
  const reviewWrites = () => sent.filter((t) => t === "REVIEW_VOCAB").length;
  return { bg, settings, local, run, setNow, el, view, stat, session, click, key, reviewWrites };
}

test("overview: due / new / future counts, the nav badge and a start button", async () => {
  const ui = await setup();
  assert.equal(ui.stat("due"), 1);
  assert.equal(ui.stat("new"), 1);
  assert.equal(ui.stat("future"), 1);
  assert.equal(ui.stat("reviewed"), 0);
  assert.match(ui.view(), /data-review-action="start"/);
  assert.match(ui.view(), /本轮 <strong>2<\/strong> 个：到期 1 · 新词 1/);
  ui.run("updateReviewBadge()");
  assert.equal(ui.el("reviewNavBadge").textContent, "2");
  assert.equal(ui.el("reviewNavBadge").hidden, false);
});

test("empty state when nothing is due", async () => {
  const later = fixture().filter((v) => v.id === "zebra");
  const ui = await setup(later);
  assert.match(ui.view(), /今天没有需要复习的单词/);
  assert.match(ui.view(), /下一个到期/);
  ui.run("updateReviewBadge()");
  assert.equal(ui.el("reviewNavBadge").hidden, true);
});

test("card flow: answer hidden until revealed, rating saved by the worker, then the next card", async () => {
  const ui = await setup();
  ui.click("start");
  assert.deepEqual(ui.session().ids, ["apple", "bank"], "due first, then new");
  let html = ui.view();
  assert.match(html, /1 \/ 2/);
  assert.match(html, /class="review-term">apple</);
  assert.doesNotMatch(html, /基础释义|data-rating=/, "front only: no answer, no rating buttons");

  await ui.run("rateReviewCard('good')");
  assert.equal(ui.reviewWrites(), 0, "cannot rate before revealing");
  assert.equal(ui.session().index, 0);

  ui.click("reveal");
  html = ui.view();
  assert.match(html, /基础释义[\s\S]*苹果/);
  assert.match(html, /用法[\s\S]*常见水果/, "no saved context → lexical usage note");
  for (const [rating, delay] of [["again", "10 分钟"], ["hard", "3 天"], ["good", "5 天"], ["easy", "7 天"]]) {
    assert.match(html, new RegExp(`data-rating="${rating}"[\\s\\S]*?${delay}`));
  }

  await ui.run("rateReviewCard('good')");
  assert.equal(ui.reviewWrites(), 1);
  const apple = ui.local.data[VOCAB].find((v) => v.id === "apple");
  assert.equal(apple.review.intervalDays, 5);
  assert.equal(apple.review.dueAt, NOW + 5 * DAY);
  assert.equal(ui.session().index, 1);
  assert.equal(ui.session().revealed, false);
  assert.equal(ui.stat("reviewed"), 1);
  assert.equal(ui.stat("due"), 0);
  html = ui.view();
  assert.match(html, /2 \/ 2/);
  assert.match(html, /class="review-term">bank</);
  assert.match(html, /\/bæŋk\/ · noun/);

  ui.click("reveal");
  html = ui.view();
  assert.match(html, /当前语境 · 1\/2/);
  assert.match(html, /此处指金融机构：银行/);
  assert.match(html, /The <mark>bank<\/mark> approved my loan\./);
  assert.match(html, /银行批准了我的贷款。/);
  assert.match(html, /Money News/);
  assert.match(html, /助记[\s\S]*bank → 银行 \/ 岸/); // 0.11.1: section renamed to 助记
  assert.match(html, /She works at a bank\./);
  assert.doesNotMatch(html, /undefined|NaN/);
});

test("a storage update from another tab refreshes counts but keeps the session where it is", async () => {
  const ui = await setup();
  ui.run("startReviewSession()");
  ui.run("revealReviewCard()");
  await ui.run("rateReviewCard('good')");
  ui.run("revealReviewCard()");
  const before = ui.session();

  await ui.bg.dispatch({ type: "ADD_VOCAB", item: { term: "charlie", queryType: "word", short_meaning: "c" } }, { tab: { id: 7 } });
  await waitFor(() => ui.settings.vocabulary().length === 4, 1000, "settings sync");
  assert.deepEqual(ui.session(), before, "same ids, index and revealed state");
  assert.match(ui.view(), /当前语境 · 1\/2/, "still showing bank's answer");
  assert.equal(ui.stat("new"), 2, "counts include the new word");

  await ui.run("rateReviewCard('again')");
  assert.match(ui.view(), /本轮完成：复习了 <strong>2<\/strong> 个词/);
  assert.match(ui.view(), /继续复习（1）/, "charlie is new; bank is learning and due in 10 minutes");

  // 11 minutes later bank is due again and its OTHER context is shown
  ui.setNow(NOW + 11 * MIN);
  ui.click("start");
  const charlieId = ui.local.data[VOCAB].find((v) => v.term === "charlie").id;
  assert.deepEqual(ui.session().ids, ["bank", charlieId], "bank (learning, due) before the new word");
  ui.key(" ");
  assert.match(ui.view(), /当前语境 · 2\/2/);
  assert.match(ui.view(), /We sat on the <mark>bank<\/mark> of the river\./);
  assert.match(ui.view(), /此处指河岸/);
});

test("a failed save keeps the card, shows the error, and the same rating can be retried", async () => {
  const ui = await setup();
  ui.run("startReviewSession()");
  ui.run("revealReviewCard()");
  ui.local.failSetWith = new Error("QUOTA_BYTES quota exceeded");
  await ui.run("rateReviewCard('easy')");
  assert.equal(ui.session().index, 0, "did not move on");
  assert.equal(ui.session().reviewed, 0);
  assert.equal(ui.session().pending, false);
  assert.match(ui.view(), /保存失败[\s\S]*本次评分未记录/);
  assert.doesNotMatch(ui.view(), / disabled/, "buttons usable again");
  assert.equal(ui.local.data[VOCAB].find((v) => v.id === "apple").review.reviewCount, 2, "storage unchanged");

  ui.local.failSetWith = null;
  await ui.run("rateReviewCard('easy')");
  assert.equal(ui.session().index, 1);
  assert.equal(ui.local.data[VOCAB].find((v) => v.id === "apple").review.lastRating, "easy");
});

test("a word deleted elsewhere during the session is skipped, not shown", async () => {
  const ui = await setup();
  ui.run("startReviewSession()");
  await ui.bg.dispatch({ type: "DELETE_VOCAB", ids: ["bank"] });
  await waitFor(() => ui.settings.vocabulary().length === 2, 1000, "settings sync");
  ui.run("revealReviewCard()");
  await ui.run("rateReviewCard('hard')");
  assert.match(ui.view(), /本轮完成/);
  assert.match(ui.view(), /已跳过 1 个已删除的词/);
  assert.equal(ui.session().reviewed, 1);
});

test("keyboard: Space / Enter reveal, 1–4 rate; keys typed into inputs are ignored", async () => {
  const ui = await setup();
  ui.run("startReviewSession()");
  ui.key("3");
  assert.equal(ui.reviewWrites(), 0, "no rating before reveal");
  ui.key(" ", "INPUT");
  assert.equal(ui.session().revealed, false);
  ui.key("Enter");
  assert.equal(ui.session().revealed, true);
  ui.key("3", "TEXTAREA");
  assert.equal(ui.reviewWrites(), 0);
  ui.key("3");
  await waitFor(() => ui.session().index === 1, 1000, "rated with key 3");
  assert.equal(ui.local.data[VOCAB].find((v) => v.id === "apple").review.lastRating, "good");
});

test("the vocabulary list shows each word's review state in local time", async () => {
  const ui = await setup();
  ui.run("startReviewSession()");
  ui.run("revealReviewCard()");
  await ui.run("rateReviewCard('good')");
  ui.run("switchSection('vocabulary')");
  const html = ui.settings.listHtml();
  const local = ui.run(`zehFormatLocalTime(${NOW + 5 * DAY})`);
  assert.ok(html.includes(`复习：下次 ${local} · 已复习 3 次`), html);
  assert.match(html, /复习：新词，未复习/);
  // back to review: the finished session is still there
  ui.run("switchSection('review')");
  assert.equal(ui.session().index, 1);
});
