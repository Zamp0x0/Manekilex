/**
 * pdf-reader/document.js — PDF 数据从哪里来、怎么交给 PDF.js、出错时怎么说明
 *
 * 两条入口，都只在内存里处理，不保存、不上传：
 *   A. Chrome 151+ 的 MIME 处理（manifest mime_types_handler）：Chrome 打开 application/pdf 时载入
 *      本页面。mimeHandler.getStreamInfo() 给出 streamUrl（只能读取一次的数据流）与 originalUrl。
 *      这里只 fetch(streamUrl) 一次；originalUrl 只用于显示与出处（不会重新请求它）。
 *   B. 手动打开：<input type="file"> / 拖放得到的 File，直接读成内存数据交给 PDF.js。
 *      不需要任何额外权限，不留副本。
 *
 * 数据交给 PDF.js 后由它的 worker 持有（transfer），本页面不再保留另一份。
 * 出处信息只保留 http(s) 地址的协议 + 主机 + 路径（去掉查询串 / 片段 / 用户名密码）。
 *
 * 依赖：config.js（zehSanitizePdfSourceUrl）。暴露 window.ZEHPdfDocument。
 */
(function (global) {
  const PDF_MIME = "application/pdf";
  /** 增强阅读器打开的文件大小上限；更大的文件请用 Chrome 自带查看器 */
  const MAX_BYTES = 512 * 1024 * 1024;
  /** 数据流多久没有新数据算作停滞 */
  const STREAM_STALL_MS = 45000;

  const MESSAGES = {
    STREAM_UNAVAILABLE: "Chrome 没有把这个 PDF 的数据交给扩展（页面可能已过期），请刷新页面重试。",
    STREAM_ALREADY_READ: "这个 PDF 的数据流已经读取过，请刷新页面重新打开。",
    STREAM_FAILED: "读取 PDF 数据失败。",
    STREAM_STALLED: "PDF 下载长时间没有进展，已停止等待。",
    TOO_LARGE: "PDF 超过 512 MB，增强阅读器不打开这么大的文件。",
    EMPTY: "文件是空的。",
    NOT_PDF: "这不是 PDF 文件。",
    INVALID_PDF: "文件不是有效的 PDF，或者已经损坏，PDF.js 无法解析。",
    PASSWORD_CANCELLED: "这个 PDF 需要密码，已取消输入。",
    LIBRARY_FAILED: "PDF 组件加载失败。",
    UNKNOWN: "打开 PDF 时出错。",
  };

  function readerError(code, detail) {
    const err = new Error(MESSAGES[code] || MESSAGES.UNKNOWN);
    err.code = code;
    if (detail) err.detail = String(detail).slice(0, 300);
    return err;
  }

  /** Chrome 151+ 的 MIME 处理 API；旧版 Chrome 没有（返回 null） */
  function getMimeHandler(scope) {
    const c = scope ? scope.chrome : typeof chrome !== "undefined" ? chrome : null;
    const b = scope ? scope.browser : typeof browser !== "undefined" ? browser : null;
    const api = (c && c.mimeHandler) || (b && b.mimeHandler) || null;
    return api && typeof api.getStreamInfo === "function" ? api : null;
  }

  /** 从 URL 路径取文件名（解码失败时用原样）；没有时返回 "" */
  function fileNameFromUrl(url) {
    try {
      const u = new URL(String(url || ""));
      const last = u.pathname.split("/").filter(Boolean).pop() || "";
      let name = last;
      try {
        name = decodeURIComponent(last);
      } catch {
        /* keep raw */
      }
      return name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
    } catch {
      return "";
    }
  }

  /** Content-Disposition 里的文件名（filename* 优先），只取最后一段，去掉路径 */
  function fileNameFromDisposition(value) {
    const v = String(value || "");
    let name = "";
    const star = v.match(/filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/);
    if (star) {
      try {
        name = decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
      } catch {
        name = "";
      }
    }
    if (!name) {
      const plain = v.match(/filename\s*=\s*("([^"]*)"|[^;]+)/);
      if (plain) name = (plain[2] != null ? plain[2] : plain[1]).trim();
    }
    name = name.split(/[\\/]/).pop() || "";
    return name.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 200);
  }

  function headerValue(headers, name) {
    if (!headers || typeof headers !== "object") return "";
    const want = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (String(k).toLowerCase() === want) return String(v || "");
    }
    return "";
  }

  /** MIME 处理入口的出处：显示用的文件名、可保存的地址、所在标签页 */
  function provenanceFromStream(info) {
    const originalUrl = String(info?.originalUrl || "");
    const fileName =
      fileNameFromDisposition(headerValue(info?.responseHeaders, "content-disposition")) ||
      fileNameFromUrl(originalUrl) ||
      "document.pdf";
    return {
      kind: "stream",
      fileName,
      url: typeof zehSanitizePdfSourceUrl === "function" ? zehSanitizePdfSourceUrl(originalUrl) : "",
      displayUrl: originalUrl.slice(0, 2000),
      tabId: Number.isInteger(info?.tabId) ? info.tabId : null,
      embedded: Boolean(info?.embedded),
    };
  }

  function looksLikePdf(bytes) {
    // %PDF- 可以出现在文件前 1024 字节内的任意位置（PDF 规范允许前面有垃圾数据）
    const head = bytes.subarray(0, 1024);
    for (let i = 0; i + 4 < head.length; i++) {
      if (head[i] === 0x25 && head[i + 1] === 0x50 && head[i + 2] === 0x44 && head[i + 3] === 0x46 && head[i + 4] === 0x2d) {
        return true;
      }
    }
    return false;
  }

  /**
   * 创建一个 MIME 数据流读取器：streamUrl 只会被请求一次（第二次调用直接报错）。
   * @param {{ mimeHandler: object, fetchImpl?: Function, maxBytes?: number, stallMs?: number,
   *           onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal }} options
   */
  function createStreamSource(options) {
    const opts = options || {};
    let used = false;
    let streamInfo = null;

    async function info() {
      if (!streamInfo) {
        streamInfo = await opts.mimeHandler.getStreamInfo();
        if (!streamInfo || typeof streamInfo.streamUrl !== "string" || !streamInfo.streamUrl) {
          throw readerError("STREAM_UNAVAILABLE");
        }
      }
      return streamInfo;
    }

    async function read() {
      if (used) throw readerError("STREAM_ALREADY_READ");
      used = true;
      const si = await info();
      const fetchImpl = opts.fetchImpl || ((url, init) => fetch(url, init));
      const maxBytes = opts.maxBytes || MAX_BYTES;
      const stallMs = opts.stallMs || STREAM_STALL_MS;
      const ac = new AbortController();
      const outer = opts.signal;
      const onOuterAbort = () => ac.abort();
      outer?.addEventListener("abort", onOuterAbort, { once: true });
      let stallTimer = null;
      let stalled = false;
      const armStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => {
          stalled = true;
          ac.abort();
        }, stallMs);
      };
      try {
        armStall();
        let response;
        try {
          response = await fetchImpl(si.streamUrl, { signal: ac.signal, credentials: "omit", cache: "no-store" });
        } catch (err) {
          throw readerError(stalled ? "STREAM_STALLED" : "STREAM_FAILED", err?.message);
        }
        if (!response || !response.ok) {
          throw readerError("STREAM_FAILED", response ? `HTTP ${response.status}` : "no response");
        }
        const declared = Number(response.headers?.get?.("content-length")) || 0;
        if (declared > maxBytes) throw readerError("TOO_LARGE");
        const chunks = [];
        let loaded = 0;
        try {
          if (response.body && typeof response.body.getReader === "function") {
            const reader = response.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              armStall();
              loaded += value.byteLength;
              if (loaded > maxBytes) {
                ac.abort();
                throw readerError("TOO_LARGE");
              }
              chunks.push(value);
              opts.onProgress?.(loaded, declared);
            }
          } else {
            const buf = new Uint8Array(await response.arrayBuffer());
            loaded = buf.byteLength;
            if (loaded > maxBytes) throw readerError("TOO_LARGE");
            chunks.push(buf);
          }
        } catch (err) {
          if (err?.code) throw err;
          throw readerError(stalled ? "STREAM_STALLED" : "STREAM_FAILED", err?.message);
        }
        const data = concat(chunks, loaded);
        chunks.length = 0;
        if (!data.byteLength) throw readerError("EMPTY");
        if (!looksLikePdf(data)) throw readerError("NOT_PDF");
        return { data, provenance: provenanceFromStream(si), mimeType: String(si.mimeType || PDF_MIME) };
      } finally {
        clearTimeout(stallTimer);
        outer?.removeEventListener("abort", onOuterAbort);
      }
    }

    return {
      info,
      read,
      get used() {
        return used;
      },
    };
  }

  function concat(chunks, total) {
    if (chunks.length === 1) return chunks[0];
    const out = new Uint8Array(total);
    let at = 0;
    for (const c of chunks) {
      out.set(c, at);
      at += c.byteLength;
    }
    return out;
  }

  /** 手动打开的本地文件 → { data, provenance }；不保存文件，也不读取路径 */
  async function readFile(file, options) {
    const maxBytes = options?.maxBytes || MAX_BYTES;
    if (!file || typeof file.arrayBuffer !== "function") throw readerError("UNKNOWN", "no file");
    if (file.size > maxBytes) throw readerError("TOO_LARGE");
    const name = String(file.name || "document.pdf").split(/[\\/]/).pop().slice(0, 200);
    const type = String(file.type || "");
    if (type && type !== PDF_MIME && !/\.pdf$/i.test(name)) throw readerError("NOT_PDF");
    const data = new Uint8Array(await file.arrayBuffer());
    if (!data.byteLength) throw readerError("EMPTY");
    if (!looksLikePdf(data)) throw readerError("NOT_PDF");
    return { data, provenance: { kind: "file", fileName: name, url: "", displayUrl: "", tabId: null, embedded: false } };
  }

  /**
   * PDF.js 抛出的错误 → { code, message }。密码错误由 onPassword 处理，不经过这里。
   */
  function classifyError(err) {
    if (err && err.code && MESSAGES[err.code]) return { code: err.code, message: MESSAGES[err.code] };
    const name = String(err?.name || "");
    if (name === "InvalidPDFException" || name === "FormatError") return { code: "INVALID_PDF", message: MESSAGES.INVALID_PDF };
    if (name === "PasswordException") return { code: "PASSWORD_CANCELLED", message: MESSAGES.PASSWORD_CANCELLED };
    if (name === "ResponseException" || name === "MissingPDFException") {
      return { code: "STREAM_FAILED", message: MESSAGES.STREAM_FAILED };
    }
    return { code: "UNKNOWN", message: MESSAGES.UNKNOWN };
  }

  /**
   * 打开 PDF：getDocument 参数由 pdfjs-loader 固定（禁用 XFA、本地 wasm、无脚本）。
   * onPassword(reason, submit, cancel)：reason 为 "need" / "incorrect"；密码只传给 PDF.js，不保存。
   * 返回 { loadingTask, promise }；loadingTask.destroy() 释放文档与 worker。
   */
  function openDocument(lib, data, hooks) {
    const h = hooks || {};
    const params = global.ZEHPdfjs.documentParams({ data });
    const loadingTask = lib.getDocument(params);
    if (h.onProgress) {
      loadingTask.onProgress = ({ loaded, total }) => h.onProgress(loaded, total);
    }
    loadingTask.onPassword = (update, reason) => {
      const kind = reason === lib.PasswordResponses.INCORRECT_PASSWORD ? "incorrect" : "need";
      if (!h.onPassword) {
        loadingTask.destroy();
        return;
      }
      h.onPassword(
        kind,
        (password) => update(String(password || "")),
        () => loadingTask.destroy()
      );
    };
    return { loadingTask, promise: loadingTask.promise };
  }

  global.ZEHPdfDocument = {
    PDF_MIME,
    MAX_BYTES,
    MESSAGES,
    getMimeHandler,
    fileNameFromUrl,
    fileNameFromDisposition,
    provenanceFromStream,
    looksLikePdf,
    createStreamSource,
    readFile,
    classifyError,
    openDocument,
    readerError,
  };
})(typeof window !== "undefined" ? window : globalThis);
