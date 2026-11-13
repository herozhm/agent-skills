---
name: analyze-perf-trace
description: 分析 Chrome DevTools Performance trace JSON 文件（性能录制导出），定位长任务、强制重排、布局抖动、querySelector 风暴等主线程性能问题。触发词：performance trace、性能 trace、trace 分析、分析 Trace-*.json、性能录制、长任务、卡顿分析、performance profile、devtools 录制、页面卡了帮我看 trace。不适用于 .log 日志文件（日志类文件另行分析）。
---

# analyze-perf-trace

解析 Chrome DevTools Performance 面板导出的 trace JSON（通常 50-200MB），不要直接 Read 文件，用本 skill 的脚本提取结论。

## 用法

```bash
RUN="NODE_OPTIONS=--max-old-space-size=8192 pnpm tsx .claude/skills/analyze-perf-trace/scripts/analyze-trace.ts"
# 大 trace 必须加 max-old-space-size，否则 JSON.parse OOM
```

| 命令                                  | 作用                                                                                                                                                                        |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$RUN <trace.json> overview`          | 进程/线程清单、trace 窗口时长、自动识别渲染主线程                                                                                                                           |
| `$RUN <trace.json> main`              | 长任务、self-time 按事件名聚合、UpdateLayoutTree/Layout 统计、大型 recalc（含 elementCount）、强制重排来源（带调用栈）、GC、FunctionCall/EventDispatch/TimerFire 按来源聚合 |
| `$RUN <trace.json> profile`           | 内嵌 CPU profile：按函数聚合 self / total(inclusive) 时间                                                                                                                   |
| `$RUN <trace.json> callers '<正则>'`  | 匹配函数的自底向上调用链（定位"谁在调它"）                                                                                                                                  |
| `$RUN <trace.json> timeline '<正则>'` | 匹配事件的时间线分布 + UpdateLayoutTree 每 500ms 密度                                                                                                                       |

主线程自动识别（最忙的 CrRendererMain）；多 renderer 时可在命令末尾追加 `pid:tid` 覆盖。

## 分析流程

1. `overview` → 确认窗口时长、主线程
2. `main` → 找长任务（>50ms）和 self-time 大头；记下 FunctionCall 来源 top 的 `文件:行号`
3. `profile` → self-time 看"钱花在哪个原生调用"（querySelector / get scrollTop / getBoundingClientRect 高 = 强制重排/DOM 查询风暴）；total 看业务入口
4. `callers '<热点函数>'` → 还原调用链，拿到业务文件名
5. `timeline '<业务文件名>'` → 看热点在长任务内的时间分布、recalc 密度突变点
6. 回到仓库 Grep/Read 源码确认根因

## 输出解读要点

- **`get scrollTop` / `getBoundingClientRect` / `getComputedStyle` self-time 高** = 强制同步重排：读发生在 DOM 变脏后，样式重算记在读取方头上。单次大型 recalc 的 `elements=` 数即失效范围。
- **`querySelector` self-time 高** = 全文档选择器风暴，用 `callers 'querySelector'` 找注册方（常见：MutationObserver 回调里逐元素查询）。
- **`RunMicrotasks` self 高**：Vue flushJobs / Promise 链 / MutationObserver 投递都算微任务，用 profile 的 total 榜定位（如 `flushJobs`）。
- **`CpuProfiler::StartProfiling` ~1.5s** 是录制本身的开销，忽略。
- **blob URL（uuid:0）函数** = 经 blob 加载的代码（常见 WASM glue / worker 内联），用 `main` 的 TimerFire/FunctionCall 来源对照定位（如 setInterval 包装器的 `文件:行`）。
- **`es-*.js?v=xxx` 等 vite chunk**：是 optimized deps,行号对不上源码;按函数名 + 行为特征到 `node_modules/.pnpm/<pkg>/dist/es` 里 grep 确认（如 `update` 读 scrollTop → 找组件库 Scrollbar）。
- **trace 内 `:行号` 是 0-based** 且对应构建产物，和工作区源码可能差几行，以函数名为准。
- **EventDispatch 大量 `readystatechange`/`load`** = XHR/资源请求风暴，会持续喂 MutationObserver 类监听。

## 常见坑

- 不要 `Read` trace 文件或用 `head`/`jq` 逐段看 —— 166k+ 事件没有可读性，直接跑脚本。
- 长任务时间点是相对主线程第一个事件的偏移（ms），与 DevTools 面板的绝对时间轴不同。
- `main` 的 self-time 聚合基于 X 事件嵌套推断，叶子级精度看 `profile`（采样制，~0.1ms 粒度）。
- trace 没录 JavaScript samples 时 `profile`/`callers` 不可用，只能用 `main` 的 FunctionCall 来源。
