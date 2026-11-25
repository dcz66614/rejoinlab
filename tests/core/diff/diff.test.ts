/**
 * T004 tests — deterministic state comparison + first divergence
 * location (diff.ts).
 *
 * Coverage required by the T004 card: fullPath vs resumePath
 * equal/unequal, JSON Pointer correctness, first-divergence location
 * (sourceIndex + expected/actual), message-order, tool-call,
 * shared-state and pending differences, empty diff.
 *
 * Histories here are folded step by step with reduceEvent so each
 * entry carries the sourceIndex of the EXPANDED sequence it belongs
 * to; the expanded NormalizedEvent sequence is passed to
 * findFirstDivergence as the event-identity source (per the T004
 * brief, rule 4: sourceIndex is taken from the caller-supplied
 * sequence, never invented).
 */
import { describe, expect, it } from "vitest";
import {
  comparePaths,
  diffStates,
  diffValues,
  escapePointerToken,
  findFirstDivergence,
  joinPointer,
  type StateHistoryEntry,
} from "../../../src/core/diff.js";
import { stateHash } from "../../../src/core/canonical.js";
import { initialState, type RejoinState } from "../../../src/core/state.js";
import { reduceEvent } from "../../../src/core/reducer.js";
import type { AGUIEvent, NormalizedEvent } from "../../../src/protocol/types.js";
import { ev, norm, runFinish, runNorm, runStart, simpleRun } from "../helpers.js";

/** Fold (sourceIndex, event) pairs, recording the state after each step. */
function foldWithIndices(
  pairs: ReadonlyArray<{ sourceIndex: number; event: AGUIEvent }>,
): StateHistoryEntry[] {
  let state = initialState();
  const history: StateHistoryEntry[] = [];
  for (const { sourceIndex, event } of pairs) {
    state = reduceEvent(state, event);
    history.push({ sourceIndex, state });
  }
  return history;
}

function pairsOf(events: readonly AGUIEvent[]): Array<{ sourceIndex: number; event: AGUIEvent }> {
  return events.map((event, i) => ({ sourceIndex: i, event }));
}

/** Full run: START, m1 "Hello" (two deltas), tool call, result, FINISH. */
function fullEvents(): AGUIEvent[] {
  return [
    runStart("t1", "r1"),
    ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
    ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "Hel" }),
    ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "lo" }),
    ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search", parentMessageId: "m1" }),
    ev("TOOL_CALL_ARGS", { toolCallId: "tc1", delta: '{"q":"x"}' }),
    ev("TOOL_CALL_END", { toolCallId: "tc1" }),
    ev("TEXT_MESSAGE_END", { messageId: "m1" }),
    ev("TOOL_CALL_RESULT", { messageId: "m2", toolCallId: "tc1", content: "found it" }),
    runFinish("t1", "r1"),
  ];
}

describe("diffValues — primitives and pointers", () => {
  it("equal values produce no differences", () => {
    expect(diffValues({ a: [1, { b: "x" }] }, { a: [1, { b: "x" }] })).toEqual([]);
    expect(diffValues(null, null)).toEqual([]);
    expect(diffValues("s", "s")).toEqual([]);
  });
  it("scalar change at the root reports pointer \"\"", () => {
    expect(diffValues("a", "b")).toEqual([
      { jsonPointer: "", expected: "a", actual: "b", kind: "changed" },
    ]);
  });
  it("nested object path", () => {
    expect(diffValues({ a: { b: 1 } }, { a: { b: 2 } })).toEqual([
      { jsonPointer: "/a/b", expected: 1, actual: 2, kind: "changed" },
    ]);
  });
  it("array index path; added and removed elements", () => {
    expect(diffValues([1, 2, 3], [1, 9, 3, 4])).toEqual([
      { jsonPointer: "/1", expected: 2, actual: 9, kind: "changed" },
      { jsonPointer: "/3", expected: undefined, actual: 4, kind: "added" },
    ]);
    expect(diffValues([1, 2, 3], [1, 2])).toEqual([
      { jsonPointer: "/2", expected: 3, actual: undefined, kind: "removed" },
    ]);
  });
  it("added / removed object keys", () => {
    expect(diffValues({ a: 1 }, { a: 1, b: 2 })).toEqual([
      { jsonPointer: "/b", expected: undefined, actual: 2, kind: "added" },
    ]);
    expect(diffValues({ a: 1, b: 2 }, { a: 1 })).toEqual([
      { jsonPointer: "/b", expected: 2, actual: undefined, kind: "removed" },
    ]);
  });
  it("pointer escaping: ~ -> ~0, / -> ~1", () => {
    expect(escapePointerToken("a/b~c")).toBe("a~1b~0c");
    expect(joinPointer("/sharedState", "a/b")).toBe("/sharedState/a~1b");
    expect(joinPointer("", "x")).toBe("/x");
    expect(diffValues({ "a/b": 1 }, { "a/b": 2 })).toEqual([
      { jsonPointer: "/a~1b", expected: 1, actual: 2, kind: "changed" },
    ]);
  });
  it("traversal order is deterministic (keys sorted, indices ascending)", () => {
    const a = { z: 1, a: { y: 1, b: 1 } };
    const b = { z: 2, a: { y: 2, b: 2 } };
    const once = diffValues(a, b).map((d) => d.jsonPointer);
    expect(once).toEqual(["/a/b", "/a/y", "/z"]);
    expect(diffValues(a, b).map((d) => d.jsonPointer)).toEqual(once);
  });
});

describe("diffStates / comparePaths — final states", () => {
  it("identical states compare equal with empty differences", () => {
    const a = runNorm(simpleRun());
    const b = runNorm(simpleRun());
    const cmp = comparePaths(a, b);
    expect(cmp.equal).toBe(true);
    expect(cmp.differences).toEqual([]);
    expect(cmp.firstDifference).toBeNull();
    expect(cmp.fullHash).toBe(stateHash(a));
    expect(cmp.resumeHash).toBe(stateHash(b));
    expect(diffStates(a, b)).toEqual([]);
  });
  it("states differing only in diagnostics compare equal", () => {
    const a = runNorm(simpleRun());
    const b = {
      ...a,
      diagnostics: [{ code: "RUN_ERROR", severity: "CRITICAL" as const, message: "x" }],
    };
    expect(comparePaths(a, b).equal).toBe(true);
    expect(diffStates(a, b)).toEqual([]);
  });
  it("message content difference", () => {
    const a = runNorm(simpleRun());
    const b = runNorm([
      runStart(),
      ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "bye" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      runFinish(),
    ]);
    const cmp = comparePaths(a, b);
    expect(cmp.equal).toBe(false);
    expect(cmp.differences).toContainEqual({
      jsonPointer: "/messages/0/content",
      expected: "hi",
      actual: "bye",
      kind: "changed",
    });
    expect(cmp.firstDifference).toEqual(cmp.differences[0]);
  });
  it("message order difference", () => {
    const a = runNorm([
      runStart(),
      ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "one" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      ev("TEXT_MESSAGE_START", { messageId: "m2", role: "user" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m2", delta: "two" }),
      ev("TEXT_MESSAGE_END", { messageId: "m2" }),
      runFinish(),
    ]);
    const b = runNorm([
      runStart(),
      ev("TEXT_MESSAGE_START", { messageId: "m2", role: "user" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m2", delta: "two" }),
      ev("TEXT_MESSAGE_END", { messageId: "m2" }),
      ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "one" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      runFinish(),
    ]);
    const diffs = diffStates(a, b);
    expect(diffs).toContainEqual({
      jsonPointer: "/messages/0/id",
      expected: "m1",
      actual: "m2",
      kind: "changed",
    });
    expect(diffs).toContainEqual({
      jsonPointer: "/messages/1/id",
      expected: "m2",
      actual: "m1",
      kind: "changed",
    });
  });
  it("tool call differences: args, result, status", () => {
    const a = runNorm(fullEvents());
    const b = runNorm([
      runStart("t1", "r1"),
      ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "Hel" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "lo" }),
      ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search", parentMessageId: "m1" }),
      ev("TOOL_CALL_ARGS", { toolCallId: "tc1", delta: '{"q":"y"}' }),
      ev("TOOL_CALL_END", { toolCallId: "tc1" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      ev("TOOL_CALL_RESULT", { messageId: "m2", toolCallId: "tc1", content: "nothing" }),
      runFinish("t1", "r1"),
    ]);
    const diffs = diffStates(a, b);
    expect(diffs).toContainEqual({
      jsonPointer: "/toolCalls/0/arguments",
      expected: '{"q":"x"}',
      actual: '{"q":"y"}',
      kind: "changed",
    });
    expect(diffs).toContainEqual({
      jsonPointer: "/toolCalls/0/resultContent",
      expected: "found it",
      actual: "nothing",
      kind: "changed",
    });
  });
  it("shared state differences: nested value and array element", () => {
    const a = runNorm([
      runStart("t1", "r1", {
        input: { threadId: "t1", runId: "r1", messages: [], state: { n: { b: [1, 2] }, s: "x" } },
      }),
      runFinish("t1", "r1"),
    ]);
    const b = runNorm([
      runStart("t1", "r1", {
        input: { threadId: "t1", runId: "r1", messages: [], state: { n: { b: [1, 9] }, s: "x" } },
      }),
      runFinish("t1", "r1"),
    ]);
    expect(diffStates(a, b)).toContainEqual({
      jsonPointer: "/sharedState/n/b/1",
      expected: 2,
      actual: 9,
      kind: "changed",
    });
    const c = runNorm([
      runStart("t1", "r1", {
        input: { threadId: "t1", runId: "r1", messages: [], state: { n: { b: [1, 2] } } },
      }),
      runFinish("t1", "r1"),
    ]);
    expect(diffStates(a, c)).toContainEqual({
      jsonPointer: "/sharedState/s",
      expected: "x",
      actual: undefined,
      kind: "removed",
    });
  });
  it("pendingToolCallIds, runStatus and threadId differences", () => {
    const a = runNorm(fullEvents());
    expect(diffStates(a, { ...a, pendingToolCallIds: ["tc1"] })).toContainEqual({
      jsonPointer: "/pendingToolCallIds/0",
      expected: undefined,
      actual: "tc1",
      kind: "added",
    });
    expect(diffStates(a, { ...a, runStatus: "ERROR" as const })).toContainEqual({
      jsonPointer: "/runStatus",
      expected: "FINISHED",
      actual: "ERROR",
      kind: "changed",
    });
    expect(diffStates(a, { ...a, threadId: "t2" })).toContainEqual({
      jsonPointer: "/threadId",
      expected: "t1",
      actual: "t2",
      kind: "changed",
    });
  });
});

describe("findFirstDivergence — §8.6 step-by-step alignment", () => {
  it("identical histories: no divergence", () => {
    const events = fullEvents();
    const full = foldWithIndices(pairsOf(events));
    const resume = foldWithIndices(pairsOf(events));
    expect(findFirstDivergence(full, resume, norm(events))).toBeNull();
  });
  it("dropped CONTENT delta: first divergence at the next step, with event identity", () => {
    const events = fullEvents();
    const full = foldWithIndices(pairsOf(events));
    // Resume drops the "lo" delta (full sourceIndex 3) but keeps the
    // original indices for the events it does apply.
    const resumePairs = pairsOf(events).filter((p) => p.sourceIndex !== 3);
    const resume = foldWithIndices(resumePairs);
    const div = findFirstDivergence(full, resume, norm(events));
    expect(div).not.toBeNull();
    // At index 3 the resume history has no entry (carried forward from
    // index 2, content "Hel"); the full state already has "Hello".
    expect(div?.sourceIndex).toBe(3);
    expect(div?.eventType).toBe("TEXT_MESSAGE_CONTENT");
    expect(div?.messageId).toBe("m1");
    expect(div?.fullStateHash).not.toBe(div?.resumeStateHash);
    expect(div?.differences).toContainEqual({
      jsonPointer: "/messages/0/content",
      expected: "Hello",
      actual: "Hel",
      kind: "changed",
    });
    expect(div?.note).toMatch(/carried forward from sourceIndex 2/);
  });
  it("dropped TOOL_CALL_ARGS delta: divergence names the tool call", () => {
    const events = fullEvents();
    const full = foldWithIndices(pairsOf(events));
    const resumePairs = pairsOf(events).filter((p) => p.sourceIndex !== 5);
    const resume = foldWithIndices(resumePairs);
    const div = findFirstDivergence(full, resume, norm(events));
    expect(div?.sourceIndex).toBe(5);
    expect(div?.eventType).toBe("TOOL_CALL_ARGS");
    expect(div?.toolCallId).toBe("tc1");
    expect(div?.differences).toContainEqual({
      jsonPointer: "/toolCalls/0/arguments",
      expected: '{"q":"x"}',
      actual: "",
      kind: "changed",
    });
  });
  it("without an event sequence: position is still reported, identity unresolved", () => {
    const events = fullEvents();
    const full = foldWithIndices(pairsOf(events));
    const resume = foldWithIndices(pairsOf(events).filter((p) => p.sourceIndex !== 3));
    const div = findFirstDivergence(full, resume);
    expect(div?.sourceIndex).toBe(3);
    expect(div?.eventType).toBeUndefined();
    expect(div?.note).toMatch(/no expanded event sequence supplied/);
  });
  it("empty resume history: divergence at the first step vs the initial state", () => {
    const events = fullEvents();
    const full = foldWithIndices(pairsOf(events));
    const div = findFirstDivergence(full, [], norm(events));
    expect(div?.sourceIndex).toBe(0);
    expect(div?.eventType).toBe("RUN_STARTED");
    expect(div?.runId).toBe("r1");
    expect(div?.differences).toContainEqual({
      jsonPointer: "/threadId",
      expected: "t1",
      actual: null,
      kind: "changed",
    });
    expect(div?.note).toMatch(/initial state/);
  });
  it("empty full history: no divergence", () => {
    expect(findFirstDivergence([], foldWithIndices(pairsOf(fullEvents())))).toBeNull();
  });
  it("resume entry missing at the divergent index is carried forward, not fabricated", () => {
    // Resume stops after index 2 (truncated stream): its last known
    // state is carried forward and compared at every later index.
    const events = fullEvents();
    const full = foldWithIndices(pairsOf(events));
    const resume = foldWithIndices(pairsOf(events).slice(0, 3));
    const div = findFirstDivergence(full, resume, norm(events));
    expect(div?.sourceIndex).toBe(3);
    expect(div?.note).toMatch(/carried forward from sourceIndex 2/);
    // The carried resume state is the real state at index 2, so the
    // diff is a fact about that state, not an invented event.
    expect(div?.differences).toContainEqual({
      jsonPointer: "/messages/0/content",
      expected: "Hello",
      actual: "Hel",
      kind: "changed",
    });
  });
  it("duplicate entries for one sourceIndex keep the last state (chunk expansion)", () => {
    const events = fullEvents();
    const full = foldWithIndices(pairsOf(events));
    // A resume history where sourceIndex 3 appears twice: first a
    // stale intermediate (the state as of index 2), then the real
    // state after the index-3 event. The LAST entry wins, so the
    // histories still agree and there is no divergence.
    const staleAt3: StateHistoryEntry = { sourceIndex: 3, state: full[2]?.state as RejoinState };
    const resume: StateHistoryEntry[] = [
      full[0] as StateHistoryEntry,
      full[1] as StateHistoryEntry,
      full[2] as StateHistoryEntry,
      staleAt3,
      ...full.slice(3),
    ];
    expect(findFirstDivergence(full, resume, norm(events))).toBeNull();
    // And the reverse: if the stale entry came LAST, it would diverge.
    const staleLast: StateHistoryEntry[] = [...full.slice(0, 4), staleAt3, ...full.slice(4)];
    const div = findFirstDivergence(full, staleLast, norm(events));
    expect(div?.sourceIndex).toBe(3);
  });
  it("result is deterministic across repeated calls", () => {
    const events = fullEvents();
    const full = foldWithIndices(pairsOf(events));
    const resume = foldWithIndices(pairsOf(events).filter((p) => p.sourceIndex !== 3));
    const first = findFirstDivergence(full, resume, norm(events));
    const second = findFirstDivergence(full, resume, norm(events));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first?.differences).toEqual(second?.differences);
  });
});
