---
name: error-code-schema
description: 当错误码定义散落在多个模块/仓库、格式不一致、没有统一的地方能查「这个错误是什么、该怎么办、谁来处理」时使用;或新增错误码需要命名规范、severity 分级、recoveryActions(恢复动作)、rawMappings(原始码映射)指导时使用;或需要生成/更新统一的 JSON Schema 错误注册表时使用。
---

# error-code-schema——统一错误码注册表

## 问题本质

一个错误要有意义,必须回答三个问题:

```
发生了什么? → 该怎么办? → 谁来处理?
(识别)        (行动)       (路由)
```

根本问题:**生产者和消费者之间没有契约**——上游报了一个错误码,下游拿到字符串,不知道该弹窗还是静默,不知道给用户什么恢复建议。

**本 skill 交付契约的数据层**(规范层 + 数据层)。运行时映射层和治理层(CI 校验)是独立工程任务。

## 范围边界

| 层 | 内容 | 本 skill |
|---|---|---|
| 规范层 | 命名格式、severity、字段定义 | ✅ |
| 数据层 | 扫描存量,生成 registry | ✅ |
| 运行层 | raw code → canonical key | ❌ 独立任务 |
| 治理层 | CI 校验,强制新错误入册 | ❌ 独立任务 |

## 消费者优先(设计注册表字段前,先确认消费者需要什么)

| 消费者 | 需要的字段 |
|---|---|
| UI 层 | severity、userActionable、recoveryActions |
| 埋点/监控 | key(稳定 ID)、domain、severity |
| 客服/支持 | key、recoveryActions(如 FAQ 链接) |
| 开发者调试 | 自描述的 key、rawMappings(原始码映射) |

## 五阶段工作流

### Phase 1: Scan——定位存量

盘点所有端的错误码定义文件:设备端/后端(字符串三段式或数字枚举)、前端(TypeScript enum)、服务端(Proto enum)、契约层(JSON Schema)。标记空 stub(优先处理——空定义是最容易漏的)。

### Phase 2: Parse——各端解析规则

不同端的错误码格式不同,逐端定义解析规则:

- **点分隔字符串**(如 CATEGORY.MODULE.DETAIL):key → rawCode,value 按段拆;有 DETAIL 是三段式,末尾无 DETAIL 是两段式
- **数字枚举**:算法类错误,带 key: number 映射
- **TypeScript enum / Proto enum**:直接解析

**faqUrl 等附加信息** → 转成 recoveryActions 数组。

### Phase 3: Severity 归一化

不同端的严重级别口径不一,统一映射到一个标准分级(如 critical / error / warning / info),映射表显式声明——**口径差异靠映射表而不是猜**。

### Phase 4: CATEGORY → domain 映射

错误类别(如水温/电压/通信)映射到业务 domain,同样是显式映射表——**映射表就是两个团队之间的契约**。

### Phase 5: 生成 registry

汇总生成统一的 JSON 注册表,每个错误码包含:稳定 key、各端 rawMappings、severity、domain、recoveryActions。

## 新增错误码规范

- key 用自描述格式(domain.action.detail),字面量即含义
- 避免裸数字或简写
- 每个 key 必须有 recoveryActions(哪怕只是「联系支持」)

## 检查清单

- [ ] 无重复 key
- [ ] severity 在合法枚举内
- [ ] 每个错误码有 recoveryActions
- [ ] 已进注册表(新的错误码必须入册,CI 校验强制)

## 常见问题

- **两套编码并存怎么办?** → 显式的 rawMappings 映射表,双写期间两边都查得到,迁移完下线旧表
- **空 stub 要不要入册?** → 要——空定义最容易漏,入册后用 CI 校验逼着补全
- **注册表谁维护?** → 契约层仓库,变更走 code review——它是生产者和消费者的共同契约,改动必须双方可见
