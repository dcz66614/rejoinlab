/**
 * T005 tests — recovery planner: DISCONNECT_AFTER, the three
 * strategies, checkpoint coverage, the UNCLOSED_STREAM_ITEM ->
 * TRUNCATED_RUN mapping, and input limits.
 */
import { describe, expect, it } from "vitest";
import {
  buildResumeStream,
  evaluateFixture,
  foldTrack,
  resolveCheckpoint,
  type ReplayFixture,
} from "../../src/replay/planner.js";
import { expandChunks } from "../../src/parser/normalize.js";
import { initialState } from "../../src/core/state.js";
import { ev, norm, runFinish, runStart } from "../core/helpers.js";
import { loadFixture } from "./golden-helpers.js";

function simpleFixture(
  strategy: ReplayFixture["recovery"]["strategy"],
  overrides: Partial<ReplayFixture["recovery"]> = {},
): ReplayFixture {
  return {
    scenarioId: "T-CURSOR",
    events: norm([
      runStart("t1", "r1"),
      ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "Hello " }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "world." }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      runFinish("t1", "r1"),
    ]),
    recovery: { strategy, disconnectAfter: 2, ...overrides },
  };
}

describe("DISCONNECT_AFTER + three recovery strategies", () => {
  it("RESUME_FROM_CHECKPOINT: base is the prefix through disconnectAfter", () => {
    const fixture = simpleFixture("RESUME_FROM_CHECKPOINT");
    const expanded = expandChunks(fixture.events);
    const resolved = resolveCheckpoint(expanded, 2, null);
    expect(resolved.checkpointIndex).toBe(2);
    expect(resolved.baseState.messages[0]?.content).toBe("Hello ");
    const stream = buildResumeStream(
      expanded,
      "RESUME_FROM_CHECKPOINT",
      2,
      undefined,
      resolved.checkpointIndex,
    );
    expect(stream.map((w) => w.sourceIndex)).toEqual([3, 4, 5]);
    expect(evaluateFixture(fixture).verdict).toBe("CONSISTENT");
  });

  it("FULL_REPLAY_FROM_START: the whole trace is re-sent", () => {
    const fixture = simpleFixture("FULL_REPLAY_FROM_START");
    const expanded = expandChunks(fixture.events);
    const stream = buildResumeStream(expanded, "FULL_REPLAY_FROM_START", 2, undefined, 2);
    expect(stream.map((w) => w.sourceIndex)).toEqual([0, 1, 2, 3, 4, 5]);
    // A full replay over a POPULATED checkpoint re-applies covered
    // payloads (the G01 shape): "Hello " is applied twice. Within
    // this fold the payload occurs once, so there is no
    // SUSPECTED_DUPLICATE — the divergence is a plain DIVERGENT_STATE.
    const result = evaluateFixture(fixture);
    expect(result.verdict).toBe("INCONSISTENT");
    expect(result.diagnostics.map((d) => d.code)).toEqual(["DIVERGENT_STATE"]);
    expect(result.resumeState?.messages[0]?.content).toBe("Hello Hello world.");
  });

  it("FULL_REPLAY_FROM_START from an empty base converges (N06 shape)", () => {
    const fixture = simpleFixture("FULL_REPLAY_FROM_START", {
      checkpoint: { empty: true },
    });
    expect(evaluateFixture(fixture).verdict).toBe("CONSISTENT");
  });

  it("REPLAY_AFTER_SOURCE_CURSOR: resumeAfterSourceIndex wins over disconnectAfter", () => {
    const fixture = simpleFixture("REPLAY_AFTER_SOURCE_CURSOR", {
      resumeAfterSourceIndex: 3,
    });
    const expanded = expandChunks(fixture.events);
    const stream = buildResumeStream(
      expanded,
      "REPLAY_AFTER_SOURCE_CURSOR",
      2,
      3,
      2,
    );
    expect(stream.map((w) => w.sourceIndex)).toEqual([4, 5]);
    // The cursor skips the "world." content: the resume path diverges.
    // (Cursor-skipped events are NOT injection drops, so they are not
    // reported as LOST_EVENT / droppedSourceIndices — those track
    // injections only, mirroring the Oracle.)
    const result = evaluateFixture(fixture);
    expect(result.verdict).toBe("INCONSISTENT");
    expect(result.diagnostics.map((d) => d.code)).toEqual(["DIVERGENT_STATE"]);
    expect(result.droppedSourceIndices).toEqual([]);
    expect(result.resumeState?.messages[0]?.content).toBe("Hello ");
    expect(result.fullState?.messages[0]?.content).toBe("Hello world.");
  });

  it("REPLAY_AFTER_SOURCE_CURSOR is local to this import (not an SSE Last-Event-ID)", () => {
    // The cursor value only ever applies to the events it was given:
    // resuming exactly at the checkpoint converges.
    const fixture = simpleFixture("REPLAY_AFTER_SOURCE_CURSOR", {
      resumeAfterSourceIndex: 2,
    });
    const result = evaluateFixture(fixture);
    expect(result.verdict).toBe("CONSISTENT");
  });

  it("disconnectAfter -1 / absent means an empty base", () => {
    const expanded = expandChunks(simpleFixture("RESUME_FROM_CHECKPOINT").events);
    const resolved = resolveCheckpoint(expanded, undefined, null);
    expect(resolved.checkpointIndex).toBe(-1);
    expect(resolved.baseState).toEqual(initialState());
  });
});

describe("checkpoint coverage (N16)", () => {
  it("a checkpoint covering only sharedState restores messages from the prefix", () => {
    const result = evaluateFixture(loadFixture("N16"));
    expect(result.verdict).toBe("CONSISTENT");
    expect(result.resumeState?.messages.map((m) => m.id)).toEqual(["msg-1"]);
    expect(result.resumeState?.sharedState).toEqual({ count: 5 });
  });
});

describe("UNCLOSED_STREAM_ITEM -> TRUNCATED_RUN mapping", () => {
  it("G08: report has TRUNCATED_RUN (WARNING) and no UNCLOSED_STREAM_ITEM", () => {
    const result = evaluateFixture(loadFixture("G08"));
    expect(result.verdict).toBe("INCOMPLETE_TRACE");
    expect(result.diagnostics.map((d) => d.code)).toEqual(["TRUNCATED_RUN"]);
    expect(result.diagnostics[0]?.severity).toBe("WARNING");
    expect(
      result.diagnostics.some((d) => d.code === "UNCLOSED_STREAM_ITEM"),
    ).toBe(false);
  });

  it("a run that ENDS with an open item keeps UNCLOSED in fold state only", () => {
    // RUN_FINISHED while msg-1 is still open: the T003 fold records
    // UNCLOSED_STREAM_ITEM (CRITICAL) in RejoinState.diagnostics,
    // but the stream DOES have a terminating event, so the report
    // maps nothing to TRUNCATED_RUN and reports no UNCLOSED code.
    const fixture: ReplayFixture = {
      scenarioId: "T-UNCLOSED",
      events: norm([
        runStart("t1", "r1"),
        ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
        ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "hi" }),
        runFinish("t1", "r1"),
      ]),
      recovery: { strategy: "RESUME_FROM_CHECKPOINT", disconnectAfter: 2 },
    };
    const result = evaluateFixture(fixture);
    expect(result.verdict).toBe("CONSISTENT");
    expect(result.diagnostics).toEqual([]);
    expect(
      result.fullState?.diagnostics.some(
        (d) => d.code === "UNCLOSED_STREAM_ITEM",
      ),
    ).toBe(true);
  });
});

describe("foldTrack replay tolerance", () => {
  it("replaying a TOOL_CALL_START over a closed call records a duplicate, not a throw", () => {
    const result = evaluateFixture(loadFixture("G01"));
    expect(result.verdict).toBe("INCONSISTENT");
    expect(result.resumePath?.toolCalls.map((t) => t.id)).toEqual([
      "call-1",
      "call-1",
    ]);
  });

  it("SUSPECTED_DUPLICATE is a WARNING and the payload is still applied twice", () => {
    const result = evaluateFixture(loadFixture("G07"));
    expect(result.verdict).toBe("INCONSISTENT");
    expect(result.diagnostics.map((d) => d.code)).toEqual([
      "SUSPECTED_DUPLICATE",
    ]);
    expect(result.diagnostics[0]?.severity).toBe("WARNING");
    expect(result.resumeState?.messages[0]?.content).toBe("HelloHello");
  });
});

describe("input limits and invalid input", () => {
  it("41 events -> INCONCLUSIVE_LIMIT with LIMIT_EXCEEDED", () => {
    const events = norm([
      runStart("t1", "r1"),
      ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
      ...Array.from({ length: 37 }, () =>
        ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "x" }),
      ),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      runFinish("t1", "r1"),
    ]);
    expect(events.length).toBe(41);
    const fixture: ReplayFixture = {
      scenarioId: "T-OVER",
      events,
      recovery: { strategy: "RESUME_FROM_CHECKPOINT", disconnectAfter: 2 },
    };
    const result = evaluateFixture(fixture);
    expect(result.verdict).toBe("INCONCLUSIVE_LIMIT");
    expect(result.diagnostics.map((d) => d.code)).toEqual(["LIMIT_EXCEEDED"]);
  });

  it("an unsupported event type -> INVALID_INPUT, never a divergence", () => {
    const fixture: ReplayFixture = {
      scenarioId: "T-BAD",
      events: norm([
        runStart("t1", "r1"),
        ev("STEP_STARTED", { stepName: "s1" }),
      ]),
      recovery: { strategy: "RESUME_FROM_CHECKPOINT", disconnectAfter: 0 },
    };
    const result = evaluateFixture(fixture);
    expect(result.verdict).toBe("INVALID_INPUT");
    expect(result.diagnostics.map((d) => d.code)).toEqual(["INVALID_INPUT"]);
    expect(result.diagnostics[0]?.severity).toBe("CRITICAL");
  });

  it("foldTrack records one history entry per event, in order", () => {
    const fixture = loadFixture("N02");
    const fold = foldTrack(expandChunks(fixture.events), initialState(), -1);
    expect(fold.history.map((h) => h.sourceIndex)).toEqual(
      fixture.events.map((w) => w.sourceIndex),
    );
  });
});
