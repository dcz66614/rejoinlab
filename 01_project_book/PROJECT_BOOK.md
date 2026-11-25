文件一：PROJECT_BOOK.md

以下为完整项目书，版本 1.0.2。

PROJECT_BOOK.md
---
project_id: P031
slug: rejoinlab
name: RejoinLab（续流证）
document: PROJECT_BOOK
spec_version: 1.0.2
status: SPECIFICATION_FROZEN_PENDING_OWNER_REVIEW
license: MIT
human_participants: 0
total_effort_hours: 88
runtime: Local-first, offline, CPU-only
protocol: AG-UI 1.0
---

# P031 RejoinLab（续流证）项目书
副标题：AI Agent 事件流续接与对话状态一致性实验室
README 一句话：> Your AI agent reconnected. Did your conversation survive correctly?

## 0. 项目定义与冻结决定
### 0.1 一句话定义
RejoinLab 是一个本地运行的 AG-UI 事件流续接与对话状态一致性实验室。用户导入一条 AI Agent 事件流后，RejoinLab 自动构造断线、重连、重放、快照恢复等场景，比较完整事件流和恢复事件流所产生的对话状态，定位：哪条工具调用被重复；哪段文本被遗漏；哪段回答被移动到工具调用之前或之后；哪个消息被错误地合并或拆分；哪次状态快照覆盖了较新的状态；哪些事件在恢复后被重复应用；哪个恢复路径无法重建原有对话状态。它提供确定性参考 Reducer、事件重放模拟器、双轨时间线、状态差异定位和可复现 JSON 故障报告。
### 0.2 冻结的基本信息
PROJECT_ID P031；中文名 续流证；英文名 RejoinLab；slug rejoinlab；SPEC_VERSION 1.0.2；产品类型 纯软件、本地离线交互式事件流实验室；目标用户 AI Agent 前端工程师、AG-UI 集成开发者、AI 应用维护者；核心领域 Agent 事件流、状态归约、断线恢复、消息顺序与一致性；协议版本 AG-UI 1.0；输入格式 JSONL、SSE 文件；算法内核 确定性状态 Reducer、双轨状态比较、有界重放与最短分歧定位；前端技术栈 TypeScript、React、Vite；后台计算 Web Worker；独立 Oracle Python 3.12+；交付报告 JSON rejoinlab.report/v1、独立 HTML；运行方式 本地静态 Web 应用；外部 API 无；LLM 无；GPU 不需要；数据 全部合成数据或用户主动导入的本地文件；真人参与 0 人；许可证 MIT；总工时 88 小时，其中 72 小时任务预算、16 小时缓冲；原型周期 单人等效约两周。本书是产品与算法权威规格，不是软件已实现、已运行或已通过验收的声明。
### 0.3 产品核心承诺
RejoinLab 只做一件事：核验 AI Agent 的事件经过断线、恢复和重放后，是否仍能得到与完整事件流一致的用户可见状态。产品不判断模型回答是否正确，不判断工具执行是否合理，也不推测 Agent 后端内部发生了什么。
### 0.4 冻结范围
MVP 必须包含：1. AG-UI 1.0 事件流解析。2. 本地 JSONL 文件导入。3. 本地 SSE 文件导入。4. 独立确定性参考 Reducer。5. 完整事件流与恢复事件流双轨计算。6. 断线位置和恢复点模拟。7. 完整重放、游标重放和快照恢复模拟。8. 重复、丢失、乱序事件注入。9. 消息、工具调用和共享状态一致性检查。10. 首个分歧事件定位。11. 双轨时间线可视化。12. 最短故障注入序列。13. JSON 故障报告。14. 独立 HTML 报告导出。15. Python 独立 Oracle。16. 24 条固定合成 Golden 轨迹。
明确不做：实时 Agent 服务；实时网络连接或真实断线拦截；收费 API；LLM 推理；云端日志平台；Agent 运行时监控；AG-UI SDK 修复补丁；自动修改用户的 Agent；完整分布式系统模型检查；exactly-once 投递保证；真实生产系统的故障概率预测；对所有 AG-UI 事件类型的完整实现。
### 0.5 版本记录
- v1.0.0（2026-11-23）：冻结。终审 R1 审查对象。
- v1.0.1（2026-11-23）：终审 R1 后的规格修订（P1-R1-03、P2-R1-01、P2-R1-02、P2-R1-08）。§13.2：fullPath / resumePath 由 PathResult 改为 PathResult | null；shortestInjectionSequence 由 string[] 改为 string[] | null（见 00_control/ADR-001.md）。§8.5：BFS 目标语义澄清为搜索 primary diagnostic 的最短复现（见 00_control/ADR-002.md），措辞澄清，不是算法变更。§3.17：明确 AG-UI wire MESSAGES_SNAPSHOT 不保留内部 segments 的限制。另有 ADR-003 对 §5.3（canonical 形式）与 §10.4（parity 字段）的澄清性交叉引用（见 00_control/ADR-003.md），只澄清既有语义，不改行为、不升版。
- v1.0.2（2026-11-24）：终审 R3 后的规格修订（P1-R3-01、P1-R3-02、P2-R3-03、P2-R3-04；见 00_control/ADR-004.md）。§3.3：新增 RUN_FINISHED 身份规则——必须关闭当前正处于 RUNNING 的 run，且 event.runId 必须等于该 open run 的 runId；无 open run 时判 INVALID_INPUT（FINISH_WITHOUT_START），open run 为另一 runId 时判 INVALID_INPUT（FINISH_WRONG_RUN）；不得以第一个 RUNNING run 代替目标 run，不得采信线上 outcome / result 去完成一个未被 Reducer 接受的 run。§3.14：新增 pending 规范定义——pending 是逻辑调用（toolCallId）的属性，按 id 分组、当前 run 作用域、已闭合且无结果、首次出现顺序、每 id 至多出现一次；并新增 verdict 句——outcome.pendingToolCallIds 与 pending(当前 run) 不一致时判 INVALID_INPUT（PENDING_TOOL_CALL_MISMATCH），声明只作校验，永不写入派生状态。§3.4：RUN_FINISHED 必填由 type 改为 type、threadId、runId（以 Schema 为准）；outcome 段补一句：cancelled 不是成功，不校验 pending 列表；success 可带 pendingToolCallIds。§7：INVALID_INPUT 定义后加映射句——上述三项生命周期违规（FINISH_WITHOUT_START、FINISH_WRONG_RUN、PENDING_TOOL_CALL_MISMATCH）属 INVALID_INPUT，诊断码均为 INVALID_INPUT，不新增 §6 诊断码。§10.4 / §11：S0 门禁除 24 条 Golden 外另含 gate.test.ts 内的 FIX-R3 专门 parity 夹具，其计数单列，不计入 24/24。新增 00_control/ADR-004.md，记录三码走 INVALID_INPUT 的裁决与否决理由、pending 统一定义与“给 helper 加可选 runId 参数、不另抽 helper”的决定、升版理由、两类 verdict 分裂的已裁决说明与未决点。

## 1. 目标用户与痛点
### 1.1 首要目标用户
中国 AI 应用团队中的前端工程师和全栈工程师。具体人物：正在开发聊天式 AI Agent 应用；使用 AG-UI 或相似的事件流协议；使用 TypeScript、React、Vue 或其他前端技术；Agent 通过 HTTP/SSE、WebSocket 或其他流式方式传递事件；前端维护消息列表、工具调用卡片和 Agent 状态；没有专门的协议恢复测试团队。
典型场景：周三下午，开发者正在调试一个使用 AG-UI 的 AI 助手。用户与助手进行了长对话，助手调用了两个工具，随后网络连接中断。浏览器刷新后，客户端恢复历史消息。开发者发现：工具调用卡片出现两次；工具结果出现在调用卡片之前；助手回答的后半段跑到了工具调用之前；页面看起来已经恢复，但下一次发给模型的消息历史与用户此前看到的内容不一致。开发者需要知道：究竟是哪一个事件、哪一个恢复位置或哪一种状态合并方式导致了差异。
### 1.2 次要目标用户
AG-UI 集成开发者：为不同 Agent 后端适配事件流，难以证明不同后端的事件恢复行为一致；AI 应用维护者：修改消息 Reducer、快照合并和重连代码，容易引入消息顺序和工具调用回归；SDK 开发者：修改事件归约和历史消息重建逻辑，缺少可独立重放的确定性回归样本；自动化测试工程师：为 AI 聊天界面增加协议测试，普通 E2E 很难覆盖断线和历史重放组合；AI 应用技术负责人：审查 Agent 长对话稳定性，只看到最终 UI，难以确定恢复路径是否正确。
### 1.3 痛点频率、强度和代价
以下为规划假设，不是真人调研结果。发生频率：每个正在维护流式 Agent 的项目每月约 0.5–2 次相关问题；痛点强度 4/5；单次排查代价 30–90 分钟；严重故障代价 可能需要数小时定位和修复；当前 workaround 手工截取 SSE 日志、打印消息数组、刷新浏览器、反复重放请求；workaround 不足 无法系统枚举断线位置、重复事件、快照和重放的组合，也缺少独立参考状态。上述频率和代价不得写成已经测量的事实。
### 1.4 核心机制
确定性状态归约：S_{i+1} = R(S_i, e_i)，其中 S_i 为当前对话状态，e_i 为下一条事件，R 为确定性状态归约函数。分别计算完整事件流与断线恢复后的事件流：S_full = fold(R, S_0, E)；S_resume = fold(R, S_k_snapshot, E_{k+1:n})。比较两条路径最终状态：D = canon(S_full) ≠ canon(S_resume)。若不一致，定位第一次发生差异的事件。没有可靠传输 ID 时，不能仅凭两个事件内容相同就断言它们是重复事件，必须标为“疑似重复”，而不是自动去重。
### 1.5 最接近已有方案与差异
AG-UI 官方 SDK：定义协议和提供事件处理实现；RejoinLab 不替代 SDK，独立核验恢复前后的状态。AG-UI 客户端 Reducer：将事件转换为消息和共享状态；不依赖被测 Reducer 作为唯一正确答案。Playwright：浏览器交互自动化；不把真实浏览器 E2E 当成事件流正确性的唯一验证。SSE 调试工具：查看 HTTP/SSE 事件内容；不只显示日志，而是重放和比较两条状态路径。Event Sourcing 调试工具：查看事件和状态变化；专门处理 AG-UI 消息、工具调用和状态快照语义。通用 JSON Diff：比较两个 JSON 文档；自动计算完整路径和恢复路径，并定位首个事件分歧。RejoinLab 不声称首创事件重放、Event Sourcing 或状态 Diff。差异化主张是：针对 AG-UI 1.0 的消息、工具调用和状态快照，提供一个本地、确定性、可视化、可独立复核的断线恢复一致性实验台。

## 2. 外部问题证据与协议版本
### 2.1 协议版本冻结
本项目使用 AG-UI 1.0。AG-UI 1.0 于 2026-09-18 正式发布。官方发布说明称 1.0 是冻结的、带版本号的协议合同，未来演进通过新版本和 draft 进行。因此：不以 0.x 草案作为字段权威；不混用后续 draft 事件；不根据某个 SDK 的内部实现擅自修改协议定义；事件字段以 AG-UI 1.0 JSON Schema 为准；事件顺序和生命周期以 AG-UI 1.0 行为规范为准。主要来源：AG-UI 1.0 发布讨论 https://github.com/ag-ui-protocol/ag-ui/discussions/2792 ；AG-UI 1.0 规范 https://docs.ag-ui.com/spec/1.0 ；AG-UI 1.0 JSON Schema https://docs.ag-ui.com/spec/1.0/schema.json
### 2.2 E01：官方事件规范
来源：AG-UI 官方 1.0 Specification。网址：https://docs.ag-ui.com/spec/1.0 ；https://docs.ag-ui.com/spec/1.0/events ；https://docs.ag-ui.com/spec/1.0/basic 。版本：1.0。核实日期：2026-11-23。规范定义了：Run 生命周期；文本消息流；工具调用流；状态快照与增量；消息快照；事件标识符；事件到达顺序；SSE 和 Protobuf 等传输绑定。关键事实：1. timestamp 是可选信息，不能用它替代事件到达顺序。2. 消息流使用 messageId。3. 工具调用流使用 toolCallId。4. STATE_SNAPSHOT 替换共享状态。5. STATE_DELTA 使用 RFC 6902 JSON Patch。6. MESSAGES_SNAPSHOT 按协议规则协调已有消息，而不是简单地把数组整体覆盖。7. 消息和工具调用可以交错。8. RUN_ERROR 可以在 RUN_STARTED 之前出现，用于报告启动前失败。借鉴范围：作为 RejoinLab 事件解析、Reducer 和 Golden 预期的权威基础。不复制：AG-UI SDK 的生产实现代码。
### 2.3 E02：真实 AG-UI 故障 Issue
以下三个 Issue 已实际打开并读取原文。
E02-A：AG-UI #1524，标题：`TOOL_CALL_START handler in defaultApplyEvents is not idempotent — duplicates toolCalls when connect() replays historic events over pre-populated message state`，网址 https://github.com/ag-ui-protocol/ag-ui/issues/1524 ，提交日期 2026-04-15，当前核实状态 Open，涉及版本 @ag-ui/client@0.0.52、@ag-ui/core@0.0.52，故障位置 defaultApplyEvents 中的 TOOL_CALL_START 处理。原始问题：历史工具调用已经存在于消息状态中，重新连接时又重放同一个 TOOL_CALL_START。处理函数无重复检查，再次插入相同 toolCallId，导致重复工具调用及 React duplicate-key 警告。RejoinLab 对应测试：G01。
E02-B：AG-UI #3119，标题：`MESSAGES_SNAPSHOT can leave a re-ID’d tool-call assistant after its result and answer`，网址 https://github.com/ag-ui-protocol/ag-ui/issues/3119 ，提交日期 2026-10-19，当前核实状态 Open，涉及实现 @ag-ui/client 的 defaultApplyEvents。原始问题：已有历史包含两个工具调用 assistant message，且两个调用使用同一个 toolCallId。随后应用完整 MESSAGES_SNAPSHOT，其中后一个 assistant message 的 messageId 被更换。由于快照合并保留旧消息的位置、把新 ID 消息追加到末尾，原本位于第二个调用之后的工具结果和回答可能留在调用消息之前。实际问题是消息身份重建与顺序协调失败。RejoinLab 对应测试：G02。
E02-C：AG-UI #3368，标题：`[dotnet] AGUI.Server reopens a closed text message when text resumes after a tool call, so the text lands before the call`，网址 https://github.com/ag-ui-protocol/ag-ui/issues/3368 ，提交日期 2026-11-11，当前核实状态 Open，涉及版本 AGUI.Server@1.0.1 与当前 main 分支对应实现。原始问题：同一个响应流先产生文本 A，再产生工具调用，随后又产生文本 B，但三者共用同一个 MessageId。文本消息被关闭后又以相同 ID 重新打开。AG-UI 1.0 允许这种重新打开行为，但当前消息模型把文本合并为一个字符串、工具调用另行存储，无法表达 A、工具调用、B 的交错顺序。结果是 B 可能显示在工具调用卡片之前。RejoinLab 对应测试：G03。
重要边界：上述三个 Issue 证明存在具体工程故障，不证明所有 AG-UI 实现都存在同样的问题，也不证明这些问题具有某个已测行业发生率。
### 2.4 E03：WHATWG Server-Sent Events
来源：WHATWG HTML Living Standard，§9.2 Server-sent events。网址 https://html.spec.whatwg.org/multipage/server-sent-events.html ，核实日期 2026-11-23。当前标准页面显示最近更新日期：2026-11-22。标准规定：浏览器 EventSource 在连接重新建立时，可以把最近的事件 ID 通过 Last-Event-ID 请求头发给服务器；SSE id 字段更新 EventSource 的 last event ID；浏览器在后续重连时可以发送该值；事件按照收到的顺序处理。但必须明确区分：AG-UI 1.0 标准 HTTP+SSE 绑定不使用 SSE 的 id、event、retry 字段，并明确规定该绑定没有原生 stream resumption。AG-UI 1.0 SSE 绑定规定：每个 SSE data 对应一个完整 AG-UI JSON 事件；消费者忽略除 data 之外的 SSE 字段；连接中断且没有收到终止事件时，该 run 是 truncated；重新运行是一个新的 run，必须使用新的 runId；新 run 的输入携带消费者保留的消息和状态。因此 RejoinLab：1. 解析 SSE 文件中的 id 字段并保留为传输层原始证据；2. 不把它认定为 AG-UI 1.0 的事件 ID；3. 不把它认定为 AG-UI 1.0 官方恢复游标；4. 使用本地事件序号和实验配置模拟恢复位置；5. 不执行真实网络重连。
### 2.5 证据适用范围
E01 支持 AG-UI 1.0 有明确事件和状态规则，不支持所有 SDK 都完全符合规则；E02-A 支持历史工具调用重放可能造成重复，不支持每次重连都会重复工具调用；E02-B 支持消息快照中的 ID 变化可能造成历史顺序问题，不支持所有消息快照都改变顺序；E02-C 支持消息 ID 复用可能造成文本和工具卡片的展示顺序损失，不支持同一 messageId 重新打开本身违反 AG-UI 1.0；E03 支持 SSE 定义 Last-Event-ID 重连语义，不支持 AG-UI 1.0 SSE 绑定使用 Last-Event-ID 恢复。

## 3. AG-UI 1.0 事件子集与数据契约
### 3.1 统一事件模型
每条事件必须包含 type。允许的公共可选字段：timestamp、rawEvent、metadata。部分事件允许 subagentRunId。MVP 的算法范围固定为 parent-agent 主流程，不展开 Subagent 生命周期。遇到需要 Subagent 独立归约的样本时，报告 INCONCLUSIVE_LIMIT，不得假装已经完整支持。所有事件按文件中的到达顺序排列。禁止使用 timestamp 对事件重新排序。
### 3.2 MVP 支持事件清单
MVP 支持以下 15 种事件：RUN_STARTED、RUN_FINISHED、RUN_ERROR、TEXT_MESSAGE_START、TEXT_MESSAGE_CONTENT、TEXT_MESSAGE_END、TEXT_MESSAGE_CHUNK（支持并展开）、TOOL_CALL_START、TOOL_CALL_ARGS、TOOL_CALL_END、TOOL_CALL_CHUNK（支持并展开）、TOOL_CALL_RESULT、STATE_SNAPSHOT、STATE_DELTA、MESSAGES_SNAPSHOT。明确不支持：STEP_STARTED / STEP_FINISHED；REASONING_*；ACTIVITY_*；SUBAGENT_*；RAW；CUSTOM；未列出的 draft events。遇到不支持事件，不得静默删除后继续声称一致。必须报告 INCONCLUSIVE_LIMIT 或 INVALID_INPUT，并指出事件位置和类型。
### 3.3 RUN_STARTED
必填：type = RUN_STARTED、threadId、runId。可选：protocolVersion、parentRunId、input、公共事件字段。语义：开始一个 run；threadId 标识对话；runId 标识一次运行；input 如存在，提供该 run 开始时的输入消息和状态；同一 thread 内不得将一个 runId 用于另一次不同的 run。RUN_FINISHED 身份规则（v1.0.2，见 00_control/ADR-004.md）：RUN_FINISHED 必须关闭当前正处于 RUNNING 的 run，且 event.runId 必须等于该 open run 的 runId；无 open run 时判 INVALID_INPUT（FINISH_WITHOUT_START）；open run 为另一 runId 时判 INVALID_INPUT（FINISH_WRONG_RUN）；不得以第一个 RUNNING run 代替目标 run，不得采信线上 outcome / result 去完成一个未被 Reducer 接受的 run。
### 3.4 RUN_FINISHED
必填：type = RUN_FINISHED、threadId、runId。可选：outcome、result、usage、公共事件字段。语义：结束一个未报告失败的 run；必须保证 run 打开的消息、工具调用等按协议正确关闭；不得把用户断开连接直接伪装成 RUN_FINISHED。outcome 的 MVP 处理：absent 视为正常成功；success 正常结束，可带 pendingToolCallIds；cancelled 取消结束，不是成功，也不是 RUN_ERROR；interrupt 记录中断状态，不在 MVP 中实现完整人工审批及 ResumeEntry 交互。cancelled 不是成功，不校验 pending 列表；success 可带 pendingToolCallIds。
### 3.5 RUN_ERROR
必填：type = RUN_ERROR、message。可选：code、usage、公共事件字段。语义：报告 run 失败；可以出现在 RUN_STARTED 之前；出现在 RUN_STARTED 之后时结束当前 run；结束时尚未完成的流式消息和工具调用标记为未完成；不得把 RUN_ERROR 当成成功的 TOOL_CALL_RESULT。
### 3.6 TEXT_MESSAGE_START
必填：type、messageId。可选：role、name、公共事件字段。role 缺失时默认 assistant。语义：创建或重新打开一个文本消息。
### 3.7 TEXT_MESSAGE_CONTENT
必填：type、messageId、delta。语义：将 delta 追加到对应打开消息的文本内容。空字符串 delta 在 AG-UI 1.0 中合法，不得自动判定为空消息错误。
### 3.8 TEXT_MESSAGE_END
必填：type、messageId。语义：关闭对应消息。AG-UI 1.0 允许一个关闭后的消息通过相同 messageId 重新打开。重新打开必须保持相同的 owner、role 和 name。RejoinLab 不得把合法的消息重新打开直接判成协议违规，但必须检查文本与工具调用交错后是否丢失展示顺序。
### 3.9 TEXT_MESSAGE_CHUNK
字段：messageId（首次 chunk 必填，后续可省略）；role 可选；name 可选；delta 可选；公共事件字段。语义：展开为 TEXT_MESSAGE_START、TEXT_MESSAGE_CONTENT、TEXT_MESSAGE_END。在进入 Reducer 前完成展开。
### 3.10 TOOL_CALL_START
必填：type、toolCallId、toolCallName。可选：parentMessageId、公共事件字段。语义：开始一个工具调用，并记录其所属消息。
### 3.11 TOOL_CALL_ARGS
必填：type、toolCallId、delta。语义：将参数片段按到达顺序追加到工具调用参数文本。参数在 TOOL_CALL_END 前不视为完整，不得在分析器中提前解析并认定为有效 JSON。
### 3.12 TOOL_CALL_END
必填：type、toolCallId。语义：关闭工具调用的参数流。AG-UI 1.0 允许关闭后的工具调用使用相同 toolCallId 重新打开，但必须保持 toolCallName、parentMessageId 和 owner 一致。
### 3.13 TOOL_CALL_CHUNK
字段：toolCallId（首次 chunk 必填）；toolCallName（首次 chunk 必填）；parentMessageId 可选；delta 可选；公共事件字段。语义：展开为 TOOL_CALL_START、TOOL_CALL_ARGS、TOOL_CALL_END。
### 3.14 TOOL_CALL_RESULT
必填：type、messageId、toolCallId、content。可选：role，若出现必须为 tool；公共事件字段。content 支持字符串或按顺序排列的 ContentPart 数组。语义：创建一个新的 tool message，并将其关联到对应工具调用。重要生命周期修正：AG-UI 1.0 并不要求每个 TOOL_CALL_START 都必须在同一 run 中收到 TOOL_CALL_RESULT。存在两种情况：1. Agent 自己执行的工具：结果通常通过同一 run 的 TOOL_CALL_RESULT 返回。2. 前端执行的工具：当前 run 可以以成功状态结束，并将尚未回答的调用列入 pendingToolCallIds；结果通过下一次 run 的输入消息返回。因此 RejoinLab 的约束是：一个同一 run 的工具调用最多只能收到一次对应的 TOOL_CALL_RESULT；同一调用 ID 不得因重放而被误认为多个不同调用；前端工具调用允许在当前 run 没有 TOOL_CALL_RESULT；若有 pendingToolCallIds，必须与当前 run 中尚未收到结果的调用一致；下一 run 如果继续该线程，应在输入消息中携带对应工具结果；RUN_ERROR 结束未完成调用时，不推断一个虚假的 TOOL_CALL_RESULT。pending 规范定义（v1.0.2，见 00_control/ADR-004.md）：pending(R)（R 为一个 run；状态字段 pendingToolCallIds 取全部 run 的并集）是逻辑调用（toolCallId）的属性：当且仅当存在至少一条属于 R 的 toolCalls 条目，其参数流已闭合（TS：status === "closed"；Oracle：not open and not incomplete），且同一 id 在 R 内的任一条目均未持有结果，该 id 属于 pending(R)。每个 id 在列表中至多出现一次，顺序为该 id 在 toolCalls 数组中的首次出现顺序（即 START 顺序；重开复用条目不改变首次出现位置）。open（参数未完）、incomplete（run 结束时未闭合）、resulted（已有结果）的条目均不使 id 进入 pending；RUN_FINISHED 的 outcome.pendingToolCallIds 必须与 pending(当前 run) 作为有序数组逐项相等，缺席视为 []。RUN_FINISHED 的 outcome.pendingToolCallIds（缺席视为 []）与 pending(当前 run) 不一致时，判 INVALID_INPUT（PENDING_TOOL_CALL_MISMATCH）；声明只作校验，永不写入派生状态。
### 3.15 STATE_SNAPSHOT
必填：type、snapshot。语义：完整替换当前共享状态，不做深度合并。
### 3.16 STATE_DELTA
必填：type、delta。delta 是 RFC 6902 JSON Patch 操作数组。语义：以当前共享状态为基准顺序应用 Patch。结构格式不合法时为 INVALID_INPUT。结构合法但 Patch 无法应用时，记录 SNAPSHOT_MISMATCH 或相关状态错误，不得伪装成功。
### 3.17 MESSAGES_SNAPSHOT
必填：type、messages。语义：声明生产者拥有的完整消息集合。必须遵循 AG-UI 1.0 的协调规则：1. snapshot 中已有相同 messageId 的消息，替换已有消息，但保留原位置；2. snapshot 中未出现过的消息，按 snapshot 顺序追加；3. producer-owned 的旧消息如果不在完整 snapshot 中，应移除；4. 客户端独有的 activity/reasoning 消息按协议规定保留，除非快照明确声明相应完整集合。不能把它简单实现为 messages = snapshot.messages。wire 形式限制（v1.0.1，终审 R1 P2-R1-02）：AG-UI wire Message 没有内部 segments 字段；messageStateToAGUI 只输出 content。单独从 wire messagesSnapshot 恢复会丢失文本片段边界；权威恢复是检查点的 capturedState（段完整）或对前缀的折叠重放（段重建）。当前产品没有只从 wire 快照恢复的路径；未来任何新增此类路径时，若无法证明交错信息完整，必须返回 INCOMPLETE_TRACE，不得静默丢段后声称一致。见 docs/LIMITATIONS.md L-T007-04。

## 4. 标识符、快照与恢复游标
### 4.1 AG-UI 标识符
threadId 对话身份，同一对话跨 run 稳定；runId 单次运行身份，同一 thread 内不得用于不同 run；messageId 消息身份，同一 thread 内唯一，可跨 run 重述；toolCallId 工具调用身份，关联调用、参数、结果；eventId AG-UI 1.0 不定义，不得伪造为标准事件字段。所有 AG-UI 标识符都是 opaque strings，不解析其中的内部结构。
### 4.2 eventId 的边界
AG-UI 1.0 的 BaseEvent 没有 eventId 字段。SSE 的 id 是传输层字段，不是 AG-UI JSON 事件的标准 eventId。RejoinLab 对每条导入事件额外建立本地记录：{"sourceIndex": 12, "sourceEventKey": null, "transportEventId": null, "event": {"type": "TEXT_MESSAGE_CONTENT", "messageId": "msg-1", "delta": "Hello"}}。字段定义：sourceIndex：RejoinLab 为本次导入文件分配的从 0 开始的顺序编号。sourceEventKey：若用户提供了额外稳定事件标识，则保存原值；否则为 null。transportEventId：若来源为 SSE，保留原始 id 字段；否则为 null。event：原始 AG-UI 事件对象。以上字段属于 RejoinLab 的本地导入包装，不属于 AG-UI 协议。
### 4.3 无稳定 ID 的重复判定
如果两个事件 type 相同；messageId/toolCallId 相同；delta 或其他有效负载相同；出现在合理的重放窗口内；但没有稳定的事件标识或可核对的原始轨迹位置，RejoinLab 只能报告 SUSPECTED_DUPLICATE，不得仅凭内容相同就自动去重。因为两个不同事件可能合法地包含相同文本、相同工具参数或相同状态值。
### 4.4 快照检查点
RejoinLab 的快照检查点是一个本地分析对象：interface RecoveryCheckpoint { threadId: string; sourceIndex: number; stateSnapshot?: unknown; messagesSnapshot?: unknown[]; capturedState: RejoinState; coverage: { sharedState: boolean; messages: boolean; }; }。其中：STATE_SNAPSHOT 负责共享状态；MESSAGES_SNAPSHOT 负责消息集合；两者可以分别出现；单独出现其中一个，不意味着另一个也已被完整快照覆盖。当完整恢复需要两个维度时，必须使用具有相应覆盖范围的检查点。
### 4.5 恢复游标
恢复游标定义为 resumeAfterSourceIndex，含义：恢复分支从已应用的最后一个检查点 sourceIndex 之后的第一条事件开始。该游标：只在本次本地导入文件内有效；不等同于 SSE Last-Event-ID；不等同于 AG-UI eventId；不代表服务器支持真实恢复；不用于建立网络连接。RejoinLab 另外支持 FULL_REPLAY_FROM_START，用于模拟重新收到整段历史的情况。

## 5. 核心算法与一致性不变量
### 5.1 状态结构
interface RejoinState { threadId: string | null; runs: RunState[]; messages: MessageState[]; toolCalls: ToolCallState[]; sharedState: unknown; orderedTimeline: TimelineItem[]; pendingToolCallIds: string[]; runStatus: "NOT_STARTED" | "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED"; }
### 5.2 双轨最终状态一致性
核心不变量：canon(S_full) = canon(S_resume)，其中 S_full 为完整事件流归约后的状态，S_resume 为快照恢复和后续事件归约后的状态，canon 为规范化状态序列化函数。若二者不同：DIVERGENT_STATE，必须输出至少一个可复核差异路径。
### 5.3 canon 规范
采用 RFC 8785 JSON Canonicalization Scheme 语义。要求：对象键按规范顺序排列；数组顺序保留；字符串按 JSON 规则规范编码；数字使用确定性规范表示；不允许 NaN、Infinity 等非 JSON 值；不将 undefined 当成 null；排除 timestamp、sourceIndex、导入文件名和本地耗时等非业务状态字段；不排除 messageId、toolCallId、消息顺序和工具结果。规范化结果使用 UTF-8 字节计算 SHA-256。生产实现与 Python Oracle 必须分别实现，不能共享序列化结果作为预期值。完整状态 parity 的 canonical 形式澄清（v1.0.1，见 00_control/ADR-003.md）：canonical 形式是生产 projectState 的 8 个协议字段，runs 含全部 5 个 RunState 字段（parentRunId、protocolVersion、outcome、result、error）；parity 投影为生产投影加推导出的时间线 runId（run 事件取事件 runId，其余项取当前 RUNNING run 的 runId，无 run 时缺键）；parity 路径 = 生产路径 + runStatus。
### 5.4 消息生命周期不变量
TEXT_MESSAGE_CONTENT 必须关联一个已打开或按 AG-UI 1.0 合法重新打开的 messageId。TEXT_MESSAGE_END 必须关联相应消息。同一消息不能同时存在两个未关闭的流式生命周期。每个 run 结束时，必须按协议处理所有打开的消息。同一 messageId 的合法重新打开必须保持 owner、role、name 一致。消息的文本片段必须按事件到达顺序连接。不得把工具调用之后的文本移动到该工具调用之前。消息快照不能无证据地将两个不同 messageId 合并为同一个消息。
### 5.5 工具调用生命周期不变量
TOOL_CALL_ARGS 必须对应一个已打开的 toolCallId。TOOL_CALL_END 必须对应一个已打开的 toolCallId。一个调用 ID 不能被重复创建成两个相同的逻辑调用。参数片段必须按事件顺序拼接。TOOL_CALL_RESULT 必须对应已有调用。同一个调用在同一逻辑执行中最多有一个结果。前端工具调用可以在当前 run 结束时保持 pending。RUN_ERROR 结束当前 run 的未完成操作，但不自动产生工具结果。同一个 toolCallId 如果被用于两个不同父消息或两个不一致调用，必须标记身份复用风险。
### 5.6 消息与工具调用顺序不变量
orderedTimeline 必须保留以下交错：TEXT_A / TOOL_CALL_START / TOOL_CALL_ARGS / TOOL_CALL_END / TOOL_CALL_RESULT / TEXT_B，不能把它简化成 TEXT_AB / TOOL_CALL_START / TOOL_CALL_RESULT。如果目标消息投影无法表达原始事件流中的交错，必须报告 MESSAGE_REORDER 或相应的信息损失。
### 5.7 状态不变量
STATE_SNAPSHOT 完整替换共享状态。STATE_DELTA 必须按顺序应用。JSON Patch 数组操作顺序不可改变。快照恢复后的状态必须等价于完整前缀计算得到的状态。快照恢复不能覆盖在其之后已经发生的有效状态更新。同一事件序列、同一初始状态必须产生相同结果。
### 5.8 合法恢复路径收敛
对每一个合法的断线恢复路径：canon(S_full) = canon(S_resume)，要求合法恢复路径收敛率 100%。如果恢复路径缺少必要快照、存在未知事件或超过计算边界，不能将其计为成功。

## 6. 诊断代码与严重级别
DUPLICATE_TOOL_CALL CRITICAL：已有调用在恢复重放后被再次插入；证据 toolCallId、parentMessageId、两次 START 的 sourceIndex。LOST_EVENT CRITICAL：已知完整轨迹中的事件没有进入恢复分支，且导致状态缺失；证据 sourceIndex、sourceEventKey、事件类型、差异字段。OUT_OF_ORDER CRITICAL：事件依赖顺序错误，例如 CONTENT 先于 START；证据前后事件、messageId/toolCallId、sourceIndex。MESSAGE_REORDER CRITICAL：最终消息顺序与有效事件交错顺序不一致；证据 messageId、toolCallId、预期顺序、实际顺序。SNAPSHOT_MISMATCH CRITICAL：快照内容与对应前缀状态不一致或恢复基线错误；证据 snapshotIndex、预期哈希、实际哈希。DIVERGENT_STATE CRITICAL：双轨终态 canon 不相等；证据两个状态哈希、JSON Pointer 差异路径。SUSPECTED_DUPLICATE WARNING：没有可靠事件 ID，仅发现相同事件负载在重放窗口内再次出现；证据 type、业务 ID、delta、两个 sourceIndex。TOOL_CALL_ID_REUSE WARNING：同一 toolCallId 被关联到不同调用上下文；证据 toolCallId、不同 parentMessageId、调用名称。TRUNCATED_RUN WARNING：流在终止事件前结束；证据最后事件位置、runId、缺少终止事件。MISSING_TERMINAL WARNING：完整性检查发现没有可确认的 run 终态；证据 runId、最后事件位置。
### 6.1 诊断优先级
CRITICAL：足以证明输入或恢复路径存在可复现的不一致。WARNING：存在风险或证据不足，但不能确认发生了确定性错误。
### 6.2 诊断不得越权
不得：把相同文本直接判成重复事件；把所有消息 ID 重新打开都判为错误；把前端工具没有同 run 结果判成错误；把时间戳较早的事件强制移动到前面；把没有稳定事件标识的疑似重复自动删除。

## 7. 最终裁决
CONSISTENT 一致：双轨规范化状态相等，无 CRITICAL。INCONSISTENT 不一致：双轨状态不同或出现可证实的关键故障。INCONCLUSIVE_LIMIT 超出计算边界：超过事件、搜索节点或时间限制。INVALID_INPUT 输入无效：JSON/SSE 格式错误、必需字段缺失、无法解析的协议事件。下列生命周期违规属 INVALID_INPUT：RUN_FINISHED 无 open run（FINISH_WITHOUT_START）、目标 run 非 open run（FINISH_WRONG_RUN）、outcome.pendingToolCallIds 与当前 run 未结果调用不一致（PENDING_TOOL_CALL_MISMATCH）；三者诊断码均为 INVALID_INPUT，不新增 §6 诊断码。INCOMPLETE_TRACE 轨迹不完整：缺少必要终止信息、检查点覆盖不足或无法确认恢复完整性。CONSISTENT 不等于 Agent 后端正确。INCOMPLETE_TRACE 不得降级为 CONSISTENT。SUSPECTED_DUPLICATE 可以与 CONSISTENT 同时出现，但必须在报告中显示警告。

## 8. 确定性有界重放算法
### 8.1 输入规模
每条原始轨迹事件数 40；断线点 4；快照检查点 4；单次注入的重复事件数 4；单次注入的丢失事件数 4；最大故障注入深度 3；最大搜索节点 5,000；单条最大轨迹处理时间 1 秒；输入文件总大小 1 MiB；单个事件大小 64 KiB。轨迹事件数包括 AG-UI 事件和 RejoinLab 的 DISCONNECT / RECONNECT 控制标记。超过规模限制返回 INCONCLUSIVE_LIMIT。
### 8.2 断线模拟
DISCONNECT_AFTER(i)：在第 i 个源事件已经交付后中断。已交付事件保留；未交付事件不进入客户端状态；不虚构 RUN_ERROR；不虚构 RUN_FINISHED；原 run 视为可能被截断。
### 8.3 恢复模拟
支持：A. FULL_REPLAY_FROM_START 从原始轨迹开头重新发送全部历史事件，用于检查已有状态是否能安全接受历史重放。B. RESUME_FROM_CHECKPOINT 从检查点恢复消息和状态，然后应用其后的事件。C. REPLAY_AFTER_SOURCE_CURSOR 使用 RejoinLab 的 sourceIndex 游标确定下一条待应用事件。这只是本地实验路径，不代表 AG-UI 1.0 SSE 官方支持游标恢复。
### 8.4 故障注入算子
DUPLICATE_EVENT 在指定位置重复一个事件；DROP_EVENT 删除一个事件；SWAP_ADJACENT 交换相邻两个事件；STALE_SNAPSHOT 使用较早的快照作为恢复基线；REPLAY_PREFIX 重放已经被客户端处理过的事件前缀；MESSAGE_ID_REMAP 在消息快照中改变指定消息 ID；CURSOR_SKIP 恢复时跳过指定 sourceIndex 范围；TRUNCATE_STREAM 在终止事件之前截断流。所有注入均记录在实验报告中。
### 8.5 最短故障序列
使用确定性 BFS：初始节点为未注入故障的轨迹；按固定算子顺序生成子节点；计算每个子节点的双轨状态；检查是否发生可确认的状态分歧；第一次找到的分歧具有最少注入步数；同样步数存在多个结果时按固定字典序选择；返回最短注入序列及首个分歧位置。固定字典序：CURSOR_SKIP、DROP_EVENT、DUPLICATE_EVENT、MESSAGE_ID_REMAP、REPLAY_PREFIX、STALE_SNAPSHOT、SWAP_ADJACENT、TRUNCATE_STREAM。同一输入必须产生相同的：搜索节点访问顺序；故障序列；首个分歧事件；诊断代码；报告哈希。目标语义澄清（v1.0.1，见 00_control/ADR-002.md）：本节“第一次找到的状态分歧”指达到 BFS 目标的最短注入序列。故障轨迹的目标是复现该轨迹的 primary diagnostic，不是任意状态分歧；正常轨迹的目标是任意可确认分歧。这是措辞澄清，不是算法变更：实现自 T005 起即按此目标搜索（S0_REPORT A-03）。
### 8.6 首个分歧定位
对齐完整路径和恢复路径后：按源事件序号进行对齐；计算每一步的规范化状态；找到第一个状态不相等的位置；输出对应事件、状态差异和相关业务 ID；无法可靠对齐时输出分支内序号和置信边界，不伪造精确事件身份。
### 8.7 性能
最大 40 条事件的单条轨迹：处理时间必须小于 1 秒。在达到 5,000 个搜索节点或 1 秒限制时立即停止并返回 INCONCLUSIVE_LIMIT。不得通过忽略未处理的分支宣布 CONSISTENT。

## 9. Golden 合成轨迹集
### 9.1 固定规模
24 条轨迹：8 条已知故障轨迹；16 条正常轨迹。全部由脚本生成，不使用真人对话或真实生产日志。
### 9.2 八条已知故障轨迹
G01 已有工具调用状态上再次重放 TOOL_CALL_START，对应 AG-UI #1524，预期 DUPLICATE_TOOL_CALL。G02 MESSAGES_SNAPSHOT 中 assistant messageId 被更换，导致工具结果和回答位置错误，对应 AG-UI #3119，预期 MESSAGE_REORDER。G03 相同 messageId 在工具调用后重新打开，后半段文本被错误展示，对应 AG-UI #3368，预期 MESSAGE_REORDER。G04 断线恢复时漏掉一个 TEXT_MESSAGE_CONTENT，合成丢失，预期 LOST_EVENT。G05 TEXT_MESSAGE_CONTENT 或 TOOL_CALL_ARGS 相邻片段交换，合成乱序，预期 OUT_OF_ORDER。G06 恢复使用旧 STATE_SNAPSHOT，覆盖较新状态，合成陈旧快照，预期 SNAPSHOT_MISMATCH。G07 无可靠 event ID 时重放相同内容，合成重复，预期 SUSPECTED_DUPLICATE。G08 流在 RUN_FINISHED 前中断，恢复轨迹又缺少剩余事件，合成截断，预期 TRUNCATED_RUN / INCOMPLETE_TRACE。
### 9.3 十六条正常轨迹
N01 单次正常文本 run，CONSISTENT。N02 多段 TEXT_MESSAGE_CONTENT 正常拼接，CONSISTENT。N03 正常工具调用及结果，CONSISTENT。N04 前端工具 pendingToolCallIds，下一 run 返回结果，CONSISTENT。N05 正常 STATE_SNAPSHOT + STATE_DELTA，CONSISTENT。N06 完整重放后应用相同消息快照，CONSISTENT。N07 正常断线后使用完整检查点恢复，CONSISTENT。N08 同一消息合法重新打开，保留事件时间线，CONSISTENT。N09 多个独立工具调用交错，CONSISTENT。N10 多 run 同 thread 顺序执行，CONSISTENT。N11 RUN_ERROR 作为第一条事件，CONSISTENT（失败 run）。N12 RUN_ERROR 结束未完成流，CONSISTENT（失败状态）。N13 timestamp 非递增，但事件到达顺序正确，CONSISTENT。N14 两个不同 sourceEventKey 的相同文本片段，CONSISTENT。N15 相同工具参数用于不同 toolCallId，CONSISTENT。N16 只恢复共享状态快照，保留未被覆盖的本地消息，CONSISTENT。
### 9.4 Golden 门槛
必须同时满足：8/8 已知故障全部检出；16/16 正常轨迹全部正确判定；False Positive = 0；False Negative = 0；合法恢复路径收敛率 = 100%；每条轨迹的首个分歧位置正确；生产实现与 Oracle parity = 24/24。Golden expected 必须手工依据冻结规格推导，不能从生产实现输出直接复制。

## 10. 独立 Python Oracle
### 10.1 目的
Oracle 独立验证生产 TypeScript Reducer 的结果。生产实现和 Oracle 不能共享核心状态计算代码。
### 10.2 技术选择
Python 3.12+；标准库优先；JSON 输入；独立状态 Reducer；独立状态规范化；独立故障注入；独立诊断分类；独立 SHA-256。
### 10.3 独立性要求
禁止：import TypeScript 生成的结果；直接读取生产 Reducer 的状态输出作为 Oracle 真值；从生产实现生成 Golden expected；让两个实现共用同一套业务状态转移函数。允许：共用书面 JSON 接口；共用原始合成事件输入；共用人工推导的 Golden expected；对比各自计算结果。
### 10.4 Parity 字段
逐轨迹比较：verdict；final state hash；message order；tool call order；shared state；pending tool calls；diagnostic codes；first divergence sourceIndex；shortest injection sequence；report canonical hash。必须 24/24 一致。报告 canonical 哈希为完整生产报告哈希（诊断含 message/evidence、首分歧完整对象、input、recovery、assumptions、limitations、metrics.visitedStates 全含，parity 路径替换生产路径；见 00_control/ADR-003.md），不得降级为缩减投影哈希。S0 门禁除 24 条 Golden 外，另含 gate.test.ts 内的 FIX-R3 专门 parity 夹具，其计数单列，不计入 24/24（v1.0.2，见 00_control/ADR-004.md）。

## 11. S0 硬门
S0 = T001–T007。T007 为正式 S0 门禁任务。必须全部通过：24 条 Golden 全部执行。8/8 已知故障检出。16/16 正常轨迹正确通过。False Positive = 0。False Negative = 0。Python Oracle parity = 24/24。合法恢复路径收敛率 = 100%。最短分歧可重复定位。相同输入重复 100 次，报告哈希只有一个值。最大 40 条事件的单轨迹处理时间小于 1 秒。离线运行，外部请求数为 0。无真人参与。任何一项失败：S0 = FAIL。T008–T014 不得启动。S0 门禁除 24 条 Golden 外，另含 gate.test.ts 内的 FIX-R3 专门 parity 夹具，其计数单列，不计入 24/24（v1.0.2，见 00_control/ADR-004.md）。

## 12. 用户流程与 UI 设计
### 12.1 主流程
打开 RejoinLab；导入 JSONL 或 SSE 文件；选择 AG-UI 1.0 profile；检查事件解析结果；选择断线位置；选择恢复策略；选择是否注入重复、丢失、乱序或快照故障；点击运行；Web Worker 执行双轨归约；展示完整路径与恢复路径；查看首个状态分歧；展开诊断证据；导出 JSON 或独立 HTML。
### 12.2 主界面
桌面优先，分为四个区域。顶部控制区：输入文件；协议版本；轨迹事件数；断线位置；快照选择；恢复策略；注入故障类型；运行、暂停、重置。左侧：源事件流，按 sourceIndex 显示 event type、messageId、toolCallId、runId、delta、snapshot、事件原始位置。中央：双轨时间线，上轨完整事件流，下轨断线恢复事件流，显示事件到达顺序、快照位置、断线点、重放区间、重复事件、丢失事件、首个分歧点。右侧：状态与诊断，完整路径终态、恢复路径终态、两个状态哈希、消息数量、工具调用数量、pendingToolCallIds、共享状态、JSON Pointer 差异、诊断代码。
### 12.3 交互要求
点击事件定位源 JSON；点击消息高亮所有相关 messageId 事件；点击工具调用高亮 START / ARGS / END / RESULT；点击分歧点显示两侧状态；点击诊断代码展开触发条件；可以逐事件回放；可以切换恢复策略；可以改变断线点；可以修改合成样本；可以清空当前导入内容；可以导出报告。
### 12.4 视觉规范
完整路径和恢复路径使用两条明确轨道；正常事件使用统一中性色；CRITICAL 使用红色标识；WARNING 使用黄色标识；快照使用竖向标记；断线点使用醒目的分隔标记；分歧点必须有文字和位置说明；不允许仅依赖颜色区分结果。
### 12.5 可访问性
键盘可以完成导入、运行、暂停、逐步回放和导出；重要状态同时提供文本；深色和浅色主题适配；390px 窄屏下改为纵向布局；不使用远程字体；不请求外部图标资源。

## 13. JSON 报告接口
### 13.1 Schema 标识
rejoinlab.report/v1
### 13.2 数据结构
type Verdict = "CONSISTENT" | "INCONSISTENT" | "INCONCLUSIVE_LIMIT" | "INVALID_INPUT" | "INCOMPLETE_TRACE"; type Severity = "CRITICAL" | "WARNING"; interface Diagnostic { code: string; severity: Severity; sourceIndex?: number; relatedSourceIndices?: number[]; message: string; evidence: Record<string, unknown>; } interface PathResult { finalStateHash: string; messages: unknown[]; toolCalls: unknown[]; sharedState: unknown; pendingToolCallIds: string[]; } interface RejoinReport { schema: "rejoinlab.report/v1"; specVersion: "1.0.2"; protocolVersion: "1.0"; scenarioId: string; verdict: Verdict; input: { sourceFormat: "JSONL" | "SSE"; eventCount: number; sourceSha256: string; }; recovery: { strategy: string; disconnectAfter?: number; resumeAfterSourceIndex?: number; }; fullPath: PathResult | null; resumePath: PathResult | null; firstDivergence?: { sourceIndex?: number; fullStateHash: string; resumeStateHash: string; differences: Array<{ jsonPointer: string; expected: unknown; actual: unknown; }>; }; diagnostics: Diagnostic[]; shortestInjectionSequence: string[] | null; metrics: { durationMs: number; visitedStates: number; }; assumptions: string[]; limitations: string[]; }
null 语义（v1.0.1，见 00_control/ADR-001.md）：fullPath / resumePath 各自独立为对象或 null。null 表示“本次分析没有该路径的终态”，绝不伪造空路径。允许 null 的情形：输入无效（INVALID_INPUT，未知事件或折叠失败）——双轨终态缺失时两路径为 null，恢复折叠失败时仅 resumePath 为 null；事件数超限（INCONCLUSIVE_LIMIT）——两路径为 null。BFS 节点超限的 INCONCLUSIVE_LIMIT 仍带已算出的双轨终态，路径照常为对象。null 与对象按实际计算结果取舍，不按裁决一刀切；消费者不得把 null 误读为 CONSISTENT 的证据。shortestInjectionSequence：[] 表示 BFS 已证实目标在无注入时已达成（如 G08）；null 表示未计算（INVALID_INPUT / INCONCLUSIVE_LIMIT / BFS 未运行 / 界内无序列可达）。
### 13.3 样例输出
JSON 示例（scenarioId G01_DUPLICATE_TOOL_CALL，verdict INCONSISTENT，input sourceFormat JSONL、eventCount 6、sourceSha256 "fixture-sha256"，recovery strategy FULL_REPLAY_FROM_START、disconnectAfter 4、resumeAfterSourceIndex 0，fullPath 含 toolCallId "call-1" 一条，resumePath 含同一 toolCallId 两条，firstDivergence sourceIndex 2，differences jsonPointer "/toolCalls/1/toolCallId"、expected null、actual "call-1"，diagnostics DUPLICATE_TOOL_CALL CRITICAL、sourceIndex 2、relatedSourceIndices [2, 5]、message "同一工具调用在恢复路径中被重复添加"，shortestInjectionSequence ["REPLAY_PREFIX"]，metrics durationMs 12、visitedStates 8，assumptions ["使用 AG-UI 1.0 事件语义", "事件到达顺序为权威顺序"]，limitations ["不证明真实 Agent 后端 exactly-once", "不执行真实网络重连"]）。上述数据为接口示意，不是实际运行结果。

## 14. 技术架构
### 14.1 固定技术栈
Runtime Node.js 24 LTS 或 T001 实测兼容版本；Language TypeScript 5.x；UI React 19.x；Build Vite 7.x；Async Web Worker；Test Vitest；E2E Playwright；Oracle Python 3.12+；Hash Web Crypto / Node crypto SHA-256；Export Blob API JSON / HTML；Storage 内存，不持久化敏感输入。具体 patch 版本由 T001 在真实 VM 环境探测后锁定。
### 14.2 系统架构
React UI → Input / Scenario → Trace Parser → Protocol Validator → Event Normalizer → Recovery Planner → Web Worker → Full Reducer / Resume Reducer → Canonical Diff → Diagnostics / BFS → Report Builder → JSON / HTML → Python Oracle（test only）
### 14.3 模块划分
protocol/types.ts AG-UI 1.0 类型；protocol/validate.ts Schema 和字段校验；parser/jsonl.ts JSONL 导入；parser/sse.ts SSE 导入；parser/normalize.ts sourceIndex 和本地包装；core/reducer.ts 确定性状态归约；core/state.ts 状态模型；core/snapshot.ts 快照与检查点；core/canonical.ts canon；core/diff.ts 状态差异；replay/inject.ts 故障注入；replay/search.ts BFS 最短分歧；diagnostics/catalog.ts 诊断代码；report/schema.ts JSON 报告类型；report/json.ts JSON 导出；report/html.ts 自包含 HTML；worker/protocol.ts Worker 消息；worker/rejoin.worker.ts 后台计算；ui/Timeline.tsx 双轨时间线；ui/StateDiff.tsx 状态对照；ui/Diagnostics.tsx 诊断面板。
### 14.4 Worker 契约
请求：{ jobId: string; type: "ANALYZE"; input: AnalyzeInput; } 响应：{ jobId: string; type: "RESULT"; report: RejoinReport; } 取消：{ jobId: string; type: "CANCEL"; } 旧 job 的结果不得覆盖新输入对应的分析结果。

## 15. 隐私、安全与许可证
### 15.1 数据隐私
不上传用户文件；不连接真实 Agent；不请求外部模型；不收集遥测；不写 localStorage；不写 IndexedDB；不在服务端保存事件内容；用户可以查看、编辑和删除导入数据；清空操作必须清除内存中的原始事件、状态和导出引用。
### 15.2 安全要求
输入仅按 JSON/SSE 解析；不执行 rawEvent；不执行工具调用；不执行事件中的代码或 URL；不将事件内容作为 HTML 注入；HTML 报告中的所有用户文本必须正确转义；不加载远程脚本；不加载远程字体；不允许远程资源请求；JSON Patch 必须限制输入规模；防止深层嵌套和超大数组导致资源耗尽；Worker 必须能够取消计算；搜索超限必须返回 INCONCLUSIVE_LIMIT。
### 15.3 许可证
自有代码使用 MIT License。第三方依赖必须在最终发布前逐项核验：包名；版本；SPDX；使用位置；许可证来源。交付 THIRD_PARTY_NOTICES.md。

## 16. 验收指标
Golden 正确分类 24/24；已知故障检出 8/8；正常轨迹正确通过 16/16；False Positive 0；False Negative 0；Oracle parity 24/24；合法恢复路径收敛率 100%；确定性重放 100/100 单一哈希；最短分歧定位 100% Golden；最大轨迹 40 条事件；单轨迹性能 < 1 秒；网络请求 0；真人参与者 0；用户数据持久化 0。上述指标全部是验收要求，不是已经取得的成绩。

## 17. 交付物
最终发布包至少包含：完整 TypeScript 源码；React UI；JSONL / SSE 导入器；AG-UI 1.0 协议校验；参考 Reducer；双轨重放引擎；确定性故障注入器；BFS 搜索器；24 条 Golden 轨迹；独立 Python Oracle；自动化测试；Playwright E2E；JSON Schema；独立 HTML 导出；README；LICENSE；THIRD_PARTY_NOTICES.md；用户指南；协议边界说明；性能测试日志；离线测试日志；演示截图；REVIEW_INDEX.md；REVIEW_PACK_XX.md；RELEASE_MANIFEST.json；SHA256SUMS.txt；Git commit 和 Git bundle；源码 ZIP 和静态发布 ZIP。

## 18. 诚实边界
### 18.1 能证明什么
在给定的 AG-UI 1.0 事件子集、已导入事件序列、初始状态、快照语义、恢复游标、有界事件轨迹、固定故障注入规则范围内，RejoinLab 可以确定性证明：完整事件流产生的状态；恢复事件流产生的状态；两条路径的最终状态是否相等；是否存在消息顺序变化；是否存在工具调用重复；是否存在已知事件丢失；是否存在状态快照差异；最短故障注入序列；首个可定位的状态分歧；相同输入能否稳定产生相同报告。
### 18.2 不能证明什么
RejoinLab 不能证明：Agent 后端业务逻辑正确；Agent 模型生成内容正确；真实网络传输没有丢包；真实服务端支持断点恢复；AG-UI SDK 实现没有其他缺陷；工具只会执行一次；exactly-once 投递；真实浏览器和所有前端框架表现一致；所有可能的分布式并发交错均被覆盖；超过 40 条事件的轨迹一定安全；真实用户看到的 UI 与实验 Reducer 完全相同；用户实际节省了多少排查时间。
### 18.3 结果解释
CONSISTENT 的正确解释：在本次给定事件轨迹、Reducer 规则、快照语义和有界恢复路径中，两条计算路径得到相同的规范化状态。错误解释：这个 Agent 在所有真实网络故障下都不会丢消息或重复调用工具。INCONCLUSIVE_LIMIT 的正确解释：搜索边界不足以支持一致性结论。错误解释：没有找到错误，所以安全。
### 18.4 最终停止条件
发生以下任一情况，必须停止扩大范围：无法建立独立 Oracle；不能确定性复现 #1524 类故障；不能正确实现 AG-UI 1.0 快照语义；正常轨迹出现无法解释的误报；无法区分协议错误和展示信息损失；40 条事件内无法满足性能门槛；产品必须依赖在线 Agent 或收费 API 才能演示。
项目状态：SPECIFICATION_FROZEN_PENDING_OWNER_REVIEW / NO_CODE_BUILT。
