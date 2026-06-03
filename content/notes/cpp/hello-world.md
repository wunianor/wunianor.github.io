---
title: "Hello World：第一个 C++ 程序"
date: 2026-06-01
draft: false
categories: ["cpp"]
tags: ["入门", "编译"]
type: "note"
weight: 10
description: "从 main 函数与 iostream 输出开始，验证本地编译环境。"
---

## 概述

本文用最小示例确认 C++ 工具链可用，并展示带行号的代码高亮。

## 示例代码

```cpp
#include <iostream>
#include <string>

int main() {
    std::string name = "wunianor";
    std::cout << "Hello, " << name << "!" << std::endl;
    return 0;
}
```

编译与运行：

```bash
g++ -std=c++17 -Wall -o hello hello.cpp
./hello
```

## 配图说明

站点配图约定：Markdown 引用 `/images/notes/<slug>/` 路径。

![示例配图：Docsy 站点占位图](/images/notes/demo/demo.png)

## 小结

- 使用 `g++ -std=c++17` 编译
- 输出流 `std::cout` 用于控制台打印
- 后续笔记将覆盖 STL 与内存管理
