# AG-UI 1.0 事件 Schema 冻结（EVENT_SCHEMA.md）

- 项目：P031 RejoinLab（续流证）
- 规格版本：PROJECT_BOOK.md v1.0.2 / IMPLEMENTATION_PLAN.md v1.0.2
- 冻结任务：T001
- 状态：FROZEN
- 权威来源：AG-UI 1.0 JSON Schema（https://docs.ag-ui.com/spec/1.0/schema.json ，本地冻结副本 `docs/ag-ui-1.0-schema.json`，SHA-256 `4b5c93226838a0e72d88e6c5df20633c686c49fcb75d9be2815c6cbf9e48e71a`）与 AG-UI 1.0 行为规范（`spec/1.0/basic`：Streaming Messages、Snapshots and Deltas、HTTP + Server-Sent Events）。T001 已于 2026-11-23 自官方 URL 取回原文并逐字段核对。
- TypeScript 冻结类型：`src/protocol/types.ts`（与本文件一一对应）。

## 0. 阅读规则

- 下表「必填 / 可选」以 Schema 各事件定义的 `required` 数组为准。
- 「类型」栏写 Schema 类型；`string` 未注明枚举时为任意字符串；`JsonValue` 为任意 JSON 值。
- 行为规则（打开/关闭纪律、chunk 展开、快照协调）来自规范 prose 页，Schema 不表达这部分；已在各节注明出处。
- 项目书 §3 的字段表与 Schema 不一致处，见 §8；一律以 Schema 为准（PROJECT_BOOK §2.1）。

## 1. 公共字段（所有事件，Schema `BaseEvent`）

| 字段 | 必填/可选 | 类型 | 语义要点 |
|---|---|---|---|
| `type` | 必填 | 枚举（见 §2） | 事件种类；每种事件定义将其收窄为单一常量 |
| `timestamp` | 可选 | integer | 事件创建时间。**单位不受 Schema 约束**；仅信息性，**不得用于排序**，不得替代事件到达顺序 |
| `rawEvent` | 可选 | 任意 JSON | 提供方原生事件，原样携带，供调试；**不得执行** |
| `metadata` | 可选 | object（open-by-key） | 附加信息；任意 JSON 值（含 null）可作键值；`ag-ui` 键保留给协议；对象本身可缺席，但出现时永不为 null |

**没有 `eventId` 字段。** `BaseEvent` 不定义 `eventId`；15 种 MVP 事件的定义中也没有它。见 `docs/AGUI_SCOPE.md` §4。

## 2. 事件类型枚举

Schema `EventType` 枚举共 31 个值。MVP 只用其中 15 个（本文件 §3–§5）；其余 16 个（`STEP_STARTED`、`STEP_FINISHED`、`REASONING_START`、`REASONING_MESSAGE_START`、`REASONING_MESSAGE_CONTENT`、`REASONING_MESSAGE_END`、`REASONING_MESSAGE_CHUNK`、`REASONING_END`、`REASONING_ENCRYPTED_VALUE`、`ACTIVITY_SNAPSHOT`、`ACTIVITY_DELTA`、`SUBAGENT_STARTED`、`SUBAGENT_FINISHED`、`SUBAGENT_ERROR`、`RAW`、`CUSTOM`）在 MVP 中不支持（`docs/AGUI_SCOPE.md` §3）。

## 3. Run 生命周期事件

### 3.1 RUN_STARTED

| 字段 | 必填/可选 | 类型 | 语义要点 |
|---|---|---|---|
| `type` | 必填 | `"RUN_STARTED"` | |
| `threadId` | 必填 | string | 对话身份；同一对话跨 run 稳定 |
| `runId` | 必填 | string | 单次运行身份；同一 thread 内不得用于另一次不同的 run |
| `protocolVersion` | 可选 | string | 生产者自己宣称的协议版本，如 `"1.0"` |
| `parentRunId` | 可选 | string | 派生出本次 run 的父 run（Agent 调用另一 Agent 作为独立 run 时） |
| `input` | 可选 | `RunAgentInput` | 本次 run 的请求输入回显；`RunAgentInput` 必填 `threadId`、`runId`、`messages`，可选 `state`、`tools`、`context`、`resume` 等 |

语义：开始一个 run。`input` 如存在，提供该 run 开始时的输入消息和状态。

### 3.2 RUN_FINISHED

| 字段 | 必填/可选 | 类型 | 语义要点 |
|---|---|---|---|
| `type` | 必填 | `"RUN_FINISHED"` | |
| `threadId` | 必填 | string | 所关闭 run 所属的对话（见 §8 差异 D-01；项目书 §3.4（v1.0.2）已并入三者必填，与 Schema 一致） |
| `runId` | 必填 | string | 所关闭的 run |
| `result` | 可选 | 任意 JSON | run 的返回值（如果有） |
| `outcome` | 可选 | `RunFinishedOutcome` | 见下；缺席 = 成功 |
| `usage` | 可选 | array | 每 provider / 模型一条 token 用量记录 |

`outcome`（Schema `RunFinishedOutcome`，三选一）：

| `outcome.type` | 含义 | MVP 处理（PROJECT_BOOK §3.4） |
|---|---|---|
| 缺席 | 成功 | 正常成功；可带 `pendingToolCallIds` |
| `"success"` | 成功 | 正常结束；`pendingToolCallIds`（可选，string 数组）列出本 run 发起且未收到结果、留待应用在下一次输入消息中回答的前端工具调用，按发起顺序排列 |
| `"cancelled"` | 取消结束 | 不是成功，也不是 `RUN_ERROR`；不产生结果，也不等待任何事；thread 上的下一次 run 是普通新 run，不是 resume |
| `"interrupt"` | 中断 | 记录中断状态；`interrupts`（必填，≥1 项）列出等待外部回答的中断；恢复意味着开启一个携带 `resume` 条目的新 run。MVP **不实现**完整人工审批及 ResumeEntry 交互 |

语义：结束一个未报告失败的 run；必须保证 run 打开的消息、工具调用等按协议正确关闭；不得把用户断开连接直接伪装成 `RUN_FINISHED`。

### 3.3 RUN_ERROR

| 字段 | 必填/可选 | 类型 | 语义要点 |
|---|---|---|---|
| `type` | 必填 | `"RUN_ERROR"` | |
| `message` | 必填 | string | 人可读的错误说明 |
| `code` | 可选 | string | 机器可读错误码；开放字符串，协议不定义词汇表 |
| `usage` | 可选 | array | 失败前已累积的 token 用量 |

语义：报告 run 失败；**可以出现在 `RUN_STARTED` 之前**（启动前失败）；出现在 `RUN_STARTED` 之后时结束当前 run；结束时尚未完成的流式消息和工具调用标记为未完成；不得把 `RUN_ERROR` 当成成功的 `TOOL_CALL_RESULT`。

## 4. 文本消息事件

### 4.1 开–内容–关纪律（规范：Streaming Messages，适用于全部三类流式家族）

- 流式项由 `*_START` 打开、零个或多个内容事件扩展、由 `*_END` 关闭，全部用该项的标识符匹配（消息用 `messageId`，工具调用用 `toolCallId`）。
- 生产者**不得**打开一个标识符已打开的项；**不得**为未打开的标识符发送内容或结束事件；生产者打开的每一项**必须**在 run 结束前关闭。
- 打开事件携带描述该项的字段；内容事件只携带标识符和 `delta`；`delta` 按到达顺序拼接成该项的值。
- 消息、工具调用、推理消息、步骤相互独立，生产者可自由交错——工具调用可在消息仍在流式传输时打开——只要每一项遵守自己的开/关纪律。
- 独立事件（`STATE_SNAPSHOT`、`STATE_DELTA`、`MESSAGES_SNAPSHOT` 等）不打开/关闭任何项，可在打开的 run 内任意位置出现。

### 4.2 TEXT_MESSAGE_START

| 字段 | 必填/可选 | 类型 | 语义要点 |
|---|---|---|---|
| `type` | 必填 | `"TEXT_MESSAGE_START"` | |
| `messageId` | 必填 | string | 本流构建的消息身份；后续内容与结束事件凭此关联 |
| `role` | 可选 | `"developer" \| "system" \| "assistant" \| "user"` | 缺席 = `assistant`（规范性含义） |
| `name` | 可选 | string | 作者展示名 |

语义：创建或**重新打开**一个文本消息。AG-UI 1.0 允许关闭后的消息用相同 `messageId` 重新打开，但必须保持相同的 owner、role、name（PROJECT_BOOK §3.8；对应 E02-C / Golden G03 的交错顺序检查）。

### 4.3 TEXT_MESSAGE_CONTENT

| 字段 | 必填/可选 | 类型 | 语义要点 |
|---|---|---|---|
| `type` | 必填 | `"TEXT_MESSAGE_CONTENT"` | |
| `messageId` | 必填 | string | 本片段所属的消息 |
| `delta` | 必填 | string | 待追加的片段；**可为空字符串**（生产者用空 delta 作 keep-alive），不得自动判定为空消息错误 |

语义：将 `delta` 追加到对应已打开消息的文本内容。必须关联一个已打开或按 AG-UI 1.0 合法重新打开的 `messageId`。

### 4.4 TEXT_MESSAGE_END

| 字段 | 必填/可选 | 类型 | 语义要点 |
|---|---|---|---|
| `type` | 必填 | `"TEXT_MESSAGE_END"` | |
| `messageId` | 必填 | string | 所关闭的消息 |

语义：关闭对应消息。合法重新打开不得直接判成协议违规，但必须检查文本与工具调用交错后是否丢失展示顺序（PROJECT_BOOK §5.4、§5.6：`orderedTimeline` 必须保留 TEXT_A / TOOL_CALL / TEXT_B 的交错，不得简化为 TEXT_AB / TOOL_CALL）。

### 4.5 TEXT_MESSAGE_CHUNK（支持并展开）

| 字段 | 必填/可选 | 类型 | 语义要点 |
|---|---|---|---|
| `type` | 必填（Schema `required = ["type"]`） | `"TEXT_MESSAGE_CHUNK"` | |
| `messageId` | 首块必填、后续可省略 | string | 首块必须携带；缺席则延续已打开的消息 |
| `role` | 可选 | `TextMessageRole` | 首块可携带；缺席 = `assistant`，与 `TEXT_MESSAGE_START` 相同 |
| `name` | 可选 | string | 作者展示名 |
| `delta` | 可选 | string | 待追加片段；可为空字符串 |

展开规则（规范：Streaming Messages，§The chunked form / The first chunk / Continuation chunks / Closing a chunk stream；T002 在进入 Reducer 前完成展开，T003 只见展开后的三元组）：

1. 消费者**必须**把 chunk 展开为 start / content / end 形式，**在校验之前、在应用代码之前**完成展开；chunk 按它所展开成的事件受评判。
2. 两种写法**不得在同一项内混合**：由 chunk 打开的项用 chunk 形式延续和关闭（`*_END` 是合成的，永不发送）；由 `*_START` 打开的项用显式形式延续和关闭。携带 chunk 正在组装的标识符的显式事件不是它的延续——它终结了该简写，此后按三元组规则评判；生产者不得发出这种混合序列。
3. 首块规则：第一个 `TEXT_MESSAGE_CHUNK` **必须**携带 `messageId`；缺失必填字段的首块是协议违规，消费者**不得**凭空编造标识符。
4. 后续块：携带标识符的后续块**必须**携带与所延续项相同的标识符；命名不同标识符的块会打开一个新项，前一项先关闭。后续块可重复 opener 已确立的字段（`role`、`name`），但值必须相同；冲突的重复是协议违规（包括与“缺席即默认值”的冲突：未带 role 打开的消息就是 `assistant` 消息，后续块声称其他 role 即冲突）。
5. 合成 `*_END` 的时机（chunk 流无显式结束事件）：当一个 chunk 在同一 lane 打开了不同的项；当消息 / 工具调用 / 步骤 / 状态 / 自定义 / 推理事件到达该项所在的 lane（例外：`RAW`、`ACTIVITY_SNAPSHOT`、`ACTIVITY_DELTA`、`REASONING_ENCRYPTED_VALUE` 不关闭任何项，`SUBAGENT_STARTED` 开新 lane 也不触及本 lane）；当 run 级事件到达——`RUN_STARTED`、`RUN_FINISHED`、`RUN_ERROR`、`MESSAGES_SNAPSHOT`——关闭**所有** lane。
6. chunk 的 `metadata` 适用于由该 chunk 合成的事件，并按 metadata 规则合并进该项；只带 metadata 的收尾 chunk 合法（不增加内容，其 metadata 仍到达所延续的项）。

## 5. 工具调用事件

### 5.1 TOOL_CALL_START

| 字段 | 必填/可选 | 类型 | 语义要点 |
|---|---|---|---|
| `type` | 必填 | `"TOOL_CALL_START"` | |
| `toolCallId` | 必填 | string | 调用身份；后续 args / end / result 事件凭此关联 |
| `toolCallName` | 必填 | string | 所调用的工具名 |
| `parentMessageId` | 可选 | string | 持有该调用的 assistant message；缺席表示生产者未归属 |

语义：开始一个工具调用，并记录其所属消息。同一 `toolCallId` 不得被重复创建成两个相同的逻辑调用（对应 E02-A / Golden G01 的重复检查）。

### 5.2 TOOL_CALL_ARGS

| 字段 | 必填/可选 | 类型 | 语义要点 |
|---|---|---|---|
| `type` | 必填 | `"TOOL_CALL_ARGS"` | |
| `toolCallId` | 必填 | string | 参数所属的调用 |
| `delta` | 必填 | string | 参数片段；按到达顺序拼成调用的参数文本（按约定为 JSON 文本） |

语义：参数在 `TOOL_CALL_END` 前不视为完整，不得在分析器中提前解析并认定为有效 JSON。

### 5.3 TOOL_CALL_END

| 字段 | 必填/可选 | 类型 | 语义要点 |
|---|---|---|---|
| `type` | 必填 | `"TOOL_CALL_END"` | |
| `toolCallId` | 必填 | string | 所关闭的调用 |

语义：关闭工具调用的参数流。AG-UI 1.0 允许关闭后的工具调用用相同 `toolCallId` 重新打开，但必须保持 `toolCallName`、`parentMessageId` 和 owner 一致。

### 5.4 TOOL_CALL_CHUNK（支持并展开）

| 字段 | 必填/可选 | 类型 | 语义要点 |
|---|---|---|---|
| `type` | 必填（Schema `required = ["type"]`） | `"TOOL_CALL_CHUNK"` | |
| `toolCallId` | 首块必填、后续可省略 | string | 首块必须携带 |
| `toolCallName` | 首块必填、后续可省略 | string | 首块必须携带（在打开该调用的块上） |
| `parentMessageId` | 可选 | string | 持有该调用的 assistant message |
| `delta` | 可选 | string | 参数片段；可为空字符串 |

展开规则：与 §4.5 相同（两种写法不混用；首块缺失必填字段 = 协议违规，不得编造标识符；后续块标识符必须一致、重复字段值必须相同、冲突即违规；合成 `*_END` 的时机与 §4.5 第 5 条相同；`metadata` 合并规则相同）。

### 5.5 TOOL_CALL_RESULT

| 字段 | 必填/可选 | 类型 | 语义要点 |
|---|---|---|---|
| `type` | 必填 | `"TOOL_CALL_RESULT"` | |
| `messageId` | 必填 | string | 该结果所成为的 tool message 的身份 |
| `toolCallId` | 必填 | string | 所回答的调用 |
| `content` | 必填 | string 或 `ContentPart[]`（有序数组） | 工具返回内容：纯文本，或按顺序排列的内容块（`TextPart` / `ImagePart` / `AudioPart` / `VideoPart` / `DocumentPart`；结构化数据序列化为文本，媒体以自有 part 传递）。`ContentPart` 必填成员：`TextPart` 需 `type="text"` + `text`；其余四种需 `type` + `source`（`PartSource`：`{type:"url", value}` / `{type:"data", value, mimeType}` / `{type:"file", value, provider?, mimeType?}`） |
| `role` | 可选 | 固定 `"tool"` | 仅为与它所创建的 message 对称而存在；生产者可省略 |

语义：创建一个新的 tool message，并将其关联到对应工具调用。

**生命周期修正（PROJECT_BOOK §3.14，冻结结论，T003 必须遵守）：** AG-UI 1.0 **并不要求**每个 `TOOL_CALL_START` 都必须在同一 run 中收到 `TOOL_CALL_RESULT`。两种情况：

1. Agent 自己执行的工具：结果通常通过同一 run 的 `TOOL_CALL_RESULT` 返回。
2. 前端执行的工具：当前 run 可以以**成功状态结束**，并将尚未回答的调用列入 `pendingToolCallIds`（见 §3.2 `outcome: success`）；结果通过下一次 run 的输入消息返回。

因此 RejoinLab 的约束是：

- 同一 run 的同一工具调用最多只能收到一次对应的 `TOOL_CALL_RESULT`；
- 同一调用 ID 不得因重放而被误认为多个不同调用；
- 前端工具调用允许在当前 run 没有 `TOOL_CALL_RESULT`（不得判为错误）；
- 若有 `pendingToolCallIds`，必须与当前 run 中尚未收到结果的调用一致；
- 下一 run 如果继续该线程，应在输入消息中携带对应工具结果；
- `RUN_ERROR` 结束未完成调用时，不推断一个虚假的 `TOOL_CALL_RESULT`。

## 6. 状态事件

### 6.1 STATE_SNAPSHOT

| 字段 | 必填/可选 | 类型 | 语义要点 |
|---|---|---|---|
| `type` | 必填 | `"STATE_SNAPSHOT"` | |
| `snapshot` | 必填 | 任意 JSON 值（`State`） | 完整的新状态；对象、数组、字符串、数字都合法，协议不解释其内容 |

语义：**完整替换**当前共享状态，不做深度合并。快照是新的基线时刻：此前所有 delta 作废（无论快照被采纳还是拒绝）。生产者可在任何时间发送快照；当无法保证消费者基线与自己一致时（出错后、delta 无法表达的内容之后、继续旧 thread 的 run 开始时），**应当**发送快照（规范：Snapshots and Deltas）。

### 6.2 STATE_DELTA

| 字段 | 必填/可选 | 类型 | 语义要点 |
|---|---|---|---|
| `type` | 必填 | `"STATE_DELTA"` | |
| `delta` | 必填 | `JsonPatch`（RFC 6902 操作数组） | 对当前状态的修改 |

语义（规范：Snapshots and Deltas；RFC 6902）：

- delta 针对消费者的**当前值**应用：即上一个快照经此后所有 delta 修改后的值；run 起始的状态来自输入的 `state`，未携带时为空对象。
- 操作按顺序、**原子**应用：如果任一操作失败，文档保持原样；消费者**不得**保留部分应用的结果。
- 操作是开放对象：Schema 标记如此；RFC 6902 未定义的成员是协议合法内容，处理模型**不得**剥离。
- 生产者**不得**在未给消费者基线的情况下发送 delta（state 的基线来自输入；activity 只有在首个快照后才有基线）。
- 结构不合法时为 `INVALID_INPUT`（不是数组、操作缺失必填成员或成员类型错误——这是畸形的已知值，与其他畸形值一样致命）。结构合法但无法应用时（例如操作指向不存在的路径），记录 `SNAPSHOT_MISMATCH` 或相关状态错误，不得伪装成功；消费者必须浮现失败（指出失败内容与原因的警告），并可保留先前值继续 run（不得把失败悄悄吞掉）。
- `op` 命名了 RFC 6902 未定义的操作时：不是畸形，而是**未识别**——按处理模型的列表规则，该元素从 patch 中丢弃并告警，run 继续。
- `test` 操作失败时等同于 patch 未应用：消费者保留先前值。
- 六种操作（Schema `JsonPatchOperation`）：`add`（需 `op`、`path`、`value`）、`remove`（需 `op`、`path`）、`replace`（需 `op`、`path`、`value`）、`move`（需 `op`、`from`、`path`）、`copy`（需 `op`、`from`、`path`）、`test`（需 `op`、`path`、`value`）。空数组是合法的 no-op patch。
- 快照恢复后的状态必须等价于完整前缀计算得到的状态；快照恢复不能覆盖在其之后已经发生的有效状态更新（PROJECT_BOOK §5.7）。

### 6.3 MESSAGES_SNAPSHOT

| 字段 | 必填/可选 | 类型 | 语义要点 |
|---|---|---|---|
| `type` | 必填 | `"MESSAGES_SNAPSHOT"` | |
| `messages` | 必填 | `Message[]`（有序数组） | 生产者声明的消息，按顺序排列 |

语义：声明**生产者拥有的完整消息集合**。Schema 描述原文：

> "The complete set of messages the producer owns, in order. Conversation-wide rather than a plain overwrite: a consumer may keep messages of its own that no producer tracks, so exactly how a snapshot reconciles with those is behavioural and belongs in the prose."

即：**不是简单的整体覆盖**（`messages = snapshot.messages` 是错误的实现）。必须遵循以下四条协调规则（PROJECT_BOOK §3.17 冻结，T003 实现，T006 Oracle 独立实现）：

1. 快照中已有相同 `messageId` 的消息：**替换**已有消息，但**保留原位置**；
2. 快照中未出现过的新消息：按快照顺序**追加**；
3. producer-owned 的旧消息如果不在完整快照中：**应移除**；
4. 客户端独有的 activity / reasoning 消息按协议规定**保留**，但例外是**按角色（per-role）自撤销**的：快照本身携带任一 activity 消息，即声明了完整 activity 集合，该角色下不在快照中的消息照样删除；reasoning 同理。

官方出处：AG-UI 1.0 规范 https://docs.ag-ui.com/spec/1.0/events/state ，“Reconciliation”一节，原文：“The exception is per-role and self-revoking: a snapshot that itself carries any activity message is declaring the complete activity set, and the consumer's activity messages not in it are dropped like anything else. The same rule holds for reasoning messages.”

补充：

- `Message` 的 `id` 与 `role` 必填；`AssistantMessage` 可带 `content`（string 或 `ContentPart[]`）与 `toolCalls`；`ToolMessage` 需 `toolCallId`，可带 `error`。
- `MESSAGES_SNAPSHOT` 是 run 级事件：它到达时关闭所有 chunk lane（见 §4.5 第 5 条）；它可以出现在打开的 run 内任意位置。
- 本规则是 Golden G02（AG-UI #3119：快照换 ID 导致工具结果与回答错位）的判定依据。

## 7. 特殊字段说明（`subagentRunId` / `eventId` / SSE 字段）

- **`subagentRunId`**：Schema `$defs/Attributable` 的唯一属性。Schema 通过 `allOf` 把 `Attributable` 组合进 11 种 MVP 事件（`TEXT_MESSAGE_START`、`TEXT_MESSAGE_CONTENT`、`TEXT_MESSAGE_END`、`TEXT_MESSAGE_CHUNK`、`TOOL_CALL_START`、`TOOL_CALL_ARGS`、`TOOL_CALL_END`、`TOOL_CALL_CHUNK`、`TOOL_CALL_RESULT`、`STATE_SNAPSHOT`、`STATE_DELTA`），因此它是这 11 个事件的**合法可选字段**；只有 `RUN_STARTED`、`RUN_FINISHED`、`RUN_ERROR`、`MESSAGES_SNAPSHOT` 这 4 个没有它（Schema `Attributable` 描述原文：“Run-scoped events omit it — RUN_STARTED, RUN_FINISHED and RUN_ERROR describe the run itself and MESSAGES_SNAPSHOT is conversation-wide, so none of them can belong to one subagent.”）。此外它还是 `SUBAGENT_STARTED` / `SUBAGENT_FINISHED` / `SUBAGENT_ERROR` 的必填字段。`src/protocol/types.ts` 不包含它——这是 MVP 按 parent-agent 主流程范围不使用该字段做归约的范围决定，保留不动。

  **带 `subagentRunId` 的 MVP 事件处理规则（T002 执行）：** 接受该事件，**不得**判 `INVALID_INPUT`（它是合法可选字段）；归约时忽略该字段（MVP 只做 parent-agent 主流程）；将原始值保留在 `rawEvent` / `metadata` 中作为证据；只有当事件实际要求 Subagent 独立归约时才按项目书 §3.1 报告 `INCONCLUSIVE_LIMIT`，单凭字段出现不得判 `INCONCLUSIVE_LIMIT`。
- **`eventId`**：不存在于 AG-UI 1.0 的任何事件定义中（见 §1）。
- **SSE `id` / `event` / `retry`**：传输层字段，不是事件字段；解析时 `id` 保留为 `transportEventId`（`docs/AGUI_SCOPE.md` §4.2），其余忽略。

## 8. 与项目书文字的不一致（已核对，Schema 为准）

T001 在逐字段核对 Schema 后发现以下差异，全部记录于此，后续任务按本节执行，不得按项目书旧文字施工：

| # | 位置 | 项目书 §3 的写法 | Schema / 规范原文的实际规定 | 冻结处理 |
|---|---|---|---|---|
| D-01 | §3.4 `RUN_FINISHED` | 必填只列 `type` | Schema `required = ["type", "threadId", "runId"]` | **以 Schema 为准**：`RUN_FINISHED` 必填 `type`、`threadId`、`runId`（`src/protocol/types.ts` 已如此定义）。缺失 `threadId`/`runId` 的 `RUN_FINISHED` 是 Schema 违规，由 T002 校验报告（已并入项目书 §3.4（v1.0.2）） |
| D-02 | §3.9 / §3.13 chunk 首块 | “`messageId`（首次 chunk 必填，后续可省略）”、“`toolCallName`（首次 chunk 必填）” | Schema 只要求 `type`；首块必填是规范 prose（Streaming Messages, "The first chunk"）的要求，不是 Schema `required` | 两层都要执行：Schema 校验只要求 `type`；协议校验（T002/T003）按 prose 要求首块字段，缺失 = 协议违规，不得编造标识符 |
| D-03 | §3.17 `MESSAGES_SNAPSHOT` 四条协调规则 | 列为协议规则 | Schema 描述只说“完整集合、对话范围、不是简单覆盖，具体协调属于 prose”；四条规则的具体表述来自项目书冻结 | 四条规则按项目书 §3.17 冻结执行；Schema 描述作为佐证引用（见 §6.3）。规则 4 的精确表述以官方 prose（https://docs.ag-ui.com/spec/1.0/events/state ，“Reconciliation”）为准：例外按角色自撤销，见 §6.3。如 GPT 终审或独立复核对某条提出异议，以终审裁决为准，不得由施工方自行改动 |
| D-04 | §3.1 “部分事件允许 `subagentRunId`” | 未指明是哪些事件 | Schema 中 `subagentRunId` 是 `Attributable` 的唯一属性，通过 `allOf` 组合进 11 个 MVP 事件（`TEXT_MESSAGE_*` 全部 4 个、`TOOL_CALL_*` 全部 5 个、`STATE_SNAPSHOT`、`STATE_DELTA`），是这些事件的合法可选字段；只有 `RUN_STARTED`、`RUN_FINISHED`、`RUN_ERROR`、`MESSAGES_SNAPSHOT` 这 4 个没有它 | 见 §7：Schema 上 11 个 MVP 事件可带可选 `subagentRunId`；MVP 按 parent-agent 主流程范围不使用该字段做归约，`src/protocol/types.ts` 不含该字段是范围决定，保留不动；带该字段的事件处理规则见 §7 |
| D-05 | §4.4 `RecoveryCheckpoint` | 含 `capturedState: RejoinState` 字段 | `src/protocol/types.ts` 的 `RecoveryCheckpoint` 省略了该字段 | 省略合理：`RejoinState` 是 T003 才冻结的类型；T003 冻结 `RejoinState` 后由 T003 补回 |

除上述五项外，项目书 §3 的其余字段表（必填/可选、类型、语义）经 T001 核对，与 Schema 及规范 prose 一致。

## 9. 校验分层（供 T002/T003 使用）

1. **JSON 结构层**：事件必须是 JSON 对象，`type` 必须是字符串且属于 31 值枚举；未知 `type` → `INVALID_INPUT`（MVP 外的已知类型按 §2 处理为 `INCONCLUSIVE_LIMIT`，见 `docs/AGUI_SCOPE.md` §3）。
2. **Schema 层**：按本文件各表校验必填字段与类型；`timestamp` 须为整数；`role` 须在枚举内；`TOOL_CALL_RESULT.role` 如出现须为 `"tool"`。`subagentRunId` 是 11 个 MVP 事件的合法可选字段（见 §7），出现时不得判 `INVALID_INPUT`。
3. **协议层**：开–关纪律（§4.1）、chunk 首块/延续/关闭规则（§4.5、§5.4）、`STATE_DELTA` 基线与原子性（§6.2）、`MESSAGES_SNAPSHOT` 四条协调规则（§6.3）、`TOOL_CALL_RESULT` 生命周期修正（§5.5）。
4. **本地层**：`sourceIndex` 唯一递增；`transportEventId` 仅作证据；不得用 `timestamp` 排序；不得把疑似重复自动去重（无稳定 ID 时只报告 `SUSPECTED_DUPLICATE`，PROJECT_BOOK §4.3）。
