---
title: "select"
date: "2026-07-17"
draft: false
categories:
  - "linux"
tags:
  - "IO多路转接"
type: "note"
weight: 20
description: "包括select系统调用及其优缺点、`fd_set`操作、以及一个简单的通过select实现的TCP服务器"
---

## 1. 系统调用

### 1.1. select()——只负责等待，不负责拷贝

```c
#include <sys/select.h>
int select(int nfds, 
          fd_set *_Nullable restrict readfds,
          fd_set *_Nullable restrict writefds,
          fd_set *_Nullable restrict exceptfds,
          struct timeval *_Nullable restrict timeout);
/* 作用: */
/*     只负责等待每个关心的fd的读/写/异常事件就绪, */
/*     可以同时等待多个fd, */
/*     有关心的fd对应关心的事件就绪了or超时就返回 ,*/
/*     如果读事件就绪了就可以使用read()等函数读取
/* 参数: */
/*     nfds:等待的多个fd的最大值+1 */
/*     readfds:输入输出型参数,struct fd_set本质是一个位图结构 */
/*         输入: */
/*             传入需要关心 读事件 的fd_set位图 */
/*         输出: */
/*             输出 读事件已经就绪 的fd_set位图 */
/*     writefds:输入输出型参数 */
/*         输入: */
/*             传入需要关心 写事件 的fd_set位图 */
/*         输出: */
/*             输出 写事件已经就绪 的fd_set位图 */
/*     exceptfds:输入输出型参数 */
/*         输入: */
/*             传入需要关心 异常事件 的fd_set位图 */
/*         输出: */
/*             输出 异常事件已经就绪 的fd_set位图 */
/*     timeout:输入输出型参数 */
/*         struct timeval结构体: */
            struct timeval
            {
                __time_t tv_sec;    /* Seconds.秒  */
                __suseconds_t tv_usec;  /* Microseconds. 毫秒 */
            };
/*         输入: */
/*             设置等待时间; */
/*             如果传nullptr,为阻塞等待; */
/*             如果传{0,0},为非阻塞等待; */
/*         输出: */
/*             返回剩余的等待时间; */
/*             例如,等待时间设置为{5,0}, */
/*             等待了{1,0}就select()返回了, */
/*             那么该参数返回{4,0} */
/* 返回值: */
/*     n>0,表示有n个关心的fd对应关心的事件就绪了 */
/*     n=0,超时了 */
/*     n<0,表示出错,并设置errno */
    On  error, -1 is returned, and errno is set to indicate the error; the file descriptor sets are unmodified, and
       timeout becomes undefined.
```

### 1.2. `fd_set`(位图结构)的四个操作函数

```c
void FD_CLR(int fd, fd_set *set);
/* 作用: */
/*     在set内将fd对应位 置为0 */
int  FD_ISSET(int fd, fd_set *set);
/* 作用: */
/*     判断set内fd对应位 是否为1 */
void FD_SET(int fd, fd_set *set);
/* 作用: */
/*     在set内将fd对应位 置为1 */
void FD_ZERO(fd_set *set);
/* 作用: */
/*     将set的所有位 置为0 */
```

### 1.3. 一个select搭建简单tcp服务器的demo
```cpp
#include <cstdio>
#include <unistd.h>

#include <sys/select.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#include <iostream>
#include <string>
#include <vector>
#include <algorithm>

class TcpServer
{
public:
    TcpServer(const std::string& ip = "0.0.0.0", uint16_t port = 8888, int backlog = 5)
        : _ip(ip), _port(port), _backlog(backlog), _serverfd(-1)
    {
    }

    ~TcpServer()
    {
        stop();
    }

    // 创建套接字、开启地址复用、绑定、开始监听
    bool listen()
    {
        //创建套接字
        _serverfd = socket(AF_INET, SOCK_STREAM, 0);
        if (_serverfd < 0)
        {
            perror("[error]scoket()");
            return false;
        }

        //开启地址复用
        int reuse = 1;
        if (setsockopt(_serverfd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) < 0)
        {
            perror("[error]setsockopt()");
            close(_serverfd);
            _serverfd = -1;
            return false;
        }

        //绑定地址端口
        struct sockaddr_in addr;
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = inet_addr(_ip.c_str());
        addr.sin_port = htons(_port);
        if (bind(_serverfd, (const sockaddr*)(&addr), sizeof(addr)) < 0)
        {
            perror("[error]bind()");
            close(_serverfd);
            _serverfd = -1;
            return false;
        }

        //开始监听
        if (::listen(_serverfd, _backlog) < 0)
        {
            perror("[error]listen()");
            close(_serverfd);
            _serverfd = -1;
            return false;
        }
        std::cout << "[debug]开始监听,serverfd=" << _serverfd << std::endl;
        return true;
    }

    // select 事件循环
    void run()
    {
        if (_serverfd < 0)
        {
            std::cerr << "[error]请先调用 listen()" << std::endl;
            return;
        }

        fd_set fdset;
        std::vector<int> clientfds;
        while (1)
        {
            FD_ZERO(&fdset);
            FD_SET(_serverfd, &fdset);

            int maxfd = _serverfd;
            for (auto const clientfd : clientfds)
            {
                FD_SET(clientfd, &fdset);
                maxfd = std::max(maxfd, clientfd);
            }

            std::cout << "[debug]进行select等待,maxfd=" << maxfd << std::endl;
            int n = select(maxfd + 1, &fdset, nullptr, nullptr, nullptr);
            std::cout << "[debug]select触发,返回值=" << n << std::endl;

            //有读事件就绪
            if (n > 0)
            {
                //获取新连接
                if (FD_ISSET(_serverfd, &fdset))
                {
                    sockaddr_in clientAddr;
                    socklen_t clientAddrLen = sizeof(clientAddr);
                    int clientfd = accept(_serverfd, (sockaddr*)&clientAddr, &clientAddrLen);
                    if (clientfd < 0)
                    {
                        std::cerr << "[error]"
                                  << "获取新连接失败" << std::endl;
                        break;
                    }

                    char clientIp[16];
                    uint16_t clientPort = ntohs(clientAddr.sin_port);
                    if (inet_ntop(AF_INET, &(clientAddr.sin_addr), clientIp, sizeof(clientIp)) == NULL)
                    {
                        std::cerr << "[warning]"
                                  << "解析客户端ip地址失败"
                                  << "clientfd=" << clientfd
                                  << std::endl;
                    }
                    clientIp[15] = '\0';

                    std::cout << "[info]获取新连接,clientfd=" << clientfd << ","
                              << "IP地址->" << clientIp << ":" << clientPort
                              << std::endl;
                    clientfds.emplace_back(clientfd);
                }

                for (auto it = clientfds.begin(); it != clientfds.end();)
                {
                    auto& clientfd = *it;
                    //客户端发送数据
                    if (FD_ISSET(clientfd, &fdset))
                    {
                        char buff[1024];
                        ssize_t readN = read(clientfd, buff, sizeof(buff));

                        if (0 == readN)
                        {
                            std::cout << "[info]客户端下线,clientfd=" << clientfd << std::endl;
                            close(clientfd);
                            it = clientfds.erase(it);
                        }
                        else if (0 > readN)
                        {
                            perror("[error]read()");
                            close(clientfd);
                            it = clientfds.erase(it);
                            break;
                        }
                        else
                        {
                            buff[readN] = '\0';
                            std::cout << "[info]收到客户端内容:" << std::endl << buff << std::endl;
                            const std::string response =
                                "HTTP/1.1 302 Found\r\n"
                                "Location: https://ys-api.mihoyo.com/event/download_porter/link/ys_cn/official/pc_default\r\n"
                                "Content-Type: text/html;charset=utf-8\r\n"
                                "Content-Length: 78\r\n"
                                "\r\n"
                                "<html><head><meta http-equiv=\"refresh\" content=\"0;url=https://ys-api.mihoyo.com/event/download_porter/link/ys_cn/official/pc_default\"></head><body>跳转中...</body></html>";
                            if (write(clientfd, response.c_str(), response.size()) < 0)
                            {
                                perror("write()");
                                break;
                            }
                            ++it;
                        }
                    }
                    else
                        ++it;
                }
            }
            else
            {
                std::cerr << "select失败" << std::endl;
                break;
            }
        }

        for (auto const clientfd : clientfds)
        {
            close(clientfd);
        }
        clientfds.clear();
    }

private:
    void stop()
    {
        if (_serverfd >= 0)
        {
            close(_serverfd);
            _serverfd = -1;
        }
    }

    //服务器ip
    std::string _ip;

    //服务器端口
    uint16_t _port;

    //TCP全连接队列的最大长度
    int _backlog;

    //服务器监听套接字
    int _serverfd;
};

int main()
{
    TcpServer server("0.0.0.0", 8888);
    if (!server.listen())
        return 1;
    server.run();
    return 0;
}


```

## 2. select的优缺点

**优点**：

1. 单线程/单进程即可管理多个fd
2. **提高IO效率**

**缺点**：

1. **(最重要)能管理的fd数量太少了**，只能管理 `sizeof(fd_set)*8` 个**（一般是1024个）**
2. 每次调用时，**都需要重新设置关心读/写/异常的fd有哪些（因为参数是输入输出型的）**
3. 每次调用时，都需要发生**用户级<->内核级的双向拷贝（因为参数是输入输出型的）**
4. **需要大量的遍历**（假如数组内有10000个fd呢？**降低效率**）：在用户层，需要**自己使用数组管理所有合法的fd，才能让select()进行等待所有的合法fd，用户层会需要遍历很多次；在内核层，检测fd事件是否就绪，也需要遍历 `struct file*` 数组**，select第一个参数的作用是限制内核遍历的范围
