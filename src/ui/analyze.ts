/**
 * P031 RejoinLab — T008: UI 适配层（不含任何业务算法）。
 *
 * 本模块只做三件事，全部委托给 T002–T005 已冻结的接口：
 * 1. 按文件名 / 内容嗅探导入格式，调用 T002 的 parseInput 解析；
 * 2. 把界面上的实验配置组装成 AnalyzeInput，调用 T005 的
 *    evaluateFixture 做双轨分析；
 * 3. 提供裁决 / 策略 / 注入算子的中文展示文案。
 *
 * 不重新实现 Reducer、不修改协议契约、不使用 messagesSnapshot 恢复
 * （因此不触及 A-08 的 segments 往返遗留：检查点一律由 planner 按
 * disconnectAfter 做前缀折叠，UI 从不提供显式 RecoveryCheckpoint）。
 * 不写入 localStorage / IndexedDB；导入文本只保留在当前内存中。
 */

import { parseInput, ParseError, type ParseDiagnostic } from "../parser/index.js";
import type { NormalizedEvent } from "../protocol/types.js";
import {
  evaluateFixture,
  type DualTrackEvaluation,
  type RecoveryStrategy,
  type Verdict,
} from "../replay/planner.js";
import { OPERATOR_ORDER, type Injection, type InjectionOperator } from "../replay/inject.js";

export type { DualTrackEvaluation, RecoveryStrategy, Verdict, Injection, InjectionOperator };
export { OPERATOR_ORDER };

export type SourceFormat = "jsonl" | "sse";

/** PROJECT_BOOK §13.2: 报告接口的协议版本。 */
export const PROTOCOL_VERSION = "1.0";
/** PROJECT_BOOK v1.0.2。 */
export const SPEC_VERSION = "1.0.2";

/** 五种裁决的中文说明（PROJECT_BOOK §7）。 */
export const VERDICT_LABELS: Record<Verdict, string> = {
  CONSISTENT: "一致",
  INCONSISTENT: "不一致",
  INCONCLUSIVE_LIMIT: "超出计算边界",
  INVALID_INPUT: "输入无效",
  INCOMPLETE_TRACE: "轨迹不完整",
};

export const VERDICT_DESCRIPTIONS: Record<Verdict, string> = {
  CONSISTENT: "双轨规范化状态相等，无 CRITICAL 诊断。",
  INCONSISTENT: "双轨状态不同，或出现可证实的关键故障。",
  INCONCLUSIVE_LIMIT: "超出计算边界（事件数、搜索节点或时间限制），无法得出一致性结论。",
  INVALID_INPUT: "输入无效：格式错误、必需字段缺失或无法解析的协议事件。",
  INCOMPLETE_TRACE: "轨迹不完整：缺少必要终止信息或无法确认恢复完整性。",
};

/** 三种恢复策略的中文说明（PROJECT_BOOK §8.3）。 */
export const STRATEGY_LABELS: Record<RecoveryStrategy, string> = {
  FULL_REPLAY_FROM_START: "从头完整重放",
  RESUME_FROM_CHECKPOINT: "从检查点恢复",
  REPLAY_AFTER_SOURCE_CURSOR: "按 sourceIndex 游标续接",
};

export const STRATEGY_DESCRIPTIONS: Record<RecoveryStrategy, string> = {
  FULL_REPLAY_FROM_START: "从原始轨迹开头重新发送全部历史事件，检查已有状态是否能安全接受历史重放。",
  RESUME_FROM_CHECKPOINT: "从断线点检查点恢复消息和共享状态，然后应用其后的事件。",
  REPLAY_AFTER_SOURCE_CURSOR: "使用 RejoinLab 本地 sourceIndex 游标确定下一条待应用事件（非 AG-UI 官方恢复机制）。",
};

/** 8 种故障注入算子的中文说明（PROJECT_BOOK §8.4，顺序为 §8.5 固定字典序）。 */
export const INJECTION_LABELS: Record<InjectionOperator, string> = {
  CURSOR_SKIP: "游标跳过",
  DROP_EVENT: "丢失事件",
  DUPLICATE_EVENT: "重复事件",
  MESSAGE_ID_REMAP: "消息 ID 重映射",
  REPLAY_PREFIX: "重放已处理前缀",
  STALE_SNAPSHOT: "陈旧快照",
  SWAP_ADJACENT: "交换相邻事件",
  TRUNCATE_STREAM: "截断流",
};

export const INJECTION_DESCRIPTIONS: Record<InjectionOperator, string> = {
  CURSOR_SKIP: "恢复时跳过指定 sourceIndex 范围内的事件。",
  DROP_EVENT: "删除指定位置的一个事件。",
  DUPLICATE_EVENT: "在指定位置重复一个事件。",
  MESSAGE_ID_REMAP: "在消息快照中改变指定消息 ID（消息移至末尾，模拟 AG-UI #3119）。",
  REPLAY_PREFIX: "在恢复流前重放断线前已处理过的事件前缀。",
  STALE_SNAPSHOT: "使用较早的 STATE_SNAPSHOT 作为恢复基线。",
  SWAP_ADJACENT: "交换指定位置与下一位置的两个事件。",
  TRUNCATE_STREAM: "在指定位置截断流（其后的事件都不进入恢复路径）。",
};

/**
 * 按文件名后缀嗅探格式；无后缀时按内容嗅探：行首出现 `data:` /
 * `id:` / `event:` / `:` 的 SSE 帧结构即判为 SSE，否则为 JSONL。
 * JSONL 行首必为 `{`，不可能与 SSE 帧行首冲突。
 */
export function detectFormat(fileName: string, text: string): SourceFormat {
  if (/\.sse$/i.test(fileName)) return "sse";
  if (/\.jsonl$/i.test(fileName)) return "jsonl";
  for (const line of text.split(/\r\n|\r|\n/)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    if (/^(data|id|event|retry):/.test(trimmed) || trimmed.startsWith(":")) {
      return "sse";
    }
    return "jsonl";
  }
  return "jsonl";
}

export type ImportResult =
  | { readonly ok: true; readonly events: readonly NormalizedEvent[]; readonly format: SourceFormat }
  | { readonly ok: false; readonly format: SourceFormat; readonly diagnostics: readonly ParseDiagnostic[] };

/**
 * 导入文本 → T002 解析。失败时返回结构化诊断（含 sourceIndex /
 * line），不返回部分事件序列，不抛错到调用方。
 */
export function importEvents(text: string, format: SourceFormat): ImportResult {
  try {
    const events = parseInput(text, format);
    return { ok: true, events, format };
  } catch (error) {
    if (error instanceof ParseError) {
      return { ok: false, format, diagnostics: error.diagnostics };
    }
    throw error;
  }
}

/** 界面上的实验配置（AnalyzeInput 的 recovery 部分）。 */
export interface ScenarioConfig {
  readonly strategy: RecoveryStrategy;
  /** 未设置 = 不断线（恢复流覆盖全部事件）。 */
  readonly disconnectAfter?: number;
  /** 未设置 = 跟随断线位置。仅对后两种策略有意义。 */
  readonly resumeAfterSourceIndex?: number;
  readonly injections: readonly Injection[];
}

export const DEFAULT_SCENARIO: ScenarioConfig = {
  strategy: "RESUME_FROM_CHECKPOINT",
  injections: [],
};

/** 各注入算子的默认参数（界面勾选时填入）。 */
export function defaultInjection(op: InjectionOperator): Injection {
  switch (op) {
    case "DROP_EVENT":
    case "DUPLICATE_EVENT":
    case "SWAP_ADJACENT":
    case "TRUNCATE_STREAM":
      return { op, sourceIndex: 0 };
    case "CURSOR_SKIP":
      return { op, from: 0, to: 0 };
    case "MESSAGE_ID_REMAP":
      return { op, messageId: "", newMessageId: "" };
    case "REPLAY_PREFIX":
    case "STALE_SNAPSHOT":
      return { op };
  }
}

/** 注入算子是否需要目标 sourceIndex 参数。 */
export function injectionNeedsSourceIndex(op: InjectionOperator): boolean {
  return (
    op === "DROP_EVENT" ||
    op === "DUPLICATE_EVENT" ||
    op === "SWAP_ADJACENT" ||
    op === "TRUNCATE_STREAM"
  );
}

export interface AnalysisResult {
  readonly evaluation: DualTrackEvaluation;
  /** 本次双轨分析的墙钟耗时（毫秒，仅作展示，不进入任何报告哈希）。 */
  readonly durationMs: number;
  /**
   * 运行时刻实际生效的实验配置快照（F3）：结果区回显只读此快照，
   * 运行后改动面板配置不会改写已出结果的回显文字。
   * 快照取归一化后的生效配置（见 normalizeInjection），即真正
   * 交给 evaluateFixture 的那一份。
   */
  readonly scenario: ScenarioConfig;
}

/**
 * 把界面文本框的“留空”语义翻译成 T005 能理解的缺省（F1）。
 *
 * 只在 runAnalysis 交给 evaluateFixture 之前、唯一一处做归一化，
 * 理由：defaultInjection / updateInjection 都可能产出 ""——
 * defaultInjection 本来就用 "" 表示留空，而文本框在用户清空内容时
 * 也会写回 ""；只在其中一处归一化拦不住另一条路。runAnalysis 是
 * 所有注入通往 T005 的唯一汇合点，在此归一化可覆盖全部调用方。
 *
 * T005 的 MESSAGE_ID_REMAP 用 `??` 取缺省，只对 undefined/null
 * 生效："" 会原样当作旧 ID / 新 ID，oldId === newId === "" 时
 * 直接返回 changed: false，注入静默不生效，与界面“留空 = 首条
 * assistant 消息 / 加 -remapped 后缀”的承诺相反。故 "" → undefined。
 * 其余算子无字符串缺省字段，不受影响。
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

/**
 * 运行一次双轨分析：直接调用 T005 的 evaluateFixture。
 * scenarioId 取导入文件名（去后缀），便于在结果中追溯输入来源。
 */
export function runAnalysis(
  events: readonly NormalizedEvent[],
  scenario: ScenarioConfig,
  scenarioId: string,
): AnalysisResult {
  const start = Date.now();
  const effectiveScenario: ScenarioConfig = {
    ...scenario,
    injections: scenario.injections.map(normalizeInjection),
  };
  const evaluation = evaluateFixture({
    scenarioId,
    events,
    recovery: {
      strategy: effectiveScenario.strategy,
      ...(effectiveScenario.disconnectAfter !== undefined
        ? { disconnectAfter: effectiveScenario.disconnectAfter }
        : {}),
      ...(effectiveScenario.resumeAfterSourceIndex !== undefined
        ? { resumeAfterSourceIndex: effectiveScenario.resumeAfterSourceIndex }
        : {}),
      injections: effectiveScenario.injections,
    },
  });
  return { evaluation, durationMs: Date.now() - start, scenario: effectiveScenario };
}

/** 注入配置的一行中文描述（用于结果区回显）。 */
export function describeInjection(injection: Injection): string {
  const label = INJECTION_LABELS[injection.op];
  switch (injection.op) {
    case "DROP_EVENT":
    case "DUPLICATE_EVENT":
    case "SWAP_ADJACENT":
    case "TRUNCATE_STREAM":
      return `${label}（sourceIndex ${injection.sourceIndex ?? 0}）`;
    case "CURSOR_SKIP":
      return `${label}（sourceIndex ${injection.from ?? 0}–${injection.to ?? 0}）`;
    case "MESSAGE_ID_REMAP": {
      const from = injection.messageId === "" || injection.messageId === undefined ? "（默认首条 assistant 消息）" : injection.messageId;
      const to = injection.newMessageId === "" || injection.newMessageId === undefined ? "（默认加 -remapped 后缀）" : injection.newMessageId;
      return `${label}（${from} → ${to}）`;
    }
    case "REPLAY_PREFIX":
    case "STALE_SNAPSHOT":
      return label;
  }
}
