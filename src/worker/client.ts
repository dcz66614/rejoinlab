/**
 * P031 RejoinLab — T009: 主线程 Worker 客户端。
 *
 * 职责：
 * - 创建真正的 Web Worker（`new Worker(new URL("./rejoin.worker.ts",
 *   import.meta.url), { type: "module" })`，Vite 打包为独立 chunk），
 *   把双轨分析发过去；主线程绝不在 Worker 路径下同步跑分析。
 * - jobId 唯一、响应按 jobId 匹配：旧任务的迟到响应一律丢弃，
 *   绝不覆盖新任务的结果。
 * - 取消真实生效：cancel() 先发 CANCEL 消息（覆盖“尚未开始计算”
 *   的窗口），再 terminate 掉 Worker 线程（真正停止一次已开始的
 *   同步计算），并为下一个任务生成全新的 Worker。待处理的 Promise
 *   以 WorkerCancelledError 拒绝，调用方据此区分“用户取消”与
 *   “计算出错”。
 *
 * 没有 Worker API 的环境（如 jsdom 测试环境）：退回到 in-process
 * host——同一份 worker 协议 host 代码（src/worker/rejoin.worker.ts
 * 的 createWorkerHost）在当前线程内执行，消息、jobId、取消语义
 * 完全相同，只是没有独立线程。这一回退只在平台根本没有 Worker
 * 时发生，mode 会如实暴露为 "in-process"，App 会在界面上注明，
 * 绝不冒充独立线程的结果；真实浏览器中永远走 "worker"。T011
 * E2E（真实 Chromium）负责核验真实 Worker 线程路径。
 */

import { createWorkerHost } from "./rejoin.worker.js";
import {
  createJobId,
  type WorkerAnalysisResult,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.js";
import type { Injection } from "../replay/inject.js";
import type { ReplayFixture } from "../replay/planner.js";
import type { NormalizedEvent } from "../protocol/types.js";
import type { ScenarioConfig } from "../ui/analyze.js";

/** 用户取消分析（暂停 / 重置 / 清空 / 被新任务取代）。 */
export class WorkerCancelledError extends Error {
  constructor() {
    super("分析已被取消");
    this.name = "WorkerCancelledError";
  }
}

/** 客户端与 Worker 线程（或 in-process host）之间的最小接口。 */
export interface WorkerLike {
  postMessage: (message: WorkerRequest) => void;
  terminate: () => void;
  onmessage: ((event: { readonly data: WorkerResponse }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export type WorkerMode = "worker" | "in-process";

export interface CreatedWorker {
  readonly worker: WorkerLike;
  readonly mode: WorkerMode;
}

export type WorkerFactory = () => CreatedWorker;

/** 真实 Worker 优先；无 Worker API 时用同一份 host 代码 in-process 执行。 */
export function defaultWorkerFactory(): CreatedWorker {
  if (typeof Worker !== "undefined") {
    const worker = new Worker(new URL("./rejoin.worker.ts", import.meta.url), {
      type: "module",
    });
    return { worker: worker as unknown as WorkerLike, mode: "worker" };
  }
  let host: { handleMessage: (message: unknown) => void } | null = null;
  let terminated = false;
  const fake: WorkerLike = {
    postMessage(message) {
      if (!terminated) host?.handleMessage(message);
    },
    terminate() {
      terminated = true;
      host = null;
    },
    onmessage: null,
    onerror: null,
  };
  host = createWorkerHost((response) => {
    if (!terminated) fake.onmessage?.({ data: response });
  });
  return { worker: fake, mode: "in-process" };
}

/**
 * 把界面文本框的“留空”语义翻译成 T005 能理解的缺省。
 * 与 src/ui/analyze.ts 的 normalizeInjection（F1）完全相同的规则，
 * 复制于此是因为 analyze.ts 是 T008 冻结文件、T009 不得修改；
 * 两处规则必须保持一致，见 tests/worker/client.test.ts 的对照测试。
 */
function normalizeInjection(injection: Injection): Injection {
  if (injection.op !== "MESSAGE_ID_REMAP") return injection;
  return {
    ...injection,
    messageId: injection.messageId === "" ? undefined : injection.messageId,
    newMessageId:
      injection.newMessageId === "" ? undefined : injection.newMessageId,
  };
}

/** 由界面实验配置组装 Worker 输入（与 analyze.ts runAnalysis 同构）。 */
export function buildAnalyzeFixture(
  events: readonly NormalizedEvent[],
  scenario: ScenarioConfig,
  scenarioId: string,
): ReplayFixture {
  return {
    scenarioId,
    events,
    recovery: {
      strategy: scenario.strategy,
      ...(scenario.disconnectAfter !== undefined
        ? { disconnectAfter: scenario.disconnectAfter }
        : {}),
      ...(scenario.resumeAfterSourceIndex !== undefined
        ? { resumeAfterSourceIndex: scenario.resumeAfterSourceIndex }
        : {}),
      injections: scenario.injections.map(normalizeInjection),
    },
  };
}

interface PendingJob {
  readonly resolve: (result: WorkerAnalysisResult) => void;
  readonly reject: (error: unknown) => void;
}

export class RejoinWorkerClient {
  readonly mode: WorkerMode;
  private readonly createWorker: WorkerFactory;
  private worker: WorkerLike;
  private currentJobId: string | null = null;
  private pending: PendingJob | null = null;

  constructor(createWorker: WorkerFactory = defaultWorkerFactory) {
    this.createWorker = createWorker;
    const created = createWorker();
    this.worker = created.worker;
    this.mode = created.mode;
    this.worker.onmessage = (event) => this.handleMessage(event.data);
    this.worker.onerror = () => {
      this.failPending(new Error("Worker 线程出错，分析未完成"));
    };
  }

  /**
   * 提交一次分析。开始新任务即取代尚未结算的旧任务（旧任务的
   * Promise 以 WorkerCancelledError 拒绝，其迟到响应会被 jobId
   * 检查丢弃）。返回的 Promise 只在收到与本次 jobId 一致的
   * RESULT 时兑现。
   */
  analyze(
    events: readonly NormalizedEvent[],
    scenario: ScenarioConfig,
    scenarioId: string,
  ): Promise<WorkerAnalysisResult> {
    if (this.pending !== null) {
      const superseded = this.pending;
      this.pending = null;
      superseded.reject(new WorkerCancelledError());
    }
    const fixture = buildAnalyzeFixture(events, scenario, scenarioId);
    const jobId = createJobId();
    this.currentJobId = jobId;
    const promise = new Promise<WorkerAnalysisResult>((resolve, reject) => {
      this.pending = { resolve, reject };
    });
    this.worker.postMessage({ type: "ANALYZE", jobId, input: fixture });
    return promise;
  }

  /**
   * 取消当前任务（真实取消）：先发 CANCEL，再 terminate 线程并
   * 生成全新 Worker。待处理 Promise 以 WorkerCancelledError 拒绝。
   * 无待处理任务时不做任何事。
   */
  cancel(): void {
    if (this.pending === null && this.currentJobId === null) return;
    const jobId = this.currentJobId;
    if (jobId !== null) {
      try {
        this.worker.postMessage({ type: "CANCEL", jobId });
      } catch {
        // Worker 已死：terminate 本来就是取消手段，忽略。
      }
    }
    this.respawn();
    if (this.pending !== null) {
      const pending = this.pending;
      this.pending = null;
      this.currentJobId = null;
      pending.reject(new WorkerCancelledError());
    } else {
      this.currentJobId = null;
    }
  }

  /** 释放 Worker（组件卸载 / 清空时调用）。 */
  dispose(): void {
    this.cancel();
    try {
      this.worker.terminate();
    } catch {
      // 已终止的 Worker 再次 terminate 是无操作，忽略。
    }
  }

  private respawn(): void {
    try {
      this.worker.terminate();
    } catch {
      // 同上，忽略。
    }
    const created = this.createWorker();
    this.worker = created.worker;
    this.worker.onmessage = (event) => this.handleMessage(event.data);
    this.worker.onerror = () => {
      this.failPending(new Error("Worker 线程出错，分析未完成"));
    };
  }

  private failPending(error: unknown): void {
    if (this.pending === null) return;
    const pending = this.pending;
    this.pending = null;
    this.currentJobId = null;
    pending.reject(error);
  }

  private handleMessage(response: WorkerResponse): void {
    // 旧任务的迟到响应：jobId 与当前任务不一致，一律丢弃。
    if (response.jobId !== this.currentJobId) return;
    if (this.pending === null) return;
    const pending = this.pending;
    this.pending = null;
    this.currentJobId = null;
    if (response.type === "RESULT") {
      pending.resolve(response.result);
    } else if (response.type === "ERROR") {
      pending.reject(new Error(response.error.message));
    } else {
      pending.reject(new WorkerCancelledError());
    }
  }
}
