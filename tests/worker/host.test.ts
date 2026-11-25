/**
 * P031 RejoinLab — T009: Worker host 测试（不依赖真实 Worker 线程，
 * 直接驱动 createWorkerHost）。
 *
 * 重点实测项（非接口存在性检查）：
 * - ANALYZE → RESULT，jobId 原样回显，结果与 evaluateFixture 一致；
 * - 未知注入算子 → ERROR（jobId 正确）；
 * - ANALYZE 后立即 CANCEL → 只发 CANCELLED，绝不发 RESULT；
 * - 先 ANALYZE A、再 ANALYZE B → 只有 B 的 RESULT，A 只发 CANCELLED；
 * - 非法消息 → ERROR（可恢复 jobId 时）或静默丢弃；
 * - 未知 jobId 的 CANCEL 被忽略，不抛错、不发响应。
 */
import { describe, expect, it } from "vitest";
import { createWorkerHost } from "../../src/worker/rejoin.worker.js";
import type { WorkerResponse } from "../../src/worker/protocol.js";
import { loadFixture } from "../replay/golden-helpers.js";

const flush = async (ms = 25): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function createHarness() {
  const responses: WorkerResponse[] = [];
  const host = createWorkerHost((response) => {
    responses.push(response);
  });
  return { host, responses };
}

describe("Worker host：ANALYZE / RESULT", () => {
  it("正常计算返回 RESULT，jobId 100% 正确，结果与 Golden G01 一致", async () => {
    const { host, responses } = createHarness();
    host.handleMessage({
      type: "ANALYZE",
      jobId: "job-g01",
      input: loadFixture("G01"),
    });
    await flush();
    expect(responses).toHaveLength(1);
    const response = responses[0];
    expect(response?.type).toBe("RESULT");
    if (response?.type !== "RESULT") return;
    expect(response.jobId).toBe("job-g01");
    expect(response.result.evaluation.scenarioId).toBe("G01");
    expect(response.result.evaluation.verdict).toBe("INCONSISTENT");
    expect(
      response.result.evaluation.diagnostics.map((d) => d.code),
    ).toContain("DUPLICATE_TOOL_CALL");
    expect(response.result.fullTrack.length).toBeGreaterThan(0);
    expect(response.result.resumeTrack.length).toBeGreaterThan(0);
  });

  it("未知注入算子 → ERROR，jobId 正确（错误结果传递正确）", async () => {
    const { host, responses } = createHarness();
    const fixture = loadFixture("N01");
    host.handleMessage({
      type: "ANALYZE",
      jobId: "job-bad-op",
      input: {
        ...fixture,
        recovery: {
          ...fixture.recovery,
          injections: [{ op: "NO_SUCH_OPERATOR" }],
        },
      },
    });
    await flush();
    expect(responses).toHaveLength(1);
    const response = responses[0];
    expect(response?.type).toBe("ERROR");
    if (response?.type !== "ERROR") return;
    expect(response.jobId).toBe("job-bad-op");
    expect(response.error.message).toContain("NO_SUCH_OPERATOR");
  });

  it("非法消息 → ERROR（jobId 可恢复时）；无 jobId 时静默丢弃", async () => {
    const { host, responses } = createHarness();
    host.handleMessage({ type: "NOPE", jobId: "job-bad-msg" });
    host.handleMessage(null);
    host.handleMessage({ type: "ANALYZE", jobId: "job-bad-input" });
    await flush();
    expect(responses).toHaveLength(2);
    expect(responses[0]?.type).toBe("ERROR");
    expect(responses[0]?.jobId).toBe("job-bad-msg");
    expect(responses[1]?.type).toBe("ERROR");
    expect(responses[1]?.jobId).toBe("job-bad-input");
  });
});

describe("Worker host：取消（实测）", () => {
  it("ANALYZE 后立即 CANCEL：只发 CANCELLED，绝不发 RESULT", async () => {
    const { host, responses } = createHarness();
    host.handleMessage({
      type: "ANALYZE",
      jobId: "job-cancel-me",
      input: loadFixture("G02"),
    });
    // 与 ANALYZE 同一任务队列内立即取消：host 让出的宏任务尚未执行。
    host.handleMessage({ type: "CANCEL", jobId: "job-cancel-me" });
    await flush();
    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual({ type: "CANCELLED", jobId: "job-cancel-me" });
  });

  it("新 ANALYZE 取代旧任务：旧任务只发 CANCELLED，只有新任务的 RESULT", async () => {
    const { host, responses } = createHarness();
    host.handleMessage({
      type: "ANALYZE",
      jobId: "job-old",
      input: loadFixture("G01"),
    });
    host.handleMessage({
      type: "ANALYZE",
      jobId: "job-new",
      input: loadFixture("N01"),
    });
    await flush();
    const results = responses.filter((r) => r.type === "RESULT");
    const cancelled = responses.filter((r) => r.type === "CANCELLED");
    expect(results).toHaveLength(1);
    expect(results[0]?.jobId).toBe("job-new");
    if (results[0]?.type === "RESULT") {
      expect(results[0].result.evaluation.scenarioId).toBe("N01");
    }
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.jobId).toBe("job-old");
    // 旧任务结果覆盖新任务：0 次。
    expect(responses.some((r) => r.jobId === "job-old" && r.type === "RESULT")).toBe(false);
  });

  it("未知 jobId 的 CANCEL 被忽略：不抛错、不发任何响应", async () => {
    const { host, responses } = createHarness();
    expect(() =>
      host.handleMessage({ type: "CANCEL", jobId: "job-never-seen" }),
    ).not.toThrow();
    await flush();
    expect(responses).toHaveLength(0);
  });

  it("已结算任务的 CANCEL 被忽略：RESULT 发出后不再补发 CANCELLED", async () => {
    const { host, responses } = createHarness();
    host.handleMessage({
      type: "ANALYZE",
      jobId: "job-done",
      input: loadFixture("N01"),
    });
    await flush();
    expect(responses).toHaveLength(1);
    expect(responses[0]?.type).toBe("RESULT");
    host.handleMessage({ type: "CANCEL", jobId: "job-done" });
    await flush();
    expect(responses).toHaveLength(1);
  });
});
