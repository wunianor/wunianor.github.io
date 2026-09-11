---
title: "epoll"
description: "包括 epoll 三个系统调用、原理（红黑树/就绪队列/回调）、LT/ET 模式，以及 reactor"
date: "2026-09-11"
draft: false
type: "note"
weight: 40
categories:
  - "linux"
tags:
  - "IO多路转接"
---

## 1. 系统调用

### 1.1. epoll_create()——创建epoll模型

```c
#include <sys/epoll.h>
int epoll_create(int size);

/* 作用: */
/*     创建一个epoll模型, */
/*     返回epoll模型对应的fd */
/* 参数: */
/*     size:已被废弃, */
/*     只要传入>0的数即可 */
/*         Since Linux 2.6.8, the size argument is ignored, */
/*         but must be greater than zero; */
/* 返回值: */
/*     成功,返回一个epoll fd */
/*     On error, -1 is returned, */
/*     and errno is set to indicate the error. */
```

### 1.2. epoll_wait()——获取已经有关心事件就绪的fd

```c
#include <sys/epoll.h>

int epoll_wait(int epfd,
               struct epoll_event *events,
               int maxevents,
               int timeout);
/* 作用: */
/*     从epoll模型的就绪队列里面 */
/*     获取已经有关心事件就绪的fd */
/* 参数: */
/*     epfd: */
/*         epoll模型的fd */
/*     events:输出型参数 */
/*         传入一个epoll_event数组, */
/*         输出已经有关心事件就绪的fd的数组 */
/*         struct epoll_event结构如下: */
        typedef union epoll_data
        {
          void *ptr;
          int fd;
          uint32_t u32;
          uint64_t u64;
        } epoll_data_t;

        struct epoll_event
        {
          uint32_t events;  /* Epoll events 位图 */
          epoll_data_t data;    /* User data variable */
        } __EPOLL_PACKED;
/*        可选选项如下表 */
/*     maxevents: */
/*         events数组的大小 */
/*     timeout: */
/*         等待时间,单位ms; */
/*         传-1,表示阻塞等待 */
/*         传0,表示非阻塞等待 */
/* 返回值: */
/*     >0,表示已经有关心事件就绪的fd的个数; */
/*     =0,表示等待时间内没有任何fd就绪, */
/*     即超时 */
/*     On failure, epoll_wait() returns -1 */
/*     and errno is set to indicate the error. */
```

下面是一张 EPOLL 事件标志位表，
每一个事件在 `events` 内对应二进制的某一位：

| 事件 | 描述 | 是否可作为输入 | 是否可作为输出 |
| --- | --- | --- | --- |
| EPOLLIN | 读事件（包括对端 SOCKET 正常关闭） | 是 | 是 |
| EPOLLOUT | 写事件 | 是 | 是 |
| EPOLLPRI | 紧急数据可读（带外数据） | 是 | 是 |
| EPOLLERR | 对应的文件描述符发生错误 | 否 | 是 |
| EPOLLHUP | 对应的文件描述符被挂断 | 否 | 是 |
| EPOLLET | 边缘触发（ET）模式 | 是 | 否 |
| EPOLLONESHOT | 只监听一次事件；若还需监听，需再次加入 epoll 队列 | 是 | 否 |

### 1.3. epoll_ctl()——增/改/删关心的fd及其事件

```c
#include <sys/epoll.h>

int epoll_ctl(int epfd,
              int op,
              int fd,
              struct epoll_event *_Nullable event);
/* 作用: */
/*     增/改/删关心的fd及其事件 */
/* 参数: */
/*     epfd: */
/*         epoll 模型的fd */
/*     op:进行的操作选项 */
        EPOLL_CTL_ADD /*增加*/
        EPOLL_CTL_MOD /*修改*/
        EPOLL_CTL_DEL /*删除*/
/*     fd:操作的fd */
/*     event:该fd关心的事件 */
/* 返回值: */
/*     When successful, epoll_ctl() returns zero. */
/*     When an error occurs, epoll_ctl() returns -1 */
/*     and errno  is  set  to indicate the error. */
```

## 2. epoll原理

![epoll 原理：红黑树、就绪队列与硬件中断](/images/notes/linux/io-multiplexing/epoll/image-013.svg)

epoll模型三大机制:

1. **红黑树**:本质上与select(),poll()那维护合法fd的数组相同，
   并且查找效率更高
2. **就绪队列**:存放有关心事件就绪的fd
3. **回调函数机制**:当驱动来数据(读事件就绪)(或者其他事件)了，会执行回调函数,
   查找红黑树,检查对应fd是否有关心该事件，
   若关心，则将该fd放入就绪队列中

## 3. LT（水平触发）与 ET（边沿触发）

### 3.1. 两种模式是什么

LT 和 ET 是 epoll 的事件触发模式，作用于被监听的文件描述符 fd。
epoll 默认是 LT；select、poll 只有 LT 模式。
给 fd 添加 `EPOLLET` 标志注册进 epoll，就开启 ET 模式。

**LT（水平触发 level triggered）**：只要 fd 的内核缓冲区还有未读完的数据，
fd 就处于就绪状态，epoll_wait 会持续返回该就绪事件。

**ET（边沿触发 edge triggered）**：仅当 fd 的状态发生跳变时，才上报一次就绪事件。
典型跳变：缓冲区从空变为有数据，或是已有数据的缓冲区又收到新数据。
如果一次事件通知后，缓冲区数据没有被全部读完，且后续没有新数据进来，
内核不会再次上报事件；只有缓冲区状态再次发生变化，才会再次触发。

### 3.2. 缓冲区数据未读完的表现

LT：事件就绪后，不必一次性读完缓冲区。
例如本次只读 1K，缓冲区剩余 1K。
下一轮调用 epoll_wait 会立刻再次返回该 fd 的读就绪事件，
重复通知，直到缓冲区数据全部被读取完毕。
LT 支持阻塞、非阻塞两种 fd。

ET：事件就绪仅有一次上报机会（若无新数据）。
同样只读 1K，缓冲区剩 1K，只要没有新数据包到达，
后续 epoll_wait 不会再返回这个读事件，残留数据会一直留在缓冲区。
ET 关注缓冲区状态的**变化瞬间**，要求我们在本次事件回调里把缓冲区数据全部读完。
在本次通知里把缓冲区循环读完之后，TCP 会向对方通告更大的窗口，
从而从概率上让对方一次发来更多数据。

### 3.3. 性能，以及 ET 为什么必须使用非阻塞 fd

ET 的优势是减少 epoll_wait 的事件唤醒次数，所以理论上性能更好，
Nginx epoll 默认使用 ET。
但性能差距不是绝对的：LT 模式下，如果每次就绪事件都一次性读完缓冲区，
epoll_wait 的触发次数和 ET 可以做到基本一致。
代价是 ET 的业务代码复杂度更高。

ET 必须搭配非阻塞 fd，以读事件举例：ET 需要循环读取直到缓冲区无数据。
但程序无法提前知道内核缓冲区的数据总量，只能循环调用 read。
若 fd 是阻塞模式，当缓冲区数据读完后，read 会阻塞等待新数据，
直接卡住整个 Reactor 事件循环。
使用非阻塞 read，缓冲区空的时候 read 返回 `-1`，
`errno` 为 `EAGAIN/EWOULDBLOCK`，代表当前无更多可读数据，
这时才终止循环。所以 ET 只能使用非阻塞读写。

>
> 思考：LT 也可以全部 fd 设置为非阻塞，
> 每次就绪都循环读取直到 EAGAIN，一次性清空缓冲区，
> 那是不是就等价 ET？
> 并不是完全等价。
> LT 的内核机制仍然是：只要缓冲区有数据就持续就绪。
> 如果代码出现 bug，某次没有读完，
> 下一轮 epoll_wait 会立刻再次触发事件，内核自带兜底。
> 而 ET 没有兜底，残留数据会一直静默留在缓冲区。
> 另外可写事件（EPOLLOUT）二者行为差异巨大：
> LT 只要写缓冲区有空位就持续上报可写事件；
> ET 只在写缓冲区由满变为有空位这一瞬间上报一次。
> 哪怕读事件处理逻辑写得一模一样，
> 二者在可写事件的处理逻辑上依然不能等同。

## 4. 惊群问题

### 4.1. 问题是什么

惊群问题是多个进程或线程被同一个事件同时唤醒，
但最终只有一个能拿到事件，其余全都白跑一趟。

具体到 epoll：一个客户端发起连接，
监听 socket 由不可读变为可读，
阻塞在同一个监听 socket 上的多个进程或线程
（各自调用 `epoll_wait`，或者直接阻塞在 `accept`）会被同时唤醒。
它们一起调用 `accept` 抢这个新连接，
但内核只会把连接交给其中一个，
其余的 `accept` 返回 `-1`，
`errno` 为 `EAGAIN` 或 `EWOULDBLOCK`。
这些被唤醒的进程或线程什么也没拿到，
却付出了大量上下文切换的代价，
浪费了 CPU。

### 4.2. 为什么会出现

因为内核通知的是「监听 socket 上有新连接」这个事件，
而不是「该由哪个进程或线程来处理」。

监听 socket 就绪时，
内核把「可读」这件事通知给所有正在等待它的执行流：
多个 epoll 实例监听同一个监听 socket 时，
每个实例的等待队列都可能被唤醒；
多个进程直接阻塞在 `accept` 上时，
它们同样会一起被唤醒。
内核并不预先指定赢家，
每个被唤醒的等待者都得自己去 `accept` 一次，
只有一个能成功，其余只能拿到 `EAGAIN`。
也就是说，惊群来自内核「广而告之」的唤醒方式
与应用层「只需要一个人处理」的期望不匹配。

### 4.3. 怎么解决

核心思路是在唤醒前就选出唯一的处理者，
常见做法有单监听派发、`SO_REUSEPORT` 和 `EPOLLEXCLUSIVE` 三种。

1. 单监听派发：只让一个 acceptor（主线程或主进程）
   监听 socket 并 `accept`，
   拿到的新连接 fd 再分发给 worker 处理。
   监听 socket 上永远只有一个等待者，
   自然不会有惊群，
   也不依赖较新的内核。
2. `SO_REUSEPORT`：每个 worker 各自 `socket`、
   用 `setsockopt` 打开 `SO_REUSEPORT`、
   `bind` 同一个端口并 `listen`。
   内核在协议层把新连接负载均衡到其中一个 socket，
   每个 worker 持有各自的监听 fd，
   不再共享同一个等待队列，
   也就不会被同一个 fd 一起唤醒。
3. `EPOLLEXCLUSIVE`（Linux 4.5 起）：
   注册事件时带上这个标志，
   多个 epoll 实例监听同一个 fd 时，
   内核只唤醒其中一个实例去处理，
   其余实例继续睡眠。

此外还有应用层的 `accept_mutex`：
`epoll_wait` 返回后先抢一把锁，
抢到的线程才去 `accept`。
Nginx 早期用它缓解惊群，
但锁本身也有开销。

需要注意，如果多个线程共享同一个 epoll 实例并在其上 `epoll_wait`，
`EPOLLEXCLUSIVE` 就帮不上忙了，
因为它约束的是 fd 与 epoll 实例之间的关系。
这时可以用 `EPOLLONESHOT` 让一个 fd 的事件只上报一次、
处理完再重新注册，
避免同一个连接被多个线程重复处理，
但唤醒后只有一个线程能真正读到数据这一点仍要自己保证。

实际新项目里更常用单监听派发或 `SO_REUSEPORT`：
前者实现简单，
后者让内核直接做负载均衡。

## 5. reactor（反应堆）

reactor 是一种事件驱动的服务端结构：
用一个事件循环统一等待大量 fd，
事件就绪后再把就绪事件分派给对应的处理函数。

它把「等待」与「处理」分开，
事件循环里只做两件事：
先用 select/poll/epoll 拿到就绪的 fd 集合，
再按 fd 的角色分派。
监听 socket 就绪就 `accept` 新连接，
并把新 fd 注册进多路转接模型；
已连接 socket 就绪就负责读写数据。
业务代码不必自己轮询每个 fd，
也不必为每个连接开一个线程去阻塞等待。

事件循环与回调通常跑在同一个线程里，
耗时的业务处理会拖住整个循环，
所以实际实现里常再配一个线程池，
把耗时任务交给 worker，
避免阻塞事件循环。
