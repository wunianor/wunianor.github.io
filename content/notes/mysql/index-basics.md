---
title: "MySQL 索引基础与 EXPLAIN"
date: 2026-06-03
draft: false
categories: ["mysql"]
tags: ["索引", "优化"]
type: "note"
weight: 10
description: "创建二级索引并用 EXPLAIN 查看执行计划。"
---

## 概述

合理索引能显著降低全表扫描成本。本文记录建表、建索引与查看执行计划的步骤。

## 建表与索引

```sql
CREATE TABLE users (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  email VARCHAR(255) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_users_email (email)
);
```

## 查看执行计划

```sql
EXPLAIN SELECT id, email
FROM users
WHERE email = 'demo@example.com';
```

关注 `type`、`key`、`rows` 等字段，确认是否命中 `idx_users_email`。

## 小结

- 高频过滤列适合建立二级索引
- `EXPLAIN` 是排查慢查询的第一步
- 避免在低选择性列上滥建索引
