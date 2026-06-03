# 静态图片资源

文章配图统一放在 `static/images/` 下，Hugo 构建后会映射到站点根路径 `/images/`。

## 目录规范

| 用途 | 路径 | 说明 |
|------|------|------|
| 学习笔记配图 | `static/images/notes/<slug>/` | `<slug>` 与文章 slug 一致，便于维护 |
| 关于页头像（P3） | `static/images/about/` | 预留 |

## Markdown 引用

在笔记或文章中，使用站点根相对路径（以 `/images/` 开头）：

```markdown
![示例配图说明](/images/notes/cpp-hello/demo.png)
```

对应文件：`static/images/notes/cpp-hello/demo.png`

## Git LFS

`static/images/**/*.{png,jpg,jpeg,gif,webp}` 由 `.gitattributes` 走 Git LFS。

- 单图 **< 500KB**：可选直接 Git 跟踪（与 LFS 规则不冲突）
- **≥ 500KB** 或二进制大图：自动走 LFS

验证 LFS 跟踪：

```bash
git lfs track
git lfs ls-files
```
