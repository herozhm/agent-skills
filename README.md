# agent-skills · AI 辅助研发时代的工程纪律 Skill 集

> 一组面向 **AI 辅助研发场景**的 Agent Skill：每个 skill 都内建**反模式封堵、量化阈值、验证判据与授权边界**——不只告诉 Agent 做什么，还预判它会怎么走捷径并提前封堵。

灵感与结构参考 [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)，差异化定位：**AI 时代的质量护栏**——每个 skill 背后都有真实项目的踩坑史。

## ✍️ Skill 设计方法论（本仓库所有 skill 遵循的五特征）

1. **写明适用与不适用边界**——防过度流程化
2. **关键规则多重冗余**——长上下文会稀释单次声明
3. **预判模型的合理化借口并逐条封堵**——「任务很明显」「规划是开销」「AI 写的直接能用」，每个借口配一条反驳
4. **量化阈值替代主观判断**——「超过 2 小时会话」「验收标准超 3 条」比「任务太大」可执行
5. **人工确认点内建成流程节点**——高危操作 human-led，不是可选建议

详见 `skills/automation-loop-init`（Loop 解剖 + 8 步问答）与 `skills/requirement-decompose` 风格的任务卡设计。

## 📦 Skills

### 调试与诊断

| Skill | 说明 |
|---|---|
| [`browser-log-debugger`](skills/browser-log-debugger/SKILL.md) | 本地 HTTP 日志服务：让页面代码通过 fetch 上报运行时状态到磁盘，AI 直接读取分析——解决「AI 看不到运行时」的痛点 |
| [`analyze-heapsnapshot`](skills/analyze-heapsnapshot/SKILL.md) | V8 内存快照分析：按构造函数聚合、detached DOM 检测、支配树 retained size、两张快照 diff |
| [`analyze-memory-trace`](skills/analyze-memory-trace/SKILL.md) | Chromium contentTracing 内存 dump 按进程拆解，判断泄露还是 GC 回收 |
| [`analyze-perf-trace`](skills/analyze-perf-trace/SKILL.md) | Performance trace 分析：长任务、强制重排、布局抖动、querySelector 风暴 |

### 规划与流程

| Skill | 说明 |
|---|---|
| [`automation-loop-init`](skills/automation-loop-init/SKILL.md) | 长任务自驱 Loop 脚手架：8 步问答生成 loop 文档 + 一句话启动指令，内置预算纪律与 Writer/Verifier 分离 |
| [`doc-gardening`](skills/doc-gardening/SKILL.md) | 文档巡检与自动修复：断链、过时 API、权威文档互相矛盾、陈旧文档，八阶段流程 |
| [`change-summary`](skills/change-summary/SKILL.md) | git 提交 → 三段式主题分组 changelog（新增/修复/发布），拒绝逐条搬运 commit message |

## 🚀 使用

把 `skills/<name>/SKILL.md` 的内容加入你的 Agent 上下文（Claude Code 用户放入 `.claude/skills/<name>/SKILL.md` 即可自动触发）。诊断类 skill 附带可执行脚本（`scripts/`），用 tsx 直接运行。

## 🧭 设计原则（为什么这套 skill 长这样）

- **失败语义显式**：每个任务的失败分支提前定义，失败信息贯通到最终出口
- **两层验证**：自动化验证（测试/CI）+ 真环境冒烟，缺一不可——「AI 写的直接能用」是本仓库重点封堵的反模式
- **预算纪律**：重试、轮数、耗时三重封顶，预算按最坏实测或语义化定
- **幂等产物**：重复执行先查重，禁止静默覆盖既有产出
