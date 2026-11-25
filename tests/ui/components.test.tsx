/**
 * @vitest-environment jsdom
 *
 * P031 RejoinLab — T008: StateDiff / Diagnostics 组件测试。
 * 全部用真实分析结果渲染（T002 解析 + T005 评估 + Golden 样本），
 * 不使用手写假结果。
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { NormalizedEvent } from "../../src/protocol/types.js";
import { runAnalysis, type ScenarioConfig } from "../../src/ui/analyze.js";
import { StateDiff } from "../../src/ui/StateDiff.js";
import { Diagnostics } from "../../src/ui/Diagnostics.js";

afterEach(() => {
  cleanup();
});

function loadGoldenEvents(id: string): NormalizedEvent[] {
  const raw = JSON.parse(readFileSync(`fixtures/golden/${id}.json`, "utf8")) as {
    events: NormalizedEvent[];
  };
  return raw.events;
}

function analyze(
  events: NormalizedEvent[],
  scenario: ScenarioConfig,
  scenarioId: string,
) {
  return runAnalysis(events, scenario, scenarioId);
}

describe("StateDiff：五种裁决 5/5 展示", () => {
  const cases: Array<{
    name: string;
    verdict: string;
    label: string;
    build: () => ReturnType<typeof runAnalysis>;
  }> = [
    {
      name: "CONSISTENT",
      verdict: "CONSISTENT",
      label: "一致",
      build: () =>
        analyze(loadGoldenEvents("N01"), {
          strategy: "RESUME_FROM_CHECKPOINT",
          disconnectAfter: 2,
          resumeAfterSourceIndex: 2,
          injections: [],
        }, "N01"),
    },
    {
      name: "INCONSISTENT",
      verdict: "INCONSISTENT",
      label: "不一致",
      build: () =>
        analyze(loadGoldenEvents("G01"), {
          strategy: "FULL_REPLAY_FROM_START",
          disconnectAfter: 4,
          injections: [{ op: "REPLAY_PREFIX" }],
        }, "G01"),
    },
    {
      name: "INCONCLUSIVE_LIMIT",
      verdict: "INCONCLUSIVE_LIMIT",
      label: "超出计算边界",
      build: () => {
        const events: NormalizedEvent[] = [
          {
            sourceIndex: 0,
            sourceEventKey: null,
            transportEventId: null,
            event: { type: "RUN_STARTED", threadId: "t", runId: "r" },
          },
        ];
        for (let i = 1; i < 41; i += 1) {
          events.push({
            sourceIndex: i,
            sourceEventKey: null,
            transportEventId: null,
            event: { type: "STATE_SNAPSHOT", snapshot: { i } },
          });
        }
        return analyze(events, {
          strategy: "RESUME_FROM_CHECKPOINT",
          injections: [],
        }, "OVER-LIMIT");
      },
    },
    {
      name: "INVALID_INPUT",
      verdict: "INVALID_INPUT",
      label: "输入无效",
      build: () =>
        analyze(
          [
            {
              sourceIndex: 0,
              sourceEventKey: null,
              transportEventId: null,
              event: { type: "CUSTOM" } as unknown as NormalizedEvent["event"],
            },
          ],
          { strategy: "RESUME_FROM_CHECKPOINT", injections: [] },
          "BAD-TYPE",
        ),
    },
    {
      name: "INCOMPLETE_TRACE",
      verdict: "INCOMPLETE_TRACE",
      label: "轨迹不完整",
      build: () =>
        analyze(loadGoldenEvents("G08"), {
          strategy: "RESUME_FROM_CHECKPOINT",
          disconnectAfter: 2,
          resumeAfterSourceIndex: 2,
          injections: [{ op: "TRUNCATE_STREAM", sourceIndex: 4 }],
        }, "G08"),
    },
  ];

  for (const testCase of cases) {
    it(`裁决 ${testCase.name}：显示中文标签“${testCase.label}”与代码`, () => {
      const result = testCase.build();
      expect(result.evaluation.verdict).toBe(testCase.verdict);
      const { container } = render(<StateDiff result={result} />);
      expect(screen.getByText(`${testCase.label}（${testCase.verdict}）`)).toBeTruthy();
      expect(container.textContent).toContain("完整路径终态");
      expect(container.textContent).toContain("恢复路径终态");
    });
  }

  it("G01：首个分歧展示 sourceIndex、事件类型与 JSON Pointer 差异（kind 原样展示）", () => {
    const result = analyze(loadGoldenEvents("G01"), {
      strategy: "FULL_REPLAY_FROM_START",
      disconnectAfter: 4,
      injections: [{ op: "REPLAY_PREFIX" }],
    }, "G01");
    const divergence = result.evaluation.firstDivergence;
    expect(divergence).not.toBeNull();
    const { container } = render(<StateDiff result={result} />);
    expect(screen.getByText("首个分歧")).toBeTruthy();
    expect(screen.getByTestId("first-divergence-source-index").textContent).toBe(
      String(divergence?.sourceIndex),
    );
    // T004 接口原样展示：kind 值（added / removed / changed）逐字出现。
    for (const diff of divergence?.differences ?? []) {
      expect(screen.getByText(diff.jsonPointer)).toBeTruthy();
      expect(container.textContent).toContain(diff.kind);
    }
    // 双轨终态哈希均展示。
    expect(screen.getAllByText("终态哈希")).toHaveLength(2);
  });

  it("尚未运行时显示占位提示，不展示假结果", () => {
    render(<StateDiff result={null} />);
    expect(screen.getByText(/这里展示完整路径与恢复路径的终态对照/)).toBeTruthy();
    expect(screen.queryByText(/裁决/)).toBeNull();
  });
});

describe("Diagnostics：严重级别 CRITICAL / WARNING 均正确", () => {
  it("G01：DUPLICATE_TOOL_CALL 显示 CRITICAL · 严重，带 sourceIndex", () => {
    const result = analyze(loadGoldenEvents("G01"), {
      strategy: "FULL_REPLAY_FROM_START",
      disconnectAfter: 4,
      injections: [{ op: "REPLAY_PREFIX" }],
    }, "G01");
    render(<Diagnostics diagnostics={result.evaluation.diagnostics} />);
    // G01 的恢复重放会产生两条 DUPLICATE_TOOL_CALL 诊断（两个 START 位置）。
    expect(screen.getAllByText("DUPLICATE_TOOL_CALL").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/CRITICAL · 严重/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/共 \d+ 条：严重（CRITICAL）\d+ 条，警告（WARNING）\d+ 条/)).toBeTruthy();
  });

  it("G08：TRUNCATED_RUN 显示 WARNING · 警告", () => {
    const result = analyze(loadGoldenEvents("G08"), {
      strategy: "RESUME_FROM_CHECKPOINT",
      disconnectAfter: 2,
      resumeAfterSourceIndex: 2,
      injections: [{ op: "TRUNCATE_STREAM", sourceIndex: 4 }],
    }, "G08");
    render(<Diagnostics diagnostics={result.evaluation.diagnostics} />);
    expect(screen.getByText("TRUNCATED_RUN")).toBeTruthy();
    expect(screen.getAllByText(/WARNING · 警告/).length).toBeGreaterThanOrEqual(1);
  });

  it("无诊断时显示“无诊断”，不展示假诊断", () => {
    render(<Diagnostics diagnostics={[]} />);
    expect(screen.getByText(/无诊断/)).toBeTruthy();
  });

  it("诊断证据以文本形式展示（不注入 HTML）", () => {
    const result = analyze(loadGoldenEvents("G01"), {
      strategy: "FULL_REPLAY_FROM_START",
      disconnectAfter: 4,
      injections: [{ op: "REPLAY_PREFIX" }],
    }, "G01");
    const { container } = render(<Diagnostics diagnostics={result.evaluation.diagnostics} />);
    expect(container.querySelector("details")).not.toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("call-1");
  });
});
