# ADR-F01：pendingToolCallIds 为派生状态 —— 修 Oracle，不修 TS，不改冻结规格

- **状态：** 已执行（FIX-T007-F01），待协调员独立复核；未提交。
- **日期：** 2026-11-23
- **背景：** T007 S0 硬门禁 FAIL，矩阵 13 项中 12 项 PASS，唯一 FAIL 为 M-06 Oracle parity 23/24（F-01，G05 pendingToolCallIds）。协调员已亲自复现（`npm run verify:s0` exit 1）并核查规格原文，裁决修 Oracle。
- **涉及文件：** `oracle/reference.py`、`oracle/golden_expected.json`（仅 G05 两字段）；本 ADR；附带 `scripts/verify-s0.mjs` 的 M-11 探针检测修复（见 §5.4，门禁脚本缺陷，非阈值放宽）。

## §1 问题：G05 的数值

G05（相邻 TOOL_CALL_ARGS 片段交换，`fixtures/golden/G05.json`）：call-1 经历 START / ARGS / ARGS / END，无 TOOL_CALL_RESULT；RUN_FINISHED（sourceIndex 9）无 outcome。

| 路径 | TS | Oracle（修复前） | 手工预期（修复前） |
|---|---|---|---|
| 全路径 pendingToolCallIds | `["call-1"]` | `[]` | `[]` |
| 恢复路径 pendingToolCallIds | `["call-1"]` | `[]` | `[]` |

其余字段三方全一致：verdict INCONSISTENT、诊断 `[OUT_OF_ORDER]`、最短序列 `["SWAP_ADJACENT"]`、首分歧 4、消息顺序 `["msg-1"]`、工具顺序 `["call-1"]`、sharedState `{}`、runStatus FINISHED。分类 24/24 不受影响。

## §2 规格依据（冻结规格原文引用）

以下引文逐字抄自 `01_project_book/PROJECT_BOOK.md` v1.0.0，未改写。

**§3.14 TOOL_CALL_RESULT（核心定义句）：**

> 重要生命周期修正：AG-UI 1.0 并不要求每个 TOOL_CALL_START 都必须在同一 run 中收到 TOOL_CALL_RESULT。存在两种情况：1. Agent 自己执行的工具：结果通常通过同一 run 的 TOOL_CALL_RESULT 返回。2. 前端执行的工具：当前 run 可以以成功状态结束，并将尚未回答的调用列入 pendingToolCallIds；结果通过下一次 run 的输入消息返回。因此 RejoinLab 的约束是：一个同一 run 的工具调用最多只能收到一次对应的 TOOL_CALL_RESULT；同一调用 ID 不得因重放而被误认为多个不同调用；前端工具调用允许在当前 run 没有 TOOL_CALL_RESULT；**若有 pendingToolCallIds，必须与当前 run 中尚未收到结果的调用一致**；下一 run 如果继续该线程，应在输入消息中携带对应工具结果；RUN_ERROR 结束未完成调用时，不推断一个虚假的 TOOL_CALL_RESULT。

**§5.5 工具调用生命周期不变量：**

> TOOL_CALL_ARGS 必须对应一个已打开的 toolCallId。TOOL_CALL_END 必须对应一个已打开的 toolCallId。一个调用 ID 不能被重复创建成两个相同的逻辑调用。参数片段必须按事件顺序拼接。TOOL_CALL_RESULT 必须对应已有调用。同一个调用在同一逻辑执行中最多有一个结果。**前端工具调用可以在当前 run 结束时保持 pending。**RUN_ERROR 结束当前 run 的未完成操作，但不自动产生工具结果。同一个 toolCallId 如果被用于两个不同父消息或两个不一致调用，必须标记身份复用风险。

**§3.4 RUN_FINISHED（outcome 的 MVP 处理）：**

> 必填：type = RUN_FINISHED。可选：outcome、result、usage、公共事件字段。语义：结束一个未报告失败的 run；必须保证 run 打开的消息、工具调用等按协议正确关闭；不得把用户断开连接直接伪装成 RUN_FINISHED。outcome 的 MVP 处理：absent 视为正常成功；success 正常结束，可带 pendingToolCallIds；cancelled 取消结束，不是成功，也不是 RUN_ERROR；interrupt 记录中断状态，不在 MVP 中实现完整人工审批及 ResumeEntry 交互。

**§3.12 TOOL_CALL_END（何谓“已关闭”）：**

> 必填：type、toolCallId。语义：关闭工具调用的参数流。AG-UI 1.0 允许关闭后的工具调用使用相同 toolCallId 重新打开，但必须保持 toolCallName、parentMessageId 和 owner 一致。

**§3.2 MVP 支持事件清单（范围，非 pending 定义）：**

> MVP 支持以下 15 种事件：RUN_STARTED、RUN_FINISHED、RUN_ERROR、TEXT_MESSAGE_START、TEXT_MESSAGE_CONTENT、TEXT_MESSAGE_END、TEXT_MESSAGE_CHUNK（支持并展开）、TOOL_CALL_START、TOOL_CALL_ARGS、TOOL_CALL_END、TOOL_CALL_CHUNK（支持并展开）、TOOL_CALL_RESULT、STATE_SNAPSHOT、STATE_DELTA、MESSAGES_SNAPSHOT。

**两点澄清（避免误引）：**

1. “本 run 发起且未收到结果”这句话不在 §3.2 原文里，它是 `src/core/reducer.ts` 注释对 §3.14 定义句的转述；规范依据是 §3.14 本身。
2. T007 报告（`artifacts/reports/S0_REPORT.md` §3）称 §3.14“只约束‘若有 pending 列表须与未收结果的调用一致’，未定义无 outcome 时的状态字段”。本次裁决认为该读法过窄：§3.14 的定义句把 pending 列表定义为“当前 run 中尚未收到结果的调用”这个派生集合，§5.5 又把 pending 说成调用在 run 结束时可处于的状态（“可以在当前 run 结束时保持 pending”）——pending 是调用的状态，不是 wire 声明的回显。因此**无需修订冻结规格文本**；T007 报告 §3 列出的第三条路径（改规格）不需要走。

## §3 双方实现对照（修复前）

| 维度 | TS（生产实现，T003 冻结） | Oracle（修复前） |
|---|---|---|
| pending 的定义 | 派生：`computePendingToolCallIds`（`src/core/lifecycle.ts:59-67`，注释 + 定义）= 状态为 `"closed"`（TOOL_CALL_END 见过）且 `!hasResult` 的调用，每事件后重算（`reducer.ts` 的 `refreshPending`） | wire 回显：仅在 RUN_FINISHED outcome.success 时把声明列表拷进状态（`oracle/reference.py:633-634` 修复前行号）；无 outcome 时保持 `[]`，此后不再重算 |
| RUN_FINISHED 声明的处理 | 声明列表与本 run 的派生子集比对，不一致抛 `PENDING_TOOL_CALL_MISMATCH`（`src/core/reducer.ts:202-220`） | 声明列表直接采信，无比对 |
| TOOL_CALL_RESULT 到达 | `applyToolCallResult` 置 `status: "resulted"`，随后重算，pending 移出 | 从 pending 列表中删 id（`oracle/reference.py:807-809` 修复前行号）——Oracle 自己也把 pending 当作“等待结果的调用”集合，却只靠声明填充，声明缺失时就漏报 |
| 锁定用例 | `tests/core/reducer.test.ts:400`：无 outcome 的 runFinish 后 pending 为 `["tc1"]`（TOOL_CALL_CHUNK 展开用例，与 G05 同形） | 无对应锁定 |
| 状态注释 | `src/core/state.ts:168-169`（ToolCallState `status` 注释）：“closed”即 pending 状态；"incomplete" 明确不在 pending 里 | — |

## §4 裁决：pending 为派生状态；修 Oracle，不修 TS，不改冻结规格

1. **定义归属：** §3.14 把 pending 列表定义为派生集合（“当前 run 中尚未收到结果的调用”），§5.5 把 pending 定为调用在 run 结束时可处于的状态。G05 的 call-1 有 START/ARGS/END、无 RESULT，RUN_FINISHED 无 outcome——按 §3.14 它就是 pending。TS 的 `["call-1"]` 是对的，Oracle 的 `[]` 违反规格。
2. **Oracle 自相矛盾：** Oracle 在 TOOL_CALL_RESULT 到达时把 id 移出 pending，说明它也把 pending 理解为“等待结果的调用”集合；但它只靠 outcome 声明填充该集合，声明缺失时漏报。派生规则同时修复定义与填充。
3. **与 FIX-T003-G03 方向相反但逻辑相同：** 上次 TS 违规格改 TS（MessageState segments，G03）；这次 Oracle 违规格改 Oracle。Oracle 是独立参照，不是福音；违规格时以冻结规格为准。
4. **手工预期同错，同步修正：** `oracle/golden_expected.json` 的 G05 pending `[]` 与 Oracle 同错（该文件声明为手工推导、非程序输出），按同一规格依据修正为 `["call-1"]`（双路径），见 §5.2。
5. **不改冻结规格文本：** 见 §2 末尾——§3.14 + §5.5 合起来已经定义了派生语义，无需规格修订。

## §5 本次修复

### §5.1 `oracle/reference.py`（5 处，均在该文件内；行号为修复后）

1. **派生函数 `_compute_pending_tool_call_ids(state, run_id=None)`（:613）与 `_refresh_pending_tool_call_ids(state)`（:659-666），辅以 `_current_run_id(state)`（:603）。** 规则与 TS `computePendingToolCallIds` 同款：已关闭（`open` 为 False）且未被标记 `incomplete` 且 `result` 为 None 的调用；顺序为 toolCalls 列表顺序（START 顺序，与 TS 过滤其 toolCalls 数组一致）；每个 id 至多出现一次。`run_id` 给定时只计该 run 的调用（RUN_FINISHED 比对范围）；不给时为跨所有 run 的全局集合。
   - **按 id 分组（修复中发现的第二处分歧，见 §5.3）：** pending 是逻辑调用（toolCallId）的属性，不是单个状态条目的属性。Oracle 会把重放的 TOOL_CALL_START 记为第二条目（DUPLICATE_TOOL_CALL，AG-UI #1524），而 §3.14 禁止把同一 id 误认为多个调用。因此：一个 id 仅当**没有任何条目持有结果**且**至少一条目已关闭未收结果**时才 pending。
   - **runId 字段：** `_new_tool_call` 增加 `runId` 参数（:156），新建/重放重复条目（:828、:855）及合法重开（:849，将既有条目的 runId 更新为当前 run，与 TS 重开更新 runId 一致）均记录当前运行 run 的 runId；无运行 run 时为 None。用途仅限本 run 派生子集比对。**`oracle/canonical.py` 的 `canonicalize_state()` 投影键表未加 `runId`，既有状态哈希保持不变。**
2. **RUN_FINISHED 分支（:704-745）：删除旧的“声明列表拷进状态”行为；** outcome.type 为 success 时，把声明列表（缺失计为 `[]`，与 TS `?? []` 一致）与本 run 的派生子集比对，不一致时抛 `InvalidInput`（通道选择见 §6）；比对发生在 `_close_open_items` 之前（与 TS 先比对、后标记未闭项的顺序一致）。outcome 缺失或非 success 时不比对、不触碰 pending（G05 即此情形）。
3. **`fold()`（:989-1004）：** 折叠开始时先把初始状态（检查点基底）的 pending 归一化为派生值；每处理一个（展开后的）事件后重算一次，保证历史快照里记录的也是派生值。
4. **保留未动：** TOOL_CALL_RESULT 分支的显式移出逻辑（:918-920，修复前 :807-809）原文保留——每事件重算已将其包含，保留属于最小改动与纵深防御。`validate_event` 对 outcome.pendingToolCallIds 的形状校验（:247-252）未动。`oracle/replay.py`、`oracle/canonical.py` 未动（见 §7 末尾：G02/G03/G06 的显式检查点 pending `[]` 与其 toolCalls 一致，无需改 replay）。

### §5.2 `oracle/golden_expected.json`（字节级 diff 仅两处）

G05 `finalState.full.pendingToolCallIds` 与 `finalState.resume.pendingToolCallIds` 由 `[]` 改为 `["call-1"]`。文件为单行 JSON、无尾换行；改写时用 `ensure_ascii=False` + 紧凑分隔符重 dump 并以 `difflib` 核对：相对 HEAD 仅 2 处插入（`[]` → `["call-1"]`，长度 +16 字节），其他条目、其他字段、转义形式均未动。G05 的 rationale 未提 pending，无需改。

### §5.3 修复中发现：按条目派生会误判 G01，必须按 id 分组

第一版实现（逐条目派生）使 `run_goldens` 从 24/24 跌到 23/24：G01 恢复路径 pending 变为 `["call-1"]`，预期为 `[]`。根因是 Oracle 的双条目模型：G01 恢复路径为 FULL_REPLAY，检查点内已关闭的 call-1 被重放 START 记为第二条目（duplicate=True）；随后的 TOOL_CALL_END 关闭的是该重复条目（`_find_tool_call` 无 `want_open` 时返回最后匹配），TOOL_CALL_RESULT 命中首个未收结果条目（原始条目）。终态：原始条目已收结果，重复条目已关闭未收结果——逐条目派生把重复条目计为 pending，但按 §3.14 它是同一个逻辑调用，且该调用已有结果。TS 的单条目模型（重开复用同一条目，结果落在其上）终态 pending 为 `[]`，与预期一致。按 id 分组后（§5.1），G01 恢复路径 pending 回到 `[]`，`run_goldens` 恢复 24/24。此分组规则只影响存在重复条目的轨迹；24 条 Golden 中仅 G01 有重复条目。

### §5.4 附带修复：`scripts/verify-s0.mjs` 的 M-11 探针检测（门禁脚本缺陷）

修复 Oracle 后首次重跑 `verify:s0`：parity 24/24、分类 24/24、收敛 24/24、确定性 2400 次，但 verdict 仍为 FAIL——M-11（搜索节点上限）翻为 False，而 T007 时它为 True。根因与 Oracle 无关，是门禁脚本的检测方式缺陷：M-11 的通过条件包含 `steps.gateTest.output.includes("maxNodes=1 forces limitExceeded")`；经实测（`/tmp` 隔离探针），vitest 仅在测试文件含失败用例时才逐条打印用例名，全绿时只打印文件汇总行。T007 时 gate 有 2 项失败，探针名因失败列表被打印出来，检查偶然通过；本次修复使 gate 28/28 全绿，探针名不再出现，检查随之变假——而探针本身（`tests/s0/gate.test.ts:388`，断言 `limitExceeded === true`）两次运行都通过，maxBfsVisited 均为 8。

改动（一行，`scripts/verify-s0.mjs` M-11 定义处，附注释说明）：用 `steps.gateTest.exit === 0` 代替字符串包含检查——gate exit 0 当且仅当 28 个门禁测试全过，探针包含在内。**阈值未变**（maxBfsVisited ≤ 5000；探针仍须通过）；仅检测方式从“依赖 reporter 啰嗦程度”改为“门禁文件退出码”。改后重跑 `verify:s0`：verdict PASS，矩阵 13/13（见 §8）。

**未修复、留给协调员的模板问题：** `verify-s0.mjs` 的报告模板含 T007 时的硬编码叙事（`S0_REPORT.md` §0/§3/§6 与 `S0_GATE.json` 的 `note` 字段仍写“唯一缺口是 G05”“S0 = FAIL”“待协调员裁决 F-01 修复方向”等），本次 PASS 后重生成的报告里数字已全部正确，但叙事与 verdict 矛盾（例如 `S0_REPORT.md:38` 仍称“失败的 2 项即 G05……是 F-01 的直接信号”，而 gate 实际为 28 通过 / 0 失败）。本次未改模板正文——那是 T007 产物的叙事更新，超出本次修复范围；协调员复核时请决定是否由后续任务更新模板。

## §6 RUN_FINISHED 声明比对的错误通道：`InvalidInput`（已新增）

- **选了什么：** 不一致时在 `_reduce_one` 的 RUN_FINISHED 分支抛 `InvalidInput`，消息内含 TS 对等码名 `[PENDING_TOOL_CALL_MISMATCH]`、声明列表、派生子集与 §3.14 引用（`reference.py:737-745`）。`oracle/replay.py` 的 `evaluate()` 已将 `InvalidInput` 映射为 verdict `INVALID_INPUT` + 诊断码 `INVALID_INPUT`（CRITICAL，Oracle 内部码，不在 §6 内——与既有硬违规如未知事件类型、非法 outcome 形状同一通道）。
- **为什么不用诊断（soft diagnostic）：** (a) §6 没有 `PENDING_TOOL_CALL_MISMATCH` 诊断码，新造一个属于规格扩展；(b) `evaluate()` 只用恢复路径的诊断驱动裁决，全路径折叠里追加的诊断会被丢弃——同一份畸形输入在两条路径上会得出不一致的处理；抛错使双路径一致中止，与 TS 抛 `ReducerError` 中止折叠对等。
- **覆盖情况：** 24 条 Golden 中仅 N04 携带 outcome（run-1 success，声明 `["call-1"]`，与派生子集一致，终态 run-2 结果到达后 pending 为 `[]`）。**无 Golden 覆盖不匹配分支**（按任务要求，未为此改任何夹具或预期）。探针验证（ fold 直调，见 §8）：声明 `[]` 而派生 `["c1"]` 时抛 `InvalidInput`；声明一致时通过且 pending 为 `["c1"]`；无 outcome 时派生 `["c1"]`；run-1 遗留 pending 下 run-2 success 无列表时不抛错、全局 pending 保持 `["c1"]`（跨 run 作用域正确）。

## §7 影响范围：仅 G05

- **终态层面：** 派生规则只改变“已关闭未收结果且无结果”的调用的终态 pending。24 条中除 G05 外：G01/G02/G03 的 call-1 终态均已收结果；G08 的 call-1 终态仍 open（截断流，无 END）；N03/N04/N09/N15 的调用终态均已收结果；N04 的 run-1 声明与派生子集一致；其余轨迹无工具调用或无已关闭未收结果调用。实证：`run_goldens` 24/24、`pytest` 95/95、`verify:s0` 13/13（§8）。
- **中间态层面：** 派生值同时进入折叠历史摘要（`state_hash` 含 pending），但首分歧与 BFS 均不受影响：G05 首分歧仍为 4（两路径在 index 4 的 args 上已分歧，pending 在两路径上同步为 `["call-1"]`）；G01 首分歧仍为 2（诊断优先分支）；G02/G03 首分歧仍为检查点下标 7/10（消息重映射/段合并已在该处分歧）。`run_goldens` 与门禁逐字段比对已覆盖。
- **未改：** 冻结规格 `01_project_book/`、`02_implementation_plan/`；TS 生产代码 `src/` 与既有 `tests/`（`reducer.test.ts:400` 锁定用例原样通过）；`fixtures/golden/` 下的事件夹具；其他 Golden 的预期值；`oracle/replay.py`（G02/G03/G06 的显式检查点 pending `[]` 与其 toolCalls 一致——RESULT 均在检查点下标之前到达；`resolve_checkpoint` 的前缀折叠基底本身已是派生值）；`oracle/canonical.py`（投影未加 `runId`，状态哈希不变）。

## §8 验收（全部亲自跑过）

执行时 HEAD：`3be4082`（协调员在任务执行期间提交的 T007 收尾提交，仅改 `00_control/PROJECT_STATE.md`）。

| 命令 | 结果 |
|---|---|
| `python3 -m pytest oracle/tests -q` | **95 passed** |
| `python3 -m oracle.run_goldens` | **24/24 PASS**（failed: none） |
| `npm run typecheck` | **0 错**，exit 0 |
| `npm run test:core` | 137 passed |
| `npm run test:canonical` | 37 passed |
| `npm run test:replay` | 121 passed |
| `npm run test:parser` | 88 passed |
| `npm run test:diff` | 23 passed |
| `npm run test:determinism` | 5 passed |
| `npm run test:performance` | 7 passed |
| `npm run test:oracle` | 75 passed（内含 run_goldens 24/24） |
| `npm run verify:s0` | **verdict PASS，exit 0，矩阵 13/13**（第二次运行；第一次运行因 §5.4 的 M-11 脚本缺陷为 FAIL，parity 已 24/24） |

`verify:s0` 第二次运行（2026-11-23T16:02:35.912Z，HEAD 3be4082）关键数字：M-01 分类 24/24；M-02 故障检出 8/8；M-03 正常轨迹 16/16；M-04/M-05 均为 0；M-06 parity **24/24**（parityFailures `[]`）；M-07 收敛 24/24；M-08 确定性 2400 次重复、每条恰 1 个哈希；M-09 40 事件轨迹正常；M-10 最慢 45.4 ms（T-40 analyze 45.4 ms；最慢 Golden G01 10.9 ms；门槛 < 1,000 ms）；M-11 最多 8 节点；M-12 网络调用点 0；M-13 真人参与 0；failItems `[]`；gate 28/28；pytest 95；run_goldens 24；tsconfig 探针 19 错 / exit 2（A-06 既有信息性探针，未变）。firstDivergence vs Oracle 值 23/24（已知定义分歧 G01：TS 4 vs Oracle 2，A-01，未变）。新生成文件 SHA-256 见 `artifacts/manifests/S0_SHA256SUMS.txt`（如 `S0_GATE.json` `047a12be…`、`S0_PARITY.json` `2daab533…`、`oracle/reference.py` `5a183a53…`、`oracle/golden_expected.json` `fb60f92e…`）。

`artifacts/logs/T006_ORACLE.log` 的处理：每次 `run_goldens` 都会重写它（仅日期与 durationMs 差异）。本次跑完后**用任务开始前备份的字节恢复**（`/tmp/T006_ORACLE.log.t007-backup`，md5 `54db3852…`），未用 `git checkout`——HEAD 提交的版本与 T007 运行记录不同，checkout 会丢 T007 的记录。恢复后 `git status` 中该文件仍为任务开始时已有的 `M` 状态。

## §9 遗留

1. **RUN_FINISHED 声明比对是本次新增，无 Golden 覆盖。** 见 §6：仅 N04 携带 outcome 且一致；不匹配分支只有探针验证，未进夹具。后续若新增带 outcome 的 Golden，应包含一条声明与派生子集不一致的轨迹，预期 verdict `INVALID_INPUT`。
2. **Oracle RUN_STARTED input 缺口仍在（T007 A-05）。** Oracle 折叠忽略 RUN_STARTED input（无 input 播种；`seedRunInput` 的 TS 对应逻辑缺失），TS 播种 sharedState。24 条 Golden 均无 input，零影响；后续需新增一条带 input 的 Golden，或对齐 Oracle 的播种规则——由协调员定。
3. **wire 快照丢段边界仍在（T007 A-08）。** `messageStateToAGUI` 不带 segments；当前恢复路径用 capturedState 或前缀重放，不受影响；T008/T009 若用 messagesSnapshot 恢复须先补 segments 往返。
4. **显式检查点 pending 片段的瞬时不一致（本次未改 `replay.py`）。** `resolve_checkpoint` 采用显式检查点片段的 `pendingToolCallIds` 时，`fold()` 会在首个恢复事件后重算为派生值；若恢复流为空，基底的片段值会原样保留。24 条 Golden 中 G02/G03/G06 的显式 `[]` 与其 toolCalls 一致，未触发；未来若出现“显式过期检查点 + 空恢复流”的组合，需在 `resolve_checkpoint` 侧同样派生。
5. **相邻观察，未改：合法重开不重置结果。** Oracle 的合法重开（`reference.py` TOOL_CALL_START 分支）把既有条目置 open、清 args，但不重置 `result`；TS 重开重置 `hasResult`。因此“曾收结果的调用被重开、关闭后未收新结果”时，TS 计 pending，Oracle 不计。24 条 Golden 无此情形，本次未动；后续对齐时一并考虑。
6. **门禁报告模板叙事滞后（见 §5.4）。** `verify-s0.mjs` 模板正文仍按 T007 FAIL 叙事写死，PASS 后重生成的 `S0_REPORT.md`/`S0_GATE.json` 数字正确但叙事矛盾；请协调员决定后续任务是否更新模板。

## §10 未改清单（核对）

- 冻结规格 `01_project_book/`、`02_implementation_plan/`：未动。
- TS 生产代码 `src/`、既有 `tests/`：未动。
- `fixtures/golden/` 事件夹具：未动。
- 其他 Golden 的预期值：未动（`golden_expected.json` 字节级 diff 仅 G05 两处）。
- `oracle/replay.py`、`oracle/canonical.py`：未动。
- 未提交任何内容；提交与独立复核由协调员负责。
