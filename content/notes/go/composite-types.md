---
title: "Go 语法基础2：复合类型"
date: 2026-06-10
draft: true
categories: ["go"]
tags: ["数组", "slice", "map", "struct"]
type: "note"
weight: 20
description: "介绍 Go 普通数组、slice、map 与 struct 的声明、初始化及常用操作。"
---

读前注意：
1. 其实go**所有函数传参都是值类型**，然后slice,map这些类型内**有指向数据的指针**，假设s1和s2两个slice对象指向同一块内存，然后s1在函数体内，s2在函数体外，**对s1指向内存的修改可能会影响到s2**，所以才形象地说slice,map是引用类型,其函数传参为引用传参


## 1.数组和切片(slice)
![](/images/notes/go/composite-types/1.jpg)
### 1.1.数组---值类型
1. go的数组是**定长**的，未主动初始化的元素会进行空初始化，声明方式如下
```go
var arr1 [5]int
var arr2 [5]int=[5]int{1,2,3}
var arr3 = [5]int{1,2}
arr4 := [5]int{1,2,3,4}
``` 
2. go的数组是**值类型**的，函数传参时是**值拷贝**
```go
func printArray(myArray [5]int) {
    //数组是值类型,因此修改myArray不会影响原数组
    for index, value := range myArray {
        fmt.Println("index=", index, "value=", value)
    }
}

func main() {
    	var arr1 [5]int
    	printArray(arr1)
    	var arr2 [5]int=[5]int{1,2,3}
    	printArray(arr2)	
    	var arr3 = [5]int{1,2}
    	printArray(arr3)
    	arr4 := [5]int{1,2,3,4}
    	printArray(arr4)

	fmt.Printf("arr1 type is %T\n", arr1)
	fmt.Printf("arr2 type is %T\n", arr2)
	fmt.Printf("arr3 type is %T\n", arr3)
	fmt.Printf("arr4 type is %T\n", arr4)
}

//运行结果：
index= 0 value= 0
index= 1 value= 0
index= 2 value= 0
index= 3 value= 0
index= 4 value= 0
index= 0 value= 1
index= 1 value= 2
index= 2 value= 3
index= 3 value= 0
index= 4 value= 0
index= 0 value= 1
index= 1 value= 2
index= 2 value= 0
index= 3 value= 0
index= 4 value= 0
index= 0 value= 1
index= 1 value= 2
index= 2 value= 3
index= 3 value= 4
index= 4 value= 0
arr1 type is [5]int
arr2 type is [5]int
arr3 type is [5]int
arr4 type is [5]int
```

### 1.2.切片slice---引用类型
#### 1.2.1.slice基础
1. 切片是**不定长的**，声明方式如下
![](/images/notes/go/composite-types/2.jpg)
```go
var slice1 []int
var slice2 []int=[]int{1,2,3}
var slice3 = []int{1,2}
slice4 := []int{1,2,3,4}
//[]int表示创建 slice类型,5表示该slice的初始化大小
slice5 := make([]int, 5) 
//[]int表示创建 slice类型,5表示该slice的初始化大小,10表示该slice初始化容量
slice6 := make([]int, 5, 10) 
```

2. 切片本质上是数组的一个视图，因此是**引用类型**的，函数传参时为**引用传参**
```go
func printSlice(mySlice []int) {
    //slice函数传参为引用类型,修改mySlice会影响外面
    for i:=0;i<len(mySlice);i++ {
        fmt.Println("mySlice[",i,"]=", mySlice[i])
    }
    fmt.Printf("mySlice type is %T\n", mySlice)
}

func main() {
    var slice1 []int
    var slice2 []int=[]int{1,2,3}
    var slice3 = []int{1,2}
    slice4 := []int{1,2,3,4}
    slice5 := make([]int, 5)
    slice6 := make([]int, 5, 10)
    slice7 := slice2[1:3] //取值范围为slice2[1,3)
    printSlice(slice1)
    printSlice(slice2)
    printSlice(slice3)
    printSlice(slice4)
    printSlice(slice5)
    printSlice(slice6)
    printSlice(slice7)
}
//运行结果:
mySlice type is []int
mySlice[ 0 ]= 1
mySlice[ 1 ]= 2
mySlice[ 2 ]= 3
mySlice type is []int
mySlice[ 0 ]= 1
mySlice[ 1 ]= 2
mySlice type is []int
mySlice[ 0 ]= 1
mySlice[ 1 ]= 2
mySlice[ 2 ]= 3
mySlice[ 3 ]= 4
mySlice type is []int
mySlice[ 0 ]= 0
mySlice[ 1 ]= 0
mySlice[ 2 ]= 0
mySlice[ 3 ]= 0
mySlice[ 4 ]= 0
mySlice type is []int
mySlice[ 0 ]= 0
mySlice[ 1 ]= 0
mySlice[ 2 ]= 0
mySlice[ 3 ]= 0
mySlice[ 4 ]= 0
mySlice type is []int
mySlice[ 0 ]= 2
mySlice[ 1 ]= 3
mySlice type is []int
```

3. slice类型变量可以**直接和nil进行判断是否为空**
```go
if slice2==nil {
    fmt.Println("slice2 is nil")
} else {
    fmt.Println("slice2 is not nil")
}
```
4. slice扩容是以2倍进行扩容
5. slice是引用类型（视图类型）
    - 如果s2=s1[0,2]，那么在**s2不扩容的情况下**修改s2会影响s1；
    - 如果s2=s1[0,2]，并且**后续s2发生了扩容**，那么此时修改s2不影响s1
    - 如果**copy(s2,s1)**,那么修改s2不会影响s1
```go
slice3 := slice2[0:4]
fmt.Printf("len= %d ,cap= %d, slice2=%v\n", len(slice2), cap(slice2), slice2)
fmt.Printf("len= %d ,cap= %d, slice3=%v\n", len(slice3), cap(slice3), slice3)
slice3=append(slice3, 100,200,300)
fmt.Printf("len= %d ,cap= %d, slice2=%v\n", len(slice2), cap(slice2), slice2)
fmt.Printf("len= %d ,cap= %d, slice3=%v\n", len(slice3), cap(slice3), slice3)

//运行结果:
len= 5 ,cap= 7, slice2=[100 0 0 1 2]
len= 4 ,cap= 7, slice3=[100 0 0 1]
len= 5 ,cap= 7, slice2=[100 0 0 1 100]  //为什么sclie2结果是这个
len= 7 ,cap= 7, slice3=[100 0 0 1 100 200 300] //为什么slice3结果是这个
```

#### 1.2.2.slice方法
1. len()--求slice的len
2. cap()---求slice的capacity
3. append()---追加元素
```go
slice1 := make([]int, 3,5)
fmt.Printf("len= %d ,cap= %d, slice1=%v\n", len(slice1), cap(slice1), slice1)

slice1 = append(slice1, 1,2,3)
fmt.Printf("len= %d ,cap= %d, slice1=%v\n", len(slice1), cap(slice1), slice1)

slice1 = append(slice1, 4,5,6)
fmt.Printf("len= %d ,cap= %d, slice1=%v\n", len(slice1), cap(slice1), slice1)

slice1 = append(slice1, 7,8,9)
fmt.Printf("len= %d ,cap= %d, slice1=%v\n", len(slice1), cap(slice1), slice1)

//运行结果：
len= 3 ,cap= 5, slice1=[0 0 0]
len= 6 ,cap= 10, slice1=[0 0 0 1 2 3]
len= 9 ,cap= 10, slice1=[0 0 0 1 2 3 4 5 6]
len= 12 ,cap= 20, slice1=[0 0 0 1 2 3 4 5 6 7 8 9]
```
4. 切片截取[begin:end]---取值的下标范围为[begin,end) 
5. copy(des,src)---对slice进行深拷贝
    - copy()是进行**深拷贝**，且拷贝范围**不会超过des的大小**
```go
slice2 := make([]int, 5,7)
copy(slice2,slice1)
fmt.Printf("len= %d ,cap= %d, slice1=%v\n", len(slice1), cap(slice1), slice1)
fmt.Printf("len= %d ,cap= %d, slice2=%v\n", len(slice2), cap(slice2), slice2)

fmt.Println("----")

slice2[0]=100
fmt.Printf("len= %d ,cap= %d, slice1=%v\n", len(slice1), cap(slice1), slice1)
fmt.Printf("len= %d ,cap= %d, slice2=%v\n", len(slice2), cap(slice2), slice2)

//运行结果：
len= 12 ,cap= 20, slice1=[0 0 0 1 2 3 4 5 6 7 8 9]
len= 5 ,cap= 7, slice2=[0 0 0 1 2]
----
len= 12 ,cap= 20, slice1=[0 0 0 1 2 3 4 5 6 7 8 9]
len= 5 ,cap= 7, slice2=[100 0 0 1 2]
```


## 2.哈希
1. map的声明方式如下
```go
//第一种
var map1 map[k]v; //此时map1=nil
map1=make(map[k]v,cap);//cap是指map1有多少容量

//第二种
map2 := make(map[k]v,cap); 

//第三种
map2 := map[string]int{
    "a": 1,
    "b": 2,
    "c": 3,
    }
```

2. map是**引用类型**的，下面是使用例子
```go
func printMap(cityMap map[string]string) {
    for key,value := range cityMap {
        fmt.Println("key=", key, "value=", value)
    }
}

func changeMap(cityMap map[string]string,key string,value string) {
    //map是引用类型
    cityMap[key] = value
}

func main() {
    var map1 map[string]int
    if nil == map1{
        fmt.Println("map1 is nil")
    }

    map1 = make(map[string]int,10)
    map2 := map[string]int{
        "a": 1,
        "b": 2,
        "c": 3,
    }
    fmt.Println(map2)

    cityMap := make(map[string]string)

    //添加
    changeMap(cityMap, "China", "Beijing")
    fmt.Println("len = %d", len(cityMap))//map不能使用cap()
    changeMap(cityMap, "Japan", "Tokyo")
    changeMap(cityMap, "USA", "New York")
    printMap(cityMap)
    
    //删除
    delete(cityMap, "Japan")
    printMap(cityMap)
    
    //修改
    changeMap(cityMap, "China", "Shanghai")
    printMap(cityMap)
}
```


## 3.struct
1. struct是**值类型**,语法使用如下
2. type用于**定义新类型**或者给**已有类型取别名**
```go
下面是相应的代码示例：
type myInt int


type Book struct {
    Title string
    Author string
    Price float64
}

func printBook(book Book) {
    //struct是值类型，想要修改struct需要传指针
    fmt.Println(book)
    fmt.Printf("book type is %T\n", book)
}

func changeBook(book *Book) {
    book.Title = "Go Programming"
    book.Author = "John Doe"
    book.Price = 19.99
}

func main() {
    var a myInt
    a = 10
    fmt.Printf("a type is %T\n", a)

        var book1 Book
    printBook(book1)
    changeBook(&book1)
    printBook(book1)
}

//运行结果:
a type is main.myInt
{  0}
book type is main.Book
{Go Programming John Doe 19.99}
book type is main.Book
```

3. 如果需要给struct绑定方法，方式如下：
```go
type Person struct {
    Name string
    Age int    //在包外可见,因为首字母大写
    sex string //在包外不可见,因为首字母小写
}

//方法名前的(p Person)和(p *Person)表示这个方法是绑定到Person内的
//写(p Person)时,是值传递,p是调用该方法对象的拷贝
//(p Person)是值传递会不会因为struct Person是值类型导致的？？？
func (p Person) Show() {
    fmt.Println("Name=", p.Name, "Age=", p.Age, "Sex=", p.Sex)
}

//写(p *Person)时,是指针传递,修改p可以影响调用该方法的对象
func (p *Person) SetName(name string) {
    (*p).Name = name
}
```
