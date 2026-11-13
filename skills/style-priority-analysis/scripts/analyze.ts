#!/usr/bin/env -S pnpm tsx

/**
 * 完整分析 Vue SFC 文件中 !important 声明是否可以去掉
 *
 * 竞争来源（三层）：
 *   1. 文件内部 CSS 规则
 *   2. 组件库 CSS 规则（搜索 dist-browser/*.css）
 *   3. 组件库 JS 内联样式（搜索 dist-browser/*.js，动态 style 绑定）
 *
 * 特异性计算：
 *   Vue <style scoped> 会给 :deep() 之前的每个选择器部分加 [data-v-xxx]（属性选择器）
 *   compiled specificity = base + (0, N, 0)，N = :deep() 前的选择器段数
 *   若无 :deep()，N = 全部段数
 *
 * Usage: pnpm tsx .claude/skills/analyze-important/scripts/analyze.ts <file.vue> [...]
 */

/** ===== 项目适配:类名前缀 → 组件库 CSS 位置(按你的技术栈配置) ===== */
const LIB_PREFIX_MAP: Record<string, string[]> = {
  // 'xt-': ['node_modules/your-design-system/dist'],
  // 'n-': ['node_modules/naive-ui'],
};

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';

// ── Terminal colors ──────────────────────────────────────────────────────────

const c = {
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  gray: (s: string) => `\x1b[90m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[0m`,
};

// ── CSS Specificity ──────────────────────────────────────────────────────────

type Specificity = [number, number, number];

/** Base specificity, without Vue scoped attribute. */
function calcSpecificity(selector: string): Specificity {
  let s = selector.replace(/:deep\(([^)]*)\)/g, '$1').replace(/::[\w-]+/g, '');

  const innerParts: string[] = [];
  s = s.replace(/:(not|is|has)\(([^)]*)\)/g, (_, _fn, inner) => {
    innerParts.push(inner);
    return '';
  });

  const ids = (s.match(/#[\w-]+/g) ?? []).length;
  const classes = (
    s.match(/\.[\w-]+|\[[\w^$*|~=-]+(?:=["']?[^"'\]]*["']?)?\]|:[\w-]+(?:\([^)]*\))?/g) ?? []
  ).length;
  const elems = (s.replace(/[.#[:][^\s>+~{]*/g, '').match(/\b[a-z][\w-]*/g) ?? []).length;

  let [ai, ac, ae] = [0, 0, 0];
  for (const p of innerParts) {
    const [a, b, cc] = calcSpecificity(p);
    ai += a;
    ac += b;
    ae += cc;
  }
  return [ids + ai, classes + ac, elems + ae];
}

/** Count top-level selector parts (split by combinators). */
function countSelectorParts(sel: string): number {
  // Remove content inside parens first
  let s = sel;
  let result = '';
  let depth = 0;
  for (const ch of s) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0) result += ch;
  }
  return result
    .split(/[\s>+~]+/)
    .map(p => p.trim())
    .filter(Boolean).length;
}

/**
 * Compiled specificity for a scoped Vue rule.
 * Vue adds [data-v-xxx] to every selector part that is NOT inside :deep().
 */
function compiledSpecificity(selector: string, scoped: boolean): Specificity {
  const base = calcSpecificity(selector);
  if (!scoped) return base;

  const deepIdx = selector.indexOf(':deep(');
  const before = deepIdx === -1 ? selector : selector.slice(0, deepIdx);
  const n = countSelectorParts(before);
  return [base[0], base[1] + n, base[2]];
}

function cmpSpec(a: Specificity, b: Specificity): number {
  return a[0] !== b[0] ? a[0] - b[0] : (a[1] !== b[1] ? a[1] - b[1] : a[2] - b[2]);
}

function specStr(s: Specificity) {
  return `(${s[0]},${s[1]},${s[2]})`;
}

// ── Vue SFC Parser ───────────────────────────────────────────────────────────

interface StyleBlock {
  content: string;
  scoped: boolean;
  lang: string;
  startLine: number;
}

function extractStyleBlocks(source: string): StyleBlock[] {
  const blocks: StyleBlock[] = [];
  const re = /<style([^>]*)>([\s\S]*?)<\/style>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const attrs = m[1];
    const scoped = /\bscoped\b/.test(attrs);
    const langM = attrs.match(/lang=["']?(\w+)["']?/);
    blocks.push({
      content: m[2],
      scoped,
      lang: langM ? langM[1] : 'css',
      startLine: (source.slice(0, m.index).match(/\n/g) ?? []).length + 1,
    });
  }
  return blocks;
}

// ── CSS Parser (supports SCSS nesting + :deep) ───────────────────────────────

interface Decl {
  property: string;
  value: string;
  important: boolean;
  line: number;
}

interface CssRule {
  selector: string;
  rawSelector: string;
  specificity: Specificity;
  compiledSpec: Specificity;
  isDeep: boolean;
  line: number;
  decls: Decl[];
}

function parseDirectDecls(body: string, baseLine: number): Decl[] {
  const decls: Decl[] = [];
  let buf = '';
  let parenDepth = 0;
  let braceDepth = 0;
  let line = baseLine;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\n') line++;
    if (ch === '(' || ch === '[') {
      parenDepth++;
      buf += ch;
      continue;
    }
    if (ch === ')' || ch === ']') {
      parenDepth--;
      buf += ch;
      continue;
    }
    if (ch === '{') {
      braceDepth++;
      buf = '';
      continue;
    }
    if (ch === '}') {
      braceDepth--;
      buf = '';
      continue;
    }
    if (braceDepth > 0) continue;
    if (ch === ';' && parenDepth === 0) {
      const t = buf.trim();
      buf = '';
      if (!t) continue;
      const important = /!important\s*$/.test(t);
      const clean = t.replace(/\s*!important\s*$/, '').trim();
      const colon = clean.indexOf(':');
      if (colon <= 0) continue;
      const prop = clean.slice(0, colon).trim().toLowerCase();
      const val = clean.slice(colon + 1).trim();
      if (/^[\w-]+$/.test(prop)) decls.push({ property: prop, value: val, important, line });
    } else buf += ch;
  }
  return decls;
}

function resolveSelectors(raw: string, parents: string[]): string[] {
  const parts = raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  if (parents.length === 0) return parts;
  const out: string[] = [];
  for (const raw of parts) {
    for (const parent of parents) {
      out.push(raw.includes('&') ? raw.replace(/&/g, parent) : `${parent} ${raw}`);
    }
  }
  return out;
}

function walkBlock(
  body: string,
  parentSelectors: string[],
  baseLine: number,
  scoped: boolean,
  out: CssRule[],
): void {
  let i = 0;
  let selectorBuf = '';
  let selectorLine = baseLine;
  let currentLine = baseLine;
  let parenDepth = 0;

  while (i < body.length) {
    const ch = body[i];
    if (ch === '\n') currentLine++;
    if (ch === '(' || ch === '[') {
      parenDepth++;
      selectorBuf += ch;
      i++;
      continue;
    }
    if (ch === ')' || ch === ']') {
      parenDepth--;
      selectorBuf += ch;
      i++;
      continue;
    }
    if (parenDepth > 0) {
      selectorBuf += ch;
      i++;
      continue;
    }

    if (ch === ';') {
      selectorBuf = '';
      selectorLine = currentLine;
      i++;
      continue;
    }

    if (ch === '{') {
      const rawSelector = selectorBuf.trim();
      selectorBuf = '';

      let depth = 1,
        j = i + 1;
      while (j < body.length && depth > 0) {
        if (body[j] === '{') depth++;
        else if (body[j] === '}') depth--;
        j++;
      }
      const blockBody = body.slice(i + 1, j - 1);
      const blockLine = currentLine + 1;

      if (rawSelector && !rawSelector.trimStart().startsWith('@')) {
        const resolved = resolveSelectors(rawSelector, parentSelectors);
        const decls = parseDirectDecls(blockBody, blockLine);
        if (decls.length > 0) {
          for (const sel of resolved) {
            const isDeep = rawSelector.includes(':deep');
            out.push({
              selector: sel,
              rawSelector,
              specificity: calcSpecificity(sel),
              compiledSpec: compiledSpecificity(sel, scoped),
              isDeep,
              line: selectorLine,
              decls,
            });
          }
        }
        walkBlock(blockBody, resolved, blockLine, scoped, out);
      } else if (rawSelector.trimStart().startsWith('@')) {
        walkBlock(blockBody, parentSelectors, blockLine, scoped, out);
      }

      i = j;
      selectorLine = currentLine;
    } else if (ch === '}') {
      selectorBuf = '';
      selectorLine = currentLine;
      i++;
    } else {
      selectorBuf += ch;
      i++;
    }
  }
}

// ── Library Search ───────────────────────────────────────────────────────────

/** Convert kebab-case CSS property to camelCase for JS searching. */
function toCamelCase(prop: string): string {
  return prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

/** Recursively find files matching a predicate (up to maxDepth). */
function findFiles(dir: string, predicate: (path: string) => boolean, maxDepth = 4): string[] {
  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && maxDepth > 0) {
        results.push(...findFiles(full, predicate, maxDepth - 1));
      } else if (entry.isFile() && predicate(full)) {
        results.push(full);
      }
    }
  } catch {
    /* ignore unreadable directories */
  }
  return results;
}

/** Locate the dist-browser directory for a package name, searching from cwd. */
function findPackageDistBrowser(pkgName: string, cwd: string): string | null {
  // Direct node_modules
  const direct = join(cwd, 'node_modules', pkgName, 'dist-browser');
  try {
    statSync(direct);
    return direct;
  } catch {
    /* not found */
  }

  // pnpm virtual store
  const pnpmStore = join(cwd, 'node_modules', '.pnpm');
  try {
    const entries = readdirSync(pnpmStore, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const candidate = join(pnpmStore, e.name, 'node_modules', pkgName, 'dist-browser');
      try {
        statSync(candidate);
        return candidate;
      } catch {
        /* not found */
      }
    }
  } catch {
    /* pnpm store not accessible */
  }
  return null;
}

interface LibSource {
  kind: 'css' | 'inline';
  selector?: string;
  specificity?: Specificity;
  value?: string;
  file: string;
  evidence?: string;
}

/** Parse a flat (non-SCSS) CSS file and find rules for the given class + property. */
function searchLibraryCss(cssPath: string, innerClass: string, property: string): LibSource[] {
  let content: string;
  try {
    content = readFileSync(cssPath, 'utf-8');
  } catch {
    return [];
  }

  // Strip comments
  content = content.replace(/\/\*[\s\S]*?\*\//g, '');

  const sources: LibSource[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;

  while ((m = ruleRe.exec(content)) !== null) {
    const selectorBlock = m[1].trim();
    const declBlock = m[2];

    // Check if this rule targets the inner class (e.g. `.xt-slider-thumb`)
    const selectorParts = selectorBlock.split(',').map(s => s.trim());
    const matching = selectorParts.filter(
      sel => sel.includes(innerClass) || sel.includes(innerClass.replace('.', '')),
    );
    if (matching.length === 0) continue;

    // Check if the property is set
    const declRe = new RegExp(`${property}\\s*:\\s*([^;]+?)(?:\\s*!important)?\\s*;`);
    const declM = declRe.exec(declBlock);
    if (!declM) continue;

    for (const sel of matching) {
      sources.push({
        kind: 'css',
        selector: sel,
        specificity: calcSpecificity(sel),
        value: declM[1].trim(),
        file: cssPath.split('node_modules/').pop() ?? cssPath,
      });
    }
  }
  return sources;
}

/** Search JS bundle for inline style bindings (camelCase property) near the inner class.
 *
 *  Strategy: find the closest occurrence of the class name in the file, then scan
 *  outward (up to ±100 000 chars, i.e. one large component scope) for an inline
 *  style pattern that sets the target property. If the class appears in the file at
 *  all, the inline style binding for the same component is almost certainly nearby.
 */
function searchLibraryInlineStyles(
  jsPath: string,
  innerClass: string,
  property: string,
): LibSource[] {
  let content: string;
  try {
    content = readFileSync(jsPath, 'utf-8');
  } catch {
    return [];
  }

  const className = innerClass.replace(/^\./, ''); // strip leading dot
  const camel = toCamelCase(property);
  const fileKey = jsPath.split('node_modules/').pop() ?? jsPath;

  // Find ALL positions of the class name in the file
  const classPositions: number[] = [];
  let idx = 0;
  while (true) {
    const pos = content.indexOf(className, idx);
    if (pos === -1) break;
    classPositions.push(pos);
    idx = pos + 1;
  }
  if (classPositions.length === 0) return [];

  // For each class occurrence, search a generous window for `camelProp:` inside
  // a style binding context (`style:` or `normalizeStyle`).
  const styleWithPropPattern = new RegExp(
    `(?:style\\s*:|normalizeStyle)[\\s\\S]{1,500}?\\b${camel}\\s*:`,
  );

  for (const pos of classPositions) {
    const windowStart = Math.max(0, pos - 5000);
    const windowEnd = Math.min(content.length, pos + 100000);
    const window = content.slice(windowStart, windowEnd);

    const m = styleWithPropPattern.exec(window);
    if (m) {
      const propIdx = m.index + m[0].lastIndexOf(camel);
      const snippet = window
        .slice(propIdx, propIdx + 80)
        .trim()
        .replace(/\s+/g, ' ');
      return [{ kind: 'inline', file: fileKey, evidence: snippet }];
    }
  }
  return [];
}

// ── Analysis ─────────────────────────────────────────────────────────────────

type Verdict = 'needed' | 'removable' | 'manual';

interface Finding {
  selector: string;
  compiledSpec: Specificity;
  baseSpec: Specificity;
  isDeep: boolean;
  property: string;
  value: string;
  line: number;
  scoped: boolean;
  verdict: Verdict;
  reasons: string[];
  suggestions: string[];
  internalCompetitors: Array<{
    selector: string;
    spec: Specificity;
    compiledSpec: Specificity;
    value: string;
    line: number;
  }>;
  libSources: LibSource[];
}

function analyzeFile(filePath: string, cwd: string): void {
  const abs = resolve(cwd, filePath);
  let source: string;
  try {
    source = readFileSync(abs, 'utf-8');
  } catch {
    console.error(c.red(`Cannot read: ${abs}`));
    process.exit(1);
  }

  const stripComments = (css: string) =>
    css.replace(/\/\*[\s\S]*?\*\//g, m => '\n'.repeat((m.match(/\n/g) ?? []).length));

  const blocks = extractStyleBlocks(source);
  if (blocks.length === 0) {
    console.log(c.yellow('No <style> blocks found.'));
    return;
  }

  // Pre-locate library dist-browser directories
  const libDirs = new Map<string, string | null>();
  const getLibDir = (pkg: string) => {
    if (!libDirs.has(pkg)) libDirs.set(pkg, findPackageDistBrowser(pkg, cwd));
    return libDirs.get(pkg)!;
  };

  const findings: Finding[] = [];

  for (const block of blocks) {
    const rules: CssRule[] = [];
    walkBlock(stripComments(block.content), [], block.startLine + 1, block.scoped, rules);

    for (const rule of rules) {
      for (const decl of rule.decls) {
        if (!decl.important) continue;

        // ── 1. File-internal competitors ──
        const internalCompetitors = rules
          .filter(r => r !== rule && r.decls.some(d => d.property === decl.property))
          .map(r => {
            const cd = r.decls.find(d => d.property === decl.property)!;
            return {
              selector: r.selector,
              spec: r.specificity,
              compiledSpec: r.compiledSpec,
              value: cd.value,
              line: r.line,
            };
          });

        // ── 2. Library sources (for :deep() rules) ──
        const libSources: LibSource[] = [];

        if (rule.isDeep) {
          // Extract inner class(es) from :deep(.foo) — take the first class
          const deepM = rule.rawSelector.match(/:deep\(([^)]+)\)/);
          if (deepM) {
            const innerSel = deepM[1].trim(); // e.g. ".xt-slider-thumb"
            const innerClasses = innerSel.split(/\s+/).filter(p => p.startsWith('.'));

            // Guess which library owns this class
            const libGuesses = innerClasses.flatMap(cls => {
              const name = cls.replace(/^\./, '');
              // 类名前缀 → 组件库位置:走顶部可配置映射,未配置的前缀返回空(交给人工确认档)
              const mapped = Object.keys(LIB_PREFIX_MAP).find(prefix => name.startsWith(prefix));
              if (mapped) return LIB_PREFIX_MAP[mapped];
              if (name.startsWith('n-')) return ['naive-ui'];
            });

            const checkedLibs = new Set<string>();
            for (const lib of libGuesses) {
              if (checkedLibs.has(lib)) continue;
              checkedLibs.add(lib);

              const distBrowser = getLibDir(lib);
              if (!distBrowser) continue;

              // Check each inner class
              for (const innerClass of innerClasses) {
                // Search CSS
                const cssFiles = findFiles(
                  distBrowser,
                  f => f.endsWith('.css') && !f.endsWith('.min.css'),
                );
                for (const f of cssFiles) {
                  libSources.push(...searchLibraryCss(f, innerClass, decl.property));
                }

                // Search JS for inline styles
                const jsFiles = findFiles(
                  distBrowser,
                  f => f.endsWith('.js') && !f.endsWith('.min.js'),
                );
                for (const f of jsFiles) {
                  libSources.push(...searchLibraryInlineStyles(f, innerClass, decl.property));
                }
              }
            }
          }
        }

        // ── 3. Determine verdict ──
        const reasons: string[] = [];
        const suggestions: string[] = [];
        let verdict: Verdict;

        const hasInlineStyle = libSources.some(s => s.kind === 'inline');
        const cssLibSources = libSources.filter(s => s.kind === 'css');

        // Internal competitors that beat the current compiled spec
        const beatingInternal = internalCompetitors.filter(
          cp => cmpSpec(rule.compiledSpec, cp.compiledSpec) < 0,
        );

        // Library CSS sources that beat the current compiled spec
        const beatingLibCss = cssLibSources.filter(s =>
          s.specificity ? cmpSpec(rule.compiledSpec, s.specificity) < 0 : false,
        );

        if (hasInlineStyle) {
          verdict = 'needed';
          reasons.push(
            `组件库通过 JS 内联样式设置 ${decl.property}（inline style 特异性 > 任何 CSS class）`,
          );
          suggestions.push('查是否有组件 prop 或 CSS 变量可替代，若无则保留 !important');
        } else if (beatingInternal.length > 0) {
          verdict = 'needed';
          reasons.push(
            `文件内有更高特异性规则覆盖：${beatingInternal.map(c => `L${c.line} [${c.selector}] ${specStr(c.compiledSpec)}`).join(', ')}`,
          );
          suggestions.push('提升当前选择器特异性，或参考 css-trace-to-source 修改源头');
        } else if (beatingLibCss.length > 0) {
          verdict = 'needed';
          reasons.push(
            `组件库 CSS 有更高特异性规则：${beatingLibCss.map(s => `[${s.selector}] ${specStr(s.specificity!)}`).join(', ')}`,
          );
          suggestions.push('提升当前选择器特异性，或查找组件库 CSS 变量');
        } else if (libSources.length > 0 && cssLibSources.length > 0) {
          // All lib CSS sources lose to compiled spec
          verdict = 'removable';
          const maxLibSpec = cssLibSources.reduce(
            (m, s) => (s.specificity && cmpSpec(s.specificity, m) > 0 ? s.specificity : m),
            [0, 0, 0] as Specificity,
          );
          reasons.push(
            `编译后特异性 ${specStr(rule.compiledSpec)} 已 ≥ 组件库 CSS ${specStr(maxLibSpec)}，!important 冗余`,
          );
          suggestions.push('直接删掉 !important，在 DevTools 确认视觉不变');
        } else if (internalCompetitors.length > 0 && beatingInternal.length === 0) {
          verdict = 'removable';
          reasons.push(
            `编译后特异性 ${specStr(rule.compiledSpec)} 已 ≥ 文件内所有竞争规则，!important 冗余`,
          );
          suggestions.push('直接删掉 !important，在 DevTools 确认视觉不变');
        } else {
          // No lib found and no internal competitors
          verdict = 'manual';
          const libMsg = rule.isDeep
            ? '未找到对应组件库 dist，无法检查内联样式和 CSS 竞争'
            : '文件内无竞争规则，可能覆盖外部全局样式';
          reasons.push(libMsg);
          suggestions.push('在 DevTools 去掉 !important，观察是否有其他规则生效');
        }

        findings.push({
          selector: rule.selector,
          compiledSpec: rule.compiledSpec,
          baseSpec: rule.specificity,
          isDeep: rule.isDeep,
          property: decl.property,
          value: decl.value,
          line: decl.line,
          scoped: block.scoped,
          verdict,
          reasons,
          suggestions,
          internalCompetitors,
          libSources,
        });
      }
    }
  }

  // ── Output ───────────────────────────────────────────────────────────────
  const short = filePath.replace(cwd + '/', '');
  console.log(c.bold(`\n!important 完整分析：${short}`));
  console.log(c.gray('─'.repeat(64)));

  if (findings.length === 0) {
    console.log(c.green('✓ 未发现 !important 声明'));
    return;
  }

  const needed = findings.filter(f => f.verdict === 'needed');
  const removable = findings.filter(f => f.verdict === 'removable');
  const manual = findings.filter(f => f.verdict === 'manual');

  function printGroup(label: string, color: (s: string) => string, icon: string, items: Finding[]) {
    if (items.length === 0) return;
    console.log(color(`${icon} ${label} (${items.length})`));
    for (const f of items) {
      const tags = [f.scoped ? c.dim('scoped') : c.dim('global'), f.isDeep ? c.dim(':deep') : '']
        .filter(Boolean)
        .join(' ');

      console.log(
        `  ${color(`L${f.line}`)} [${tags}]  ` +
          c.bold(f.property) +
          ': ' +
          c.dim(truncate(f.value, 55)) +
          ' ' +
          color('!important'),
      );
      const specNote =
        f.scoped && f.baseSpec[1] !== f.compiledSpec[1]
          ? ` → compiled ${specStr(f.compiledSpec)} (含[data-v-xxx]×${f.compiledSpec[1] - f.baseSpec[1]})`
          : '';
      console.log(c.gray(`    selector : ${f.selector}  ${specStr(f.baseSpec)}${specNote}`));
      for (const r of f.reasons) console.log(c.gray(`    reason   : ${r}`));
      for (const s of f.suggestions) console.log(c.cyan(`    suggest  : ${s}`));

      // Show lib sources
      const inlineSources = f.libSources.filter(s => s.kind === 'inline');
      const cssSources = f.libSources.filter(s => s.kind === 'css');
      if (inlineSources.length > 0) {
        for (const s of inlineSources) {
          console.log(
            c.magenta(`    lib[inline]: ${s.file}`) +
              (s.evidence ? c.gray(`  → ${truncate(s.evidence, 70)}`) : ''),
          );
        }
      }
      if (cssSources.length > 0) {
        for (const s of cssSources) {
          const beats = s.specificity ? cmpSpec(f.compiledSpec, s.specificity) < 0 : false;
          const marker = beats ? c.red(' ← beats compiled') : c.gray(' ← loses');
          console.log(
            c.gray(
              `    lib[css]  : [${s.selector}] ${specStr(s.specificity!)}  → ${truncate(s.value ?? '', 40)}`,
            ) + marker,
          );
        }
      }
      console.log();
    }
  }

  printGroup('!important 必须保留', c.red, '✗', needed);
  printGroup('可安全去掉', c.green, '✓', removable);
  printGroup('需人工确认（DevTools）', c.yellow, '?', manual);

  console.log(c.gray('─'.repeat(64)));
  console.log(c.bold('汇总'));
  console.log(`  ${c.red(`✗ ${needed.length}  !important 必须保留`)}`);
  console.log(`  ${c.green(`✓ ${removable.length}  可安全去掉`)}`);
  console.log(`  ${c.yellow(`? ${manual.length}  需人工确认`)}`);
  console.log();
}

function truncate(s: string, max: number) {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
}

// ── Entry ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error(
    c.red('Usage: pnpm tsx .claude/skills/analyze-important/scripts/analyze.ts <file.vue> [...]'),
  );
  process.exit(1);
}
const cwd = process.cwd();
for (const f of args) analyzeFile(f, cwd);
