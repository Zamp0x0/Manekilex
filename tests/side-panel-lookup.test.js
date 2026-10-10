/**
 * F3: the PDF fallback opens the side panel with the selected text.
 *
 * Chrome's built-in PDF viewer cannot run content scripts, so a context-menu lookup there falls
 * back to the side panel (background.js openSidePanelLookup). lookup-panel.js reads the text from
 * its own URL (?text=), so the path given to chrome.sidePanel.setOptions must carry it. These
 * tests follow the real path end to end: the service worker's setOptions call, then the side
 * panel page loaded at exactly that path.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadBackground, evalIn, waitFor, sleep } = require("./helpers/extension-sandbox");
const { loadSidePanelPage } = require("./helpers/extension-pages");
const { disposeLookupControllers } = require("./helpers/fake-dom");

test.afterEach(() => disposeLookupControllers());

const PDF_TAB = { id: 5, url: "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html" };

/** Service worker with a fake sidePanel API and a PDF tab that has no content script. */
function backgroundWithSidePanel() {
  const bg = loadBackground();
  const calls = [];
  bg.chrome.sidePanel = {
    setOptions: async (options) => {
      calls.push({ setOptions: options });
    },
    open: async (options) => {
      calls.push({ open: options });
    },
  };
  bg.chrome.tabs.query = async () => [PDF_TAB];
  bg.chrome.tabs.sendMessage = async () => {
    throw new Error("Could not establish connection. Receiving end does not exist.");
  };
  return { bg, calls };
}

async function sidePanelPathFor(text) {
  const { bg, calls } = backgroundWithSidePanel();
  const ok = await bg.context.dispatchPdfLookup(text, PDF_TAB);
  assert.equal(ok, true);
  await waitFor(() => calls.some((c) => c.open), 2000, "sidePanel.open");
  const setOptions = calls.find((c) => c.setOptions).setOptions;
  assert.equal(setOptions.tabId, PDF_TAB.id);
  assert.equal(setOptions.enabled, true);
  return { path: setOptions.path, bg };
}

function searchOf(path) {
  const i = path.indexOf("?");
  return i < 0 ? "" : path.slice(i);
}

test("F3: the side panel path carries the selected text and the panel looks it up", async () => {
  const { path } = await sidePanelPathFor("  serendipity ");
  assert.match(path, /^lookup-panel\.html\?/);
  assert.equal(new URLSearchParams(searchOf(path)).get("text"), "serendipity");

  const panel = loadSidePanelPage({ search: searchOf(path) });
  await waitFor(() => panel.messages("EXPLAIN").length > 0, 2000, "EXPLAIN from the side panel");
  const [sent] = panel.messages("EXPLAIN");
  assert.equal(sent.message.text, "serendipity");
  assert.ok(panel.document.body.classList.contains("mode-panel"));
  await sleep(5);
});

test("F3: text with URL-special characters survives the round trip", async () => {
  const text = "rock & roll? 50% off #1 = a+b";
  const { path } = await sidePanelPathFor(text);
  const panel = loadSidePanelPage({ search: searchOf(path) });
  await waitFor(() => panel.messages("EXPLAIN").length > 0, 2000, "EXPLAIN from the side panel");
  assert.equal(panel.messages("EXPLAIN")[0].message.text, text);
  await sleep(5);
});

test("F3: very long selections are capped in the path and nothing is left in storage.session", async () => {
  const long = "word ".repeat(2000).trim();
  const { path, bg } = await sidePanelPathFor(long);
  const sent = new URLSearchParams(searchOf(path)).get("text");
  assert.ok(sent.length > 0);
  assert.ok(sent.length <= evalIn(bg.context, "ZEH_LOOKUP_LIMITS.hard"), `text in the path is ${sent.length} chars`);
  assert.ok(long.startsWith(sent));
  // 旧实现把文本写进 storage.session（sidePanelLookupText / sidePanelFromPdf），但没有页面读取它
  const session = await bg.chrome.storage.session.get(null);
  assert.deepEqual(Object.keys(session), []);
});
