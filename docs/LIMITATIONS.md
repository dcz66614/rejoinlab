# 已知限制与偏差 — RejoinLab (P031)

> 本清单是终审包的必读项：每一项都已披露，不得静默接受。
> 编号规则：`L-Txxx-nn` 按来源任务编号；`L-SPEC-nn` 为规格验证的 6 项 MINOR。
> “已修复”项保留历史记录，不再是当前限制。

## T003 — 确定性参考 Reducer

- **L-T003-01** `MessageState` 装不下 activity 对象 payload：类型不精确，
  运行时正确。activity 消息的对象 payload 没有对应的状态字段，归约时只保留
  文本侧信息，不影响 verdict 计算。
- **L-T003-02** activity 夹具的 `content` 是字符串，不是对象：
  测试夹具用字符串 content 覆盖 activity 路径，与真实 activity 对象形状不一致。
  夹具通过，覆盖的是字符串分支。
- **L-T003-03** `diagnostics` 是 `RejoinState` 的第 9 个字段，在项目书 §5.3
  的状态结构之外：软发现记入 `state.diagnostics`；T004 的 canon 明确排除该字段，
  不影响状态哈希。已接受，不改规格。

## T007 — S0 硬门禁（裁决 A-01～A-08 与遗留 F1/F2/F4/F5）

- **L-T007-01**（A-01）G01 首个分歧 TS=4 vs Oracle=2：以 T004 步进比较
  （项目书 §8.6：按 sourceIndex 对齐、从检查点起逐事件步进规范化状态、
  首个不同位置）作为 S0 首分歧定义，G01 = 4。Oracle 的诊断优先分支
  （取最早诊断 sourceIndex 2）是 Oracle 内部判断分支，不在 §8.6 文本中；
  该差异不计入 parity 字段集，另列 firstDivergence 一致性
  （vs Oracle 值 23/24，vs §8.6 定义 24/24）。`DUPLICATE_TOOL_CALL`
  诊断本身在双方均带 sourceIndex 2，故障位置没有丢失。分类 24/24 不受影响。
- **L-T007-02**（A-05）Oracle 忽略 `RUN_STARTED` 的 `input`：同一探针轨迹
  （`input.state {count: 7}`），TS 播种 sharedState `{count: 7}`，
  Oracle fold 忽略 input、sharedState 保持 `{}`。24 条 Golden 均不含 input
  （全文 grep 0 处），故对本门 parity/分类零影响。后续：需新增一条带 input 的
  Golden，或对齐 Oracle 的播种规则——由协调员定，不改 oracle/、不改生产代码。
- **L-T007-03**（A-06）tsconfig 的 `include` 不扩大到 tests：探查报 19 错——
  15 处缺 `@types/node`（模块解析 13 处、Buffer 2 处），4 处真实测试代码类型错，
  全部为 T002/T005 既有。扩大需新增 dev 依赖并改 T002/T005 测试代码，
  超出 T007 门禁范围。src typecheck 保持 0 错；测试由 vitest 执行（不做类型检查）。
  风险：测试代码类型错是潜伏的，目前运行时全绿。
- **L-T007-04**（A-08）wire 快照丢段边界：`messageStateToAGUI` 不带 segments
  （`src/core/state.ts:384–395`，注释已写明“AG-UI Message schema 没有 segments，
  只有 content 随 wire 走”；`makeCheckpoint` 的 messagesSnapshot 经此函数生成，
  `src/core/snapshot.ts:536`）。当前恢复路径用 capturedState（段完整）或
  foldPrefix 重放（段重建），故不影响 T005/T007；未来任何从 wire
  messagesSnapshot 单独重建状态的路径会丢段边界。T008/T009 若用
  messagesSnapshot 恢复须先补 segments 往返。
  v1.0.1（终审 R1 P2-R1-02）：该限制已写进 PROJECT_BOOK.md §3.17 与
  `docs/MODEL_CONTRACT.md` §2.1。关于“无法证明交错信息完整时是否应返回
  INCOMPLETE_TRACE”的评估：**当前产品不存在可返回 INCOMPLETE_TRACE 的
  分支**——因为没有任何代码路径只从 wire 快照恢复，丢段情形不可达；
  现有的 INCOMPLETE_TRACE 只来自流缺终止事件（`planner.ts` 的
  `classifyDualTrack`，`truncated` 分支）。没有为凑数而加未经测试的分支。
  要求：未来任何新增“只从 wire 快照恢复”的路径时，若无法证明交错信息
  完整，必须返回 INCOMPLETE_TRACE，不得静默丢段后声称一致。
- **L-T007-05**（F1）FAIL 分支模板潜伏缺陷：verdict 为 FAIL 但 failItems 为空时，
  报告模板 §3/§8.1 写错。S0 通过时未触发（failItems 非空或 verdict 为 PASS），
  属于未执行的分支缺陷。
- **L-T007-06**（F2）`src/core/reducer.ts:211` 注释误引 §3.2：注释文字错误，
  代码行为正确。只改注释即可。
- **L-T007-07**（F4）`RUN_FINISHED` 不匹配分支无 Golden 覆盖：仅探针验证，
  没有一条 Golden 覆盖该分支。
- **L-T007-08**（F5）合法重开时 Oracle 不重置 result，TS 重置 hasResult：
  同一 messageId 合法重新打开后，两侧对“结果是否保留”的处理不一致；
  24 条 Golden 未触发该分歧（G03/N08 均通过），属于未覆盖的语义差。
- **L-T007-09**（FIX-R2，Q8）显式 JSON null 基线与无基线在 null 处碰撞：
  sharedState 显式为 JSON null（`STATE_SNAPSHOT`/`RUN_STARTED` input.state
  明确给出 null）与“尚无基线”（sharedState undefined）在投影中都编码为
  null，parity 无法区分两者。TS 与 Oracle 在此处的编码一致（两侧都把
  undefined 编码为 null），故不是跨语言分歧，而是规格本身的表达力边界：
  一条显式 null 基线的轨迹与一条无基线的轨迹会得到相同的终态哈希。
  FIX-R2 只记录，不修（协调员裁决 5）：修它需要改 canonical 形式区分
  null 与缺键，属于规格语义修订，须另行立项。

## T009 — Web Worker 与双轨时间线

- **L-T009-01** 主包仍含重放引擎：in-process 回退 import 在运行时是死代码，
  建议后续用动态 import 隔离。产品行为不受影响（真实路径走 Worker），
  但包体积含一份不会执行的重放引擎。
- **L-T009-02** 全部 vitest 走 in-process 路径：真实 Worker 线程只在 T011
  浏览器 E2E 与 T012 真实 Worker 测试中覆盖；vitest 套件不经过真实 Worker。
- **L-T009-03** 重复折叠一次：同一状态在一次分析中被重复折叠一次，
  毫秒级开销，无正确性影响。

## T010 — JSON 报告与独立 HTML 导出

- **L-T010-01** `fullPath` / `resumePath` 为 null【v1.0.1 已修订入规格，不再是
  偏差；以下为历史记录】：项目书 v1.0.0 §13.2 写为必填 `PathResult` 对象；
  但当输入本身无效（格式错误、未知事件）或事件数超限时，T005 根本没有双轨
  终态（`fullState` / `resumeState` 为 null）。此时报告用 `null` 表示“无终态”，
  绝不伪造一条空路径（空路径会带一个与任何计算结果都不符的 `finalStateHash`）。
  JSON Schema 接受 `PathResult` 或 `null`；BFS 节点超限的
  `INCONCLUSIVE_LIMIT` 仍带已算出的双轨终态，路径照常为对象——null 与对象
  按实际计算结果取舍，不按裁决一刀切。终审 R1 P1-R1-03 接受该行为，规格
  v1.0.1 §13.2 已改为 `PathResult | null`（见 `00_control/ADR-001.md`；
  恢复折叠失败时仅 `resumePath` 为 null，见 `planner.ts:1278–1279`）。
  消费者不得把 null 误读为 CONSISTENT 的证据（回归见
  tests/report/fix-r1-null-paths.test.ts）。
- **L-T010-02** `shortestInjectionSequence` 的 `[]` 与 `null` 语义（v1.0.1，
  终审 R1 P2-R1-08）：§13.2 已改为 `string[] | null`。`[]` 表示 BFS 已证实
  目标在无注入时已达成（如 G08）；`null` 表示未计算（`INVALID_INPUT` /
  `INCONCLUSIVE_LIMIT` / BFS 未运行 / 界内无序列可达）。分析层来源是
  `src/replay/search.ts` 的 `analyzeFixture`（`sequence: string[] | null`）。
  JSON Schema 与 `validateReport` 已接受 null；两种情况的回归见
  tests/report/fix-r1-null-paths.test.ts。
  已落地（FIX-R1 收尾同步改动）：`src/report/schema.ts` 的 TS 类型已放宽为
  `string[] | null`，`src/report/json.ts` 的 `buildReport` 透传 null（不再把
  null 折叠为 `[]`），`src/report/html.ts` 已补 null 分支（null 时渲染“未计算”，
  `[]` 时只渲染“目标在无注入时已达成”）；null 已真正进入 JSON 报告，`[]` 与
  null 不再混同。
- **L-T010-03** `buildReportFromWorkerResult` 丢弃 `analysis.evaluation`：
  当前常量下 BFS 超限分支不可达（深度 ≤3、585 次评估 < 5,000 节点预算），
  故无实际影响；常量放宽后须重审。
- **L-T010-04** `export.test.tsx` 的 fakeReport 形状与真实 planner 不一致：
  不影响被测路径（导出按钮与下载行为），但测试替身不是真实报告形状。

## T011 — 浏览器 E2E 与交互回归

- **L-T011-01** G06 显式陈旧检查点在 UI 上不可达（产品设计边界，非 E2E 缺口）：
  UI 无法传显式检查点（`client.ts` 的 recovery 对象无 checkpoint 字段）。
  T011 用等价复现覆盖（双快照 + `STALE_SNAPSHOT`，走同一分支
  `planner.ts:979`）。G06 的 UI 路径缺失是界面设计边界，不是测试遗漏。
- **L-T011-02** 500px 视口仍走双列布局：断点 480px；500px 不在本次范围，
  未调整。

## T012 — 性能、确定性、安全与离线验证

- **L-T012-01** 性能数值各轮有冷启动波动：同一命令多次运行的最大值不同
  （例：40 事件 analyze，S0 门禁运行 41.5 ms，本次 T012 运行 68.94 ms；
  Worker 计算与往返同样逐轮波动）。所有值远低于 1,000 ms 门槛；引用性能数字时
  必须带运行时间戳、与当次日志原文逐值核对（`npm run verify:docs` 会重算），
  不得引用单次最好成绩，不得引用已被覆盖的早期运行数值，也不得引用
  施工者早期汇报数（T012 施工者汇报数引自已被覆盖的早期运行，已按最终磁盘日志更正；
  复核重跑数值只存在于复核报告中，不在磁盘日志里，同样不得引用）。
- **L-T012-02** `oracle/run_goldens` 打印 stale 文案：
  `parity with production TypeScript: PENDING T007 (no production implementation exists yet)`。
  S0 已证明 parity 24/24，该打印是 Oracle 脚本里的过期文案，未随 T007 更新。
  输出本身（`golden: 24/24 PASS`）正确。

## T013 — 文档、隐私说明与许可证

- **L-T013-01** [已修复] 裸 `npx vitest run` 曾退出 1：项目缺少
  `vitest.config.ts`，vitest 默认 include 把 Playwright 规格
  `tests/e2e/rejoinlab.spec.ts` 也收进来，在 vitest 里调用 Playwright 的
  `test.beforeEach()` 直接抛错——600 个测试全过也 exit 1。
  发现：主聊天 2026-11-23 ~18:15 GMT 亲自复核时发现（协调员未发现）。
  修复：并行修复任务新增 `vitest.config.ts`（`exclude: [...configDefaults.exclude, "tests/e2e/**"]`），
  2026-11-23 18:18 落盘；主聊天 ~18:21 GMT 验证通过；T013 亲自重跑确认：
  `npx vitest run` exit 0，32 个文件、600/600 通过。E2E 仍用 `npm run test:e2e`（Playwright，12/12）。
- **L-T013-02** `fixtures/examples/` 缺失：计划 §4.1 所列的手写示例
  （`normal.jsonl`、`duplicate-tool-call.jsonl`、`snapshot-reorder.jsonl`、
  `message-reopen.jsonl`）不存在于磁盘，T002–T012 均未交付。
  用户指南改用内联示例（`docs/USER_GUIDE.md` §2.1/§2.2，与 G01 轨迹一致）；
  Golden 语料在 `fixtures/golden/`（`rejoinlab.golden/v1` JSON，测试用）。
- **L-T013-03** 验证脚本可能留下 `vite preview` 进程：T012 验证运行时
  `vite preview --port 4173` 未退出，主聊天 2026-11-23 ~18:15 GMT 发现
  PID 7714 仍占 4173 端口并手动杀掉。`verify_offline` / `verify_privacy`
  脚本的进程清理未验证；跑完验证后请自行检查端口。

## 规格 MINOR（VERIFY_LOG §3，施工时已接受）

- **L-SPEC-01**（D-01）T008–T014 输出文件清单在转录时被截断 8 处：
  施工以计划 §4.1/§4.2 文件归属为准，未向 GPT 追问。
- **L-SPEC-02**（D-02）三套字段集约定并存于各任务卡，标题措辞有两处差异。
- **L-SPEC-03**（D-03）T007 卡片无完成定义 / 失败回退字段。
- **L-SPEC-04**（D-04）计划无 §7+ 收尾章节：已接受，项目书 §0/§18 覆盖冻结信息。
- **L-SPEC-05**（D-05）合并接缝：T007 完整表 + T008–T014 卡片来自补充消息。
- **L-SPEC-06**（D-06）计划无 AG-UI 1.0 发布日期锚点（2026-09-18 仅项目书 §2.1 有）。
