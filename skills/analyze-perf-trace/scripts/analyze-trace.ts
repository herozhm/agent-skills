#!/usr/bin/env -S pnpm tsx
/**
 * Chrome DevTools Performance trace 分析工具
 *
 * 用法:
 *   NODE_OPTIONS=--max-old-space-size=8192 pnpm tsx analyze-trace.ts <trace.json> [command] [args]
 *
 * 命令:
 *   overview                  进程/线程清单、trace 窗口、最忙线程(默认)
 *   main [pid:tid]            主线程分析:长任务、self-time 聚合、布局/强制重排、GC、
 *                             FunctionCall/EventDispatch/TimerFire 来源聚合
 *   profile [pid]             内嵌 CPU profile:按函数聚合 self / total(inclusive) 时间
 *   callers <pattern> [pid]   匹配函数的调用链(自底向上),pattern 匹配函数名或 url 子串
 *   timeline <pattern> [pid:tid]  按 500ms 分桶看事件/脚本来源的时间分布 + UpdateLayoutTree 密度
 */

import { readFileSync } from 'node:fs';

interface TraceEvent {
  name: string;
  ph: string;
  pid: number;
  tid: number;
  ts: number;
  dur?: number;
  args?: any;
  // 内部字段:嵌套子事件累计时长
  _child?: number;
}

interface ProfNode {
  id: number;
  fn: string;
  url: string;
  line?: number;
  parent?: number;
  self: number;
  total: number;
}

const ms = (us: number) => (us / 1000).toFixed(1);

function load(file: string): TraceEvent[] {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  return data.traceEvents || data;
}

/** 自动识别渲染进程主线程:X/B 事件最多的 CrRendererMain */
function detectMainThread(events: TraceEvent[]): { pid: number; tid: number } {
  const threadNames = events.filter(e => e.ph === 'M' && e.name === 'thread_name');
  const mains = threadNames.filter(t => t.args?.name === 'CrRendererMain');
  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.ph !== 'X' && e.ph !== 'B') continue;
    const k = `${e.pid}:${e.tid}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  let best: { pid: number; tid: number } | null = null;
  let bestCount = -1;
  for (const m of mains) {
    const c = counts.get(`${m.pid}:${m.tid}`) || 0;
    if (c > bestCount) {
      bestCount = c;
      best = { pid: m.pid, tid: m.tid };
    }
  }
  if (!best) throw new Error('未找到 CrRendererMain 线程,请用 pid:tid 参数手动指定');
  return best;
}

function mainEvents(events: TraceEvent[], pid: number, tid: number): TraceEvent[] {
  return events
    .filter(e => e.pid === pid && e.tid === tid && e.ph === 'X' && e.dur != null)
    .sort((a, b) => a.ts - b.ts || b.dur! - a.dur!);
}

// ---------- overview ----------
function cmdOverview(events: TraceEvent[]): void {
  console.log('total events:', events.length);
  const meta = (name: string) => events.filter(e => e.ph === 'M' && e.name === name);
  const procNames = meta('process_name');
  const procLabels = meta('process_labels');
  const threadNames = meta('thread_name');

  console.log('\n--- 进程 ---');
  for (const p of procNames) {
    const label = procLabels.find(l => l.pid === p.pid);
    console.log(p.pid, p.args.name, label ? JSON.stringify(label.args.labels).slice(0, 120) : '');
  }

  const counts = new Map<string, number>();
  for (const e of events) {
    if (e.ph !== 'X' && e.ph !== 'B') continue;
    const k = `${e.pid}:${e.tid}`;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  console.log('\n--- 最忙线程(X/B 事件数 top 8)---');
  [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .forEach(([k, c]) => {
      const [pid, tid] = k.split(':').map(Number);
      const tn = threadNames.find(t => t.pid === pid && t.tid === tid);
      console.log(k, c, tn ? tn.args.name : '?');
    });

  const xs = events.filter(e => e.ph === 'X' && e.dur != null);
  if (xs.length) {
    let t0 = Infinity,
      t1 = -Infinity;
    for (const e of xs) {
      if (e.ts < t0) t0 = e.ts;
      const e1 = e.ts + e.dur!;
      if (e1 > t1) t1 = e1;
    }
    console.log(`\ntrace 窗口: ${((t1 - t0) / 1e6).toFixed(2)}s`);
  }
  try {
    const m = detectMainThread(events);
    console.log(`渲染主线程: ${m.pid}:${m.tid}(后续命令默认使用)`);
  } catch {
    console.log('未识别到渲染主线程');
  }
}

// ---------- main ----------
function cmdMain(events: TraceEvent[], pid: number, tid: number): void {
  const xs = mainEvents(events, pid, tid);
  if (!xs.length) {
    console.log('该线程没有 X 事件');
    return;
  }
  let t0 = Infinity;
  for (const e of xs) if (e.ts < t0) t0 = e.ts;
  const rel = (e: TraceEvent) => ((e.ts - t0) / 1000).toFixed(0);

  // 长任务
  const tasks = xs.filter(e => e.name === 'RunTask');
  const long = tasks.filter(e => e.dur! > 50000).sort((a, b) => b.dur! - a.dur!);
  console.log(
    `--- 长任务 >50ms: ${long.length} 个,合计 ${ms(long.reduce((s, e) => s + e.dur!, 0))}ms ---`,
  );
  for (const e of long.slice(0, 25)) console.log(`@${rel(e)}ms dur=${ms(e.dur!)}ms`);

  // self-time 聚合(用栈算嵌套)
  const stack: TraceEvent[] = [];
  for (const e of xs) {
    while (stack.length && stack[stack.length - 1].ts + stack[stack.length - 1].dur! <= e.ts)
      stack.pop();
    if (stack.length) {
      const p = stack[stack.length - 1];
      p._child = (p._child || 0) + e.dur!;
    }
    stack.push(e);
  }
  const self = new Map<string, number>();
  for (const e of xs) {
    const s = e.dur! - (e._child || 0);
    if (s > 0) self.set(e.name, (self.get(e.name) || 0) + s);
  }
  console.log('\n--- self-time 按事件名(top 25)---');
  [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .forEach(([n, t]) => console.log(`${ms(t).padStart(10)}ms  ${n}`));

  // 样式重算 / 布局 / 强制重排
  const recalc = xs.filter(e => e.name === 'UpdateLayoutTree' || e.name === 'RecalculateStyles');
  const layout = xs.filter(e => e.name === 'Layout');
  console.log(
    `\nUpdateLayoutTree: ${recalc.length} 次,合计 ${ms(recalc.reduce((s, e) => s + e.dur!, 0))}ms`,
  );
  console.log(`Layout: ${layout.length} 次,合计 ${ms(layout.reduce((s, e) => s + e.dur!, 0))}ms`);

  const bigRecalc = recalc
    .filter(e => e.dur! > 5000)
    .sort((a, b) => b.dur! - a.dur!)
    .slice(0, 8);
  if (bigRecalc.length) {
    console.log('--- 大型 recalc(>5ms,top 8)---');
    for (const e of bigRecalc)
      console.log(
        `@${rel(e)}ms dur=${ms(e.dur!)}ms elements=${e.args?.elementCount ?? e.args?.beginData?.dirtyObjects ?? '?'}`,
      );
  }

  const forced = layout.filter(e => e.args?.beginData?.stackTrace?.length);
  console.log(
    `脚本触发的强制 Layout(带调用栈): ${forced.length} 次,合计 ${ms(forced.reduce((s, e) => s + e.dur!, 0))}ms`,
  );
  const forcedSrc = new Map<string, { c: number; t: number }>();
  for (const e of forced) {
    const f = e.args.beginData.stackTrace[0];
    const k = `${f.functionName || '(anon)'} @ ${(f.url || '').split('/').slice(-1)[0]}:${f.lineNumber}`;
    if (!forcedSrc.has(k)) forcedSrc.set(k, { c: 0, t: 0 });
    const v = forcedSrc.get(k)!;
    v.c++;
    v.t += e.dur!;
  }
  if (forcedSrc.size) {
    console.log('--- 强制重排来源(top 10)---');
    [...forcedSrc.entries()]
      .sort((a, b) => b[1].t - a[1].t)
      .slice(0, 10)
      .forEach(([k, v]) => console.log(`${ms(v.t).padStart(9)}ms x${v.c}  ${k}`));
  }

  // GC
  const gcNames = [
    'MinorGC',
    'MajorGC',
    'V8.GCFinalizeMC',
    'BlinkGC.AtomicPhase',
    'CppGC.IncrementalSweep',
    'V8.GCScavenger',
  ];
  for (const n of gcNames) {
    const g = xs.filter(e => e.name === n);
    if (g.length)
      console.log(`GC ${n}: ${g.length} 次,合计 ${ms(g.reduce((s, e) => s + e.dur!, 0))}ms`);
  }

  // 按来源聚合
  const aggBy = (name: string, keyFn: (e: TraceEvent) => string) => {
    const m = new Map<string, { c: number; t: number }>();
    for (const e of xs.filter(e => e.name === name)) {
      const k = keyFn(e);
      if (!m.has(k)) m.set(k, { c: 0, t: 0 });
      const v = m.get(k)!;
      v.c++;
      v.t += e.dur!;
    }
    return [...m.entries()].sort((a, b) => b[1].t - a[1].t);
  };

  console.log('\n--- FunctionCall 按脚本来源(top 12)---');
  aggBy('FunctionCall', e => {
    const d = e.args?.data;
    return d
      ? `${d.functionName || '(anon)'} @ ${(d.url || '').split('/').slice(-1)[0]}:${d.lineNumber}`
      : '?';
  })
    .slice(0, 12)
    .forEach(([k, v]) => console.log(`${ms(v.t).padStart(9)}ms x${v.c}  ${k}`));

  console.log('\n--- EventDispatch 按事件类型(top 12)---');
  aggBy('EventDispatch', e => e.args?.data?.type || '?')
    .slice(0, 12)
    .forEach(([k, v]) => console.log(`${ms(v.t).padStart(9)}ms x${v.c}  ${k}`));

  console.log('\n--- TimerFire 按 timerId(top 5)---');
  aggBy('TimerFire', e => String(e.args?.data?.timerId ?? '?'))
    .slice(0, 5)
    .forEach(([k, v]) => console.log(`${ms(v.t).padStart(9)}ms x${v.c}  timerId=${k}`));

  const profCount = events.filter(e => e.name === 'Profile').length;
  const chunkCount = events.filter(e => e.name === 'ProfileChunk').length;
  console.log(
    `\nCPU profile: ${profCount} 个(${chunkCount} chunks)${profCount ? ',可用 profile / callers 命令深入' : ''}`,
  );
}

// ---------- profile ----------
function buildProfile(
  events: TraceEvent[],
  pid: number,
): {
  nodes: Map<number, ProfNode>;
  samples: number[];
  deltas: number[];
} {
  const profEv = events.filter(
    e => (e.name === 'Profile' || e.name === 'ProfileChunk') && e.pid === pid,
  );
  const nodes = new Map<number, ProfNode>();
  const samples: number[] = [];
  const deltas: number[] = [];
  for (const e of profEv) {
    const cp = e.args?.data?.cpuProfile;
    if (cp?.nodes)
      for (const n of cp.nodes) {
        const cf = n.callFrame || n;
        nodes.set(n.id, {
          id: n.id,
          fn: cf.functionName || '(anon)',
          url: cf.url || '',
          line: cf.lineNumber,
          parent: n.parent,
          self: 0,
          total: 0,
        });
      }
    if (cp?.samples) samples.push(...cp.samples);
    if (e.args?.data?.timeDeltas) deltas.push(...e.args.data.timeDeltas);
  }
  for (let i = 0; i < samples.length; i++) {
    const n = nodes.get(samples[i]);
    if (n) n.self += deltas[i] || 0;
  }
  return { nodes, samples, deltas };
}

const nodeLabel = (n: ProfNode) =>
  `${n.fn} @ ${n.url.split('/').slice(-1)[0]}${n.line != null ? ':' + n.line : ''}`;

function cmdProfile(events: TraceEvent[], pid: number): void {
  const { nodes, samples } = buildProfile(events, pid);
  console.log('profile nodes:', nodes.size, 'samples:', samples.length);
  if (!samples.length) {
    console.log('trace 中没有 CPU profile(录制时需勾选 JavaScript samples)');
    return;
  }

  const selfAgg = new Map<string, number>();
  for (const n of nodes.values()) {
    if (!n.self) continue;
    const k = nodeLabel(n);
    selfAgg.set(k, (selfAgg.get(k) || 0) + n.self);
  }
  console.log('\n--- CPU profile: self-time 按函数(top 35)---');
  [...selfAgg.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 35)
    .forEach(([k, t]) => console.log(`${ms(t).padStart(9)}ms  ${k}`));

  // total(inclusive):self 沿祖先链向上累加
  for (const n of nodes.values()) {
    let cur: ProfNode | undefined = n;
    const seen = new Set<ProfNode>();
    while (cur) {
      if (seen.has(cur)) break;
      seen.add(cur);
      cur.total += n.self;
      cur = cur.parent != null ? nodes.get(cur.parent) : undefined;
    }
  }
  const totAgg = new Map<string, number>();
  for (const n of nodes.values()) {
    if (!n.total) continue;
    const k = nodeLabel(n);
    totAgg.set(k, Math.max(totAgg.get(k) || 0, n.total));
  }
  console.log('\n--- CPU profile: total(inclusive)按函数(top 35)---');
  [...totAgg.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 35)
    .forEach(([k, t]) => console.log(`${ms(t).padStart(9)}ms  ${k}`));
}

function cmdCallers(events: TraceEvent[], pid: number, pattern: string): void {
  const { nodes } = buildProfile(events, pid);
  const re = new RegExp(pattern, 'i');
  const hot = [...nodes.values()]
    .filter(n => (re.test(n.fn) || re.test(n.url)) && n.self > 10000)
    .sort((a, b) => b.self - a.self)
    .slice(0, 6);
  if (!hot.length) {
    console.log(`没有 self>10ms 且匹配 /${pattern}/i 的函数`);
    return;
  }
  for (const h of hot) {
    const chain: string[] = [];
    let cur: ProfNode | undefined = h;
    while (cur && chain.length < 20) {
      chain.push(nodeLabel(cur));
      cur = cur.parent != null ? nodes.get(cur.parent) : undefined;
    }
    console.log(`\nself=${ms(h.self)}ms  ${chain[0]}\n  ${chain.slice(1).join('\n  <- ')}`);
  }
}

// ---------- timeline ----------
function cmdTimeline(events: TraceEvent[], pid: number, tid: number, pattern: string): void {
  const xs = mainEvents(events, pid, tid);
  let t0 = Infinity;
  for (const e of xs) if (e.ts < t0) t0 = e.ts;
  const re = new RegExp(pattern, 'i');
  const matched = xs
    .filter(e => {
      if (re.test(e.name)) return true;
      const u = e.args?.data?.url || '';
      return e.name === 'FunctionCall' && re.test(u) && e.dur! > 10000;
    })
    .sort((a, b) => a.ts - b.ts);

  console.log(`--- 匹配 /${pattern}/i 的事件时间线(>10ms 的 FunctionCall / 全部同名事件)---`);
  for (const e of matched.slice(0, 40)) {
    const d = e.args?.data;
    const src = d?.url ? ` ${(d.url || '').split('/').slice(-1)[0]}:${d.lineNumber}` : '';
    console.log(
      `@${((e.ts - t0) / 1000).toFixed(0).padStart(6)}ms dur=${ms(e.dur!).padStart(7)}ms ${e.name}${src}`,
    );
  }

  const recalc = xs.filter(e => e.name === 'UpdateLayoutTree');
  const buckets = new Map<number, { c: number; t: number }>();
  for (const e of recalc) {
    const b = Math.floor((e.ts - t0) / 500000);
    if (!buckets.has(b)) buckets.set(b, { c: 0, t: 0 });
    const v = buckets.get(b)!;
    v.c++;
    v.t += e.dur!;
  }
  console.log('\n--- UpdateLayoutTree 每 500ms 分桶(次数 / 耗时)---');
  [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .forEach(([b, v]) =>
      console.log(
        `${(b * 500).toString().padStart(6)}ms: ${String(v.c).padStart(4)} 次, ${(v.t / 1000).toFixed(0)}ms`,
      ),
    );
}

// ---------- 入口 ----------
function parsePidTid(arg: string | undefined, fallback: { pid: number; tid: number }) {
  if (!arg) return fallback;
  const m = arg.match(/^(\d+)(?::(\d+))?$/);
  if (!m) return fallback;
  return { pid: Number(m[1]), tid: m[2] ? Number(m[2]) : fallback.tid };
}

const [file, command = 'overview', ...rest] = process.argv.slice(2);
if (!file) {
  console.error(
    '用法: pnpm tsx analyze-trace.ts <trace.json> [overview|main|profile|callers <pattern>|timeline <pattern>] [pid:tid]',
  );
  process.exit(1);
}

const events = load(file);
const auto = command === 'overview' ? null : detectMainThread(events);

switch (command) {
  case 'overview':
    cmdOverview(events);
    break;
  case 'main': {
    const { pid, tid } = parsePidTid(rest[0], auto!);
    cmdMain(events, pid, tid);
    break;
  }
  case 'profile': {
    const { pid } = parsePidTid(rest[0], auto!);
    cmdProfile(events, pid);
    break;
  }
  case 'callers': {
    if (!rest[0]) {
      console.error('用法: callers <pattern> [pid]');
      process.exit(1);
    }
    const { pid } = parsePidTid(rest[1], auto!);
    cmdCallers(events, pid, rest[0]);
    break;
  }
  case 'timeline': {
    if (!rest[0]) {
      console.error('用法: timeline <pattern> [pid:tid]');
      process.exit(1);
    }
    const { pid, tid } = parsePidTid(rest[1], auto!);
    cmdTimeline(events, pid, tid, rest[0]);
    break;
  }
  default:
    console.error(`未知命令: ${command}`);
    process.exit(1);
}
