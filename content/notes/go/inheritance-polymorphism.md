---
title: "Go 语法基础3：继承和多态"
date: 2026-06-12
draft: false
categories: ["go"]
tags: ["继承", "多态", "interface"]
type: "note"
weight: 30
description: "介绍 Go 的继承机制与 interface 实现的多态机制。"
---

读前注意：
1. 其实go**所有函数传参都是值类型**，然后slice,map这些类型内**有指向数据的指针**，假设s1和s2两个slice对象指向同一块内存，然后s1在函数体内，s2在函数体外，**对s1指向内存的修改可能会影响到s2**，所以才形象地说slice,map是引用类型，其函数传参为引用传参

## 1.继承
![](/images/notes/go/inheritance-polymorphism/1.jpg)
1. go中的继承也叫**结构体嵌入**
2. go中**子类继承父类**有两种方式,**在子类中写上`父类类名`(值嵌入)** 或者 **在子类中写上`*父类类名`(指针嵌入)**
    - 值嵌入和指针嵌入的区别:
        - 值嵌入是子类中**包含一个完整的父类对象**；指针嵌入是子类中只**包含一个父类对象指针**
        - 值嵌入在子类对象拷贝时会进行**深拷贝**；指针嵌入在子类对象拷贝时只会**浅拷贝指针的值**，即指向是**同一个父类对象**
3. 子类对象初始化方式如下
```go
type People struct {
    Name string
    Sex string
    Age int
}

func (p *People) show() {
    fmt.Println("(people)Name=", p.Name, "Sex=", p.Sex, "Age=", p.Age)
}

func (p *People) eat() {
    fmt.Println("(people)eat")
}


type Student struct {
    People	//继承People结构体
    Score int
}

//重写父类方法
func (s *Student) show() {
    fmt.Println("(student)Name=", s.Name, "Sex=", s.Sex, "Age=", s.Age, "Score=", s.Score)
}

//子类新方法
func (s *Student) goSchool() {
    fmt.Println("(student)goSchool")
}

func main() {
    people := People{Name: "John", Sex: "Male", Age: 20}
    people.show()//父类方法
    people.eat()//父类方法
    
    //初始化方式1
    student1 := Student{People{Name: "lisi", Sex: "Male", Age: 18}, 95}
    student1.show()//子类方法
    student1.goSchool()//子类方法
    student1.eat()//父类方法
    
    //初始化方式2
    var student2 Student
    student2.Name = "wangwu"
    student2.Sex = "Female"
    student2.Age = 20
    student2.Score = 90
    student2.show()//子类方法
    student2.goSchool()//子类方法
    student2.eat()//父类方法
}
```



## 2.多态
### 2.1.普通多态
![](/images/notes/go/inheritance-polymorphism/2.jpg)
1. go的多态是通过定义一个interface类型，然后具体类型**实现这个interface内的所有方法**来实现多态的；可以把interface类型理解为父类指针，实现了这个interface的所有方法的具体类型是其子类
2. 使用interface类型进行函数传参，是指针/引用方式传参,因为**interface本质是个指针**
```go
//interface类型本质是一个指针
type Animal interface {
    GetColor() string
    SetColor(color string)
    Sleep()
}

//如果类实现了接口中所有的方法，则称该类实现了该接口,Animal类型可以指向Cat类和Dog类
//下面的Cat类和Dog类都实现了Animal接口
type Cat struct {
    Color string
}
func (c *Cat) GetColor() string {
    return c.Color
}
func (c *Cat) SetColor(color string) {
    c.Color = color
}
func (c *Cat) Sleep() {
    fmt.Println("Cat is sleeping")
}

type Dog struct {
    Color string
}
func (d *Dog) GetColor() string {
    return d.Color
}
func (d *Dog) SetColor(color string) {
    d.Color = color
}
func (d *Dog) Sleep() {
    fmt.Println("Dog is sleeping")
}

type Person struct {
    Name string
    Animal Animal
}
func (p *Person) BuyAnimal(animal Animal) {
    p.Animal = animal
}
func (p *Person) ShowAnimal() {
    fmt.Println("Person is buying", p.Animal.GetColor())
}

func showAnimal(animal Animal) {
    fmt.Println("Animal color is", animal.GetColor())	
    //修改animal的color
    animal.SetColor("Red")
    fmt.Println("Animal color is", animal.GetColor())
}
// func (p *Person) GetColor() string {
// 	return "Person"
// }
// func (p *Person) Sleep() {
// 	fmt.Println("Person is sleeping")
// }

func main() {
    var animal Animal 
    animal = &Cat{Color: "Black"} //需要传指针给animal类型
    animal.Sleep()
    showAnimal(animal)
    fmt.Println("Animal color is", animal.GetColor())
    fmt.Println("----")
    animal = &Dog{Color: "White"}
    animal.Sleep()
    showAnimal(animal)
    fmt.Println("Animal color is", animal.GetColor())

    //Person类型没有实现Animal接口,下面这句会报错
    //animal = &Person{Name: "John", Animal: &Cat{Color: "Black"}}
}
```

### 2.2.interface{}与类型断言
![](/images/notes/go/inheritance-polymorphism/3.jpg)
1. go中**所有的结构体都实现了interface{}**，interface{}相当于一个万能类型
2. 可以使用 `value,ok := 变量.(类型)` 来断言变量的类型
```go
func show(v interface{}) {
    fmt.Println("v=", v)
    value,ok :=v.(int)
    if ok {
        v=200
        fmt.Println("value=", value)
    } else {
        fmt.Printf("value is not int,type is %T\n", v)
    }
}

func main() {
    var animal Animal 
    animal = &Cat{Color: "Black"}
    num := 100
    show(num)
    fmt.Println("num=", num)
    show("hello")
    show(3.14)
    show(true)
    show(animal)
}

//
v= 100
value= 100
num= 100
v= hello
value is not int,type is string
v= 3.14
value is not int,type is float64
v= true
value is not int,type is bool
v= &{Black}
value is not int,type is *main.Cat
```