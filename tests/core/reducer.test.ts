/**
 * T003 tests — Reducer: runs, text messages, chunk expansion, timeline.
 * Covers PROJECT_BOOK §3.3–§3.9, §5.4, §5.6 and EVENT_SCHEMA §4.1/§4.5.
 */
import { describe, expect, it } from "vitest";
import { initialState, ReducerError } from "../../src/core/state.js";
import { reduceEvent, reduceEvents } from "../../src/core/reducer.js";
import { expandChunks } from "../../src/parser/normalize.js";
import { deepFreeze, ev, norm, run, runFinish, runNorm, runStart, simpleRun } from "./helpers.js";

describe("initialState", () => {
  it("has the frozen §5.3 shape with no thread, no runs, no baseline", () => {
    const s = initialState();
    expect(s.threadId).toBeNull();
    expect(s.runs).toEqual([]);
    expect(s.messages).toEqual([]);
    expect(s.toolCalls).toEqual([]);
    expect(s.sharedState).toBeUndefined();
    expect(s.orderedTimeline).toEqual([]);
    expect(s.pendingToolCallIds).toEqual([]);
    expect(s.runStatus).toBe("NOT_STARTED");
    expect(s.diagnostics).toEqual([]);
  });
});

describe("RUN_STARTED / RUN_FINISHED", () => {
  it("starts a run, fixes threadId, defaults the state baseline to {}", () => {
    const s = run([runStart()]);
    expect(s.threadId).toBe("t1");
    expect(s.runStatus).toBe("RUNNING");
    expect(s.runs).toHaveLength(1);
    expect(s.runs[0]).toMatchObject({ runId: "r1", threadId: "t1", status: "RUNNING" });
    expect(s.sharedState).toEqual({});
  });

  it("adopts input.state as the baseline when present", () => {
    const s = run([
      runStart("t1", "r1", {
        input: { threadId: "t1", runId: "r1", messages: [], state: { count: 3 } },
      }),
    ]);
    expect(s.sharedState).toEqual({ count: 3 });
  });

  it("finishes a run as FINISHED with no outcome (absent = success)", () => {
    const s = run(simpleRun());
    expect(s.runStatus).toBe("FINISHED");
    expect(s.runs[0]?.status).toBe("FINISHED");
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ id: "m1", content: "hi", status: "closed" });
  });

  it("finishes a run as CANCELLED for outcome cancelled", () => {
    const s = run([
      runStart(),
      runFinish("t1", "r1", { outcome: { type: "cancelled" } }),
    ]);
    expect(s.runStatus).toBe("CANCELLED");
    expect(s.runs[0]?.status).toBe("CANCELLED");
  });

  it("records an interrupt outcome without treating it as success or error", () => {
    const s = run([
      runStart(),
      runFinish("t1", "r1", { outcome: { type: "interrupt", interrupts: [{ id: "i1" }] } }),
    ]);
    expect(s.runStatus).toBe("FINISHED");
    expect(s.runs[0]?.outcome).toEqual({ type: "interrupt", interrupts: [{ id: "i1" }] });
  });

  it("throws when a second run starts while one is still running", () => {
    expect(() => run([runStart(), runStart("t1", "r2")])).toThrow(ReducerError);
    expect(() => run([runStart(), runStart("t1", "r2")])).toThrow(/still open/);
  });

  it("throws when a runId is reused for another run", () => {
    expect(() => run([...simpleRun(), runStart("t1", "r1")])).toThrow(/reuses runId/);
  });

  it("throws when a second threadId appears mid-trace", () => {
    expect(() => run([...simpleRun(), runStart("t2", "r2")])).toThrow(/THREAD_MISMATCH/);
  });

  it("throws on RUN_FINISHED with no run open", () => {
    expect(() => run([runFinish()])).toThrow(/FINISH_WITHOUT_START/);
  });

  it("throws on RUN_FINISHED for the wrong runId", () => {
    expect(() => run([runStart(), runFinish("t1", "rX")])).toThrow(/FINISH_WRONG_RUN/);
  });

  it("throws when RUN_STARTED input identity disagrees with the event", () => {
    expect(() =>
      run([
        runStart("t1", "r1", {
          input: { threadId: "t1", runId: "rOTHER", messages: [] },
        }),
      ]),
    ).toThrow(/RUN_INPUT_MISMATCH/);
  });

  it("supports many runs on one thread, in order", () => {
    const s = run([
      ...simpleRun(),
      runStart("t1", "r2"),
      ev("TEXT_MESSAGE_START", { messageId: "m2" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m2", delta: "second" }),
      ev("TEXT_MESSAGE_END", { messageId: "m2" }),
      runFinish("t1", "r2"),
    ]);
    expect(s.runs.map((r) => r.runId)).toEqual(["r1", "r2"]);
    expect(s.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(s.messages[1]?.content).toBe("second");
    expect(s.runStatus).toBe("FINISHED");
  });
});

describe("RUN_ERROR", () => {
  it("before RUN_STARTED: records the failure, no run entry, status ERROR", () => {
    const s = run([ev("RUN_ERROR", { message: "startup failed", code: "E_BOOT" })]);
    expect(s.runStatus).toBe("ERROR");
    expect(s.runs).toEqual([]);
    expect(s.diagnostics).toHaveLength(1);
    expect(s.diagnostics[0]).toMatchObject({ code: "RUN_ERROR", severity: "CRITICAL" });
    expect(s.diagnostics[0]?.message).toContain("startup failed");
  });

  it("during a run: ends the run, marks open items incomplete, invents no result", () => {
    const s = run([
      runStart(),
      ev("TEXT_MESSAGE_START", { messageId: "m1" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "part" }),
      ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search" }),
      ev("TOOL_CALL_ARGS", { toolCallId: "tc1", delta: "{}" }),
      ev("RUN_ERROR", { message: "upstream died" }),
    ]);
    expect(s.runStatus).toBe("ERROR");
    expect(s.runs[0]?.status).toBe("ERROR");
    expect(s.runs[0]?.error).toEqual({ message: "upstream died" });
    expect(s.messages[0]?.status).toBe("incomplete");
    expect(s.messages[0]?.content).toBe("part");
    expect(s.toolCalls[0]?.status).toBe("incomplete");
    // No fake result, no pending entry for the incomplete call.
    expect(s.toolCalls[0]?.hasResult).toBe(false);
    expect(s.pendingToolCallIds).toEqual([]);
    expect(s.messages.filter((m) => m.role === "tool")).toEqual([]);
    expect(s.diagnostics.some((d) => d.code === "RUN_ERROR")).toBe(true);
    expect(s.diagnostics.some((d) => d.code === "UNCLOSED_STREAM_ITEM")).toBe(true);
  });

  it("a new run can start after a RUN_ERROR", () => {
    const s = run([
      runStart(),
      ev("RUN_ERROR", { message: "boom" }),
      runStart("t1", "r2"),
      runFinish("t1", "r2"),
    ]);
    expect(s.runs).toHaveLength(2);
    expect(s.runs[0]?.status).toBe("ERROR");
    expect(s.runs[1]?.status).toBe("FINISHED");
    expect(s.runStatus).toBe("FINISHED");
  });
});

describe("text message lifecycle", () => {
  it("START/CONTENT/END concatenates deltas in arrival order; role defaults to assistant", () => {
    const s = run([
      runStart(),
      ev("TEXT_MESSAGE_START", { messageId: "m1" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "Hel" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "lo" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      runFinish(),
    ]);
    expect(s.messages[0]).toMatchObject({ id: "m1", role: "assistant", content: "Hello", status: "closed" });
  });

  it("empty delta is legal (keep-alive) and adds no text", () => {
    const s = run([
      runStart(),
      ev("TEXT_MESSAGE_START", { messageId: "m1" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "x" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      runFinish(),
    ]);
    expect(s.messages[0]?.content).toBe("x");
    expect(s.diagnostics).toEqual([]);
  });

  it("CONTENT for a never-opened message throws (not silently accepted)", () => {
    expect(() =>
      run([runStart(), ev("TEXT_MESSAGE_CONTENT", { messageId: "ghost", delta: "x" })]),
    ).toThrow(/CONTENT_WITHOUT_START/);
  });

  it("CONTENT for a closed message throws", () => {
    expect(() =>
      run([
        ...simpleRun().slice(0, 4),
        ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "late" }),
      ]),
    ).toThrow(/CONTENT_WITHOUT_START/);
  });

  it("END for a never-opened message throws", () => {
    expect(() => run([runStart(), ev("TEXT_MESSAGE_END", { messageId: "ghost" })])).toThrow(
      /END_WITHOUT_START/,
    );
  });

  it("duplicate START while open throws", () => {
    expect(() =>
      run([
        runStart(),
        ev("TEXT_MESSAGE_START", { messageId: "m1" }),
        ev("TEXT_MESSAGE_START", { messageId: "m1" }),
      ]),
    ).toThrow(/DUPLICATE_MESSAGE_START/);
  });

  it("legal reopen (same role/name) is NOT a violation; content appends in arrival order", () => {
    const s = run([
      runStart(),
      ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant", name: "Helper" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "A" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant", name: "Helper" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "B" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      runFinish(),
    ]);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]?.content).toBe("AB");
    expect(s.diagnostics).toEqual([]);
  });

  it("legal reopen opens a NEW segment; content is the segment join (FIX-T003-G03)", () => {
    const s = run([
      runStart(),
      ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant", name: "Helper" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "A" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant", name: "Helper" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "B" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      runFinish(),
    ]);
    expect(s.messages[0]?.segments).toEqual([{ text: "A" }, { text: "B" }]);
    expect(s.messages[0]?.content).toBe(
      s.messages[0]?.segments.map((seg) => seg.text).join(""),
    );
  });

  it("START opens one empty segment; CONTENT appends to the last segment only", () => {
    const s = run([
      runStart(),
      ev("TEXT_MESSAGE_START", { messageId: "m1" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "Hello, " }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "world." }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      runFinish(),
    ]);
    expect(s.messages[0]?.segments).toEqual([{ text: "Hello, world." }]);
    expect(s.messages[0]?.content).toBe("Hello, world.");
  });

  it("reopen with a different role throws", () => {
    expect(() =>
      run([
        ...simpleRun().slice(0, 4),
        ev("TEXT_MESSAGE_START", { messageId: "m1", role: "user" }),
      ]),
    ).toThrow(/MESSAGE_REOPEN_ROLE_MISMATCH/);
  });

  it("reopen with a different name throws", () => {
    expect(() =>
      run([
        runStart(),
        ev("TEXT_MESSAGE_START", { messageId: "m1", name: "A" }),
        ev("TEXT_MESSAGE_END", { messageId: "m1" }),
        ev("TEXT_MESSAGE_START", { messageId: "m1", name: "B" }),
      ]),
    ).toThrow(/MESSAGE_REOPEN_NAME_MISMATCH/);
  });

  it("stream events outside any run throw", () => {
    expect(() => run([ev("TEXT_MESSAGE_START", { messageId: "m1" })])).toThrow(
      /EVENT_WITHOUT_RUN/,
    );
  });

  it("does not reorder by timestamp: arrival order wins", () => {
    const s = run([
      runStart(),
      ev("TEXT_MESSAGE_START", { messageId: "m1", timestamp: 300 }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "first-", timestamp: 100 }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "second", timestamp: 200 }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      runFinish(),
    ]);
    expect(s.messages[0]?.content).toBe("first-second");
  });

  it("does not mutate its input state or event (frozen inputs reduce fine)", () => {
    const frozen = deepFreeze(initialState());
    const event = deepFreeze(runStart());
    const s = reduceEvent(frozen, event);
    expect(frozen.runStatus).toBe("NOT_STARTED");
    expect(s.runStatus).toBe("RUNNING");
  });
});

describe("orderedTimeline interleave (G03)", () => {
  it("keeps TEXT_A / TOOL_CALL_* / TEXT_B — never collapses to TEXT_AB / TOOL_CALL_*", () => {
    const s = run([
      runStart(),
      ev("TEXT_MESSAGE_START", { messageId: "m1" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "A" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search", parentMessageId: "m1" }),
      ev("TOOL_CALL_ARGS", { toolCallId: "tc1", delta: "{}" }),
      ev("TOOL_CALL_END", { toolCallId: "tc1" }),
      ev("TOOL_CALL_RESULT", { messageId: "tm1", toolCallId: "tc1", content: "ok" }),
      ev("TEXT_MESSAGE_START", { messageId: "m1" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "B" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      runFinish(),
    ]);
    const kinds = s.orderedTimeline.map(
      (t) =>
        `${t.eventType}:${t.messageId ?? t.runId ?? ""}${t.toolCallId !== undefined ? `/${t.toolCallId}` : ""}`,
    );
    expect(kinds).toEqual([
      "RUN_STARTED:r1",
      "TEXT_MESSAGE_START:m1",
      "TEXT_MESSAGE_CONTENT:m1",
      "TEXT_MESSAGE_END:m1",
      "TOOL_CALL_START:m1/tc1",
      "TOOL_CALL_ARGS:/tc1",
      "TOOL_CALL_END:/tc1",
      "TOOL_CALL_RESULT:tm1/tc1",
      "TEXT_MESSAGE_START:m1",
      "TEXT_MESSAGE_CONTENT:m1",
      "TEXT_MESSAGE_END:m1",
      "RUN_FINISHED:r1",
    ]);
    expect(s.messages.find((m) => m.id === "m1")?.content).toBe("AB");
  });

  it("records the delta text on CONTENT / ARGS timeline entries", () => {
    const s = run([
      runStart(),
      ev("TEXT_MESSAGE_START", { messageId: "m1" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "Hello" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      runFinish(),
    ]);
    expect(s.orderedTimeline[2]).toMatchObject({
      eventType: "TEXT_MESSAGE_CONTENT",
      messageId: "m1",
      text: "Hello",
    });
  });
});

describe("chunk expansion through reduceEvents", () => {
  it("TEXT_MESSAGE_CHUNK expands to START/CONTENT/END and reduces", () => {
    const s = runNorm([
      runStart(),
      ev("TEXT_MESSAGE_CHUNK", { messageId: "m1", role: "assistant", delta: "Hel" }),
      ev("TEXT_MESSAGE_CHUNK", { delta: "lo" }),
      runFinish(),
    ]);
    expect(s.messages[0]).toMatchObject({ id: "m1", content: "Hello", status: "closed" });
    expect(s.orderedTimeline.map((t) => t.eventType)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
  });

  it("TOOL_CALL_CHUNK expands to START/ARGS/END and reduces", () => {
    const s = runNorm([
      runStart(),
      ev("TOOL_CALL_CHUNK", { toolCallId: "tc1", toolCallName: "search", delta: '{"q":' }),
      ev("TOOL_CALL_CHUNK", { delta: '"x"}' }),
      runFinish(),
    ]);
    expect(s.toolCalls[0]).toMatchObject({
      id: "tc1",
      name: "search",
      arguments: '{"q":"x"}',
      status: "closed",
    });
    expect(s.pendingToolCallIds).toEqual(["tc1"]);
  });

  it("a chunk opening a different id closes the previous item first", () => {
    const expanded = expandChunks(
      norm([
        ev("TEXT_MESSAGE_CHUNK", { messageId: "m1", delta: "a" }),
        ev("TEXT_MESSAGE_CHUNK", { messageId: "m2", delta: "b" }),
      ]),
    );
    expect(expanded.map((n) => n.event.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
    ]);
    const s = reduceEvents(norm([
      runStart(),
      ev("TEXT_MESSAGE_CHUNK", { messageId: "m1", delta: "a" }),
      ev("TEXT_MESSAGE_CHUNK", { messageId: "m2", delta: "b" }),
      runFinish(),
    ]));
    expect(s.messages.map((m) => [m.id, m.content])).toEqual([
      ["m1", "a"],
      ["m2", "b"],
    ]);
  });

  it("a raw chunk passed to reduceEvent directly throws UNEXPANDED_CHUNK", () => {
    expect(() =>
      reduceEvent(initialState(), ev("TEXT_MESSAGE_CHUNK", { messageId: "m1", delta: "x" })),
    ).toThrow(/UNEXPANDED_CHUNK/);
    expect(() =>
      reduceEvent(initialState(), ev("TOOL_CALL_CHUNK", { toolCallId: "t", toolCallName: "f" })),
    ).toThrow(/UNEXPANDED_CHUNK/);
  });
});

describe("determinism", () => {
  it("the same input reduced twice yields identical state", () => {
    const events = [
      runStart(),
      ev("STATE_SNAPSHOT", { snapshot: { a: 1 } }),
      ev("TEXT_MESSAGE_START", { messageId: "m1" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "hi" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "f" }),
      ev("TOOL_CALL_ARGS", { toolCallId: "tc1", delta: "{}" }),
      ev("TOOL_CALL_END", { toolCallId: "tc1" }),
      ev("TOOL_CALL_RESULT", { messageId: "tm1", toolCallId: "tc1", content: "done" }),
      runFinish(),
    ];
    const a = run(events);
    const b = run(events);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // And reducing the same events again from scratch via reduceEvents agrees.
    expect(JSON.stringify(runNorm(events))).toBe(JSON.stringify(a));
  });

  it("identical repeated content events are NOT deduplicated (SUSPECTED_DUPLICATE is not the Reducer's call)", () => {
    const s = run([
      runStart(),
      ev("TEXT_MESSAGE_START", { messageId: "m1" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "same" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "same" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      runFinish(),
    ]);
    expect(s.messages[0]?.content).toBe("samesame");
    expect(s.orderedTimeline.filter((t) => t.eventType === "TEXT_MESSAGE_CONTENT")).toHaveLength(2);
  });
});
