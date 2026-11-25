/**
 * FIX-R1 B 组回归 — 终审 R1 P1-R1-03 / P2-R1-08（规格 v1.0.1）。
 *
 * 覆盖：
 * - P1-R1-03：INVALID_INPUT 与 INCONCLUSIVE_LIMIT 的报告 fullPath /
 *   resumePath 为 null（不是伪造的空路径），仍通过 Schema 校验，
 *   裁决不是 CONSISTENT；非对称 null（仅 resumePath）形状亦通过校验。
 * - P2-R1-08：shortestInjectionSequence 的两种情形——[]（BFS 已证实
 *   目标在无注入时已达成，如 G08）与 null（未计算，如 INVALID_INPUT）；
 *   wire 契约（JSON Schema 与校验器）接受 null。
 * - 消费者：JSON 序列化往返保留 null；HTML 渲染对 null 路径显示
 *   “无终态”，不渲染终态哈希，不把 null 误认为 CONSISTENT。
 *
 * 说明：非对称 null 的真实触发分支是恢复折叠抛错
 * （planner.ts:1278–1279），从现有 Golden 夹具无法直接构造出仅恢复
 * 折叠抛错的输入，故该形状用一次真实 N01 评估改写 resumePath 后验证
 * Schema 与消费者处理；分支本身的存在以 planner.ts 源码为准。
 * 另：截至 v1.0.1，buildReport 仍把分析层的 null 序列折叠为 []
 * （json.ts:190–193，见 L-T010-02 的分阶段说明），故本文件的报告层
 * null 序列用例直接构造报告对象验证，不经过 buildReport。
 */
import { describe, expect, it } from "vitest";
import { evaluateFixture } from "../../src/replay/planner.js";
import { analyzeFixture } from "../../src/replay/search.js";
import { buildReport, serializeReport } from "../../src/report/json.js";
import { renderReportHtml } from "../../src/report/html.js";
import {
  REJOIN_REPORT_JSON_SCHEMA,
  SPEC_VERSION,
  validateReport,
} from "../../src/report/schema.js";
import { loadFixture, loadRawFixture } from "../replay/golden-helpers.js";
import type { NormalizedEvent } from "../../src/protocol/types.js";

const HEX64 = "a".repeat(64);

function invalidInputEvaluation() {
  const raw = loadRawFixture("N01");
  const badEvent = {
    sourceIndex: raw.events.length,
    sourceEventKey: null,
    transportEventId: null,
    event: { type: "STEP_STARTED", stepId: "s-1" },
  } as unknown as NormalizedEvent;
  return evaluateFixture({
    scenarioId: "BAD-TYPE",
    events: [...raw.events, badEvent],
    recovery: { strategy: "RESUME_FROM_CHECKPOINT" },
  });
}

function overLimitEvaluation() {
  const raw = loadRawFixture("N01");
  const events: NormalizedEvent[] = [];
  while (events.length < 41) {
    for (const event of raw.events) {
      if (events.length >= 41) break;
      events.push({ ...event, sourceIndex: events.length });
    }
  }
  return evaluateFixture({
    scenarioId: "TOO-MANY",
    events,
    recovery: { strategy: "RESUME_FROM_CHECKPOINT" },
  });
}

function reportFor(
  evaluation: ReturnType<typeof evaluateFixture>,
  scenarioId: string,
  eventCount: number,
) {
  return buildReport({
    evaluation,
    shortestInjectionSequence: null,
    durationMs: 3,
    source: {
      scenarioId,
      sourceFormat: "JSONL",
      sourceText: "x".repeat(Math.max(eventCount, 1)),
      eventCount,
    },
    recovery: { strategy: "RESUME_FROM_CHECKPOINT" },
  });
}

describe("规格版本 v1.0.2", () => {
  it("SPEC_VERSION 与 JSON Schema 的 specVersion 常量均为 1.0.2", () => {
    expect(SPEC_VERSION).toBe("1.0.2");
    const schema = REJOIN_REPORT_JSON_SCHEMA as unknown as Record<
      string,
      unknown
    >;
    const properties = schema["properties"] as Record<string, unknown>;
    const specVersion = properties["specVersion"] as Record<string, unknown>;
    expect(specVersion["const"]).toBe("1.0.2");
  });
});

describe("P1-R1-03：null 路径的报告", () => {
  it("INVALID_INPUT：未知事件类型，双路径为 null，通过 Schema 校验，裁决不是 CONSISTENT", () => {
    const evaluation = invalidInputEvaluation();
    expect(evaluation.verdict).toBe("INVALID_INPUT");
    expect(evaluation.fullPath).toBeNull();
    expect(evaluation.resumePath).toBeNull();
    const report = reportFor(evaluation, "BAD-TYPE", 7);
    expect(report.verdict).toBe("INVALID_INPUT");
    // null 是“无终态”，不是伪造的空路径对象。
    expect(report.fullPath).toBeNull();
    expect(report.resumePath).toBeNull();
    expect(report.fullPath).not.toEqual({ messages: [] });
    expect(validateReport(report)).toEqual({ ok: true, errors: [] });
  });

  it("INCONCLUSIVE_LIMIT：41 条事件超限，双路径为 null，通过 Schema 校验", () => {
    const evaluation = overLimitEvaluation();
    expect(evaluation.verdict).toBe("INCONCLUSIVE_LIMIT");
    expect(evaluation.fullPath).toBeNull();
    expect(evaluation.resumePath).toBeNull();
    const report = reportFor(evaluation, "TOO-MANY", 41);
    expect(report.verdict).toBe("INCONCLUSIVE_LIMIT");
    expect(report.fullPath).toBeNull();
    expect(report.resumePath).toBeNull();
    expect(validateReport(report).ok).toBe(true);
  });

  it("非对称 null：fullPath 为对象、resumePath 为 null 的报告通过 Schema 校验", () => {
    const base = evaluateFixture(loadFixture("N01"));
    expect(base.verdict).toBe("CONSISTENT");
    expect(base.fullPath).not.toBeNull();
    const report = buildReport({
      evaluation: {
        ...base,
        verdict: "INVALID_INPUT",
        resumePath: null,
      },
      shortestInjectionSequence: null,
      durationMs: 3,
      source: {
        scenarioId: "RESUME-FOLD-FAIL",
        sourceFormat: "JSONL",
        sourceText: "{}",
        eventCount: 6,
      },
      recovery: { strategy: "RESUME_FROM_CHECKPOINT" },
    });
    expect(report.verdict).toBe("INVALID_INPUT");
    expect(report.fullPath).not.toBeNull();
    expect(report.resumePath).toBeNull();
    expect(validateReport(report)).toEqual({ ok: true, errors: [] });
  });
});

describe("P2-R1-08：shortestInjectionSequence 的 [] 与 null", () => {
  it("[]：G08 目标在无注入时已达成，分析层序列为空数组", () => {
    const analysis = analyzeFixture(loadFixture("G08"), "TRUNCATED_RUN");
    expect(analysis.evaluation.verdict).toBe("INCOMPLETE_TRACE");
    expect(analysis.shortestInjectionSequence).toEqual([]);
  });

  it("null：INVALID_INPUT 未运行 BFS，分析层序列为 null", () => {
    const raw = loadRawFixture("N01");
    const badEvent = {
      sourceIndex: raw.events.length,
      sourceEventKey: null,
      transportEventId: null,
      event: { type: "STEP_STARTED", stepId: "s-1" },
    } as unknown as NormalizedEvent;
    const invalid = analyzeFixture(
      {
        scenarioId: "BAD-TYPE",
        events: [...raw.events, badEvent],
        recovery: { strategy: "RESUME_FROM_CHECKPOINT" },
      },
      null,
    );
    expect(invalid.evaluation.verdict).toBe("INVALID_INPUT");
    expect(invalid.shortestInjectionSequence).toBeNull();
  });

  it("wire 契约：JSON Schema 接受 null，校验器接受 null 与 []，拒绝其他非数组值", () => {
    const schema = REJOIN_REPORT_JSON_SCHEMA as unknown as Record<
      string,
      unknown
    >;
    const properties = schema["properties"] as Record<string, unknown>;
    const sequence = properties["shortestInjectionSequence"] as Record<
      string,
      unknown
    >;
    const anyOf = sequence["anyOf"] as Array<Record<string, unknown>>;
    expect(anyOf.some((branch) => branch["type"] === "null")).toBe(true);
    expect(
      anyOf.some((branch) => branch["type"] === "array"),
    ).toBe(true);

    const base: Record<string, unknown> = {
      schema: "rejoinlab.report/v1",
      specVersion: "1.0.2",
      protocolVersion: "1.0",
      scenarioId: "G08",
      verdict: "INCOMPLETE_TRACE",
      input: {
        sourceFormat: "JSONL",
        eventCount: 5,
        sourceSha256: HEX64,
      },
      recovery: { strategy: "RESUME_FROM_CHECKPOINT" },
      fullPath: {
        finalStateHash: "b".repeat(64),
        messages: [],
        toolCalls: [],
        sharedState: {},
        pendingToolCallIds: [],
      },
      resumePath: {
        finalStateHash: "c".repeat(64),
        messages: [],
        toolCalls: [],
        sharedState: {},
        pendingToolCallIds: [],
      },
      diagnostics: [],
      metrics: { durationMs: 1, visitedStates: 4 },
      assumptions: ["使用 AG-UI 1.0 事件语义"],
      limitations: ["不证明真实 Agent 后端 exactly-once"],
    };
    expect(
      validateReport({ ...base, shortestInjectionSequence: [] }).ok,
    ).toBe(true);
    expect(
      validateReport({ ...base, shortestInjectionSequence: null }).ok,
    ).toBe(true);
    expect(
      validateReport({ ...base, shortestInjectionSequence: ["DROP_EVENT"] })
        .ok,
    ).toBe(true);
    const bad = validateReport({
      ...base,
      shortestInjectionSequence: "REPLAY_PREFIX",
    });
    expect(bad.ok).toBe(false);
    expect(bad.errors.join("\n")).toContain("shortestInjectionSequence");
  });
});

describe("消费者：null 路径不被误认为 CONSISTENT", () => {
  it("JSON 序列化往返保留 null，裁决仍为 INVALID_INPUT", () => {
    const report = reportFor(invalidInputEvaluation(), "BAD-TYPE", 7);
    const roundTripped = JSON.parse(serializeReport(report)) as Record<
      string,
      unknown
    >;
    expect(roundTripped["fullPath"]).toBeNull();
    expect(roundTripped["resumePath"]).toBeNull();
    expect(roundTripped["verdict"]).toBe("INVALID_INPUT");
    expect(validateReport(roundTripped).ok).toBe(true);
  });

  it("HTML 渲染：双路径为 null 时显示“无终态”，不渲染终态哈希，裁决为输入无效", () => {
    const report = reportFor(invalidInputEvaluation(), "BAD-TYPE", 7);
    const html = renderReportHtml(report);
    expect(html).toContain("INVALID_INPUT");
    expect(html).toContain("输入无效");
    expect(html).toContain("无终态");
    expect(html).not.toContain("终态哈希");
    // 注意：内联 <style> 含全部裁决的 CSS 类名，故断言裁决 <span> 本身的类，
    // 而不是全文不含 "verdict-consistent"。
    expect(html).toContain('class="verdict verdict-invalid"');
    expect(html).not.toContain('class="verdict verdict-consistent"');
    expect(html).toContain("规格 v1.0.2");
  });

  it("HTML 渲染：非对称 null 时仅缺失路径显示“无终态”，另一路径照常显示终态哈希", () => {
    const base = evaluateFixture(loadFixture("N01"));
    const report = buildReport({
      evaluation: {
        ...base,
        verdict: "INVALID_INPUT",
        resumePath: null,
      },
      shortestInjectionSequence: null,
      durationMs: 3,
      source: {
        scenarioId: "RESUME-FOLD-FAIL",
        sourceFormat: "JSONL",
        sourceText: "{}",
        eventCount: 6,
      },
      recovery: { strategy: "RESUME_FROM_CHECKPOINT" },
    });
    const html = renderReportHtml(report);
    expect(html).toContain("无终态");
    expect((html.match(/终态哈希/g) ?? []).length).toBe(1);
    expect(html).toContain("INVALID_INPUT");
    expect(html).toContain('class="verdict verdict-invalid"');
    expect(html).not.toContain('class="verdict verdict-consistent"');
  });
});
