---
title: "IO理解与五种IO模型"
date: 2026-07-08
draft: false
categories: ["linux"]          # 仍用顶层分类 linux，/notes/ 总列表会显示「Linux」
tags: ["IO多路转接"]    # 可用 tag 做细分类
type: "note"
weight: 10
description: "记录IO概念与对IO的理解，以及五种IO模型"
---

## 1.对IO的理解

### 1.1.IO本质以及如何提高效率

比如说**read()/write()**，这两个函数的本质是把**内核/用户**缓冲区的数据拷贝到**用户/内核**缓冲区；

那么如果有事件未就绪（比如说*需要拷贝的数据没就绪*、*拷贝的目标缓冲区满了*），这个时候肯定是不能直接拷贝的，只能等对应事件就绪；

这也就引出：**IO=等(等待读/写事件就绪)+拷贝**

而需要提升单次IO的效率（即减少单次IO花费的时间）的话，也就有两个切入点：
1. **提升拷贝速度**；这个基本只能靠硬件来解决
2. **降低等的时间在单次IO时间内的占比**；高效的IO方式基本上都是通过**减少等的时间**来提升IO效率

### 1.2.同步IO与异步IO
1. **同步IO**：**参与了IO过程中的任意流程**，要不参与了等，要不参与了拷贝
2. **异步IO**：作为IO的发起者，不参与IO中的任何流程；进程仅发起 IO 请求，内核完成 “等待就绪 + 数据拷贝” 后通知进程（全程无需进程参与）


## 2.五种IO模型
在2025年11月28日与豆包的讨论： https://www.doubao.com/thread/w0cf943a2eb4563ac
### 2.1.阻塞式IO

<style>
.io-svg { width:100%; max-width:720px; height:auto; display:block; font-family:'PingFang SC','Segoe UI',Arial,sans-serif; }
[data-bs-theme="dark"] .io-svg text { fill:#E5E7EB; }
[data-bs-theme="dark"] .io-svg .io-panel { fill:#1F2937; stroke:#4B5563; }
[data-bs-theme="dark"] .io-svg .io-subtitle { fill:#9CA3AF; }
[data-bs-theme="dark"] .io-svg .io-center-line { stroke:#4B5563; }
</style>
<svg class="io-svg" viewBox="0 0 780 195" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="blockingGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#EA6668" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#EA6668" stop-opacity="0.4"/>
    </linearGradient>
    <linearGradient id="runningGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#52C41A" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#52C41A" stop-opacity="0.35"/>
    </linearGradient>
    <linearGradient id="kernelGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#9BBBF4" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#9BBBF4" stop-opacity="0.5"/>
    </linearGradient>
    <linearGradient id="copyGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#F4B393" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#F4B393" stop-opacity="0.5"/>
    </linearGradient>
    <marker id="arrow1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#374151"/>
    </marker>
  </defs>
  <rect class="io-panel" x="10" y="10" width="760" height="175" rx="8" fill="#F9FAFB" stroke="#E5E7EB" stroke-width="0.5"/>
  <text x="20" y="30" font-size="13" font-weight="600" fill="#1A1B1C">阻塞 IO (Blocking IO)</text>
  <text class="io-subtitle" x="20" y="46" font-size="10.5" fill="#6B7280">recvfrom() 全程阻塞，直到数据拷贝完成才返回</text>
  <text x="195" y="66" text-anchor="middle" font-size="12" font-weight="600" fill="#1A1B1C">用户进程 (User)</text>
  <text x="585" y="66" text-anchor="middle" font-size="12" font-weight="600" fill="#1A1B1C">内核 (Kernel)</text>
  <line class="io-center-line" x1="390" y1="72" x2="390" y2="162" stroke="#D1D5DB" stroke-width="1" stroke-dasharray="4,4"/>
  <rect x="120" y="78" width="150" height="18" rx="3" fill="url(#runningGrad)" stroke="#52C41A" stroke-width="0.8"/>
  <text x="195" y="91" text-anchor="middle" font-size="10.5" fill="#1A1B1C">运行</text>
  <rect x="120" y="96" width="150" height="42" rx="3" fill="url(#blockingGrad)" stroke="#EA6668" stroke-width="0.8"/>
  <text x="195" y="121" text-anchor="middle" font-size="10.5" fill="#1A1B1C">阻塞等待</text>
  <rect x="120" y="140" width="150" height="18" rx="3" fill="url(#runningGrad)" stroke="#52C41A" stroke-width="0.8"/>
  <text x="195" y="153" text-anchor="middle" font-size="10.5" fill="#1A1B1C">处理数据</text>
  <rect x="510" y="96" width="150" height="22" rx="3" fill="url(#kernelGrad)" stroke="#9BBBF4" stroke-width="0.8"/>
  <text x="585" y="110" text-anchor="middle" font-size="10.5" fill="#1A1B1C">等待数据就绪</text>
  <rect x="510" y="118" width="150" height="20" rx="3" fill="url(#copyGrad)" stroke="#F4B393" stroke-width="0.8"/>
  <text x="585" y="132" text-anchor="middle" font-size="10.5" fill="#1A1B1C">内核→用户拷贝</text>
  <line x1="270" y1="96" x2="510" y2="96" stroke="#374151" stroke-width="1" marker-end="url(#arrow1)"/>
  <text x="390" y="92" text-anchor="middle" font-size="10" fill="#374151">recvfrom()</text>
  <line x1="510" y1="138" x2="270" y2="138" stroke="#374151" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#arrow1)"/>
  <text x="390" y="134" text-anchor="middle" font-size="10" fill="#374151">返回 n 字节</text>
  <rect x="20" y="168" width="12" height="12" rx="2" fill="url(#runningGrad)" stroke="#52C41A" stroke-width="0.5"/>
  <text class="io-subtitle" x="36" y="178" font-size="10" fill="#6B7280">运行/非阻塞</text>
  <rect x="120" y="168" width="12" height="12" rx="2" fill="url(#blockingGrad)" stroke="#EA6668" stroke-width="0.5"/>
  <text class="io-subtitle" x="136" y="178" font-size="10" fill="#6B7280">进程阻塞</text>
  <rect x="220" y="168" width="12" height="12" rx="2" fill="url(#kernelGrad)" stroke="#9BBBF4" stroke-width="0.5"/>
  <text class="io-subtitle" x="236" y="178" font-size="10" fill="#6B7280">内核等待数据</text>
  <rect x="340" y="168" width="12" height="12" rx="2" fill="url(#copyGrad)" stroke="#F4B393" stroke-width="0.5"/>
  <text class="io-subtitle" x="356" y="178" font-size="10" fill="#6B7280">数据拷贝阶段</text>
</svg>

是同步IO；

阻塞式地等待，并进行拷贝；

实际场景简单使用


### 2.2.非阻塞轮询IO

<svg class="io-svg" viewBox="0 0 780 275" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="nb-blockingGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#EA6668" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#EA6668" stop-opacity="0.4"/>
    </linearGradient>
    <linearGradient id="nb-runningGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#52C41A" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#52C41A" stop-opacity="0.35"/>
    </linearGradient>
    <linearGradient id="nb-kernelGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#9BBBF4" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#9BBBF4" stop-opacity="0.5"/>
    </linearGradient>
    <linearGradient id="nb-copyGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#F4B393" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#F4B393" stop-opacity="0.5"/>
    </linearGradient>
    <marker id="nb-arrow1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#374151"/>
    </marker>
  </defs>
  <rect class="io-panel" x="10" y="10" width="760" height="255" rx="8" fill="#F9FAFB" stroke="#E5E7EB" stroke-width="0.5"/>
  <text x="20" y="30" font-size="13" font-weight="600" fill="#1A1B1C">非阻塞轮询 IO (Non-blocking IO)</text>
  <text class="io-subtitle" x="20" y="46" font-size="10.5" fill="#6B7280">反复调用 recvfrom，未就绪时立即返回 EWOULDBLOCK；蓝块表示数据未就绪，仅拷贝阶段阻塞</text>
  <text x="195" y="66" text-anchor="middle" font-size="12" font-weight="600" fill="#1A1B1C">用户进程 (User)</text>
  <text x="585" y="66" text-anchor="middle" font-size="12" font-weight="600" fill="#1A1B1C">内核 (Kernel)</text>
  <line class="io-center-line" x1="390" y1="72" x2="390" y2="243" stroke="#D1D5DB" stroke-width="1" stroke-dasharray="4,4"/>
  <rect x="120" y="78" width="150" height="28" rx="3" fill="url(#nb-runningGrad)" stroke="#52C41A" stroke-width="0.8"/>
  <text x="195" y="96" text-anchor="middle" font-size="9.5" fill="#1A1B1C">recvfrom</text>
  <rect x="120" y="106" width="150" height="28" rx="3" fill="url(#nb-runningGrad)" stroke="#52C41A" stroke-width="0.8" opacity="0.85"/>
  <text x="195" y="124" text-anchor="middle" font-size="9.5" fill="#1A1B1C">recvfrom</text>
  <rect x="120" y="134" width="150" height="28" rx="3" fill="url(#nb-runningGrad)" stroke="#52C41A" stroke-width="0.8" opacity="0.85"/>
  <text x="195" y="152" text-anchor="middle" font-size="9.5" fill="#1A1B1C">recvfrom</text>
  <rect x="120" y="162" width="150" height="34" rx="3" fill="url(#nb-blockingGrad)" stroke="#EA6668" stroke-width="0.8"/>
  <text x="195" y="182" text-anchor="middle" font-size="9.5" fill="#1A1B1C">阻塞拷贝</text>
  <rect x="120" y="196" width="150" height="16" rx="3" fill="url(#nb-runningGrad)" stroke="#52C41A" stroke-width="0.8"/>
  <text x="195" y="207" text-anchor="middle" font-size="9.5" fill="#1A1B1C">处理数据</text>
  <rect x="510" y="78" width="150" height="84" rx="3" fill="url(#nb-kernelGrad)" stroke="#9BBBF4" stroke-width="0.8"/>
  <text x="585" y="124" text-anchor="middle" font-size="10.5" fill="#1A1B1C">数据未就绪</text>
  <rect x="510" y="162" width="150" height="34" rx="3" fill="url(#nb-copyGrad)" stroke="#F4B393" stroke-width="0.8"/>
  <text x="585" y="182" text-anchor="middle" font-size="10" fill="#1A1B1C">内核→用户拷贝</text>
  <line x1="270" y1="86" x2="510" y2="86" stroke="#374151" stroke-width="0.8" marker-end="url(#nb-arrow1)"/>
  <line x1="510" y1="92" x2="270" y2="92" stroke="#374151" stroke-width="0.8" stroke-dasharray="3,2" marker-end="url(#nb-arrow1)"/>
  <text x="390" y="101" text-anchor="middle" font-size="8.5" fill="#6B7280">EWOULDBLOCK</text>
  <line x1="270" y1="114" x2="510" y2="114" stroke="#374151" stroke-width="0.8" marker-end="url(#nb-arrow1)"/>
  <line x1="510" y1="120" x2="270" y2="120" stroke="#374151" stroke-width="0.8" stroke-dasharray="3,2" marker-end="url(#nb-arrow1)"/>
  <text x="390" y="129" text-anchor="middle" font-size="8.5" fill="#6B7280">EWOULDBLOCK</text>
  <line x1="270" y1="142" x2="510" y2="142" stroke="#374151" stroke-width="0.8" marker-end="url(#nb-arrow1)"/>
  <line x1="510" y1="148" x2="270" y2="148" stroke="#374151" stroke-width="0.8" stroke-dasharray="3,2" marker-end="url(#nb-arrow1)"/>
  <text x="390" y="157" text-anchor="middle" font-size="8.5" fill="#6B7280">EWOULDBLOCK</text>
  <line x1="270" y1="162" x2="510" y2="162" stroke="#374151" stroke-width="1" marker-end="url(#nb-arrow1)"/>
  <text x="390" y="171" text-anchor="middle" font-size="9.5" fill="#374151">recvfrom()</text>
  <line x1="510" y1="196" x2="270" y2="196" stroke="#374151" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#nb-arrow1)"/>
  <text x="390" y="202" text-anchor="middle" font-size="9.5" fill="#374151">返回 n 字节</text>
  <rect x="20" y="248" width="12" height="12" rx="2" fill="url(#nb-runningGrad)" stroke="#52C41A" stroke-width="0.5"/>
  <text class="io-subtitle" x="36" y="258" font-size="10" fill="#6B7280">运行/非阻塞</text>
  <rect x="120" y="248" width="12" height="12" rx="2" fill="url(#nb-blockingGrad)" stroke="#EA6668" stroke-width="0.5"/>
  <text class="io-subtitle" x="136" y="258" font-size="10" fill="#6B7280">进程阻塞</text>
  <rect x="220" y="248" width="12" height="12" rx="2" fill="url(#nb-kernelGrad)" stroke="#9BBBF4" stroke-width="0.5"/>
  <text class="io-subtitle" x="236" y="258" font-size="10" fill="#6B7280">内核等待数据</text>
  <rect x="340" y="248" width="12" height="12" rx="2" fill="url(#nb-copyGrad)" stroke="#F4B393" stroke-width="0.5"/>
  <text class="io-subtitle" x="356" y="258" font-size="10" fill="#6B7280">数据拷贝阶段</text>
</svg>

同步IO;

非阻塞式地轮询,并进行拷贝;

1. 如果进程/线程在轮询期间还会做别的事情,在IO效率方面与阻塞式没有区别,在整体效率上与阻塞式IO有区别;
2. 如果进程/线程是纯轮询,那么CPU会忙等;

实际场景简单使用

### 2.3.信号驱动式IO

<svg class="io-svg" viewBox="0 0 780 235" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="sig-blockingGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#EA6668" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#EA6668" stop-opacity="0.4"/>
    </linearGradient>
    <linearGradient id="sig-runningGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#52C41A" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#52C41A" stop-opacity="0.35"/>
    </linearGradient>
    <linearGradient id="sig-kernelGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#9BBBF4" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#9BBBF4" stop-opacity="0.5"/>
    </linearGradient>
    <linearGradient id="sig-copyGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#F4B393" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#F4B393" stop-opacity="0.5"/>
    </linearGradient>
    <marker id="sig-arrow1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#374151"/>
    </marker>
    <marker id="sig-arrow-sig" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#7C3AED"/>
    </marker>
  </defs>
  <rect class="io-panel" x="10" y="10" width="760" height="215" rx="8" fill="#F9FAFB" stroke="#E5E7EB" stroke-width="0.5"/>
  <text x="20" y="30" font-size="13" font-weight="600" fill="#1A1B1C">信号驱动 IO (Signal-driven IO)</text>
  <text class="io-subtitle" x="20" y="46" font-size="10.5" fill="#6B7280">sigaction() 注册 SIGIO 处理函数，等待阶段用户继续运行；数据就绪后内核发 SIGIO，再 recvfrom() 完成拷贝</text>
  <text x="195" y="66" text-anchor="middle" font-size="12" font-weight="600" fill="#1A1B1C">用户进程 (User)</text>
  <text x="585" y="66" text-anchor="middle" font-size="12" font-weight="600" fill="#1A1B1C">内核 (Kernel)</text>
  <line class="io-center-line" x1="390" y1="72" x2="390" y2="205" stroke="#D1D5DB" stroke-width="1" stroke-dasharray="4,4"/>
  <rect x="120" y="78" width="150" height="20" rx="3" fill="url(#sig-runningGrad)" stroke="#52C41A" stroke-width="0.8"/>
  <text x="195" y="92" text-anchor="middle" font-size="10" fill="#1A1B1C">建立信号处理</text>
  <rect x="120" y="98" width="150" height="46" rx="3" fill="url(#sig-runningGrad)" stroke="#52C41A" stroke-width="0.8"/>
  <text x="195" y="125" text-anchor="middle" font-size="10.5" fill="#1A1B1C">继续运行（不阻塞）</text>
  <rect x="120" y="144" width="150" height="28" rx="3" fill="url(#sig-blockingGrad)" stroke="#EA6668" stroke-width="0.8"/>
  <text x="195" y="162" text-anchor="middle" font-size="10" fill="#1A1B1C">recvfrom 拷贝</text>
  <rect x="120" y="172" width="150" height="16" rx="3" fill="url(#sig-runningGrad)" stroke="#52C41A" stroke-width="0.8"/>
  <text x="195" y="183" text-anchor="middle" font-size="10" fill="#1A1B1C">处理数据</text>
  <rect x="510" y="98" width="150" height="46" rx="3" fill="url(#sig-kernelGrad)" stroke="#9BBBF4" stroke-width="0.8"/>
  <text x="585" y="125" text-anchor="middle" font-size="10.5" fill="#1A1B1C">等待数据就绪</text>
  <rect x="510" y="144" width="150" height="28" rx="3" fill="url(#sig-copyGrad)" stroke="#F4B393" stroke-width="0.8"/>
  <text x="585" y="162" text-anchor="middle" font-size="10" fill="#1A1B1C">内核→用户拷贝</text>
  <line x1="270" y1="86" x2="510" y2="86" stroke="#374151" stroke-width="0.8" marker-end="url(#sig-arrow1)"/>
  <text x="390" y="94" text-anchor="middle" font-size="9.5" fill="#374151">sigaction()</text>
  <line x1="270" y1="96" x2="510" y2="96" stroke="#374151" stroke-width="0.8" marker-end="url(#sig-arrow1)"/>
  <text x="390" y="104" text-anchor="middle" font-size="9.5" fill="#374151">fcntl(O_ASYNC)</text>
  <line x1="510" y1="133" x2="270" y2="133" stroke="#C9A7E8" stroke-width="0.9" stroke-dasharray="3,2" marker-end="url(#sig-arrow-sig)"/>
  <text x="390" y="129" text-anchor="middle" font-size="9.5" fill="#7C3AED">SIGIO 信号</text>
  <line x1="270" y1="144" x2="510" y2="144" stroke="#374151" stroke-width="1" marker-end="url(#sig-arrow1)"/>
  <text x="390" y="152" text-anchor="middle" font-size="9.5" fill="#374151">recvfrom()</text>
  <line x1="510" y1="172" x2="270" y2="172" stroke="#374151" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#sig-arrow1)"/>
  <text x="390" y="168" text-anchor="middle" font-size="9.5" fill="#374151">返回 n 字节</text>
  <rect x="20" y="208" width="12" height="12" rx="2" fill="url(#sig-runningGrad)" stroke="#52C41A" stroke-width="0.5"/>
  <text class="io-subtitle" x="36" y="218" font-size="10" fill="#6B7280">运行/非阻塞</text>
  <rect x="120" y="208" width="12" height="12" rx="2" fill="url(#sig-blockingGrad)" stroke="#EA6668" stroke-width="0.5"/>
  <text class="io-subtitle" x="136" y="218" font-size="10" fill="#6B7280">进程阻塞</text>
  <rect x="220" y="208" width="12" height="12" rx="2" fill="url(#sig-kernelGrad)" stroke="#9BBBF4" stroke-width="0.5"/>
  <text class="io-subtitle" x="236" y="218" font-size="10" fill="#6B7280">内核等待数据</text>
  <rect x="340" y="208" width="12" height="12" rx="2" fill="url(#sig-copyGrad)" stroke="#F4B393" stroke-width="0.5"/>
  <text class="io-subtitle" x="356" y="218" font-size="10" fill="#6B7280">数据拷贝阶段</text>
</svg>

同步IO；

收到IO信号进行拷贝,理论上来说不需要等，只需要拷贝；

实际场景几乎不用


### 2.4.多路复用/多路转接

<svg class="io-svg" viewBox="0 0 780 210" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="mux-blockingGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#EA6668" stop-opacity="0.25"/>
      <stop offset="100%" stop-color="#EA6668" stop-opacity="0.4"/>
    </linearGradient>
    <linearGradient id="mux-runningGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#52C41A" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#52C41A" stop-opacity="0.35"/>
    </linearGradient>
    <linearGradient id="mux-kernelGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#9BBBF4" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#9BBBF4" stop-opacity="0.5"/>
    </linearGradient>
    <linearGradient id="mux-copyGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#F4B393" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#F4B393" stop-opacity="0.5"/>
    </linearGradient>
    <marker id="mux-arrow1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#374151"/>
    </marker>
  </defs>
  <rect class="io-panel" x="10" y="10" width="760" height="188" rx="8" fill="#F9FAFB" stroke="#E5E7EB" stroke-width="0.5"/>
  <text x="20" y="30" font-size="13" font-weight="600" fill="#1A1B1C">多路转接 IO (IO Multiplexing)</text>
  <text class="io-subtitle" x="20" y="46" font-size="10.5" fill="#6B7280">epoll_wait 阻塞等待多个 fd 就绪，返回后再 recvfrom() 拷贝；两段阻塞分别对应「等」与「拷贝」</text>
  <text x="195" y="66" text-anchor="middle" font-size="12" font-weight="600" fill="#1A1B1C">用户进程 (User)</text>
  <text x="585" y="66" text-anchor="middle" font-size="12" font-weight="600" fill="#1A1B1C">内核 (Kernel)</text>
  <line class="io-center-line" x1="390" y1="72" x2="390" y2="178" stroke="#D1D5DB" stroke-width="1" stroke-dasharray="4,4"/>
  <rect x="120" y="78" width="150" height="14" rx="3" fill="url(#mux-runningGrad)" stroke="#52C41A" stroke-width="0.8"/>
  <text x="195" y="89" text-anchor="middle" font-size="10" fill="#1A1B1C">运行</text>
  <rect x="120" y="92" width="150" height="26" rx="3" fill="url(#mux-blockingGrad)" stroke="#EA6668" stroke-width="0.8"/>
  <text x="195" y="108" text-anchor="middle" font-size="10" fill="#1A1B1C">阻塞等待就绪</text>
  <rect x="120" y="118" width="150" height="28" rx="3" fill="url(#mux-blockingGrad)" stroke="#EA6668" stroke-width="0.8"/>
  <text x="195" y="136" text-anchor="middle" font-size="10" fill="#1A1B1C">recvfrom 拷贝</text>
  <rect x="120" y="146" width="150" height="16" rx="3" fill="url(#mux-runningGrad)" stroke="#52C41A" stroke-width="0.8"/>
  <text x="195" y="157" text-anchor="middle" font-size="10" fill="#1A1B1C">处理数据</text>
  <rect x="510" y="92" width="150" height="26" rx="3" fill="url(#mux-kernelGrad)" stroke="#9BBBF4" stroke-width="0.8"/>
  <text x="585" y="106" text-anchor="middle" font-size="9.5" fill="#1A1B1C">监控多个 fd</text>
  <text x="585" y="116" text-anchor="middle" font-size="9.5" fill="#1A1B1C">等待就绪</text>
  <rect x="510" y="118" width="150" height="28" rx="3" fill="url(#mux-copyGrad)" stroke="#F4B393" stroke-width="0.8"/>
  <text x="585" y="136" text-anchor="middle" font-size="10" fill="#1A1B1C">内核→用户拷贝</text>
  <line x1="270" y1="92" x2="510" y2="92" stroke="#374151" stroke-width="1" marker-end="url(#mux-arrow1)"/>
  <text x="390" y="100" text-anchor="middle" font-size="9.5" fill="#374151">epoll_wait()</text>
  <line x1="510" y1="117" x2="270" y2="117" stroke="#374151" stroke-width="0.8" stroke-dasharray="3,2" marker-end="url(#mux-arrow1)"/>
  <text x="390" y="113" text-anchor="middle" font-size="9.5" fill="#374151">fd 就绪</text>
  <line x1="270" y1="118" x2="510" y2="118" stroke="#374151" stroke-width="1" marker-end="url(#mux-arrow1)"/>
  <text x="390" y="126" text-anchor="middle" font-size="9.5" fill="#374151">recvfrom()</text>
  <line x1="510" y1="146" x2="270" y2="146" stroke="#374151" stroke-width="1" stroke-dasharray="3,2" marker-end="url(#mux-arrow1)"/>
  <text x="390" y="142" text-anchor="middle" font-size="9.5" fill="#374151">返回 n 字节</text>
  <rect x="20" y="181" width="12" height="12" rx="2" fill="url(#mux-runningGrad)" stroke="#52C41A" stroke-width="0.5"/>
  <text class="io-subtitle" x="36" y="191" font-size="10" fill="#6B7280">运行/非阻塞</text>
  <rect x="120" y="181" width="12" height="12" rx="2" fill="url(#mux-blockingGrad)" stroke="#EA6668" stroke-width="0.5"/>
  <text class="io-subtitle" x="136" y="191" font-size="10" fill="#6B7280">进程阻塞</text>
  <rect x="220" y="181" width="12" height="12" rx="2" fill="url(#mux-kernelGrad)" stroke="#9BBBF4" stroke-width="0.5"/>
  <text class="io-subtitle" x="236" y="191" font-size="10" fill="#6B7280">内核等待数据</text>
  <rect x="340" y="181" width="12" height="12" rx="2" fill="url(#mux-copyGrad)" stroke="#F4B393" stroke-width="0.5"/>
  <text class="io-subtitle" x="356" y="191" font-size="10" fill="#6B7280">数据拷贝阶段</text>
</svg>

同步IO；

一个进程/线程管理大量的IO请求(大量的fd)；

实际场景最多使用；

### 2.5.异步IO

<svg class="io-svg" viewBox="0 0 780 220" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="aio-runningGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#52C41A" stop-opacity="0.2"/>
      <stop offset="100%" stop-color="#52C41A" stop-opacity="0.35"/>
    </linearGradient>
    <linearGradient id="aio-kernelGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#9BBBF4" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#9BBBF4" stop-opacity="0.5"/>
    </linearGradient>
    <linearGradient id="aio-copyGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#F4B393" stop-opacity="0.3"/>
      <stop offset="100%" stop-color="#F4B393" stop-opacity="0.5"/>
    </linearGradient>
    <marker id="aio-arrow1" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#374151"/>
    </marker>
    <marker id="aio-arrow-done" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto">
      <path d="M0,0 L10,5 L0,10 z" fill="#0D9488"/>
    </marker>
  </defs>
  <rect class="io-panel" x="10" y="10" width="760" height="198" rx="8" fill="#F9FAFB" stroke="#E5E7EB" stroke-width="0.5"/>
  <text x="20" y="30" font-size="13" font-weight="600" fill="#1A1B1C">异步 IO (Asynchronous IO)</text>
  <text class="io-subtitle" x="20" y="46" font-size="10.5" fill="#6B7280">aio_read() 提交后用户继续执行；内核完成等+拷贝后通过信号/回调通知，用户侧全程无阻塞</text>
  <text x="195" y="66" text-anchor="middle" font-size="12" font-weight="600" fill="#1A1B1C">用户进程 (User)</text>
  <text x="585" y="66" text-anchor="middle" font-size="12" font-weight="600" fill="#1A1B1C">内核 (Kernel)</text>
  <line class="io-center-line" x1="390" y1="72" x2="390" y2="188" stroke="#D1D5DB" stroke-width="1" stroke-dasharray="4,4"/>
  <rect x="120" y="78" width="150" height="16" rx="3" fill="url(#aio-runningGrad)" stroke="#52C41A" stroke-width="0.8"/>
  <text x="195" y="90" text-anchor="middle" font-size="10" fill="#1A1B1C">运行</text>
  <rect x="120" y="94" width="150" height="58" rx="3" fill="url(#aio-runningGrad)" stroke="#52C41A" stroke-width="0.8"/>
  <text x="195" y="126" text-anchor="middle" font-size="10.5" fill="#1A1B1C">继续执行其他任务</text>
  <rect x="120" y="152" width="150" height="18" rx="3" fill="url(#aio-runningGrad)" stroke="#52C41A" stroke-width="0.8"/>
  <text x="195" y="164" text-anchor="middle" font-size="10" fill="#1A1B1C">信号/回调处理</text>
  <rect x="510" y="94" width="150" height="34" rx="3" fill="url(#aio-kernelGrad)" stroke="#9BBBF4" stroke-width="0.8"/>
  <text x="585" y="114" text-anchor="middle" font-size="10.5" fill="#1A1B1C">等待数据就绪</text>
  <rect x="510" y="128" width="150" height="24" rx="3" fill="url(#aio-copyGrad)" stroke="#F4B393" stroke-width="0.8"/>
  <text x="585" y="143" text-anchor="middle" font-size="10" fill="#1A1B1C">内核→用户拷贝</text>
  <line x1="270" y1="94" x2="510" y2="94" stroke="#374151" stroke-width="1" marker-end="url(#aio-arrow1)"/>
  <text x="390" y="102" text-anchor="middle" font-size="9.5" fill="#374151">aio_read()</text>
  <line x1="510" y1="152" x2="270" y2="152" stroke="#94D8C3" stroke-width="0.9" stroke-dasharray="3,2" marker-end="url(#aio-arrow-done)"/>
  <text x="390" y="160" text-anchor="middle" font-size="9.5" fill="#0D9488">完成通知（信号/回调）</text>
  <rect x="20" y="191" width="12" height="12" rx="2" fill="url(#aio-runningGrad)" stroke="#52C41A" stroke-width="0.5"/>
  <text class="io-subtitle" x="36" y="201" font-size="10" fill="#6B7280">运行/非阻塞</text>
  <rect x="120" y="191" width="12" height="12" rx="2" fill="url(#aio-kernelGrad)" stroke="#9BBBF4" stroke-width="0.5"/>
  <text class="io-subtitle" x="136" y="201" font-size="10" fill="#6B7280">内核等待数据</text>
  <rect x="220" y="191" width="12" height="12" rx="2" fill="url(#aio-copyGrad)" stroke="#F4B393" stroke-width="0.5"/>
  <text class="io-subtitle" x="236" y="201" font-size="10" fill="#6B7280">数据拷贝阶段</text>
  <rect x="320" y="191" width="12" height="12" rx="2" fill="none" stroke="#94D8C3" stroke-width="1"/>
  <text class="io-subtitle" x="336" y="201" font-size="10" fill="#0D9488">异步完成通知</text>
</svg>

异步IO；

作为IO的发起者,只关心数据是否已经拷贝完毕；

进程仅发起 IO 请求，内核完成 “等待就绪 + 数据拷贝” 后通知进程（全程无需进程参与）；

理论上IO效率最高；

实际场景没有多路复用用的多
