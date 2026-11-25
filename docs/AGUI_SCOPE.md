# AG-UI 1.0 协议范围冻结（AGUI_SCOPE.md）

- 项目：P031 RejoinLab（续流证）
- 规格版本：PROJECT_BOOK.md v1.0.2 / IMPLEMENTATION_PLAN.md v1.0.2
- 冻结任务：T001（环境盘点与协议契约冻结）
- 状态：FROZEN（后续任务 T002–T014 只依赖本文件 + `docs/EVENT_SCHEMA.md` + `src/protocol/types.ts` 施工，不得自行扩大协议范围）

## 1. 协议版本

| 项 | 冻结值 |
|---|---|
| 协议 | AG-UI 1.0（Agent-User Interaction Protocol） |
| 发布日期 | 2026-09-18（官方发布讨论创建于 2026-09-18T15:02:00Z，T001 已核对原文） |
| 规范 | https://docs.ag-ui.com/spec/1.0 |
| 事件页 | https://docs.ag-ui.com/spec/1.0/events |
| 基础概念页 | https://docs.ag-ui.com/spec/1.0/basic |
| JSON Schema | https://docs.ag-ui.com/spec/1.0/schema.json |
| 发布讨论 | https://github.com/ag-ui-protocol/ag-ui/discussions/2792 |
| Schema 本地冻结副本 | `docs/ag-ui-1.0-schema.json`（94,359 B，SHA-256 `4b5c93226838a0e72d88e6c5df20633c686c49fcb75d9be2815c6cbf9e48e71a`，2026-11-23 自官方 URL 取回，HTTP 200） |
| Schema `$id` | `https://ag-ui.com/spec/1.0/schema.json`，`$schema` 为 JSON Schema draft 2020-12 |

规则（PROJECT_BOOK §2.1）：

- 1.0 是冻结的、带版本号的协议合同；不以 0.x 草案作为字段权威。
- 不混用后续 draft 事件；不根据某个 SDK 的内部实现擅自修改协议定义。
- 事件字段以 AG-UI 1.0 JSON Schema 为准；事件顺序和生命周期以 AG-UI 1.0 行为规范（`spec/1.0/basic` 下的 patterns / transports）为准。
- 项目书 §3 的字段表与 Schema 不一致时，以 Schema 为准；差异见 `docs/EVENT_SCHEMA.md` §8。

> 注：个别第三方文章称 AG-UI 1.0 发布于 2026-09-30，与官方发布讨论（2026-09-18T15:02:00Z）的创建时间不符。冻结日期以官方讨论为准，即 2026-09-18。

## 2. MVP 支持的 15 种事件

以下 15 种事件是 RejoinLab MVP 的全部协议范围（PROJECT_BOOK §3.2，`src/protocol/types.ts` 中的 `AGUIEvent` 联合类型与之一一对应）：

| 组 | 事件 | 用途 |
|---|---|---|
| Run 生命周期 | `RUN_STARTED` | 开始一个 run |
| Run 生命周期 | `RUN_FINISHED` | 结束一个未报告失败的 run |
| Run 生命周期 | `RUN_ERROR` | 报告 run 失败；可出现在 `RUN_STARTED` 之前 |
| 文本消息 | `TEXT_MESSAGE_START` | 创建或重新打开一个文本消息 |
| 文本消息 | `TEXT_MESSAGE_CONTENT` | 向已打开消息追加 `delta` |
| 文本消息 | `TEXT_MESSAGE_END` | 关闭对应消息 |
| 文本消息 | `TEXT_MESSAGE_CHUNK` | chunked 简写；进入 Reducer 前必须展开为 START / CONTENT / END |
| 工具调用 | `TOOL_CALL_START` | 开始一个工具调用 |
| 工具调用 | `TOOL_CALL_ARGS` | 按到达顺序追加参数片段 |
| 工具调用 | `TOOL_CALL_END` | 关闭工具调用参数流 |
| 工具调用 | `TOOL_CALL_CHUNK` | chunked 简写；进入 Reducer 前必须展开为 START / ARGS / END |
| 工具调用 | `TOOL_CALL_RESULT` | 创建一个 tool message 并关联到对应调用 |
| 状态 | `STATE_SNAPSHOT` | 完整替换共享状态 |
| 状态 | `STATE_DELTA` | RFC 6902 JSON Patch，按序、原子应用 |
| 状态 | `MESSAGES_SNAPSHOT` | 声明生产者拥有的完整消息集合（协调式，非整体覆盖） |

通用规则：

- 每条事件必须包含 `type`（Schema `BaseEvent.required = ["type"]`）。
- 公共可选字段：`timestamp`（整数，仅信息性）、`rawEvent`（原样携带的提供方原生事件）、`metadata`（open-by-key，`ag-ui` 键保留给协议）。
- 所有事件按文件中的**到达顺序**排列；**禁止用 `timestamp` 重新排序**（PROJECT_BOOK §3.1；Schema 明确 `timestamp` 的单位不受约束）。
- MVP 的算法范围固定为 parent-agent 主流程，不展开 Subagent 生命周期。遇到需要 Subagent 独立归约的样本时，报告 `INCONCLUSIVE_LIMIT`，不得假装已完整支持。

## 3. 明确不支持的事件

遇到以下事件，不得静默删除后继续声称一致；必须报告 `INCONCLUSIVE_LIMIT` 或 `INVALID_INPUT`，并指出事件位置和类型（PROJECT_BOOK §3.2）：

| 不支持 | 说明 |
|---|---|
| `STEP_STARTED` / `STEP_FINISHED` | AG-UI 1.0 有定义，MVP 不实现 |
| `REASONING_START`、`REASONING_MESSAGE_START`、`REASONING_MESSAGE_CONTENT`、`REASONING_MESSAGE_END`、`REASONING_MESSAGE_CHUNK`、`REASONING_END`、`REASONING_ENCRYPTED_VALUE` | 全部 `REASONING_*`，MVP 不实现 |
| `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` | 全部 `ACTIVITY_*`，MVP 不实现（注意：Schema 的 `EventType` 枚举包含这两者，但它们不在 15 事件清单内） |
| `SUBAGENT_STARTED` / `SUBAGENT_FINISHED` / `SUBAGENT_ERROR` | 全部 `SUBAGENT_*`，MVP 不展开 Subagent 生命周期 |
| `RAW` | 透传原生事件，MVP 不实现 |
| `CUSTOM` | 应用自定义事件，MVP 不实现 |
| 未列出的 draft events | 任何不在 AG-UI 1.0 Schema `EventType` 枚举中的类型，以及 1.0 之后 draft 新增的类型 |

补充：`subagentRunId` 是 Schema `$defs/Attributable` 的唯一属性，通过 `allOf` 组合进 11 种 MVP 事件（`TEXT_MESSAGE_*` 全部 4 个、`TOOL_CALL_*` 全部 5 个、`STATE_SNAPSHOT`、`STATE_DELTA`），是这些事件的合法可选字段；只有 `RUN_STARTED`、`RUN_FINISHED`、`RUN_ERROR`、`MESSAGES_SNAPSHOT` 这 4 个没有它（Schema `Attributable` 描述原文亦如此说明）。MVP 按 parent-agent 主流程范围**不使用该字段做归约**，`src/protocol/types.ts` 不含该字段是范围决定，保留不动。带该字段的 MVP 事件到达时的处理规则见 `docs/EVENT_SCHEMA.md` §7。

## 4. 三类标识符的边界

这是本项目最容易出错的边界，冻结如下（PROJECT_BOOK §4）：

### 4.1 AG-UI 协议标识符（协议层）

| 标识符 | 含义 | 规则 |
|---|---|---|
| `threadId` | 对话身份 | 同一对话跨 run 稳定 |
| `runId` | 单次运行身份 | 同一 thread 内不得用于另一次不同的 run；重跑是**新 runId 的新 run** |
| `messageId` | 消息身份 | 同一 thread 内唯一，可跨 run 重述；关闭后可用相同 ID 合法重新打开（须保持 owner / role / name 一致） |
| `toolCallId` | 工具调用身份 | 关联调用、参数、结果；关闭后可用相同 ID 重新打开（须保持 toolCallName / parentMessageId / owner 一致） |
| `eventId` | **AG-UI 1.0 不定义** | `BaseEvent` 没有 `eventId` 字段。不得伪造为标准事件字段，不得把它当作恢复游标，不得在事件对象里凭空构造一个 |

所有 AG-UI 标识符都是 opaque strings，不解析其中的内部结构。

### 4.2 SSE 传输层标识符（传输层，不是协议层）

- SSE 的 `id:` 字段是 WHATWG SSE 传输层字段。RejoinLab 解析 SSE 文件时保留其原值，记为 `transportEventId`，仅作传输层原始证据。
- `transportEventId` **不是** AG-UI `eventId`，**不是** AG-UI 恢复游标，**不参与** Reducer 状态计算，不得用于去重判定（去重判定见 PROJECT_BOOK §4.3，只能报告 `SUSPECTED_DUPLICATE`）。
- AG-UI 1.0 HTTP+SSE 绑定规定：消费者**必须忽略**除 `data` 之外的 SSE 字段（`event:`、`id:`、`retry:`），并容忍 SSE 注释行（`: keep-alive`）。生产者必须用 LF（`\n`）分帧；消费者可额外接受完整 SSE 语法（CR / CRLF）。
- 每个 SSE `data` 对应一个完整 AG-UI JSON 事件；多行 `data` 字段按 SSE 规范拼接。

### 4.3 RejoinLab 本地标识符（实验层，不是协议层）

| 本地字段 | 定义 | 有效范围 |
|---|---|---|
| `sourceIndex` | 本次导入文件内从 0 开始的顺序编号 | 仅本次导入文件内有效；不参与 AG-UI 语义 |
| `sourceEventKey` | 用户提供的额外稳定事件标识；否则为 `null` | 仅作证据引用 |
| `resumeAfterSourceIndex`（恢复游标） | 恢复分支从已应用的最后一个检查点 `sourceIndex` 之后的第一条事件开始 | 仅本次本地导入文件内有效；**不等同于** SSE Last-Event-ID；**不等同于** AG-UI eventId；不代表服务器支持真实恢复；不用于建立网络连接 |
| `FULL_REPLAY_FROM_START` | 从原始轨迹开头重新发送全部历史事件的本地实验路径 | 本地模拟，不是协议恢复 |

本地包装结构（IMPLEMENTATION_PLAN §5.1）：

```json
{
  "sourceIndex": 12,
  "sourceEventKey": null,
  "transportEventId": null,
  "event": { "type": "TEXT_MESSAGE_CONTENT", "messageId": "msg-1", "delta": "Hello" }
}
```

## 5. HTTP+SSE 无恢复机制（冻结事实）

以下为 AG-UI 1.0 官方规范原文事实，T001 已于 2026-11-23 从规范页逐字核对（https://docs.ag-ui.com/spec/1.0/basic/transports/http-sse ，§No resumption / §Errors / §Response）：

1. **该绑定没有流恢复（No resumption）**。原文：

   > "The binding has no stream resumption: SSE's Last-Event-ID mechanism is not used, and a broken stream cannot be re-entered. Re-running is a new run with a new runId, whose input carries whatever the consumer retained."

2. **连接中断且无终止事件时，该 run 为 truncated（截断）**。原文：

   > "A connection that drops without a terminal event is a truncated run."

   流在终止事件前结束时，RejoinLab 报告 `TRUNCATED_RUN` / `INCOMPLETE_TRACE`，不得把用户断开直接伪装成 `RUN_FINISHED`。
3. **Last-Event-ID 不是 AG-UI 恢复游标**。WHATWG SSE 定义了浏览器重连时发送 Last-Event-ID 的机制（PROJECT_BOOK E03），但 AG-UI 1.0 标准 HTTP+SSE 绑定**不使用**它。RejoinLab 不执行真实网络重连，只用本地 `sourceIndex` 游标和实验配置模拟恢复位置。
4. **HTTP 200 不代表成功**。流打开后的失败以流内 `RUN_ERROR` 传递；HTTP 状态已发送、无法更改；消费者不得仅凭 200 推断成功。HTTP 错误状态且无事件流时，该 run 从未开始。
5. **生产者在最后一个 run 的终止事件后关闭响应体**。一个 POST 携带一个请求；但当生产者在重放某 thread 的历史时，一个响应可携带多个 run。
6. **不执行真实网络重连**是 RejoinLab 的产品边界（PROJECT_BOOK §2.4、§4.5）：恢复实验全部是本地重放/快照恢复模拟。

## 6. 证据来源（E01–E03）

| 证据 | 内容 | 核实 |
|---|---|---|
| E01 官方事件规范 | AG-UI 1.0 Specification：Run 生命周期、文本消息流、工具调用流、状态快照与增量、消息快照、事件标识符、事件到达顺序、SSE 与 Protobuf 等传输绑定 | 2026-11-23，T001 自官方 URL 取回 Schema 与规范页并核对字段（见 §1 与 `docs/EVENT_SCHEMA.md`） |
| E02 真实故障 Issue | AG-UI #1524（2026-04-15，`TOOL_CALL_START` 重放导致重复工具调用，对应 Golden G01）、#3119（2026-10-19，`MESSAGES_SNAPSHOT` 换 ID 导致顺序错乱，对应 G02）、#3368（2026-11-11，同一 messageId 重开后文本落到工具调用之前，对应 G03），三者核实状态均为 Open | 项目书 §2.3 冻结；T001 未改动。注意：三 Issue 只证明存在具体工程故障，不证明所有实现都有同样问题，也不证明某个已测行业发生率 |
| E03 WHATWG SSE | WHATWG HTML Living Standard §9.2 Server-sent events：浏览器重连可发 Last-Event-ID；SSE `id` 更新 last event ID；事件按收到顺序处理 | 项目书 §2.4 冻结。E03 只支持 SSE 定义了 Last-Event-ID 重连语义，**不支持** AG-UI 1.0 SSE 绑定使用 Last-Event-ID 恢复 |

## 7. 冻结决定（不得擅自更改）

- 协议版本冻结为 AG-UI 1.0，不跟随 draft。
- 15 事件清单冻结；不支持清单冻结。
- `eventId` 不存在；`transportEventId` 与 `sourceIndex` 是本地字段，不是协议字段。
- HTTP+SSE 无恢复；`resumeAfterSourceIndex` 只是本地实验游标。
- 字段必填/可选以 Schema 为准（`docs/EVENT_SCHEMA.md` §8 列出与项目书文字的差异点）。
- 任何协议解释冲突：回到 AG-UI 1.0 原文和 Schema，提交 ADR，不得用实现方便性改变规范（IMPLEMENTATION_PLAN T003 失败回退，同样适用于 T001 的冻结）。
