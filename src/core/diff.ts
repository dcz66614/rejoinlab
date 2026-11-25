/**
 * P031 RejoinLab — T004: deterministic state comparison + first
 * divergence location.
 *
 * Frozen sources:
 * - PROJECT_BOOK.md v1.0.0 §5.2 (canon equality is the consistency
 *   invariant), §8.6 (首个分歧定位：按源事件序号对齐、逐事件步进、
 *   输出对应事件、状态差异与相关业务 ID；无法可靠对齐时输出分支
 *   内序号和置信边界，不伪造精确事件身份), §13.2 (report schema:
 *   firstDivergence { sourceIndex?, fullStateHash, resumeStateHash,
 *   differences: [{ jsonPointer, expected, actual }] }).
 * - IMPLEMENTATION_PLAN.md v1.0.0 §5.5 (Report 接口), §6 T004 任务卡.
 *
 * What this module does — and does NOT do:
 * - It compares canonical state PROJECTIONS (the 8 protocol fields;
 *   diagnostics excluded — see canonical.ts), so two states that
 *   differ only in Reducer diagnostics compare EQUAL. Comparison is
 *   over values, never over hashes alone: a hash mismatch proves
 *   divergence, the value diff locates it field by field.
 * - Differences are JSON Pointer paths (RFC 6901) in a deterministic
 *   traversal order: object keys in JCS (UTF-16 code-unit) order,
 *   array indices ascending. differences[0] is therefore THE first
 *   difference, well-defined and reproducible. "expected" is the full
 *   path, "actual" is the resume path (§13.2 wording).
 * - It does NOT classify diagnostics or map diagnostic codes: the
 *   T003 fold codes (e.g. UNCLOSED_STREAM_ITEM, TOOL_CALL_RESULT_
 *   UNMATCHED_INPUT) vs the Oracle/report codes (e.g. TRUNCATED_RUN)
 *   mapping is T005/T007's job. This module reports only facts:
 *   paths, expected/actual values, and the first divergent position.
 * - Event identity in a divergence comes ONLY from a caller-supplied
 *   expanded NormalizedEvent sequence: the sourceIndex of a history
 *   entry is looked up in that sequence (ReducerDiagnostic itself
 *   carries no sourceIndex — §5.4's frozen reduceEvent(state, event)
 *   signature cannot see one). If the caller supplies no sequence,
 *   or no entry matches, the event fields stay undefined and a note
 *   records that the identity could not be resolved. Nothing is ever
 *   invented: an unresolvable position is reported as a branch-local
 *   index with a confidence note, per §8.6.
 * - History alignment mirrors Oracle replay._first_divergence: walk
 *   sourceIndex ascending; a resume history with no entry at an
 *   index carries forward its last known state (or the initial state
 *   before any entry); an index with no full entry is skipped.
 *   Duplicate entries for one sourceIndex (expanded chunks share the
 *   sourceIndex of their source event) keep the LAST state, i.e. the
 *   state after all events at that index.
 */

import type { NormalizedEvent } from "../protocol/types.js";
import type { RejoinState } from "./state.js";
import { initialState, jsonDeepEqual } from "./state.js";
import { canonicalizeState, projectState, stateHash } from "./canonical.js";

/** One field-level difference between the two paths. */
export interface StateDiff {
  /** RFC 6901 JSON Pointer into the canonical state projection. */
  readonly jsonPointer: string;
  /** Value on the full path (expected). Absent key -> undefined. */
  readonly expected: unknown;
  /** Value on the resume path (actual). Absent key -> undefined. */
  readonly actual: unknown;
  /** "added": key/index only in actual; "removed": only in expected. */
  readonly kind: "added" | "removed" | "changed";
}

/** Escape one reference token per RFC 6901 (~ -> ~0, / -> ~1). */
export function escapePointerToken(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Join a base pointer and one token ("" is the whole document). */
export function joinPointer(base: string, token: string): string {
  return base + "/" + escapePointerToken(token);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Recursive value diff. Deterministic order: object keys in JCS
 * order, array indices ascending. Returns [] when deeply equal.
 * `expected` is the full path, `actual` the resume path.
 */
export function diffValues(
  expected: unknown,
  actual: unknown,
  basePointer = "",
): StateDiff[] {
  if (jsonDeepEqual(expected, actual)) return [];
  if (isPlainObject(expected) && isPlainObject(actual)) {
    const keys = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
    const diffs: StateDiff[] = [];
    for (const key of keys) {
      const inExpected = Object.prototype.hasOwnProperty.call(expected, key);
      const inActual = Object.prototype.hasOwnProperty.call(actual, key);
      const pointer = joinPointer(basePointer, key);
      if (!inExpected) {
        diffs.push({
          jsonPointer: pointer,
          expected: undefined,
          actual: actual[key],
          kind: "added",
        });
      } else if (!inActual) {
        diffs.push({
          jsonPointer: pointer,
          expected: expected[key],
          actual: undefined,
          kind: "removed",
        });
      } else {
        diffs.push(...diffValues(expected[key], actual[key], pointer));
      }
    }
    return diffs;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const diffs: StateDiff[] = [];
    const max = Math.max(expected.length, actual.length);
    for (let i = 0; i < max; i += 1) {
      const pointer = joinPointer(basePointer, String(i));
      if (i >= expected.length) {
        diffs.push({
          jsonPointer: pointer,
          expected: undefined,
          actual: actual[i],
          kind: "added",
        });
      } else if (i >= actual.length) {
        diffs.push({
          jsonPointer: pointer,
          expected: expected[i],
          actual: undefined,
          kind: "removed",
        });
      } else {
        diffs.push(...diffValues(expected[i], actual[i], pointer));
      }
    }
    return diffs;
  }
  return [
    { jsonPointer: basePointer, expected, actual, kind: "changed" },
  ];
}

/**
 * Diff two states over their canonical projections (8 protocol
 * fields; diagnostics excluded). Pure: neither input is mutated.
 */
export function diffStates(
  expected: RejoinState,
  actual: RejoinState,
): StateDiff[] {
  return diffValues(projectState(expected), projectState(actual));
}

/** Result of comparing the two final states (§5.2 invariant). */
export interface PathComparison {
  /** canon(S_full) === canon(S_resume). */
  readonly equal: boolean;
  readonly fullHash: string;
  readonly resumeHash: string;
  /** All field-level differences, deterministic order. */
  readonly differences: StateDiff[];
  /** differences[0], or null when equal. */
  readonly firstDifference: StateDiff | null;
}

/** Compare the full-path and resume-path final states. */
export function comparePaths(
  fullState: RejoinState,
  resumeState: RejoinState,
): PathComparison {
  const fullHash = stateHash(fullState);
  const resumeHash = stateHash(resumeState);
  const differences =
    fullHash === resumeHash ? [] : diffStates(fullState, resumeState);
  return {
    equal: fullHash === resumeHash,
    fullHash,
    resumeHash,
    differences,
    firstDifference: differences.length > 0 ? (differences[0] as StateDiff) : null,
  };
}

/** One step of a per-event state history (T005 fold output). */
export interface StateHistoryEntry {
  /** Expanded-sequence sourceIndex (see the module header). */
  readonly sourceIndex: number;
  readonly state: RejoinState;
}

/**
 * First divergence between two per-event histories (§8.6), in the
 * §13.2 firstDivergence shape plus the resolved event identity.
 * `sourceIndex` is the first expanded-sequence index where the
 * canonical states differ. `fullStateHash` / `resumeStateHash` are
 * the canonical hashes at that step; `differences` is the field-level
 * diff at that step. `note` records alignment caveats (carried-forward
 * resume state, unresolvable event identity) instead of hiding them.
 */
export interface FirstDivergence {
  readonly sourceIndex: number;
  /** Expanded event type at sourceIndex, when resolvable. */
  readonly eventType?: string;
  /** Business ids of the divergent event, when resolvable. */
  readonly messageId?: string;
  readonly toolCallId?: string;
  readonly runId?: string;
  readonly fullStateHash: string;
  readonly resumeStateHash: string;
  readonly differences: StateDiff[];
  /** Alignment caveats; absent when the step aligned cleanly. */
  readonly note?: string;
}

function eventIdentityAt(
  events: readonly NormalizedEvent[] | undefined,
  sourceIndex: number,
): {
  eventType?: string;
  messageId?: string;
  toolCallId?: string;
  runId?: string;
} {
  if (events === undefined) return {};
  const found = events.find((item) => item.sourceIndex === sourceIndex);
  if (found === undefined) return {};
  const event = found.event as unknown as Record<string, unknown>;
  const identity: {
    eventType?: string;
    messageId?: string;
    toolCallId?: string;
    runId?: string;
  } = { eventType: found.event.type };
  if (typeof event["messageId"] === "string") {
    identity.messageId = event["messageId"];
  }
  if (typeof event["toolCallId"] === "string") {
    identity.toolCallId = event["toolCallId"];
  }
  if (typeof event["runId"] === "string") {
    identity.runId = event["runId"];
  }
  if (typeof event["parentMessageId"] === "string" && identity.messageId === undefined) {
    identity.messageId = event["parentMessageId"];
  }
  return identity;
}

/**
 * Locate the first divergence between two histories. Returns null
 * when every compared step agrees (including an empty full history).
 *
 * Alignment (mirrors Oracle replay._first_divergence):
 * - Walk the sorted union of full-history sourceIndex values.
 * - An index with no full entry is skipped.
 * - A resume history with no entry at an index carries forward its
 *   last known state; before any resume entry, the initial state is
 *   the base (its hash is the base hash).
 * - The first index where the canonical hashes differ wins.
 *
 * `events` is the caller's expanded NormalizedEvent sequence; it is
 * used ONLY to resolve the event identity at the divergent index.
 * When it is absent or has no entry at that index, the event fields
 * stay undefined and `note` says so — the position itself (the
 * branch-local sourceIndex) is still reported, per §8.6.
 */
export function findFirstDivergence(
  fullHistory: readonly StateHistoryEntry[],
  resumeHistory: readonly StateHistoryEntry[],
  events?: readonly NormalizedEvent[],
): FirstDivergence | null {
  if (fullHistory.length === 0) return null;

  // Last entry per sourceIndex wins (expanded chunks share one index).
  const fullByIndex = new Map<number, RejoinState>();
  for (const entry of fullHistory) {
    fullByIndex.set(entry.sourceIndex, entry.state);
  }
  const resumeByIndex = new Map<number, RejoinState>();
  for (const entry of resumeHistory) {
    resumeByIndex.set(entry.sourceIndex, entry.state);
  }

  const indices = [...fullByIndex.keys()].sort((a, b) => a - b);
  let carriedResumeState: RejoinState = initialState();
  let carriedResumeHash = stateHash(carriedResumeState);
  let carriedFrom: number | null = null;

  for (const index of indices) {
    const fullState = fullByIndex.get(index) as RejoinState;
    const fullHash = stateHash(fullState);
    const resumeEntry = resumeByIndex.get(index);
    if (resumeEntry !== undefined) {
      carriedResumeState = resumeEntry;
      carriedResumeHash = stateHash(resumeEntry);
      carriedFrom = index;
    }
    if (fullHash !== carriedResumeHash) {
      const identity = eventIdentityAt(events, index);
      const notes: string[] = [];
      if (resumeEntry === undefined) {
        notes.push(
          carriedFrom === null
            ? "no resume entry at or before this index; compared against the initial state"
            : `no resume entry at this index; resume state carried forward from sourceIndex ${carriedFrom}`,
        );
      }
      if (events === undefined) {
        notes.push("no expanded event sequence supplied; event identity not resolved");
      } else if (identity.eventType === undefined) {
        notes.push(`no expanded event found at sourceIndex ${index}; event identity not resolved`);
      }
      return {
        sourceIndex: index,
        ...identity,
        fullStateHash: fullHash,
        resumeStateHash: carriedResumeHash,
        differences: diffStates(fullState, carriedResumeState),
        ...(notes.length > 0 ? { note: notes.join("; ") } : {}),
      };
    }
  }
  return null;
}

/** Canonical JSON string of a state (re-exported convenience). */
export { canonicalizeState } from "./canonical.js";
