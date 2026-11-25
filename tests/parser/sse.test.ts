/**
 * T002 tests — SSE import.
 * Covers: normal parse, transportEventId retention (never promoted to
 * eventId), multi-line data, comment lines, LF/CRLF/CR endings, ignored
 * event:/retry: fields, id-only blocks, invalid JSON (start line reported),
 * unsupported events, determinism, and JSONL/SSE parity on the same events.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseSse } from "../../src/parser/sse.js";
import { parseJsonl } from "../../src/parser/jsonl.js";
import { ParseError } from "../../src/parser/normalize.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
}

function expectSseError(input: string, code: string, line?: number): ParseError {
  try {
    parseSse(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ParseError);
    const err = error as ParseError;
    expect(err.code).toBe(code);
    if (line !== undefined) expect(err.diagnostics[0]?.line).toBe(line);
    return err;
  }
  throw new Error(`expected ParseError(${code}) but parsing succeeded`);
}

describe("parseSse — normal input", () => {
  it("parses tests/parser/fixtures/normal.sse: 10 events, ids retained as transportEventId", () => {
    const events = parseSse(fixture("normal.sse"));
    expect(events).toHaveLength(10);
    expect(events.map((e) => e.sourceIndex)).toEqual(
      Array.from({ length: 10 }, (_, i) => i),
    );
    expect(events.map((e) => e.transportEventId)).toEqual([
      "evt-0", "evt-1", "evt-2", "evt-3", "evt-4",
      "evt-5", "evt-6", "evt-7", "evt-8", "evt-9",
    ]);
    expect(events.map((e) => e.event.type)).toEqual([
      "RUN_STARTED",
      "TEXT_MESSAGE_START",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_END",
      "TOOL_CALL_START",
      "TOOL_CALL_ARGS",
      "TOOL_CALL_END",
      "TOOL_CALL_RESULT",
      "RUN_FINISHED",
    ]);
  });

  it("transportEventId is never promoted to an AG-UI eventId", () => {
    const events = parseSse(fixture("normal.sse"));
    for (const e of events) {
      expect("eventId" in (e.event as unknown as Record<string, unknown>)).toBe(false);
      expect(e.transportEventId).toMatch(/^evt-\d+$/);
    }
  });

  it("comment lines are ignored and consume no sourceIndex", () => {
    const events = parseSse(
      `: keep-alive\n: another comment\n\nid: a\n: mid comment\ndata: {"type":"RUN_STARTED","threadId":"t","runId":"r"}\n\n: trailing\n`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.sourceIndex).toBe(0);
    expect(events[0]?.transportEventId).toBe("a");
  });

  it("event: and retry: fields are ignored (AG-UI binding: only data matters)", () => {
    const events = parseSse(
      `event: message\nretry: 3000\ndata: {"type":"RUN_STARTED","threadId":"t","runId":"r"}\n`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.event.type).toBe("RUN_STARTED");
  });

  it("an SSE event with no data lines dispatches nothing", () => {
    const events = parseSse(
      `id: only-id\n\nid: b\ndata: {"type":"RUN_STARTED","threadId":"t","runId":"r"}\n`,
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.transportEventId).toBe("b");
    expect(events[0]?.sourceIndex).toBe(0);
  });

  it("a final event without a trailing blank line is still dispatched", () => {
    const events = parseSse(
      `id: a\ndata: {"type":"RUN_STARTED","threadId":"t","runId":"r"}`,
    );
    expect(events).toHaveLength(1);
  });

  it("accepts an empty input as zero events", () => {
    expect(parseSse("")).toEqual([]);
    expect(parseSse("\n\n")).toEqual([]);
  });
});

describe("parseSse — multi-line data and line endings", () => {
  it("joins multiple data: lines with \\n into one JSON event", () => {
    const events = parseSse(fixture("multiline-data.sse"));
    expect(events).toHaveLength(3);
    expect(events.map((e) => e.transportEventId)).toEqual(["multi-0", "multi-1", "multi-2"]);
    expect(events[0]?.event).toMatchObject({
      type: "RUN_STARTED", threadId: "thread-1", runId: "run-1",
    });
    expect(events[2]?.event).toMatchObject({
      type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1", delta: "split across data lines",
    });
  });

  it("accepts LF, CRLF and CR endings with identical results", () => {
    const base = fixture("normal.sse");
    const lf = base.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const crlf = lf.replaceAll("\n", "\r\n");
    const cr = lf.replaceAll("\n", "\r");
    expect(parseSse(crlf)).toEqual(parseSse(lf));
    expect(parseSse(cr)).toEqual(parseSse(lf));
  });

  it("a single space after the colon is stripped; extra spaces are kept", () => {
    const events = parseSse(
      `id:  spaced\ndata:  {"type":"RUN_STARTED","threadId":"t","runId":"r"}\n`,
    );
    expect(events[0]?.transportEventId).toBe(" spaced");
    expect(events[0]?.event.type).toBe("RUN_STARTED");
  });
});

describe("parseSse — errors", () => {
  it("invalid JSON in data reports INVALID_INPUT with the event start line", () => {
    const err = expectSseError(
      `id: a\ndata: {"type":"RUN_STARTED","threadId":"t","runId":"r"}\n\nid: b\ndata: {broken}\n`,
      "INVALID_INPUT",
      4,
    );
    expect(err.diagnostics[0]?.message).toMatch(/line 4/);
  });

  it("unsupported event in SSE reports INCONCLUSIVE_LIMIT with position and type", () => {
    const err = expectSseError(
      `id: s1\ndata: {"type":"STEP_STARTED","stepName":"s"}\n`,
      "INCONCLUSIVE_LIMIT",
      1,
    );
    expect(err.diagnostics[0]?.eventType).toBe("STEP_STARTED");
    expect(err.diagnostics[0]?.sourceIndex).toBe(0);
  });

  it("missing required field in SSE reports INVALID_INPUT", () => {
    expectSseError(
      `data: {"type":"RUN_FINISHED","threadId":"t"}\n`,
      "INVALID_INPUT",
      1,
    );
  });
});

describe("parseSse — determinism and JSONL parity", () => {
  it("parsing the same SSE file twice yields byte-identical JSON", () => {
    const input = fixture("normal.sse");
    expect(JSON.stringify(parseSse(input))).toBe(JSON.stringify(parseSse(input)));
  });

  it("JSONL and SSE encodings of the same run give the same type sequence and run boundaries", () => {
    const jsonl = parseJsonl(fixture("normal.jsonl"));
    const sse = parseSse(fixture("normal.sse"));
    // SSE fixture holds the same run/text/tool events as the JSONL fixture,
    // minus one TEXT_MESSAGE_CONTENT line ("world.") and the STATE_SNAPSHOT;
    // its two TOOL_CALL_ARGS fragments arrive pre-joined in one data line.
    expect(sse.map((e) => e.event.type)).toEqual([
      "RUN_STARTED", "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT",
      "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END", "TOOL_CALL_START",
      "TOOL_CALL_ARGS", "TOOL_CALL_END", "TOOL_CALL_RESULT", "RUN_FINISHED",
    ]);
    expect(sse[0]?.event).toEqual(jsonl[0]?.event);
    expect(sse[sse.length - 1]?.event).toEqual(jsonl[jsonl.length - 1]?.event);
    expect(sse[1]?.event).toEqual(jsonl[1]?.event);
    expect(sse[2]?.event).toEqual(jsonl[2]?.event);
  });
});
