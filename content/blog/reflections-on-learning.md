---
title: "学习笔记与博客：栏目拆分实践"
date: 2026-06-04
draft: false
categories: ["meta"]
tags: ["Hugo", "站点"]
type: "blog"
weight: 10
description: "记录将 type: blog 文章从 notes 拆至独立博客栏的过程与 URL 策略。"
aliases:
  - /notes/meta/reflections-on-learning/
---

## 背景

站点第二期将博客文与学习笔记合并放在 `notes` 目录，用 Front Matter `type` 区分；第三期（M10）再拆出独立「博客」导航。

## 迁移要点

| 项 | 做法 |
|------|------|
| 内容目录 | `content/blog/<slug>.md` → `/blog/<slug>/` |
| 布局 | 复用 M7 docs 式侧栏 + TOC（`layouts/blog/`） |
| 旧 URL | Front Matter `aliases` 保留 `/notes/.../` 可访问 |
| 笔记列表 | `notes` 栏目仅展示 `type: note` |

## 示例代码

```bash
hugo --minify
# 检查 /blog/ 列表与 /blog/reflections-on-learning/ 详情
```

## 小结

- 博客与学习笔记分栏展示，导航并列
- Front Matter 契约与 M7 一致（`categories`、`tags`、`description` 等）
- 旧链接通过 `aliases` 重定向至新路径
