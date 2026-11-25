/**
 * T004 tests — TS <-> Python Oracle canonicalization parity.
 *
 * This is a COMPARISON, not code sharing: the TS implementation in
 * src/core/canonical.ts and oracle/canonical.py were written
 * independently, and this test feeds the SAME hand-written JSON values
 * to both live implementations and requires byte-identical output.
 * No Oracle output is used as an expected value for the TS code —
 * the expected value on the TS side is computed by the TS code itself
 * and compared against the Oracle's live output (and vice versa).
 *
 * Scope note (read before "fixing" a failure here):
 * - Generic canonicalize(): parity must hold for every JSON value
 *   representable as an IEEE-754 double (everything the TS side can
 *   hold). Integers beyond 2^53 are NOT in scope: Python ints are
 *   exact while JS doubles are not — a JSON integer like
 *   123456789012345678901234567890 cannot be held exactly by the TS
 *   side at all, so it is excluded from the battery by design.
 * - State level: Oracle's canonicalize_state() projects entries onto
 *   ORACLE-INTERNAL field names (messages: open/segments/...;
 *   toolCalls: toolCallId/args/...), which do not match the frozen TS
 *   RejoinState field names — feeding a TS-shaped state to it would
 *   silently drop most fields. Parity at state level is therefore
 *   checked as: TS canonicalizeState(state) vs Python
 *   canonicalize() applied to the same 8-field projected JSON value
 *   (projectState output). That validates the projection bytes
 *   against Python's JCS, plus the shared rule "8 protocol fields
 *   only, diagnostics dropped".
 * - Number formatting (fixed in oracle/canonical.py, 2026-11-23):
 *   Oracle's format_number() used to format floats with Python
 *   repr(), which switches to scientific notation at 1e16 / 1e-4,
 *   while JCS §3.2.2.3 defers to ECMAScript Number::toString, which
 *   switches at 1e21 / 1e-6. Floats in [1e16, 1e21) and [1e-6, 1e-4)
 *   therefore used to canonicalize differently (1e16 -> Oracle
 *   "1e+16" vs TS "10000000000000000"; 1e-5 -> Oracle "1e-5" vs TS
 *   "0.00001"). The Oracle now re-formats repr's shortest digits
 *   per the ES rules, and the five formerly divergent cases live in
 *   the byte-identical battery below ("floats in the former
 *   divergence zones"). They are fed as exponent-form raw JSON on
 *   purpose: JSON.stringify(1e16) emits fixed notation
 *   ("10000000000000000"), which Python reads as an int and formats
 *   exactly — that spelling masks the bug for large values. The bug
 *   bites when Python holds the value as a float (exponent-form
 *   JSON, or a float produced by Oracle's own fold), which is the
 *   normal case for sharedState numbers arriving as 1e16 / 1e-5.
 *   The 24 Golden fixtures contain no floats in those zones
 *   (verified by grep over fixtures/golden +
 *   oracle/golden_expected.json), so no Golden hash is affected.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalize,
  canonicalizeState,
  projectState,
} from "../../../src/core/canonical.js";
import { initialState, type RejoinState } from "../../../src/core/state.js";
import { ev, runFinish, runNorm, runStart } from "../helpers.js";

const REPO_ROOT = new URL("../../..", import.meta.url).pathname;

const PYTHON_DRIVER = `
import base64, json, sys
sys.path.insert(0, sys.argv[1])
from oracle.canonical import canonicalize
with open(sys.argv[2], encoding="utf-8") as handle:
    cases = json.load(handle)
for case in cases:
    sys.stdout.write(base64.b64encode(canonicalize(case)).decode("ascii") + "\\n")
`;

/** Run oracle.canonical.canonicalize over each JSON value; one b64 line each. */
function oracleCanonicalizeAll(values: readonly unknown[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), "t004-parity-"));
  try {
    const casesPath = join(dir, "cases.json");
    const driverPath = join(dir, "driver.py");
    writeFileSync(casesPath, JSON.stringify(values), "utf-8");
    writeFileSync(driverPath, PYTHON_DRIVER, "utf-8");
    let stdout: string;
    try {
      stdout = execFileSync(
        "python3",
        [driverPath, REPO_ROOT, casesPath],
        { encoding: "utf-8", timeout: 60_000 },
      );
    } catch (error) {
      throw new Error(
        `Oracle parity run failed (python3 + oracle/canonical.py): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const lines = stdout.split("\n").filter((line) => line.length > 0);
    if (lines.length !== values.length) {
      throw new Error(
        `Oracle parity run returned ${lines.length} lines for ${values.length} cases`,
      );
    }
    return lines;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run oracle.canonical.canonicalize over raw JSON text (one b64 line per case). */
function oracleCanonicalizeRawJson(jsonText: string, count: number): string[] {
  const dir = mkdtempSync(join(tmpdir(), "t004-parity-"));
  try {
    const casesPath = join(dir, "cases.json");
    const driverPath = join(dir, "driver.py");
    writeFileSync(casesPath, jsonText, "utf-8");
    writeFileSync(driverPath, PYTHON_DRIVER, "utf-8");
    let stdout: string;
    try {
      stdout = execFileSync(
        "python3",
        [driverPath, REPO_ROOT, casesPath],
        { encoding: "utf-8", timeout: 60_000 },
      );
    } catch (error) {
      throw new Error(
        `Oracle parity run failed (python3 + oracle/canonical.py): ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const lines = stdout.split("\n").filter((line) => line.length > 0);
    if (lines.length !== count) {
      throw new Error(
        `Oracle parity run returned ${lines.length} lines for ${count} cases`,
      );
    }
    return lines;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
function toB64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** A realistic TS-shaped state, built by the T003 reducer. */
function richState(): RejoinState {
  return runNorm([
    runStart("t1", "r1", {
      input: {
        threadId: "t1",
        runId: "r1",
        messages: [],
        state: { counter: 3, nested: { b: [1, 2], a: "x" }, flag: true, nothing: null },
      },
    }),
    ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
    ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "Hello 😀" }),
    ev("TOOL_CALL_START", { toolCallId: "tc1", toolCallName: "search", parentMessageId: "m1" }),
    ev("TOOL_CALL_ARGS", { toolCallId: "tc1", delta: '{"q":"x"}' }),
    ev("TOOL_CALL_END", { toolCallId: "tc1" }),
    ev("TEXT_MESSAGE_END", { messageId: "m1" }),
    ev("TOOL_CALL_RESULT", { messageId: "m2", toolCallId: "tc1", content: "found it" }),
    ev("STATE_DELTA", {
      delta: [{ op: "replace", path: "/counter", value: 4 }],
    }),
    runFinish("t1", "r1"),
  ]);
}

describe("oracle parity — generic canonicalize() byte-identical", () => {
  it("hand-written JSON battery matches oracle.canonical.canonicalize byte for byte", () => {
    const cases: readonly unknown[] = [
      { b: 1, a: 2 },
      { z: { d: [3, { b: null, a: true }], c: 2 }, a: [] },
      {},
      [],
      [1, 2.5, 1e21, 1e-7, 0, 0.1, 1.5e-10, 1234567890123456],
      [0.30000000000000004, 5e-324, 1.7976931348623157e308, 1e20],
      10000000000000000, // int in JSON: Python int path, exact; TS double, exact here
      "a\"b\\c\nd\te\u0001f\u2028g",
      { "": "" },
      { "é": "λ", "😀": "x", "中": [true, false, null] },
      "lone" + String.fromCharCode(0xd800) + "x",
      { ["k" + String.fromCharCode(0xdfff)]: 1 },
      { z: null, a: true, m: [null, false] },
      { deep: { deeper: { deepest: [{ k: "v" }, [], {}] } } },
      ["", 0, false, null, {}, []],
    ];
    const oracleLines = oracleCanonicalizeAll(cases);
    for (let i = 0; i < cases.length; i += 1) {
      const tsBytes = toB64(canonicalize(cases[i]));
      expect(tsBytes, `case ${i}: ${JSON.stringify(cases[i])}`).toBe(
        oracleLines[i] as string,
      );
    }
  });

  it("floats in the former divergence zones match the Oracle byte for byte", () => {
    // Formerly KNOWN DIVERGENCE (Oracle repr() vs ES Number::toString);
    // fixed in oracle/canonical.py — these now belong in the normal
    // byte-identical battery. Fed as exponent-form raw JSON so Python
    // holds them as floats (see header note).
    const cases: Array<[number, string]> = [
      [1e16, "10000000000000000"],
      [1.23e16, "12300000000000000"],
      [1e-5, "0.00001"],
      [1e-6, "0.000001"],
      [1.5e-5, "0.000015"],
    ];
    for (const [value, want] of cases) {
      expect(canonicalize(value)).toBe(want);
    }
    const oracleLines = oracleCanonicalizeRawJson(
      "[1e16, 1.23e16, 1e-5, 1e-6, 1.5e-5]",
      cases.length,
    );
    const oracleValues = oracleLines.map((line) =>
      Buffer.from(line, "base64").toString("utf8"),
    );
    for (let i = 0; i < cases.length; i += 1) {
      expect(oracleValues[i], `case ${i}: ${cases[i]?.[0]}`).toBe(
        cases[i]?.[1],
      );
    }
  });

  it("TS state projection bytes match Python canonicalize() of the same projection", () => {
    const state = richState();
    const polluted = {
      ...state,
      diagnostics: [{ code: "RUN_ERROR", severity: "CRITICAL", message: "boom" }],
      timestamp: 1793123456789,
      sourceIndex: 7,
      fileName: "trace.jsonl",
      durationMs: 42,
    } as unknown as RejoinState;
    // The projected JSON (8 fields, no diagnostics) is the shared value.
    const projectedJson = projectState(polluted) as unknown;
    const oracleLines = oracleCanonicalizeAll([projectedJson, projectState(initialState())]);
    expect(toB64(canonicalizeState(polluted))).toBe(oracleLines[0] as string);
    expect(toB64(canonicalizeState(state))).toBe(oracleLines[0] as string);
    expect(toB64(canonicalizeState(initialState()))).toBe(oracleLines[1] as string);
  });
});
