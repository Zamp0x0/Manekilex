# Manekilex 隐私政策（草稿）

> **草稿，尚未生效。** 本文依据 0.11.1 版代码写成，发布前需要维护者审阅，并补上联系方式与生效日期。
> 它只描述 Manekilex 扩展本身的行为；你选择的模型服务商和 AssemblyAI 如何处理收到的数据，由它们各自的政策决定，本文不作任何保证。
> English version below.

生效日期：〔发布前填写〕　联系方式：〔发布前由维护者填写〕

## 1. 概要

- Manekilex 没有自己的服务器，也不收集统计、遥测或广告数据。维护者收不到你的任何数据。
- 数据要么只保存在你的浏览器里，要么在你操作之后，由扩展直接发给**你自己配置的**服务商（模型服务商、AssemblyAI）。
- 不出售、不出租、不转让用户数据，也不用于广告或信用评估。

## 2. 保存在本机的数据

以下数据保存在 Chrome 为扩展提供的本地存储（`chrome.storage.local`、IndexedDB）里，不会同步到其他设备：

| 数据 | 内容 | 保留 |
| --- | --- | --- |
| 模型服务商设置 | 每家服务商的 API Key、模型名、是否启用 | 直到你修改或删除；Key 以明文保存在本机 |
| AssemblyAI 设置 | AssemblyAI API Key 和转写选项 | 同上；清空输入框后保存即删除 Key |
| 查词缓存 | 你查过的文本、模型返回的解释；按句子缓存的结果还包含那句话 | 单词 / 短语 30 天，句子 14 天，段落 7 天，总量上限约 8 MB，过期自动清理 |
| 生词本 | 词条、释义、你保存时所在的句子及其翻译、来源（网页地址和标题；EPUB 的书名、章节；PDF 的标题、页码和不含查询参数的地址）、复习进度 | 直到你删除，最多 2000 条 |
| 用量记录 | 每次模型请求的时间、服务商、模型、词元数、耗时、是否成功（不含查询的文字） | 最近 500 条 |
| 书籍 | 你导入的 EPUB（以及由 TXT、Markdown、HTML、DOCX、PDF 在本机转换成的 EPUB）、封面、书签（含书签处的一小段文字）、阅读位置 | 直到你删除这本书 |
| 偏好 | 主题、阅读器显示设置、总开关等 | 直到你修改 |
| 标签页音频捕获 | 开始捕获时，目标标签页的编号、标题和地址，保存在会话存储里 | 最多 45 秒，读取后立即删除 |

实时转译的音频和字幕只在内存里，不保存；关闭页面或点「清空」即消失。只有你点「导出」时才会生成一个 Markdown 文件。

在增强 PDF 阅读器里打开的 PDF 只在内存中读取，不保存到扩展里，也不上传。

## 3. 发给第三方的数据

扩展只会连接下列地址，而且都只在你操作之后：

| 去向 | 什么时候 | 发送的内容 |
| --- | --- | --- |
| 你启用的模型服务商（OpenAI、DeepSeek、Moonshot、智谱、SiliconFlow、Groq、Google Gemini 之一） | 你点击查词小球、在侧边栏或右键菜单查词时；单词和短语在显示本地词典结果后再发一次请求补充此处含义 | 选中的文本；单词和短语还会带上所在句子（最多 400 字符，句子很短时再加最多 600 字符的上下文）和词典里的基础释义；固定的提示词；你的 API Key（作为请求认证） |
| 你为实时转译选择的模型服务商 | 实时转译进行中 | 转写出的英文句子和前两句作为上下文；你的 API Key |
| AssemblyAI（`streaming.assemblyai.com`） | 你开始实时转译时 | 你的 AssemblyAI Key（只用于换取临时令牌）；之后是麦克风或你选择的标签页的音频流 |
| 所有已配置 Key 的模型服务商 | 只有你在设置里点「开始测速」时（已开始的测速在浏览器重启后会继续完成） | 扩展内置的固定测试句子，不含你的数据 |
| 当前 PDF 所在的网站 | 你在 Chrome 自带 PDF 查看器里点击猫球、要切换到增强阅读器时 | 对该 PDF 地址的一次 1 字节请求，用来确认它还能访问；不发送任何你的数据 |

不会发送：网页地址、页面标题、书名、整个网页、整份 PDF 或 EPUB 文件、你的生词本、浏览记录。

API Key 只发给对应服务商的固定接口地址，扩展里没有可以改成其他地址的设置。Google Gemini 的接口按其文档把 Key 放在请求地址的查询参数里。

这些服务商收到数据后如何保存和使用，由它们各自的条款和隐私政策决定；请在配置 Key 之前阅读。

发音功能使用浏览器自带的语音合成。如果你的系统只提供联网语音，朗读的文字是否发给语音服务由浏览器和操作系统决定，不在扩展控制范围内。

导入的 EPUB 或网页转换成的书里如果引用了网络图片，阅读时浏览器可能会去加载这些图片。

## 4. 权限的用途

| 权限 | 用途 |
| --- | --- |
| 在所有网站上运行内容脚本（`<all_urls>`，含 iframe） | 在你浏览的任何网页（包括嵌入的框架）里识别选中的英文并显示查词小球和面板。内容脚本在你点击小球之前不会把任何数据发出你的设备 |
| `storage`、`unlimitedStorage` | 在本机保存设置、生词本、缓存和导入的书籍（书籍可能较大） |
| `tabs` | 判断当前标签页是不是 PDF、找到已打开的设置页、为实时转译选择要捕获的标签页；标签页信息只在本机使用 |
| `contextMenus` | 右键菜单「Manekilex 查词」 |
| `sidePanel` | Chrome 自带 PDF 查看器里的查词结果显示在侧边栏 |
| `tabCapture`、`activeTab` | 你在工具栏弹窗里开始实时转译时，捕获当前标签页的声音 |
| 访问各模型服务商与 AssemblyAI 的接口地址 | 把查词和转译请求发给你配置的服务商 |
| PDF 处理（`mime_types_handler`，Chrome 151+） | 用增强 PDF 阅读器显示你打开的网页 PDF；可在设置里关闭 |

## 5. 你的控制

- 关闭查词：工具栏弹窗里的总开关。
- 删除 API Key：在「模型与 API」或「实时转译」里清空 Key 并保存。
  从很早的版本升级而来的：旧版单独保存的 OpenAI Key（存储键 `openaiApiKey`）迁移到新设置后仍留在本机存储里，目前只有卸载扩展才会删除它。
- 删除生词本条目、单本书籍（连同书签）、查词缓存、用量记录、阅读位置记录、测速结果：在设置的对应页面操作。
- 导出生词本：TXT、CSV、Markdown。
- 删除全部数据：在 `chrome://extensions` 卸载 Manekilex，Chrome 会删除它的全部本地数据。目前没有一键清除全部数据的按钮。

## 6. 儿童

Manekilex 不面向儿童，也不会有意收集任何人的个人信息。

## 7. 变更

本政策变化时会更新本文件并修改生效日期。

---

# Manekilex Privacy Policy (draft)

> **Draft, not yet in effect.** Written from the code of version 0.11.1. The maintainer must review it and add contact details and an effective date before publication.
> It describes only what the Manekilex extension does. How the AI providers and AssemblyAI you choose handle the data they receive is governed by their own policies; this document makes no promise about them.

Effective date: [to be filled in before publication]. Contact: [to be filled in by the maintainer before publication].

## 1. Summary

- Manekilex has no server of its own and collects no analytics, telemetry or advertising data. The maintainer receives none of your data.
- Data either stays in your browser, or is sent by the extension directly to the providers **you configured** (an AI provider, AssemblyAI), after you act.
- User data is not sold, rented or transferred, and is not used for advertising or credit decisions.

## 2. Data stored on your device

Stored in the extension's local storage (`chrome.storage.local`, IndexedDB); not synced to other devices.

| Data | Contents | Retention |
| --- | --- | --- |
| Provider settings | API key, model name and on/off state per provider | Until you change or remove them; keys are stored unencrypted on your device |
| AssemblyAI settings | AssemblyAI API key and transcription options | Same; saving an empty key field removes the key |
| Lookup cache | Text you looked up and the explanation returned; results cached per sentence also contain that sentence | Words and phrases 30 days, sentences 14 days, paragraphs 7 days, about 8 MB in total; expired entries are removed |
| Vocabulary | Words, meanings, the sentence you saved them from and its translation, the source (web page address and title; EPUB title and chapter; PDF title, page and address without query string), review progress | Until you delete it; at most 2000 entries |
| Usage log | Time, provider, model, token counts, duration and success of each model request (no looked-up text) | Last 500 requests |
| Books | EPUBs you import (and EPUBs converted on your device from TXT, Markdown, HTML, DOCX or PDF), covers, bookmarks (with a short excerpt), reading positions | Until you delete the book |
| Preferences | Theme, reader display settings, the on/off switch | Until you change them |
| Tab audio capture | When you start a capture: the target tab's id, title and address, in session storage | At most 45 seconds; deleted once read |

Live transcription audio and captions stay in memory only and are not saved; closing the page or pressing Clear discards them. A Markdown file is created only when you press Export.

A PDF opened in the enhanced PDF reader is read in memory only; it is not stored by the extension and not uploaded.

## 3. Data sent to third parties

The extension connects only to the following, and only after you act:

| Destination | When | What is sent |
| --- | --- | --- |
| The AI provider you enabled (one of OpenAI, DeepSeek, Moonshot, Zhipu, SiliconFlow, Groq, Google Gemini) | When you click the lookup bubble or look up from the side panel or context menu; for words and phrases, one more request after the local dictionary result is shown, to add the meaning in context | The selected text; for words and phrases also the surrounding sentence (up to 400 characters, plus up to 600 characters of nearby text when the sentence is very short) and the basic dictionary meaning; fixed instructions; your API key (as request authentication) |
| The AI provider you chose for live transcription | While live transcription runs | Transcribed English sentences with the previous two as context; your API key |
| AssemblyAI (`streaming.assemblyai.com`) | When you start live transcription | Your AssemblyAI key (only to obtain a temporary token); then the audio stream of your microphone or of the tab you chose |
| Every AI provider that has a key | Only when you press "start" in the benchmark settings (a benchmark you started continues after a browser restart) | Fixed test sentences built into the extension; none of your data |
| The site hosting the current PDF | When you click the cat in Chrome's built-in PDF viewer to switch to the enhanced reader | One 1-byte request for that PDF's address, to check it is still available; none of your data |

Not sent: page addresses, page titles, book titles, whole web pages, whole PDF or EPUB files, your vocabulary, your browsing history.

API keys are sent only to the fixed endpoint of the matching provider; the extension has no setting to change those addresses. For Google Gemini the key is sent as a query parameter of the request URL, as Gemini's API accepts.

How these providers store and use what they receive is governed by their own terms and privacy policies; please read them before configuring a key.

Pronunciation uses the browser's built-in speech synthesis. If your system only offers online voices, whether the spoken text is sent to a speech service is decided by the browser and operating system, outside the extension's control.

If an imported EPUB, or a book converted from a web page, refers to images on the internet, the browser may load them while you read.

## 4. What the permissions are for

| Permission | Purpose |
| --- | --- |
| Content scripts on all sites (`<all_urls>`, including frames) | Detect selected English text on any page you read (including embedded frames) and show the lookup bubble and panel. Content scripts send nothing off your device until you click the bubble |
| `storage`, `unlimitedStorage` | Keep settings, vocabulary, cache and imported books (books can be large) on your device |
| `tabs` | Tell whether the current tab shows a PDF, find an open settings page, and choose the tab to capture for live transcription; tab information is used on your device only |
| `contextMenus` | The "Manekilex 查词" context-menu item |
| `sidePanel` | Show lookup results in the side panel from Chrome's built-in PDF viewer |
| `tabCapture`, `activeTab` | Capture the current tab's audio when you start live transcription from the toolbar popup |
| Access to the AI provider and AssemblyAI endpoints | Send lookup and transcription requests to the providers you configured |
| PDF handling (`mime_types_handler`, Chrome 151+) | Show web PDFs you open in the enhanced PDF reader; can be turned off in settings |

## 5. Your controls

- Turn lookups off: the switch in the toolbar popup.
- Remove an API key: clear it and save, under "模型与 API" (models) or "实时转译" (live transcription).
  If you upgraded from a very early version: the OpenAI key that version kept on its own (storage key `openaiApiKey`) stays in local storage after it is migrated to the new settings; currently only uninstalling the extension removes it.
- Delete vocabulary entries, a book (with its bookmarks), the lookup cache, the usage log, saved reading positions, benchmark results: on the matching settings page.
- Export vocabulary: TXT, CSV, Markdown.
- Delete everything: uninstall Manekilex at `chrome://extensions`; Chrome removes all of its local data. There is currently no single "clear all data" button.

## 6. Children

Manekilex is not directed at children and does not knowingly collect anyone's personal information.

## 7. Changes

When this policy changes, this file and its effective date will be updated.
