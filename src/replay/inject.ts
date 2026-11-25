/**
 * P031 RejoinLab — T005: deterministic fault injection (§8.4).
 *
 * Frozen sources:
 * - PROJECT_BOOK.md v1.0.0 §8.4 (8 operators), §8.5 (fixed operator
 *   order), §4.2 (no eventId is ever added to an AG-UI event).
 * - IMPLEMENTATION_PLAN.md v1.0.0 §6 T005 task card.
 * - oracle/replay.py apply_injection (comparison reference only; this
 *   implementation is written independently against the frozen spec and
 *   the TS state shapes — it does not copy Oracle code).
 *
 * Rules:
 * - Injections operate on EXPANDED NormalizedEvent sequences (chunks
 *   already expanded by expandChunks) and on a RejoinState base. They
 *   never mutate their inputs (every stream/base value is cloned first)
 *   and never add an `eventId` field to any AG-UI event.
 * - `changed` is false when the operator could not apply here (target
 *   absent, range empty, no snapshot to go stale from, ...). Callers
 *   (BFS) treat a no-op application as an inapplicable branch, never
 *   as a divergence.
 * - MESSAGE_ID_REMAP models the AG-UI #3119 reconciliation behaviour:
 *   the renamed message is moved to the END of the message list (both
 *   in the base state and inside any MESSAGES_SNAPSHOT event in the
 *   stream); references (messageId / parentMessageId) are renamed
 *   consistently. A bare rename with no order change would only be
 *   DIVERGENT_STATE, not MESSAGE_REORDER.
 * - STALE_SNAPSHOT re-folds the trace prefix through the FIRST
 *   STATE_SNAPSHOT event and uses that as the recovery base. With no
 *   STATE_SNAPSHOT in the trace it is inapplicable (changed: false).
 * - CURSOR_SKIP drops stream events whose sourceIndex lies in
 *   [from, to]. Skipping only already-covered events is a legal no-op
 *   (the canonical BFS form relies on this); skipping uncovered events
 *   is a DROP_EVENT in effect and is reported as a change here.
 */

import type { NormalizedEvent } from "../protocol/types.js";
import type { MessageState, RejoinState } from "../core/state.js";
import { cloneState } from "../core/state.js";
import { reduceEvents } from "../core/reducer.js";

/** The 8 frozen injection operators, in the frozen lexicographic order
 * (PROJECT_BOOK §8.5). BFS must iterate exactly this order. */
export const OPERATOR_ORDER: readonly InjectionOperator[] = [
  "CURSOR_SKIP",
  "DROP_EVENT",
  "DUPLICATE_EVENT",
  "MESSAGE_ID_REMAP",
  "REPLAY_PREFIX",
  "STALE_SNAPSHOT",
  "SWAP_ADJACENT",
  "TRUNCATE_STREAM",
] as const;

export type InjectionOperator =
  | "CURSOR_SKIP"
  | "DROP_EVENT"
  | "DUPLICATE_EVENT"
  | "MESSAGE_ID_REMAP"
  | "REPLAY_PREFIX"
  | "STALE_SNAPSHOT"
  | "SWAP_ADJACENT"
  | "TRUNCATE_STREAM";

/**
 * One injection. Only the fields the operator needs are set:
 * DROP_EVENT / DUPLICATE_EVENT / SWAP_ADJACENT / TRUNCATE_STREAM use
 * `sourceIndex`; CURSOR_SKIP uses `from`/`to`; MESSAGE_ID_REMAP uses
 * `messageId` (default: first assistant message in the base) and
 * `newMessageId` (default: `<old>-remapped`).
 */
export interface Injection {
  readonly op: InjectionOperator;
  readonly sourceIndex?: number;
  readonly from?: number;
  readonly to?: number;
  readonly messageId?: string;
  readonly newMessageId?: string;
}

/** Context an injection needs beyond (stream, base): the full expanded
 * trace (for REPLAY_PREFIX / STALE_SNAPSHOT) and the disconnect point
 * (for REPLAY_PREFIX). */
export interface InjectionContext {
  /** Full expanded event sequence, in arrival order. */
  readonly events: readonly NormalizedEvent[];
  /** disconnectAfter: last delivered sourceIndex before the disconnect. */
  readonly disconnectAfter?: number;
}

export interface InjectionResult {
  readonly stream: NormalizedEvent[];
  readonly baseState: RejoinState;
  /** Stream events the injection removed (DROP_EVENT, CURSOR_SKIP,
   * TRUNCATE_STREAM); [] for the other operators. */
  readonly dropped: NormalizedEvent[];
  /** False when the operator could not apply here (no-op branch). */
  readonly changed: boolean;
}

function cloneStream(stream: readonly NormalizedEvent[]): NormalizedEvent[] {
  return structuredClone(stream) as NormalizedEvent[];
}

function cloneEventWrapper(
  wrapper: NormalizedEvent,
): NormalizedEvent {
  return structuredClone(wrapper);
}

/** Rename a messageId consistently inside one stream event object. */
function renameInEvent(
  event: Record<string, unknown>,
  oldId: string,
  newId: string,
): void {
  if (event["messageId"] === oldId) event["messageId"] = newId;
  if (event["parentMessageId"] === oldId) event["parentMessageId"] = newId;
  if (event["type"] === "MESSAGES_SNAPSHOT" && Array.isArray(event["messages"])) {
    const messages = event["messages"] as Record<string, unknown>[];
    const moved: Record<string, unknown>[] = [];
    const kept: Record<string, unknown>[] = [];
    for (const message of messages) {
      if (message["id"] === oldId) {
        moved.push({ ...message, id: newId });
      } else {
        kept.push(message);
      }
    }
    // #3119 behaviour: the re-ID'd message is appended at the end.
    event["messages"] = [...kept, ...moved];
  }
}

/**
 * Apply one injection to (stream, baseState). Pure: inputs are never
 * mutated. Unknown operators throw (they are INVALID_INPUT, never a
 * silent no-op).
 */
export function applyInjection(
  stream: readonly NormalizedEvent[],
  baseState: RejoinState,
  context: InjectionContext,
  injection: Injection,
): InjectionResult {
  const nextStream = cloneStream(stream);
  let nextBase: RejoinState = cloneState(baseState);
  const dropped: NormalizedEvent[] = [];

  switch (injection.op) {
    case "DROP_EVENT": {
      const target = injection.sourceIndex;
      const kept: NormalizedEvent[] = [];
      for (const wrapper of nextStream) {
        if (wrapper.sourceIndex === target) dropped.push(wrapper);
        else kept.push(wrapper);
      }
      return { stream: kept, baseState: nextBase, dropped, changed: dropped.length > 0 };
    }

    case "DUPLICATE_EVENT": {
      const target = injection.sourceIndex;
      const out: NormalizedEvent[] = [];
      let changed = false;
      for (const wrapper of nextStream) {
        out.push(wrapper);
        if (wrapper.sourceIndex === target) {
          out.push(cloneEventWrapper(wrapper));
          changed = true;
        }
      }
      return { stream: out, baseState: nextBase, dropped, changed };
    }

    case "SWAP_ADJACENT": {
      const target = injection.sourceIndex;
      const position = nextStream.findIndex((w) => w.sourceIndex === target);
      if (position === -1 || position + 1 >= nextStream.length) {
        return { stream: nextStream, baseState: nextBase, dropped, changed: false };
      }
      const swapped = [...nextStream];
      const first = swapped[position] as NormalizedEvent;
      const second = swapped[position + 1] as NormalizedEvent;
      swapped[position] = second;
      swapped[position + 1] = first;
      return { stream: swapped, baseState: nextBase, dropped, changed: true };
    }

    case "MESSAGE_ID_REMAP": {
      const oldId =
        injection.messageId ??
        nextBase.messages.find((m) => m.role === "assistant")?.id;
      if (oldId === undefined) {
        return { stream: nextStream, baseState: nextBase, dropped, changed: false };
      }
      const newId = injection.newMessageId ?? `${oldId}-remapped`;
      if (oldId === newId) {
        return { stream: nextStream, baseState: nextBase, dropped, changed: false };
      }
      let renamed: MessageState | undefined;
      const keptMessages: MessageState[] = [];
      for (const message of nextBase.messages) {
        if (message.id === oldId) renamed = { ...message, id: newId };
        else keptMessages.push(message);
      }
      if (renamed === undefined) {
        return { stream: nextStream, baseState: nextBase, dropped, changed: false };
      }
      // #3119 behaviour: the re-ID'd message is appended at the end.
      const remappedMessages: RejoinState["messages"] = [...keptMessages, renamed];
      nextBase = {
        ...nextBase,
        messages: remappedMessages,
        toolCalls: nextBase.toolCalls.map((call) =>
          call.parentMessageId === oldId
            ? { ...call, parentMessageId: newId }
            : call,
        ),
      };
      for (const wrapper of nextStream) {
        renameInEvent(
          wrapper.event as unknown as Record<string, unknown>,
          oldId,
          newId,
        );
      }
      return { stream: nextStream, baseState: nextBase, dropped, changed: true };
    }

    case "REPLAY_PREFIX": {
      const disconnectAfter = context.disconnectAfter;
      if (disconnectAfter === undefined || disconnectAfter === null) {
        return { stream: nextStream, baseState: nextBase, dropped, changed: false };
      }
      const prefix = context.events
        .filter((w) => w.sourceIndex <= disconnectAfter)
        .map(cloneEventWrapper);
      if (prefix.length === 0) {
        return { stream: nextStream, baseState: nextBase, dropped, changed: false };
      }
      return {
        stream: [...prefix, ...nextStream],
        baseState: nextBase,
        dropped,
        changed: true,
      };
    }

    case "STALE_SNAPSHOT": {
      const firstSnapshot = context.events.find(
        (w) => w.event.type === "STATE_SNAPSHOT",
      );
      if (firstSnapshot === undefined) {
        return { stream: nextStream, baseState: nextBase, dropped, changed: false };
      }
      const prefix = context.events.filter(
        (w) => w.sourceIndex <= firstSnapshot.sourceIndex,
      );
      // The prefix is a clean, already-covered prefix; the plain
      // reducer fold is the right tool here (no replay duplicates
      // inside a single forward fold).
      const staleState = reduceEvents(prefix);
      return { stream: nextStream, baseState: staleState, dropped, changed: true };
    }

    case "CURSOR_SKIP": {
      const from = injection.from;
      const to = injection.to;
      if (from === undefined || to === undefined) {
        return { stream: nextStream, baseState: nextBase, dropped, changed: false };
      }
      const kept: NormalizedEvent[] = [];
      for (const wrapper of nextStream) {
        if (wrapper.sourceIndex >= from && wrapper.sourceIndex <= to) {
          dropped.push(wrapper);
        } else {
          kept.push(wrapper);
        }
      }
      return { stream: kept, baseState: nextBase, dropped, changed: dropped.length > 0 };
    }

    case "TRUNCATE_STREAM": {
      const target = injection.sourceIndex;
      if (target === undefined) {
        return { stream: nextStream, baseState: nextBase, dropped, changed: false };
      }
      const kept: NormalizedEvent[] = [];
      for (const wrapper of nextStream) {
        if (wrapper.sourceIndex < target) kept.push(wrapper);
        else dropped.push(wrapper);
      }
      return { stream: kept, baseState: nextBase, dropped, changed: dropped.length > 0 };
    }

    default: {
      const unknown = injection as { readonly op: string };
      throw new Error(
        `[INVALID_INPUT] unknown injection operator ${JSON.stringify(unknown.op)}`,
      );
    }
  }
}

/** Apply a sequence of injections, left to right. */
export function applyInjections(
  stream: readonly NormalizedEvent[],
  baseState: RejoinState,
  context: InjectionContext,
  injections: readonly Injection[],
): InjectionResult {
  let currentStream: NormalizedEvent[] = cloneStream(stream);
  let currentBase: RejoinState = cloneState(baseState);
  const droppedAll: NormalizedEvent[] = [];
  let changedAny = false;
  for (const injection of injections) {
    const result = applyInjection(currentStream, currentBase, context, injection);
    currentStream = result.stream;
    currentBase = result.baseState;
    droppedAll.push(...result.dropped);
    changedAny = changedAny || result.changed;
  }
  return {
    stream: currentStream,
    baseState: currentBase,
    dropped: droppedAll,
    changed: changedAny,
  };
}
