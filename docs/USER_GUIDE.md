# 用户指南 — RejoinLab（续流证）

> 规格：PROJECT_BOOK.md v1.0.2。运行方式：本地静态 Web 应用，离线，不上传文件。
> 本指南只讲“怎么用”；算法细节见 `docs/ALGORITHM.md`，模型契约见
> `docs/MODEL_CONTRACT.md`，已知限制见 `docs/LIMITATIONS.md`。

## 1. 安装与启动

环境要求：Node.js ≥ 24，npm。Python 3.12+ 只在运行独立 Oracle 时需要。

```bash
npm ci            # 安装依赖（唯一需要联网的步骤）
npm run dev       # 开发服务器，默认 http://localhost:5173
npm run build     # 生产构建，产物在 dist/
npx vite preview --port 4173   # 预览构建产物
```

如果 `localhost` 在你的机器上解析异常（例如只解析到 IPv6 而服务只监听 IPv4），
用显式地址启动：`npx vite --port 5199 --host 127.0.0.1`。
已验证：`npm run build` 约 2–5 秒完成（单次实测，逐轮波动；59 个模块，Worker chunk 58.73 kB）；
`npm run dev` 返回 HTTP 200，页面标题 `RejoinLab — 续流证`。

## 2. 导入一条事件流

主界面接受 `.jsonl`、`.sse`、`.txt` 文件（拖放或点击选择）。

### 2.1 JSONL：每行一个 AG-UI 事件

每行是一个原始 AG-UI 1.0 事件 JSON 对象；`sourceIndex` 由导入顺序自动分配
（不要用 `timestamp` 排序，时间戳不是顺序依据）。下面是最小可用示例
（对应 Golden G01 的 9 条事件，一个工具调用被重复重放的故障轨迹）：

```jsonl
{"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}
{"type":"TEXT_MESSAGE_START","messageId":"msg-1"}
{"type":"TOOL_CALL_START","toolCallId":"call-1","toolCallName":"search","parentMessageId":"msg-1"}
{"type":"TOOL_CALL_ARGS","toolCallId":"call-1","delta":"{\"q\":\"weather\"}"}
{"type":"TOOL_CALL_END","toolCallId":"call-1"}
{"type":"TOOL_CALL_RESULT","messageId":"msg-r1","toolCallId":"call-1","content":"sunny"}
{"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"It is sunny."}
{"type":"TEXT_MESSAGE_END","messageId":"msg-1"}
{"type":"RUN_FINISHED","threadId":"thread-1","runId":"run-1"}
```

### 2.2 SSE：`data:` 行是事件，`id:` 行只作证据保留

```sse
id: 100
data: {"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}

data: {"type":"TEXT_MESSAGE_START","messageId":"msg-1"}
data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"Hello, "}
```

多行 `data:` 按 SSE 规范用 `\n` 连接。`id:` 字段会原样保留为
`transportEventId`，但**不**把它当成 AG-UI 事件 ID 或恢复游标
（AG-UI 1.0 的 HTTP+SSE 绑定不支持流恢复，见 `docs/MODEL_CONTRACT.md` §4）。

### 2.3 导入限制

| 限制 | 值 | 超限结果 |
|---|---|---|
| 文件总大小 | 1 MiB | 拒绝导入 |
| 单个事件 | 64 KiB | 拒绝导入 |
| 事件数 | 40 条（含快照与断线标记） | 第 41 条起 → `INCONCLUSIVE_LIMIT` |
| 不支持的事件类型 | STEP_* / REASONING_* / ACTIVITY_* / SUBAGENT_* / RAW / CUSTOM / 未列出的 draft | `INCONCLUSIVE_LIMIT` 或 `INVALID_INPUT`，指出位置和类型 |

`fixtures/golden/` 下的 24 条 Golden 是测试语料（`rejoinlab.golden/v1` JSON，
含 `sourceIndex` 包装），用 `npm run test:oracle` 运行，**不是**直接导入 UI
的文件格式。`fixtures/examples/`（计划 §4.1 所列的手写 JSONL/SSE 示例）
本次未交付，见 `docs/LIMITATIONS.md` L-T013-02；用上面 2.1/2.2 的示例即可上手。

## 3. 配置一次实验

1. **断线位置**：选择在第几个源事件之后断开（`DISCONNECT_AFTER(i)`）。
   已交付事件保留，未交付事件不进入客户端状态；不虚构 `RUN_ERROR`，
   不虚构 `RUN_FINISHED`，原 run 视为可能被截断。
2. **恢复策略**（三选一）：
   - `FULL_REPLAY_FROM_START`：从头重新发送全部历史事件，检查已有状态是否能安全接受历史重放。
   - `RESUME_FROM_CHECKPOINT`：从检查点恢复消息和状态，然后应用其后的事件。
   - `REPLAY_AFTER_SOURCE_CURSOR`：用本地 `sourceIndex` 游标确定下一条待应用事件。
3. **故障注入**（可选，8 种算子，可组合，BFS 最深 3 步）：
   `DUPLICATE_EVENT`（重复）、`DROP_EVENT`（丢失）、`SWAP_ADJACENT`（交换相邻）、
   `STALE_SNAPSHOT`（陈旧快照）、`REPLAY_PREFIX`（重放已处理的前缀）、
   `MESSAGE_ID_REMAP`（快照中改消息 ID）、`CURSOR_SKIP`（跳过一段 sourceIndex）、
   `TRUNCATE_STREAM`（在终止事件前截断）。
4. 点击**运行**：分析在 Web Worker 中执行，可取消；取消后无结果，旧 job 的结果
   不会覆盖新输入的分析。

## 4. 读报告

### 4.1 双轨时间线

上轨是完整事件流，下轨是断线恢复事件流。快照用竖向标记，断线点用醒目的分隔标记，
分歧点有文字和位置说明（不只依赖颜色：CRITICAL 红色、WARNING 黄色，同时有文字）。

点击事件定位源 JSON；点击消息高亮所有相关 messageId 事件；点击工具调用高亮
START / ARGS / END / RESULT；点击分歧点显示两侧状态；点击诊断代码展开触发条件。
可以逐事件回放、切换恢复策略、改变断线点、修改合成样本、清空当前导入内容。

### 4.2 五种裁决

| 裁决 | 含义 | 正确理解 |
|---|---|---|
| `CONSISTENT` | 双轨规范化状态相等，无 CRITICAL | 在本次给定轨迹、规则和有界路径中两条路径一致。**不是**“这个 Agent 在所有真实网络故障下都不会丢消息”。 |
| `INCONSISTENT` | 双轨状态不同，或出现可证实的关键故障 | 看诊断代码与首个分歧定位根因。 |
| `INCONCLUSIVE_LIMIT` | 超出计算边界（事件、节点、时间） | 搜索边界不足以支持一致性结论。**不是**“没有找到错误，所以安全”。 |
| `INVALID_INPUT` | JSON/SSE 格式错误、必需字段缺失、无法解析的协议事件 | 检查导入文件与事件字段。 |
| `INCOMPLETE_TRACE` | 缺少必要终止信息、检查点覆盖不足、无法确认恢复完整性 | 不得降级为 CONSISTENT。 |

`SUSPECTED_DUPLICATE`（WARNING）可以与 `CONSISTENT` 同时出现，但必须在报告中显示警告：
没有可靠事件 ID 时，相同内容再次出现只能标“疑似重复”，绝不自动去重。

### 4.3 十种诊断代码

| 代码 | 级别 | 含义 |
|---|---|---|
| `DUPLICATE_TOOL_CALL` | CRITICAL | 已有调用在恢复重放后被再次插入（证据：toolCallId、parentMessageId、两次 START 的 sourceIndex）。 |
| `LOST_EVENT` | CRITICAL | 已知完整轨迹中的事件没有进入恢复分支，且导致状态缺失。 |
| `OUT_OF_ORDER` | CRITICAL | 事件依赖顺序错误，例如 CONTENT 先于 START。 |
| `MESSAGE_REORDER` | CRITICAL | 最终消息顺序与有效事件交错顺序不一致。 |
| `SNAPSHOT_MISMATCH` | CRITICAL | 快照内容与对应前缀状态不一致，或恢复基线错误。 |
| `DIVERGENT_STATE` | CRITICAL | 双轨终态 canon 不相等（附两个状态哈希与 JSON Pointer 差异路径）。 |
| `SUSPECTED_DUPLICATE` | WARNING | 没有可靠事件 ID，仅发现相同事件负载在重放窗口内再次出现。 |
| `TOOL_CALL_ID_REUSE` | WARNING | 同一 toolCallId 被关联到不同调用上下文。 |
| `TRUNCATED_RUN` | WARNING | 流在终止事件前结束。 |
| `MISSING_TERMINAL` | WARNING | 完整性检查发现没有可确认的 run 终态。 |

诊断不得越权：相同文本不直接判成重复事件；消息 ID 合法重新打开不判为错误；
前端工具没有同 run 结果不判为错误；时间戳较早的事件不强制移动到前面。

### 4.4 导出

- **JSON**：`rejoinlab.report/v1`（`scenarioId`、裁决、双轨终态哈希、首个分歧、
  诊断、 最短注入序列、`metrics`、`assumptions`、`limitations`）。
  注意一个已知偏差：当输入本身无效或事件数超限、根本没有双轨终态时，
  `fullPath` / `resumePath` 记为 `null`（不伪造空路径），见
  `docs/LIMITATIONS.md` L-T010-01；`shortestInjectionSequence` 未得出时记为 `[]`。
- **HTML**：独立自包含报告，无远程资源（无 link/script/img/iframe、无 href/src、
  无 http 字符串），可 `file://` 单独打开；用户文本全部转义。

## 5. 动手示例：复现 G01（重复工具调用，AG-UI #1524）

1. 把 §2.1 的 9 行 JSONL 保存为 `g01.jsonl`，导入。
2. 断线位置选“第 4 个事件后”（`DISCONNECT_AFTER(4)`），恢复策略选
   `FULL_REPLAY_FROM_START`。
3. 运行。预期结果：裁决 `INCONSISTENT`；诊断 `DUPLICATE_TOOL_CALL`（CRITICAL，
   sourceIndex 2）；首个分歧 sourceIndex 4（按 §8.6 步进比较定义）；
   最短注入序列 `["REPLAY_PREFIX"]`。
4. 对照：`fixtures/golden/G01.json` 是同一轨迹的测试语料；
   `npm run test:oracle` 对 24 条 Golden 逐值核对（24/24）。

## 6. 隐私与清空

- 导入的文件不上传、不联网、不写 localStorage、不写 IndexedDB、不在服务端保存。
- “清空”会清除内存中的原始事件、状态和导出引用；清空后事件数为 0，
  localStorage 仍为 0，页面无导入内容残留（T012 隐私验证实测）。
- 报告导出（JSON/HTML）是你主动下载的文件，下载后由你自己保管。

## 7. 故障排查

| 现象 | 原因与做法 |
|---|---|
| 导入后裁决 `INCONCLUSIVE_LIMIT`，诊断含 `LIMIT_EXCEEDED` | 事件超过 40 条，或 BFS 超过 5,000 节点，或单轨迹超过 1,000 ms。缩短轨迹或拆分文件。 |
| 导入后裁决 `INVALID_INPUT` | JSON/SSE 格式错误或必需字段缺失；检查报错指出的行号与事件位置。 |
| 不支持的事件类型被标记 | STEP_* / REASONING_* / ACTIVITY_* / SUBAGENT_* / RAW / CUSTOM 不在 MVP 子集内；删掉或替换这些事件后重导。 |
| `npm run dev` 打开 `localhost:5173` 无响应 | `localhost` 可能只解析到 IPv6；改用 `npx vite --port 5199 --host 127.0.0.1`（已实测 HTTP 200）。 |
| `npx vite preview` 报 4173 端口已被占用 | 之前某次验证留下的 `vite preview` 进程未退出；按 PID 杀掉后重跑（T012 验证曾留下 PID 7714，已由主聊天清理）。 |
| `npx vitest run` 报错 | 应已修复：`vitest.config.ts` 排除 `tests/e2e/**`；若仍失败，见 L-T013-01。E2E 永远用 `npm run test:e2e`。 |
| 性能数字每次运行不一样 | 正常：冷启动波动。40 事件轨迹 analyze 在多次运行中为 19–77 ms，远低于 1,000 ms 门槛；不要拿单次最好成绩当结论。 |

## 8. 界面与可访问性

- 桌面优先，四区布局：顶部控制区、左侧源事件流、中央双轨时间线、右侧状态与诊断。
- 键盘可以完成导入、运行、暂停、逐步回放和导出；重要状态同时提供文本。
- 深色和浅色主题适配；390px 窄屏下改为纵向布局；不使用远程字体；不请求外部图标资源。
- 已知：500px 视口仍走双列布局（断点 480px），见 L-T011-02。
