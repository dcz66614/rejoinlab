/**
 * @vitest-environment jsdom
 *
 * P031 RejoinLab — T009: 双轨时间线组件测试。
 *
 * 全部用真实 Worker 结果渲染（buildWorkerResult + 24 条 Golden
 * 样本），不使用手写假结果。核查：
 * - 两条轨道各为一条完整轨道，事件按 sourceIndex 顺序渲染；
 * - 断线点 / 恢复点 / 快照 / 重复 / 丢失 / 乱序 / 首个分歧标记；
 * - 首个分歧标记与 StateDiff 的值一致；
 * - 点击事件展示原始 JSON；
 * - 逐事件回放：分歧前的步两侧状态一致，分歧步与核心结果一致；
 * - chunk 展开时的编号说明。
 */
import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { buildWorkerResult } from "../../src/worker/rejoin.worker.js";
import { Timeline } from "../../src/ui/Timeline.js";
import { StateDiff } from "../../src/ui/StateDiff.js";
import { buildAnalyzeFixture } from "../../src/worker/client.js";
import { parseInput } from "../../src/parser/index.js";
import { toReplayFixture } from "../replay/golden-helpers.js";
import type { ReplayFixture } from "../../src/replay/planner.js";

/**
 * jsdom 环境下 import.meta.url 是 http 协议，golden-helpers 的
 * loadFixture（基于 import.meta.url 读文件）不可用；改用 T008
 * 组件测试的做法：相对工作目录（项目根）读文件，再用
 * toReplayFixture 做同样的转换。
 */
function loadFixtureLocal(id: string): ReplayFixture {
  const raw = JSON.parse(readFileSync(`fixtures/golden/${id}.json`, "utf8")) as Parameters<
    typeof toReplayFixture
  >[0];
  return toReplayFixture(raw);
}

afterEach(() => {
  cleanup();
});

function trackRows(trackTestId: string): HTMLElement[] {
  const track = screen.getByTestId(trackTestId);
  return within(track).getAllByRole("button");
}

function rowSourceIndices(trackTestId: string): number[] {
  return trackRows(trackTestId).map((row) =>
    Number(row.getAttribute("data-source-index")),
  );
}

describe("Timeline：双轨渲染与顺序", () => {
  it("G01：两条轨道各为一条完整轨道，事件按 sourceIndex 升序", () => {
    const result = buildWorkerResult(loadFixtureLocal("G01"));
    render(<Timeline result={result} />);
    const fullIndices = rowSourceIndices("timeline-track-full");
    expect(fullIndices.length).toBe(result.fullTrack.length);
    expect([...fullIndices].sort((a, b) => a - b)).toEqual(fullIndices);
    const resumeIndices = rowSourceIndices("timeline-track-resume");
    expect(resumeIndices.length).toBe(result.resumeTrack.length);
    expect([...resumeIndices].sort((a, b) => a - b)).toEqual(resumeIndices);
  });

  it("空结果时显示提示，不渲染轨道", () => {
    render(<Timeline result={null} />);
    expect(screen.getByText(/这里展示完整路径与恢复路径的双轨时间线/)).toBeTruthy();
    expect(screen.queryByTestId("timeline-track-full")).toBeNull();
  });

  it("N01：一致轨迹无分歧标记，两条轨道终态哈希一致", () => {
    const result = buildWorkerResult(loadFixtureLocal("N01"));
    render(<Timeline result={result} />);
    expect(screen.queryByText("首个分歧")).toBeNull();
    expect(result.evaluation.fullPath?.finalStateHash).toBe(
      result.evaluation.resumePath?.finalStateHash,
    );
  });
});

describe("Timeline：标记", () => {
  it("G01：断线点在完整轨道 sourceIndex 4，恢复点在恢复轨道首条", () => {
    const result = buildWorkerResult(loadFixtureLocal("G01"));
    expect(result.evaluation.checkpointIndex).toBe(4);
    render(<Timeline result={result} />);
    const fullRows = trackRows("timeline-track-full");
    const disconnectRow = fullRows.find(
      (row) => row.getAttribute("data-source-index") === "4",
    );
    expect(disconnectRow?.textContent).toContain("断线点");
    const resumeRows = trackRows("timeline-track-resume");
    expect(resumeRows[0]?.textContent).toContain("恢复点");
  });

  it("G01：恢复轨道上有重复标记", () => {
    const result = buildWorkerResult(loadFixtureLocal("G01"));
    render(<Timeline result={result} />);
    const resumeRows = trackRows("timeline-track-resume");
    expect(resumeRows.some((row) => row.textContent?.includes("重复"))).toBe(true);
  });

  it("G04：恢复轨道上有丢失标记（虚线占位）", () => {
    const result = buildWorkerResult(loadFixtureLocal("G04"));
    render(<Timeline result={result} />);
    const resumeRows = trackRows("timeline-track-resume");
    const dropped = resumeRows.filter((row) => row.textContent?.includes("丢失"));
    expect(dropped.length).toBeGreaterThanOrEqual(1);
  });

  it("G05：恢复轨道上有乱序标记", () => {
    const result = buildWorkerResult(loadFixtureLocal("G05"));
    render(<Timeline result={result} />);
    const resumeRows = trackRows("timeline-track-resume");
    expect(resumeRows.some((row) => row.textContent?.includes("乱序"))).toBe(true);
  });

  it("G06：恢复轨道上有快照标记（STATE_SNAPSHOT 事件）", () => {
    const result = buildWorkerResult(loadFixtureLocal("G06"));
    render(<Timeline result={result} />);
    const rows = [
      ...trackRows("timeline-track-full"),
      ...trackRows("timeline-track-resume"),
    ];
    expect(rows.some((row) => row.textContent?.includes("快照"))).toBe(true);
  });

  it("首个分歧标记与 StateDiff 的值一致（G05：sourceIndex 4）", () => {
    const result = buildWorkerResult(loadFixtureLocal("G05"));
    expect(result.evaluation.firstDivergence?.sourceIndex).toBe(4);
    render(
      <>
        <StateDiff
          result={{
            evaluation: result.evaluation,
            durationMs: result.durationMs,
            scenario: result.scenario,
          }}
        />
        <Timeline result={result} />
      </>,
    );
    expect(screen.getByTestId("first-divergence-source-index").textContent).toBe("4");
    const fullRows = trackRows("timeline-track-full");
    const divergenceRow = fullRows.find(
      (row) => row.getAttribute("data-source-index") === "4",
    );
    expect(divergenceRow?.textContent).toContain("首个分歧");
  });
});

describe("Timeline：点击事件查看原始 JSON", () => {
  it("点击恢复轨道事件，展示该事件的真实原始 JSON", () => {
    const result = buildWorkerResult(loadFixtureLocal("G01"));
    render(<Timeline result={result} />);
    const resumeRows = trackRows("timeline-track-resume");
    const target = resumeRows.find(
      (row) => row.getAttribute("data-source-index") === "2",
    );
    expect(target).toBeDefined();
    fireEvent.click(target as HTMLElement);
    const panel = screen.getByTestId("timeline-selected-json");
    expect(panel.textContent).toContain("TOOL_CALL_START");
    expect(panel.textContent).toContain("call-1");
    expect(panel.textContent).toContain("sourceIndex 2");
  });

  it("点击丢失占位，展示被丢弃事件的原始 JSON 并注明未应用", () => {
    const result = buildWorkerResult(loadFixtureLocal("G04"));
    render(<Timeline result={result} />);
    const resumeRows = trackRows("timeline-track-resume");
    const dropped = resumeRows.find((row) => row.textContent?.includes("丢失"));
    expect(dropped).toBeDefined();
    fireEvent.click(dropped as HTMLElement);
    const panel = screen.getByTestId("timeline-selected-json");
    expect(panel.textContent).toContain("未应用（丢失占位）");
    expect(panel.textContent).toContain("TEXT_MESSAGE_CONTENT");
  });
});

describe("Timeline：逐事件回放", () => {
  it("G05：分歧前的步两侧状态一致，分歧步与核心结果一致", () => {
    const result = buildWorkerResult(loadFixtureLocal("G05"));
    expect(result.evaluation.firstDivergence?.sourceIndex).toBe(4);
    render(<Timeline result={result} />);
    const next = screen.getByRole("button", { name: "下一步" });
    const comparison = () => screen.getByTestId("timeline-step-comparison").textContent ?? "";
    // checkpointIndex 为 3：可比较步从 sourceIndex 3 起；第 1 步（3）一致。
    fireEvent.click(next);
    expect(screen.getByTestId("timeline-step-label").textContent).toContain("sourceIndex 3");
    expect(comparison()).toContain("两侧状态一致");
    // 第 2 步（sourceIndex 4）：首个分歧。
    fireEvent.click(next);
    expect(screen.getByTestId("timeline-step-label").textContent).toContain("sourceIndex 4");
    expect(comparison()).toContain("与核心结果的首个分歧一致");
    // 回到开头后比较区消失。
    fireEvent.click(screen.getByRole("button", { name: "回到开头" }));
    expect(screen.queryByTestId("timeline-step-states")).toBeNull();
  });

  it("G01：跳到首个分歧直达分歧步；分歧步即首个可比较步，上一步回到起点", () => {
    const result = buildWorkerResult(loadFixtureLocal("G01"));
    // G01 的首个分歧（sourceIndex 4）恰是检查点后第一个可比较步。
    expect(result.evaluation.firstDivergence?.sourceIndex).toBe(4);
    expect(result.evaluation.checkpointIndex).toBe(4);
    render(<Timeline result={result} />);
    fireEvent.click(screen.getByRole("button", { name: "跳到首个分歧" }));
    expect(screen.getByTestId("timeline-step-label").textContent).toContain(
      `sourceIndex ${result.evaluation.firstDivergence?.sourceIndex}`,
    );
    expect(screen.getByTestId("timeline-step-comparison").textContent).toContain(
      "与核心结果的首个分歧一致",
    );
    // 再上一步即回到起点，比较区消失（分歧前无可比较的步）。
    fireEvent.click(screen.getByRole("button", { name: "上一步" }));
    expect(screen.queryByTestId("timeline-step-states")).toBeNull();
  });

  it("N01：逐步回放到末尾始终一致", () => {
    const result = buildWorkerResult(loadFixtureLocal("N01"));
    render(<Timeline result={result} />);
    fireEvent.click(screen.getByRole("button", { name: "跳到末尾" }));
    expect(screen.getByTestId("timeline-step-comparison").textContent).toContain(
      "两侧状态一致",
    );
    expect(screen.queryByRole("button", { name: "跳到首个分歧" })).toBeNull();
  });
});

describe("Timeline：chunk 展开编号说明", () => {
  it("含 chunk 事件的轨迹显示展开编号说明", () => {
    const text = [
      '{"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}',
      '{"type":"TEXT_MESSAGE_CHUNK","messageId":"msg-1","role":"assistant","delta":"你好，"}',
      '{"type":"TEXT_MESSAGE_CHUNK","messageId":"msg-1","delta":"世界"}',
      '{"type":"RUN_FINISHED","threadId":"thread-1","runId":"run-1"}',
    ].join("\n");
    const events = parseInput(text, "jsonl");
    const fixture = buildAnalyzeFixture(events, {
      strategy: "RESUME_FROM_CHECKPOINT",
      injections: [],
    }, "CHUNK-TRACE");
    const result = buildWorkerResult(fixture);
    expect(result.importedEventCount).toBe(4);
    expect(result.expandedEventCount).toBeGreaterThan(4);
    render(<Timeline result={result} />);
    expect(screen.getByTestId("timeline-chunk-note").textContent).toContain("chunk 事件已展开");
  });
});
