/**
 * P031 RejoinLab — T003: state snapshots, JSON Patch, message reconciliation.
 *
 * Frozen sources:
 * - PROJECT_BOOK §3.15–§3.17, §5.7 (snapshot/delta/message-snapshot rules).
 * - EVENT_SCHEMA §6.1–§6.3 (complete replacement; RFC 6902 atomicity;
 *   unknown op discarded with a warning, run continues; test failure =
 *   patch not applied; four reconciliation rules + per-role self-revoking).
 * - PROJECT_BOOK §4.4 (RecoveryCheckpoint; `capturedState` added back by
 *   T003 once RejoinState was frozen — see src/protocol/types.ts).
 *
 * JSON Patch (RFC 6902) implementation notes:
 * - Application is ATOMIC: ops apply to a deep clone; any failure of a
 *   known op discards the whole patch and the prior value is kept
 *   (EVENT_SCHEMA §6.2). The failure is recorded as a SNAPSHOT_MISMATCH
 *   diagnostic — never disguised as success.
 * - An op naming an operation RFC 6902 does not define is NOT malformed:
 *   it is discarded with a WARNING diagnostic and the run continues
 *   (§6.2). Only structurally malformed patches are INVALID_INPUT, and
 *   those are rejected by T002 before they reach this module.
 * - Pointers follow RFC 6901: "" addresses the whole document, "~1" is
 *   "/", "~0" is "~". Array "add" accepts index == length (append) and
 *   "-" (append); any other out-of-range index fails the patch.
 * - `test` compares with deep JSON equality (see state.ts jsonDeepEqual).
 * - No time, no randomness, no input mutation: the document is cloned
 *   before patching and the input patch array is never modified.
 */

import type {
  AGUIMessage,
  JsonPatch,
  JsonPatchOperation,
  JsonValue,
} from "../protocol/types.js";
import type {
  MessageState,
  ReducerDiagnostic,
  RejoinState,
  ToolCallState,
} from "./state.js";
import {
  cloneJsonValue,
  cloneState,
  jsonDeepEqual,
  messageStateToAGUI,
  segmentsForContent,
} from "./state.js";
import { addDiagnostic, computePendingToolCallIds } from "./lifecycle.js";

// ---------------------------------------------------------------------------
// RFC 6902 JSON Patch
// ---------------------------------------------------------------------------

export type PatchFailureReason =
  | "MISSING_PATH"
  | "INVALID_INDEX"
  | "INVALID_POINTER"
  | "TEST_FAILED"
  | "MOVE_INTO_CHILD"
  | "NOT_AN_OBJECT_OR_ARRAY";

export interface PatchApplyResult {
  readonly ok: boolean;
  /** New document when ok; the ORIGINAL document when not ok. */
  readonly value: unknown;
  readonly failedOpIndex?: number;
  readonly reason?: PatchFailureReason;
  readonly detail?: string;
  /** Unknown ops that were discarded (with their indices). */
  readonly discardedUnknownOps: readonly { readonly index: number; readonly op: string }[];
}

/** Unescape one RFC 6901 reference token. */
function unescapeToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Split a JSON Pointer into tokens. "" -> [] (whole document). */
function parsePointer(pointer: string): { ok: true; tokens: string[] } | { ok: false } {
  if (pointer === "") return { ok: true, tokens: [] };
  if (!pointer.startsWith("/")) return { ok: false };
  return { ok: true, tokens: pointer.slice(1).split("/").map(unescapeToken) };
}

function isArrayIndex(token: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(token);
}

interface ResolvedParent {
  readonly parent: Record<string, unknown> | unknown[];
  readonly key: string;
}

/** Resolve all but the last token. Fails when an intermediate is missing or scalar. */
function resolveParent(
  doc: unknown,
  tokens: readonly string[],
): { ok: true; resolved: ResolvedParent } | { ok: false; reason: PatchFailureReason; detail: string } {
  let current: unknown = doc;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const token = tokens[i] as string;
    if (Array.isArray(current)) {
      if (!isArrayIndex(token)) {
        return { ok: false, reason: "INVALID_INDEX", detail: `array index "${token}" is not a non-negative integer` };
      }
      const index = Number(token);
      if (index >= current.length) {
        return { ok: false, reason: "MISSING_PATH", detail: `array index ${index} does not exist` };
      }
      current = current[index];
    } else if (typeof current === "object" && current !== null) {
      const obj = current as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(obj, token)) {
        return { ok: false, reason: "MISSING_PATH", detail: `object key "${token}" does not exist` };
      }
      current = obj[token];
    } else {
      return { ok: false, reason: "NOT_AN_OBJECT_OR_ARRAY", detail: `cannot descend into a scalar at "${token}"` };
    }
  }
  const key = tokens[tokens.length - 1] as string;
  if (Array.isArray(current) || (typeof current === "object" && current !== null)) {
    return { ok: true, resolved: { parent: current as Record<string, unknown> | unknown[], key } };
  }
  return { ok: false, reason: "NOT_AN_OBJECT_OR_ARRAY", detail: "parent is a scalar value" };
}

/** Read the value at a pointer. Used by move/copy/test. */
function readAt(
  doc: unknown,
  tokens: readonly string[],
): { ok: true; value: unknown } | { ok: false; reason: PatchFailureReason; detail: string } {
  if (tokens.length === 0) return { ok: true, value: doc };
  const parent = resolveParent(doc, tokens);
  if (!parent.ok) return parent;
  const { parent: container, key } = parent.resolved;
  if (Array.isArray(container)) {
    if (!isArrayIndex(key)) {
      return { ok: false, reason: "INVALID_INDEX", detail: `array index "${key}" is not a non-negative integer` };
    }
    const index = Number(key);
    if (index >= container.length) {
      return { ok: false, reason: "MISSING_PATH", detail: `array index ${index} does not exist` };
    }
    return { ok: true, value: container[index] };
  }
  const obj = container as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    return { ok: false, reason: "MISSING_PATH", detail: `object key "${key}" does not exist` };
  }
  return { ok: true, value: obj[key] };
}

function applyAdd(
  doc: unknown,
  tokens: readonly string[],
  value: JsonValue,
): { ok: true; doc: unknown } | { ok: false; reason: PatchFailureReason; detail: string } {
  if (tokens.length === 0) return { ok: true, doc: cloneJsonValue(value) };
  const parent = resolveParent(doc, tokens);
  if (!parent.ok) return parent;
  const { parent: container, key } = parent.resolved;
  if (Array.isArray(container)) {
    if (key === "-") {
      container.push(cloneJsonValue(value));
      return { ok: true, doc };
    }
    if (!isArrayIndex(key)) {
      return { ok: false, reason: "INVALID_INDEX", detail: `array index "${key}" is not a non-negative integer` };
    }
    const index = Number(key);
    if (index > container.length) {
      return { ok: false, reason: "INVALID_INDEX", detail: `array index ${index} is beyond the end (${container.length})` };
    }
    container.splice(index, 0, cloneJsonValue(value));
    return { ok: true, doc };
  }
  (container as Record<string, unknown>)[key] = cloneJsonValue(value);
  return { ok: true, doc };
}

function applyRemove(
  doc: unknown,
  tokens: readonly string[],
): { ok: true; doc: unknown; removed: unknown } | { ok: false; reason: PatchFailureReason; detail: string } {
  if (tokens.length === 0) {
    return { ok: false, reason: "INVALID_POINTER", detail: "cannot remove the whole document" };
  }
  const parent = resolveParent(doc, tokens);
  if (!parent.ok) return parent;
  const { parent: container, key } = parent.resolved;
  if (Array.isArray(container)) {
    if (!isArrayIndex(key)) {
      return { ok: false, reason: "INVALID_INDEX", detail: `array index "${key}" is not a non-negative integer` };
    }
    const index = Number(key);
    if (index >= container.length) {
      return { ok: false, reason: "MISSING_PATH", detail: `array index ${index} does not exist` };
    }
    const [removed] = container.splice(index, 1);
    return { ok: true, doc, removed };
  }
  const obj = container as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    return { ok: false, reason: "MISSING_PATH", detail: `object key "${key}" does not exist` };
  }
  const removed = obj[key];
  delete obj[key];
  return { ok: true, doc, removed };
}

const KNOWN_OPS: ReadonlySet<string> = new Set(["add", "remove", "replace", "move", "copy", "test"]);

/**
 * Apply an RFC 6902 patch to a document, atomically. The input document is
 * never mutated; on failure the returned `value` IS the original document.
 * Unknown ops are discarded (listed in `discardedUnknownOps`) and do NOT
 * fail the patch.
 */
export function applyJsonPatch(doc: unknown, patch: JsonPatch): PatchApplyResult {
  const discardedUnknownOps: { index: number; op: string }[] = [];
  let working: unknown = cloneJsonValue(doc);
  for (let i = 0; i < patch.length; i += 1) {
    const operation = patch[i] as JsonPatchOperation;
    const opName = (operation as { readonly op: string }).op;
    if (!KNOWN_OPS.has(opName)) {
      discardedUnknownOps.push({ index: i, op: opName });
      continue;
    }
    const path = (operation as { readonly path: string }).path;
    const parsed = parsePointer(path);
    if (!parsed.ok) {
      return { ok: false, value: doc, failedOpIndex: i, reason: "INVALID_POINTER", detail: `path ${JSON.stringify(path)} is not a valid JSON Pointer`, discardedUnknownOps };
    }
    const tokens = parsed.tokens;
    if (opName === "add") {
      const result = applyAdd(working, tokens, (operation as { readonly value: JsonValue }).value);
      if (!result.ok) {
        return { ok: false, value: doc, failedOpIndex: i, reason: result.reason, detail: result.detail, discardedUnknownOps };
      }
      working = result.doc;
    } else if (opName === "remove") {
      const result = applyRemove(working, tokens);
      if (!result.ok) {
        return { ok: false, value: doc, failedOpIndex: i, reason: result.reason, detail: result.detail, discardedUnknownOps };
      }
      working = result.doc;
    } else if (opName === "replace") {
      // Replace = target must exist, then set. Implemented as remove+add
      // on the working copy, but a failed add after a successful remove
      // must still fail the whole patch (atomicity is preserved because
      // the caller keeps the original `doc` on any failure).
      const existing = readAt(working, tokens);
      if (!existing.ok) {
        return { ok: false, value: doc, failedOpIndex: i, reason: existing.reason, detail: existing.detail, discardedUnknownOps };
      }
      if (tokens.length === 0) {
        working = cloneJsonValue((operation as { readonly value: JsonValue }).value);
      } else {
        const removed = applyRemove(working, tokens);
        if (!removed.ok) {
          return { ok: false, value: doc, failedOpIndex: i, reason: removed.reason, detail: removed.detail, discardedUnknownOps };
        }
        const added = applyAdd(working, tokens, (operation as { readonly value: JsonValue }).value);
        if (!added.ok) {
          return { ok: false, value: doc, failedOpIndex: i, reason: added.reason, detail: added.detail, discardedUnknownOps };
        }
        working = added.doc;
      }
    } else if (opName === "move") {
      const from = (operation as { readonly from: string }).from;
      const fromParsed = parsePointer(from);
      if (!fromParsed.ok) {
        return { ok: false, value: doc, failedOpIndex: i, reason: "INVALID_POINTER", detail: `from ${JSON.stringify(from)} is not a valid JSON Pointer`, discardedUnknownOps };
      }
      const fromTokens = fromParsed.tokens;
      if (
        tokens.length > fromTokens.length &&
        tokens.slice(0, fromTokens.length).every((t, j) => t === fromTokens[j])
      ) {
        return { ok: false, value: doc, failedOpIndex: i, reason: "MOVE_INTO_CHILD", detail: `cannot move ${JSON.stringify(from)} into its own child ${JSON.stringify(path)}`, discardedUnknownOps };
      }
      const removed = applyRemove(working, fromTokens);
      if (!removed.ok) {
        return { ok: false, value: doc, failedOpIndex: i, reason: removed.reason, detail: removed.detail, discardedUnknownOps };
      }
      const added = applyAdd(working, tokens, cloneJsonValue(removed.removed) as JsonValue);
      if (!added.ok) {
        return { ok: false, value: doc, failedOpIndex: i, reason: added.reason, detail: added.detail, discardedUnknownOps };
      }
      working = added.doc;
    } else if (opName === "copy") {
      const from = (operation as { readonly from: string }).from;
      const fromParsed = parsePointer(from);
      if (!fromParsed.ok) {
        return { ok: false, value: doc, failedOpIndex: i, reason: "INVALID_POINTER", detail: `from ${JSON.stringify(from)} is not a valid JSON Pointer`, discardedUnknownOps };
      }
      const source = readAt(working, fromParsed.tokens);
      if (!source.ok) {
        return { ok: false, value: doc, failedOpIndex: i, reason: source.reason, detail: source.detail, discardedUnknownOps };
      }
      const added = applyAdd(working, tokens, cloneJsonValue(source.value) as JsonValue);
      if (!added.ok) {
        return { ok: false, value: doc, failedOpIndex: i, reason: added.reason, detail: added.detail, discardedUnknownOps };
      }
      working = added.doc;
    } else if (opName === "test") {
      const actual = readAt(working, tokens);
      if (!actual.ok) {
        return { ok: false, value: doc, failedOpIndex: i, reason: actual.reason, detail: actual.detail, discardedUnknownOps };
      }
      if (!jsonDeepEqual(actual.value, (operation as { readonly value: JsonValue }).value)) {
        return {
          ok: false,
          value: doc,
          failedOpIndex: i,
          reason: "TEST_FAILED",
          detail: `test at ${JSON.stringify(path)} failed: expected ${JSON.stringify((operation as { readonly value: JsonValue }).value)}, got ${JSON.stringify(actual.value)}`,
          discardedUnknownOps,
        };
      }
    }
  }
  return { ok: true, value: working, discardedUnknownOps };
}

// ---------------------------------------------------------------------------
// STATE_SNAPSHOT / STATE_DELTA
// ---------------------------------------------------------------------------

/**
 * STATE_SNAPSHOT: complete replacement of the shared state, never a deep
 * merge (PROJECT_BOOK §3.15). The snapshot becomes the new baseline, so
 * all earlier deltas are obsolete by construction. Returns a new state.
 */
export function applyStateSnapshot(state: RejoinState, snapshot: JsonValue): RejoinState {
  return { ...state, sharedState: cloneJsonValue(snapshot) };
}

/**
 * STATE_DELTA: apply an RFC 6902 patch in order, atomically, against the
 * current shared state.
 * - No baseline yet (sharedState undefined): SNAPSHOT_MISMATCH diagnostic,
 *   state unchanged (EVENT_SCHEMA §6.2: a producer must not send a delta
 *   without giving the consumer a baseline).
 * - Patch cannot apply: SNAPSHOT_MISMATCH diagnostic (CRITICAL), prior
 *   value kept, run continues (§6.2: "must surface the failure ... may
 *   keep the prior value and continue the run").
 * - Unknown op(s): discarded with a WARNING diagnostic each; the rest of
 *   the patch still applies and the run continues (§6.2).
 * - Empty patch: legal no-op.
 */
export function applyStateDelta(state: RejoinState, delta: JsonPatch): RejoinState {
  if (state.sharedState === undefined) {
    return addDiagnostic(state, {
      code: "SNAPSHOT_MISMATCH",
      severity: "CRITICAL",
      message:
        `STATE_DELTA arrived with no shared-state baseline (no RUN_STARTED input.state ` +
        `and no STATE_SNAPSHOT yet); the delta is not applied and the state stays unset ` +
        `(EVENT_SCHEMA §6.2: a producer must not send a delta without a baseline).`,
      eventType: "STATE_DELTA",
    });
  }
  const result = applyJsonPatch(state.sharedState, delta);
  let next: RejoinState = state;
  for (const discarded of result.discardedUnknownOps) {
    next = addDiagnostic(next, {
      code: "UNKNOWN_PATCH_OP",
      severity: "WARNING",
      message:
        `STATE_DELTA op #${discarded.index} names unknown operation ${JSON.stringify(discarded.op)}; ` +
        `the element is discarded and the run continues (EVENT_SCHEMA §6.2).`,
      eventType: "STATE_DELTA",
    });
  }
  if (!result.ok) {
    return addDiagnostic(next, {
      code: "SNAPSHOT_MISMATCH",
      severity: "CRITICAL",
      message:
        `STATE_DELTA could not be applied (op #${result.failedOpIndex ?? "?"}: ` +
        `${result.reason ?? "UNKNOWN"}${result.detail !== undefined ? ` — ${result.detail}` : ""}); ` +
        `the patch is discarded atomically and the prior shared state is kept (EVENT_SCHEMA §6.2).`,
      eventType: "STATE_DELTA",
    });
  }
  return { ...next, sharedState: result.value };
}

// ---------------------------------------------------------------------------
// MESSAGES_SNAPSHOT reconciliation (PROJECT_BOOK §3.17, EVENT_SCHEMA §6.3)
// ---------------------------------------------------------------------------

/** Build a MessageState from a snapshot AGUIMessage (producer-owned, closed). */
export function snapshotMessageToState(message: AGUIMessage): MessageState {
  const base: MessageState = {
    id: message.id,
    role: message.role,
    ...(message.name !== undefined ? { name: message.name } : {}),
    content:
      message.content !== undefined
        ? (cloneJsonValue(message.content) as MessageState["content"])
        : "",
    // A snapshot message is built from whole content: a SINGLE segment
    // (Oracle `_snapshot_message_to_state`). A streamed message that had
    // two segments collapses to one here — the merge the G03 check
    // detects (FIX-T003-G03). ContentPart[] content yields an empty
    // single segment, matching the Oracle rule.
    segments: segmentsForContent(message.content),
    status: "closed",
    owner: "producer",
  };
  if (message.role === "assistant" && "toolCalls" in message && message.toolCalls !== undefined) {
    return { ...base, toolCalls: cloneJsonValue(message.toolCalls) as MessageState["toolCalls"] };
  }
  if (message.role === "tool") {
    return {
      ...base,
      toolCallId: message.toolCallId,
      ...(message.error !== undefined ? { error: message.error } : {}),
    };
  }
  return base;
}

/**
 * Reconcile state.messages against a MESSAGES_SNAPSHOT. NOT a wholesale
 * overwrite (`messages = snapshot.messages` is the wrong implementation,
 * §6.3). Rules, in order:
 * 1. Same id in the snapshot: REPLACE in place (position kept).
 * 2. New id in the snapshot: APPEND, in snapshot order.
 * 3. Producer-owned old message absent from the snapshot: REMOVE.
 * 4. Client-only activity/reasoning messages are KEPT, unless the
 *    snapshot itself carries any message of that role — then the exception
 *    is per-role self-revoking: absent messages of that role are dropped
 *    like anything else (official prose, §6.3).
 * Messages still "open" when a snapshot arrives are treated as
 * producer-owned stream state: if the snapshot carries the same id they
 * are replaced (and closed); if absent they are removed — a snapshot is
 * the producer's declaration of the complete set, and an open streamed
 * message the producer no longer lists is not client-owned.
 * Snapshot toolCalls are synced into toolCalls: a snapshot assistant
 * message naming a call this trace never saw creates a "closed" entry
 * (args complete as given, no result yet); existing entries are left
 * untouched so streamed lifecycle state is never clobbered.
 */
export function reconcileMessagesSnapshot(
  state: RejoinState,
  messages: readonly AGUIMessage[],
): RejoinState {
  const snapshotIds = new Set(messages.map((m) => m.id));
  const snapshotRoles = new Set<string>(messages.map((m) => m.role));
  const snapshotById = new Map(messages.map((m) => [m.id, m]));

  const nextMessages: MessageState[] = [];
  for (const existing of state.messages) {
    if (snapshotIds.has(existing.id)) {
      const snap = snapshotById.get(existing.id) as AGUIMessage;
      nextMessages.push(snapshotMessageToState(snap));
      continue;
    }
    // Absent from the snapshot: keep only client-only activity/reasoning
    // whose role the snapshot does NOT declare (rule 4).
    if (
      existing.owner === "client" &&
      (existing.role === "activity" || existing.role === "reasoning") &&
      !snapshotRoles.has(existing.role)
    ) {
      nextMessages.push(existing);
      continue;
    }
    // Otherwise producer-owned (or a role the snapshot now declares):
    // removed. No diagnostic is recorded: removal is the snapshot's
    // declared semantics, not an error.
  }
  // Append snapshot messages that are new, in snapshot order (rule 2).
  for (const snap of messages) {
    if (!state.messages.some((m) => m.id === snap.id)) {
      nextMessages.push(snapshotMessageToState(snap));
    }
  }

  let next: RejoinState = { ...state, messages: nextMessages };
  // Sync snapshot toolCalls into toolCalls (create-only, never clobber).
  for (const snap of messages) {
    if (snap.role !== "assistant" || !("toolCalls" in snap) || snap.toolCalls === undefined) {
      continue;
    }
    for (const call of snap.toolCalls) {
      if (next.toolCalls.some((t) => t.id === call.id)) continue;
      const created: ToolCallState = {
        id: call.id,
        name: call.function.name,
        ...(snap.id !== undefined ? { parentMessageId: snap.id } : {}),
        arguments: call.function.arguments,
        status: "closed",
        hasResult: false,
        runId: null,
      };
      next = { ...next, toolCalls: [...next.toolCalls, created] };
    }
  }
  return { ...next, pendingToolCallIds: computePendingToolCallIds(next) };
}

// ---------------------------------------------------------------------------
// Recovery checkpoints (PROJECT_BOOK §4.4)
// ---------------------------------------------------------------------------

export interface CheckpointCoverage {
  readonly sharedState: boolean;
  readonly messages: boolean;
}

/**
 * Build a RecoveryCheckpoint from a state value. `capturedState` is a full
 * deep clone of the state (the field T003 adds back to RecoveryCheckpoint
 * once RejoinState is frozen — EVENT_SCHEMA §8 D-05). `sourceIndex` is the
 * expanded-sequence index of the last applied event (downstream cursors
 * always use post-expansion indices). Coverage is caller-declared: only
 * the dimensions the checkpoint actually covers are snapshotted.
 */
export function makeCheckpoint(
  state: RejoinState,
  sourceIndex: number,
  coverage: CheckpointCoverage,
): import("../protocol/types.js").RecoveryCheckpoint {
  return {
    threadId: state.threadId ?? "",
    sourceIndex,
    ...(coverage.sharedState
      ? { stateSnapshot: cloneJsonValue(state.sharedState) as JsonValue }
      : {}),
    ...(coverage.messages
      ? { messagesSnapshot: state.messages.map((m) => messageStateToAGUI(m)) }
      : {}),
    capturedState: cloneState(state),
    coverage: { sharedState: coverage.sharedState, messages: coverage.messages },
  };
}

/** Re-export for callers that need the diagnostic type only. */
export type { ReducerDiagnostic };
