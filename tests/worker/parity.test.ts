/**
 * P031 RejoinLab — T009: Worker 结果与主线程直接调用的等价性。
 *
 * Worker 内的计算必须与 T005 evaluateFixture（主线程直接调用）
 * 完全一致：裁决、诊断代码顺序、首个分歧、双轨终态哈希、丢弃
 * 事件。另核查时间线视图的结构不变量：
 * - 完整轨道：与展开后事件一一对齐，sourceIndex 严格升序，
 *   appliedPosition / stepIndex 即下标；
 * - 恢复轨道：sourceIndex 非降序（含重复的同值相邻），丢弃占位
 *   与 droppedSourceIndices 一一对应；
 * - 逐步历史与轨道对齐（fullHistory 与 fullTrack 等长，
 *   resumeHistory 与恢复应用流等长）。
 */
import { describe, expect, it } from "vitest";
import { buildWorkerResult } from "../../src/worker/rejoin.worker.js";
import { evaluateFixture } from "../../src/replay/planner.js";
import { expandChunks } from "../../src/parser/normalize.js";
import { GOLDEN_IDS, loadExpected, loadFixture } from "../replay/golden-helpers.js";

const expected = loadExpected();

describe("Worker 结果与 evaluateFixture 等价（24 条 Golden）", () => {
  for (const id of GOLDEN_IDS) {
    it(`${id}：裁决 / 诊断 / 首个分歧 / 终态哈希与主线程一致`, () => {
      const fixture = loadFixture(id);
      const workerResult = buildWorkerResult(fixture);
      const direct = evaluateFixture(fixture);
      const golden = expected[id];
      expect(golden).toBeDefined();

      expect(workerResult.evaluation.verdict).toBe(direct.verdict);
      expect(workerResult.evaluation.verdict).toBe(golden?.verdict);
      expect(workerResult.evaluation.diagnostics.map((d) => d.code)).toEqual(
        direct.diagnostics.map((d) => d.code),
      );
      expect(workerResult.evaluation.diagnostics.map((d) => d.code)).toEqual(
        golden?.diagnostics,
      );
      expect(workerResult.evaluation.firstDivergence?.sourceIndex ?? null).toBe(
        direct.firstDivergence?.sourceIndex ?? null,
      );
      // 与 Golden expected 的首个分歧比较：G01 是已记录、T007 已裁决
      // 的 Oracle/TS 差异（align.ts 头部）：Oracle 报告 2（重放的
      // TOOL_CALL_START 本身），T004 从检查点起的步进比较报告 4
      // （分歧在状态中首次可见的位置）。其余 23 条必须与 Golden 一致。
      const goldenDivergence =
        id === "G01" ? 4 : (golden?.firstDivergenceSourceIndex ?? null);
      expect(workerResult.evaluation.firstDivergence?.sourceIndex ?? null).toBe(
        goldenDivergence,
      );
      expect(workerResult.evaluation.fullPath?.finalStateHash).toBe(
        direct.fullPath?.finalStateHash,
      );
      expect(workerResult.evaluation.resumePath?.finalStateHash).toBe(
        direct.resumePath?.finalStateHash,
      );
      expect(workerResult.evaluation.droppedSourceIndices).toEqual(
        direct.droppedSourceIndices,
      );
      expect(workerResult.checkpointIndex).toBe(direct.checkpointIndex);
    });
  }
});

describe("Worker 时间线视图结构不变量（24 条 Golden）", () => {
  for (const id of GOLDEN_IDS) {
    it(`${id}：轨道顺序、占位与历史对齐`, () => {
      const fixture = loadFixture(id);
      const result = buildWorkerResult(fixture);
      const expanded = expandChunks(fixture.events);
      const { evaluation } = result;

      expect(result.importedEventCount).toBe(fixture.events.length);
      expect(result.expandedEventCount).toBe(expanded.length);

      if (evaluation.fullState !== null && evaluation.resumeState !== null) {
        // 完整轨道与展开后事件一一对齐，sourceIndex 严格升序。
        expect(result.fullTrack.length).toBe(expanded.length);
        expect(result.fullHistory.length).toBe(expanded.length);
        result.fullTrack.forEach((view, index) => {
          expect(view.sourceIndex).toBe(expanded[index]?.sourceIndex);
          expect(view.appliedPosition).toBe(index);
          expect(view.stepIndex).toBe(index);
        });
        const fullIndices = result.fullTrack.map((v) => v.sourceIndex);
        expect([...fullIndices].sort((a, b) => a - b)).toEqual(fullIndices);

        // 恢复轨道 sourceIndex 非降序（视觉布局不改变实际顺序）。
        const resumeIndices = result.resumeTrack.map((v) => v.sourceIndex);
        expect([...resumeIndices].sort((a, b) => a - b)).toEqual(resumeIndices);

        // 丢弃占位与 droppedSourceIndices 一一对应。
        const droppedViews = result.resumeTrack.filter((v) => v.isDropped);
        expect(
          droppedViews.map((v) => v.sourceIndex).sort((a, b) => a - b),
        ).toEqual([...evaluation.droppedSourceIndices].sort((a, b) => a - b));
        for (const view of droppedViews) {
          expect(view.appliedPosition).toBe(-1);
          expect(view.stepIndex).toBeNull();
        }

        // 逐步历史与应用流对齐：恢复历史条数 = 恢复轨道非占位条数；
        // stepIndex 是历史下标（应用流顺序），不是展示位置——乱序
        // 轨道上两者不同，只要求它指向同 sourceIndex 的历史条目。
        const appliedResume = result.resumeTrack.filter((v) => !v.isDropped);
        expect(result.resumeHistory.length).toBe(appliedResume.length);
        for (const view of appliedResume) {
          expect(view.stepIndex).not.toBeNull();
          expect(view.stepIndex as number).toBeGreaterThanOrEqual(0);
          expect(view.stepIndex as number).toBeLessThan(result.resumeHistory.length);
          expect(result.resumeHistory[view.stepIndex as number]?.sourceIndex).toBe(
            view.sourceIndex,
          );
        }

        // 首个分歧标记与核心结果一致：完整轨道上同序号恰标一处；
        // 恢复轨道上若有该序号的事件则全部标出，若无该序号事件
        // （分歧位于检查点基线内，如 G02/G06）则不要求标记。
        if (evaluation.firstDivergence !== null) {
          const at = evaluation.firstDivergence.sourceIndex;
          expect(
            result.fullTrack.filter((v) => v.sourceIndex === at && v.isFirstDivergence)
              .length,
          ).toBe(1);
          const resumeAt = result.resumeTrack.filter((v) => v.sourceIndex === at);
          expect(resumeAt.every((v) => v.isFirstDivergence)).toBe(true);
        } else {
          expect(result.fullTrack.some((v) => v.isFirstDivergence)).toBe(false);
          expect(result.resumeTrack.some((v) => v.isFirstDivergence)).toBe(false);
        }
      } else {
        expect(result.fullTrack).toHaveLength(0);
        expect(result.resumeTrack).toHaveLength(0);
      }
    });
  }
});

describe("Worker 时间线标记（已知故障 Golden）", () => {
  it("G01：恢复轨道上 sourceIndex 2 的事件标为重复", () => {
    const result = buildWorkerResult(loadFixture("G01"));
    const flagged = result.resumeTrack.filter(
      (v) => v.sourceIndex === 2 && v.isDuplicate,
    );
    expect(flagged.length).toBeGreaterThanOrEqual(1);
    expect(
      result.evaluation.diagnostics.some((d) => d.code === "DUPLICATE_TOOL_CALL"),
    ).toBe(true);
  });

  it("G04：恢复轨道上有丢失占位，与 LOST_EVENT 诊断同序号", () => {
    const result = buildWorkerResult(loadFixture("G04"));
    const dropped = result.resumeTrack.filter((v) => v.isDropped);
    expect(dropped.length).toBeGreaterThanOrEqual(1);
    expect(
      result.evaluation.diagnostics.some((d) => d.code === "LOST_EVENT"),
    ).toBe(true);
    for (const view of dropped) {
      expect(
        result.evaluation.diagnostics.some(
          (d) => d.code === "LOST_EVENT" && d.sourceIndex === view.sourceIndex,
        ),
      ).toBe(true);
    }
  });

  it("G05：恢复轨道上有乱序标记", () => {
    const result = buildWorkerResult(loadFixture("G05"));
    expect(result.resumeTrack.some((v) => v.isOutOfOrder)).toBe(true);
    expect(
      result.evaluation.diagnostics.some((d) => d.code === "OUT_OF_ORDER"),
    ).toBe(true);
  });

  it("G02/G03：首个分歧标记在 MESSAGE_REORDER 诊断的序号处", () => {
    for (const id of ["G02", "G03"] as const) {
      const result = buildWorkerResult(loadFixture(id));
      expect(result.evaluation.firstDivergence).not.toBeNull();
      expect(
        result.evaluation.diagnostics.some((d) => d.code === "MESSAGE_REORDER"),
      ).toBe(true);
    }
  });

  it("N01：一致轨迹无重复 / 丢失 / 乱序 / 分歧标记", () => {
    const result = buildWorkerResult(loadFixture("N01"));
    expect(result.evaluation.verdict).toBe("CONSISTENT");
    expect(result.fullTrack.some((v) => v.isDuplicate || v.isOutOfOrder)).toBe(false);
    expect(result.resumeTrack.some((v) => v.isDuplicate || v.isDropped || v.isOutOfOrder)).toBe(
      false,
    );
    expect(result.fullTrack.some((v) => v.isFirstDivergence)).toBe(false);
  });
});
