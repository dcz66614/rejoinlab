/**
 * T005 test helpers — load the 24 Golden fixtures + hand-derived
 * expected values, and convert the Oracle-shaped explicit checkpoints
 * (G02/G03/G06) into TS RecoveryCheckpoints.
 *
 * Checkpoint conversion (test-only, NOT production code):
 * - The capturedState starts from the TS prefix fold through the
 *   checkpoint index (so orderedTimeline / diagnostics match the TS
 *   fold), then messages / toolCalls / runs / sharedState /
 *   pendingToolCallIds / runStatus are overridden with the
 *   fixture's explicit Oracle fragment, converted field by field.
 *   Oracle-only fields (message `segments`, call `duplicate` flag
 *   shape, `open` booleans) are translated into the TS equivalents
 *   (status strings, hasResult); `segments` is passed through
 *   VERBATIM (FIX-T003-G03) — it is the field that makes a merged
 *   checkpoint (G03: one segment) distinguishable from the full path
 *   (two segments). A fragment message without a `segments` field
 *   falls back to the single-segment form of its content, mirroring
 *   the Oracle snapshot rule.
 * - Coverage fallbacks are exercised by the planner itself, not by
 *   this conversion (N16's messages:false checkpoint keeps its
 *   explicit sharedState fragment and gets messages from the prefix
 *   fold at resolve time).
 */
import { readFileSync } from "node:fs";
import type {
  AGUIMessage,
  ContentPart,
  JsonValue,
  MessageRole,
  NormalizedEvent,
  RecoveryCheckpoint,
} from "../../src/protocol/types.js";
import type { MessageState, RejoinState, ToolCallState } from "../../src/core/state.js";
import { messageStateToAGUI, segmentsForContent } from "../../src/core/state.js";
import { expandChunks } from "../../src/parser/normalize.js";
import { foldTrack, type ReplayFixture } from "../../src/replay/planner.js";
import { initialState } from "../../src/core/state.js";

export const GOLDEN_IDS: readonly string[] = [
  "G01", "G02", "G03", "G04", "G05", "G06", "G07", "G08",
  "N01", "N02", "N03", "N04", "N05", "N06", "N07", "N08",
  "N09", "N10", "N11", "N12", "N13", "N14", "N15", "N16",
] as const;

interface RawFixture {
  scenarioId: string;
  events: NormalizedEvent[];
  recovery: {
    strategy: ReplayFixture["recovery"]["strategy"];
    disconnectAfter?: number;
    resumeAfterSourceIndex?: number;
    checkpoint?: Record<string, unknown> | null;
    injections?: ReplayFixture["recovery"]["injections"];
  };
}

export interface GoldenExpected {
  verdict: string;
  diagnostics: string[];
  firstDivergenceSourceIndex: number | null;
  shortestInjectionSequence: string[];
}

export function loadRawFixture(scenarioId: string): RawFixture {
  const url = new URL(`../../fixtures/golden/${scenarioId}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf-8")) as RawFixture;
}

export function loadExpected(): Record<string, GoldenExpected> {
  const url = new URL("../../oracle/golden_expected.json", import.meta.url);
  const parsed = JSON.parse(readFileSync(url, "utf-8")) as {
    traces: Record<string, GoldenExpected>;
  };
  return parsed.traces;
}

type OracleMessage = Record<string, unknown>;
type OracleToolCall = Record<string, unknown>;

function convertMessage(
  raw: OracleMessage,
): MessageState {
  const content = raw["content"] as string | readonly ContentPart[];
  // Segments pass through verbatim (FIX-T003-G03): the fixture
  // fragment's segment list IS the checkpoint's claim about the
  // message. Without a segments field, fall back to the single-segment
  // form of the content (the Oracle snapshot rule).
  const rawSegments = raw["segments"];
  const segments = Array.isArray(rawSegments)
    ? rawSegments.map((s) => ({
        text:
          typeof (s as { readonly text?: unknown } | null)?.text === "string"
            ? ((s as { readonly text: string }).text as string)
            : "",
      }))
    : segmentsForContent(content);
  const message: MessageState = {
    id: raw["id"] as string,
    role: raw["role"] as MessageRole,
    ...(raw["name"] !== undefined && raw["name"] !== null
      ? { name: raw["name"] as string }
      : {}),
    content: content === undefined ? "" : content,
    segments,
    status:
      raw["open"] === true
        ? "open"
        : raw["incomplete"] === true
          ? "incomplete"
          : "closed",
    owner:
      raw["role"] === "activity" || raw["role"] === "reasoning"
        ? "client"
        : "producer",
  };
  // NOTE: the Oracle fragment lists tool-call ids on the message, but
  // a TS streamed message never carries `toolCalls` (the T003 Reducer
  // only installs them from a snapshot / input seeding, and the
  // Golden checkpoints are hand-written fragments, not snapshot
  // events). Synthesising ToolCall objects here would make the
  // checkpoint state differ from every TS fold of the same trace.
  // The fault signal lives in message ORDER and ids, not in this field.
  if (raw["role"] === "tool") {
    return {
      ...message,
      ...(raw["toolCallId"] !== undefined
        ? { toolCallId: raw["toolCallId"] as string }
        : {}),
      ...(raw["error"] !== undefined
        ? { error: raw["error"] as boolean }
        : {}),
    };
  }
  return message;
}

function convertToolCall(
  raw: OracleToolCall,
  prefixRunId: string | null,
): ToolCallState {
  const hasResult = raw["result"] !== null && raw["result"] !== undefined;
  return {
    id: raw["toolCallId"] as string,
    name: (raw["toolCallName"] as string) ?? "",
    ...(raw["parentMessageId"] !== undefined && raw["parentMessageId"] !== null
      ? { parentMessageId: raw["parentMessageId"] as string }
      : {}),
    arguments: (raw["args"] as string) ?? "",
    status:
      raw["open"] === true
        ? "open"
        : raw["incomplete"] === true
          ? "incomplete"
          : hasResult
            ? "resulted"
            : "closed",
    hasResult,
    ...(raw["resultMessageId"] !== undefined && raw["resultMessageId"] !== null
      ? { resultMessageId: raw["resultMessageId"] as string }
      : {}),
    ...(hasResult
      ? { resultContent: raw["result"] as string | readonly ContentPart[] }
      : {}),
    // The Oracle fragment carries no runId; take it from the TS
    // prefix fold for the same call when one exists.
    runId: prefixRunId,
  };
}

function convertCheckpoint(
  raw: Record<string, unknown>,
  events: readonly NormalizedEvent[],
): RecoveryCheckpoint {
  const expanded = expandChunks(events);
  const prefixState = foldTrack(
    expanded.filter((w) => w.sourceIndex <= (raw["sourceIndex"] as number)),
    initialState(),
    -1,
  ).state;

  const rawToolCalls = (raw["toolCalls"] as OracleToolCall[] | undefined) ?? [];
  const messages = ((raw["messages"] as OracleMessage[] | undefined) ?? []).map(
    (m) => convertMessage(m),
  );
  const prefixRunIdByCall = new Map(
    prefixState.toolCalls.map((t) => [t.id, t.runId]),
  );
  const toolCalls = rawToolCalls.map((c) =>
    convertToolCall(c, prefixRunIdByCall.get(c["toolCallId"] as string) ?? null),
  );
  const runs = ((raw["runs"] as Record<string, unknown>[] | undefined) ?? []).map(
    (r) => ({
      runId: r["runId"] as string,
      threadId: r["threadId"] as string,
      status: r["status"] as RejoinState["runs"][number]["status"],
    }),
  );

  const coverage = (raw["coverage"] as
    | { sharedState: boolean; messages: boolean }
    | undefined) ?? { sharedState: true, messages: true };

  const capturedState: RejoinState = {
    ...prefixState,
    threadId: (raw["threadId"] as string | null) ?? prefixState.threadId,
    runs: runs.length > 0 ? runs : prefixState.runs,
    messages,
    toolCalls,
    sharedState:
      raw["sharedState"] !== undefined
        ? (raw["sharedState"] as JsonValue)
        : prefixState.sharedState,
    pendingToolCallIds:
      (raw["pendingToolCallIds"] as string[] | undefined) ??
      prefixState.pendingToolCallIds,
    runStatus:
      (raw["runStatus"] as RejoinState["runStatus"] | undefined) ??
      prefixState.runStatus,
  };

  return {
    threadId: (raw["threadId"] as string) ?? "",
    sourceIndex: raw["sourceIndex"] as number,
    ...(coverage.sharedState && raw["sharedState"] !== undefined
      ? { stateSnapshot: raw["sharedState"] as JsonValue }
      : {}),
    ...(coverage.messages
      ? {
          messagesSnapshot: messages.map(
            (m) => messageStateToAGUI(m) as AGUIMessage,
          ),
        }
      : {}),
    capturedState,
    coverage: { sharedState: coverage.sharedState, messages: coverage.messages },
  };
}

export function toReplayFixture(raw: RawFixture): ReplayFixture {
  const rawCheckpoint = raw.recovery.checkpoint;
  let checkpoint: ReplayFixture["recovery"]["checkpoint"];
  if (rawCheckpoint === null || rawCheckpoint === undefined) {
    checkpoint = null;
  } else if (
    typeof rawCheckpoint === "object" &&
    (rawCheckpoint as Record<string, unknown>)["empty"] === true
  ) {
    checkpoint = { empty: true };
  } else {
    checkpoint = convertCheckpoint(
      rawCheckpoint as Record<string, unknown>,
      raw.events,
    );
  }
  return {
    scenarioId: raw.scenarioId,
    events: raw.events,
    recovery: {
      strategy: raw.recovery.strategy,
      ...(raw.recovery.disconnectAfter !== undefined
        ? { disconnectAfter: raw.recovery.disconnectAfter }
        : {}),
      ...(raw.recovery.resumeAfterSourceIndex !== undefined
        ? { resumeAfterSourceIndex: raw.recovery.resumeAfterSourceIndex }
        : {}),
      checkpoint,
      injections: raw.recovery.injections ?? [],
    },
  };
}

export function loadFixture(scenarioId: string): ReplayFixture {
  return toReplayFixture(loadRawFixture(scenarioId));
}
