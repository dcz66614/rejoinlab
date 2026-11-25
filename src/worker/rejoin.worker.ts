/**
 * P031 RejoinLab — T009: Web Worker 后台计算。
 *
 * 本模块是 Worker 线程的入口，同时导出可直接测试的 host 工厂：
 * - `buildWorkerResult(input)`：纯计算。调用 T005 的 evaluateFixture
 *   做双轨评估，再用 T005 导出的 expandChunks / resolveCheckpoint /
 *   buildResumeStream / applyInjections / foldTrack（与 evaluateFixture
 *   内部完全相同的调用）重建双轨事件流与逐步状态历史，组装成
 *   WorkerAnalysisResult。所有业务逻辑都在 T003–T005 的冻结代码里，
 *   这里只做调用与视图组装，不复制、不重实现 Reducer / 注入 / 比较。
 * - `createWorkerHost(postMessage)`：协议层。处理 ANALYZE / CANCEL，
 *   保证：同一时刻只有一个待处理任务（新 ANALYZE 取代旧任务，旧
 *   任务的迟到结果绝不发出）；CANCEL 在计算开始前可实际取消
 *   （ANALYZE 处理先让出一个宏任务，让随后到达的 CANCEL 先被处理）；
 *   计算中途或计算后到达的取消同样丢弃结果，只发 CANCELLED。
 *   客户端的取消还会在此同时 terminate 掉 Worker 线程（见
 *   src/worker/client.ts），那是真正停止一次已开始的同步计算的手段；
 *   本 host 的取消窗口覆盖“尚未开始计算”的情况，两者互补。
 *
 * 注意：evaluateFixture 内部的折叠是同步的，一次 ≤40 条事件的
 * 分析在毫秒级完成（S0 门槛 < 1 秒）。host 不把 fold 拆成多步，
 * 因为 T005 的 foldTrack 是整体调用、不可在不改核心代码的前提下
 * 拆分；取消语义由“计算前检查 + 计算后丢弃 + 客户端 terminate”
 * 三层共同保证，缺一不可，见 tests/worker/ 的实测。
 */

import { expandChunks } from "../parser/normalize.js";
import { initialState } from "../core/state.js";
import { stateHash } from "../core/canonical.js";
import {
  buildResumeStream,
  evaluateFixture,
  foldTrack,
  resolveCheckpoint,
  type DualTrackEvaluation,
  type ReplayFixture,
  type TrackFold,
} from "../replay/planner.js";
import { applyInjections } from "../replay/inject.js";
import type { AGUIEventType, NormalizedEvent } from "../protocol/types.js";
import {
  validateWorkerRequest,
  type TrackEventDiagnostic,
  type TrackEventView,
  type TrackStepState,
  type WorkerAnalysisResult,
  type WorkerRequest,
  type WorkerResponse,
} from "./protocol.js";

/** A-08：检查点段边界来源说明（时间线展示检查点时附注）。 */
export const CHECKPOINT_NOTE =
  "检查点位置来自断线前缀折叠（capturedState / foldPrefix 重建）；wire messagesSnapshot 不携带段边界，此处不展示来自 wire 快照的段边界。";

const SNAPSHOT_TYPES: readonly AGUIEventType[] = ["STATE_SNAPSHOT", "MESSAGES_SNAPSHOT"];

function diagnosticsByIndex(
  evaluation: DualTrackEvaluation,
): ReadonlyMap<number, readonly TrackEventDiagnostic[]> {
  const map = new Map<number, TrackEventDiagnostic[]>();
  for (const diagnostic of evaluation.diagnostics) {
    if (diagnostic.sourceIndex === undefined) continue;
    const entry: TrackEventDiagnostic = {
      code: diagnostic.code,
      severity: diagnostic.severity,
    };
    const list = map.get(diagnostic.sourceIndex);
    if (list === undefined) map.set(diagnostic.sourceIndex, [entry]);
    else list.push(entry);
  }
  return map;
}

interface ViewSeed {
  readonly wrapper: NormalizedEvent;
  readonly appliedPosition: number;
  readonly stepIndex: number | null;
  readonly isDropped: boolean;
}

function buildView(
  seed: ViewSeed,
  context: {
    readonly checkpointIndex: number;
    readonly divergenceIndex: number | null;
    readonly diagnostics: ReadonlyMap<number, readonly TrackEventDiagnostic[]>;
    readonly duplicateIndices: ReadonlySet<number>;
    readonly outOfOrderPositions: ReadonlySet<number>;
    readonly isResumeTrack: boolean;
  },
): TrackEventView {
  const { wrapper, appliedPosition, stepIndex, isDropped } = seed;
  const sourceIndex = wrapper.sourceIndex;
  const diagnostics = context.diagnostics.get(sourceIndex) ?? [];
  const isDuplicate =
    context.duplicateIndices.has(sourceIndex) ||
    diagnostics.some(
      (d) => d.code === "DUPLICATE_TOOL_CALL" || d.code === "SUSPECTED_DUPLICATE",
    );
  return {
    sourceIndex,
    appliedPosition,
    stepIndex,
    event: wrapper.event,
    eventType: wrapper.event.type,
    transportEventId: wrapper.transportEventId,
    sourceEventKey: wrapper.sourceEventKey,
    isSnapshot: (SNAPSHOT_TYPES as readonly string[]).includes(wrapper.event.type),
    isDisconnectPoint:
      !context.isResumeTrack &&
      context.checkpointIndex >= 0 &&
      sourceIndex === context.checkpointIndex,
    isResumePoint: context.isResumeTrack && appliedPosition === 0,
    isFirstDivergence:
      context.divergenceIndex !== null && sourceIndex === context.divergenceIndex,
    isDuplicate,
    isDropped,
    isOutOfOrder:
      context.isResumeTrack && context.outOfOrderPositions.has(appliedPosition),
    isReplayedPrefix:
      context.isResumeTrack &&
      context.checkpointIndex >= 0 &&
      sourceIndex <= context.checkpointIndex,
    diagnostics,
  };
}

function toStepStates(fold: TrackFold): readonly TrackStepState[] {
  return fold.history.map((entry) => ({
    sourceIndex: entry.sourceIndex,
    stateHash: stateHash(entry.state),
    state: entry.state,
  }));
}

/**
 * 对一次 ReplayFixture 做完整 Worker 计算：双轨评估 + 双轨时间线
 * 视图 + 逐步状态历史。纯函数；与 evaluateFixture 使用同一输入、
 * 同一冻结实现，因此裁决、诊断、首个分歧、终态哈希与主线程直接
 * 调用 evaluateFixture 的结果完全一致（见 tests/worker/parity）。
 *
 * 注意：evaluateFixture 内部已做过同样的折叠；这里为拿到逐步历史
 * 与恢复流而再次调用同一批导出函数（确定性实现，结果相同），
 * 而不是把 evaluateFixture 的内部中间量拆出来——后者需要改 T005
 * 核心代码，T009 禁止。
 */
export function buildWorkerResult(input: ReplayFixture): WorkerAnalysisResult {
  const startedAt = Date.now();
  const evaluation = evaluateFixture(input);
  const durationMs = Date.now() - startedAt;

  const recovery = input.recovery;
  const checkpointIndex = evaluation.checkpointIndex;
  const scenario = {
    strategy: recovery.strategy,
    ...(recovery.disconnectAfter !== undefined
      ? { disconnectAfter: recovery.disconnectAfter }
      : {}),
    ...(recovery.resumeAfterSourceIndex !== undefined
      ? { resumeAfterSourceIndex: recovery.resumeAfterSourceIndex }
      : {}),
    injections: recovery.injections ?? [],
  };
  const resumeAfterSourceIndex =
    recovery.strategy === "FULL_REPLAY_FROM_START"
      ? null
      : (recovery.resumeAfterSourceIndex ??
        recovery.disconnectAfter ??
        checkpointIndex);
  const checkpointOrigin =
    recovery.checkpoint !== null &&
    recovery.checkpoint !== undefined &&
    "capturedState" in recovery.checkpoint
      ? "explicitCheckpoint"
      : checkpointIndex >= 0
        ? "foldPrefix"
        : "none";
  const notes = checkpointIndex >= 0 ? [CHECKPOINT_NOTE] : [];

  const emptyResult: WorkerAnalysisResult = {
    evaluation,
    durationMs,
    scenario,
    importedEventCount: input.events.length,
    expandedEventCount: 0,
    fullTrack: [],
    resumeTrack: [],
    fullHistory: [],
    resumeHistory: [],
    fullBaseState: initialState(),
    resumeBaseState: initialState(),
    ...(recovery.disconnectAfter !== undefined
      ? { disconnectAfter: recovery.disconnectAfter }
      : {}),
    resumeAfterSourceIndex,
    checkpointIndex,
    checkpointOrigin,
    notes,
  };

  // 无双轨终态（INVALID_INPUT / INCONCLUSIVE_LIMIT / 恢复折叠失败）：
  // 没有可展示的轨道，只返回评估本身。
  if (evaluation.fullState === null || evaluation.resumeState === null) {
    return emptyResult;
  }

  const injections = recovery.injections ?? [];
  const expanded = expandChunks(input.events);
  const resolved = resolveCheckpoint(expanded, recovery.disconnectAfter, recovery.checkpoint);
  const stream = buildResumeStream(
    expanded,
    recovery.strategy,
    recovery.disconnectAfter,
    recovery.resumeAfterSourceIndex,
    resolved.checkpointIndex,
  );
  const injected = applyInjections(stream, resolved.baseState, {
    events: expanded,
    disconnectAfter: recovery.disconnectAfter,
  }, injections);
  const fullFold = foldTrack(expanded, initialState(), -1);
  const resumeFold = foldTrack(injected.stream, injected.baseState, resolved.checkpointIndex);

  const diagnostics = diagnosticsByIndex(evaluation);
  const divergenceIndex = evaluation.firstDivergence?.sourceIndex ?? null;

  // 恢复流中的重复 sourceIndex：第二次及之后出现的位置记为重复。
  const duplicateIndices = new Set<number>();
  {
    const seen = new Set<number>();
    for (const wrapper of injected.stream) {
      if (seen.has(wrapper.sourceIndex)) duplicateIndices.add(wrapper.sourceIndex);
      seen.add(wrapper.sourceIndex);
    }
  }
  // 乱序：应用位置与按 sourceIndex 稳定排序后的位置不同。
  const outOfOrderPositions = new Set<number>();
  {
    const ranked = injected.stream
      .map((wrapper, position) => ({ wrapper, position }))
      .sort((a, b) => a.wrapper.sourceIndex - b.wrapper.sourceIndex);
    ranked.forEach((entry, rank) => {
      if (entry.position !== rank) outOfOrderPositions.add(entry.position);
    });
  }

  const fullContext = {
    checkpointIndex,
    divergenceIndex,
    diagnostics,
    duplicateIndices: new Set<number>(),
    outOfOrderPositions: new Set<number>(),
    isResumeTrack: false,
  };
  const fullTrack = expanded.map((wrapper, position) =>
    buildView(
      { wrapper, appliedPosition: position, stepIndex: position, isDropped: false },
      fullContext,
    ),
  );

  const resumeContext = {
    checkpointIndex,
    divergenceIndex,
    diagnostics,
    duplicateIndices,
    outOfOrderPositions,
    isResumeTrack: true,
  };
  const resumeViews: TrackEventView[] = injected.stream.map((wrapper, position) =>
    buildView(
      { wrapper, appliedPosition: position, stepIndex: position, isDropped: false },
      resumeContext,
    ),
  );
  for (const wrapper of injected.dropped) {
    resumeViews.push(
      buildView(
        { wrapper, appliedPosition: -1, stepIndex: null, isDropped: true },
        resumeContext,
      ),
    );
  }
  // 展示顺序：sourceIndex 升序；同值保持应用流顺序（Array.sort 稳定）。
  // 绝不按应用位置重排——视觉布局不得改变事件的实际顺序。
  resumeViews.sort((a, b) => a.sourceIndex - b.sourceIndex);

  return {
    evaluation,
    durationMs,
    scenario,
    importedEventCount: input.events.length,
    expandedEventCount: expanded.length,
    fullTrack,
    resumeTrack: resumeViews,
    fullHistory: toStepStates(fullFold),
    resumeHistory: toStepStates(resumeFold),
    fullBaseState: initialState(),
    resumeBaseState: injected.baseState,
    ...(recovery.disconnectAfter !== undefined
      ? { disconnectAfter: recovery.disconnectAfter }
      : {}),
    resumeAfterSourceIndex,
    checkpointIndex,
    checkpointOrigin,
    notes,
  };
}

/** Worker host：协议层，可脱离真实 Worker 线程测试。 */
export interface WorkerHost {
  readonly handleMessage: (message: unknown) => void;
}

/**
 * 创建一个 Worker host。`postMessage` 是 host 向主线程发响应的
 * 唯一出口（真实 Worker 里即 self.postMessage）。
 *
 * 并发语义：
 * - 新 ANALYZE 立即取代待处理的旧任务（旧任务记为已取消，其后
 *   的延续只发 CANCELLED，绝不发 RESULT）。
 * - CANCEL 只对当前待处理任务生效；未知 / 已结算的 jobId 直接忽略。
 * - ANALYZE 处理先让出一个宏任务（setTimeout 0），让紧随其后
 *   的 CANCEL 有机会在计算开始前被处理；计算完成后再次检查取消
 *   标记，取消的任务只发 CANCELLED。
 */
export function createWorkerHost(
  postMessage: (response: WorkerResponse) => void,
): WorkerHost {
  const cancelled = new Set<string>();
  let pendingJobId: string | null = null;
  let generation = 0;

  const handleMessage = (message: unknown): void => {
    const problem = validateWorkerRequest(message);
    if (problem !== null) {
      const jobId = (message as { readonly jobId?: unknown } | null)?.jobId;
      if (typeof jobId === "string" && jobId !== "") {
        postMessage({
          type: "ERROR",
          jobId,
          error: { message: problem, code: "INVALID_WORKER_REQUEST" },
        });
      }
      return;
    }
    const request = message as WorkerRequest;
    if (request.type === "CANCEL") {
      if (pendingJobId === request.jobId) {
        cancelled.add(request.jobId);
        pendingJobId = null;
      }
      return;
    }

    // ANALYZE：取代任何待处理任务。
    if (pendingJobId !== null && pendingJobId !== request.jobId) {
      cancelled.add(pendingJobId);
    }
    const jobId = request.jobId;
    const input = request.input;
    pendingJobId = jobId;
    const myGeneration = ++generation;

    void (async () => {
      // 让出一个宏任务：紧随 ANALYZE 到达的 CANCEL 先被处理。
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (cancelled.has(jobId) || myGeneration !== generation) {
        cancelled.delete(jobId);
        postMessage({ type: "CANCELLED", jobId });
        return;
      }
      let result: WorkerAnalysisResult;
      try {
        result = buildWorkerResult(input);
      } catch (error) {
        if (pendingJobId === jobId) pendingJobId = null;
        if (cancelled.has(jobId) || myGeneration !== generation) {
          cancelled.delete(jobId);
          postMessage({ type: "CANCELLED", jobId });
          return;
        }
        postMessage({
          type: "ERROR",
          jobId,
          error: {
            message: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
      if (cancelled.has(jobId) || myGeneration !== generation) {
        if (pendingJobId === jobId) pendingJobId = null;
        cancelled.delete(jobId);
        postMessage({ type: "CANCELLED", jobId });
        return;
      }
      if (pendingJobId === jobId) pendingJobId = null;
      postMessage({ type: "RESULT", jobId, result });
    })();
  };

  return { handleMessage };
}

// 真实 Worker 线程入口。jsdom / Node 环境没有
// DedicatedWorkerGlobalScope，此分支不会执行，因此直接 import 本
// 模块做 in-process 测试时不会产生副作用。
const scope = globalThis as unknown as {
  readonly DedicatedWorkerGlobalScope?: new () => object;
};
if (
  typeof scope.DedicatedWorkerGlobalScope === "function" &&
  globalThis instanceof scope.DedicatedWorkerGlobalScope
) {
  const workerSelf = globalThis as unknown as {
    postMessage: (response: WorkerResponse) => void;
    onmessage: ((event: { readonly data: unknown }) => void) | null;
  };
  const host = createWorkerHost((response) => workerSelf.postMessage(response));
  workerSelf.onmessage = (event) => {
    host.handleMessage(event.data);
  };
}
