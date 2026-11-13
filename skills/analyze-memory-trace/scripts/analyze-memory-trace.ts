import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';

process.stdout.on('error', (e: any) => {
  if (e.code === 'EPIPE') process.exit(0);
}); // piping to head/grep

// Chrome/Electron memory-infra trace (contentTracing dump) analyzer.
// Dumps live in events with ph 'v'/'V' and args.dumps: { allocators, totals?, level_of_detail }.
// allocator sizes are hex-string bytes under attrs.size.value (effective_size dedups shared mem).

const [, , file, cmd = 'overview', arg2] = process.argv;
if (!file) {
  console.error('usage: analyze-memory-trace.ts <trace.json> [overview|pid <pid>|timeline [pid]] ');
  process.exit(1);
}

const json = JSON.parse(readFileSync(file, 'utf8'));
const events: any[] = Array.isArray(json) ? json : json.traceEvents;

const pidName: Record<number, string> = {};
for (const e of events) {
  if (e.name === 'process_name' && e.args?.name) pidName[e.pid] = e.args.name;
  if (e.name === 'process_labels' && e.args?.labels) {
    pidName[e.pid] = (pidName[e.pid] ?? '') + ' | ' + e.args.labels;
  }
}

const mb = (b: number) => (b / 1048576).toFixed(1) + 'MB';
const name = (pid: number) => pidName[pid] ?? '?';
const num = (v: any): number => {
  if (v == null) return 0;
  return typeof v === 'string' ? parseInt(v, 16) : Number(v);
};
const size = (a: any): number => num(a?.attrs?.size?.value);
const effSize = (a: any): number => num(a?.attrs?.effective_size?.value ?? a?.attrs?.size?.value);

type Dump = { ts: number; pid: number; dumps: any };
const allDumps: Dump[] = [];
for (const e of events) {
  if ((e.ph === 'v' || e.ph === 'V') && e.args?.dumps) {
    allDumps.push({ ts: e.ts, pid: e.pid, dumps: e.args.dumps });
  }
}
const detailed = allDumps.filter(d => Object.keys(d.dumps.allocators ?? {}).length);

// last detailed dump per pid
const lastByPid: Record<number, Dump> = {};
for (const d of detailed) lastByPid[d.pid] = d;

// Process total proxy: prefer real footprint/RSS from totals, else sum of top-level allocator effective_size.
function totals(d: any): { footprint: number; rss: number; allocSum: number } {
  const t = d.totals ?? {};
  const allocs = d.allocators ?? {};
  let allocSum = 0;
  for (const k of Object.keys(allocs)) if (!k.includes('/')) allocSum += effSize(allocs[k]);
  return {
    footprint: num(t.private_footprint_bytes),
    rss: num(t.resident_set_bytes),
    allocSum,
  };
}
const totalOf = (t: ReturnType<typeof totals>) => t.footprint || t.rss || t.allocSum;

const t0 = detailed.length ? Math.min(...detailed.map(d => d.ts)) : 0;
const spanSec = detailed.length ? (Math.max(...detailed.map(d => d.ts)) - t0) / 1e6 : 0;

// memory-infra emits light + detailed dumps at the same tick; keep the largest per second.
function seriesOf(pid: number): { t: number; total: number }[] {
  const perSec: Record<number, number> = {};
  for (const d of detailed.filter(d => d.pid === pid)) {
    const t = Math.round((d.ts - t0) / 1e6);
    perSec[t] = Math.max(perSec[t] ?? 0, totalOf(totals(d.dumps)));
  }
  return Object.entries(perSec)
    .map(([t, total]) => ({ t: Number(t), total }))
    .sort((a, b) => a.t - b.t);
}

function overview() {
  console.log(`trace: ${file}`);
  console.log(`events=${events.length}  dumps=${allDumps.length}  detailed=${detailed.length}\n`);
  const rows = Object.values(lastByPid)
    .map(d => ({ pid: d.pid, t: totals(d.dumps), d }))
    .sort((a, b) => totalOf(b.t) - totalOf(a.t));
  for (const { pid, t, d } of rows) {
    const src = t.footprint ? 'footprint' : (t.rss ? 'rss' : 'Σtop-alloc');
    console.log(`===== pid ${pid}  [${name(pid)}] =====`);
    console.log(`  total ≈ ${mb(totalOf(t))}  (${src})`);
    const allocs = d.dumps.allocators ?? {};
    const top: [string, number][] = [];
    for (const k of Object.keys(allocs)) if (!k.includes('/')) top.push([k, effSize(allocs[k])]);
    top.sort((a, b) => b[1] - a[1]);
    for (const [k, v] of top) if (v > 1048576) console.log(`    ${mb(v).padStart(9)}  ${k}`);
    console.log('');
  }
}

function pidDetail(pid: number) {
  const d = lastByPid[pid];
  if (!d) return console.log(`no detailed dump for pid ${pid}`);
  const allocs = d.dumps.allocators ?? {};
  console.log(`===== pid ${pid}  [${name(pid)}] =====\n`);

  const isoTotals: Record<string, number> = {};
  const v8Big: [string, number][] = [];
  for (const k of Object.keys(allocs)) {
    if (!k.startsWith('v8/')) continue;
    const s = size(allocs[k]);
    const iso = k.split('/')[1] ?? '?';
    if (k.split('/').length === 2) isoTotals[iso] = (isoTotals[iso] ?? 0) + s;
    if (s > 2 * 1048576) v8Big.push([k, s]);
  }
  const isoRows = Object.entries(isoTotals).sort((a, b) => b[1] - a[1]);
  console.log(`V8 isolates = ${isoRows.length}`);
  for (const [iso, s] of isoRows) console.log(`  ${mb(s).padStart(9)}  isolate ${iso}`);

  console.log(`\nv8/* big sub-nodes (>2MB):`);
  v8Big.sort((a, b) => b[1] - a[1]);
  for (const [k, s] of v8Big.slice(0, 25)) console.log(`  ${mb(s).padStart(9)}  ${k}`);

  console.log(`\nblink/parkable/partition/malloc/skia/cc sub-nodes (>3MB):`);
  const rows = subNodes(
    allocs,
    /^(blink|parkable|partition_alloc|malloc|web_cache|discardable|cc|skia|gpu)/,
    3 * 1048576,
  );
  for (const [k, s] of rows.slice(0, 30)) console.log(`  ${mb(s).padStart(9)}  ${k}`);
}

function timeline(onlyPid?: number) {
  const pids = onlyPid ? [onlyPid] : [...new Set(detailed.map(d => d.pid))];
  for (const pid of pids) {
    const series = seriesOf(pid);
    if (!series.length) continue;
    console.log(`\n===== pid ${pid}  [${name(pid)}] =====`);
    let prev = 0;
    for (const { t, total } of series) {
      const delta = prev ? total - prev : 0;
      const sign = delta > 0 ? '+' : '';
      console.log(
        `  t+${t.toFixed(1).padStart(5)}s  ${mb(total).padStart(9)}  ${prev ? sign + mb(delta) : ''}`,
      );
      prev = total;
    }
  }
}

// ---- HTML report ----

const CAT_COLORS: Record<string, string> = {
  v8: '#f6c744',
  blink_gc: '#6ab0f3',
  malloc: '#e57373',
  parkable_strings: '#ba98e0',
  partition_alloc: '#4db6ac',
  cc: '#ffb74d',
  web_cache: '#a1c65d',
  gpu: '#7986cb',
  iosurface: '#4fc3f7',
  ioaccelerator: '#4dd0e1',
  skia: '#f06292',
  discardable: '#90a4ae',
  shared_memory: '#bcaaa4',
};
const catColor = (k: string) => CAT_COLORS[k] ?? '#9e9e9e';
const esc = (s: string) =>
  s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

function subNodes(allocs: any, re: RegExp, min: number) {
  const rows: [string, number][] = [];
  for (const k of Object.keys(allocs)) {
    if (re.test(k) && k.includes('/')) {
      const s = size(allocs[k]);
      if (s > min) rows.push([k, s]);
    }
  }
  return rows.sort((a, b) => b[1] - a[1]);
}

function htmlReport(outfile?: string) {
  const procs = Object.values(lastByPid)
    .map(d => {
      const allocs = d.dumps.allocators ?? {};
      const t = totals(d.dumps);
      const top: [string, number][] = [];
      for (const k of Object.keys(allocs)) if (!k.includes('/')) top.push([k, effSize(allocs[k])]);
      top.sort((a, b) => b[1] - a[1]);
      return {
        pid: d.pid,
        name: name(d.pid),
        total: totalOf(t),
        src: t.footprint ? 'footprint' : (t.rss ? 'rss' : 'Σtop-alloc'),
        top,
        allocs,
      };
    })
    .sort((a, b) => b.total - a.total);
  const grand = procs.reduce((s, p) => s + p.total, 0);
  const maxTotal = procs[0]?.total || 1;

  // timeline per pid
  const tl: Record<number, { t: number; total: number }[]> = {};
  for (const pid of new Set(detailed.map(d => d.pid))) tl[pid] = seriesOf(pid);

  // ---- 自动分析总结（启发式，基于分类总量推导）----
  const findings: { level: 'high' | 'mid' | 'tip'; title: string; detail: string }[] = [];
  const MB = 1048576;

  const renderers = procs.filter(p => p.name.includes('Renderer'));
  const rendTotal = renderers.reduce((s, p) => s + p.total, 0);
  findings.push({
    level: 'mid',
    title: `全进程合计 ≈ ${mb(grand)}，其中 ${renderers.length} 个 Renderer 占 ${mb(rendTotal)}`,
    detail: `最大进程 pid ${procs[0]?.pid}（${esc(procs[0]?.name ?? '')}）${mb(procs[0]?.total ?? 0)}。微前端架构下 home/editor 各是独立 Renderer，评估内存要把相关 Renderer 加总看。`,
  });

  for (const p of renderers.filter(r => r.total > 100 * MB)) {
    const a = p.allocs;
    const buf = size(a['partition_alloc/partitions/buffer']);
    const parkable =
      size(a['parkable_strings/<unspecified>']) ||
      (p.top.find(([k]) => k === 'parkable_strings')?.[1] ?? 0);
    const blink = p.top.find(([k]) => k === 'blink_gc')?.[1] ?? 0;
    const v8old = size(a['v8/main/heap/old_space']);
    const v8new = size(a['v8/main/heap/new_space']);
    const bits: string[] = [];
    if (buf > 40 * MB)
      bits.push(
        `ArrayBuffer/TypedArray ${mb(buf)}（partition_alloc buffer，多为图片解码位图 / 二进制资源）`,
      );
    if (parkable > 20 * MB)
      bits.push(`可换出大字符串 ${mb(parkable)}（parkable_strings，常是内联 base64 资源）`);
    if (blink > 60 * MB) bits.push(`Blink DOM/CSS ${mb(blink)}（blink_gc，DOM 节点规模大）`);
    if (v8old > 40 * MB) bits.push(`JS 老生代常驻 ${mb(v8old)}（v8 old_space）`);
    if (v8new > 30 * MB)
      bits.push(`JS 新生代 ${mb(v8new)}（v8 new_space，偏大说明采样点刚好在分配高峰、GC 未跑）`);
    if (bits.length) {
      findings.push({
        level: p.total > 400 * MB ? 'high' : 'mid',
        title: `pid ${p.pid} ${mb(p.total)}：大头是 ${bits.length} 类`,
        detail: bits.map(b => '• ' + b).join('<br>'),
      });
    }
  }

  // 泄露 vs 回收判定
  const bigTl = Object.entries(tl).filter(
    ([, s]) => s.length > 1 && Math.max(...s.map(x => x.total)) > 50 * MB,
  );
  if (spanSec < 10) {
    findings.push({
      level: 'tip',
      title: `采样窗口仅 ~${spanSec.toFixed(0)}s，趋势不足以判定泄露`,
      detail: `窗口太短，看不出持续增长或回落。要判定泄露：让内存回基线 → 抓一份 → 重复嫌疑操作 N 次 → 再抓，跨度拉到几十秒以上再看趋势。`,
    });
  } else {
    for (const [pid, s] of bigTl) {
      const delta = s[s.length - 1].total - s[0].total;
      const up = delta > 0.05 * s[0].total;
      findings.push({
        level: up ? 'high' : 'tip',
        title: `pid ${pid} 趋势：${delta >= 0 ? '+' : ''}${mb(delta)}（~${spanSec.toFixed(0)}s）`,
        detail: up
          ? '总量随时间单调上升，疑似泄露，建议抓 heapsnapshot diff 定位持有方。'
          : '总量平稳或回落，属 GC 正常回收，当前高点是回收前峰值，非泄露。',
      });
    }
  }

  findings.push({
    level: 'tip',
    title: '下一步：定位"谁在持有"',
    detail:
      'trace 只给分类总量，给不出具体对象。要落到组件/代码：DevTools 抓 heapsnapshot，用 analyze-heapsnapshot 做两张 diff，看 Δcount 线性增长的类名。',
  });

  const findingsHtml = findings
    .map(
      f =>
        `<div class="finding ${f.level}"><div class="ft">${f.title}</div><div class="fd">${f.detail}</div></div>`,
    )
    .join('');

  const bar = (segs: [string, number][], scale: number) =>
    `<div class="bar">${segs
      .filter(([, v]) => v > 0)
      .map(
        ([k, v]) =>
          `<span title="${esc(k)} ${mb(v)}" style="width:${(v / scale) * 100}%;background:${catColor(k)}"></span>`,
      )
      .join('')}</div>`;

  const procCards = procs
    .map(p => {
      const alloc = p.top.filter(([, v]) => v > 1048576);
      const legend = alloc
        .map(
          ([k, v]) => `<li><i style="background:${catColor(k)}"></i>${esc(k)} <b>${mb(v)}</b></li>`,
        )
        .join('');
      // per-pid detail (only meaningful for renderer-ish with v8)
      const v8Big = subNodes(p.allocs, /^v8\//, 2 * 1048576).slice(0, 12);
      const blinkBig = subNodes(
        p.allocs,
        /^(blink|parkable|partition_alloc|malloc|cc|skia|gpu|web_cache)/,
        3 * 1048576,
      ).slice(0, 20);
      const detailRows = (rows: [string, number][]) =>
        rows.map(([k, v]) => `<tr><td>${mb(v)}</td><td class="mono">${esc(k)}</td></tr>`).join('');
      const detail =
        v8Big.length || blinkBig.length
          ? `<details><summary>细分（size）</summary><div class="detail">
          ${v8Big.length ? `<h4>v8/*</h4><table>${detailRows(v8Big)}</table>` : ''}
          ${blinkBig.length ? `<h4>blink / partition / malloc / cc</h4><table>${detailRows(blinkBig)}</table>` : ''}
         </div></details>`
          : '';
      return `<div class="card">
      <div class="chead"><span class="pid">pid ${p.pid}</span><span class="pname">${esc(p.name)}</span>
        <span class="ptot">${mb(p.total)} <em>(${p.src})</em></span></div>
      ${bar([...alloc], maxTotal)}
      <ul class="legend">${legend}</ul>
      ${detail}
    </div>`;
    })
    .join('');

  // timeline: simple inline SVG sparkline + delta table, only pids with >1 point and >10MB
  const tlCards = Object.entries(tl)
    .filter(([, s]) => s.length > 1 && Math.max(...s.map(x => x.total)) > 10 * 1048576)
    .sort((a, b) => Math.max(...b[1].map(x => x.total)) - Math.max(...a[1].map(x => x.total)))
    .map(([pid, s]) => {
      const max = Math.max(...s.map(x => x.total));
      const min = Math.min(...s.map(x => x.total));
      const span = max - min || 1;
      const w = 260,
        h = 44;
      const pts = s
        .map((x, i) => `${(i / (s.length - 1)) * w},${h - ((x.total - min) / span) * (h - 6) - 3}`)
        .join(' ');
      const first = s[0].total,
        last = s[s.length - 1].total,
        delta = last - first;
      const cls = delta > 2 * 1048576 ? 'up' : (delta < -2 * 1048576 ? 'down' : 'flat');
      return `<div class="tl">
        <div class="tlhead"><b>pid ${pid}</b> ${esc(name(Number(pid)))}
          <span class="badge ${cls}">${delta >= 0 ? '+' : ''}${mb(delta)}</span></div>
        <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}"/></svg>
        <div class="tlrange">${mb(min)} … ${mb(max)}</div>
      </div>`;
    })
    .join('');

  const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Memory Trace — ${esc(file.split('/').pop() ?? '')}</title>
<style>
:root{color-scheme:light dark}
body{margin:0;font:14px/1.5 -apple-system,system-ui,"Segoe UI",sans-serif;background:#f4f5f7;color:#1a1a1a}
@media(prefers-color-scheme:dark){body{background:#16181d;color:#e6e6e6}.card,.tl{background:#1f2229!important;border-color:#2c313a!important}table td{border-color:#2c313a!important}details summary{color:#8ab4f8}}
.wrap{max-width:920px;margin:0 auto;padding:24px 16px 60px}
h1{font-size:20px;margin:0 0 4px}.meta{color:#888;font-size:12px;margin-bottom:20px}
.summary{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:24px}
.stat{background:#fff;border:1px solid #e3e5e9;border-radius:10px;padding:12px 18px;flex:1;min-width:120px}
@media(prefers-color-scheme:dark){.stat{background:#1f2229;border-color:#2c313a}}
.stat b{display:block;font-size:22px}.stat span{color:#888;font-size:12px}
h2{font-size:15px;margin:26px 0 12px;border-bottom:1px solid #e3e5e9;padding-bottom:6px}
.card{background:#fff;border:1px solid #e3e5e9;border-radius:10px;padding:14px 16px;margin-bottom:12px}
.chead{display:flex;align-items:baseline;gap:10px;margin-bottom:8px}
.pid{font-weight:600}.pname{color:#666;font-size:13px;flex:1}
.ptot{font-weight:600;font-variant-numeric:tabular-nums}.ptot em{color:#999;font-style:normal;font-size:11px;font-weight:400}
.bar{display:flex;height:16px;border-radius:5px;overflow:hidden;background:#eceef1}
@media(prefers-color-scheme:dark){.bar{background:#2c313a}}
.bar span{display:block;height:100%}
.legend{list-style:none;display:flex;flex-wrap:wrap;gap:4px 14px;padding:8px 0 0;margin:0;font-size:12px}
.legend i{display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:5px;vertical-align:middle}
.legend b{font-variant-numeric:tabular-nums}
details{margin-top:8px}summary{cursor:pointer;font-size:12px;color:#0969da}
.detail h4{margin:10px 0 4px;font-size:12px;color:#888}
table{border-collapse:collapse;width:100%;font-size:12px}
table td{border-bottom:1px solid #eee;padding:2px 6px}table td:first-child{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;width:70px;color:#666}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}
.tlgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px}
.tl{background:#fff;border:1px solid #e3e5e9;border-radius:10px;padding:12px}
.tlhead{font-size:13px;margin-bottom:6px}.tlhead b{margin-right:4px}
.badge{float:right;font-size:11px;padding:1px 7px;border-radius:10px;font-variant-numeric:tabular-nums}
.badge.up{background:#fde2e1;color:#c0392b}.badge.down{background:#dcefe0;color:#1e7e45}.badge.flat{background:#e8eaed;color:#666}
.tl svg{width:100%;height:44px;display:block}.tl polyline{fill:none;stroke:#4db6ac;stroke-width:2;vector-effect:non-scaling-stroke}
.tlrange{font-size:11px;color:#999;margin-top:4px;font-variant-numeric:tabular-nums}
.findings{display:flex;flex-direction:column;gap:8px}
.finding{border:1px solid #e3e5e9;border-left-width:4px;border-radius:8px;padding:9px 14px;background:#fff}
@media(prefers-color-scheme:dark){.finding{background:#1f2229;border-color:#2c313a}}
.finding.high{border-left-color:#e05555}.finding.mid{border-left-color:#4db6ac}.finding.tip{border-left-color:#f0b429}
.finding .ft{font-weight:600;font-size:13px}.finding .fd{color:#777;font-size:12px;margin-top:3px}
@media(prefers-color-scheme:dark){.finding .fd{color:#9aa0aa}}
.note{background:#fff8e1;border:1px solid #f0e0a0;border-radius:8px;padding:10px 14px;font-size:12px;color:#7a5c00;margin-top:20px}
@media(prefers-color-scheme:dark){.note{background:#2a2410;border-color:#4a3f1a;color:#d4b96a}.badge.up{background:#3a1f1e;color:#f08a80}.badge.down{background:#16321f;color:#7cd99a}.badge.flat{background:#2c313a;color:#aaa}}
</style></head><body><div class="wrap">
<h1>内存 Trace 分析</h1>
<div class="meta">${esc(file)} · events ${events.length} · dumps ${allDumps.length} (detailed ${detailed.length}) · 采样跨度 ~${spanSec.toFixed(0)}s</div>
<div class="summary">
  <div class="stat"><b>${mb(grand)}</b><span>全进程合计 (近似)</span></div>
  <div class="stat"><b>${procs.length}</b><span>进程数</span></div>
  <div class="stat"><b>${mb(maxTotal)}</b><span>最大进程 · pid ${procs[0]?.pid}</span></div>
</div>
<h2>分析总结</h2>
<div class="findings">${findingsHtml}</div>
<h2>各进程内存构成</h2>
${procCards}
<h2>内存随时间变化</h2>
<div class="tlgrid">${tlCards || '<p style="color:#999">采样点不足，无趋势</p>'}</div>
<div class="note">总量为近似值（本 trace 无 RSS/footprint，按顶层 allocator effective_size 求和）。单个高点不代表泄露——需看趋势是否单调上升，或抓 heapsnapshot 用 analyze-heapsnapshot 定位持有方。</div>
</div></body></html>`;

  const out = outfile ?? `output/tracing/${basename(file).replace(/\.json$/, '')}.report.html`;
  mkdirSync(out.slice(0, out.lastIndexOf('/')) || '.', { recursive: true });
  writeFileSync(out, html);
  console.log(`report written: ${out}`);
  return out;
}

if (cmd === 'overview') overview();
else if (cmd === 'pid') pidDetail(Number(arg2));
else if (cmd === 'timeline') timeline(arg2 ? Number(arg2) : undefined);
else if (cmd === 'html') htmlReport(arg2);
else console.error(`unknown command: ${cmd}`);
