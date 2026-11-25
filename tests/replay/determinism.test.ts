/**
 * T005 tests — determinism (100x) and the 40-event boundary
 * (PROJECT_BOOK §8.1, §11: same input 100 times -> one report hash).
 */
import { describe, expect, it } from "vitest";
import { evaluateFixture } from "../../src/replay/planner.js";
import { analyzeFixture, searchShortest } from "../../src/replay/search.js";
import { stateHash } from "../../src/core/canonical.js";
import { ev, norm, runFinish, runStart } from "../core/helpers.js";
import { loadFixture } from "./golden-helpers.js";
import type { ReplayFixture as FixtureType } from "../../src/replay/planner.js";

function fortyEventFixture(): FixtureType {
  // RUN_STARTED + START + 36 CONTENT + END + FINISHED = 40 events.
  return {
    scenarioId: "T-40",
    events: norm([
      runStart("t1", "r1"),
      ev("TEXT_MESSAGE_START", { messageId: "m1", role: "assistant" }),
      ...Array.from({ length: 36 }, (_, i) =>
        ev("TEXT_MESSAGE_CONTENT", { messageId: "m1", delta: `x${i}` }),
      ),
      ev("TEXT_MESSAGE_END", { messageId: "m1" }),
      runFinish("t1", "r1"),
    ]),
    recovery: { strategy: "RESUME_FROM_CHECKPOINT", disconnectAfter: 2 },
  };
}

describe("determinism — 100x repeat, one result", () => {
  it("100x the same shortest sequence (G01)", () => {
    const sequences = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const result = searchShortest(loadFixture("G01"), "DUPLICATE_TOOL_CALL");
      sequences.add(JSON.stringify(result.sequence));
    }
    expect(sequences.size).toBe(1);
    expect([...sequences][0]).toBe(JSON.stringify(["REPLAY_PREFIX"]));
  });

  it("100x the same canonical state hashes (G01 dual track)", () => {
    const hashes = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const result = evaluateFixture(loadFixture("G01"));
      hashes.add(
        `${stateHash(result.fullState!)}|${stateHash(result.resumeState!)}`,
      );
    }
    expect(hashes.size).toBe(1);
  });

  it("100x the same first divergence + diagnostics (G04)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const result = evaluateFixture(loadFixture("G04"));
      seen.add(
        JSON.stringify([
          result.firstDivergence?.sourceIndex,
          result.diagnostics.map((d) => d.code),
        ]),
      );
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).toBe(JSON.stringify([3, ["LOST_EVENT"]]));
  });

  it("100x analyzeFixture agrees (G02)", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i += 1) {
      const analysis = analyzeFixture(loadFixture("G02"), "MESSAGE_REORDER");
      seen.add(
        JSON.stringify([
          analysis.evaluation.verdict,
          analysis.shortestInjectionSequence,
        ]),
      );
    }
    expect(seen.size).toBe(1);
  });
});

describe("40-event boundary (§8.1)", () => {
  it("exactly 40 events evaluates normally", () => {
    const fixture = fortyEventFixture();
    expect(fixture.events.length).toBe(40);
    const result = evaluateFixture(fixture);
    expect(result.verdict).toBe("CONSISTENT");
  });

  it("exactly 40 events stays under the 1s budget", () => {
    const start = Date.now();
    evaluateFixture(fortyEventFixture());
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("41 events returns INCONCLUSIVE_LIMIT (never CONSISTENT by default)", () => {
    const fixture = fortyEventFixture();
    const over: FixtureType = {
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
  });
});
