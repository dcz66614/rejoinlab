/**
 * P031 RejoinLab — T009: Worker 协议测试（jobId、请求校验）。
 */
import { describe, expect, it } from "vitest";
import {
  createJobId,
  validateWorkerRequest,
} from "../../src/worker/protocol.js";

describe("Worker 协议：jobId", () => {
  it("每次生成的 jobId 唯一", () => {
    const ids = new Set(Array.from({ length: 200 }, () => createJobId()));
    expect(ids.size).toBe(200);
  });

  it("jobId 为非空字符串", () => {
    expect(typeof createJobId()).toBe("string");
    expect(createJobId().length).toBeGreaterThan(0);
  });
});

describe("Worker 协议：请求校验", () => {
  it("合法的 ANALYZE 与 CANCEL 通过校验", () => {
    expect(
      validateWorkerRequest({
        type: "ANALYZE",
        jobId: "job-1",
        input: { scenarioId: "S", events: [], recovery: { strategy: "RESUME_FROM_CHECKPOINT" } },
      }),
    ).toBeNull();
    expect(validateWorkerRequest({ type: "CANCEL", jobId: "job-1" })).toBeNull();
  });

  it("非法消息被拒绝：非对象、未知类型、空 jobId、缺失 input", () => {
    expect(validateWorkerRequest(null)).not.toBeNull();
    expect(validateWorkerRequest("ANALYZE")).not.toBeNull();
    expect(validateWorkerRequest({ type: "NOPE", jobId: "job-1" })).not.toBeNull();
    expect(validateWorkerRequest({ type: "CANCEL", jobId: "" })).not.toBeNull();
    expect(validateWorkerRequest({ type: "CANCEL" })).not.toBeNull();
    expect(validateWorkerRequest({ type: "ANALYZE", jobId: "job-1" })).not.toBeNull();
    expect(
      validateWorkerRequest({
        type: "ANALYZE",
        jobId: "job-1",
        input: { scenarioId: "S", events: "nope", recovery: {} },
      }),
    ).not.toBeNull();
  });
});
