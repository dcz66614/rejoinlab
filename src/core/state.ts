/**
 * P031 RejoinLab — T003: deterministic reference Reducer state.
 *
 * Frozen sources:
 * - PROJECT_BOOK.md v1.0.0 §5.1 (RejoinState shape), §5.4–§5.7 (lifecycle
 *   and ordering invariants), §6 (diagnostic codes and severities).
 * - IMPLEMENTATION_PLAN.md v1.0.0 §5.3 (RejoinState), §5.4 (reduceEvent
 *   purity contract: no external state, no randomness, no time reads, no
 *   network, no input mutation, same input -> same output).
 * - docs/EVENT_SCHEMA.md §3–§6 (per-event semantics), §6.2 (STATE_DELTA
 *   atomicity / unknown-op discard-with-warning), §6.3 (MESSAGES_SNAPSHOT
 *   reconciliation), §5.5 (TOOL_CALL_RESULT lifecycle correction).
 * - docs/AGUI_SCOPE.md §4 (identifier boundaries; no eventId).
 *
 * T003 extensions, documented (not silent):
 * 1. `RejoinState.diagnostics` is an ADDITIONAL field beyond the eight
 *    fields listed in IMPLEMENTATION_PLAN §5.3. The plan's eight fields are
 *    all present with the specified names and types; `diagnostics` holds
 *    the Reducer's non-fatal findings (RUN_ERROR, unclosed items at run
 *    end, STATE_DELTA that cannot apply, unknown patch ops, input.state
 *    baseline conflicts). It is local Reducer bookkeeping, NOT protocol
 *    state: T004's canon MUST exclude it (PROJECT_BOOK §5.3 already
 *    excludes local run metadata), and T006's Oracle parity compares the
 *    eight protocol fields. Without this field the Reducer could not obey
 *    EVENT_SCHEMA §6.2 ("record SNAPSHOT_MISMATCH ... must surface the
 *    failure, never swallow it silently") while keeping the §5.4
 *    `reduceEvent(state, event): RejoinState` signature, which has no
 *    diagnostics return channel. Hard protocol violations (CONTENT for a
 *    never-opened message, ARGS for a never-opened call, duplicate START
 *    while open, reopen with mismatched role/name/tool, second result for
 *    one logical execution, RUN_FINISHED for a run that is not open) are
 *    NOT recorded here — they throw `ReducerError` (see reducer.ts), so
 *    they can never be silently accepted either.
 * 2. Open/closed tracking lives ON the state entries themselves
 *    (`MessageState.status`, `ToolCallState.status`), never in a side
 *    table, so the state stays self-contained and deterministic: folding
 *    the same event sequence from `initialState()` always yields the same
 *    state, and a state value alone is enough to resume reduction.
 * 3. `MessageState.content` is `string | readonly ContentPart[]`:
 *    streamed text accumulates as a plain string; snapshot messages keep
 *    their original content shape (string or parts) verbatim.
 *    `content` is the DERIVED / compatibility view of the message text:
 *    for a streamed string message it is always the concatenation of
 *    `segments` (see below); it is kept as a field because the frozen
 *    T003 shape and every existing consumer read it, and because a
 *    snapshot message may carry ContentPart[] content that has no
 *    single string form.
 * 4. `MessageState.segments` (FIX-T003-G03) records TEXT segment
 *    boundaries, mirroring the Oracle message model
 *    (oracle/reference.py `_new_message` / TEXT_MESSAGE_START reopen /
 *    TEXT_MESSAGE_CONTENT): a TEXT_MESSAGE_START opens a new segment
 *    `{"text": ""}` (a legal reopen APPENDS one, it never merges into
 *    the previous segment); a TEXT_MESSAGE_CONTENT appends its delta
 *    to the LAST segment only. A snapshot / tool-result message holds
 *    exactly ONE segment whose text is its string content ("" when the
 *    content is a ContentPart[] array) — i.e. a snapshot COLLAPSES
 *    whatever segments the streamed message had into one, which is
 *    precisely the G03 fault (PROJECT_BOOK §5.6: when the target
 *    message projection cannot express the interleave, MESSAGE_REORDER
 *    must be reported). Without segments, two segments merged into one
 *    are state-identical to the full path (same `content` string) and
 *    no comparison layer can observe the loss. `segments` is a
 *    verbatim sub-field of the canonical state projection
 *    (src/core/canonical.ts `projectState`), so it enters the state
 *    hash; `content` alone must never be used as the segment signal.
 * 5. No timestamps, no random ids, no `Date`, no `Math.random` anywhere
 *    in this module. Identifiers are always copied from the events.
 */

import type {
  AGUIMessage,
  ContentPart,
  JsonValue,
  MessageRole,
  RunFinishedOutcome,
  ToolCall,
} from "../protocol/types.js";

/** PROJECT_BOOK §5.1. */
export type RunStatus =
  | "NOT_STARTED"
  | "RUNNING"
  | "FINISHED"
  | "ERROR"
  | "CANCELLED";

/**
 * One run inside a thread. `status` mirrors the run's own lifecycle; the
 * thread-level `RejoinState.runStatus` is the status of the most recent
 * run (or NOT_STARTED before any run). `outcome` is the RUN_FINISHED
 * outcome as received (absent = success); `error` is the RUN_ERROR payload
 * that ended the run, when one did.
 */
export interface RunState {
  readonly runId: string;
  readonly threadId: string;
  readonly status: "RUNNING" | "FINISHED" | "ERROR" | "CANCELLED";
  readonly parentRunId?: string;
  readonly protocolVersion?: string;
  /** RUN_FINISHED outcome; undefined when the run ended without one. */
  readonly outcome?: RunFinishedOutcome;
  /** RUN_FINISHED `result`, when present. */
  readonly result?: JsonValue;
  /** RUN_ERROR payload that ended this run, when one did. */
  readonly error?: { readonly message: string; readonly code?: string };
}

/**
 * One TEXT segment of a message (Oracle parity: oracle/reference.py
 * `_new_message` creates `segments: [{"text": ""}]`; a reopen appends
 * `{"text": ""}`; CONTENT appends to the last segment; a snapshot /
 * tool-result message holds a single segment with its string content).
 * `content` (below) is the concatenation of these texts for a streamed
 * string message; `segments` is what preserves the boundaries.
 */
export interface MessageSegment {
  readonly text: string;
}

/**
 * One message in the conversation.
 *
 * `segments` (FIX-T003-G03): TEXT segment boundaries, in order. See the
 * module header, point 4. Every MessageState carries exactly the
 * segments its history produced — never synthesised, never merged,
 * except by a snapshot / tool-result construction, which by Oracle
 * semantics holds a single segment (the merge that G03 detects).
 *
 * `status`:
 * - "open": a TEXT_MESSAGE_START (or chunk expansion) opened it and no
 *   TEXT_MESSAGE_END has closed it yet. CONTENT may only target "open".
 * - "closed": ended by TEXT_MESSAGE_END, created by TOOL_CALL_RESULT, or
 *   installed by MESSAGES_SNAPSHOT / RUN_STARTED input seeding.
 * - "incomplete": the run ended (RUN_FINISHED / RUN_ERROR) while it was
 *   still open. It stays in the state as evidence; it is NOT silently
 *   dropped and NOT auto-closed as if it had ended cleanly.
 *
 * `owner`: "producer" for everything that arrived on the event stream or
 * in a producer snapshot; "client" is reserved for client-only
 * activity/reasoning messages (MESSAGES_SNAPSHOT rule 4). Streamed and
 * snapshot messages are producer-owned; client-only entries can only enter
 * via RUN_STARTED input seeding (input messages the producer does not
 * track) and are then kept across snapshots unless the snapshot itself
 * declares that role's complete set (see snapshot.ts).
 */
export interface MessageState {
  readonly id: string;
  readonly role: MessageRole;
  readonly name?: string;
  readonly content: string | readonly ContentPart[];
  /** TEXT segment boundaries, in order (see MessageSegment). */
  readonly segments: readonly MessageSegment[];
  readonly toolCalls?: readonly ToolCall[];
  /** Tool-role messages only: the call this message answers. */
  readonly toolCallId?: string;
  /** Tool-role messages only: producer-reported error flag. */
  readonly error?: boolean;
  readonly status: "open" | "closed" | "incomplete";
  readonly owner: "producer" | "client";
}

/**
 * One tool call.
 *
 * `status`:
 * - "open": TOOL_CALL_START seen, TOOL_CALL_END not yet seen. ARGS may
 *   only target "open".
 * - "closed": TOOL_CALL_END seen, no result yet. This is the pending
 *   state: the call appears in `pendingToolCallIds` until a result lands.
 * - "resulted": a TOOL_CALL_RESULT (same run or a later run's input /
 *   TOOL_CALL_RESULT) answered this logical execution.
 * - "incomplete": the run ended (RUN_FINISHED / RUN_ERROR) while it was
 *   still "open". It is NOT in `pendingToolCallIds` (pending means args
 *   complete, result outstanding — §3.14) and NOT given a fake result.
 *
 * `hasResult` is tracked separately from `status` because a call that is
 * legally reopened (same toolCallId, same name/parent — PROJECT_BOOK
 * §3.12) starts a NEW logical execution: `hasResult` resets to false
 * while `arguments` keeps appending in arrival order (§5.5: parameter
 * fragments splice in event order). "One result per logical execution"
 * is enforced on the current execution only.
 */
export interface ToolCallState {
  readonly id: string;
  readonly name: string;
  readonly parentMessageId?: string;
  /** Parameter text, spliced in arrival order; never parsed as JSON here. */
  readonly arguments: string;
  readonly status: "open" | "closed" | "resulted" | "incomplete";
  readonly hasResult: boolean;
  /** messageId of the TOOL_CALL_RESULT / input tool message, when any. */
  readonly resultMessageId?: string;
  /** Result content as received, when any. */
  readonly resultContent?: string | readonly ContentPart[];
  /** runId of the run that (re)opened this logical execution. */
  readonly runId: string | null;
}

/**
 * One entry of the presentation-order timeline. Every reduced (expanded)
 * event appends exactly one entry, in arrival order, so interleaving is
 * preserved verbatim: TEXT_A / TOOL_CALL_* / TEXT_B must NEVER collapse
 * to TEXT_AB / TOOL_CALL_* (PROJECT_BOOK §5.6, G03). `text` carries the
 * delta for CONTENT / ARGS entries so the interleave is checkable without
 * re-reading the event stream.
 */
export interface TimelineItem {
  readonly kind: "run" | "message" | "tool-call" | "state" | "messages-snapshot";
  /** The expanded event type that produced this entry. */
  readonly eventType:
    | "RUN_STARTED"
    | "RUN_FINISHED"
    | "RUN_ERROR"
    | "TEXT_MESSAGE_START"
    | "TEXT_MESSAGE_CONTENT"
    | "TEXT_MESSAGE_END"
    | "TOOL_CALL_START"
    | "TOOL_CALL_ARGS"
    | "TOOL_CALL_END"
    | "TOOL_CALL_RESULT"
    | "STATE_SNAPSHOT"
    | "STATE_DELTA"
    | "MESSAGES_SNAPSHOT";
  readonly messageId?: string;
  readonly toolCallId?: string;
  readonly runId?: string;
  /** delta text for TEXT_MESSAGE_CONTENT / TOOL_CALL_ARGS entries. */
  readonly text?: string;
}

/** Severity vocabulary: PROJECT_BOOK §6.1 (CRITICAL proves a reproducible
 * inconsistency; WARNING is risk / insufficient evidence). */
export type DiagnosticSeverity = "CRITICAL" | "WARNING";

/**
 * A non-fatal Reducer finding. `code` uses a frozen PROJECT_BOOK §6 code
 * whenever the situation matches one (SNAPSHOT_MISMATCH, RUN_ERROR);
 * otherwise it is a T003-local code, named descriptively and documented
 * at its call site (the frozen catalog has no Reducer-layer code for
 * "run ended with items still open" or "input.state conflicts with the
 * live baseline"). In particular the Reducer NEVER emits TRUNCATED_RUN:
 * a run ending with items still open is recorded here as the T003-local
 * UNCLOSED_STREAM_ITEM (CRITICAL, one per open item, emitted by
 * markOpenItemsIncomplete in lifecycle.ts). TRUNCATED_RUN (WARNING,
 * PROJECT_BOOK §6: "the stream ended before a terminating event") is a
 * report-layer diagnostic: T005 maps it at report-assembly time from
 * whether the stream lacks a terminating event. Hard violations throw
 * ReducerError instead and never appear here.
 */
export interface ReducerDiagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly eventType?: string;
  readonly messageId?: string;
  readonly toolCallId?: string;
  readonly runId?: string;
}

/**
 * Deterministic reference state (IMPLEMENTATION_PLAN §5.3, plus the
 * T003-local `diagnostics` field documented above).
 *
 * - `threadId`: null until the first RUN_STARTED; afterwards stable for
 *   the whole trace (a second threadId is a protocol violation).
 * - `runs`: every run ever started, in start order. A RUN_ERROR before
 *   any RUN_STARTED adds NO entry (there is no runId to record).
 * - `pendingToolCallIds`: ids of calls whose args are complete
 *   (status "closed") and which have no result yet, in the order their
 *   TOOL_CALL_END arrived. Recomputed from `toolCalls` after every event
 *   that can change it, never stored from the wire (the wire's
 *   outcome.pendingToolCallIds is CHECKED against it at RUN_FINISHED,
 *   never trusted blindly).
 * - `sharedState`: unknown until a baseline exists: RUN_STARTED
 *   input.state, a STATE_SNAPSHOT, or the empty-object default when a run
 *   starts without input.state (EVENT_SCHEMA §6.2). A STATE_DELTA with no
 *   baseline is a SNAPSHOT_MISMATCH diagnostic, not an implicit `{}`.
 */
export interface RejoinState {
  readonly threadId: string | null;
  readonly runs: readonly RunState[];
  readonly messages: readonly MessageState[];
  readonly toolCalls: readonly ToolCallState[];
  readonly sharedState: unknown;
  readonly orderedTimeline: readonly TimelineItem[];
  readonly pendingToolCallIds: readonly string[];
  readonly runStatus: RunStatus;
  /** T003-local non-fatal findings (see the module header, point 1). */
  readonly diagnostics: readonly ReducerDiagnostic[];
}

/** The empty state: no thread, no runs, no baseline. */
export function initialState(): RejoinState {
  return {
    threadId: null,
    runs: [],
    messages: [],
    toolCalls: [],
    sharedState: undefined,
    orderedTimeline: [],
    pendingToolCallIds: [],
    runStatus: "NOT_STARTED",
    diagnostics: [],
  };
}

/**
 * Deep-clone a JSON value. Uses structuredClone (deterministic, no time,
 * no randomness). `undefined` passes through (it marks "no baseline yet",
 * which is distinct from the JSON value null).
 */
export function cloneJsonValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

/** Deep-clone a whole RejoinState (used for checkpoints). */
export function cloneState(state: RejoinState): RejoinState {
  return {
    threadId: state.threadId,
    runs: structuredClone(state.runs),
    messages: structuredClone(state.messages),
    toolCalls: structuredClone(state.toolCalls),
    sharedState: cloneJsonValue(state.sharedState),
    orderedTimeline: structuredClone(state.orderedTimeline),
    pendingToolCallIds: [...state.pendingToolCallIds],
    runStatus: state.runStatus,
    diagnostics: structuredClone(state.diagnostics),
  };
}

/** Deep JSON equality (objects: key order insensitive; arrays: ordered). */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!jsonDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (typeof a === "object") {
    const aObj = a as Record<string, unknown>;
    const bObj = b as Record<string, unknown>;
    const aKeys = Object.keys(aObj);
    const bKeys = Object.keys(bObj);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
      if (!jsonDeepEqual(aObj[key], bObj[key])) return false;
    }
    return true;
  }
  return false;
}

/**
 * The single-segment form of a message built from whole content
 * (Oracle `_snapshot_message_to_state` / TOOL_CALL_RESULT result
 * message): one segment holding the string content, or "" when the
 * content is a ContentPart[] array (which has no single string form).
 * Used by snapshot construction, RUN_STARTED input seeding and the
 * replay fold's tool-result message — never for streamed text, where
 * segments accumulate per START/CONTENT instead.
 */
export function segmentsForContent(
  content: unknown,
): readonly MessageSegment[] {
  return [{ text: typeof content === "string" ? content : "" }];
}


/**
 * Convert a MessageState back to its AG-UI wire shape (for checkpoints).
 * `segments` is internal Reducer state, not a wire field: the AG-UI
 * Message schema has no segments, so only `content` travels on the wire.
 * A checkpoint restored from `messagesSnapshot` alone would therefore
 * lose segment boundaries; the authoritative restore is `capturedState`
 * (a deep clone of the state, segments included), never the wire snapshot.
 */
export function messageStateToAGUI(message: MessageState): AGUIMessage {
  const base: Record<string, unknown> = {
    id: message.id,
    role: message.role,
  };
  if (message.name !== undefined) base["name"] = message.name;
  base["content"] = message.content;
  if (message.toolCalls !== undefined) base["toolCalls"] = message.toolCalls;
  if (message.toolCallId !== undefined) base["toolCallId"] = message.toolCallId;
  if (message.error !== undefined) base["error"] = message.error;
  return base as unknown as AGUIMessage;
}

/** The run currently in progress, if any. */
export function currentRun(state: RejoinState): RunState | null {
  for (let i = state.runs.length - 1; i >= 0; i -= 1) {
    const run = state.runs[i];
    if (run !== undefined && run.status === "RUNNING") return run;
  }
  return null;
}

/**
 * Thrown for hard protocol violations. Lives here (not in reducer.ts) so
 * lifecycle.ts can throw it without a lifecycle <-> reducer import cycle.
 * `code` is the machine-readable failure; `message` is human-readable
 * evidence. Callers that reduce untrusted or injected traces (T005) catch
 * ReducerError and translate its `code` into a diagnostic.
 */
export class ReducerError extends Error {
  readonly code: string;
  readonly eventType?: string;
  readonly messageId?: string;
  readonly toolCallId?: string;
  readonly runId?: string;

  constructor(
    code: string,
    message: string,
    context: {
      readonly eventType?: string;
      readonly messageId?: string;
      readonly toolCallId?: string;
      readonly runId?: string;
    } = {},
  ) {
    // The code is prefixed to the message so `toThrow(/CODE/)` and plain
    // log grepping both work; the structured `code` field stays canonical.
    super(`[${code}] ${message}`);
    this.name = "ReducerError";
    this.code = code;
    this.eventType = context.eventType;
    this.messageId = context.messageId;
    this.toolCallId = context.toolCallId;
    this.runId = context.runId;
  }
}
