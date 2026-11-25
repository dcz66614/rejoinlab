/**
 * P031 RejoinLab — T004: JCS canonicalization + state hashing.
 *
 * Frozen sources:
 * - PROJECT_BOOK.md v1.0.0 §5.2 (canon(S_full) = canon(S_resume)),
 *   §5.3 (canon 规范：RFC 8785 JCS 语义), §5.6 (timeline 保留交错).
 * - IMPLEMENTATION_PLAN.md v1.0.0 §5.3 (RejoinState), §6 T004 任务卡.
 * - Oracle oracle/canonical.py (只读比对参考；本实现独立编写，
 *   不共享代码、不把 Oracle 输出当预期值).
 *
 * Rules (PROJECT_BOOK §5.3):
 * - Object keys sorted in UTF-16 code-unit order (JCS §3.2.3); array
 *   order preserved; strings JSON-escaped per JCS (control chars
 *   escaped, non-ASCII emitted raw as UTF-8, lone surrogates escaped
 *   as \uXXXX); numbers in ECMAScript Number::toString form (JCS
 *   §3.2.2.3); NaN / Infinity are rejected; `undefined` is NOT null
 *   (a bare undefined value is rejected, never coerced); local run
 *   metadata (timestamp, sourceIndex, import file names, timings) is
 *   excluded by the state projection, while messageId, toolCallId,
 *   message order and tool results are retained.
 * - Canonical bytes are UTF-8; digest is SHA-256.
 *
 * State projection (canon 只覆盖 8 个协议字段):
 * - RejoinState has a 9th field, `diagnostics` (T003-local bookkeeping,
 *   not protocol state). canonicalizeState() projects onto exactly the
 *   8 protocol fields (threadId, runs, messages, toolCalls,
 *   sharedState, orderedTimeline, pendingToolCallIds, runStatus) and
 *   drops `diagnostics` — the same rule Oracle's canonical.py states
 *   ("diagnostics is dropped"). Any other non-protocol key smuggled
 *   onto a state object is likewise dropped by the projection.
 * - The projection is VERBATIM for the 8 fields: every sub-field of a
 *   run / message / tool call / timeline item is business state
 *   (status, owner, hasResult, resultContent, eventType, ...). Oracle's
 *   canonicalize_state() additionally projects each entry onto a
 *   shorter key list keyed to ORACLE-INTERNAL field names
 *   (messages: id/role/name/content/segments/toolCalls/open/incomplete;
 *   toolCalls: toolCallId/toolCallName/args/result/...; runs:
 *   runId/threadId/status; timeline: kind/messageId/toolCallId/delta/
 *   text/name). Those names do NOT match the frozen TS RejoinState
 *   field names (MessageState.status/owner, ToolCallState.id/name/
 *   arguments/status/hasResult/resultContent/runId, RunState with
 *   parentRunId/protocolVersion/outcome/result/error,
 *   TimelineItem.kind/eventType/messageId/toolCallId/runId/text), so
 *   feeding a TS-shaped state to Oracle's canonicalize_state() would
 *   silently drop most of it. Cross-language parity is therefore
 *   established at the generic canonicalize() level (identical JSON
 *   value -> byte-identical output, verified in
 *   tests/core/canonical/oracle-parity.test.ts against
 *   oracle.canonical.canonicalize), plus the shared rule "8 protocol
 *   fields only, diagnostics dropped". The TS projection bytes are
 *   additionally checked against Python canonicalize() applied to the
 *   same projected JSON value.
 * - `sharedState === undefined` ("no baseline yet", distinct from the
 *   JSON value null) is encoded as null IN THE PROJECTION ONLY. This
 *   mirrors Oracle's `state.get(field)` -> None -> null, and keeps the
 *   projected object shape constant (all 8 keys always present). It is
 *   a projection-level rule, not a generic coercion: bare `undefined`
 *   anywhere else is rejected by canonicalize() (see above), and a
 *   nested undefined inside sharedState is dropped as an absent
 *   object key by the projection's stripUndefined() pass.
 *
 * Report-hash note (for T007; T004 only leaves the interface):
 * - PROJECT_BOOK §11 requires "相同输入重复 100 次，报告哈希只有
 *   一个值", while §13.2's report schema contains
 *   metrics.durationMs, a timing field that varies on every run.
 *   The report-hash definition is NOT frozen here and will be frozen
 *   by T007 (expected: canon hash of the report with
 *   metrics.durationMs excluded). canonicalHash()/canonicalize() in
 *   this module are the reusable primitives for that definition:
 *   durationMs MUST NOT enter any report hash. Do not hash a report
 *   object with canonicalHash() directly until T007 freezes the
 *   exclusion list.
 *
 * Determinism: pure functions only — no time, no randomness, no I/O.
 * SHA-256 is implemented here in plain TypeScript (FIPS 180-4) so this
 * module stays usable in a browser Web Worker (T009) with no Node-only
 * import; it is cross-checked against node:crypto in the tests.
 */

import type { RejoinState } from "./state.js";

/** Thrown when a value cannot be canonicalized (non-JSON value). */
export class JcsError extends Error {
  constructor(message: string) {
    super(`[JCS] ${message}`);
    this.name = "JcsError";
  }
}

/** The 8 protocol fields covered by the state canon (diagnostics out). */
export const STATE_FIELDS: readonly string[] = [
  "threadId",
  "runs",
  "messages",
  "toolCalls",
  "sharedState",
  "orderedTimeline",
  "pendingToolCallIds",
  "runStatus",
] as const;

// ---------------------------------------------------------------------------
// SHA-256 (FIPS 180-4), plain TypeScript. Cross-checked against
// node:crypto in tests/core/canonical/canonical.test.ts.
// ---------------------------------------------------------------------------

const SHA256_K: readonly number[] = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const SHA256_H0: readonly number[] = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
];

function rotr32(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

/**
 * SHA-256 hex digest of a UTF-8 string. Pure TS; no Node-only import.
 * Known vectors (FIPS 180-4): "" -> e3b0c44298fc1c149afbf4c8996fb924
 * 27ae41e4649b934ca495991b7852b855, "abc" -> ba7816bf8f01cfea414140de5d
 * 01f... (full vectors asserted in the tests).
 */
export function sha256Hex(data: string): string {
  const bytes = new TextEncoder().encode(data);
  const bitLenLow = (bytes.length << 3) >>> 0;
  const bitLenHigh = Math.floor(bytes.length / 0x20000000);
  const paddedLen = (((bytes.length + 9 + 63) >> 6) << 6);
  const msg = new Uint8Array(paddedLen);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const view = new DataView(msg.buffer);
  // 64-bit big-endian bit length in the last 8 bytes.
  view.setUint32(paddedLen - 8, bitLenHigh);
  view.setUint32(paddedLen - 4, bitLenLow);

  let h0 = SHA256_H0[0] as number;
  let h1 = SHA256_H0[1] as number;
  let h2 = SHA256_H0[2] as number;
  let h3 = SHA256_H0[3] as number;
  let h4 = SHA256_H0[4] as number;
  let h5 = SHA256_H0[5] as number;
  let h6 = SHA256_H0[6] as number;
  let h7 = SHA256_H0[7] as number;

  const w = new Array<number>(64);
  for (let block = 0; block < paddedLen; block += 64) {
    for (let t = 0; t < 16; t += 1) {
      w[t] = view.getUint32(block + t * 4);
    }
    for (let t = 16; t < 64; t += 1) {
      const s0 =
        rotr32(w[t - 15] as number, 7) ^
        rotr32(w[t - 15] as number, 18) ^
        ((w[t - 15] as number) >>> 3);
      const s1 =
        rotr32(w[t - 2] as number, 17) ^
        rotr32(w[t - 2] as number, 19) ^
        ((w[t - 2] as number) >>> 10);
      w[t] = (((w[t - 16] as number) + s0 + (w[t - 7] as number) + s1) | 0);
    }
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;
    for (let t = 0; t < 64; t += 1) {
      const s1 =
        rotr32(e, 6) ^ rotr32(e, 11) ^ rotr32(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 =
        (h + s1 + ch + (SHA256_K[t] as number) + (w[t] as number)) | 0;
      const s0 = rotr32(a, 2) ^ rotr32(a, 13) ^ rotr32(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }
  const words = [h0, h1, h2, h3, h4, h5, h6, h7];
  return words
    .map((word) => (word >>> 0).toString(16).padStart(8, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// JCS canonicalization (RFC 8785).
// ---------------------------------------------------------------------------

/**
 * Escape one string per JCS §3.2.2.2: escape `"` and `\`, the C0
 * controls (\b \t \n \f \r, else \u00XX lowercase hex); lone
 * surrogates as \uXXXX; every other character — including non-ASCII
 * and valid surrogate pairs — is emitted raw (UTF-8 on the wire).
 */
function escapeJcsString(value: string): string {
  let out = '"';
  for (let i = 0; i < value.length; i += 1) {
    const cu = value.charCodeAt(i);
    if (cu === 0x22) {
      out += '\\"';
    } else if (cu === 0x5c) {
      out += "\\\\";
    } else if (cu === 0x08) {
      out += "\\b";
    } else if (cu === 0x09) {
      out += "\\t";
    } else if (cu === 0x0a) {
      out += "\\n";
    } else if (cu === 0x0c) {
      out += "\\f";
    } else if (cu === 0x0d) {
      out += "\\r";
    } else if (cu < 0x20) {
      out += "\\u" + cu.toString(16).padStart(4, "0");
    } else if (cu >= 0xd800 && cu <= 0xdbff) {
      // High surrogate: valid pair -> emit the pair raw; lone -> escape.
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[i] as string;
        out += value[i + 1] as string;
        i += 1;
      } else {
        out += "\\u" + cu.toString(16).padStart(4, "0");
      }
    } else if (cu >= 0xdc00 && cu <= 0xdfff) {
      // Lone low surrogate.
      out += "\\u" + cu.toString(16).padStart(4, "0");
    } else {
      out += value[i] as string;
    }
  }
  return out + '"';
}

/**
 * Format a finite number per JCS §3.2.2.3, which defers to ECMAScript
 * Number::toString — in JS that is exactly `String(n)`. -0 formats as
 * "0" (String(-0) === "0"), matching JCS. Non-finite values are
 * rejected by the caller before this is reached.
 */
function formatJcsNumber(value: number): string {
  return String(value);
}

function writeValue(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new JcsError(
        `NaN and Infinity are not JSON values (got ${String(value)})`,
      );
    }
    return formatJcsNumber(value);
  }
  if (typeof value === "string") return escapeJcsString(value);
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new JcsError("circular value cannot be canonicalized");
    }
    ancestors.add(value);
    try {
      const parts: string[] = [];
      for (let i = 0; i < value.length; i += 1) {
        // Array holes / undefined elements are not JSON values.
        if (!(i in value)) {
          throw new JcsError(`array hole at index ${i} is not a JSON value`);
        }
        parts.push(writeValue(value[i], ancestors));
      }
      return "[" + parts.join(",") + "]";
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === "object") {
    if (ancestors.has(value)) {
      throw new JcsError("circular value cannot be canonicalized");
    }
    ancestors.add(value);
    try {
      // Default Array.sort() compares strings by UTF-16 code units —
      // exactly the JCS key order (§3.2.3). Sorting a fresh array also
      // neutralises JS's integer-key-first Object.keys() order.
      const keys = Object.keys(value as Record<string, unknown>).sort();
      for (const key of keys) {
        if (
          typeof (value as Record<string, unknown>)[key] === "symbol" ||
          typeof (value as Record<string, unknown>)[key] === "function"
        ) {
          throw new JcsError(
            `property ${JSON.stringify(key)} holds a non-JSON value`,
          );
        }
      }
      const parts: string[] = [];
      for (const key of keys) {
        const child = (value as Record<string, unknown>)[key];
        if (child === undefined) {
          // undefined is NOT null (§5.3): reject, never coerce.
          throw new JcsError(
            `property ${JSON.stringify(key)} is undefined; undefined is not a JSON value`,
          );
        }
        parts.push(escapeJcsString(key) + ":" + writeValue(child, ancestors));
      }
      return "{" + parts.join(",") + "}";
    } finally {
      ancestors.delete(value);
    }
  }
  // undefined, bigint, function, symbol at the top level or nested.
  throw new JcsError(`value of type ${typeof value} is not a JSON value`);
}

/**
 * The RFC 8785 canonical JSON string of a JSON value.
 * Throws JcsError on any non-JSON value (undefined, NaN, Infinity,
 * bigint, function, symbol, circular reference, array hole).
 */
export function canonicalize(value: unknown): string {
  return writeValue(value, new Set<object>());
}

/** The canonical UTF-8 bytes of a JSON value. */
export function canonicalBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalize(value));
}

/**
 * SHA-256 hex digest of the canonical UTF-8 bytes of a JSON value.
 * Reusable primitive for the report hash (T007): when hashing a
 * report, hash the T007-frozen projection — durationMs MUST NOT enter
 * the hash (see the module header).
 */
export function canonicalHash(value: unknown): string {
  return sha256Hex(canonicalize(value));
}

// ---------------------------------------------------------------------------
// RejoinState projection (8 protocol fields; diagnostics dropped).
// ---------------------------------------------------------------------------

/**
 * Deep-clean a JSON-ish value for the state projection: drop
 * object properties whose value is `undefined` (TS optional fields
 * that were never set — Python dicts simply lack the key), recurse
 * into arrays/objects. Throws JcsError on undefined array elements
 * and on non-JSON values, so canonicalize() never sees them.
 */
function stripUndefined(value: unknown): unknown {
  if (value === undefined) {
    throw new JcsError("undefined is not a JSON value");
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefined(item));
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) out[key] = stripUndefined(child);
  }
  return out;
}

/**
 * Project a RejoinState onto its 8 protocol fields only.
 * `diagnostics` (T003-local bookkeeping) and any other non-protocol
 * key are dropped. `sharedState === undefined` ("no baseline yet")
 * is encoded as null in the projection only (mirrors Oracle's
 * state.get(field) -> None -> null); see the module header.
 * The returned object is a fresh deep copy; the input is not mutated.
 * Verified (FIX-T003-G03): the projection is VERBATIM for the 8
 * fields, so a message's `segments` sub-field enters the hash with no
 * code change — a checkpoint that merges two segments into one hashes
 * differently from the full path, as the Oracle's canonicalize_state
 * (which projects messages onto id/role/name/content/segments/...) does.
 */
export function projectState(state: RejoinState): Record<string, unknown> {
  return {
    threadId: state.threadId,
    runs: stripUndefined(state.runs),
    messages: stripUndefined(state.messages),
    toolCalls: stripUndefined(state.toolCalls),
    sharedState:
      state.sharedState === undefined
        ? null
        : stripUndefined(state.sharedState),
    orderedTimeline: stripUndefined(state.orderedTimeline),
    pendingToolCallIds: [...state.pendingToolCallIds],
    runStatus: state.runStatus,
  };
}

/** The canonical JSON string of a RejoinState (8 protocol fields). */
export function canonicalizeState(state: RejoinState): string {
  return canonicalize(projectState(state));
}

/** SHA-256 hex digest of the canonical state (8 protocol fields). */
export function stateHash(state: RejoinState): string {
  return sha256Hex(canonicalizeState(state));
}
