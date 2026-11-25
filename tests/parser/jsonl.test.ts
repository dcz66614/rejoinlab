/**
 * T002 tests — JSONL import.
 * Covers: normal parse, blank lines, invalid JSON (line reported), missing
 * required fields (Schema, incl. RUN_FINISHED D-01), unknown type,
 * unsupported events, empty delta, subagentRunId, size limits, chunk
 * first-block rules, determinism.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseJsonl } from "../../src/parser/jsonl.js";
import { ParseError } from "../../src/parser/normalize.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
}

function expectParseError(input: string, code: string, line?: number): ParseError {
  try {
    parseJsonl(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ParseError);
    const err = error as ParseError;
    expect(err.code).toBe(code);
    expect(err.diagnostics.length).toBeGreaterThan(0);
    if (line !== undefined) expect(err.diagnostics[0]?.line).toBe(line);
    return err;
  }
  throw new Error(`expected ParseError(${code}) but parsing succeeded`);
}

describe("parseJsonl — normal input", () => {
  it("parses tests/parser/fixtures/normal.jsonl: 13 events, stable sourceIndex, null transportEventId", () => {
    const events = parseJsonl(fixture("normal.jsonl"));
    expect(events).toHaveLength(13);
    expect(events.map((e) => e.sourceIndex)).toEqual(
      Array.from({ length: 13 }, (_, i) => i),
    );
    expect(events.every((e) => e.transportEventId === null)).toBe(true);
    expect(events.every((e) => e.sourceEventKey === null)).toBe(true);
    expect(events.map((e) => e.event.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "STATE_SNAPSHOT",
      "RUN_FINISHED",
    ]);
    const started = events[0]?.event;
    expect(started).toMatchObject({ type: "RUN_STARTED", threadId: "thread-1", runId: "run-1" });
  });

  it("skips blank lines without consuming a sourceIndex", () => {
    const events = parseJsonl(
      `\n{"type":"RUN_STARTED","threadId":"t","runId":"r"}\n\n\n{"type":"RUN_FINISHED","threadId":"t","runId":"r"}\n`,
    );
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.sourceIndex)).toEqual([0, 1]);
  });

  it("accepts LF, CRLF and CR line endings with identical results", () => {
    const lf = `{"type":"RUN_STARTED","threadId":"t","runId":"r"}\n{"type":"RUN_FINISHED","threadId":"t","runId":"r"}\n`;
    const crlf = lf.replaceAll("\n", "\r\n");
    const cr = lf.replaceAll("\n", "\r");
    expect(parseJsonl(crlf)).toEqual(parseJsonl(lf));
    expect(parseJsonl(cr)).toEqual(parseJsonl(lf));
  });

  it("accepts an empty (whitespace-only) input as zero events", () => {
    expect(parseJsonl("")).toEqual([]);
    expect(parseJsonl("\n\n")).toEqual([]);
  });

  it("empty-string delta is legal (keep-alive), never an error by itself", () => {
    const events = parseJsonl(
      `{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":""}`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toMatchObject({ type: "TEXT_MESSAGE_CONTENT", delta: "" });
  });

  it("honours caller-supplied sourceEventKeys", () => {
    const events = parseJsonl(
      `{"type":"RUN_STARTED","threadId":"t","runId":"r"}\n{"type":"RUN_FINISHED","threadId":"t","runId":"r"}`,
      { sourceEventKeys: ["k-0", null] },
    );
    expect(events[0]?.sourceEventKey).toBe("k-0");
    expect(events[1]?.sourceEventKey).toBeNull();
  });
});

describe("parseJsonl — validation errors carry exact line numbers", () => {
  it("invalid JSON reports INVALID_INPUT with the exact line", () => {
    const err = expectParseError(
      `{"type":"RUN_STARTED","threadId":"t","runId":"r"}\n{not json}\n{"type":"RUN_FINISHED","threadId":"t","runId":"r"}`,
      "INVALID_INPUT",
      2,
    );
    expect(err.diagnostics[0]?.message).toMatch(/line 2/i);
  });

  it("non-object event (array) reports INVALID_INPUT", () => {
    expectParseError(`[1,2,3]`, "INVALID_INPUT", 1);
  });

  it("missing type reports INVALID_INPUT", () => {
    expectParseError(`{"threadId":"t"}`, "INVALID_INPUT", 1);
  });

  it("RUN_FINISHED missing runId reports INVALID_INPUT (D-01: Schema requires threadId+runId)", () => {
    const err = expectParseError(
      `{"type":"RUN_FINISHED","threadId":"t"}`,
      "INVALID_INPUT",
      1,
    );
    expect(err.diagnostics[0]?.field).toBe("runId");
  });

  it("RUN_FINISHED missing threadId reports INVALID_INPUT (D-01)", () => {
    const err = expectParseError(`{"type":"RUN_FINISHED","runId":"r"}`, "INVALID_INPUT", 1);
    expect(err.diagnostics[0]?.field).toBe("threadId");
  });

  it("TEXT_MESSAGE_CONTENT missing delta reports INVALID_INPUT", () => {
    expectParseError(
      `{"type":"TEXT_MESSAGE_CONTENT","messageId":"m"}`,
      "INVALID_INPUT",
      1,
    );
  });

  it("wrong field type (delta as number) reports INVALID_INPUT", () => {
    expectParseError(
      `{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":42}`,
      "INVALID_INPUT",
      1,
    );
  });

  it("non-integer timestamp reports INVALID_INPUT", () => {
    expectParseError(
      `{"type":"RUN_STARTED","threadId":"t","runId":"r","timestamp":1.5}`,
      "INVALID_INPUT",
      1,
    );
  });

  it("TOOL_CALL_RESULT with role other than 'tool' reports INVALID_INPUT", () => {
    expectParseError(
      `{"type":"TOOL_CALL_RESULT","messageId":"m","toolCallId":"c","content":"x","role":"assistant"}`,
      "INVALID_INPUT",
      1,
    );
  });

  it("STATE_DELTA with a non-array delta reports INVALID_INPUT", () => {
    expectParseError(`{"type":"STATE_DELTA","delta":{}}`, "INVALID_INPUT", 1);
  });

  it("STATE_DELTA op missing path reports INVALID_INPUT", () => {
    expectParseError(
      `{"type":"STATE_DELTA","delta":[{"op":"add","value":1}]}`,
      "INVALID_INPUT",
      1,
    );
  });

  it("MESSAGES_SNAPSHOT message missing id reports INVALID_INPUT", () => {
    expectParseError(
      `{"type":"MESSAGES_SNAPSHOT","messages":[{"role":"user","content":"hi"}]}`,
      "INVALID_INPUT",
      1,
    );
  });
});

describe("parseJsonl — unknown and unsupported types", () => {
  it("unknown type (not in the 31-value enum) reports INVALID_INPUT with type and line", () => {
    const err = expectParseError(
      `{"type":"RUN_STARTED","threadId":"t","runId":"r"}\n{"type":"MAGIC_EVENT"}`,
      "INVALID_INPUT",
      2,
    );
    expect(err.diagnostics[0]?.eventType).toBe("MAGIC_EVENT");
  });

  it.each([
    "STEP_STARTED",
    "REASONING_MESSAGE_CONTENT",
    "ACTIVITY_SNAPSHOT",
    "SUBAGENT_STARTED",
    "RAW",
    "CUSTOM",
  ])("unsupported known type %s reports INCONCLUSIVE_LIMIT with position and type", (type) => {
    const err = expectParseError(
      `{"type":"${type}","stepName":"s"}`,
      "INCONCLUSIVE_LIMIT",
      1,
    );
    expect(err.diagnostics[0]?.eventType).toBe(type);
    expect(err.diagnostics[0]?.sourceIndex).toBe(0);
  });

  it("an unsupported event aborts the whole import (no partial list leaks to the Reducer)", () => {
    expect(() =>
      parseJsonl(
        `{"type":"RUN_STARTED","threadId":"t","runId":"r"}\n{"type":"STEP_STARTED","stepName":"s"}`,
      ),
    ).toThrow(ParseError);
  });
});

describe("parseJsonl — subagentRunId (D-04)", () => {
  it("accepts subagentRunId on an MVP event, preserves the raw value, never INVALID_INPUT", () => {
    const events = parseJsonl(
      `{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"hi","subagentRunId":"sub-9"}`,
    );
    expect(events).toHaveLength(1);
    expect(
      (events[0]?.event as unknown as Record<string, unknown>)["subagentRunId"],
    ).toBe("sub-9");
  });

  it("preserves other unknown fields verbatim instead of silently dropping them", () => {
    const events = parseJsonl(
      `{"type":"RUN_STARTED","threadId":"t","runId":"r","vendorNote":"keep-me","extra":{"n":1}}`,
    );
    const raw = events[0]?.event as unknown as Record<string, unknown>;
    expect(raw["vendorNote"]).toBe("keep-me");
    expect(raw["extra"]).toEqual({ n: 1 });
  });
});

describe("parseJsonl — size limits (PROJECT_BOOK §8.1)", () => {
  it("a single event over 64 KiB is rejected with INCONCLUSIVE_LIMIT, never truncated", () => {
    const big = "x".repeat(64 * 1024);
    const err = expectParseError(
      `{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"${big}"}`,
      "INCONCLUSIVE_LIMIT",
      1,
    );
    expect(err.diagnostics[0]?.message).toMatch(/64 KiB/);
  });

  it("an event of exactly 64 KiB is accepted", () => {
    // Build a payload whose UTF-8 byte length is exactly 65536.
    const prefix = `{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"`;
    const suffix = `"}`;
    const pad = 64 * 1024 - prefix.length - suffix.length;
    const events = parseJsonl(prefix + "x".repeat(pad) + suffix);
    expect(events).toHaveLength(1);
  });

  it("total input over 1 MiB is rejected with INCONCLUSIVE_LIMIT", () => {
    const line = `{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"${"y".repeat(1000)}"}\n`;
    const input = line.repeat(1100); // > 1 MiB
    expect(input.length).toBeGreaterThan(1024 * 1024);
    expectParseError(input, "INCONCLUSIVE_LIMIT");
  });
});

describe("parseJsonl — chunk protocol rules (EVENT_SCHEMA §4.5/§5.4)", () => {
  it("parses tests/parser/fixtures/chunks.jsonl: chunks preserved verbatim with sourceIndex", () => {
    const events = parseJsonl(fixture("chunks.jsonl"));
    expect(events.map((e) => e.event.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_CHUNK",
      "TEXT_MESSAGE_CHUNK",
      "TEXT_MESSAGE_CHUNK",
      "TOOL_CALL_CHUNK",
      "TOOL_CALL_CHUNK",
      "RUN_FINISHED",
    ]);
    expect(events.map((e) => e.sourceIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("a first TEXT_MESSAGE_CHUNK without messageId is INVALID_INPUT (never invent an id)", () => {
    const err = expectParseError(`{"type":"TEXT_MESSAGE_CHUNK","delta":"hi"}`, "INVALID_INPUT", 1);
    expect(err.diagnostics[0]?.field).toBe("messageId");
  });

  it("a first TOOL_CALL_CHUNK without toolCallId is INVALID_INPUT", () => {
    expectParseError(`{"type":"TOOL_CALL_CHUNK","delta":"{}"}`, "INVALID_INPUT", 1);
  });

  it("a first TOOL_CALL_CHUNK without toolCallName is INVALID_INPUT", () => {
    expectParseError(
      `{"type":"TOOL_CALL_CHUNK","toolCallId":"c1","delta":"{}"}`,
      "INVALID_INPUT",
      1,
    );
  });

  it("a continuation chunk repeating a conflicting role is INVALID_INPUT", () => {
    expectParseError(
      `{"type":"TEXT_MESSAGE_CHUNK","messageId":"m","role":"assistant","delta":"a"}\n{"type":"TEXT_MESSAGE_CHUNK","role":"user","delta":"b"}`,
      "INVALID_INPUT",
      2,
    );
  });

  it("a continuation chunk with a different messageId opens a new item (no error)", () => {
    const events = parseJsonl(
      `{"type":"TEXT_MESSAGE_CHUNK","messageId":"m1","delta":"a"}\n{"type":"TEXT_MESSAGE_CHUNK","messageId":"m2","delta":"b"}`,
    );
    expect(events).toHaveLength(2);
  });
});

describe("parseJsonl — determinism", () => {
  it("parsing the same file twice yields byte-identical NormalizedEvent JSON", () => {
    const input = fixture("normal.jsonl");
    const first = parseJsonl(input);
    const second = parseJsonl(input);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(second).toEqual(first);
  });
});
