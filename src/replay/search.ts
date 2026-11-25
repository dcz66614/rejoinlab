/**
 * P031 RejoinLab — T005: deterministic BFS shortest fault sequence (§8.5).
 *
 * Frozen sources:
 * - PROJECT_BOOK.md v1.0.2 §8.5 (deterministic BFS, fixed operator
 *   order, first found = fewest steps, same step count -> fixed
 *   lexicographic order; depth <= 3, nodes <= 5000; on hitting the
 *   limit stop immediately and return INCONCLUSIVE_LIMIT — never
 *   report CONSISTENT by ignoring unprocessed branches), §13.3
 *   (G01 -> ["REPLAY_PREFIX"]).
 * - oracle/replay.py bfs_shortest (comparison reference only).
 *
 * BFS goal (frozen T005 ruling, formalized as ADR-002 in v1.0.1 —
 * see 00_control/ADR-002.md; a wording clarification of §8.5,
 * not an algorithm change):
 * - For a fault fixture the goal is to reproduce THAT fixture's
 *   primary diagnostic code — not "any divergence". A generic
 *   DROP_EVENT diverges almost every trace, so "any divergence"
 *   would report DROP_EVENT for every Golden and say nothing about
 *   the fault under test (§13.3 likewise shows G01 ->
 *   ["REPLAY_PREFIX"]).
 * - For a normal fixture (targetCode null) the goal is any
 *   divergence from CONSISTENT.
 * - G08's goal (TRUNCATED_RUN) is already reached by the empty
 *   sequence: the trace itself is truncated.
 *
 * Legal baseline (mirrors Oracle _legal_baseline):
 * - The search starts from the LEGAL recovery of the same events:
 *   correct checkpoint (recomputed from the covered prefix — an
 *   explicit non-empty checkpoint IS the fault in G02/G03/G06, so
 *   it is dropped), no injections. An {"empty": true} checkpoint is
 *   already the legal empty base and is kept (N06).
 * - A FULL_REPLAY over a populated checkpoint is itself the G01
 *   fault, so the baseline resumes after the checkpoint instead. A
 *   replay from the empty base (N06) stays a full replay.
 *
 * Canonical injection (mirrors Oracle _canonical_injection):
 * - CURSOR_SKIP skips only already-covered events (a legal no-op);
 *   when the resume stream actually contains events in that range
 *   the operator is inapplicable rather than a disguised DROP_EVENT.
 * - DROP_EVENT drops the first resume-stream event; DUPLICATE_EVENT
 *   duplicates the first TEXT_MESSAGE_CONTENT / TOOL_CALL_ARGS in
 *   the stream; MESSAGE_ID_REMAP renames the first assistant
 *   message in the base; REPLAY_PREFIX replays the covered prefix;
 *   STALE_SNAPSHOT uses the earliest STATE_SNAPSHOT as the base;
 *   SWAP_ADJACENT swaps the first two resume-stream events;
 *   TRUNCATE_STREAM cuts the stream at the first terminal event
 *   (or at the last event when there is none).
 * - An operator that is inapplicable here, or whose application is
 *   a no-op, makes the whole candidate sequence invalid (it cannot
 *   diverge) — the branch is skipped, never counted as a hit.
 */

import type { NormalizedEvent } from "../protocol/types.js";
import type { RejoinState } from "../core/state.js";
import {
  MAX_SEARCH_DEPTH,
  MAX_SEARCH_NODES,
  evaluateFixture,
  resolveCheckpoint,
  buildResumeStream,
  type DualTrackEvaluation,
  type ReplayFixture,
  type Verdict,
} from "./planner.js";
import {
  OPERATOR_ORDER,
  applyInjection,
  type Injection,
  type InjectionOperator,
} from "./inject.js";
import { expandChunks } from "../parser/normalize.js";

export interface BfsResult {
  /** Shortest operator sequence, [] when the goal already holds with
   * no injection, null when no sequence within the bounds reaches
   * the goal. */
  readonly sequence: string[] | null;
  /** True when the node budget was exhausted: the caller must map
   * this to INCONCLUSIVE_LIMIT, never to a verdict from partial
   * search. */
  readonly limitExceeded: boolean;
  /** Number of candidate sequences evaluated. */
  readonly visited: number;
}

export interface ReplayAnalysis {
  readonly evaluation: DualTrackEvaluation;
  readonly shortestInjectionSequence: string[] | null;
  readonly bfsLimitExceeded: boolean;
  readonly bfsVisited: number;
}

const TERMINAL_TYPES: readonly string[] = ["RUN_FINISHED", "RUN_ERROR"];

/** Deep-clone a fixture (fixtures are JSON-shaped data). */
function cloneFixture(fixture: ReplayFixture): ReplayFixture {
  return structuredClone(fixture);
}

/** The legal recovery of the same events (see the module header). */
export function legalBaseline(fixture: ReplayFixture): ReplayFixture {
  const baseline = cloneFixture(fixture);
  const recovery = baseline.recovery;
  const checkpoint = (fixture.recovery as { checkpoint?: unknown }).checkpoint;
  const isExplicitCheckpoint =
    checkpoint !== null &&
    checkpoint !== undefined &&
    typeof checkpoint === "object" &&
    !("empty" in (checkpoint as Record<string, unknown>));
  const isEmptyCheckpoint =
    checkpoint !== null &&
    checkpoint !== undefined &&
    typeof checkpoint === "object" &&
    (checkpoint as Record<string, unknown>)["empty"] === true;
  const populated =
    recovery.strategy === "FULL_REPLAY_FROM_START" &&
    !isEmptyCheckpoint &&
    recovery.disconnectAfter !== undefined &&
    recovery.disconnectAfter >= 0;
  const nextRecovery: ReplayFixture["recovery"] = {
    strategy: populated ? "RESUME_FROM_CHECKPOINT" : recovery.strategy,
    ...(recovery.disconnectAfter !== undefined
      ? { disconnectAfter: recovery.disconnectAfter }
      : {}),
    ...(populated
      ? { resumeAfterSourceIndex: recovery.disconnectAfter as number }
      : recovery.resumeAfterSourceIndex !== undefined
        ? { resumeAfterSourceIndex: recovery.resumeAfterSourceIndex }
        : {}),
    checkpoint: isExplicitCheckpoint ? null : recovery.checkpoint,
    injections: [],
  };
  return { ...baseline, recovery: nextRecovery };
}

/**
 * The single canonical application of `operator` on the clean
 * baseline. Returns null when the operator is inapplicable here.
 */
export function canonicalInjection(
  operator: InjectionOperator,
  fixture: ReplayFixture,
  baseState: RejoinState,
  stream: readonly NormalizedEvent[],
): Injection | null {
  switch (operator) {
    case "CURSOR_SKIP": {
      const checkpointIndex = fixture.recovery.disconnectAfter ?? -1;
      if (
        stream.some(
          (w) =>
            w.sourceIndex >= checkpointIndex - 1 &&
            w.sourceIndex <= checkpointIndex,
        )
      ) {
        return null;
      }
      return { op: "CURSOR_SKIP", from: checkpointIndex - 1, to: checkpointIndex };
    }
    case "DROP_EVENT": {
      if (stream.length === 0) return null;
      return { op: "DROP_EVENT", sourceIndex: (stream[0] as NormalizedEvent).sourceIndex };
    }
    case "DUPLICATE_EVENT": {
      for (const wrapper of stream) {
        if (
          wrapper.event.type === "TEXT_MESSAGE_CONTENT" ||
          wrapper.event.type === "TOOL_CALL_ARGS"
        ) {
          return { op: "DUPLICATE_EVENT", sourceIndex: wrapper.sourceIndex };
        }
      }
      return null;
    }
    case "MESSAGE_ID_REMAP": {
      const assistant = baseState.messages.find((m) => m.role === "assistant");
      if (assistant === undefined) return null;
      return {
        op: "MESSAGE_ID_REMAP",
        messageId: assistant.id,
        newMessageId: `${assistant.id}-remapped`,
      };
    }
    case "REPLAY_PREFIX":
      return { op: "REPLAY_PREFIX" };
    case "STALE_SNAPSHOT":
      return { op: "STALE_SNAPSHOT" };
    case "SWAP_ADJACENT": {
      if (stream.length < 2) return null;
      return { op: "SWAP_ADJACENT", sourceIndex: (stream[0] as NormalizedEvent).sourceIndex };
    }
    case "TRUNCATE_STREAM": {
      const terminal = stream.find((w) => TERMINAL_TYPES.includes(w.event.type));
      if (terminal !== undefined) {
        return { op: "TRUNCATE_STREAM", sourceIndex: terminal.sourceIndex };
      }
      if (stream.length > 0) {
        return {
          op: "TRUNCATE_STREAM",
          sourceIndex: (stream[stream.length - 1] as NormalizedEvent).sourceIndex,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

function goalReached(
  evaluation: DualTrackEvaluation,
  targetCode: string | null,
): boolean {
  if (targetCode === null) {
    return evaluation.verdict !== "CONSISTENT";
  }
  return evaluation.diagnostics.some((d) => d.code === targetCode);
}

/**
 * Deterministic BFS for the shortest injection sequence.
 *
 * Level-order over the fixed OPERATOR_ORDER; the first sequence that
 * reaches the goal is the shortest, and ties break by operator
 * order. Returns limitExceeded=true (sequence null) as soon as the
 * node budget is exhausted — the search stops immediately and the
 * caller must report INCONCLUSIVE_LIMIT.
 */
export function searchShortest(
  fixture: ReplayFixture,
  targetCode: string | null,
  maxDepth: number = MAX_SEARCH_DEPTH,
  maxNodes: number = MAX_SEARCH_NODES,
): BfsResult {
  const baseline = legalBaseline(fixture);
  let visited = 0;
  let limitExceeded = false;

  const evaluateSequence = (
    sequence: readonly InjectionOperator[],
  ): DualTrackEvaluation | null => {
    visited += 1;
    if (visited > maxNodes) {
      limitExceeded = true;
      return null;
    }
    const trialBase = cloneFixture(baseline);
    const expanded = expandChunks(trialBase.events);
    const resolved = resolveCheckpoint(
      expanded,
      trialBase.recovery.disconnectAfter,
      trialBase.recovery.checkpoint,
    );
    let stream = buildResumeStream(
      expanded,
      trialBase.recovery.strategy,
      trialBase.recovery.disconnectAfter,
      trialBase.recovery.resumeAfterSourceIndex,
      resolved.checkpointIndex,
    );
    let baseState = resolved.baseState;
    const injections: Injection[] = [];
    for (const operator of sequence) {
      const injection = canonicalInjection(operator, trialBase, baseState, stream);
      if (injection === null) return null;
      const result = applyInjection(stream, baseState, {
        events: expanded,
        disconnectAfter: trialBase.recovery.disconnectAfter,
      }, injection);
      if (!result.changed) return null;
      stream = result.stream;
      baseState = result.baseState;
      injections.push(injection);
    }
    const trial: ReplayFixture = {
      ...trialBase,
      recovery: { ...trialBase.recovery, injections },
    };
    return evaluateFixture(trial);
  };

  const initial = evaluateSequence([]);
  if (limitExceeded) return { sequence: null, limitExceeded: true, visited };
  if (initial !== null && goalReached(initial, targetCode)) {
    return { sequence: [], limitExceeded: false, visited };
  }

  let frontier: InjectionOperator[][] = [[]];
  for (let depth = 1; depth <= maxDepth; depth += 1) {
    const nextFrontier: InjectionOperator[][] = [];
    for (const sequence of frontier) {
      for (const operator of OPERATOR_ORDER) {
        const candidate = [...sequence, operator];
        const result = evaluateSequence(candidate);
        if (limitExceeded) {
          return { sequence: null, limitExceeded: true, visited };
        }
        if (result === null) continue;
        if (goalReached(result, targetCode)) {
          return { sequence: candidate, limitExceeded: false, visited };
        }
        nextFrontier.push(candidate);
      }
    }
    frontier = nextFrontier;
  }
  return { sequence: null, limitExceeded: false, visited };
}

/**
 * Full analysis of one fixture: dual-track evaluation plus the BFS
 * shortest sequence for `targetCode` (the fixture's primary
 * diagnostic code for fault fixtures, null for normal fixtures).
 * A BFS node-budget exhaustion turns the verdict into
 * INCONCLUSIVE_LIMIT.
 */
export function analyzeFixture(
  fixture: ReplayFixture,
  targetCode: string | null,
): ReplayAnalysis {
  const evaluation = evaluateFixture(fixture);
  if (
    evaluation.verdict === "INVALID_INPUT" ||
    evaluation.verdict === "INCONCLUSIVE_LIMIT"
  ) {
    return {
      evaluation,
      shortestInjectionSequence: null,
      bfsLimitExceeded: false,
      bfsVisited: 0,
    };
  }
  const bfs = searchShortest(fixture, targetCode);
  if (bfs.limitExceeded) {
    const limited: DualTrackEvaluation = {
      ...evaluation,
      verdict: "INCONCLUSIVE_LIMIT" as Verdict,
    };
    return {
      evaluation: limited,
      shortestInjectionSequence: null,
      bfsLimitExceeded: true,
      bfsVisited: bfs.visited,
    };
  }
  return {
    evaluation,
    shortestInjectionSequence: bfs.sequence,
    bfsLimitExceeded: false,
    bfsVisited: bfs.visited,
  };
}
