# Manekilex — 架构与文件说明

> **版本**：0.11.1（查词体验与词汇讲解补丁；Phase 5：MVP 加固）
> **定位**：个人维护的 Chrome 扩展（Manifest V3，原生 JavaScript，无构建步骤）。网页 / PDF / EPUB 划词查词 + 语境释义 + 生词本复习 + 设置页实时转译。
> **安装与用法** → [README.md](../README.md)。

---

## 1. 整体架构

```
┌──────────────────────────────────────────────────────────────────────┐
│ 页面层                                                                │
│  content.js (网页, 所有 frame)   reader.js (EPUB)   lookup-panel.js   │
│  pdf-page-assistant.js (PDF)                        (侧边栏 PDF 兜底)  │
│        └──────────────┬─────────────────┘                 │           │
│                 mk-lookup.js  MKLookup.createController   │           │
│                 小球 / 面板 / 查词流程 / 加生词             │           │
│                 lookup/*.js  渲染 · 选区 · 语境 · 发音 · 通道 │           │
│                                                                      │
│  settings.js + settings/*.js  模型 / 流量 / 生词本(只读) / 复习 / 数据 / 阅读 / 实时转译 │
│  popup.js     全局开关 / 标签页音频捕获                                 │
└───────────────┬────────────────────────────────────┬─────────────────┘
                │ chrome.runtime.sendMessage          │ chrome.storage.onChanged
                ▼                                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│ background.js（Service Worker 入口）importScripts: config, provider-benchmark, vocab-review, sw/*.js │
│  0. 消息边界：内容脚本只能发 5 类消息；其余只接受扩展页面                   │
│  1. 查词：语境缓存 → 通用缓存(仅模型结果) → 词典(可用条目) → 语境增强 → API  │
│  2. 生词本 / 复习：zehUpdateStorageList 按 key 串行的读-改-写队列            │
│  3. Provider 调用、用量日志、缓存清理、Benchmark job、实时转译翻译            │
└───────────────┬──────────────────────────────────────────────────────┘
                ▼
┌──────────────────────────────────────────────────────────────────────┐
│ 本地数据：chrome.storage.local（设置 / 生词本 / 缓存 / 日志）           │
│           IndexedDB zeh-reader（EPUB blob / 书签 / 进度）               │
│           data/dictionary_core.json（打包在扩展内，按需 fetch）          │
└──────────────────────────────────────────────────────────────────────┘
```

### 查词链路（`sw/lookup.js` → `handleExplain`）

| 步骤 | 条件 | 行为 |
|------|------|------|
| 0 | 文本是 Manekilex 品牌词 | 本地彩蛋条目，直接返回 |
| 1a | 带语境且语境缓存命中 | 返回完整语境结果（键 `…:c{hash}`） |
| 1b | 通用缓存命中 | 返回；带语境且有 Key 则再异步 `CONTEXT_ENHANCED` |
| 2 | word / phrase 且词典命中**可用**条目 | 立即 `SHOW_RESULT fromDict`（旧助记先过 `zehIsUsefulMemoryTip`）；带语境且有 Key → 异步语境增强；**不写缓存** |
| 2' | 词典命中但是空壳（无中文释义） | 当未命中处理（`missReason = dictionary_entry_empty`） |
| 3 | 以上都未命中 | 无 Key → `NO_API_KEY`；有 Key → 并发去重后调用模型，结果写缓存 + 用量日志 |

页面侧用 `queryId` 保护（`lookup/runtime.js` 的 `isStaleQueryMessage` 与 `mk-lookup.js` 的 `applyContextEnhancement`）：换词、关闭、超时后迟到的 `SHOW_RESULT` / `CONTEXT_ENHANCED` 一律丢弃；查词结果只发回发起查询的 frame（M3b），扩展页面收到的 runtime 广播也靠它区分。超时常量在 `config.js`（`ZEH_LOOKUP_PROVIDER_TIMEOUT_MS`）。

### 语境（Phase 3）

页面在选区附近读取有限长度的句子（`ZEH_CONTEXT_LIMITS`），SW 用同一套 `zehNormalizeLookupContext` 再校验、再限长，不信任页面传来的长度。PDF 页没有语境。

0.11.1：代码容器（`zehFindCodeElement`：CODE/SAMP/KBD、PRE、高亮类名）里的选区只在该容器内读取，`zehBuildLookupContext({ inCode: true })` 只取所在行的句子（去掉行首注释符，不带 nearby）；所在行 `zehLooksLikeCodeLine` 为真时不发语境。`foo.bar()` 这类无空格点路径在 `isLikelySentence` 里不再算句子，按 `code_term` 查。

### 词汇讲解（0.11.1）

一次语境增强请求（`ZEH_CONTEXT_ENHANCE_PROMPT`，老师人设 + 助记规则 + 防注入说明）返回 `meaning_here`、`pos_here`、`sentence_translation`、`memory_tip`、`memory_tip_type`、`derivatives[{word,pos,zh}]`、`synonyms[{word,zh,nuance}]`、`examples`。`zehNormalizeContextEnhancement` 清洗限长（派生词 / 同义词各最多 5 个，去掉与原词相同、仅大小写或 -s/-es 的条目），`zehMergeContextEnhancement` 合并：基础释义不变、同义词跟随此处义项、派生词合并去重、已有的可用助记保留。已有可用助记时请求里带 `has_memory_tip: true`，模型不再写助记。`zehIsUsefulMemoryTip` 是保守质量门：只拒绝硬拆单字母的 `+` 拆分、「字母 x 像…」、只重复拼写、过短、占位符、与释义相同；拿不准就保留。

---

## 2. 运行时文件

### 入口与共享

| 文件 | 作用 |
|------|------|
| `manifest.json` | MV3：`background.service_worker`、content_scripts（`<all_urls>`，all_frames）、`side_panel`、权限 storage / unlimitedStorage / tabs / contextMenus / sidePanel / tabCapture / activeTab |
| `config.js` | 核心（每个上下文第一个加载，M5 后约 64 KB）：`ZEH_STORAGE`、缓存键与缓存策略、查词类型判定与 key 归一化（`zehLookupKeyVariants`）、语境裁剪、结果清洗、词典可用性（`zehIsDictEntryUsable`）、词性展示归一（`zehNormalizePartOfSpeech`）、调试开关 `ZEH_DEBUG_LOGS` / `zehDebugLog`；多处共用的小工具：HTML 转义 `zehEscapeHtml`（含引号，mk-lookup / reader / settings 共用，settings 保留全局别名 `escapeHtml`）、Manekilex 总开关订阅 `zehSubscribeEnabled`（content / PDF 页 / reader 共用）、PDF 判定 `zehIsPdfViewerUrl`（content / PDF 页 / SW 共用） |
| `shared/providers.js` | provider 元数据与设置：`ZEH_PROVIDER_META` / `ZEH_PROVIDER_IDS`、旧模型名迁移、`zehApplyProviderRequestOptions`、`zehMergeProviderEdits`、默认 provider / AssemblyAI 配置。SW 与设置页加载 |
| `shared/prompts.js` | 查词提示词与请求模板：`zehBuildSystemPrompt`、`zehMaxTokens`、语境请求 `zehBuildContextLookupRequest` / `zehBuildContextEnhanceRequest`。只有 SW 加载 |
| `shared/benchmark-cases.js` | 测速候选模型、模式计划、测试用例（`ZEH_BENCHMARK_*`）。SW 与设置页加载，在 `provider-benchmark.js` 之前 |
| `lookup/dom-helpers.js` | 页面侧：选区修复 `zehRepairSelectionWithContext`、代码块判定 `zehFindCodeElement`、词典 key 集合 `zehEnsureDictKeys`（同源 frame 共享）。内容脚本、reader、侧边栏加载，SW / 设置页 / 弹出页不加载 |

M5 按「谁用」拆 `config.js`：`shared/` 与 `lookup/` 文件都紧跟在 `config.js` 后加载、只声明（M7 的 `lookup/*.js` 工厂也遵守这条，见「划词 UI」）；`tests/config-split.test.js` 检查加载位置、没有重复声明、SW 文件不引用 DOM 全局。
| `vocab-review.js` | 生词本 v2 结构与复习调度纯函数（见 §5） |
| `background.js` | Service Worker 入口（M4）：`importScripts` 列表、两个启动任务（`initCacheMaintenance`、benchmark 续跑）、全部 `chrome.*` 监听注册（都在第一次同步执行时完成）。本文件不声明函数或变量 |
| `sw/storage-queue.js` | `zehUpdateStorageList`：按 key 串行的读-改-写队列 |
| `sw/settings.js` | `getAppSettings`、`migrateLegacySettings`：读设置、旧 OpenAI 键迁移 |
| `sw/cache.js` | 查词缓存 v2：读写、统计、按类型上限清理、每日维护 |
| `sw/dictionary.js` | 本地词典按需加载与查找（`zehLoadDictionary`、`getDictionaryEntry`） |
| `sw/provider-client.js` | OpenAI 兼容 / Gemini 请求、超时、错误归类、用量日志 |
| `sw/lookup.js` | 查词流程 `handleExplain`：缓存 → 词典 → 语境增强 → 模型 |
| `sw/vocab.js` | 生词本增删、复习、v2 迁移 |
| `sw/transcribe.js` | 实时转写：字幕翻译、AssemblyAI 临时 token、转写 provider 选择 |
| `sw/benchmark.js` | Provider benchmark job：开始、逐条执行、取消、清除、按结果设模型 |
| `sw/tabs.js` | 右键菜单、PDF 查看器判定、侧边栏查词、标签页音频捕获目标 |
| `sw/router.js` | 消息注册表 `ZEH_MESSAGE_ROUTES` 与发送方检查 `zehAuthorizeMessage`（见 §3） |

`sw/` 模块只声明、加载时不执行（唯一例外是 `sw/tabs.js` 用 `chrome.runtime.getURL` 取扩展页面前缀），按依赖顺序排在 `importScripts` 里；`tests/sw-modules.test.js` 检查这些规则，`tests/sw-startup.test.js` 固定启动时的 chrome 调用顺序。

### 划词 UI

| 文件 | 作用 |
|------|------|
| `mk-lookup.js` | `MKLookup.createController()`：小球与面板的生命周期、查词流程、`ADD_VOCAB`、超时、bfcache、对外 API；下面的 `lookup/*.js` 由它为每个控制器各实例化一次 |
| `lookup/render.js` | M7：结果面板的 HTML 与「复制」文本（单词 / 句子 / 段落 / 代码术语 / 语境区块），只拼字符串 |
| `lookup/egg.js` | M7：Manekilex 彩蛋动画（弹幕、掉落、预载图片），计时器留在闭包里 |
| `lookup/tts.js` | M7：发音与 Web Speech 预热（每个控制器一个 voiceschanged 监听） |
| `lookup/selection.js` | M7：读取与修正选区：跨 iframe / Shadow DOM 找选区、Range 与输入框矩形、半个单词扩展 |
| `lookup/context.js` | M7：查词语境：选区附近有限长度的文本快照、按最终查询词定位句子 |
| `lookup/runtime.js` | M7：与后台的通道（`safeSendMessage` / `safeStorageGet`）、扩展上下文失效防护与刷新横幅、`isStaleQueryMessage` |
| `content.js` | 网页适配：同源 iframe 把 UI 挂到顶层、跨域 iframe 静默回退、PDF embed 子帧跳过、禁用态只挂最小监听 |
| `pdf-page-assistant.js/css` | 浏览器内 `.pdf` 页右上角猫球 + 面板（右键菜单触发 `PDF_PAGE_LOOKUP`） |
| `lookup-panel.html/js` | 侧边栏查词页：Chrome 内置 PDF 查看器无法注入内容脚本时，`openSidePanelLookup` 把选中文本编码进侧边栏路径（`lookup-panel.html?text=…`，最长 3000 字符）并打开侧边栏。侧边栏只读 `?text=`；旧的悬浮窗协议（`?mode=pdf`、`PDF_ASSISTANT_*` 消息）没有发送方，已在 M1 删除 |
| `styles.css` / `mk-buttons.css` | 面板、小球、按钮样式 |

### 设置中心与入口

| 文件 | 作用 |
|------|------|
| `settings.html/js/css` | 模型与 API（自动保存，Phase 5 起按「最新存储 + 本页改动」合并）、流量统计、生词本（只读视图 + 通过 SW 删除）、复习、数据（缓存统计 / 清理 / 阅读位置缓存 / 重置书架进度）、阅读（上传、书架、继续阅读）、实时转译 |
| `settings/*.js` | 设置页按分区拆分的经典脚本（M6），`settings.html` 依次加载 `core` → `models` → `benchmark` → `appearance` → `usage` → `data` → `transcription` → `book-import` → `reading` → `vocabulary` → `review`，最后是 `settings.js`。它们共享设置页的全局作用域，加载时只声明（`benchmark.js` 的 `beforeunload` 除外）；`settings.js` 只剩启动加载、导航与页面级监听、时钟。`core.js` 放分区元数据与 `switchSection`、扩展失效保护、storage 包装和页面主题，各分区之间只通过这些共用函数、storage 和 service worker 消息联系 |
| `live-transcribe.js` / `live-transcribe-worklet.js` | AssemblyAI 流式听写 + 同传窗口；16kHz PCM AudioWorklet。每次开始录音建立一个会话，会话记下自己打开的 WebSocket、音频流和 AudioContext：停止、新的开始或提前返回只释放这个会话的资源，旧 socket 的事件不影响新会话 |
| `popup.html/js` | 全局开关、标签页音频捕获入口 |
| `daily-lines.js` | 设置页随机名言（`poem/quotes.json`） |

### EPUB 阅读器

| 文件 | 作用 |
|------|------|
| `reader.html/js/css` | epub.js 滚动模式渲染、滚轮切章、目录跳转、书签跳转、进度恢复与保存、多标签页归属；`reader.js` 是协调者，下面的部分由它创建并注入所需状态 |
| `reader/log.js` | M8：`?debug=1` 调试输出与位置调试浮层（`zehCreateReaderLog`） |
| `reader/progress.js` | M8：进度公式 progress = clamp((spine + clamp(ratio)) / 章节数)（`zehCreateReaderProgress`） |
| `reader/selection.js` | M8：书内选区的两条出口 —— 划词查词的猫、右键书签菜单（`zehCreateReaderSelection`） |
| `reader/theme.js` | M8：纸张 / 背景配色、保存（`zehReaderTheme`）与配色面板（`zehCreateReaderTheme`） |
| `reader/bookmarks.js` | M8：添加书签、书签列表的重命名 / 删除、书签面板开关（`zehCreateReaderBookmarks`）；跳转仍在 `reader.js` 的 `jumpTo` |
| `reader/toc.js` | M8：目录摊平与渲染、href ↔ spine 对应、当前项高亮（`zehCreateReaderToc`）；目录跳转仍在 `reader.js` 的 `jumpToTocItem` |
| `book-store.js` | IndexedDB 封装：`books` / `bookmarks`；所有事务 `oncomplete` / `onerror` / `onabort` 都让 Promise 结束；`reorderBooks` / `claimActiveReaderSession` 在同一 readwrite 事务里读-改-写 |

`reader/` 下的文件只在 `reader.html` 里、在 `reader.js` 之前加载，每个文件只声明一个 `zehCreateReader*` 工厂，加载时不做任何事；`reader.js` 在启动前依次创建它们，把会变化的状态（当前 book、rendition、章节、位置）以函数形式传入，所以拆分后读到的始终是最新值。存储键、IndexedDB（`zeh-reader` 版本不变）、进度公式与保存原因都没有改变。

位置恢复规则（Phase 5）：`refreshBookRecordFromStore` 以「更新的那一份」为准 —— 库记录、`zehReaderPositionCache`（chrome.storage）、内存记录三者取 `lastReadAt` 最大者，开书时不会被较旧的库记录冲掉。多个阅读标签页打开同一本书时，最后打开或最后获得焦点的标签页拥有位置（`activeReaderSessionId`）：旧标签页的写入（包括「回到书架」的强制保存）一律被拒绝，`force` 只跳过阅读页自己的节流；位置缓存带 `sessionId`，开书时只采用当前拥有者写的缓存（没有 `sessionId` 的旧缓存照旧采用）。书签跳转（`jumpTo`）显示后同步 `currentSpineIndex`、进度 UI，并以 `bookmark-jump` 原因持久化（允许的原因只有一份：`ZEHBookStore.SAVE_ALLOWED_REASONS` / `isSaveAllowedPersistReason`，`reader.js` 也用它）。

### 书籍导入（`importers/`，只在设置页运行）

```
File → converters/{txt,markdown,html,docx,pdf-text,pdf-image}-converter.js
     → shared/html-sanitize.js   DOMParser(text/html) → 删除 script/style/iframe/form…
                                 → serializeXhtml：元素/属性白名单、空元素自闭合、XML 转义、剔除非法控制字符
     → shared/chapter-split.js   在 DOM 上拆章：先展开包着 h1–h3 的容器，再按最高级标题切直接子节点；
                                 首个标题前的内容单独成章；无标题则按字数拆
     → epub-builder.js           生成前 validateChapterXhtml（纯文本良构检查 + DOMParser application/xhtml+xml 复核）
                                 任一章不合法即抛错，不生成坏 EPUB
```

`shared/pdf-utils.js` 通过 `pdf-reader/pdfjs-loader.js`（`ZEHPdfjs.documentParams`：XFA 关闭、wasm 只从本地加载）调用 PDF.js 6.4.299，见 `lib/README.md`。Reader 永远只读 EPUB。

### 静态资源与第三方库

| 路径 | 作用 |
|------|------|
| `data/dictionary_core.json` | 运行时词典，25,518 条，~19.7MB，SW 按需 fetch 后建 Map + forms 反向索引 |
| `lib/` | epub.js 0.3.93、JSZip 3.10.1、mammoth 1.12.0、marked 18.0.5、PDF.js 6.4.299（`lib/pdfjs/`；来源与 SHA-256 校验见 `lib/README.md`） |
| `icons/`、`assets/`、`poem/` | 图标、源图（不进扩展包）、名言（许可未核实，暂不进扩展包，见 `docs/RELEASE.md`） |

---

## 3. 消息协议与发送方边界

### 注册表（`sw/router.js` → `ZEH_MESSAGE_ROUTES`，M3）

SW 接收的每一种消息在 `ZEH_MESSAGE_ROUTES`（`Map`）里登记一次：`from`（`"any"` / `"extension-page"`，即下表的发送方规则）、`payload`（handler 读取的字段，仅说明）、`senders`（发出它的文件）、可选 `validate`（handler 之前的校验，失败时把 `response` 原样回给发送方：`EXPLAIN` 的文本校验、`TRANSLATE_TRANSCRIPT` 的空文本）和 `handle`。唯一的 `onMessage` 监听器（仍在 `background.js`）只做三件事：查表（`zehMessageRoute`）→ `zehAuthorizeMessage` → 校验并调用；handler 的返回值就是监听器的返回值（全部为 `true`，与原 if 链一致）。`EXPLAIN` 的处理体是具名函数 `handleExplain`。发送方检查读的 `ZEH_CONTENT_SCRIPT_MESSAGE_TYPES` / `ZEH_EXTENSION_PAGE_MESSAGE_TYPES` 由注册表推出。

M3b 收紧（`tests/message-security.test.js`）：

- **默认拒绝**：查不到路由时由 `zehUnroutedMessageResponse` 决定。格式不对（不是对象、`type` 不是字符串）回 `{ ok:false, accepted:false, code:"MALFORMED_MESSAGE" }`，未登记的类型回 `code:"UNKNOWN_MESSAGE_TYPE"`，都是同步回复一次。`ZEH_PAGE_BOUND_MESSAGES` 里的类型属于页面监听器，SW 不回复（返回 `false`），以免和真正处理它的页面抢答。扩展里没有页面之间互发的 runtime 消息，SW 也收不到自己的广播，所以这条规则不会拦掉合法流量。
- **`EXPLAIN` 校验**：文本校验之后，`queryId` 必须是 1–80 位 `[A-Za-z0-9_-]`（控制器生成 `q_<毫秒>_<随机>`），否则回 `INVALID_QUERY_ID`；带了 `queryType` 时必须是 `word` / `phrase` / `sentence` / `paragraph` / `code_term` 之一，否则回 `INVALID_QUERY_TYPE`。被拒的查词不调用 provider、不向页面发任何消息。
- **结果只回发起的 frame**：`handleExplain` 用 `lookupReplyFrame(sender, tabId)` 给 `sendToTab` 加上 `{ documentId }`（没有就 `{ frameId }`），`SHOW_RESULT` / `DICT_ENHANCED` / `SHOW_ERROR` / `CONTEXT_ENHANCED` 都只发给发起查询的那个文档。只有它的控制器持有这个 `queryId`，所以这只去掉了本来就会被丢弃的投递。没有标签页的扩展页面（侧边栏、增强 PDF 阅读器）照旧收 runtime 广播，靠 `queryId` 认领；右键查词时「Manekilex 已关闭」的提示（不带 `queryId`）照旧发给整个标签页。
- **页面认领**：`isStaleQueryMessage` 要求 `SHOW_RESULT` / `DICT_ENHANCED` / 带 `queryId` 的 `SHOW_ERROR` 的 `queryId` 是非空字符串且等于当前查询；缺 `queryId` 或为 `null` 的结果不再渲染。不带 `queryId` 的 `SHOW_ERROR` 是标签页级提示，照常显示。

SW 发给页面的消息登记在 `ZEH_PAGE_BOUND_MESSAGES`（类型 → 处理它的文件）。`tests/message-registry.test.js` 扫描所有一方脚本里的 `type: "…"` 字面量，要求每一个都在这两张表之一，并核对登记的发送方 / 接收方文件。

### 发送方规则（`sw/router.js` → `zehAuthorizeMessage`）

| 允许谁 | 消息类型 |
|--------|----------|
| 任何 sender（含注入网页的内容脚本） | `EXPLAIN`、`ADD_VOCAB`、`OPEN_SETTINGS`、`PDF_PAGE_ASSISTANT_READY`、`GET_DICT_KEY_LIST` |
| 仅扩展页面（`sender.url` 以 `chrome.runtime.getURL("")` 开头，且 `sender.id` 为本扩展） | `DELETE_VOCAB`、`REVIEW_VOCAB`、`MIGRATE_VOCAB`、`GET_LOOKUP_CACHE_STATS`、`CLEANUP_LOOKUP_CACHE`、`CLEAR_LOOKUP_CACHE`、`CLEAR_USAGE_LOGS`、`CLEAR_READER_POSITION_CACHE`、`START/GET_STATUS/CANCEL/CLEAR_PROVIDER_BENCHMARK`、`SET_PROVIDER_MODEL_FROM_BENCHMARK`、`SAVE_PROVIDER_SETTINGS`、`MIGRATE_PROVIDER_SETTINGS`、`SAVE_BENCHMARK_CUSTOM_MODELS`、`GET_ASSEMBLYAI_TEMP_TOKEN`、`GET_LIVE_TRANSCRIBE_PROVIDER_OPTIONS`、`SET_LIVE_TRANSCRIBE_PROVIDER`、`PREVIEW_TAB_CAPTURE_TARGET`、`START_TAB_AUDIO_CAPTURE_FROM_ACTIVE_TAB`、`TRANSLATE_TRANSCRIPT` |

被拒绝的消息得到 `{ ok:false, accepted:false, code:"FORBIDDEN_SENDER" }`，SW 打一条 warn。扩展页面包括 settings / popup / reader / lookup-panel（reader 标签页也是扩展页面）。

### 页面 → SW

| 消息 | 说明 |
|------|------|
| `EXPLAIN` | `{ text, queryId, queryType?, context? }` 发起查词（`queryId` 必填，M3b）；回复 `{ accepted, code?, fromCache?, fromSpecial? }` |
| `ADD_VOCAB` | `{ item }`：词 + 结果 + 语境；同词合并语境（最多 8 条） |
| `DELETE_VOCAB` / `REVIEW_VOCAB` / `MIGRATE_VOCAB` | 生词本删除 / 评分 / 旧结构迁移 |
| `GET_DICT_KEY_LIST` | 词典 key 数组（划词 repair 用，按需加载） |
| `OPEN_SETTINGS` | 打开设置页指定 section |
| 缓存 / 日志 / 位置缓存清理 | `GET_LOOKUP_CACHE_STATS`、`CLEANUP_LOOKUP_CACHE`、`CLEAR_LOOKUP_CACHE`、`CLEAR_USAGE_LOGS`、`CLEAR_READER_POSITION_CACHE` |
| Benchmark | `START_PROVIDER_BENCHMARK`（立即返回 jobId）、`GET_PROVIDER_BENCHMARK_STATUS`、`CANCEL_…`、`CLEAR_…`、`SET_PROVIDER_MODEL_FROM_BENCHMARK`、`SAVE_BENCHMARK_CUSTOM_MODELS` |
| 实时转译 | `GET_ASSEMBLYAI_TEMP_TOKEN`、`GET_LIVE_TRANSCRIBE_PROVIDER_OPTIONS`、`SET_LIVE_TRANSCRIBE_PROVIDER`、`PREVIEW_TAB_CAPTURE_TARGET`、`START_TAB_AUDIO_CAPTURE_FROM_ACTIVE_TAB`、`TRANSLATE_TRANSCRIPT`（partial / final，不走查词缓存） |

### SW → 页面（`chrome.tabs.sendMessage`）

| 消息 | 说明 |
|------|------|
| `SHOW_RESULT` | `{ queryId, queryType, data, fromCache?, fromDict?, contextPending? }` |
| `CONTEXT_ENHANCED` | `{ queryId, ok, data? }`：语境增强结果，页面只接受仍在等待的 queryId |
| `SHOW_ERROR` | 配置 / 校验 / 禁用提示 |
| `DICT_ENHANCED` | `{ queryId, durationMs, providerName, modelName }`：词典结果已显示后 provider 也返回了，只更新面板状态栏 |
| `PDF_PAGE_LOOKUP` / `PDF_PAGE_COLLAPSE` | PDF 页助手 |
| `TAB_AUDIO_CAPTURE_PENDING` | popup 捕获后通知设置页 |

Phase 5 删除的无人调用的处理器：`GET_ACTIVE_PROVIDER_INFO`、`GET_TAB_CAPTURE_STREAM_ID`、reader 的 `RELOAD_READER_POSITION` 监听，以及 `getCachedLookup` / `setCachedLookup` / `translateTranscriptPlain` 兼容函数。

### Provider（`shared/providers.js` + `sw/provider-client.js`）

`ZEH_PROVIDER_META[id]`（代码内）：`name`、`type`（openai-compatible | gemini）、`baseUrl`、`defaultModel`。`zehProviders[id]`（本机）：`apiKey`、`model`、`enabled`；`zehActiveProvider` 为当前启用 id。旧模型名由 `zehMigrateProviderModels` 迁移：空值 → 默认模型；只有与旧 Manekilex 默认值完全相同的名字才映射到新默认（`ZEH_PROVIDER_MODEL_MIGRATIONS`），用户自填的模型名不动。各平台的请求差异（`max_completion_tokens`、关闭 thinking / reasoning、去掉不支持的 temperature）集中在 `zehApplyProviderRequestOptions`，仍是 Chat Completions。

持久化的 provider 配置只由 service worker 写入（M9）。设置页保存（`persistProviders`）把上次读到的快照和当前编辑发给 worker（`SAVE_PROVIDER_SETTINGS { base, edits }`）；worker 的 `saveProviderSettings` 读最新 `zehProviders` → `zehMergeProviderEdits(stored, base, edits)` 只覆盖本页相对快照改过的字段 → 按原启用规则写回，写入完成后才回复 `{ ok, providers, activeProvider }`，页面据此刷新快照并显示「已保存」，失败时显示错误。设置页打开时的旧版设置迁移也请 worker 做（`MIGRATE_PROVIDER_SETTINGS`）。worker 内所有改 provider 配置的操作（设置页保存、测速「使用此模型」、旧设置迁移、`getAppSettings` 前的 `migrateLegacySettings`）都经过 `zehWithProviderConfigLock` 排成一队，每次「读 → 合并 → 写」完整结束后才轮到下一次，同时发生的修改不会互相覆盖。`storage.onChanged` 到达时页面把未保存的改动叠加到新状态再刷新表单；保存在途时收到的变化等回复之后再处理。

---

## 4. 本地存储

### chrome.storage.local（`ZEH_STORAGE`）

| 键 | 内容 |
|----|------|
| `zehProviders` / `zehActiveProvider` | 各平台 Key / 模型 / 启用；当前平台 |
| `zehVocabulary` | 生词本 v2 数组（§5）；只由 SW 写 |
| `zehUsageLogs` | 模型调用日志（cap 500） |
| `zehCache:v2:*`、`zehCacheCleanupMeta` | 查词结果缓存（分层 TTL、总 cap 8MB）；只存模型结果 |
| `zehTheme`、`zehReaderPrefs`、`zehReaderTheme` | 主题 / 阅读偏好 |
| `zehReaderPositionCache` | 阅读位置缓存（按 bookId），与 IndexedDB 记录取较新者 |
| `zehProviderBenchmarkLast` / `…Job` / `…CustomModels` | 测速 |
| `zehAssemblyAI`、`zehLiveTranscribeSource`、`zehLiveTranscribeProvider` | 实时转译 |
| `zehManekilexEnabled` | 全局开关（默认 true） |
| `openaiApiKey` / `openaiModel` | 旧版键，仅迁移时读取 |

`chrome.storage.session`：`zehPendingTabAudioCapture`（popup 捕获的 streamId）。侧边栏兜底查词的文字放在侧边栏路径的 `?text=` 里，不再写入 session。

### IndexedDB `zeh-reader`（`book-store.js`）

- `books`（keyPath `id`）：`fileBlob`（始终是 EPUB）、`coverBlob`、`title`、`progress`、`currentSpineIndex`、`chapterScrollRatio`、`currentLocation`（CFI）、`lastReadAt`、`sortOrder`、`activeReaderSessionId`、可选 `sourceFormat` / `convertMode`
- `bookmarks`（keyPath `id`，index `bookId`）
- 进度写入只接受 `scroll-debounce` / `back-to-shelf` / `toc-jump` / `bookmark-jump` 四种原因，且拒绝非活跃阅读会话

---

## 5. 生词本与复习（Phase 4）

条目结构（`vocab-review.js`）：`{ id, term, termKey, queryType, short_meaning…, contexts: [{ id: "ctx-<fnv>", sentence, pageUrl, title, savedAt, contextMeaning? }], review: { state, dueAt, intervalDays, ease, reviewCount, lapses } }`。同词（`zehVocabTermKey`）合并，`contexts` 最多 `ZEH_VOCAB_MAX_CONTEXTS = 8` 条。0.11.1：词条上有 `derivatives`、`memory_tip`、`memory_tip_type`；语境上有 `synonyms`（没有原句时存在词条上）。再次保存时 `zehMergeVocabLexical` 合并去重派生词，已有可用助记不覆盖，只替换明显无效的。

所有变更在 SW 内通过 `mutateVocabulary(fn)` → `zehUpdateStorageList("zehVocabulary", …)` 串行执行：读最新列表 → 变更 → 写回。设置页不写 `zehVocabulary`，只在 `storage.onChanged` 后刷新。

复习调度（`ZEH_REVIEW_RULES`）：Again 10 分钟、Hard 30 分钟后重现；Good / Easy 毕业为 1 / 4 天；之后按 ease（初始 2.5，范围 1.3–3.0）与 Hard ×1.2 / Easy ×1.3 / 遗忘 ×0.5 递推，上限 365 天。队列（`zehBuildReviewQueue`）每次最多 100 张、新词 20 张；评分消息带 `expectedReviewCount` 做乐观并发校验。未实现：FSRS、复习历史、按语境独立调度。

---

## 6. 词典数据流与维护脚本

```
dic/*.txt / wordfreq.json / ecdict.csv
   → scripts/build-dictionary.js   （全量重建：目标含 enriched 数据时拒绝，--force-overwrite 才覆盖并先备份）
   → scripts/migrate-dictionary-format.js（同样的安全闸）
   → scripts/enrich-dictionary.js  （DeepSeek 付费补全：必须 --keys / --keys-file / --retry-failed / --limit N
                                     或显式 --confirm-full-run；两次答非所问则记失败，不把别的词写进该 key）
   → scripts/add-dictionary-words.js（增量加词）
   → scripts/clean-dictionary-entries.js（Phase 5 清理：空壳 / 占位数字 key / 中文 term；默认只报告，--write 写回）
   → scripts/audit-dictionary.js / check-term-mismatch.js（检查）
所有写入经 scripts/dictionary-file.js：临时文件 → 重新解析校验 → 备份 → rename
```

运行时（`sw/dictionary.js`）：`zehLoadDictionary` 按需 fetch，失败不缓存；`getDictionaryEntry` 依次试 `zehLookupKeyVariants`、去重音、forms 反向索引；`normalizeDictEntry` 归一字段与词性；`zehIsDictEntryUsable` 决定是否当命中。

---

## 7. 测试（`npm test`）

| 文件 | 覆盖 |
|------|------|
| `tests/background-explain.test.js`、`lookup-lifecycle-helpers`、`mk-lookup-controller` | Phase 1：查词生命周期、超时、queryId、bfcache |
| `tests/background-dictionary`、`dictionary-keys`、`content-selection-gating`、`vocabulary-mutations` | Phase 2：按需词典、禁用态、SW 串行写入 |
| `tests/context-*.test.js`、`vocabulary-context` | Phase 3：语境采集 / 缓存键 / 增强 |
| `tests/review-*.test.js`、`vocab-migration`、`vocab-multi-context` | Phase 4：多语境、调度、队列、迁移、复习 UI |
| `tests/importer-xhtml.test.js` | Phase 5：Markdown / HTML / DOCX 风格 HTML → 良构 XHTML、拆章、清洗、EPUB 前校验 |
| `tests/book-store.test.js`、`reader-navigation.test.js` | Phase 5：事务 abort、reorder、书签跳转、位置优先级 |
| `tests/message-sender.test.js`、`provider-race.test.js` | Phase 5：发送方边界、provider 保存合并 |
| `tests/provider-defaults.test.js`、`settings-layout.test.js` | 0.11.1：默认模型与迁移、请求参数适配、设置页卡片布局结构 |
| `tests/bubble-lifecycle.test.js`、`code-context.test.js` | 0.11.1：小球生命周期（连续查词、开关、bfcache、换 body、输入框、重复注入、失效提示）、代码块里的语境 |
| `tests/lexical-enrichment.test.js` | 0.11.1：一次增强补齐派生词 / 同义词 / 助记、助记质量门、面板顺序与原地更新、生词本与设置页导出 |
| `tests/dictionary-usability.test.js`、`dictionary-scripts.test.js` | Phase 5：空壳回退、词性归一、不写缓存、脚本安全闸、原子写入、清理规则 |
| `tests/reader-sessions.test.js`、`live-transcribe.test.js` | Batch 2：多个阅读标签页的位置归属（F9）、实时转写会话与资源释放（F10） |
| `tests/shared-utilities.test.js`、`message-registry.test.js` | Batch 2：共享小工具与各旧副本等价（M2）、消息注册表与发送方 / 异步回复语义不变（M3） |
| `tests/settings-sections.test.js`、`lookup-panel-snapshot.test.js`、`lookup-speech.test.js` | Batch 4：设置页各分区的元素与切换（M6 拆分前录制）、查词面板逐字节快照与发音（M7 拆分前录制） |
| `tests/message-security.test.js` | Batch 4 M3b：未登记 / 畸形消息明确拒绝、`EXPLAIN` 的 `queryId` 与 `queryType` 校验、结果只回发起的 frame、页面按 `queryId` 认领 |
| `tests/reader-behaviour.test.js` | Batch 5 M8：阅读器拆分前录制的行为（缺 id / 已删除 / 无法打开的提示、开书与会话归属、按章节 + 比例恢复位置、进度公式、滚动防抖保存与非用户滚动不保存、离开页面与切到后台时落盘、旧标签页写入被拒（F9）与重新获得焦点、滚轮切章阈值、目录、显示设置、查词上下文、阅读中删除书籍）；窗口缩放、键盘、右键菜单等需要真实布局的行为在 `reader.browser.js` |
| `tests/reader-progress.test.js`、`reader-toc.test.js` | Batch 5 M8：拆出的进度公式与目录列表（摊平、href 匹配、高亮）逐条不变 |
| `tests/provider-config-ownership.test.js` | Batch 5 M9：模型设置只由 SW 写入（`SAVE_PROVIDER_SETTINGS` / `MIGRATE_PROVIDER_SETTINGS`）、并发保存与基准测试选模型互不覆盖、存储确认后才报成功、旧设置迁移 |
| `tests/scripted-events.test.js` | Batch 6：网页脚本合成的点击（`isTrusted === false`）不能触发查词、加入生词本或打开设置，真实点击照常；浏览器里的同一场景见 `lookup-hosts.browser.js` |
| `tests/package-release.test.js`、`vendor-provenance.test.js` | Batch 6：私有发布包可复现（同一提交得到同一 SHA-256）、只含运行时文件与许可证、不含测试 / 开发文件 / 本地文件 / 许可未核实的数据、manifest / 页面 / service worker 引用的文件都在包里、缺少 `poem/quotes.json` 时设置页用内置句子；`lib/` 每个文件都有记录且与 npm 包逐字节一致，每份数据与图片都写明来源 |

真实浏览器（`npm run test:browser`，Playwright + Chrome for Testing，CI 的 Browser tests 工作流）：`tests/browser/pdf-reader.browser.js`（PDF 增强阅读器、MIME 接管、与 Chrome 自带查看器来回切换）、`tests/browser/lookup-hosts.browser.js`（网页、同源 / 跨域 iframe、多 frame 并发查词与结果归属、结果只发回发起的文档、伪造 / 过期 queryId、EPUB 阅读器与阅读位置、弹窗开关、设置页与生词本、service worker 停止后被下一次查词唤醒、网页脚本伪造的点击不触发查词）、`tests/browser/reader.browser.js`（真实 epub.js：滚动与键盘、滚轮切章、目录、显示设置、窗口缩小、同书多标签页、右键与工具栏书签（含真实右键：Linux / macOS 在按下时就弹出菜单，松开后菜单不能关闭）、阅读中删除书籍）和 `tests/browser/settings-providers.browser.js`（SW 停止期间的模型设置保存与重新唤醒、设置页与基准测试同时写入）。除 localhost / 127.0.0.1 外所有域名都解析失败，provider 请求由 service worker 里的桩函数回答，不需要也不会用到真实 API Key。`MK_REQUIRE_MIME=1` 时 PDF MIME 用例不能跳过。`MK_EXTENSION_DIR` 指向解压后的发布包时，同一套用例在发布包上运行（CI 的 Browser tests 工作流两者都跑）。

辅助：`tests/helpers/extension-sandbox.js`（假 chrome.*、storage、消息分发，默认 sender 为设置页）、`fake-dom.js`、`settings-page.js`、`mini-dom.js`（迷你 HTML / XML 解析器）、`importer-sandbox.js`、`fake-indexeddb.js`、`reader-page.js`（假 epub.js）。

---

## 8. 调试

| 场景 | 方法 |
|------|------|
| 详细日志 | `config.js` 把 `ZEH_DEBUG_LOGS` 改为 `true`（SW、内容脚本、设置页、实时转译共用） |
| Reader 位置链路 | `reader.html?id=…&debug=1`（调试浮层 + `[ZEH_POS]` / `[Reader]` 日志；book-store 的进度日志也只在此时输出） |
| Service Worker | `chrome://extensions` → Inspect；被拒绝的消息打印 `rejected message from non-extension sender` |
| 扩展上下文失效 | 重新加载扩展后，旧标签页选中文字会出现刷新横幅；刷新当前页 |

---

## 9. 已知限制与遗留

- 未做 Shadow DOM，站点 CSS 可能影响面板；跨域 iframe 内面板受视口限制
- `settings.html` 里的「小球颜色」入口被隐藏（`hidden`），对应代码保留未删（产品决定）
- reader.js 不再按 `readingAnchor` 恢复位置：这部分从未被调用的恢复代码已在 M1 删除；库记录里已有的 `readingAnchor` 字段保留不动（`book-store.js` 仍接受它）
- 扩展未发布到 Chrome 商店。发布前的检查、打包与阻塞项见 `docs/RELEASE.md`；权限说明草稿见 `docs/STORE_LISTING.md`
