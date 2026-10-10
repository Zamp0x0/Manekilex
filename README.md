# Manekilex

[![CI](https://github.com/Zamp0x0/Manekilex/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/Zamp0x0/Manekilex/actions/workflows/ci.yml)

个人维护的 Chrome 扩展（Manifest V3，原生 JavaScript，无构建步骤），帮助中文读者读英文：

- **语境查词**：在网页、PDF 和内置 EPUB 阅读器里选中英文，点击招财猫小球，用中文解释词义、此处含义、派生词、同义词、例句和助记。
- **词典优先，AI 补充**：单词和短语先查随扩展附带的本地词典（约 2.5 万条），立即显示；配置了模型 API Key 时，再用一次请求补上此处含义等内容。句子、段落和词典没有的词直接交给模型。
- **多家模型**：OpenAI、DeepSeek、Moonshot、智谱、SiliconFlow、Groq、Gemini，使用你自己的 API Key，同一时间启用一家。
- **生词本与间隔复习**：查过的词连同所在句子存进生词本，按 Again / Hard / Good / Easy 安排复习；可导出 TXT、CSV、Markdown。
- **阅读**：内置 EPUB 阅读器（书签、目录、进度）；TXT、Markdown、HTML、DOCX、PDF 可在本机转成 EPUB。Chrome 151 及以上可用增强 PDF 阅读器打开网页上的 PDF。
- **实时转译（可选）**：麦克风或标签页声音经 AssemblyAI 转成英文字幕，再由所选模型翻译。

没有 API Key 时只能用本地词典查单词和短语。扩展尚未在 Chrome 应用商店发布，目前以「加载已解压的扩展程序」方式使用。

当前版本：**0.11.1**（查词体验与词汇讲解补丁；Phase 5：MVP 加固）

## 项目结构

```
Manekilex/
├── manifest.json            # MV3 入口：service worker、content_scripts、权限
├── background.js            # Service Worker：查词链路、缓存、词典、生词本/复习写入、消息边界
├── config.js                # 共享常量与纯函数：存储键、provider 元数据、Prompt、key 归一化、语境裁剪
├── vocab-review.js          # 生词本 v2 结构 + 复习调度纯函数（SW 与设置页共用）
├── mk-lookup.js             # 划词 UI 控制器（小球 / 面板 / 查词流程 / 生词本）
├── lookup/                  # 划词 UI 的组成部分：渲染 / 选区 / 语境 / 发音 / 彩蛋 / 后台通道
├── sw/                      # Service Worker 的各部分：消息注册表、查词、缓存、词典、生词本、转译、标签页
├── shared/                  # SW 与页面共用：provider 元数据、Prompt、测速用例
├── content.js               # 网页适配层：iframe 宿主、跨域回退、PDF 页跳过
├── pdf-page-assistant.js/css# 浏览器内 PDF 页的猫球 + 面板
├── lookup-panel.html/js     # 侧边栏查词页：Chrome 内置 PDF 查看器（无法注入脚本）的兜底入口
├── reader.html/js/css       # EPUB 阅读器（reader/ 下是它拆出的部分：选区、主题、书签、目录、进度、日志）
├── pdf-reader.html/css      # 增强 PDF 阅读器（pdf-reader/ 下：文档、页面、工具栏、选区、查词适配、PDF.js 加载）
├── book-store.js            # IndexedDB（书籍 / 书签 / 进度）
├── settings.html/js/css     # 设置中心入口：模型、流量、生词本、复习、数据、实时转译、阅读
├── settings/                # 设置页各分区的脚本（core / models / benchmark / usage / data / reading …）
├── live-transcribe.js(+worklet) # 设置页实时转译（AssemblyAI）
├── popup.html/js            # 工具栏弹窗：全局开关、标签页音频捕获
├── importers/               # TXT / MD / HTML / DOCX / PDF → EPUB（设置页内运行）
├── data/dictionary_core.json# 运行时词典（25,518 条，~19.7MB）
├── dic/                     # 词典构建输入（ecdict.csv 需自行下载，git 忽略）
├── scripts/                 # Node 维护脚本（构建 / enrich / 审计 / 清理，均有安全闸）
├── lib/                     # 第三方浏览器库（见 lib/README.md）
├── tests/                   # node:test 测试（npm test）；tests/browser/ 是真实浏览器测试
└── docs/                    # 架构说明、隐私政策草稿、商店文案草稿、发布流程
```

## 查词链路

| 顺序 | 来源 | 说明 |
|------|------|------|
| 1 | 语境缓存 | 同一词 + 同一句子（`:c{hash}` 键）的完整结果 |
| 2 | 通用缓存 v2 | `zehCache:v2:{queryType}:{len}:{hash}`，**只保存模型结果**（词典命中不再写入缓存） |
| 3 | 本地词典 | word / phrase 先查词典；**可用**条目（有中文释义）立刻显示；空壳条目视为未命中 |
| 4 | 语境增强 | 有句子语境且配置了 Key：词典结果先显示，再用**一次**请求异步补齐此处含义、原句翻译、派生词、同义词、助记（`CONTEXT_ENHANCED`，原地更新面板，结果按句子缓存） |
| 5 | 模型 API | 句子、段落、词典未收录词、空壳条目；超时与并发去重见 `config.js` |

页面侧有 queryId 保护：换词、关闭面板、超时之后迟到的结果一律丢弃。

面板顺序：词条 / 音标 / 词性 → 基础释义 → 当前语境 → 用法说明 → 派生词 → 同义词 → 例句 → 助记 → 常见搭配（空的区块不显示）。

- **代码块里的英文**：PRE / CODE 里选中普通单词时，只取它所在那一行里的句子作语境（不跨行、不发整个代码块）；这一行本身像代码（`const bank = accounts.get(id);`）或选中的是代码词（`foo.bar()`）时不带语境
- **助记规则**：优先真实构词 → 同族词 → 可靠词源 → 读音 → 形象联想 → 对比；禁止编造词源 / 词根、把单词硬拆成字母（如 `ban + k`）、重复释义。没有好助记就留空。词典里明显无效的旧助记（硬拆字母、「字母 x 像…」、过短、占位符）不显示，有模型时由语境增强补上
- **生词本**：派生词与助记存在词条上，同义词随所在句子存在语境里；同一个词再次保存时派生词合并去重，已有的可用助记不被覆盖

## 本地加载

1. `chrome://extensions` → 开启**开发者模式**
2. **加载已解压的扩展程序** → 选择本文件夹
3. 改代码后：**重新加载扩展** + 刷新测试页 / 阅读器 / 设置页

### 支持的 Chrome 版本

- 自动测试：Chrome for Testing **155**（CI 的 Browser tests 工作流）。早期也在 Chromium 141 上跑过同一批浏览器测试。
- 增强 PDF 阅读器自动打开网页 PDF 需要 **Chrome 151+**（`chrome.mimeHandler`）。更早的版本里 PDF 仍由 Chrome 自带查看器显示，右上角猫球和右键查词照常可用。
- 侧边栏需要 Chrome 114+。低于 141 的版本没有测试过；`manifest.json` 目前没有设置 `minimum_chrome_version`。
- 只支持桌面版 Chrome（Windows、macOS、Linux）。

## 使用

1. 工具栏图标 → **设置中心** → **模型与 API** 配置 Key（同一时间只启用一个平台）
2. 网页选中英文 → 招财猫小球 → 点击 → 面板（单词 / 短语 / 句子 / 段落显示不同）
3. 面板：发音、**加入生词本**（带本句语境）、复制、进设置
4. **PDF**：Chrome 151+ 打开网页上的 PDF 时默认用 Manekilex 的增强阅读器显示，里面可以直接划词；工具栏可切回 Chrome 自带查看器，设置里可以关闭这项接管。也可以在设置里打开本地 PDF（只在内存中读取，不保存、不上传）。在 Chrome 自带查看器里：右上角猫球；选中后右键 → **Manekilex 查词**，结果在侧边栏打开
5. **EPUB 阅读器**：设置 → 阅读 → 上传书籍 / 继续阅读；滚到章首章尾切章；目录、书签、进度自动保存
6. **生词本**：同一个词在不同句子里保存时合并为一条、最多 8 条语境；删除 / 导出 TXT、CSV、Markdown
7. **复习**：设置 → 复习；先回忆再显示答案，按 Again / Hard / Good / Easy 评分决定下次复习时间

## 安全与数据边界

完整说明见 [隐私政策草稿](./docs/PRIVACY.md)。要点：

- 扩展没有自己的服务器，不收集统计或遥测。数据只在本机，或由你触发后直接发给你配置的服务商。
- API Key 只存本机 `chrome.storage.local`（不同步、未加密），只发给对应服务商的固定接口地址；扩展不内置 Key，错误提示不显示 Key
- 发给模型的是你点击小球后选中的文本，单词和短语还带上所在句子（最多 400 字符；句子很短时再加最多 600 字符的上下文），不发送网址、页面标题、书名或整份 PDF / EPUB。网页里的脚本伪造的点击不会触发查词
- 实时转译时，麦克风或标签页的音频发给 AssemblyAI，转写文字发给所选模型翻译；音频和字幕都不保存
- 书籍、书签、阅读进度只存本机 IndexedDB；多格式转 EPUB 在本机浏览器内完成
- **消息边界**：注入网页的内容脚本只能发起 `EXPLAIN` / `ADD_VOCAB` / `OPEN_SETTINGS` / `PDF_PAGE_ASSISTANT_READY` / `PDF_PAGE_ENHANCED` / `GET_DICT_KEY_LIST`；删除、复习、迁移、清缓存、provider / 测速 / 转译等改数据或花钱的消息只接受扩展自己的页面（注册表 `sw/router.js` → `ZEH_MESSAGE_ROUTES`）
- 生词本的所有写入都在 service worker 内串行执行（设置页只读 + 监听 `storage.onChanged`）
- 内容脚本注入 `<all_urls>` 的所有 frame；`chrome://`、商店页、地址栏无法注入

## 本地词典

| 项目 | 说明 |
|------|------|
| 规模 | **25,518** 条（Phase 5 前 25,687；清理掉 72 条空壳、97 条占位数字 / 纯符号 key，修正 11 条中文 term） |
| 来源 | ECDICT 白名单（google-10000 / Oxford 3000 / wordfreq 25k / 手动补词）→ DeepSeek 批量 enrich（例句、记忆、搭配）→ `add-dictionary-words.js` 增量 → Phase 5 `clean-dictionary-entries.js`。Phase 5 之前若有手工编辑，没有留下记录。来源与许可详见 [data/README.md](./data/README.md) |
| 可用性 | 运行时不只看 `enriched:true`：没有中文释义的条目当未命中处理，交给模型兜底，也不写缓存（`zehIsDictEntryUsable`） |
| 词性 | 文件里仍有多种拼写（`n.` / `noun` / `名词`…）；展示时由 `zehNormalizePartOfSpeech` 统一（缩写展开、分隔符统一、去重），未批量改写文件 |
| 归一化 | `i'm` ↔ `i am`、`dont` → `don't`、弯引号、大小写、词形 forms 反向索引 |

### 维护命令

```bash
npm run clean:dictionary                 # 只报告；加 --write 才写回（先备份，原子写入）
npm run audit:dictionary -- --structural --all-entries
node scripts/add-dictionary-words.js vaporize            # 增量加词（原子写入 + 备份）
node scripts/enrich-dictionary.js --keys vaporize --force # 需 DEEPSEEK_API_KEY

# 危险操作都有安全闸：
npm run build:dictionary                 # 目标已含 enriched 数据时拒绝；--force-overwrite 才覆盖（先备份）
npm run migrate:dictionary               # 同上
node scripts/enrich-dictionary.js        # 无范围参数直接拒绝；全量需 --confirm-full-run（先 --scan）
```

所有写入 `data/dictionary_core.json` 的脚本都经过 `scripts/dictionary-file.js`：写临时文件 → 重新解析校验 → 可选备份 → rename。备份文件 `data/*.bak-*` 已加入 `.gitignore`，确认无误后手动删除。

改完词典后务必**重新加载扩展**。

## 上传书籍（多格式 → EPUB）

| 格式 | 说明 |
|------|------|
| EPUB | 直接入库 |
| TXT / Markdown / HTML / DOCX | 本机转换：解析 → 清洗（去脚本 / 样式 / 表单，属性白名单）→ 按 XML 规则序列化 → 按标题在 DOM 上拆章（首个标题前的内容单独成章）→ 生成前校验每章 XHTML 良构 |
| PDF 文本模式 | 提取文字，可划词 |
| PDF 原貌模式 | 每页转图片，保留排版，不可划词 |

限制：EPUB ≤100MB · TXT/MD/HTML ≤20MB · DOCX ≤50MB · PDF ≤50MB。不支持 OCR、MOBI、AZW3、DRM。

## 实时转译

设置 → **实时转译**：麦克风或标签页声音 → AssemblyAI 流式听写 → 所选模型翻译（不走查词缓存）。需要你自己的 AssemblyAI Key，存本机 `zehAssemblyAI`；清空输入框后保存即删除。标签页声音需从工具栏弹窗开始捕获。详见 `docs/ARCHITECTURE.md`。

## 支持的平台

OpenAI、DeepSeek、Moonshot/Kimi、智谱 GLM、SiliconFlow、Groq（OpenAI 兼容接口）、Google Gemini（generateContent）。定义在 `config.js` → `ZEH_PROVIDER_META`；日常查词推荐 flash / mini / lite 级别模型。默认模型：OpenAI `gpt-6-luna`、DeepSeek `deepseek-flash`（`deepseek-v4-flash` 只是旧兼容别名）、Moonshot `kimi-k2.6`、智谱 `glm-4-flash`、SiliconFlow `deepseek-ai/DeepSeek-V4-Flash`、Groq `openai/gpt-oss-20b`、Gemini `gemini-3.5-flash-lite`。只有「没填模型」或「正好等于旧的 Manekilex 默认值」才会迁移到新默认，自己填的模型名不动。查词请求统一走 Chat Completions，按模型自动关闭推理 / thinking（`zehApplyProviderRequestOptions`）。设置页有模型测速 Benchmark（job + checkpoint，不写查词缓存 / 生词本）。

## 开发与测试

需要 Node.js 22（`engines` 最低 20；CI 用 22）。Windows / macOS / Linux 均可。

```bash
npm ci                 # 按 package-lock.json 安装（只有 csv-parse）
npm test               # node --test，纯 Node 内置运行器，离线，不调用付费 API
npm run check          # 只读检查：语法、manifest / 版本、词典完整性、仓库卫生
npm run test:browser   # 真实浏览器测试（需要 Playwright 与 Chrome，见下）
npm run perf           # 查词、PDF、EPUB 的耗时基线（同样需要浏览器）
node scripts/package-release.js   # 生成私有扩展压缩包（不得分发，见 docs/RELEASE.md）
```

浏览器测试不把 Playwright 写进依赖：`npm install --no-save --no-package-lock playwright-core@1.56.1`，再用 `MK_BROWSER_PATH` 指向 Chrome for Testing 151+（例如 `npx @puppeteer/browsers install chrome@stable`）。`MK_REQUIRE_MIME=1` 让 PDF MIME 用例不能跳过；Linux 无显示器时用 `MK_HEADED=1 xvfb-run -a npm run test:browser`。除 localhost 外所有域名都解析失败，模型请求由 service worker 里的桩函数回答，不需要真实 API Key。`MK_EXTENSION_DIR` 指向解压后的发布包时，同一套用例在发布包上运行。

`npm run check` 也可以单独跑某一项：`check:syntax`（对 `lib/` 以外的 JS 跑 `node --check`）、`check:manifest`（Manifest V3、引用文件存在，manifest / package / package-lock / README 版本一致）、`check:dictionary`（`data/dictionary_core.json` 可解析，无空壳、垃圾 key、中文词头）、`check:hygiene`（没有 `claude_report/`、`.cursor/`、私有审计、备份文件、`node_modules`、`.env` 或明显的密钥）。

GitHub Actions：`ci.yml` 在推送到 `master` 和指向 `master` 的 PR 上运行 `npm ci`、`npm run check`、`npm test`，生成两次私有压缩包并核对字节一致与内容，另有 `npm audit` 与 `npm audit signatures`；`browser.yml` 在推送到 `master` 时用 Chrome for Testing 分别对检出的代码和解压后的发布包跑浏览器测试。全部为只读权限，action 固定到提交 SHA，不需要任何 secret，不调用付费 API，不上传或发布任何东西。

- `tests/*.test.js` 用 `node:vm` 加载真实的 `config.js` / `background.js` / `mk-lookup.js` / `content.js` / `settings.js` + `settings/*.js` / `book-store.js` / `reader.js` / `importers/*`
- `tests/helpers/`：扩展沙箱（假 chrome.*、storage、消息分发）、假 DOM、迷你 HTML/XML 解析器（导入器）、假 IndexedDB、假 epub.js
- 唯一的 npm 依赖是 `csv-parse`（devDependency，仅 `build-dictionary.js` 使用）；浏览器库在 `lib/`

## 调试

- `config.js` → `ZEH_DEBUG_LOGS = false`：改为 `true` 后 `zehDebugLog` 输出 `[ZEH lookup]`、`[ZEH dict]`、`[LiveTranscribe]` 等详细日志；warn / error 不受开关影响
- Reader：URL 加 `&debug=1`（如 `reader.html?id=xxx&debug=1`）输出位置链路日志并显示调试浮层
- Service Worker：`chrome://extensions` → Inspect；被拒绝的消息会打印 `rejected message from non-extension sender`

## 已知限制

- `chrome://`、商店页等无法注入；**地址栏（omnibox）不支持划词**（浏览器界面，不是网页）；网页里的搜索框、ChatGPT 输入框、`input[type=text|search]`、`textarea` 都可以
- 面板直接挂在网页的 DOM 里（未做 Shadow DOM）：部分站点 CSS 可能影响面板，网页脚本也能读到面板里显示的释义
- 跨域 iframe 内面板受 iframe 视口限制
- 在 `chrome://extensions` **重新加载 / 更新扩展后，已经打开的标签页里的旧脚本会失效**（Chrome 不会给它们重新注入）：在这些页面选中文字时会出现「请刷新页面」横幅，刷新一次即可。没有做后台自动重新注入：那需要 `<all_urls>` 的 host 权限
- 实时转译需 `tabCapture`；部分页面无法捕获音频。麦克风与标签页音频只做过人工验证，没有自动化测试
- 增强 PDF 阅读器没有附带 CJK CMap 与标准字体，使用预定义 CJK CMap 的 PDF 可能缺字（见 `lib/README.md`）
- EPUB 打开时有约 1 秒的固定等待；切换很多章节后旧章节文档会留在内存里，重新打开书时释放
- 没有「清除全部数据」按钮：生词本、书籍、缓存、用量记录各自在设置里删除；卸载扩展会删除全部本地数据
- 未发布到 Chrome 应用商店

## 许可与来源

- 本项目代码以 [MIT License](./LICENSE) 发布，Copyright (c) 2026 Zamp。
- `lib/` 里的第三方库（epub.js、JSZip、mammoth.js、marked、PDF.js）各自保留原许可，见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。
- 词典与词表的来源、AI 生成内容和尚未核实的部分见 [data/README.md](./data/README.md)。词典的中文释义和词形大量来自 [ECDICT](https://github.com/skywind3000/ECDICT)（MIT）；例句、语境说明、助记、搭配等由 DeepSeek 生成，可能有错误。
- 招财猫吉祥物与图标（`icons/`、`assets/`）由作者借助 AI 图像工具生成，不主张超出法律允许范围的权利。
- `dic/google-10000-english-usa.txt`、`dic/The_Oxford_3000.txt`、`poem/quotes.json` 的再分发许可尚未核实，不在 MIT 许可范围内；公开发布前需要替换或移除（待作者决定）。发布包不含 `dic/` 与 `poem/quotes.json`。

## 反馈与安全

- 问题与建议：GitHub Issues（模板在 `.github/ISSUE_TEMPLATE/`）。参与开发见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
- 安全问题请不要公开提交，见 [SECURITY.md](./SECURITY.md)。

## 更多

架构、消息协议、存储结构、词典数据流：**[docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)**。
