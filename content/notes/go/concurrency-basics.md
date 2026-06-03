---
title: "Go 并发基础：goroutine 与 channel"
date: 2026-06-02
draft: false
categories: ["go"]
tags: ["并发", "goroutine"]
type: "note"
weight: 10
description: "用 WaitGroup 与 channel 协调多个 goroutine。"
---

## 概述

Go 通过 goroutine 与 channel 提供轻量级并发模型，本文记录最小可运行示例。

## 启动 goroutine

```go
package main

import (
	"fmt"
	"sync"
)

func worker(id int, wg *sync.WaitGroup) {
	defer wg.Done()
	fmt.Printf("worker %d done\n", id)
}

func main() {
	var wg sync.WaitGroup
	for i := 1; i <= 3; i++ {
		wg.Add(1)
		go worker(i, &wg)
	}
	wg.Wait()
	fmt.Println("all workers finished")
}
```

## channel 传递结果

```go
ch := make(chan int, 1)
go func() { ch <- 42 }()
fmt.Println(<-ch)
```

## 小结

- `go` 关键字启动 goroutine
- `sync.WaitGroup` 等待一组任务结束
- 带缓冲 channel 可避免阻塞发送方
