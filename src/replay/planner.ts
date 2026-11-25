/**
 * P031 RejoinLab — T005: deterministic dual-track recovery planner.
 *
 * Frozen sources:
 * - PROJECT_BOOK.md v1.0.2 §4.4–§4.5 (checkpoint / resume cursor),
 *   §5.2 (canon equality invariant), §5.7–§5.8 (snapshot / legal
 *   recovery convergence), §6 (diagnostic codes), §7 (verdicts),
 *   §8.1–§8.3 (size bounds, DISCONNECT_AFTER, three strategies).
 * - IMPLEMENTATION_PLAN.md v1.0.0 §5.2 (AnalyzeInput), §6 T005.
 * - oracle/replay.py evaluate() (comparison reference only; written
 *   independently against the frozen spec and the TS Reducer).
 *
 * The replay fold (foldTrack) vs the T003 Reducer:
 * - The T003 Reducer is strict: it THROWS ReducerError on hard
 *   protocol violations (CONTENT for a closed message, a duplicate
 *   START while open, a second result, a replayed runId, ...). The
 *   Oracle reference fold is lenient: it records an OUT_OF_ORDER /
 *   DUPLICATE_TOOL_CALL diagnostic and keeps folding. A replay
 *   engine that aborted on the first injected violation could never
 *   compare a faulty resume path, so foldTrack wraps reduceEvent:
 *   replay-shaped situations are intercepted BEFORE the Reducer
 *   (replayed TOOL_CALL_START over a closed call, replayed START
 *   over an open item, legal reopen of an incomplete item, replayed
 *   RUN_STARTED), and any remaining ReducerError is translated into
 *   a report diagnostic (see REDUCER_ERROR_TO_DIAGNOSTIC) while the
 *   fold continues with the state unchanged for that event. The
 *   history still records one entry per expanded event, so step
 *   comparison stays aligned.
 * - SUSPECTED_DUPLICATE (§4.3) is detected here, never in the
 *   Reducer: when the same (type, business id, delta) payload is
 *   applied twice inside one fold and the wrapper carries no stable
 *   sourceEventKey, a WARNING is recorded and the payload is still
 *   applied a second time (never silently de-duplicated).
 *
 * Diagnostic-code mapping (frozen T005 ruling, §6 + task brief):
 * - The fold layer's UNCLOSED_STREAM_ITEM (CRITICAL, T003-local,
 *   recorded in RejoinState.diagnostics when a run ends with items
 *   still open) is NEVER copied verbatim into report diagnostics.
 *   It is mapped to the report layer's TRUNCATED_RUN (WARNING) if
 *   and only if the stream actually lacks a terminating event
 *   (full-path runStatus RUNNING / NOT_STARTED with events present).
 *   When the stream DOES end with a terminating event, no
 *   TRUNCATED_RUN is reported for it. The mapping lives in
 *   classifyDualTrack, not in the fold.
 * - TS diagnostics carry no sourceIndex (the frozen
 *   reduceEvent(state, event) signature cannot see one). Report
 *   diagnostics built from fold findings therefore take their
 *   sourceIndex from the expanded-sequence position being folded at
 *   the time — never invented from anywhere else.
 * - RUN_ERROR is recorded in RejoinState.diagnostics by the Reducer
 *   but is NOT a resume-path diagnostic here (the Oracle emits none
 *   for it either); a failed run is visible in runStatus.
 * - Only SNAPSHOT_MISMATCH and UNKNOWN_PATCH_OP are harvested from
 *   RejoinState.diagnostics into report diagnostics (both have
 *   Oracle counterparts with the same codes).
 */

import type {
  AGUIEvent,
  NormalizedEvent,
  RecoveryCheckpoint,
} from "../protocol/types.js";
import { isMvpEventType } from "../protocol/types.js";
import type { RejoinState, RunState } from "../core/state.js";
import {
  cloneState,
  initialState,
  jsonDeepEqual,
  ReducerError,
  segmentsForContent,
} from "../core/state.js";
import { reduceEvent } from "../core/reducer.js";
import {
  appendTimeline,
  computePendingToolCallIds,
  currentRunId,
} from "../core/lifecycle.js";
import { expandChunks } from "../parser/normalize.js";
import { stateHash } from "../core/canonical.js";
import type { FirstDivergence, StateHistoryEntry } from "../core/diff.js";
import { findFirstDivergenceForReplay } from "./align.js";
import { applyInjections, type Injection } from "./inject.js";

/** PROJECT_BOOK §8.1. */
export const MAX_EVENTS = 40;
/** PROJECT_BOOK §8.5. */
export const MAX_SEARCH_NODES = 5000;
/** PROJECT_BOOK §8.5. */
export const MAX_SEARCH_DEPTH = 3;

export type RecoveryStrategy =
  | "FULL_REPLAY_FROM_START"
  | "RESUME_FROM_CHECKPOINT"
  | "REPLAY_AFTER_SOURCE_CURSOR";

export type Verdict =
  | "CONSISTENT"
  | "INCONSISTENT"
  | "INCONCLUSIVE_LIMIT"
  | "INVALID_INPUT"
  | "INCOMPLETE_TRACE";

export type DiagnosticSeverity = "CRITICAL" | "WARNING";

/** Report-layer diagnostic (PROJECT_BOOK §13.2 shape). */
export interface ReplayDiagnostic {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly sourceIndex?: number;
  readonly relatedSourceIndices?: number[];
  readonly message: string;
  readonly evidence: Record<string, unknown>;
}

export interface RecoverySpec {
  readonly strategy: RecoveryStrategy;
  readonly disconnectAfter?: number;
  readonly resumeAfterSourceIndex?: number;
}

/**
 * A checkpoint supplied to the planner. Either a full TS
 * RecoveryCheckpoint (its `capturedState` is REQUIRED — a checkpoint
 * without a captured state cannot be used) or the empty-base marker
 * `{ empty: true }` (N06: full replay from the empty state).
 */
export type CheckpointInput =
  | RecoveryCheckpoint
  | { readonly empty: true }
  | null
  | undefined;

export interface ReplayFixture {
  readonly scenarioId: string;
  /** Pre-expansion events, in import (arrival) order. */
  readonly events: readonly NormalizedEvent[];
  readonly recovery: RecoverySpec & {
    readonly checkpoint?: CheckpointInput;
    readonly injections?: readonly Injection[];
  };
}

export interface PathResult {
  readonly finalStateHash: string;
  readonly messages: RejoinState["messages"];
  readonly toolCalls: RejoinState["toolCalls"];
  readonly sharedState: unknown;
  readonly pendingToolCallIds: readonly string[];
  readonly runStatus: RejoinState["runStatus"];
}

export interface DualTrackEvaluation {
  readonly scenarioId: string;
  readonly verdict: Verdict;
  readonly diagnostics: readonly ReplayDiagnostic[];
  /** First divergence sourceIndex (T004 step comparison from the
   * checkpoint), or null when the compared steps all agree. */
  readonly firstDivergence: FirstDivergence | null;
  readonly fullState: RejoinState | null;
  readonly resumeState: RejoinState | null;
  readonly fullPath: PathResult | null;
  readonly resumePath: PathResult | null;
  /** sourceIndex values of events the injections dropped. */
  readonly droppedSourceIndices: readonly number[];
  readonly checkpointIndex: number;
  readonly metrics: { readonly visitedStates: number };
}

export interface TrackFold {
  readonly state: RejoinState;
  readonly diagnostics: ReplayDiagnostic[];
  readonly history: StateHistoryEntry[];
}

/** Hard ReducerError codes translated into report diagnostics by the
 * replay fold. Codes not listed here fall back to OUT_OF_ORDER
 * (CRITICAL): an event that cannot be applied in arrival order.
 * Deliberately absent: FINISH_WITHOUT_START, FINISH_WRONG_RUN and
 * PENDING_TOOL_CALL_MISMATCH — those three RUN_FINISHED lifecycle
 * violations are rethrown as [INVALID_INPUT] in the foldTrack catch
 * below (ADR-004), never mapped to a diagnostic here. */
const REDUCER_ERROR_TO_DIAGNOSTIC: Readonly<Record<
  string,
  { code: string; severity: DiagnosticSeverity }
>> = {
  CONTENT_WITHOUT_START: { code: "OUT_OF_ORDER", severity: "CRITICAL" },
  ARGS_WITHOUT_START: { code: "OUT_OF_ORDER", severity: "CRITICAL" },
  END_WITHOUT_START: { code: "OUT_OF_ORDER", severity: "CRITICAL" },
  RESULT_WITHOUT_CALL: { code: "OUT_OF_ORDER", severity: "CRITICAL" },
  RESULT_FOR_INCOMPLETE_CALL: { code: "OUT_OF_ORDER", severity: "CRITICAL" },
  DUPLICATE_TOOL_CALL_RESULT: { code: "DUPLICATE_TOOL_CALL", severity: "CRITICAL" },
  DUPLICATE_MESSAGE_START: { code: "OUT_OF_ORDER", severity: "CRITICAL" },
  DUPLICATE_MESSAGE_ID: { code: "OUT_OF_ORDER", severity: "CRITICAL" },
  MESSAGE_REOPEN_ROLE_MISMATCH: { code: "OUT_OF_ORDER", severity: "CRITICAL" },
  MESSAGE_REOPEN_NAME_MISMATCH: { code: "OUT_OF_ORDER", severity: "CRITICAL" },
  REOPEN_INCOMPLETE_MESSAGE: { code: "OUT_OF_ORDER", severity: "CRITICAL" },
  REOPEN_INCOMPLETE_TOOL_CALL: { code: "OUT_OF_ORDER", severity: "CRITICAL" },
  TOOL_CALL_REOPEN_NAME_MISMATCH: { code: "TOOL_CALL_ID_REUSE", severity: "WARNING" },
  TOOL_CALL_ID_REUSE: { code: "TOOL_CALL_ID_REUSE", severity: "WARNING" },
  EVENT_WITHOUT_RUN: { code: "OUT_OF_ORDER", severity: "CRITICAL" },
  DUPLICATE_RUN_ID: { code: "OUT_OF_ORDER", severity: "CRITICAL" },
  RUN_ALREADY_RUNNING: { code: "OUT_OF_ORDER", severity: "CRITICAL" },
  THREAD_MISMATCH: { code: "OUT_OF_ORDER", severity: "CRITICAL" },
  RUN_INPUT_MISMATCH: { code: "OUT_OF_ORDER", severity: "CRITICAL" },
};

function diagnostic(
  code: string,
  severity: DiagnosticSeverity,
  message: string,
  sourceIndex?: number,
  evidence: Record<string, unknown> = {},
  relatedSourceIndices?: number[],
): ReplayDiagnostic {
  return {
    code,
    severity,
    ...(sourceIndex !== undefined ? { sourceIndex } : {}),
    ...(relatedSourceIndices !== undefined ? { relatedSourceIndices } : {}),
    message,
    evidence,
  };
}

/**
 * Fold an ALREADY-EXPANDED event sequence from `initial`, recording
 * one history entry (sourceIndex, cloned state) per event. Callers
 * must expand chunks first (expandChunks): this function deliberately
 * does NOT re-expand, because re-expansion would re-number
 * sourceIndex values from 0 in emission order and erase injected
 * reorderings (e.g. a SWAP_ADJACENT) from the history.
 *
 * `appliedThrough` is the sourceIndex the initial state already
 * covers (-1 for an empty base): a TOOL_CALL_START at or below it
 * for an already-closed call is a replay duplicate (AG-UI #1524),
 * not a legal reopen. The fold never throws ReducerError for
 * replay-shaped violations — see the module header.
 */
export function foldTrack(
  events: readonly NormalizedEvent[],
  initial: RejoinState,
  appliedThrough = -1,
): TrackFold {
  const expanded = events;
  let state: RejoinState = cloneState(initial);
  const diagnostics: ReplayDiagnostic[] = [];
  const history: StateHistoryEntry[] = [];
  const seenToolStarts = new Set<number>();
  const appliedPayloads = new Set<string>();

  for (const wrapper of expanded) {
    const event = wrapper.event;
    const sourceIndex = wrapper.sourceIndex;
    const diagnosticsBefore = state.diagnostics.length;
    let handled = false;

    // --- TOOL_CALL_START: replay / duplicate / incomplete-reopen ---
    if (event.type === "TOOL_CALL_START") {
      const replayedInFold = seenToolStarts.has(sourceIndex);
      seenToolStarts.add(sourceIndex);
      const existing = state.toolCalls.find((t) => t.id === event.toolCallId);
      if (existing !== undefined && existing.status === "open") {
        // Replay of an already-open call: harmless no-op (Oracle).
        handled = true;
      } else if (
        existing !== undefined &&
        (sourceIndex <= appliedThrough || replayedInFold)
      ) {
        // Closed/resulted call started again over already-applied
        // state: a duplicate (AG-UI #1524). Recorded as a SECOND
        // tool-call entry, so the divergence stays visible in the
        // state (PROJECT_BOOK §13.3 sample: resume toolCalls holds
        // the id twice).
        const duplicate: RejoinState["toolCalls"][number] = {
          id: event.toolCallId,
          name: event.toolCallName,
          ...(event.parentMessageId !== undefined
            ? { parentMessageId: event.parentMessageId }
            : {}),
          arguments: "",
          status: "open",
          hasResult: false,
          runId: currentRunId(state),
        };
        state = {
          ...state,
          toolCalls: [...state.toolCalls, duplicate],
        };
        state = appendTimeline(state, {
          kind: "tool-call",
          eventType: "TOOL_CALL_START",
          toolCallId: event.toolCallId,
          ...(event.parentMessageId !== undefined
            ? { messageId: event.parentMessageId }
            : {}),
        });
        diagnostics.push(
          diagnostic(
            "DUPLICATE_TOOL_CALL",
            "CRITICAL",
            `Tool call "${event.toolCallId}" already present was started again ` +
              `(AG-UI #1524: a replayed TOOL_CALL_START over already-applied state).`,
            sourceIndex,
            {
              toolCallId: event.toolCallId,
              ...(event.parentMessageId !== undefined
                ? { parentMessageId: event.parentMessageId }
                : {}),
            },
            [sourceIndex],
          ),
        );
        handled = true;
      } else if (existing !== undefined && existing.status === "incomplete") {
        // The Oracle reopens an incomplete call when name/parent
        // agree; the strict Reducer throws. Reopen manually.
        if (
          existing.name !== event.toolCallName ||
          (existing.parentMessageId ?? undefined) !==
            (event.parentMessageId ?? undefined)
        ) {
          diagnostics.push(
            diagnostic(
              "TOOL_CALL_ID_REUSE",
              "WARNING",
              `Tool call "${event.toolCallId}" reopened with a different name or parent message.`,
              sourceIndex,
              { toolCallId: event.toolCallId },
            ),
          );
        } else {
          state = {
            ...state,
            toolCalls: state.toolCalls.map((t) =>
              t.id === event.toolCallId
                ? {
                    ...t,
                    status: "open" as const,
                    hasResult: false,
                    resultMessageId: undefined,
                    resultContent: undefined,
                    runId: currentRunId(state),
                  }
                : t,
            ),
          };
          state = appendTimeline(state, {
            kind: "tool-call",
            eventType: "TOOL_CALL_START",
            toolCallId: event.toolCallId,
            ...(event.parentMessageId !== undefined
              ? { messageId: event.parentMessageId }
              : {}),
          });
        }
        handled = true;
      }
    }

    // --- TEXT_MESSAGE_START: replay over open / mismatched reopen ---
    if (!handled && event.type === "TEXT_MESSAGE_START") {
      const existing = state.messages.find((m) => m.id === event.messageId);
      if (existing !== undefined && existing.status === "open") {
        // Replay of an already-open message: harmless no-op (Oracle).
        handled = true;
      } else if (existing !== undefined) {
        const effectiveRole = event.role ?? "assistant";
        if (
          existing.role !== effectiveRole ||
          (existing.name ?? undefined) !== (event.name ?? undefined)
        ) {
          diagnostics.push(
            diagnostic(
              "OUT_OF_ORDER",
              "CRITICAL",
              `Reopened message "${event.messageId}" changed role or name.`,
              sourceIndex,
              {
                messageId: event.messageId,
                expectedRole: existing.role,
                actualRole: effectiveRole,
              },
            ),
          );
          handled = true;
        } else if (existing.status === "incomplete") {
          // The Oracle reopens an incomplete message when role/name
          // agree; the strict Reducer throws. Reopen manually — and
          // open a NEW segment, exactly as the Reducer's legal reopen
          // does (FIX-T003-G03): the resumed text is a second segment.
          state = {
            ...state,
            messages: state.messages.map((m) =>
              m.id === event.messageId
                ? {
                    ...m,
                    segments: [...m.segments, { text: "" }],
                    status: "open" as const,
                  }
                : m,
            ),
          };
          state = appendTimeline(state, {
            kind: "message",
            eventType: "TEXT_MESSAGE_START",
            messageId: event.messageId,
          });
          handled = true;
        }
      }
    }

    // --- SUSPECTED_DUPLICATE pre-check (CONTENT / ARGS) ---
    if (!handled && event.type === "TEXT_MESSAGE_CONTENT") {
      const message = state.messages.find((m) => m.id === event.messageId);
      if (message !== undefined && message.status === "open") {
        const key = `TEXT_MESSAGE_CONTENT|${event.messageId}|${event.delta}`;
        if (appliedPayloads.has(key) && wrapper.sourceEventKey === null) {
          diagnostics.push(
            diagnostic(
              "SUSPECTED_DUPLICATE",
              "WARNING",
              `Identical text content applied again with no stable event id ` +
                `(PROJECT_BOOK §4.3: suspected duplicate, never auto-deduplicated).`,
              sourceIndex,
              { messageId: event.messageId, delta: event.delta },
            ),
          );
        }
        appliedPayloads.add(key);
      }
    }
    if (!handled && event.type === "TOOL_CALL_ARGS") {
      const call = state.toolCalls.find(
        (t) => t.id === event.toolCallId && t.status === "open",
      );
      if (call !== undefined) {
        const key = `TOOL_CALL_ARGS|${event.toolCallId}|${event.delta}`;
        if (appliedPayloads.has(key) && wrapper.sourceEventKey === null) {
          diagnostics.push(
            diagnostic(
              "SUSPECTED_DUPLICATE",
              "WARNING",
              `Identical tool args applied again with no stable event id ` +
                `(PROJECT_BOOK §4.3: suspected duplicate, never auto-deduplicated).`,
              sourceIndex,
              { toolCallId: event.toolCallId, delta: event.delta },
            ),
          );
        }
        appliedPayloads.add(key);
      }
    }

    // --- TOOL_CALL_ARGS / END / RESULT: target the open (or
    // unresulted) entry when a replay duplicate exists. The strict
    // Reducer always addresses the FIRST entry with an id; after a
    // DUPLICATE_TOOL_CALL the live entry is the later duplicate
    // (Oracle _find_tool_call(want_open=True) / first-with-no-result).
    // Without this, replayed ARGS/END would throw against the
    // already-closed original and the duplicate could never close.
    if (!handled && event.type === "TOOL_CALL_ARGS") {
      const entries = state.toolCalls.filter((t) => t.id === event.toolCallId);
      const first = entries[0];
      const openEntry = [...entries].reverse().find((t) => t.status === "open");
      if (openEntry !== undefined && first !== undefined && openEntry !== first) {
        state = {
          ...state,
          toolCalls: state.toolCalls.map((t) =>
            t === openEntry ? { ...t, arguments: t.arguments + event.delta } : t,
          ),
        };
        state = appendTimeline(state, {
          kind: "tool-call",
          eventType: "TOOL_CALL_ARGS",
          toolCallId: event.toolCallId,
          text: event.delta,
        });
        handled = true;
      }
    }
    if (!handled && event.type === "TOOL_CALL_END") {
      const entries = state.toolCalls.filter((t) => t.id === event.toolCallId);
      const first = entries[0];
      const openEntry = [...entries].reverse().find((t) => t.status === "open");
      if (openEntry !== undefined && first !== undefined && openEntry !== first) {
        state = {
          ...state,
          toolCalls: state.toolCalls.map((t) =>
            t === openEntry ? { ...t, status: "closed" as const } : t,
          ),
        };
        state = {
          ...state,
          pendingToolCallIds: computePendingToolCallIds(state),
        };
        state = appendTimeline(state, {
          kind: "tool-call",
          eventType: "TOOL_CALL_END",
          toolCallId: event.toolCallId,
        });
        handled = true;
      }
    }
    if (!handled && event.type === "TOOL_CALL_RESULT") {
      const entries = state.toolCalls.filter((t) => t.id === event.toolCallId);
      const unresulted = entries.find((t) => !t.hasResult);
      if (entries.length > 1 && unresulted !== undefined) {
        // A result for a duplicated call answers the FIRST entry with
        // no result, by identity — never by id, which would mark
        // every entry with this id resulted (Oracle: first call with
        // no result; oracle/reference.py TOOL_CALL_RESULT branch).
        // Two shapes, one rule:
        // - first has no result yet (G01: the single RESULT arrives
        //   while both the checkpoint original [0] and the replayed
        //   duplicate [1] are unanswered) -> answer [0]; [1] stays
        //   closed without a result.
        // - first already has a result (a second RESULT arrives) ->
        //   answer the duplicate execution [1]; [0] keeps its result.
        // A single entry never takes this branch: the strict Reducer
        // still owns it (including DUPLICATE_TOOL_CALL_RESULT on a
        // second result, which the fold turns into a diagnostic).
        const content = event.content;
        state = {
          ...state,
          toolCalls: state.toolCalls.map((t) =>
            t === unresulted
              ? {
                  ...t,
                  status: "resulted" as const,
                  hasResult: true,
                  resultMessageId: event.messageId,
                  resultContent: content,
                }
              : t,
          ),
          messages: [
            ...state.messages,
            {
              id: event.messageId,
              role: "tool" as const,
              content,
              // Built from whole content: a single segment (Oracle parity).
              segments: segmentsForContent(content),
              toolCallId: event.toolCallId,
              status: "closed" as const,
              owner: "producer" as const,
            },
          ],
        };
        state = {
          ...state,
          pendingToolCallIds: computePendingToolCallIds(state),
        };
        state = appendTimeline(state, {
          kind: "tool-call",
          eventType: "TOOL_CALL_RESULT",
          messageId: event.messageId,
          toolCallId: event.toolCallId,
        });
        handled = true;
      }
    }

    // --- RUN_STARTED replay: an already-known runId (or a run that
    // is still open, or a threadId change) is a replay, not a fresh
    // run. The Oracle re-activates the known run and keeps the first
    // threadId; input is NOT re-seeded on a replay. ---
    if (!handled && event.type === "RUN_STARTED") {
      const knownRun = state.runs.find((r) => r.runId === event.runId);
      const openRun = state.runs.find((r) => r.status === "RUNNING");
      if (
        knownRun !== undefined ||
        openRun !== undefined ||
        (state.threadId !== null && state.threadId !== event.threadId)
      ) {
        if (knownRun !== undefined) {
          state = {
            ...state,
            runs: state.runs.map((r) =>
              r.runId === event.runId ? { ...r, status: "RUNNING" as const } : r,
            ),
            runStatus: "RUNNING",
          };
        } else {
          const run: RunState = {
            runId: event.runId,
            threadId: event.threadId,
            status: "RUNNING",
            ...(event.parentRunId !== undefined
              ? { parentRunId: event.parentRunId }
              : {}),
            ...(event.protocolVersion !== undefined
              ? { protocolVersion: event.protocolVersion }
              : {}),
          };
          state = {
            ...state,
            threadId: state.threadId ?? event.threadId,
            runs: [...state.runs, run],
            runStatus: "RUNNING",
          };
        }
        state = appendTimeline(state, {
          kind: "run",
          eventType: "RUN_STARTED",
          runId: event.runId,
        });
        handled = true;
      }
    }

    // --- Normal path: the strict Reducer, with errors translated. ---
    if (!handled) {
      try {
        const next = reduceEvent(state, event);
        // Harvest only the fold findings that have an Oracle/report
        // counterpart. UNCLOSED_STREAM_ITEM stays in
        // RejoinState.diagnostics (fold layer) and is mapped only by
        // the truncated-stream rule in classifyDualTrack; RUN_ERROR
        // and TOOL_CALL_RESULT_UNMATCHED_INPUT have no Oracle
        // counterpart and are not report diagnostics.
        for (let i = diagnosticsBefore; i < next.diagnostics.length; i += 1) {
          const entry = next.diagnostics[i];
          if (entry === undefined) continue;
          if (entry.code === "SNAPSHOT_MISMATCH" || entry.code === "UNKNOWN_PATCH_OP") {
            diagnostics.push(
              diagnostic(
                entry.code,
                entry.severity,
                entry.message,
                sourceIndex,
                { reducerCode: entry.code },
              ),
            );
          }
        }
        state = next;
      } catch (error) {
        if (error instanceof ReducerError) {
          // RUN_FINISHED lifecycle violations (FINISH_WITHOUT_START,
          // FINISH_WRONG_RUN, PENDING_TOOL_CALL_MISMATCH) are hard
          // input violations, not recoverable divergences: rethrow as
          // INVALID_INPUT (ADR-004). The old fallback that trusted the
          // wire outcome list and finished the run manually is removed.
          if (
            error.code === "PENDING_TOOL_CALL_MISMATCH" ||
            error.code === "FINISH_WITHOUT_START" ||
            error.code === "FINISH_WRONG_RUN" ||
            error.code === "UNSUPPORTED_EVENT" ||
            error.code === "UNEXPANDED_CHUNK"
          ) {
            throw new Error(`[INVALID_INPUT] ${error.message}`);
          } else {
            const mapped = REDUCER_ERROR_TO_DIAGNOSTIC[error.code] ?? {
              code: "OUT_OF_ORDER",
              severity: "CRITICAL" as const,
            };
            diagnostics.push(
              diagnostic(
                mapped.code,
                mapped.severity,
                error.message,
                sourceIndex,
                {
                  reducerCode: error.code,
                  ...(error.messageId !== undefined
                    ? { messageId: error.messageId }
                    : {}),
                  ...(error.toolCallId !== undefined
                    ? { toolCallId: error.toolCallId }
                    : {}),
                  ...(error.runId !== undefined ? { runId: error.runId } : {}),
                },
              ),
            );
          }
        } else {
          throw error;
        }
      }
    }

    history.push({ sourceIndex, state: cloneState(state) });
  }

  return { state, diagnostics, history };
}

/** Fold a prefix of the expanded trace (sourceIndex <= through) from empty. */
export function foldPrefix(
  expandedEvents: readonly NormalizedEvent[],
  throughIndex: number,
): RejoinState {
  if (throughIndex < 0) return initialState();
  return foldTrack(
    expandedEvents.filter((w) => w.sourceIndex <= throughIndex),
    initialState(),
    -1,
  ).state;
}

export interface ResolvedCheckpoint {
  readonly baseState: RejoinState;
  readonly checkpointIndex: number;
  /** sourceIndex of an explicitly supplied checkpoint, or null. */
  readonly explicitSourceIndex: number | null;
}

/**
 * Resolve the recovery base state (PROJECT_BOOK §4.4).
 *
 * - Explicit RecoveryCheckpoint: `capturedState` is REQUIRED and is
 *   used as the base. Dimensions the checkpoint does NOT cover fall
 *   back to the prefix fold at the checkpoint index (Oracle
 *   resolve_checkpoint): coverage.messages false restores messages +
 *   toolCalls from the prefix; coverage.sharedState false restores
 *   sharedState from the prefix.
 * - `{ empty: true }`: the empty initial state, checkpoint index -1.
 * - No checkpoint: fold the covered prefix (0..disconnectAfter).
 */
export function resolveCheckpoint(
  expandedEvents: readonly NormalizedEvent[],
  disconnectAfter: number | undefined,
  checkpoint: CheckpointInput,
): ResolvedCheckpoint {
  if (checkpoint !== null && checkpoint !== undefined && "empty" in checkpoint && checkpoint.empty) {
    return { baseState: initialState(), checkpointIndex: -1, explicitSourceIndex: null };
  }
  if (checkpoint !== null && checkpoint !== undefined && "capturedState" in checkpoint) {
    const explicit = checkpoint as RecoveryCheckpoint;
    let base = cloneState(explicit.capturedState);
    if (!explicit.coverage.sharedState || !explicit.coverage.messages) {
      const prefix = foldPrefix(expandedEvents, explicit.sourceIndex);
      if (!explicit.coverage.sharedState) {
        base = { ...base, sharedState: prefix.sharedState };
      }
      if (!explicit.coverage.messages) {
        base = {
          ...base,
          messages: prefix.messages,
          toolCalls: prefix.toolCalls,
        };
      }
    }
    return {
      baseState: base,
      checkpointIndex: explicit.sourceIndex,
      explicitSourceIndex: explicit.sourceIndex,
    };
  }
  const checkpointIndex = disconnectAfter ?? -1;
  return {
    baseState: foldPrefix(expandedEvents, checkpointIndex),
    checkpointIndex,
    explicitSourceIndex: null,
  };
}

/**
 * Build the resume event stream before injections (PROJECT_BOOK §8.3).
 * FULL_REPLAY_FROM_START re-sends the whole trace; the other two
 * strategies start after resumeAfterSourceIndex (defaulting to
 * disconnectAfter, then to the checkpoint index). The cursor is
 * local to this import file only — it is NOT an SSE Last-Event-ID
 * and NOT an AG-UI eventId (§4.5).
 */
export function buildResumeStream(
  expandedEvents: readonly NormalizedEvent[],
  strategy: RecoveryStrategy,
  disconnectAfter: number | undefined,
  resumeAfterSourceIndex: number | undefined,
  checkpointIndex: number,
): NormalizedEvent[] {
  if (strategy === "FULL_REPLAY_FROM_START") {
    return [...expandedEvents];
  }
  const resumeAfter =
    resumeAfterSourceIndex ?? disconnectAfter ?? checkpointIndex;
  return expandedEvents.filter((w) => w.sourceIndex > resumeAfter);
}

function pathResult(state: RejoinState): PathResult {
  return {
    finalStateHash: stateHash(state),
    messages: state.messages,
    toolCalls: state.toolCalls,
    sharedState: state.sharedState,
    pendingToolCallIds: state.pendingToolCallIds,
    runStatus: state.runStatus,
  };
}

function messageRoleOrder(state: RejoinState): string[] {
  return state.messages.map((m) => m.role);
}

/**
 * Segment-interleave check (AG-UI #3368, PROJECT_BOOK §5.6).
 *
 * Mirrors Oracle replay._segment_interleave_lost exactly: a message
 * whose FULL-path segments are >= 2 and whose TEXT_MESSAGE_CONTENT
 * entries in the full orderedTimeline straddle a tool-call entry
 * (first text position < tool position < last text position) has
 * lost its interleave when the resume path holds the same message
 * with ONE segment and identical `content`. Returns that messageId,
 * or null. (FIX-T003-G03: this was a stub returning null because TS
 * MessageState had no segments field — a merged checkpoint was
 * state-identical to the full path. With segments in the model the
 * merge is observable, and the check is real.)
 *
 * Timeline positions are indices into orderedTimeline (Oracle uses
 * enumerate() over its timeline the same way); TEXT positions are
 * TEXT_MESSAGE_CONTENT entries for this message (Oracle kind "text"),
 * tool positions are any tool-call entry (Oracle kinds tool_start /
 * tool_args / tool_end / tool_result).
 */
export function segmentInterleaveLost(
  fullState: RejoinState,
  resumeState: RejoinState,
): string | null {
  const resumeById = new Map(resumeState.messages.map((m) => [m.id, m]));
  for (const message of fullState.messages) {
    if (message.segments.length < 2) continue;
    const textPositions: number[] = [];
    const toolPositions: number[] = [];
    fullState.orderedTimeline.forEach((item, index) => {
      if (
        item.eventType === "TEXT_MESSAGE_CONTENT" &&
        item.messageId === message.id
      ) {
        textPositions.push(index);
      }
      if (item.kind === "tool-call") toolPositions.push(index);
    });
    if (textPositions.length === 0 || toolPositions.length === 0) continue;
    const firstText = textPositions[0] as number;
    const lastText = textPositions[textPositions.length - 1] as number;
    const interleaved = toolPositions.some(
      (tool) => firstText < tool && tool < lastText,
    );
    if (!interleaved) continue;
    const resumeMessage = resumeById.get(message.id);
    if (resumeMessage === undefined) continue;
    if (
      resumeMessage.segments.length === 1 &&
      jsonDeepEqual(resumeMessage.content, message.content)
    ) {
      return message.id;
    }
  }
  return null;
}

function firstOccurrenceOrder(indices: readonly number[]): number[] {
  const seen: number[] = [];
  for (const index of indices) {
    if (!seen.includes(index)) seen.push(index);
  }
  return seen;
}

export interface ClassifyInput {
  readonly fullState: RejoinState;
  readonly resumeState: RejoinState;
  readonly baseState: RejoinState;
  readonly resumeDiagnostics: readonly ReplayDiagnostic[];
  readonly dropped: readonly NormalizedEvent[];
  readonly fullHistory: readonly StateHistoryEntry[];
  readonly resumeHistory: readonly StateHistoryEntry[];
  readonly expandedEvents: readonly NormalizedEvent[];
  readonly checkpointIndex: number;
  readonly explicitSourceIndex: number | null;
  readonly disconnectAfter: number | undefined;
  readonly injections: readonly Injection[];
}

/**
 * Classify a dual-track result into diagnostics + verdict, mirroring
 * Oracle replay.evaluate()'s post-fold classification (same order of
 * checks, same sort, same truncated-stream handling).
 *
 * The UNCLOSED_STREAM_ITEM -> TRUNCATED_RUN mapping (see the module
 * header) is realised here: TRUNCATED_RUN is emitted if and only if
 * the FULL stream lacks a terminating event (runStatus RUNNING /
 * NOT_STARTED with events present). Fold-layer UNCLOSED_STREAM_ITEM
 * entries are never copied into the report.
 */
export function classifyDualTrack(input: ClassifyInput): {
  verdict: Verdict;
  diagnostics: ReplayDiagnostic[];
} {
  const {
    fullState,
    resumeState,
    baseState,
    fullHistory,
    resumeHistory,
    expandedEvents,
    checkpointIndex,
    explicitSourceIndex,
    disconnectAfter,
    injections,
  } = input;
  const diagnostics: ReplayDiagnostic[] = [...input.resumeDiagnostics];
  const diverged = stateHash(fullState) !== stateHash(resumeState);
  const truncated =
    (fullState.runStatus === "RUNNING" || fullState.runStatus === "NOT_STARTED") &&
    expandedEvents.length > 0;

  if (diverged || diagnostics.length > 0) {
    // Stale-checkpoint snapshot mismatch (G06): the recovery base
    // claims an older sourceIndex than the disconnect point (an
    // explicit stale checkpoint, or a STALE_SNAPSHOT injection) and
    // its shared state disagrees with the full prefix at the
    // disconnect point.
    let staleSourceIndex: number | null = null;
    if (
      explicitSourceIndex !== null &&
      disconnectAfter !== undefined &&
      disconnectAfter !== null &&
      explicitSourceIndex < disconnectAfter
    ) {
      staleSourceIndex = explicitSourceIndex;
    }
    if (injections.some((inj) => inj.op === "STALE_SNAPSHOT")) {
      const firstSnapshot = expandedEvents.find(
        (w) => w.event.type === "STATE_SNAPSHOT",
      );
      staleSourceIndex =
        firstSnapshot !== undefined ? firstSnapshot.sourceIndex : null;
    }
    if (
      staleSourceIndex !== null &&
      disconnectAfter !== undefined &&
      disconnectAfter !== null
    ) {
      const prefixState = foldPrefix(expandedEvents, disconnectAfter);
      if (
        !jsonDeepEqual(prefixState.sharedState, baseState.sharedState) &&
        !diagnostics.some((d) => d.code === "SNAPSHOT_MISMATCH")
      ) {
        diagnostics.push(
          diagnostic(
            "SNAPSHOT_MISMATCH",
            "CRITICAL",
            "Recovery checkpoint is older than the disconnect point and its shared state disagrees with the full prefix.",
            staleSourceIndex,
            {
              checkpointIndex: staleSourceIndex,
              disconnectAfter,
              expectedSharedState: prefixState.sharedState,
              actualSharedState: baseState.sharedState,
            },
            [disconnectAfter],
          ),
        );
      }
    }

    // Message order (G02): compare the role order of the two paths.
    if (
      JSON.stringify(messageRoleOrder(fullState)) !==
        JSON.stringify(messageRoleOrder(resumeState)) &&
      !diagnostics.some((d) => d.code === "MESSAGE_REORDER")
    ) {
      diagnostics.push(
        diagnostic(
          "MESSAGE_REORDER",
          "CRITICAL",
          "Final message order differs from the full path.",
          checkpointIndex,
          {
            expectedOrder: fullState.messages.map((m) => m.id),
            actualOrder: resumeState.messages.map((m) => m.id),
            expectedRoles: messageRoleOrder(fullState),
            actualRoles: messageRoleOrder(resumeState),
          },
        ),
      );
    }

    // Segment interleave lost (G03): a full-path message with >= 2
    // segments interleaved with a tool call collapsed to one segment
    // in the resume path (segmentInterleaveLost, Oracle parity).
    const mergedId = segmentInterleaveLost(fullState, resumeState);
    if (
      mergedId !== null &&
      !diagnostics.some((d) => d.code === "MESSAGE_REORDER")
    ) {
      diagnostics.push(
        diagnostic(
          "MESSAGE_REORDER",
          "CRITICAL",
          "A message reopened after a tool call lost its text/tool interleave in the resume path.",
          checkpointIndex,
          { messageId: mergedId },
        ),
      );
    }

    // Lost events (G04): dropped resume-stream payloads whose effect
    // is missing. Suppressed when the trace itself is truncated.
    if (!truncated) {
      const resumeMessages = new Map(
        resumeState.messages.map((m) => [m.id, m]),
      );
      const resumeCalls = new Map(
        resumeState.toolCalls.map((t) => [t.id, t]),
      );
      for (const wrapper of input.dropped) {
        const event = wrapper.event as AGUIEvent;
        let lost = false;
        if (event.type === "TEXT_MESSAGE_CONTENT") {
          const message = resumeMessages.get(event.messageId);
          const content =
            message !== undefined && typeof message.content === "string"
              ? message.content
              : "";
          lost = !content.includes(event.delta);
        } else if (event.type === "TOOL_CALL_ARGS") {
          const call = resumeCalls.get(event.toolCallId);
          lost = call === undefined || !call.arguments.includes(event.delta);
        } else if (event.type === "TOOL_CALL_RESULT") {
          const call = resumeCalls.get(event.toolCallId);
          lost = call === undefined || !call.hasResult;
        }
        if (
          lost &&
          !diagnostics.some(
            (d) => d.code === "LOST_EVENT" && d.sourceIndex === wrapper.sourceIndex,
          )
        ) {
          diagnostics.push(
            diagnostic(
              "LOST_EVENT",
              "CRITICAL",
              "An event from the full trace did not reach the resume path and its effect is missing.",
              wrapper.sourceIndex,
              { sourceIndex: wrapper.sourceIndex },
              [wrapper.sourceIndex],
            ),
          );
        }
      }
    }

    // Order permutation (G05): the resume stream applied the same
    // events in a different order and the states diverged.
    if (!diagnostics.some((d) => d.code === "OUT_OF_ORDER")) {
      const fullOrder = firstOccurrenceOrder(
        fullHistory.map((entry) => entry.sourceIndex),
      );
      const resumeOrder = firstOccurrenceOrder(
        resumeHistory.map((entry) => entry.sourceIndex),
      );
      const common = fullOrder.filter((i) => resumeOrder.includes(i));
      const resumeCommon = resumeOrder.filter((i) => fullOrder.includes(i));
      if (common.length >= 2 && JSON.stringify(common) !== JSON.stringify(resumeCommon)) {
        const firstDiff = common.findIndex(
          (value, i) => value !== resumeCommon[i],
        );
        diagnostics.push(
          diagnostic(
            "OUT_OF_ORDER",
            "CRITICAL",
            "The resume path applied events in a different order than the full path.",
            common[firstDiff] as number,
            { expectedOrder: common, actualOrder: resumeCommon },
          ),
        );
      }
    }

    if (diverged && !truncated && diagnostics.length === 0) {
      diagnostics.push(
        diagnostic(
          "DIVERGENT_STATE",
          "CRITICAL",
          "Canonical full and resume states differ.",
          undefined,
          {
            fullStateHash: stateHash(fullState),
            resumeStateHash: stateHash(resumeState),
          },
        ),
      );
    }
  }

  // Deterministic diagnostic order: sourceIndex ascending, nulls last,
  // then code (mirrors Oracle's sort key).
  diagnostics.sort((a, b) => {
    const aNull = a.sourceIndex === undefined ? 1 : 0;
    const bNull = b.sourceIndex === undefined ? 1 : 0;
    if (aNull !== bNull) return aNull - bNull;
    if (a.sourceIndex !== b.sourceIndex) {
      return (a.sourceIndex ?? 0) - (b.sourceIndex ?? 0);
    }
    return a.code < b.code ? -1 : a.code > b.code ? 1 : 0;
  });

  const hasCritical = diagnostics.some((d) => d.severity === "CRITICAL");
  let verdict: Verdict;
  if (hasCritical) {
    verdict = "INCONSISTENT";
  } else if (truncated) {
    verdict = "INCOMPLETE_TRACE";
    // Report-layer mapping of the fold layer's UNCLOSED_STREAM_ITEM:
    // emitted here, and only here, when the stream actually lacks a
    // terminating event.
    diagnostics.push(
      diagnostic(
        "TRUNCATED_RUN",
        "WARNING",
        "The stream ended before a terminal event (RUN_FINISHED / RUN_ERROR).",
        expandedEvents.length - 1,
        {
          lastSourceIndex: expandedEvents.length - 1,
          runStatus: fullState.runStatus,
        },
      ),
    );
  } else if (diverged) {
    verdict = "INCONSISTENT";
  } else {
    verdict = "CONSISTENT";
  }
  return { verdict, diagnostics };
}

/**
 * Evaluate one fixture end to end (no BFS): full fold, checkpoint
 * resolution, resume-stream build, injections, resume fold,
 * classification, first divergence (T004 step comparison from the
 * checkpoint — see align.ts).
 */
export function evaluateFixture(fixture: ReplayFixture): DualTrackEvaluation {
  const events = fixture.events;
  const recovery = fixture.recovery;
  const injections = recovery.injections ?? [];

  if (events.length > MAX_EVENTS) {
    return {
      scenarioId: fixture.scenarioId,
      verdict: "INCONCLUSIVE_LIMIT",
      diagnostics: [
        diagnostic(
          "LIMIT_EXCEEDED",
          "WARNING",
          `Event count ${events.length} exceeds the ${MAX_EVENTS} limit.`,
          undefined,
          { eventCount: events.length },
        ),
      ],
      firstDivergence: null,
      fullState: null,
      resumeState: null,
      fullPath: null,
      resumePath: null,
      droppedSourceIndices: [],
      checkpointIndex: recovery.disconnectAfter ?? -1,
      metrics: { visitedStates: 0 },
    };
  }

  for (const wrapper of events) {
    const type = (wrapper.event as { readonly type?: unknown } | null)?.type;
    if (typeof type !== "string" || !isMvpEventType(type)) {
      return {
        scenarioId: fixture.scenarioId,
        verdict: "INVALID_INPUT",
        diagnostics: [
          diagnostic(
            "INVALID_INPUT",
            "CRITICAL",
            `Event at sourceIndex ${wrapper.sourceIndex} has unsupported or unknown type ${JSON.stringify(type)}: not one of the 15 MVP events.`,
            wrapper.sourceIndex,
            {},
          ),
        ],
        firstDivergence: null,
        fullState: null,
        resumeState: null,
        fullPath: null,
        resumePath: null,
        droppedSourceIndices: [],
        checkpointIndex: recovery.disconnectAfter ?? -1,
        metrics: { visitedStates: 0 },
      };
    }
  }

  const expanded = expandChunks(events);
  let fullFold: TrackFold;
  let resolved: ResolvedCheckpoint;
  try {
    fullFold = foldTrack(expanded, initialState(), -1);
    resolved = resolveCheckpoint(
      expanded,
      recovery.disconnectAfter,
      recovery.checkpoint,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      scenarioId: fixture.scenarioId,
      verdict: "INVALID_INPUT",
      diagnostics: [
        diagnostic("INVALID_INPUT", "CRITICAL", message, undefined, {}),
      ],
      firstDivergence: null,
      fullState: null,
      resumeState: null,
      fullPath: null,
      resumePath: null,
      droppedSourceIndices: [],
      checkpointIndex: recovery.disconnectAfter ?? -1,
      metrics: { visitedStates: 0 },
    };
  }

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

  let resumeFold: TrackFold;
  try {
    resumeFold = foldTrack(injected.stream, injected.baseState, resolved.checkpointIndex);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      scenarioId: fixture.scenarioId,
      verdict: "INVALID_INPUT",
      diagnostics: [
        diagnostic("INVALID_INPUT", "CRITICAL", message, undefined, {}),
      ],
      firstDivergence: null,
      fullState: fullFold.state,
      resumeState: null,
      fullPath: pathResult(fullFold.state),
      resumePath: null,
      droppedSourceIndices: injected.dropped.map((w) => w.sourceIndex),
      checkpointIndex: resolved.checkpointIndex,
      metrics: { visitedStates: fullFold.history.length },
    };
  }

  const { verdict, diagnostics } = classifyDualTrack({
    fullState: fullFold.state,
    resumeState: resumeFold.state,
    baseState: injected.baseState,
    resumeDiagnostics: resumeFold.diagnostics,
    dropped: injected.dropped,
    fullHistory: fullFold.history,
    resumeHistory: resumeFold.history,
    expandedEvents: expanded,
    checkpointIndex: resolved.checkpointIndex,
    explicitSourceIndex: resolved.explicitSourceIndex,
    disconnectAfter: recovery.disconnectAfter,
    injections,
  });

  const firstDivergence =
    verdict === "INCONSISTENT" || verdict === "INCOMPLETE_TRACE"
      ? findFirstDivergenceForReplay(
          fullFold.history,
          resumeFold.history,
          expanded,
          recovery.strategy,
          resolved.checkpointIndex,
          injected.baseState,
        )
      : null;

  return {
    scenarioId: fixture.scenarioId,
    verdict,
    diagnostics,
    firstDivergence,
    fullState: fullFold.state,
    resumeState: resumeFold.state,
    fullPath: pathResult(fullFold.state),
    resumePath: pathResult(resumeFold.state),
    droppedSourceIndices: injected.dropped.map((w) => w.sourceIndex),
    checkpointIndex: resolved.checkpointIndex,
    metrics: {
      visitedStates: fullFold.history.length + resumeFold.history.length,
    },
  };
}
