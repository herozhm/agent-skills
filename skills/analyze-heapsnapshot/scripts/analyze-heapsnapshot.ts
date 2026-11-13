#!/usr/bin/env -S pnpm tsx
/**
 * Chrome / V8 .heapsnapshot 内存快照分析工具
 *
 * 用法:
 *   NODE_OPTIONS=--max-old-space-size=8192 pnpm tsx analyze-heapsnapshot.ts <snapshot.heapsnapshot> [command] [args]
 *
 * 命令:
 *   overview                       快照规模、按节点类型的浅大小(self_size)分布、detached 节点数
 *   summary [topN]                 按构造函数/类名聚合实例数 + 浅大小(对应 DevTools Summary 视图),默认 top 40
 *   detached [topN]                detached DOM 节点(内存泄露重灾区),分组 + 每组一条最短 retainer 路径
 *   biggest [topN]                 retained size(支配树)top 对象:"谁独占了最多内存",默认 top 30(重命令)
 *   nodes <pattern> [topN]         列出 name 匹配 /pattern/i 的实例节点(id / self_size / detached)
 *   retainers <pattern> [count]    name 匹配的节点的最短 retainer 路径(root -> ... -> 对象),默认前 5 个
 *   strings [topN]                 重复字符串聚合(按总浅大小),定位字符串膨胀 / 未复用
 *   diff <other.heapsnapshot>      与另一快照按类名做 count / size 增量对比(泄露定位的核心流程)
 *
 * 说明:
 *   - 大快照(>200MB / 数百万节点)JSON.parse 很吃内存,必须加 --max-old-space-size,8192 起步,超大用 16384。
 *   - biggest 需要构建支配树,是最重的命令;先用 summary / diff / detached 定位,再用它确认"谁在独占内存"。
 */

import { readFileSync, statSync } from 'node:fs';

// Node 单个字符串上限 ~512MiB(0x1fffffe8);超过则不能 readFileSync('utf8') 整读
const MAX_STRING = 0x1fffffe8;

interface RawSnapshot {
  snapshot: {
    meta: {
      node_fields: string[];
      node_types: (string[] | string)[];
      edge_fields: string[];
      edge_types: (string[] | string)[];
    };
    node_count: number;
    edge_count: number;
  };
  nodes: number[] | Float64Array;
  edges: number[] | Float64Array;
  strings: string[];
}

/** 解析后的快照视图:提供按序号(ordinal)访问节点 / 边的访问器 */
class Snapshot {
  nodes: number[] | Float64Array;
  edges: number[] | Float64Array;
  strings: string[];
  nodeTypes: string[];
  edgeTypes: string[];

  NF: number; // node_fields 个数(每个节点占用的整数个数)
  EF: number; // edge_fields 个数
  nodeCount: number;

  // 节点字段下标
  niType: number;
  niName: number;
  niId: number;
  niSelf: number;
  niEdgeCount: number;
  niDetached: number; // -1 表示该快照不含 detachedness 字段

  // 边字段下标
  eiType: number;
  eiName: number;
  eiTo: number;

  /** firstEdge[i] = 节点 i 的第一条边的全局边序号;长度 nodeCount+1 */
  firstEdge: Uint32Array;

  // 反向边(retainer)CSR,按需构建
  private revFirst?: Uint32Array;
  private revSrc?: Uint32Array; // 指向该节点的源节点 ordinal
  private revEdge?: Uint32Array; // 对应的边序号(用于还原边名)

  constructor(raw: RawSnapshot) {
    this.nodes = raw.nodes;
    this.edges = raw.edges;
    this.strings = raw.strings;
    const meta = raw.snapshot.meta;
    this.nodeTypes = meta.node_types[0] as string[];
    this.edgeTypes = meta.edge_types[0] as string[];

    const nf = meta.node_fields;
    const ef = meta.edge_fields;
    this.NF = nf.length;
    this.EF = ef.length;
    this.niType = nf.indexOf('type');
    this.niName = nf.indexOf('name');
    this.niId = nf.indexOf('id');
    this.niSelf = nf.indexOf('self_size');
    this.niEdgeCount = nf.indexOf('edge_count');
    this.niDetached = nf.indexOf('detachedness');
    this.eiType = ef.indexOf('type');
    this.eiName = ef.indexOf('name_or_index');
    this.eiTo = ef.indexOf('to_node');

    this.nodeCount = this.nodes.length / this.NF;

    // 边按源节点顺序排列;前缀和得到每个节点的第一条边序号
    this.firstEdge = new Uint32Array(this.nodeCount + 1);
    let acc = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      this.firstEdge[i] = acc;
      acc += this.nodes[i * this.NF + this.niEdgeCount];
    }
    this.firstEdge[this.nodeCount] = acc;
  }

  nodeName(i: number): string {
    return this.strings[this.nodes[i * this.NF + this.niName]] ?? '';
  }
  nodeTypeName(i: number): string {
    return this.nodeTypes[this.nodes[i * this.NF + this.niType]] ?? '?';
  }
  nodeId(i: number): number {
    return this.nodes[i * this.NF + this.niId];
  }
  nodeSelf(i: number): number {
    return this.nodes[i * this.NF + this.niSelf];
  }
  isDetached(i: number): boolean {
    if (this.niDetached >= 0 && this.nodes[i * this.NF + this.niDetached] === 2) return true;
    // 老快照无 detachedness 字段:回退到名字判断
    return this.nodeName(i).startsWith('Detached ');
  }

  /** node ordinal -> 它的出边序号区间 [start, end) */
  edgeRange(i: number): [number, number] {
    return [this.firstEdge[i], this.firstEdge[i + 1]];
  }
  /** 边序号 -> 目标节点 ordinal */
  edgeTo(eo: number): number {
    return this.edges[eo * this.EF + this.eiTo] / this.NF;
  }
  /** 边序号 -> 可读边名(属性名 / [下标]) */
  edgeName(eo: number): string {
    const base = eo * this.EF;
    const t = this.edgeTypes[this.edges[base + this.eiType]];
    const noi = this.edges[base + this.eiName];
    if (t === 'element' || t === 'hidden') return `[${noi}]`;
    return this.strings[noi] ?? `[${noi}]`;
  }

  /** 构造函数/类名分组键,对齐 DevTools Summary 的聚合方式 */
  className(i: number): string {
    const t = this.nodeTypeName(i);
    const name = this.nodeName(i);
    switch (t) {
      case 'string':
      case 'concatenated string':
      case 'sliced string':
        return '(string)';
      case 'array':
        return name || '(array)';
      case 'code':
        return '(compiled code)';
      case 'closure':
        return name ? `${name}()` : '(closure)';
      case 'regexp':
        return '(regexp)';
      case 'number':
      case 'bigint':
        return '(heap number)';
      case 'symbol':
        return '(symbol)';
      case 'hidden':
        return name || '(system)';
      case 'synthetic':
        return name || '(synthetic)';
      default:
        return name || `(${t})`;
    }
  }

  buildReverse(): void {
    if (this.revFirst) return;
    const totalEdges = this.firstEdge[this.nodeCount];
    const inDeg = new Uint32Array(this.nodeCount);
    for (let eo = 0; eo < totalEdges; eo++) inDeg[this.edgeTo(eo)]++;
    const revFirst = new Uint32Array(this.nodeCount + 1);
    let acc = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      revFirst[i] = acc;
      acc += inDeg[i];
    }
    revFirst[this.nodeCount] = acc;
    const cursor = revFirst.slice(0, this.nodeCount);
    const revSrc = new Uint32Array(totalEdges);
    const revEdge = new Uint32Array(totalEdges);
    for (let src = 0; src < this.nodeCount; src++) {
      const [s, e] = this.edgeRange(src);
      for (let eo = s; eo < e; eo++) {
        const to = this.edgeTo(eo);
        const pos = cursor[to]++;
        revSrc[pos] = src;
        revEdge[pos] = eo;
      }
    }
    this.revFirst = revFirst;
    this.revSrc = revSrc;
    this.revEdge = revEdge;
  }

  /**
   * 从根(ordinal 0)到 target 的最短 retainer 路径。
   * 反向 BFS:从 target 沿反向边走,首次抵达根即最短。
   * 返回 [{node, edgeName}],第一个是根,最后一个是 target。
   */
  retainerPath(target: number, cap = 3_000_000): { node: number; edge: string }[] | null {
    this.buildReverse();
    const next = new Map<number, { to: number; eo: number }>(); // node -> 它指向的下一跳(朝 target 方向)
    next.set(target, { to: -1, eo: -1 });
    const queue = [target];
    let head = 0;
    let visited = 0;
    while (head < queue.length) {
      const cur = queue[head++];
      if (++visited > cap) return null;
      if (cur === 0) {
        // 回溯:从根沿 next 链走到 target
        const path: { node: number; edge: string }[] = [];
        let n = 0;
        while (n !== -1) {
          const link = next.get(n)!;
          path.push({ node: n, edge: link.eo >= 0 ? this.edgeName(link.eo) : '' });
          n = link.to;
        }
        return path;
      }
      const s = this.revFirst![cur];
      const e = this.revFirst![cur + 1];
      for (let p = s; p < e; p++) {
        const src = this.revSrc![p];
        if (next.has(src)) continue;
        next.set(src, { to: cur, eo: this.revEdge![p] });
        queue.push(src);
      }
    }
    return null;
  }
}

const bytes = (n: number): string => {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
};

const WS = (c: number) => c === 0x20 || c === 9 || c === 10 || c === 13;

/**
 * 大快照(>512MiB)Buffer 流式解析:不把整个文件做成字符串,绕开 Node 字符串长度上限。
 * 先结构化扫描顶层对象拿到各 value 的字节区间,再按类型解析。
 */
function topLevelRanges(buf: Buffer): Map<string, [number, number]> {
  const ranges = new Map<string, [number, number]>();
  const n = buf.length;
  let i = 0;
  while (i < n && buf[i] !== 0x7b /* { */) i++;
  i++;
  while (i < n) {
    while (i < n && (WS(buf[i]) || buf[i] === 0x2c) /* , */) i++;
    if (i >= n || buf[i] === 0x7d /* } */) break;
    if (buf[i] !== 0x22 /* " */) {
      i++;
      continue;
    }
    const ks = i;
    i++;
    while (i < n) {
      const c = buf[i];
      if (c === 0x5c /* \ */) {
        i += 2;
        continue;
      }
      if (c === 0x22) {
        i++;
        break;
      }
      i++;
    }
    const key = JSON.parse(buf.toString('utf8', ks, i)) as string;
    while (i < n && WS(buf[i])) i++;
    if (buf[i] === 0x3a /* : */) i++;
    while (i < n && WS(buf[i])) i++;
    const vs = i;
    const c = buf[i];
    if (c === 0x7b || c === 0x5b) {
      // 平衡括号跳过(处理嵌套与字符串内的括号)
      let depth = 0;
      let inStr = false;
      for (; i < n; i++) {
        const ch = buf[i];
        if (inStr) {
          if (ch === 0x5c) {
            i++;
            continue;
          }
          if (ch === 0x22) inStr = false;
          continue;
        }
        if (ch === 0x22) {
          inStr = true;
          continue;
        }
        if (ch === 0x7b || ch === 0x5b) depth++;
        else if (ch === 0x7d || ch === 0x5d) {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
    } else if (c === 0x22) {
      i++;
      while (i < n) {
        const ch = buf[i];
        if (ch === 0x5c) {
          i += 2;
          continue;
        }
        if (ch === 0x22) {
          i++;
          break;
        }
        i++;
      }
    } else {
      while (i < n && !(buf[i] === 0x2c || buf[i] === 0x7d || buf[i] === 0x5d || WS(buf[i]))) i++;
    }
    ranges.set(key, [vs, i]);
  }
  return ranges;
}

/**
 * 解析整数数组(nodes / edges):两遍扫描字节,只含数字/逗号/空白/中括号。
 * 先数出 token 数,再填充预分配的 Float64Array —— 避免超大普通数组 push 增长时
 * V8 backing store 抛 RangeError,同时内存更紧凑(数亿元素级快照必需)。
 */
function parseIntArray(buf: Buffer, start: number, end: number): Float64Array {
  let i0 = start;
  while (i0 < end && buf[i0] !== 0x5b /* [ */) i0++;
  i0++;
  // pass 1: 计数
  let count = 0;
  {
    let inNum = false;
    for (let i = i0; i < end; i++) {
      const c = buf[i];
      if ((c >= 0x30 && c <= 0x39) || c === 0x2d /* - */) {
        inNum = true;
      } else {
        if (inNum) {
          count++;
          inNum = false;
        }
        if (c === 0x5d /* ] */) break;
      }
    }
  }
  // pass 2: 填充
  const out = new Float64Array(count);
  let w = 0;
  let num = 0;
  let inNum = false;
  let neg = false;
  for (let i = i0; i < end; i++) {
    const c = buf[i];
    if (c >= 0x30 && c <= 0x39) {
      num = num * 10 + (c - 0x30);
      inNum = true;
    } else if (c === 0x2d /* - */) {
      neg = true;
      inNum = true;
    } else {
      if (inNum) {
        out[w++] = neg ? -num : num;
        num = 0;
        inNum = false;
        neg = false;
      }
      if (c === 0x5d /* ] */) break;
    }
  }
  return out;
}

/** 解析字符串数组:逐元素 buffer.toString + JSON.parse(单个 token 很小,不触发长度上限) */
function parseStringArray(buf: Buffer, start: number, end: number): string[] {
  const out: string[] = [];
  let i = start;
  while (i < end && buf[i] !== 0x5b /* [ */) i++;
  i++;
  while (i < end) {
    while (i < end && (WS(buf[i]) || buf[i] === 0x2c)) i++;
    if (i >= end || buf[i] === 0x5d) break;
    if (buf[i] !== 0x22) {
      i++;
      continue;
    }
    const s = i;
    i++;
    while (i < end) {
      const c = buf[i];
      if (c === 0x5c) {
        i += 2;
        continue;
      }
      if (c === 0x22) {
        i++;
        break;
      }
      i++;
    }
    out.push(JSON.parse(buf.toString('utf8', s, i)) as string);
  }
  return out;
}

function loadLarge(file: string): Snapshot {
  const buf = readFileSync(file); // Buffer 可远大于字符串上限
  const ranges = topLevelRanges(buf);
  const snapR = ranges.get('snapshot');
  const nodesR = ranges.get('nodes');
  const edgesR = ranges.get('edges');
  const strR = ranges.get('strings');
  if (!snapR || !nodesR || !strR) {
    throw new Error('不是有效的 .heapsnapshot(顶层缺少 snapshot / nodes / strings)');
  }
  const snapshot = JSON.parse(buf.toString('utf8', snapR[0], snapR[1]));
  const raw: RawSnapshot = {
    snapshot,
    nodes: parseIntArray(buf, nodesR[0], nodesR[1]),
    edges: edgesR ? parseIntArray(buf, edgesR[0], edgesR[1]) : [],
    strings: parseStringArray(buf, strR[0], strR[1]),
  };
  return new Snapshot(raw);
}

function load(file: string): Snapshot {
  const size = statSync(file).size;
  if (size >= MAX_STRING) {
    console.error(`[大快照 ${(size / 1024 / 1024).toFixed(0)}MB,启用 Buffer 流式解析]`);
    return loadLarge(file);
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as RawSnapshot;
  if (!raw.nodes || !raw.snapshot?.meta) {
    throw new Error('不是有效的 .heapsnapshot(缺少 nodes / snapshot.meta)');
  }
  return new Snapshot(raw);
}

/** 按类名聚合:key -> { count, self } */
function aggregateByClass(s: Snapshot): Map<string, { count: number; self: number }> {
  const agg = new Map<string, { count: number; self: number }>();
  for (let i = 0; i < s.nodeCount; i++) {
    const k = s.className(i);
    let v = agg.get(k);
    if (!v) {
      v = { count: 0, self: 0 };
      agg.set(k, v);
    }
    v.count++;
    v.self += s.nodeSelf(i);
  }
  return agg;
}

// ---------- overview ----------
function cmdOverview(s: Snapshot): void {
  console.log(
    `节点数: ${s.nodeCount.toLocaleString()}  边数: ${s.firstEdge[s.nodeCount].toLocaleString()}`,
  );
  console.log(
    `node_fields(${s.NF}): detachedness 字段${s.niDetached >= 0 ? '存在' : '缺失(老快照,只能按名字判断 detached)'}`,
  );

  const byType = new Map<string, { count: number; self: number }>();
  let totalSelf = 0;
  let detached = 0;
  for (let i = 0; i < s.nodeCount; i++) {
    const t = s.nodeTypeName(i);
    const self = s.nodeSelf(i);
    totalSelf += self;
    let v = byType.get(t);
    if (!v) {
      v = { count: 0, self: 0 };
      byType.set(t, v);
    }
    v.count++;
    v.self += self;
    if (s.isDetached(i)) detached++;
  }
  console.log(`\n总浅大小(self_size 合计): ${bytes(totalSelf)}`);
  console.log(
    `detached 节点: ${detached.toLocaleString()} 个${detached ? '  ← 用 detached 命令展开' : ''}`,
  );

  console.log('\n--- 按节点类型的浅大小分布 ---');
  [...byType.entries()]
    .sort((a, b) => b[1].self - a[1].self)
    .forEach(([t, v]) =>
      console.log(`${bytes(v.self).padStart(10)}  x${String(v.count).padStart(10)}  ${t}`),
    );
}

// ---------- summary ----------
function cmdSummary(s: Snapshot, topN: number): void {
  const agg = aggregateByClass(s);
  console.log(`--- 按类名聚合(浅大小 top ${topN},对齐 DevTools Summary)---`);
  console.log(`${'浅大小'.padStart(8)}  ${'实例数'.padStart(12)}  类名`);
  [...agg.entries()]
    .sort((a, b) => b[1].self - a[1].self)
    .slice(0, topN)
    .forEach(([k, v]) =>
      console.log(`${bytes(v.self).padStart(10)}  x${String(v.count).padStart(11)}  ${k}`),
    );
}

// ---------- detached ----------
function cmdDetached(s: Snapshot, topN: number): void {
  const detached: number[] = [];
  for (let i = 0; i < s.nodeCount; i++) if (s.isDetached(i)) detached.push(i);
  if (!detached.length) {
    console.log('未发现 detached 节点(快照很干净,或为老快照无 detachedness 字段)。');
    return;
  }
  // 分组
  const groups = new Map<string, { count: number; self: number; sample: number }>();
  for (const i of detached) {
    const k = s.className(i);
    let v = groups.get(k);
    if (!v) {
      v = { count: 0, self: 0, sample: i };
      groups.set(k, v);
    }
    v.count++;
    v.self += s.nodeSelf(i);
  }
  console.log(`--- detached 节点共 ${detached.length} 个,按类名分组(top ${topN})---`);
  const sorted = [...groups.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, topN);
  for (const [k, v] of sorted) {
    console.log(`\n■ ${k}  x${v.count}  ${bytes(v.self)}`);
    const path = s.retainerPath(v.sample);
    if (!path) {
      console.log('  (未在限定步数内找到 retainer 路径)');
      continue;
    }
    printPath(s, path, '  ');
  }
  console.log(
    '\n提示: detached 节点仍被 JS 引用 = DOM 泄露;沿上面的 retainer 路径找到第一个业务对象即泄露持有方。',
  );
}

// ---------- nodes ----------
function cmdNodes(s: Snapshot, pattern: string, topN: number): void {
  const re = new RegExp(pattern, 'i');
  const hits: number[] = [];
  for (let i = 0; i < s.nodeCount; i++) {
    if (re.test(s.nodeName(i))) hits.push(i);
    if (hits.length > 200000) break;
  }
  hits.sort((a, b) => s.nodeSelf(b) - s.nodeSelf(a));
  console.log(
    `--- name 匹配 /${pattern}/i 的节点: ${hits.length}${hits.length > 200000 ? '+' : ''} 个(按浅大小 top ${topN})---`,
  );
  for (const i of hits.slice(0, topN)) {
    console.log(
      `@${s.nodeId(i)}  ${bytes(s.nodeSelf(i)).padStart(9)}  ${s.nodeTypeName(i)}  ${s.nodeName(i)}${s.isDetached(i) ? '  [DETACHED]' : ''}`,
    );
  }
}

// ---------- retainers ----------
function printPath(s: Snapshot, path: { node: number; edge: string }[], indent: string): void {
  // path[0] 是根,最后是目标;打印成 目标 <- 持有方 <- ... <- 根
  for (let k = path.length - 1; k >= 0; k--) {
    const { node, edge } = path[k];
    const label = `${s.className(node)} @${s.nodeId(node)}`;
    if (k === path.length - 1) {
      console.log(`${indent}${label}`);
    } else {
      // 第 k 层节点通过 edge 指向第 k+1 层(更靠近目标)
      console.log(`${indent}  ↑ .${edge}`);
      console.log(`${indent}${label}`);
    }
  }
}

/** 匹配节点:`@<id>` 精确按节点 id 命中(用于锁定 biggest 列出的具体大对象);否则按 name 正则 */
function matchNodes(s: Snapshot, pattern: string, limit: number): number[] {
  const idMatch = /^@?(\d+)$/.exec(pattern);
  if (idMatch && pattern.startsWith('@')) {
    const id = Number(idMatch[1]);
    for (let i = 0; i < s.nodeCount; i++) if (s.nodeId(i) === id) return [i];
    return [];
  }
  const re = new RegExp(pattern, 'i');
  const hits: number[] = [];
  for (let i = 0; i < s.nodeCount; i++) {
    if (re.test(s.nodeName(i))) hits.push(i);
    if (hits.length >= limit) break;
  }
  return hits;
}

function cmdRetainers(s: Snapshot, pattern: string, count: number): void {
  const hits = matchNodes(s, pattern, count);
  if (!hits.length) {
    console.log(`没有 name 匹配 /${pattern}/i 的节点`);
    return;
  }
  console.log(`--- /${pattern}/i 的 retainer 路径(目标在上,根在下;前 ${hits.length} 个)---`);
  for (const i of hits) {
    console.log(`\n● ${s.className(i)} @${s.nodeId(i)}  ${bytes(s.nodeSelf(i))}`);
    const path = s.retainerPath(i);
    if (!path) {
      console.log('  (未在限定步数内找到 retainer 路径,可能是不可达/将被回收对象)');
      continue;
    }
    printPath(s, path, '  ');
  }
}

// ---------- byid ----------
function cmdById(s: Snapshot, id: number): void {
  let ord = -1;
  for (let i = 0; i < s.nodeCount; i++) {
    if (s.nodeId(i) === id) {
      ord = i;
      break;
    }
  }
  if (ord < 0) {
    console.log(`没有 id=${id} 的节点`);
    return;
  }
  console.log(
    `节点 @${id}: ${s.className(ord)}  type=${s.nodeTypeName(ord)}  self=${bytes(s.nodeSelf(ord))}  name="${s.nodeName(ord).slice(0, 120)}"`,
  );
  console.log('\n--- 出边(该对象引用了谁,前 25 条)---');
  const [es, ee] = s.edgeRange(ord);
  let shown = 0;
  for (let eo = es; eo < ee && shown < 25; eo++, shown++) {
    const to = s.edgeTo(eo);
    console.log(
      `  .${s.edgeName(eo)} → ${s.className(to)} @${s.nodeId(to)} (${bytes(s.nodeSelf(to))})`,
    );
  }
  console.log('\n--- retainer 路径(目标在上,根在下)---');
  const path = s.retainerPath(ord);
  if (!path) console.log('  (未找到 retainer 路径)');
  else printPath(s, path, '  ');
}

// ---------- strings ----------
function cmdStrings(s: Snapshot, topN: number): void {
  const agg = new Map<string, { count: number; self: number }>();
  for (let i = 0; i < s.nodeCount; i++) {
    const t = s.nodeTypeName(i);
    if (t !== 'string' && t !== 'concatenated string' && t !== 'sliced string') continue;
    const val = s.nodeName(i);
    let v = agg.get(val);
    if (!v) {
      v = { count: 0, self: 0 };
      agg.set(val, v);
    }
    v.count++;
    v.self += s.nodeSelf(i);
  }
  console.log(`--- 重复字符串(按总浅大小 top ${topN};count>1 才提示复用问题)---`);
  [...agg.entries()]
    .filter(([, v]) => v.count > 1)
    .sort((a, b) => b[1].self - a[1].self)
    .slice(0, topN)
    .forEach(([val, v]) => {
      const preview = val.length > 80 ? val.slice(0, 77) + '...' : val;
      console.log(
        `${bytes(v.self).padStart(10)}  x${String(v.count).padStart(8)}  ${JSON.stringify(preview)}`,
      );
    });
}

// ---------- biggest (retained size via dominator tree) ----------
function cmdBiggest(s: Snapshot, topN: number): void {
  const N = s.nodeCount;
  console.error(`[构建支配树] 节点 ${N.toLocaleString()},可能较慢...`);

  // 1) 从根做迭代 DFS,得到可达节点的逆后序(RPO)编号
  const rpo = new Int32Array(N).fill(-1); // ordinal -> RPO 序号
  const order = new Int32Array(N); // RPO 序号 -> ordinal
  {
    const postorder = new Int32Array(N);
    const visited = new Uint8Array(N);
    // 迭代后序遍历
    const stackNode = new Int32Array(N);
    const stackEdge = new Float64Array(N);
    let sp = 0;
    let poIdx = 0;
    stackNode[sp] = 0;
    stackEdge[sp] = s.firstEdge[0];
    visited[0] = 1;
    while (sp >= 0) {
      const node = stackNode[sp];
      const end = s.firstEdge[node + 1];
      let eo = stackEdge[sp];
      let descended = false;
      while (eo < end) {
        const to = s.edgeTo(eo);
        eo++;
        if (!visited[to]) {
          visited[to] = 1;
          stackEdge[sp] = eo;
          sp++;
          stackNode[sp] = to;
          stackEdge[sp] = s.firstEdge[to];
          descended = true;
          break;
        }
      }
      if (!descended) {
        postorder[poIdx++] = node;
        sp--;
      }
    }
    // 逆后序:postorder 反过来,根的 RPO=0
    for (let k = 0; k < poIdx; k++) {
      const node = postorder[poIdx - 1 - k];
      rpo[node] = k;
      order[k] = node;
    }
    // 标记可达数量
    (order as any)._reachable = poIdx;
  }
  const reachable: number = (order as any)._reachable;

  // 2) 反向边(前驱)— 仅用于支配求解
  s.buildReverse();

  // 3) Cooper-Harvey-Kennedy 迭代支配算法,在 RPO 上做
  const idom = new Int32Array(reachable).fill(-1);
  idom[0] = 0; // 根的支配者是自身
  const revFirst = (s as any).revFirst as Uint32Array;
  const revSrc = (s as any).revSrc as Uint32Array;

  const intersect = (a: number, b: number): number => {
    while (a !== b) {
      while (a > b) a = idom[a];
      while (b > a) b = idom[b];
    }
    return a;
  };

  let changed = true;
  while (changed) {
    changed = false;
    // 按 RPO 从 1 开始(跳过根)
    for (let r = 1; r < reachable; r++) {
      const node = order[r];
      let newIdom = -1;
      const ps = revFirst[node];
      const pe = revFirst[node + 1];
      for (let p = ps; p < pe; p++) {
        const predNode = revSrc[p];
        const predR = rpo[predNode];
        if (predR < 0) continue; // 前驱不可达
        if (idom[predR] === -1) continue; // 尚未处理
        newIdom = newIdom === -1 ? predR : intersect(newIdom, predR);
      }
      if (newIdom !== -1 && idom[r] !== newIdom) {
        idom[r] = newIdom;
        changed = true;
      }
    }
  }

  // 4) retained size:retained[v] = self[v] + Σ retained[被 v 支配的子节点]
  const retained = new Float64Array(reachable);
  for (let r = 0; r < reachable; r++) retained[r] = s.nodeSelf(order[r]);
  // 逆 RPO(叶子在前)累加到支配者
  for (let r = reachable - 1; r >= 1; r--) {
    const d = idom[r];
    if (d >= 0 && d !== r) retained[d] += retained[r];
  }

  // 5) 输出 top(排除根)
  const idx: number[] = [];
  for (let r = 1; r < reachable; r++) idx.push(r);
  idx.sort((a, b) => retained[b] - retained[a]);

  console.log(`--- retained size top ${topN}(支配树;"删掉它能释放多少")---`);
  console.log(`可达节点 ${reachable.toLocaleString()} / 总 ${N.toLocaleString()}`);
  console.log(`${'retained'.padStart(10)}  ${'self'.padStart(9)}  类名 @id`);
  for (const r of idx.slice(0, topN)) {
    const node = order[r];
    console.log(
      `${bytes(retained[r]).padStart(12)}  ${bytes(s.nodeSelf(node)).padStart(9)}  ${s.className(node)} @${s.nodeId(node)}${s.isDetached(node) ? ' [DETACHED]' : ''}`,
    );
  }
  console.log(
    '\n提示: retained 远大于 self 的节点是"内存黑洞";若它是数组/Map/闭包且持续变大,多半是泄露累积点。配合 retainers 命令看谁持有它。',
  );
}

// ---------- diff ----------
function summaryMap(file: string): {
  map: Map<string, { count: number; self: number }>;
  total: number;
} {
  const s = load(file);
  const map = aggregateByClass(s);
  let total = 0;
  for (let i = 0; i < s.nodeCount; i++) total += s.nodeSelf(i);
  return { map, total };
}

function cmdDiff(fileA: string, fileB: string): void {
  console.error('[diff] 解析快照 A...');
  const a = summaryMap(fileA);
  console.error('[diff] 解析快照 B...');
  const b = summaryMap(fileB);

  console.log(`快照 A 总浅大小: ${bytes(a.total)}`);
  console.log(`快照 B 总浅大小: ${bytes(b.total)}`);
  console.log(`增量: ${b.total >= a.total ? '+' : ''}${bytes(b.total - a.total)}\n`);

  const keys = new Set([...a.map.keys(), ...b.map.keys()]);
  const rows: { k: string; dCount: number; dSelf: number; bCount: number }[] = [];
  for (const k of keys) {
    const va = a.map.get(k) ?? { count: 0, self: 0 };
    const vb = b.map.get(k) ?? { count: 0, self: 0 };
    rows.push({ k, dCount: vb.count - va.count, dSelf: vb.self - va.self, bCount: vb.count });
  }

  console.log('--- 类名 size 增长 top 30(B - A;正数 = 在 B 里变大,泄露嫌疑)---');
  console.log(`${'Δsize'.padStart(11)}  ${'Δcount'.padStart(9)}  ${'B count'.padStart(9)}  类名`);
  rows
    .filter(r => r.dSelf > 0)
    .sort((x, y) => y.dSelf - x.dSelf)
    .slice(0, 30)
    .forEach(r =>
      console.log(
        `${('+' + bytes(r.dSelf)).padStart(11)}  ${('+' + r.dCount).padStart(9)}  ${String(r.bCount).padStart(9)}  ${r.k}`,
      ),
    );

  console.log('\n--- 实例数增长 top 20(只增不减 = 经典泄露:监听器/缓存/闭包累积)---');
  console.log(`${'Δcount'.padStart(9)}  ${'Δsize'.padStart(11)}  类名`);
  rows
    .filter(r => r.dCount > 0)
    .sort((x, y) => y.dCount - x.dCount)
    .slice(0, 20)
    .forEach(r =>
      console.log(
        `${('+' + r.dCount).padStart(9)}  ${('+' + bytes(r.dSelf)).padStart(11)}  ${r.k}`,
      ),
    );
  console.log(
    '\n提示: 在 A、B 之间做同一操作 N 次再各抓一张快照;Δcount 随操作次数线性增长的类名就是泄露源。',
  );
}

// ---------- 入口 ----------
const [file, command = 'overview', ...rest] = process.argv.slice(2);
if (!file) {
  console.error(
    '用法: pnpm tsx analyze-heapsnapshot.ts <snapshot.heapsnapshot> [overview|summary|detached|biggest|nodes <pat>|retainers <pat>|strings|diff <other>]',
  );
  process.exit(1);
}

const intArg = (v: string | undefined, def: number) => (v && /^\d+$/.test(v) ? Number(v) : def);

switch (command) {
  case 'overview':
    cmdOverview(load(file));
    break;
  case 'summary':
    cmdSummary(load(file), intArg(rest[0], 40));
    break;
  case 'detached':
    cmdDetached(load(file), intArg(rest[0], 25));
    break;
  case 'biggest':
    cmdBiggest(load(file), intArg(rest[0], 30));
    break;
  case 'nodes':
    if (!rest[0]) {
      console.error('用法: nodes <pattern> [topN]');
      process.exit(1);
    }
    cmdNodes(load(file), rest[0], intArg(rest[1], 30));
    break;
  case 'retainers':
    if (!rest[0]) {
      console.error('用法: retainers <pattern> [count]');
      process.exit(1);
    }
    cmdRetainers(load(file), rest[0], intArg(rest[1], 5));
    break;
  case 'strings':
    cmdStrings(load(file), intArg(rest[0], 30));
    break;
  case 'byid':
    if (!rest[0]) {
      console.error('用法: byid <nodeId>');
      process.exit(1);
    }
    cmdById(load(file), Number(rest[0]));
    break;
  case 'diff':
    if (!rest[0]) {
      console.error('用法: diff <other.heapsnapshot>');
      process.exit(1);
    }
    cmdDiff(file, rest[0]);
    break;
  default:
    console.error(`未知命令: ${command}`);
    process.exit(1);
}
