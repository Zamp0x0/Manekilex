# 发布流程

> 当前只生成**私有**构建，用于本地测试。压缩包文件名和包内的 `NOT_FOR_DISTRIBUTION.txt` 都标明不得分发：在许可与安全问题解决、维护者决定发布之前，不要上传到 Chrome 应用商店、不要附到 GitHub Release、不要分享。

## 1. 生成压缩包

```bash
npm ci
npm run check
npm test
node scripts/package-release.js            # 从 HEAD 打包到 dist/
node scripts/package-release.js --verify dist/manekilex-*.zip
```

输出（`dist/` 已加入 `.gitignore`）：

| 文件 | 内容 |
| --- | --- |
| `manekilex-<版本>-<提交>-PRIVATE-NOT-FOR-DISTRIBUTION.zip` | 扩展包 |
| `….zip.sha256` | 压缩包的 SHA-256 |
| `….files.txt` | 包内每个文件的 SHA-256 和大小 |

其他选项：`--ref <提交>` 从指定提交打包，`--out <目录>` 改输出目录，`--list` 只列出将要打包的文件。

## 2. 可复现

- 文件内容直接从 Git 提交读取，不读工作区：未提交的修改、换行符差异（Windows 检出为 CRLF）、被忽略的本地文件（如 `icons/lucky.png`）都不会进包。
- 条目按路径排序，时间戳取提交时间，权限固定为 0644，使用不压缩的 STORE 方式（不同 Node / zlib 版本的 deflate 结果可能不同）。
- 因此同一提交在任何系统、任何 Node 版本上得到同一个 SHA-256。CI 每次构建两次并逐字节比较。

## 3. 包里有什么

- 运行时文件：根目录的 `*.js`、`*.html`、`*.css` 与 `manifest.json`；`importers/`、`lib/`、`lookup/`、`pdf-reader/`、`reader/`、`settings/`、`shared/`、`sw/`、`icons/` 下的已跟踪文件；`data/dictionary_core.json`。
- 许可与来源：`LICENSE`、`THIRD_PARTY_NOTICES.md`、`data/README.md`、`lib/README.md`、`lib/pdfjs/LICENSE` 与 `lib/pdfjs/wasm/LICENSE_*`。
- `NOT_FOR_DISTRIBUTION.txt`：提交、日期和故意排除的文件。

不进包：`tests/`、`scripts/`、`docs/`、`dic/`、`assets/`、`.github/`、点文件、`package*.json`、`node_modules/`、报告与备份文件、`icons/lucky.png`，以及再分发许可尚未核实的 `poem/quotes.json`（设置页「每日一句」在缺少它时显示内置的一句）。规则写在 `scripts/package-release.js` 顶部。

## 4. 校验内容

打包前和 `--verify` 都会检查：

- 没有不允许进包的路径，没有许可未核实的文件；
- `manifest.json` 为 MV3、版本号合法、没有 `key` / `update_url`；
- manifest 引用的 service worker、内容脚本、样式、图标、页面都在包里，`web_accessible_resources` 有匹配的文件；
- 各页面的 `<script src>` / `<link href>`、service worker 的 `importScripts`、代码里 `chrome.runtime.getURL` 与扩展内路径引用的文件都在包里；
- PDF.js 及其 wasm 解码器的许可证文件都在。

写出的压缩包会读回来逐个文件比对，并校验 CRC。CI（`browser.yml`）还会把压缩包解压后，用 `MK_EXTENSION_DIR` 在 Chrome for Testing 里跑完整的浏览器测试。

## 5. 发布前检查清单

正式发布（公开仓库、上传商店）之前，至少确认：

1. `data/README.md` 中标为需要替换的词表与名言集已经替换或删除，图片的生成工具与条款已确认；
2. Git 历史中不应公开的内容已经处理；
3. `docs/PRIVACY.md` 经维护者审阅，补上联系方式与生效日期，并发布到公开地址；
4. `docs/STORE_LISTING.md` 的文案、权限说明与数据披露经维护者确认，商店截图与宣传图已制作；
5. 在真实设备上手动验证麦克风与标签页音频转写、Chrome 自带 PDF 查看器里的右键查词；
6. 版本号已提升（`npm run check:manifest` 会核对各处一致）；
7. `npm run check`、`npm test`、`npm run test:browser`（`MK_REQUIRE_MIME=1`）与两个 CI 工作流全部通过；
8. 从要发布的提交重新生成压缩包，核对 SHA-256。

商店上传、GitHub Release 和仓库公开都由维护者手动完成；CI 不会自动发布任何东西。
