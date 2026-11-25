/**
 * P031 RejoinLab — T003: deterministic reference Reducer.
 *
 * Frozen contract: IMPLEMENTATION_PLAN §5.4
 *   function reduceEvent(state: RejoinState, event: AGUIEvent): RejoinState
 *   - no external state; no randomness; no time reads; no network;
 *   - does not mutate its input; same input produces same output.
 *   Events reduce in ARRIVAL order; `timestamp` is never used to reorder.
 *
 * Entry points:
 * - `reduceEvent(state, event)`: one EXPANDED event (chunk triples only).
 *   A raw *_CHUNK event passed here throws: chunks must be expanded by
 *   `expandChunks()` before the Reducer ever sees them (EVENT_SCHEMA §4.5
 *   rule 1; T002 owns the expansion helper, T003 owns calling it).
 * - `reduceEvents(normalized)`: the sanctioned reduction entry — calls
 *   T002's `expandChunks()` on the input NormalizedEvent sequence, then
 *   folds `reduceEvent` over the expanded events in order. It does NOT
 *   re-index anything itself: the from-0 re-numbering in emission order
 *   happens inside `expandChunks()` (parser/normalize.ts `push()`
 *   assigns `sourceIndex = out.length`), and `reduceEvents` keeps only
 *   each expanded item's `.event`, so the expanded sourceIndex values do
 *   not even reach `reduceEvent` — diagnostics and timeline entries
 *   carry no sourceIndex. The pre-expansion numbering exists only
 *   inside the parser; anything downstream that needs positions must use
 *   the expanded sequence from `expandChunks()` directly.
 * - `reduceExpandedEvents(events)`: fold over an already-expanded
 *   sequence (e.g. a hand-built triple sequence in tests).
 *
 * Error policy (PROJECT_BOOK §5.4–§5.6, §6.2):
 * - HARD violations throw ReducerError and abort the fold. They are never
 *   silently accepted: CONTENT/ARGS/END for a never-opened or closed id,
 *   duplicate START while open, reopen with mismatched descriptive fields,
 *   second result for one logical execution, result for an unknown call,
 *   RUN_STARTED while a run is running / reusing a runId / changing
 *   threadId, RUN_FINISHED for a run that is not open, RUN_FINISHED whose
 *   outcome.pendingToolCallIds disagrees with the state-derived pending
 *   set. Callers that reduce untrusted or injected traces (T005) catch
 *   ReducerError and translate its `code` into a diagnostic.
 * - SOFT findings are recorded in `state.diagnostics` and reduction
 *   continues: RUN_ERROR (before or during a run), a run ending with
 *   items still open (marked "incomplete"), STATE_DELTA that cannot apply
 *   (SNAPSHOT_MISMATCH, prior value kept), unknown patch ops (discarded
 *   with a warning), RUN_STARTED input.state conflicting with the live
 *   baseline (live baseline kept).
 * - SUSPECTED_DUPLICATE is NEVER decided here: without a stable event id
 *   the Reducer cannot tell a replayed event from a legitimately identical
 *   one, and it must never delete a suspected duplicate (§4.3, §6.2).
 *   Identical events reduce twice, deterministically; duplicate detection
 *   is T004/T005's job.
 */

import type {
  AGUIEvent,
  NormalizedEvent,
} from "../protocol/types.js";
import type { RejoinState, RunState } from "./state.js";
import { initialState, ReducerError } from "./state.js";
import {
  addDiagnostic,
  appendTimeline,
  applyToolCallResult,
  appendMessageContent,
  appendToolCallArgs,
  closeMessage,
  closeToolCall,
  computePendingToolCallIds,
  currentRunId,
  markOpenItemsIncomplete,
  openMessage,
  openToolCall,
  seedRunInput,
} from "./lifecycle.js";
import {
  applyStateDelta,
  applyStateSnapshot,
  reconcileMessagesSnapshot,
} from "./snapshot.js";
import { expandChunks } from "../parser/normalize.js";

/** Thrown for hard protocol violations (defined in state.ts to avoid a
 * lifecycle <-> reducer import cycle). */
export { ReducerError } from "./state.js";

/** Refresh the derived pendingToolCallIds after a mutation. */
function refreshPending(state: RejoinState): RejoinState {
  return { ...state, pendingToolCallIds: computePendingToolCallIds(state) };
}

/** Guard: most stream events require an open run. Returns the open run. */
function requireOpenRun(state: RejoinState, eventType: string): RunState {
  const runs = state.runs;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const run = runs[i];
    if (run !== undefined && run.status === "RUNNING") return run;
  }
  throw new ReducerError(
    "EVENT_WITHOUT_RUN",
    `${eventType} arrived with no run open: stream events belong to a run ` +
      `(RUN_STARTED ... RUN_FINISHED / RUN_ERROR). State-only snapshots ` +
      `outside a run are the single exception and are handled separately.`,
    { eventType },
  );
}

function reduceRunStarted(
  state: RejoinState,
  event: Extract<AGUIEvent, { type: "RUN_STARTED" }>,
): RejoinState {
  // A second threadId mid-trace is a different conversation.
  if (state.threadId !== null && state.threadId !== event.threadId) {
    throw new ReducerError(
      "THREAD_MISMATCH",
      `RUN_STARTED threadId "${event.threadId}" does not match the established threadId ` +
        `"${state.threadId}": one trace is one conversation (AGUI_SCOPE §4.1).`,
      { eventType: "RUN_STARTED", runId: event.runId },
    );
  }
  // A runId must not be reused for another run (§3.3).
  if (state.runs.some((r) => r.runId === event.runId)) {
    throw new ReducerError(
      "DUPLICATE_RUN_ID",
      `RUN_STARTED reuses runId "${event.runId}" which already ran in this thread: ` +
        `one runId is one run; a re-run is a new runId (PROJECT_BOOK §3.3).`,
      { eventType: "RUN_STARTED", runId: event.runId },
    );
  }
  // A run must not start while another is still running.
  const open = state.runs.find((r) => r.status === "RUNNING");
  if (open !== undefined) {
    throw new ReducerError(
      "RUN_ALREADY_RUNNING",
      `RUN_STARTED runId "${event.runId}" arrived while run "${open.runId}" is still open: ` +
        `a run must end (RUN_FINISHED / RUN_ERROR) before the next starts.`,
      { eventType: "RUN_STARTED", runId: event.runId },
    );
  }
  // Event/input identity must agree when input is present.
  if (event.input !== undefined) {
    if (event.input.threadId !== event.threadId || event.input.runId !== event.runId) {
      throw new ReducerError(
        "RUN_INPUT_MISMATCH",
        `RUN_STARTED input threadId/runId ("${event.input.threadId}"/"${event.input.runId}") ` +
          `disagree with the event threadId/runId ("${event.threadId}"/"${event.runId}").`,
        { eventType: "RUN_STARTED", runId: event.runId },
      );
    }
  }
  const run: RunState = {
    runId: event.runId,
    threadId: event.threadId,
    status: "RUNNING",
    ...(event.parentRunId !== undefined ? { parentRunId: event.parentRunId } : {}),
    ...(event.protocolVersion !== undefined ? { protocolVersion: event.protocolVersion } : {}),
  };
  let next: RejoinState = {
    ...state,
    threadId: event.threadId,
    runs: [...state.runs, run],
    runStatus: "RUNNING",
  };
  if (event.input !== undefined) {
    next = seedRunInput(next, event.input);
  } else if (next.sharedState === undefined) {
    // No input.state: the run baseline is the empty object (§6.2).
    next = { ...next, sharedState: {} };
  }
  next = appendTimeline(next, {
    kind: "run",
    eventType: "RUN_STARTED",
    runId: event.runId,
  });
  return refreshPending(next);
}

function reduceRunFinished(
  state: RejoinState,
  event: Extract<AGUIEvent, { type: "RUN_FINISHED" }>,
): RejoinState {
  if (state.threadId !== null && state.threadId !== event.threadId) {
    throw new ReducerError(
      "THREAD_MISMATCH",
      `RUN_FINISHED threadId "${event.threadId}" does not match the established threadId "${state.threadId}".`,
      { eventType: "RUN_FINISHED", runId: event.runId },
    );
  }
  const open = state.runs.find((r) => r.status === "RUNNING");
  if (open === undefined) {
    throw new ReducerError(
      "FINISH_WITHOUT_START",
      `RUN_FINISHED for run "${event.runId}" arrived with no run open.`,
      { eventType: "RUN_FINISHED", runId: event.runId },
    );
  }
  if (open.runId !== event.runId) {
    throw new ReducerError(
      "FINISH_WRONG_RUN",
      `RUN_FINISHED for run "${event.runId}" but the open run is "${open.runId}": ` +
        `a run can only be finished by its own RUN_FINISHED.`,
      { eventType: "RUN_FINISHED", runId: event.runId },
    );
  }
  // outcome.pendingToolCallIds must equal the current run's calls that are
  // still without a result (§3.14). Compare as ordered arrays: the spec
  // says the list is in initiation order.
  if (event.outcome !== undefined && event.outcome.type === "success") {
    const declared = event.outcome.pendingToolCallIds ?? [];
    const currentRunPending = computePendingToolCallIds(state, event.runId);
    // Calls pending from EARLIER runs stay pending globally but are not
    // this run's; the outcome list covers this run's calls only (§3.2:
    // "本 run 发起且未收到结果"). A declared id that is not a current-run
    // unresulted call is equally a mismatch.
    const mismatch =
      declared.length !== currentRunPending.length ||
      declared.some((id, i) => id !== currentRunPending[i]);
    if (mismatch) {
      throw new ReducerError(
        "PENDING_TOOL_CALL_MISMATCH",
        `RUN_FINISHED outcome.pendingToolCallIds ${JSON.stringify(declared)} does not match ` +
          `this run's calls still without a result ${JSON.stringify(currentRunPending)} ` +
          `(PROJECT_BOOK §3.14: the list must be consistent with the run's unresulted calls).`,
        { eventType: "RUN_FINISHED", runId: event.runId },
      );
    }
  }
  const outcomeType = event.outcome?.type;
  const runStatus: RejoinState["runStatus"] =
    outcomeType === "cancelled" ? "CANCELLED" : "FINISHED";
  let next = markOpenItemsIncomplete(state, "RUN_FINISHED", event.runId);
  const finished: RunState = {
    ...open,
    status: outcomeType === "cancelled" ? "CANCELLED" : "FINISHED",
    ...(event.outcome !== undefined ? { outcome: event.outcome } : {}),
    ...(event.result !== undefined ? { result: event.result } : {}),
  };
  next = {
    ...next,
    runs: next.runs.map((r) => (r.runId === open.runId ? finished : r)),
    runStatus,
  };
  next = appendTimeline(next, {
    kind: "run",
    eventType: "RUN_FINISHED",
    runId: event.runId,
  });
  return refreshPending(next);
}

function reduceRunError(
  state: RejoinState,
  event: Extract<AGUIEvent, { type: "RUN_ERROR" }>,
): RejoinState {
  // RUN_ERROR may appear BEFORE RUN_STARTED (§3.5): no run to close, the
  // failure is recorded as a diagnostic and runStatus becomes ERROR.
  let next = addDiagnostic(state, {
    code: "RUN_ERROR",
    severity: "CRITICAL",
    message:
      `RUN_ERROR${event.code !== undefined ? ` [${event.code}]` : ""}: ${event.message} ` +
      `(PROJECT_BOOK §3.5: a run failure; uncompleted items are marked incomplete, no fake TOOL_CALL_RESULT is inferred).`,
    eventType: "RUN_ERROR",
  });
  const open = state.runs.find((r) => r.status === "RUNNING");
  if (open === undefined) {
    next = { ...next, runStatus: "ERROR" };
  } else {
    next = markOpenItemsIncomplete(next, "RUN_ERROR", open.runId);
    const failed: RunState = {
      ...open,
      status: "ERROR",
      error: {
        message: event.message,
        ...(event.code !== undefined ? { code: event.code } : {}),
      },
    };
    next = {
      ...next,
      runs: next.runs.map((r) => (r.runId === open.runId ? failed : r)),
      runStatus: "ERROR",
    };
  }
  next = appendTimeline(next, {
    kind: "run",
    eventType: "RUN_ERROR",
    ...(open !== undefined ? { runId: open.runId } : {}),
  });
  return refreshPending(next);
}

/**
 * Reduce one EXPANDED event. Pure: never mutates `state` or `event`.
 * Throws ReducerError on hard protocol violations; records soft findings
 * in the returned state's `diagnostics`.
 */
export function reduceEvent(state: RejoinState, event: AGUIEvent): RejoinState {
  switch (event.type) {
    case "TEXT_MESSAGE_CHUNK":
    case "TOOL_CALL_CHUNK":
      throw new ReducerError(
        "UNEXPANDED_CHUNK",
        `${event.type} reached the Reducer unexpanded: chunks must be expanded by ` +
          `expandChunks() before reduction (EVENT_SCHEMA §4.5 rule 1). Call reduceEvents() instead.`,
        { eventType: event.type },
      );
    case "RUN_STARTED":
      return reduceRunStarted(state, event);
    case "RUN_FINISHED":
      return reduceRunFinished(state, event);
    case "RUN_ERROR":
      return reduceRunError(state, event);
    case "TEXT_MESSAGE_START": {
      requireOpenRun(state, event.type);
      let next = openMessage(state, event.messageId, event.role, event.name);
      next = appendTimeline(next, {
        kind: "message",
        eventType: "TEXT_MESSAGE_START",
        messageId: event.messageId,
      });
      return refreshPending(next);
    }
    case "TEXT_MESSAGE_CONTENT": {
      requireOpenRun(state, event.type);
      let next = appendMessageContent(state, event.messageId, event.delta);
      next = appendTimeline(next, {
        kind: "message",
        eventType: "TEXT_MESSAGE_CONTENT",
        messageId: event.messageId,
        text: event.delta,
      });
      return refreshPending(next);
    }
    case "TEXT_MESSAGE_END": {
      requireOpenRun(state, event.type);
      let next = closeMessage(state, event.messageId);
      next = appendTimeline(next, {
        kind: "message",
        eventType: "TEXT_MESSAGE_END",
        messageId: event.messageId,
      });
      return refreshPending(next);
    }
    case "TOOL_CALL_START": {
      requireOpenRun(state, event.type);
      let next = openToolCall(
        state,
        event.toolCallId,
        event.toolCallName,
        event.parentMessageId,
        currentRunId(state),
      );
      next = appendTimeline(next, {
        kind: "tool-call",
        eventType: "TOOL_CALL_START",
        toolCallId: event.toolCallId,
        messageId: event.parentMessageId,
      });
      return refreshPending(next);
    }
    case "TOOL_CALL_ARGS": {
      requireOpenRun(state, event.type);
      let next = appendToolCallArgs(state, event.toolCallId, event.delta);
      next = appendTimeline(next, {
        kind: "tool-call",
        eventType: "TOOL_CALL_ARGS",
        toolCallId: event.toolCallId,
        text: event.delta,
      });
      return refreshPending(next);
    }
    case "TOOL_CALL_END": {
      requireOpenRun(state, event.type);
      let next = closeToolCall(state, event.toolCallId);
      next = appendTimeline(next, {
        kind: "tool-call",
        eventType: "TOOL_CALL_END",
        toolCallId: event.toolCallId,
      });
      return refreshPending(next);
    }
    case "TOOL_CALL_RESULT": {
      requireOpenRun(state, event.type);
      let next = applyToolCallResult(
        state,
        event.messageId,
        event.toolCallId,
        event.content,
        event.role,
      );
      next = appendTimeline(next, {
        kind: "tool-call",
        eventType: "TOOL_CALL_RESULT",
        messageId: event.messageId,
        toolCallId: event.toolCallId,
      });
      return refreshPending(next);
    }
    case "STATE_SNAPSHOT": {
      // Independent event: may appear at any position inside an open run
      // (§4.1); also legal outside a run (a snapshot is a baseline, not a
      // stream item), so no requireOpenRun here.
      let next = applyStateSnapshot(state, event.snapshot);
      next = appendTimeline(next, { kind: "state", eventType: "STATE_SNAPSHOT" });
      return refreshPending(next);
    }
    case "STATE_DELTA": {
      let next = applyStateDelta(state, event.delta);
      next = appendTimeline(next, { kind: "state", eventType: "STATE_DELTA" });
      return refreshPending(next);
    }
    case "MESSAGES_SNAPSHOT": {
      // Run-level event (§6.3): legal inside an open run at any position.
      // Outside a run it is still a conversation-wide declaration, so no
      // requireOpenRun here either.
      let next = reconcileMessagesSnapshot(state, event.messages);
      next = appendTimeline(next, { kind: "messages-snapshot", eventType: "MESSAGES_SNAPSHOT" });
      return refreshPending(next);
    }
    default: {
      const unknown = event as { readonly type: string };
      throw new ReducerError(
        "UNSUPPORTED_EVENT",
        `Event type ${JSON.stringify(unknown.type)} is not one of the 15 MVP events ` +
          `(AGUI_SCOPE §2–§3); unsupported events must be reported, never silently dropped.`,
        { eventType: unknown.type },
      );
    }
  }
}

/**
 * Fold an already-expanded event sequence. `initial` defaults to
 * initialState(). Pure: the input array and its events are never mutated.
 */
export function reduceExpandedEvents(
  events: readonly AGUIEvent[],
  initial: RejoinState = initialState(),
): RejoinState {
  let state = initial;
  for (const event of events) {
    state = reduceEvent(state, event);
  }
  return state;
}

/**
 * The sanctioned reduction entry: expand *_CHUNK events first (T002's
 * expandChunks — which assigns the expanded items fresh sourceIndex
 * values from 0 in emission order), then fold `reduceEvent` over the
 * expanded events in order. Only the `.event` of each expanded item is
 * folded, so the expanded sourceIndex values do not reach the Reducer:
 * the returned state's diagnostics and timeline carry no sourceIndex.
 * The pre-expansion numbering exists only inside the parser.
 */
export function reduceEvents(
  normalized: readonly NormalizedEvent[],
  initial: RejoinState = initialState(),
): RejoinState {
  const expanded = expandChunks(normalized);
  return reduceExpandedEvents(
    expanded.map((item) => item.event),
    initial,
  );
}

/** Alias with the input type spelled out for T005/T007 callers. */
export const reduceNormalizedEvents = reduceEvents;

export { findMessage, findToolCall } from "./lifecycle.js";
