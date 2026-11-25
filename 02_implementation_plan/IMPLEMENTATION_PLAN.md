# 文件二：IMPLEMENTATION_PLAN.md
---
project_id: P031
slug: rejoinlab
name: RejoinLab（续流证）
document: IMPLEMENTATION_PLAN
spec_version: 1.0.2
status: READY_FOR_S0_IMPLEMENTATION
license: MIT
total_effort_hours: 88
implementation_hours: 72
buffer_hours: 16
tasks: T001-T014
---
# P031 RejoinLab（续流证）实施计划
副标题：AG-UI 事件流续接、重放与状态一致性验证系统
## 0. 计划目的与执行边界
### 0.1 计划目的
本计划将 PROJECT_BOOK.md 中冻结的 RejoinLab 规格转化为可以直接派发给 Coding Agent 的原子任务。目标是在 72 小时有效施工预算和 16 小时缓冲内完成：AG-UI 1.0 事件解析；确定性参考 Reducer；双轨状态比较；快照与恢复；故障注入；最短分歧定位；Python 独立 Oracle；24 条 Golden 轨迹；React 可视化界面；Web Worker；JSON 与独立 HTML 报告；自动化测试；发布和审查资产。
### 0.2 角色职责
Sam 项目决策者、方向和范围批准者（不需要参与日常编码）；GPT-6 产品规格、架构、算法审查、最终独立终审（不直接替代施工 Agent 编码）；Muse 项目 Owner 代理、任务调度、依赖管理、运行门禁、归档（不编写业务代码）；Coding Agent 编码、修复、测试脚本、构建和文档生成（不擅自修改冻结契约）；Independent Oracle Agent 使用 Python 独立实现参考算法（不读取生产实现结果作为真值）；Independent Reviewer 审查代码、测试和证据（不使用构建者自评代替独立审查）；Integration Agent 集成、合并、构建和发布（不绕过任务验收直接覆盖冻结版本）。
### 0.3 会话纪律
每一个编码、修复、代码审查和集成任务：1. 必须使用新会话；2. 必须附带完整 TASK_ID；3. 必须传入任务输入、代码版本和接口契约；4. 不依赖旧聊天的隐式记忆；5. 不允许施工 Agent 自己宣布最终验收通过；6. 必须输出可核验文件和真实命令日志；7. 先验收，再合并；8. 构建者和审查者尽可能使用不同模型及独立会话。Muse 负责调度自己已经实测可用的免费模型平台，不要求新增付费账号或购买 API。
## 1. 冻结约束
### 1.1 产品范围
严格遵循 PROJECT_BOOK.md v1.0.2：AG-UI 1.0；15 种 MVP 事件；JSONL / SSE 本地导入；独立参考 Reducer；双轨状态比较；断线、重连、重放、快照恢复；重复、丢失、乱序故障注入；确定性 BFS；最短分歧定位；Python 独立 Oracle；24 条 Golden；React 时间线；JSON 和独立 HTML 导出。不得扩大成：实时 Agent 运行服务；云端日志平台；通用 Event Sourcing 平台；通用分布式系统模型检查器；AG-UI SDK 的 fork；网络代理；LLM 评估器；生产系统 exactly-once 验证器。
### 1.2 技术栈
Node.js 24 LTS 或 T001 实测兼容版本；TypeScript 5.x；React 19.x；Vite 7.x；Worker Web Worker；Unit test Vitest；E2E Playwright；Oracle Python 3.12+；JSON 原生 JSON + 固定规范化实现；Hash SHA-256；HTML 原生静态资源；UI 中文优先、桌面优先；Runtime 本地离线、CPU-only。所有 patch 版本由 T001 根据真实虚拟机环境冻结到 lockfile。
### 1.3 运行约束
不使用收费 API；不调用 LLM；不要求 GPU；不要求 Docker；不要求数据库；不请求网络；不发送遥测；不读取用户系统中的真实 Agent 会话；测试全部使用合成轨迹；用户导入数据只留在当前浏览器内存。
## 2. 任务总览与工时预算
### 2.1 工时分配
总预算：88 小时。阶段 S0 T001–T007 52h；S1 T008–T014 20h；缓冲 修复、环境问题和集成余量 16h；总计 14 个任务 88h。实际任务预算 72h，不允许把 16h 缓冲预先分配给普通功能扩张。
### 2.2 任务总表
T001 环境盘点与协议契约冻结 5h S0；T002 JSONL/SSE 导入与事件标准化 7h S0；T003 确定性参考 Reducer 9h S0；T004 canon、状态比较与差异定位 8h S0；T005 断线恢复、故障注入与 BFS 7h S0；T006 Python 独立 Oracle 与 Golden 9h S0；T007 S0 硬门禁与独立核验 7h S0；T008 React 主界面与导入交互 4h S1；T009 Web Worker 与双轨时间线 4h S1；T010 JSON/HTML 报告和导出 3h S1；T011 浏览器 E2E 与交互回归 2h S1；T012 隐私、安全、性能与离线测试 3h S1；T013 README、指南、许可证和示例 2h S1；T014 集成、冻结、审查包与发布 2h S1；任务预算 72h；缓冲 16h；总计 88h。
## 3. 阶段门槛与依赖图
### 3.1 总体依赖关系
T001→T002；T001→T006；T002→T003；T003→T004；T003→T005；T004→T005；T003→T006；T004→T006；T005→T007；T006→T007；T007 PASS→T008，FAIL→停止 S1，返回修复；T008→T009；T004→T010；T009→T010；T010→T011；T011→T012；T012→T013；T013→T014。箭头表示前置任务完成并通过验收后，才允许下游任务集成。
### 3.2 S0：算法可行性硬门
S0 包括 T001–T007。必须证明：事件解析准确；AG-UI 1.0 生命周期规则实现正确；Reducer 确定性；消息和工具调用状态可以规范化；双轨差异可以定位；故障注入可复现；Python Oracle 独立；24 条 Golden 正确分类；最大 40 条事件的轨迹在 1 秒内完成；合法恢复路径 100% 收敛。T007 未通过，不得开始 T008。
### 3.3 S1：完整 MVP
S0 PASS 后进入 S1。目标：可交互的 React 界面；双轨时间线；Worker 运行；状态差异展示；JSON/HTML 导出；E2E；离线与隐私检查；发布包。
## 4. 工作区布局与文件归属
### 4.1 工作区根目录
P031-rejoinlab/：README.md、LICENSE、THIRD_PARTY_NOTICES.md、SECURITY.md、package.json、package-lock.json、tsconfig.json、vite.config.ts、vitest.config.ts、playwright.config.ts；docs/ PROJECT_BOOK.md、IMPLEMENTATION_PLAN.md、AGUI_SCOPE.md、EVENT_SCHEMA.md、ALGORITHM.md、LIMITATIONS.md、USER_GUIDE.md；src/ protocol/（types.ts、validate.ts、constants.ts）、parser/（jsonl.ts、sse.ts、normalize.ts）、core/（state.ts、reducer.ts、snapshot.ts、canonical.ts、diff.ts、lifecycle.ts）、replay/（inject.ts、planner.ts、search.ts、align.ts）、diagnostics/（catalog.ts）、report/（schema.ts、json.ts、html.ts）、worker/（protocol.ts、rejoin.worker.ts）、ui/（App.tsx、ImportPanel.tsx、ScenarioPanel.tsx、Timeline.tsx、StateDiff.tsx、Diagnostics.tsx、ExportPanel.tsx、styles.css）、main.tsx；oracle/（reference.py、canonical.py、replay.py、golden_expected.json、tests/）；fixtures/golden/（G01.json–G08.json、N01-N16.json）、fixtures/examples/（normal.jsonl、duplicate-tool-call.jsonl、snapshot-reorder.jsonl、message-reopen.jsonl）；tests/（protocol/、parser/、core/、replay/、report/、oracle/、e2e/）；scripts/（verify_s0.ts、verify_oracle.ts、verify_determinism.ts、verify_performance.ts、verify_release.ts）；review/（REVIEW_INDEX.md、REVIEW_PACK_01.md、REVIEW_PACK_02.md、findings/）；artifacts/（logs/、reports/、screenshots/、manifests/、release/）。
### 4.2 文件归属原则
T002 负责 parser/。T003 负责 core/state.ts、core/reducer.ts、core/snapshot.ts。T004 负责 core/canonical.ts、core/diff.ts。T005 负责 replay/。T006 负责 oracle/ 和 Golden 文件。T008 负责 ui/。T009 负责 worker/ 和 Timeline.tsx。T010 负责 report/ 和 ExportPanel.tsx。T011 负责 E2E。T012 负责安全与性能脚本。T013 负责文档。T014 负责集成和冻结。同一时段不得由两个 Agent 修改同一个源文件。需要并行施工时，使用不同 Git worktree 或独立工作目录。
## 5. 接口契约
### 5.1 NormalizedEvent
interface NormalizedEvent { sourceIndex: number; sourceEventKey: string | null; transportEventId: string | null; event: AGUIEvent; } 要求：sourceIndex 必须唯一；不使用 timestamp 排序；transportEventId 不自动提升为 AG-UI eventId；未知字段不得静默丢弃；不支持的事件必须保留位置和诊断。
### 5.2 AnalyzeInput
interface AnalyzeInput { schema: "rejoinlab.input/v1"; scenarioId: string; protocolVersion: "1.0"; events: NormalizedEvent[]; recovery: { strategy: "FULL_REPLAY_FROM_START" | "RESUME_FROM_CHECKPOINT" | "REPLAY_AFTER_SOURCE_CURSOR"; disconnectAfter?: number; resumeAfterSourceIndex?: number; }; injections: Injection[]; }
### 5.3 RejoinState
由 T003 冻结：interface RejoinState { threadId: string | null; runs: RunState[]; messages: MessageState[]; toolCalls: ToolCallState[]; sharedState: unknown; orderedTimeline: TimelineItem[]; pendingToolCallIds: string[]; runStatus: RunStatus; }
### 5.4 Reducer 接口
function reduceEvent(state: RejoinState, event: AGUIEvent): RejoinState; 必须满足：无外部状态；无随机数；无时间读取；无网络；不修改输入对象；相同输入产生相同输出。
### 5.5 Report 接口
function buildReport(input: AnalyzeInput, fullState: RejoinState, resumeState: RejoinState, diagnostics: Diagnostic[]): RejoinReport; 必须遵循 rejoinlab.report/v1。
## 6. 任务卡：T001–T014
每张任务卡均包含：TASK_ID；目标；输入；输出；禁止修改；验收命令；预期证据；完成定义；失败回退。
T001：环境盘点与协议契约冻结，预算 5 小时。目标：建立可复现的开发环境，并冻结 AG-UI 1.0 事件字段及生命周期规则。输入：PROJECT_BOOK.md v1.0.2；AG-UI 1.0 官方规范；AG-UI 1.0 JSON Schema；虚拟机环境。输出：docs/AGUI_SCOPE.md、docs/EVENT_SCHEMA.md、artifacts/logs/T001_ENVIRONMENT.md、package.json、package-lock.json、tsconfig.json。工作内容：记录 OS、CPU、RAM、Node、npm、Python、浏览器版本；检查 Node.js 24 可用性；初始化 TypeScript、React、Vite；冻结 AG-UI 1.0 Schema；确认 15 个 MVP 事件；明确不支持事件清单；确认 eventId / SSE id / sourceIndex 边界；记录 AG-UI 1.0 HTTP+SSE 无恢复机制的事实；冻结类型定义；生成环境快照。禁止修改：核心 Reducer；Golden expected；S0 门槛。验收：node --version、npm --version、python --version、npm run typecheck。预期证据：完整版本记录；Schema 来源 URL；事件清单；依赖锁文件；typecheck 日志。完成定义：环境可用，协议字段和版本边界无歧义，后续任务可以只依赖冻结文件施工。失败回退：Node 或浏览器版本不兼容时，先调整工具链并记录 ADR，不允许改变协议版本。
T002：JSONL/SSE 导入与事件标准化，预算 7 小时。目标：实现纯本地事件导入和统一 NormalizedEvent。输入：T001 冻结的类型；AG-UI 1.0 JSON Schema；合成 JSONL 和 SSE 文件。输出：src/parser/jsonl.ts、src/parser/sse.ts、src/parser/normalize.ts、tests/parser/。工作内容：JSONL 逐行解析；SSE UTF-8 解析；正确处理 LF、CRLF、CR；处理多行 data 字段；保留 SSE id 作为 transportEventId；不将 SSE id 认定为 AG-UI eventId；生成稳定 sourceIndex；检查 JSON 格式；检查事件 type；校验必填字段；对未知事件返回明确诊断；限制输入大小和单事件大小。禁止修改：core/reducer.ts、core/canonical.ts、replay/、oracle/。验收：npm run test:parser、npm run typecheck。预期证据：JSONL fixtures；SSE fixtures；解析测试日志；sourceIndex 对照表；错误输入报告。完成定义：同一文件重复导入得到相同的 NormalizedEvent 序列。失败回退：解析不完整时不允许进入 Reducer；保留原始输入和准确行号。
T003：确定性参考 Reducer，预算 9 小时。目标：实现 AG-UI 1.0 子集的确定性状态归约。输入：T001 协议契约；T002 NormalizedEvent。输出：src/core/state.ts、src/core/reducer.ts、src/core/snapshot.ts、src/core/lifecycle.ts、tests/core/。工作内容：实现初始状态；RUN_STARTED；RUN_FINISHED；RUN_ERROR；TEXT_MESSAGE_START / CONTENT / END；TEXT_MESSAGE_CHUNK 展开；TOOL_CALL_START / ARGS / END；TOOL_CALL_CHUNK 展开；TOOL_CALL_RESULT；STATE_SNAPSHOT；STATE_DELTA；MESSAGES_SNAPSHOT 协调；维护 orderedTimeline；维护 pendingToolCallIds；区分协议错误和合法恢复状态。禁止：读取系统时间；使用随机 ID；根据 timestamp 排序；自动删除疑似重复事件；修改协议字段定义；使用 Python Oracle 结果。禁止修改：parser/、core/canonical.ts、replay/、oracle/、ui/。验收：npm run test:core、npm run typecheck。预期证据：每个事件类型至少一个控制测试；消息生命周期日志；工具调用生命周期日志；状态快照和 Patch 测试；多 run 控制测试。完成定义：所有冻结事件可以确定性归约，非法生命周期不会被静默接受。失败回退：发现协议解释冲突时，回到 AG-UI 1.0 原文和 Schema，提交 ADR，不得用实现方便性改变规范。
T004：canon、状态比较与首个分歧定位，预算 8 小时。目标：实现规范化状态和确定性差异。输入：T003 RejoinState；RFC 8785 JCS；项目书 §5。输出：src/core/canonical.ts、src/core/diff.ts、tests/core/canonical/、tests/core/diff/。工作内容：实现规范化 JSON；保留数组顺序；排序对象键；排除本地运行元数据；保留业务 ID 和 timeline；计算 SHA-256；比较 fullPath 和 resumePath；计算 JSON Pointer 差异；定位第一个差异；输出差异路径、expected 和 actual。禁止修改：Reducer；Parser；Replay 注入逻辑；Oracle。验收：npm run test:canonical、npm run test:diff、npm run test:determinism。预期证据：规范化样本；100 次重复哈希日志；JSON Pointer 差异样本；首个分歧定位日志。完成定义：相同状态始终得到相同哈希；不同状态能够定位到具体字段。失败回退：Python 和 TypeScript 的规范化出现差异时，暂停 T005，先解决 canonicalization 问题。
T005：断线恢复、故障注入与 BFS，预算 7 小时。目标：实现确定性双轨恢复和最短故障注入序列。输入：T003 Reducer；T004 Canonical Diff；T002 NormalizedEvent。输出：src/replay/inject.ts、src/replay/planner.ts、src/replay/search.ts、src/replay/align.ts、tests/replay/。工作内容：实现 DISCONNECT_AFTER；FULL_REPLAY_FROM_START；RESUME_FROM_CHECKPOINT；REPLAY_AFTER_SOURCE_CURSOR；DUPLICATE_EVENT；DROP_EVENT；SWAP_ADJACENT；STALE_SNAPSHOT；REPLAY_PREFIX；MESSAGE_ID_REMAP；CURSOR_SKIP；TRUNCATE_STREAM；BFS；固定字典序；最短注入序列；首个状态分歧。禁止：使用真实网络；使用真实 Agent；修改 AG-UI 官方事件对象来偷偷加入 eventId；超出 40 条事件限制；搜索超限后返回 CONSISTENT。验收：npm run test:replay、npm run test:determinism。预期证据：8 种注入算子测试；最短路径对照；100 次相同输入哈希；最大事件数测试；超限测试。完成定义：已知合成故障能够通过固定注入规则重复生成，并能得到相同最短故障序列。失败回退：搜索性能不满足门槛时，先缩小注入深度和节点数；必须保留 INCONCLUSIVE_LIMIT，不允许减少 Golden。
T006：Python 独立 Oracle 与 24 条 Golden，预算 9 小时。目标：建立独立 Python 参考实现和手工推导的 Golden expected。输入：T001 协议契约；T002 事件输入；PROJECT_BOOK §9。输出：oracle/reference.py、oracle/canonical.py、oracle/replay.py、oracle/golden_expected.json、oracle/tests/、fixtures/golden/。工作内容：Python 独立实现事件归约；Python 独立实现状态规范化；Python 独立实现状态比较；Python 独立实现故障注入；Python 独立实现诊断分类；手工建立 8 条故障轨迹；手工建立 16 条正常轨迹；手工推导预期结果；输出 Oracle 报告；与生产实现进行字段级比较。必须验证：#1524 类重复工具调用；#3119 类消息快照顺序问题；#3368 类文本和工具交错；丢失事件；乱序事件；陈旧快照；疑似重复；截断流。禁止：import 生产 TypeScript；复制生产 Reducer；从生产输出生成 Golden expected；通过修改 expected 消除差异。验收：python -m pytest -q oracle/tests、npm run test:oracle。预期证据：24 份输入；24 份手工 expected；Python 运行日志；字段级 parity 日志；Oracle 自身测试日志。完成定义：Oracle 独立运行，生产实现与 Oracle 的预期接口已经冻结。失败回退：如果 Oracle 与生产实现不一致，保留双方原始输出，由独立 Reviewer 判断是生产错误、Oracle 错误还是规格歧义。
T007：S0 硬门禁与独立核验，预算 7 小时，S0 唯一放行门。目标：对 T003–T006 进行完整硬门验收。输入：24 条 Golden；TypeScript 生产实现；Python Oracle；冻结接口。输出：artifacts/reports/S0_GATE.json、artifacts/reports/S0_REPORT.md、artifacts/logs/T007_PRODUCTION.log、artifacts/logs/T007_ORACLE.log、artifacts/logs/T007_PARITY.log、artifacts/manifests/S0_SHA256SUMS.txt。验收命令：npm ci、npm run typecheck、npm run test:core、npm run test:canonical、npm run test:replay、npm run test:oracle、npm run verify:s0、npm run test:determinism、npm run test:performance；Python：python -m pytest -q oracle/tests。

T007 硬门验收矩阵（指标 | 验收阈值 | 备注/来源）：
Golden 正确分类 | 24/24 | 8 条已知故障 + 16 条正常轨迹
已知故障检出 | 8/8 | G01–G08 全部检出
正常轨迹正确通过 | 16/16 | N01–N16 全部正确
False Positive | 0 | 正常轨迹不得误报
False Negative | 0 | 已知故障不得漏报
Oracle parity | 24/24 | 与 Python Oracle 字段级一致
合法恢复收敛率 | 100% | 所有合法恢复路径均收敛
确定性重复执行 | 100/100 | 相同输入的报告哈希唯一
最大事件轨迹 | 40 条事件 | 含快照与断线标记
单轨迹性能 | 小于 1,000 ms | 每条被测轨迹必须低于 1 秒
搜索节点上限 | ≤ 5,000 | 超限必须返回 INCONCLUSIVE_LIMIT
离线运行外部请求 | 0 | 不得联网
真人参与 | 0 | 全部合成数据

T007 最终裁决：
S0 = PASS 必须满足上述全部门槛，并经独立 Reviewer 检查原始输入、生产输出、Oracle 输出和实际运行日志。
S0 = FAIL 任意一项门槛未通过即为 FAIL，T008–T014 不得启动。不得删除失败 Golden、修改预期值或放宽阈值来取得通过。

一、IMPLEMENTATION_PLAN.md 第 6 节补充：T008–T014 详细任务卡

T008：React 主界面与导入交互，预算：4 小时，S1
任务目标：完成 RejoinLab 可实际运行的中文 React 主界面，实现本地事件文件导入、实验参数设置、状态展示和用户操作。界面必须使用 T001–T007 已冻结的协议及算法接口，不得在 UI 中重新实现 Reducer。
输入：PROJECT_BOOK.md v1.0.2；T007 的 S0 PASS 证据；T002 的 NormalizedEvent 接口；T003 的 RejoinState；T004 的差异报告接口；T005 的 RecoveryPlan；T001 冻结的 React、TypeScript、Vite 版本。
输出文件：src/ui/App.tsx、src/ui/ImportPanel.tsx、src/ui/ScenarioPanel.tsx、src/ui/StateDiff.tsx、src/ui/Diagnostics.tsx、src/ui/analyze.ts、src/ui/styles.css、tests/ui/（App.test.tsx、analyze.test.ts、components.test.tsx、security.test.ts）
实施内容：1. 实现主页面布局和导航。2. 实现 JSONL / SSE 文件导入入口。3. 实现拖放导入。4. 显示协议版本和事件数量。5. 显示事件解析错误及 sourceIndex。6. 实现断线位置选择。7. 实现恢复策略选择。8. 实现故障注入参数选择。9. 展示完整路径和恢复路径的状态摘要。10. 展示诊断代码及严重程度。11. 实现开始、暂停、重置和清空。12. 提供运行状态和错误提示。
验收标准：JSONL 导入 UI 通过；SSE 导入 UI 通过；文件拖放 通过；事件数量展示 正确；断线位置选择 通过；三种恢复策略选择 通过；故障注入配置 8 种可选；五种裁决状态展示 5/5；诊断级别展示 CRITICAL / WARNING 均正确；清空操作 100% 清除界面数据；组件测试 全部通过；TypeScript 类型检查 0 错误；构建 退出码 0。另外：390px 窄屏不得出现无法阅读的主界面；用户输入不得通过 innerHTML 注入；不得写入 localStorage 或 IndexedDB。
验收命令：npm run typecheck；npm run test:ui；npm run build
依赖任务：T007 PASS。
完成定义：用户能够在真实浏览器中导入事件文件、配置恢复实验、查看状态及诊断，并清空当前数据。
失败回退：如果 UI 与核心接口不一致，优先修复 UI 适配层，不得擅自修改 Reducer 或协议契约。

T009：Web Worker 与双轨时间线，预算：4 小时，S1
任务目标：将重放、状态比较和故障搜索放入 Web Worker，完成完整事件流与恢复事件流的双轨时间线可视化。
输入：T005 Replay Engine；T004 Canonical Diff；T008 React 主界面；PROJECT_BOOK.md §5、§8、§12。
输出文件：src/worker/protocol.ts、src/worker/rejoin.worker.ts、src/worker/client.ts、src/ui/Timeline.tsx、src/ui/TimelineEvent.tsx、src/ui/timeline.css、tests/worker/（client.test.ts、host.test.ts、parity.test.ts、protocol.test.ts）、tests/timeline/（AppTimeline.test.tsx、Timeline.test.tsx）
实施内容：1. 定义 Worker 请求和响应协议。2. 实现唯一 jobId。3. 实现 ANALYZE 消息。4. 实现 RESULT 和 ERROR 消息。5. 实现 CANCEL 消息。6. 实现计算取消。7. 防止旧任务结果覆盖新任务。8. 实现完整事件流时间线。9. 实现恢复事件流时间线。10. 显示断线点、恢复点和快照位置。11. 显示重复、丢失和乱序事件。12. 显示首个分歧位置。13. 支持点击事件查看原始 JSON。14. 支持逐事件回放。
验收标准：Worker 请求协议 100% 符合接口；Worker 响应 jobId 100% 正确；正常计算结果传递 正确；错误结果传递 正确；任务取消 可实际取消；旧任务结果覆盖新任务 0 次；完整路径时间线 1 条完整轨道；恢复路径时间线 1 条完整轨道；源事件定位 100% 可定位；首个分歧点显示 与核心结果一致；逐步回放 正常；Worker 测试 全部通过。每条轨迹的事件展示必须保留 sourceIndex 顺序，不得为了视觉布局改变事件的实际顺序。
验收命令：npm run test:worker；npm run test:timeline；npm run typecheck；npm run build
依赖任务：T004、T005、T008。
完成定义：最大规格内的计算在 Worker 中执行，主线程能够响应用户操作，双轨时间线与实际分析报告一致。
失败回退：若 Worker 取消机制不可靠，停止 UI 集成，单独修复 Worker 协议；不得退回主线程同步计算后宣称通过。

T010：JSON 报告与独立 HTML 导出，预算：3 小时，S1
任务目标：实现正式的 rejoinlab.report/v1 JSON 报告，以及完全自包含的 HTML 报告导出。
输入：T004 Canonical Diff；T005 Replay Result；T009 Worker 输出；PROJECT_BOOK.md §13。
输出文件：src/report/schema.ts、src/report/json.ts、src/report/html.ts、src/ui/ExportPanel.tsx、tests/report/（export.test.tsx、html.test.ts、json.test.ts、schema.test.ts）
实施内容：1. 冻结 JSON Schema。2. 实现报告对象组装。3. 保存输入文件 SHA-256。4. 保存协议版本和规格版本。5. 保存双轨状态及哈希。6. 保存诊断代码。7. 保存首个分歧位置。8. 保存 JSON Pointer 差异。9. 保存最短故障注入序列。10. 保存性能和搜索节点统计。11. 实现 JSON 下载。12. 实现独立 HTML 下载。13. 对所有用户文本进行 HTML 转义。14. 为报告附上能力边界和假设说明。
验收标准：Schema 标识 rejoinlab.report/v1；JSON Schema 校验 100% 通过；五种 verdict 5/5 正确；CRITICAL / WARNING 正确区分；双轨状态哈希 与计算结果一致；输入 SHA-256 与原始输入字节一致；首个分歧字段 与 T004 一致；最短注入序列 与 T005 一致；JSON 下载 成功；HTML 下载 成功；HTML 自包含 100% 资源内嵌；远程资源 0；HTML 注入测试 全部通过。HTML 报告必须在断开网络的情况下独立打开，不能依赖开发服务器、CDN 或远程字体。
验收命令：npm run test:report；npm run test:export；npm run typecheck；npm run build
依赖任务：T004、T009。
完成定义：任意一个有效分析结果都可以导出符合 JSON Schema 的报告及独立 HTML 文件。
失败回退：如果报告字段与 PROJECT_BOOK.md 不一致，必须以冻结规格为准修复，不允许通过放宽 Schema 隐藏缺失字段。

T011：浏览器 E2E 与交互回归，预算：2 小时，S1
任务目标：通过真实 Chromium 浏览器验证 RejoinLab 的核心用户流程，证明 UI、Worker、分析内核和导出功能已经集成。
输入：T008 UI；T009 Worker 和时间线；T010 报告及导出；T007 Golden 样本。
输出文件：tests/e2e/rejoinlab.spec.ts、tests/e2e/fixtures/（g01.jsonl、normal.jsonl、normal.sse、two-snapshot.jsonl）、playwright.config.ts、artifacts/logs/T011_E2E.log、artifacts/screenshots/（T011_HOME.png、T011_NORMAL_RUN.png、T011_FAULT_DUPLICATE.png、T011_FAULT_REORDER.png、T011_FAULT_SNAPSHOT.png、T011_EXPORT.png、T011_CANCEL.png、T011_JSONL_IMPORT.png、T011_NARROW.png、T011_SSE_IMPORT.png）
实施内容：至少覆盖以下 12 条交互路径：1. 首页正常加载。2. JSONL 文件导入。3. SSE 文件导入。4. 正常轨迹运行。5. 重复工具调用诊断。6. 消息重排诊断。7. 状态快照不一致诊断。8. 断线位置修改。9. 故障注入修改。10. 分析取消和重新运行。11. JSON 与 HTML 下载。12. 清空内存及窄屏检查。
验收标准：E2E 流程 至少 12 条；E2E 通过率 100%；首页加载 PASS；JSONL 导入 PASS；SSE 导入 PASS；正常轨迹 PASS；故障轨迹 PASS；Worker 取消 PASS；JSON 下载 PASS；HTML 下载 PASS；清空操作 PASS；浏览器未处理异常 0；核心流程截图 至少 5 张。
验收命令：npm run test:e2e
依赖任务：T008、T009、T010。
完成定义：12 条核心交互流程在真实 Chromium 中全部通过，并保存可复核的运行日志和截图。
失败回退：如果 E2E 失败，先区分 UI 缺陷、Worker 竞态和算法缺陷，再派发独立修复任务。不得只修改测试断言使其通过。

T012：性能、确定性、安全与离线验证，预算：3 小时，S1
任务目标：对完整产品进行性能、重复执行一致性、隐私、安全和离线运行检查。
输入：T007 S0 证据；T009 Worker；T010 HTML 报告；T011 E2E 结果；PROJECT_BOOK.md §8、§15、§16、§18。
输出文件：scripts/verify_determinism.ts、scripts/verify_performance.ts、scripts/verify_offline.ts、scripts/verify_privacy.ts、scripts/verify_security.ts
实施内容：A. 性能验证：构造最大 40 条事件的轨迹；执行完整路径和恢复路径分析；测量 Worker 计算时间；记录访问状态节点数量；记录每次实际运行耗时；检查 5,000 节点上限；检查 1 秒停止门槛。B. 确定性验证：使用相同输入连续运行 100 次；比较规范化报告 SHA-256；检查最短故障序列；检查首个分歧位置；检查诊断代码顺序。C. 隐私验证：检查 localStorage；检查 IndexedDB；检查用户输入是否被持久化；检查清空操作是否清除原始事件和衍生状态；检查导出操作是否由用户主动触发。D. 安全验证：HTML 注入；JSON 超大输入；深层嵌套；非法 JSON Patch；超过事件上限；Worker 取消；未知事件；报告文本转义。E. 离线验证：阻断外部网络请求；加载本地应用；导入样本；运行分析；导出报告；独立打开 HTML。
验收标准：相同输入重复执行 100 次；报告 SHA-256 100 次完全相同；最短故障序列 100 次完全相同；首个分歧位置 100 次完全相同；最大事件轨迹 40 条；单轨迹耗时 每次小于 1 秒；搜索节点 不超过 5,000；超限处理 100% 返回 INCONCLUSIVE_LIMIT；外部网络请求 0；localStorage 写入 0；IndexedDB 写入 0；清空后原始数据残留 0；HTML 远程资源 0；安全回归 全部通过。
验收命令：npm run test:determinism；npm run test:performance；npm run test:offline；npm run test:privacy；npm run test:security
依赖任务：T009、T010、T011。
完成定义：所有性能、确定性、隐私、安全及离线门槛均通过，所有实际测量值和环境信息写入日志。
失败回退：性能失败：优先优化状态规范化和搜索，不得删减 Golden。确定性失败：定位随机依赖、遍历顺序或时间依赖。隐私失败：立即阻断发布。安全失败：修复后重新执行相关测试。离线失败：删除运行时网络依赖。

T013：文档、隐私说明与许可证，预算：2 小时，S1
任务目标：完成用户可以独立理解、安装和使用的文档，核对 MIT 许可证及全部第三方依赖许可。
输入：PROJECT_BOOK.md v1.0.2；IMPLEMENTATION_PLAN.md v1.0.2；T008–T012 实际实现；T012 隐私、安全和离线日志；package-lock.json。
输出文件：README.md、LICENSE、THIRD_PARTY_NOTICES.md、SECURITY.md、docs/USER_GUIDE.md、docs/LIMITATIONS.md、docs/AGUI_SCOPE.md、docs/ALGORITHM.md、docs/EVENT_SCHEMA.md、docs/MODEL_CONTRACT.md（其中 AGUI_SCOPE.md 与 EVENT_SCHEMA.md 为 T001 冻结文件，由 T013 复核后归档；ALGORITHM.md 与 MODEL_CONTRACT.md 为 T013 产出）
实施内容：1. 撰写项目 README。2. 添加产品价值说明和演示截图。3. 添加安装及启动命令。4. 编写 JSONL/SSE 导入指南。5. 编写断线和恢复实验说明。6. 说明五种裁决结果。7. 说明全部诊断代码。8. 解释核心算法和双轨比较。9. 说明 AG-UI 1.0 支持边界。10. 说明 SSE 与恢复游标的区别。11. 明确 exactly-once 不在保证范围内。12. 撰写隐私及数据删除说明。13. 核对所有第三方依赖许可证。14. 生成 MIT LICENSE。15. 生成第三方许可证清单。README 标题必须为：RejoinLab — Your AI agent reconnected. Did your conversation survive correctly?
验收标准：README 存在且完整；快速开始 命令可核对；用户指南 存在；算法说明 存在；协议范围说明 存在；隐私说明 存在；诚实边界 完整；MIT LICENSE 存在；依赖许可证清单 100% 覆盖；未核实许可证 0 项未登记；远程 API 承诺 不得出现；未实测性能数据 不得伪装成成绩。
验收命令：npm run verify:docs；npm run verify:licenses
依赖任务：T010、T011、T012。
完成定义：用户不需要阅读施工聊天即可理解产品用途、运行方式、数据边界及其不能证明的内容。
失败回退：若某个依赖许可证不明确，先调查或替换依赖，不得默认标记为 MIT。

T014：冻结打包与发布准备，预算：2 小时，S1
任务目标：完成最终源码冻结、构建产物打包、哈希核对和独立审查材料准备。T014 是施工阶段的发布准备任务，不是 GPT 最终终审，也不能自行宣布产品 ACCEPTED。
输入：T001–T013 全部交付；完整测试日志；Python Oracle 结果；Golden 验收结果；Git 仓库；项目书与实施计划。
输出文件：artifacts/release/source.zip、artifacts/release/dist.zip、artifacts/release/RELEASE_MANIFEST.json、artifacts/release/SOURCE_MANIFEST.csv、artifacts/release/SHA256SUMS.txt、artifacts/release/GitBundle.bundle、artifacts/review/REVIEW_INDEX.md、artifacts/review/REVIEW_PACK_01.md、artifacts/review/REVIEW_PACK_02.md（注：原占位行写的 artifacts/manifests/RELEASE_MANIFEST.json 路径有误，实际位置为 artifacts/release/；artifacts/manifests/ 下仅有 S0_SHA256SUMS.txt）。
实施内容：1. 确认所有任务均已交接。2. 确认没有未提交代码。3. 确认没有未记录的本地修改。4. 冻结 Git commit。5. 生成 Git bundle。6. 从冻结 commit 生成 source ZIP。7. 从构建产物生成 dist ZIP。8. 生成 SOURCE_MANIFEST。9. 计算所有发布文件 SHA-256。10. 生成 RELEASE_MANIFEST。11. 验证源码 ZIP 与冻结 Git commit 的文件一致性。12. 验证构建产物可以独立运行。13. 建立 REVIEW_INDEX。14. 生成分批 REVIEW_PACK。15. 由独立会话进行发布审查。16. 归档至 Google Drive 的 P031 项目目录。
验收标准：Git 冻结 commit 存在；Git 工作树 干净；Git bundle 可独立检出；source.zip 存在且可解压；dist.zip 存在且可解压；SOURCE_MANIFEST 存在；RELEASE_MANIFEST 存在；SHA256SUMS 全部核对通过；源码与冻结 commit 逐文件一致；构建产物 独立启动成功；REVIEW_INDEX 完整；REVIEW_PACK 覆盖全部应审查源码；测试日志 全部归档；截图证据 完整；Drive 归档 回读核实；重大未解决 P0/P1 0 项。
验收命令：npm ci；npm run typecheck；npm test；npm run build；npm run verify:release；Oracle：python -m pytest -q oracle/tests；Git：git status --short；git rev-parse HEAD；git bundle create GitBundle.bundle --all
依赖任务：T001–T013 全部通过。
完成定义：源码、构建产物、测试日志、哈希清单和审查包全部对应同一个冻结版本，具备交给 GPT 独立终审的条件。
失败回退：哈希不一致：重新从冻结 commit 构建发布包。Git bundle 无法检出：修复 Git 归档。审查包不完整：重新生成并核对文件覆盖。测试日志缺失：返回对应任务重新运行。P0/P1 未关闭：不得提交最终发布候选。
