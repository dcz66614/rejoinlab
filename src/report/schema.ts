/**
 * P031 RejoinLab — T010: rejoinlab.report/v1 JSON 报告的冻结类型、
 * JSON Schema 与校验器。
 *
 * Frozen sources:
 * - PROJECT_BOOK.md v1.0.2 §13.2 (RejoinReport 数据结构 — 本文件
 *   的类型与 JSON Schema 逐字段对照 §13.2，不得增删字段；§13.3
 *   样例输出为接口示意，不是实际运行结果）。
 * - PROJECT_BOOK.md v1.0.2 §6 (诊断代码与严重级别)、§7 (五种裁决)、
 *   §8.4–§8.5 (8 种注入算子与固定字典序)、§18 (诚实边界：能力
 *   边界与假设说明的文本来源）。
 * - 终审 R1 FIX-R1（v1.0.1 修订）：P1-R1-03 / ADR-001（§13.2 路径
 *   nullable）；P2-R1-08（shortestInjectionSequence 的 [] 与 null
 *   语义）；P2-R1-01 / ADR-002（§8.5 BFS 目标语义澄清）。
 * - T007 A-02 (artifacts/reports/S0_REPORT.md §2)：报告哈希 = JCS
 *   canonicalHash 作用于报告对象，剔除 metrics.durationMs，保留
 *   metrics.visitedStates。哈希函数本身在 src/report/json.ts。
 * - T007 A-07 (同上)：T004 的 StateDiff 多余 `kind` 字段、
 *   FirstDivergence 多余字段 (eventType / messageId / toolCallId /
 *   runId / note) 在输出 rejoinlab.report/v1 时剥离 — 剥离发生在
 *   src/report/json.ts 的组装层，不改 T004 生产代码。本文件
 *   的类型与校验器只接受 §13.2 的字段集，上述多余字段一律
 *   判为非法（additionalProperties: false 的等价检查）。
 *
 * 与 §13.2 文本的三处显式说明（均不是放宽，而是不让规格沉默处
 * 变成捏造数据的借口）：
 * 1. fullPath / resumePath：§13.2（v1.0.1，ADR-001）写为
 *    PathResult | null；null 表示“无终态”，绝不伪造一条空路径
 *    （空路径会带一个与任何计算结果都不符的 finalStateHash）。
 *    null 按路径独立取舍：事件数超限 / 未知事件 / 完整折叠失败时
 *    两路径为 null；恢复折叠失败时仅 resumePath 为 null
 *    （planner.ts:1188 / 1214 / 1244 / 1278）；BFS 节点超限的
 *    INCONCLUSIVE_LIMIT 仍带已算出的双轨终态，路径照常为对象。
 *    JSON Schema 接受 PathResult 或 null；消费者不得把 null 误读
 *    为 CONSISTENT 的证据。
 * 2. shortestInjectionSequence：§13.2（v1.0.1）写为
 *    string[] | null。[] 表示 BFS 已证实目标在无注入时已达成
 *    （如 G08）；null 表示未计算（INVALID_INPUT /
 *    INCONCLUSIVE_LIMIT / BFS 未运行 / 界内无序列可达）。JSON
 *    Schema 与校验器接受 null（见下方 shortestInjectionSequence
 *    的 anyOf）。已落地（FIX-R1 收尾同步改动）：TS 类型
 *    RejoinReport.shortestInjectionSequence 已放宽为
 *    string[] | null，src/report/json.ts 的 buildReport 透传
 *    null（不再折叠为 []），src/report/html.ts 已补 null 分支
 *    （null 时渲染“未计算”）；null 已真正进入 JSON 报告。
 *    任何收到 null 的报告消费者不得把它当作 []。
 * 3. metrics：§13.2 只有 durationMs 与 visitedStates。T005 的 BFS
 *    访问节点数 (bfsVisited) 没有对应的 §13.2 字段，故不进入
 *    JSON 报告，只在 HTML 报告中展示（见 src/report/html.ts）。
 *    同样，终态 runStatus 在 §13.2 PathResult 中没有字段，也只
 *    在 HTML 中展示；finalStateHash 本身仍逐值取自 T005 的计算。
 *
 * 依赖：本模块不依赖 Node API，可在浏览器 Web Worker 中使用。
 * 校验器为手写实现（项目无 ajv 等 JSON Schema 依赖），其检查
 * 规则与下方 REJOIN_REPORT_JSON_SCHEMA 的约束一一对应。
 */

import type { JsonValue } from "../protocol/types.js";

/** PROJECT_BOOK §13.1：Schema 标识。 */
export const REPORT_SCHEMA_ID = "rejoinlab.report/v1" as const;
/** PROJECT_BOOK v1.0.2。 */
export const SPEC_VERSION = "1.0.2" as const;
/** AG-UI 1.0（PROJECT_BOOK §2.1 冻结的协议版本）。 */
export const PROTOCOL_VERSION = "1.0" as const;

/** PROJECT_BOOK §7：五种裁决。 */
export type ReportVerdict =
  | "CONSISTENT"
  | "INCONSISTENT"
  | "INCONCLUSIVE_LIMIT"
  | "INVALID_INPUT"
  | "INCOMPLETE_TRACE";

export const REPORT_VERDICTS: readonly ReportVerdict[] = [
  "CONSISTENT",
  "INCONSISTENT",
  "INCONCLUSIVE_LIMIT",
  "INVALID_INPUT",
  "INCOMPLETE_TRACE",
] as const;

/** PROJECT_BOOK §6：严重级别。 */
export type ReportSeverity = "CRITICAL" | "WARNING";

/** PROJECT_BOOK §8.4–§8.5：8 种注入算子（固定字典序）。 */
export const INJECTION_OPERATORS: readonly string[] = [
  "CURSOR_SKIP",
  "DROP_EVENT",
  "DUPLICATE_EVENT",
  "MESSAGE_ID_REMAP",
  "REPLAY_PREFIX",
  "STALE_SNAPSHOT",
  "SWAP_ADJACENT",
  "TRUNCATE_STREAM",
] as const;

/**
 * 报告 assumptions（冻结文本，来源：§13.3 样例 + §4.5/§8.3 的
 * 游标边界 + §4.4 的检查点来源）。buildReport 一律使用此表，
 * 不由调用方自由填写。
 */
export const REPORT_ASSUMPTIONS: readonly string[] = [
  "使用 AG-UI 1.0 事件语义",
  "事件到达顺序为权威顺序",
  "恢复游标为 RejoinLab 本地 sourceIndex；AG-UI 1.0 HTTP+SSE 本身不支持流恢复",
  "检查点状态来自断线前缀折叠或显式检查点 capturedState",
] as const;

/**
 * 报告 limitations（冻结文本，来源：§13.3 样例 + §18.2 不能证明
 * 的事项）。buildReport 一律使用此表。
 */
export const REPORT_LIMITATIONS: readonly string[] = [
  "不证明真实 Agent 后端 exactly-once",
  "不执行真实网络重连",
  "不证明真实 Agent 后端业务逻辑正确",
  "不证明真实服务端支持断点恢复",
  "不覆盖超过 40 条事件的轨迹",
] as const;

/** PROJECT_BOOK §13.2：诊断。 */
export interface ReportDiagnostic {
  readonly code: string;
  readonly severity: ReportSeverity;
  readonly sourceIndex?: number;
  readonly relatedSourceIndices?: number[];
  readonly message: string;
  readonly evidence: Record<string, unknown>;
}

/** PROJECT_BOOK §13.2：单条路径终态（无 runStatus，见模块头说明 3）。 */
export interface ReportPathResult {
  readonly finalStateHash: string;
  readonly messages: unknown[];
  readonly toolCalls: unknown[];
  readonly sharedState: unknown;
  readonly pendingToolCallIds: string[];
}

/** PROJECT_BOOK §13.2：首个分歧（只有这 4 类字段；无 kind / note 等）。 */
export interface ReportDifference {
  readonly jsonPointer: string;
  readonly expected: unknown;
  readonly actual: unknown;
}

/** PROJECT_BOOK §13.2：首个分歧。 */
export interface ReportFirstDivergence {
  readonly sourceIndex?: number;
  readonly fullStateHash: string;
  readonly resumeStateHash: string;
  readonly differences: ReportDifference[];
}

/** PROJECT_BOOK §13.2：rejoinlab.report/v1 报告。 */
export interface RejoinReport {
  readonly schema: "rejoinlab.report/v1";
  readonly specVersion: "1.0.2";
  readonly protocolVersion: "1.0";
  readonly scenarioId: string;
  readonly verdict: ReportVerdict;
  readonly input: {
    readonly sourceFormat: "JSONL" | "SSE";
    readonly eventCount: number;
    readonly sourceSha256: string;
  };
  readonly recovery: {
    readonly strategy: string;
    readonly disconnectAfter?: number;
    readonly resumeAfterSourceIndex?: number;
  };
  /** 无双轨终态时（INVALID_INPUT / INCONCLUSIVE_LIMIT）为 null（ADR-001）。 */
  readonly fullPath: ReportPathResult | null;
  /** 无双轨终态时（INVALID_INPUT / INCONCLUSIVE_LIMIT）为 null（ADR-001）。 */
  readonly resumePath: ReportPathResult | null;
  readonly firstDivergence?: ReportFirstDivergence;
  readonly diagnostics: ReportDiagnostic[];
  /**
   * v1.0.1 wire 契约：string[] | null。[] = BFS 已证实目标在无注入
   * 时已达成（如 G08）；null = 未计算（INVALID_INPUT /
   * INCONCLUSIVE_LIMIT / BFS 未运行 / 界内无序列可达）。TS 类型
   * 与 wire 契约一致（FIX-R1 收尾已落地，见模块头说明 2）：
   * json.ts 生产者透传 null、html.ts 有 null 分支。
   */
  readonly shortestInjectionSequence: string[] | null;
  readonly metrics: {
    readonly durationMs: number;
    readonly visitedStates: number;
  };
  readonly assumptions: string[];
  readonly limitations: string[];
}

/**
 * 冻结 JSON Schema（与 RejoinReport 类型一一对应；
 * shortestInjectionSequence 一项：JSON Schema（wire 契约）与 TS 类型
 * 均为 string[] | null（FIX-R1 收尾已落地，见模块头说明 2）。
 * - 顶层及每个子对象均为 additionalProperties: false。
 * - sourceSha256 / finalStateHash / fullStateHash / resumeStateHash
 *   必须为 64 位小写十六进制 SHA-256（§13.3 样例的 "fixture-sha256"
 *   是占位符，明确不是实际运行结果，故不在此接受）。
 * - shortestInjectionSequence 为 null（未计算）或元素均为 8 种冻结
 *   算子的数组；[] 表示目标在无注入时已达成。
 * - fullPath / resumePath 接受对象或 null（见模块头说明 1）。
 */
export const REJOIN_REPORT_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "rejoinlab.report/v1",
  title: "RejoinLab report",
  type: "object",
  additionalProperties: false,
  required: [
    "schema",
    "specVersion",
    "protocolVersion",
    "scenarioId",
    "verdict",
    "input",
    "recovery",
    "fullPath",
    "resumePath",
    "diagnostics",
    "shortestInjectionSequence",
    "metrics",
    "assumptions",
    "limitations",
  ],
  properties: {
    schema: { const: "rejoinlab.report/v1" },
    specVersion: { const: "1.0.2" },
    protocolVersion: { const: "1.0" },
    scenarioId: { type: "string", minLength: 1 },
    verdict: { enum: [...REPORT_VERDICTS] },
    input: {
      type: "object",
      additionalProperties: false,
      required: ["sourceFormat", "eventCount", "sourceSha256"],
      properties: {
        sourceFormat: { enum: ["JSONL", "SSE"] },
        eventCount: { type: "integer", minimum: 0 },
        sourceSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
    },
    recovery: {
      type: "object",
      additionalProperties: false,
      required: ["strategy"],
      properties: {
        strategy: { type: "string", minLength: 1 },
        disconnectAfter: { type: "integer", minimum: 0 },
        resumeAfterSourceIndex: { type: "integer", minimum: 0 },
      },
    },
    fullPath: { $ref: "#/$defs/pathResultOrNull" },
    resumePath: { $ref: "#/$defs/pathResultOrNull" },
    firstDivergence: {
      type: "object",
      additionalProperties: false,
      required: ["fullStateHash", "resumeStateHash", "differences"],
      properties: {
        sourceIndex: { type: "integer", minimum: 0 },
        fullStateHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        resumeStateHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
        differences: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["jsonPointer", "expected", "actual"],
            properties: {
              jsonPointer: { type: "string" },
              expected: true,
              actual: true,
            },
          },
        },
      },
    },
    diagnostics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["code", "severity", "message", "evidence"],
        properties: {
          code: { type: "string", minLength: 1 },
          severity: { enum: ["CRITICAL", "WARNING"] },
          sourceIndex: { type: "integer", minimum: 0 },
          relatedSourceIndices: {
            type: "array",
            items: { type: "integer", minimum: 0 },
          },
          message: { type: "string" },
          evidence: { type: "object" },
        },
      },
    },
    shortestInjectionSequence: {
      anyOf: [
        { type: "null" },
        {
          type: "array",
          items: { enum: [...INJECTION_OPERATORS] },
        },
      ],
    },
    metrics: {
      type: "object",
      additionalProperties: false,
      required: ["durationMs", "visitedStates"],
      properties: {
        durationMs: { type: "number", minimum: 0 },
        visitedStates: { type: "integer", minimum: 0 },
      },
    },
    assumptions: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
    limitations: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
    },
  },
  $defs: {
    pathResultOrNull: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: [
            "finalStateHash",
            "messages",
            "toolCalls",
            "sharedState",
            "pendingToolCallIds",
          ],
          properties: {
            finalStateHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
            messages: { type: "array" },
            toolCalls: { type: "array" },
            sharedState: true,
            pendingToolCallIds: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      ],
    },
  },
} as const;

// ---------------------------------------------------------------------------
// JSON 值清洗与校验
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * 检查一个值是否为 JSON 值（null / 布尔 / 有限数 / 字符串 /
 * 数组 / 纯对象，键值递归；拒绝 undefined、函数、symbol、
 * bigint、非有限数、循环引用、Date 等非纯对象）。
 */
export function isJsonValue(value: unknown, ancestors = new Set<object>()): boolean {
  if (value === null) return true;
  if (typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    try {
      return value.every((item) => isJsonValue(item, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  if (isPlainObject(value)) {
    if (ancestors.has(value)) return false;
    ancestors.add(value);
    try {
      return Object.values(value).every((child) => isJsonValue(child, ancestors));
    } finally {
      ancestors.delete(value);
    }
  }
  return false;
}

/**
 * 把一个值清洗为 JSON 值（深拷贝，不修改输入）：
 * - 对象中值为 undefined 的键直接丢弃（TS 可选字段未设置时）；
 * - 数组中的 undefined 元素按 JSON.stringify 的规则记为 null；
 * - 其余值原样递归。非 JSON 值（函数、循环引用等）会抛错，
 *   由调用方决定如何处理——报告组装层只喂入已知的状态/诊断
 *   数据，正常情况下不会触发。
 */
export function toJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : toJsonValue(item),
    );
  }
  if (!isPlainObject(value)) {
    throw new Error(
      `[report] value of type ${Object.prototype.toString.call(value)} is not a JSON value`,
    );
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const child = (value as Record<string, unknown>)[key];
    if (child === undefined) continue;
    out[key] = toJsonValue(child);
  }
  return out;
}

/** 校验结果。 */
export interface ReportValidation {
  readonly ok: boolean;
  readonly errors: string[];
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function checkExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  required: readonly string[],
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push(`${path}: unexpected key ${JSON.stringify(key)}`);
    }
  }
  for (const key of required) {
    if (!(key in value)) {
      errors.push(`${path}: missing required key ${JSON.stringify(key)}`);
    }
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 0
  );
}

function checkPathResult(
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (value === null) return;
  if (!isPlainObject(value)) {
    errors.push(`${path}: must be an object or null`);
    return;
  }
  checkExactKeys(
    value,
    ["finalStateHash", "messages", "toolCalls", "sharedState", "pendingToolCallIds"],
    ["finalStateHash", "messages", "toolCalls", "sharedState", "pendingToolCallIds"],
    path,
    errors,
  );
  if (
    typeof value["finalStateHash"] !== "string" ||
    !SHA256_HEX.test(value["finalStateHash"])
  ) {
    errors.push(`${path}.finalStateHash: must be a 64-char lowercase hex SHA-256`);
  }
  if (!Array.isArray(value["messages"])) {
    errors.push(`${path}.messages: must be an array`);
  } else if (!value["messages"].every((item) => isJsonValue(item))) {
    errors.push(`${path}.messages: every entry must be a JSON value`);
  }
  if (!Array.isArray(value["toolCalls"])) {
    errors.push(`${path}.toolCalls: must be an array`);
  } else if (!value["toolCalls"].every((item) => isJsonValue(item))) {
    errors.push(`${path}.toolCalls: every entry must be a JSON value`);
  }
  if (!("sharedState" in value) || !isJsonValue(value["sharedState"])) {
    errors.push(`${path}.sharedState: must be a JSON value`);
  }
  if (
    !Array.isArray(value["pendingToolCallIds"]) ||
    !value["pendingToolCallIds"].every((item) => typeof item === "string")
  ) {
    errors.push(`${path}.pendingToolCallIds: must be an array of strings`);
  }
}

/**
 * 按 REJOIN_REPORT_JSON_SCHEMA 校验一个值。只做结构校验（字段集、
 * 类型、枚举、哈希格式、JSON 值），不做跨字段业务一致性判断
 * （如裁决与诊断是否相符，那是组装层测试的事）。
 * 失败时 errors 列出全部问题，不在第一处停下。
 */
export function validateReport(value: unknown): ReportValidation {
  const errors: string[] = [];
  if (!isPlainObject(value)) {
    return { ok: false, errors: ["report: must be an object"] };
  }
  const allowedTop = [
    "schema",
    "specVersion",
    "protocolVersion",
    "scenarioId",
    "verdict",
    "input",
    "recovery",
    "fullPath",
    "resumePath",
    "firstDivergence",
    "diagnostics",
    "shortestInjectionSequence",
    "metrics",
    "assumptions",
    "limitations",
  ];
  const requiredTop = allowedTop.filter((key) => key !== "firstDivergence");
  checkExactKeys(value, allowedTop, requiredTop, "report", errors);

  if (value["schema"] !== REPORT_SCHEMA_ID) {
    errors.push(`report.schema: must be ${JSON.stringify(REPORT_SCHEMA_ID)}`);
  }
  if (value["specVersion"] !== SPEC_VERSION) {
    errors.push(`report.specVersion: must be ${JSON.stringify(SPEC_VERSION)}`);
  }
  if (value["protocolVersion"] !== PROTOCOL_VERSION) {
    errors.push(`report.protocolVersion: must be ${JSON.stringify(PROTOCOL_VERSION)}`);
  }
  if (typeof value["scenarioId"] !== "string" || value["scenarioId"] === "") {
    errors.push("report.scenarioId: must be a non-empty string");
  }
  if (
    typeof value["verdict"] !== "string" ||
    !(REPORT_VERDICTS as readonly string[]).includes(value["verdict"])
  ) {
    errors.push(
      `report.verdict: must be one of ${REPORT_VERDICTS.join(", ")}`,
    );
  }

  const input = value["input"];
  if (!isPlainObject(input)) {
    errors.push("report.input: must be an object");
  } else {
    checkExactKeys(
      input,
      ["sourceFormat", "eventCount", "sourceSha256"],
      ["sourceFormat", "eventCount", "sourceSha256"],
      "report.input",
      errors,
    );
    if (input["sourceFormat"] !== "JSONL" && input["sourceFormat"] !== "SSE") {
      errors.push('report.input.sourceFormat: must be "JSONL" or "SSE"');
    }
    if (!isNonNegativeInteger(input["eventCount"])) {
      errors.push("report.input.eventCount: must be a non-negative integer");
    }
    if (
      typeof input["sourceSha256"] !== "string" ||
      !SHA256_HEX.test(input["sourceSha256"])
    ) {
      errors.push(
        "report.input.sourceSha256: must be a 64-char lowercase hex SHA-256",
      );
    }
  }

  const recovery = value["recovery"];
  if (!isPlainObject(recovery)) {
    errors.push("report.recovery: must be an object");
  } else {
    checkExactKeys(
      recovery,
      ["strategy", "disconnectAfter", "resumeAfterSourceIndex"],
      ["strategy"],
      "report.recovery",
      errors,
    );
    if (
      typeof recovery["strategy"] !== "string" ||
      recovery["strategy"] === ""
    ) {
      errors.push("report.recovery.strategy: must be a non-empty string");
    }
    if (
      recovery["disconnectAfter"] !== undefined &&
      !isNonNegativeInteger(recovery["disconnectAfter"])
    ) {
      errors.push(
        "report.recovery.disconnectAfter: must be a non-negative integer",
      );
    }
    if (
      recovery["resumeAfterSourceIndex"] !== undefined &&
      !isNonNegativeInteger(recovery["resumeAfterSourceIndex"])
    ) {
      errors.push(
        "report.recovery.resumeAfterSourceIndex: must be a non-negative integer",
      );
    }
  }

  checkPathResult(value["fullPath"], "report.fullPath", errors);
  checkPathResult(value["resumePath"], "report.resumePath", errors);
  // 注意：这里不按裁决强制路径为空或非空。T005 的两种超限/无效
  // 形状不同：事件数超限的 INCONCLUSIVE_LIMIT 无终态（路径 null），
  // 而 BFS 节点超限的 INCONCLUSIVE_LIMIT 仍带双轨终态；恢复折叠
  // 失败的 INVALID_INPUT 可能只有 fullPath 而无 resumePath。
  // fullPath / resumePath 各自独立为对象或 null（见模块头说明 1），
  // 校验器只做结构检查，不替组装层裁决业务一致性。

  const firstDivergence = value["firstDivergence"];
  if (firstDivergence !== undefined) {
    if (!isPlainObject(firstDivergence)) {
      errors.push("report.firstDivergence: must be an object");
    } else {
      checkExactKeys(
        firstDivergence,
        ["sourceIndex", "fullStateHash", "resumeStateHash", "differences"],
        ["fullStateHash", "resumeStateHash", "differences"],
        "report.firstDivergence",
        errors,
      );
      if (
        firstDivergence["sourceIndex"] !== undefined &&
        !isNonNegativeInteger(firstDivergence["sourceIndex"])
      ) {
        errors.push(
          "report.firstDivergence.sourceIndex: must be a non-negative integer",
        );
      }
      for (const key of ["fullStateHash", "resumeStateHash"] as const) {
        if (
          typeof firstDivergence[key] !== "string" ||
          !SHA256_HEX.test(firstDivergence[key])
        ) {
          errors.push(
            `report.firstDivergence.${key}: must be a 64-char lowercase hex SHA-256`,
          );
        }
      }
      if (!Array.isArray(firstDivergence["differences"])) {
        errors.push("report.firstDivergence.differences: must be an array");
      } else {
        firstDivergence["differences"].forEach((item, index) => {
          const path = `report.firstDivergence.differences[${index}]`;
          if (!isPlainObject(item)) {
            errors.push(`${path}: must be an object`);
            return;
          }
          checkExactKeys(
            item,
            ["jsonPointer", "expected", "actual"],
            ["jsonPointer", "expected", "actual"],
            path,
            errors,
          );
          if (typeof item["jsonPointer"] !== "string") {
            errors.push(`${path}.jsonPointer: must be a string`);
          }
          if (!isJsonValue(item["expected"])) {
            errors.push(`${path}.expected: must be a JSON value`);
          }
          if (!isJsonValue(item["actual"])) {
            errors.push(`${path}.actual: must be a JSON value`);
          }
        });
      }
    }
  }

  if (!Array.isArray(value["diagnostics"])) {
    errors.push("report.diagnostics: must be an array");
  } else {
    value["diagnostics"].forEach((item, index) => {
      const path = `report.diagnostics[${index}]`;
      if (!isPlainObject(item)) {
        errors.push(`${path}: must be an object`);
        return;
      }
      checkExactKeys(
        item,
        ["code", "severity", "sourceIndex", "relatedSourceIndices", "message", "evidence"],
        ["code", "severity", "message", "evidence"],
        path,
        errors,
      );
      if (typeof item["code"] !== "string" || item["code"] === "") {
        errors.push(`${path}.code: must be a non-empty string`);
      }
      if (item["severity"] !== "CRITICAL" && item["severity"] !== "WARNING") {
        errors.push(`${path}.severity: must be "CRITICAL" or "WARNING"`);
      }
      if (
        item["sourceIndex"] !== undefined &&
        !isNonNegativeInteger(item["sourceIndex"])
      ) {
        errors.push(`${path}.sourceIndex: must be a non-negative integer`);
      }
      if (
        item["relatedSourceIndices"] !== undefined &&
        (!Array.isArray(item["relatedSourceIndices"]) ||
          !item["relatedSourceIndices"].every((entry) =>
            isNonNegativeInteger(entry),
          ))
      ) {
        errors.push(
          `${path}.relatedSourceIndices: must be an array of non-negative integers`,
        );
      }
      if (typeof item["message"] !== "string") {
        errors.push(`${path}.message: must be a string`);
      }
      if (!isPlainObject(item["evidence"])) {
        errors.push(`${path}.evidence: must be an object`);
      } else if (!isJsonValue(item["evidence"])) {
        errors.push(`${path}.evidence: every value must be a JSON value`);
      }
    });
  }

  // shortestInjectionSequence：null（未计算）或 8 种冻结算子的数组；
  // [] 表示目标在无注入时已达成（见模块头说明 2）。
  const sequence = value["shortestInjectionSequence"];
  if (sequence === null) {
    // 未计算：合法。
  } else if (!Array.isArray(sequence)) {
    errors.push(
      "report.shortestInjectionSequence: must be an array or null",
    );
  } else if (
    !sequence.every(
      (entry) =>
        typeof entry === "string" &&
        (INJECTION_OPERATORS as readonly string[]).includes(entry),
    )
  ) {
    errors.push(
      `report.shortestInjectionSequence: every entry must be one of ${INJECTION_OPERATORS.join(", ")}`,
    );
  }

  const metrics = value["metrics"];
  if (!isPlainObject(metrics)) {
    errors.push("report.metrics: must be an object");
  } else {
    checkExactKeys(
      metrics,
      ["durationMs", "visitedStates"],
      ["durationMs", "visitedStates"],
      "report.metrics",
      errors,
    );
    if (
      typeof metrics["durationMs"] !== "number" ||
      !Number.isFinite(metrics["durationMs"]) ||
      metrics["durationMs"] < 0
    ) {
      errors.push("report.metrics.durationMs: must be a finite number >= 0");
    }
    if (!isNonNegativeInteger(metrics["visitedStates"])) {
      errors.push(
        "report.metrics.visitedStates: must be a non-negative integer",
      );
    }
  }

  for (const key of ["assumptions", "limitations"] as const) {
    const list = value[key];
    if (
      !Array.isArray(list) ||
      list.length === 0 ||
      !list.every((entry) => typeof entry === "string" && entry !== "")
    ) {
      errors.push(
        `report.${key}: must be a non-empty array of non-empty strings`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/** 确认一个未知值是合法的 JsonValue（供 html.ts 的 JSON 嵌入复用）。 */
export type { JsonValue };
