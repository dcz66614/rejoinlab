/**
 * T005 test — reproduction of a T003 edge case (recorded, NOT fixed).
 *
 * Edge: a message whose content is a ContentPart[] (installed by a
 * MESSAGES_SNAPSHOT) is legally reopened by TEXT_MESSAGE_START and
 * then receives TEXT_MESSAGE_CONTENT. T003's appendMessageContent
 * takes `typeof content === "string" ? content : ""` as the prior
 * text, so the snapshot parts are silently discarded and the message
 * ends up holding only the new delta — with NO diagnostic recorded
 * anywhere (no Reducer diagnostic, no fold diagnostic, no throw).
 *
 * This test records the ACTUAL behaviour as observed. It must not be
 * "fixed" here: T003 code is out of scope for T005, and changing the
 * Reducer would invalidate the T003/T004 acceptance baselines. The
 * finding is filed for T007 adjudication (the snapshot parts are
 * user-visible content; losing them on a legal reopen is a real
 * information-loss shape, even though the text itself was never
 * streamed through this Reducer).
 */
import { describe, expect, it } from "vitest";
import { runNorm } from "../core/helpers.js";
import { ev, runFinish, runStart } from "../core/helpers.js";

describe("T003 edge — snapshot ContentPart[] message reopened, then CONTENT", () => {
  it("reopening a parts-content message and appending content loses the parts, silently", () => {
    const state = runNorm([
      runStart("t1", "r1"),
      ev("MESSAGES_SNAPSHOT", {
        messages: [
          {
            id: "msg-1",
            role: "assistant",
            content: [{ type: "text", text: "Hello" }],
          },
        ],
      }),
      ev("TEXT_MESSAGE_START", { messageId: "msg-1", role: "assistant" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "msg-1", delta: " world" }),
      ev("TEXT_MESSAGE_END", { messageId: "msg-1" }),
      runFinish("t1", "r1"),
    ]);

    const message = state.messages.find((m) => m.id === "msg-1");
    expect(message).toBeDefined();
    // OBSERVED (not asserted as desired): the snapshot part "Hello"
    // is gone; only the post-reopen delta survives.
    expect(message?.content).toBe(" world");
    // OBSERVED: no diagnostic of any kind was recorded for the loss.
    expect(
      state.diagnostics.filter(
        (d) =>
          d.messageId === "msg-1" ||
          d.message.includes("msg-1") ||
          d.message.toLowerCase().includes("content"),
      ),
    ).toEqual([]);
    expect(state.diagnostics).toEqual([]);
  });

  it("the same reopen over a plain-string message keeps the prior text (control)", () => {
    const state = runNorm([
      runStart("t1", "r1"),
      ev("TEXT_MESSAGE_START", { messageId: "msg-1", role: "assistant" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "msg-1", delta: "Hello" }),
      ev("TEXT_MESSAGE_END", { messageId: "msg-1" }),
      ev("TEXT_MESSAGE_START", { messageId: "msg-1", role: "assistant" }),
      ev("TEXT_MESSAGE_CONTENT", { messageId: "msg-1", delta: " world" }),
      ev("TEXT_MESSAGE_END", { messageId: "msg-1" }),
      runFinish("t1", "r1"),
    ]);
    expect(
      state.messages.find((m) => m.id === "msg-1")?.content,
    ).toBe("Hello world");
  });
});
