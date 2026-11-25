/**
 * T003 tests — tool-call lifecycle, STATE events and MESSAGES_SNAPSHOT, checkpoints.
 * Covers PROJECT_BOOK §3.10–§3.17, §5.5, §5.7 and EVENT_SCHEMA §5.5, §6.
 */
import { describe, expect, it } from "vitest";
import type { AGUIMessage, JsonPatch } from "../../src/protocol/types.js";
import { makeCheckpoint } from "../../src/core/snapshot.js";
import { ev, run, runFinish, runNorm, runStart } from "./helpers.js";

function toolCallRun(extra: readonly unknown[] = []): ReturnType<typeof run> {
  return run([
    runStart(),
    ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search", parentMessageId: "m1" }),
    ev("TOOL_CALL_ARGS", { toolCallId: "tc1", delta: '{"q":' }),
    ev("TOOL_CALL_ARGS", { toolCallId: "tc1", delta: '"x"}' }),
    ev("TOOL_CALL_END", { toolCallId: "tc1" }),
    ...(extra as never[]),
  ]);
}

describe("tool-call lifecycle", () => {
  it("START/ARGS/END splices args in arrival order and becomes pending", () => {
    const s = toolCallRun();
    expect(s.toolCalls[0]).toMatchObject({
      id: "tc1",
      name: "search",
      parentMessageId: "m1",
      arguments: '{"q":"x"}',
      status: "closed",
      hasResult: false,
    });
    expect(s.pendingToolCallIds).toEqual(["tc1"]);
  });

  it("ARGS for a never-opened call throws", () => {
    expect(() =>
      run([runStart(), ev("TOOL_CALL_ARGS", { toolCallId: "ghost", delta: "{}" })]),
    ).toThrow(/ARGS_WITHOUT_START/);
  });

  it("END for a never-opened call throws", () => {
    expect(() => run([runStart(), ev("TOOL_CALL_END", { toolCallId: "ghost" })])).toThrow(
      /END_WITHOUT_START/,
    );
  });

  it("duplicate START while open throws (G01: no silent second logical call)", () => {
    expect(() =>
      run([
        runStart(),
        ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search" }),
        ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search" }),
      ]),
    ).toThrow(/DUPLICATE_TOOL_CALL_START/);
  });

  it("RESULT in the same run creates the tool message and clears pending", () => {
    const s = run([
      runStart(),
      ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search" }),
      ev("TOOL_CALL_ARGS", { toolCallId: "tc1", delta: "{}" }),
      ev("TOOL_CALL_END", { toolCallId: "tc1" }),
      ev("TOOL_CALL_RESULT", { messageId: "tm1", toolCallId: "tc1", content: "42" }),
      runFinish(),
    ]);
    expect(s.toolCalls[0]).toMatchObject({
      status: "resulted",
      hasResult: true,
      resultMessageId: "tm1",
      resultContent: "42",
    });
    expect(s.pendingToolCallIds).toEqual([]);
    const toolMsg = s.messages.find((m) => m.id === "tm1");
    expect(toolMsg).toMatchObject({ role: "tool", content: "42", toolCallId: "tc1", status: "closed" });
  });

  it("a second RESULT for the same logical execution throws", () => {
    expect(() =>
      run([
        runStart(),
        ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search" }),
        ev("TOOL_CALL_END", { toolCallId: "tc1" }),
        ev("TOOL_CALL_RESULT", { messageId: "tm1", toolCallId: "tc1", content: "a" }),
        ev("TOOL_CALL_RESULT", { messageId: "tm2", toolCallId: "tc1", content: "b" }),
      ]),
    ).toThrow(/DUPLICATE_TOOL_CALL_RESULT/);
  });

  it("RESULT for an unknown call throws", () => {
    expect(() =>
      run([runStart(), ev("TOOL_CALL_RESULT", { messageId: "tm1", toolCallId: "ghost", content: "x" })]),
    ).toThrow(/RESULT_WITHOUT_CALL/);
  });

  it("RESULT with a duplicate tool messageId throws", () => {
    expect(() =>
      run([
        runStart(),
        ev("TEXT_MESSAGE_START", { messageId: "tm1" }),
        ev("TEXT_MESSAGE_END", { messageId: "tm1" }),
        ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search" }),
        ev("TOOL_CALL_END", { toolCallId: "tc1" }),
        ev("TOOL_CALL_RESULT", { messageId: "tm1", toolCallId: "tc1", content: "x" }),
      ]),
    ).toThrow(/DUPLICATE_MESSAGE_ID/);
  });

  it("legal reopen (same name/parent) starts a new logical execution that may receive its own result", () => {
    const s = run([
      runStart(),
      ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search", parentMessageId: "m1" }),
      ev("TOOL_CALL_ARGS", { toolCallId: "tc1", delta: "{}" }),
      ev("TOOL_CALL_END", { toolCallId: "tc1" }),
      ev("TOOL_CALL_RESULT", { messageId: "tm1", toolCallId: "tc1", content: "first" }),
      ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search", parentMessageId: "m1" }),
      ev("TOOL_CALL_ARGS", { toolCallId: "tc1", delta: "{}" }),
      ev("TOOL_CALL_END", { toolCallId: "tc1" }),
      ev("TOOL_CALL_RESULT", { messageId: "tm2", toolCallId: "tc1", content: "second" }),
      runFinish(),
    ]);
    expect(s.toolCalls).toHaveLength(1);
    expect(s.toolCalls[0]).toMatchObject({
      status: "resulted",
      hasResult: true,
      resultMessageId: "tm2",
      resultContent: "second",
    });
    expect(s.pendingToolCallIds).toEqual([]);
  });

  it("reopen with a different toolCallName throws", () => {
    expect(() =>
      run([
        runStart(),
        ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search" }),
        ev("TOOL_CALL_END", { toolCallId: "tc1" }),
        ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "other" }),
      ]),
    ).toThrow(/TOOL_CALL_REOPEN_NAME_MISMATCH/);
  });

  it("reopen with a different parentMessageId throws TOOL_CALL_ID_REUSE", () => {
    expect(() =>
      run([
        runStart(),
        ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search", parentMessageId: "m1" }),
        ev("TOOL_CALL_END", { toolCallId: "tc1" }),
        ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search", parentMessageId: "m2" }),
      ]),
    ).toThrow(/TOOL_CALL_ID_REUSE/);
  });
});

describe("pendingToolCallIds and RUN_FINISHED outcome (§3.14)", () => {
  it("run may end successfully with a pending frontend call listed in outcome", () => {
    const s = run([
      ...[
        runStart(),
        ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search" }),
        ev("TOOL_CALL_ARGS", { toolCallId: "tc1", delta: "{}" }),
        ev("TOOL_CALL_END", { toolCallId: "tc1" }),
      ],
      runFinish("t1", "r1", { outcome: { type: "success", pendingToolCallIds: ["tc1"] } }),
    ]);
    expect(s.runStatus).toBe("FINISHED");
    expect(s.pendingToolCallIds).toEqual(["tc1"]);
    expect(s.diagnostics).toEqual([]);
  });

  it("outcome.pendingToolCallIds disagreeing with the run's unresulted calls throws", () => {
    expect(() =>
      run([
        runStart(),
        ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search" }),
        ev("TOOL_CALL_END", { toolCallId: "tc1" }),
        runFinish("t1", "r1", { outcome: { type: "success", pendingToolCallIds: [] } }),
      ]),
    ).toThrow(/PENDING_TOOL_CALL_MISMATCH/);
    expect(() =>
      run([
        runStart(),
        ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search" }),
        ev("TOOL_CALL_END", { toolCallId: "tc1" }),
        runFinish("t1", "r1", { outcome: { type: "success", pendingToolCallIds: ["tcX"] } }),
      ]),
    ).toThrow(/PENDING_TOOL_CALL_MISMATCH/);
  });

  it("the result arrives in the NEXT run's input messages and clears pending", () => {
    const s = run([
      runStart(),
      ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search" }),
      ev("TOOL_CALL_ARGS", { toolCallId: "tc1", delta: "{}" }),
      ev("TOOL_CALL_END", { toolCallId: "tc1" }),
      runFinish("t1", "r1", { outcome: { type: "success", pendingToolCallIds: ["tc1"] } }),
      runStart("t1", "r2", {
        input: {
          threadId: "t1",
          runId: "r2",
          messages: [
            { id: "tm1", role: "tool", content: "result-via-input", toolCallId: "tc1" },
          ],
        },
      }),
      runFinish("t1", "r2"),
    ]);
    expect(s.toolCalls[0]).toMatchObject({
      status: "resulted",
      hasResult: true,
      resultMessageId: "tm1",
      resultContent: "result-via-input",
    });
    expect(s.pendingToolCallIds).toEqual([]);
    expect(s.messages.find((m) => m.id === "tm1")).toMatchObject({
      role: "tool",
      content: "result-via-input",
    });
  });

  it("a run ending with an open call marks it incomplete (diagnostic, no fake result, not pending)", () => {
    const s = run([
      runStart(),
      ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search" }),
      runFinish(),
    ]);
    expect(s.toolCalls[0]?.status).toBe("incomplete");
    expect(s.pendingToolCallIds).toEqual([]);
    expect(s.diagnostics.some((d) => d.code === "UNCLOSED_STREAM_ITEM")).toBe(true);
  });
});

describe("STATE_SNAPSHOT / STATE_DELTA", () => {
  it("STATE_SNAPSHOT replaces the whole shared state (never deep-merges)", () => {
    const s = run([
      runStart(),
      ev("STATE_SNAPSHOT", { snapshot: { a: 1, b: { c: 2 } } }),
      ev("STATE_SNAPSHOT", { snapshot: { b: 3 } }),
      runFinish(),
    ]);
    expect(s.sharedState).toEqual({ b: 3 });
  });

  it("STATE_DELTA applies ops in order (add/replace/remove/move/copy/test)", () => {
    const s = run([
      runStart(),
      ev("STATE_SNAPSHOT", { snapshot: { a: 1, list: [1, 2], nested: { x: "x" } } }),
      ev("STATE_DELTA", {
        delta: [
          { op: "replace", path: "/a", value: 9 },
          { op: "add", path: "/list/-", value: 3 },
          { op: "move", from: "/nested/x", path: "/moved" },
          { op: "copy", from: "/a", path: "/aCopy" },
          { op: "test", path: "/a", value: 9 },
          { op: "remove", path: "/aCopy" },
        ] as unknown as JsonPatch,
      }),
      runFinish(),
    ]);
    // move leaves the emptied parent object behind (RFC 6902: only the
    // moved member is removed, not its parent).
    expect(s.sharedState).toEqual({ a: 9, list: [1, 2, 3], nested: {}, moved: "x" });
    expect(s.diagnostics).toEqual([]);
  });

  it("STATE_DELTA applies atomically: one failing op keeps the prior value", () => {
    const before = { a: 1, b: 2 };
    const s = run([
      runStart(),
      ev("STATE_SNAPSHOT", { snapshot: before }),
      ev("STATE_DELTA", {
        delta: [
          { op: "replace", path: "/a", value: 99 },
          { op: "remove", path: "/missing" },
        ] as unknown as JsonPatch,
      }),
      runFinish(),
    ]);
    expect(s.sharedState).toEqual(before);
    expect(s.diagnostics).toHaveLength(1);
    expect(s.diagnostics[0]).toMatchObject({ code: "SNAPSHOT_MISMATCH", severity: "CRITICAL" });
  });

  it("a failing test op discards the whole patch", () => {
    const s = run([
      runStart(),
      ev("STATE_SNAPSHOT", { snapshot: { a: 1 } }),
      ev("STATE_DELTA", {
        delta: [
          { op: "replace", path: "/a", value: 2 },
          { op: "test", path: "/a", value: 999 },
        ] as unknown as JsonPatch,
      }),
      runFinish(),
    ]);
    expect(s.sharedState).toEqual({ a: 1 });
    expect(s.diagnostics[0]?.code).toBe("SNAPSHOT_MISMATCH");
    expect(s.diagnostics[0]?.message).toContain("TEST_FAILED");
  });

  it("an unknown op is discarded with a warning and the rest of the patch still applies", () => {
    const s = run([
      runStart(),
      ev("STATE_SNAPSHOT", { snapshot: { a: 1 } }),
      ev("STATE_DELTA", {
        delta: [
          { op: "frobnicate", path: "/a", value: 5 },
          { op: "add", path: "/b", value: 2 },
        ] as unknown as JsonPatch,
      }),
      runFinish(),
    ]);
    expect(s.sharedState).toEqual({ a: 1, b: 2 });
    expect(s.diagnostics).toHaveLength(1);
    expect(s.diagnostics[0]).toMatchObject({ code: "UNKNOWN_PATCH_OP", severity: "WARNING" });
  });

  it("an empty patch is a legal no-op", () => {
    const s = run([
      runStart(),
      ev("STATE_SNAPSHOT", { snapshot: { a: 1 } }),
      ev("STATE_DELTA", { delta: [] }),
      runFinish(),
    ]);
    expect(s.sharedState).toEqual({ a: 1 });
    expect(s.diagnostics).toEqual([]);
  });

  it("STATE_DELTA with no baseline is a SNAPSHOT_MISMATCH and applies nothing", () => {
    const s = run([ev("STATE_DELTA", { delta: [{ op: "add", path: "/a", value: 1 }] as unknown as JsonPatch })]);
    expect(s.sharedState).toBeUndefined();
    expect(s.diagnostics[0]).toMatchObject({ code: "SNAPSHOT_MISMATCH", severity: "CRITICAL" });
  });

  it("STATE_DELTA after RUN_STARTED without input.state uses the {} baseline", () => {
    const s = run([
      runStart(),
      ev("STATE_DELTA", { delta: [{ op: "add", path: "/a", value: 1 }] as unknown as JsonPatch }),
      runFinish(),
    ]);
    expect(s.sharedState).toEqual({ a: 1 });
    expect(s.diagnostics).toEqual([]);
  });

  it("RUN_STARTED input.state conflicting with the live baseline is kept out (diagnostic, live wins)", () => {
    const s = run([
      runStart("t1", "r1", { input: { threadId: "t1", runId: "r1", messages: [], state: { v: 1 } } }),
      ev("STATE_DELTA", { delta: [{ op: "replace", path: "/v", value: 2 }] as unknown as JsonPatch }),
      runFinish("t1", "r1"),
      runStart("t1", "r2", { input: { threadId: "t1", runId: "r2", messages: [], state: { v: 1 } } }),
      runFinish("t1", "r2"),
    ]);
    expect(s.sharedState).toEqual({ v: 2 });
    expect(s.diagnostics.some((d) => d.code === "SNAPSHOT_MISMATCH")).toBe(true);
  });
});

describe("MESSAGES_SNAPSHOT reconciliation (§3.17 + per-role self-revoking)", () => {
  const m1 = { id: "m1", role: "assistant", content: "old-one" };
  const m2 = { id: "m2", role: "user", content: "hello" };

  it("rule 1: same id replaces in place (position kept)", () => {
    const s = run([
      runStart(),
      ev("MESSAGES_SNAPSHOT", { messages: [m1, m2] as unknown as AGUIMessage[] }),
      ev("MESSAGES_SNAPSHOT", {
        messages: [{ id: "m1", role: "assistant", content: "new-one" }, m2] as unknown as AGUIMessage[],
      }),
      runFinish(),
    ]);
    expect(s.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(s.messages[0]?.content).toBe("new-one");
  });

  it("a snapshot message holds ONE segment: a two-segment streamed message collapses (FIX-T003-G03)", () => {
    const s = run([
      runStart(),
      ev("TEXT_MESSAGE_START", { messageId: "m1" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "Hello, " }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      ev("TEXT_MESSAGE_START", { messageId: "m1" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "world." }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      runFinish(),
    ]);
    expect(s.messages[0]?.segments).toEqual([{ text: "Hello, " }, { text: "world." }]);
    const snap = run([
      runStart(),
      ev("TEXT_MESSAGE_START", { messageId: "m1" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "Hello, " }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      ev("TEXT_MESSAGE_START", { messageId: "m1" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "world." }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      ev("MESSAGES_SNAPSHOT", {
        messages: [{ id: "m1", role: "assistant", content: "Hello, world." }] as unknown as AGUIMessage[],
      }),
      runFinish(),
    ]);
    expect(snap.messages[0]?.content).toBe("Hello, world.");
    expect(snap.messages[0]?.segments).toEqual([{ text: "Hello, world." }]);
  });

  it("rule 2: new ids append in snapshot order; rule 3: absent producer messages are removed", () => {
    const s = run([
      runStart(),
      ev("MESSAGES_SNAPSHOT", { messages: [m1, m2] as unknown as AGUIMessage[] }),
      ev("MESSAGES_SNAPSHOT", {
        messages: [
          m1,
          { id: "m3", role: "assistant", content: "third" },
        ] as unknown as AGUIMessage[],
      }),
      runFinish(),
    ]);
    expect(s.messages.map((m) => m.id)).toEqual(["m1", "m3"]);
  });

  it("is NOT a wholesale overwrite: streamed messages absent from the snapshot are removed, snapshot order governs appends", () => {
    const s = run([
      runStart(),
      ev("TEXT_MESSAGE_START", { messageId: "s1" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "s1", delta: "streamed" }),
      ev("TEXT_MESSAGE_END", { messageId: "s1" }),
      ev("MESSAGES_SNAPSHOT", { messages: [m1] as unknown as AGUIMessage[] }),
      runFinish(),
    ]);
    expect(s.messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("rule 4a: client-only activity is KEPT when the snapshot carries no activity", () => {
    const activity = { id: "a1", role: "activity", content: "typing…" };
    const s = run([
      runStart("t1", "r1", {
        input: {
          threadId: "t1",
          runId: "r1",
          messages: [activity as unknown as AGUIMessage],
        },
      }),
      ev("MESSAGES_SNAPSHOT", { messages: [m1] as unknown as AGUIMessage[] }),
      runFinish(),
    ]);
    expect(s.messages.map((m) => m.id)).toEqual(["a1", "m1"]);
  });

  it("rule 4b: client-only activity is DROPPED when the snapshot itself carries any activity (per-role self-revoking)", () => {
    const activity = { id: "a1", role: "activity", content: "typing…" };
    const s = run([
      runStart("t1", "r1", {
        input: {
          threadId: "t1",
          runId: "r1",
          messages: [activity as unknown as AGUIMessage],
        },
      }),
      ev("MESSAGES_SNAPSHOT", {
        messages: [m1, { id: "a2", role: "activity", content: "working" }] as unknown as AGUIMessage[],
      }),
      runFinish(),
    ]);
    expect(s.messages.map((m) => m.id)).toEqual(["m1", "a2"]);
  });

  it("rule 4c: the same self-revoking rule holds for reasoning, independently of activity", () => {
    const reasoning = { id: "r-msg", role: "reasoning", content: "thinking" };
    const activity = { id: "a1", role: "activity", content: "typing…" };
    const s = run([
      runStart("t1", "r1", {
        input: {
          threadId: "t1",
          runId: "r1",
          messages: [reasoning as unknown as AGUIMessage, activity as unknown as AGUIMessage],
        },
      }),
      ev("MESSAGES_SNAPSHOT", {
        messages: [m1, { id: "r2", role: "reasoning", content: "new thought" }] as unknown as AGUIMessage[],
      }),
      runFinish(),
    ]);
    // Reasoning declared -> old reasoning dropped; activity NOT declared -> kept.
    expect(s.messages.map((m) => m.id)).toEqual(["a1", "m1", "r2"]);
  });

  it("snapshot assistant toolCalls sync into toolCalls (create-only, never clobbers streamed state)", () => {
    const s = run([
      runStart(),
      ev("MESSAGES_SNAPSHOT", {
        messages: [
          {
            id: "m1",
            role: "assistant",
            content: "",
            toolCalls: [{ id: "tc9", type: "function", function: { name: "lookup", arguments: '{"k":1}' } }],
          },
        ] as unknown as AGUIMessage[],
      }),
      runFinish(),
    ]);
    expect(s.toolCalls[0]).toMatchObject({
      id: "tc9",
      name: "lookup",
      parentMessageId: "m1",
      arguments: '{"k":1}',
      status: "closed",
    });
    expect(s.pendingToolCallIds).toEqual(["tc9"]);
  });
});

describe("RecoveryCheckpoint (PROJECT_BOOK §4.4)", () => {
  it("makeCheckpoint captures a deep clone of the state plus declared coverage", () => {
    const s = run([
      runStart(),
      ev("STATE_SNAPSHOT", { snapshot: { a: 1 } }),
      ev("TEXT_MESSAGE_START", { messageId: "m1" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "hi" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      runFinish(),
    ]);
    const cp = makeCheckpoint(s, 5, { sharedState: true, messages: true });
    expect(cp.threadId).toBe("t1");
    expect(cp.sourceIndex).toBe(5);
    expect(cp.stateSnapshot).toEqual({ a: 1 });
    expect(cp.messagesSnapshot?.map((m) => m.id)).toEqual(["m1"]);
    expect(cp.capturedState).toEqual(s);
    expect(cp.coverage).toEqual({ sharedState: true, messages: true });
    // The captured state is a clone: mutating the checkpoint must not move the live state.
    (cp.capturedState.messages[0] as { content: string }).content = "tampered";
    expect(s.messages[0]?.content).toBe("hi");
    // Uncovered dimensions are absent.
    const cp2 = makeCheckpoint(s, 5, { sharedState: false, messages: false });
    expect(cp2.stateSnapshot).toBeUndefined();
    expect(cp2.messagesSnapshot).toBeUndefined();
    expect(cp2.capturedState).toEqual(s);
  });
});

describe("15-event coverage sweep", () => {
  it("every MVP event type reduces without throwing in a valid sequence", () => {
    // Chunk forms are expanded by reduceEvents; explicit forms reduce
    // directly. All 15 MVP types appear exactly once here (chunks count
    // as their own types pre-expansion).
    const s = runNorm([
      runStart(),
      ev("TEXT_MESSAGE_CHUNK", { messageId: "m1", delta: "Hel" }),
      ev("TEXT_MESSAGE_CHUNK", { delta: "lo" }),
      ev("TOOL_CALL_CHUNK", { toolCallId: "tc1", toolCallName: "search", delta: "{}" }),
      ev("TOOL_CALL_RESULT", { messageId: "tm1", toolCallId: "tc1", content: "ok" }),
      ev("STATE_SNAPSHOT", { snapshot: { a: 1 } }),
      ev("STATE_DELTA", { delta: [{ op: "add", path: "/b", value: 2 }] as unknown as JsonPatch }),
      ev("MESSAGES_SNAPSHOT", {
        messages: [{ id: "m1", role: "assistant", content: "Hello" }] as unknown as AGUIMessage[],
      }),
      ev("RUN_ERROR", { message: "late failure" }),
      runStart("t1", "r2"),
      ev("TEXT_MESSAGE_START", { messageId: "m2" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m2", delta: "x" }),
      ev("TEXT_MESSAGE_END", { messageId: "m2" }),
      ev("TOOL_CALL_START", { toolCallId: "tc2", toolCallName: "f" }),
      ev("TOOL_CALL_ARGS", { toolCallId: "tc2", delta: "{}" }),
      ev("TOOL_CALL_END", { toolCallId: "tc2" }),
      runFinish("t1", "r2"),
    ]);
    expect(s.runs.map((r) => r.runId)).toEqual(["r1", "r2"]);
    expect(s.runs[0]?.status).toBe("ERROR");
    expect(s.runs[1]?.status).toBe("FINISHED");
    expect(s.messages.find((m) => m.id === "m1")?.content).toBe("Hello");
    expect(s.toolCalls.find((t) => t.id === "tc1")?.status).toBe("resulted");
    expect(s.toolCalls.find((t) => t.id === "tc2")?.status).toBe("closed");
    expect(s.pendingToolCallIds).toEqual(["tc2"]);
    expect(s.sharedState).toEqual({ a: 1, b: 2 });
    expect(s.diagnostics.some((d) => d.code === "RUN_ERROR")).toBe(true);
    // Every expanded event produced exactly one timeline entry:
    // 21 expanded events (2 synthetic ENDs: TOOL_CALL_END before the
    // RESULT, TEXT_MESSAGE_END at MESSAGES_SNAPSHOT lane close).
    expect(s.orderedTimeline).toHaveLength(21);
  });
});
