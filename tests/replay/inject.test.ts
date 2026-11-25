/**
 * T005 tests — the 8 injection operators (PROJECT_BOOK §8.4).
 * Mirrors oracle/tests/test_replay.py::test_each_injection_operator
 * (same N02 resume stream [4, 5, 6]) plus the remap-moves-to-end
 * and replay-prefix cases.
 */
import { describe, expect, it } from "vitest";
import {
  OPERATOR_ORDER,
  applyInjection,
  type Injection,
} from "../../src/replay/inject.js";
import {
  buildResumeStream,
  resolveCheckpoint,
} from "../../src/replay/planner.js";
import { expandChunks } from "../../src/parser/normalize.js";
import { loadFixture } from "./golden-helpers.js";

function n02Setup() {
  const fixture = loadFixture("N02");
  const expanded = expandChunks(fixture.events);
  const resolved = resolveCheckpoint(
    expanded,
    fixture.recovery.disconnectAfter,
    fixture.recovery.checkpoint,
  );
  const stream = buildResumeStream(
    expanded,
    fixture.recovery.strategy,
    fixture.recovery.disconnectAfter,
    fixture.recovery.resumeAfterSourceIndex,
    resolved.checkpointIndex,
  );
  return { fixture, expanded, base: resolved.baseState, stream };
}

describe("operator order is the frozen lexicographic order", () => {
  it("OPERATOR_ORDER matches PROJECT_BOOK §8.5", () => {
    expect([...OPERATOR_ORDER]).toEqual([
      "CURSOR_SKIP",
      "DROP_EVENT",
      "DUPLICATE_EVENT",
      "MESSAGE_ID_REMAP",
      "REPLAY_PREFIX",
      "STALE_SNAPSHOT",
      "SWAP_ADJACENT",
      "TRUNCATE_STREAM",
    ]);
  });
});

describe("each injection operator (N02 resume stream [4, 5, 6])", () => {
  it("DROP_EVENT removes the target and reports it dropped", () => {
    const { fixture, expanded, base, stream } = n02Setup();
    const result = applyInjection(stream, base, {
      events: expanded,
      disconnectAfter: fixture.recovery.disconnectAfter,
    }, { op: "DROP_EVENT", sourceIndex: 4 });
    expect(result.changed).toBe(true);
    expect(result.stream.map((w) => w.sourceIndex)).toEqual([5, 6]);
    expect(result.dropped.map((w) => w.sourceIndex)).toEqual([4]);
  });

  it("DUPLICATE_EVENT repeats the target in place", () => {
    const { fixture, expanded, base, stream } = n02Setup();
    const result = applyInjection(stream, base, {
      events: expanded,
      disconnectAfter: fixture.recovery.disconnectAfter,
    }, { op: "DUPLICATE_EVENT", sourceIndex: 4 });
    expect(result.changed).toBe(true);
    expect(result.stream.map((w) => w.sourceIndex)).toEqual([4, 4, 5, 6]);
  });

  it("SWAP_ADJACENT swaps the target with its successor", () => {
    const { fixture, expanded, base, stream } = n02Setup();
    const result = applyInjection(stream, base, {
      events: expanded,
      disconnectAfter: fixture.recovery.disconnectAfter,
    }, { op: "SWAP_ADJACENT", sourceIndex: 4 });
    expect(result.changed).toBe(true);
    expect(result.stream.map((w) => w.sourceIndex)).toEqual([5, 4, 6]);
  });

  it("SWAP_ADJACENT at the last event is a no-op", () => {
    const { fixture, expanded, base, stream } = n02Setup();
    const result = applyInjection(stream, base, {
      events: expanded,
      disconnectAfter: fixture.recovery.disconnectAfter,
    }, { op: "SWAP_ADJACENT", sourceIndex: 6 });
    expect(result.changed).toBe(false);
  });

  it("TRUNCATE_STREAM keeps only events before the target", () => {
    const { fixture, expanded, base, stream } = n02Setup();
    const result = applyInjection(stream, base, {
      events: expanded,
      disconnectAfter: fixture.recovery.disconnectAfter,
    }, { op: "TRUNCATE_STREAM", sourceIndex: 6 });
    expect(result.changed).toBe(true);
    expect(result.stream.map((w) => w.sourceIndex)).toEqual([4, 5]);
  });

  it("CURSOR_SKIP over already-covered indices drops nothing", () => {
    const { fixture, expanded, base, stream } = n02Setup();
    const result = applyInjection(stream, base, {
      events: expanded,
      disconnectAfter: fixture.recovery.disconnectAfter,
    }, { op: "CURSOR_SKIP", from: 2, to: 3 });
    expect(result.changed).toBe(false);
    expect(result.stream.map((w) => w.sourceIndex)).toEqual([4, 5, 6]);
  });

  it("CURSOR_SKIP over resume indices drops them", () => {
    const { fixture, expanded, base, stream } = n02Setup();
    const result = applyInjection(stream, base, {
      events: expanded,
      disconnectAfter: fixture.recovery.disconnectAfter,
    }, { op: "CURSOR_SKIP", from: 4, to: 5 });
    expect(result.changed).toBe(true);
    expect(result.stream.map((w) => w.sourceIndex)).toEqual([6]);
    expect(result.dropped.map((w) => w.sourceIndex)).toEqual([4, 5]);
  });

  it("STALE_SNAPSHOT is inapplicable: N02 has no STATE_SNAPSHOT", () => {
    const { fixture, expanded, base, stream } = n02Setup();
    const result = applyInjection(stream, base, {
      events: expanded,
      disconnectAfter: fixture.recovery.disconnectAfter,
    }, { op: "STALE_SNAPSHOT" });
    expect(result.changed).toBe(false);
  });

  it("STALE_SNAPSHOT rewinds the base to the first snapshot (G06)", () => {
    const fixture = loadFixture("G06");
    const expanded = expandChunks(fixture.events);
    const resolved = resolveCheckpoint(
      expanded,
      fixture.recovery.disconnectAfter,
      fixture.recovery.checkpoint,
    );
    const stream = buildResumeStream(
      expanded,
      fixture.recovery.strategy,
      fixture.recovery.disconnectAfter,
      fixture.recovery.resumeAfterSourceIndex,
      resolved.checkpointIndex,
    );
    const result = applyInjection(stream, resolved.baseState, {
      events: expanded,
      disconnectAfter: fixture.recovery.disconnectAfter,
    }, { op: "STALE_SNAPSHOT" });
    expect(result.changed).toBe(true);
    expect(result.baseState.sharedState).toEqual({ counter: 1, items: ["a"] });
  });
});

describe("MESSAGE_ID_REMAP moves the renamed message to the end", () => {
  it("G02 legal baseline: msg-a first, remapped msg-a last", () => {
    const fixture = loadFixture("G02");
    const expanded = expandChunks(fixture.events);
    // Legal baseline checkpoint: recomputed from the covered prefix.
    const resolved = resolveCheckpoint(
      expanded,
      fixture.recovery.disconnectAfter,
      null,
    );
    expect(resolved.baseState.messages.map((m) => m.id)).toEqual([
      "msg-a",
      "msg-r1",
    ]);
    const stream = buildResumeStream(
      expanded,
      fixture.recovery.strategy,
      fixture.recovery.disconnectAfter,
      fixture.recovery.resumeAfterSourceIndex,
      resolved.checkpointIndex,
    );
    const result = applyInjection(stream, resolved.baseState, {
      events: expanded,
      disconnectAfter: fixture.recovery.disconnectAfter,
    }, {
      op: "MESSAGE_ID_REMAP",
      messageId: "msg-a",
      newMessageId: "msg-a-remapped",
    });
    expect(result.changed).toBe(true);
    expect(result.baseState.messages.map((m) => m.id)).toEqual([
      "msg-r1",
      "msg-a-remapped",
    ]);
  });
});

describe("REPLAY_PREFIX reproduces G01", () => {
  it("prefix [0..4] is prepended to the resume stream [5..8]", () => {
    const fixture = loadFixture("G01");
    const expanded = expandChunks(fixture.events);
    const resolved = resolveCheckpoint(
      expanded,
      fixture.recovery.disconnectAfter,
      null,
    );
    const stream = buildResumeStream(
      expanded,
      "RESUME_FROM_CHECKPOINT",
      fixture.recovery.disconnectAfter,
      fixture.recovery.disconnectAfter,
      resolved.checkpointIndex,
    );
    expect(stream.map((w) => w.sourceIndex)).toEqual([5, 6, 7, 8]);
    const result = applyInjection(stream, resolved.baseState, {
      events: expanded,
      disconnectAfter: fixture.recovery.disconnectAfter,
    }, { op: "REPLAY_PREFIX" });
    expect(result.changed).toBe(true);
    expect(result.stream.map((w) => w.sourceIndex)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });
});

describe("injection hygiene", () => {
  it("unknown operator throws instead of silently passing", () => {
    const { fixture, expanded, base, stream } = n02Setup();
    expect(() =>
      applyInjection(stream, base, {
        events: expanded,
        disconnectAfter: fixture.recovery.disconnectAfter,
      }, { op: "NOPE" } as Injection),
    ).toThrow(/unknown injection operator/);
  });

  it("injections never add an eventId and never mutate their inputs", () => {
    const { fixture, expanded, base, stream } = n02Setup();
    const streamBefore = JSON.stringify(stream);
    const baseBefore = JSON.stringify(base);
    const result = applyInjection(stream, base, {
      events: expanded,
      disconnectAfter: fixture.recovery.disconnectAfter,
    }, { op: "REPLAY_PREFIX" });
    expect(JSON.stringify(stream)).toBe(streamBefore);
    expect(JSON.stringify(base)).toBe(baseBefore);
    for (const wrapper of result.stream) {
      expect("eventId" in (wrapper.event as Record<string, unknown>)).toBe(false);
    }
  });
});
