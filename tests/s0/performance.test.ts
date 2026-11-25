/**
 * T007 test:performance — single-trace timing (< 1,000 ms), the
 * 40-event boundary (with snapshot + disconnect markers), the
 * 41-event INCONCLUSIVE_LIMIT boundary, and the BFS node-budget probe.
 *
 * "G12-like largest sample": there is no G12 — the Golden set is
 * G01–G08 + N01–N16. The largest Golden by event count is N09
 * (13 events); it is used here as the largest-Golden sample, and the
 * 40-event synthetic trace below is the maximum-size trace.
 */
import { describe, expect, it } from "vitest";
import { evaluateFixture, type DualTrackEvaluation } from "../../src/replay/planner.js";
import { analyzeFixture, searchShortest, type ReplayAnalysis } from "../../src/replay/search.js";
import { ev, norm, runFinish, runStart } from "../core/helpers.js";
import { loadFixture } from "../replay/golden-helpers.js";
import type { ReplayFixture } from "../../src/replay/planner.js";

/**
 * Exactly 40 events, including snapshot events and a disconnect
 * marker: RUN_STARTED + TEXT_MESSAGE_START + 33 CONTENT deltas +
 * TEXT_MESSAGE_END + MESSAGES_SNAPSHOT + STATE_SNAPSHOT +
 * STATE_DELTA + RUN_FINISHED = 40. Disconnect after index 10
 * (mid-content), so the resume path replays the tail.
 */
function fortyEventFixture(): ReplayFixture {
  const deltas = Array.from({ length: 33 }, (_, i) => `x${i}`);
  const content = deltas.join("");
  return {
    scenarioId: "T-40",
    events: norm([
      runStart("t1", "r1"),
      ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
      ...deltas.map((delta) =>
        ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta }),
      ),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      ev("MESSAGES_SNAPSHOT", {
        messages: [{ id: "m1", role: "assistant", content }],
      }),
      ev("STATE_SNAPSHOT", { snapshot: { count: 1 } }),
      ev("STATE_DELTA", {
        delta: [{ op: "replace", path: "/count", value: 2 }],
      }),
      runFinish("t1", "r1"),
    ]),
    recovery: { strategy: "RESUME_FROM_CHECKPOINT", disconnectAfter: 10 },
  };
}

function timeMs(fn: () => void): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("performance — single trace < 1,000 ms", () => {
  it("40-event max trace (snapshot + disconnect) evaluates + analyzes < 1,000 ms", () => {
    const fixture = fortyEventFixture();
    expect(fixture.events.length).toBe(40);
    const evalTimes: number[] = [];
    const analyzeTimes: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      let result: DualTrackEvaluation | undefined;
      evalTimes.push(timeMs(() => {
        result = evaluateFixture(fixture);
      }));
      expect(result?.verdict).toBe("CONSISTENT");
      let analysis: ReplayAnalysis | undefined;
      analyzeTimes.push(timeMs(() => {
        analysis = analyzeFixture(fixture, null);
      }));
      expect(analysis?.evaluation.verdict).toBe("CONSISTENT");
      expect(analysis?.bfsLimitExceeded).toBe(false);
    }
    const maxEval = Math.max(...evalTimes);
    const maxAnalyze = Math.max(...analyzeTimes);
    // eslint-disable-next-line no-console
    console.log(
      `T-40 evaluate max ${maxEval.toFixed(1)} ms, analyze max ${maxAnalyze.toFixed(1)} ms over 5 runs`,
    );
    expect(maxEval).toBeLessThan(1000);
    expect(maxAnalyze).toBeLessThan(1000);
  });

  it("largest Golden (N09, 13 events) analyzes < 1,000 ms", () => {
    const times: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      let analysis: ReplayAnalysis | undefined;
      times.push(timeMs(() => {
        analysis = analyzeFixture(loadFixture("N09"), null);
      }));
      expect(analysis?.evaluation.verdict).toBe("CONSISTENT");
    }
    const max = Math.max(...times);
    // eslint-disable-next-line no-console
    console.log(`N09 analyze max ${max.toFixed(1)} ms over 5 runs`);
    expect(max).toBeLessThan(1000);
  });

  it("every Golden analyzes < 1,000 ms (worst case recorded)", () => {
    const ids = [
      "G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08",
      "N01", "N02", "N03", "N04", "N05", "N06", "N07", "N08",
      "N09", "N10", "N11", "N12", "N13", "N14", "N15", "N16",
    ] as const;
    const targets: Record<string, string | null> = {
      G01: "DUPLICATE_TOOL_CALL", G02: "MESSAGE_REORDER",
      G03: "MESSAGE_REORDER", G04: "LOST_EVENT", G05: "OUT_OF_ORDER",
      G06: "SNAPSHOT_MISMATCH", G07: "SUSPECTED_DUPLICATE",
      G08: "TRUNCATED_RUN",
    };
    let worst = 0;
    let worstId = "";
    for (const id of ids) {
      const target = targets[id] ?? null;
      const ms = timeMs(() => analyzeFixture(loadFixture(id), target));
      if (ms > worst) {
        worst = ms;
        worstId = id;
      }
      expect(ms).toBeLessThan(1000);
    }
    // eslint-disable-next-line no-console
    console.log(`worst Golden analyze: ${worstId} ${worst.toFixed(1)} ms`);
  });
});

describe("size bounds — 40 / 41 events and BFS node budget", () => {
  it("exactly 40 events evaluates normally (CONSISTENT)", () => {
    const result = evaluateFixture(fortyEventFixture());
    expect(result.verdict).toBe("CONSISTENT");
  });

  it("41 events returns INCONCLUSIVE_LIMIT (never CONSISTENT by default)", () => {
    const fixture = fortyEventFixture();
    const over: ReplayFixture = {
      ...fixture,
      events: [
        ...fixture.events,
        {
          sourceIndex: 40,
          sourceEventKey: null,
          transportEventId: null,
          event: ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: "y" }),
        },
      ],
    };
    expect(over.events.length).toBe(41);
    const result = evaluateFixture(over);
    expect(result.verdict).toBe("INCONCLUSIVE_LIMIT");
    expect(result.diagnostics.map((d) => d.code)).toEqual(["LIMIT_EXCEEDED"]);
  });

  it("BFS node budget exhausted -> limitExceeded (sequence null)", () => {
    const result = searchShortest(loadFixture("G01"), "DUPLICATE_TOOL_CALL", 3, 1);
    expect(result.limitExceeded).toBe(true);
    expect(result.sequence).toBeNull();
  });

  it("full-budget BFS on every Golden stays within 5,000 nodes", () => {
    const targets: Record<string, string | null> = {
      G01: "DUPLICATE_TOOL_CALL", G02: "MESSAGE_REORDER",
      G03: "MESSAGE_REORDER", G04: "LOST_EVENT", G05: "OUT_OF_ORDER",
      G06: "SNAPSHOT_MISMATCH", G07: "SUSPECTED_DUPLICATE",
      G08: "TRUNCATED_RUN",
    };
    let max = 0;
    for (const id of Object.keys(targets)) {
      const r = searchShortest(loadFixture(id), targets[id] as string);
      expect(r.limitExceeded).toBe(false);
      max = Math.max(max, r.visited);
    }
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) {
      const id = `N${String(n).padStart(2, "0")}`;
      const r = searchShortest(loadFixture(id), null);
      expect(r.limitExceeded).toBe(false);
      max = Math.max(max, r.visited);
    }
    // eslint-disable-next-line no-console
    console.log(`max BFS visited across 24 Goldens: ${max} (limit 5000)`);
    expect(max).toBeLessThanOrEqual(5000);
  });
});
