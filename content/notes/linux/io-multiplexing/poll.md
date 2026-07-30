---
title: "poll"
date: "2026-07-24"
draft: false
categories:
  - "linux"
tags:
  - "IO多路转接"
type: "note"
weight: 30
description: "包括poll系统调用及其优缺点、事件标志位，以及一个用poll实现的简单tcp服务器demo"
---

## 1. 系统调用

### 1.1. poll()——只负责等待关心的事件是否就绪，可以同时等待多个fd

```c
#include <poll.h>
int poll(struct pollfd *fds, nfds_t nfds, int timeout);

/* 作用: */
/*     只负责等待关心的事件是否就绪， */
/*     可以同时等待多个fd， */
/*     有关心的fd对应关心的事件就绪了or超时就返回 */
/* 参数: */
/*     fds: */
/*         一个pollfd类型的数组， */
            struct pollfd {
                  int   fd;     /* file descriptor */
                  short events; /* 输入型参数:告诉poll(内核)需要关心这个fd的哪些事件 */
                  short revents;/* 输出型参数:poll()(内核)告诉用户这个fd关心的哪些事件已经就绪 */
              };
/*        events和revents都是位图， */
/*        可选选项如下表； */
/*        如果struct pollfd结构体对象内的fd设置为-1， */
/*        那么poll()会跳过这个结构体对象 */
/*     nfds: */
/*         fds对应数组的大小 */
/*     timeout: */
/*         等待时间，单位为ms； */
/*         传0，表示非阻塞等待； */
/*         传-1，表示阻塞等待； */
/* 返回值: */
/*     n>0，表示有n个关心的fd对应关心的事件就绪了 */
/*     n=0，超时了 */
/*     n<0，表示出错，并设置errno */
```

下面是一张POLL事件标志位表，每一个事件在events/revents内对应二进制的某一位：

| 事件 | 描述 | 是否可作为输入 | 是否可作为输出 |
| --- | --- | --- | --- |
| POLLIN | 数据（包括普通数据和优先数据）可读 | 是 | 是 |
| POLLRDNORM | 普通数据可读 | 是 | 是 |
| POLLRDBAND | 优先级带数据可读（Linux 不支持） | 是 | 是 |
| POLLPRI | 高优先级数据可读，比如 TCP 带外数据 | 是 | 是 |
| POLLOUT | 数据（包括普通数据和优先数据）可写 | 是 | 是 |
| POLLWRNORM | 普通数据可写 | 是 | 是 |
| POLLWRBAND | 优先级带数据可写 | 是 | 是 |
| POLLRDHUP | TCP 连接被对方关闭，或者对方关闭了写操作。它由 GNU 引入 | 是 | 是 |
| POLLERR | 错误 | 否 | 是 |
| POLLHUP | 挂起。比如管道的写端被关闭后，读端描述符上将收到 POLLHUP 事件 | 否 | 是 |
| POLLNVAL | 文件描述符没有打开 | 否 | 是 |


### 1.2. 通过poll实现的一个简单tcp服务器demo

```cpp
#include <cerrno>
#include <csignal>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <unistd.h>
#include <fcntl.h>

#include <sys/poll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>

#include <iostream>
#include <string>
#include <vector>
#include <algorithm>

//响应
const std::string response=
    "HTTP/1.1 302 Found\r\n"
    "Location: https://ys-api.mihoyo.com/event/download_porter/link/ys_cn/official/pc_default\r\n"
    "Content-Type: text/html;charset=utf-8\r\n"
    "Content-Length: 0\r\n"
    "\r\n";

class Utils
{
public:
    static bool setNoBlock(int fd)
    {
        //取出状态位图
        int statusFlags=fcntl(fd,F_GETFL);
        if(statusFlags<0)
        {
            //errno是线程安全的，每个线程各有一个
            perror("[ERROR]fcntl()F_GETFL 失败");
            return false;
        }

        //设置非阻塞
        if(fcntl(fd,F_SETFL,statusFlags | O_NONBLOCK)<0)
        {
            perror("[ERROR]fcntl(),cmd=F_SETFL,设置 O_NONBLOCK 失败");
            return false;
        }
        return true;
    }

};



class TcpServer
{
public:
    TcpServer(const std::string& ip = "0.0.0.0", uint16_t port = 8888, int backlog = 5,int timeout=60000)
        : _ip(ip),
          _port(port),
          _backlog(backlog),
          _serverfd(-1),
          _fds(0),
          _timeout(timeout)
    {
    }

    ~TcpServer()
    {
        stop();
    }

    // 创建套接字、开启地址复用、绑定、开始监听
    bool listen()
    {
        //忽略因 读端关闭，写端继续写入 而收到的SIGPIPE信号
        signal(SIGPIPE, SIG_IGN);

        //创建套接字
        _serverfd = socket(AF_INET, SOCK_STREAM, 0);
        if (_serverfd < 0)
        {
            perror("[ERROR]socket()");
            return false;
        }

        //开启地址复用
        int reuse = 1;
        if (setsockopt(_serverfd, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse)) < 0)
        {
            perror("[ERROR]setsockopt()");
            close(_serverfd);
            _serverfd = -1;
            return false;
        }

        //绑定地址端口
        struct sockaddr_in addr;
        memset(&addr,0, sizeof(addr));
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

        //设置非阻塞
        if(Utils::setNoBlock(_serverfd)==false)
        {
            close(_serverfd);
            _serverfd=-1;
            return false;
        }

        std::cout << "[DEBUG]开始监听,serverfd=" << _serverfd << std::endl;

        //服务器监听套接字加入pollfd数组
        _fds.push_back({_serverfd,POLLIN,0});

        return true;
    }

    // poll 事件循环
    void run()
    {
        if (_serverfd < 0)
        {
            std::cerr << "[error]请先调用 listen()" << std::endl;
            return;
        }

        while (1)
        {
            std::cout << "[DEBUG]进行poll等待,等待的fd个数:"<<_fds.size()<< std::endl;
            int n = poll(_fds.data(),_fds.size(),_timeout);
            std::cout << "[DEBUG]poll触发,返回值=" << n << std::endl;

            //有事件就绪
            if (n > 0)
            {
                //客户端套接字区间
                for(auto it=_fds.begin()+1;it!=_fds.end();)
                {
                    //通信通道对端已经关闭 ||
                    //fd 不是一个有效的、已经打开的文件描述符 ||
                    //或者出现错误
                    if(it->revents & (POLLHUP | POLLNVAL | POLLERR))
                    {
                        close(it->fd);
                        it->fd=-1;
                        it=_fds.erase(it);
                        continue;
                    }
                    //读事件就绪
                    else if(it->revents & POLLIN)
                    {
                        std::string out;
                        if(false == read(it->fd,out))
                        {
                            close(it->fd);
                            it->fd=-1;
                            it=_fds.erase(it);
                            continue;
                        }

                        if(false == write(it->fd,response))
                        {
                            close(it->fd);
                            it->fd=-1;
                            it=_fds.erase(it);
                            continue;
                        }

                        ++it;
                    }
                    else ++it;
                }


                //服务器监听套接字异常
                if(_fds[0].revents & (POLLNVAL | POLLERR))
                {
                    stop();
                    break;
                }
                //判断服务器套接字读事件是否就绪，不能放在判断客户端是否有事件就绪前面，因为pollfd数组会扩容
                else if(_fds[0].revents & POLLIN)
                {
                    if(accept()==false)
                    {
                        break;
                    }
                }
            }
            else if(0 == n)//超时
            {
                std::cout << "[INFO]poll超时" << std::endl;
            }
            else//poll异常
            {
                //errno是线程安全的，每个线程各有一个
                if(EINTR != errno)
                {
                    perror("[ERROR]poll()");
                    break;
                }
            }
        }
    }

private:

    //获取一个/多个新连接
    bool accept()
    {
        while(true)
        {
            sockaddr_in clientAddr;
            memset(&clientAddr,0,sizeof(clientAddr));
            socklen_t clientAddrLen = sizeof(clientAddr);
            int clientfd = ::accept(_serverfd, (sockaddr*)&clientAddr, &clientAddrLen);
            if (clientfd < 0)
            {
                //资源未就绪
                if(EAGAIN == errno ||
                   EWOULDBLOCK == errno)
                {
                    break;
                }
                //被信号打断，重试
                else if(EINTR == errno)
                {
                    continue;
                }
                else
                {
                    std::cerr << "[ERROR]"
                              << "获取新连接失败" << std::endl;
                    return false;
                }
            }

            char clientIp[16]={0};
            uint16_t clientPort = ntohs(clientAddr.sin_port);
            if (inet_ntop(AF_INET, &(clientAddr.sin_addr), clientIp, sizeof(clientIp)) == NULL)
            {
                std::cerr << "[WARNING]"
                          << "解析客户端ip地址失败"
                          << "clientfd=" << clientfd
                          << std::endl;
            }
            else {
                clientIp[15] = '\0';
                std::cout << "[INFO]获取新连接,clientfd=" << clientfd << ","
                        << "IP地址->" << clientIp << ":" << clientPort
                        << std::endl;
            }


            //客户端套接字设置为非阻塞
            if(Utils::setNoBlock(clientfd)==false)
            {
                close(clientfd);
                clientfd=-1;

                continue;
            }

            //将客户端套接字加入到pollfd数组内
            _fds.push_back({clientfd,POLLIN,0});


        }
        return true;
    }

    //从fd内读数据到out
    bool read(int fd,std::string &out)
    {
        //简单实现一下，不处理面向字节流导致的 read()读的不是一个完整报文的问题
        //要实现的话根据具体的应用层协议去read()收集报文数据并解析就可以了，
        //解析成功就从用户缓冲区移除，否则留在里面
        const int BUFF_CAPACITY=65535;

        char buff[BUFF_CAPACITY];
        size_t buffSize=0;
        while(true)
        {
            //这里会有因buff满了，然后期望读出字节数变为0，再然后read()返回0，导致误认为客户端已下线的问题
            //简单实现先不管
            ssize_t readN = ::read(fd, (char*)(buff)+buffSize, sizeof(buff)-buffSize);

            if (0 == readN)
            {
                std::cout << "[INFO]客户端下线,clientfd=" << fd << std::endl;
                return false;
            }
            else if (0 > readN)
            {
                //read没数据读了(资源未就绪) ||
                //操作会阻塞(read没数据读了->资源未就绪) ||
                if(EAGAIN == errno ||
                   EWOULDBLOCK == errno)
                {
                    //简单处理一下
                    break;
                }
                //被信号打断
                else if(EINTR == errno)
                {
                    continue;
                }
                else {
                    perror("[ERROR]read()");
                    return false;
                }

            }
            else
            {
                buffSize += readN;
            }
        }

        buff[std::min(buffSize,(size_t)BUFF_CAPACITY-1)] = '\0';
        std::cout << "[INFO]收到客户端内容:" << std::endl << buff << std::endl;
        out=buff;
        return true;
    }

    //向fd内写数据
    bool write(int fd,std::string const &in)
    {
        size_t sz=in.size();
        size_t cnt=0;//已经通过write()写入的字节数
        while(cnt<sz)
        {
            ssize_t n=::write(fd,&(in[cnt]),sz-cnt);
            if(0 > n)
            {

                //write缓冲区满了 ||
                //write操作会阻塞(write缓冲区满了)
                if(EAGAIN == errno ||
                   EWOULDBLOCK == errno)
                {
                    //这里其实这种处理方式更好:记录未发完的报文部分，然后关注POLLOUT事件，等下一次就绪再发
                    //简单实现就先粗暴处理了
                    perror("[WARNING]write()");
                    return false;
                }
                //被信号打断
                else if(EINTR == errno)
                {
                    continue;
                }
                else
                {
                    perror("[ERROR]write()");
                    return false;
                }
            }
            else if(0 == n)
            {
                return false;
            }
            else
            {
                //统计写入了多少字节
                cnt += n;
            }
        }
        return true;
    }

    void stop()
    {
        for (auto &fd : _fds)
        {
            if(fd.fd>=0)
            {
                close(fd.fd);
                if(fd.fd == _serverfd) _serverfd=-1;
                fd.fd=-1;
            }
        }
        _fds.clear();
    }



private:

    //服务器ip
    std::string _ip;

    //服务器port
    uint16_t _port;

    //tcp全连接队列长度
    int _backlog;

    //服务器监听套接字
    int _serverfd;

    //pollfd数组,服务器监听套接字为fds[0],其余为客户端
    std::vector<struct pollfd> _fds;

    //poll超时时间
    int _timeout=60000;
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

## 2. poll的优缺点

**优点**：

1. 相较于select()，poll()可以**等待的fd的数量是无限的**（或者是**受限于硬件**）
2. 相较于select()，每次调用时**不需要重新设置关心哪些fd的哪些事件**

**缺点**：

1. 依旧有**内核态用户态的双向拷贝**
2. **依旧需要遍历**（假如数组内有10000个fd呢？**降低效率**）；在用户层，需要**自己使用数组管理所有合法的fd，才能让poll()进行等待所有的合法fd，用户层会需要遍历很多次；在内核层，检测fd事件是否就绪，也需要遍历传入的数组**

