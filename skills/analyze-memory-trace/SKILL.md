---
name: analyze-memory-trace
description: 分析 Electron/Chrome memory-infra trace（contentTracing 内存 dump，路径由项目配置），按进程拆解内存占用——各进程总量与顶层 allocator（v8/blink_gc/partition_alloc/malloc/parkable_strings…）、单进程 V8 isolate 与 blink/partition 细分、多时间点内存曲线（判断是泄露还是 GC 回收）。触发词：memory-trace、内存 trace、内存 dump、contentTracing、mem-*.json、上位机内存高、渲染进程内存、内存会降下来吗、内存回收、分析内存 trace。不适用于 heapsnapshot 堆快照（用 analyze-heapsnapshot）或性能 trace（用 analyze-perf-trace）。
---

# analyze-memory-trace

解析 Electron/Chromium 通过 `contentTracing`（memory-infra category）导出的内存 dump（由项目的 contentTracing 导出入口落到本地文件，通常 10~20MB）。不要直接 Read，用脚本提取结论。

数据结构：`traceEvents` 里 `ph:'v'/'V'` 且带 `args.dumps` 的事件是内存 dump，每 ~2s 采一次。`dumps.allocators` 里 allocator 大小是 **十六进制字符串字节**（`attrs.size.value`）。本项目的 trace 是 `level_of_detail:detailed` 但**不带 `totals`**（无 `resident_set_bytes`），进程总量用顶层 allocator 的 `effective_size` 求和近似。

## 用法

```bash
RUN="NODE_OPTIONS=--max-old-space-size=8192 pnpm tsx .claude/skills/analyze-memory-trace/scripts/analyze-memory-trace.ts"
# 十几 MB 的 trace 加 max-old-space-size 稳妥；更大给 16384
```

| 命令                          | 作用                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `$RUN <trace> overview`       | 所有进程（含进程名）按总量排序，各自 >1MB 的顶层 allocator。**先跑这个定位大头进程**                                                          |
| `$RUN <trace> pid <pid>`      | 单进程细分：V8 isolate 数量与大小、v8/\* 大子节点、blink_gc/partition_alloc/malloc/cc 细分                                                    |
| `$RUN <trace> timeline [pid]` | 每个采样点的进程总量随时间变化（+/- 增量），**判断持续增长(疑似泄露) vs 采完就回落(GC)**                                                      |
| `$RUN <trace> html [outfile]` | 生成自包含 HTML 报告（进程占用条 + allocator 图例 + 细分表 + 趋势 sparkline），默认落 `output/tracing/<trace名>.report.html`，`open` 即可预览 |

## 分析流程

1. `overview` → 找占用最高的进程。看它的顶层构成：
   - `v8` 大 = JS 堆（对象/闭包/字符串）
   - `blink_gc` 大 = DOM/CSS 等 Blink 托管对象
   - `partition_alloc/partitions/buffer` 大 = **ArrayBuffer/TypedArray**（图片解码、二进制资源）
   - `parkable_strings` 大 = 可换出的大字符串（常是内联 base64 资源）
   - `cc` = 合成器 tile/image 显存缓存
2. `pid <热点进程>` → 往下钻：`v8/main/heap/old_space` 看老生代常驻；`partition_alloc/allocated_objects/*` 里带哈希后缀的大块就是 ArrayBuffer 聚集点；`blink_gc/main/heap/NormalPageSpaceN` 看 DOM 规模。
3. `timeline <pid>` → **区分泄露与回收**：总量随时间**单调上升不回落** = 疑似泄露；**采样期间就自己降下来** = GC 正常回收，当前高点只是回收前的峰值，不是泄露。

## 输出解读要点

- **总量来源标注**：overview 每个进程标 `(footprint)` / `(rss)` / `(Σtop-alloc)`。本项目 trace 无 totals，一律 `Σtop-alloc`（顶层 allocator effective_size 之和，`effective_size` 已按共享内存去重，避免父子重复计数）。
- **size vs effective_size**：overview/timeline 用 `effective_size`（去重，接近真实占用）；`pid` 细分用原始 `size`（看单个子树的账面大小）。
- **多个 Renderer**：微前端（WuJie）架构下 home/editor 各是独立 Renderer 进程；总内存要把相关 Renderer 加起来看。
- **V8 isolate**：一个 Renderer 通常一个 `main` isolate 承载所有微应用 + 若干 `workers`/`shared`。`main` 独大是正常的。
- **timeline 的 Browser 进程**会同时发轻量 dump 和详细 dump，脚本已按秒取最大值去重。

## 常见坑

- 别 `Read`/`jq` 逐段看 trace——4 万+ 事件、allocator 大小是 hex 字符串，人读无意义，必须跑脚本。
- 单个高点 ≠ 泄露。先 `timeline` 确认是否回落；不回落再考虑抓 heapsnapshot 用 `analyze-heapsnapshot` 定位持有方（trace 只给分类总量，给不出具体是谁在持有）。
- `overview` 总量是近似值（无 RSS/footprint 时按 allocator 求和），和活动监视器的 phys_footprint/RSS 有出入，用于**看构成占比和趋势**，不要当精确 RSS。
- trace 里同一进程有多个 dump，脚本只取**最后一个** detailed dump 做 overview/pid（最新状态）；趋势看 `timeline`。
