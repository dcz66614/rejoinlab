/**
 * P031 RejoinLab — T009: Web Worker 请求 / 响应协议。
 *
 * Frozen sources:
 * - PROJECT_BOOK.md v1.0.0 §14.4（Worker 契约：请求 { jobId, type:
 *   "ANALYZE", input: AnalyzeInput }；响应 { jobId, type: "RESULT",
 *   report }；取消 { jobId, type: "CANCEL" }；旧 job 的结果不得覆盖
 *   新输入对应的分析结果）。
 * - IMPLEMENTATION_PLAN.md v1.0.0 §5.2（AnalyzeInput）、§6 T009。
 *
 * 本模块只定义协议形状与 jobId 生成，不做任何计算。计算在
 * src/worker/rejoin.worker.ts，复用 T005 的 evaluateFixture 与
 * T004 的 diff 接口（import 生产代码，不复制逻辑）。
 *
 * 与 §14.4 的一点展开：§14.4 的响应只写了 RESULT；本协议增加
 * ERROR（Worker 内计算抛错，如未知注入算子）与 CANCELLED（任务
 * 在计算前或计算后被取消），因为 T009 验收要求“错误结果传递正确”
 * 与“任务取消可实际取消”，两者都需要明确的响应类型。jobId 语义
 * 不变：客户端只接受与当前 jobId 一致的响应。
 */

import type { Injection } from "../replay/inject.js";
import type {
  DualTrackEvaluation,
  RecoveryStrategy,
  ReplayFixture,
} from "../replay/planner.js";
import type { AGUIEvent, AGUIEventType } from "../protocol/types.js";
import type { RejoinState } from "../core/state.js";

/** Worker 请求：一次分析，或取消一个已提交的任务。 */
export type WorkerRequest =
  | {
      readonly type: "ANALYZE";
      /** 客户端生成的唯一任务标识；响应原样回显。 */
      readonly jobId: string;
      /** 与 T005 evaluateFixture 相同的输入。 */
      readonly input: ReplayFixture;
    }
  | { readonly type: "CANCEL"; readonly jobId: string };

/** Worker 响应：分析结果、计算错误、或任务已取消。 */
export type WorkerResponse =
  | { readonly type: "RESULT"; readonly jobId: string; readonly result: WorkerAnalysisResult }
  | {
      readonly type: "ERROR";
      readonly jobId: string;
      readonly error: { readonly message: string; readonly code?: string };
    }
  | { readonly type: "CANCELLED"; readonly jobId: string };

/** 一条诊断在时间线事件上的投影（代码 + 严重级别）。 */
export interface TrackEventDiagnostic {
  readonly code: string;
  readonly severity: "CRITICAL" | "WARNING";
}

/**
 * 时间线上一条事件的展示视图。
 *
 * 展示顺序即数组顺序：Worker 返回的轨道数组已按 sourceIndex 升序
 * 排列（sourceIndex 相同时保持应用流顺序），UI 必须原样渲染，
 * 不得为了视觉布局重排。sourceIndex 是展开后事件的编号（T005
 * expandChunks 对全部事件重编号），与 T005 诊断、首个分歧、
 * StateDiff 使用的是同一编号；含 chunk 事件的轨迹中，它与导入
 * 列表的原始编号可能不同，Timeline 会在该情况下注明。
 */
export interface TrackEventView {
  /** 展开后事件编号（与诊断 / 首个分歧同一编号体系）。 */
  readonly sourceIndex: number;
  /**
   * 在本轨道应用流中的位置（0-based）。-1 表示从未应用：仅用于
   * 恢复轨道上被注入丢弃的事件占位。
   */
  readonly appliedPosition: number;
  /**
   * 在本轨道逐步状态历史中的下标；丢弃占位为 null（无状态变化，
   * 回放时沿用前一状态）。
   */
  readonly stepIndex: number | null;
  /** 原始 AG-UI 事件对象（点击查看原始 JSON 即展示此对象）。 */
  readonly event: AGUIEvent;
  readonly eventType: AGUIEventType;
  readonly transportEventId: string | null;
  readonly sourceEventKey: string | null;
  /** STATE_SNAPSHOT 或 MESSAGES_SNAPSHOT。 */
  readonly isSnapshot: boolean;
  /** 完整轨道上 sourceIndex === checkpointIndex 的事件（断线点）。 */
  readonly isDisconnectPoint: boolean;
  /** 恢复轨道应用流的第一条事件（恢复点）。 */
  readonly isResumePoint: boolean;
  /** sourceIndex === evaluation.firstDivergence.sourceIndex。 */
  readonly isFirstDivergence: boolean;
  /**
   * 重复事件：同一 sourceIndex 在恢复流中出现两次及以上（后一次），
   * 或该 sourceIndex 带有 DUPLICATE_TOOL_CALL /
   * SUSPECTED_DUPLICATE 诊断（重放前缀导致的重复应用）。
   */
  readonly isDuplicate: boolean;
  /** 恢复轨道上被注入丢弃的事件占位（未进入恢复流）。 */
  readonly isDropped: boolean;
  /**
   * 乱序事件：恢复流中的应用位置与按 sourceIndex 排序后的位置
   * 不同（SWAP_ADJACENT 等注入导致）。
   */
  readonly isOutOfOrder: boolean;
  /** sourceIndex 已在检查点覆盖范围内、又在恢复流中重放的事件。 */
  readonly isReplayedPrefix: boolean;
  /** 引用本 sourceIndex 的报告层诊断。 */
  readonly diagnostics: readonly TrackEventDiagnostic[];
}

/** 逐步回放的一步：某事件应用后的规范化状态。 */
export interface TrackStepState {
  readonly sourceIndex: number;
  readonly stateHash: string;
  readonly state: RejoinState;
}

/** 实际生效的实验配置（Worker 输入的回显，供 App 做 F3 快照）。 */
export interface WorkerScenario {
  readonly strategy: RecoveryStrategy;
  readonly disconnectAfter?: number;
  readonly resumeAfterSourceIndex?: number;
  readonly injections: readonly Injection[];
}

/**
 * Worker 一次分析的完整结果：T005 双轨评估 + 双轨时间线视图 +
 * 逐步回放所需的状态历史。
 *
 * 当评估因输入无效 / 超限而没有双轨终态时（evaluation.fullState
 * 或 resumeState 为 null），轨道与历史为空数组，Timeline 只展示
 * 评估本身（裁决与诊断）。
 */
export interface WorkerAnalysisResult {
  readonly evaluation: DualTrackEvaluation;
  /** Worker 内计算的墙钟耗时（毫秒，仅作展示，不进入报告哈希）。 */
  readonly durationMs: number;
  readonly scenario: WorkerScenario;
  /** 导入的原始事件条数（展开前）。 */
  readonly importedEventCount: number;
  /** 展开后事件条数（chunk 展开后；时间线按此编号）。 */
  readonly expandedEventCount: number;
  /** 完整路径轨道：展开后事件，按 sourceIndex 升序。 */
  readonly fullTrack: readonly TrackEventView[];
  /** 恢复路径轨道：应用流事件 + 丢弃占位，按 sourceIndex 升序。 */
  readonly resumeTrack: readonly TrackEventView[];
  /** 完整路径逐步状态：与 fullTrack 一一对齐（下标即 stepIndex）。 */
  readonly fullHistory: readonly TrackStepState[];
  /**
   * 恢复路径逐步状态：与恢复应用流一一对齐（下标即 stepIndex）；
   * 丢弃占位没有对应条目。
   */
  readonly resumeHistory: readonly TrackStepState[];
  /** 完整路径折叠起点（空初始状态）。 */
  readonly fullBaseState: RejoinState;
  /** 恢复路径折叠起点（检查点基线状态）。 */
  readonly resumeBaseState: RejoinState;
  /** 断线位置（原始配置值，未设置即 undefined）。 */
  readonly disconnectAfter?: number;
  /**
   * 生效的恢复游标：恢复流从此 sourceIndex 之后开始；
   * FULL_REPLAY_FROM_START 时为 null（从头开始）。
   */
  readonly resumeAfterSourceIndex: number | null;
  /** 检查点 sourceIndex（evaluation.checkpointIndex 的回显）。 */
  readonly checkpointIndex: number;
  /**
   * 检查点来源：foldPrefix（断线前缀折叠重建）、explicitCheckpoint
   * （显式 RecoveryCheckpoint）、none（无检查点 / 空基线）。
   * A-08：wire messagesSnapshot 不携带段边界，时间线展示的检查
   * 点一律来自 capturedState / foldPrefix 重建，不假装来自 wire。
   */
  readonly checkpointOrigin: "foldPrefix" | "explicitCheckpoint" | "none";
  /** 展示用说明（如 A-08 的段边界来源说明）。 */
  readonly notes: readonly string[];
}

let fallbackCounter = 0;

/**
 * 生成唯一 jobId。优先 crypto.randomUUID；无 crypto 时用计数器 +
 * 时间 + 随机数组合（仅作任务标识，不参与任何报告哈希）。
 */
export function createJobId(): string {
  const cryptoObject = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObject?.randomUUID !== undefined) {
    return `job-${cryptoObject.randomUUID()}`;
  }
  fallbackCounter += 1;
  return `job-${Date.now().toString(36)}-${fallbackCounter}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/**
 * 校验一条 Worker 请求消息。返回 null 表示合法，否则返回错误原因。
 * 非法消息绝不触发计算；调用方按 jobId 可恢复时回 ERROR。
 */
export function validateWorkerRequest(message: unknown): string | null {
  if (typeof message !== "object" || message === null) {
    return "worker request must be an object";
  }
  const request = message as Record<string, unknown>;
  if (request["type"] !== "ANALYZE" && request["type"] !== "CANCEL") {
    return `unknown worker request type ${JSON.stringify(request["type"])}`;
  }
  if (typeof request["jobId"] !== "string" || request["jobId"] === "") {
    return "worker request jobId must be a non-empty string";
  }
  if (request["type"] === "ANALYZE") {
    const input = request["input"] as Record<string, unknown> | null;
    if (typeof input !== "object" || input === null) {
      return "ANALYZE request input must be an object";
    }
    if (typeof input["scenarioId"] !== "string") {
      return "ANALYZE request input.scenarioId must be a string";
    }
    if (!Array.isArray(input["events"])) {
      return "ANALYZE request input.events must be an array";
    }
    if (typeof input["recovery"] !== "object" || input["recovery"] === null) {
      return "ANALYZE request input.recovery must be an object";
    }
  }
  return null;
}
