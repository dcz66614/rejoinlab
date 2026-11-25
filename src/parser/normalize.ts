/**
 * P031 RejoinLab — T002: event normalization and validation.
 *
 * Frozen sources:
 * - docs/ag-ui-1.0-schema.json (AG-UI 1.0 JSON Schema, $id
 *   https://ag-ui.com/spec/1.0/schema.json) — required fields and types.
 * - docs/EVENT_SCHEMA.md §4.5/§5.4 (chunk rules), §6.2 (STATE_DELTA),
 *   §7 (subagentRunId), §8 (D-01..D-05), §9 (validation layers).
 * - docs/AGUI_SCOPE.md §3 (unsupported events), §4 (identifier boundaries).
 * - PROJECT_BOOK.md v1.0.0 §8.1 (size limits: 1 MiB input, 64 KiB/event).
 *
 * Design decisions (documented, not silent):
 * 1. This module does NOT expand *_CHUNK events into START/CONTENT/END.
 *    IMPLEMENTATION_PLAN §6 T003 explicitly owns chunk expansion
 *    ("TEXT_MESSAGE_CHUNK 展开；TOOL_CALL_CHUNK 展开"), so T002 validates
 *    the chunk protocol rules that are checkable at parse time (first-block
 *    fields, continuation identity, conflicting repeats, lane closure) and
 *    preserves chunks verbatim. The pure helper `expandChunks()` is provided
 *    here for T003 to call before the Reducer (EVENT_SCHEMA §4.5 rule 1:
 *    expansion happens before verification / before the Reducer sees events).
 * 2. Unknown extra fields are PRESERVED verbatim on the returned event
 *    object (spread of the raw object), never silently dropped
 *    (IMPLEMENTATION_PLAN §5.1). This intentionally does not enforce the
 *    Schema's `unevaluatedProperties: false` for extra fields: the plan's
 *    preservation rule wins, and a producer-added field must not break an
 *    otherwise valid import. `subagentRunId` is the sole property of Schema
 *    `Attributable` (EVENT_SCHEMA §7, D-04): a legitimate optional field on
 *    only 11 of the 15 MVP events (TEXT_MESSAGE_* 4, TOOL_CALL_* 5,
 *    STATE_SNAPSHOT, STATE_DELTA). RUN_STARTED, RUN_FINISHED, RUN_ERROR and
 *    MESSAGES_SNAPSHOT do not have it; on those 4 events it is preserved
 *    anyway — not by D-04 but by the plan §5.1 unknown-fields rule. Either
 *    way the behavior is the same: accept, never INVALID_INPUT, ignore at
 *    reduce time, keep the raw value as evidence; the Reducer ignores it.
 * 3. Validation is fail-fast: the first violation throws a ParseError
 *    carrying a structured diagnostic (code, message, sourceIndex, line,
 *    eventType, field). A partially parsed sequence is NEVER returned, so
 *    an incomplete parse cannot enter the Reducer (T002 failure fallback).
 *    The caller keeps the original input text and the diagnostic's line
 *    number for evidence.
 * 4. Determinism: pure functions only — no Date, no randomness, no
 *    timestamp-based ordering. sourceIndex is assigned 0-based in file
 *    arrival order, never re-sorted.
 */

import type { AGUIEvent, NormalizedEvent } from "../protocol/types.js";
import { isMvpEventType, MVP_EVENT_TYPES } from "../protocol/types.js";

/** PROJECT_BOOK §8.1: input file total size limit. */
export const MAX_INPUT_BYTES = 1024 * 1024; // 1 MiB
/** PROJECT_BOOK §8.1: single event size limit. */
export const MAX_EVENT_BYTES = 64 * 1024; // 64 KiB

/** The 31 event types of the AG-UI 1.0 Schema `EventType` enum. */
export const SCHEMA_EVENT_TYPES: readonly string[] = [
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_END",
  "TEXT_MESSAGE_CHUNK",
  "TOOL_CALL_START",
  "TOOL_CALL_ARGS",
  "TOOL_CALL_END",
  "TOOL_CALL_CHUNK",
  "TOOL_CALL_RESULT",
  "STATE_SNAPSHOT",
  "STATE_DELTA",
  "MESSAGES_SNAPSHOT",
  "ACTIVITY_SNAPSHOT",
  "ACTIVITY_DELTA",
  "RAW",
  "CUSTOM",
  "RUN_STARTED",
  "RUN_FINISHED",
  "RUN_ERROR",
  "STEP_STARTED",
  "STEP_FINISHED",
  "REASONING_START",
  "REASONING_MESSAGE_START",
  "REASONING_MESSAGE_CONTENT",
  "REASONING_MESSAGE_END",
  "REASONING_MESSAGE_CHUNK",
  "REASONING_END",
  "REASONING_ENCRYPTED_VALUE",
  "SUBAGENT_STARTED",
  "SUBAGENT_FINISHED",
  "SUBAGENT_ERROR",
] as const;

/** Known AG-UI 1.0 types that MVP deliberately does not support (AGUI_SCOPE §3). */
export const UNSUPPORTED_EVENT_TYPES: readonly string[] = [
  "STEP_STARTED",
  "STEP_FINISHED",
  "REASONING_START",
  "REASONING_MESSAGE_START",
  "REASONING_MESSAGE_CONTENT",
  "REASONING_MESSAGE_END",
  "REASONING_MESSAGE_CHUNK",
  "REASONING_END",
  "REASONING_ENCRYPTED_VALUE",
  "ACTIVITY_SNAPSHOT",
  "ACTIVITY_DELTA",
  "SUBAGENT_STARTED",
  "SUBAGENT_FINISHED",
  "SUBAGENT_ERROR",
  "RAW",
  "CUSTOM",
] as const;

export type DiagnosticCode = "INVALID_INPUT" | "INCONCLUSIVE_LIMIT";

export interface ParseDiagnostic {
  readonly code: DiagnosticCode;
  readonly message: string;
  /** 0-based event position in the import sequence, when known. */
  readonly sourceIndex?: number;
  /** 1-based input line number, when known. */
  readonly line?: number;
  readonly eventType?: string;
  readonly field?: string;
}

/** Thrown when parsing cannot complete. Carries structured diagnostics. */
export class ParseError extends Error {
  readonly diagnostics: readonly ParseDiagnostic[];
  readonly code: DiagnosticCode;

  constructor(diagnostics: readonly ParseDiagnostic[]) {
    super(diagnostics.map((d) => d.message).join("; "));
    this.name = "ParseError";
    this.diagnostics = diagnostics;
    this.code = diagnostics[0]?.code ?? "INVALID_INPUT";
  }
}

export function fail(diagnostic: ParseDiagnostic): never {
  throw new ParseError([diagnostic]);
}

/** UTF-8 byte length of a string (size limits are byte limits, not chars). */
export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** Enforce the 1 MiB total input limit (PROJECT_BOOK §8.1). */
export function checkInputSize(input: string): void {
  if (utf8ByteLength(input) > MAX_INPUT_BYTES) {
    fail({
      code: "INCONCLUSIVE_LIMIT",
      message:
        `Input exceeds the 1 MiB size limit ` +
        `(${utf8ByteLength(input)} bytes > ${MAX_INPUT_BYTES} bytes); ` +
        `input is rejected, never silently truncated.`,
    });
  }
}

/** Enforce the 64 KiB single-event limit (PROJECT_BOOK §8.1). */
export function checkEventSize(payload: string, line?: number, sourceIndex?: number): void {
  if (utf8ByteLength(payload) > MAX_EVENT_BYTES) {
    fail({
      code: "INCONCLUSIVE_LIMIT",
      message:
        `Single event exceeds the 64 KiB size limit ` +
        `(${utf8ByteLength(payload)} bytes > ${MAX_EVENT_BYTES} bytes); ` +
        `event is rejected, never silently truncated.`,
      line,
      sourceIndex,
    });
  }
}

export interface TextLine {
  readonly text: string;
  /** 1-based line number in the original input. */
  readonly line: number;
}

/**
 * Split input into lines, accepting LF, CRLF and bare CR as terminators.
 * The trailing empty piece produced by a final terminator is dropped so a
 * file ending in a newline does not gain a phantom blank line.
 */
export function splitTextLines(input: string): TextLine[] {
  const stripped = input.startsWith("﻿") ? input.slice(1) : input;
  const parts = stripped.split(/\r\n|\r|\n/);
  if (parts.length > 0 && parts[parts.length - 1] === "" && /(\r\n|\r|\n)$/.test(stripped)) {
    parts.pop();
  }
  return parts.map((text, i) => ({ text, line: i + 1 }));
}

// ---------------------------------------------------------------------------
// Per-event validation (Schema layer + chunk protocol layer, EVENT_SCHEMA §9)
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failMissing(
  type: string,
  field: string,
  sourceIndex?: number,
  line?: number,
): never {
  fail({
    code: "INVALID_INPUT",
    message: `Event ${type} is missing required field "${field}" (AG-UI 1.0 Schema).`,
    eventType: type,
    field,
    sourceIndex,
    line,
  });
}

function requireString(
  raw: Record<string, unknown>,
  type: string,
  field: string,
  sourceIndex?: number,
  line?: number,
): string {
  if (!(field in raw)) failMissing(type, field, sourceIndex, line);
  const value = raw[field];
  if (typeof value !== "string") {
    fail({
      code: "INVALID_INPUT",
      message: `Event ${type} field "${field}" must be a string, got ${typeof value}.`,
      eventType: type,
      field,
      sourceIndex,
      line,
    });
  }
  return value as string;
}

function optionalString(
  raw: Record<string, unknown>,
  type: string,
  field: string,
  sourceIndex?: number,
  line?: number,
): void {
  if (field in raw && raw[field] !== undefined && typeof raw[field] !== "string") {
    fail({
      code: "INVALID_INPUT",
      message: `Event ${type} field "${field}" must be a string, got ${typeof raw[field]}.`,
      eventType: type,
      field,
      sourceIndex,
      line,
    });
  }
}

function requirePresent(
  raw: Record<string, unknown>,
  type: string,
  field: string,
  sourceIndex?: number,
  line?: number,
): unknown {
  if (!(field in raw) || raw[field] === undefined) failMissing(type, field, sourceIndex, line);
  return raw[field];
}

const TEXT_ROLES = ["developer", "system", "assistant", "user"] as const;
const MESSAGE_ROLES = [
  "developer",
  "system",
  "assistant",
  "user",
  "tool",
  "activity",
  "reasoning",
] as const;

function checkRole(
  raw: Record<string, unknown>,
  type: string,
  field: string,
  allowed: readonly string[],
  sourceIndex?: number,
  line?: number,
): void {
  if (field in raw && raw[field] !== undefined) {
    if (typeof raw[field] !== "string" || !allowed.includes(raw[field] as string)) {
      fail({
        code: "INVALID_INPUT",
        message:
          `Event ${type} field "${field}" must be one of ${allowed.join(", ")}, ` +
          `got ${JSON.stringify(raw[field])}.`,
        eventType: type,
        field,
        sourceIndex,
        line,
      });
    }
  }
}

function checkStringArray(
  value: unknown,
  type: string,
  field: string,
  sourceIndex?: number,
  line?: number,
): void {
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    fail({
      code: "INVALID_INPUT",
      message: `Event ${type} field "${field}" must be an array of strings.`,
      eventType: type,
      field,
      sourceIndex,
      line,
    });
  }
}

/** Validate the `messages` array of MESSAGES_SNAPSHOT / RunAgentInput.input. */
function checkMessagesArray(
  value: unknown,
  type: string,
  field: string,
  sourceIndex?: number,
  line?: number,
): void {
  if (!Array.isArray(value)) {
    fail({
      code: "INVALID_INPUT",
      message: `Event ${type} field "${field}" must be an array of messages.`,
      eventType: type,
      field,
      sourceIndex,
      line,
    });
  }
  value.forEach((m, i) => {
    if (!isRecord(m)) {
      fail({
        code: "INVALID_INPUT",
        message: `Event ${type} field "${field}[${i}]" must be a message object.`,
        eventType: type,
        field,
        sourceIndex,
        line,
      });
    }
    if (typeof m["id"] !== "string") {
      fail({
        code: "INVALID_INPUT",
        message: `Event ${type} field "${field}[${i}].id" must be a string (Message requires id).`,
        eventType: type,
        field,
        sourceIndex,
        line,
      });
    }
    if (typeof m["role"] !== "string" || !MESSAGE_ROLES.includes(m["role"] as (typeof MESSAGE_ROLES)[number])) {
      fail({
        code: "INVALID_INPUT",
        message:
          `Event ${type} field "${field}[${i}].role" must be one of ` +
          `${MESSAGE_ROLES.join(", ")}, got ${JSON.stringify(m["role"])}.`,
        eventType: type,
        field,
        sourceIndex,
        line,
      });
    }
    // Per-role required fields (AG-UI 1.0 Schema docs/ag-ui-1.0-schema.json
    // $defs; FIX-R2 P1-R2-01). Common id/role are checked above; the
    // role-specific fields are:
    // - developer / system / reasoning: content (string).
    // - assistant: content is OPTIONAL (a turn may be tool calls only),
    //   but must be a string when present.
    // - user / tool: content (string or ContentPart array); tool also
    //   requires toolCallId (string).
    // - activity: activityType (string) and content (object).
    const role = m["role"] as string;
    const where = `${field}[${i}]`;
    switch (role) {
      case "developer":
      case "system":
      case "reasoning": {
        if (typeof m["content"] !== "string") {
          fail({
            code: "INVALID_INPUT",
            message: `Event ${type} field "${where}.content" must be a string (role "${role}" requires content).`,
            eventType: type,
            field,
            sourceIndex,
            line,
          });
        }
        break;
      }
      case "assistant": {
        if ("content" in m && m["content"] !== undefined && typeof m["content"] !== "string") {
          fail({
            code: "INVALID_INPUT",
            message: `Event ${type} field "${where}.content" must be a string when present (role "assistant").`,
            eventType: type,
            field,
            sourceIndex,
            line,
          });
        }
        break;
      }
      case "user":
      case "tool": {
        const content = m["content"];
        if (typeof content === "string") {
          break;
        }
        if (Array.isArray(content)) {
          checkContentParts(content, type, sourceIndex, line);
          break;
        }
        fail({
          code: "INVALID_INPUT",
          message: `Event ${type} field "${where}.content" must be a string or an array of content parts (role "${role}" requires content).`,
          eventType: type,
          field,
          sourceIndex,
          line,
        });
      }
      case "activity": {
        if (typeof m["activityType"] !== "string") {
          fail({
            code: "INVALID_INPUT",
            message: `Event ${type} field "${where}.activityType" must be a string (role "activity" requires activityType).`,
            eventType: type,
            field,
            sourceIndex,
            line,
          });
        }
        if (!isRecord(m["content"])) {
          fail({
            code: "INVALID_INPUT",
            message: `Event ${type} field "${where}.content" must be an object (role "activity" requires content).`,
            eventType: type,
            field,
            sourceIndex,
            line,
          });
        }
        break;
      }
      default:
        // Unreachable: role was validated against MESSAGE_ROLES above.
        break;
    }
    if (role === "tool" && typeof m["toolCallId"] !== "string") {
      fail({
        code: "INVALID_INPUT",
        message: `Event ${type} field "${where}.toolCallId" must be a string (role "tool" requires toolCallId).`,
        eventType: type,
        field,
        sourceIndex,
        line,
      });
    }
  });
}

/**
 * Validate one RFC 6902 patch array (EVENT_SCHEMA §6.2).
 * Structural errors (not an array, op missing/not a string, required member
 * missing or wrong type) are INVALID_INPUT. An `op` naming an operation the
 * spec does not define is NOT malformed — it passes through untouched for
 * the Reducer to discard-with-warning per §6.2.
 */
function checkJsonPatch(
  value: unknown,
  type: string,
  sourceIndex?: number,
  line?: number,
): void {
  if (!Array.isArray(value)) {
    fail({
      code: "INVALID_INPUT",
      message: `Event ${type} field "delta" must be a JSON Patch array (RFC 6902).`,
      eventType: type,
      field: "delta",
      sourceIndex,
      line,
    });
  }
  const knownOps = ["add", "remove", "replace", "move", "copy", "test"] as const;
  value.forEach((op, i) => {
    const where = `delta[${i}]`;
    if (!isRecord(op)) {
      fail({
        code: "INVALID_INPUT",
        message: `Event ${type} field "${where}" must be a patch operation object.`,
        eventType: type,
        field: "delta",
        sourceIndex,
        line,
      });
    }
    if (typeof op["op"] !== "string") {
      fail({
        code: "INVALID_INPUT",
        message: `Event ${type} field "${where}.op" must be a string.`,
        eventType: type,
        field: "delta",
        sourceIndex,
        line,
      });
    }
    const opName = op["op"] as string;
    if (!(knownOps as readonly string[]).includes(opName)) {
      // Unrecognized op: not malformed; Reducer discards it with a warning.
      return;
    }
    if (typeof op["path"] !== "string") {
      fail({
        code: "INVALID_INPUT",
        message: `Event ${type} field "${where}.path" must be a string for op "${opName}".`,
        eventType: type,
        field: "delta",
        sourceIndex,
        line,
      });
    }
    if (opName === "add" || opName === "replace" || opName === "test") {
      if (!("value" in op)) {
        fail({
          code: "INVALID_INPUT",
          message: `Event ${type} field "${where}.value" is required for op "${opName}".`,
          eventType: type,
          field: "delta",
          sourceIndex,
          line,
        });
      }
    }
    if (opName === "move" || opName === "copy") {
      if (typeof op["from"] !== "string") {
        fail({
          code: "INVALID_INPUT",
          message: `Event ${type} field "${where}.from" must be a string for op "${opName}".`,
          eventType: type,
          field: "delta",
          sourceIndex,
          line,
        });
      }
    }
  });
}

function checkContentParts(
  value: unknown,
  type: string,
  sourceIndex?: number,
  line?: number,
): void {
  if (typeof value === "string") return;
  if (!Array.isArray(value)) {
    fail({
      code: "INVALID_INPUT",
      message: `Event ${type} field "content" must be a string or an array of content parts.`,
      eventType: type,
      field: "content",
      sourceIndex,
      line,
    });
  }
  value.forEach((part, i) => {
    if (!isRecord(part) || typeof part["type"] !== "string") {
      fail({
        code: "INVALID_INPUT",
        message: `Event ${type} field "content[${i}].type" must be a string.`,
        eventType: type,
        field: "content",
        sourceIndex,
        line,
      });
    }
    if (part["type"] === "text") {
      if (typeof part["text"] !== "string") {
        fail({
          code: "INVALID_INPUT",
          message: `Event ${type} field "content[${i}].text" must be a string for a text part.`,
          eventType: type,
          field: "content",
          sourceIndex,
          line,
        });
      }
    } else if (["image", "audio", "video", "document"].includes(part["type"] as string)) {
      const src = part["source"];
      if (!isRecord(src) || typeof src["type"] !== "string" || typeof src["value"] !== "string") {
        fail({
          code: "INVALID_INPUT",
          message:
            `Event ${type} field "content[${i}].source" must be an object with ` +
            `string "type" and "value" for a media part.`,
          eventType: type,
          field: "content",
          sourceIndex,
          line,
        });
      }
    } else {
      fail({
        code: "INVALID_INPUT",
        message:
          `Event ${type} field "content[${i}].type" is not a known content part type: ` +
          `${JSON.stringify(part["type"])}.`,
        eventType: type,
        field: "content",
        sourceIndex,
        line,
      });
    }
  });
}

/**
 * Validate a single raw JSON value as one AG-UI event and return it verbatim
 * (unknown fields preserved by spread). Throws ParseError on any violation.
 * This is the stateless Schema-layer check; chunk lane rules live in
 * `normalizeEvents`, which sees the whole sequence.
 */
export function validateEvent(
  raw: unknown,
  sourceIndex?: number,
  line?: number,
): AGUIEvent {
  if (!isRecord(raw)) {
    fail({
      code: "INVALID_INPUT",
      message: `Event at ${line !== undefined ? `line ${line}` : `sourceIndex ${sourceIndex ?? "?"}`} must be a JSON object, got ${Array.isArray(raw) ? "array" : typeof raw}.`,
      sourceIndex,
      line,
    });
  }
  const typeValue = raw["type"];
  if (typeof typeValue !== "string") {
    fail({
      code: "INVALID_INPUT",
      message: `Event is missing required field "type" (must be a string).`,
      field: "type",
      sourceIndex,
      line,
    });
  }
  const type = typeValue as string;
  if (!(SCHEMA_EVENT_TYPES as readonly string[]).includes(type)) {
    fail({
      code: "INVALID_INPUT",
      message:
        `Unknown event type ${JSON.stringify(type)}: not in the AG-UI 1.0 ` +
        `Schema EventType enum (31 values).`,
      eventType: type,
      sourceIndex,
      line,
    });
  }
  if ((UNSUPPORTED_EVENT_TYPES as readonly string[]).includes(type)) {
    fail({
      code: "INCONCLUSIVE_LIMIT",
      message:
        `Unsupported event type ${type} at ${line !== undefined ? `line ${line}` : `sourceIndex ${sourceIndex ?? "?"}`}: ` +
        `AG-UI 1.0 defines it but RejoinLab MVP does not implement it ` +
        `(AGUI_SCOPE §3). Event position is preserved in this diagnostic; ` +
        `the event is not silently dropped.`,
      eventType: type,
      sourceIndex,
      line,
    });
  }

  // Common fields (BaseEvent).
  if ("timestamp" in raw && raw["timestamp"] !== undefined) {
    if (typeof raw["timestamp"] !== "number" || !Number.isInteger(raw["timestamp"])) {
      fail({
        code: "INVALID_INPUT",
        message: `Event ${type} field "timestamp" must be an integer.`,
        eventType: type,
        field: "timestamp",
        sourceIndex,
        line,
      });
    }
  }
  if ("metadata" in raw && raw["metadata"] !== undefined) {
    if (!isRecord(raw["metadata"])) {
      fail({
        code: "INVALID_INPUT",
        message: `Event ${type} field "metadata" must be an object, never null.`,
        eventType: type,
        field: "metadata",
        sourceIndex,
        line,
      });
    }
  }

  // Per-type required fields and types (Schema `required` arrays, NOT the
  // project book's prose summaries — EVENT_SCHEMA §8 D-01/D-02).
  switch (type) {
    case "RUN_STARTED": {
      requireString(raw, type, "threadId", sourceIndex, line);
      requireString(raw, type, "runId", sourceIndex, line);
      optionalString(raw, type, "protocolVersion", sourceIndex, line);
      optionalString(raw, type, "parentRunId", sourceIndex, line);
      if ("input" in raw && raw["input"] !== undefined) {
        const input = raw["input"];
        if (!isRecord(input)) {
          fail({ code: "INVALID_INPUT", message: `Event RUN_STARTED field "input" must be an object.`, eventType: type, field: "input", sourceIndex, line });
        }
        requireString(input, "RUN_STARTED input", "threadId", sourceIndex, line);
        requireString(input, "RUN_STARTED input", "runId", sourceIndex, line);
        if (!("messages" in input)) failMissing("RUN_STARTED input", "messages", sourceIndex, line);
        checkMessagesArray(input["messages"], "RUN_STARTED input", "messages", sourceIndex, line);
      }
      break;
    }
    case "RUN_FINISHED": {
      // D-01: Schema requires type + threadId + runId (book §3.4 listed type only).
      requireString(raw, type, "threadId", sourceIndex, line);
      requireString(raw, type, "runId", sourceIndex, line);
      if ("outcome" in raw && raw["outcome"] !== undefined) {
        const outcome = raw["outcome"];
        if (!isRecord(outcome) || typeof outcome["type"] !== "string") {
          fail({ code: "INVALID_INPUT", message: `Event RUN_FINISHED field "outcome" must be an object with a string "type".`, eventType: type, field: "outcome", sourceIndex, line });
        }
        const otype = outcome["type"] as string;
        if (otype === "success") {
          if ("pendingToolCallIds" in outcome && outcome["pendingToolCallIds"] !== undefined) {
            checkStringArray(outcome["pendingToolCallIds"], type, "outcome.pendingToolCallIds", sourceIndex, line);
          }
        } else if (otype === "interrupt") {
          if (!Array.isArray(outcome["interrupts"]) || outcome["interrupts"].length < 1) {
            fail({ code: "INVALID_INPUT", message: `Event RUN_FINISHED outcome "interrupt" requires "interrupts" with at least 1 item.`, eventType: type, field: "outcome.interrupts", sourceIndex, line });
          }
        } else if (otype !== "cancelled") {
          fail({ code: "INVALID_INPUT", message: `Event RUN_FINISHED outcome type must be "success", "interrupt" or "cancelled", got ${JSON.stringify(otype)}.`, eventType: type, field: "outcome.type", sourceIndex, line });
        }
      }
      break;
    }
    case "RUN_ERROR": {
      requireString(raw, type, "message", sourceIndex, line);
      optionalString(raw, type, "code", sourceIndex, line);
      break;
    }
    case "TEXT_MESSAGE_START": {
      requireString(raw, type, "messageId", sourceIndex, line);
      checkRole(raw, type, "role", TEXT_ROLES, sourceIndex, line);
      optionalString(raw, type, "name", sourceIndex, line);
      break;
    }
    case "TEXT_MESSAGE_CONTENT": {
      requireString(raw, type, "messageId", sourceIndex, line);
      // Empty-string delta is legal (keep-alive); never an error by itself.
      requireString(raw, type, "delta", sourceIndex, line);
      break;
    }
    case "TEXT_MESSAGE_END": {
      requireString(raw, type, "messageId", sourceIndex, line);
      break;
    }
    case "TEXT_MESSAGE_CHUNK": {
      // Schema requires type only; first-chunk messageId is a prose rule
      // enforced by the lane state machine in normalizeEvents (D-02).
      checkRole(raw, type, "role", TEXT_ROLES, sourceIndex, line);
      optionalString(raw, type, "messageId", sourceIndex, line);
      optionalString(raw, type, "name", sourceIndex, line);
      optionalString(raw, type, "delta", sourceIndex, line);
      break;
    }
    case "TOOL_CALL_START": {
      requireString(raw, type, "toolCallId", sourceIndex, line);
      requireString(raw, type, "toolCallName", sourceIndex, line);
      optionalString(raw, type, "parentMessageId", sourceIndex, line);
      break;
    }
    case "TOOL_CALL_ARGS": {
      requireString(raw, type, "toolCallId", sourceIndex, line);
      requireString(raw, type, "delta", sourceIndex, line);
      break;
    }
    case "TOOL_CALL_END": {
      requireString(raw, type, "toolCallId", sourceIndex, line);
      break;
    }
    case "TOOL_CALL_CHUNK": {
      // Schema requires type only; first-chunk toolCallId/toolCallName is a
      // prose rule enforced by the lane state machine (D-02).
      optionalString(raw, type, "toolCallId", sourceIndex, line);
      optionalString(raw, type, "toolCallName", sourceIndex, line);
      optionalString(raw, type, "parentMessageId", sourceIndex, line);
      optionalString(raw, type, "delta", sourceIndex, line);
      break;
    }
    case "TOOL_CALL_RESULT": {
      requireString(raw, type, "messageId", sourceIndex, line);
      requireString(raw, type, "toolCallId", sourceIndex, line);
      const content = requirePresent(raw, type, "content", sourceIndex, line);
      checkContentParts(content, type, sourceIndex, line);
      checkRole(raw, type, "role", ["tool"], sourceIndex, line);
      break;
    }
    case "STATE_SNAPSHOT": {
      // Any JSON value is legal, including null; only presence is required.
      requirePresent(raw, type, "snapshot", sourceIndex, line);
      break;
    }
    case "STATE_DELTA": {
      const delta = requirePresent(raw, type, "delta", sourceIndex, line);
      checkJsonPatch(delta, type, sourceIndex, line);
      break;
    }
    case "MESSAGES_SNAPSHOT": {
      const messages = requirePresent(raw, type, "messages", sourceIndex, line);
      checkMessagesArray(messages, type, "messages", sourceIndex, line);
      break;
    }
    default:
      // Unreachable: unsupported/unknown types fail above.
      fail({
        code: "INVALID_INPUT",
        message: `Unhandled event type ${type}.`,
        eventType: type,
        sourceIndex,
        line,
      });
  }

  // Verbatim preservation: unknown fields stay on the event object as
  // evidence. `subagentRunId` is a legitimate optional field on 11 of the 15
  // MVP events (Schema `Attributable`, EVENT_SCHEMA §7/D-04: TEXT_MESSAGE_*
  // 4, TOOL_CALL_* 5, STATE_SNAPSHOT, STATE_DELTA); on the other 4
  // (RUN_STARTED, RUN_FINISHED, RUN_ERROR, MESSAGES_SNAPSHOT) it is kept by
  // the plan §5.1 unknown-fields rule instead. The Reducer ignores it;
  // nothing is silently dropped.
  return { ...(raw as Record<string, unknown>) } as unknown as AGUIEvent;
}

// ---------------------------------------------------------------------------
// Sequence-level validation: chunk lanes (EVENT_SCHEMA §4.5/§5.4)
// ---------------------------------------------------------------------------

export interface RawImportItem {
  readonly raw: unknown;
  readonly transportEventId: string | null;
  /** 1-based input line where this event starts (for diagnostics). */
  readonly line?: number;
}

interface TextLane {
  messageId: string;
  role: string;
  name?: string;
}

interface ToolLane {
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
}

/**
 * Validate a whole import sequence and assign stable 0-based sourceIndex
 * values in arrival order. Enforces the chunk first-block / continuation /
 * conflict / lane-closure rules (EVENT_SCHEMA §4.5 rule 2–5, §5.4).
 * Throws ParseError on the first violation; never returns a partial list.
 */
export function normalizeEvents(items: readonly RawImportItem[]): NormalizedEvent[] {
  let textLane: TextLane | null = null;
  let toolLane: ToolLane | null = null;
  const out: NormalizedEvent[] = [];

  const closeAllLanes = (): void => {
    textLane = null;
    toolLane = null;
  };

  items.forEach((item, index) => {
    const event = validateEvent(item.raw, index, item.line);
    const type = event.type;

    if (type === "TEXT_MESSAGE_CHUNK") {
      const chunk = event as unknown as Record<string, unknown>;
      const messageId = chunk["messageId"];
      const role = typeof chunk["role"] === "string" ? (chunk["role"] as string) : undefined;
      const name = typeof chunk["name"] === "string" ? (chunk["name"] as string) : undefined;
      if (typeof messageId === "string") {
        if (textLane && textLane.messageId !== messageId) {
          // A chunk naming a different id opens a new item; the previous
          // item closes (synthetic END at expansion time).
          textLane = { messageId, role: role ?? "assistant", name };
        } else if (textLane) {
          if (role !== undefined && role !== textLane.role) {
            fail({
              code: "INVALID_INPUT",
              message: `TEXT_MESSAGE_CHUNK for message ${messageId} repeats role ${JSON.stringify(role)} conflicting with the opener role ${JSON.stringify(textLane.role)}.`,
              eventType: type, field: "role", sourceIndex: index, line: item.line,
            });
          }
          if (name !== undefined && textLane.name !== undefined && name !== textLane.name) {
            fail({
              code: "INVALID_INPUT",
              message: `TEXT_MESSAGE_CHUNK for message ${messageId} repeats name ${JSON.stringify(name)} conflicting with the opener name ${JSON.stringify(textLane.name)}.`,
              eventType: type, field: "name", sourceIndex: index, line: item.line,
            });
          }
        } else {
          textLane = { messageId, role: role ?? "assistant", name };
        }
      } else if (textLane === null) {
        // First chunk of an item MUST carry messageId; never invent one.
        fail({
          code: "INVALID_INPUT",
          message: `First TEXT_MESSAGE_CHUNK of an item must carry "messageId" (AG-UI 1.0 Streaming Messages, "The first chunk"); the identifier must not be invented.`,
          eventType: type, field: "messageId", sourceIndex: index, line: item.line,
        });
      } else {
        if (role !== undefined && role !== textLane.role) {
          fail({
            code: "INVALID_INPUT",
            message: `TEXT_MESSAGE_CHUNK continuation repeats role ${JSON.stringify(role)} conflicting with the opener role ${JSON.stringify(textLane.role)}.`,
            eventType: type, field: "role", sourceIndex: index, line: item.line,
          });
        }
        if (name !== undefined && textLane.name !== undefined && name !== textLane.name) {
          fail({
            code: "INVALID_INPUT",
            message: `TEXT_MESSAGE_CHUNK continuation repeats name ${JSON.stringify(name)} conflicting with the opener name ${JSON.stringify(textLane.name)}.`,
            eventType: type, field: "name", sourceIndex: index, line: item.line,
          });
        }
      }
    } else if (type === "TOOL_CALL_CHUNK") {
      const chunk = event as unknown as Record<string, unknown>;
      const toolCallId = chunk["toolCallId"];
      const toolCallName = chunk["toolCallName"];
      const parentMessageId =
        typeof chunk["parentMessageId"] === "string" ? (chunk["parentMessageId"] as string) : undefined;
      if (typeof toolCallId === "string") {
        if (toolLane && toolLane.toolCallId !== toolCallId) {
          if (typeof toolCallName !== "string") {
            fail({
              code: "INVALID_INPUT",
              message: `First TOOL_CALL_CHUNK of a new call ${toolCallId} must carry "toolCallName".`,
              eventType: type, field: "toolCallName", sourceIndex: index, line: item.line,
            });
          }
          toolLane = { toolCallId, toolCallName: toolCallName as string, parentMessageId };
        } else if (toolLane) {
          if (typeof toolCallName === "string" && toolCallName !== toolLane.toolCallName) {
            fail({
              code: "INVALID_INPUT",
              message: `TOOL_CALL_CHUNK for call ${toolCallId} repeats toolCallName ${JSON.stringify(toolCallName)} conflicting with the opener ${JSON.stringify(toolLane.toolCallName)}.`,
              eventType: type, field: "toolCallName", sourceIndex: index, line: item.line,
            });
          }
          if (parentMessageId !== undefined && toolLane.parentMessageId !== undefined && parentMessageId !== toolLane.parentMessageId) {
            fail({
              code: "INVALID_INPUT",
              message: `TOOL_CALL_CHUNK for call ${toolCallId} repeats parentMessageId conflicting with the opener.`,
              eventType: type, field: "parentMessageId", sourceIndex: index, line: item.line,
            });
          }
        } else {
          if (typeof toolCallName !== "string") {
            fail({
              code: "INVALID_INPUT",
              message: `First TOOL_CALL_CHUNK of a call must carry "toolCallName" (AG-UI 1.0 Streaming Messages, "The first chunk").`,
              eventType: type, field: "toolCallName", sourceIndex: index, line: item.line,
            });
          }
          toolLane = { toolCallId, toolCallName: toolCallName as string, parentMessageId };
        }
      } else if (toolLane === null) {
        fail({
          code: "INVALID_INPUT",
          message: `First TOOL_CALL_CHUNK of a call must carry "toolCallId" (and "toolCallName"); the identifier must not be invented.`,
          eventType: type, field: "toolCallId", sourceIndex: index, line: item.line,
        });
      } else {
        if (typeof toolCallName === "string" && toolCallName !== toolLane.toolCallName) {
          fail({
            code: "INVALID_INPUT",
            message: `TOOL_CALL_CHUNK continuation repeats toolCallName ${JSON.stringify(toolCallName)} conflicting with the opener ${JSON.stringify(toolLane.toolCallName)}.`,
            eventType: type, field: "toolCallName", sourceIndex: index, line: item.line,
          });
        }
      }
    } else if (
      type === "RUN_STARTED" ||
      type === "RUN_FINISHED" ||
      type === "RUN_ERROR" ||
      type === "MESSAGES_SNAPSHOT"
    ) {
      // Run-level events close ALL chunk lanes (EVENT_SCHEMA §4.5 rule 5).
      closeAllLanes();
    } else if (type === "TEXT_MESSAGE_START" || type === "TEXT_MESSAGE_CONTENT" || type === "TEXT_MESSAGE_END") {
      // An explicit event in the message lane terminates the chunk shorthand
      // for that item; afterwards the triple rules apply (rule 2).
      textLane = null;
    } else if (type === "TOOL_CALL_START" || type === "TOOL_CALL_ARGS" || type === "TOOL_CALL_END" || type === "TOOL_CALL_RESULT") {
      toolLane = null;
    }
    // STATE_SNAPSHOT / STATE_DELTA are a different lane and do not close
    // text/tool chunk lanes (EVENT_SCHEMA §4.5 rule 5, "in that lane").

    out.push({
      sourceIndex: index,
      sourceEventKey: null,
      transportEventId: item.transportEventId,
      event,
    });
  });

  return out;
}

/**
 * Normalize a single event without sequence context (no chunk lane checks).
 * Useful for unit tests and for callers that validate one event at a time.
 */
export function normalizeEvent(
  raw: unknown,
  sourceIndex: number,
  transportEventId: string | null = null,
  line?: number,
): NormalizedEvent {
  return {
    sourceIndex,
    sourceEventKey: null,
    transportEventId,
    event: validateEvent(raw, sourceIndex, line),
  };
}

// ---------------------------------------------------------------------------
// Chunk expansion (for T003; see the header note #1)
// ---------------------------------------------------------------------------

function mergeMetadata(
  base: Record<string, unknown> | undefined,
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (base === undefined) return extra;
  if (extra === undefined) return base;
  return { ...base, ...extra };
}

/**
 * Fields `expandChunks()` copies verbatim from a chunk onto the synthetic
 * event that chunk produces, beyond the chunk's own known fields
 * (IMPLEMENTATION_PLAN §5.1: unknown fields must never be silently dropped).
 * "Extras" are every field outside the chunk type's known set — i.e. the
 * BaseEvent `timestamp`, the Schema `Attributable` field `subagentRunId`,
 * `rawEvent`, and any producer-added field (`zzzCustom`, ...). `type`,
 * `delta` and `metadata` are excluded: `type`/`delta` are rewritten by the
 * expansion itself and `metadata` follows its own merge rule (§4.5 rule 6).
 * The known identity/descriptive fields (messageId/role/name,
 * toolCallId/toolCallName/parentMessageId) are excluded because they are
 * placed explicitly by field attribution, not carried blindly.
 */
const TEXT_CHUNK_KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "messageId",
  "role",
  "name",
  "delta",
  "metadata",
]);
const TOOL_CHUNK_KNOWN_FIELDS: ReadonlySet<string> = new Set([
  "type",
  "toolCallId",
  "toolCallName",
  "parentMessageId",
  "delta",
  "metadata",
]);

function chunkExtras(
  raw: Record<string, unknown>,
  known: ReadonlySet<string>,
): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!known.has(key)) extras[key] = value;
  }
  return extras;
}

/**
 * Expand *_CHUNK events into START / CONTENT|ARGS / END triples, per
 * EVENT_SCHEMA §4.5/§5.4. Synthetic END events are emitted when a chunk
 * opens a different item, when an explicit event arrives in the same lane,
 * when a run-level event arrives, or at end of stream.
 *
 * The output is re-indexed from 0 in emission order: expanded indices are
 * post-expansion sequence numbers, NOT input line numbers. Synthetic END
 * events have transportEventId null (they were never on the wire) and
 * sourceEventKey null. Chunk metadata is merged onto the synthetic event
 * the chunk produced (START, CONTENT/ARGS, or the preceding event of the
 * same item for a metadata-only trailing chunk).
 *
 * Evidence preservation (IMPLEMENTATION_PLAN §5.1 — no field is silently
 * dropped): a chunk's `timestamp` and every other field outside its known
 * set (`subagentRunId`, `rawEvent`, producer-added fields, ...) ride on the
 * FIRST synthetic event that chunk produces — the START for a first chunk
 * (opener fields per EVENT_SCHEMA §4.1), the CONTENT/ARGS for a
 * continuation chunk. A continuation chunk carrying extras but no delta
 * still expands into an event: an empty-delta CONTENT/ARGS carrying the
 * extras (empty delta is the neutral keep-alive element, EVENT_SCHEMA
 * §4.3/§4.5 — it adds no text). Only a continuation chunk with neither
 * delta, metadata nor extras produces nothing, because there is nothing
 * to preserve. Synthetic END events carry no extras: no chunk produced
 * them, and they close the lane rather than describe a chunk.
 *
 * T003 owns calling this before the Reducer; the parsers deliberately
 * return unexpanded events so sourceIndex stays 1:1 with input order.
 */
export function expandChunks(events: readonly NormalizedEvent[]): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  let textOpen: { messageId: string; lastOutIndex: number } | null = null;
  let toolOpen: { toolCallId: string; lastOutIndex: number } | null = null;

  const push = (event: AGUIEvent, transportEventId: string | null): number => {
    const index = out.length;
    out.push({ sourceIndex: index, sourceEventKey: null, transportEventId, event });
    return index;
  };

  const closeText = (): void => {
    if (textOpen) {
      push(
        { type: "TEXT_MESSAGE_END", messageId: textOpen.messageId } as AGUIEvent,
        null,
      );
      textOpen = null;
    }
  };

  const closeTool = (): void => {
    if (toolOpen) {
      push(
        { type: "TOOL_CALL_END", toolCallId: toolOpen.toolCallId } as AGUIEvent,
        null,
      );
      toolOpen = null;
    }
  };

  for (const item of events) {
    const event = item.event;
    const raw = event as unknown as Record<string, unknown>;
    const metadata = isRecord(raw["metadata"])
      ? (raw["metadata"] as Record<string, unknown>)
      : undefined;

    if (event.type === "TEXT_MESSAGE_CHUNK") {
      const messageId = raw["messageId"] as string | undefined;
      const delta = raw["delta"] as string | undefined;
      const extras = chunkExtras(raw, TEXT_CHUNK_KNOWN_FIELDS);
      const hasExtras = Object.keys(extras).length > 0;
      const isFirstChunk =
        messageId !== undefined && (!textOpen || textOpen.messageId !== messageId);
      if (isFirstChunk) {
        closeText();
        // First chunk: extras (timestamp, subagentRunId, producer-added
        // fields) ride on the START — the opener carries the item's
        // descriptive fields (EVENT_SCHEMA §4.1).
        const start: Record<string, unknown> = {
          ...extras,
          type: "TEXT_MESSAGE_START",
          messageId,
        };
        if (typeof raw["role"] === "string") start["role"] = raw["role"];
        if (typeof raw["name"] === "string") start["name"] = raw["name"];
        if (metadata) start["metadata"] = metadata;
        const idx = push(start as unknown as AGUIEvent, item.transportEventId);
        textOpen = { messageId, lastOutIndex: idx };
      }
      if (textOpen === null) {
        // Unvalidated input (a first chunk without messageId). expandChunks
        // assumes validated input; pass the chunk through unchanged rather
        // than inventing an identifier.
        push(event, item.transportEventId);
        continue;
      }
      if (delta !== undefined) {
        const content: Record<string, unknown> = {
          // A continuation chunk's extras ride on the CONTENT it produces
          // (the START was already emitted); a first chunk's extras already
          // rode on its START, so they are not duplicated here.
          ...(isFirstChunk ? {} : extras),
          type: "TEXT_MESSAGE_CONTENT",
          messageId: textOpen.messageId,
          delta,
        };
        if (metadata) content["metadata"] = metadata;
        const idx = push(content as unknown as AGUIEvent, item.transportEventId);
        textOpen = { ...textOpen, lastOutIndex: idx };
      } else if (hasExtras && !isFirstChunk) {
        // Extras-only trailing chunk (no delta, no metadata): it must still
        // expand into an event, not vanish. Empty delta adds no text.
        // (A first chunk needs no such event: its START already carries the
        // extras, and duplicating them onto an empty CONTENT would add a
        // redundant event.)
        const content: Record<string, unknown> = {
          ...extras,
          type: "TEXT_MESSAGE_CONTENT",
          messageId: textOpen.messageId,
          delta: "",
        };
        if (metadata) content["metadata"] = metadata;
        const idx = push(content as unknown as AGUIEvent, item.transportEventId);
        textOpen = { ...textOpen, lastOutIndex: idx };
      } else if (metadata && textOpen) {
        // Metadata-only trailing chunk: its metadata still reaches the item.
        const prev = out[textOpen.lastOutIndex];
        if (prev) {
          const merged = mergeMetadata(
            (prev.event as unknown as Record<string, unknown>)["metadata"] as Record<string, unknown> | undefined,
            metadata,
          );
          out[textOpen.lastOutIndex] = {
            ...prev,
            event: { ...(prev.event as unknown as Record<string, unknown>), metadata: merged } as unknown as AGUIEvent,
          };
        }
      }
      continue;
    }

    if (event.type === "TOOL_CALL_CHUNK") {
      const toolCallId = raw["toolCallId"] as string | undefined;
      const toolCallName = raw["toolCallName"] as string | undefined;
      const delta = raw["delta"] as string | undefined;
      const extras = chunkExtras(raw, TOOL_CHUNK_KNOWN_FIELDS);
      const hasExtras = Object.keys(extras).length > 0;
      const isFirstChunk =
        toolCallId !== undefined && (!toolOpen || toolOpen.toolCallId !== toolCallId);
      if (isFirstChunk) {
        closeTool();
        // First chunk: extras (timestamp, subagentRunId, producer-added
        // fields) ride on the START by field attribution — the opener
        // carries the call's descriptive fields (EVENT_SCHEMA §4.1/§5.1).
        // `delta` belongs to ARGS, never to START.
        const start: Record<string, unknown> = {
          ...extras,
          type: "TOOL_CALL_START",
          toolCallId,
        };
        // Validated input always carries toolCallName on a first chunk;
        // only copy it when present so nothing is invented here.
        if (typeof toolCallName === "string") start["toolCallName"] = toolCallName;
        if (typeof raw["parentMessageId"] === "string") start["parentMessageId"] = raw["parentMessageId"];
        if (metadata) start["metadata"] = metadata;
        const idx = push(start as unknown as AGUIEvent, item.transportEventId);
        toolOpen = { toolCallId, lastOutIndex: idx };
      }
      if (toolOpen === null) {
        push(event, item.transportEventId);
        continue;
      }
      if (delta !== undefined) {
        const args: Record<string, unknown> = {
          // A continuation chunk's extras ride on the ARGS it produces;
          // a first chunk's extras already rode on its START.
          ...(isFirstChunk ? {} : extras),
          type: "TOOL_CALL_ARGS",
          toolCallId: toolOpen.toolCallId,
          delta,
        };
        if (metadata) args["metadata"] = metadata;
        const idx = push(args as unknown as AGUIEvent, item.transportEventId);
        toolOpen = { ...toolOpen, lastOutIndex: idx };
      } else if (hasExtras && !isFirstChunk) {
        // Extras-only trailing chunk (no delta, no metadata): it must still
        // expand into an event, not vanish. Empty delta adds no args text.
        // (A first chunk needs no such event: its START already carries the
        // extras.)
        const args: Record<string, unknown> = {
          ...extras,
          type: "TOOL_CALL_ARGS",
          toolCallId: toolOpen.toolCallId,
          delta: "",
        };
        if (metadata) args["metadata"] = metadata;
        const idx = push(args as unknown as AGUIEvent, item.transportEventId);
        toolOpen = { ...toolOpen, lastOutIndex: idx };
      } else if (metadata && toolOpen) {
        const prev = out[toolOpen.lastOutIndex];
        if (prev) {
          const merged = mergeMetadata(
            (prev.event as unknown as Record<string, unknown>)["metadata"] as Record<string, unknown> | undefined,
            metadata,
          );
          out[toolOpen.lastOutIndex] = {
            ...prev,
            event: { ...(prev.event as unknown as Record<string, unknown>), metadata: merged } as unknown as AGUIEvent,
          };
        }
      }
      continue;
    }

    if (
      event.type === "RUN_STARTED" ||
      event.type === "RUN_FINISHED" ||
      event.type === "RUN_ERROR" ||
      event.type === "MESSAGES_SNAPSHOT"
    ) {
      closeText();
      closeTool();
    } else if (
      event.type === "TEXT_MESSAGE_START" ||
      event.type === "TEXT_MESSAGE_CONTENT" ||
      event.type === "TEXT_MESSAGE_END"
    ) {
      closeText();
    } else if (
      event.type === "TOOL_CALL_START" ||
      event.type === "TOOL_CALL_ARGS" ||
      event.type === "TOOL_CALL_END" ||
      event.type === "TOOL_CALL_RESULT"
    ) {
      closeTool();
    }
    push(event, item.transportEventId);
  }

  closeText();
  closeTool();
  return out;
}

export { MVP_EVENT_TYPES, isMvpEventType };
