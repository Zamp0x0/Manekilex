# 参与开发

谢谢你愿意改进 Manekilex。这是一个个人维护的项目，回复可能不及时；较大的改动请先开 Issue 讨论。

## 环境

- Node.js 22（最低 20），Chrome 或 Chrome for Testing（增强 PDF 阅读器需要 151+）。
- 扩展没有构建步骤：改完代码在 `chrome://extensions` 重新加载即可（见 README「本地加载」）。
- `npm ci` 只安装测试和词典脚本用的 `csv-parse`；浏览器库放在 `lib/`，不通过 npm 安装。

## 提交前

```bash
npm run check          # 语法、manifest 与版本、词典、仓库卫生
npm test               # 离线单元测试，不调用付费 API
npm run test:browser   # 改动涉及页面、内容脚本、阅读器或 PDF 时运行（配置见 README「开发与测试」）
```

CI 会在 PR 上运行 `check`、`test`、打包校验和依赖审计；浏览器测试在合并到 `master` 后运行。

## 约定

- **不新增框架和构建工具**。页面是一组共享全局作用域的 classic script，加载顺序写在各 HTML 和 `manifest.json` 里。改动顺序或新增全局名称时，`tests/load-order-*.test.js` 与 `tests/global-surface.test.js` 会提示；确认是有意的改动后用 `UPDATE_GLOBAL_SURFACE=1 node --test tests/global-surface.test.js` 更新清单，并在同一个提交里说明原因。
- **契约快照**：发给模型的提示词与请求体、缓存键等在 `tests/fixtures/golden/` 里有快照（`UPDATE_GOLDEN=1`），查词面板与设置页结构也有快照（`UPDATE_LOOKUP_SNAPSHOT=1`、`UPDATE_SETTINGS_SECTIONS=1`）。只有确实要改变这些行为时才更新，并在提交说明里写清楚。
- **消息**：service worker 接收的每种消息都登记在 `sw/router.js` 的 `ZEH_MESSAGE_ROUTES`，写明发送方（内容脚本可发的 `"any"`，或只接受扩展页面的 `"extension-page"`）。改数据、花钱或读取敏感数据的消息只能是 `"extension-page"`。`tests/message-registry.test.js` 与 `tests/message-security.test.js` 会核对。
- **网页里的 UI**：查词小球和面板挂在网页的 DOM 里。处理点击等操作时忽略网页脚本合成的事件（`isTrusted === false`），插入 HTML 时用 `zehEscapeHtml` 转义所有来自网页、模型或词典的文字。
- **存储**：不要改已有的 `chrome.storage` 键名和 IndexedDB `zeh-reader` 的结构；确需迁移时写迁移代码和测试。
- **第三方文件**：新增或升级 `lib/` 里的库时，更新 `lib/README.md`（版本、来源、SHA-256）和 `THIRD_PARTY_NOTICES.md`；新增数据或图片时在 `data/README.md` 写明来源与许可。`tests/vendor-provenance.test.js` 会检查。来源或许可不清楚的文件不要提交。
- **测试**：修 bug 时先写能复现的测试。浏览器测试只用本地页面和服务 worker 里的模型桩函数，不要依赖外网。

## 密钥与费用

- 不要提交任何 API Key、`.env` 或私有报告；`npm run check` 的 hygiene 检查会拦截常见情况。
- 测试只用占位 Key，模型请求由桩函数回答。
- 词典维护脚本（`scripts/enrich-dictionary.js`、`scripts/audit-dictionary.js --semantic`）会调用付费的 DeepSeek API：先用 `--scan` 看规模和费用估算，优先增量运行（`--keys`、`--retry-failed`），先跑 `--structural` 再跑 `--semantic`。全量运行需要 `--confirm-full-run`。Key 只从 `.env` 读取（见 `.env.example`）。

## 提交与 PR

- 一个提交只做一件事，提交说明写清楚改了什么、为什么。
- PR 按模板填写：改了什么、怎么测试的、是否影响权限、存储、发给服务商的数据或第三方文件。
- 提交即表示你同意以本项目的 MIT 许可提供你的贡献。

## 安全问题

请不要在 Issue 里公开安全漏洞，见 [SECURITY.md](./SECURITY.md)。
