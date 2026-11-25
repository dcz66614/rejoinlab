/**
 * T004 tests — determinism (acceptance: npm run test:determinism).
 *
 * Same input, repeated 100 times: one canonical hash, one diff, one
 * first-divergence location. No time, no randomness anywhere in the
 * pipeline (reduce -> canon -> diff -> locate).
 */
import { describe, expect, it } from "vitest";
import { canonicalizeState, stateHash } from "../../../src/core/canonical.js";
import {
  comparePaths,
  diffStates,
  findFirstDivergence,
  type StateHistoryEntry,
} from "../../../src/core/diff.js";
import { reduceEvent } from "../../../src/core/reducer.js";
import { initialState, type RejoinState } from "../../../src/core/state.js";
import type { AGUIEvent } from "../../../src/protocol/types.js";
import { ev, norm, runFinish, runNorm, runStart, simpleRun } from "../helpers.js";

function richEvents() {
  return [
    runStart("t1", "r1", {
      input: {
        threadId: "t1",
        runId: "r1",
        messages: [],
        state: { counter: 3, nested: { b: [1, 2], a: "x" } },
      },
    }),
    ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
    ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "Hello" }),
    ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search", parentMessageId: "m1" }),
    ev("TOOL_CALL_ARGS", { toolCallId: "tc1", delta: '{"q":"x"}' }),
    ev("TOOL_CALL_END", { toolCallId: "tc1" }),
    ev("TEXT_MESSAGE_END", { messageId: "m1" }),
    ev("TOOL_CALL_RESULT", { messageId: "m2", toolCallId: "tc1", content: "found it" }),
    runFinish("t1", "r1"),
  ];
}

/** Fold events one by one, recording the state after each step. */
function foldHistory(
  events: readonly AGUIEvent[],
  indices?: readonly number[],
): StateHistoryEntry[] {
  let state: RejoinState = initialState();
  return events.map((event, i) => {
    state = reduceEvent(state, event);
    return { sourceIndex: indices?.[i] ?? i, state };
  });
}

describe("determinism — 100x repeat, one result", () => {
  it("same state hashes to one value over 100 fresh builds", () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      hashes.add(stateHash(runNorm(richEvents())));
    }
    expect(hashes.size).toBe(1);
  });

  it("same canonical string over 100 fresh builds", () => {
    const strings = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      strings.add(canonicalizeState(runNorm(richEvents())));
    }
    expect(strings.size).toBe(1);
  });

  it("same diff over 100 comparisons", () => {
    const a = runNorm(richEvents());
    const b = runNorm(simpleRun());
    const digests = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      digests.add(JSON.stringify(diffStates(a, b)));
    }
    expect(digests.size).toBe(1);
    const cmp = comparePaths(a, b);
    expect(cmp.equal).toBe(false);
    expect(cmp.firstDifference).toEqual(cmp.differences[0]);
  });

  it("same first divergence over 100 runs (dropped CONTENT delta)", () => {
    const fullEvents = richEvents();
    // Drop the TEXT_MESSAGE_CONTENT delta (index 2). The resume
    // history keeps the ORIGINAL indices, so the first divergence
    // must land on index 2 with the same differences every time.
    const kept = fullEvents.map((_e, i) => i).filter((i) => i !== 2);
    const resumeEvents = kept.map((i) => fullEvents[i] as AGUIEvent);
    const results = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const div = findFirstDivergence(
        foldHistory(fullEvents),
        foldHistory(resumeEvents, kept),
        norm(fullEvents),
      );
      results.add(JSON.stringify(div));
    }
    expect(results.size).toBe(1);
    const only = JSON.parse([...results][0] as string) as {
      sourceIndex: number;
      eventType: string;
      messageId: string;
    };
    expect(only.sourceIndex).toBe(2);
    expect(only.eventType).toBe("TEXT_MESSAGE_CONTENT");
    expect(only.messageId).toBe("m1");
  });

  it("identical paths locate no divergence over 100 runs", () => {
    const results = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const div = findFirstDivergence(
        foldHistory(richEvents()),
        foldHistory(richEvents()),
        norm(richEvents()),
      );
      results.add(JSON.stringify(div));
    }
    expect(results.size).toBe(1);
    expect([...results][0]).toBe("null");
  });
});
