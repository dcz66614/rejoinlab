/**
 * P031 RejoinLab — T005: first-divergence alignment (§8.6).
 *
 * Frozen sources:
 * - PROJECT_BOOK.md v1.0.0 §8.6 (align by source event number, step
 *   through canonical states, report the first differing position;
 *   when alignment is unreliable report the branch-local index and a
 *   confidence note, never invent an exact event identity).
 * - T004 src/core/diff.ts findFirstDivergence (the step-comparison
 *   implementation this module delegates to).
 *
 * How histories are passed (frozen T005 ruling):
 * - Histories are passed FROM THE CHECKPOINT onward. The full
 *   history is sliced to sourceIndex >= checkpointIndex. The resume
 *   history is seeded with one entry at the checkpoint index carrying
 *   the recovery base state, AND keeps all of its own entries: at
 *   the checkpoint index a replayed entry (FULL_REPLAY_FROM_START)
 *   overrides the seed, so the comparison at the checkpoint itself
 *   is "full prefix state vs the state after the replayed prefix".
 *   Later steps carry the last resume entry forward until the resume
 *   stream produces the next one. This applies to ALL THREE
 *   strategies, including FULL_REPLAY_FROM_START: an unsliced
 *   comparison would already diverge at sourceIndex 0, because the
 *   resume state at index 0 already carries the checkpoint's whole
 *   timeline — that is an artefact of aligning by sourceIndex, not
 *   a located fault.
 *
 * FIX-R1 (P1-R1-01): the Oracle's diagnostics-priority branch was
 * removed — oracle/replay.py _first_divergence is now the same
 * sliced step comparison used here (PROJECT_BOOK §8.6), and the two
 * implementations agree on 24/24 (S0 gate). The distinction remains
 * and must never be re-merged: a diagnostic sourceIndex is the event
 * that triggered the fault, the first-divergence sourceIndex is the
 * first position where the two canonical states differ. G01 is the
 * standing example: the DUPLICATE_TOOL_CALL diagnostic carries
 * sourceIndex 2 (the replayed TOOL_CALL_START) in BOTH
 * implementations, while firstDivergence reports 4 (TOOL_CALL_END,
 * the first sliced index at which the duplicate is visible in the
 * state). No logic change was needed on the TS side — it was
 * already correct.
 */

import type { NormalizedEvent } from "../protocol/types.js";
import type { RejoinState } from "../core/state.js";
import {
  findFirstDivergence,
  type FirstDivergence,
  type StateHistoryEntry,
} from "../core/diff.js";
import type { RecoveryStrategy } from "./planner.js";

/**
 * Locate the first divergence between the full-path and resume-path
 * histories, aligned from the checkpoint onward (see the module
 * header). Returns null when every compared step agrees.
 *
 * `baseState` is the recovery base (the checkpoint state); it is
 * seeded as the resume history's entry at `checkpointIndex`.
 * `events` is the expanded event sequence, used ONLY to resolve the
 * event identity at the divergent index — never invented.
 */
export function findFirstDivergenceForReplay(
  fullHistory: readonly StateHistoryEntry[],
  resumeHistory: readonly StateHistoryEntry[],
  events: readonly NormalizedEvent[],
  strategy: RecoveryStrategy,
  checkpointIndex: number,
  baseState: RejoinState,
): FirstDivergence | null {
  void strategy; // The checkpoint-relative alignment is strategy-independent.
  const fullSliced = fullHistory.filter(
    (entry) => entry.sourceIndex >= checkpointIndex,
  );
  if (fullSliced.length === 0) return null;
  // Seed with the base state at the checkpoint; keep every resume
  // entry (a replayed entry AT the checkpoint overrides the seed —
  // findFirstDivergence keeps the last entry per sourceIndex).
  const resumeSeeded: StateHistoryEntry[] = [
    { sourceIndex: checkpointIndex, state: baseState },
    ...resumeHistory,
  ];
  return findFirstDivergence(fullSliced, resumeSeeded, events);
}

export type { FirstDivergence, StateHistoryEntry };
