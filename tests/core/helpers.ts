/**
 * T003 test helpers — small builders for AGUIEvent / NormalizedEvent
 * sequences. No time, no randomness: every id is a literal.
 */
import type { AGUIEvent, NormalizedEvent } from "../../src/protocol/types.js";
import { initialState, type RejoinState } from "../../src/core/state.js";
import { reduceEvents, reduceExpandedEvents } from "../../src/core/reducer.js";

/** Build one event object from a type + fields. */
export function ev<T extends AGUIEvent["type"]>(
  type: T,
  fields: Record<string, unknown> = {},
): AGUIEvent {
  return { type, ...fields } as unknown as AGUIEvent;
}

/** Wrap events as a T002 NormalizedEvent sequence (arrival order). */
export function norm(events: readonly AGUIEvent[]): NormalizedEvent[] {
  return events.map((event, i) => ({
    sourceIndex: i,
    sourceEventKey: null,
    transportEventId: null,
    event,
  }));
}

/** Reduce an already-expanded event list from the initial state. */
export function run(events: readonly AGUIEvent[], from: RejoinState = initialState()): RejoinState {
  return reduceExpandedEvents(events, from);
}

/** Reduce a T002 sequence through the sanctioned entry (expandChunks + fold). */
export function runNorm(events: readonly AGUIEvent[], from: RejoinState = initialState()): RejoinState {
  return reduceEvents(norm(events), from);
}

export function runStart(
  threadId = "t1",
  runId = "r1",
  extra: Record<string, unknown> = {},
): AGUIEvent {
  return ev("RUN_STARTED", { threadId, runId, ...extra });
}

export function runFinish(
  threadId = "t1",
  runId = "r1",
  extra: Record<string, unknown> = {},
): AGUIEvent {
  return ev("RUN_FINISHED", { threadId, runId, ...extra });
}

/** A minimal valid run: START, one text message "hi", FINISH. */
export function simpleRun(): AGUIEvent[] {
  return [
    runStart(),
    ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
    ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "hi" }),
    ev("TEXT_MESSAGE_END", { messageId: "m1" }),
    runFinish(),
  ];
}

/** Deep-freeze a value (immutability test support). */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
