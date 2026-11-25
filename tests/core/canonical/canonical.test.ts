/**
 * T004 tests — JCS canonicalization + state hashing (canonical.ts).
 *
 * Coverage required by the T004 card: key sorting, array order,
 * number formatting, undefined vs null, NaN/Infinity rejection,
 * timestamp/sourceIndex/diagnostics/local-metadata exclusion,
 * messageId/toolCallId/order/tool-result retention, 100x repeat hash.
 * SHA-256 vectors cross-check the pure-TS implementation against
 * node:crypto (an independent implementation, not production code).
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  JcsError,
  STATE_FIELDS,
  canonicalBytes,
  canonicalHash,
  canonicalize,
  canonicalizeState,
  projectState,
  sha256Hex,
  stateHash,
} from "../../../src/core/canonical.js";
import { initialState, type RejoinState } from "../../../src/core/state.js";
import { reduceExpandedEvents } from "../../../src/core/reducer.js";
import { runNorm, simpleRun, ev, runStart, runFinish } from "../helpers.js";

function sha256Node(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/** A realistic non-trivial state: run + text + tool call + result + snapshot. */
function richState(): RejoinState {
  return runNorm([
    runStart("t1", "r1", {
      input: {
        threadId: "t1",
        runId: "r1",
        messages: [],
        state: { counter: 3, nested: { b: [1, 2], a: "x" } },
      },
    }),
    ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
    ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "Hel" }),
    ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "lo" }),
    ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search", parentMessageId: "m1" }),
    ev("TOOL_CALL_ARGS", { toolCallId: "tc1", delta: '{"q":"x"}' }),
    ev("TOOL_CALL_END", { toolCallId: "tc1" }),
    ev("TEXT_MESSAGE_END", { messageId: "m1" }),
    ev("TOOL_CALL_RESULT", { messageId: "m2", toolCallId: "tc1", content: "found it" }),
    runFinish("t1", "r1"),
  ]);
}

describe("sha256Hex — FIPS 180-4 vectors + node:crypto cross-check", () => {
  it("empty string vector", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
  it("\"abc\" vector", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  it("56/64/65-byte boundary inputs match node:crypto", () => {
    for (const text of [
      "a".repeat(55),
      "a".repeat(56),
      "a".repeat(64),
      "a".repeat(65),
      "a".repeat(128),
      "é😀\n\t\"\\",
      "The quick brown fox jumps over the lazy dog",
    ]) {
      expect(sha256Hex(text)).toBe(sha256Node(text));
    }
  });
  it("canonicalHash is sha256 of the canonical string", () => {
    const value = { b: [1, "é"], a: null };
    expect(canonicalHash(value)).toBe(sha256Node(canonicalize(value)));
    expect(canonicalHash(value)).toBe(sha256Hex(canonicalize(value)));
  });
});

describe("canonicalize — key order", () => {
  it("sorts object keys (UTF-16 code-unit order)", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalize({ z: 1, A: 2, a: 3, "0": 4 })).toBe(
      '{"0":4,"A":2,"a":3,"z":1}',
    );
  });
  it("integer-like keys sort lexically, not numerically", () => {
    // JCS sorts by UTF-16 code units: "10" < "2" < "9".
    expect(canonicalize({ "2": "b", "10": "a", "9": "c" })).toBe(
      '{"10":"a","2":"b","9":"c"}',
    );
  });
  it("nested objects sort at every level", () => {
    expect(canonicalize({ z: { d: 1, c: 2 }, a: { b: 1 } })).toBe(
      '{"a":{"b":1},"z":{"c":2,"d":1}}',
    );
  });
  it("same logical object in different key order canonicalizes identically", () => {
    const one = { a: 1, b: { d: 4, c: 3 } };
    const two = { b: { c: 3, d: 4 }, a: 1 };
    expect(canonicalize(one)).toBe(canonicalize(two));
  });
  it("unicode keys sort by UTF-16 code units", () => {
    // U+00E9 (0xE9) < U+4E2D (0x4E2D) < U+1F600 (surrogate D83D DE00).
    expect(canonicalize({ "😀": 1, "é": 2, "中": 3 })).toBe(
      '{"é":2,"中":3,"😀":1}',
    );
  });
  it("empty object and empty array", () => {
    expect(canonicalize({})).toBe("{}");
    expect(canonicalize([])).toBe("[]");
    expect(canonicalize({ a: {} })).toBe('{"a":{}}');
  });
});

describe("canonicalize — array order preserved", () => {
  it("array order is significant", () => {
    expect(canonicalize([3, 2, 1])).toBe("[3,2,1]");
    expect(canonicalize([3, 2, 1])).not.toBe(canonicalize([1, 2, 3]));
    expect(canonicalize(["b", "a"])).toBe('["b","a"]');
  });
  it("nested arrays keep order", () => {
    expect(canonicalize([[2, 1], [4, 3]])).toBe("[[2,1],[4,3]]");
  });
});

describe("canonicalize — numbers (ECMAScript Number::toString)", () => {
  it("integers and decimals", () => {
    expect(canonicalize(0)).toBe("0");
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize(-7)).toBe("-7");
    expect(canonicalize(2.5)).toBe("2.5");
    expect(canonicalize(0.1)).toBe("0.1");
    expect(canonicalize(0.30000000000000004)).toBe("0.30000000000000004");
  });
  it("-0 formats as 0 (JCS)", () => {
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize(-0.0)).toBe("0");
  });
  it("exponent boundaries match Number::toString", () => {
    expect(canonicalize(1e21)).toBe("1e+21");
    expect(canonicalize(1e20)).toBe("100000000000000000000");
    expect(canonicalize(1e-7)).toBe("1e-7");
    expect(canonicalize(1.5e-10)).toBe("1.5e-10");
    expect(canonicalize(5e-324)).toBe("5e-324");
    expect(canonicalize(1.7976931348623157e308)).toBe("1.7976931348623157e+308");
    // Fixed notation where ES uses it (see oracle-parity.test.ts for
    // the Oracle divergence in the 1e16 / 1e-5 zones).
    expect(canonicalize(1e16)).toBe("10000000000000000");
    expect(canonicalize(1e-5)).toBe("0.00001");
    expect(canonicalize(1e-6)).toBe("0.000001");
  });
  it("rejects NaN and Infinity at any depth", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => canonicalize(bad)).toThrow(JcsError);
      expect(() => canonicalize([1, bad])).toThrow(JcsError);
      expect(() => canonicalize({ a: bad })).toThrow(JcsError);
    }
  });
});

describe("canonicalize — strings", () => {
  it("escapes quotes, backslash and C0 controls; keeps non-ASCII raw", () => {
    expect(canonicalize('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(canonicalize("a\nb\tc\rd\be\ff")).toBe('"a\\nb\\tc\\rd\\be\\ff"');
    expect(canonicalize("a\u0001b")).toBe('"a\\u0001b"');
    expect(canonicalize("éλ😀")).toBe('"éλ😀"');
    expect(canonicalize("  ")).toBe('"  "');
  });
  it("lone surrogates are escaped as \\uXXXX", () => {
    expect(canonicalize("lone" + String.fromCharCode(0xd800) + "x")).toBe(
      '"lone\\ud800x"',
    );
    expect(canonicalize("lone" + String.fromCharCode(0xdfff) + "x")).toBe(
      '"lone\\udfffx"',
    );
    // A valid surrogate pair stays raw (non-ASCII emitted as UTF-8).
    expect(canonicalize("😀")).toBe('"😀"');
  });
  it("canonical bytes are UTF-8", () => {
    expect(canonicalBytes("é")).toEqual(new TextEncoder().encode('"é"'));
    expect(canonicalBytes("é").length).toBe(4); // " + 2 bytes + "
    expect(canonicalBytes("😀").length).toBe(6); // " + 4 bytes + "
  });
});

describe("canonicalize — undefined is NOT null", () => {
  it("null canonicalizes to null", () => {
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize([null])).toBe("[null]");
    expect(canonicalize({ a: null })).toBe('{"a":null}');
  });
  it("bare undefined is rejected, never coerced to null", () => {
    expect(() => canonicalize(undefined)).toThrow(JcsError);
    expect(() => canonicalize({ a: undefined })).toThrow(JcsError);
    expect(() => canonicalize([undefined])).toThrow(JcsError);
  });
  it("rejects bigint, function, symbol, circular values, array holes", () => {
    expect(() => canonicalize(10n)).toThrow(JcsError);
    expect(() => canonicalize(() => 1)).toThrow(JcsError);
    expect(() => canonicalize(Symbol("x"))).toThrow(JcsError);
    const circ: Record<string, unknown> = {};
    circ["self"] = circ;
    expect(() => canonicalize(circ)).toThrow(JcsError);
    const hole = [1, , 3] as unknown[];
    expect(() => canonicalize(hole)).toThrow(JcsError);
  });
  it("booleans", () => {
    expect(canonicalize(true)).toBe("true");
    expect(canonicalize(false)).toBe("false");
  });
});

describe("canonicalizeState — projection: 8 protocol fields only", () => {
  it("projectState exposes exactly the 8 protocol fields", () => {
    const projected = projectState(richState());
    expect(Object.keys(projected).sort()).toEqual([...STATE_FIELDS].sort());
    expect(STATE_FIELDS).toHaveLength(8);
    expect("diagnostics" in projected).toBe(false);
  });
  it("diagnostics and local metadata are excluded from the hash", () => {
    const base = richState();
    const polluted = {
      ...base,
      diagnostics: [
        { code: "RUN_ERROR", severity: "CRITICAL", message: "boom" },
        { code: "TRUNCATED_RUN", severity: "WARNING", message: "cut" },
      ],
      // Local run metadata smuggled onto the object (not in the type).
      timestamp: 1793123456789,
      sourceIndex: 7,
      fileName: "trace.jsonl",
      durationMs: 42,
      importedAt: "2026-11-23T14:00:00Z",
    } as unknown as RejoinState;
    expect(canonicalizeState(polluted)).toBe(canonicalizeState(base));
    expect(stateHash(polluted)).toBe(stateHash(base));
  });
  it("initial state: sharedState undefined projects to null (Oracle parity rule)", () => {
    const init = initialState();
    expect(projectState(init)["sharedState"]).toBeNull();
    const withNull = { ...init, sharedState: null };
    expect(canonicalizeState(init)).toBe(canonicalizeState(withNull));
    const withEmpty = { ...init, sharedState: {} };
    expect(canonicalizeState(init)).not.toBe(canonicalizeState(withEmpty));
  });
  it("same state built twice (fresh objects) hashes identically", () => {
    expect(stateHash(richState())).toBe(stateHash(richState()));
    expect(canonicalizeState(richState())).toBe(canonicalizeState(richState()));
  });
  it("100x repeat: one hash value only", () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      hashes.add(stateHash(richState()));
    }
    expect(hashes.size).toBe(1);
    expect([...hashes][0]).toBe(stateHash(richState()));
  });
});

describe("canonicalizeState — business identity is retained", () => {
  it("message order matters", () => {
    const a = runNorm(simpleRun());
    const b = reduceExpandedEvents([
      runStart(),
      ev("TEXT_MESSAGE_START", { messageId: "m2", role: "user" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m2", delta: "yo" }),
      ev("TEXT_MESSAGE_END", { messageId: "m2" }),
      ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "hi" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      runFinish(),
    ]);
    expect(stateHash(a)).not.toBe(stateHash(b));
  });
  it("messageId matters", () => {
    const a = runNorm(simpleRun());
    const renamed = runNorm([
      runStart(),
      ev("TEXT_MESSAGE_START", { messageId: "mX", role: "assistant" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "mX", delta: "hi" }),
      ev("TEXT_MESSAGE_END", { messageId: "mX" }),
      runFinish(),
    ]);
    expect(stateHash(a)).not.toBe(stateHash(renamed));
  });
  it("message content matters", () => {
    const a = runNorm(simpleRun());
    const changed = runNorm([
      runStart(),
      ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "bye" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      runFinish(),
    ]);
    expect(stateHash(a)).not.toBe(stateHash(changed));
  });
  it("toolCallId, tool name, args and result matter", () => {
    const a = richState();
    const renamedCall = runNorm([
      runStart("t1", "r1", {
        input: {
          threadId: "t1",
          runId: "r1",
          messages: [],
          state: { counter: 3, nested: { b: [1, 2], a: "x" } },
        },
      }),
      ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "Hel" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "lo" }),
      ev("TOOL_CALL_START", { toolCallId: "tc9", toolCallName: "search", parentMessageId: "m1" }),
      ev("TOOL_CALL_ARGS", { toolCallId: "tc9", delta: '{"q":"x"}' }),
      ev("TOOL_CALL_END", { toolCallId: "tc9" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      ev("TOOL_CALL_RESULT", { messageId: "m2", toolCallId: "tc9", content: "found it" }),
      runFinish("t1", "r1"),
    ]);
    expect(stateHash(a)).not.toBe(stateHash(renamedCall));

    const changedResult = runNorm([
      runStart("t1", "r1", {
        input: {
          threadId: "t1",
          runId: "r1",
          messages: [],
          state: { counter: 3, nested: { b: [1, 2], a: "x" } },
        },
      }),
      ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "Hel" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "lo" }),
      ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search", parentMessageId: "m1" }),
      ev("TOOL_CALL_ARGS", { toolCallId: "tc1", delta: '{"q":"x"}' }),
      ev("TOOL_CALL_END", { toolCallId: "tc1" }),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      ev("TOOL_CALL_RESULT", { messageId: "m2", toolCallId: "tc1", content: "nothing found" }),
      runFinish("t1", "r1"),
    ]);
    expect(stateHash(a)).not.toBe(stateHash(changedResult));
  });
  it("sharedState, pendingToolCallIds, runStatus and timeline matter", () => {
    const a = richState();
    const otherShared = { ...a, sharedState: { counter: 4, nested: { b: [1, 2], a: "x" } } };
    expect(stateHash(a)).not.toBe(stateHash(otherShared));
    const otherPending = { ...a, pendingToolCallIds: ["tc1"] };
    expect(stateHash(a)).not.toBe(stateHash(otherPending));
    const otherStatus = { ...a, runStatus: "ERROR" as const };
    expect(stateHash(a)).not.toBe(stateHash(otherStatus));
    const otherTimeline = { ...a, orderedTimeline: [...a.orderedTimeline].reverse() };
    expect(stateHash(a)).not.toBe(stateHash(otherTimeline));
  });
  it("timeline interleave is retained (TEXT_A / TOOL / TEXT_B != merged)", () => {
    // G03 shape: message reopened after a tool call. Swapping the two
    // TEXT_MESSAGE_CONTENT timeline entries changes the hash even
    // though the final message text is identical.
    const a = richState();
    const timeline = [...a.orderedTimeline];
    const contentIdx = timeline
      .map((t, i) => (t.eventType === "TEXT_MESSAGE_CONTENT" ? i : -1))
      .filter((i) => i >= 0);
    expect(contentIdx.length).toBeGreaterThanOrEqual(2);
    const swapped = [...timeline];
    const i0 = contentIdx[0] as number;
    const i1 = contentIdx[1] as number;
    const tmp = swapped[i0] as (typeof timeline)[number];
    swapped[i0] = swapped[i1] as (typeof timeline)[number];
    swapped[i1] = tmp;
    expect(stateHash(a)).not.toBe(stateHash({ ...a, orderedTimeline: swapped }));
  });
});
