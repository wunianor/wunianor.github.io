# 严格保真生成协议

当用户选择“严格保真”时，本协议优先于任何生成习惯：所有非机械变更必须先暂停、展示计划并获得明确确认。未确认时，助手不得生成、重排、纠错、补写或写入正文。

## 输入/输出契约

### 输入

- 已缓存的来源材料：经 `cache-share` 写入的**公共分享缓存**中的原始正文、图片、`reports/provenance.json` 与必要的来源元数据（App 短链或 hex shareId；不走私有笔记接口或凭证）。
- 用户提供或确认的来源章节列表、融合顺序、目标标题、`category-slug`、`topic-slug`、`article-slug`。
- `.cursor/skills/youdao-note-migration/youdao-note-migration-draft-template.json` 所定义的草稿元数据记录。

缓存不是最终输出；读取缓存不代表可以改写其内容。不得从缺失缓存猜测正文、图片含义或来源。

文章缓存目录约定：

```text
.tmp/content/notes/<category>/<topic>/<article>/
  source/                 # share.json, content.html
  images/original/        # cache-share 下载的原图
  images/generated/       # 重绘/新图，basename 与 original 一致
  reports/                # provenance.json, cache-manifest.json
  scripts/                # 临时探测/抽取脚本（若有）
  candidates/             # 候选 md、draft json 等（若有）
```

禁止在 `.tmp/` 根目录散落临时文件；临时脚本与候选稿必须落在上述文章缓存的分类子目录中。

### 输出

在用户确认后，当前仓库的交付分支上只能产生：

- `content/notes/<category-slug>/<topic-slug>/<article-slug>.md`
- `static/images/notes/<category-slug>/<article-slug>/...`
- 一份符合草稿模板的确认记录（可放在该文章缓存的 `candidates/` 或任务记录目录）。

最终写入前，可在该文章缓存的 `candidates/` 下创建仅供 `validate-draft` 读取的 Markdown 临时候选；它不是最终输出，必须保持不可提交。不得提交 `.tmp`，也不得把 `.tmp` 中的文件作为 Git 变更提交。本地 `git-readiness` 会拦截 `.tmp` 变更。缓存、来源与最终文件的每项对应关系必须写入草稿元数据。

## 章节与图片溯源

每个 `sourceSections` 条目必须是包含唯一 `ref`、来源 `id`、`title` 与完整 `headingPath` 的规范对象。每个 `outputSections` 条目和其中的每个 paragraph 都必须用非空 `sourceSectionRefs` 指向一个或多个已声明的 `sourceSections.ref`；融合多个来源时，草稿按最终出现顺序列出全部映射，不能只记录笔记标题。

每张图片必须记录来源 URL 或来源标识、缓存路径、最终路径、`sourceSectionRef` 与采用的图片决策。只有缓存中的实际文件能与来源记录一一对应时，才可称为“原样保留”。

图片处理方式可变（原样保留、转写、重绘、其他表达），但正文锚点位置必须与原文对应位置一致；位置一致性由 AI 审查。`blocked` 语义不变：未解阻前不写入替代内容。`redraw-candidate` 等产生的新文件写入 `images/generated/<same-basename>`，`cachePath` 指向该路径。

## AI 语义保真审查与确定性门禁

AI 必须逐段落把候选 Markdown 与已缓存的来源正文比较，并向用户输出差异检查清单；清单至少列出每个合并、删减、重排、标题层级变化、Markdown 转写、术语或标点变化，以及“无非机械差异”的逐段结论。来源段落映射仅供追踪，不是机器可证明的语义等价证明。

### 格式保真默认映射

源 HTML → Markdown 默认忠实映射：

- `font-weight:bold` / `<strong>` / `<b>` → `**...**`
- 斜体 → `*` / `_`
- `<ol>` → 有序列表
- `<ul>` → 无序列表

不得默默「优化」列表类型或强调标记。仅当 AI 认为某处需要偏离默认映射时，才可逐处提问（位置 + 原文片段 + 理由），获批后再改。

清单中的差异按确认模型分流：

- **formatChanges**（逐处确认）：`heading-structure`、`emphasis-syntax`、`chinese-punctuation`、`code-fence-comments`，必要时 `other-format`。同一 `category` 可有多条记录（每一处一条）；每条须含 `location`、`sourceExcerpt`、`reason`，并绑定独立 `approvalId`。标题扁平化、强调语法、中文标点、代码围栏伪注释等格式方案写入此类；`validate-draft` 对前四类做确定性启发式门禁（见后文）：启发式仍有问题时，须存在该 category 的已批准记录（A1）。
- **contentChanges**（按项确认）：正文措辞、合并删减、事实修订、Front Matter 等非格式内容变更。每项一条记录 + 一个 `approvalId`。Front Matter 必须有一个 `frontMatter: true` 的非机械 `contentChanges` 条目及其 approved `approvalId`，不能只凭根级 approval 放行。
- **images**：仍按张确认（见下文图片分类）。

不得声称 `validate-draft`、段落映射或任何确定性检查已经证明来源语义保真；这些门禁都不能证明来源语义保真。`validate-draft` 要求：草稿中出现的每一条 format、每一项非机械 content、每一张 image 均已 `approved` 且 `approvalId` 指向 approved 的 approval 对象。

最终写入前，候选 Markdown 必须位于非最终、不可提交的位置，并运行：

```sh
node .cursor/skills/youdao-note-migration/scripts/validate-draft.mjs \
  --draft <relative-draft.json> \
  --markdown <relative-candidate.md>
```

该命令只读、只输出安全 JSON 摘要；确定性检查确认记录、Hugo 格式、图片资产，以及格式门禁（`heading-structure` / `emphasis-syntax` / `chinese-punctuation` / `code-fence-comments`）。失败时输出安全 JSON 错误摘要并以非零状态退出。草稿与 Markdown 参数必须是仓库根目录下的相对路径，不能借由绝对路径、`..` 或符号链接离开根目录。AI 段落审查和 `validate-draft` 必须均已通过，才可写入最终文章或 `static/` 图片。

## 仅允许自动进行的机械变更

在严格保真模式中，仅可自动：

1. 读取已存在的公共分享缓存，提取元数据和文件清单。
2. 按已确认的 category、topic、article slug 推导 Hugo 的 Markdown 与图片目录。
3. 创建草稿元数据、变更计划和确认记录；这些记录不得包含实际笔记正文。
4. 在已确认“原样保留”和最终路径后，按字节复制缓存图片；不得裁切、压缩、转码或重命名为不同语义。
5. 将用户已确认的 Front Matter、章节编号和图片路径写入最终文件。

机械操作不会授权改变正文含义。任何正文生成、章节融合、标题层级变化、Markdown 转写、标点或术语纠错，都不是机械变更。

## 必须提出的确认问题

先展示一份变更计划：来源章节顺序、格式类变更（逐处）、内容类变更（按项）、每张图片决策、目标路径和待写入的 Front Matter。对结构性、事实性、图片不确定性问题再逐项询问，未确认项的状态为 `pending` 或 `blocked`。每一出现的 format 处、每一项非机械 `contentChanges` 与每张已决策图片必须记录独立的 `approvalId`，并指向显式 approval 对象；不得用自由文本 `scope` 代替关联。格式类不得把多处变更绑到同一个 `approvalId`；图片不得共用 `approvalId`。

- **格式类**（`formatChanges`）：顶层标题结构、强调语法、中文标点、代码围栏伪注释等是否按展示方案处理？不妥处逐条 AskQuestion（位置 + 原文片段 + 理由）。
- **结构性 / 内容类**（`contentChanges`）：哪些来源章节参与、融合顺序、是否省略重复内容、目标文件名与 Front Matter 值是否正确？
- **事实性**（`contentChanges`）：来源之间的技术结论、命令、参数、版本、数字或术语是否冲突或不完整？是否保持原文而不纠错、使用用户给出的修订，或阻塞？
- **图片不确定性**：每张图是否可追溯且可读？alt 文本、引用位置、转写内容、其他表达形式或重绘范围是否已确认？图片缺失、损坏、意义不明或无法确认来源时必须阻塞，不能用猜测的占位图替代。

缓存完成后，必须对**每一张**图片单独使用 AskQuestion（或等价的用户提问工具）做五选一决策；禁止把多张图批量默认成「全部原样保留」或共用同一个图片 `approvalId`。缺任何一张图的独立确认与 `approvalId` 时，`validate-draft` 必须失败。

用户须明确确认计划中的非机械项后，才可在当前仓库的交付分支写入最终 Markdown 或静态图片。用户拒绝或未回答时保留原缓存并停止该项，不得以“合理推断”继续。

## 图片分类

每张图片在草稿中使用以下唯一决策，并记录状态：原样保留、Markdown 转写、候选重绘、用其他方式表达或阻塞；每张图必须有独立 `approvalId`，指向 `approved` 的 approval 后才可写入。任意决策的产物（含转写/重绘/其他表达）均落在原文对应锚点位置；`blocked` 未解阻不写替代内容。

1. **原样保留**（`preserve-original`）：缓存文件和来源可一一对应；确认后按字节复制，并在正文引用最终路径。`cachePath` 指向 `images/original/<filename>`。
2. **Markdown 转写**（`markdown-transcription`）：把图中的内容转成 Markdown；必须先展示完整拟转写内容、说明丢失的视觉信息，并取得确认。正文锚点位置仍对应原文。
3. **候选重绘**（`redraw-candidate`）：只提出重绘建议、目标和差异；未确认前不得生成替代图。确认后新图写入 `images/generated/<same-basename>`，`cachePath` 指向该路径；正文锚点位置仍对应原文。
4. **用其他方式表达**（`alternate-expression`）：不以原图或转写/重绘呈现，而改用表格、列表、文字等其他形式；确认后必须在草稿中记录具体形式（`expressionForm`，如 `table` / `list` / `text`）。表达内容仍落在原文对应位置。
5. **阻塞**（`blocked`）：来源、含义、可读性或权利状态无法确认；不写入最终文章，等待用户决定。

## 确认记录

每次请求确认都添加一条 `approval.approvals` 对象。格式类变更、内容变更和图片以其 `approvalId` 反向链接该对象；不要用自由文本范围建立关联：

```json
{
  "id": "approval-001",
  "status": "approved",
  "recordedAt": "2026-07-11T08:00:00Z",
  "confirmedBy": "<config.approvalUserId>",
  "confirmedAt": "2026-07-11T08:00:00Z",
  "notes": "按展示的融合顺序与图片方案写入"
}
```

`confirmedBy` 必须精确等于 `.cursor/skills/youdao-note-migration/youdao-note-migration.json` 中预先配置的 `approvalUserId`，不得使用任意默认值；`confirmedAt` 必须是有效 UTC 时间戳。草稿根级 `approval.status` 只有在所有待写入非机械项均为 `approved` 时才可设为 `approved`。记录用户原话或足以复核的摘要；不要虚构确认。

## 最终 Hugo 输出结构

写入前由用户确认 Front Matter 的所有占位值：

```yaml
---
title: "<confirmed-title>"
description: "<confirmed-description>"
date: "<confirmed-date>"
draft: false
type: "note"
weight: <confirmed-positive-integer>
categories:
  - "<category-slug>"
tags:
  - "<confirmed-tag>"
---
```

最终输出前，根级 `approval.status`、每一条 format 变更、每项非机械内容变更和每项图片决策及其 `approvalId` 指向的 approval 都必须为 `approved`。Front Matter 必须具备 `title`、`date`、`draft: false`、非空 `categories`、非空 `tags`、`type: "note"`、正整数 `weight` 与 `description`；`categories[0]` 必须严格等于 `target.categorySlug`；不得使用 HTML `<img>`。

不另写 `#` 标题。确认使用编号后，正文层级必须严格为：

```md
## 1. <一级章节>
### 1.1. <二级章节>
#### 1.1.1. <三级章节>
```

同级编号连续递增；子级编号以其直接父级编号为前缀。

### 顶层标题扁平化（4D）

处理两类顶层 `##` 不合理结构；`###` 及以下的单子节点嵌套不自动扁平、也不单独触发本门禁。

- **须扁平（空壳）**：若某个 `##` 下有效结构是「恰好一个 `###` 子标题壳，且该 `###` 下还有更深层子标题」，则必须扁平为以有意义章节为顶层（只改标题层级与编号，正文段落/句子不改）。
- **须取消（唯一顶层 `##`）**：若全文最顶层 `##` 只出现 1 次，则判定布局不合理：删除该顶层 `##`，将其下每个 `###` 升为 `##` 并重编号，更深标题整体升一级；若该 `##` 下没有 `###`、只有正文，则删除该 `##`，正文直接跟在 Front Matter 后。
- **确认**：归入 `formatChanges` 类别 `heading-structure`；若有多处，逐处确认并各写一条（含 `location` / `sourceExcerpt`）。
- **门禁**：`validate-draft` 用确定性启发式检测未修复的顶层空壳或唯一顶层 `##`；若候选 Markdown 仍含该模式，且缺少已批准的 `heading-structure` 条目，则失败。已修复（不再触发启发式）时不要求该类。机器只做门禁，不静默改写；有已批准记录时允许候选尚未改完（与空壳门禁同一语义）。

交付分支名由学习笔记路径生成：去掉 `content/notes/` 前缀后把 `/` 换成 `_`（不含 `.md`），再加 `docs/` 前缀。例如 `content/notes/linux/io-multiplexing/io-basics.md` → 分支 `docs/linux_io-multiplexing_io-basics`（即 `docs/<category-slug>_<topic-slug>_<article-slug>`）。

### 强调语法（emphasis-syntax）

- **须修复**：强调标记与中英文标点错误贴邻（如 `**文本,**` / `**，文本**`），或排除代码围栏与行内代码后仍有未闭合的 `*` / `**` / `_` / `__`。
- **确认**：归入 `formatChanges` 类别 `emphasis-syntax`；不妥处逐处确认；`formatChanges` 记录位置、原文片段与修复方案。
- **门禁**：若候选 Markdown 仍检出上述问题且缺少已批准的 `emphasis-syntax` 条目，则失败。Markdown 已干净时不要求该类。机器只做门禁，不静默改写。

### 中文标点（chinese-punctuation）

- **规范**：正文与标题使用中文标点；**代码围栏、行内代码、URL、纯英文标识符不转换**。
- **确认**：归入 `formatChanges` 类别 `chinese-punctuation`；不妥处逐处确认。
- **门禁**：`validate-draft` 对「中文语境中与汉字贴邻的 ASCII `,` `.` `;` `:` `?` `!`」做启发式检测（编号小数中的 `.` 除外）；若仍检出且缺少已批准的 `chinese-punctuation` 条目，则失败。Markdown 已干净时不要求该类。机器只做门禁，不静默改写。

### 代码围栏伪注释（code-fence-comments）

- **规范**：代码围栏内、按语言应是注释却未注释的说明行（如 `c` 块中的 `作用:` / `参数:`），须加对应注释语法（`//` / `#` / `--` 等）。
- **确认**：归入 `formatChanges` 类别 `code-fence-comments`；不妥处逐处确认。
- **门禁**：以语言标签 + 常见中文说明前缀做启发式检测；`text`/`markdown` 等非代码围栏不检。若仍检出且缺少已批准的 `code-fence-comments` 条目，则失败。Markdown 已干净时不要求该类。不确定时列入清单由 AI 处理，不误改真代码。机器只做门禁，不静默改写。

文章图片在正文中必须使用：

```md
![<confirmed-alt-text>](/images/notes/<category-slug>/<article-slug>/<filename>)
```

相应文件只能位于 `static/images/notes/<category-slug>/<article-slug>/<filename>`。

草稿的 `target.categorySlug`、`target.topicSlug` 和 `target.articleSlug` 都是必填 kebab-case slug。`target.markdownPath` 必须严格等于 `content/notes/<category-slug>/<topic-slug>/<article-slug>.md`，`target.imageDir` 必须严格等于 `static/images/notes/<category-slug>/<article-slug>`。图片的 `cachePath` 必须位于该 article 的 `.tmp/content/notes/<category>/<topic>/<article>/images/(original|generated)/` 下，最终路径位于 `static/images/notes/<category>/<article>/`，不接受任意路径或跨文章路径。
