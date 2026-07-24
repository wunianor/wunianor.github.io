---
name: youdao-note-migration
description: "该技能指导助手将有道笔记的一个或多个章节迁移、融合为一篇 Hugo 学习笔记。"
---

# 有道笔记迁移

当用户要求把有道笔记的一个或多个章节迁移、合并或融合成一篇 Hugo 学习笔记时触发本技能。

严格保真模式的完整约束见[严格保真生成协议](generation-protocol.md)。协议是正文、图片与最终 Hugo 输出的唯一生成门禁。

本技能**仅支持公共分享**：用 App 短链或 32 位 hex `shareId` 经 `share-info` / `cache-share` 拉取。不走私有笔记接口、凭证或私有笔记缓存。

## 端到端工作流

1. **解析分享输入**：`--share-id` 可为 App 短链（`https://share.note.youdao.com/s/...`）、32 位 hex，或 `index.html?id=...` 长链。脚本在 SSRF 防护下解析为 32 位 shareId；**勿**要求用户手动打开浏览器拿重定向 id。
2. **探查**：`share-info --share-id <shareId-or-url>`，只展示标题、shareId 和图片数。确认并完成内容 source 读取后，再提取 `headingPath`，展示章节映射与融合顺序供确认。
3. **确认 slug 并缓存**：必须确认 `category`、`topic`、`article`（`topic` 不可省）。仅在用户确认来源与这三个 slug 后，才可：

   ```sh
   node .cursor/skills/youdao-note-migration/scripts/cache-share.mjs --share-id <shareId-or-url> \
     --category <category-slug> --topic <topic-slug> --article <article-slug> --confirmed
   ```

   只从已存在的**公共分享缓存**读取 source、图片与 provenance；缓存与临时候选只写该文章的 `.tmp/content/notes/<category>/<topic>/<article>/`（含 `source/`、`images/`、`reports/`、`scripts/`、`candidates/` 等分类子目录），不直接写 `content/` 或最终 `static/`，也不得提交 `.tmp`。禁止在 `.tmp/` 根目录散落临时脚本、候选稿或其它文件。
4. **逐张图片确认**：缓存后对**每一张**图单独 AskQuestion（或等价提问）五选一：`preserve-original` / `markdown-transcription` / `redraw-candidate` / `alternate-expression` / `blocked`。禁止批量默认「全部原样保留」或共用图片 `approvalId`；`alternate-expression` 确认后须记录具体形式（表格/列表/文字等）。无论采用何种决策，正文中的图片锚点位置必须与原文对应位置一致（由 AI 审查；`blocked` 未解阻前不写替代内容）。
5. **变更计划与确认**：按协议生成草稿与变更计划——`formatChanges`（格式类，**逐处**确认）、`contentChanges`（内容类，每项确认一次）、图片决策、目标路径与 Front Matter。源 HTML → Markdown 默认忠实映射加粗/斜体/有序/无序列表；AI 认为需改格式时，须逐处提问（位置 + 原文片段 + 理由），再写入 `formatChanges`（含 `location` / `sourceExcerpt` / `reason`）。格式类含：`heading-structure`（顶层 `##` 空壳，或全文唯一顶层 `##` 须取消并重排）、`emphasis-syntax`、`chinese-punctuation`、`code-fence-comments`（必要时 `other-format`）。不得自行生成、重排或纠错正文；必须先确认。
6. **语义对照**：把候选 Markdown 与缓存来源逐段落比较，输出差异检查清单；格式差异进 `formatChanges`，内容差异进 `contentChanges`，均须 approval。不得声称机器验证器能证明来源语义等价。
7. **validate-draft**：在不可提交的候选上运行：

   ```sh
   node .cursor/skills/youdao-note-migration/scripts/validate-draft.mjs \
     --draft <relative-draft.json> \
     --markdown <relative-candidate.md>
   ```

   只读检查 approval、Hugo 格式、图片资产，以及格式门禁（顶层标题空壳/唯一顶层 `##`、强调语法、中文标点、代码围栏伪注释）。AI 对照与该命令均通过、用户确认后，才可在当前仓库切换到交付分支并写入最终文件。
8. 写入前用 `paths --category ... --topic ... --article ...` 核对路径；写入后运行 `npm test` 与 `git diff --check`。

## Hugo 类目门禁

在确认 slug 后、写入任何最终文件前，必须检查 `config/_default/hugo.toml` 的 `params.notes.categories` 显示名映射。当前类目已注册时可继续；若 `category-slug` 未注册，必须通过用户提问工具提出精确的 `{slug: displayName}` 建议并获批准后才可编辑配置。不得自动添加或修改该映射。

## 最终交付生命周期

1. 在任何最终写入前，先在**当前仓库**创建或切换到分支 `docs/<category-slug>_<topic-slug>_<article-slug>`（由 `content/notes/<category>/<topic>/<article>.md` 去掉 `content/notes/` 后把 `/` 换成 `_`），再写入最终文件；不得在其它分支写入。
2. 写入最终 Markdown 和图片后，完成独立逐段落审查，再依次运行 `validate-draft`、`check-note`、`check-site` 与 `git-readiness`：

   ```sh
   node .cursor/skills/youdao-note-migration/scripts/validate-draft.mjs --draft <relative-draft.json> --markdown <relative-candidate.md>
   node .cursor/skills/youdao-note-migration/scripts/check-note.mjs --draft <relative-draft.json> --approved-markdown <relative-candidate.md> --category <category-slug> --topic <topic-slug> --article <article-slug>
   node .cursor/skills/youdao-note-migration/scripts/check-site.mjs
   node .cursor/skills/youdao-note-migration/scripts/git-readiness.mjs --category <category-slug> --topic <topic-slug> --article <article-slug>
   ```

   `check-note` 只接受仓库内输入；最终 Markdown 必须逐字节匹配 `--approved-markdown` 候选，并验证最终图片目录清单、已批准图片本地文件、`.tmp`/远程链接和 HTML 图片标签。`preserve-original` 图片还必须与缓存 `provenance.json` 的 SHA256 和原始缓存文件一致。`check-site` 只以固定参数执行生产 Hugo 构建。`git-readiness` 只允许该文章 Markdown、该文章图片目录和通过重复 `--allow <relative-path>` 列出的额外路径；忽略的根目录 `.tmp` 可保留，但绝不能作为允许提交的路径。若 Git 报告任何 `.tmp` 变更，须在返回路径错误前运行未暂存和已暂存的 `git diff --check`，随后阻止就绪。
3. 向用户列出 `git-readiness` 报告的全部路径变更、AI 审查结论和每个门禁的 JSON 摘要。门禁不能证明来源语义等价，AI 审查仍是必需步骤。
4. 只有用户明确确认后，才可 `git add` / `git commit`；未指定提交信息时使用 `docs: 新增 <标题> 学习笔记`。不得自动提交。
5. 只有用户明确要求时，才可 push 或创建 PR；不得自动 push、创建 PR 或请求合并。
6. 只有收到明确“合并”指令后，才可合并分支或删除分支；不得自动执行。

## 脚本参考

本 skill 的全部文件均位于 `.cursor/skills/youdao-note-migration/`（文档、配置、脚本、库与测试）。缓存与 Git 门禁遵从同目录下的 `youdao-note-migration.json`。公开分享源是只读来源；可用脚本为：

| 脚本 | 用途 |
|------|------|
| `scripts/share-info.mjs` | 探查分享标题与图片数 |
| `scripts/cache-share.mjs` | 确认后缓存公共分享到 `.tmp` |
| `scripts/paths.mjs` | 输出缓存与最终路径 |
| `scripts/validate-draft.mjs` | 只读校验草稿与候选 Markdown |
| `scripts/check-note.mjs` | 校验最终交付文件 |
| `scripts/check-site.mjs` | Hugo 生产构建门禁 |
| `scripts/git-readiness.mjs` | Git 分支与变更路径门禁 |
