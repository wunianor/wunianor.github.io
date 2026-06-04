---
title: "CI/CD：GitHub Actions 部署 Pages"
date: 2026-06-04
draft: false
project: "hugo-site"
tags: ["GitHub Actions", "Pages"]
type: "project"
weight: 20
description: "Hugo 构建与 GitHub Pages artifact 发布流程。"
---

## 概述

站点通过 GitHub Actions 自动构建并发布到 Pages，本文记录关键步骤。

## 工作流要点

```yaml
- name: Setup Hugo
  uses: peaceiris/actions-hugo@v3
  with:
    hugo-version: "latest"
    extended: true

- name: Build
  run: hugo --minify

- name: Upload artifact
  uses: actions/upload-pages-artifact@v3
  with:
    path: ./public
```

## 构建要求

- `hugo --minify` 退出码须为 0
- PostCSS 依赖已在 `package.json` 中声明
- Git LFS 在 checkout 时启用，保证图片资源可用

## 小结

- Actions 构建与本地 `hugo --minify` 保持一致
- artifact 方式发布，无需 gh-pages 分支
- 每次 push main 自动更新线上站点
