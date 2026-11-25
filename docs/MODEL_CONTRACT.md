# 模型契约 — RejoinLab (P031)

> 冻结规格：PROJECT_BOOK.md v1.0.2（§3–§5、§13）、`docs/AGUI_SCOPE.md`、
> `docs/EVENT_SCHEMA.md`、`src/protocol/types.ts`。
> 本文件是上述冻结内容的施工侧摘要；与项目书不一致时以项目书为准。

## 1. 协议版本

AG-UI 1.0，2026-09-18 正式发布（官方发布讨论
https://github.com/ag-ui-protocol/ag-ui/discussions/2792）。
1.0 是冻结的、带版本号的协议合同；不以 0.x 草案作为字段权威；
不混用后续 draft 事件；不根据某个 SDK 的内部实现擅自修改协议定义；
事件字段以 AG-UI 1.0 JSON Schema 为准（本地冻结副本
`docs/ag-ui-1.0-schema.json`，94,359 B，SHA-256
`4b5c93226838a0e72d88e6c5df20633c686c49fcb75d9be2815c6cbf9e48e71a`）。

## 2. 事件子集

### 2.1 支持的 15 种事件

| 事件 | 必填字段 | 语义要点 |
|---|---|---|
| `RUN_STARTED` | type、threadId、runId | 开始一个 run；同一 thread 内不得将一个 runId 用于另一次不同的 run。 |
| `RUN_FINISHED` | type | 结束一个未报告失败的 run；outcome 缺失视为正常成功；success 可带 `pendingToolCallIds`；cancelled 是取消，不是成功。 |
| `RUN_ERROR` | type、message | 报告 run 失败；可出现在 `RUN_STARTED` 之前；不得当成成功的 `TOOL_CALL_RESULT`。 |
| `TEXT_MESSAGE_START` | type、messageId | 创建或重新打开一个文本消息（role 缺失默认 assistant）。 |
| `TEXT_MESSAGE_CONTENT` | type、messageId、delta | delta 追加到对应打开消息；空字符串 delta 合法。 |
| `TEXT_MESSAGE_END` | type、messageId | 关闭对应消息；AG-UI 1.0 允许同 messageId 重新打开（须保持 owner/role/name 一致）。 |
| `TEXT_MESSAGE_CHUNK` | messageId（首次必填） | 进入 Reducer 前展开为 START / CONTENT / END。 |
| `TOOL_CALL_START` | type、toolCallId、toolCallName | 开始一个工具调用，记录所属消息。 |
| `TOOL_CALL_ARGS` | type、toolCallId、delta | 参数片段按到达顺序追加；`TOOL_CALL_END` 前不视为完整。 |
| `TOOL_CALL_END` | type、toolCallId | 关闭工具调用参数流；同 toolCallId 重新打开须保持 toolCallName / parentMessageId / owner 一致。 |
| `TOOL_CALL_CHUNK` | toolCallId、toolCallName（首次必填） | 进入 Reducer 前展开为 START / ARGS / END。 |
| `TOOL_CALL_RESULT` | type、messageId、toolCallId、content | 创建 tool message 关联到调用；同一调用在同一逻辑执行中最多一个结果；前端工具可 pending 到下一 run。 |
| `STATE_SNAPSHOT` | type、snapshot | 完整替换当前共享状态，不做深度合并。 |
| `STATE_DELTA` | type、delta | RFC 6902 JSON Patch，按顺序应用；无法应用 → `SNAPSHOT_MISMATCH`。 |
| `MESSAGES_SNAPSHOT` | type、messages | 按 AG-UI 1.0 协调规则处理（原位替换 / 按序追加 / 移除缺失的生产者消息 / 保留客户端独有消息），不是数组整体覆盖。wire 形式限制（v1.0.1，P2-R1-02）：AG-UI wire Message 没有内部 `segments` 字段，`messageStateToAGUI` 只输出 `content`；单独从 wire `messagesSnapshot` 恢复会丢失文本片段边界，权威恢复是检查点的 `capturedState` 或前缀折叠重放。当前产品没有只从 wire 快照恢复的路径；未来新增此类路径时，若无法证明交错信息完整，必须返回 `INCOMPLETE_TRACE`。见 PROJECT_BOOK §3.17 与 `docs/LIMITATIONS.md` L-T007-04。 |

每条事件必须包含 `type`；允许的公共可选字段：`timestamp`、`rawEvent`、
`metadata`；部分事件允许 `subagentRunId`。MVP 只覆盖 parent-agent 主流程。
所有事件按文件中的到达顺序排列，禁止用 `timestamp` 重新排序。

### 2.2 不支持的事件

`STEP_STARTED` / `STEP_FINISHED`；`REASONING_*`；`ACTIVITY_*`；
`SUBAGENT_*`；`RAW`；`CUSTOM`；未列出的 draft events。
遇到不支持事件，不得静默删除后继续声称一致：报告 `INCONCLUSIVE_LIMIT`
或 `INVALID_INPUT`，并指出事件位置和类型。需要 Subagent 独立归约的样本
报告 `INCONCLUSIVE_LIMIT`。

## 3. 标识符、快照与恢复游标

- `threadId`：对话身份，同一对话跨 run 稳定。
- `runId`：单次运行身份，同一 thread 内不得用于不同 run。
- `messageId`：消息身份，同一 thread 内唯一，可跨 run 重述。
- `toolCallId`：工具调用身份，关联调用、参数、结果。
- **`eventId`：AG-UI 1.0 不定义，不得伪造为标准事件字段。**
- 所有 AG-UI 标识符都是 opaque strings，不解析其中的内部结构。

RejoinLab 为每条导入事件建立本地包装（不属于 AG-UI 协议）：

```json
{"sourceIndex": 12, "sourceEventKey": null, "transportEventId": null,
 "event": {"type": "TEXT_MESSAGE_CONTENT", "messageId": "msg-1", "delta": "Hello"}}
```

- `sourceIndex`：本次导入文件内从 0 开始的顺序编号。
- `sourceEventKey`：用户提供的额外稳定事件标识，原值保存；否则 null。
- `transportEventId`：来源为 SSE 时保留原始 `id` 字段；否则 null。

## 4. SSE 与恢复游标的区别

AG-UI 1.0 的标准 HTTP+SSE 绑定**不支持流恢复**：消费者忽略 SSE 的
id / event / retry 字段；连接中断且没有收到终止事件时，该 run 是 truncated；
重新运行是一个带新 runId 的新 run，新 run 的输入携带消费者保留的消息和状态。
WHATWG SSE 的 Last-Event-ID 只是传输层机制，不是 AG-UI 恢复游标。

RejoinLab：解析 SSE 文件中的 `id` 字段并保留为传输层原始证据；
不把它认定为 AG-UI 1.0 的事件 ID；不把它认定为 AG-UI 1.0 官方恢复游标；
使用本地事件序号和实验配置模拟恢复位置；不执行真实网络重连。

恢复游标 `resumeAfterSourceIndex`：恢复分支从已应用的最后一个检查点
`sourceIndex` 之后的第一条事件开始。只在本次本地导入文件内有效。
另外支持 `FULL_REPLAY_FROM_START`（从原始轨迹开头重新发送全部历史事件）。

## 5. 裁决与诊断

### 5.1 五种裁决

| 裁决 | 含义 |
|---|---|
| `CONSISTENT` | 双轨规范化状态相等，无 CRITICAL。 |
| `INCONSISTENT` | 双轨状态不同，或出现可证实的关键故障。 |
| `INCONCLUSIVE_LIMIT` | 超出计算边界（事件、搜索节点、时间）。 |
| `INVALID_INPUT` | JSON/SSE 格式错误、必需字段缺失、无法解析的协议事件。 |
| `INCOMPLETE_TRACE` | 缺少必要终止信息、检查点覆盖不足、无法确认恢复完整性。 |

CONSISTENT 不等于 Agent 后端正确。INCOMPLETE_TRACE 不得降级为 CONSISTENT。
`SUSPECTED_DUPLICATE` 可以与 CONSISTENT 同时出现，但必须在报告中显示警告。

### 5.2 十种诊断代码

| 代码 | 级别 | 证据 |
|---|---|---|
| `DUPLICATE_TOOL_CALL` | CRITICAL | toolCallId、parentMessageId、两次 START 的 sourceIndex。 |
| `LOST_EVENT` | CRITICAL | sourceIndex、sourceEventKey、事件类型、差异字段。 |
| `OUT_OF_ORDER` | CRITICAL | 前后事件、messageId/toolCallId、sourceIndex。 |
| `MESSAGE_REORDER` | CRITICAL | messageId、toolCallId、预期顺序、实际顺序。 |
| `SNAPSHOT_MISMATCH` | CRITICAL | snapshotIndex、预期哈希、实际哈希。 |
| `DIVERGENT_STATE` | CRITICAL | 两个状态哈希、JSON Pointer 差异路径。 |
| `SUSPECTED_DUPLICATE` | WARNING | type、业务 ID、delta、两个 sourceIndex。 |
| `TOOL_CALL_ID_REUSE` | WARNING | toolCallId、不同 parentMessageId、调用名称。 |
| `TRUNCATED_RUN` | WARNING | 最后事件位置、runId、缺少终止事件。 |
| `MISSING_TERMINAL` | WARNING | runId、最后事件位置。 |

诊断不得越权：不得把相同文本直接判成重复事件；不得把所有消息 ID 重新打开
都判为错误；不得把前端工具没有同 run 结果判成错误；不得把时间戳较早的事件
强制移动到前面；不得把没有稳定事件标识的疑似重复自动删除。

无稳定 ID 的重复判定：两个事件 type 相同、messageId/toolCallId 相同、
delta 或其他有效负载相同、出现在合理的重放窗口内，但没有稳定的事件标识或
可核对的原始轨迹位置时，只能报告 `SUSPECTED_DUPLICATE`，不得仅凭内容相同
就自动去重。

## 6. 报告接口 `rejoinlab.report/v1`

```ts
type Verdict = "CONSISTENT" | "INCONSISTENT" | "INCONCLUSIVE_LIMIT" | "INVALID_INPUT" | "INCOMPLETE_TRACE";
type Severity = "CRITICAL" | "WARNING";
interface Diagnostic { code: string; severity: Severity; sourceIndex?: number; relatedSourceIndices?: number[]; message: string; evidence: Record<string, unknown>; }
interface PathResult { finalStateHash: string; messages: unknown[]; toolCalls: unknown[]; sharedState: unknown; pendingToolCallIds: string[]; }
interface RejoinReport {
  schema: "rejoinlab.report/v1"; specVersion: "1.0.2"; protocolVersion: "1.0";
  scenarioId: string; verdict: Verdict;
  input: { sourceFormat: "JSONL" | "SSE"; eventCount: number; sourceSha256: string; };
  recovery: { strategy: string; disconnectAfter?: number; resumeAfterSourceIndex?: number; };
  fullPath: PathResult | null; resumePath: PathResult | null;
  firstDivergence?: { sourceIndex?: number; fullStateHash: string; resumeStateHash: string;
    differences: Array<{ jsonPointer: string; expected: unknown; actual: unknown; }>; };
  diagnostics: Diagnostic[];
  shortestInjectionSequence: string[] | null;
  metrics: { durationMs: number; visitedStates: number; };
  assumptions: string[]; limitations: string[];
}
```

注：`shortestInjectionSequence` 的 `null` 形式是 v1.0.1 的 wire 契约（JSON
Schema 与校验器已接受 null）；`src/report/schema.ts` 的 TS 类型、
`src/report/json.ts` 的生产者（透传 null）与 `src/report/html.ts`
的 null 分支已在 FIX-R1 收尾同步落地（见 L-T010-02），null 已真正进入
JSON 报告。

### 6.1 与 §13.2 文本的三处显式说明（披露于 `src/report/schema.ts` 模块头）

1. **`fullPath` / `resumePath` 为 null**（v1.0.1，ADR-001）：§13.2 写为
   `PathResult | null`；null 表示“本次分析没有该路径的终态”，绝不伪造
   空路径。null 按路径独立取舍：事件数超限 / 未知事件 / 完整折叠失败时
   两路径为 null；恢复折叠失败时仅 `resumePath` 为 null；BFS 节点超限的
   `INCONCLUSIVE_LIMIT` 仍带已算出的双轨终态。消费者不得把 null 误读为
   `CONSISTENT` 的证据。详见 `docs/LIMITATIONS.md` L-T010-01。
2. **`shortestInjectionSequence` 为 `[]` 还是 `null`**（v1.0.1）：`[]`
   表示 BFS 已证实目标在无注入时已达成（如 G08）；`null` 表示未计算
   （`INVALID_INPUT` / `INCONCLUSIVE_LIMIT` / BFS 未运行 / 界内无序列
   可达）。两者的分析层来源是 `src/replay/search.ts` 的
   `analyzeFixture`（`sequence: string[] | null`）。已落地（FIX-R1 收尾）：
   wire 契约、TS 类型、生产者透传 null、HTML null 分支四处一致，见 §6
   接口下注与 L-T010-02。
3. **`metrics` 只有 `durationMs` 与 `visitedStates`**：BFS 访问节点数
   （`bfsVisited`）没有对应的 §13.2 字段，不进入 JSON 报告，只在 HTML 报告中展示；
   终态 `runStatus` 同样只在 HTML 中展示。

### 6.2 剥离规则（S0 A-07）

T004 的 StateDiff 多余 `kind` 字段、FirstDivergence 多余字段
（`eventType` / `messageId` / `toolCallId` / `runId` / `note`）在输出
`rejoinlab.report/v1` 时剥离——剥离发生在 `src/report/json.ts` 的组装层，
不改 T004 生产代码。类型与校验器只接受 §13.2 的字段集，上述多余字段一律判为非法。

## 7. 冻结裁决（S0 A-01～A-08）

施工中出现的规格解释争议由 T007 以裁决形式冻结（全文见
`artifacts/reports/S0_REPORT.md` §2）：

- **A-01** 首个分歧定义：T004 步进比较（§8.6），G01 = 4；Oracle 诊断优先分支
  （sourceIndex 2）不计入 parity 字段集。
- **A-02** 报告哈希定义：JCS 作用于报告对象，剔除 `metrics.durationMs`，
  保留 `metrics.visitedStates`。
- **A-03** BFS 目标 = 轨迹的主诊断码，不是“任意分歧”。正式目标语义见
  `00_control/ADR-002.md`（v1.0.1）：故障轨迹复现 primary diagnostic，
  正常轨迹复现任意可确认分歧；§8.5 的澄清句指向该 ADR。
- **A-04** 诊断码映射：`UNCLOSED_STREAM_ITEM`（T003 本地码）永不直出报告；
  仅当全流缺终结事件时映射为 `TRUNCATED_RUN`（WARNING）。
- **A-05** Oracle `RUN_STARTED` 输入缺口：实证存在，对本门零影响
  （Golden 均不含 input）；后续新增带 input 的 Golden 或对齐播种规则。
- **A-06** tsconfig `include` 不扩大到 tests（见 L-T007-03）。
- **A-07** Oracle `canonicalize_state()` 字段名映射 + StateDiff/FirstDivergence
  多余字段剥离（见 §6.2）。
- **A-08** wire 快照丢段边界：已证实的遗留限制，不阻塞 S0（见 L-T007-04）。
  v1.0.1 已在 PROJECT_BOOK §3.17 与本文件 §2.1 中写明该限制；当前产品
  没有只从 wire 快照恢复的路径，故不存在可返回 `INCOMPLETE_TRACE` 的
  分支，未来新增此类路径时须按 L-T007-04 的要求返回 `INCOMPLETE_TRACE`。

## 8. 能力边界

RejoinLab 证明的范围只限于：给定的 AG-UI 1.0 事件子集、已导入事件序列、
初始状态、快照语义、恢复游标、有界事件轨迹、固定故障注入规则。
它不证明 Agent 后端正确、模型内容正确、真实网络无丢包、真实服务端支持断点恢复、
AG-UI SDK 没有其他缺陷、工具只执行一次、exactly-once 投递、所有分布式并发交错
均被覆盖、超过 40 条事件的轨迹一定安全。全文见 PROJECT_BOOK §18，
遗留限制见 `docs/LIMITATIONS.md`。
