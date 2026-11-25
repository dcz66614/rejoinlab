/**
 * P031 RejoinLab — AG-UI 1.0 frozen protocol types (T001).
 *
 * Source of truth: AG-UI 1.0 JSON Schema
 *   https://docs.ag-ui.com/spec/1.0/schema.json
 *   ($id https://ag-ui.com/spec/1.0/schema.json, SHA-256 4b5c9322…e48e71a,
 *   frozen local copy: docs/ag-ui-1.0-schema.json)
 * and PROJECT_BOOK.md v1.0.2 §3.4. Field optionality below follows the Schema's
 * `required` arrays, NOT prose summaries. Where the project book's §3 prose
 * differs from the Schema, the difference is flagged in docs/EVENT_SCHEMA.md
 * (§8) and the Schema wins (PROJECT_BOOK §2.1).
 *
 * Scope: the 15 MVP events only (docs/AGUI_SCOPE.md §2). Unsupported events
 * (STEP_*, REASONING_*, ACTIVITY_*, SUBAGENT_*, RAW, CUSTOM, draft events)
 * deliberately have NO type here; encountering one must produce
 * INCONCLUSIVE_LIMIT / INVALID_INPUT, never a silent drop (PROJECT_BOOK §3.2).
 *
 * AG-UI 1.0 defines NO eventId. There is no `eventId` field on any type in
 * this file. SSE `id` is transport only (see NormalizedEvent.transportEventId).
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** RFC 6902 JSON Pointer (Schema $defs/JsonPointer). */
export type JsonPointer = string;

/** RFC 6902 JSON Patch operation (Schema $defs/JsonPatchOperation). */
export type JsonPatchOperation =
  | { readonly op: "add"; readonly path: JsonPointer; readonly value: JsonValue }
  | { readonly op: "remove"; readonly path: JsonPointer }
  | { readonly op: "replace"; readonly path: JsonPointer; readonly value: JsonValue }
  | { readonly op: "move"; readonly from: JsonPointer; readonly path: JsonPointer }
  | { readonly op: "copy"; readonly from: JsonPointer; readonly path: JsonPointer }
  | { readonly op: "test"; readonly path: JsonPointer; readonly value: JsonValue };

export type JsonPatch = readonly JsonPatchOperation[];

/**
 * Open-by-key metadata (Schema $defs/Metadata). Any JSON value is allowed
 * under a key, including null. The key `ag-ui` is reserved for the protocol.
 */
export type Metadata = { readonly [key: string]: JsonValue };

/** Roles a streamed text message may take (Schema $defs/TextMessageRole). */
export type TextMessageRole = "developer" | "system" | "assistant" | "user";

/** Roles any message may carry (Schema $defs/Role). */
export type MessageRole =
  | "developer"
  | "system"
  | "assistant"
  | "user"
  | "tool"
  | "activity"
  | "reasoning";

/** Content part source (Schema $defs/PartSource). */
export type PartSource =
  | { readonly type: "url"; readonly value: string; readonly mimeType?: string }
  | { readonly type: "data"; readonly value: string; readonly mimeType: string }
  | { readonly type: "file"; readonly value: string; readonly provider?: string; readonly mimeType?: string };

/** Content parts (Schema $defs/ContentPart). */
export type ContentPart =
  | { readonly type: "text"; readonly id?: string; readonly text: string; readonly metadata?: Metadata }
  | { readonly type: "image"; readonly id?: string; readonly source: PartSource; readonly metadata?: Metadata }
  | { readonly type: "audio"; readonly id?: string; readonly source: PartSource; readonly metadata?: Metadata }
  | { readonly type: "video"; readonly id?: string; readonly source: PartSource; readonly metadata?: Metadata }
  | { readonly type: "document"; readonly id?: string; readonly source: PartSource; readonly metadata?: Metadata };

/** A function call inside an assistant message (Schema $defs/ToolCall). */
export interface ToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
  readonly metadata?: Metadata;
}

/**
 * Messages (Schema $defs/Message). `id` and `role` are required on all.
 *
 * Activity / reasoning (J-06, added by T003 errata): the Schema's
 * $defs/Message oneOf has seven members and T002 validates message roles
 * against the 7-role list, but T001 typed only five — so activity /
 * reasoning messages arriving in MESSAGES_SNAPSHOT / RUN_STARTED input
 * had no variant. The two added here follow the Schema:
 * - ActivityMessage: `id`, `role`, `activityType` and `content` are all
 *   required; `content` is an OBJECT payload (open by key), NOT text —
 *   activity is "structured progress that is not conversation content".
 *   It carries no `name` (it does not compose BaseMessage).
 * - ReasoningMessage: `id`, `role` and `content` (string) are required.
 *   It carries no `name` either.
 * `encryptedValue` (Schema: an opaque provider artefact on both) is
 * deliberately NOT modelled — no other variant in this union models it
 * either, and nothing in the Reducer reads it. `name?: never` on both
 * records the Schema's "carries no name" while keeping the generic
 * `.name` reads in snapshot.ts / lifecycle.ts compiling.
 */
export type AGUIMessage =
  | { readonly id: string; readonly role: "assistant"; readonly name?: string; readonly content?: string | readonly ContentPart[]; readonly toolCalls?: readonly ToolCall[]; readonly metadata?: Metadata }
  | { readonly id: string; readonly role: "user"; readonly name?: string; readonly content: string | readonly ContentPart[]; readonly metadata?: Metadata }
  | { readonly id: string; readonly role: "system"; readonly name?: string; readonly content: string | readonly ContentPart[]; readonly metadata?: Metadata }
  | { readonly id: string; readonly role: "developer"; readonly name?: string; readonly content: string | readonly ContentPart[]; readonly metadata?: Metadata }
  | { readonly id: string; readonly role: "tool"; readonly name?: string; readonly content: string | readonly ContentPart[]; readonly toolCallId: string; readonly error?: boolean; readonly metadata?: Metadata }
  | { readonly id: string; readonly role: "activity"; readonly activityType: string; readonly content: { readonly [key: string]: JsonValue }; readonly name?: never; readonly metadata?: Metadata }
  | { readonly id: string; readonly role: "reasoning"; readonly content: string; readonly name?: never; readonly metadata?: Metadata };

/**
 * Run input echoed back on RUN_STARTED (Schema $defs/RunAgentInput).
 * Required: threadId, runId, messages.
 */
export interface RunAgentInput {
  readonly threadId: string;
  readonly runId: string;
  readonly messages: readonly AGUIMessage[];
  readonly protocolVersion?: string;
  readonly parentRunId?: string;
  readonly state?: JsonValue;
  readonly tools?: readonly unknown[];
  readonly context?: readonly unknown[];
  readonly forwardedProps?: { readonly [key: string]: JsonValue };
  readonly resume?: readonly unknown[];
}

/** Why a run ended (Schema $defs/RunFinishedOutcome). Absent means success. */
export type RunFinishedOutcome =
  | { readonly type: "success"; readonly pendingToolCallIds?: readonly string[] }
  | { readonly type: "interrupt"; readonly interrupts: readonly unknown[] }
  | { readonly type: "cancelled" };

/**
 * Common fields of every event (Schema $defs/BaseEvent).
 * Required: type only. timestamp is an integer (ms since epoch is NOT
 * constrained by the Schema — the unit is deliberately unconstrained);
 * it is informational and MUST NOT be used to reorder events.
 */
export interface BaseEvent {
  readonly type: string;
  readonly timestamp?: number;
  readonly rawEvent?: JsonValue;
  readonly metadata?: Metadata;
}

// ---------------------------------------------------------------------------
// The 15 MVP events (PROJECT_BOOK §3.2). `type` is a literal on each.
// ---------------------------------------------------------------------------

export interface RunStartedEvent extends BaseEvent {
  readonly type: "RUN_STARTED";
  readonly threadId: string;
  readonly runId: string;
  readonly protocolVersion?: string;
  readonly parentRunId?: string;
  readonly input?: RunAgentInput;
}

export interface RunFinishedEvent extends BaseEvent {
  readonly type: "RUN_FINISHED";
  readonly threadId: string;
  readonly runId: string;
  readonly result?: JsonValue;
  readonly outcome?: RunFinishedOutcome;
  readonly usage?: readonly unknown[];
}

export interface RunErrorEvent extends BaseEvent {
  readonly type: "RUN_ERROR";
  readonly message: string;
  readonly code?: string;
  readonly usage?: readonly unknown[];
}

export interface TextMessageStartEvent extends BaseEvent {
  readonly type: "TEXT_MESSAGE_START";
  readonly messageId: string;
  readonly role?: TextMessageRole;
  readonly name?: string;
}

export interface TextMessageContentEvent extends BaseEvent {
  readonly type: "TEXT_MESSAGE_CONTENT";
  readonly messageId: string;
  /** May be the empty string (keep-alive); never treat as an error by itself. */
  readonly delta: string;
}

export interface TextMessageEndEvent extends BaseEvent {
  readonly type: "TEXT_MESSAGE_END";
  readonly messageId: string;
}

/**
 * Chunked form. Schema-required: type only. The FIRST chunk of an item MUST
 * carry messageId (spec: Streaming Messages, "The first chunk"); later chunks
 * MAY omit it and continue the open item. Consumers MUST expand chunks into
 * START / CONTENT / END before verification (T002/T003).
 */
export interface TextMessageChunkEvent extends BaseEvent {
  readonly type: "TEXT_MESSAGE_CHUNK";
  readonly messageId?: string;
  readonly role?: TextMessageRole;
  readonly name?: string;
  readonly delta?: string;
}

export interface ToolCallStartEvent extends BaseEvent {
  readonly type: "TOOL_CALL_START";
  readonly toolCallId: string;
  readonly toolCallName: string;
  readonly parentMessageId?: string;
}

export interface ToolCallArgsEvent extends BaseEvent {
  readonly type: "TOOL_CALL_ARGS";
  readonly toolCallId: string;
  readonly delta: string;
}

export interface ToolCallEndEvent extends BaseEvent {
  readonly type: "TOOL_CALL_END";
  readonly toolCallId: string;
}

/**
 * Chunked form. Schema-required: type only. The FIRST chunk of a call MUST
 * carry toolCallId AND toolCallName (spec: Streaming Messages); later chunks
 * MAY omit them. Consumers MUST expand chunks before verification (T002/T003).
 */
export interface ToolCallChunkEvent extends BaseEvent {
  readonly type: "TOOL_CALL_CHUNK";
  readonly toolCallId?: string;
  readonly toolCallName?: string;
  readonly parentMessageId?: string;
  readonly delta?: string;
}

export interface ToolCallResultEvent extends BaseEvent {
  readonly type: "TOOL_CALL_RESULT";
  readonly messageId: string;
  readonly toolCallId: string;
  readonly content: string | readonly ContentPart[];
  /** If present, MUST be "tool". */
  readonly role?: "tool";
}

export interface StateSnapshotEvent extends BaseEvent {
  readonly type: "STATE_SNAPSHOT";
  /** Complete new state; any JSON value. Replaces, never merges. */
  readonly snapshot: JsonValue;
}

export interface StateDeltaEvent extends BaseEvent {
  readonly type: "STATE_DELTA";
  /** RFC 6902 JSON Patch, applied in order, atomically, against current state. */
  readonly delta: JsonPatch;
}

export interface MessagesSnapshotEvent extends BaseEvent {
  readonly type: "MESSAGES_SNAPSHOT";
  /** The complete set of messages the producer owns, in order. */
  readonly messages: readonly AGUIMessage[];
}

export type AGUIEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | TextMessageChunkEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallChunkEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | MessagesSnapshotEvent;

export type AGUIEventType = AGUIEvent["type"];

export const MVP_EVENT_TYPES: readonly AGUIEventType[] = [
  "RUN_STARTED",
  "RUN_FINISHED",
  "RUN_ERROR",
  "TEXT_MESSAGE_START",
  "TEXT_MESSAGE_CONTENT",
  "TEXT_MESSAGE_END",
  "TEXT_MESSAGE_CHUNK",
  "TOOL_CALL_START",
  "TOOL_CALL_ARGS",
  "TOOL_CALL_END",
  "TOOL_CALL_CHUNK",
  "TOOL_CALL_RESULT",
  "STATE_SNAPSHOT",
  "STATE_DELTA",
  "MESSAGES_SNAPSHOT",
] as const;

export function isMvpEventType(type: string): type is AGUIEventType {
  return (MVP_EVENT_TYPES as readonly string[]).includes(type);
}

// ---------------------------------------------------------------------------
// RejoinLab local import wrapper (IMPLEMENTATION_PLAN §5.1, PROJECT_BOOK §4.2).
// These fields are RejoinLab-local bookkeeping, NOT part of the AG-UI protocol.
// ---------------------------------------------------------------------------

export interface NormalizedEvent {
  /** 0-based sequence number assigned by RejoinLab for this import file. */
  readonly sourceIndex: number;
  /** Caller-supplied stable event key, if any; otherwise null. */
  readonly sourceEventKey: string | null;
  /**
   * Raw SSE `id` field when the source is SSE; otherwise null.
   * Transport-layer evidence only — NEVER an AG-UI eventId, NEVER a resume
   * cursor (AG-UI 1.0 HTTP+SSE has no stream resumption).
   */
  readonly transportEventId: string | null;
  /** The original AG-UI event object. */
  readonly event: AGUIEvent;
}

/** Local recovery checkpoint (PROJECT_BOOK §4.4). Frozen here, used by T005.
 * `capturedState` was omitted at T001 because RejoinState did not exist
 * yet (EVENT_SCHEMA §8 D-05); T003 adds it back now that RejoinState is
 * frozen in src/core/state.ts. Type-only import: erased at compile time,
 * so there is no runtime import cycle with core/state.ts. */
export interface RecoveryCheckpoint {
  readonly threadId: string;
  readonly sourceIndex: number;
  readonly stateSnapshot?: JsonValue;
  readonly messagesSnapshot?: readonly AGUIMessage[];
  readonly capturedState: RejoinState;
  readonly coverage: { readonly sharedState: boolean; readonly messages: boolean };
}

// Imported only as a type (see the RecoveryCheckpoint note above).
import type { RejoinState } from "../core/state.js";
