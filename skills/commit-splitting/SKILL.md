---
name: commit-splitting
description: 在 git 工作区中分析真实改动、生成 Conventional Commits 提交信息或直接执行提交。适用于生成 commit、帮我提交、根据 diff 写提交信息、只提交某些文件、脏工作区按边界拆分提交。多模块 / Monorepo 项目的提交拆分纪律:按边界分组、自动修复独立成 commit、staged-first 原则。
---

# Commit Splitting — 按边界拆分提交

## 目标

基于当前工作区真实改动,**直接执行**边界清晰、范围准确的 commit(一个或多个)。遵循 Conventional Commits,中文 subject。

## 何时使用

- 生成 commit / 帮我提交 / 根据 diff 写提交信息 / 只提交某些文件
- 按 Conventional Commits 规范创建提交
- 脏工作区(多模块同时改动)需要拆分提交

## 核心纪律

### Staged-first 原则

1. 先看 `git status --short`,区分 staged / unstaged / untracked / 无关改动
2. **有 staged**:仅基于 staged 改动生成 commit,**绝不主动 add 任何未 staged 的文件**
3. **staged 与 unstaged 并存**:只提交 staged 部分,unstaged 保留在工作区
4. **无 staged 且用户没指定文件**:停止,请用户先手动暂存(或明确授权「按边界自动暂存」模式)

### 自动修复独立成 commit

`lint:fix`、格式化等**自动改写必须独立成一个 commit**,禁止塞进重构/功能大提交——自动改写可能悄悄改变语义(真实案例:某 lint 规则把 `.find(x) !== undefined` 改成恒真的 `.some(x) !== undefined`,且静默不报警)。隔离成独立提交,语义变化才能在 diff 里被看见、被审、可单独回退。

**跑过任何自动修复之后,暂存前逐块过一遍**,不要盲 git add。

### 不越权动作

- 不擅自 --amend / rebase / reset / squash
- hook 失败 → 报告原因,不自动绕过
- 用户说「生成 commit」默认直接执行;说「只生成 message」时只输出 message

## 多 commit 拆分策略

| 优先级 | 分组维度 | 示例 |
|---|---|---|
| 1 | 顶层协作文档 vs 业务代码 | README/docs 一个,业务代码一个 |
| 2 | 不同模块/包 | 模块 A 与模块 B 分开 |
| 3 | 同模块内功能差异明显 | 多语言更新 vs 逻辑修改 |

单边界内改动集中 → 合并为一个 commit;lockfile 跟随主要改动所在边界一起提交。

## scope 推断

- 跟随 `git log -5 --oneline` 的既有风格,不凭空发明
- 层级约定:子项目/包名 → 模块 → 功能目录
- 无法诚实推断单一 scope → 退回较大稳定 scope(如项目名、workspace)
- 复杂项目可配「路径 → scope」推断表(脚本化或文档化,团队共享)

## Gotchas(全部来自真实踩坑)

- 不要把用户未要求提交的无关文件一起带上
- 不要因为顶层有文档改动就顺手把业务改动一起带上
- 凭空发明 scope 是大忌——优先跟随仓库既有风格
- 自动修复类改动混进功能提交 = 回滚时被迫连坐(真实发生过)

## 参考文件

- [中文 subject 模板](references/chinese-subject-templates.md)——稳定中文提交信息的语气和句型
