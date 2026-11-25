/**
 * P031 RejoinLab — T002: parser public surface.
 *
 * - parseJsonl: JSONL import (src/parser/jsonl.ts).
 * - parseSse: SSE import (src/parser/sse.ts).
 * - normalizeEvents / normalizeEvent / validateEvent / expandChunks:
 *   normalization, validation and chunk expansion (src/parser/normalize.ts).
 *   expandChunks is provided for T003 to call before the Reducer.
 */

export { parseJsonl, type JsonlParseOptions } from "./jsonl.js";
export { parseSse, splitSseBlocks, type SseParseOptions } from "./sse.js";
export {
  MAX_EVENT_BYTES,
  MAX_INPUT_BYTES,
  ParseError,
  checkEventSize,
  checkInputSize,
  expandChunks,
  normalizeEvent,
  normalizeEvents,
  splitTextLines,
  utf8ByteLength,
  validateEvent,
  SCHEMA_EVENT_TYPES,
  UNSUPPORTED_EVENT_TYPES,
  type DiagnosticCode,
  type ParseDiagnostic,
  type RawImportItem,
  type TextLine,
} from "./normalize.js";

import { parseJsonl } from "./jsonl.js";
import { parseSse } from "./sse.js";
import type { NormalizedEvent } from "../protocol/types.js";

/** Dispatch to the JSONL or SSE parser by declared format. */
export function parseInput(
  input: string,
  format: "jsonl" | "sse",
  options: { readonly sourceEventKeys?: readonly (string | null)[] } = {},
): NormalizedEvent[] {
  return format === "jsonl" ? parseJsonl(input, options) : parseSse(input, options);
}
