# lib/ — 第三方浏览器库（vendored）

扩展没有构建步骤，页面直接 `<script src="lib/…">` 加载这些压缩包。它们不是 npm 运行时依赖
（`package.json` 里只有测试 / 词典脚本用的 devDependencies），升级时把新版本的 dist 文件覆盖到这里即可。

| 文件 | 库 | 版本 | 许可证 | 来源文件（npm 包内路径） | 用途 |
| --- | --- | --- | --- | --- | --- |
| `epub.min.js` | epub.js | 0.3.93 | BSD-2-Clause | `epubjs/dist/epub.min.js` | Reader 渲染 EPUB（`reader.html`，`settings.html` 用于封面 / 元数据） |
| `jszip.min.js` | JSZip | 3.10.1 | MIT（MIT / GPL-3.0 双许可，选用 MIT） | `jszip/dist/jszip.min.js` | epub.js 依赖；导入器打包 EPUB |
| `mammoth.browser.min.js` | mammoth.js | 1.12.0 | BSD-2-Clause | `mammoth/mammoth.browser.min.js` | DOCX → HTML（导入器） |
| `marked.min.js` | marked | 18.0.5 | MIT | `marked/lib/marked.umd.js` | Markdown → HTML（导入器） |
| `pdfjs/build/pdf.min.mjs` | pdf.js (pdfjs-dist) | 6.4.299 | Apache-2.0 | `pdfjs-dist/legacy/build/pdf.min.mjs` | PDF 解析（增强 PDF 阅读器、PDF 导入）；由 `pdf-reader/pdfjs-loader.js` 用 `import()` 加载 |
| `pdfjs/build/pdf.worker.min.mjs` | pdf.js (pdfjs-dist) | 6.4.299 | Apache-2.0 | `pdfjs-dist/legacy/build/pdf.worker.min.mjs` | pdf.js worker（扩展页面内的 module worker，不对网页开放） |
| `pdfjs/web/pdf_viewer.mjs`、`pdfjs/web/pdf_viewer.css`、`pdfjs/web/images/*` | pdf.js 查看器组件 | 6.4.299 | Apache-2.0 | `pdfjs-dist/legacy/web/` | 增强 PDF 阅读器的分页渲染、文字层、链接、查找 |
| `pdfjs/wasm/{jbig2,openjpeg,qcms_bg}.wasm` | pdf.js 图像 / 色彩解码器 | 6.4.299 | BSD-3-Clause / BSD-2-Clause / MIT（见同目录 `LICENSE_*`） | `pdfjs-dist/wasm/` | JBIG2 / CCITT、JPEG 2000、ICC 颜色 |

来源核对方式（2026-10-07，Phase 5；2026-10-08 复核；pdf.js 6.4.299 于 2026-10-09 核对；2026-10-10 全部再次核对，包括 `lib/pdfjs/` 的 96 个文件）：以上每个文件的 SHA-256 与对应 npm 包 dist 文件一致。

其余四个库的 SHA-256（`tests/vendor-provenance.test.js` 逐个核对；2026-10-10 用 `npm pack` 下载的官方包再次比对一致）：

| 文件 | SHA-256 |
| --- | --- |
| `epub.min.js` | `06eae15745107b4aa508c95538275251f69bfb9f1175621fc458d9f42ed082d4` |
| `jszip.min.js` | `acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e` |
| `mammoth.browser.min.js` | `5d4c0e7c9165d70b78f789c5274a2c7846d9e1c06ec19b69afa6ef45f789a3b9` |
| `marked.min.js` | `2dc4769dfde29f51c7aca1a539c6407c789c8ea644cf8b7d01ded28a9c1d800b` |

pdf.js 6.4.299 各文件的 SHA-256（`tests/pdfjs-vendor.test.js` 逐个核对，升级时同步更新）：

| 文件 | SHA-256 |
| --- | --- |
| `pdfjs/build/pdf.min.mjs` | `bccc24ea711db8e44503629519904a5292d73b9daaa214bbe7cdcc282b0f4259` |
| `pdfjs/build/pdf.worker.min.mjs` | `145d2dd3ab0c86151011dba95acfa2d5336e2accd59388ea43dbee0efddaaec6` |
| `pdfjs/web/pdf_viewer.mjs` | `94836afa5e6d3e5f9abea50dced92dac6083ac2a11548d3681c3414dd6d3425f` |
| `pdfjs/web/pdf_viewer.css` | `1f3c7c3c692d4da2334d0386d2286ec040a37db8654e02b8704b11262bc9bf49` |
| `pdfjs/wasm/jbig2.wasm` | `466f45c2a61a698152fb5400c27e56ff2ceb73dcb71fde3fc366a502308eaab0` |
| `pdfjs/wasm/openjpeg.wasm` | `95e5002597af0824004aa57b1900fe019715db389e37640b1e58395e42f00cc5` |
| `pdfjs/wasm/qcms_bg.wasm` | `663d86126d5f5fcb1c61490f94353e2a8375660b8c5498ab3ebab5a34b08800e` |
| `pdfjs/LICENSE` | `0d542e0c8804e39aa7f37eb00da5a762149dc682d7829451287e11b938e94594` |


许可证全文、版权声明，以及这些压缩包内部打包的子组件（pako、core-js、localForage、xmldom、underscore、bluebird 等）的许可，见根目录 [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。分发 `lib/` 时必须一并附带该文件。替换或升级库时，同步更新该文件。

## 已知安全提示

- **pdf.js 6.4.299（2026-10-09 起，替换 3.11.174）**。选型依据：
  - CVE-2024-4367（GHSA-wgrm-67xf-hhpq，字体 FontMatrix 触发 `eval`）影响 ≤ 4.1.392，4.2.67 修复；
    6.x 已删除字体程序的 `eval` / `new Function` 路径，`isEvalSupported` 选项随之移除。
    `tests/pdfjs-vendor.test.js` 检查随包 JS 中没有 `eval(` 与 `new Function(`。
  - CVE-2026-16633（GHSA-hq66-cqwq-w95j，PDF 内 JavaScript 在宿主页面执行）影响 5.6.83 至 6.2.108 之前，
    6.2.108 修复。另外本项目不创建 PDFScriptingManager（`enableScripting` 为 false），
    也不随包附带 `pdf.sandbox*.mjs` 与 `quickjs-eval.*`，扩展页面 CSP 不允许 `unsafe-eval`。
  - 使用 legacy 构建：兼容较旧的 Chrome（设置页的 PDF 导入在任何版本上都要可用）。
- **只随包附带需要的文件**：未附带 `cmaps/`、`standard_fonts/`、`iccs/`、`*_nowasm_fallback.js`、source map。
  影响：使用预定义 CJK CMap 的 PDF 文本可能缺字或乱码；非嵌入的标准 14 字体用系统字体显示。
  WebAssembly 解码器需要 manifest 里的 `'wasm-unsafe-eval'`（Chrome 允许的 MV3 最低 CSP，不允许 JS eval）。
- **安全选项集中在 `pdf-reader/pdfjs-loader.js` 的 `ZEHPdfjs.documentParams`**：`enableXfa: false`、
  wasm 只从本地加载；调用方不能覆盖。查看器不传 downloadManager，PDF 附件不会被打开或下载。
- 这些库只在扩展自己的页面（`settings.html` / `reader.html` / `pdf-reader.html`）里运行，不注入到网页。
