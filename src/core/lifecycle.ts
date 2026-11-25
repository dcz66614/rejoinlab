/**
 * P031 RejoinLab — T003: lifecycle transitions (message / tool-call / run).
 *
 * Pure helpers used by reducer.ts. Every function takes a state and returns
 * a NEW state (or throws ReducerError for a hard protocol violation); no
 * function mutates its input, reads time, or uses randomness.
 *
 * Rules implemented (PROJECT_BOOK §5.4–§5.6, EVENT_SCHEMA §4.1/§4.5/§5.5):
 * - A message / tool call is opened by *_START, extended by CONTENT/ARGS,
 *   closed by *_END, all matched by id. Opening an already-open id throws.
 * - A closed id may be REOPENED, but only with identical owner/role/name
 *   (message) or toolCallName/parentMessageId (tool call). A legal reopen
 *   is NEVER a protocol violation (§3.8/§3.12); a reopen with different
 *   descriptive fields throws.
 * - Reopened text/args APPEND in arrival order (§5.4 "fragments connect
 *   in event arrival order", §5.5 "parameter fragments splice in event
 *   order"). This is a T003 reading of the spec — the spec never says a
 *   reopen resets accumulated content — and is flagged as a judgment call
 *   in artifacts/logs/T003_REDUCER.log. orderedTimeline keeps the
 *   interleave either way, so G03-style order checks are unaffected.
 * - TOOL_CALL_RESULT requires an existing call (open or closed) and at
 *   most one result per logical execution. A result for a call whose args
 *   are still open is accepted (the spec requires only "an existing
 *   call", §5.5); the call is marked resulted, not given a fake END.
 * - A run ending with open items does NOT throw: the items are marked
 *   "incomplete", a diagnostic is recorded, and reduction continues, so
 *   truncated traces still yield a comparable state (PROJECT_BOOK §6:
 *   TRUNCATED_RUN is a WARNING, and T005 must be able to reduce
 *   truncated / injected traces). The failure is visible in
 *   `diagnostics`, never silent.
 * - RUN_ERROR never invents a TOOL_CALL_RESULT (§3.5/§3.14).
 */

import type {
  AGUIMessage,
  ContentPart,
  JsonValue,
  MessageRole,
  TextMessageRole,
} from "../protocol/types.js";
import type {
  MessageState,
  ReducerDiagnostic,
  RejoinState,
  ToolCallState,
} from "./state.js";
import { cloneJsonValue, currentRun, jsonDeepEqual, ReducerError, segmentsForContent } from "./state.js";

/** Find a message by id (arrival-order scan; no timestamp use). */
export function findMessage(state: RejoinState, messageId: string): MessageState | undefined {
  return state.messages.find((m) => m.id === messageId);
}

/** Find a tool call by id. */
export function findToolCall(state: RejoinState, toolCallId: string): ToolCallState | undefined {
  return state.toolCalls.find((t) => t.id === toolCallId);
}

/**
 * Recompute pendingToolCallIds from toolCalls. Pending is a property
 * of the LOGICAL call — the toolCallId — not of individual state
 * entries (PROJECT_BOOK §3.14/§5.5; ADR-F01; mirrors Oracle
 * `_compute_pending_tool_call_ids`): "同一调用 ID 不得因重放而被
 * 误认为多个不同调用". A replayed TOOL_CALL_START over an
 * already-closed call is recorded as a SECOND entry for the same id
 * (DUPLICATE_TOOL_CALL, AG-UI #1524); that duplicate is diagnostic
 * evidence, not a second logical call. An id is pending iff some
 * entry for it has closed args (status "closed") and NO entry for
 * it holds a result yet — G01 resume path: entry [0] holds the
 * result 'sunny' while the duplicate entry [1] is closed without a
 * result, so the id is NOT pending. "open" calls are NOT pending
 * (their args are unfinished); "incomplete" calls are NOT pending
 * (their run ended without args completing — no fake result is
 * inferred); "resulted" calls are NOT pending. Each id appears at
 * most once, in first-appearance (START) order. This is the
 * state-derived truth that RUN_FINISHED outcome.pendingToolCallIds
 * is checked against.
 *
 * States without duplicate ids are unaffected: for unique ids this
 * returns exactly the old per-entry filter (same ids, same order).
 *
 * Optional `runId` scopes the aggregation to entries of that run
 * only (ADR-004): RUN_FINISHED checks pending(当前 run), while the
 * state field pendingToolCallIds stays global (no argument).
 */
export function computePendingToolCallIds(state: RejoinState, runId?: string): readonly string[] {
  const byId = new Map<string, { hasResult: boolean; hasClosed: boolean }>();
  for (const entry of state.toolCalls) {
    if (runId !== undefined && entry.runId !== runId) continue;
    let slot = byId.get(entry.id);
    if (slot === undefined) {
      slot = { hasResult: false, hasClosed: false };
      byId.set(entry.id, slot);
    }
    if (entry.hasResult) slot.hasResult = true;
    if (entry.status === "closed") slot.hasClosed = true;
  }
  const pending: string[] = [];
  for (const [id, slot] of byId) {
    if (!slot.hasResult && slot.hasClosed) pending.push(id);
  }
  return pending;
}

/** Append a diagnostic (returns a new state). */
export function addDiagnostic(
  state: RejoinState,
  diagnostic: ReducerDiagnostic,
): RejoinState {
  return { ...state, diagnostics: [...state.diagnostics, diagnostic] };
}

/** Append a timeline entry (returns a new state). */
export function appendTimeline(
  state: RejoinState,
  item: RejoinState["orderedTimeline"][number],
): RejoinState {
  return { ...state, orderedTimeline: [...state.orderedTimeline, item] };
}

/** Replace one message entry by id (returns a new state). */
export function replaceMessage(
  state: RejoinState,
  next: MessageState,
): RejoinState {
  return {
    ...state,
    messages: state.messages.map((m) => (m.id === next.id ? next : m)),
  };
}

/** Replace one tool-call entry by id (returns a new state). */
export function replaceToolCall(
  state: RejoinState,
  next: ToolCallState,
): RejoinState {
  return {
    ...state,
    toolCalls: state.toolCalls.map((t) => (t.id === next.id ? next : t)),
  };
}

// ---------------------------------------------------------------------------
// Text messages
// ---------------------------------------------------------------------------

/**
 * TEXT_MESSAGE_START. Creates a new message, or reopens a closed one with
 * identical role/name. Throws when: the id is already open; a reopen
 * changes role or name.
 */
export function openMessage(
  state: RejoinState,
  messageId: string,
  role: TextMessageRole | undefined,
  name: string | undefined,
): RejoinState {
  const effectiveRole: MessageRole = role ?? "assistant";
  const existing = findMessage(state, messageId);
  if (existing !== undefined) {
    if (existing.status === "open") {
      throw new ReducerError(
        "DUPLICATE_MESSAGE_START",
        `TEXT_MESSAGE_START for messageId "${messageId}" while it is already open: ` +
          `a producer must not open an identifier that is already open (EVENT_SCHEMA §4.1).`,
        { eventType: "TEXT_MESSAGE_START", messageId },
      );
    }
    if (existing.status === "incomplete") {
      throw new ReducerError(
        "REOPEN_INCOMPLETE_MESSAGE",
        `TEXT_MESSAGE_START reopens messageId "${messageId}" which was left incomplete ` +
          `by a run end; a reopen requires a cleanly closed message (PROJECT_BOOK §3.8).`,
        { eventType: "TEXT_MESSAGE_START", messageId },
      );
    }
    // Closed -> legal reopen, but owner/role/name must match (§3.8).
    if (existing.role !== effectiveRole) {
      throw new ReducerError(
        "MESSAGE_REOPEN_ROLE_MISMATCH",
        `TEXT_MESSAGE_START reopens messageId "${messageId}" with role "${effectiveRole}" ` +
          `but the closed message has role "${existing.role}"; a reopen must keep role identical (PROJECT_BOOK §3.8).`,
        { eventType: "TEXT_MESSAGE_START", messageId },
      );
    }
    if ((existing.name ?? undefined) !== (name ?? undefined)) {
      throw new ReducerError(
        "MESSAGE_REOPEN_NAME_MISMATCH",
        `TEXT_MESSAGE_START reopens messageId "${messageId}" with name ${JSON.stringify(name ?? null)} ` +
          `but the closed message has name ${JSON.stringify(existing.name ?? null)}; a reopen must keep name identical (PROJECT_BOOK §3.8).`,
        { eventType: "TEXT_MESSAGE_START", messageId },
      );
    }
    // Legal reopen: content APPENDS on the next CONTENT (see module
    // header); status returns to open. Timeline keeps the interleave.
    // A reopen OPENS A NEW SEGMENT (Oracle parity): the new text is a
    // second segment, never merged into the previous one — the boundary
    // is what lets G03-style interleave loss be observed (FIX-T003-G03).
    return replaceMessage(state, {
      ...existing,
      segments: [...existing.segments, { text: "" }],
      status: "open",
    });
  }
  const created: MessageState = {
    id: messageId,
    role: effectiveRole,
    ...(name !== undefined ? { name } : {}),
    content: "",
    // A fresh message starts with one empty segment (Oracle
    // `_new_message`: segments [{"text": ""}]); CONTENT appends to it.
    segments: [{ text: "" }],
    status: "open",
    owner: "producer",
  };
  return { ...state, messages: [...state.messages, created] };
}

/** TEXT_MESSAGE_CONTENT. Appends delta to an open message. Empty delta is legal (keep-alive). */
export function appendMessageContent(
  state: RejoinState,
  messageId: string,
  delta: string,
): RejoinState {
  const existing = findMessage(state, messageId);
  if (existing === undefined) {
    throw new ReducerError(
      "CONTENT_WITHOUT_START",
      `TEXT_MESSAGE_CONTENT for messageId "${messageId}" with no such message: ` +
        `content must target an already-opened message (PROJECT_BOOK §5.4; OUT_OF_ORDER).`,
      { eventType: "TEXT_MESSAGE_CONTENT", messageId },
    );
  }
  if (existing.status !== "open") {
    throw new ReducerError(
      "CONTENT_WITHOUT_START",
      `TEXT_MESSAGE_CONTENT for messageId "${messageId}" which is ${existing.status}, not open: ` +
        `content must target an already-opened message (PROJECT_BOOK §5.4; OUT_OF_ORDER).`,
      { eventType: "TEXT_MESSAGE_CONTENT", messageId },
    );
  }
  const prior = typeof existing.content === "string" ? existing.content : "";
  // CONTENT appends to the LAST segment only (Oracle parity); `content`
  // stays the concatenation of all segments. A message with no segments
  // (only possible for a hand-built state, never from this Reducer)
  // falls back to a single segment holding the prior text, so the
  // invariant content === join(segments) is never broken here.
  const baseSegments =
    existing.segments.length > 0 ? existing.segments : [{ text: prior }];
  const segments = baseSegments.map((segment, i) =>
    i === baseSegments.length - 1
      ? { text: segment.text + delta }
      : segment,
  );
  return replaceMessage(state, { ...existing, content: prior + delta, segments });
}

/** TEXT_MESSAGE_END. Closes an open message. */
export function closeMessage(state: RejoinState, messageId: string): RejoinState {
  const existing = findMessage(state, messageId);
  if (existing === undefined) {
    throw new ReducerError(
      "END_WITHOUT_START",
      `TEXT_MESSAGE_END for messageId "${messageId}" with no such message: ` +
        `END must target an already-opened message (EVENT_SCHEMA §4.1).`,
      { eventType: "TEXT_MESSAGE_END", messageId },
    );
  }
  if (existing.status !== "open") {
    throw new ReducerError(
      "END_WITHOUT_START",
      `TEXT_MESSAGE_END for messageId "${messageId}" which is ${existing.status}, not open: ` +
        `END must target an already-opened message (EVENT_SCHEMA §4.1).`,
      { eventType: "TEXT_MESSAGE_END", messageId },
    );
  }
  return replaceMessage(state, { ...existing, status: "closed" });
}

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

/**
 * TOOL_CALL_START. Creates a new call, or reopens a closed/resulted one
 * with identical toolCallName/parentMessageId. Throws when: the id is
 * already open (or incomplete); a reopen changes name or parent.
 * A reopen starts a NEW logical execution: hasResult resets, runId
 * updates; arguments keep appending in arrival order (§5.5).
 */
export function openToolCall(
  state: RejoinState,
  toolCallId: string,
  toolCallName: string,
  parentMessageId: string | undefined,
  runId: string | null,
): RejoinState {
  const existing = findToolCall(state, toolCallId);
  if (existing !== undefined) {
    if (existing.status === "open") {
      throw new ReducerError(
        "DUPLICATE_TOOL_CALL_START",
        `TOOL_CALL_START for toolCallId "${toolCallId}" while it is already open: ` +
          `one call id must not be created as two identical logical calls (PROJECT_BOOK §5.5; DUPLICATE_TOOL_CALL).`,
        { eventType: "TOOL_CALL_START", toolCallId },
      );
    }
    if (existing.status === "incomplete") {
      throw new ReducerError(
        "REOPEN_INCOMPLETE_TOOL_CALL",
        `TOOL_CALL_START reopens toolCallId "${toolCallId}" which was left incomplete ` +
          `by a run end; a reopen requires a cleanly closed call (PROJECT_BOOK §3.12).`,
        { eventType: "TOOL_CALL_START", toolCallId },
      );
    }
    if (existing.name !== toolCallName) {
      throw new ReducerError(
        "TOOL_CALL_REOPEN_NAME_MISMATCH",
        `TOOL_CALL_START reopens toolCallId "${toolCallId}" with toolCallName "${toolCallName}" ` +
          `but the closed call has name "${existing.name}"; a reopen must keep toolCallName identical (PROJECT_BOOK §3.12).`,
        { eventType: "TOOL_CALL_START", toolCallId },
      );
    }
    if ((existing.parentMessageId ?? undefined) !== (parentMessageId ?? undefined)) {
      throw new ReducerError(
        "TOOL_CALL_ID_REUSE",
        `TOOL_CALL_START reopens toolCallId "${toolCallId}" with parentMessageId ` +
          `${JSON.stringify(parentMessageId ?? null)} but the closed call has parentMessageId ` +
          `${JSON.stringify(existing.parentMessageId ?? null)}; the same id for a different parent ` +
          `is identity reuse (PROJECT_BOOK §5.5; TOOL_CALL_ID_REUSE).`,
        { eventType: "TOOL_CALL_START", toolCallId },
      );
    }
    // Legal reopen: new logical execution.
    return replaceToolCall(state, {
      ...existing,
      status: "open",
      hasResult: false,
      resultMessageId: undefined,
      resultContent: undefined,
      runId,
    });
  }
  const created: ToolCallState = {
    id: toolCallId,
    name: toolCallName,
    ...(parentMessageId !== undefined ? { parentMessageId } : {}),
    arguments: "",
    status: "open",
    hasResult: false,
    runId,
  };
  return { ...state, toolCalls: [...state.toolCalls, created] };
}

/** TOOL_CALL_ARGS. Appends delta to an open call's argument text. */
export function appendToolCallArgs(
  state: RejoinState,
  toolCallId: string,
  delta: string,
): RejoinState {
  const existing = findToolCall(state, toolCallId);
  if (existing === undefined) {
    throw new ReducerError(
      "ARGS_WITHOUT_START",
      `TOOL_CALL_ARGS for toolCallId "${toolCallId}" with no such call: ` +
        `args must target an already-opened call (PROJECT_BOOK §5.5; OUT_OF_ORDER).`,
      { eventType: "TOOL_CALL_ARGS", toolCallId },
    );
  }
  if (existing.status !== "open") {
    throw new ReducerError(
      "ARGS_WITHOUT_START",
      `TOOL_CALL_ARGS for toolCallId "${toolCallId}" which is ${existing.status}, not open: ` +
        `args must target an already-opened call (PROJECT_BOOK §5.5; OUT_OF_ORDER).`,
      { eventType: "TOOL_CALL_ARGS", toolCallId },
    );
  }
  return replaceToolCall(state, { ...existing, arguments: existing.arguments + delta });
}

/**
 * TOOL_CALL_END. Closes the args stream; the call becomes pending
 * (status "closed", no result yet). Pending ids are recomputed by the
 * caller via computePendingToolCallIds.
 */
export function closeToolCall(state: RejoinState, toolCallId: string): RejoinState {
  const existing = findToolCall(state, toolCallId);
  if (existing === undefined) {
    throw new ReducerError(
      "END_WITHOUT_START",
      `TOOL_CALL_END for toolCallId "${toolCallId}" with no such call: ` +
        `END must target an already-opened call (EVENT_SCHEMA §4.1).`,
      { eventType: "TOOL_CALL_END", toolCallId },
    );
  }
  if (existing.status !== "open") {
    throw new ReducerError(
      "END_WITHOUT_START",
      `TOOL_CALL_END for toolCallId "${toolCallId}" which is ${existing.status}, not open: ` +
        `END must target an already-opened call (EVENT_SCHEMA §4.1).`,
      { eventType: "TOOL_CALL_END", toolCallId },
    );
  }
  return replaceToolCall(state, { ...existing, status: "closed" });
}

/**
 * TOOL_CALL_RESULT. Requires an existing call (open or closed) and at
 * most one result per logical execution. Creates the tool message.
 * Throws when: no such call; the current execution already has a result;
 * a tool message with the same messageId already exists.
 */
export function applyToolCallResult(
  state: RejoinState,
  messageId: string,
  toolCallId: string,
  content: string | readonly ContentPart[],
  role: "tool" | undefined,
): RejoinState {
  if (role !== undefined && role !== "tool") {
    throw new ReducerError(
      "INVALID_INPUT",
      `TOOL_CALL_RESULT role must be "tool" when present, got ${JSON.stringify(role)}.`,
      { eventType: "TOOL_CALL_RESULT", messageId, toolCallId },
    );
  }
  const existing = findToolCall(state, toolCallId);
  if (existing === undefined) {
    throw new ReducerError(
      "RESULT_WITHOUT_CALL",
      `TOOL_CALL_RESULT for toolCallId "${toolCallId}" with no such call: ` +
        `a result must correspond to an existing call (PROJECT_BOOK §5.5).`,
      { eventType: "TOOL_CALL_RESULT", messageId, toolCallId },
    );
  }
  if (existing.status === "incomplete") {
    throw new ReducerError(
      "RESULT_FOR_INCOMPLETE_CALL",
      `TOOL_CALL_RESULT for toolCallId "${toolCallId}" which was left incomplete by a run end: ` +
        `its execution is over without a result; a result cannot revive it (PROJECT_BOOK §3.14).`,
      { eventType: "TOOL_CALL_RESULT", messageId, toolCallId },
    );
  }
  if (existing.hasResult) {
    throw new ReducerError(
      "DUPLICATE_TOOL_CALL_RESULT",
      `TOOL_CALL_RESULT for toolCallId "${toolCallId}" which already has a result ` +
        `(messageId "${existing.resultMessageId ?? "?"}"): one logical execution has at most one result (PROJECT_BOOK §3.14).`,
      { eventType: "TOOL_CALL_RESULT", messageId, toolCallId },
    );
  }
  if (findMessage(state, messageId) !== undefined) {
    throw new ReducerError(
      "DUPLICATE_MESSAGE_ID",
      `TOOL_CALL_RESULT messageId "${messageId}" already exists as a message: ` +
        `a result creates a NEW tool message (PROJECT_BOOK §3.14).`,
      { eventType: "TOOL_CALL_RESULT", messageId, toolCallId },
    );
  }
  let next = replaceToolCall(state, {
    ...existing,
    status: "resulted",
    hasResult: true,
    resultMessageId: messageId,
    resultContent: cloneJsonValue(content) as string | readonly ContentPart[],
  });
  const toolMessage: MessageState = {
    id: messageId,
    role: "tool",
    content: cloneJsonValue(content) as string | readonly ContentPart[],
    // A tool-result message is built from whole content: a single
    // segment (Oracle parity), never streamed segments.
    segments: segmentsForContent(content),
    toolCallId,
    status: "closed",
    owner: "producer",
  };
  next = { ...next, messages: [...next.messages, toolMessage] };
  return next;
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

/** The runId of the currently running run, or null. */
export function currentRunId(state: RejoinState): string | null {
  const run = currentRun(state);
  return run === null ? null : run.runId;
}

/**
 * Mark every still-open message and tool call "incomplete" and record one
 * diagnostic per item plus a run-level diagnostic. Used by RUN_FINISHED
 * and RUN_ERROR. Returns the new state; never invents results or closes
 * items as if they had ended cleanly.
 */
export function markOpenItemsIncomplete(
  state: RejoinState,
  reason: "RUN_FINISHED" | "RUN_ERROR",
  runId: string,
): RejoinState {
  let next = state;
  for (const message of state.messages) {
    if (message.status === "open") {
      next = replaceMessage(next, { ...message, status: "incomplete" });
      next = addDiagnostic(next, {
        code: "UNCLOSED_STREAM_ITEM",
        severity: "CRITICAL",
        message:
          `${reason} for run "${runId}" ended while text message "${message.id}" was still open; ` +
          `the message is marked incomplete, not closed as if it had ended cleanly (PROJECT_BOOK §5.4).`,
        eventType: reason,
        messageId: message.id,
        runId,
      });
    }
  }
  for (const call of state.toolCalls) {
    if (call.status === "open") {
      next = replaceToolCall(next, { ...call, status: "incomplete" });
      next = addDiagnostic(next, {
        code: "UNCLOSED_STREAM_ITEM",
        severity: "CRITICAL",
        message:
          `${reason} for run "${runId}" ended while tool call "${call.id}" was still open; ` +
          `the call is marked incomplete and receives no inferred result (PROJECT_BOOK §3.14).`,
        eventType: reason,
        toolCallId: call.id,
        runId,
      });
    }
  }
  return next;
}

/**
 * Seed state from a RUN_STARTED input (RunAgentInput). Idempotent merge:
 * - sharedState: adopted only when no baseline exists yet; when a baseline
 *   exists and input.state differs, the live baseline is kept and a
 *   SNAPSHOT_MISMATCH diagnostic is recorded (the input is a stale echo,
 *   not a new baseline — EVENT_SCHEMA §6.2: a snapshot after the fact must
 *   not overwrite valid later updates, PROJECT_BOOK §5.7). When no run has
 *   started yet and input.state is absent, the baseline becomes {}.
 * - messages: input messages are the conversation history echo. A message
 *   whose id is already present is skipped (streamed state wins). A new
 *   non-tool message is appended as closed/producer-owned. A new tool
 *   message answers a pending call: the call is marked resulted (this is
 *   how a frontend tool result arrives in the next run, §3.14); a tool
 *   message for an already-resulted call is skipped as a history echo;
 *   a tool message for an UNKNOWN call is skipped as well — it is history
 *   the reducer never saw, not a new result to invent state for — and a
 *   diagnostic records that it was not applied. Client-only
 *   activity/reasoning input messages (role activity/reasoning) are kept
 *   with owner "client" so MESSAGES_SNAPSHOT rule 4 can tell them apart.
 */
export function seedRunInput(
  state: RejoinState,
  input: {
    readonly messages: readonly AGUIMessage[];
    readonly state?: JsonValue;
  },
): RejoinState {
  let next = state;
  // --- sharedState baseline (EVENT_SCHEMA §6.2, PROJECT_BOOK §5.7) ---
  if (next.sharedState === undefined) {
    next = {
      ...next,
      sharedState: cloneJsonValue(input.state !== undefined ? input.state : {}),
    };
  } else if (input.state !== undefined && !jsonDeepEqual(next.sharedState, input.state)) {
    next = addDiagnostic(next, {
      code: "SNAPSHOT_MISMATCH",
      severity: "CRITICAL",
      message:
        `RUN_STARTED input.state differs from the live sharedState baseline; ` +
        `the live baseline is kept and the input state is not applied (a snapshot ` +
        `must not overwrite valid later updates, PROJECT_BOOK §5.7).`,
      eventType: "RUN_STARTED",
    });
  }
  // --- messages: idempotent history merge ---
  for (const inputMessage of input.messages) {
    if (findMessage(next, inputMessage.id) !== undefined) {
      continue; // History echo; streamed state wins.
    }
    if (inputMessage.role === "tool") {
      const toolMessage = inputMessage as {
        readonly toolCallId: string;
        readonly content: string | readonly ContentPart[];
      };
      const call = findToolCall(next, toolMessage.toolCallId);
      if (call === undefined) {
        next = addDiagnostic(next, {
          code: "TOOL_CALL_RESULT_UNMATCHED_INPUT",
          severity: "WARNING",
          message:
            `RUN_STARTED input carries tool message "${inputMessage.id}" for toolCallId ` +
            `"${toolMessage.toolCallId}" which this trace never opened; the message is ` +
            `recorded but no call is marked resulted (no state is invented for history the reducer never saw).`,
          eventType: "RUN_STARTED",
          messageId: inputMessage.id,
          toolCallId: toolMessage.toolCallId,
        });
        const recorded: MessageState = {
          id: inputMessage.id,
          role: "tool",
          content: cloneJsonValue(toolMessage.content) as string | readonly ContentPart[],
          segments: segmentsForContent(toolMessage.content),
          toolCallId: toolMessage.toolCallId,
          status: "closed",
          owner: "producer",
        };
        next = { ...next, messages: [...next.messages, recorded] };
        continue;
      }
      if (call.hasResult) {
        continue; // History echo of an already-answered call.
      }
      if (call.status === "incomplete") {
        continue; // Its execution ended without a result; do not revive it.
      }
      next = replaceToolCall(next, {
        ...call,
        status: "resulted",
        hasResult: true,
        resultMessageId: inputMessage.id,
        resultContent: cloneJsonValue(toolMessage.content) as string | readonly ContentPart[],
      });
      const recorded: MessageState = {
        id: inputMessage.id,
        role: "tool",
        content: cloneJsonValue(toolMessage.content) as string | readonly ContentPart[],
        segments: segmentsForContent(toolMessage.content),
        toolCallId: toolMessage.toolCallId,
        status: "closed",
        owner: "producer",
      };
      next = { ...next, messages: [...next.messages, recorded] };
      continue;
    }
    // NOTE: AGUIMessage now has activity/reasoning variants (FIX-T003-minor),
    // but MESSAGES_SNAPSHOT / RunAgentInput messages may still carry those
    // roles at runtime in forms the MessageState content type does not model
    // exactly (activity object payload). Compare as plain strings so the
    // runtime values are handled.
    const inputRole = inputMessage.role as string;
    const owner: MessageState["owner"] =
      inputRole === "activity" || inputRole === "reasoning" ? "client" : "producer";
    const seeded: MessageState = {
      id: inputMessage.id,
      role: inputMessage.role,
      ...(inputMessage.name !== undefined ? { name: inputMessage.name } : {}),
      content: cloneJsonValue(
        inputMessage.content !== undefined ? inputMessage.content : "",
      ) as string | readonly ContentPart[],
      // Seeded from whole content (an input echo, not a stream): a
      // single segment, mirroring the snapshot rule (Oracle parity).
      segments: segmentsForContent(inputMessage.content),
      ...("toolCalls" in inputMessage && inputMessage.toolCalls !== undefined
        ? { toolCalls: cloneJsonValue(inputMessage.toolCalls) as MessageState["toolCalls"] }
        : {}),
      status: "closed",
      owner,
    };
    next = { ...next, messages: [...next.messages, seeded] };
  }
  return { ...next, pendingToolCallIds: computePendingToolCallIds(next) };
}
