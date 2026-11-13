---
name: analyze-heapsnapshot
description: 分析 Chrome DevTools / V8 内存快照（.heapsnapshot），定位内存泄露——按构造函数聚合浅大小、检测 detached DOM、支配树算 retained size、还原 retainer 引用链、两张快照 diff 找持续增长的对象。触发词：heapsnapshot、内存快照、内存泄露、memory leak、堆快照分析、detached DOM、retained size、retainer 路径、内存涨了帮我看快照、分析 *.heapsnapshot、两张快照对比。不适用于性能 trace（用 analyze-perf-trace）或日志（日志类文件另行分析）。
---

# analyze-heapsnapshot

解析 Chrome DevTools Memory 面板（或 `v8.writeHeapSnapshot` / `--heapsnapshot-signal`）导出的 `.heapsnapshot`（通常几十到几百 MB），不要直接 Read 文件，用本 skill 的脚本提取结论。

## 用法

```bash
RUN="NODE_OPTIONS=--max-old-space-size=8192 pnpm tsx .claude/skills/analyze-heapsnapshot/scripts/analyze-heapsnapshot.ts"
# 大快照必须加 max-old-space-size,否则 JSON.parse OOM;数百万节点用 16384
```

| 命令                                     | 作用                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------- |
| `$RUN <snap> overview`                   | 快照规模、按节点类型的浅大小分布、detached 节点数、是否含 detachedness 字段   |
| `$RUN <snap> summary [topN]`             | 按构造函数/类名聚合实例数 + 浅大小（对应 DevTools Summary 视图），默认 top 40 |
| `$RUN <snap> detached [topN]`            | detached DOM 节点分组 + 每组一条最短 retainer 路径（DOM 泄露重灾区）          |
| `$RUN <snap> biggest [topN]`             | 支配树算 retained size top（"删掉它能释放多少"），默认 top 30，**最重的命令** |
| `$RUN <snap> nodes '<正则>' [topN]`      | 列出 name 匹配的实例节点（id / self_size / 是否 detached）                    |
| `$RUN <snap> retainers '<正则>' [count]` | 匹配节点的最短 retainer 引用链（root → … → 对象），默认前 5 个                |
| `$RUN <snap> strings [topN]`             | 重复字符串聚合（按总浅大小），定位字符串膨胀 / 未复用                         |
| `$RUN <snapA> diff <snapB>`              | 两张快照按类名做 count / size 增量对比（**泄露定位的核心流程**）              |

## 分析流程

### A. 只有一张快照（"内存怎么这么高"）

1. `overview` → 看总浅大小、哪类节点占大头、detached 数量
2. `summary` → 哪个构造函数实例最多 / 占内存最多；异常的业务类名记下来
3. `biggest` → retained size top，找"独占内存的黑洞"（retained ≫ self 的数组/Map/闭包）
4. `retainers '<热点类名>'` → 还原引用链，找到第一个业务对象 = 持有方
5. 回仓库 Grep/Read 源码确认根因（谁 push 进数组、谁注册了没解绑的监听器/定时器）

### B. 怀疑泄露（推荐，定位最准）

1. 在页面里做一次"嫌疑操作"（打开关闭弹窗、切换设备、加载卸载画布…）让内存回到基线，抓快照 A
2. 把同一操作重复 N 次（如 10 次），抓快照 B
3. `diff A B` → 看「实例数增长 top」：**Δcount 随操作次数线性增长**的类名就是泄露源
4. 对该类名跑 `retainers` 拿引用链 → 回源码定位

### C. DOM 泄露

- `detached` → detached DOM 仍被 JS 引用即泄露；沿 retainer 路径找到第一个业务对象（常见：闭包 / 全局 Map / 未解绑监听器持有了已移除的 DOM）

## 输出解读要点

- **retained vs self**：`self`=对象自身浅大小；`retained`=它被回收能连带释放的总大小（支配树）。`retained ≫ self` 的容器（Array/Map/Object/闭包）若持续变大 = 泄露累积点。
- **detached 节点**：`detachedness` 字段 == 2，或名字以 `Detached ` 开头（如 `Detached HTMLDivElement`）。浏览器快照里成片的 `Detached *` 是典型 DOM 泄露。
- **retainer 路径方向**：输出里**目标在上、GC root 在下**，每行 `↑ .xxx` 是下方持有者指向上方对象的属性名（对齐 DevTools Retainers 面板）。链路里第一个出现的业务对象就是泄露持有方；`(Global handles)` / `(Eternal handles)` / `(Strong root list)` 等是 GC root,看它们上一层。
- **`(string)` / `(compiled code)` 占大头**：通常正常（代码 + 字符串常量）；只有 `diff` 里它们随操作线性增长才可疑（如反复拼接未释放、字符串没复用）。
- **`system / *`（Map/Context/DescriptorArray…）**：V8 内部结构，一般不是业务泄露目标，聚焦业务类名。
- **diff 的 Δcount 比 Δsize 更可信**：监听器、缓存、闭包累积往往单个很小，靠数量暴露。

## 常见坑

- 不要 `Read` / `head` / `jq` 逐段看 `.heapsnapshot` —— 它是「扁平整数数组 + strings 表」的紧凑格式（`nodes` 每 7 个整数一个节点，`edges` 每 3 个一条边，`to_node` 是字节偏移不是序号），人读无意义，必须跑脚本。
- `nodes` / `retainers` 的正则匹配的是节点 **name 字段**：对 object 节点 = 构造函数名（如 `^MyClass$`），对 string 节点 = 字符串内容（会误匹配同名字符串）。查业务类用 `^类名$` 收紧。
- `biggest` 要建支配树（DFS + 迭代支配 + retained 累加），是最慢/最吃内存的命令；先用 `summary`/`diff`/`detached` 缩小范围，再用它确认。
- `diff` 会**先后**解析两张快照，峰值内存约等于较大那张的解析量（不是两张相加），但仍建议 `--max-old-space-size` 给足。
- 老快照可能没有 `detachedness` 字段，此时 `detached` 只能靠名字 `Detached ` 前缀判断（`overview` 会提示字段是否存在）。
- 抓快照前 DevTools 会自动跑一次 GC，所以快照里的对象都是"GC 后仍存活"的——这正是判断泄露的依据。

```

```
