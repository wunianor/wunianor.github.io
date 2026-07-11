# 严格保真生成协议

当用户选择“严格保真”时，本协议优先于任何生成习惯：所有非机械变更必须先暂停、展示计划并获得明确确认。未确认时，助手不得生成、重排、纠错、补写或写入正文。

## 输入/输出契约

### 输入

- 已缓存的来源材料：公共分享缓存或私有 CLI 缓存中的原始正文、图片、`reports/provenance.json` 与必要的来源元数据。
- 用户提供或确认的来源章节列表、融合顺序、目标标题、`category-slug`、`topic-slug`、`article-slug`。
- `.cursor/skills/youdao-note-migration/youdao-note-migration-draft-template.json` 所定义的草稿元数据记录。

私有 `.note` 的非空纯文本读取结果是转换后来源：保留原输出于 `source/note.txt`，并以 `source/content.md` 作为后续比较的正文；provenance 必须记录 `sourceFormat: "plain-text"` 与 `isRaw: false`，且图片清单为空。仅当输出以 `{` 开头且明确意图为对象 JSON 时才解析为 JSON；以 `[` 开头的一律作为纯文本保留。纯文本来源的 `rawText` 与 `content` 必须完全一致。纯文本不能提供嵌入图片；若图片影响输出，要求用户提供公共分享或导出来源。JSON `content` 来源仍保留 `source/note.json`，provenance 标记为 `sourceFormat: "json-content"`。

缓存不是最终输出；读取缓存不代表可以改写其内容。不得从缺失缓存猜测正文、图片含义或来源。

### 输出

在用户确认后，独立 worktree 中只能产生：

- `content/notes/<category-slug>/<topic-slug>/<article-slug>.md`
- `static/images/notes/<category-slug>/<article-slug>/...`
- 一份符合草稿模板的确认记录（可放在该 worktree 的任务记录目录）。

最终写入前，可在 `.tmp` 下创建仅供 `validate-draft` 读取的 Markdown 临时候选；它不是最终输出，必须保持不可提交。不得提交 `.tmp`，也不得把 `.tmp` 中的文件作为 Git 变更提交。本地 `git-readiness` 会拦截 `.tmp` 变更。缓存、来源与最终文件的每项对应关系必须写入草稿元数据。

## 章节与图片溯源

每个 `sourceSections` 条目必须是包含唯一 `ref`、来源 `id`、`title` 与完整 `headingPath` 的规范对象。每个 `outputSections` 条目和其中的每个 paragraph 都必须用非空 `sourceSectionRefs` 指向一个或多个已声明的 `sourceSections.ref`；融合多个来源时，草稿按最终出现顺序列出全部映射，不能只记录笔记标题。

每张图片必须记录来源 URL 或来源标识、缓存路径、最终路径、`sourceSectionRef` 与采用的图片决策。只有缓存中的实际文件能与来源记录一一对应时，才可称为“原样保留”。

## AI 语义保真审查与确定性门禁

AI 必须逐段落把候选 Markdown 与已缓存的来源正文比较，并向用户输出差异检查清单；清单至少列出每个合并、删减、重排、标题层级变化、Markdown 转写、术语或标点变化，以及“无非机械差异”的逐段结论。来源段落映射仅供追踪，不是机器可证明的语义等价证明。

清单中的所有非机械差异都必须写入 `contentChanges`，并由用户明确确认。Front Matter 也必须有一个 `frontMatter: true` 的非机械 `contentChanges` 条目及其 approved `approvalId`，不能只凭根级 approval 放行。不得声称 `validate-draft`、段落映射或任何确定性检查已经证明来源语义保真。

最终写入前，候选 Markdown 必须位于非最终、不可提交的位置，并运行：

```sh
node .cursor/skills/youdao-note-migration/youdao-note-migration.mjs validate-draft \
  --draft <relative-draft.json> \
  --markdown <relative-candidate.md>
```

该命令只读、只输出安全 JSON 摘要，并只确定性检查确认记录、Hugo 格式和图片资产记录；失败时输出安全 JSON 错误摘要并以非零状态退出。草稿与 Markdown 参数必须是 worktree 根目录下的相对路径，不能借由绝对路径、`..` 或符号链接离开根目录。AI 段落审查和 `validate-draft` 必须均已通过，才可写入最终文章或 `static/` 图片。

## 仅允许自动进行的机械变更

在严格保真模式中，仅可自动：

1. 读取已存在的公共分享缓存或私有 CLI 缓存，提取元数据和文件清单。
2. 按已确认的 category、topic、article slug 推导 Hugo 的 Markdown 与图片目录。
3. 创建草稿元数据、变更计划和确认记录；这些记录不得包含实际笔记正文。
4. 在已确认“原样保留”和最终路径后，按字节复制缓存图片；不得裁切、压缩、转码或重命名为不同语义。
5. 将用户已确认的 Front Matter、章节编号和图片路径写入最终文件。

机械操作不会授权改变正文含义。任何正文生成、章节融合、标题层级变化、Markdown 转写、标点或术语纠错，都不是机械变更。

## 必须提出的确认问题

先展示一份变更计划：来源章节顺序、每项内容变更、每张图片决策、目标路径和待写入的 Front Matter。对结构性、事实性、图片不确定性问题再逐项询问，未确认项的状态为 `pending` 或 `blocked`。每项非机械 `contentChanges` 与每张已决策图片必须记录 `approvalId`，并指向显式 approval 对象；不得用自由文本 `scope` 代替关联。

- **结构性**：哪些来源章节参与、融合顺序、是否省略重复内容、标题或层级如何映射、是否采用编号规则，以及目标文件名与 Front Matter 值是否正确？
- **事实性**：来源之间的技术结论、命令、参数、版本、数字或术语是否冲突或不完整？是否保持原文而不纠错、使用用户给出的修订，或阻塞？
- **图片不确定性**：每张图是否可追溯且可读？alt 文本、引用位置、转写内容或重绘范围是否已确认？图片缺失、损坏、意义不明或无法确认来源时必须阻塞，不能用猜测的占位图替代。

用户须明确确认计划中的非机械项后，才可在独立 worktree 写入最终 Markdown 或静态图片。用户拒绝或未回答时保留原缓存并停止该项，不得以“合理推断”继续。

## 图片分类

每张图片在草稿中使用以下唯一决策，并记录状态：原样保留、Markdown 转写、候选重绘或阻塞。

1. **原样保留**（`preserve-original`）：缓存文件和来源可一一对应；确认后按字节复制，并在正文引用最终路径。
2. **Markdown 转写**（`markdown-transcription`）：把图中的内容转成 Markdown；必须先展示完整拟转写内容、说明丢失的视觉信息，并取得确认。
3. **候选重绘**（`redraw-candidate`）：只提出重绘建议、目标和差异；未确认前不得生成替代图。
4. **阻塞**（`blocked`）：来源、含义、可读性或权利状态无法确认；不写入最终文章，等待用户决定。

## 确认记录

每次请求确认都添加一条 `approval.approvals` 对象。内容变更和图片以其 `approvalId` 反向链接该对象；不要用自由文本范围建立关联：

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

最终输出前，根级 `approval.status`、每项非机械内容变更和每项图片决策及其 `approvalId` 指向的 approval 都必须为 `approved`。Front Matter 必须具备 `title`、`date`、`draft: false`、非空 `categories`、非空 `tags`、`type: "note"`、正整数 `weight` 与 `description`；`categories[0]` 必须严格等于 `target.categorySlug`；不得使用 HTML `<img>`。

不另写 `#` 标题。确认使用编号后，正文层级必须严格为：

```md
## 1. <一级章节>
### 1.1. <二级章节>
#### 1.1.1. <三级章节>
```

同级编号连续递增；子级编号以其直接父级编号为前缀。文章图片在正文中必须使用：

```md
![<confirmed-alt-text>](/images/notes/<category-slug>/<article-slug>/<filename>)
```

相应文件只能位于 `static/images/notes/<category-slug>/<article-slug>/<filename>`。

草稿的 `target.categorySlug`、`target.topicSlug` 和 `target.articleSlug` 都是必填 kebab-case slug。`target.markdownPath` 必须严格等于 `content/notes/<category-slug>/<topic-slug>/<article-slug>.md`，`target.imageDir` 必须严格等于 `static/images/notes/<category-slug>/<article-slug>`。图片的缓存路径与最终路径必须分别位于该 article 的 `.tmp/static/...` 与 `static/...` 目录，不接受任意路径或跨文章路径。
