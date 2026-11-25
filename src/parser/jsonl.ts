/**
 * P031 RejoinLab — T002: JSONL import.
 *
 * One AG-UI event (one JSON object) per line. Line terminators LF, CRLF and
 * bare CR are all accepted. Blank lines are skipped and do not consume a
 * sourceIndex. Each event's JSON is parsed, validated (Schema layer +
 * chunk-lane layer, see normalize.ts) and assigned a stable 0-based
 * sourceIndex in file arrival order. transportEventId is always null for
 * JSONL: there is no transport id in this format.
 *
 * Failure behaviour (T002 fallback): any malformed line, missing required
 * field, unknown type, unsupported event or size violation throws a
 * ParseError and NO partial event list is returned, so an incomplete parse
 * can never enter the Reducer. The diagnostic carries the exact 1-based
 * line number; the caller retains the original input text.
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

export interface JsonlParseOptions {
  /**
   * Optional caller-supplied stable keys, one per event in arrival order.
   * When given, keys[i] becomes sourceEventKey of the i-th event; when
   * omitted (the default) sourceEventKey is null.
   */
  readonly sourceEventKeys?: readonly (string | null)[];
}

/**
 * Parse a JSONL document into NormalizedEvents. Throws ParseError on the
 * first violation (invalid JSON, non-object event, missing required field,
 * unknown/unsupported type, size limit). Deterministic: the same input
 * always yields the same sequence.
 */
export function parseJsonl(input: string, options: JsonlParseOptions = {}): NormalizedEvent[] {
  checkInputSize(input);
  const items: RawImportItem[] = [];
  for (const { text, line } of splitTextLines(input)) {
    if (text.trim() === "") continue;
    checkEventSize(text, line, items.length);
    let raw: unknown;
    try {
      raw = JSON.parse(text) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ParseError([
        {
          code: "INVALID_INPUT",
          message: `Line ${line}: invalid JSON: ${detail}`,
          line,
          sourceIndex: items.length,
        },
      ]);
    }
    items.push({ raw, transportEventId: null, line });
  }
  const events = normalizeEvents(items);
  if (options.sourceEventKeys === undefined) return events;
  return events.map((event, i) => ({
    ...event,
    sourceEventKey: options.sourceEventKeys?.[i] ?? null,
  }));
}
