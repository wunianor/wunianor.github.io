---
title: "站点架构：Hugo + Docsy 选型"
date: 2026-06-03
draft: false
project: "hugo-site"
tags: ["Hugo", "Docsy"]
type: "project"
weight: 10
description: "记录静态站点生成器与主题选型的考量。"
---

## 概述

本系列记录 wunianor.github.io 从骨架到上线的架构决策。

## 技术栈

| 组件 | 选择 | 说明 |
|------|------|------|
| SSG | Hugo Extended | 构建速度快，原生支持 Modules |
| 主题 | Docsy | 文档式布局，侧栏 + TOC |
| 部署 | GitHub Pages | Actions 构建 artifact 发布 |

## 目录约定

```text
content/
  notes/     # 学习笔记（M7）
  projects/  # 项目系列文章（M8）
```

## 小结

- Hugo Extended 满足 SCSS 与 PostCSS 需求
- Docsy 提供现成的 docs 布局，减少自定义 CSS
- 内容按 section 分栏，URL 与导航一一对应
