---
title: "HTTP原理（应用层）"
description: "记录HTTP的url与urlencode/urldecode、request/response报文结构、请求方式、状态码与Cookie/Session"
date: "2026-09-16"
draft: false
type: "note"
weight: 10
categories:
  - "network"
tags:
  - "网络"
---

其实写的tcp服务器已经可以通过浏览器访问了，只是没有按照http报文格式响应；

如果按照http报文的格式响应（本质是**先组织好响应行，响应报头，空行，响应报文，再序列化成字符串，再发送给客户端即可**），那么即可实现很多功能；

例如向客户端设置cookie、向客户端发送图片、重定向到其他url，等等……

## 1. url、urlencode和urldecode

**url**：统一资源定位符，平时俗称的"网址"其实说的就是url；

url的结构（以 `http://user:pass@www.example.jp:80/dir/index.htm?uid=1#ch1` 为例）：

| 组成部分 | 示例 |
| --- | --- |
| 协议方案名 | http |
| 登录信息（认证） | user:pass |
| 服务器地址 | www.example.jp |
| 服务器端口号 | 80 |
| 带层次的文件路径 | /dir/index.htm |
| 查询字符串 | uid=1 |
| 片段标识符 | ch1 |

**urlencode**：有一些特殊字符是被占用的（例如 `?`、`/`、`&`、`:`），这些字符已经被url当做特殊意义理解了，不能随意出现；当某个参数中需要带有这些特殊字符时，必须先对特殊字符进行转义，即当用户**输入特殊字符**时会被编码成**%XY**；

转义规则：将需要转码的字符转为16进制，然后从右到左，取4位（不足4位直接处理），每2位做一位，前面加上 `%`，编码成 `%XY` 格式；

**urldecode**：将%XY解码成原来的字符。

## 2. HTTP request和response

参考：[HTTP 消息结构 | 菜鸟教程](https://www.runoob.com/http/http-messages.html)

### 2.1. request——请求行、请求报头(常出现的key:value\r\n)、空行、请求正文

![HTTP request 报文结构：请求行、请求报头、空行与请求正文](/images/notes/network/application-layer/http/image-002.svg)

一个http request最多会包含如下内容：

1. **请求行**：格式：**请求方式(GET,POST,...) URL(以web根目录开始的路径+GET提交的内容(eg:?key1=value&key2=value2&...)+...) HTTPversion\r\n**
2. **请求报头**：单行或者多行**key:value\r\n**

   常出现的key（[HTTP 响应头信息 | 菜鸟教程](https://www.runoob.com/http/http-header-fields.html)）：

   - **Content-Length**：正文的长度
   - **User-Agent**：客户端的机器信息（用于反爬，个性化推荐）
   - **Connection**：管理连接的选项，如keep-alive或close，keep-alive表示连接不会在传输后关闭，即**长连接**（长连接就是处理完一批http请求才释放tcp连接，短连接就是处理完一个http请求就释放连接）
   - **Host**：表明请求的ip:port
   - **Cookie**：客户端存储的会话信息（与登录相关的信息）（Cookie可能是**内存级Cookie**或**文件级Cookie**）；如果服务器向客户端设置了cookie，那么每次客户端的请求报文都会自动带上Cookie字段及其保存的key-value信息
   - **Referer**：告诉服务器，当前请求是从哪个页面跳转而来
   - **Accept**：客户端可接收的响应数据格式
3. **空行**：\r\n
4. **请求正文**

注意：发送和接收时其实**都是一个长字符串**，要经过序列化反序列化（`read()/recv()`直接读取不一定会读到一个完整的报文，需要做处理）

### 2.2. response——状态行、响应报头(常出现的key:value\r\n)、空行、响应正文

![HTTP response 报文结构：状态行、响应报头、空行与响应正文](/images/notes/network/application-layer/http/image-004.svg)

一个http response最多会包含如下内容：

1. **状态行（响应行）**：格式：**HTTPversion 状态码 状态码描述\r\n**
2. **响应报头**：单行或者多行**key:value\r\n**

   常出现的key（[HTTP 响应头信息 | 菜鸟教程](https://www.runoob.com/http/http-header-fields.html)）：

   - **Content-Length**：正文的长度
   - **Content-Type**：响应正文的类型（文本，图片，等等……），详情见[HTTP content-type | 菜鸟教程](https://www.runoob.com/http/http-content-type.html)
   - **Location**：重定向url，客户端浏览器会自动跳转到这个url，一般与3XX状态码配合使用
   - **Set-Cookie**：设置客户端的cookie；不写Expires/Max-Age就是内存级Cookie（见2.1），写了才落盘成为文件级Cookie，两者同时出现时Max-Age优先。例如：sessionid=abc123; Path=/; HttpOnly; Secure; SameSite=Lax
   - **Cache-Control**：告知客户端如何缓存响应数据
3. **空行**：\r\n
4. **响应正文**

注意：发送和接收时其实**都是一个长字符串**，要经过序列化反序列化（`read()/recv()`直接读取不一定会读到一个完整的报文，需要做处理）

## 3. 请求方式

**最常用的两种方式（占95%）**：

1. **GET方式（95%中占80%）**：可以获取所有类型的数据，提交的数据**会出现在URL中**
2. **POST方式（95%中占20%）**：提交的数据**会出现在请求正文中**

**请求方式大全**：[HTTP 请求方法 | 菜鸟教程](https://www.runoob.com/http/http-methods.html)

## 4. 状态码

|  | 类别 | 原因短语 |
| --- | --- | --- |
| 1XX | Informational（信息性状态码） | 接收的请求正在处理 |
| 2XX | Success（成功状态码） | 请求正常处理完毕 |
| 3XX | Redirection（重定向状态码） | 需要进行附加操作以完成请求 |
| 4XX | Client Error（客户端错误状态码） | 服务器无法处理请求 |
| 5XX | Server Error（服务器错误状态码） | 服务器处理请求出错 |

**常见状态码**：

| 状态码 | 含义 |
| --- | --- |
| 200 | OK：请求成功，服务器正常返回响应 |
| 301 | Moved Permanently：永久重定向，资源已永久移动到新 URL |
| 302 | Found：临时重定向，资源临时位于新 URL（配合 Location 使用） |
| 307 | Temporary Redirect：临时重定向，且不更改请求方法 |
| 403 | Forbidden：服务器拒绝执行请求（权限不足等） |
| 404 | Not Found：请求的资源不存在 |
| 502 | Bad Gateway：网关/代理从上游服务器收到无效响应 |
| 504 | Gateway Time-out：网关/代理等待上游服务器响应超时 |

**状态码大全**：[HTTP 状态码 | 菜鸟教程](https://www.runoob.com/http/http-status-codes.html)

## 5. Cookie与Session

![Session 与 Cookie 交互原理：浏览器提交账号密码，服务器创建会话并下发 sessionid，浏览器后续请求自动携带该 Cookie](/images/notes/network/application-layer/http/image-007.svg)

**原理**：

浏览器先把账号密码提交给服务器；

服务器**只在登录这一次**查数据库校验账号密码；

校验通过后，服务器生成一个随机、不可猜测的session id，把**会话状态**（至少包含用户标识，**不含密码**）以这个id为键存进服务端存储（内存、文件或Redis集群都可以）；

而这个会话存储的**键**，就是作为Cookie返回给客户端的那个值（`Set-Cookie: sessionid=XXXXXX`）；

当客户端带着Cookie来进行访问时，服务器是拿Cookie里的session id去**找对应的会话**，找到且未过期则可以直接访问资源；找不到或者已过期，则需要重新登录验证；

这样子做**即可避免用户信息（尤其是密码）以明文落在客户端**——客户端只拿到一个无意义的id；

但是**依旧无法避免客户端Cookie被劫持**——id一旦被窃取，照样能被冒用身份；

真实的实现里还会给这个Cookie加上HttpOnly、Secure、SameSite等属性，分别防XSS窃取、明文嗅探与CSRF（见2.2的Set-Cookie）；
