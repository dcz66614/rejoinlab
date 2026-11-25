/**
 * P031 RejoinLab — T008: UI 适配层测试（不含 DOM）。
 *
 * 全部用真实接口：T002 解析 + T005 双轨评估 + 24 条 Golden 样本
 * （fixtures/golden/*.json）。不使用假数据冒充分析输出。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { NormalizedEvent } from "../../src/protocol/types.js";
import {
  DEFAULT_SCENARIO,
  INJECTION_LABELS,
  OPERATOR_ORDER,
  VERDICT_LABELS,
  defaultInjection,
  describeInjection,
  detectFormat,
  importEvents,
  runAnalysis,
  type ScenarioConfig,
} from "../../src/ui/analyze.js";

function loadGolden(id: string): {
  events: NormalizedEvent[];
  recovery: {
    strategy: ScenarioConfig["strategy"];
    disconnectAfter?: number;
    resumeAfterSourceIndex?: number;
    injections?: ScenarioConfig["injections"];
  };
} {
  const raw = JSON.parse(readFileSync(`fixtures/golden/${id}.json`, "utf8")) as {
    events: NormalizedEvent[];
    recovery: {
      strategy: ScenarioConfig["strategy"];
      disconnectAfter?: number;
      resumeAfterSourceIndex?: number;
      injections?: ScenarioConfig["injections"];
    };
  };
  return raw;
}

/** 41 条事件的合法轨迹：RUN_STARTED + START + 39 段 CONTENT + END。 */
function fortyOneEvents(): NormalizedEvent[] {
  const events: NormalizedEvent[] = [
    {
      sourceIndex: 0,
      sourceEventKey: null,
      transportEventId: null,
      event: { type: "RUN_STARTED", threadId: "thread-1", runId: "run-1" },
    },
    {
      sourceIndex: 1,
      sourceEventKey: null,
      transportEventId: null,
      event: { type: "TEXT_MESSAGE_START", messageId: "msg-1", role: "assistant" },
    },
  ];
  for (let i = 0; i < 39; i += 1) {
    events.push({
      sourceIndex: 2 + i,
      sourceEventKey: null,
      transportEventId: null,
      event: { type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1", delta: "x" },
    });
  }
  events.push({
    sourceIndex: 41 - 1,
    sourceEventKey: null,
    transportEventId: null,
    event: { type: "TEXT_MESSAGE_END", messageId: "msg-1" },
  });
  return events;
}

const NORMAL_JSONL = [
  '{"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}',
  '{"type":"TEXT_MESSAGE_START","messageId":"msg-1","role":"assistant"}',
  '{"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"你好，"}',
  '{"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"世界"}',
  '{"type":"TEXT_MESSAGE_END","messageId":"msg-1"}',
  '{"type":"RUN_FINISHED","threadId":"thread-1","runId":"run-1"}',
].join("\n");

const NORMAL_SSE = [
  'id: evt-0',
  'data: {"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}',
  "",
  'id: evt-1',
  'data: {"type":"TEXT_MESSAGE_START","messageId":"msg-1","role":"assistant"}',
  "",
  'id: evt-2',
  'data: {"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"你好，世界"}',
  "",
  'id: evt-3',
  'data: {"type":"TEXT_MESSAGE_END","messageId":"msg-1"}',
  "",
  'id: evt-4',
  'data: {"type":"RUN_FINISHED","threadId":"thread-1","runId":"run-1"}',
  "",
].join("\n");

describe("detectFormat", () => {
  it("按 .sse / .jsonl 后缀识别", () => {
    expect(detectFormat("trace.sse", NORMAL_JSONL)).toBe("sse");
    expect(detectFormat("trace.jsonl", NORMAL_SSE)).toBe("jsonl");
  });

  it("无后缀时按内容嗅探（data: 行首即 SSE）", () => {
    expect(detectFormat("trace", NORMAL_SSE)).toBe("sse");
    expect(detectFormat("trace", NORMAL_JSONL)).toBe("jsonl");
    expect(detectFormat("trace.txt", NORMAL_SSE)).toBe("sse");
  });
});

describe("importEvents", () => {
  it("JSONL 导入通过：6 条事件，sourceIndex 0–5 连续", () => {
    const result = importEvents(NORMAL_JSONL, "jsonl");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toHaveLength(6);
    expect(result.events.map((e) => e.sourceIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.events[0]?.event.type).toBe("RUN_STARTED");
    expect(result.events[0]?.transportEventId).toBeNull();
  });

  it("SSE 导入通过：5 条事件，保留 SSE id 为 transportEventId", () => {
    const result = importEvents(NORMAL_SSE, "sse");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events).toHaveLength(5);
    expect(result.events[0]?.transportEventId).toBe("evt-0");
    expect(result.events[4]?.event.type).toBe("RUN_FINISHED");
  });

  it("解析器 fixture：tests/parser/fixtures/normal.jsonl 与 normal.sse 均可导入", () => {
    const jsonl = importEvents(readFileSync("tests/parser/fixtures/normal.jsonl", "utf8"), "jsonl");
    expect(jsonl.ok).toBe(true);
    const sse = importEvents(readFileSync("tests/parser/fixtures/normal.sse", "utf8"), "sse");
    expect(sse.ok).toBe(true);
    if (sse.ok) {
      expect(sse.events[0]?.transportEventId).toBe("evt-0");
    }
  });

  it("非法 JSON 行：返回诊断，带 code / sourceIndex / line，不返回部分事件", () => {
    const bad = '{"type":"RUN_STARTED","threadId":"t","runId":"r"}\n{not json}\n';
    const result = importEvents(bad, "jsonl");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics.length).toBeGreaterThan(0);
    expect(result.diagnostics[0]?.code).toBe("INVALID_INPUT");
    expect(result.diagnostics[0]?.sourceIndex).toBe(1);
    expect(result.diagnostics[0]?.line).toBe(2);
  });

  it("缺失必填字段：诊断带 eventType 与 field", () => {
    const bad = '{"type":"TEXT_MESSAGE_START"}\n';
    const result = importEvents(bad, "jsonl");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.code).toBe("INVALID_INPUT");
    expect(result.diagnostics[0]?.eventType).toBe("TEXT_MESSAGE_START");
    expect(result.diagnostics[0]?.field).toBe("messageId");
    expect(result.diagnostics[0]?.sourceIndex).toBe(0);
  });

  it("不支持的事件类型：INCONCLUSIVE_LIMIT，位置保留在诊断中", () => {
    const bad = '{"type":"RAW","data":"x"}\n';
    const result = importEvents(bad, "jsonl");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnostics[0]?.code).toBe("INCONCLUSIVE_LIMIT");
    expect(result.diagnostics[0]?.eventType).toBe("RAW");
  });
});

describe("runAnalysis（真实双轨评估）", () => {
  it("N01 正常轨迹：RESUME_FROM_CHECKPOINT 断线后恢复，裁决 CONSISTENT", () => {
    const golden = loadGolden("N01");
    const { evaluation } = runAnalysis(golden.events, {
      strategy: "RESUME_FROM_CHECKPOINT",
      disconnectAfter: golden.recovery.disconnectAfter,
      resumeAfterSourceIndex: golden.recovery.resumeAfterSourceIndex,
      injections: [],
    }, "N01");
    expect(evaluation.verdict).toBe("CONSISTENT");
    expect(evaluation.diagnostics).toHaveLength(0);
    expect(evaluation.fullPath?.finalStateHash).toBe(evaluation.resumePath?.finalStateHash);
    expect(evaluation.firstDivergence).toBeNull();
  });

  it("G01 故障轨迹 + REPLAY_PREFIX：裁决 INCONSISTENT，DUPLICATE_TOOL_CALL CRITICAL", () => {
    const golden = loadGolden("G01");
    const { evaluation } = runAnalysis(golden.events, {
      strategy: "FULL_REPLAY_FROM_START",
      disconnectAfter: 4,
      injections: [{ op: "REPLAY_PREFIX" }],
    }, "G01");
    expect(evaluation.verdict).toBe("INCONSISTENT");
    const diagnostic = evaluation.diagnostics.find((d) => d.code === "DUPLICATE_TOOL_CALL");
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.severity).toBe("CRITICAL");
    expect(evaluation.firstDivergence).not.toBeNull();
    expect(evaluation.firstDivergence?.differences.length).toBeGreaterThan(0);
  });

  it("G08 截断轨迹（fixture 自带恢复配置）：裁决 INCOMPLETE_TRACE，TRUNCATED_RUN WARNING", () => {
    const golden = loadGolden("G08");
    const { evaluation } = runAnalysis(golden.events, {
      strategy: golden.recovery.strategy,
      disconnectAfter: golden.recovery.disconnectAfter,
      resumeAfterSourceIndex: golden.recovery.resumeAfterSourceIndex,
      injections: golden.recovery.injections ?? [],
    }, "G08");
    expect(evaluation.verdict).toBe("INCOMPLETE_TRACE");
    const diagnostic = evaluation.diagnostics.find((d) => d.code === "TRUNCATED_RUN");
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.severity).toBe("WARNING");
  });

  it("41 条事件：超出 40 条上限，裁决 INCONCLUSIVE_LIMIT", () => {
    const { evaluation } = runAnalysis(fortyOneEvents(), DEFAULT_SCENARIO, "OVER-LIMIT");
    expect(evaluation.verdict).toBe("INCONCLUSIVE_LIMIT");
    expect(evaluation.fullState).toBeNull();
  });

  it("不支持的事件类型进入评估：裁决 INVALID_INPUT", () => {
    const events: NormalizedEvent[] = [
      {
        sourceIndex: 0,
        sourceEventKey: null,
        transportEventId: null,
        event: { type: "CUSTOM", data: "x" } as unknown as NormalizedEvent["event"],
      },
    ];
    const { evaluation } = runAnalysis(events, DEFAULT_SCENARIO, "BAD-TYPE");
    expect(evaluation.verdict).toBe("INVALID_INPUT");
    expect(evaluation.diagnostics[0]?.severity).toBe("CRITICAL");
  });

  it("三种恢复策略均可运行并返回 5 种裁决之一", () => {
    const golden = loadGolden("N01");
    for (const strategy of [
      "FULL_REPLAY_FROM_START",
      "RESUME_FROM_CHECKPOINT",
      "REPLAY_AFTER_SOURCE_CURSOR",
    ] as const) {
      const { evaluation } = runAnalysis(golden.events, {
        strategy,
        disconnectAfter: 2,
        injections: [],
      }, "N01");
      expect(Object.keys(VERDICT_LABELS)).toContain(evaluation.verdict);
    }
  });

  it("8 种故障注入算子全部可选：每种都能组装并运行，不抛错", () => {
    expect(OPERATOR_ORDER).toHaveLength(8);
    const golden = loadGolden("N01");
    for (const op of OPERATOR_ORDER) {
      const injection = defaultInjection(op);
      expect(injection.op).toBe(op);
      expect(describeInjection(injection).length).toBeGreaterThan(0);
      expect(INJECTION_LABELS[op].length).toBeGreaterThan(0);
      const { evaluation } = runAnalysis(golden.events, {
        strategy: "RESUME_FROM_CHECKPOINT",
        disconnectAfter: 2,
        injections: [injection],
      }, "N01");
      expect(Object.keys(VERDICT_LABELS)).toContain(evaluation.verdict);
    }
  });

  it("五种裁决都有中文标签", () => {
    expect(Object.keys(VERDICT_LABELS).sort()).toEqual([
      "CONSISTENT",
      "INCOMPLETE_TRACE",
      "INCONCLUSIVE_LIMIT",
      "INCONSISTENT",
      "INVALID_INPUT",
    ]);
    for (const label of Object.values(VERDICT_LABELS)) {
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe("runAnalysis：MESSAGE_ID_REMAP 留空字段（F1 回归）", () => {
  it("留空字段与字段 undefined 行为一致：G02 上均为 INCONSISTENT，双路径哈希不同、有 MESSAGE_REORDER 诊断", () => {
    const golden = loadGolden("G02");
    const base = {
      strategy: golden.recovery.strategy,
      disconnectAfter: golden.recovery.disconnectAfter,
      resumeAfterSourceIndex: golden.recovery.resumeAfterSourceIndex,
    } as const;
    const blank = runAnalysis(
      golden.events,
      {
        ...base,
        injections: [{ op: "MESSAGE_ID_REMAP", messageId: "", newMessageId: "" }],
      },
      "G02",
    );
    const omitted = runAnalysis(
      golden.events,
      { ...base, injections: [{ op: "MESSAGE_ID_REMAP" }] },
      "G02",
    );
    for (const result of [blank, omitted]) {
      expect(result.evaluation.verdict).toBe("INCONSISTENT");
      expect(result.evaluation.fullPath?.finalStateHash).not.toBe(
        result.evaluation.resumePath?.finalStateHash,
      );
      expect(result.evaluation.diagnostics.length).toBeGreaterThan(0);
      // 实测诊断码：重映射把消息移至末尾，T005 报 MESSAGE_REORDER
      // （CRITICAL）；仅无顺序变化的纯重命名才报 DIVERGENT_STATE
      // （见 inject.ts 的 MESSAGE_ID_REMAP 注释）。
      const diagnostic = result.evaluation.diagnostics.find(
        (d) => d.code === "MESSAGE_REORDER",
      );
      expect(diagnostic).toBeDefined();
      expect(diagnostic?.severity).toBe("CRITICAL");
    }
    // 留空与缺省跑出完全相同的双轨终态与诊断序列。
    expect(blank.evaluation.fullPath?.finalStateHash).toBe(
      omitted.evaluation.fullPath?.finalStateHash,
    );
    expect(blank.evaluation.resumePath?.finalStateHash).toBe(
      omitted.evaluation.resumePath?.finalStateHash,
    );
    expect(blank.evaluation.diagnostics.map((d) => d.code)).toEqual(
      omitted.evaluation.diagnostics.map((d) => d.code),
    );
    // 快照里留空字段已归一化为缺省（undefined）。
    expect(blank.scenario.injections[0]).toEqual({ op: "MESSAGE_ID_REMAP" });
    // 回归锚点：修复前留空注入静默不生效，与无注入完全相同
    // （同一哈希、零诊断）；修复后必须与无注入不同。注意完整路径
    // 不受注入影响（fullHash 恒为 a708422d…），分歧只体现在恢复路径。
    const noInjection = runAnalysis(
      golden.events,
      { ...base, injections: [] },
      "G02",
    );
    expect(noInjection.evaluation.verdict).toBe("CONSISTENT");
    expect(noInjection.evaluation.diagnostics).toHaveLength(0);
    expect(blank.evaluation.verdict).not.toBe(noInjection.evaluation.verdict);
    expect(blank.evaluation.resumePath?.finalStateHash).not.toBe(
      noInjection.evaluation.resumePath?.finalStateHash,
    );
  });
});
