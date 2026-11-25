/**
 * P031 RejoinLab — T002: SSE (Server-Sent Events) import.
 *
 * Parses a local SSE text file (WHATWG SSE framing, as used by the AG-UI
 * 1.0 HTTP+SSE binding) into NormalizedEvents. Each SSE event's `data`
 * payload is one complete AG-UI JSON event.
 *
 * Framing rules implemented:
 * - Line terminators LF, CRLF and bare CR are all accepted (AGUI_SCOPE
 *   §4.2: producers must use LF; consumers accept full SSE syntax).
 * - A blank line dispatches the pending SSE event; a final event without
 *   a trailing blank line is dispatched at end of input.
 * - Comment lines (starting with ':') are ignored.
 * - Multiple `data:` lines are joined with "\n" (SSE spec); the joined
 *   payload is parsed as one JSON event.
 * - The SSE `id:` field is retained verbatim as transportEventId. It is
 *   transport-layer evidence only: it is NEVER promoted to an AG-UI
 *   eventId (AG-UI 1.0 defines no eventId) and never used as a resume
 *   cursor (AG-UI 1.0 HTTP+SSE has no resumption).
 * - `event:`, `retry:` and any other non-data field are ignored, per the
 *   AG-UI 1.0 HTTP+SSE binding ("consumers MUST ignore fields other than
 *   data", except `id` which RejoinLab retains as evidence).
 * - An SSE event with no `data:` lines dispatches nothing and consumes no
 *   sourceIndex (e.g. a comment-only or id-only block).
 * - A leading UTF-8 BOM is stripped.
 *
 * Failure behaviour: same as JSONL — any malformed payload, missing
 * required field, unknown type, unsupported event or size violation throws
 * a ParseError with the 1-based line where the SSE event starts, and NO
 * partial list is returned.
 */

import type { NormalizedEvent } from "../protocol/types.js";
import {
  checkEventSize,
  checkInputSize,
  normalizeEvents,
  ParseError,
  splitTextLines,
  type RawImportItem,
} from "./normalize.js";

export { ParseError };

export interface SseParseOptions {
  readonly sourceEventKeys?: readonly (string | null)[];
}

interface SseBlock {
  dataLines: string[];
  transportEventId: string | null;
  /** 1-based line where this SSE event's first line appears. */
  startLine: number;
}

/**
 * Parse an SSE document into NormalizedEvents. Throws ParseError on the
 * first violation. Deterministic: the same input always yields the same
 * sequence.
 */
export function parseSse(input: string, options: SseParseOptions = {}): NormalizedEvent[] {
  checkInputSize(input);
  const blocks = splitSseBlocks(input);
  const items: RawImportItem[] = [];
  for (const block of blocks) {
    if (block.dataLines.length === 0) continue;
    const payload = block.dataLines.join("\n");
    checkEventSize(payload, block.startLine, items.length);
    let raw: unknown;
    try {
      raw = JSON.parse(payload) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ParseError([
        {
          code: "INVALID_INPUT",
          message: `SSE event starting at line ${block.startLine}: invalid JSON in data payload: ${detail}`,
          line: block.startLine,
          sourceIndex: items.length,
        },
      ]);
    }
    items.push({ raw, transportEventId: block.transportEventId, line: block.startLine });
  }
  const events = normalizeEvents(items);
  if (options.sourceEventKeys === undefined) return events;
  return events.map((event, i) => ({
    ...event,
    sourceEventKey: options.sourceEventKeys?.[i] ?? null,
  }));
}

/**
 * Split SSE text into event blocks. A block ends at a blank line; the last
 * block (if it has any content) is dispatched at end of input.
 */
export function splitSseBlocks(input: string): SseBlock[] {
  const blocks: SseBlock[] = [];
  let current: SseBlock | null = null;

  const startBlock = (line: number): SseBlock => {
    const block: SseBlock = { dataLines: [], transportEventId: null, startLine: line };
    blocks.push(block);
    return block;
  };

  for (const { text, line } of splitTextLines(input)) {
    if (text === "") {
      current = null;
      continue;
    }
    if (current === null) current = startBlock(line);
    if (text.startsWith(":")) continue; // comment line
    const colon = text.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      field = text;
      value = "";
    } else {
      field = text.slice(0, colon);
      value = text.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    if (field === "data") {
      current.dataLines.push(value);
    } else if (field === "id") {
      // Last id wins; an empty id is kept as "" (WHATWG: sets the last
      // event ID string to the empty string), never silently dropped.
      current.transportEventId = value;
    }
    // "event", "retry" and unknown fields are ignored (AG-UI 1.0 binding).
  }
  return blocks;
}
