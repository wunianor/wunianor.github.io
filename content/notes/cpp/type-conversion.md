---
title: "类型转换"
description: "包含C隐式与显式转换、static_cast、reinterpret_cast、const_cast（含volatile与常量折叠）、dynamic_cast、RTTI"
date: 2026-09-14
draft: false
type: "note"
weight: 20
categories:
  - "cpp"
tags:
  - "类型转换"
  - "RTTI"
---

## 1. C 语言类型转换

C 支持隐式类型转换和显式类型转换。在 C 语言中，如果赋值运算符左右两侧类型不同，或者形参与实参类型不匹配，或者返回值类型与接收返回值类型不一致时，就需要发生类型转换。

1. **隐式类型转换**：编译器在编译阶段自动进行，能转就转，不能转就编译失败。
2. **显式类型转换**：需要用户自己处理。

```cpp
void Test()
{
	int i = 1;
	// 隐式类型转换
	double d = i;
	printf("%d, %.2f\n", i, d);

	int* p = &i;
	// 显示的强制类型转换
	int address = (int)p;

	printf("%x, %d\n", p, address);
}
```

C 风格转换的缺陷：转换的可视性比较差，所有的转换形式都是以一种相同形式书写，难以跟踪错误的转换。

## 2. C++ 强制类型转换

### 2.1. 为什么 C++ 需要四种类型转换

C 风格的转换格式很简单，但是有不少缺点：

1. 隐式类型转换有些情况下可能会出问题：比如数据精度丢失。
2. 显式类型转换将所有情况混合在一起，代码不够清晰。

因此 C++ 提出了自己的类型转换风格。注意：因为 C++ 要兼容 C 语言，所以 C++ 中还可以使用 C 语言的转换风格。

标准 C++ 为了加强类型转换的可视性，引入了四种命名的强制类型转换操作符：`static_cast`、`reinterpret_cast`、`const_cast`、`dynamic_cast`。这四个的作用就是在类型转换时明确地写出来，方便查看，增强代码可读性，而不是像隐式类型转换一样偷偷就转了，避免意外错误。

下面这段代码就会有因为隐式类型转换导致的错误：

```cpp
void insert(size_t pos, char ch)
{
	int end = 10;
	while (end >= pos)
	{
		cout << end << endl;
		--end;
	}
}
```

可以分析一下哪里会导致错误？

<details class="answer-box">
<summary>点我显示答案</summary>

**分析**：`end` 是 `int`，`pos` 是 `size_t`。比较 `end >= pos` 时，`end` 会被隐式转换为 `size_t`；当 `--end` 使 `end` 变为 `-1` 后，`-1` 被解释为一个非常大的无符号数，条件恒为真，循环无法结束，导致越界访问。

</details>

### 2.2. static_cast

- **含义**：`static_cast` 用于非多态类型的转换，是编译时的「静态」类型转换；对应 C 语言的隐式类型转换——显式地完成「编译器隐式转换会允许的那些转换」，编译器隐式执行的任何类型转换都可用 `static_cast`。
- **适用场景**：有一定关联、并且意义相似的类型之间转换（如 `int` 和 `double`）；但不能用于两个不相关的类型进行转换。
- **特点**：不保证运行时安全（例如基类指针/引用转成派生类指针/引用，使用 `static_cast` 可能会导致越界访问）。

```cpp
int main()
{
	double d = 12.34;
	int a = static_cast<int>(d);
	cout << a << endl;
	return 0;
}
```

### 2.3. reinterpret_cast

- **含义**：`reinterpret_cast` 为操作数的位模式提供较低层次的重新解释——对变量的比特位进行「重新解释」，完全忽略类型的语义和兼容性，是最「暴力」的转换方式，用于将一种类型转换为另一种不同的类型。
- **适用场景**：适用于有一定关联、但是意义不相似的类型之间转换（如 `int*` 和 `int`）。
- **特点**：转换结果完全依赖编译器实现，不保证可移植性（不同平台可能有不同结果）；几乎不做任何类型检查，滥用会导致严重的内存安全问题（如访问越界、类型错误）；通常用于底层编程（如硬件交互、内存操作），日常开发应避免使用。

```cpp
int main()
{
	double d = 12.34;
	int a = static_cast<int>(d);
	cout << a << endl;

	// 这里使用static_cast会报错，应该使用reinterpret_cast
	//int *p = static_cast<int*>(a);
	int *p = reinterpret_cast<int*>(a);

	return 0;
}
```

### 2.4. const_cast 与 volatile

- **作用**：去掉变量的 const/volatile 属性——最常用的用途就是删除变量的 const 属性，方便赋值。
- **注意**：`const_cast` 的模板参数只能是指针或者引用。

```cpp
void Test()
{
	const int a = 2;
	int* p = const_cast<int*>(&a);
	*p = 3;

	cout << a << endl;
}
```

使用注意事项：

1. 只能用于同一类型的 const 与非 const 版本之间的转换（如 `const int*` ↔ `int*`），不能用于不同类型转换（如 `const int*` → `float*` 需结合 `reinterpret_cast`）。
2. 若原变量本身是 const（如 `const int c = 10`），通过 `const_cast` 移除 const 后修改它，会导致未定义行为（可能崩溃或结果异常）。
3. 合理用途：当需要调用一个非 const 参数的函数，但只有 const 变量时（需确保函数不会修改该变量）。

#### 2.4.1. volatile 关键字

在 C++ 中，`volatile` 是一个类型修饰符（keyword），用于告诉编译器：被修饰的变量可能会被程序外部因素（如硬件、其他线程、中断服务程序等）意外修改，因此编译器不应对该变量的访问进行优化，必须每次都直接从内存中读取或写入，而不能依赖寄存器缓存或指令重排。（注意：`volatile` 不是线程安全的）

编译器在优化代码时，可能会对变量访问做以下优化（这些优化在 `volatile` 变量上会被禁用）：

1. **寄存器缓存**：将变量值暂存到寄存器中，后续访问直接使用寄存器值（而非重新从内存读取）。
2. **指令重排**：调整代码执行顺序以提高效率（如合并多次读取为一次）。
3. **死代码消除**：删除未被「显式修改」的变量的重复读取。

#### 2.4.2. const 与 volatile 对比实验

例子代码1：

![代码1（const_cast 修改 const 变量）与被注释的代码2（volatile 版本）：代码1 输出 a=2、*p=3，代码2 输出 a=3、*p=3](/images/notes/cpp/type-conversion/fig07.png)

Q1：为什么代码1输出 a 和 *p 结果不一样？

<details class="answer-box">
<summary>点我显示答案</summary>

A1：因为 a 是被 const 修饰了，是编译期常量，编译器会认为 a 的值「永远不会变」：

- 说法1：因此会进行常量折叠优化——直接把代码中所有用到 a 的地方，替换成它的字面量 2（而不是运行时从内存读取 a）。
- 说法2：因此编译器把 a 放在寄存器中，读取就从寄存器读，而不是从内存读。

这点从反汇编也能看出来（`cout << a` 对应的指令为 `mov edx, 2`，直接把字面量 2 嵌入指令）：

![代码1 反汇编：cout << a 直接嵌入字面量 2](/images/notes/cpp/type-conversion/fig08.png)

</details>

Q2：为什么代码2输出 a 和 *p 结果又一样了？

<details class="answer-box">
<summary>点我显示答案</summary>

A2：因为 volatile 禁止了常量折叠优化，强制每次访问必须是从内存访问。这点从反汇编也能看出来（`cout << a` 对应的指令为 `mov edx, dword ptr [a]`，从内存读取）：

![代码2 反汇编：cout << a 从内存读取](/images/notes/cpp/type-conversion/fig09.png)

</details>

### 2.5. dynamic_cast

- **作用**：在运行时将一个父类对象的指针/引用安全地转换为子类对象的指针或引用（动态转换，即向下转换；但是父类对象还是不能转成子类对象）。
- **向上转型**：子类对象指针/引用 → 父类指针/引用（不需要转换，赋值兼容规则），即子类对象/指针/引用可以用父类指针/引用接收。
- **向下转型**：父类对象指针/引用 → 子类指针/引用，用 `dynamic_cast` 转型是安全的——它会先检查是否能转换成功，能成功则转换，不能则返回 `nullptr`（指针）或抛出异常（引用）。
- **注意**：
  1. `dynamic_cast` 只能用于父类含有虚函数的类（父类是多态类）。
  2. `dynamic_cast` 的目标类型只能是指针或引用（按值转换对象会编译报错）。

```cpp
class A
{
public:
	virtual void f() {}
};

class B : public A
{
};

void fun(A* pa)
{
	// dynamic_cast会先检查是否能转换成功，能成功则转换，不能则返回nullptr
	B* pb1 = static_cast<B*>(pa);
	B* pb2 = dynamic_cast<B*>(pa);

	cout << "pb1:" << pb1 << endl;
	cout << "pb2:" << pb2 << endl;
}
```


向上转换示例：

```cpp
B objb;
A obja = objb;
A& ra = objb;
```

比如上面代码的 A 引用类型接收 B 类型对象。

```cpp
double d = 1.1;
const int& i = d;
```

上面代码中写 `const int& i = d;` 不会报错，但是写成 `int& i = d;` 会报错，为什么？

<details class="answer-box">
<summary>点我显示答案</summary>

**分析**：`d` 是 `double`，而引用的目标类型是 `int`，两者类型不同，编译器会先把 `d` 转换生成一个 `int` 类型的**临时变量**，再让引用绑定到这个临时变量上：

```cpp
double d = 1.1;
const int& i = d;
// 编译器实际行为等价于：
// int temp = d;         // 生成 int 临时变量（值被截断为 1）
// const int& i = temp;  // const 引用绑定临时变量，并延长其生命周期
```

临时变量是右值，非 const 的普通引用不能绑定右值——否则对引用的修改只会改到一个无人可见的临时变量上，没有任何意义，所以 `int& i = d;` 编译报错；而 const 引用可以绑定临时变量并延长其生命周期，所以 `const int& i = d;` 不会报错。上面 `A& ra = objb;` 不需要 const，是因为子类对象用父类引用接收属于向上转换（赋值兼容规则），没有发生类型转换、不产生临时变量，引用直接绑定在 `objb` 的父类子对象上。

</details>

像之前使用强制类型转换或者使用 `static_cast` 将父类指针/引用转换成子类指针/引用（这种行为是不安全的），如果父类指针/引用指向的就是父类对象，那么可能会导致越界访问问题：

```cpp
void fun(A* pa)
{
	// 向下转换：直接转换是不安全的
	// 如果pa是指向父类A对象，存在越界问题
	B* ptr = (B*)pa;
	ptr->_a++;
	ptr->_b++;
}
```

上面代码中 `_a` 是类 A（父类）的成员，`_b` 是类 B（子类）的成员。如果原本 `pa` 指向的就是父类对象，那么执行 `ptr->_b++` 时，就会非法修改内存（可以通过调试发现）。

而使用 `dynamic_cast` 做向下转换时会先检查，结果分两种情况：

1. 如果父类指针指向的是子类对象就可以转换成功；如果父类指针本来就指向的是父类对象，则转换失败，返回 `nullptr`（图中 A 是父类，B 是子类）：

![dynamic_cast 指针转换示例：父类指针分别指向父类对象与子类对象](/images/notes/cpp/type-conversion/fig13.png)

2. 如果父类引用指向的是子类对象就可以转换成功；如果父类引用本来就引用的是父类对象，则转换失败，抛出异常（图中 A 是父类，B 是子类；控制台输出「转换失败：Bad dynamic_cast!」）：

![dynamic_cast 引用转换示例：转换失败抛出 Bad dynamic_cast 异常](/images/notes/cpp/type-conversion/fig14.png)

## 3. RTTI

RTTI：Run-time Type identification 的简称，即运行时类型识别。

C++ 通过以下方式来支持 RTTI：

1. **typeid 运算符**：`typeid(变量).name()` 返回 `const char*`，获取变量类型的字符串。
2. **dynamic_cast**：根据类型转换结果，识别是父类还是子类。
3. **decltype**：根据表达式获取类型。
