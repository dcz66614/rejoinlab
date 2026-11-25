/**
 * T007 S0 gate — three-way parity (TS production vs Python Oracle vs
 * hand-derived golden_expected.json), legal-recovery convergence, and
 * 100x report-hash determinism.
 *
 * This suite is the MEASUREMENT instrument. Each per-Golden test
 * stores its full comparison row in `rows` BEFORE asserting, and the
 * summary test writes artifacts/reports/S0_PARITY.json BEFORE
 * asserting the thresholds — so the evidence file exists even when
 * the gate fails. The PASS/FAIL verdict itself is issued by
 * scripts/verify-s0.mjs from the measured numbers (S0_GATE.json);
 * this suite failing IS the gate failing, not a harness error.
 *
 * Frozen definitions (adjudicated by T007; see artifacts/reports/
 * S0_REPORT.md §2):
 * - Parity field set (PROJECT_BOOK §13.2 + §10.4): verdict, diagnostic
 *   codes + severity + sourceIndex, shortest injection sequence,
 *   final-state fields (message order, tool-call order, sharedState,
 *   pendingToolCallIds, runStatus) on both paths, PLUS — since FIX-R1
 *   (P1-R1-01 item 4) — the final-state hash and the report canonical
 *   hash, compared over ONE shared parity projection. Since FIX-R2
 *   (P1-R2-02, ADR-003) the parity projection is a DIFFERENTIAL
 *   projection of the production projectState: runs carry the full
 *   RunState (outcome/result/error/parentRunId/protocolVersion),
 *   message toolCalls are the verbatim wire objects, and the timeline
 *   carries the DERIVED runId on every item (run events take the event
 *   runId, other items take the current RUNNING run's runId, absent
 *   when no run is open). The two implementations hash the same
 *   projection (parityProjectStateTS here, parity_project_state in
 *   oracle/parity.py — the two constructions must stay in sync).
 *   The only fields the parity form adds to production are the
 *   derived timeline runId and, on paths, runStatus (the production
 *   PathResult has none; parity path = production path + runStatus).
 * - First divergence: the S0 definition is the T004 step comparison
 *   (PROJECT_BOOK §8.6: align by sourceIndex, step through canonical
 *   states, first differing position). FIX-R1 removed the Oracle's
 *   diagnostics-priority branch (earliest resume diagnostic): it
 *   reported the DUPLICATE_TOOL_CALL diagnostic's sourceIndex (2 on
 *   G01) as the first divergence, while the first comparable state
 *   difference is at 4 (TOOL_CALL_END). Both values stay in the
 *   report — the diagnostic keeps sourceIndex 2, firstDivergence
 *   reports 4 — but they are two different values and must never be
 *   mixed. The two implementations now agree on 24/24.
 * - Report hash (frozen by T007): JCS canonical hash (TS
 *   canonicalHash) of the rejoinlab.report/v1 report object with
 *   metrics.durationMs REMOVED (timing varies every run, 5–51 ms
 *   observed on the Oracle side). metrics.visitedStates is retained:
 *   it is a deterministic count. The hash input therefore contains
 *   verdict, diagnostics, firstDivergence sourceIndex, shortest
 *   sequence, fullPath and resumePath — no time, no randomness.
 *   Since FIX-R2 the cross-language report hash (parityReportHash)
 *   is the FULL production report hash input — diagnostics with
 *   message/evidence, firstDivergence in full, input, recovery,
 *   assumptions, limitations, metrics.visitedStates — with both
 *   paths in parity projection (production path + runStatus). No
 *   downgrade, no field is silently excluded (coordinator ruling 2).
 *   The production report hash itself (R-10) is compared directly:
 *   TS buildReportFromAnalysis + reportHash vs Oracle report_hash
 *   over the same raw fixture text.
 * - Legal-recovery convergence: legalBaseline() (correct checkpoint,
 *   no injections) must give fullStateHash === resumeStateHash with
 *   no CRITICAL diagnostic, on all 24 Goldens. G08's legal baseline
 *   is INCOMPLETE_TRACE (the trace itself is truncated) but its two
 *   paths still converge (identical hashes) — convergence is a state
 *   property, not a CONSISTENT verdict.
 *
 * MEASURED RESULT (2026-11-23, FIX-R1): parity 24/24, first-divergence
 * Oracle agreement 24/24, final-state hash parity 24/24, report-hash
 * parity 24/24, classification 24/24, convergence 24/24. G01 was open
 * at the start of FIX-R1 (TS marked BOTH duplicate call-1 entries
 * resulted on the resume path while the Oracle answered only the first
 * entry with no result — a product bug in src/core/lifecycle.ts) and
 * was closed by the coordinator's product fix (planner.ts TOOL_CALL_RESULT
 * branch now answers the first result-less entry by identity, and
 * computePendingToolCallIds groups by logical id). The earlier 23/24 (G05
 * pendingToolCallIds) was fixed before FIX-R1; the G01
 * first-divergence split (TS 4 vs Oracle 2) was fixed by FIX-R1
 * (Oracle diagnostics-priority branch removed, Golden expected 2→4).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalHash, projectState } from "../../src/core/canonical.js";
import type { RejoinState } from "../../src/core/state.js";
import { expandChunks } from "../../src/parser/normalize.js";
import { ParseError, validateEvent } from "../../src/parser/normalize.js";
import { buildReportFromAnalysis, reportHash as productionReportHash, toReportFirstDivergence } from "../../src/report/json.js";
import { SPEC_VERSION } from "../../src/report/schema.js";
import { evaluateFixture, type PathResult } from "../../src/replay/planner.js";
import {
  analyzeFixture,
  legalBaseline,
  searchShortest,
  type ReplayAnalysis,
} from "../../src/replay/search.js";
import { GOLDEN_IDS, loadExpected, loadFixture, toReplayFixture } from "../replay/golden-helpers.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface OracleTrace {
  verdict: string;
  diagnostics: { code: string; severity: string; sourceIndex: number | null }[];
  firstDivergenceSourceIndex: number | null;
  shortestInjectionSequence: string[] | null;
  fullPath: Record<string, unknown> | null;
  resumePath: Record<string, unknown> | null;
  durationMs: number;
  /** FIX-R1 parity projection (P1-R1-01 item 4); null on error returns. */
  parityFullStateHash: string | null;
  parityResumeStateHash: string | null;
  parityReportHash: string | null;
  parityFullPath: Record<string, unknown> | null;
  parityResumePath: Record<string, unknown> | null;
  /** FIX-R2 production report (P1-R2-02): full report hash, full
   * diagnostics, firstDivergence object, visitedStates, bfsVisited. */
  reportHash: string | null;
  diagnosticsFull: Record<string, unknown>[];
  firstDivergence: Record<string, unknown> | null;
  visitedStates: number;
  bfsVisited: number | null;
  legalBaseline: {
    verdict: string;
    diagnostics: string[];
    converged: boolean;
  };
}

interface OracleParityDump {
  traces: Record<string, OracleTrace>;
  inputTraces: Record<string, OracleTrace>;
  parityTraces: Record<string, OracleTrace>;
  /** FIX-R3 (P1-R3-01 / P1-R3-02 / P2-R3-03): 8 fixtures, counted
   * separately as fixR3Parity — never part of the 24 Golden traces. */
  fixR3Traces: Record<string, OracleTrace>;
}

function loadOracle(): OracleParityDump {
  const out = execFileSync(
    "python3",
    [join(ROOT, "scripts", "oracle-parity.py")],
    { cwd: ROOT, encoding: "utf-8", timeout: 120000 },
  );
  return JSON.parse(out) as OracleParityDump;
}

/** TS step-comparison first-divergence expectations (T004 definition). */
const TS_FIRST_DIVERGENCE: Record<string, number | null> = {
  G01: 4, // FIX-R1: Oracle now reports 4 as well (diagnostics-priority branch removed).
  G02: 7,
  G03: 10,
  G04: 3,
  G05: 4,
  G06: 2,
  G07: 2,
  G08: 4,
  N01: null, N02: null, N03: null, N04: null, N05: null, N06: null,
  N07: null, N08: null, N09: null, N10: null, N11: null, N12: null,
  N13: null, N14: null, N15: null, N16: null,
};

function targetFor(id: string, expected: Record<string, { diagnostics: string[] }>): string | null {
  return expected[id]?.diagnostics[0] ?? null;
}

/** Frozen T007 report-hash input: report minus metrics.durationMs. */
export function reportHashInput(analysis: ReplayAnalysis, durationMs: number): Record<string, unknown> {
  const e = analysis.evaluation;
  const { durationMs: _dropped, ...metricsKept } = {
    durationMs,
    visitedStates: e.metrics.visitedStates,
  };
  void _dropped;
  return {
    schema: "rejoinlab.report/v1",
    // FIX-R1 (coordinator follow-up): tracks the product's report
    // version — src/report/schema.ts SPEC_VERSION is "1.0.2" since the
    // v1.0.2 spec revision (FIX-R3, ADR-004), and src/report/json.ts builds
    // real reports with that version (schema validation rejects any
    // other version). The T007 freeze covers the hash DEFINITION (which
    // fields enter, durationMs excluded), not this literal: the hash
    // input must mirror the report the product actually emits, so it
    // follows SPEC_VERSION on every spec bump.
    specVersion: SPEC_VERSION,
    protocolVersion: "1.0",
    scenarioId: e.scenarioId,
    verdict: e.verdict,
    diagnostics: e.diagnostics,
    firstDivergence:
      e.firstDivergence === null
        ? null
        : { sourceIndex: e.firstDivergence.sourceIndex },
    shortestInjectionSequence: analysis.shortestInjectionSequence,
    fullPath: e.fullPath,
    resumePath: e.resumePath,
    metrics: metricsKept,
  };
}

export function reportHash(analysis: ReplayAnalysis, durationMs: number): string {
  return canonicalHash(reportHashInput(analysis, durationMs));
}

// ---------------------------------------------------------------------------
// Cross-language parity projection (FIX-R2, P1-R2-02; ADR-003).
// PROJECT_BOOK §10.4 requires the S0 parity to compare the final state
// hash and the report canonical hash. The parity form is a
// DIFFERENTIAL projection of the production projectState(): the full
// production shape (src/core/canonical.ts projectState, 8 protocol
// fields) plus the derived timeline runId (ADR-003 §3(b)) — never a
// reduced shape. The single translation source is oracle/parity.py
// (parity_project_state); the TS side below (parityProjectStateTS)
// is the identical walk, and this gate proves it (24/24 parity
// hashes equal).
//
// What the projection carries (nothing silently dropped):
//   * runs: all 5 RunState fields — parentRunId, protocolVersion,
//     outcome, result, error — carried verbatim (the Oracle stores
//     them all since FIX-R2; ADR-003 §2).
//   * messages: toolCalls compared as the full verbatim wire objects
//     (the old id-only filter is deleted — ADR-003 "与备忘录的偏差"
//     §2); the toolCalls key appears only for a non-empty list
//     (explicit [] corner: TS keeps [], Oracle drops it, no fixture
//     — ADR-003 §3(d)); content omitted only when undefined (a tool
//     input message without content); "error" kept when present.
//   * toolCalls: status/hasResult/runId carried verbatim (the Oracle
//     derives status from open/incomplete/result with the same
//     precedence: incomplete > resulted > open > closed).
//   * timeline: runId ENTERS the canonical form — run events take the
//     event runId, other items take the current RUNNING run's runId,
//     absent when no run is open (ADR-003 §3(b)); the TOOL_CALL_START
//     messageId is carried when parentMessageId exists (Q2a); text
//     carried verbatim.
//   * sharedState undefined ("no baseline yet") encodes as null,
//     exactly as the Oracle's None does.
// ---------------------------------------------------------------------------

/** Project a RejoinState onto the shared parity form (FIX-R2, §3.6-A).
 * Parity is a DIFFERENTIAL projection of the production projectState:
 * the full production shape (runs carry outcome/result/error/
 * parentRunId/protocolVersion; message toolCalls are the verbatim wire
 * objects) plus the derived timeline runId (ADR-003 §3(b): runId
 * ENTERS the canonical form; run events take the event runId, other
 * items take the current RUNNING run's runId, absent when no run is
 * open). The identical walk lives in oracle/parity.py
 * parity_project_state(); the two must stay in sync, and this gate
 * proves it (24/24 parity hashes equal). projectState() returns a
 * fresh deep copy, so the walk mutates the projection, never the
 * input state. */
export function parityProjectStateTS(state: RejoinState): Record<string, unknown> {
  const projected = projectState(state);
  const timeline = projected.orderedTimeline as Record<string, unknown>[];
  let current: string | undefined;
  for (const item of timeline) {
    if (item.kind === "run") {
      if (item.eventType === "RUN_STARTED") {
        current = item.runId as string;
      } else if (item.eventType === "RUN_FINISHED" || item.eventType === "RUN_ERROR") {
        current = undefined;
      }
      continue;
    }
    if (current !== undefined) item.runId = current;
  }
  return projected;
}

/** SHA-256 of the JCS canonical bytes of the parity projection. */
export function parityStateHashTS(state: RejoinState): string {
  return canonicalHash(parityProjectStateTS(state));
}

/** §13.2 PathResult in parity form (parity hash + parity contents). */
export function parityProjectPathTS(state: RejoinState): Record<string, unknown> {
  const projected = parityProjectStateTS(state);
  return {
    finalStateHash: canonicalHash(projected),
    messages: projected.messages,
    toolCalls: projected.toolCalls,
    sharedState: projected.sharedState,
    pendingToolCallIds: projected.pendingToolCallIds,
    runStatus: projected.runStatus,
  };
}

/**
 * Cross-language report canonical hash input (PROJECT_BOOK §10.4).
 * FIX-R2 (coordinator ruling 2): NO downgrade — this is the FULL
 * production report hash input (TS buildReportFromAnalysis, minus
 * metrics.durationMs) with fullPath/resumePath replaced by the parity
 * paths (production path + runStatus). Diagnostics enter with full
 * message/evidence, firstDivergence in full (A-07 stripped form),
 * input/recovery/assumptions/limitations/metrics.visitedStates all
 * included. Mirrors oracle/parity.py parity_report_hash(); the two
 * must stay in sync, and this gate proves it (24/24 + parity
 * fixtures). The caller supplies the raw fixture text (sourceSha256
 * is the raw-text hash) and the recovery object from toReplayFixture.
 */
export function parityReportHashInputTS(
  analysis: ReplayAnalysis,
  sourceText: string,
  eventCount: number,
  recovery: { strategy: string; disconnectAfter?: number; resumeAfterSourceIndex?: number },
): Record<string, unknown> {
  const e = analysis.evaluation;
  const report = buildReportFromAnalysis(
    analysis,
    0,
    { scenarioId: e.scenarioId, sourceFormat: "JSONL", eventCount, sourceText },
    recovery,
  );
  const { durationMs: _dropped, ...metricsKept } = report.metrics;
  void _dropped;
  return {
    ...report,
    metrics: metricsKept,
    fullPath: e.fullState === null ? null : parityProjectPathTS(e.fullState),
    resumePath: e.resumeState === null ? null : parityProjectPathTS(e.resumeState),
  };
}

/** Cross-language report canonical hash, or null when either path is absent. */
export function parityReportHashTS(
  analysis: ReplayAnalysis,
  sourceText: string,
  eventCount: number,
  recovery: { strategy: string; disconnectAfter?: number; resumeAfterSourceIndex?: number },
): string | null {
  const e = analysis.evaluation;
  if (e.fullState === null || e.resumeState === null) return null;
  return canonicalHash(parityReportHashInputTS(analysis, sourceText, eventCount, recovery));
}

/** Production report hash input (R-10): the report exactly as the
 * product emits it, minus metrics.durationMs. Used to compare the TS
 * production reportHash against the Oracle's full report hash. */
export function productionReportHashInputTS(
  analysis: ReplayAnalysis,
  sourceText: string,
  eventCount: number,
  recovery: { strategy: string; disconnectAfter?: number; resumeAfterSourceIndex?: number },
): Record<string, unknown> {
  const e = analysis.evaluation;
  const report = buildReportFromAnalysis(
    analysis,
    0,
    { scenarioId: e.scenarioId, sourceFormat: "JSONL", eventCount, sourceText },
    recovery,
  );
  const { durationMs: _dropped, ...metricsKept } = report.metrics;
  void _dropped;
  return { ...report, metrics: metricsKept };
}

function pathFields(path: PathResult | null) {
  if (path === null) return null;
  return {
    messageOrder: path.messages.map((m) => m.id),
    toolCallOrder: path.toolCalls.map((t) => t.id),
    sharedState: path.sharedState === undefined ? null : path.sharedState,
    pendingToolCallIds: [...path.pendingToolCallIds],
    runStatus: path.runStatus,
  };
}

/** Report-form diagnostic (mirrors src/report/json.ts
 * toReportDiagnostic, which is module-private: code/severity, then
 * sourceIndex / relatedSourceIndices only when defined, message
 * verbatim, evidence via a JSON round trip — the same undefined-drop
 * as toJsonValue for these JSON-safe values). */
function reportDiagnosticTS(d: {
  code: string;
  severity: string;
  sourceIndex?: number;
  relatedSourceIndices?: number[];
  message: string;
  evidence: unknown;
}): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    code: d.code,
    severity: d.severity,
  };
  if (d.sourceIndex !== undefined) entry.sourceIndex = d.sourceIndex;
  if (d.relatedSourceIndices !== undefined) {
    entry.relatedSourceIndices = [...d.relatedSourceIndices];
  }
  entry.message = d.message;
  entry.evidence = JSON.parse(JSON.stringify(d.evidence ?? {})) as Record<string, unknown>;
  return entry;
}

/** Order-insensitive deep equality via key-sorted canonical JSON. */
function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canon((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

const JSON_EQUAL = (a: unknown, b: unknown): boolean =>
  JSON.stringify(canon(a)) === JSON.stringify(canon(b));

describe("S0 gate — three-way parity (TS vs Oracle vs hand-derived expected)", () => {
  const { traces: oracle, inputTraces: oracleInput } = loadOracle();
  const expected = loadExpected();
  const rows: Record<string, Record<string, unknown>> = {};
  let maxBfsVisited = 0;

  for (const id of GOLDEN_IDS) {
    it(`${id} verdict + diagnostics + shortest + final states (3-way)`, () => {
      const target = targetFor(id, expected);
      const fixture = loadFixture(id);
      const analysis = analyzeFixture(fixture, target);
      const ev = analysis.evaluation;
      const orc = oracle[id] as OracleTrace;
      const exp = expected[id] as unknown as {
        verdict: string;
        diagnostics: string[];
        shortestInjectionSequence: string[];
        firstDivergenceSourceIndex: number | null;
        finalState: {
          full: { messageOrder: string[]; toolCallOrder: string[]; sharedState: unknown; pendingToolCallIds: string[]; runStatus: string };
          resume: { messageOrder: string[]; toolCallOrder: string[]; sharedState: unknown; pendingToolCallIds: string[]; runStatus: string };
        };
      };

      const tsDiags = ev.diagnostics.map((d) => ({
        code: d.code,
        severity: d.severity,
        sourceIndex: d.sourceIndex ?? null,
      }));
      const tsFull = pathFields(ev.fullPath);
      const tsResume = pathFields(ev.resumePath);
      const { finalStateHash: _of, ...orcFull } = orc.fullPath as Record<string, unknown>;
      const { finalStateHash: _or, ...orcResume } = orc.resumePath as Record<string, unknown>;
      void _of;
      void _or;
      const tsFirstDiv = ev.firstDivergence?.sourceIndex ?? null;

      // FIX-R1 parity hashes (§10.4): both paths projected onto the
      // shared parity form, then hashed with the same JCS primitive.
      const tsParityFullHash =
        ev.fullState === null ? null : parityStateHashTS(ev.fullState);
      const tsParityResumeHash =
        ev.resumeState === null ? null : parityStateHashTS(ev.resumeState);
      // FIX-R2: the report hashes need the raw fixture text
      // (sourceSha256 is the raw-text hash) and the recovery object.
      const sourceText = readFileSync(join(ROOT, "fixtures", "golden", `${id}.json`), "utf-8");
      const eventCount = fixture.events.length;
      const tsParityReportHash = parityReportHashTS(analysis, sourceText, eventCount, fixture.recovery);
      const tsProductionReportHash = canonicalHash(productionReportHashInputTS(analysis, sourceText, eventCount, fixture.recovery));
      const tsParityFullPath =
        ev.fullState === null ? null : parityProjectPathTS(ev.fullState);
      const tsParityResumePath =
        ev.resumeState === null ? null : parityProjectPathTS(ev.resumeState);

      // Legal-baseline convergence (TS side).
      const baselineEval = evaluateFixture(legalBaseline(loadFixture(id)));
      const baseConverged =
        baselineEval.fullPath !== null &&
        baselineEval.resumePath !== null &&
        baselineEval.fullPath.finalStateHash === baselineEval.resumePath.finalStateHash &&
        !baselineEval.diagnostics.some((d) => d.severity === "CRITICAL");

      // Field-level booleans (stored before asserting, so the row
      // survives a failing expect and the summary can count it).
      const checks = {
        verdict: ev.verdict === exp.verdict && ev.verdict === orc.verdict,
        diagnostics: JSON_EQUAL(ev.diagnostics.map((d) => d.code), exp.diagnostics) && JSON_EQUAL(tsDiags, orc.diagnostics),
        shortest: JSON_EQUAL(analysis.shortestInjectionSequence, exp.shortestInjectionSequence) && JSON_EQUAL(analysis.shortestInjectionSequence, orc.shortestInjectionSequence),
        fullState: JSON_EQUAL(tsFull, {
          messageOrder: exp.finalState.full.messageOrder,
          toolCallOrder: exp.finalState.full.toolCallOrder,
          sharedState: exp.finalState.full.sharedState,
          pendingToolCallIds: exp.finalState.full.pendingToolCallIds,
          runStatus: exp.finalState.full.runStatus,
        }) && JSON_EQUAL(tsFull, orcFull),
        resumeState: JSON_EQUAL(tsResume, {
          messageOrder: exp.finalState.resume.messageOrder,
          toolCallOrder: exp.finalState.resume.toolCallOrder,
          sharedState: exp.finalState.resume.sharedState,
          pendingToolCallIds: exp.finalState.resume.pendingToolCallIds,
          runStatus: exp.finalState.resume.runStatus,
        }) && JSON_EQUAL(tsResume, orcResume),
        firstDivergenceTsDefinition: tsFirstDiv === TS_FIRST_DIVERGENCE[id],
        firstDivergenceMatchesOracle: tsFirstDiv === orc.firstDivergenceSourceIndex,
        // FIX-R1 (§10.4): final-state hash parity (both paths) and
        // report canonical-hash parity over the shared projection.
        // A null on either side is a miss, never a pass.
        finalStateHashParity:
          tsParityFullHash !== null &&
          tsParityFullHash === orc.parityFullStateHash &&
          tsParityResumeHash !== null &&
          tsParityResumeHash === orc.parityResumeStateHash,
        parityPathsEqual:
          tsParityFullPath !== null &&
          JSON_EQUAL(tsParityFullPath, orc.parityFullPath) &&
          tsParityResumePath !== null &&
          JSON_EQUAL(tsParityResumePath, orc.parityResumePath),
        reportHashParity:
          tsParityReportHash !== null &&
          tsParityReportHash === orc.parityReportHash,
        // FIX-R2 (R-10): the production report hash — full byte-for-
        // byte reproduction, diagnostics with message/evidence,
        // firstDivergence in full, input/recovery/assumptions/
        // limitations included.
        productionReportHashParity:
          tsProductionReportHash === orc.reportHash,
        // FIX-R2 (R-07/R-08/R-09): full diagnostics byte-for-byte,
        // firstDivergence object, visitedStates, bfsVisited.
        diagnosticsFullParity: JSON_EQUAL(
          ev.diagnostics.map(reportDiagnosticTS),
          orc.diagnosticsFull,
        ),
        firstDivergenceObjectParity: JSON_EQUAL(
          ev.firstDivergence === null
            ? null
            : toReportFirstDivergence(ev.firstDivergence),
          orc.firstDivergence,
        ),
        visitedStatesParity:
          ev.metrics.visitedStates === orc.visitedStates,
        bfsVisitedParity: analysis.bfsVisited === orc.bfsVisited,
        bfsWithinBudget: !analysis.bfsLimitExceeded && analysis.bfsVisited <= 5000,
        legalBaselineConverged: baseConverged === true && baseConverged === orc.legalBaseline.converged,
      };
      const parityOk =
        checks.verdict && checks.diagnostics && checks.shortest &&
        checks.fullState && checks.resumeState && checks.bfsWithinBudget &&
        checks.finalStateHashParity && checks.parityPathsEqual &&
        checks.reportHashParity && checks.productionReportHashParity &&
        checks.diagnosticsFullParity && checks.firstDivergenceObjectParity &&
        checks.visitedStatesParity && checks.bfsVisitedParity;
      maxBfsVisited = Math.max(maxBfsVisited, analysis.bfsVisited);

      rows[id] = {
        parityOk,
        checks,
        tsVerdict: ev.verdict,
        oracleVerdict: orc.verdict,
        expectedVerdict: exp.verdict,
        tsDiagnostics: tsDiags,
        oracleDiagnostics: orc.diagnostics,
        expectedDiagnostics: exp.diagnostics,
        tsFirstDivergence: tsFirstDiv,
        oracleFirstDivergence: orc.firstDivergenceSourceIndex,
        expectedFirstDivergence: exp.firstDivergenceSourceIndex,
        tsParityFullStateHash: tsParityFullHash,
        oracleParityFullStateHash: orc.parityFullStateHash,
        tsParityResumeStateHash: tsParityResumeHash,
        oracleParityResumeStateHash: orc.parityResumeStateHash,
        tsParityReportHash,
        oracleParityReportHash: orc.parityReportHash,
        tsProductionReportHash,
        oracleProductionReportHash: orc.reportHash,
        tsDiagnosticsFull: ev.diagnostics.map(reportDiagnosticTS),
        oracleDiagnosticsFull: orc.diagnosticsFull,
        tsFirstDivergenceObject:
          ev.firstDivergence === null
            ? null
            : toReportFirstDivergence(ev.firstDivergence),
        oracleFirstDivergenceObject: orc.firstDivergence,
        tsVisitedStates: ev.metrics.visitedStates,
        oracleVisitedStates: orc.visitedStates,
        tsBfsVisited: analysis.bfsVisited,
        oracleBfsVisited: orc.bfsVisited,
        tsShortest: analysis.shortestInjectionSequence,
        oracleShortest: orc.shortestInjectionSequence,
        expectedShortest: exp.shortestInjectionSequence,
        tsFullState: tsFull,
        oracleFullState: orcFull,
        expectedFullState: exp.finalState.full,
        tsResumeState: tsResume,
        oracleResumeState: orcResume,
        expectedResumeState: exp.finalState.resume,
        bfsVisited: analysis.bfsVisited,
        legalBaselineConverged: baseConverged,
        oracleLegalBaselineConverged: orc.legalBaseline.converged,
        oracleDurationMs: orc.durationMs,
      };

      // Hard asserts: a parity miss fails this test (and the gate).
      expect(ev.verdict).toBe(exp.verdict);
      expect(ev.verdict).toBe(orc.verdict);
      expect(ev.diagnostics.map((d) => d.code)).toEqual(exp.diagnostics);
      expect(tsDiags).toEqual(orc.diagnostics);
      expect(analysis.shortestInjectionSequence).toEqual(exp.shortestInjectionSequence);
      expect(analysis.shortestInjectionSequence).toEqual(orc.shortestInjectionSequence);
      expect(analysis.bfsLimitExceeded).toBe(false);
      expect(analysis.bfsVisited).toBeLessThanOrEqual(5000);
      expect(tsFull).toEqual({
        messageOrder: exp.finalState.full.messageOrder,
        toolCallOrder: exp.finalState.full.toolCallOrder,
        sharedState: exp.finalState.full.sharedState,
        pendingToolCallIds: exp.finalState.full.pendingToolCallIds,
        runStatus: exp.finalState.full.runStatus,
      });
      expect(tsResume).toEqual({
        messageOrder: exp.finalState.resume.messageOrder,
        toolCallOrder: exp.finalState.resume.toolCallOrder,
        sharedState: exp.finalState.resume.sharedState,
        pendingToolCallIds: exp.finalState.resume.pendingToolCallIds,
        runStatus: exp.finalState.resume.runStatus,
      });
      expect(tsFull).toEqual(orcFull);
      expect(tsResume).toEqual(orcResume);
      expect(tsFirstDiv).toBe(TS_FIRST_DIVERGENCE[id]);
      // FIX-R1 (§10.4): the shared-projection hashes must agree
      // exactly — a null on either side fails here, never passes.
      expect(tsParityFullHash).not.toBeNull();
      expect(tsParityFullHash).toBe(orc.parityFullStateHash);
      expect(tsParityResumeHash).not.toBeNull();
      expect(tsParityResumeHash).toBe(orc.parityResumeStateHash);
      expect(tsParityFullPath).toEqual(orc.parityFullPath);
      expect(tsParityResumePath).toEqual(orc.parityResumePath);
      expect(tsParityReportHash).not.toBeNull();
      expect(tsParityReportHash).toBe(orc.parityReportHash);
      // FIX-R2 (R-10): the production report hash — full byte-for-
      // byte reproduction, no field excluded.
      expect(tsProductionReportHash).toBe(orc.reportHash);
      // FIX-R2 (R-07/R-08/R-09): full diagnostics, firstDivergence
      // object, visitedStates, bfsVisited.
      expect(ev.diagnostics.map(reportDiagnosticTS)).toEqual(orc.diagnosticsFull);
      expect(
        ev.firstDivergence === null
          ? null
          : toReportFirstDivergence(ev.firstDivergence),
      ).toEqual(orc.firstDivergence);
      expect(ev.metrics.visitedStates).toBe(orc.visitedStates);
      expect(analysis.bfsVisited).toBe(orc.bfsVisited);
      expect(baseConverged).toBe(true);
      expect(baseConverged).toBe(orc.legalBaseline.converged);
    });
  }

  it("gate summary — counts written to artifacts/reports/S0_PARITY.json", () => {
    const ids = Object.keys(rows);
    const parityPass = ids.filter((id) => (rows[id] as { parityOk: boolean }).parityOk).length;
    const firstDivOracleMatches = ids.filter(
      (id) => (rows[id] as { checks: { firstDivergenceMatchesOracle: boolean } }).checks.firstDivergenceMatchesOracle,
    ).length;
    const finalStateHashMatches = ids.filter(
      (id) => (rows[id] as { checks: { finalStateHashParity: boolean } }).checks.finalStateHashParity,
    ).length;
    const reportHashMatches = ids.filter(
      (id) => (rows[id] as { checks: { reportHashParity: boolean } }).checks.reportHashParity,
    ).length;
    const productionReportHashMatches = ids.filter(
      (id) => (rows[id] as { checks: { productionReportHashParity: boolean } }).checks.productionReportHashParity,
    ).length;
    const converged = ids.filter(
      (id) => (rows[id] as { checks: { legalBaselineConverged: boolean } }).checks.legalBaselineConverged,
    ).length;
    const parityFailures = ids.filter((id) => !(rows[id] as { parityOk: boolean }).parityOk);
    const out = {
      schema: "rejoinlab.s0-parity/v1",
      // Spec version under test (same FIX-R1 decision as reportHashInput
      // above: follows src/report/schema.ts SPEC_VERSION, now "1.0.2").
      specVersion: SPEC_VERSION,
      generatedAtUtc: new Date().toISOString(),
      definitions: {
        parityFields: ["verdict", "diagnostic code+severity+sourceIndex", "shortestInjectionSequence", "final-state fields (messageOrder, toolCallOrder, sharedState, pendingToolCallIds, runStatus) x full/resume", "final-state hash (shared parity projection) x full/resume", "report canonical hash (shared parity projection)", "production report canonical hash (full, R-10)", "diagnostics with message/evidence byte-for-byte (R-07)", "firstDivergence object (R-06)", "visitedStates (R-08)", "bfsVisited (R-09)"],
        parityProjection: "FIX-R2 (§3.6-A, ADR-003): the parity projection is a differential projection of the production projectState — full runs (outcome/result/error/parentRunId/protocolVersion), verbatim message toolCalls, plus the derived timeline runId (run events take the event runId, other items take the current RUNNING run's runId, absent when no run is open); parity path = production path + runStatus",
        firstDivergenceDefinition: "T004 step comparison (PROJECT_BOOK §8.6): align by sourceIndex, step through canonical states from the checkpoint, first differing position — diagnostic sourceIndex (e.g. G01 DUPLICATE_TOOL_CALL at 2) is a different value and is NOT the first divergence (4)",
        reportHashDefinition: "JCS canonicalHash of the rejoinlab.report/v1 report with metrics.durationMs removed; metrics.visitedStates retained",
        parityReportHashDefinition: "FIX-R2: JCS canonicalHash of the FULL production report hash input (diagnostics with message/evidence, firstDivergence in full, input, recovery, assumptions, limitations, metrics.visitedStates) with both paths in parity projection (production path + runStatus)",
        productionReportHashDefinition: "FIX-R2 (R-10): JCS canonicalHash of the production report exactly as the product emits it (buildReportFromAnalysis + reportHash), minus metrics.durationMs — no field excluded",
        convergenceDefinition: "legalBaseline() (correct checkpoint, no injections): fullStateHash === resumeStateHash and no CRITICAL diagnostic",
      },
      summary: {
        parityPass,
        parityTotal: 24,
        parityFailures,
        firstDivergenceOracleMatches: firstDivOracleMatches,
        firstDivergenceOracleTotal: 24,
        firstDivergenceKnownDivergence: [],
        finalStateHashMatches,
        finalStateHashTotal: 24,
        reportHashMatches,
        reportHashTotal: 24,
        productionReportHashMatches,
        productionReportHashTotal: 24,
        legalBaselineConverged: converged,
        legalBaselineTotal: 24,
        maxBfsVisited,
        bfsNodeLimit: 5000,
      },
      traces: rows,
    };
    const dir = join(ROOT, "artifacts", "reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "S0_PARITY.json"), `${JSON.stringify(out, null, 2)}\n`, "utf-8");
    // Threshold asserts (fail the gate when the measured numbers miss).
    expect(ids.length).toBe(24);
    expect(parityPass).toBe(24);
    expect(firstDivOracleMatches).toBe(24);
    expect(rows["G01"]?.["tsFirstDivergence"]).toBe(4);
    expect(rows["G01"]?.["oracleFirstDivergence"]).toBe(4);
    expect(finalStateHashMatches).toBe(24);
    expect(reportHashMatches).toBe(24);
    expect(productionReportHashMatches).toBe(24);
    expect(converged).toBe(24);
    expect(maxBfsVisited).toBeLessThanOrEqual(5000);
  });
});

describe("S0 gate — RUN_STARTED.input parity (FIX-R1, P1-R1-02)", () => {
  const { inputTraces: oracleInput } = loadOracle();
  // Same order as scripts/oracle-parity.py (sorted fixture stems).
  const INPUT_IDS = [
    "input_empty",
    "input_illegal_bad_role",
    "input_illegal_message_no_id",
    "input_illegal_messages_missing",
    "input_illegal_messages_not_array",
    "input_illegal_not_object",
    "input_messages",
    "input_no_input",
    "input_replay_no_reseed",
    "input_run_mismatch",
    "input_stale_state",
    "input_state",
    "input_thread_mismatch",
    "input_tool_no_content",
    "input_tool_result",
  ] as const;

  function loadInputFixture(id: string) {
    const rawText = readFileSync(join(ROOT, "oracle", "tests", "fixtures", `${id}.json`), "utf-8");
    const raw = JSON.parse(rawText) as { events: { event: unknown }[] };
    return { raw, rawText, fixture: toReplayFixture(raw as never) };
  }

  for (const id of INPUT_IDS) {
    it(`${id} TS vs Oracle on the same input fixture`, () => {
      const orc = oracleInput[id] as OracleTrace;
      expect(orc).toBeDefined();
      const { raw, rawText, fixture } = loadInputFixture(id);

      // Comparison contract for the 15 input fixtures (FIX-R2, P1-R2-01).
      // Every fixture is compared under exactly one of two definitions;
      // no fixture is exempted from parity:
      // - LEGAL (9): input_empty, input_messages, input_no_input,
      //   input_replay_no_reseed, input_run_mismatch, input_stale_state,
      //   input_state, input_thread_mismatch, input_tool_result — full
      //   fold comparison below (verdict, diagnostics, first divergence,
      //   shortest injection sequence, parity full/resume state hashes,
      //   parity report hash, parity full/resume paths).
      // - ILLEGAL SHAPE (6): the 5 input_illegal_* fixtures plus
      //   input_tool_no_content — validation-layer comparison only.
      //   analyzeFixture bypasses parser validation, so a fold
      //   comparison would be meaningless here. Both validators must
      //   reject with INVALID_INPUT and neither side produces a final
      //   state (all parity hashes/paths null, no first divergence,
      //   no shortest sequence).
      if (id.startsWith("input_illegal_") || id === "input_tool_no_content") {
        expect(orc.verdict).toBe("INVALID_INPUT");
        expect(orc.diagnostics).toEqual([
          { code: "INVALID_INPUT", severity: "CRITICAL", sourceIndex: null },
        ]);
        expect(orc.firstDivergenceSourceIndex).toBeNull();
        expect(orc.shortestInjectionSequence).toBeNull();
        expect(orc.parityFullStateHash).toBeNull();
        expect(orc.parityResumeStateHash).toBeNull();
        expect(orc.parityReportHash).toBeNull();
        expect(orc.parityFullPath).toBeNull();
        expect(orc.parityResumePath).toBeNull();
        // The illegal shape may sit in any RUN_STARTED.input, not
        // necessarily events[0] (input_tool_no_content carries it in
        // events[7]). Validate every event; exactly one must throw
        // ParseError INVALID_INPUT.
        let thrown: unknown;
        let threwCount = 0;
        for (let k = 0; k < raw.events.length; k += 1) {
          try {
            validateEvent(raw.events[k]?.event, k);
          } catch (e) {
            threwCount += 1;
            thrown = e;
          }
        }
        expect(threwCount).toBe(1);
        expect(thrown).toBeInstanceOf(ParseError);
        expect((thrown as ParseError).code).toBe("INVALID_INPUT");
        return;
      }

      const analysis = analyzeFixture(fixture, null);
      const ev = analysis.evaluation;
      const tsDiags = ev.diagnostics.map((d) => ({
        code: d.code,
        severity: d.severity,
        sourceIndex: d.sourceIndex ?? null,
      }));
      const tsFirstDiv = ev.firstDivergence?.sourceIndex ?? null;
      const tsParityFullHash =
        ev.fullState === null ? null : parityStateHashTS(ev.fullState);
      const tsParityResumeHash =
        ev.resumeState === null ? null : parityStateHashTS(ev.resumeState);
      // FIX-R2: the report hashes need the raw fixture text
      // (sourceSha256 is the raw-text hash) and the recovery object.
      const tsParityReportHash = parityReportHashTS(
        analysis, rawText, raw.events.length, fixture.recovery,
      );
      const tsProductionReportHash = canonicalHash(
        productionReportHashInputTS(
          analysis, rawText, raw.events.length, fixture.recovery,
        ),
      );

      expect(ev.verdict).toBe(orc.verdict);
      expect(tsDiags).toEqual(orc.diagnostics);
      expect(tsFirstDiv).toBe(orc.firstDivergenceSourceIndex);
      expect(analysis.shortestInjectionSequence).toEqual(orc.shortestInjectionSequence);
      expect(tsParityFullHash).not.toBeNull();
      expect(tsParityFullHash).toBe(orc.parityFullStateHash);
      expect(tsParityResumeHash).not.toBeNull();
      expect(tsParityResumeHash).toBe(orc.parityResumeStateHash);
      expect(tsParityReportHash).not.toBeNull();
      expect(tsParityReportHash).toBe(orc.parityReportHash);
      // FIX-R2 (R-10/R-07/R-08/R-09): production report hash, full
      // diagnostics, firstDivergence object, visitedStates, bfsVisited.
      expect(tsProductionReportHash).toBe(orc.reportHash);
      expect(ev.diagnostics.map(reportDiagnosticTS)).toEqual(orc.diagnosticsFull);
      expect(
        ev.firstDivergence === null
          ? null
          : toReportFirstDivergence(ev.firstDivergence),
      ).toEqual(orc.firstDivergence);
      expect(ev.metrics.visitedStates).toBe(orc.visitedStates);
      expect(analysis.bfsVisited).toBe(orc.bfsVisited);
      if (ev.fullState !== null) {
        expect(parityProjectPathTS(ev.fullState)).toEqual(orc.parityFullPath);
      }
      if (ev.resumeState !== null) {
        expect(parityProjectPathTS(ev.resumeState)).toEqual(orc.parityResumePath);
      }
    });
  }
});

describe("S0 gate — FIX-R2 parity fixtures (P1-R2-02)", () => {
  const { parityTraces: oracleParity } = loadOracle();
  // Same order as scripts/oracle-parity.py (sorted fixture stems).
  const PARITY_IDS = [
    "parity_error_code",
    "parity_outcome",
    "parity_parent_run",
    "parity_protocol_version",
    "parity_result",
    "parity_result_null",
  ] as const;

  function loadParityFixture(id: string) {
    const rawText = readFileSync(join(ROOT, "oracle", "tests", "fixtures", `${id}.json`), "utf-8");
    const raw = JSON.parse(rawText) as { events: { event: unknown }[] };
    return { raw, rawText, fixture: toReplayFixture(raw as never) };
  }

  for (const id of PARITY_IDS) {
    it(`${id} TS vs Oracle — full RunState parity`, () => {
      const orc = oracleParity[id] as OracleTrace;
      expect(orc).toBeDefined();
      const { raw, rawText, fixture } = loadParityFixture(id);
      const analysis = analyzeFixture(fixture, null);
      const ev = analysis.evaluation;
      const tsDiags = ev.diagnostics.map((d) => ({
        code: d.code,
        severity: d.severity,
        sourceIndex: d.sourceIndex ?? null,
      }));
      const tsParityFullHash =
        ev.fullState === null ? null : parityStateHashTS(ev.fullState);
      const tsParityResumeHash =
        ev.resumeState === null ? null : parityStateHashTS(ev.resumeState);
      const tsParityReportHash = parityReportHashTS(
        analysis, rawText, raw.events.length, fixture.recovery,
      );
      const tsProductionReportHash = canonicalHash(
        productionReportHashInputTS(
          analysis, rawText, raw.events.length, fixture.recovery,
        ),
      );

      // All six fixtures are legal, CONSISTENT, no diagnostics, no
      // first divergence; the shortest fault sequence is DROP_EVENT.
      expect(ev.verdict).toBe("CONSISTENT");
      expect(ev.verdict).toBe(orc.verdict);
      expect(ev.diagnostics).toEqual([]);
      expect(tsDiags).toEqual(orc.diagnostics);
      expect(ev.firstDivergence).toBeNull();
      expect(orc.firstDivergence).toBeNull();
      expect(orc.firstDivergenceSourceIndex).toBeNull();
      expect(analysis.shortestInjectionSequence).toEqual(["DROP_EVENT"]);
      expect(analysis.shortestInjectionSequence).toEqual(orc.shortestInjectionSequence);
      expect(tsParityFullHash).not.toBeNull();
      expect(tsParityFullHash).toBe(orc.parityFullStateHash);
      expect(tsParityResumeHash).not.toBeNull();
      expect(tsParityResumeHash).toBe(orc.parityResumeStateHash);
      expect(tsParityReportHash).not.toBeNull();
      expect(tsParityReportHash).toBe(orc.parityReportHash);
      expect(tsProductionReportHash).toBe(orc.reportHash);
      expect(ev.diagnostics.map(reportDiagnosticTS)).toEqual(orc.diagnosticsFull);
      expect(ev.metrics.visitedStates).toBe(orc.visitedStates);
      expect(analysis.bfsVisited).toBe(orc.bfsVisited);
      if (ev.fullState !== null) {
        expect(parityProjectPathTS(ev.fullState)).toEqual(orc.parityFullPath);
      }
      if (ev.resumeState !== null) {
        expect(parityProjectPathTS(ev.resumeState)).toEqual(orc.parityResumePath);
      }
      // The five RunState fields are actually present in the parity
      // projection — this guards against a both-sides-missing false
      // positive (hash equality alone would not catch it).
      const fullParity = parityProjectStateTS(ev.fullState as never) as {
        runs: Record<string, unknown>[];
      };
      if (id === "parity_result") {
        expect(fullParity.runs[0]).toEqual(
          expect.objectContaining({ result: { summary: "ok" } }),
        );
      }
      if (id === "parity_result_null") {
        expect(fullParity.runs[0]).toEqual(
          expect.objectContaining({ result: null }),
        );
        expect("result" in fullParity.runs[0]).toBe(true);
      }
      if (id === "parity_parent_run") {
        expect(fullParity.runs[1]).toEqual(
          expect.objectContaining({ parentRunId: "run-p" }),
        );
      }
      if (id === "parity_protocol_version") {
        expect(fullParity.runs[0]).toEqual(
          expect.objectContaining({ protocolVersion: "1.1" }),
        );
      }
      if (id === "parity_outcome") {
        expect(fullParity.runs[0]).toEqual(
          expect.objectContaining({
            outcome: { type: "success", pendingToolCallIds: [] },
          }),
        );
        expect(fullParity.runs[1]).toEqual(
          expect.objectContaining({ outcome: { type: "cancelled" } }),
        );
      }
      if (id === "parity_error_code") {
        expect(fullParity.runs[0]).toEqual(
          expect.objectContaining({
            error: { message: "downstream failed", code: "UPSTREAM_500" },
          }),
        );
      }
    });
  }
});

describe("S0 gate — FIX-R2 protection test (R-11, memo §3.6-A)", () => {
  const expected = loadExpected();
  it("parity run key set covers the production run key set (all Goldens)", () => {
    for (const id of GOLDEN_IDS) {
      const fixture = loadFixture(id);
      const analysis = analyzeFixture(fixture, targetFor(id, expected));
      const ev = analysis.evaluation;
      for (const state of [ev.fullState, ev.resumeState]) {
        if (state === null) continue;
        const production = projectState(state) as {
          runs: Record<string, unknown>[];
        };
        const parity = parityProjectStateTS(state) as {
          runs: Record<string, unknown>[];
        };
        expect(parity.runs.length).toBe(production.runs.length);
        production.runs.forEach((run, i) => {
          for (const key of Object.keys(run)) {
            expect(parity.runs[i]).toHaveProperty(key);
          }
        });
      }
    }
  });
});

describe("S0 gate — FIX-R2 expandChunks boundary (memo §6.3-(A))", () => {
  type Triple = { type: string; messageId?: string; toolCallId?: string };
  function oracleExpand(events: unknown[]): { expanded: Triple[]; count: number } {
    const out = execFileSync(
      "python3",
      [join(ROOT, "scripts", "oracle-expand-chunks.py")],
      { cwd: ROOT, encoding: "utf-8", input: JSON.stringify(events), timeout: 60000 },
    );
    return JSON.parse(out) as { expanded: Triple[]; count: number };
  }
  function triples(
    expanded: readonly { event: { type: string; messageId?: string; toolCallId?: string } }[],
  ): Triple[] {
    return expanded.map((w) => {
      const e = w.event;
      const t: Triple = { type: e.type };
      if (e.messageId !== undefined) t.messageId = e.messageId;
      if (e.toolCallId !== undefined) t.toolCallId = e.toolCallId;
      return t;
    });
  }
  function wrap(events: Record<string, unknown>[]) {
    return events.map((event, i) => ({
      sourceIndex: i,
      sourceEventKey: null,
      transportEventId: null,
      event,
    }));
  }
  // sourceIndex is deliberately NOT compared: TS re-indexes the
  // expansion 0..n in emission order while the Oracle keeps the
  // original indices (ADR-003 known corner); the expanded event
  // sequence is what the fold consumes.
  const cases: { name: string; events: Record<string, unknown>[]; expected: Triple[] }[] = [
    {
      name: "interleaved lanes stay independent",
      events: [
        { type: "TEXT_MESSAGE_CHUNK", messageId: "msg-1", delta: "a" },
        { type: "TOOL_CALL_CHUNK", toolCallId: "call-1", toolCallName: "search", parentMessageId: "msg-1", delta: "{}" },
        { type: "TEXT_MESSAGE_CHUNK", messageId: "msg-1", delta: "b" },
        { type: "TEXT_MESSAGE_END", messageId: "msg-1" },
      ],
      // The explicit TEXT_MESSAGE_END first closes the open chunk
      // item (synthetic END) and is then pushed itself — both ENDs
      // appear, in that order; the tool lane is untouched by it.
      expected: [
        { type: "TEXT_MESSAGE_START", messageId: "msg-1" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1" },
        { type: "TOOL_CALL_START", toolCallId: "call-1" },
        { type: "TOOL_CALL_ARGS", toolCallId: "call-1" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1" },
        { type: "TEXT_MESSAGE_END", messageId: "msg-1" },
        { type: "TEXT_MESSAGE_END", messageId: "msg-1" },
        { type: "TOOL_CALL_END", toolCallId: "call-1" },
      ],
    },
    {
      name: "id switch mid-chunk closes the previous item",
      events: [
        { type: "TEXT_MESSAGE_CHUNK", messageId: "msg-1", delta: "a" },
        { type: "TEXT_MESSAGE_CHUNK", messageId: "msg-2", delta: "b" },
      ],
      expected: [
        { type: "TEXT_MESSAGE_START", messageId: "msg-1" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1" },
        { type: "TEXT_MESSAGE_END", messageId: "msg-1" },
        { type: "TEXT_MESSAGE_START", messageId: "msg-2" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "msg-2" },
        { type: "TEXT_MESSAGE_END", messageId: "msg-2" },
      ],
    },
    {
      name: "explicit TEXT event does not close the tool lane",
      events: [
        { type: "TOOL_CALL_CHUNK", toolCallId: "call-1", toolCallName: "search", parentMessageId: "msg-1", delta: "{}" },
        { type: "TEXT_MESSAGE_START", messageId: "msg-1" },
      ],
      // An explicit START opens no chunk lane, so the stream end
      // closes only the chunk-opened tool item; no TEXT_END is
      // synthesised for the explicit START.
      expected: [
        { type: "TOOL_CALL_START", toolCallId: "call-1" },
        { type: "TOOL_CALL_ARGS", toolCallId: "call-1" },
        { type: "TEXT_MESSAGE_START", messageId: "msg-1" },
        { type: "TOOL_CALL_END", toolCallId: "call-1" },
      ],
    },
    {
      name: "explicit TOOL event does not close the text lane",
      events: [
        { type: "TEXT_MESSAGE_CHUNK", messageId: "msg-1", delta: "a" },
        { type: "TOOL_CALL_START", toolCallId: "call-1", toolCallName: "search", parentMessageId: "msg-1" },
      ],
      // Symmetric: the explicit TOOL_CALL_START opens no lane, so
      // the stream end closes only the chunk-opened text item.
      expected: [
        { type: "TEXT_MESSAGE_START", messageId: "msg-1" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1" },
        { type: "TOOL_CALL_START", toolCallId: "call-1" },
        { type: "TEXT_MESSAGE_END", messageId: "msg-1" },
      ],
    },
    {
      name: "STATE_SNAPSHOT closes neither lane",
      events: [
        { type: "TEXT_MESSAGE_CHUNK", messageId: "msg-1", delta: "a" },
        { type: "TOOL_CALL_CHUNK", toolCallId: "call-1", toolCallName: "search", parentMessageId: "msg-1", delta: "{}" },
        { type: "STATE_SNAPSHOT", state: { k: 1 } },
      ],
      expected: [
        { type: "TEXT_MESSAGE_START", messageId: "msg-1" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1" },
        { type: "TOOL_CALL_START", toolCallId: "call-1" },
        { type: "TOOL_CALL_ARGS", toolCallId: "call-1" },
        { type: "STATE_SNAPSHOT" },
        { type: "TEXT_MESSAGE_END", messageId: "msg-1" },
        { type: "TOOL_CALL_END", toolCallId: "call-1" },
      ],
    },
    {
      name: "metadata-only trailing chunk emits no new event",
      events: [
        { type: "TEXT_MESSAGE_CHUNK", messageId: "msg-1", delta: "a" },
        { type: "TEXT_MESSAGE_CHUNK", messageId: "msg-1", metadata: { trace: "x" } },
      ],
      expected: [
        { type: "TEXT_MESSAGE_START", messageId: "msg-1" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1" },
        { type: "TEXT_MESSAGE_END", messageId: "msg-1" },
      ],
    },
    {
      name: "extras-only trailing chunk emits an empty-delta event",
      events: [
        { type: "TEXT_MESSAGE_CHUNK", messageId: "msg-1", delta: "a" },
        { type: "TEXT_MESSAGE_CHUNK", messageId: "msg-1", customField: "x" },
      ],
      expected: [
        { type: "TEXT_MESSAGE_START", messageId: "msg-1" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1" },
        { type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1" },
        { type: "TEXT_MESSAGE_END", messageId: "msg-1" },
      ],
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const wrapped = wrap(c.events);
      const ts = triples(expandChunks(wrapped as never));
      const orc = oracleExpand(wrapped);
      expect(ts).toEqual(c.expected);
      expect(orc.expanded).toEqual(c.expected);
      expect(orc.count).toBe(c.expected.length);
    });
  }
});

describe("S0 gate — determinism: 100x full analysis, one report hash each", () => {
  const expected = loadExpected();
  it("100 repeats per Golden, report hash (durationMs excluded) unique", { timeout: 300000 }, () => {
    const perGolden: Record<string, { distinctHashes: number; hash: string; repeats: number }> = {};
    let totalRepeats = 0;
    for (const id of GOLDEN_IDS) {
      const target = targetFor(id, expected);
      const hashes = new Set<string>();
      for (let i = 0; i < 100; i += 1) {
        const started = Date.now();
        const analysis = analyzeFixture(loadFixture(id), target);
        const durationMs = Date.now() - started;
        hashes.add(reportHash(analysis, durationMs));
        totalRepeats += 1;
      }
      expect(hashes.size).toBe(1);
      perGolden[id] = {
        distinctHashes: hashes.size,
        hash: [...hashes][0] as string,
        repeats: 100,
      };
    }
    expect(totalRepeats).toBe(2400);
    const dir = join(ROOT, "artifacts", "reports");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "S0_DETERMINISM.json"),
      `${JSON.stringify({ schema: "rejoinlab.s0-determinism/v1", specVersion: SPEC_VERSION, generatedAtUtc: new Date().toISOString(), totalRepeats, perGolden }, null, 2)}\n`,
      "utf-8",
    );
  });
});

describe("S0 gate — BFS node budget is respected (limit probe)", () => {
  it("maxNodes=1 forces limitExceeded (never a verdict from partial search)", () => {
    const result = searchShortest(loadFixture("G01"), "DUPLICATE_TOOL_CALL", 3, 1);
    expect(result.limitExceeded).toBe(true);
    expect(result.sequence).toBeNull();
  });
  it("full-budget BFS visits at most 5000 nodes on every Golden", () => {
    const expected = loadExpected();
    let max = 0;
    for (const id of GOLDEN_IDS) {
      const analysis = analyzeFixture(loadFixture(id), targetFor(id, expected));
      expect(analysis.bfsLimitExceeded).toBe(false);
      max = Math.max(max, analysis.bfsVisited);
    }
    expect(max).toBeLessThanOrEqual(5000);
  });
});

describe("S0 gate — FIX-R3 RUN_FINISHED lifecycle + D-02 parity fixtures (P1-R3-01 / P1-R3-02 / P2-R3-03)", () => {
  const { fixR3Traces: oracleFixR3 } = loadOracle();
  // Same order as scripts/oracle-parity.py (sorted fixture stems).
  // 8 fixtures (coordinator ruling: the design memo's "7/7"
  // miscounted the two F4 variants as one fixture; the delivered
  // count is 8 and S0_PARITY.json carries fixR3Parity 8/8).
  const FIXR3_IDS = [
    "fixr3_pending_mismatch",
    "fixr3_finish_wrong_run",
    "fixr3_finish_without_start",
    "fixr3_pending_grouped",
    "fixr3_pending_grouped_declared",
    "fixr3_pending_cross_run",
    "fixr3_empty_toolcalls",
    "fixr3_chunk_index",
  ] as const;
  const rows: Record<string, Record<string, unknown>> = {};

  function loadFixR3Fixture(id: string) {
    const rawText = readFileSync(join(ROOT, "oracle", "tests", "fixtures", `${id}.json`), "utf-8");
    const raw = JSON.parse(rawText) as { events: { event: unknown }[] };
    return { raw, rawText, fixture: toReplayFixture(raw as never) };
  }

  function commonTs(id: string) {
    const orc = oracleFixR3[id] as OracleTrace;
    expect(orc).toBeDefined();
    const { raw, rawText, fixture } = loadFixR3Fixture(id);
    const analysis = analyzeFixture(fixture, null);
    const ev = analysis.evaluation;
    const tsDiags = ev.diagnostics.map((d) => ({
      code: d.code,
      severity: d.severity,
      sourceIndex: d.sourceIndex ?? null,
    }));
    const tsFirstDiv = ev.firstDivergence?.sourceIndex ?? null;
    const tsParityFullHash =
      ev.fullState === null ? null : parityStateHashTS(ev.fullState);
    const tsParityResumeHash =
      ev.resumeState === null ? null : parityStateHashTS(ev.resumeState);
    const tsParityReportHash = parityReportHashTS(
      analysis, rawText, raw.events.length, fixture.recovery,
    );
    const tsProductionReportHash = canonicalHash(
      productionReportHashInputTS(
        analysis, rawText, raw.events.length, fixture.recovery,
      ),
    );
    const tsParityFullPath =
      ev.fullState === null ? null : parityProjectPathTS(ev.fullState);
    const tsParityResumePath =
      ev.resumeState === null ? null : parityProjectPathTS(ev.resumeState);
    return {
      orc, raw, rawText, fixture, analysis, ev, tsDiags, tsFirstDiv,
      tsParityFullHash, tsParityResumeHash, tsParityReportHash,
      tsProductionReportHash, tsParityFullPath, tsParityResumePath,
    };
  }

  // A档 — INVALID_INPUT 夹具（F1–F3 及 F4 变体）：粗口径比较
  // （备忘录 §2.6）。TS 诊断 message 为 "[INVALID_INPUT] [CODE] ..."
  // 抛错原文，Oracle 为固定模板 "Input is invalid: INVALID_INPUT
  // at sourceIndex N."，且 Oracle 的 sourceIndex 字段恒为 null —
  // 因此不得断言诊断 message 全文相等或生产报告哈希相等。
  for (const id of [
    "fixr3_pending_mismatch",
    "fixr3_finish_wrong_run",
    "fixr3_finish_without_start",
    "fixr3_pending_grouped_declared",
  ] as const) {
    it(`${id} TS vs Oracle — INVALID_INPUT, coarse comparison`, () => {
      const c = commonTs(id);
      const checks = {
        verdict: c.ev.verdict === "INVALID_INPUT" && c.orc.verdict === "INVALID_INPUT",
        diagnostics: JSON_EQUAL(c.tsDiags, [{ code: "INVALID_INPUT", severity: "CRITICAL", sourceIndex: null }]) &&
          JSON_EQUAL(c.orc.diagnostics, [{ code: "INVALID_INPUT", severity: "CRITICAL", sourceIndex: null }]),
        firstDivergenceNull: c.ev.firstDivergence === null && c.orc.firstDivergenceSourceIndex === null,
        shortestNull: c.analysis.shortestInjectionSequence === null && c.orc.shortestInjectionSequence === null,
        parityNull:
          c.tsParityFullHash === null && c.orc.parityFullStateHash === null &&
          c.tsParityResumeHash === null && c.orc.parityResumeStateHash === null &&
          c.tsParityReportHash === null && c.orc.parityReportHash === null &&
          c.tsParityFullPath === null && c.orc.parityFullPath === null &&
          c.tsParityResumePath === null && c.orc.parityResumePath === null,
      };
      rows[id] = {
        parityOk: Object.values(checks).every(Boolean),
        checks,
        tsVerdict: c.ev.verdict,
        oracleVerdict: c.orc.verdict,
        tsDiagnostics: c.tsDiags,
        oracleDiagnostics: c.orc.diagnostics,
        tsDiagnosticsFull: c.ev.diagnostics.map(reportDiagnosticTS),
        oracleDiagnosticsFull: c.orc.diagnosticsFull,
        tsFirstDivergence: c.tsFirstDiv,
        oracleFirstDivergence: c.orc.firstDivergenceSourceIndex,
        tsShortest: c.analysis.shortestInjectionSequence,
        oracleShortest: c.orc.shortestInjectionSequence,
      };
      expect(c.orc.verdict).toBe("INVALID_INPUT");
      expect(c.orc.diagnostics).toEqual([
        { code: "INVALID_INPUT", severity: "CRITICAL", sourceIndex: null },
      ]);
      expect(c.orc.firstDivergenceSourceIndex).toBeNull();
      expect(c.orc.shortestInjectionSequence).toBeNull();
      expect(c.orc.parityFullStateHash).toBeNull();
      expect(c.orc.parityResumeStateHash).toBeNull();
      expect(c.orc.parityReportHash).toBeNull();
      expect(c.orc.parityFullPath).toBeNull();
      expect(c.orc.parityResumePath).toBeNull();
      expect(c.ev.verdict).toBe("INVALID_INPUT");
      expect(c.tsDiags).toEqual([
        { code: "INVALID_INPUT", severity: "CRITICAL", sourceIndex: null },
      ]);
      expect(c.ev.firstDivergence).toBeNull();
      expect(c.analysis.shortestInjectionSequence).toBeNull();
      expect(c.tsParityFullHash).toBeNull();
      expect(c.tsParityResumeHash).toBeNull();
      expect(c.tsParityReportHash).toBeNull();
      expect(c.tsParityFullPath).toBeNull();
      expect(c.tsParityResumePath).toBeNull();
    });
  }

  // B档 — 全口径比对（F4 主变体、F5）：verdict、诊断（code/severity/
  // sourceIndex + 全文）、终态 parity 哈希、parity 路径、parity
  // 报告哈希、生产报告哈希、visitedStates、bfsVisited。
  function assertFullParity(id: string, expectedVerdict: string) {
    const c = commonTs(id);
    const checks = {
      verdict: c.ev.verdict === expectedVerdict && c.ev.verdict === c.orc.verdict,
      diagnostics: JSON_EQUAL(c.tsDiags, c.orc.diagnostics),
      diagnosticsFull: JSON_EQUAL(
        c.ev.diagnostics.map(reportDiagnosticTS),
        c.orc.diagnosticsFull,
      ),
      firstDivergence:
        c.tsFirstDiv === c.orc.firstDivergenceSourceIndex &&
        JSON_EQUAL(
          c.ev.firstDivergence === null
            ? null
            : toReportFirstDivergence(c.ev.firstDivergence),
          c.orc.firstDivergence,
        ),
      shortest: JSON_EQUAL(c.analysis.shortestInjectionSequence, c.orc.shortestInjectionSequence),
      parityHashes:
        c.tsParityFullHash !== null &&
        c.tsParityFullHash === c.orc.parityFullStateHash &&
        c.tsParityResumeHash !== null &&
        c.tsParityResumeHash === c.orc.parityResumeStateHash,
      parityPaths:
        c.tsParityFullPath !== null &&
        JSON_EQUAL(c.tsParityFullPath, c.orc.parityFullPath) &&
        c.tsParityResumePath !== null &&
        JSON_EQUAL(c.tsParityResumePath, c.orc.parityResumePath),
      parityReportHash:
        c.tsParityReportHash !== null &&
        c.tsParityReportHash === c.orc.parityReportHash,
      productionReportHash: c.tsProductionReportHash === c.orc.reportHash,
      visitedStates: c.ev.metrics.visitedStates === c.orc.visitedStates,
      bfsVisited: c.analysis.bfsVisited === c.orc.bfsVisited,
    };
    rows[id] = {
      parityOk: Object.values(checks).every(Boolean),
      checks,
      tsVerdict: c.ev.verdict,
      oracleVerdict: c.orc.verdict,
      tsDiagnostics: c.tsDiags,
      oracleDiagnostics: c.orc.diagnostics,
      tsDiagnosticsFull: c.ev.diagnostics.map(reportDiagnosticTS),
      oracleDiagnosticsFull: c.orc.diagnosticsFull,
      tsFirstDivergence: c.tsFirstDiv,
      oracleFirstDivergence: c.orc.firstDivergenceSourceIndex,
      tsParityFullStateHash: c.tsParityFullHash,
      oracleParityFullStateHash: c.orc.parityFullStateHash,
      tsParityResumeStateHash: c.tsParityResumeHash,
      oracleParityResumeStateHash: c.orc.parityResumeStateHash,
      tsParityReportHash: c.tsParityReportHash,
      oracleParityReportHash: c.orc.parityReportHash,
      tsProductionReportHash: c.tsProductionReportHash,
      oracleProductionReportHash: c.orc.reportHash,
      tsVisitedStates: c.ev.metrics.visitedStates,
      oracleVisitedStates: c.orc.visitedStates,
      tsBfsVisited: c.analysis.bfsVisited,
      oracleBfsVisited: c.orc.bfsVisited,
      tsShortest: c.analysis.shortestInjectionSequence,
      oracleShortest: c.orc.shortestInjectionSequence,
    };
    expect(c.ev.verdict).toBe(expectedVerdict);
    expect(c.ev.verdict).toBe(c.orc.verdict);
    expect(c.tsDiags).toEqual(c.orc.diagnostics);
    expect(c.ev.diagnostics.map(reportDiagnosticTS)).toEqual(c.orc.diagnosticsFull);
    expect(c.tsFirstDiv).toBe(c.orc.firstDivergenceSourceIndex);
    expect(
      c.ev.firstDivergence === null
        ? null
        : toReportFirstDivergence(c.ev.firstDivergence),
    ).toEqual(c.orc.firstDivergence);
    expect(c.analysis.shortestInjectionSequence).toEqual(c.orc.shortestInjectionSequence);
    expect(c.tsParityFullHash).not.toBeNull();
    expect(c.tsParityFullHash).toBe(c.orc.parityFullStateHash);
    expect(c.tsParityResumeHash).not.toBeNull();
    expect(c.tsParityResumeHash).toBe(c.orc.parityResumeStateHash);
    expect(c.tsParityFullPath).toEqual(c.orc.parityFullPath);
    expect(c.tsParityResumePath).toEqual(c.orc.parityResumePath);
    expect(c.tsParityReportHash).not.toBeNull();
    expect(c.tsParityReportHash).toBe(c.orc.parityReportHash);
    expect(c.tsProductionReportHash).toBe(c.orc.reportHash);
    expect(c.ev.metrics.visitedStates).toBe(c.orc.visitedStates);
    expect(c.analysis.bfsVisited).toBe(c.orc.bfsVisited);
    return c;
  }

  it("fixr3_pending_grouped TS vs Oracle — full parity, INCONSISTENT on the replay duplicate", () => {
    // 协调员裁决（备忘录 §2.6 修正）：F4 主变体的期望 verdict 是
    // INCONSISTENT 而非 CONSISTENT——重放副本条目只能由 foldTrack
    // 的 duplicate 分支产生，该分支必在 resume 折叠中记一条
    // DUPLICATE_TOOL_CALL 诊断，且 classifyDualTrack 对任一 resume
    // 诊断即判 INCONSISTENT，副本条目本身也使终态哈希分歧；快照
    // 同步是 create-only（同 id 跳过），产不出第二条目。
    // 本测试是回归钉：F4 主变体在新旧代码下均为 INCONSISTENT
    // [DUPLICATE_TOOL_CALL]（B 组复核对照实验证实：旧代码下本测
    // 试即通过——resume 折叠的重放副本诊断占优，旧 Planner catch
    // 吞掉 PENDING 抛出后 verdict 仍为 INCONSISTENT）。本测试钉
    // 住分组推导下诊断中不出现 PENDING_TOOL_CALL_MISMATCH、verdict
    // 不是 INVALID_INPUT；分组修复的证据是 F4 变体（旧 INCONSISTENT
    // → 新 INVALID_INPUT）+ F1。
    const c = assertFullParity("fixr3_pending_grouped", "INCONSISTENT");
    expect(c.ev.diagnostics.map((d) => d.code)).toEqual(["DUPLICATE_TOOL_CALL"]);
    expect(c.tsFirstDiv).toBe(4);
    expect(c.orc.firstDivergenceSourceIndex).toBe(4);
    expect(c.ev.diagnostics.map((d) => d.code)).not.toContain("PENDING_TOOL_CALL_MISMATCH");
    expect(c.orc.diagnostics.map((d) => d.code)).not.toContain("PENDING_TOOL_CALL_MISMATCH");
    expect(c.ev.verdict).not.toBe("INVALID_INPUT");
    expect(c.orc.verdict).not.toBe("INVALID_INPUT");
  });

  it("fixr3_pending_cross_run TS vs Oracle — full parity, run-scoped pending", () => {
    assertFullParity("fixr3_pending_cross_run", "CONSISTENT");
  });

  it("fixr3_empty_toolcalls TS vs Oracle — bounded comparison (D-02a residual corner)", () => {
    // D-02a（备忘录 §2.6 退路 + D 组定夺：不修）：TS 在输入消息上
    // 保留显式 toolCalls: []，Oracle 投影在 parity.py:134–135 丢弃
    // 它（"键存在即保留"会给每条消息都加上 toolCalls: []，实测 24
    // 条 Golden 的 production 哈希变 23/24、parity 哈希变 23/24；
    // 真正的修复需在 reducer 层记录 wire 是否携带该键，超出
    // FIX-R3 范围）。因此本夹具只做有界断言：verdict、诊断、首分
    // 歧、最短序列、visitedStates、bfsVisited 全一致，外加“除该键
    // 外的状态哈希一致”（双路径各去 toolCalls 键 + finalStateHash
    // 后求 canonical 哈希，两侧相等）。parity 终态哈希、parity
    // 路径（原样）、parity 报告哈希、生产报告哈希均不比对——它们
    // 都含该键，分歧是已知的残留角落（ADR-004，C 组），不是静默
    // 放宽：本测试同时钉住分歧本身（TS 侧 msg-a1 带 toolCalls:
    // []，Oracle 侧同消息无该键）。
    const c = commonTs("fixr3_empty_toolcalls");
    const stripToolCallsKey = (
      path: Record<string, unknown> | null,
    ): string | null => {
      if (path === null) return null;
      const copy = JSON.parse(JSON.stringify(path)) as Record<string, unknown>;
      delete copy.finalStateHash;
      for (const m of (copy.messages as Record<string, unknown>[]) ?? []) {
        delete m.toolCalls;
      }
      return canonicalHash(copy);
    };
    const tsFullStripped = stripToolCallsKey(c.tsParityFullPath);
    const orcFullStripped = stripToolCallsKey(c.orc.parityFullPath);
    const tsResumeStripped = stripToolCallsKey(c.tsParityResumePath);
    const orcResumeStripped = stripToolCallsKey(c.orc.parityResumePath);
    const tsMsgA1 = (c.tsParityFullPath?.messages as Record<string, unknown>[] | undefined)?.find(
      (m) => m.id === "msg-a1",
    );
    const orcMsgA1 = (c.orc.parityFullPath?.messages as Record<string, unknown>[] | undefined)?.find(
      (m) => m.id === "msg-a1",
    );
    const checks = {
      verdict: c.ev.verdict === "CONSISTENT" && c.ev.verdict === c.orc.verdict,
      diagnostics: JSON_EQUAL(c.tsDiags, c.orc.diagnostics) && c.tsDiags.length === 0,
      diagnosticsFull: JSON_EQUAL(
        c.ev.diagnostics.map(reportDiagnosticTS),
        c.orc.diagnosticsFull,
      ),
      firstDivergence: c.ev.firstDivergence === null && c.orc.firstDivergence === null,
      shortest: JSON_EQUAL(c.analysis.shortestInjectionSequence, c.orc.shortestInjectionSequence),
      visitedStates: c.ev.metrics.visitedStates === c.orc.visitedStates,
      bfsVisited: c.analysis.bfsVisited === c.orc.bfsVisited,
      strippedStateHash:
        tsFullStripped !== null && tsFullStripped === orcFullStripped &&
        tsResumeStripped !== null && tsResumeStripped === orcResumeStripped,
      cornerPinned:
        tsMsgA1 !== undefined && "toolCalls" in tsMsgA1 &&
        JSON_EQUAL(tsMsgA1.toolCalls, []) &&
        orcMsgA1 !== undefined && !("toolCalls" in orcMsgA1),
    };
    rows["fixr3_empty_toolcalls"] = {
      parityOk: Object.values(checks).every(Boolean),
      checks,
      tsVerdict: c.ev.verdict,
      oracleVerdict: c.orc.verdict,
      tsDiagnostics: c.tsDiags,
      oracleDiagnostics: c.orc.diagnostics,
      tsFirstDivergence: c.tsFirstDiv,
      oracleFirstDivergence: c.orc.firstDivergenceSourceIndex,
      tsShortest: c.analysis.shortestInjectionSequence,
      oracleShortest: c.orc.shortestInjectionSequence,
      tsVisitedStates: c.ev.metrics.visitedStates,
      oracleVisitedStates: c.orc.visitedStates,
      tsBfsVisited: c.analysis.bfsVisited,
      oracleBfsVisited: c.orc.bfsVisited,
      tsStrippedFullPathHash: tsFullStripped,
      oracleStrippedFullPathHash: orcFullStripped,
      tsStrippedResumePathHash: tsResumeStripped,
      oracleStrippedResumePathHash: orcResumeStripped,
      tsParityFullStateHash: c.tsParityFullHash,
      oracleParityFullStateHash: c.orc.parityFullStateHash,
    };
    expect(c.ev.verdict).toBe("CONSISTENT");
    expect(c.ev.verdict).toBe(c.orc.verdict);
    expect(c.tsDiags).toEqual([]);
    expect(c.tsDiags).toEqual(c.orc.diagnostics);
    expect(c.ev.diagnostics.map(reportDiagnosticTS)).toEqual(c.orc.diagnosticsFull);
    expect(c.ev.firstDivergence).toBeNull();
    expect(c.orc.firstDivergence).toBeNull();
    expect(c.analysis.shortestInjectionSequence).toEqual(c.orc.shortestInjectionSequence);
    expect(c.ev.metrics.visitedStates).toBe(c.orc.visitedStates);
    expect(c.analysis.bfsVisited).toBe(c.orc.bfsVisited);
    expect(tsFullStripped).not.toBeNull();
    expect(tsFullStripped).toBe(orcFullStripped);
    expect(tsResumeStripped).not.toBeNull();
    expect(tsResumeStripped).toBe(orcResumeStripped);
    // The corner itself, pinned: TS keeps the explicit [], Oracle drops it.
    expect(tsMsgA1).toBeDefined();
    expect(tsMsgA1).toHaveProperty("toolCalls", []);
    expect(orcMsgA1).toBeDefined();
    expect(orcMsgA1).not.toHaveProperty("toolCalls");
  });

  it("fixr3_chunk_index TS vs Oracle — expansion + state parity (D-02b)", () => {
    // 备忘录 §2.6 D-02b 的 (i)–(iii)，外加可对齐的诊断/最短序列/
    // bfsVisited/parity 路径。展开 sourceIndex 序列不得跨侧比较
    // （TS 以 0..n 重编号，Oracle 保留原始下标，ADR-003 已知角落）。
    // 不比对 visitedStates、parity 报告哈希、生产报告哈希：实测
    // TS visitedStates 16、Oracle 12。Oracle fold() 内部同样展
    // 开（full 历史也是 11）；差距全在 resume 切片：TS 对已展开
    // 流按展开下标切片（buildResumeStream，>5 得 5 个事件），
    // Oracle 对原始流按原始下标切片（replay.py:243
    // build_resume_stream，>5 得 1 个 RUN_FINISHED 再展开），即
    // 16=11+5 对 12=11+1。两类报告哈希都含 visitedStates，故亦
    // 不对齐。这是坐标系差异，不是状态分歧（终态 parity 哈希两
    // 侧相等）。
    const c = commonTs("fixr3_chunk_index");
    // (i) 展开后的事件类型与载荷序列相等（忽略 sourceIndex）。
    // Hand-derived from the fixture + EVENT_SCHEMA §4.5/§5.4
    // (NOT copied from either implementation's output — the TS
    // scratch measurement confirmed this sequence by hand first).
    const expectedExpanded: Record<string, unknown>[] = [
      { type: "RUN_STARTED", threadId: "thread-1", runId: "run-1" },
      { type: "TEXT_MESSAGE_START", messageId: "msg-1" },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1", delta: "Hello " },
      { type: "TEXT_MESSAGE_CONTENT", messageId: "msg-1", delta: "world." },
      { type: "TOOL_CALL_START", toolCallId: "call-1", toolCallName: "search", parentMessageId: "msg-1" },
      { type: "TOOL_CALL_ARGS", toolCallId: "call-1", delta: "{\"q\":" },
      { type: "TOOL_CALL_ARGS", toolCallId: "call-1", delta: "\"x\"}" },
      { type: "TOOL_CALL_END", toolCallId: "call-1" },
      { type: "TOOL_CALL_RESULT", messageId: "msg-r1", toolCallId: "call-1", content: "sunny" },
      { type: "TEXT_MESSAGE_END", messageId: "msg-1" },
      { type: "RUN_FINISHED", threadId: "thread-1", runId: "run-1", outcome: { type: "success", pendingToolCallIds: [] } },
    ];
    const tsExpanded = expandChunks(c.raw.events as never);
    expect(tsExpanded.map((w) => w.sourceIndex)).toEqual(
      expectedExpanded.map((_, i) => i),
    );
    expect(tsExpanded.map((w) => w.event)).toEqual(expectedExpanded);
    const oracleExpanded = JSON.parse(
      execFileSync(
        "python3",
        [join(ROOT, "scripts", "oracle-expand-chunks.py")],
        { cwd: ROOT, encoding: "utf-8", input: JSON.stringify(c.raw.events), timeout: 60000 },
      ),
    ) as { expanded: Record<string, unknown>[]; count: number };
    const expectedTypeIds = expectedExpanded.map((e) => {
      const t: Record<string, unknown> = { type: e.type };
      if (e.messageId !== undefined) t.messageId = e.messageId;
      if (e.toolCallId !== undefined) t.toolCallId = e.toolCallId;
      return t;
    });
    expect(oracleExpanded.expanded).toEqual(expectedTypeIds);
    expect(oracleExpanded.count).toBe(expectedExpanded.length);
    // (ii) verdict 一致（CONSISTENT）且终态 parity 哈希相等；
    // (iii) firstDivergence 两侧均为 null。
    const checks = {
      expansionTs: JSON_EQUAL(tsExpanded.map((w) => w.event), expectedExpanded),
      expansionOracle: JSON_EQUAL(oracleExpanded.expanded, expectedTypeIds),
      verdict: c.ev.verdict === "CONSISTENT" && c.ev.verdict === c.orc.verdict,
      diagnostics: JSON_EQUAL(c.tsDiags, c.orc.diagnostics) && c.tsDiags.length === 0,
      parityHashes:
        c.tsParityFullHash !== null &&
        c.tsParityFullHash === c.orc.parityFullStateHash &&
        c.tsParityResumeHash !== null &&
        c.tsParityResumeHash === c.orc.parityResumeStateHash,
      parityPaths:
        c.tsParityFullPath !== null &&
        JSON_EQUAL(c.tsParityFullPath, c.orc.parityFullPath) &&
        c.tsParityResumePath !== null &&
        JSON_EQUAL(c.tsParityResumePath, c.orc.parityResumePath),
      firstDivergence: c.ev.firstDivergence === null && c.orc.firstDivergence === null,
      shortest: JSON_EQUAL(c.analysis.shortestInjectionSequence, c.orc.shortestInjectionSequence),
      bfsVisited: c.analysis.bfsVisited === c.orc.bfsVisited,
    };
    rows["fixr3_chunk_index"] = {
      parityOk: Object.values(checks).every(Boolean),
      checks,
      tsVerdict: c.ev.verdict,
      oracleVerdict: c.orc.verdict,
      tsDiagnostics: c.tsDiags,
      oracleDiagnostics: c.orc.diagnostics,
      tsFirstDivergence: c.tsFirstDiv,
      oracleFirstDivergence: c.orc.firstDivergenceSourceIndex,
      tsParityFullStateHash: c.tsParityFullHash,
      oracleParityFullStateHash: c.orc.parityFullStateHash,
      tsParityResumeStateHash: c.tsParityResumeHash,
      oracleParityResumeStateHash: c.orc.parityResumeStateHash,
      tsShortest: c.analysis.shortestInjectionSequence,
      oracleShortest: c.orc.shortestInjectionSequence,
      tsBfsVisited: c.analysis.bfsVisited,
      oracleBfsVisited: c.orc.bfsVisited,
      tsVisitedStates: c.ev.metrics.visitedStates,
      oracleVisitedStates: c.orc.visitedStates,
    };
    expect(c.ev.verdict).toBe("CONSISTENT");
    expect(c.ev.verdict).toBe(c.orc.verdict);
    expect(c.tsDiags).toEqual([]);
    expect(c.tsDiags).toEqual(c.orc.diagnostics);
    expect(c.ev.diagnostics.map(reportDiagnosticTS)).toEqual(c.orc.diagnosticsFull);
    expect(c.tsParityFullHash).not.toBeNull();
    expect(c.tsParityFullHash).toBe(c.orc.parityFullStateHash);
    expect(c.tsParityResumeHash).not.toBeNull();
    expect(c.tsParityResumeHash).toBe(c.orc.parityResumeStateHash);
    expect(c.tsParityFullPath).toEqual(c.orc.parityFullPath);
    expect(c.tsParityResumePath).toEqual(c.orc.parityResumePath);
    expect(c.ev.firstDivergence).toBeNull();
    expect(c.orc.firstDivergence).toBeNull();
    expect(c.tsFirstDiv).toBeNull();
    expect(c.orc.firstDivergenceSourceIndex).toBeNull();
    expect(c.analysis.shortestInjectionSequence).toEqual(c.orc.shortestInjectionSequence);
    expect(c.analysis.bfsVisited).toBe(c.orc.bfsVisited);
  });

  it("fixR3 summary — fixR3Parity 8/8 merged into artifacts/reports/S0_PARITY.json", () => {
    const ids = Object.keys(rows);
    const pass = ids.filter((id) => (rows[id] as { parityOk: boolean }).parityOk).length;
    const failures = ids.filter((id) => !(rows[id] as { parityOk: boolean }).parityOk);
    const file = join(ROOT, "artifacts", "reports", "S0_PARITY.json");
    // Merge only: the 24-Golden summary/traces written by the Golden
    // describe earlier in this file are preserved untouched (this
    // merge never rewrites summary or traces, so the 24/24 counts
    // cannot be inflated by the new fixtures).
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    } catch {
      existing = {};
    }
    const out = {
      ...existing,
      fixR3Parity: { pass, total: 8, failures },
      fixR3Traces: rows,
    };
    mkdirSync(join(ROOT, "artifacts", "reports"), { recursive: true });
    writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`, "utf-8");
    expect(ids.length).toBe(8);
    expect(pass).toBe(8);
    expect(failures).toEqual([]);
  });
});
