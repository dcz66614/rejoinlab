# 诊断模板目录（冻结，FIX-R2）

> **状态：冻结。** 本文件是 TS 与 Oracle 共享的诊断模板目录（FIX-R2，P1-R2-02；
> 备忘录 §5，方案 B）。报告中的每一条诊断（`message` + `evidence` +
> `sourceIndex` / `relatedSourceIndices` 的有无）都必须与此处逐字一致；
> S0 门禁逐字节对照 24 条 Golden + 15 条 input 夹具 + 6 条 parity 夹具的
> 完整诊断（R-07）。改动任一模板即改报告哈希，须经协调员批准并同步两侧实现
> （`src/replay/planner.ts`、`src/core/lifecycle.ts`、`src/core/reducer.ts`、
> `src/core/snapshot.ts`、`oracle/reference.py`、`oracle/replay.py`）。
>
> 记号：`⟨x⟩` 为填槽；`JSON(x)` 为 `JSON.stringify(x)`（含引号）；
> `…` 前缀 `[CODE] ` 只出现在 D 组（ReducerError 翻译）中，`CODE` 为
> ReducerError 自身的 code。`evidence` 一律只含所列键，缺键不得补 null。
> `sourceIndex` 无值时键省略（TS `!== undefined`，Oracle `None`）；
> `relatedSourceIndices` 只在注明时出现，其余一律省略（TS 从不发出 `[]`）。

## A. 分类诊断（classifyDualTrack，B2）

由 `classifyDualTrack` 在双轨比较后产生。排序：`sourceIndex` 升序、null
最后、再按 code；`TRUNCATED_RUN` 在排序后追加。

| code | severity | sourceIndex | relatedSourceIndices | message | evidence |
|---|---|---|---|---|---|
| SNAPSHOT_MISMATCH（检查点过期） | CRITICAL | `⟨staleSourceIndex⟩` | `[⟨disconnectAfter⟩]` | `Recovery checkpoint is older than the disconnect point and its shared state disagrees with the full prefix.` | `{checkpointIndex: ⟨stale⟩, disconnectAfter: ⟨n⟩, expectedSharedState: ⟨v⟩, actualSharedState: ⟨v⟩}` |
| MESSAGE_REORDER（角色/顺序） | CRITICAL | `⟨checkpointIndex⟩` | 省略 | `Final message order differs from the full path.` | `{expectedOrder: ⟨id[]⟩, actualOrder: ⟨id[]⟩, expectedRoles: ⟨role[]⟩, actualRoles: ⟨role[]⟩}` |
| MESSAGE_REORDER（交错丢失） | CRITICAL | `⟨checkpointIndex⟩` | 省略 | `A message reopened after a tool call lost its text/tool interleave in the resume path.` | `{messageId: ⟨id⟩}` |
| LOST_EVENT | CRITICAL | `⟨sourceIndex⟩` | `[⟨sourceIndex⟩]` | `An event from the full trace did not reach the resume path and its effect is missing.` | `{sourceIndex: ⟨sourceIndex⟩}` |
| OUT_OF_ORDER（排列） | CRITICAL | `⟨common[firstDiff]⟩` | 省略 | `The resume path applied events in a different order than the full path.` | `{expectedOrder: ⟨number[]⟩, actualOrder: ⟨number[]⟩}` |
| DIVERGENT_STATE | CRITICAL | 省略 | 省略 | `Canonical full and resume states differ.` | `{fullStateHash: ⟨hex⟩, resumeStateHash: ⟨hex⟩}` |
| TRUNCATED_RUN | WARNING | `⟨len(events) - 1⟩` | 省略 | `The stream ended before a terminal event (RUN_FINISHED / RUN_ERROR).` | `{lastSourceIndex: ⟨len(events) - 1⟩, runStatus: ⟨string⟩}` |
| LIMIT_EXCEEDED | WARNING | 省略 | 省略 | `Event count ⟨N⟩ exceeds the 40 limit.` | `{eventCount: ⟨N⟩}` |

> 注：`LIMIT_EXCEEDED` 由 `evaluateFixture` 在事件数超 40 时直接产生
> （不经分类）。

## B. 折叠诊断（foldTrack，B1 之外的折叠层）

由 `foldTrack` 在折叠事件时直接产生（不经过 ReducerError 翻译）。

| code | severity | sourceIndex | relatedSourceIndices | message | evidence |
|---|---|---|---|---|---|
| DUPLICATE_TOOL_CALL | CRITICAL | `⟨sourceIndex⟩` | `[⟨sourceIndex⟩]` | ``Tool call "⟨toolCallId⟩" already present was started again (AG-UI #1524: a replayed TOOL_CALL_START over already-applied state).`` | `{toolCallId: ⟨id⟩}`，有 `parentMessageId` 时追加 `{parentMessageId: ⟨id⟩}` |
| TOOL_CALL_ID_REUSE（不完整重开） | WARNING | `⟨sourceIndex⟩` | 省略 | ``Tool call "⟨toolCallId⟩" reopened with a different name or parent message.`` | `{toolCallId: ⟨id⟩}` |
| OUT_OF_ORDER（文本重开合并） | CRITICAL | `⟨sourceIndex⟩` | 省略 | ``Reopened message "⟨messageId⟩" changed role or name.`` | `{messageId: ⟨id⟩, expectedRole: ⟨role⟩, actualRole: ⟨role⟩}` |
| SUSPECTED_DUPLICATE（文本） | WARNING | `⟨sourceIndex⟩` | 省略 | `Identical text content applied again with no stable event id (PROJECT_BOOK §4.3: suspected duplicate, never auto-deduplicated).` | `{messageId: ⟨id⟩, delta: ⟨string⟩}` |
| SUSPECTED_DUPLICATE（工具参数） | WARNING | `⟨sourceIndex⟩` | 省略 | `Identical tool args applied again with no stable event id (PROJECT_BOOK §4.3: suspected duplicate, never auto-deduplicated).` | `{toolCallId: ⟨id⟩, delta: ⟨string⟩}` |

## C. 收获诊断（harvested，B1）

折叠层 `state.diagnostics` 中的 `SNAPSHOT_MISMATCH` /
`UNKNOWN_PATCH_OP` 被收获进报告：`message` 逐字保留，`evidence`
统一改写为 `{reducerCode: ⟨code⟩}`，`sourceIndex` 取折叠事件的
index，`relatedSourceIndices` 省略。

| 场景 | code | severity | message |
|---|---|---|---|
| STATE_DELTA 无基线 | SNAPSHOT_MISMATCH | CRITICAL | `STATE_DELTA arrived with no shared-state baseline (no RUN_STARTED input.state and no STATE_SNAPSHOT yet); the delta is not applied and the state stays unset (EVENT_SCHEMA §6.2: a producer must not send a delta without a baseline).` |
| STATE_DELTA 补丁失败（第 N 个 op） | SNAPSHOT_MISMATCH | CRITICAL | `STATE_DELTA could not be applied (op #⟨N⟩: ⟨REASON⟩ — ⟨detail⟩); the patch is discarded atomically and the prior shared state is kept (EVENT_SCHEMA §6.2).` |
| STATE_DELTA 未知操作（第 N 个 op） | UNKNOWN_PATCH_OP | WARNING | `STATE_DELTA op #⟨N⟩ names unknown operation "⟨op⟩"; the element is discarded and the run continues (EVENT_SCHEMA §6.2).` |
| RUN_STARTED input.state 过期 | SNAPSHOT_MISMATCH | CRITICAL | `RUN_STARTED input.state differs from the live sharedState baseline; the live baseline is kept and the input state is not applied (a snapshot must not overwrite valid later updates, PROJECT_BOOK §5.7).` |

补丁失败的 `⟨REASON⟩ — ⟨detail⟩` 取值（`src/core/snapshot.ts`
`applyJsonPatch`；Oracle `oracle/reference.py` `apply_json_patch`
逐字复现）：

| REASON | detail 格式 |
|---|---|
| `MISSING_PATH` | `object key "⟨k⟩" does not exist` / `array index ⟨N⟩ is beyond the end (⟨len⟩)` |
| `INVALID_INDEX` | `array index "⟨s⟩" is not a valid index` |
| `INVALID_POINTER` | `path/from "⟨p⟩" is not a valid JSON Pointer` / `cannot remove the whole document` |
| `TEST_FAILED` | `test at "⟨p⟩" failed: expected ⟨JSON⟩, got ⟨JSON⟩` |
| `MOVE_INTO_CHILD` | `cannot move "⟨from⟩" into its own child "⟨to⟩"` |
| `NOT_AN_OBJECT_OR_ARRAY` | `cannot descend into a scalar at "⟨token⟩"` / `parent is a scalar value` |

> 注：`add ""` / `replace ""` 为整文档替换（成功）；`remove ""` 为
> `INVALID_POINTER`；未知操作只丢弃该元素、补丁继续；第一个失败的
> 已知操作使整补丁原子丢弃。

## D. ReducerError 翻译诊断（B3）

折叠中 Reducer 抛出的 `ReducerError` 由 `foldTrack` 翻译为报告诊断：
`message` = `"[" + ⟨reducerCode⟩ + "] " + ⟨body⟩`（`ReducerError`
构造器自带 `[CODE] ` 前缀，见 `src/core/state.ts`），`evidence` =
`{reducerCode: ⟨code⟩}` + 有值时追加的 `messageId` / `toolCallId` /
`runId`（只含已定义者），`sourceIndex` = 折叠事件的 index，
`relatedSourceIndices` 省略。报告 code/severity 按下表映射；映射表
中没有的 Reducer code 回退为 `OUT_OF_ORDER` / CRITICAL。

| Reducer code | 报告 code | severity | body（`[CODE] ` 之后） |
|---|---|---|---|
| CONTENT_WITHOUT_START（无此消息） | OUT_OF_ORDER | CRITICAL | ``TEXT_MESSAGE_CONTENT for messageId "⟨id⟩" with no such message: content must target an already-opened message (PROJECT_BOOK §5.4; OUT_OF_ORDER).`` |
| CONTENT_WITHOUT_START（非 open） | OUT_OF_ORDER | CRITICAL | ``TEXT_MESSAGE_CONTENT for messageId "⟨id⟩" which is ⟨status⟩, not open: content must target an already-opened message (PROJECT_BOOK §5.4; OUT_OF_ORDER).`` |
| END_WITHOUT_START（文本，无此消息） | OUT_OF_ORDER | CRITICAL | ``TEXT_MESSAGE_END for messageId "⟨id⟩" with no such message: END must target an already-opened message (EVENT_SCHEMA §4.1).`` |
| END_WITHOUT_START（文本，非 open） | OUT_OF_ORDER | CRITICAL | ``TEXT_MESSAGE_END for messageId "⟨id⟩" which is ⟨status⟩, not open: END must target an already-opened message (EVENT_SCHEMA §4.1).`` |
| END_WITHOUT_START（工具，无此调用） | OUT_OF_ORDER | CRITICAL | ``TOOL_CALL_END for toolCallId "⟨id⟩" with no such call: END must target an already-opened call (EVENT_SCHEMA §4.1).`` |
| END_WITHOUT_START（工具，非 open） | OUT_OF_ORDER | CRITICAL | ``TOOL_CALL_END for toolCallId "⟨id⟩" which is ⟨status⟩, not open: END must target an already-opened call (EVENT_SCHEMA §4.1).`` |
| ARGS_WITHOUT_START（无此调用） | OUT_OF_ORDER | CRITICAL | ``TOOL_CALL_ARGS for toolCallId "⟨id⟩" with no such call: args must target an already-opened call (PROJECT_BOOK §5.5; OUT_OF_ORDER).`` |
| ARGS_WITHOUT_START（非 open） | OUT_OF_ORDER | CRITICAL | ``TOOL_CALL_ARGS for toolCallId "⟨id⟩" which is ⟨status⟩, not open: args must target an already-opened call (PROJECT_BOOK §5.5; OUT_OF_ORDER).`` |
| DUPLICATE_TOOL_CALL_START | OUT_OF_ORDER（映射表无此码，回退） | CRITICAL | ``TOOL_CALL_START for toolCallId "⟨id⟩" while it is already open: one call id must not be created as two identical logical calls (PROJECT_BOOK §5.5; DUPLICATE_TOOL_CALL).`` |
| REOPEN_INCOMPLETE_TOOL_CALL | OUT_OF_ORDER | CRITICAL | ``TOOL_CALL_START reopens toolCallId "⟨id⟩" which was left incomplete by a run end; a reopen requires a cleanly closed call (PROJECT_BOOK §3.12).`` |
| TOOL_CALL_REOPEN_NAME_MISMATCH | TOOL_CALL_ID_REUSE | WARNING | ``TOOL_CALL_START reopens toolCallId "⟨id⟩" with toolCallName "⟨name⟩" but the closed call has name "⟨name⟩"; a reopen must keep toolCallName identical (PROJECT_BOOK §3.12).`` |
| TOOL_CALL_ID_REUSE | TOOL_CALL_ID_REUSE | WARNING | ``TOOL_CALL_START reopens toolCallId "⟨id⟩" with parentMessageId ⟨JSON⟩ but the closed call has parentMessageId ⟨JSON⟩; the same id for a different parent is identity reuse (PROJECT_BOOK §5.5; TOOL_CALL_ID_REUSE).`` |
| RESULT_WITHOUT_CALL | OUT_OF_ORDER | CRITICAL | ``TOOL_CALL_RESULT for toolCallId "⟨id⟩" with no such call: a result must correspond to an existing call (PROJECT_BOOK §5.5).`` |
| RESULT_FOR_INCOMPLETE_CALL | OUT_OF_ORDER | CRITICAL | ``TOOL_CALL_RESULT for toolCallId "⟨id⟩" which was left incomplete by a run end: its execution is over without a result; a result cannot revive it (PROJECT_BOOK §3.14).`` |
| DUPLICATE_TOOL_CALL_RESULT | DUPLICATE_TOOL_CALL | CRITICAL | ``TOOL_CALL_RESULT for toolCallId "⟨id⟩" which already has a result (messageId "⟨id⟩"): one logical execution has at most one result (PROJECT_BOOK §3.14).``（无 resultMessageId 时填 `"?"`） |
| DUPLICATE_MESSAGE_ID | OUT_OF_ORDER | CRITICAL | ``TOOL_CALL_RESULT messageId "⟨id⟩" already exists as a message: a result creates a NEW tool message (PROJECT_BOOK §3.14).`` |
| DUPLICATE_MESSAGE_START | OUT_OF_ORDER | CRITICAL | ``TEXT_MESSAGE_START for messageId "⟨id⟩" while it is already open: a producer must not open an identifier that is already open (EVENT_SCHEMA §4.1).`` |
| REOPEN_INCOMPLETE_MESSAGE | OUT_OF_ORDER | CRITICAL | ``TEXT_MESSAGE_START reopens messageId "⟨id⟩" which was left incomplete by a run end; a reopen requires a cleanly closed message (PROJECT_BOOK §3.8).`` |
| MESSAGE_REOPEN_ROLE_MISMATCH | OUT_OF_ORDER | CRITICAL | ``TEXT_MESSAGE_START reopens messageId "⟨id⟩" with role "⟨role⟩" but the closed message has role "⟨role⟩"; a reopen must keep role identical (PROJECT_BOOK §3.8).`` |
| MESSAGE_REOPEN_NAME_MISMATCH | OUT_OF_ORDER | CRITICAL | ``TEXT_MESSAGE_START reopens messageId "⟨id⟩" with name ⟨JSON⟩ but the closed message has name ⟨JSON⟩; a reopen must keep name identical (PROJECT_BOOK §3.8).`` |
| EVENT_WITHOUT_RUN | OUT_OF_ORDER | CRITICAL | `⟨TYPE⟩ arrived with no run open: stream events belong to a run (RUN_STARTED... RUN_FINISHED / RUN_ERROR). State-only snapshots outside a run are the single exception and are handled separately.`（仅 TEXT_*/TOOL_* 六类事件受此守卫；STATE_*/MESSAGES_SNAPSHOT/RUN_* 不受） |
| THREAD_MISMATCH | OUT_OF_ORDER | CRITICAL | ``RUN_STARTED threadId "⟨t⟩" does not match the established threadId "⟨t⟩": one trace is one conversation (AGUI_SCOPE §4.1).`` |
| DUPLICATE_RUN_ID | OUT_OF_ORDER | CRITICAL | ``RUN_STARTED reuses runId "⟨id⟩" which already ran in this thread: one runId is one run; a re-run is a new runId (PROJECT_BOOK §3.3).`` |
| RUN_ALREADY_RUNNING | OUT_OF_ORDER | CRITICAL | ``RUN_STARTED runId "⟨id⟩" arrived while run "⟨id⟩" is still open: a run must end (RUN_FINISHED / RUN_ERROR) before the next starts.`` |
| RUN_INPUT_MISMATCH | OUT_OF_ORDER | CRITICAL | ``RUN_STARTED input threadId/runId ("⟨t⟩"/"⟨r⟩") disagree with the event threadId/runId ("⟨t⟩"/"⟨r⟩").`` |
| FINISH_WITHOUT_START | OUT_OF_ORDER | CRITICAL | ``RUN_FINISHED for run "⟨id⟩" arrived with no run open.`` |
| FINISH_WRONG_RUN | OUT_OF_ORDER | CRITICAL | ``RUN_FINISHED for run "⟨id⟩" but the open run is "⟨id⟩": a run can only be finished by its own RUN_FINISHED.`` |
| PENDING_TOOL_CALL_MISMATCH | OUT_OF_ORDER | CRITICAL | ``RUN_FINISHED outcome.pendingToolCallIds ⟨JSON⟩ does not match this run's calls still without a result ⟨JSON⟩ (PROJECT_BOOK §3.14: the list must be consistent with the run's unresulted calls).`` |
| INVALID_INPUT（TOOL_CALL_RESULT role 非 tool） | OUT_OF_ORDER | CRITICAL（映射表无此码，回退） | ``TOOL_CALL_RESULT role must be "tool" when present, got ⟨JSON⟩.`` |
| UNEXPANDED_CHUNK | —（抛为 INVALID_INPUT，见 E 节） | — | ``⟨TYPE⟩ reached the Reducer unexpanded: chunks must be expanded by expandChunks() before reduction (EVENT_SCHEMA §4.5 rule 1). Call reduceEvents() instead.`` |
| UNSUPPORTED_EVENT | —（抛为 INVALID_INPUT，见 E 节） | — | ``Event type ⟨JSON⟩ is not one of the 15 MVP events (AGUI_SCOPE §2–§3); unsupported events must be reported, never silently dropped.``（注：折叠前 `evaluateFixture` 先按 E 节模板拦截不支持类型；此 Reducer 文本只在事件绕过前置检查到达 Reducer 时出现） |

> 注：`DUPLICATE_TOOL_CALL_START` 与 `INVALID_INPUT`（role）不在
> `REDUCER_ERROR_TO_DIAGNOSTIC` 映射表中——折叠翻译时回退为
> `OUT_OF_ORDER` / CRITICAL。`foldTrack` 在 Reducer 之前拦截了重复 /
> 不完整重开情形（B 节），故 `DUPLICATE_TOOL_CALL_START`、
> `REOPEN_INCOMPLETE_TOOL_CALL`、`REOPEN_INCOMPLETE_MESSAGE`、
> `MESSAGE_REOPEN_*`、`DUPLICATE_MESSAGE_START` 在折叠诊断中一般不
> 出现；此处冻结文本，供未来任何走到 Reducer 的路径复现同一文本。
> 另：`TOOL_CALL_RESULT_UNMATCHED_INPUT`（WARNING，折叠层）与
> `RUN_ERROR` 折叠诊断不是报告诊断，不进入报告。

## E. 输入无效（INVALID_INPUT）与超限

| 情形 | code | severity | sourceIndex | message | evidence |
|---|---|---|---|---|---|
| 不支持 / 未知事件类型 | INVALID_INPUT | CRITICAL | `⟨i⟩`（事件 index） | `Event at sourceIndex ⟨i⟩ has unsupported or unknown type ⟨JSON⟩: not one of the 15 MVP events.` | `{}` |
| 其他折叠失败（缺字段、形状非法等） | INVALID_INPUT | CRITICAL | 省略 | `Input is invalid: INVALID_INPUT at sourceIndex ⟨i⟩.`（无 index 时为 `Input is invalid: INVALID_INPUT.`） | `{}` |
| 事件数超 40 | LIMIT_EXCEEDED | WARNING | 省略 | 见 A 节 | 见 A 节 |

> 规则（协调员裁决 8）：不支持类型逐字复现 TS 模板；其余一律固定模板，
> Oracle 内部措辞（如缺哪个必填字段）不进入报告；不得静默豁免。
> R-10 对照集不含非法形状夹具（与既有门禁的 LEGAL/ILLEGAL 划分一致）。

## F. 报告层规则

- 诊断排序：`sourceIndex` 升序、null 最后、再按 code；`TRUNCATED_RUN`
  在排序后追加（`planner.ts` `classifyDualTrack`；Oracle
  `oracle/replay.py` `evaluate` 同规则）。
- 报告转换（`src/report/json.ts` `toReportDiagnostic`；Oracle
  `oracle/parity.py` `to_report_diagnostic`）：`sourceIndex` 无值时省略；
  `relatedSourceIndices` 无值或空数组时省略；`message` 逐字；`evidence`
  深拷贝（undefined 键丢弃）。
- 首个分歧（`toReportFirstDivergence`；Oracle `oracle/diff.py`
  `to_report_first_divergence`）：剥离 kind 与事件身份
  （eventType / messageId / toolCallId / runId / note）；缺失的
  expected / actual 记为 null；为 null 时整个 `firstDivergence` 键省略。
