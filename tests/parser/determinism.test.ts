/**
 * T002 tests — determinism.
 * Completion definition (IMPLEMENTATION_PLAN §6 T002): importing the same
 * file twice yields the same NormalizedEvent sequence. Proved here at the
 * JSON level (byte-identical serialization) for both formats, including
 * chunk fixtures and CRLF input, and across interleaved imports.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseJsonl } from "../../src/parser/jsonl.js";
import { parseSse } from "../../src/parser/sse.js";
import { expandChunks } from "../../src/parser/normalize.js";

function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf-8");
}

describe("determinism — same file, same NormalizedEvent sequence", () => {
  it("normal.jsonl: repeated imports are byte-identical", () => {
    const input = fixture("normal.jsonl");
    const runs = [parseJsonl(input), parseJsonl(input), parseJsonl(input)];
    expect(JSON.stringify(runs[1])).toBe(JSON.stringify(runs[0]));
    expect(JSON.stringify(runs[2])).toBe(JSON.stringify(runs[0]));
  });

  it("normal.sse: repeated imports are byte-identical", () => {
    const input = fixture("normal.sse");
    expect(JSON.stringify(parseSse(input))).toBe(JSON.stringify(parseSse(input)));
  });

  it("chunks.jsonl: repeated imports are byte-identical, including expansion", () => {
    const input = fixture("chunks.jsonl");
    const first = parseJsonl(input);
    const second = parseJsonl(input);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(expandChunks(second))).toBe(JSON.stringify(expandChunks(first)));
  });

  it("CRLF input parses identically to LF input (byte-identical output)", () => {
    const lf = fixture("normal.jsonl");
    const crlf = lf.replaceAll("\n", "\r\n");
    expect(JSON.stringify(parseJsonl(crlf))).toBe(JSON.stringify(parseJsonl(lf)));
  });

  it("interleaving different imports does not contaminate results (no shared state)", () => {
    const a = fixture("normal.jsonl");
    const b = fixture("chunks.jsonl");
    const a1 = parseJsonl(a);
    parseJsonl(b);
    const a2 = parseJsonl(a);
    expect(JSON.stringify(a2)).toBe(JSON.stringify(a1));
  });

  it("sourceIndex is stable across repeats for every fixture", () => {
    for (const name of ["normal.jsonl", "chunks.jsonl"]) {
      const input = fixture(name);
      const first = parseJsonl(input).map((e) => e.sourceIndex);
      const second = parseJsonl(input).map((e) => e.sourceIndex);
      expect(second).toEqual(first);
      expect(first).toEqual(first.map((_, i) => i));
    }
    const sse = fixture("normal.sse");
    const first = parseSse(sse).map((e) => e.sourceIndex);
    expect(parseSse(sse).map((e) => e.sourceIndex)).toEqual(first);
  });
});
