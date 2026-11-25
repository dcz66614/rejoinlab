/**
 * T005 tests — Golden parity vs the hand-derived expected values
 * (oracle/golden_expected.json) and vs the Oracle (oracle/replay.py).
 *
 * Verdict + diagnostic codes + shortest sequence must match Oracle
 * for all 24 traces. First divergence (T004 step comparison from
 * the checkpoint, see align.ts) matches Oracle for 23/24; the one
 * documented exception is asserted with its observed value:
 * - G01: Oracle's diagnostics-priority branch reports 2 (the
 *   replayed TOOL_CALL_START); the T004 step comparison from the
 *   checkpoint reports 4 (the first sliced index at which the
 *   duplicate is visible in the state). The duplicate diagnostic
 *   itself still carries sourceIndex 2.
 * - G03 (FIX-T003-G03): the Oracle detects the fault through message
 *   `segments` (two text segments merged into one). TS MessageState
 *   now models segments with Oracle semantics (START opens a new
 *   segment, CONTENT appends to the last, a snapshot collapses to a
 *   single segment), so evaluate() reports INCONSISTENT /
 *   [MESSAGE_REORDER] with first divergence 10, matching Oracle and
 *   the hand-derived expected values. The earlier TS CONSISTENT
 *   result was the segments gap, now fixed — it must not regress.
 */
import { describe, expect, it } from "vitest";
import { evaluateFixture } from "../../src/replay/planner.js";
import { searchShortest } from "../../src/replay/search.js";
import {
  GOLDEN_IDS,
  loadExpected,
  loadFixture,
} from "./golden-helpers.js";

const expected = loadExpected();

describe("golden evaluate — verdict + diagnostics vs hand-derived expected", () => {
  for (const id of GOLDEN_IDS) {
    it(`${id} verdict + diagnostic codes`, () => {
      const result = evaluateFixture(loadFixture(id));
      const exp = expected[id] as (typeof expected)[string];
      expect(result.verdict).toBe(exp.verdict);
      expect(result.diagnostics.map((d) => d.code)).toEqual(exp.diagnostics);
    });
  }
  it("G03 diagnostic is MESSAGE_REORDER at the checkpoint (sourceIndex 10)", () => {
    const result = evaluateFixture(loadFixture("G03"));
    expect(result.verdict).toBe("INCONSISTENT");
    expect(result.diagnostics.map((d) => d.code)).toEqual(["MESSAGE_REORDER"]);
    expect(result.diagnostics[0]?.sourceIndex).toBe(10);
  });
  it("N08 legal reopen stays CONSISTENT and keeps two segments on both tracks", () => {
    const result = evaluateFixture(loadFixture("N08"));
    expect(result.verdict).toBe("CONSISTENT");
    expect(result.diagnostics).toEqual([]);
    const fullSegments = result.fullState?.messages.find((m) => m.id === "msg-1")?.segments;
    const resumeSegments = result.resumeState?.messages.find((m) => m.id === "msg-1")?.segments;
    expect(fullSegments?.map((s) => s.text)).toEqual(["Hello, ", "world."]);
    expect(resumeSegments?.map((s) => s.text)).toEqual(["Hello, ", "world."]);
  });
});

describe("golden first divergence (T004 step comparison from checkpoint)", () => {
  const cases: Record<string, number | null> = {
    G01: 4, // Oracle diagnostics-priority: 2 — see the header note.
    G02: 7,
    G03: 10,
    G04: 3,
    G05: 4,
    G06: 2,
    G07: 2,
    G08: 4,
  };
  for (const [id, index] of Object.entries(cases)) {
    it(`${id} first divergence at ${index}`, () => {
      const result = evaluateFixture(loadFixture(id));
      expect(result.firstDivergence?.sourceIndex).toBe(index);
    });
  }
  for (const id of GOLDEN_IDS.filter((x) => x.startsWith("N"))) {
    it(`${id} has no first divergence`, () => {
      const result = evaluateFixture(loadFixture(id));
      expect(result.firstDivergence).toBeNull();
    });
  }
  it("G03 full and resume hashes differ (merged segments are observable)", () => {
    const result = evaluateFixture(loadFixture("G03"));
    expect(result.fullPath?.finalStateHash).not.toBe(
      result.resumePath?.finalStateHash,
    );
    const fullSegments = result.fullState?.messages.find((m) => m.id === "msg-1")?.segments;
    const resumeSegments = result.resumeState?.messages.find((m) => m.id === "msg-1")?.segments;
    expect(fullSegments?.map((s) => s.text)).toEqual(["Hello, ", "it is sunny."]);
    expect(resumeSegments?.map((s) => s.text)).toEqual(["Hello, it is sunny."]);
  });
});

describe("golden BFS — shortest sequence vs Oracle", () => {
  for (const id of GOLDEN_IDS) {
    it(`${id} shortest sequence`, () => {
      const fixture = loadFixture(id);
      const exp = expected[id] as (typeof expected)[string];
      const target = exp.diagnostics[0] ?? null;
      const result = searchShortest(fixture, target);
      expect(result.limitExceeded).toBe(false);
      expect(result.sequence).toEqual(exp.shortestInjectionSequence);
    });
  }
});
