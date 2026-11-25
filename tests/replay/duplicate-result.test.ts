/**
 * FIX-R1 (P1-R1-01, G01) regression — one TOOL_CALL_RESULT answers
 * exactly one logical execution.
 *
 * G01 resume path holds TWO call-1 entries when TOOL_CALL_RESULT
 * (index 5) arrives: [0] the checkpoint original, [1] the replayed
 * duplicate (AG-UI #1524). The Oracle answers the FIRST entry with
 * no result (oracle/reference.py TOOL_CALL_RESULT branch). The TS
 * replay fold used to fall through to the strict Reducer, whose
 * applyToolCallResult -> replaceToolCall matches by id and marked
 * BOTH entries resulted — so the final-state hash and the report
 * hash disagreed with the Oracle (S0 parity 23/24).
 *
 * The planner's TOOL_CALL_RESULT replay branch now also covers the
 * "first has no result yet, but a duplicate exists" case: it
 * answers the first unresulted entry by identity, exactly like the
 * Oracle. The pre-existing "first already resulted" (second result)
 * case is guarded by the foldTrack-level test below.
 */
import { describe, expect, it } from "vitest";
import {
  evaluateFixture,
  foldTrack,
} from "../../src/replay/planner.js";
import { computePendingToolCallIds } from "../../src/core/lifecycle.js";
import { initialState, type RejoinState } from "../../src/core/state.js";
import { ev, norm } from "../core/helpers.js";
import { loadFixture } from "./golden-helpers.js";

describe("pendingToolCallIds is a property of the logical call id", () => {
  function stateWithCalls(
    calls: RejoinState["toolCalls"],
  ): RejoinState {
    return { ...initialState(), toolCalls: calls };
  }

  const resultedCall = {
    id: "call-1",
    name: "search",
    parentMessageId: "msg-1",
    arguments: '{"q":"weather"}',
    status: "resulted" as const,
    hasResult: true,
    resultMessageId: "msg-r1",
    resultContent: "sunny",
    runId: "run-1",
  };
  const closedUnresultedCall = {
    id: "call-1",
    name: "search",
    parentMessageId: "msg-1",
    arguments: '{"q":"weather"}',
    status: "closed" as const,
    hasResult: false,
    runId: "run-1",
  };

  it("G01 shape: one entry resulted + duplicate closed-unresulted -> id not pending", () => {
    expect(
      computePendingToolCallIds(
        stateWithCalls([resultedCall, closedUnresultedCall]),
      ),
    ).toEqual([]);
  });

  it("duplicate closed-unresulted entries -> id listed once, not twice", () => {
    expect(
      computePendingToolCallIds(
        stateWithCalls([closedUnresultedCall, closedUnresultedCall]),
      ),
    ).toEqual(["call-1"]);
  });

  it("distinct ids keep their own pending state, in START order", () => {
    expect(
      computePendingToolCallIds(
        stateWithCalls([
          closedUnresultedCall,
          { ...closedUnresultedCall, id: "call-2", name: "lookup" },
          resultedCall,
        ]),
      ),
    ).toEqual(["call-2"]);
  });
});

describe("G01 duplicate tool call — one result answers one execution", () => {
  it("resume path: the single RESULT answers only the first call-1 entry", () => {
    const result = evaluateFixture(loadFixture("G01"));
    const resume = result.resumeState;
    expect(resume).not.toBeNull();
    const calls = resume?.toolCalls.filter((t) => t.id === "call-1") ?? [];
    expect(calls).toHaveLength(2);

    // [0] — the checkpoint original — is the only answered entry.
    expect(calls[0]?.status).toBe("resulted");
    expect(calls[0]?.hasResult).toBe(true);
    expect(calls[0]?.resultContent).toBe("sunny");
    expect(calls[0]?.resultMessageId).toBe("msg-r1");

    // [1] — the replayed duplicate — stays unanswered.
    expect(calls[1]?.status).toBe("closed");
    expect(calls[1]?.hasResult).toBe(false);
    expect(calls[1]?.resultContent).toBeUndefined();
    expect(calls[1]?.resultMessageId).toBeUndefined();

    // Exactly one tool-result message exists.
    const resultMessages =
      resume?.messages.filter((m) => m.id === "msg-r1") ?? [];
    expect(resultMessages).toHaveLength(1);
  });

  it("full path: the single call-1 is resulted, unchanged", () => {
    const result = evaluateFixture(loadFixture("G01"));
    const calls = result.fullState?.toolCalls ?? [];
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBe("resulted");
    expect(calls[0]?.hasResult).toBe(true);
    expect(calls[0]?.resultContent).toBe("sunny");
    expect(calls[0]?.resultMessageId).toBe("msg-r1");
  });

  it("second result still answers the duplicate entry (pre-existing branch)", () => {
    const base: RejoinState = {
      ...initialState(),
      threadId: "thread-1",
      runStatus: "RUNNING",
      sharedState: {},
      runs: [{ runId: "run-1", threadId: "thread-1", status: "RUNNING" }],
      messages: [
        {
          id: "msg-1",
          role: "assistant",
          content: "",
          segments: [{ text: "" }],
          status: "closed",
          owner: "producer",
        },
        {
          id: "msg-r1",
          role: "tool",
          content: "sunny",
          segments: [{ text: "sunny" }],
          toolCallId: "call-1",
          status: "closed",
          owner: "producer",
        },
      ],
      toolCalls: [
        {
          id: "call-1",
          name: "search",
          parentMessageId: "msg-1",
          arguments: '{"q":"weather"}',
          status: "resulted",
          hasResult: true,
          resultMessageId: "msg-r1",
          resultContent: "sunny",
          runId: "run-1",
        },
        {
          id: "call-1",
          name: "search",
          parentMessageId: "msg-1",
          arguments: '{"q":"weather"}',
          status: "closed",
          hasResult: false,
          runId: "run-1",
        },
      ],
      pendingToolCallIds: ["call-1"],
    };
    const fold = foldTrack(
      norm([
        ev("TOOL_CALL_RESULT", {
          messageId: "msg-r2",
          toolCallId: "call-1",
          content: "cloudy",
        }),
      ]),
      base,
      -1,
    );
    const calls = fold.state.toolCalls.filter((t) => t.id === "call-1");
    expect(calls).toHaveLength(2);
    // [0] keeps its first result; [1] answers the second result.
    expect(calls[0]?.resultMessageId).toBe("msg-r1");
    expect(calls[0]?.resultContent).toBe("sunny");
    expect(calls[1]?.status).toBe("resulted");
    expect(calls[1]?.hasResult).toBe(true);
    expect(calls[1]?.resultMessageId).toBe("msg-r2");
    expect(calls[1]?.resultContent).toBe("cloudy");
    expect(
      fold.state.messages.filter((m) => m.id === "msg-r2"),
    ).toHaveLength(1);
  });
});
