#!/usr/bin/env -S pnpm tsx

/**
 * 样式债务增量自检 —— css-source-tracing skill 的收尾步骤
 *
 * 只检查「新增」的样式代码(git diff HEAD 的 + 行 + 未跟踪样式文件),
 * 不扫存量,不会被历史 !important 债务干扰。
 *
 * Usage:
 *   pnpm tsx check-style-debt.ts                    # 扫工作区相对 HEAD 的全部新增
 *   pnpm tsx check-style-debt.ts --files a.vue b.css # 全量扫指定文件
 *
 * 例外逃生门:在违规行或其上一行加注释 `style-guard-allow: <规则id> <理由>`,
 * 会被记为「已豁免」而非违规,但必须按项目的例外登记流程记录。
 *
 * 退出码: 0 = 无违规; 1 = 有违规(agent 必须修复后重跑)。
 */

/** ===== 项目适配配置:接到你自己的仓库时,通常只需要改这里 ===== */
const CONFIG = {
  /** 扫描根目录(多仓/多包项目逐个列出) */
  sourceRoots: ['src', 'packages'],
  /** 不纳入检查的路径(正则;如私有 playground、示例目录) */
  excludePatterns: [/^examples\//],
  /** 设计系统样式文件(样式文件匹配) */
  styleFilePattern: /\.(vue|css|less|scss)$/,
  /** 收集「已定义 CSS 变量」时,组件库 dist 的定位 glob(node_modules 内;用于读取组件库暴露的 token) */
  componentLibDistGlob: '*your-design-system*',
  /** 运行时注入 / 框架内置的变量前缀家族:不在源码定义也属正常(按你的技术栈调整) */
  tokenWhitelist: /^--(tw-|v-)/,
  /** 设计 token 定义文件路径(仅用于错误提示指路) */
  tokenDefinitionFiles: 'src/styles/tokens.css(按项目替换为你的 token 定义文件)',
};
/** ==================================================================== */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const STYLE_FILE = CONFIG.styleFilePattern;
const isExcluded = (f: string): boolean => CONFIG.excludePatterns.some(r => r.test(f));
const isStyleTarget = (f: string): boolean => STYLE_FILE.test(f) && !isExcluded(f);

interface Violation {
  file: string;
  line: number;
  rule: string;
  text: string;
  allowed: boolean;
}

interface Rule {
  id: string;
  test: (line: string, isVue: boolean) => boolean;
  fix: string;
}

/**
 * 取出一行里所有 class 属性的"静态值":
 * - class="..." 整段
 * - :class="..." 只取其中的字符串字面量(对象键/JS 表达式不算)
 */
function classValues(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(/(?<![:\w])class\s*=\s*(["'])([\s\S]*?)\1/g)) out.push(m[2]);
  for (const m of line.matchAll(/:class\s*=\s*(["'])([\s\S]*?)\1/g)) {
    for (const s of m[2].matchAll(/(["'`])([^"'`]*?)\1/g)) out.push(s[2]);
  }
  return out;
}

/** 运行时注入 / 框架钩子家族:不在源码里定义也属正常 */
const TOKEN_WHITELIST = CONFIG.tokenWhitelist;

let definedTokens: Set<string> | null = null;
/**
 * 构建「已定义 CSS 变量」集合:源码内 --x: 定义 + TS 引号键/setProperty + 组件库 dist。
 * 只在命中 var()/Tailwind 任意值语法时才懒构建,不拖慢无 token 改动的检查。
 */
function getDefinedTokens(): Set<string> {
  if (definedTokens) return definedTokens;

  /** 扫一遍源码取匹配片段。
   * ⚠️ rg 不能想当然认为在 PATH 上:某些环境里 `rg` 只是个 shell function,
   * spawnSync('rg') 会 ENOENT——这会静默地把本集合清空,于是 unknown-token
   * 规则对全仓每一个 var(--color-*) 都报"幽灵 token"。所以 spawn 失败一律
   * 回落 grep,而不是吞掉错误返回空串。正则一律用 POSIX 字符类(BSD grep -E 不认 \s)。
   */
  const scan = (pattern: string, exts: string[], target: string, followSymlink = false): string => {
    const rg = spawnSync(
      'rg',
      [
        '-e', pattern, '--no-filename', '-o', '-g', '!node_modules',
        ...(exts.length ? ['--glob', `*.{${exts.join(',')}}`] : []),
        ...(followSymlink ? ['--follow'] : []),
        target,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    // rg: 0 = 有命中, 1 = 无命中(正常), 2 = 出错
    if (!rg.error && (rg.status === 0 || rg.status === 1)) return rg.stdout ?? '';
    const grep = spawnSync(
      'grep',
      [
        followSymlink ? '-Rhoe' : '-rhoe', pattern, '-E',
        '--exclude-dir=node_modules',
        ...exts.map(e => `--include=*.${e}`),
        target,
      ],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    return grep.stdout ?? '';
  };

  const raw = CONFIG.sourceRoots.flatMap(root => [
    scan('(--[a-zA-Z][a-zA-Z0-9_-]*)[[:space:]]*:[^;]', ['css', 'less', 'scss', 'vue'], root),
    scan('setProperty\\([\'"](--[a-zA-Z][a-zA-Z0-9_-]*)', ['ts', 'tsx', 'vue', 'js'], root),
    scan('[\'"](--[a-zA-Z][a-zA-Z0-9_-]*)[\'"][[:space:]]*:', ['ts', 'tsx', 'vue'], root),
  ]);

  // 组件库 dist:组件库通过 JS/CSS 暴露的 token 也算「已定义」
  const dist = spawnSync(
    'find',
    [
      'node_modules/.pnpm', '-maxdepth', '5', '-type', 'd',
      '-path', CONFIG.componentLibDistGlob, '-name', 'dist',
    ],
    { encoding: 'utf8' },
  )
    .stdout.trim()
    .split('\n')
    .filter(Boolean)[0];
  if (dist) raw.push(scan('(--[a-zA-Z][a-zA-Z0-9_-]*)[[:space:]]*:', [], dist, true));

  definedTokens = new Set<string>();
  for (const line of raw.join('\n').split('\n')) {
    const m = line.match(/--[a-zA-Z][a-zA-Z0-9_-]*/);
    if (m) definedTokens.add(m[0]);
  }
  return definedTokens;
}

/** 一行里引用到的 CSS 变量名:var(--x) 与 Tailwind v4 任意值语法 bg-(--x) / text-(--x,...) */
function referencedTokens(line: string): string[] {
  const names = new Set<string>();
  for (const m of line.matchAll(/var\(\s*(--[a-zA-Z][a-zA-Z0-9_-]*)/g)) names.add(m[1]);
  for (const m of line.matchAll(/[a-z-]+\((--[a-zA-Z][a-zA-Z0-9_-]*)/g)) names.add(m[1]);
  return [...names];
}

const RULES: Rule[] = [
  {
    id: 'css-important',
    test: line => !isCommentLine(line) && /!important/.test(line),
    fix: '禁止 !important。回到溯源流程改源头/用 token/调整层叠,而不是提高武力值。',
  },
  {
    id: 'tailwind-important',
    // Tailwind 强制优先级: 前缀形 !flex / hover:!bg-*,后缀形 text-sm!(v4)。
    // 只看 class 属性的静态值,:class 里的 JS 取反(`!overflowed`)不算
    test: line => {
      const l = line.replace(/!important/g, '');
      const values = classValues(l);
      if (/@apply\b/.test(l)) values.push(l.slice(l.indexOf('@apply') + 6));
      return values.some(v => /(^|[\s:])!(?=[a-z])/.test(v) || /[a-z0-9\]]!(?=\s|$)/.test(v));
    },
    fix: 'Tailwind 的 ! 强制优先级与 !important 同罪。先查组件 variant/Props/token 是否能解决。',
  },
  {
    id: 'z-index-literal',
    // 同时覆盖 CSS z-index: 13000 与 JS zIndex: 13000
    test: line => {
      if (isCommentLine(line)) return false;
      const m = line.match(/z-?index['"]?\s*[:=]\s*['"]?(-?\d+)/i);
      return Boolean(m) && Math.abs(parseInt(m[1], 10)) >= 10;
    },
    fix: 'z-index 禁止裸数字(≥10)。用项目的 z-index 阶梯 token 或统一的层级管理器,不要猜一个更大的数。',
  },
  {
    id: 'hardcoded-color',
    // 只匹配 CSS 声明形态;var(--token, #fff) 后备值放行;`--x: #hex` 是 token 定义本身,放行
    test: line => {
      const stripped = line.replace(/var\([^)]*\)/g, 'var()');
      for (const m of stripped.matchAll(
        /(?:^|[{;])\s*(-{0,2}[a-zA-Z][\w-]*)\s*:[^;'"]*#[0-9a-fA-F]{3,8}\b/g,
      )) {
        if (!m[1].startsWith('--')) return true; // 属性名以 -- 开头 = token 定义,放行
      }
      return false;
    },
    fix: '颜色禁止硬编码 hex,使用设计 token var(--color-*)。定义见 CONFIG.tokenDefinitionFiles。',
  },
  {
    id: 'unscoped-style',
    test: (line, isVue) => isVue && /<style\b/.test(line) && !/\b(scoped|module)\b/.test(line),
    fix: '<style> 必须加 scoped。确需全局样式时写入全局样式文件并注明理由。',
  },
  {
    id: 'deep-chain',
    // 4 层以上含 :deep() 的选择器链
    test: line => {
      if (!line.includes(':deep(')) return false;
      const sel = line.split('{')[0];
      const parts = sel
        .trim()
        .split(/\s+|>/)
        .filter(p => p && !['>', '+', '~', '&'].includes(p));
      return parts.length >= 4;
    },
    fix: ':deep() 链超过 3 层说明在依赖子组件内部 DOM。改用组件 API/token/稳定 class hook。',
  },
  {
    id: 'long-class',
    test: line => {
      const m = line.match(/(?:class|:class)\s*=\s*(["'])([\s\S]*?)\1/);
      return Boolean(m) && m[2].length > 200;
    },
    fix: '单行 class 超过 200 字符。提取语义 class、组件 variant 或共享 utility。',
  },
  {
    id: 'unknown-token',
    // 引用了全部来源都没定义的 CSS 变量 = 幽灵 token:
    // 凭语义感拼名 + fallback 兜底,看起来能跑,实际换肤/dark 静默失效
    test: line => {
      const refs = referencedTokens(line).filter(n => !TOKEN_WHITELIST.test(n));
      if (!refs.length) return false;
      const defined = getDefinedTokens();
      return refs.some(n => !defined.has(n));
    },
    fix: '引用了未定义的 CSS 变量(幽灵 token)。去 CONFIG.tokenDefinitionFiles 声明的定义文件查真名,不要凭语义感拼 token 名。',
  },
];

/** 整行是注释(`//` / `*` / `/*` / `<!--`)就跳过:正则启发式会把注释里的示例文字当代码命中。 */
function isCommentLine(text: string): boolean {
  return /^\s*(\/\/|\*|\/\*|<!--)/.test(text);
}

function checkLines(file: string, lines: Array<{ no: number; text: string }>): Violation[] {
  const isVue = file.endsWith('.vue');
  const out: Violation[] = [];
  for (let i = 0; i < lines.length; i++) {
    const { no, text } = lines[i];
    if (isCommentLine(text)) continue;
    // 豁免:本行或紧邻的上一行(仅限连续新增行)带 style-guard-allow
    const prev = i > 0 && lines[i - 1].no === no - 1 ? lines[i - 1].text : '';
    const allowed = text.includes('style-guard-allow') || prev.includes('style-guard-allow');
    for (const rule of RULES) {
      if (rule.test(text, isVue)) {
        out.push({ file, line: no, rule: rule.id, text: text.trim().slice(0, 110), allowed });
      }
    }
  }
  return out;
}

function git(args: string[]): string {
  const r = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(`git ${args.join(' ')} 失败: ${r.stderr}`);
    process.exit(2);
  }
  return r.stdout;
}

/** 解析 git diff -U0 输出,返回每个文件的新增行(带行号) */
function parseDiff(diff: string): Map<string, Array<{ no: number; text: string }>> {
  const byFile = new Map<string, Array<{ no: number; text: string }>>();
  let file = '';
  let lineNo = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ b/')) {
      file = raw.slice(6);
      continue;
    }
    const hunk = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)/);
    if (hunk) {
      lineNo = parseInt(hunk[1], 10);
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      if (isStyleTarget(file)) {
        if (!byFile.has(file)) byFile.set(file, []);
        byFile.get(file)!.push({ no: lineNo, text: raw.slice(1) });
      }
      lineNo++;
    }
  }
  return byFile;
}

function main(): number {
  const args = process.argv.slice(2);
  const violations: Violation[] = [];
  let scannedLines = 0;
  const scannedFiles = new Set<string>();

  if (args[0] === '--files') {
    for (const f of args.slice(1)) {
      if (!isStyleTarget(f)) continue;
      const lines = readFileSync(f, 'utf8')
        .split('\n')
        .map((text, i) => ({ no: i + 1, text }));
      scannedFiles.add(f);
      scannedLines += lines.length;
      violations.push(...checkLines(f, lines));
    }
  } else {
    // 已跟踪文件:相对 HEAD 的新增行
    const diff = git(['diff', '-U0', 'HEAD', '--', '*.vue', '*.css', '*.less', '*.scss']);
    for (const [file, lines] of parseDiff(diff)) {
      scannedFiles.add(file);
      scannedLines += lines.length;
      violations.push(...checkLines(file, lines));
    }
    // 未跟踪的新样式文件:全量检查
    const untracked = git(['ls-files', '--others', '--exclude-standard'])
      .split('\n')
      .filter(f => isStyleTarget(f));
    for (const f of untracked) {
      const lines = readFileSync(f, 'utf8')
        .split('\n')
        .map((text, i) => ({ no: i + 1, text }));
      scannedFiles.add(f);
      scannedLines += lines.length;
      violations.push(...checkLines(f, lines));
    }
  }

  const real = violations.filter(v => !v.allowed);
  const waived = violations.filter(v => v.allowed);

  console.log(
    `[check-style-debt] 扫描 ${scannedFiles.size} 个文件 / ${scannedLines} 行新增样式相关代码`,
  );

  if (violations.length) {
    let cur = '';
    for (const v of [...real, ...waived].sort((a, b) =>
      a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file),
    )) {
      if (v.file !== cur) {
        cur = v.file;
        console.log(`\n${v.file}`);
      }
      const mark = v.allowed ? '(已豁免)' : '';
      console.log(`  L${v.line} [${v.rule}]${mark} ${v.text}`);
      if (!v.allowed) {
        const rule = RULES.find(r => r.id === v.rule);
        if (rule) console.log(`       → ${rule.fix}`);
      }
    }
  }

  console.log('');
  if (waived.length) {
    console.log(`⚠ ${waived.length} 处已豁免 —— 请确认已按项目例外流程登记。`);
  }
  if (real.length) {
    console.log(`✗ ${real.length} 处违规。修复后重跑本脚本,违规为 0 才算完成样式任务。`);
    return 1;
  }
  console.log('✓ 无新增样式债务。');
  return 0;
}

process.exit(main());
