/**
 * F10: live transcription start/stop. Every start owns what it opens (WebSocket, microphone or
 * tab stream, AudioContexts); Stop, a newer start or an early return releases it, and events
 * from an old socket cannot stop a newer session. Media, WebSocket and the token reply are fakes
 * (tests/helpers/live-transcribe-page.js); nothing reaches AssemblyAI or a provider.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const { waitFor, sleep } = require("./helpers/extension-sandbox");
const { loadLiveTranscribe } = require("./helpers/live-transcribe-page");

/** Wait for a start to finish, but do not hang the file when a broken start never settles. */
const settled = (promise, ms = 300) => Promise.race([promise, sleep(ms)]);

const NO_LEAKS = { liveTracks: [], openContexts: 0, openSockets: 0 };

/** Start, open the socket, and wait until the microphone pipeline is running. */
async function startFully(page, socketIndex) {
  const started = page.start();
  await waitFor(() => page.sockets.length > socketIndex, 2000, `socket ${socketIndex} created`);
  page.sockets[socketIndex].open();
  await started;
  await waitFor(() => page.media.worklets.length > socketIndex, 2000, `pipeline ${socketIndex} running`);
}

test("F10 control: a normal start and stop releases the microphone, the audio graph and the socket", async () => {
  const page = loadLiveTranscribe();
  await page.mount();
  await startFully(page, 0);
  assert.deepEqual(page.leaks(), { liveTracks: ["mic"], openContexts: 1, openSockets: 1 });
  await page.stop();
  assert.deepEqual(page.leaks(), NO_LEAKS);
});

test("F10: Stop while the temporary token is being fetched opens no socket and no microphone", async () => {
  const page = loadLiveTranscribe({ holdToken: true });
  await page.mount();
  const started = page.start();
  await waitFor(() => page.tokenWaits.length === 1, 2000, "token requested");
  await page.stop();
  page.releaseToken(0);
  await settled(started);
  await sleep(20);
  assert.equal(page.sockets.length, 0, "no WebSocket after Stop");
  assert.deepEqual(page.media.requests, [], "the microphone was never requested");
  assert.deepEqual(page.leaks(), NO_LEAKS);
  assert.equal(page.root.byId("ltStartBtn").getAttribute("disabled"), null, "Start is available again");
});

test("F10: Stop while the socket is connecting, then Start again: the aborted handshake does not stop the new session", async () => {
  const page = loadLiveTranscribe();
  await page.mount();
  const first = page.start();
  await waitFor(() => page.sockets.length === 1, 2000, "first socket created");
  await page.stop();
  assert.ok(page.sockets[0].closeCalls > 0, "Stop closes the connecting socket");

  const second = page.start();
  await waitFor(() => page.sockets.length === 2, 2000, "second socket created");
  page.sockets[0].fail(1006); // the browser reports the aborted first handshake only now
  await settled(first);
  page.sockets[1].open();
  await settled(second);
  await waitFor(() => page.media.worklets.length === 1, 1000, "second pipeline running").catch(() => {});
  assert.equal(page.sockets[1].closeCalls, 0, "the new socket stays open");
  assert.deepEqual(page.media.requests, ["mic"], "only the new session opened the microphone");
  assert.deepEqual(page.leaks(), { liveTracks: ["mic"], openContexts: 1, openSockets: 1 });
  assert.doesNotMatch(page.status(), /WebSocket 连接失败/, "no connection error is shown for the stopped start");
  await page.stop();
  assert.deepEqual(page.leaks(), NO_LEAKS);
});

test("F10: Stop while the microphone permission is pending releases the microphone when it arrives", async () => {
  const page = loadLiveTranscribe({ holdMedia: true });
  await page.mount();
  const started = page.start();
  await waitFor(() => page.sockets.length === 1, 2000, "socket created");
  page.sockets[0].open();
  await waitFor(() => page.mediaWaits.length === 1, 2000, "microphone requested");
  await page.stop();
  page.releaseMedia(0);
  await settled(started);
  await sleep(20);
  assert.equal(page.media.contexts.length, 0, "no audio graph is built after Stop");
  assert.deepEqual(page.leaks(), NO_LEAKS);
});

test("F10: a late close event from the previous socket does not stop the new session", async () => {
  const page = loadLiveTranscribe();
  await page.mount();
  await startFully(page, 0);
  await page.stop();
  await startFully(page, 1);
  page.sockets[0].fireClose(1000); // the first socket finishes closing only now
  await sleep(20);
  assert.equal(page.sockets[1].closeCalls, 0, "the new socket stays open");
  assert.deepEqual(page.leaks(), { liveTracks: ["mic"], openContexts: 1, openSockets: 1 });
  assert.equal(page.root.byId("ltStopBtn").getAttribute("disabled"), null, "Stop is still available");
  await page.stop();
  assert.deepEqual(page.leaks(), NO_LEAKS);
});

test("F10: a start abandoned by Stop does not take over a newer session when its token arrives late", async () => {
  const page = loadLiveTranscribe({ holdToken: true });
  await page.mount();
  const first = page.start();
  await waitFor(() => page.tokenWaits.length === 1, 2000, "first token requested");
  await page.stop();

  const second = page.start();
  await waitFor(() => page.tokenWaits.length === 2, 2000, "second token requested");
  page.releaseToken(1);
  await waitFor(() => page.sockets.length === 1, 2000, "second socket created");
  page.sockets[0].open();
  await second;
  await waitFor(() => page.media.worklets.length === 1, 2000, "second pipeline running");

  page.releaseToken(0); // the abandoned first start resumes
  await settled(first);
  await sleep(20);
  assert.equal(page.sockets.length, 1, "the abandoned start opened no socket");
  assert.deepEqual(page.leaks(), { liveTracks: ["mic"], openContexts: 1, openSockets: 1 });

  await page.stop();
  assert.deepEqual(page.leaks(), NO_LEAKS, "Stop releases everything the live session owns");
});

for (const [label, setup] of [
  ["no AssemblyAI key", { local: {} }],
  ["no translation provider", { noProvider: true }],
]) {
  test(`F10: a pending tab capture is released when the start returns early (${label})`, async () => {
    const page = loadLiveTranscribe({
      ...setup,
      session: {
        zehPendingTabAudioCapture: { streamId: "stream-1", targetTabId: 7, targetTabTitle: "Lecture", createdAt: Date.now() },
      },
    });
    await page.mount();
    await sleep(20);
    assert.deepEqual(page.media.requests, ["tab"], "the tab stream was opened");
    assert.equal(page.sockets.length, 0);
    assert.deepEqual(page.leaks(), NO_LEAKS, "tab stream stopped and its playback context closed");
  });
}

test("F10: destroying the view during a start releases everything", async () => {
  const page = loadLiveTranscribe({ holdToken: true });
  await page.mount();
  const started = page.start();
  await waitFor(() => page.tokenWaits.length === 1, 2000, "token requested");
  await page.destroy();
  page.releaseToken(0);
  await settled(started);
  await sleep(20);
  assert.equal(page.sockets.length, 0);
  assert.deepEqual(page.leaks(), NO_LEAKS);
});

test("Batch 6: saving an empty AssemblyAI key removes the stored key and keeps the other settings", async () => {
  const page = loadLiveTranscribe({ local: { zehAssemblyAI: { apiKey: "aai-test-key", speechModel: "universal-streaming", endpointingPreset: "fast" } } });
  await page.mount();
  assert.equal(page.root.byId("ltApiKey").value, "aai-test-key");
  page.root.byId("ltApiKey").value = "   ";
  page.root.byId("ltSaveKeyBtn").click();
  await waitFor(() => /已从本机删除/.test(page.status()), 2000, "removal reported");
  const saved = (await page.local.get("zehAssemblyAI")).zehAssemblyAI;
  assert.equal(saved.speechModel, "universal-streaming");
  assert.equal(saved.endpointingPreset, "fast");
  assert.equal(saved.apiKey, "");

  // nothing stored and nothing typed: only the reminder, no write
  page.root.byId("ltSaveKeyBtn").click();
  await waitFor(() => /请输入 AssemblyAI API Key/.test(page.status()), 2000, "reminder shown");
  assert.equal((await page.local.get("zehAssemblyAI")).zehAssemblyAI.apiKey, "");

  page.root.byId("ltApiKey").value = "aai-new-key";
  page.root.byId("ltSaveKeyBtn").click();
  await waitFor(() => /已保存到本机/.test(page.status()), 2000, "new key saved");
  assert.equal((await page.local.get("zehAssemblyAI")).zehAssemblyAI.apiKey, "aai-new-key");
  await page.destroy();
});
