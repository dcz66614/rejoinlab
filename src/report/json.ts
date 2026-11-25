/**
 * P031 RejoinLab — T010: rejoinlab.report/v1 JSON 报告组装、哈希与下载。
 *
 * Frozen sources:
 * - PROJECT_BOOK.md v1.0.2 §13.2 (§13.3 样例仅作接口示意)、§5.2
 *   (canon 相等为一致性不变量)、§8.5 (最短注入序列)、§8.6 (首个
 *   分歧定位)。
 * - T007 A-02：报告哈希 = JCS canonicalHash 作用于报告对象，
 *   剔除 metrics.durationMs，保留 metrics.visitedStates。
 * - T007 A-07：组装层剥离 StateDiff 的 `kind` 与 FirstDivergence
 *   的 eventType / messageId / toolCallId / runId / note（见
 *   toFirstDivergence；不改 T004 生产代码）。
 *
 * 组装规则（逐值取自 T004 / T005 / T009 的计算结果，不重新计算）：
 * - verdict / diagnostics：原样取自 DualTrackEvaluation（诊断的
 *   code / severity / sourceIndex / relatedSourceIndices / message
 *   逐值复制；evidence 经 toJsonValue 清洗，只丢弃 undefined 键，
 *   不改写任何值）。
 * - fullPath / resumePath：finalStateHash 逐值取自 T005 的
 *   PathResult（即 T004 stateHash）；messages / toolCalls 为终态
 *   对象的深拷贝（经 toJsonValue 丢弃未设置的 undefined 可选字段）；
 *   sharedState 为 undefined（尚无基线）时按 §13.3 样例的 null
 *   编码记为 null。T005 PathResult 多出的 runStatus 不进入报告
 *   （§13.2 PathResult 无此字段；HTML 报告中另行展示）。
 * - firstDivergence：sourceIndex / fullStateHash / resumeStateHash
 *   逐值取自 T004；differences 只留 jsonPointer / expected /
 *   actual（剥离 kind），缺失值（added / removed）按 §13.3 样例
 *   记为 null；evaluation.firstDivergence 为 null 时字段省略。
 * - shortestInjectionSequence：取自 T005 analyzeFixture 的 BFS
 *   结果；null（未得出）透传为 null（FIX-R1 收尾；见 schema.ts
 *   模块头说明 2），不再折叠为 []。
 * - input.sourceSha256：对原始输入文本的 UTF-8 字节计算 SHA-256
 *   （TextEncoder 编码，与 node:crypto 对同一字节的摘要一致；
 *   不做换行归一化，不规范化文本）。eventCount 为导入事件条数
 *   （展开前，与 Worker 的 importedEventCount 一致）。
 * - metrics.durationMs：调用方传入的墙钟耗时，仅作展示，不进入
 *   报告哈希；metrics.visitedStates 逐值取自 T005。
 * - assumptions / limitations：一律使用 schema.ts 的冻结文本。
 *
 * 下载用 Blob + URL.createObjectURL，不写 localStorage /
 * IndexedDB / sessionStorage。文件名取 scenarioId 的安全化形式。
 */

import { canonicalHash, sha256Hex } from "../core/canonical.js";
import type { FirstDivergence } from "../core/diff.js";
import type {
  DualTrackEvaluation,
  PathResult as PlannerPathResult,
  ReplayDiagnostic,
} from "../replay/planner.js";
import { analyzeFixture, type ReplayAnalysis } from "../replay/search.js";
import type { NormalizedEvent } from "../protocol/types.js";
import type { WorkerAnalysisResult } from "../worker/protocol.js";
import {
  PROTOCOL_VERSION,
  REPORT_ASSUMPTIONS,
  REPORT_LIMITATIONS,
  REPORT_SCHEMA_ID,
  SPEC_VERSION,
  toJsonValue,
  type RejoinReport,
  type ReportDiagnostic,
  type ReportPathResult,
} from "./schema.js";

/** 报告输入的来源信息（原始输入文件）。 */
export interface ReportSourceInfo {
  readonly scenarioId: string;
  readonly sourceFormat: "JSONL" | "SSE";
  /**
   * 原始输入文件文本（FileReader 读到的原文）。SHA-256 对其
   * UTF-8 字节计算；调用方不得先做换行归一化或去空白。
   */
  readonly sourceText: string;
  /** 导入事件条数（展开前）。 */
  readonly eventCount: number;
}

export interface BuildReportInput {
  readonly evaluation: DualTrackEvaluation;
  /**
   * T005 BFS 最短注入序列；null 表示未得出（未运行 BFS、无序列
   * 可达、输入无效或超限），报告中记为 null。
   */
  readonly shortestInjectionSequence: string[] | null;
  /** 墙钟耗时（毫秒，仅作展示，不进入报告哈希）。 */
  readonly durationMs: number;
  readonly source: ReportSourceInfo;
  readonly recovery: {
    readonly strategy: string;
    readonly disconnectAfter?: number;
    readonly resumeAfterSourceIndex?: number;
  };
}

function toReportPath(path: PlannerPathResult | null): ReportPathResult | null {
  if (path === null) return null;
  return {
    finalStateHash: path.finalStateHash,
    messages: toJsonValue(path.messages) as unknown[],
    toolCalls: toJsonValue(path.toolCalls) as unknown[],
    sharedState:
      path.sharedState === undefined
        ? null
        : toJsonValue(path.sharedState),
    pendingToolCallIds: [...path.pendingToolCallIds],
  };
}

function toReportDiagnostic(diagnostic: ReplayDiagnostic): ReportDiagnostic {
  return {
    code: diagnostic.code,
    severity: diagnostic.severity,
    ...(diagnostic.sourceIndex !== undefined
      ? { sourceIndex: diagnostic.sourceIndex }
      : {}),
    ...(diagnostic.relatedSourceIndices !== undefined
      ? { relatedSourceIndices: [...diagnostic.relatedSourceIndices] }
      : {}),
    message: diagnostic.message,
    evidence: toJsonValue(diagnostic.evidence) as Record<string, unknown>,
  };
}

/**
 * T004 FirstDivergence → §13.2 firstDivergence。
 * 剥离（A-07）：StateDiff 的 kind；FirstDivergence 的 eventType /
 * messageId / toolCallId / runId / note。缺失的 expected / actual
 *（added / removed）按 §13.3 样例记为 null。
 */
export function toReportFirstDivergence(
  firstDivergence: FirstDivergence | null,
): RejoinReport["firstDivergence"] {
  if (firstDivergence === null) return undefined;
  return {
    ...(firstDivergence.sourceIndex !== undefined
      ? { sourceIndex: firstDivergence.sourceIndex }
      : {}),
    fullStateHash: firstDivergence.fullStateHash,
    resumeStateHash: firstDivergence.resumeStateHash,
    differences: firstDivergence.differences.map((difference) => ({
      jsonPointer: difference.jsonPointer,
      expected:
        difference.expected === undefined
          ? null
          : toJsonValue(difference.expected),
      actual:
        difference.actual === undefined
          ? null
          : toJsonValue(difference.actual),
    })),
  };
}

/**
 * 组装一份 rejoinlab.report/v1 报告。纯函数：不读时间、不读随机数、
 * 不做 I/O；相同输入得到相同报告（除 durationMs 外）。
 */
export function buildReport(input: BuildReportInput): RejoinReport {
  const { evaluation } = input;
  const report: RejoinReport = {
    schema: REPORT_SCHEMA_ID,
    specVersion: SPEC_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    scenarioId: input.source.scenarioId,
    verdict: evaluation.verdict,
    input: {
      sourceFormat: input.source.sourceFormat,
      eventCount: input.source.eventCount,
      sourceSha256: sha256Hex(input.source.sourceText),
    },
    recovery: {
      strategy: input.recovery.strategy,
      ...(input.recovery.disconnectAfter !== undefined
        ? { disconnectAfter: input.recovery.disconnectAfter }
        : {}),
      ...(input.recovery.resumeAfterSourceIndex !== undefined
        ? { resumeAfterSourceIndex: input.recovery.resumeAfterSourceIndex }
        : {}),
    },
    fullPath: toReportPath(evaluation.fullPath),
    resumePath: toReportPath(evaluation.resumePath),
    ...(toReportFirstDivergence(evaluation.firstDivergence) !== undefined
      ? {
          firstDivergence: toReportFirstDivergence(
            evaluation.firstDivergence,
          ) as NonNullable<RejoinReport["firstDivergence"]>,
        }
      : {}),
    diagnostics: evaluation.diagnostics.map(toReportDiagnostic),
    shortestInjectionSequence:
      input.shortestInjectionSequence === null
        ? null
        : [...input.shortestInjectionSequence],
    metrics: {
      durationMs: input.durationMs,
      visitedStates: evaluation.metrics.visitedStates,
    },
    assumptions: [...REPORT_ASSUMPTIONS],
    limitations: [...REPORT_LIMITATIONS],
  };
  return report;
}

/**
 * T007 A-02 冻结的报告哈希输入：报告对象剔除 metrics.durationMs。
 * 保留 metrics.visitedStates（确定性计数）。
 */
export function reportHashInput(report: RejoinReport): Record<string, unknown> {
  const { durationMs: _dropped, ...metricsKept } = report.metrics;
  void _dropped;
  return { ...report, metrics: metricsKept };
}

/**
 * 报告哈希（A-02）：JCS canonicalHash 作用于剔除 durationMs 后的
 * 报告对象。同一分析重复运行（durationMs 不同）得到同一哈希。
 */
export function reportHash(report: RejoinReport): string {
  return canonicalHash(reportHashInput(report));
}

/** 报告的确定性 JSON 文本（2 空格缩进 + 末尾换行）。 */
export function serializeReport(report: RejoinReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

/**
 * 从一次完整分析（T005 analyzeFixture 的结果）组装报告。
 * evaluation / durationMs 由调用方传入；shortestInjectionSequence
 * 与 bfsVisited 取自 analysis。
 */
export function buildReportFromAnalysis(
  analysis: ReplayAnalysis,
  durationMs: number,
  source: ReportSourceInfo,
  recovery: BuildReportInput["recovery"],
): RejoinReport {
  return buildReport({
    evaluation: analysis.evaluation,
    shortestInjectionSequence: analysis.shortestInjectionSequence,
    durationMs,
    source,
    recovery,
  });
}

export interface WorkerReportBuild {
  readonly report: RejoinReport;
  /** 本次导出运行 BFS 访问的节点数（仅 HTML 展示用，不进 JSON）。 */
  readonly bfsVisited: number;
}

/**
 * 从 T009 Worker 结果组装报告（App 导出路径）。
 *
 * - 报告的 verdict / 诊断 / 双轨终态 / 首个分歧取自 Worker 返回的
 *   evaluation 本身（即界面上展示的那一份，保证导出与所见一致）；
 * - 最短注入序列取自同一夹具的 analyzeFixture（T005 BFS），目标
 *   码为 evaluation 首条诊断的 code（故障夹具的主诊断码；正常
 *   夹具无诊断时目标为 null，即“任意分歧”——与 search.ts 的
 *   目标语义一致；24 条 Golden 实测此规则复现手工预期 24/24）。
 * - BFS 在用户点击导出时才运行，不在分析完成时预跑。
 */
export function buildReportFromWorkerResult(
  result: WorkerAnalysisResult,
  events: readonly NormalizedEvent[],
  source: Omit<ReportSourceInfo, "eventCount">,
): WorkerReportBuild {
  const targetCode = result.evaluation.diagnostics[0]?.code ?? null;
  const analysis = analyzeFixture(
    {
      scenarioId: source.scenarioId,
      events,
      recovery: {
        strategy: result.scenario.strategy,
        ...(result.scenario.disconnectAfter !== undefined
          ? { disconnectAfter: result.scenario.disconnectAfter }
          : {}),
        ...(result.scenario.resumeAfterSourceIndex !== undefined
          ? { resumeAfterSourceIndex: result.scenario.resumeAfterSourceIndex }
          : {}),
        injections: result.scenario.injections,
      },
    },
    targetCode,
  );
  return {
    report: buildReport({
      evaluation: result.evaluation,
      shortestInjectionSequence: analysis.shortestInjectionSequence,
      durationMs: result.durationMs,
      // 导入事件条数取自 Worker 的 importedEventCount（展开前）。
      source: { ...source, eventCount: result.importedEventCount },
      recovery: result.scenario,
    }),
    bfsVisited: analysis.bfsVisited,
  };
}

/** 报告下载文件名：scenarioId 安全化后嵌入固定模板。 */
export function reportFileName(
  report: RejoinReport,
  extension: "json" | "html",
): string {
  const safe =
    report.scenarioId
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "report";
  return `rejoinlab-${safe}.report.${extension}`;
}

/**
 * 浏览器下载一个文本文件（Blob + URL.createObjectURL + <a download>）。
 * 不写任何持久化存储；调用方只在用户点击导出时调用。
 */
export function downloadTextFile(
  fileName: string,
  text: string,
  mimeType: string,
): void {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

/** 下载 JSON 报告。 */
export function downloadReportJson(report: RejoinReport): void {
  downloadTextFile(
    reportFileName(report, "json"),
    serializeReport(report),
    "application/json",
  );
}
