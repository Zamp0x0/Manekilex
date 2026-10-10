/**
 * Load live-transcribe.js (after config.js, as settings.html does) with fakes for everything it
 * owns: microphone / tab streams (getUserMedia), AudioContext + AudioWorkletNode, WebSocket and
 * the background replies (temporary token, translation provider list). Every fake records what
 * was created so a test can check that each owned resource was released.
 *
 * Nothing here talks to AssemblyAI or a provider. The token reply can be held back
 * (`holdToken`) and getUserMedia can be held back (`holdMedia`) to stop in the middle of a start.
 */
const vm = require("node:vm");
const { baseGlobals, runFile, createEvent, createStorageArea, withFallback } = require("./extension-sandbox");
const { scriptsFor } = require("./load-order");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createElement(tag) {
  const listeners = {};
  const children = [];
  const el = {
    tagName: String(tag || "div").toUpperCase(),
    dataset: {},
    style: {},
    className: "",
    textContent: "",
    value: "",
    disabled: false,
    checked: false,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    children,
    get firstChild() {
      return children[0] || null;
    },
    get innerHTML() {
      return "";
    },
    set innerHTML(_v) {
      children.length = 0;
    },
    _listeners: listeners,
    attributes: {},
    addEventListener(type, fn) {
      (listeners[type] ||= []).push(fn);
    },
    removeEventListener() {},
    appendChild(child) {
      children.push(child);
      return child;
    },
    removeChild(child) {
      const i = children.indexOf(child);
      if (i >= 0) children.splice(i, 1);
      return child;
    },
    remove() {},
    click() {
      return Promise.all((listeners.click || []).map((fn) => fn({ type: "click", preventDefault() {} })));
    },
    setAttribute(name, value) {
      el.attributes[name] = String(value);
    },
    removeAttribute(name) {
      delete el.attributes[name];
    },
    getAttribute(name) {
      return name in el.attributes ? el.attributes[name] : null;
    },
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  return el;
}

function createRoot() {
  const byId = new Map();
  const root = createElement("section");
  root.querySelector = (sel) => {
    const m = /^#([\w-]+)$/.exec(sel);
    if (!m) return null;
    if (!byId.has(m[1])) byId.set(m[1], createElement("div"));
    return byId.get(m[1]);
  };
  root.querySelectorAll = () => [];
  root.byId = (id) => root.querySelector(`#${id}`);
  return root;
}

function createMediaFakes() {
  const streams = [];
  const contexts = [];
  const worklets = [];
  const requests = [];

  function makeStream(kind) {
    const track = {
      kind: "audio",
      readyState: "live",
      stop() {
        track.readyState = "ended";
      },
    };
    const stream = {
      kind,
      track,
      getTracks: () => [track],
      getAudioTracks: () => [track],
    };
    streams.push(stream);
    return stream;
  }

  class FakeAudioContext {
    constructor() {
      this.sampleRate = 48000;
      this.state = "running";
      this.destination = { kind: "destination" };
      this.audioWorklet = { addModule: async () => {} };
      contexts.push(this);
    }
    createMediaStreamSource(stream) {
      return { stream, connect() {}, disconnect() {} };
    }
    close() {
      this.state = "closed";
      return Promise.resolve();
    }
  }

  class FakeAudioWorkletNode {
    constructor(context, name) {
      this.context = context;
      this.name = name;
      this.port = { onmessage: null };
      this.connected = false;
      worklets.push(this);
    }
    connect() {
      this.connected = true;
    }
    disconnect() {
      this.connected = false;
    }
  }

  return { streams, contexts, worklets, requests, makeStream, FakeAudioContext, FakeAudioWorkletNode };
}

function createWebSocketFake() {
  const sockets = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.readyState = FakeWebSocket.CONNECTING;
      this.sent = [];
      this.closeCalls = 0;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.onclose = null;
      sockets.push(this);
    }
    send(data) {
      this.sent.push(data);
    }
    /** Like a browser socket: close() only starts closing; the close event comes later (fireClose). */
    close() {
      this.closeCalls++;
      if (this.readyState !== FakeWebSocket.CLOSED) this.readyState = FakeWebSocket.CLOSING;
    }
    /** Test controls. */
    open() {
      if (this.readyState !== FakeWebSocket.CONNECTING) return; // a socket closed while connecting never opens
      this.readyState = FakeWebSocket.OPEN;
      if (this.onopen) this.onopen({ type: "open" });
    }
    /** A failed or aborted handshake: error, then close. */
    fail(code) {
      if (this.onerror) this.onerror({ type: "error" });
      this.fireClose(code || 1006);
    }
    fireClose(code) {
      this.readyState = FakeWebSocket.CLOSED;
      if (this.onclose) this.onclose({ type: "close", code: code || 1006 });
    }
  }
  FakeWebSocket.CONNECTING = 0;
  FakeWebSocket.OPEN = 1;
  FakeWebSocket.CLOSING = 2;
  FakeWebSocket.CLOSED = 3;
  return { sockets, FakeWebSocket };
}

/**
 * @param {object} opts
 * @param {object} opts.local        initial chrome.storage.local (AssemblyAI key by default)
 * @param {object} opts.session      initial chrome.storage.session (pending tab capture)
 * @param {boolean} opts.holdToken   GET_ASSEMBLYAI_TEMP_TOKEN waits for page.releaseToken()
 * @param {boolean} opts.holdMedia   getUserMedia waits for page.releaseMedia()
 * @param {boolean} opts.noProvider  the provider list is empty
 */
function loadLiveTranscribe(opts) {
  const options = opts || {};
  const local = createStorageArea(
    options.local || { zehAssemblyAI: { apiKey: "aai-test-key" } }
  );
  const session = createStorageArea(options.session || {});
  const onMessage = createEvent();
  const messages = [];
  const media = createMediaFakes();
  const ws = createWebSocketFake();
  const tokenWaits = [];
  const mediaWaits = [];

  const chrome = withFallback({
    runtime: withFallback({
      id: "test-extension",
      getURL: (p) => `chrome-extension://test-extension/${p}`,
      onMessage,
      sendMessage: async (message) => {
        messages.push(message);
        if (message.type === "GET_LIVE_TRANSCRIBE_PROVIDER_OPTIONS") {
          if (options.noProvider) return { ok: true, empty: true, options: [] };
          return { ok: true, selectedId: "deepseek", options: [{ id: "deepseek", name: "DeepSeek", model: "deepseek-chat" }] };
        }
        if (message.type === "GET_ASSEMBLYAI_TEMP_TOKEN") {
          if (options.holdToken) {
            const d = deferred();
            tokenWaits.push(d);
            return d.promise;
          }
          return { ok: true, token: "temp-token" };
        }
        return { ok: true };
      },
    }),
    storage: withFallback({ local, session }),
  });

  const navigator = {
    userAgent: "node-test",
    clipboard: { writeText: async () => {} },
    mediaDevices: {
      getUserMedia: (constraints) => {
        const kind = constraints && constraints.audio && (constraints.audio.mandatory || constraints.audio.chromeMediaSource) ? "tab" : "mic";
        media.requests.push(kind);
        const stream = media.makeStream(kind);
        if (options.holdMedia) {
          const d = deferred();
          mediaWaits.push({ resolve: () => d.resolve(stream), stream });
          return d.promise;
        }
        return Promise.resolve(stream);
      },
    },
  };

  const document = {
    createElement,
    body: createElement("body"),
  };

  const context = vm.createContext({
    ...baseGlobals(),
    chrome,
    navigator,
    document,
    AudioContext: media.FakeAudioContext,
    AudioWorkletNode: media.FakeAudioWorkletNode,
    WebSocket: ws.FakeWebSocket,
    requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
    Blob: globalThis.Blob,
  });
  context.window = context;
  context.self = context;
  // settings.html's order, narrowed to what live-transcribe.js uses
  scriptsFor("settings", { only: ["config.js", "shared/providers.js", "live-transcribe.js"] }).forEach((file) =>
    runFile(context, file)
  );

  const root = createRoot();
  const page = {
    context,
    root,
    local,
    session,
    messages,
    media,
    sockets: ws.sockets,
    api: context.MKLiveTranscribe,
    mount: () => context.MKLiveTranscribe.mount(root),
    destroy: () => context.MKLiveTranscribe.destroy(),
    start: () => root.byId("ltStartBtn").click(),
    stop: () => root.byId("ltStopBtn").click(),
    status: () => root.byId("ltStatus").textContent,
    tokenWaits,
    mediaWaits,
    releaseToken(i, reply) {
      tokenWaits[i].resolve(reply || { ok: true, token: `temp-token-${i}` });
    },
    releaseMedia(i) {
      mediaWaits[i].resolve();
    },
    /** Everything the page opened that is still holding a device, a socket or an audio graph. */
    leaks() {
      return {
        liveTracks: media.streams.filter((s) => s.track.readyState === "live").map((s) => s.kind),
        openContexts: media.contexts.filter((c) => c.state !== "closed").length,
        openSockets: ws.sockets.filter((s) => s.readyState === ws.FakeWebSocket.CONNECTING || s.readyState === ws.FakeWebSocket.OPEN).length,
      };
    },
  };
  return page;
}

module.exports = { loadLiveTranscribe, deferred };
