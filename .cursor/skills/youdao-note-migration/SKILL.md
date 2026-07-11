---
name: youdao-note-migration
description: "该技能指导助手将有道笔记的一个或多个章节迁移、融合为一篇 Hugo 学习笔记。"
---

# 有道笔记迁移

当用户要求把有道笔记的一个或多个章节迁移、合并或融合成一篇 Hugo 学习笔记时触发本技能。

严格保真模式的完整约束见[严格保真生成协议](generation-protocol.md)。协议是正文、图片与最终 Hugo 输出的唯一生成门禁。

## 缓存与确认工作流

1. 识别来源类型，并只从已存在的**公共分享缓存**或**私有 CLI 缓存**读取 source、原始图片和 provenance；缓存与最终验证前的临时候选只写 `.tmp`，不直接写 `content/` 或最终 `static/`，也不得提交 `.tmp`。
2. 私有来源在缓存前先运行 `preflight` 与 `search --title <title-query>`，私有候选仅展示 `id` 和标题；不得从候选解析器推断标题路径或融合顺序。确认并完成内容 source 读取后，代理才提取 `headingPath`，再展示章节映射与融合顺序供用户确认。公开来源先运行 `share-info --share-id <shareId>`，只展示标题、shareId 和图片数。短链接必须由用户提供公开 API shareId 或 `index.html?id=...`，不能猜测。
3. 每次迁移都必须要求且确认 `category`、`topic`、`article` 三个 slug；`topic` 不可省略。仅在用户确认来源与这三个 slug 后，才可使用 `cache --confirmed` 或 `cache-share --confirmed` 把来源写入 `.tmp`：

   ```sh
   node .cursor/skills/youdao-note-migration/youdao-note-migration.mjs cache --id <fileId> --category <category-slug> --topic <topic-slug> --article <article-slug> --confirmed
   node .cursor/skills/youdao-note-migration/youdao-note-migration.mjs cache-share --share-id <shareId> --category <category-slug> --topic <topic-slug> --article <article-slug> --confirmed
   ```

   私有 `.note` 的 `read` 输出若为非空纯文本，缓存会将原输出保存在 `source/note.txt`，并将相同的转换后正文保存在 `source/content.md`；其 provenance 标记为 `sourceFormat: "plain-text"`、`isRaw: false`，且不提取或下载图片。解析规则是：仅当首个非空白字符为 `{` 且后续明确为对象 JSON 时才解析 JSON；以 `[` 开头的输出一律是纯文本（包括 Markdown 链接）。纯文本缓存的 `rawText` 与 `content` 必须完全一致。此类纯文本无法提供嵌入图片；若图片重要，提示用户改用公共分享或导出来源。JSON `content` 输出继续保存为 `source/note.json` 和 `source/content.md`。

4. 读取缓存后，按协议生成草稿元数据和**变更计划**：列出章节来源、内容变更、图片分类、目标 Hugo 路径与 Front Matter。不得自行生成、重排或纠错正文；必须先确认。
5. AI 必须把候选 Markdown 与缓存来源逐段落比较，输出差异检查清单。该比较是语义保真审查，不得声称机器验证器能证明来源语义等价；清单中的每项非机械差异均须获得用户明确确认并记录 approval。
6. 先在非最终、不可提交的候选文件中准备 Markdown，随后执行：

   ```sh
   node .cursor/skills/youdao-note-migration/youdao-note-migration.mjs validate-draft \
     --draft <relative-draft.json> \
     --markdown <relative-candidate.md>
   ```

   `validate-draft` 仅确定性检查 approval、Hugo 格式和图片资产记录，且不会写入文件。只有 AI 段落对照和该命令都通过、用户确认后，才可在独立 worktree 写入最终 `content/` Markdown 或 `static/` 图片；未确认、拒绝或阻塞的项目不得写入。
7. 写入前使用 `paths --category <category-slug> --topic <topic-slug> --article <article-slug>` 核对目标路径；写入后运行 `npm test` 与 `git diff --check`。

## Hugo 类目门禁

在确认 slug 后、写入任何最终文件前，必须检查 `config/_default/hugo.toml` 的 `params.notes.categories` 显示名映射。当前类目已注册时可继续；若 `category-slug` 未注册，必须通过用户提问工具向用户提出精确的 `{slug: displayName}` 映射建议，并获得明确批准后才可编辑 Hugo 配置。不得自动添加或修改该映射。

## 最终交付生命周期

1. 在任何最终写入前，先创建并确认独立 worktree 与分支 `docs/<category-slug>-<article-slug>`；不得在用户当前工作目录或其他分支写入。
2. 写入最终 Markdown 和图片后，AI 必须完成独立的逐段落审查，再依次运行 `validate-draft`、`check-note`、`check-site` 与 `git-readiness`：

   ```sh
   node .cursor/skills/youdao-note-migration/youdao-note-migration.mjs validate-draft --draft <relative-draft.json> --markdown <relative-candidate.md>
   node .cursor/skills/youdao-note-migration/youdao-note-migration.mjs check-note --draft <relative-draft.json> --approved-markdown <relative-candidate.md> --category <category-slug> --topic <topic-slug> --article <article-slug>
   node .cursor/skills/youdao-note-migration/youdao-note-migration.mjs check-site
   node .cursor/skills/youdao-note-migration/youdao-note-migration.mjs git-readiness --category <category-slug> --topic <topic-slug> --article <article-slug>
   ```

   `check-note` 只接受仓库内输入；最终 Markdown 必须逐字节匹配 `--approved-markdown` 候选，并验证最终图片目录的精确清单、所有已批准图片的本地文件、`.tmp`/远程链接和 HTML 图片标签。`preserve-original` 图片还必须与缓存 `provenance.json` 的 SHA256 和原始缓存文件一致。`check-site` 只以固定参数执行生产 Hugo 构建。`git-readiness` 只允许该文章 Markdown、该文章图片目录和通过重复 `--allow <relative-path>` 明确列出的额外路径；忽略的根目录 `.tmp` 可以保留，但绝不能作为允许提交的路径。若 Git 报告任何 `.tmp` 变更，`git-readiness` 必须在返回路径错误前运行未暂存和已暂存的 `git diff --check`，随后阻止就绪状态。
3. 向用户列出 `git-readiness` 报告的全部路径变更、AI 审查结论和每个门禁的 JSON 摘要。门禁不能证明来源语义等价，AI 审查仍是必需步骤。
4. 只有用户明确确认后，才可调用 `git add` 和 `git commit`；未指定提交信息时使用 `docs: 新增 <标题> 学习笔记`。不得自动执行提交。
5. 只有用户明确要求时，才可 push 或创建 PR；不得自动执行 push、创建 PR 或请求合并。
6. 只有在之后收到用户明确“合并”指令时，才可合并分支或删除 worktree/分支；不得自动执行这些操作。

## 命令参考

本 skill 的全部文件均位于 `.cursor/skills/youdao-note-migration/`（文档、配置、CLI、库与测试）。读取、缓存与 Git 门禁遵从同目录下的 `youdao-note-migration.json`。公开分享源是只读来源，不调用私有 `youdaonote` CLI。
