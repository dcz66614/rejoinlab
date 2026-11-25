# 核心算法 — RejoinLab (P031)

> 权威规格：PROJECT_BOOK.md v1.0.2 §5、§8。实现：`src/core/`、`src/replay/`。
> 本文件解释算法，不复述规格；与规格不一致时以项目书为准。

## 1. 状态与 Reducer

对话状态 `RejoinState`（项目书 §5.1）：

```ts
interface RejoinState {
  threadId: string | null;
  runs: RunState[];
  messages: MessageState[];
  toolCalls: ToolCallState[];
  sharedState: unknown;
  orderedTimeline: TimelineItem[];
  pendingToolCallIds: string[];
  runStatus: "NOT_STARTED" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED";
}
```

确定性参考 Reducer：`S_{i+1} = R(S_i, e_i)`。约束（§5.4 / §5.7）：

- 无外部状态、无随机数、无时间读取、无网络、不修改输入对象。
- 事件按**到达顺序**归约，禁止用 `timestamp` 重新排序。
- `TEXT_MESSAGE_CHUNK` / `TOOL_CALL_CHUNK` 在进入 Reducer 前展开为
  START / CONTENT / END（或 START / ARGS / END）。
- `STATE_SNAPSHOT` 完整替换共享状态（不做深度合并）；
  `STATE_DELTA` 是 RFC 6902 JSON Patch，按顺序应用。
- `MESSAGES_SNAPSHOT` 按 AG-UI 1.0 协调规则处理：同 ID 消息原位替换、
  新消息按快照顺序追加、完整快照中缺失的生产者消息移除、客户端独有的
  activity/reasoning 消息保留。**不是** `messages = snapshot.messages`。
- `orderedTimeline` 必须保留文本与工具调用的交错
  （TEXT_A / TOOL_CALL_* / TEXT_B），不能简化成 TEXT_AB / TOOL_CALL_*。
- 前端执行的工具调用可以在当前 run 结束时保持 pending
  （`RUN_FINISHED` outcome success + `pendingToolCallIds`），结果在下一个
  run 的输入中返回；一个调用在同一逻辑执行中最多一个结果；
  `RUN_ERROR` 结束未完成调用时不推断虚假结果。

## 2. 双轨比较

```
S_full   = fold(R, S_0, E)                    完整事件流
S_resume = fold(R, S_k_snapshot, E_{k+1:n})   检查点恢复 + 后续事件
一致 ⟺ canon(S_full) = canon(S_resume)
```

合法恢复路径收敛率要求 100%（S0 M-07：24/24）。恢复路径缺少必要快照、
存在未知事件或超过计算边界时，不能计为成功。

### 2.1 检查点与游标

- 检查点 `RecoveryCheckpoint`：`{ threadId, sourceIndex, stateSnapshot?,
  messagesSnapshot?, capturedState, coverage: { sharedState, messages } }`。
  `STATE_SNAPSHOT` 负责共享状态，`MESSAGES_SNAPSHOT` 负责消息集合；
  单独出现其中一个，不意味着另一个也被完整快照覆盖。
- 恢复游标 `resumeAfterSourceIndex`：恢复分支从已应用的最后一个检查点
  `sourceIndex` 之后的第一条事件开始。只在本次本地导入文件内有效；
  不等同于 SSE Last-Event-ID，不等同于 AG-UI eventId，不代表服务器支持真实恢复。
- 另外支持 `FULL_REPLAY_FROM_START`：从原始轨迹开头重新发送全部历史事件。

## 3. canon：规范化状态序列化

采用 RFC 8785 JSON Canonicalization Scheme（JCS）语义：

- 对象键按规范顺序排列；数组顺序保留；字符串按 JSON 规则规范编码；
  数字使用确定性规范表示；不允许 NaN、Infinity 等非 JSON 值；
  不将 `undefined` 当成 `null`。
- **排除** timestamp、sourceIndex、导入文件名、本地耗时等非业务状态字段；
  **不排除** messageId、toolCallId、消息顺序、工具结果。
- 规范化结果取 UTF-8 字节的 SHA-256。
- 生产 TypeScript 实现与 Python Oracle **分别实现** canon，不得共享序列化结果
  作为预期值；跨语言一致性以“折叠层字段逐项相等 + 通用 JCS 同值同字节”建立
  （S0 A-07：Oracle 投影用 Oracle 内部字段名，TS 投影用冻结 `RejoinState`
  字段名，parity 须做折叠层字段名映射，不直接比状态哈希）。

报告哈希定义（S0 A-02，冻结）：报告哈希 = TS `canonicalHash`（JCS）作用于
`rejoinlab.report/v1` 报告对象，其中 `metrics.durationMs` 被剔除
（该字段每 run 波动），`metrics.visitedStates` 保留（确定性计数）。

## 4. 诊断与首个分歧定位

诊断代码与级别见 `docs/MODEL_CONTRACT.md` §3（项目书 §6）。

首个分歧定位（项目书 §8.6）：对齐完整路径和恢复路径后，按源事件序号对齐，
计算每一步的规范化状态，找到第一个状态不相等的位置，输出对应事件、
状态差异和相关业务 ID；无法可靠对齐时输出分支内序号和置信边界，
不伪造精确事件身份。

裁决定义（S0 A-01，FIX-R1 已落实）：首个分歧以 T004 步进比较为准。G01 的步进分歧是
sourceIndex 4，TypeScript 与 Oracle 两侧一致（24/24）。Oracle 原先的诊断优先分支
（取最早诊断 sourceIndex 2）已删除——诊断 sourceIndex（G01 的 DUPLICATE_TOOL_CALL
在 2，即重播的 TOOL_CALL_START 本身）与首次状态分歧 sourceIndex（4，即 TOOL_CALL_END，
切片比较中重复项首次在状态中可见的位置）是两个不同的值，两个都要输出、不得混用。
诊断优先分支是 Oracle 内部判断，不在 §8.6 文本中；删除后首分歧正式计入 parity 字段集。

## 5. 故障注入与最短故障序列（BFS）

8 种注入算子（项目书 §8.4）：`DUPLICATE_EVENT`、`DROP_EVENT`、
`SWAP_ADJACENT`、`STALE_SNAPSHOT`、`REPLAY_PREFIX`、`MESSAGE_ID_REMAP`、
`CURSOR_SKIP`、`TRUNCATE_STREAM`。所有注入均记录在实验报告中。

最短故障序列（项目书 §8.5）：确定性 BFS。

- 初始节点为未注入故障的轨迹；按固定算子顺序生成子节点；
  计算每个子节点的双轨状态；检查是否发生可确认的状态分歧。
- 首次找到的分歧具有最少注入步数；同样步数存在多个结果时按固定字典序选择：
  `CURSOR_SKIP`、`DROP_EVENT`、`DUPLICATE_EVENT`、`MESSAGE_ID_REMAP`、
  `REPLAY_PREFIX`、`STALE_SNAPSHOT`、`SWAP_ADJACENT`、`TRUNCATE_STREAM`。
- 同一输入必须产生相同的搜索节点访问顺序、故障序列、首个分歧事件、
  诊断代码、报告哈希。
- BFS 目标 = 轨迹的**主诊断码**（S0 A-03，冻结）：故障夹具的目标是该夹具的
  主诊断码；正常夹具目标为任意分歧（偏离 CONSISTENT）。
  若目标为“任意分歧”，通用 `DROP_EVENT` 几乎能分歧每条轨迹，全部最短序列
  都会变成 `["DROP_EVENT"]`，与项目书 §13.3 的 G01 样本 `["REPLAY_PREFIX"]` 矛盾。

## 6. 有界性

| 边界 | 值 | 超限行为 |
|---|---|---|
| 每条轨迹事件数 | 40（含快照与断线标记） | `INCONCLUSIVE_LIMIT` |
| 最大搜索节点 | 5,000 | 立即停止，`INCONCLUSIVE_LIMIT` |
| 单轨迹处理时间 | 1,000 ms | `INCONCLUSIVE_LIMIT` |
| 最大故障注入深度 | 3 | BFS 不再加深 |
| 输入文件总大小 | 1 MiB | 拒绝 |
| 单个事件大小 | 64 KiB | 拒绝 |

不得通过忽略未处理的分支宣布 CONSISTENT；不得删除失败 Golden、修改预期值
或放宽阈值来取得通过。

## 7. 实测性能（引用，非承诺）

S0 门禁（`artifacts/reports/S0_GATE.json`）：最慢单轨迹 42.8 ms
（T-40 analyze），最慢 Golden G05 10.7 ms，BFS 最多 8 节点，门槛 1,000 ms。

T012 复测（`artifacts/logs/T012_PERFORMANCE.log`，2026-11-24T01:47:11.439Z 运行，
40 事件轨迹 10 次重复）：evaluate 最大 20.88 ms，analyze 最大 76.86 ms；
24 条 Golden 最慢 G01 12.77 ms；
真实 Chromium Worker（5 次）：计算最大 42.00 ms，往返最大 105.80 ms。
各轮存在冷启动波动，复核重跑的最大值同样远低于门槛。确定性：
2400 次重复（24 条 × 100 次），每条 Golden 恰 1 个报告哈希。
