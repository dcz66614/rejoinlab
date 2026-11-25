/**
 * T002 tests — normalization layer (normalize.ts).
 * Covers: single-event validation, STATE_DELTA patch rules, MESSAGES_SNAPSHOT
 * shape, per-role message required fields (FIX-R2 P1-R2-01), unknown-op
 * pass-through, expandChunks (provided for T003), and the
 * sourceIndex contract (0-based, unique, arrival order, never timestamp
 * sorted).
 */
import { describe, expect, it } from "vitest";
import {
  expandChunks,
  normalizeEvent,
  normalizeEvents,
  ParseError,
  validateEvent,
  type NormalizedEvent,
} from "../../src/parser/normalize.js";
import { parseJsonl } from "../../src/parser/jsonl.js";

function eventsFromJsonl(input: string): NormalizedEvent[] {
  return parseJsonl(input);
}

describe("validateEvent — Schema layer", () => {
  it("accepts all 15 MVP event shapes", () => {
    const samples: Record<string, unknown>[] = [
      { type: "RUN_STARTED", threadId: "t", runId: "r" },
      { type: "RUN_FINISHED", threadId: "t", runId: "r" },
      { type: "RUN_ERROR", message: "boom" },
      { type: "TEXT_MESSAGE_START", messageId: "m" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "m", delta: "" },
      { type: "TEXT_MESSAGE_END", messageId: "m" },
      { type: "TEXT_MESSAGE_CHUNK" },
      { type: "TOOL_CALL_START", toolCallId: "c", toolCallName: "f" },
      { type: "TOOL_CALL_ARGS", toolCallId: "c", delta: "{}" },
      { type: "TOOL_CALL_END", toolCallId: "c" },
      { type: "TOOL_CALL_CHUNK" },
      { type: "TOOL_CALL_RESULT", messageId: "m", toolCallId: "c", content: "ok" },
      { type: "STATE_SNAPSHOT", snapshot: null },
      { type: "STATE_DELTA", delta: [] },
      { type: "MESSAGES_SNAPSHOT", messages: [] },
    ];
    for (const sample of samples) {
      expect(() => validateEvent(sample)).not.toThrow();
    }
  });

  it("STATE_SNAPSHOT with a null snapshot is valid (any JSON value, presence only)", () => {
    expect(validateEvent({ type: "STATE_SNAPSHOT", snapshot: null })).toMatchObject({
      type: "STATE_SNAPSHOT",
      snapshot: null,
    });
  });

  it("STATE_SNAPSHOT without snapshot is INVALID_INPUT", () => {
    expect(() => validateEvent({ type: "STATE_SNAPSHOT" })).toThrow(ParseError);
  });

  it("STATE_DELTA accepts an empty patch array (legal no-op)", () => {
    expect(validateEvent({ type: "STATE_DELTA", delta: [] })).toMatchObject({
      type: "STATE_DELTA",
      delta: [],
    });
  });

  it("STATE_DELTA with an unrecognized op passes through (not malformed; Reducer discards it with a warning, EVENT_SCHEMA §6.2)", () => {
    const event = validateEvent({
      type: "STATE_DELTA",
      delta: [{ op: "frobnicate", path: "/x" }],
    });
    expect(event).toMatchObject({ type: "STATE_DELTA" });
  });

  it("STATE_DELTA move without 'from' is INVALID_INPUT", () => {
    expect(() =>
      validateEvent({ type: "STATE_DELTA", delta: [{ op: "move", path: "/x" }] }),
    ).toThrow(ParseError);
  });

  it("RUN_FINISHED outcome interrupt without interrupts is INVALID_INPUT", () => {
    expect(() =>
      validateEvent({
        type: "RUN_FINISHED",
        threadId: "t",
        runId: "r",
        outcome: { type: "interrupt", interrupts: [] },
      }),
    ).toThrow(ParseError);
  });

  it("RUN_FINISHED outcome success with pendingToolCallIds is valid", () => {
    expect(() =>
      validateEvent({
        type: "RUN_FINISHED",
        threadId: "t",
        runId: "r",
        outcome: { type: "success", pendingToolCallIds: ["c1"] },
      }),
    ).not.toThrow();
  });

  it("TOOL_CALL_RESULT content parts are validated (text part needs text)", () => {
    expect(() =>
      validateEvent({
        type: "TOOL_CALL_RESULT",
        messageId: "m",
        toolCallId: "c",
        content: [{ type: "text" }],
      }),
    ).toThrow(ParseError);
    expect(() =>
      validateEvent({
        type: "TOOL_CALL_RESULT",
        messageId: "m",
        toolCallId: "c",
        content: [{ type: "text", text: "ok" }],
      }),
    ).not.toThrow();
  });

  it("metadata must be an object, never null", () => {
    expect(() =>
      validateEvent({ type: "RUN_STARTED", threadId: "t", runId: "r", metadata: null }),
    ).toThrow(ParseError);
    expect(() =>
      validateEvent({ type: "RUN_STARTED", threadId: "t", runId: "r", metadata: { k: 1 } }),
    ).not.toThrow();
  });
});

describe("validateEvent — per-role message required fields (FIX-R2, P1-R2-01)", () => {
  // AG-UI 1.0 Schema $defs (docs/ag-ui-1.0-schema.json):
  // developer / system / reasoning: id, role, content (string).
  // assistant: id, role (content optional, string when present).
  // user / tool: id, role, content (string or ContentPart array);
  // tool also requires toolCallId (string).
  // activity: id, role, activityType (string), content (object).
  // checkMessagesArray serves BOTH call sites — RUN_STARTED.input and
  // MESSAGES_SNAPSHOT — so every case below is asserted through both.
  //
  // Bilateral status (probed 2026-11-23 with oracle.replay.analyze):
  // the Oracle rejects only the tool-no-content shape (and generic
  // id/role violations) — it still folds developer/system/user/
  // reasoning messages without content, tool messages without
  // toolCallId, and activity messages without activityType/content
  // as CONSISTENT, and on the MESSAGES_SNAPSHOT path it accepts even
  // a tool message without content. Those Oracle gaps need an
  // Oracle-side fix (reported to the coordinator; Oracle production
  // code is out of scope for this fix), so no bilateral fixture
  // assertion is added for them here — and no expected-disagreement
  // assertion is written anywhere. The bilateral INVALID_INPUT
  // fixture that both sides already agree on is
  // input_tool_no_content (tests/s0/gate.test.ts).
  function expectInvalidInput(fn: () => unknown): void {
    let thrown: unknown;
    try {
      fn();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ParseError);
    expect((thrown as ParseError).code).toBe("INVALID_INPUT");
  }

  const invalidCases: { name: string; message: Record<string, unknown> }[] = [
    { name: "developer missing content", message: { id: "m1", role: "developer" } },
    { name: "system missing content", message: { id: "m1", role: "system" } },
    { name: "user missing content", message: { id: "m1", role: "user" } },
    { name: "reasoning missing content", message: { id: "m1", role: "reasoning" } },
    { name: "tool missing content", message: { id: "m1", role: "tool", toolCallId: "c1" } },
    { name: "tool missing toolCallId", message: { id: "m1", role: "tool", content: "ok" } },
    { name: "tool missing content and toolCallId", message: { id: "m1", role: "tool" } },
    { name: "activity missing activityType", message: { id: "m1", role: "activity", content: {} } },
    { name: "activity missing content", message: { id: "m1", role: "activity", activityType: "step" } },
    { name: "assistant missing id", message: { role: "assistant", content: "x" } },
    { name: "assistant content wrong type", message: { id: "m1", role: "assistant", content: 123 } },
    { name: "developer content wrong type", message: { id: "m1", role: "developer", content: 123 } },
    { name: "user content wrong type", message: { id: "m1", role: "user", content: 123 } },
    { name: "tool content wrong type", message: { id: "m1", role: "tool", toolCallId: "c1", content: 123 } },
    { name: "tool toolCallId wrong type", message: { id: "m1", role: "tool", toolCallId: 7, content: "ok" } },
    { name: "activity content wrong type", message: { id: "m1", role: "activity", activityType: "step", content: "x" } },
    { name: "activity activityType wrong type", message: { id: "m1", role: "activity", activityType: 7, content: {} } },
  ];

  it.each(invalidCases)("$name reports INVALID_INPUT on both message paths", ({ message }) => {
    expectInvalidInput(() =>
      validateEvent({
        type: "RUN_STARTED",
        threadId: "t",
        runId: "r",
        input: { threadId: "t", runId: "r", messages: [message] },
      }),
    );
    expectInvalidInput(() =>
      validateEvent({ type: "MESSAGES_SNAPSHOT", messages: [message] }),
    );
  });

  const validCases: { name: string; message: Record<string, unknown> }[] = [
    // Assistant content is optional per schema (a turn may be tool
    // calls only) — rejecting this would over-reject.
    { name: "assistant without content", message: { id: "m1", role: "assistant" } },
    {
      name: "assistant with toolCalls, no content",
      message: {
        id: "m1",
        role: "assistant",
        toolCalls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
      },
    },
    {
      name: "user with ContentPart array content",
      message: { id: "m1", role: "user", content: [{ type: "text", text: "hi" }] },
    },
    {
      name: "tool with ContentPart array content",
      message: { id: "m1", role: "tool", toolCallId: "c1", content: [{ type: "text", text: "ok" }] },
    },
    {
      name: "activity with object content",
      message: { id: "m1", role: "activity", activityType: "step", content: { done: true } },
    },
    { name: "developer with string content", message: { id: "m1", role: "developer", content: "do x" } },
    { name: "reasoning with string content", message: { id: "m1", role: "reasoning", content: "hmm" } },
  ];

  it.each(validCases)("$name is accepted on both message paths", ({ message }) => {
    expect(() =>
      validateEvent({
        type: "RUN_STARTED",
        threadId: "t",
        runId: "r",
        input: { threadId: "t", runId: "r", messages: [message] },
      }),
    ).not.toThrow();
    expect(() =>
      validateEvent({ type: "MESSAGES_SNAPSHOT", messages: [message] }),
    ).not.toThrow();
  });
});

describe("normalizeEvent / normalizeEvents — sourceIndex contract", () => {
  it("sourceIndex is 0-based, unique and in arrival order even when timestamps are out of order", () => {
    const events = eventsFromJsonl(
      `{"type":"RUN_STARTED","threadId":"t","runId":"r","timestamp":3000}\n` +
        `{"type":"TEXT_MESSAGE_START","messageId":"m","timestamp":1000}\n` +
        `{"type":"RUN_FINISHED","threadId":"t","runId":"r","timestamp":2000}`,
    );
    // Timestamps are informational only; arrival order is kept, never sorted.
    expect(events.map((e) => e.sourceIndex)).toEqual([0, 1, 2]);
    expect(events.map((e) => e.event.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "RUN_FINISHED",
    ]);
  });

  it("normalizeEvent assigns the given sourceIndex and transportEventId", () => {
    const n = normalizeEvent(
      { type: "RUN_STARTED", threadId: "t", runId: "r" },
      7,
      "sse-42",
      3,
    );
    expect(n).toMatchObject({ sourceIndex: 7, transportEventId: "sse-42", sourceEventKey: null });
  });

  it("normalizeEvents throws on the first bad event and returns nothing partial", () => {
    expect(() =>
      normalizeEvents([
        { raw: { type: "RUN_STARTED", threadId: "t", runId: "r" }, transportEventId: null },
        { raw: { type: "RUN_FINISHED", threadId: "t" }, transportEventId: null, line: 2 },
      ]),
    ).toThrow(ParseError);
  });
});

describe("expandChunks — provided for T003 (EVENT_SCHEMA §4.5/§5.4)", () => {
  it("expands a text chunk stream into START / CONTENT / END", () => {
    const parsed = eventsFromJsonl(
      `{"type":"TEXT_MESSAGE_CHUNK","messageId":"m1","role":"assistant","delta":"Hello, "}\n` +
        `{"type":"TEXT_MESSAGE_CHUNK","delta":"world."}\n` +
        `{"type":"RUN_FINISHED","threadId":"t","runId":"r"}`,
    );
    const expanded = expandChunks(parsed);
    expect(expanded.map((e) => e.event.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(expanded.map((e) => e.sourceIndex)).toEqual([0, 1, 2, 3, 4]);
    expect(expanded[0]?.event).toMatchObject({
      type: "TEXT_MESSAGE_START",
      messageId: "m1",
      role: "assistant",
    });
    expect(expanded[1]?.event).toMatchObject({ type: "TEXT_MESSAGE_CONTENT", delta: "Hello, " });
    expect(expanded[2]?.event).toMatchObject({ type: "TEXT_MESSAGE_CONTENT", delta: "world." });
    // Synthetic END events were never on the wire: transportEventId null.
    expect(expanded[3]?.transportEventId).toBeNull();
    // Real events keep their transport ids (null here: JSONL source).
    expect(expanded[4]?.event.type).toBe("RUN_FINISHED");
  });

  it("a chunk naming a different messageId closes the previous item first", () => {
    const parsed = eventsFromJsonl(
      `{"type":"TEXT_MESSAGE_CHUNK","messageId":"m1","delta":"a"}\n` +
        `{"type":"TEXT_MESSAGE_CHUNK","messageId":"m2","delta":"b"}`,
    );
    const expanded = expandChunks(parsed);
    expect(expanded.map((e) => e.event.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
    ]);
  });

  it("expands tool call chunks into START / ARGS / END", () => {
    const parsed = eventsFromJsonl(
      `{"type":"TOOL_CALL_CHUNK","toolCallId":"c1","toolCallName":"f","delta":"{\\"a\\":"}\n` +
        `{"type":"TOOL_CALL_CHUNK","delta":"1}"}\n` +
        `{"type":"RUN_FINISHED","threadId":"t","runId":"r"}`,
    );
    const expanded = expandChunks(parsed);
    expect(expanded.map((e) => e.event.type)).toEqual([
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "RUN_FINISHED",
    ]);
    expect(expanded[0]?.event).toMatchObject({
      type: "TOOL_CALL_START",
      toolCallId: "c1",
      toolCallName: "f",
    });
  });

  it("expansion is deterministic", () => {
    const parsed = eventsFromJsonl(
      `{"type":"TEXT_MESSAGE_CHUNK","messageId":"m1","delta":"x"}\n{"type":"RUN_FINISHED","threadId":"t","runId":"r"}`,
    );
    expect(JSON.stringify(expandChunks(parsed))).toBe(JSON.stringify(expandChunks(parsed)));
  });
});

describe("expandChunks — evidence preservation (T002 errata: IMPLEMENTATION_PLAN §5.1)", () => {
  it("first text chunk's timestamp and unknown fields ride on the START", () => {
    const parsed = eventsFromJsonl(
      `{"type":"TEXT_MESSAGE_CHUNK","messageId":"m1","role":"assistant","delta":"Hi","timestamp":1710000000123,"subagentRunId":"sub-1","zzzCustom":"keep-me"}\n` +
        `{"type":"RUN_FINISHED","threadId":"t","runId":"r"}`,
    );
    const expanded = expandChunks(parsed);
    expect(expanded[0]?.event).toMatchObject({
      type: "TEXT_MESSAGE_START",
      messageId: "m1",
      timestamp: 1710000000123,
      subagentRunId: "sub-1",
      zzzCustom: "keep-me",
    });
    // Extras land on the FIRST event the chunk produces; the CONTENT from
    // the same chunk carries only id + delta (+ metadata, if any).
    expect(expanded[1]?.event).toMatchObject({ type: "TEXT_MESSAGE_CONTENT", delta: "Hi" });
    expect("zzzCustom" in (expanded[1]?.event as unknown as Record<string, unknown>)).toBe(false);
    expect("timestamp" in (expanded[1]?.event as unknown as Record<string, unknown>)).toBe(false);
  });

  it("continuation text chunk's timestamp and unknown fields ride on its CONTENT", () => {
    const parsed = eventsFromJsonl(
      `{"type":"TEXT_MESSAGE_CHUNK","messageId":"m1","delta":"Hello, "}\n` +
        `{"type":"TEXT_MESSAGE_CHUNK","delta":"world.","timestamp":1710000000999,"zzzCustom":42}\n` +
        `{"type":"RUN_FINISHED","threadId":"t","runId":"r"}`,
    );
    const expanded = expandChunks(parsed);
    expect(expanded.map((e) => e.event.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(expanded[2]?.event).toMatchObject({
      type: "TEXT_MESSAGE_CONTENT",
      delta: "world.",
      timestamp: 1710000000999,
      zzzCustom: 42,
    });
  });

  it("text chunk with only unknown fields still expands into an event (no delta, no metadata)", () => {
    const parsed = eventsFromJsonl(
      `{"type":"TEXT_MESSAGE_CHUNK","messageId":"m1","delta":"Hello, "}\n` +
        `{"type":"TEXT_MESSAGE_CHUNK","zzzCustom":"evidence","timestamp":1710000000555}\n` +
        `{"type":"RUN_FINISHED","threadId":"t","runId":"r"}`,
    );
    const expanded = expandChunks(parsed);
    expect(expanded.map((e) => e.event.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    // Empty delta adds no text; the chunk's evidence survives on the event.
    expect(expanded[2]?.event).toMatchObject({
      type: "TEXT_MESSAGE_CONTENT",
      delta: "",
      zzzCustom: "evidence",
      timestamp: 1710000000555,
    });
    expect(
      expanded
        .filter((e) => e.event.type === "TEXT_MESSAGE_CONTENT")
        .map((e) => (e.event as unknown as Record<string, unknown>)["delta"])
        .join(""),
    ).toBe("Hello, ");
  });

  it("first text chunk with only unknown fields expands to a START carrying them", () => {
    const parsed = eventsFromJsonl(
      `{"type":"TEXT_MESSAGE_CHUNK","messageId":"m1","zzzCustom":"only-me","timestamp":7}\n` +
        `{"type":"RUN_FINISHED","threadId":"t","runId":"r"}`,
    );
    const expanded = expandChunks(parsed);
    expect(expanded.map((e) => e.event.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(expanded[0]?.event).toMatchObject({
      type: "TEXT_MESSAGE_START",
      messageId: "m1",
      zzzCustom: "only-me",
      timestamp: 7,
    });
  });

  it("chunk metadata is kept and a metadata-only trailing chunk still merges onto the preceding event", () => {
    const parsed = eventsFromJsonl(
      `{"type":"TEXT_MESSAGE_CHUNK","messageId":"m1","delta":"x","metadata":{"a":1},"zzzCustom":"z"}\n` +
        `{"type":"TEXT_MESSAGE_CHUNK","metadata":{"b":2}}\n` +
        `{"type":"RUN_FINISHED","threadId":"t","runId":"r"}`,
    );
    const expanded = expandChunks(parsed);
    expect(expanded.map((e) => e.event.type)).toEqual([
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "RUN_FINISHED",
    ]);
    expect(expanded[0]?.event).toMatchObject({
      type: "TEXT_MESSAGE_START",
      metadata: { a: 1 },
      zzzCustom: "z",
    });
    // No new event for the metadata-only chunk; its metadata merged onto
    // the preceding CONTENT (EVENT_SCHEMA §4.5 rule 6).
    expect(expanded[1]?.event).toMatchObject({
      type: "TEXT_MESSAGE_CONTENT",
      delta: "x",
      metadata: { a: 1, b: 2 },
    });
  });

  it("first tool chunk's timestamp and unknown fields ride on the START, delta stays on ARGS", () => {
    const parsed = eventsFromJsonl(
      `{"type":"TOOL_CALL_CHUNK","toolCallId":"c1","toolCallName":"f","delta":"{}","timestamp":1710000000123,"subagentRunId":"sub-9","zzzCustom":"keep-me"}\n` +
        `{"type":"RUN_FINISHED","threadId":"t","runId":"r"}`,
    );
    const expanded = expandChunks(parsed);
    expect(expanded[0]?.event).toMatchObject({
      type: "TOOL_CALL_START",
      toolCallId: "c1",
      toolCallName: "f",
      timestamp: 1710000000123,
      subagentRunId: "sub-9",
      zzzCustom: "keep-me",
    });
    expect(expanded[1]?.event).toMatchObject({ type: "TOOL_CALL_ARGS", delta: "{}" });
    expect("zzzCustom" in (expanded[1]?.event as unknown as Record<string, unknown>)).toBe(false);
  });

  it("continuation tool chunk's unknown fields ride on its ARGS", () => {
    const parsed = eventsFromJsonl(
      `{"type":"TOOL_CALL_CHUNK","toolCallId":"c1","toolCallName":"f","delta":"{\\"a\\":"}\n` +
        `{"type":"TOOL_CALL_CHUNK","delta":"1}","timestamp":55,"zzzCustom":[1,2]}\n` +
        `{"type":"RUN_FINISHED","threadId":"t","runId":"r"}`,
    );
    const expanded = expandChunks(parsed);
    expect(expanded[2]?.event).toMatchObject({
      type: "TOOL_CALL_ARGS",
      delta: "1}",
      timestamp: 55,
      zzzCustom: [1, 2],
    });
  });

  it("tool chunk with only unknown fields still expands into an ARGS event", () => {
    const parsed = eventsFromJsonl(
      `{"type":"TOOL_CALL_CHUNK","toolCallId":"c1","toolCallName":"f","delta":"{}"}\n` +
        `{"type":"TOOL_CALL_CHUNK","zzzCustom":"evidence"}\n` +
        `{"type":"RUN_FINISHED","threadId":"t","runId":"r"}`,
    );
    const expanded = expandChunks(parsed);
    expect(expanded.map((e) => e.event.type)).toEqual([
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "RUN_FINISHED",
    ]);
    expect(expanded[2]?.event).toMatchObject({
      type: "TOOL_CALL_ARGS",
      delta: "",
      zzzCustom: "evidence",
    });
  });

  it("first tool chunk with only unknown fields expands to a START carrying them", () => {
    const parsed = eventsFromJsonl(
      `{"type":"TOOL_CALL_CHUNK","toolCallId":"c1","toolCallName":"f","zzzCustom":"only-me"}\n` +
        `{"type":"RUN_FINISHED","threadId":"t","runId":"r"}`,
    );
    const expanded = expandChunks(parsed);
    expect(expanded.map((e) => e.event.type)).toEqual([
      "TOOL_CALL_START",
      "TOOL_CALL_END",
      "RUN_FINISHED",
    ]);
    expect(expanded[0]?.event).toMatchObject({
      type: "TOOL_CALL_START",
      toolCallId: "c1",
      zzzCustom: "only-me",
    });
  });

  it("synthetic END events carry no chunk extras", () => {
    const parsed = eventsFromJsonl(
      `{"type":"TEXT_MESSAGE_CHUNK","messageId":"m1","delta":"x","timestamp":1,"zzzCustom":"z"}\n` +
        `{"type":"RUN_FINISHED","threadId":"t","runId":"r"}`,
    );
    const expanded = expandChunks(parsed);
    const end = expanded.find((e) => e.event.type === "TEXT_MESSAGE_END");
    expect(end?.event).toEqual({ type: "TEXT_MESSAGE_END", messageId: "m1" });
  });
});

describe("subagentRunId — EVENT_SCHEMA §7 / D-04 (comment citation fix, behavior unchanged)", () => {
  it("is a legitimate optional field on the 11 Attributable MVP events (never INVALID_INPUT)", () => {
    expect(() =>
      validateEvent({ type: "TEXT_MESSAGE_CHUNK", subagentRunId: "sub-1" }),
    ).not.toThrow();
    expect(
      validateEvent({ type: "STATE_DELTA", delta: [], subagentRunId: "sub-1" }),
    ).toMatchObject({ subagentRunId: "sub-1" });
  });

  it("is also preserved on the 4 run/conversation-level events — by the plan §5.1 unknown-fields rule, not D-04", () => {
    const event = validateEvent({
      type: "RUN_STARTED",
      threadId: "t",
      runId: "r",
      subagentRunId: "sub-1",
    });
    expect(event).toMatchObject({ type: "RUN_STARTED", subagentRunId: "sub-1" });
  });
});
