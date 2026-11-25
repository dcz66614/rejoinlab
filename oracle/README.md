# P031 RejoinLab — Python 独立 Oracle（T006）

独立实现，只读冻结规格（PROJECT_BOOK.md v1.0.2、IMPLEMENTATION_PLAN.md
v1.0.2、docs/AGUI_SCOPE.md、docs/EVENT_SCHEMA.md、src/protocol/types.ts），
只用 Python 3.12+ 标准库。不 import、不读取任何生产 TypeScript 输出；
Golden expected 全部手工推导，见 `golden_expected.json`。

## 文件

- `reference.py` — 独立事件归约（Reducer）：chunk 展开、RUN/消息/工具调用
  生命周期、MESSAGES_SNAPSHOT 四条协调规则 + 按角色自撤销、RFC 6902
  JSON Patch 原子应用、pending 工具调用、诊断（§6）。
- `canonical.py` — RFC 8785 JCS 规范化 + SHA-256（独立实现）。
- `replay.py` — 双轨恢复（FULL_REPLAY / RESUME_FROM_CHECKPOINT /
  REPLAY_AFTER_SOURCE_CURSOR）、8 种故障注入、BFS 最短注入序列
  （固定字典序）、诊断分类、五种裁决、首个分歧定位。
- `golden_expected.json` — 24 条 Golden 的手工推导预期（verdict、诊断代码、
  首个分歧 sourceIndex、终态关键字段、最短注入序列、逐条推导依据）。
- `generate_goldens.py` — 夹具序列化脚本：内含手工写定的 24 条轨迹数据，
  仅负责补 NormalizedEvent 包装并写出 `fixtures/golden/*.json`。
- `run_goldens.py` — 运行器：跑 24 条 Golden 并与手工 expected 比对，
  输出 `artifacts/logs/T006_ORACLE.log`。它只做比对，绝不生成 expected。
- `tests/` — Oracle 自身测试（`python -m pytest -q oracle/tests`）。

## 夹具格式（fixtures/golden/*.json）

```json
{
  "schema": "rejoinlab.golden/v1",
  "scenarioId": "G01",
  "title": "...",
  "specRef": "PROJECT_BOOK §9.2 G01; AG-UI #1524",
  "events": [{"sourceIndex": 0, "sourceEventKey": null,
              "transportEventId": null, "event": {...}}],
  "recovery": {
    "strategy": "FULL_REPLAY_FROM_START",
    "disconnectAfter": 4,
    "resumeAfterSourceIndex": 0,
    "checkpoint": null,
    "injections": []
  }
}
```

`recovery.checkpoint` 三种形式：

- `null` — 由断线点之前的前缀折叠算出（合法检查点）；
- `{"empty": true}` — 空初始状态（N06：从空状态完整重放）；
- 显式状态片段 — 故障检查点本身就是故障证据（G02 的换 ID 快照、
  G03 的合并段快照、G06 的陈旧共享状态快照、N16 的仅共享状态覆盖）。
  未声明的字段按 `coverage` 回退到前缀折叠：
  `coverage.messages == false` 时消息保留前缀折叠结果（N16）。

## 运行

```sh
python -m pytest -q oracle/tests            # Oracle 自身测试
python -m oracle.run_goldens               # 24 条 Golden 比对 + 写日志
python oracle/generate_goldens.py          # 重新序列化夹具（数据已手工写定）
```

## 已记录的判断点（供独立复核）

1. BFS 的目标是复现该条 Golden 的**主诊断代码**，不是“任意分歧”
   （任意分歧几乎总被 DROP_EVENT 触发，无法说明被测故障；项目书
   §13.3 的 G01 示例也是 `["REPLAY_PREFIX"]`）。正常轨迹的目标才是
   任意分歧。
2. G08 没有干净基线：轨迹本身在终止事件前就截断了，空注入序列已
   产生 TRUNCATED_RUN，因此最短序列为 `[]`。
3. `MESSAGE_ID_REMAP` 对消息做一致重命名（基线状态 + 恢复流中的
   所有引用）并把它移到消息列表末尾，模拟 #3119 的协调行为
   （新 ID 追加到末尾）；仅改名不改顺序时只算 DIVERGENT_STATE。
4. `CURSOR_SKIP` 的规范形式只跳过已被检查点覆盖的事件，是合法
   no-op；跳过未覆盖事件属于 DROP_EVENT。
5. `STALE_SNAPSHOT` 需要轨迹里存在更早的 STATE_SNAPSHOT 才能
   “陈旧”；没有快照时该算子不适用（no-op）。
6. 工具调用的合法重开（新事件、sourceIndex 超过检查点）与重放重复
   （sourceIndex ≤ 检查点，或同一折叠内重复出现）由 Reducer 区分；
   文本消息 START 在已打开消息上的重放是无害 no-op。
7. 无稳定事件 ID 时，相同负载再次应用不会被去重，而是追加并标记
   SUSPECTED_DUPLICATE（项目书 §4.3）；N14（不同 messageId/不同
   sourceEventKey 的相同文本）不受此影响。
8. 扩展诊断码 `UNKNOWN_PATCH_OP`、`LIMIT_EXCEEDED`、`INVALID_INPUT`
   不在项目书 §6 目录内，仅用于 §6.2 未定义 Patch 操作的丢弃告警、
   §8.1 越界，以及 INVALID_INPUT 裁决路径自身的诊断码（与裁决同名，
   含义明确）；三者均已在代码中注明。注意：§6 的 `DIVERGENT_STATE`
   只指“双轨终态 canon 不相等”，不得用于格式错误。
9. 本次只做 Oracle 自身 + 24 条 Golden + 手工 expected；与生产实现的
   字段级 parity（`npm run test:oracle` 接线）属于 T007，待生产实现
   就绪后进行。
10. 不支持的事件类型（STEP_*/REASONING_*/ACTIVITY_*/SUBAGENT_*/
    RAW/CUSTOM）按 §7 属于无法解析的协议事件，裁决为 INVALID_INPUT，
    不得复用 §8.1 的 LIMIT_EXCEEDED / INCONCLUSIVE_LIMIT；真正的规模
    越界（事件数 > 40、BFS 节点 > 5000）仍走 LIMIT_EXCEEDED /
    INCONCLUSIVE_LIMIT 不变。
11. 夹具审计记录（G03/N16 原始错误，已修正，见
    `golden_expected.json` 各条的推导依据）：
    - G03 原先漏了工具调用前的 TEXT_MESSAGE_END，消息实际从未关闭，
      “重开”成了 no-op；修正后首个分歧由 9 变为 10。
    - N16 的 disconnectAfter=4 与只覆盖到 index 3 的检查点不一致，
      导致 TEXT_END(4) 被夹具自己丢了；修正后与 §9.3 一致。
12. pytest 前置条件：本机原无 pytest，已用 `pip install --user`
    装 pytest 9.2.0；Oracle 本体仅用 Python 3.12 标准库，pytest
    只用于测试。T007 在同一 VM 跑同一命令无需重装；换机/重建 VM
    需重新安装，且无 requirements 文件 pin 版本。
