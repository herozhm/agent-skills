---
name: css-source-tracing
description: 编写或修改任何样式(CSS/SCSS/Less/Vue style block/Tailwind class)时的强制流程——先定位样式定义源头再改,遵守零新增红线(禁 !important、Tailwind 强制优先级、裸数字 z-index、硬编码颜色、非 scoped style),改完跑增量自检脚本。适用于调样式、写新样式、修复样式 bug、处理选择器膨胀与样式覆盖冲突。
---

# CSS 追溯到源头再修改

## 触发时机

- 用户要求「调样式」「改样式」「修复 UI 显示」
- **任何会新增样式代码的任务**(新组件、新面板、新弹窗——不只是改现有样式)
- 需要改动 .vue / .scss / .css / .module.scss 文件中的选择器
- 看到诸如 :is(.a,.b,.c) :is(.d:focus-within,.e[data-state=open]) 这种链式覆盖
- 处理跨包样式覆盖
- 看到 !important、超过 3 层的后代选择器、或同一个 class 反复出现的 override

## 零新增红线(机器检查,收尾自检脚本强制执行)

新增代码禁止:

| 红线 | 替代做法 |
|---|---|
| CSS !important | 溯源改源头(本 skill Step 1~3) |
| Tailwind 强制优先级 !flex / hover:!bg-* / text-sm! | 查组件 variant / Props / token |
| 裸数字 z-index(≥10,含 JS 的 zIndex:) | 用 z-index 阶梯 token 或统一层级管理器 |
| 硬编码 hex 颜色 | var(--color-*),定义见项目 token 定义文件 |
| 无 scoped 的 style | 默认 scoped;全局样式进全局样式文件 |
| 4 层以上 :deep() 选择器链 | 组件 API / 稳定 class hook / 能力下沉 |
| 单行 class 超过 200 字符 | 提取语义 class / variant / 共享 utility |
| 引用未定义的 CSS 变量(幽灵 token) | 去 token 定义文件查真名,不凭语义感拼名 |

**例外流程**:确实无法避免时(第三方样式、后台富文本 inline style 等),在该行或上一行加注释 style-guard-allow: <规则id> <理由>,并在例外清单登记(负责人 + issue 号 + 到期时间)。Agent 不得自行决定例外——先停下来向用户说明理由。

## 核心原则

**改源头,不加覆盖层。**

任何一次样式修改前,必须先回答三个问题:

1. **谁**定义了这条样式?(哪个文件、哪一行)
2. 我这次要改的**视觉目标**落在哪条规则上?
3. 改源文件是否会**波及其他调用方**?如果会,才考虑局部覆盖。

如果回答不了 1 或 2,**停下来先查,不要直接写 CSS**。

## 禁止清单(不经用户同意不得使用)

| 模式 | 禁止原因 |
|---|---|
| :is(.a,.b,.c) :is(.x,.y) 提升优先级 | 仅靠堆叠选择器压过源头,下一个维护者无从查起 |
| !important | 制造死锁,后续只能用更多 !important 解 |
| 外层再包一个 class(如 .wrapper .wrapper-v2 .btn) | 特异性军备竞赛 |
| 在调用方覆盖第三方组件库内部选择器(如 .n-button .n-button__content) | 随库升级即失效。先查组件文档有没有 variant / prop / token |
| 同一 selector 在多个文件出现 override | 说明源头没定好,先合并 |

**允许的例外**(必须在 commit message 或代码注释一行说明**为什么**):

- 源文件在组件库内,且**经组件文档确认过**没有对应的 variant / prop / token 可用
- 修改源头会导致其他调用方回归(已经 grep 确认过)

## 工作流(每次改样式前跑一遍)

### Step 1: 定位源头

```bash
# 找 class 的定义位置(注意:是定义处,不是使用处)
Grep: pattern="\\.xt_input_number_container\\s*\\{" glob="**/*.{vue,scss,css}"

# 找是谁在 setState/渲染这个 data-state
Grep: pattern="data-state.*open" glob="**/*.{vue,ts}"

# 如果是组件库内部 class:不要 grep node_modules,走组件文档工具查
#   list_components → 有哪些组件
#   get_component_docs(name) → props / events / slots
#   get_component_style(name) → style 变体表
#   get_design_token() → 全部 token 的实际值,按主题分
```

⚠️ 组件库内部 class(如 xt_ / n- 等私有前缀)一律走组件文档工具查,不读源码、不 grep node_modules。
变体表给的是 token 名,token 表给的是值,两个拼起来才是完整答案。

### Step 2: 打印调用链给用户看

动手前先输出简报,让用户确认再改:

```
目标: <组件> 在 <状态> 下的 <视觉属性>
源头: <文件路径:行号> <选择器>
影响面: grep 显示 XX 处使用,其中 XX 是本次修改的目标,其他 XX 处需要保持不变
计划: 修改源文件第 N 行的 <属性>
风险: <有/无>
```

如果影响面超过 5 处,或跨包/跨子项目,**先问用户**再动手。

### Step 3: 改源头

- 优先级:**主题变量** > **源文件规则** > **同包 scoped 覆盖** > 其他
- 禁止为了「最小 diff」而保留旧覆盖 + 加新覆盖。删旧的。
- 如果源文件用了 CSS 变量(var(--xxx)),优先改变量值。先分清变量属于哪一套(组件库/应用层),
  自己定义新变量之前先查一遍 token 表,很容易造出一个值完全相同的重复 token。

### Step 4: 增量自检(必跑,违规为 0 才算完成)

```bash
pnpm tsx skills/css-source-tracing/scripts/check-style-debt.ts
```

- 只扫描相对 HEAD 的**新增**行和未跟踪样式文件,不会被存量债务干扰。
- 输出每处违规的文件:行号、规则 id 和替代做法;退出码非 0 时必须修复后重跑。
- 也可以全量检查指定文件:... --files path/a.vue path/b.css
- 定位「是哪条规则赢了级联」时配合浏览器 DevTools 在运行时取证(getComputedStyle / 检查元素匹配规则),不要靠猜。

## 本仓特定提示(按你的技术栈替换)

- 组件库私有前缀(如 xt_)→ 组件文档工具查,别翻 node_modules
- 框架注入前缀(如 n- / tw-)→ 框架内置,新代码不要写它们的覆盖
- data-state='open' 一般由 headless 组件(Radix 系)触发——看变体表里这个状态挂的是哪个 token,再决定改哪里

## 反面案例(就是不要这么写)

```
/* ❌ 典型的 AI 偷懒写法 */
:is(.deviceCard, .container-column, .container-row)
  :is(
    .input_container.xform-compact-number:focus-within,
    .input_container.widget-unit-input:focus-within,
    .select_trigger_root.xform-compact-select[data-state='open']
  ) {
  border-color: var(--primary);
}
```

**问题**:

1. 三层 :is() 堆优先级,显然是为了压过某处源样式
2. 读者无法回答「这条样式真正的定义在哪」
3. 下一个人想撤销这个「边框色」时,grep primary 会搜到几十处

**正确思路**:

1. focus-within / data-state 状态多半是组件库内部已经处理的——先看变体表里这两个状态挂的是哪个 token。
   ⚠️ 别照搬印象里的 token 名——凭语义感拼的 token **可能根本不存在**、全仓零命中(unknown-token 规则正是查这类幽灵 token)。token 名一律以组件文档/token 表为准。
2. 如果确实要区分两种变体,让它们**各自**在**自己的源组件**里定义一次 focus 样式
3. 不需要从父容器限定作用域——scoped style 已经解决了

## 与其他 skill 的关系

- 判断存量 !important 能否安全去掉 → style-priority-analysis(三档结论:必须保留 / 可安全去掉 / 需人工确认)
- 改完后提交 → commit-splitting(按模块边界拆分提交)
- 运行时定位级联竞争(哪条规则赢了、被谁划线)→ 浏览器 DevTools
