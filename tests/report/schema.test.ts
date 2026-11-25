/**
 * T010 tests — rejoinlab.report/v1 冻结 Schema 与校验器。
 *
 * 对照 PROJECT_BOOK.md v1.0.1 §13.2：类型字段集、必填项、
 * additionalProperties: false 的等价检查、哈希格式、五种裁决、
 * 两种严重级别、8 种注入算子；T007 A-07 的多余字段（kind /
 * eventType / messageId / toolCallId / runId / note）必须被拒。
 */
import { describe, expect, it } from "vitest";
import {
  isJsonValue,
  REJOIN_REPORT_JSON_SCHEMA,
  REPORT_ASSUMPTIONS,
  REPORT_LIMITATIONS,
  REPORT_SCHEMA_ID,
  toJsonValue,
  validateReport,
} from "../../src/report/schema.js";

const HEX64 = "a".repeat(64);

function validReport(): Record<string, unknown> {
  return {
    schema: "rejoinlab.report/v1",
    specVersion: "1.0.2",
    protocolVersion: "1.0",
    scenarioId: "G01",
    verdict: "INCONSISTENT",
    input: {
      sourceFormat: "JSONL",
      eventCount: 6,
      sourceSha256: HEX64,
    },
    recovery: {
      strategy: "FULL_REPLAY_FROM_START",
      disconnectAfter: 4,
      resumeAfterSourceIndex: 0,
    },
    fullPath: {
      finalStateHash: "b".repeat(64),
      messages: [],
      toolCalls: [{ id: "call-1" }],
      sharedState: {},
      pendingToolCallIds: [],
    },
    resumePath: {
      finalStateHash: "c".repeat(64),
      messages: [],
      toolCalls: [{ id: "call-1" }, { id: "call-1" }],
      sharedState: {},
      pendingToolCallIds: [],
    },
    firstDivergence: {
      sourceIndex: 2,
      fullStateHash: "b".repeat(64),
      resumeStateHash: "c".repeat(64),
      differences: [
        {
          jsonPointer: "/toolCalls/1/toolCallId",
          expected: null,
          actual: "call-1",
        },
      ],
    },
    diagnostics: [
      {
        code: "DUPLICATE_TOOL_CALL",
        severity: "CRITICAL",
        sourceIndex: 2,
        relatedSourceIndices: [2, 5],
        message: "同一工具调用在恢复路径中被重复添加",
        evidence: { toolCallId: "call-1" },
      },
    ],
    shortestInjectionSequence: ["REPLAY_PREFIX"],
    metrics: { durationMs: 12, visitedStates: 8 },
    assumptions: ["使用 AG-UI 1.0 事件语义"],
    limitations: ["不证明真实 Agent 后端 exactly-once"],
  };
}

describe("冻结 Schema 常量", () => {
  it("Schema 标识为 rejoinlab.report/v1，版本与 §13.2 一致", () => {
    expect(REPORT_SCHEMA_ID).toBe("rejoinlab.report/v1");
    const report = validReport();
    expect(validateReport(report).ok).toBe(true);
  });

  it("JSON Schema 对象的 $id 与标识一致，顶层禁止附加属性", () => {
    expect(REJOIN_REPORT_JSON_SCHEMA.$id).toBe("rejoinlab.report/v1");
    expect(REJOIN_REPORT_JSON_SCHEMA.additionalProperties).toBe(false);
    const required = REJOIN_REPORT_JSON_SCHEMA.required as readonly string[];
    expect(required).toContain("schema");
    expect(required).toContain("fullPath");
    expect(required).toContain("shortestInjectionSequence");
    expect(required).toContain("metrics");
    // firstDivergence 是可选字段，不在 required 中。
    expect(required).not.toContain("firstDivergence");
  });

  it("冻结的假设与局限说明非空且全为字符串", () => {
    expect(REPORT_ASSUMPTIONS.length).toBeGreaterThan(0);
    expect(REPORT_LIMITATIONS.length).toBeGreaterThan(0);
    for (const text of [...REPORT_ASSUMPTIONS, ...REPORT_LIMITATIONS]) {
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    }
    expect(REPORT_ASSUMPTIONS).toContain("使用 AG-UI 1.0 事件语义");
    expect(REPORT_LIMITATIONS).toContain("不证明真实 Agent 后端 exactly-once");
  });
});

describe("validateReport 接受合法报告", () => {
  it("§13.3 样例形状的合法报告通过", () => {
    expect(validateReport(validReport())).toEqual({ ok: true, errors: [] });
  });

  it("无 firstDivergence 的一致报告通过", () => {
    const report = validReport();
    delete report["firstDivergence"];
    report["verdict"] = "CONSISTENT";
    report["diagnostics"] = [];
    report["shortestInjectionSequence"] = ["DROP_EVENT"];
    expect(validateReport(report).ok).toBe(true);
  });

  it("路径为 null 的无效输入报告通过（无终态不是捏造空路径）", () => {
    const report = validReport();
    report["verdict"] = "INVALID_INPUT";
    report["fullPath"] = null;
    report["resumePath"] = null;
    delete report["firstDivergence"];
    report["diagnostics"] = [
      {
        code: "INVALID_INPUT",
        severity: "CRITICAL",
        message: "unsupported event type",
        evidence: {},
      },
    ];
    report["shortestInjectionSequence"] = [];
    expect(validateReport(report).ok).toBe(true);
  });

  it("五种裁决全部通过", () => {
    for (const verdict of [
      "CONSISTENT",
      "INCONSISTENT",
      "INCONCLUSIVE_LIMIT",
      "INVALID_INPUT",
      "INCOMPLETE_TRACE",
    ]) {
      const report = validReport();
      report["verdict"] = verdict;
      expect(validateReport(report).ok).toBe(true);
    }
  });
});

describe("validateReport 拒绝非法报告", () => {
  it("错误的 Schema 标识", () => {
    const report = validReport();
    report["schema"] = "rejoinlab.report/v2";
    const result = validateReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("report.schema");
  });

  it("缺失必填字段 metrics.visitedStates", () => {
    const report = validReport();
    const metrics = report["metrics"] as Record<string, unknown>;
    delete metrics["visitedStates"];
    const result = validateReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("report.metrics");
  });

  it("顶层多余字段", () => {
    const report = validReport();
    report["extra"] = 1;
    const result = validateReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("unexpected key");
  });

  it("metrics 多余字段", () => {
    const report = validReport();
    (report["metrics"] as Record<string, unknown>)["bfsVisited"] = 3;
    const result = validateReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("report.metrics");
  });

  it("PathResult 多余 runStatus 字段（§13.2 无此字段）", () => {
    const report = validReport();
    (report["fullPath"] as Record<string, unknown>)["runStatus"] = "FINISHED";
    const result = validateReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("report.fullPath");
  });

  it("非法裁决", () => {
    const report = validReport();
    report["verdict"] = "MAYBE";
    expect(validateReport(report).ok).toBe(false);
  });

  it("非法严重级别", () => {
    const report = validReport();
    const diagnostics = report["diagnostics"] as Record<string, unknown>[];
    diagnostics[0]!["severity"] = "INFO";
    expect(validateReport(report).ok).toBe(false);
  });

  it("§13.3 样例的占位符 sourceSha256 不是合法报告哈希", () => {
    const report = validReport();
    (report["input"] as Record<string, unknown>)["sourceSha256"] =
      "fixture-sha256";
    const result = validateReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("sourceSha256");
  });

  it("非 64 位十六进制的状态哈希", () => {
    const report = validReport();
    (report["fullPath"] as Record<string, unknown>)["finalStateHash"] =
      "xyz";
    expect(validateReport(report).ok).toBe(false);
  });

  it("A-07：differences 多余 kind 字段", () => {
    const report = validReport();
    const firstDivergence = report["firstDivergence"] as Record<
      string,
      unknown
    >;
    const differences = firstDivergence["differences"] as Record<
      string,
      unknown
    >[];
    differences[0]!["kind"] = "added";
    const result = validateReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("differences[0]");
  });

  it("A-07：firstDivergence 多余 eventType / note 字段", () => {
    const report = validReport();
    const firstDivergence = report["firstDivergence"] as Record<
      string,
      unknown
    >;
    firstDivergence["eventType"] = "TOOL_CALL_START";
    firstDivergence["note"] = "no resume entry at this index";
    const result = validateReport(report);
    expect(result.ok).toBe(false);
    expect(result.errors.join("\n")).toContain("firstDivergence");
  });

  it("最短序列含未知算子", () => {
    const report = validReport();
    report["shortestInjectionSequence"] = ["RETRY_NETWORK"];
    expect(validateReport(report).ok).toBe(false);
  });

  it("非对象报告、空假设、负数 eventCount", () => {
    expect(validateReport(null).ok).toBe(false);
    expect(validateReport("x").ok).toBe(false);
    const emptyAssumptions = validReport();
    emptyAssumptions["assumptions"] = [];
    expect(validateReport(emptyAssumptions).ok).toBe(false);
    const negativeCount = validReport();
    (negativeCount["input"] as Record<string, unknown>)["eventCount"] = -1;
    expect(validateReport(negativeCount).ok).toBe(false);
  });
});

describe("toJsonValue / isJsonValue", () => {
  it("丢弃 undefined 键，数组 undefined 元素记为 null，深拷贝", () => {
    const input = {
      a: 1,
      b: undefined,
      c: [1, undefined, { d: undefined, e: "x" }],
    };
    const cleaned = toJsonValue(input) as Record<string, unknown>;
    expect(cleaned).toEqual({ a: 1, c: [1, null, { e: "x" }] });
    (cleaned["c"] as unknown[])[0] = 99;
    expect((input["c"] as unknown[])[0]).toBe(1);
  });

  it("拒绝非 JSON 值", () => {
    expect(isJsonValue(undefined)).toBe(false);
    expect(isJsonValue(Number.NaN)).toBe(false);
    expect(isJsonValue(() => 1)).toBe(false);
    expect(isJsonValue({ when: new Date() })).toBe(false);
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(isJsonValue(circular)).toBe(false);
    expect(isJsonValue({ a: [1, "x", null, true] })).toBe(true);
  });
});
