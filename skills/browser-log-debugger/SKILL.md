---
name: debugger
description: 运行时调试技能 —— 启动本地 HTTP 日志服务，让浏览器代码通过 fetch 上报状态到磁盘文件，由 Claude 直接读取分析（避免用户从 console 复制）。触发词：debugger 技能、debugger skill、调试、上报日志、本地日志服务、fetch 上报、远程 log、打 log 排查、想看运行时状态。
---

## 何时使用

- 浏览器代码里某个值我（Claude）想知道，但 console.log 用户得手工复制回来太麻烦
- 多步交互产生的状态变化要按时序汇总
- 跨多个文件 / store / 组件 想统一收集运行时数据
- 单步调试不便，需要"打 log → 用户复现 → 我直接读 log 文件"的快速循环

## 三条铁律

1. **根因优先**：追到根因层再修，禁止打补丁。
2. **注入即验证**：注入前完整读当前文件、注入后自查引用与语法。禁止凭旧上下文推测代码结构。
3. **修复后先问再清理**：数据符合预期 ≠ 修好。等用户在 UI 上明确回复"现象消失"再清理 debug 痕迹和关 server。

## 工作流（6 步）

### Step 1 — 启动日志服务（后台）

```bash
pnpm exec tsx .claude/skills/debugger/scripts/log-server.ts
```

- 必须用 `run_in_background: true`，**不要前台阻塞**
- 默认端口 7777，写到 `/tmp/debug-log.log`
- **每次启动清空文件**，所以每个会话日志干净
- 可选 env：`PORT=8888 LOG_FILE=/tmp/foo.log pnpm exec tsx ...`
- 启动后用 `until curl -s -o /dev/null -w "%{http_code}" -X POST http://localhost:7777/log -d '{}' -H "Content-Type: application/json" | grep -q 200; do sleep 1; done` 等就绪

### Step 2 — 在要调试的位置直接写 fetch

> ⚠️ 参见**铁律 2**：注入前完整读当前文件，注入后自查引用与语法。

**不要注入 helper 函数**，每条上报就是一行 fetch + 行尾 `[debugger-skill]` 标签：

```ts
fetch("http://localhost:7777/log", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    label: "语义化标签字符串",
    // 在 body 里**直接列出关键字段**，不要 dump 整个对象（避免循环引用）
    foo: someValue,
    barIsTruthy: !!barRef,
    canvasScaled: canvas?.viewportScaled,
  }),
  keepalive: true,
}).catch(() => {}); // [debugger-skill]
```

**强制约定：**

- **不 dump 整个对象**：PIXI canvas、Vue ref、DOM 元素都有循环引用，`JSON.stringify` 直接抛错。挑你想看的标量字段（数字、字符串、布尔），引用类型用 `!!x` / `x?.id` / `x?.length` / `Object.keys(x)`。
- **行尾必须带 `// [debugger-skill]` 标签** —— 清理凭这个 grep。
- **多行块**用 `// [debugger-skill] BEGIN` / `// [debugger-skill] END` 包裹。
- **`keepalive: true` 必加**，防止页面切换 / unload 时丢日志。
- **`.catch(() => {})` 必加**，防止 server 没起来时报错污染原业务逻辑。

### Step 3 — 提示用户复现，停下等回复

打好 log 后，**主动**告诉用户类似：

> 已注入调试 fetch（X 处、Y 处），请你去浏览器复现一次问题（操作 Z）。复现完告诉我"已操作"，我读 `/tmp/debug-log.log` 分析。

然后**停下来等用户回复**。**不要**继续修代码、不要继续打 log。这一步是 skill 强制约定 —— 跳过会拿不到真实数据。

### Step 4 — 读日志分析

> ⚠️ 参见**铁律 1**：分析时已经要分流派——是补丁方案就还没找到根因，加更多 log 继续挖。

用户回复后：

```bash
cat /tmp/debug-log.log
```

读完直接分析。如果数据不够再回 Step 2 加更多 log，再回 Step 3 让用户复现一次。

**心里有多条假设时，列给用户看**：把候选根因 A/B/C 写在回复里，标明倾向和排除理由，让用户能在你定方向前纠偏。不要把假设藏在 thinking 里、对外只说"我怀疑是 X"。

### Step 5 — 写修复代码，提示用户验证

定位到根因后，写修复代码。**主动**告诉用户：

> 已根据日志定位到 X，修了 Y。请你去浏览器验证一下，告诉我现象是否消失了。

然后**停下来等用户明确回复**。

### Step 6 — 清理调试代码（用户确认现象消失后）

> ⚠️ 参见**铁律 3**：等用户明确确认 UI 上现象消失再清理。

用户确认修复有效后：

```bash
# 1. 找出所有注入点（在仓库根目录运行）
grep -rn "\[debugger-skill\]" .

# 2. 对每条匹配，用 Edit 工具：
#    - BEGIN/END 块：删除整块（包括两条标签注释行）
#    - 行级标签：删除整行
#    - 临时 import：删除整行

# 3. 验证清理干净：
grep -rn "\[debugger-skill\]" .
# 期望：无输出（除 .claude/skills/debugger/SKILL.md 自身的引用外）

# 4. 停日志服务：
lsof -ti:7777 | xargs -r kill

# 5. 删日志文件（可选）：
rm -f /tmp/debug-log.log
```

**注意**：清理时**不要碰** `.claude/skills/debugger/` 下的任何文件 —— skill 本身保留供下次复用。

## 标签规范

### 行级（最常用）

```ts
fetch(...).catch(() => {}); // [debugger-skill]
import { foo } from 'bar';  // [debugger-skill]
const tmpVar = something;   // [debugger-skill]
```

### 块级（多行调试逻辑、try/catch 包装）

```ts
// [debugger-skill] BEGIN — 简短说明
try {
  doSomething();
} catch (e) {
  fetch("http://localhost:7777/log", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "caught", message: e?.message }),
    keepalive: true,
  }).catch(() => {});
}
// [debugger-skill] END
```

## 常见陷阱

- **循环引用**：`JSON.stringify` 在 PIXI canvas、Vue ref、DOM 元素上会抛 `TypeError: Converting circular structure to JSON`。**只 log 标量字段**，引用类型用 `!!x` / `x?.id`。
- **大 payload**：log-server 把 body 累加在内存。建议每条 < 10KB。
- **跨域**：log-server 已设 `Access-Control-Allow-Origin: *`，任何 origin 都能 POST。
- **不要用作生产监控**：本服务只在本机 localhost，无认证、无持久化、每次启动清空。
- **顺序敏感的 log**：每条带 ISO 时间戳前缀，但 fetch 是异步的，复杂场景下落盘顺序≠发起顺序。需要严格顺序时，加自增计数器到 payload：
  ```ts
  let __dbgSeq = 0; // [debugger-skill]
  fetch(..., { body: JSON.stringify({ seq: ++__dbgSeq, ... }) }); // [debugger-skill]
  ```

## 端口冲突

默认 7777。如果占用：

```bash
PORT=8888 pnpm exec tsx .claude/skills/debugger/scripts/log-server.ts
```

**记住把注入的 fetch URL 也改成 :8888**（不要忘）。

## 工作流速查

```
1. 启动 server (后台)
2. 注入 fetch 到代码里（带 [debugger-skill] 标签）
   ⚠ 铁律2：先完整读文件 → 写 → 再读一次自查
3. 提示用户复现 → 等回复 ⏸
4. cat /tmp/debug-log.log 分析
   (数据不够回 2)
   ⚠ 铁律1：要追到根因，不接受补丁方案
5. 写修复 → 提示用户去浏览器验证 → 等回复 ⏸
   ⚠ 铁律3：必须等用户明确说"现象消失了"
6. grep [debugger-skill] 全部删除 + 关 server
```
