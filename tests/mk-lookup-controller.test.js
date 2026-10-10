/**
 * mk-lookup.js controller lifecycle with a tiny fake DOM:
 * R-01 (bfcache), R-03 (render errors), R-35 (stale callbacks), page-side timeout,
 * and single error rendering per lookup.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadLookupController, disposeLookupControllers } = require("./helpers/fake-dom");
const { sleep } = require("./helpers/extension-sandbox");

test.afterEach(() => disposeLookupControllers());

const SENTENCE = "The committee postponed the vote until the next quarterly meeting.";
const OTHER = "A second, unrelated sentence arrives while the first one is still loading.";
const RECT = { left: 10, top: 10, right: 60, bottom: 30, width: 50, height: 20 };

function startLookup(env, text = SENTENCE) {
  assert.equal(env.controller.lookupText(text), true);
  const requests = env.explainRequests();
  return requests[requests.length - 1].message.queryId;
}

function showTrigger(env, text = "postponed") {
  env.controller.presentTrigger({ text, rect: RECT, releaseX: 40, releaseY: 30 });
  return env.controller.hasTrigger();
}

test("lookup sends EXPLAIN with a queryId and shows a loading panel", () => {
  const env = loadLookupController();
  const queryId = startLookup(env);
  assert.ok(queryId);
  assert.equal(env.controller.isPending(), true);
  assert.match(env.panelBodyHtml(), /zeh-spinner/);
});

test("R-03: malformed result fields are rendered safely (difficult_phrases: [null])", () => {
  const env = loadLookupController();
  const queryId = startLookup(env, SENTENCE);
  env.deliver({
    type: "SHOW_RESULT",
    queryId,
    queryType: "paragraph",
    data: {
      queryType: "paragraph",
      translation: "委员会把投票推迟到下次季度会议。",
      difficult_phrases: [null, { phrase: "postpone", meaning: "推迟" }],
      key_phrases: [null],
    },
  });
  assert.equal(env.hasRefreshBanner(), false, "must not show the extension-invalidated banner");
  assert.equal(env.controller.isExtensionAlive(), true);
  assert.equal(env.controller.isPending(), false);
  assert.match(env.panelBodyHtml(), /委员会把投票推迟/);
  assert.match(env.panelBodyHtml(), /postpone/);
});

test("R-03: a renderer exception shows a recoverable error and later lookups still work", () => {
  const env = loadLookupController();
  const original = env.context.zehSanitizeLookupResult;
  env.context.zehSanitizeLookupResult = () => {
    throw new TypeError("Cannot read properties of null (reading 'phrase')");
  };
  const q1 = startLookup(env);
  env.deliver({ type: "SHOW_RESULT", queryId: q1, data: { translation: "x" } });

  assert.equal(env.hasRefreshBanner(), false);
  assert.equal(env.controller.isExtensionAlive(), true);
  assert.equal(env.controller.isPending(), false, "spinner stops");
  assert.match(env.panelBodyHtml(), /结果显示失败/);

  env.context.zehSanitizeLookupResult = original;
  const q2 = startLookup(env, OTHER);
  assert.notEqual(q2, q1);
  env.deliver({
    type: "SHOW_RESULT",
    queryId: q2,
    queryType: "sentence",
    data: { queryType: "sentence", translation: "第二句的翻译" },
  });
  assert.match(env.panelBodyHtml(), /第二句的翻译/);
});

test("R-03: a genuinely invalidated extension context still shows the refresh banner", () => {
  const env = loadLookupController();
  const q1 = startLookup(env);
  env.runtime.id = undefined; // what Chrome does after the extension is reloaded
  env.context.zehSanitizeLookupResult = () => {
    throw new Error("Extension context invalidated.");
  };
  env.deliver({ type: "SHOW_RESULT", queryId: q1, data: {} });
  assert.equal(env.hasRefreshBanner(), true);
});

test("R-35: after Esc, a late EXPLAIN callback does not reopen the panel", () => {
  const env = loadLookupController();
  startLookup(env);
  env.controller.hideAll(); // Esc / close button
  assert.equal(env.controller.hasPanel(), false);
  env.respond(0, { accepted: false, code: "NO_API_KEY", message: "请先配置 API Key" });
  assert.equal(env.controller.hasPanel(), false);
});

test("R-35: after Esc, late SHOW_RESULT / SHOW_ERROR for that query are ignored", () => {
  const env = loadLookupController();
  const q1 = startLookup(env);
  env.controller.hideAll();
  env.deliver({ type: "SHOW_RESULT", queryId: q1, data: { translation: "迟到" } });
  env.deliver({ type: "SHOW_ERROR", queryId: q1, message: "迟到的错误" });
  assert.equal(env.controller.hasPanel(), false);
});

test("stale responses from an older query cannot overwrite a newer lookup", () => {
  const env = loadLookupController();
  const q1 = startLookup(env, SENTENCE);
  const q2 = startLookup(env, OTHER);
  assert.notEqual(q1, q2);

  env.respond(0, { accepted: false, code: "NO_API_KEY", message: "旧回调" });
  env.deliver({ type: "SHOW_ERROR", queryId: q1, message: "旧错误" });
  env.deliver({ type: "SHOW_RESULT", queryId: q1, data: { translation: "旧结果" } });
  assert.equal(env.controller.isPending(), true, "newer lookup is still loading");
  assert.match(env.panelBodyHtml(), /zeh-spinner/);
  assert.doesNotMatch(env.panelBodyHtml(), /旧/);

  env.deliver({
    type: "SHOW_RESULT",
    queryId: q2,
    queryType: "sentence",
    data: { queryType: "sentence", translation: "新结果" },
  });
  assert.match(env.panelBodyHtml(), /新结果/);
});

test("one rejected lookup renders one error (SHOW_ERROR then a rejected response)", () => {
  const env = loadLookupController();
  const q1 = startLookup(env);
  env.deliver({ type: "SHOW_ERROR", queryId: q1, message: "第一条错误" });
  env.respond(0, { accepted: false, code: "EMPTY", message: "第二条错误" });
  assert.match(env.panelBodyHtml(), /第一条错误/);
  assert.doesNotMatch(env.panelBodyHtml(), /第二条错误/);
});

test("non-API-key rejections show a plain error, API-key rejections keep the settings button", () => {
  const env = loadLookupController();
  startLookup(env);
  env.respond(0, { accepted: false, code: "disabled", message: "Manekilex 已关闭" });
  assert.match(env.panelBodyHtml(), /Manekilex 已关闭/);
  assert.doesNotMatch(env.panelBodyHtml(), /mk-btn-settings-inline/);

  startLookup(env, OTHER);
  env.respond(1, { accepted: false, code: "NO_API_KEY", message: "请先配置" });
  assert.match(env.panelBodyHtml(), /mk-btn-settings-inline/);
});

test("page-side timeout stops the spinner, ignores the late result, and allows a new lookup", async () => {
  const env = loadLookupController();
  env.context.zehLookupClientTimeoutMs = () => 30;
  const q1 = startLookup(env);
  await sleep(60);
  assert.equal(env.controller.isPending(), false);
  assert.match(env.panelBodyHtml(), /超时/);

  env.deliver({ type: "SHOW_RESULT", queryId: q1, data: { translation: "迟到的结果" } });
  assert.doesNotMatch(env.panelBodyHtml(), /迟到的结果/);

  const q2 = startLookup(env, OTHER);
  env.deliver({
    type: "SHOW_RESULT",
    queryId: q2,
    queryType: "sentence",
    data: { queryType: "sentence", translation: "正常结果" },
  });
  assert.match(env.panelBodyHtml(), /正常结果/);
});

test("a terminal message clears the page-side timeout", async () => {
  const env = loadLookupController();
  env.context.zehLookupClientTimeoutMs = () => 30;
  const q1 = startLookup(env);
  env.deliver({
    type: "SHOW_RESULT",
    queryId: q1,
    queryType: "sentence",
    data: { queryType: "sentence", translation: "按时返回" },
  });
  await sleep(60);
  assert.match(env.panelBodyHtml(), /按时返回/);
  assert.doesNotMatch(env.panelBodyHtml(), /超时/);
});

test("R-01: the bubble still works after a back/forward-cache round trip", () => {
  const env = loadLookupController();
  assert.equal(showTrigger(env), true);

  env.window.dispatchEvent({ type: "pagehide", persisted: true });
  assert.equal(env.controller.hasTrigger(), false, "UI is cleared when the page is cached");
  env.window.dispatchEvent({ type: "pageshow", persisted: true });

  assert.equal(showTrigger(env), true, "bubble appears after restore");
  const q = startLookup(env);
  env.deliver({
    type: "SHOW_RESULT",
    queryId: q,
    queryType: "sentence",
    data: { queryType: "sentence", translation: "恢复后的结果" },
  });
  assert.match(env.panelBodyHtml(), /恢复后的结果/);
});

test("R-01: a lookup pending when the page entered bfcache cannot reopen it after restore", () => {
  const env = loadLookupController();
  const q1 = startLookup(env);
  env.window.dispatchEvent({ type: "pagehide", persisted: true });
  env.window.dispatchEvent({ type: "pageshow", persisted: true });
  env.deliver({ type: "SHOW_RESULT", queryId: q1, data: { translation: "缓存前的结果" } });
  env.respond(0, { accepted: false, code: "NO_API_KEY", message: "缓存前的回调" });
  assert.equal(env.controller.hasPanel(), false);
  assert.equal(env.controller.isPending(), false);
});

test("R-01: a real unload destroys the controller; a later bfcache restore revives it", () => {
  const env = loadLookupController();
  env.window.dispatchEvent({ type: "pagehide", persisted: false });
  assert.equal(showTrigger(env), false, "destroyed controller shows nothing");
  env.window.dispatchEvent({ type: "pageshow", persisted: true });
  assert.equal(showTrigger(env), true);
});

test("R-01: restore cycles reuse the same controller without duplicating listeners", () => {
  const env = loadLookupController();
  const before = {
    runtime: env.onMessageListenerCount(),
    pagehide: env.window.listenerCount("pagehide"),
    pageshow: env.window.listenerCount("pageshow"),
  };
  for (let i = 0; i < 3; i += 1) {
    env.window.dispatchEvent({ type: "pagehide", persisted: true });
    env.window.dispatchEvent({ type: "pageshow", persisted: true });
  }
  assert.equal(env.onMessageListenerCount(), before.runtime);
  assert.equal(env.window.listenerCount("pagehide"), before.pagehide);
  assert.equal(env.window.listenerCount("pageshow"), before.pageshow);
  assert.equal(before.runtime, 1);
});

test("R-01: beforeunload (which can be cancelled) no longer destroys the controller", () => {
  const env = loadLookupController();
  env.window.dispatchEvent({ type: "beforeunload" });
  assert.equal(showTrigger(env), true);
});

test("F2: only code NO_API_KEY opens the API-key panel; INTERNAL and code-less rejections show the real error", () => {
  const env = loadLookupController();
  startLookup(env);
  env.respond(0, { accepted: false, code: "INTERNAL", message: "storage read exploded" });
  assert.match(env.panelBodyHtml(), /storage read exploded/);
  assert.doesNotMatch(env.panelBodyHtml(), /mk-btn-settings-inline/);
  assert.doesNotMatch(env.panelBodyHtml(), /API Key/);

  // 旧版后台在异常时回复的形状（没有 code）
  startLookup(env, OTHER);
  env.respond(1, { accepted: false, ok: false, message: "background crashed", error: "background crashed" });
  assert.match(env.panelBodyHtml(), /background crashed/);
  assert.doesNotMatch(env.panelBodyHtml(), /mk-btn-settings-inline/);

  // 没有任何回复内容：也不能把用户引向 API Key 设置
  startLookup(env, "A third sentence that gets an empty reply from the background.");
  env.respond(2, undefined);
  assert.doesNotMatch(env.panelBodyHtml(), /mk-btn-settings-inline/);
  assert.doesNotMatch(env.panelBodyHtml(), /API Key/);
  assert.equal(env.controller.isPending(), false);

  startLookup(env, "A fourth sentence, this time really without an API key configured.");
  env.respond(3, { accepted: false, code: "NO_API_KEY", message: "请先配置" });
  assert.match(env.panelBodyHtml(), /mk-btn-settings-inline/);
});
