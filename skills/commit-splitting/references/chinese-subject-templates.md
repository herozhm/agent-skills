# 中文 Subject 模板

这个文件用于稳定 `commit-splitting` 生成中文 Conventional Commit subject 的语气和句型。

## 一、默认风格

优先使用短句、动词开头、面向结果的中文 subject。

推荐动词：

- `添加`
- `修复`
- `完善`
- `简化`
- `更新`
- `收敛`
- `调整`
- `重构`
- `补充`

避免：

- 过长的解释句
- “为了……所以……”这类原因前置句
- 把实现细节直接写进 subject

## 二、按 Type 推荐模板

### `feat`

```text
feat(<scope>): 添加 <能力>
feat(<scope>): 支持 <能力>
feat(<scope>): 引入 <机制/流程>
```

示例：

```text
feat(skills): 添加 workspace 管理相关 skills
feat(app): 支持统一 UI provider 入口
```

### `fix`

```text
fix(<scope>): 修复 <问题>
fix(<scope>): 解决 <异常/回归>
fix(<scope>): 纠正 <错误行为>
```

示例：

```text
fix(xcs-extension/compiler): 修复 proto 对齐后的类型回归
fix(app): 解决弹窗 z-index 冲突
```

### `docs`

```text
docs(<scope>): 更新 <文档主题>
docs(<scope>): 完善 <文档主题>
docs(<scope>): 补充 <说明/方案>
```

示例：

```text
docs(workspace): 完善 UI 组件库统一实施计划
docs(schemas/docs): 补充 schema 契约说明
```

### `refactor`

```text
refactor(<scope>): 重构 <模块/流程>
refactor(<scope>): 收敛 <入口/边界>
refactor(<scope>): 简化 <结构/流程>
```

示例：

```text
refactor(app): 收敛运行时 provider 注册入口
refactor(legacy-ui): 简化旧组件桥接层导出
```

### `chore`

```text
chore(<scope>): 更新 <配置/元数据>
chore(<scope>): 调整 <脚本/规则>
chore(<scope>): 清理 <遗留项>
```

示例：

```text
chore(scripts): 简化 xcs-extension 同步脚本名称
chore(workspace): 添加 AGENTS.md 多代理配置
```

## 三、Body 句型建议

当需要 body 时，优先写 1 到 3 行高信息密度说明：

```text
<概括这次改动是什么，为什么需要做>

- <第一类变化>
- <第二类变化>
- <风险或边界>
```

示例：

```text
收敛 project 应用中的 UI provider 注册入口，避免多套 UI 方案多处重复注入。

- 抽离统一 runtime shell
- 移除 main.ts 中重复 provide
- 保留 xcs-ui 兼容出口，降低迁移风险
```

## 四、选择建议

- 改动是新增能力，用 `添加` / `支持`
- 改动是消除问题，用 `修复` / `解决`
- 改动是补文档，用 `完善` / `补充` / `更新`
- 改动是收边界、降复杂度，用 `收敛` / `简化` / `重构`

如果拿不准，优先选择更保守、更贴近结果的词，而不是夸大改动范围。
