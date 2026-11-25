/**
 * T010 tests — JSON 报告组装（src/report/json.ts）。
 *
 * 逐值对照，不只测形状：
 * - 24 条 Golden：verdict / 诊断码 / 最短注入序列与手工预期
 *   (oracle/golden_expected.json) 一致；首个分歧 sourceIndex
 *   与 T004 步进比较一致（S0 A-01：G01 = 4，不是 Oracle 的 2）；
 *   双轨终态哈希与 T004 stateHash 一致；输入 SHA-256 与夹具文件
 *   原始字节的 node:crypto 摘要一致。
 * - 五种裁决 5/5：CONSISTENT / INCONSISTENT / INCOMPLETE_TRACE
 *   来自 Golden；INVALID_INPUT（未知事件）与 INCONCLUSIVE_LIMIT
 *   （41 条事件）来自构造输入。
 * - CRITICAL / WARNING 区分：G01 CRITICAL、G07 仅 WARNING 仍判
 *   INCONSISTENT（状态确已分歧）、G08 WARNING 配 INCOMPLETE_TRACE。
 * - 报告哈希（T007 A-02）：durationMs 剔除、visitedStates 保留；
 *   两次构建（durationMs 不同）哈希相同。
 * - A-07 剥离：报告的 firstDivergence / differences 只有 §13.2
 *   字段；runStatus 不进 PathResult。
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalHash, sha256Hex, stateHash } from "../../src/core/canonical.js";
import { evaluateFixture } from "../../src/replay/planner.js";
import { analyzeFixture } from "../../src/replay/search.js";
import { buildWorkerResult } from "../../src/worker/rejoin.worker.js";
import type { NormalizedEvent } from "../../src/protocol/types.js";
import {
  buildReport,
  buildReportFromAnalysis,
  buildReportFromWorkerResult,
  reportHash,
  reportHashInput,
  serializeReport,
  toReportFirstDivergence,
} from "../../src/report/json.js";
import {
  REPORT_ASSUMPTIONS,
  REPORT_LIMITATIONS,
  validateReport,
} from "../../src/report/schema.js";
import {
  GOLDEN_IDS,
  loadExpected,
  loadFixture,
  loadRawFixture,
} from "../replay/golden-helpers.js";

/** T004 步进比较的首个分歧（S0 A-01；G01 = 4，Oracle 诊断优先分支为 2）。 */
const TS_FIRST_DIVERGENCE: Record<string, number | null> = {
  G01: 4,
  G02: 7,
  G03: 10,
  G04: 3,
  G05: 4,
  G06: 2,
  G07: 2,
  G08: 4,
  N01: null,
  N02: null,
  N03: null,
  N04: null,
  N05: null,
  N06: null,
  N07: null,
  N08: null,
  N09: null,
  N10: null,
  N11: null,
  N12: null,
  N13: null,
  N14: null,
  N15: null,
  N16: null,
};

const expected = loadExpected();

function nodeSha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");
}

function fixtureFileText(id: string): string {
  return readFileSync(
    join(process.cwd(), "fixtures", "golden", `${id}.json`),
    "utf8",
  );
}

describe("24 条 Golden：经 Worker 输出组装报告，逐值对照", () => {
  for (const id of GOLDEN_IDS) {
    it(`${id} 报告逐值一致`, () => {
      const fixture = loadFixture(id);
      const workerResult = buildWorkerResult(fixture);
      const { report, bfsVisited } = buildReportFromWorkerResult(
        workerResult,
        fixture.events,
        {
          scenarioId: id,
          sourceFormat: "JSONL",
          sourceText: fixtureFileText(id),
        },
      );
      const exp = expected[id] as (typeof expected)[string];

      // 裁决 / 诊断 / 最短序列与手工预期一致。
      expect(report.verdict).toBe(exp.verdict);
      expect(report.diagnostics.map((d) => d.code)).toEqual(exp.diagnostics);
      expect(report.shortestInjectionSequence).toEqual(
        exp.shortestInjectionSequence,
      );
      // 首个分歧与 T004 步进比较一致（G01 = 4）。
      const expectedIndex = TS_FIRST_DIVERGENCE[id] as number | null;
      if (expectedIndex === null) {
        expect(report.firstDivergence).toBeUndefined();
      } else {
        expect(report.firstDivergence?.sourceIndex).toBe(expectedIndex);
      }
      // 双轨终态哈希与 T004 计算一致。
      const evaluation = workerResult.evaluation;
      expect(evaluation.fullState).not.toBeNull();
      expect(evaluation.resumeState).not.toBeNull();
      expect(report.fullPath?.finalStateHash).toBe(
        stateHash(evaluation.fullState!),
      );
      expect(report.resumePath?.finalStateHash).toBe(
        stateHash(evaluation.resumeState!),
      );
      // 输入 SHA-256 与夹具文件原始字节一致。
      expect(report.input.sourceSha256).toBe(
        nodeSha256(fixtureFileText(id)),
      );
      expect(report.input.eventCount).toBe(workerResult.importedEventCount);
      expect(report.input.sourceFormat).toBe("JSONL");
      // 恢复配置与 Worker 回显一致。
      expect(report.recovery.strategy).toBe(workerResult.scenario.strategy);
      // 冻结的假设与局限说明。
      expect(report.assumptions).toEqual([...REPORT_ASSUMPTIONS]);
      expect(report.limitations).toEqual([...REPORT_LIMITATIONS]);
      // 报告通过 Schema 校验；BFS 节点数在 S0 门槛内。
      expect(validateReport(report)).toEqual({ ok: true, errors: [] });
      expect(bfsVisited).toBeLessThanOrEqual(5000);
      // 报告是纯 JSON 值：序列化后解析回原值。
      expect(JSON.parse(serializeReport(report))).toEqual(
        JSON.parse(JSON.stringify(report)),
      );
    });
  }

  it("Worker 评估与 analyzeFixture 评估同源：报告除 durationMs 外相同", () => {
    for (const id of GOLDEN_IDS) {
      const fixture = loadFixture(id);
      const workerResult = buildWorkerResult(fixture);
      const fromWorker = buildReportFromWorkerResult(
        workerResult,
        fixture.events,
        { scenarioId: id, sourceFormat: "JSONL", sourceText: fixtureFileText(id) },
      ).report;
      const target =
        workerResult.evaluation.diagnostics[0]?.code ?? null;
      const analysis = analyzeFixture(fixture, target);
      const fromAnalysis = buildReportFromAnalysis(
        analysis,
        workerResult.durationMs,
        {
          scenarioId: id,
          sourceFormat: "JSONL",
          sourceText: fixtureFileText(id),
          eventCount: workerResult.importedEventCount,
        },
        workerResult.scenario,
      );
      expect(fromAnalysis).toEqual(fromWorker);
    }
  });
});

describe("A-07 剥离：报告只含 §13.2 字段", () => {
  it("G01 firstDivergence 只有 sourceIndex/fullStateHash/resumeStateHash/differences", () => {
    const fixture = loadFixture("G01");
    const workerResult = buildWorkerResult(fixture);
    const { report } = buildReportFromWorkerResult(workerResult, fixture.events, {
      scenarioId: "G01",
      sourceFormat: "JSONL",
      sourceText: fixtureFileText("G01"),
    });
    expect(report.firstDivergence).toBeDefined();
    expect(Object.keys(report.firstDivergence as object).sort()).toEqual([
      "differences",
      "fullStateHash",
      "resumeStateHash",
      "sourceIndex",
    ]);
    for (const difference of report.firstDivergence?.differences ?? []) {
      expect(Object.keys(difference).sort()).toEqual([
        "actual",
        "expected",
        "jsonPointer",
      ]);
    }
    // 差异条目只含 §13.2 的三个键；"kind" / "eventType" 只会作为
    // 差异值（TimelineItem 的状态字段）出现，绝不是差异条目本身
    // 的属性——全文本字符串搜索分不清这两者，故只做结构断言。
    const parsed = JSON.parse(serializeReport(report)) as {
      firstDivergence?: {
        differences?: Array<Record<string, unknown>>;
      };
    };
    for (const difference of parsed.firstDivergence?.differences ?? []) {
      expect(Object.keys(difference).sort()).toEqual([
        "actual",
        "expected",
        "jsonPointer",
      ]);
      expect(difference).not.toHaveProperty("kind");
    }
    // G01 的首个差异确实在 /orderedTimeline/5：恢复路径在该步
    // 多出一条 run 时间线项（其值含 kind/eventType 等状态字段，
    // 是合法的差异内容，不是 StateDiff 的多余字段）。
    expect(report.firstDivergence?.differences[0]?.jsonPointer).toBe(
      "/orderedTimeline/5",
    );
    expect(report.firstDivergence?.differences[0]?.actual).toEqual({
      kind: "run",
      eventType: "RUN_STARTED",
      runId: "run-1",
    });
  });

  it("toReportFirstDivergence 剥离 kind 与事件身份字段", () => {
    const evaluation = evaluateFixture(loadFixture("G01"));
    const stripped = toReportFirstDivergence(evaluation.firstDivergence);
    expect(stripped).toBeDefined();
    expect(stripped).not.toHaveProperty("eventType");
    expect(stripped).not.toHaveProperty("messageId");
    expect(stripped).not.toHaveProperty("toolCallId");
    expect(stripped).not.toHaveProperty("runId");
    expect(stripped).not.toHaveProperty("note");
    for (const difference of stripped?.differences ?? []) {
      expect(difference).not.toHaveProperty("kind");
    }
    expect(toReportFirstDivergence(null)).toBeUndefined();
  });

  it("PathResult 不含 runStatus（§13.2 无此字段）", () => {
    const fixture = loadFixture("N01");
    const workerResult = buildWorkerResult(fixture);
    const { report } = buildReportFromWorkerResult(workerResult, fixture.events, {
      scenarioId: "N01",
      sourceFormat: "JSONL",
      sourceText: fixtureFileText("N01"),
    });
    expect(Object.keys(report.fullPath as object).sort()).toEqual([
      "finalStateHash",
      "messages",
      "pendingToolCallIds",
      "sharedState",
      "toolCalls",
    ]);
  });
});

describe("五种裁决 5/5", () => {
  it("INVALID_INPUT：未知事件类型，路径为 null，序列为 null（未计算）", () => {
    const raw = loadRawFixture("N01");
    const badEvent = {
      sourceIndex: raw.events.length,
      sourceEventKey: null,
      transportEventId: null,
      event: { type: "STEP_STARTED", stepId: "s-1" },
    } as unknown as NormalizedEvent;
    const evaluation = evaluateFixture({
      scenarioId: "BAD-TYPE",
      events: [...raw.events, badEvent],
      recovery: { strategy: "RESUME_FROM_CHECKPOINT" },
    });
    expect(evaluation.verdict).toBe("INVALID_INPUT");
    const report = buildReport({
      evaluation,
      shortestInjectionSequence: null,
      durationMs: 3,
      source: {
        scenarioId: "BAD-TYPE",
        sourceFormat: "JSONL",
        sourceText: '{"type":"STEP_STARTED"}\n',
        eventCount: raw.events.length + 1,
      },
      recovery: { strategy: "RESUME_FROM_CHECKPOINT" },
    });
    expect(report.verdict).toBe("INVALID_INPUT");
    expect(report.fullPath).toBeNull();
    expect(report.resumePath).toBeNull();
    expect(report.shortestInjectionSequence).toBeNull();
    expect(report.diagnostics[0]?.code).toBe("INVALID_INPUT");
    expect(report.diagnostics[0]?.severity).toBe("CRITICAL");
    expect(validateReport(report).ok).toBe(true);
  });

  it("INCONCLUSIVE_LIMIT：41 条事件超限，路径为 null", () => {
    const raw = loadRawFixture("N01");
    const events: NormalizedEvent[] = [];
    while (events.length < 41) {
      for (const event of raw.events) {
        if (events.length >= 41) break;
        events.push({ ...event, sourceIndex: events.length });
      }
    }
    const evaluation = evaluateFixture({
      scenarioId: "TOO-MANY",
      events,
      recovery: { strategy: "RESUME_FROM_CHECKPOINT" },
    });
    expect(evaluation.verdict).toBe("INCONCLUSIVE_LIMIT");
    const report = buildReport({
      evaluation,
      shortestInjectionSequence: null,
      durationMs: 1,
      source: {
        scenarioId: "TOO-MANY",
        sourceFormat: "JSONL",
        sourceText: "x".repeat(41),
        eventCount: 41,
      },
      recovery: { strategy: "RESUME_FROM_CHECKPOINT" },
    });
    expect(report.verdict).toBe("INCONCLUSIVE_LIMIT");
    expect(report.fullPath).toBeNull();
    expect(report.resumePath).toBeNull();
    expect(report.diagnostics[0]?.code).toBe("LIMIT_EXCEEDED");
    expect(validateReport(report).ok).toBe(true);
  });

  it("G08 INCOMPLETE_TRACE 与 N01 CONSISTENT 来自 Golden 对照", () => {
    for (const [id, verdict] of [
      ["G08", "INCOMPLETE_TRACE"],
      ["N01", "CONSISTENT"],
    ] as const) {
      const fixture = loadFixture(id);
      const workerResult = buildWorkerResult(fixture);
      const { report } = buildReportFromWorkerResult(
        workerResult,
        fixture.events,
        { scenarioId: id, sourceFormat: "JSONL", sourceText: fixtureFileText(id) },
      );
      expect(report.verdict).toBe(verdict);
    }
  });
});

describe("CRITICAL / WARNING 正确区分", () => {
  it("G01 DUPLICATE_TOOL_CALL 为 CRITICAL", () => {
    const fixture = loadFixture("G01");
    const { report } = buildReportFromWorkerResult(
      buildWorkerResult(fixture),
      fixture.events,
      { scenarioId: "G01", sourceFormat: "JSONL", sourceText: fixtureFileText("G01") },
    );
    expect(report.diagnostics).toHaveLength(1);
    expect(report.diagnostics[0]).toMatchObject({
      code: "DUPLICATE_TOOL_CALL",
      severity: "CRITICAL",
      sourceIndex: 2,
    });
  });

  it("G07 只有 WARNING（SUSPECTED_DUPLICATE），但状态确已分歧故判 INCONSISTENT", () => {
    const fixture = loadFixture("G07");
    const { report } = buildReportFromWorkerResult(
      buildWorkerResult(fixture),
      fixture.events,
      { scenarioId: "G07", sourceFormat: "JSONL", sourceText: fixtureFileText("G07") },
    );
    expect(report.verdict).toBe("INCONSISTENT");
    expect(report.diagnostics.map((d) => d.severity)).toEqual(["WARNING"]);
    expect(report.diagnostics[0]?.code).toBe("SUSPECTED_DUPLICATE");
  });

  it("G08 TRUNCATED_RUN 为 WARNING，配 INCOMPLETE_TRACE", () => {
    const fixture = loadFixture("G08");
    const { report } = buildReportFromWorkerResult(
      buildWorkerResult(fixture),
      fixture.events,
      { scenarioId: "G08", sourceFormat: "JSONL", sourceText: fixtureFileText("G08") },
    );
    expect(report.verdict).toBe("INCOMPLETE_TRACE");
    expect(report.diagnostics.map((d) => d.severity)).toEqual(["WARNING"]);
    expect(report.diagnostics[0]?.code).toBe("TRUNCATED_RUN");
  });
});

describe("输入 SHA-256：原始字节，不归一化", () => {
  it("与 node:crypto 对同一字节的摘要一致（含 CRLF、中文、emoji）", () => {
    const text =
      '{"type":"RUN_STARTED","threadId":"t-1","runId":"r-1"}\r\n' +
      '{"type":"TEXT_MESSAGE_CONTENT","messageId":"m-1","delta":"你好，世界 🌍"}\r\n';
    expect(sha256Hex(text)).toBe(nodeSha256(text));
    // 归一化后的文本摘要不同：证明实现没有悄悄改写换行。
    expect(sha256Hex(text)).not.toBe(nodeSha256(text.replace(/\r\n/g, "\n")));
  });

  it("buildReport 的 sourceSha256 取原文，不取规范化文本", () => {
    const fixture = loadFixture("N01");
    const workerResult = buildWorkerResult(fixture);
    const text = fixtureFileText("N01");
    const { report } = buildReportFromWorkerResult(workerResult, fixture.events, {
      scenarioId: "N01",
      sourceFormat: "JSONL",
      sourceText: text,
    });
    expect(report.input.sourceSha256).toBe(nodeSha256(text));
    expect(report.input.sourceSha256).toBe(sha256Hex(text));
  });
});

describe("报告哈希（T007 A-02）", () => {
  it("等于 JCS canonicalHash（报告剔除 durationMs）", () => {
    const fixture = loadFixture("G01");
    const workerResult = buildWorkerResult(fixture);
    const { report } = buildReportFromWorkerResult(workerResult, fixture.events, {
      scenarioId: "G01",
      sourceFormat: "JSONL",
      sourceText: fixtureFileText("G01"),
    });
    expect(reportHash(report)).toBe(canonicalHash(reportHashInput(report)));
    const { durationMs: _dropped, ...metricsKept } = report.metrics;
    void _dropped;
    expect(reportHashInput(report)).toEqual({
      ...report,
      metrics: metricsKept,
    });
  });

  it("durationMs 不同而其余相同：哈希相同；visitedStates 不同：哈希不同", () => {
    const fixture = loadFixture("N01");
    const workerResult = buildWorkerResult(fixture);
    const source = {
      scenarioId: "N01",
      sourceFormat: "JSONL" as const,
      sourceText: fixtureFileText("N01"),
      eventCount: workerResult.importedEventCount,
    };
    const a = buildReport({
      evaluation: workerResult.evaluation,
      shortestInjectionSequence: ["DROP_EVENT"],
      durationMs: 1,
      source,
      recovery: workerResult.scenario,
    });
    const b = buildReport({
      evaluation: workerResult.evaluation,
      shortestInjectionSequence: ["DROP_EVENT"],
      durationMs: 999,
      source,
      recovery: workerResult.scenario,
    });
    expect(reportHash(a)).toBe(reportHash(b));
    expect(a.metrics.durationMs).not.toBe(b.metrics.durationMs);
    // visitedStates 保留在哈希输入中：改动它必须改变哈希。
    const c = { ...a, metrics: { durationMs: 1, visitedStates: a.metrics.visitedStates + 1 } };
    expect(reportHash(c)).not.toBe(reportHash(a));
  });

  it("同一输入两次构建字节相同（除 durationMs 外）", () => {
    const fixture = loadFixture("G03");
    const workerResult = buildWorkerResult(fixture);
    const build = () =>
      buildReportFromWorkerResult(workerResult, fixture.events, {
        scenarioId: "G03",
        sourceFormat: "JSONL",
        sourceText: fixtureFileText("G03"),
      }).report;
    const a = build();
    const b = build();
    expect(a).toEqual(b);
    expect(serializeReport(a)).toBe(serializeReport(b));
  });
});
