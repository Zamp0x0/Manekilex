# data/ — 词典数据来源与许可

`data/dictionary_core.json` 是扩展运行时使用的本地词典（25,518 条，约 19.7MB，Service Worker 按需 fetch）。
本文说明它是怎么生成的、每个字段来自哪里、哪些来源已经核实、哪些还不能确定。标为 **UNVERIFIED** 的内容没有足够证据，不要据此推断来源或许可。

## 1. 字段来源

条目结构：`{ term, phonetic, part_of_speech, short_meaning, context_meaning, examples[], memory_tip, common_collocations[], forms{}, enriched }`。
下表的数字是 2026-10-08 用 ECDICT 当前版本（commit `bc015ed`，2025-03-28）逐条比对得出的。

| 字段 | 主要来源 | 比对结果 |
| --- | --- | --- |
| 词条 key / `term` | 种子词表（§3）取并集后在 ECDICT 中查找 | 24,997 / 25,518 个 key 在 ECDICT 中存在 |
| `short_meaning` | ECDICT `translation` 清洗；不合格时改用 DeepSeek 输出 | 至少 12,256 条的中文释义完全由 ECDICT 原文片段组成 |
| `forms` | ECDICT `exchange` | 6,589 条非空，全部对应 ECDICT 的 exchange 数据 |
| `phonetic`、`part_of_speech` | DeepSeek 输出优先，缺失时用 ECDICT | 只有 1,078 条音标与 ECDICT 完全相同 |
| `context_meaning`、`examples`、`memory_tip`、`common_collocations` | **DeepSeek 生成** | 25,518 条均为 `enriched: true` |

合并规则见 `scripts/dictionary-schema.js`（`mergeEnrichIntoEntry` / `forceFillEntry`）：模型返回的 `term` 与 key 不一致时丢弃模型内容；例句必须含中文译文；`short_meaning` 必须含中文。

## 2. 生成流程

```
dic/ 种子词表（§3） ─┐
                     ├─ scripts/build-dictionary.js      取词表并集，从 ECDICT 取释义、音标、词形；ECDICT 未收录的词生成空壳
dic/ecdict.csv ──────┘                                     （ecdict.csv 需自行下载，已加入 .gitignore）
   → scripts/migrate-dictionary-format.js                  格式迁移
   → scripts/enrich-dictionary.js                           DeepSeek 批量补全（2026-06，v0.9.8 起）
   → scripts/add-dictionary-words.js                        增量加词
   → scripts/clean-dictionary-entries.js                    Phase 5 清理（2026-10）
   → scripts/audit-dictionary.js / check-term-mismatch.js   检查
```

所有写入都经过 `scripts/dictionary-file.js`（临时文件 → 重新解析校验 → 备份 → rename）。

## 3. 种子词表与其他数据

| 文件 | 用途 | 运行时需要 | 来源 | 许可 / 状态 |
| --- | --- | --- | --- | --- |
| `dic/ecdict.csv`（不在仓库内） | 释义、音标、词形 | 否 | [skywind3000/ECDICT](https://github.com/skywind3000/ECDICT) | MIT，Copyright (c) 2025 Linwei。当年下载的具体版本 **UNVERIFIED** |
| `dic/google-10000-english-usa.txt` | 词表（取前 8,000） | 否 | 与 [first20hours/google-10000-english](https://github.com/first20hours/google-10000-english) 同名文件逐字节相同 | 无开源许可。上游说明数据来自 LDC 发行的 Google Web Trillion Word Corpus，仅说明教育、个人、研究用途可用，不建议未经 LDC 授权的商业使用。**公开发布前需替换** |
| `dic/The_Oxford_3000.txt` | 词表 | 否 | Oxford 3000 是牛津大学出版社发布的词表；本文件的下载来源 **UNVERIFIED** | 未见任何再分发许可。**公开发布前需替换** |
| `dic/wordfreq-en-25000-log.json` | 词表（25,000 高频词，自然对数词频） | 否 | 与 [wordfreq](https://github.com/rspeer/wordfreq)（Robyn Speer）英文数据一致：23,855 个词与 wordfreq 当前 top 25,000 重合，多个词的数值等于 ln(词频)。生成脚本与 wordfreq 版本 **UNVERIFIED** | wordfreq 数据为 CC BY-SA 4.0，本文件按 CC BY-SA 4.0 提供，署名见 `THIRD_PARTY_NOTICES.md` §4.5 |
| `dic/manual-core-words.txt` | 手动补充词（102 个） | 否 | 作者手工整理 | 第一方内容，随项目 MIT |
| `poem/quotes.json` | 设置页「每日一句」（`daily-lines.js`） | 是（可选功能） | 1,655 条名言，704 位作者；只有 100 条带 `source` 链接（多为 goodreads 等名言网站）。整体来源 **UNVERIFIED** | 汇编来源与许可不明；部分作者在世或作品仍受版权保护。**公开发布前需替换或删除** |

ECDICT 的 CSV 自带 `oxford`（牛津 3000 标记）、`bnc`、`frq`（语料库词频排名）列。以后可以改用这些列选词，替换上面两份许可不明的词表。

## 3a. 图片

| 文件 | 用途 | 进扩展包 | 来源 | 状态 |
| --- | --- | --- | --- | --- |
| `icons/icon16.png`、`icon32.png`、`icon48.png`、`icon128.png` | 扩展图标 | 是 | 作者借助 AI 图像工具生成 | 生成工具及其使用条款未记录（**UNVERIFIED**），公开发布前由作者确认 |
| `icons/css_1.png` … `css_5.png`、`icons/lucky1.png`、`icons/lucky2.png`、`icons/rename.png` | 招财猫小球、彩蛋、设置页插图 | 是 | 同上 | 同上 |
| `assets/icon-source.png` | 图标源图 | 否 | 同上 | 同上 |

这些 PNG 只含 `sRGB` / `pHYs` 块，没有记录生成工具的元数据。`icons/lucky.png` 是作者本地文件，被 `.gitignore` 忽略，不在仓库和扩展包里。

## 4. AI 生成内容

- `context_meaning`、`examples`、`memory_tip`、`common_collocations` 以及部分 `short_meaning`、`phonetic`、`part_of_speech` 由 DeepSeek API 生成。脚本默认模型为 `deepseek-chat`（可用 `DEEPSEEK_MODEL` 覆盖），每次运行实际用的模型没有记录（**UNVERIFIED**）。
- 按 DeepSeek Open Platform Terms of Service（2026-04-29 生效）第 4.2 条，DeepSeek 把输出中的权利（如有）转让给使用者。AI 生成内容在一些法域可能不受版权保护，项目不主张超出法律允许范围的权利。
- 同一条款要求向最终用户说明输出由 AI 生成：本词典大量内容由 AI 生成，可能有错误，没有逐条人工审核，不应作为权威参考。

## 5. 清理与校验

- Phase 5（2026-10）`clean-dictionary-entries.js`：删除 72 条空壳、97 条占位数字 / 纯符号 key，修正 11 条中文 term（25,687 → 25,518 条）。
- 运行时 `zehIsDictEntryUsable`：没有中文释义的条目当未命中处理。
- `audit-dictionary.js --structural` 检查字段结构；`check-term-mismatch.js` 检查 term 与 key 是否一致。
- Phase 5 之前若有手工编辑，没有留下记录（**UNVERIFIED**）。

## 6. 许可

- 在作者享有权利的范围内，`dictionary_core.json` 随项目以 MIT 许可提供（见根目录 `LICENSE`）。
- 来自 ECDICT 的部分仍受 ECDICT 的 MIT 许可约束，必须保留其版权与许可声明（`THIRD_PARTY_NOTICES.md` §4.4）。
- AI 生成部分见 §4。
- 词条选择参考了 §3 中许可不明的词表。词表只用于决定收录哪些常见词，没有复制其中的释义或其他文字；这一点是否需要进一步处理，留待公开发布前决定。

## 7. 重新生成

1. 从 ECDICT 下载 `ecdict.csv` 放到 `dic/`。
2. `npm run build:dictionary`。目标文件已有 enriched 数据时会拒绝；`--force-overwrite` 才覆盖（会先备份）。
3. `node scripts/enrich-dictionary.js --scan` 先看规模与费用；补全需要 `DEEPSEEK_API_KEY`（见 `.env.example`），并且必须给出范围参数或 `--confirm-full-run`。
4. `npm run clean:dictionary -- --write`，然后 `npm run audit:dictionary -- --structural --all-entries`。

AI 输出不确定，重新生成的结果不会与当前文件完全相同。

## 8. 发布包

Chrome 扩展运行时只需要 `data/dictionary_core.json`。`dic/`、`scripts/`、`tests/`、`assets/` 是开发用文件，不打进扩展包。`poem/quotes.json` 在许可核实之前也不打进扩展包（设置页「每日一句」改为显示内置的一句）。打包方法见 [`docs/RELEASE.md`](../docs/RELEASE.md)。
