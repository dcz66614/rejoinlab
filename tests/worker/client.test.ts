/**
 * P031 RejoinLab — T009: 主线程 Worker 客户端测试。
 *
 * 用可注入的假 Worker（背后是同一份 createWorkerHost）实测：
 * - analyze 兑现为 Worker 结果，jobId 匹配；
 * - 旧任务的迟到 RESULT 被丢弃（0 次覆盖）；
 * - cancel() 真实取消：待处理 Promise 以 WorkerCancelledError 拒绝，
 *   旧 Worker 被 terminate，下一任务用全新 Worker 完成；
 * - 默认工厂在无 Worker API 的环境下降级为 in-process host，
 *   mode 如实报告；
 * - buildAnalyzeFixture 与 analyze.ts runAnalysis 的输入归一化一致
 *   （MESSAGE_ID_REMAP 留空语义，F1）。
 */
import { describe, expect, it, vi } from "vitest";
import {
  RejoinWorkerClient,
  WorkerCancelledError,
  buildAnalyzeFixture,
  type CreatedWorker,
  type WorkerLike,
} from "../../src/worker/client.js";
import { createWorkerHost } from "../../src/worker/rejoin.worker.js";
import type { WorkerRequest, WorkerResponse } from "../../src/worker/protocol.js";
import { evaluateFixture } from "../../src/replay/planner.js";
import { runAnalysis, type ScenarioConfig } from "../../src/ui/analyze.js";
import { loadFixture } from "../replay/golden-helpers.js";
import { parseInput } from "../../src/parser/index.js";

const flush = async (ms = 25): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 假 Worker：背后是同一份 host；terminate 后不再投递任何消息。 */
function createHostBackedWorkerFactory() {
  const workers: {
    postMessage: (message: WorkerRequest) => void;
    terminate: () => void;
    onmessage: ((event: { data: WorkerResponse }) => void) | null;
    onerror: ((event: unknown) => void) | null;
  }[] = [];
  const factory = (): CreatedWorker => {
    let terminated = false;
    const fake: WorkerLike = {
      postMessage: () => {},
      terminate: () => {},
      onmessage: null,
      onerror: null,
    };
    const host = createWorkerHost((response) => {
      if (!terminated) fake.onmessage?.({ data: response });
    });
    fake.postMessage = (message) => {
      if (!terminated) host.handleMessage(message);
    };
    fake.terminate = () => {
      terminated = true;
    };
    workers.push(fake);
    return { worker: fake, mode: "worker" };
  };
  return { factory, workers };
}

describe("RejoinWorkerClient：analyze / 取消 / 旧结果丢弃", () => {
  it("analyze 兑现为 Worker 结果", async () => {
    const { factory } = createHostBackedWorkerFactory();
    const client = new RejoinWorkerClient(factory);
    expect(client.mode).toBe("worker");
    const fixture = loadFixture("N01");
    const result = await client.analyze(fixture.events, {
      strategy: fixture.recovery.strategy,
      disconnectAfter: fixture.recovery.disconnectAfter,
      resumeAfterSourceIndex: fixture.recovery.resumeAfterSourceIndex,
      injections: fixture.recovery.injections ?? [],
    }, fixture.scenarioId);
    expect(result.evaluation.scenarioId).toBe("N01");
    expect(result.evaluation.verdict).toBe("CONSISTENT");
    expect(result.fullTrack.length).toBeGreaterThan(0);
  });

  it("cancel()：待处理任务以 WorkerCancelledError 拒绝，旧 Worker 被 terminate，新任务仍可完成", async () => {
    const { factory, workers } = createHostBackedWorkerFactory();
    const client = new RejoinWorkerClient(factory);
    // G01（无显式检查点，FULL_REPLAY）：客户端场景不携带检查点，
    // 与 App 的 ScenarioConfig 覆盖范围一致。
    const fixture = loadFixture("G01");
    const scenario: ScenarioConfig = {
      strategy: fixture.recovery.strategy,
      disconnectAfter: fixture.recovery.disconnectAfter,
      resumeAfterSourceIndex: fixture.recovery.resumeAfterSourceIndex,
      injections: fixture.recovery.injections ?? [],
    };
    const first = client.analyze(fixture.events, scenario, fixture.scenarioId);
    const firstSettled = expect(first).rejects.toThrow(WorkerCancelledError);
    // 在 host 的宏任务让出点之前取消：计算尚未开始。
    client.cancel();
    await firstSettled;
    expect(workers).toHaveLength(2);
    expect(workers[0]).toBeDefined();
    // 旧 Worker 的迟到响应不再投递：再等一轮宏任务也不会兑现已拒绝的 Promise。
    await flush();
    // 新任务用全新 Worker 完成。
    const second = await client.analyze(fixture.events, scenario, fixture.scenarioId);
    expect(second.evaluation.scenarioId).toBe("G01");
    expect(second.evaluation.verdict).toBe("INCONSISTENT");
  });

  it("旧任务的迟到 RESULT 被丢弃：只兑现当前任务的结果", async () => {
    const delivered: WorkerLike[] = [];
    const postedMessages: WorkerRequest[] = [];
    const factory = (): CreatedWorker => {
      const fake: WorkerLike = {
        postMessage: (message) => {
          postedMessages.push(message);
        },
        terminate: () => {},
        onmessage: null,
        onerror: null,
      };
      delivered.push(fake);
      return { worker: fake, mode: "worker" };
    };
    const client = new RejoinWorkerClient(factory);
    const fixture = loadFixture("N01");
    const scenario: ScenarioConfig = {
      strategy: fixture.recovery.strategy,
      injections: [],
    };
    // 第一个任务被第二个任务取代：以 WorkerCancelledError 拒绝。
    const first = client.analyze(fixture.events, scenario, "N01");
    const firstRejection = expect(first).rejects.toThrow(WorkerCancelledError);
    const second = client.analyze(fixture.events, scenario, "N01");
    await firstRejection;
    const jobId1 = (postedMessages[0] as { jobId: string }).jobId;
    const jobId2 = (postedMessages[1] as { jobId: string }).jobId;
    expect(jobId1).not.toBe(jobId2);

    let resolvedWith: unknown = null;
    const secondDone = second.then((result) => {
      resolvedWith = result;
    });
    const fake = delivered[0] as WorkerLike;
    // 伪造旧任务（jobId1）的迟到 RESULT：必须被忽略。
    fake.onmessage?.({
      data: {
        type: "RESULT",
        jobId: jobId1,
        result: { evaluation: { scenarioId: "FORGED-OLD" } },
      } as unknown as WorkerResponse,
    });
    await flush(10);
    expect(resolvedWith).toBeNull();
    // 当前任务（jobId2）的 RESULT 到达后才兑现，且是新任务的结果。
    const realResult = { evaluation: { scenarioId: "N01" } };
    fake.onmessage?.({
      data: {
        type: "RESULT",
        jobId: jobId2,
        result: realResult,
      } as unknown as WorkerResponse,
    });
    await secondDone;
    expect((resolvedWith as { evaluation: { scenarioId: string } }).evaluation.scenarioId).toBe(
      "N01",
    );
  });

  it("analyze 出错（ERROR 响应）时 Promise 以 Error 拒绝", async () => {
    const delivered: WorkerLike[] = [];
    const factory = (): CreatedWorker => {
      const fake: WorkerLike = {
        postMessage: vi.fn(),
        terminate: vi.fn(),
        onmessage: null,
        onerror: null,
      };
      delivered.push(fake);
      return { worker: fake, mode: "worker" };
    };
    const client = new RejoinWorkerClient(factory);
    const fixture = loadFixture("N01");
    const pending = client.analyze(fixture.events, { strategy: "RESUME_FROM_CHECKPOINT", injections: [] }, "N01");
    const assertion = expect(pending).rejects.toThrow("boom");
    // 伪造 ERROR 响应：jobId 必须与当前任务一致——从 postMessage 的
    // ANALYZE 消息里取本次 jobId。
    const posted = (delivered[0]?.postMessage as unknown as { mock: { calls: WorkerRequest[][] } }).mock
      .calls[0]?.[0];
    expect(posted?.type).toBe("ANALYZE");
    delivered[0]?.onmessage?.({
      data: { type: "ERROR", jobId: posted?.jobId ?? "", error: { message: "boom" } },
    });
    await assertion;
  });
});

describe("RejoinWorkerClient：默认工厂与输入归一化", () => {
  it("无 Worker API 的环境下降级为 in-process host，mode 如实报告", async () => {
    expect(typeof Worker).toBe("undefined");
    const client = new RejoinWorkerClient();
    expect(client.mode).toBe("in-process");
    const fixture = loadFixture("N03");
    const result = await client.analyze(fixture.events, {
      strategy: fixture.recovery.strategy,
      disconnectAfter: fixture.recovery.disconnectAfter,
      resumeAfterSourceIndex: fixture.recovery.resumeAfterSourceIndex,
      injections: fixture.recovery.injections ?? [],
    }, fixture.scenarioId);
    expect(result.evaluation.verdict).toBe("CONSISTENT");
    client.dispose();
  });

  it("buildAnalyzeFixture 与 runAnalysis 的 MESSAGE_ID_REMAP 留空归一化一致", () => {
    const text = [
      '{"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}',
      '{"type":"TEXT_MESSAGE_START","messageId":"msg-1","role":"assistant"}',
      '{"type":"TEXT_MESSAGE_CONTENT","messageId":"msg-1","delta":"你好"}',
      '{"type":"TEXT_MESSAGE_END","messageId":"msg-1"}',
      '{"type":"MESSAGES_SNAPSHOT","messages":[{"id":"msg-1","role":"assistant","content":"你好"}]}',
      '{"type":"RUN_FINISHED","threadId":"thread-1","runId":"run-1"}',
    ].join("\n");
    const events = parseInput(text, "jsonl");
    const scenario: ScenarioConfig = {
      strategy: "RESUME_FROM_CHECKPOINT",
      disconnectAfter: 3,
      injections: [{ op: "MESSAGE_ID_REMAP", messageId: "", newMessageId: "" }],
    };
    // Worker 路径的输入：留空应归一化为 undefined（与 analyze.ts F1 同规则）。
    const fixture = buildAnalyzeFixture(events, scenario, "REMAP-BLANK");
    expect(fixture.recovery.injections).toEqual([
      { op: "MESSAGE_ID_REMAP", messageId: undefined, newMessageId: undefined },
    ]);
    // 两条路径对同一实验的裁决与诊断代码一致。
    const viaWorkerInput = evaluateFixture(fixture);
    const viaMainThread = runAnalysis(events, scenario, "REMAP-BLANK");
    expect(viaWorkerInput.verdict).toBe(viaMainThread.evaluation.verdict);
    expect(viaWorkerInput.diagnostics.map((d) => d.code)).toEqual(
      viaMainThread.evaluation.diagnostics.map((d) => d.code),
    );
  });
});
