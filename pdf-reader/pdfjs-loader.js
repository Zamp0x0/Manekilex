/**
 * pdf-reader/pdfjs-loader.js — PDF.js 的唯一接入点（增强 PDF 阅读器与设置页的 PDF 导入共用）
 *
 * PDF.js 6.x 只发布 ES module，没有 UMD 全局包。扩展页面仍是一组共享全局作用域的 classic script，
 * 所以这里用 import()（仅限扩展自己的 chrome-extension:// 地址）按需加载 lib/pdfjs/ 里的 legacy
 * 构建，worker 也从本地加载。没有 CDN、没有远程代码。
 *
 * 安全相关的固定选项（documentParams）：
 *   - enableXfa: false            不渲染 XFA 表单（XFA 自带脚本语义）
 *   - wasmUrl: lib/pdfjs/wasm/     JBIG2 / JPX / ICC 解码器只从本地加载（manifest CSP 允许 wasm-unsafe-eval）
 *   - 不传 cMapUrl / standardFontDataUrl：未随包附带（见 lib/README.md），非嵌入字体用系统字体
 *   - isEvalSupported：6.x 已删除字体 eval 路径（CVE-2024-4367 的触发点），该选项不再存在
 * 查看器侧（pdf-reader/viewer.js）不创建 PDFScriptingManager，即 enableScripting = false
 * （CVE-2026-16633 的前提条件），也不传 downloadManager（附件不会被打开或下载）。
 *
 * 依赖：chrome.runtime.getURL。暴露 window.ZEHPdfjs。
 */
(function (global) {
  const VERSION = "6.4.299";
  const BASE = "lib/pdfjs/";
  const FILES = Object.freeze({
    library: "build/pdf.min.mjs",
    worker: "build/pdf.worker.min.mjs",
    viewer: "web/pdf_viewer.mjs",
    viewerCss: "web/pdf_viewer.css",
    wasm: "wasm/",
  });

  let libraryPromise = null;
  let viewerPromise = null;

  function resourceUrl(rel) {
    return chrome.runtime.getURL(BASE + rel);
  }

  function checkVersion(lib) {
    if (!lib || lib.version !== VERSION) {
      throw new Error(`PDF.js 版本不符：期望 ${VERSION}，实际 ${lib && lib.version}`);
    }
    return lib;
  }

  /** PDF.js 核心库（同一页面只加载一次；加载失败后允许重试） */
  function loadLibrary(importer) {
    if (!libraryPromise) {
      const load = importer || ((url) => import(url));
      libraryPromise = Promise.resolve()
        .then(() => load(resourceUrl(FILES.library)))
        .then((lib) => {
          checkVersion(lib);
          lib.GlobalWorkerOptions.workerSrc = resourceUrl(FILES.worker);
          return lib;
        })
        .catch((err) => {
          libraryPromise = null;
          throw err;
        });
    }
    return libraryPromise;
  }

  /** 查看器组件（pdf_viewer.mjs 在求值时读取 globalThis.pdfjsLib，所以先放好核心库） */
  function loadViewer(importer) {
    if (!viewerPromise) {
      const load = importer || ((url) => import(url));
      viewerPromise = loadLibrary(importer)
        .then((lib) => {
          global.pdfjsLib = lib;
          return load(resourceUrl(FILES.viewer));
        })
        .then((viewer) => ({ lib: global.pdfjsLib, viewer }))
        .catch((err) => {
          viewerPromise = null;
          throw err;
        });
    }
    return viewerPromise;
  }

  /**
   * getDocument 参数：调用方只提供数据来源（data / password），安全选项在这里固定，
   * 调用方传入的同名字段会被覆盖。
   */
  function documentParams(source) {
    const src = source && typeof source === "object" ? source : {};
    const params = {};
    if (src.data != null) params.data = src.data;
    if (typeof src.password === "string") params.password = src.password;
    return Object.assign(params, {
      enableXfa: false,
      wasmUrl: resourceUrl(FILES.wasm),
      useWasm: true,
      verbosity: 0,
    });
  }

  global.ZEHPdfjs = {
    VERSION,
    FILES,
    resourceUrl,
    loadLibrary,
    loadViewer,
    documentParams,
  };
})(typeof window !== "undefined" ? window : globalThis);
