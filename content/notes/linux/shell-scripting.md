---
title: "Shell 脚本：批量重命名文件"
date: 2026-06-03
draft: false
categories: ["linux"]
tags: ["bash", "脚本"]
type: "note"
weight: 10
description: "用 Bash 循环与参数扩展批量处理文件名。"
---

## 概述

Linux 日常运维中常需批量重命名，Bash 循环配合 `mv` 即可快速完成。

## 遍历并重命名

```bash
#!/usr/bin/env bash
set -euo pipefail

prefix="backup"
count=1

for file in *.log; do
  [[ -f "$file" ]] || continue
  mv -- "$file" "${prefix}-${count}-${file}"
  count=$((count + 1))
done

echo "Renamed $((count - 1)) files"
```

## 权限与可执行

```bash
chmod +x rename-logs.sh
./rename-logs.sh
```

## 小结

- `set -euo pipefail` 提升脚本健壮性
- 使用 `--` 避免文件名以 `-` 开头时被误解析
- 生产环境操作前先在测试目录验证
