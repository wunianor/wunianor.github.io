---
title: "Go 语法基础"
date: 2026-06-09
draft: false
categories: ["go"]
tags: ["语法", "变量", "iota", "defer", "包"]
type: "note"
weight: 10
description: "梳理 Go 变量与常量、iota、函数语法、init、import 导包及 defer 等入门语法要点。"
---

## 1.声明变量

![声明变量](/images/notes/go/go-basics/1.jpg)

```go
//方式1:声明一个变量,默认值为0
var a int

//方式2:声明一个变量,初始化一个值
var b int=10

//方式3:初始化变量时省略类型
var c=20

//方式4:自动匹配
e := 100
```

## 2.const和iota

1. const:
    a. const 用于声明常量
2. iota
    a. iota只能用于在const ()内，在**第1有效行（即第1非空行）值为0**，在第2有效行值为1，以此类推
    b. 如果对于iota定义了表达式（例如iota*2,iota+1等等），在未新定义表达式之前，此表达式逻辑会一直执行；新定义表达式后则执行新的表达式逻辑

下面是使用例子：

```go
//声明const变量
const len = 100
//不能 const len:=100

//批量声明
const (
    AAA = 10
    BBB = 20
)

//iota只能在const()内使用,iota在第1行时值为0,第2行为1,以此类推
const (
    A = iota  //A=0
    B         //B=1 
    C         //C=2
)


const (
    AAA  =1    //AAA=1
    BBB =iota  //BBB=1
    CCC        //CCC=2
)

const ( AAA  =iota   //AAA=0
	
	BBB =iota    //BBB=1
	CCC          //CCC=2
)

const (
    a,b=iota+1,iota+2
    c,d
    e,f
    
    g,h=iota*2,iota*3
)


const ( 

	AAA  =iota *2   //0

	BBB,DDD =iota,iota*10   //1,10

	CCC,EEE    //2,20
)
```

![](/images/notes/go/go-basics/2.jpg)

## 3.函数

### 3.1.函数语法

1. go的函数支持**多返回值**
2. **有名返回值**是函数的形参，**进入函数体时就被空初始化**

```go
//下面四种返回值定义方式

//单返回值
func func1(a string ,b int) string {

	c := a+fmt.Sprintf("%d",b)
	return c
}

//多匿名返回值
func func2(a string ,b int) (string,int) {
	return a,b
}

//多有名返回值写法1
func func3(a string ,b int) (r1 string,r2 int) {
        fmt.Println("r1=", r1, "r2=", r2) //r1="" r2=0
	r1 = a
	r2 = b
	return
}

//多有名返回值写法2
func func4(a string ,b int) (r1,r2 int) {
	fmt.Println("r1=", r1, "r2=", r2) //r1=0 r2=0
	r1 = 10
	r2 = 20
	return r1,r2  //也可以写成return 
}
```

### 3.2.init函数

![](/images/notes/go/go-basics/3.jpg)

1. 每个包的init函数都会在main()函数之前执行

## 4.import导包，与包有关的语法

1. import导包有三种方式：匿名别名导包，别名导包，点导包

![](/images/notes/go/go-basics/4.jpg)

```go
//import _ "包路径/包名"
//匿名别名导包:这种方式导入只会执行包内的init()函数,无法使用当前包的方法
//eg:
import _ "lib1"
    
//import 别名 "包路径/包名"
//别名导包:这种方式导入,会执行包内的init()函数,使用方法需要通过 别名.方法名() 来调用
//eg:

import aa "fmt"
aa.PrintLn("aaa");
    
//import . "包路径/包名"
//点导包:这种方式导入,会执行包内的init()函数,可以直接通过 方法名() 来调用,
//      但是要注意多个包内有同名方法时都使用这种导包方式会有冲突
//eg:
import . "lib2"
Mul(3,4)  /Mul()为lib2内的方法
```

2. 在包中，**首字母大写方法/成员变量**为**包外可调用方法/成员变量**（即public）,**首字母小写方法/成员变量**为**包外不可调用方法/成员变量**（即praivate）；因此go的包可以理解为c++中的类

3. go **不支持循环引用导包**

## 5.defer

1. defer类似于C++的析构函数，**后写的defer语句先执行**

![defer](/images/notes/go/go-basics/5.jpg)

```go
package main

import "fmt"

func main() {
	fmt.Println("main start")
    	defer fmt.Println("defer 1")
    	defer fmt.Println("defer 2")
    	defer fmt.Println("defer 3")
	fmt.Println("main end")
}

//运行结果：
main start
main end
defer 3
defer 2
defer 1

```

2. **return语句会比defer语句先执行**，表明defer语句在函数体最后才执行，这也更表明defer和C++的析构很像

```go
func returnFunc() int {
	fmt.Println("returnFunc()")
	return 10
}

func returnAndDefer() int {
	defer func() {
		fmt.Println("deferFunc()")
	}()
	return returnFunc()
}

func main() {
	returnAndDefer()
}

//运行结果:
returnFunc()
deferFunc()

```
