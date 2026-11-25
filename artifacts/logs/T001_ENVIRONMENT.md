# T001 环境快照（T001_ENVIRONMENT.md）

- 任务：P031 RejoinLab T001 — 环境盘点与协议契约冻结
- 执行时间：2026-11-23 13:57–14:05 GMT（UTC）
- 执行人：T001 施工代理（全新会话）
- 仓库：`~/workspace/p031-rejoinlab`，分支 main，起始 HEAD `bd7c3d9`
- 结论：**环境可用；协议字段与版本边界已冻结；后续任务可只依赖冻结文件施工。**

## 1. 环境版本（实测，非推断）

| 组件 | 实测版本 | 核对命令 / 来源 |
|---|---|---|
| OS | Ubuntu 24.04.5 LTS (Noble Numbat)，内核 Linux 7.0.0-44-generic x86_64 | `/etc/os-release`、`uname -a` |
| CPU | AMD EPYC 9D25 126-Core Processor，VM 内可见 4 vCPU（1 线程/核） | `lscpu` |
| RAM | 7.7 GiB 总量（实测时可用约 567 MiB，Swap 1.0 GiB） | `free -h` |
| 磁盘 | /home 150G，123G 可用（19% 已用） | `df -h` |
| Node.js | **v24.22.1**（满足 Node.js 24 LTS 要求） | `node --version` |
| npm | **10.9.4** | `npm --version` |
| Python | **3.12.3**（满足 Oracle Python 3.12+ 要求） | `python3 --version` |
| git | 2.43.0 | `git --version` |
| 浏览器 | Google Chrome for Testing **159.0.8154.6**（Playwright 缓存 `chromium-1255`，`~/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome`） | `--version` 直接核对 |
| Playwright 浏览器缓存 | chromium-1248 / 1254 / 1255，chromium_headless_shell-1248 / 1254 / 1255，ffmpeg-1013 | `ls ~/.cache/ms-playwright/` |
| npm registry | 可达（`npm ping` PONG，713ms） | `npm ping` |

> 说明：本机无系统级 `chromium` / `google-chrome` 二进制；E2E（T011）使用 Playwright 自带 Chromium 159.0.8154.6，已验证存在且可执行。VM 在本次任务期间重启过（`uptime` 显示 up 24 min），环境数据为重启后重新实测。

## 2. 锁定的依赖版本（package.json / package-lock.json）

`npm install` 首次直接装最新版得到 TypeScript 7.0.2 / Vite 8.3.8，**不符合**冻结要求（TypeScript 5.x、Vite 7.x），已纠正为以下锁定版本。`package.json` 中全部使用**精确版本**（无 `^` 前缀），`package-lock.json`（lockfileVersion 3，149 个包）与之一致。

| 包 | 锁定版本 | 角色 |
|---|---|---|
| react | 19.3.1 | UI |
| react-dom | 19.3.1 | UI |
| typescript | 5.9.3 | 语言（5.x 最新 patch） |
| vite | 7.3.8 | 构建（7.x 最新 patch） |
| @vitejs/plugin-react | 5.2.0 | Vite React 插件（适配 Vite 7） |
| vitest | 4.1.12 | 单元测试（适配 Vite 7） |
| @playwright/test | 1.65.1 | E2E |
| @types/react | 19.3.0 | 类型 |
| @types/react-dom | 19.3.0 | 类型 |

`tsconfig.json`：严格模式（`strict: true`，另有 `noFallthroughCasesInSwitch`、`forceConsistentCasingInFileNames`、`isolatedModules`），`target ES2022`，`module ESNext`，`moduleResolution bundler`，`jsx react-jsx`，`noEmit: true`，`include: ["src"]`。

## 3. 安装日志摘要

执行命令（按顺序）：

```bash
npm init -y
npm install react react-dom                                  # 首次装到最新版
npm install -D typescript vite @vitejs/plugin-react vitest @playwright/test @types/react @types/react-dom
# ↑ 得到 typescript 7.0.2 / vite 8.3.8，不符合冻结要求，遂纠正：
# package.json 手工改写为精确锁定版本（见 §2），rm -rf node_modules package-lock.json 后重装
npm install
```

### 3.1 工具链问题（已解决，记录为 ADR-T001-01，无协议变更）

**现象：** 锁定版本后 `npm install` 多次失败，报错均为：

```
npm error Cannot read properties of null (reading 'edgesOut')
TypeError: Cannot read properties of null (reading 'edgesOut')
    at #loadPeerSet (.../@npmcli/arborist/lib/arborist/build-ideal-tree.js:1289:38)
```

日志显示崩溃点在解析 `@vitest/browser-playwright` 的 peer set 时（npm 10.9.4 的 arborist bug；`npm cache clean --force` 后重装仍复现，与缓存无关）。

**处理：** 改用 `npm install --legacy-peer-deps`，一次成功（`added 97 packages in 13s`）。该 flag 只改变 peer 依赖的解析方式（不自动安装 optional peer），不改变任何已锁定版本，不改变协议版本。

**复现性验证（均通过）：**

```bash
rm -rf node_modules && npm ci --legacy-peer-deps   # tsc 5.9.3，vitest 4.1.12，OK
rm -rf node_modules && npm ci                       # 无 flag 的 npm ci 同样 OK（ci 直接按 lockfile 安装，不走 ideal-tree peer 解析）
```

**后续任务注意：** 新增依赖时 `npm install` 仍可能触发同一 arborist 报错，届时用 `npm install --legacy-peer-deps`；`npm ci`（T007 验收用）无此问题。新增依赖后必须重新核对锁定版本仍在冻结大版本内（TS 5.x / Vite 7.x / React 19.x）。

## 4. 验收命令真实输出

```text
$ node --version
v24.22.1

$ npm --version
10.9.4

$ python3 --version
Python 3.12.3

$ npm run typecheck

> rejoinlab@1.0.0 typecheck
> tsc --noEmit

TYPECHECK_EXIT: 0
```

- `npm run typecheck` 退出码 **0**，无输出（无类型错误）。
- typecheck 覆盖 `src/protocol/types.ts`（冻结类型定义，11,992 B），此时无其他业务代码（符合任务要求：不创建 T002–T005 的 src 业务代码）。

## 5. 协议来源核对记录（T001 实测）

| 核对项 | 结果 | 证据 |
|---|---|---|
| AG-UI 1.0 JSON Schema | HTTP 200，94,359 B，SHA-256 `4b5c93226838a0e72d88e6c5df20633c686c49fcb75d9be2815c6cbf9e48e71a`；本地冻结副本 `docs/ag-ui-1.0-schema.json` 与取回文件同一哈希 | `curl https://docs.ag-ui.com/spec/1.0/schema.json`，2026-11-23 |
| AG-UI 1.0 发布日期 2026-09-18 | 确认。发布讨论 #2792 创建于 **2026-09-18T15:02:00Z**，标题 "AG-UI 1.0 is officially released" | `curl https://github.com/ag-ui-protocol/ag-ui/discussions/2792`，2026-11-23 |
| HTTP+SSE 无恢复机制 | 确认。规范原文："The binding has no stream resumption: SSE's Last-Event-ID mechanism is not used, and a broken stream cannot be re-entered. Re-running is a new run with a new runId, whose input carries whatever the consumer retained."；"A connection that drops without a terminal event is a truncated run."；"A consumer MUST ignore SSE fields other than data (event:, id:, retry:)" | https://docs.ag-ui.com/spec/1.0/basic/transports/http-sse ，2026-11-23 |
| Chunk 展开规则 | 确认。规范原文："A consumer MUST expand them into the start/content/end form before verification and before application code"；首块 `TEXT_MESSAGE_CHUNK` 必须带 `messageId`，首块 `TOOL_CALL_CHUNK` 必须带 `toolCallId` + `toolCallName`；两种写法不得在同一项内混合；合成 `*_END` 的触发条件已写入 `docs/EVENT_SCHEMA.md` §4.5 | https://docs.ag-ui.com/spec/1.0/basic/patterns/streaming ，2026-11-23 |
| 快照 / delta 规则 | 确认。快照整体替换（非合并）；delta 为 RFC 6902、有序、原子；无基线不得发 delta；结构合法但无法应用时不得保留部分结果，必须浮现失败 | https://docs.ag-ui.com/spec/1.0/basic/patterns/snapshots ，2026-11-23 |
| 15 事件字段必填/可选 | 逐字段核对 Schema `required` 数组（见 `docs/EVENT_SCHEMA.md` 各表）；发现 1 项与项目书文字不一致（D-01，`RUN_FINISHED` 的 `threadId`/`runId`），已按 Schema 冻结并记录 | Schema `$defs` 全量解析，2026-11-23 |
| `eventId` 不存在 | 确认。`BaseEvent` 只有 `type` / `timestamp` / `rawEvent` / `metadata`；15 事件定义中无 `eventId`；`subagentRunId` 只在 Subagent 相关事件上 | Schema `$defs` 全量解析，2026-11-23 |

## 6. 输出文件清单

| 文件 | 字节数 | 说明 |
|---|---|---|
| `package.json` | 525 | 精确锁定版本 + `typecheck` 脚本 |
| `package-lock.json` | 75,692 | lockfileVersion 3，149 个包 |
| `tsconfig.json` | 428 | 严格模式 |
| `src/protocol/types.ts` | 11,992 | AG-UI 1.0 15 事件冻结类型 + `NormalizedEvent` + `RecoveryCheckpoint`（仅类型定义，无业务逻辑） |
| `docs/AGUI_SCOPE.md` | 11,783 | 协议版本、15 事件清单、不支持清单、三类标识符边界、无恢复机制事实、证据来源 |
| `docs/EVENT_SCHEMA.md` | 23,102 | 15 事件逐字段表、chunk 展开规则、STATE_DELTA 原子性、MESSAGES_SNAPSHOT 四条协调规则、TOOL_CALL_RESULT 生命周期修正、与项目书的 4 项差异（§8） |
| `docs/ag-ui-1.0-schema.json` | 94,359 | AG-UI 1.0 Schema 冻结副本（SHA-256 见 §5） |
| `artifacts/logs/T001_ENVIRONMENT.md` | 本文件 | 环境快照 |
| `.gitignore` | 186 | 忽略 `node_modules/`、`dist/` 等（T001 附加，非任务卡列出，防误提交） |

未创建 `src/` 业务代码（T002–T005 的 parser / core / replay 不在本次范围）；未修改 `01_project_book/`、`02_implementation_plan/`、`00_control/` 下的任何已冻结文件（`git status` 中 `00_control/PROJECT_STATE.md` 的修改在 T001 开始前已存在，非本次改动）；未执行 `git commit`（由协调员统一提交）。

## 7. 与规格不一致或无法确定的点（向协调员汇报）

1. **D-01（已解决，按 Schema 冻结）：** 项目书 §3.4 称 `RUN_FINISHED` 必填只有 `type`，但 Schema 要求 `type` + `threadId` + `runId`。已按 Schema 冻结（`src/protocol/types.ts` 与 `docs/EVENT_SCHEMA.md` §3.2、§8）。T002 校验须按此执行；如终审认为项目书文字优先，需由终审裁决，不得由施工方自行改回。
2. **D-02（已解决，分层执行）：** chunk 首块必填（`messageId` / `toolCallId` + `toolCallName`）是规范 prose 要求，Schema `required` 只含 `type`。冻结为两层校验：Schema 层只要求 `type`，协议层按 prose 要求首块字段（见 `docs/EVENT_SCHEMA.md` §8）。
3. **D-03（记录在案）：** `MESSAGES_SNAPSHOT` 四条协调规则的具体表述来自项目书 §3.17 冻结；Schema 描述只佐证“完整集合、对话范围、不是简单覆盖”，未逐条列出四条。T001 未能从官方站单独取回逐条对应的 prose 页（只取回 Snapshots and Deltas 总则页），四条规则按项目书冻结执行；如独立复核或终审对某条提出异议，以终审裁决为准。
4. **D-04（已解决）：** 项目书 §3.1“部分事件允许 `subagentRunId`”未指明事件；经 Schema 核对，`subagentRunId` 只在 Subagent 相关事件上，15 种 MVP 事件均无此字段，冻结类型中不含它（见 `docs/EVENT_SCHEMA.md` §7、§8）。
5. **工具链 ADR-T001-01：** npm 10.9.4 arborist `edgesOut` 崩溃，见 §3.1。只影响依赖安装方式，不影响协议、版本或代码。`npm ci` 不受影响。
6. **浏览器版本说明：** 本机无系统级 Chrome；E2E 以 Playwright 缓存 Chromium 159.0.8154.6 为准（见 §1）。T011 如需系统浏览器，需另行说明。
7. **内存说明：** 实测时 VM 可用内存约 567 MiB（总 7.7 GiB，大部分被其他进程占用）；本次任务未受影响，但后续构建/测试如遇内存不足，应先查当时可用内存再排查。
