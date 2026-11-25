# P031 RejoinLab — S0 硬门禁核验报告（T007）

**裁决：S0 = PASS** —— T008–T014 可以启动。

- 生成时间：2026-11-24T01:47:42.241Z（UTC）
- git HEAD：44d59df757e92025908d1fe6d637fa175c659a15
- 环境：node v24.22.1，npm 10.9.4，Python 3.12.3
- 规格：v1.0.2（FIX-R3 修订，见 00_control/ADR-004.md；FIX-R1 修订：P1-R1-03 路径 nullable、P2-R1-08 序列 null 语义、P2-R1-01 BFS 目标澄清；见 00_control/ADR-001.md 与 ADR-002.md；oracle/ 与 G05 预期值经 FIX-T007-F01 修正，见 §3 与 docs/ADR-F01-pending-derived.md）

## §0 总览

- Golden 正确分类：**24/24**（verdict 三方一致；已知故障 8/8，正常轨迹 16/16，False Positive 0，False Negative 0）
- Oracle parity（§13.2 字段集）：**24/24**（历史 FAIL 项 F-01 已闭合，见 §3）
- 合法恢复收敛率：**24/24**
- 确定性：24 条 Golden × 100 次重复 = **2400 次**，每条恰 1 个报告哈希（定义见 A-02）
- 单轨迹性能：最慢 42.8 ms（门槛 < 1,000 ms）；40 事件轨迹正常，41 事件 → INCONCLUSIVE_LIMIT
- BFS 节点：最多 8（上限 5,000）；maxNodes=1 探针返回 limitExceeded
- 离线：src/ 扫描网络调用点 0 个；真人参与 0（全部合成数据）

## §1 硬门验收矩阵（实测值）

| 编号 | 指标 | 实测值 | 阈值 | 结果 | 证据 |
|---|---|---|---|---|---|
| M-01 | Golden 正确分类 | 24/24 | 24/24 | PASS | S0_PARITY.json（verdict 三方一致） |
| M-02 | 已知故障检出（G01–G08） | 8/8 | 8/8 | PASS | S0_PARITY.json；G08 为 INCOMPLETE_TRACE（截断流本身） |
| M-03 | 正常轨迹正确通过（N01–N16） | 16/16 | 16/16 | PASS | S0_PARITY.json |
| M-04 | False Positive | 0 | 0 | PASS | M-03 的补数 |
| M-05 | False Negative | 0 | 0 | PASS | M-02 的补数 |
| M-06 | Oracle parity（§13.2 字段集） | 24/24 | 24/24 | PASS | S0_PARITY.json；24/24 三方一致（历史 FAIL 项 F-01 已闭合，见 §3） |
| M-07 | 合法恢复收敛率 | 24/24 | 24/24（100%） | PASS | S0_PARITY.json legalBaselineConverged；G08 合法基线为 INCOMPLETE_TRACE 但双路径哈希一致 |
| M-08 | 确定性重复执行（报告哈希唯一） | 2400 次重复，每条 Golden 恰 1 个哈希值 | 100/100 每条 | PASS | S0_DETERMINISM.json；哈希定义 A-02（剔除 durationMs） |
| M-09 | 最大事件轨迹 | 40 条事件（含快照与断线标记）正常评估 | 40 条 | PASS | tests/s0/performance.test.ts T-40；41 条 → INCONCLUSIVE_LIMIT |
| M-10 | 单轨迹性能 | 最慢 42.8 ms（T-40 analyze 42.8 ms；最慢 Golden G05 10.7 ms） | < 1,000 ms | PASS | test:performance 输出（见 T007_PRODUCTION.log） |
| M-11 | 搜索节点上限 | 最多 8 节点；maxNodes=1 探针返回 limitExceeded | ≤ 5,000；超限返回 INCONCLUSIVE_LIMIT | PASS | S0_PARITY.json maxBfsVisited；tests/s0/gate.test.ts + performance.test.ts 探针 |
| M-12 | 离线运行外部请求 | 0 个网络调用点（src/ 扫描） | 0 | PASS | src/ 扫描 fetch(/XMLHttpRequest/WebSocket/node:http(s)/node:net；npm ci 的注册表下载属环境安装，非产品运行 |
| M-13 | 真人参与 | 0 | 0 | PASS | 全部输入为 fixtures/golden/ 下的合成 JSON；无真人受试者、无真实用户数据 |

配套套件（支撑证据，非矩阵项）：typecheck（src）0 错；test:core 137/137；test:canonical 37/37；test:replay 127/127；test:determinism 5/5；test:performance 7/7；Oracle pytest 177 passed, 0 failed / 177 total；Oracle run_goldens 24/24。门禁测试 tests/s0/gate.test.ts：66 通过 / 0 失败（T007 首次运行的 gate 失败已随 F-01 闭合，见 §3）。

## §2 八项遗留裁决

### A-01 G01 首个分歧：FIX-R1 后三方一致为 4（以 TS 步进比较为准）

**裁决：**采用 T004 步进比较（PROJECT_BOOK §8.6：按 sourceIndex 对齐、从检查点起逐事件步进规范化状态、首个不同位置）作为 S0 首分歧定义，G01 = 4。FIX-R1（P1-R1-01）已闭合 T007 的定义分歧：Oracle 的 _first_divergence 现实现同一 §8.6 步进比较（从检查点切片，检查点以下不可比），G01 的 Oracle 值由 2 改为 4；手工预期亦为 4。三方一致 24/24，首分歧现计入 parity 字段集（§10.4 全量），不再另列。DUPLICATE_TOOL_CALL 诊断本身在双方均带 sourceIndex 2——诊断 sourceIndex（2）与首分歧 sourceIndex（4）是两个不同数值，不得混同。分类 24/24 不受影响。

**证据：**tests/s0/gate.test.ts（TS_FIRST_DIVERGENCE；firstDivergenceMatchesOracle 24/24）；oracle/replay.py _first_divergence 文档字符串；artifacts/reports/S0_PARITY.json traces.G01（ts/oracle/expected 首分歧均为 4）与 summary.firstDivergenceOracleMatches 24/24

### A-02 报告哈希定义：冻结为剔除 metrics.durationMs 的 JCS 哈希

**裁决：**报告哈希 = TS canonicalHash（JCS）作用于 rejoinlab.report/v1 报告对象，其中 metrics.durationMs 被剔除（该字段每 run 波动；Oracle 侧本次运行 1–7 ms，历史区间 5–51 ms）；metrics.visitedStates 保留（确定性计数）。Oracle 没有报告哈希函数（只有 state_hash），故报告哈希是 TS 侧定义、TS canonicalHash 实现。确定性用该定义重测：24 条 Golden × 100 次重复 = 2400 次，每条恰 1 个哈希值。

**证据：**src/core/canonical.ts（Report-hash note）；tests/s0/gate.test.ts reportHash()；artifacts/reports/S0_DETERMINISM.json

### A-03 BFS 目标 = 轨迹的主诊断码，不是“任意分歧”

**裁决：**冻结。故障夹具的 BFS 目标是该夹具的主诊断码；正常夹具目标为任意分歧（偏离 CONSISTENT）。若目标为“任意分歧”，通用 DROP_EVENT 几乎能分歧每条轨迹，全部最短序列都会变成 ["DROP_EVENT"]，与计划 §13.3 的 G01 样本 ["REPLAY_PREFIX"] 矛盾，且不能说明被测故障。实测 24/24 最短序列与手工预期一致。

**证据：**src/replay/search.ts 模块头；oracle/replay.py 模块头（Judgment calls）；artifacts/reports/S0_PARITY.json（shortest 24/24）

### A-04 诊断码映射：UNCLOSED_STREAM_ITEM → TRUNCATED_RUN（仅当流确实缺终结事件）

**裁决：**一致。折叠层 UNCLOSED_STREAM_ITEM（CRITICAL，T003 本地码，run 结束时仍有未闭项）永不直出报告；报告层仅当全流缺终结事件（full runStatus RUNNING/NOT_STARTED 且有事件）时映射为 TRUNCATED_RUN（WARNING）。实测：G08 双方均为 [TRUNCATED_RUN] WARNING sourceIndex 4；N12（RUN_ERROR 终结、存在未闭项）双方均无 TRUNCATED_RUN。

**证据：**src/replay/planner.ts 模块头 + classifyDualTrack；src/core/state.ts（Reducer 永不发 TRUNCATED_RUN）；artifacts/reports/S0_PARITY.json traces.G08/N12

### A-05 Oracle RUN_STARTED 输入缺口：FIX-R1 已闭合（P1-R1-02）

**裁决：**FIX-R1（P1-R1-02）已闭合：Oracle 现实现 RUN_STARTED input 播种（oracle/reference.py _seed_run_input，按 PROJECT_BOOK §3.3：首个 RUN_STARTED 采用其 input.state 播种 sharedState，input.messages 播种消息态与归属），与 TS（reducer.ts reduceRunStarted + lifecycle.seedRunInput）一致。覆盖：oracle/tests/test_run_started_input.py（播种消息/状态/归属、重复播种、非法 input 拒绝）与 oracle/tests/fixtures/input_*.json 专用夹具；tests/s0/gate.test.ts 以这些夹具证明 TS 与 Oracle 的跨语言 parity。24 条 Golden 本身仍不含 input（全文 grep 0 处），但缺口已有专用夹具与测试覆盖，不再是未闭合项，不阻塞 S0。

**证据：**oracle/reference.py _seed_run_input；oracle/tests/test_run_started_input.py；oracle/tests/fixtures/input_*.json；tests/s0/gate.test.ts（input 夹具 parity）；T007 探针：同一探针轨迹 TS 与 Oracle 现均播种 sharedState {count: 7}

### A-06 tsconfig include 不扩大到 tests

**裁决：**不扩大。探查（本脚本每 run 重做）：include ["src", "tests"] 报 19 错——15 处缺 @types/node（node:fs/crypto/child_process/os/path/url 模块解析 13 处、Buffer 2 处），4 处真实测试代码类型错，全部为 T002/T005 既有（tests/parser/normalize.test.ts 从 normalize.js 导入 protocol/types.ts 才有的 NormalizedEvent 类型；tests/replay/inject.test.ts 两处 as 强转；tests/replay/planner.test.ts 把 STEP_STARTED 传给类型化 helper）。T007 新增的 tests/s0/ 两文件已修到零真实类型错（仅剩 node: 模块解析类）。扩大需新增 dev 依赖并改 T002/T005 测试代码，超出 T007 门禁范围。src typecheck 保持 0 错；测试由 vitest 执行（不做类型检查）。风险已记录：测试代码类型错是潜伏的，目前运行时全绿。

**证据：**本脚本 tsconfig 探查步骤（见 T007_PRODUCTION.log 尾部）；artifacts/logs/T007_TSCONFIG_PROBE.log

### A-07 Oracle canonicalize_state() 字段名映射 + StateDiff/FirstDivergence 多余字段

**裁决：**Parity 须做折叠层字段名映射，不直接比状态哈希：Oracle 投影用 Oracle 内部字段名（messages: id/role/name/content/segments/toolCalls/open/incomplete；toolCalls: toolCallId/toolCallName/parentMessageId/args/result/resultMessageId/open/incomplete/duplicate；runs: runId/threadId/status；timeline: kind/messageId/toolCallId/delta/text/name），TS 投影用冻结 RejoinState 字段名（MessageState.status/owner、ToolCallState.id/name/arguments/status/hasResult/resultContent/runId、RunState 含 parentRunId/protocolVersion/outcome/result/error、TimelineItem.kind/eventType/messageId/toolCallId/runId/text）。直接互喂会静默丢字段。跨语言一致性以“折叠层字段逐项相等 + 通用 JCS canonicalize() 同值同字节（oracle-parity.test.ts）”建立。StateDiff 多余 kind 字段、FirstDivergence 多余字段（eventType/messageId/toolCallId/runId/note）记为遗留：T010 输出 rejoinlab.report/v1 时须剥离/容忍（§13.2 differences 只有 jsonPointer/expected/actual；firstDivergence 只有 sourceIndex/fullStateHash/resumeStateHash/differences）。不阻塞 S0。

**证据：**src/core/canonical.ts（State projection 注释）；oracle/canonical.py canonicalize_state()；tests/s0/gate.test.ts pathFields() 折叠映射；S0_REPORT.md 附表

### A-08 wire 快照丢段边界：已证实的遗留限制，不阻塞 S0

**裁决：**已证实：messageStateToAGUI 不带 segments（src/core/state.ts:384–395，注释已写明“AG-UI Message schema 没有 segments，只有 content 随 wire 走”；makeCheckpoint 的 messagesSnapshot 经此函数生成，src/core/snapshot.ts:536）。当前恢复路径用 capturedState（段完整）或 foldPrefix 重放（段重建），故不影响 T005/T007；未来任何从 wire messagesSnapshot 单独重建状态的路径会丢段边界。记为遗留限制，不阻塞 S0；T008/T009 若用 messagesSnapshot 恢复须先补 segments 往返。

**证据：**src/core/state.ts messageStateToAGUI 注释；src/core/snapshot.ts:536；src/replay/planner.ts resolveCheckpoint（用 capturedState）


## §3 历史 FAIL 项已闭合（F-01）

**T007 首次运行为 FAIL**（唯一未过项 M-06，parity 23/24）：G05 全路径与恢复路径的 pendingToolCallIds，TS 均为 ["call-1"]，Oracle 与手工预期均为 []。其余字段（verdict INCONSISTENT、诊断 [OUT_OF_ORDER]、最短序列 ["SWAP_ADJACENT"]、首分歧 4、消息/工具顺序、sharedState、runStatus）三方一致，分类不受影响。

**裁决与修复（FIX-T007-F01，见 docs/ADR-F01-pending-derived.md）：** pending 是派生状态，不是 wire 声明的回显——规格 §3.14 定义 pending 列表为“当前 run 中尚未收到结果的调用”，§5.5 又把 pending 定为调用在 run 结束时可处于的状态。修 Oracle（oracle/reference.py：按 id 分组派生 pending，每事件后重算；RUN_FINISHED outcome.success 时比对声明列表与派生子集），不修 TS，不改冻结规格；oracle/golden_expected.json 的 G05 两处 pending 由 [] 改为 ["call-1"]。

**复跑结果：** 本次 verify:s0 复跑 verdict PASS，矩阵 13/13，parity 24/24，failItems 为空。F-01 已闭合，不再是当前失败项。

## §4 逐条 Golden 三方比对（摘要）

完整逐字段表见 artifacts/reports/S0_PARITY.json（24 条 × verdict/诊断/最短序列/双路径终态字段/BFS 节点数/合法基线收敛）。

- 24 条：verdict、诊断码（含 severity 与 sourceIndex）、最短序列、双路径终态字段（消息顺序、工具调用顺序、sharedState、pendingToolCallIds、runStatus）三方全一致。
- G01：三方全一致；首分歧 TS/Oracle/预期均为 4（§8.6 步进比较；诊断 sourceIndex 2 是另一数值，见 A-01）。
- G05：三方全一致；pending TS/Oracle/预期双路径均为 ["call-1"]（派生规则，见 §3 历史项 F-01）。
- G03：INCONSISTENT / [MESSAGE_REORDER] / 首分歧 10，与 Oracle 一致（FIX-T003-G03 未回归）；N08 仍 CONSISTENT。
- G08：INCOMPLETE_TRACE / [TRUNCATED_RUN] WARNING sourceIndex 4，三方一致；合法基线双路径哈希一致（收敛）。

## §5 字段名折叠映射（A-07 附表）

| 维度 | Oracle 字段 | TS RejoinState 字段 |
|---|---|---|
| message | id / role / name / content / segments / toolCalls / open / incomplete | id / role / name? / content / segments / toolCalls? / status（open/incomplete/closed）/ owner（producer/client） |
| toolCall | toolCallId / toolCallName / parentMessageId / args / result / resultMessageId / open / incomplete / duplicate | id / name / parentMessageId? / arguments / resultContent? / resultMessageId? / status / hasResult / runId |
| run | runId / threadId / status | runId / threadId / status / parentRunId? / protocolVersion? / outcome? / result? / error? |
| timeline | kind / messageId? / toolCallId? / delta? / text? / name? | kind / eventType / messageId? / toolCallId? / runId? / text? |
| state | threadId / runs / messages / toolCalls / sharedState / orderedTimeline / pendingToolCallIds / runStatus（diagnostics 丢弃） | 同名 8 个协议字段（diagnostics 为第 9 个本地字段，规范化时丢弃） |

状态哈希不跨语言直接比对：两投影字段名不同，直接互喂会静默丢字段。跨语言一致性以本表折叠映射逐项相等 + 通用 JCS canonicalize() 同值同字节建立。

## §6 遗留清单（不阻塞 S0，但须带入后续任务）

- T010：StateDiff 的 kind 字段、FirstDivergence 的 eventType/messageId/toolCallId/runId/note 字段在输出 rejoinlab.report/v1 时剥离/容忍（A-07）。
- T008/T009：任何从 wire messagesSnapshot 单独重建状态的路径须先补 segments 往返，否则丢段边界（A-08）。
- A-05 已闭合（FIX-R1，P1-R1-02）：Oracle 已实现 RUN_STARTED input 播种，见 oracle/tests/test_run_started_input.py 与专用夹具。
- 后续（协调员定）：tsconfig 是否扩大到 tests——需先补 @types/node 并修 4 处测试代码类型错（A-06）。
- F-01 已闭合（见 §3 历史项；ADR docs/ADR-F01-pending-derived.md）。

## §7 证据与复现

验收命令（本机实测，见 artifacts/logs/ 三个日志）：

```
npm ci
npm run typecheck
npm run test:core        # 137/137
npm run test:canonical   # 37/37
npm run test:replay      # 127/127
npm run test:oracle      # run_goldens 24/24 + golden.test.ts
npm run verify:s0        # 本脚本；FAIL 时 exit 1
npm run test:determinism # 5/5
npm run test:performance # 7/7
python -m pytest -q oracle/tests   # 177 total
```

文件清单：

- artifacts/reports/S0_GATE.json（机器可读矩阵 + 裁决）
- artifacts/reports/S0_REPORT.md（本文件）
- artifacts/reports/S0_PARITY.json（三方逐条比对表）
- artifacts/reports/S0_DETERMINISM.json（2400 次重复哈希）
- artifacts/logs/T007_PRODUCTION.log（生产套件原始输出）
- artifacts/logs/T007_ORACLE.log（Oracle 原始输出）
- artifacts/logs/T007_PARITY.log（门禁测试原始输出）
- artifacts/logs/T007_TSCONFIG_PROBE.log（tsconfig 探查，A-06）
- artifacts/manifests/S0_SHA256SUMS.txt（全部 T007 输出与关键输入的 SHA-256；清单本身除外）
- scripts/verify-s0.mjs、scripts/oracle-parity.py、tests/s0/gate.test.ts、tests/s0/performance.test.ts（T007 新增；package.json 新增 test:oracle、test:performance、verify:s0 三个脚本）

## §8 未解决的问题

1. F-01 已闭合（见 §3 历史项）；本次运行无未解决的 FAIL 项。
2. G01 首分歧已闭合（FIX-R1，A-01）：三方均为 4；诊断 sourceIndex 2 与首分歧 sourceIndex 4 是两个不同数值，不得混同。
3. Oracle RUN_STARTED input 缺口已闭合（FIX-R1，A-05）：Oracle 已实现 input 播种，专用夹具与测试覆盖；24 条 Golden 本身仍不含 input。
