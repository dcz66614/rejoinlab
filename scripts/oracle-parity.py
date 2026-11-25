"""T007 helper — dump the Oracle's per-Golden analysis as JSON.

Reads only the frozen Oracle (oracle/replay.py) and the hand-derived
expected values (oracle/golden_expected.json); writes nothing into
oracle/. The T007 gate test / verify script consumes the JSON on
stdout and compares it field by field with the TypeScript production
results. This script is T007-owned (scripts/), not part of the Oracle.

FIX-R2 (P1-R2-02): the Oracle report is now the full production
report (rejoinlab.report/v1, §13.2) — the script passes each
fixture's RAW file text to analyze() so input.sourceSha256 is the
raw-text hash, and emits per trace the production report hash, the
full diagnostics, the firstDivergence object, visitedStates and
bfsVisited alongside the (unchanged) parity fields. The parity
paths are read off the report's transport keys (analyze() attaches
parityFullPath / parityResumePath / bfsVisited; report_hash drops
them — they are not part of the report schema).

Usage (from the repository root):
    python3 scripts/oracle-parity.py > /tmp/oracle-parity.json
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from oracle.parity import parity_report_hash, report_hash  # noqa: E402
from oracle.replay import _legal_baseline, analyze, evaluate  # noqa: E402

GOLDEN_DIR = ROOT / "fixtures" / "golden"
EXPECTED_PATH = ROOT / "oracle" / "golden_expected.json"
INPUT_FIXTURE_DIR = ROOT / "oracle" / "tests" / "fixtures"
SCENARIO_IDS = [f"G0{i}" for i in range(1, 9)] + [f"N{i:02d}" for i in range(1, 17)]
# RUN_STARTED.input fixtures (FIX-R1, P1-R1-02): full fixtures in the
# Golden raw shape, but NOT Goldens — they never enter
# golden_expected.json. Sorted for a stable output order.
INPUT_FIXTURE_IDS = sorted(
    p.stem for p in INPUT_FIXTURE_DIR.glob("input_*.json"))
# Dedicated parity fixtures (FIX-R2, P1-R2-02): cover the five
# RunState fields the 24 Goldens never carry (parentRunId,
# protocolVersion, outcome, result, RUN_ERROR code). Same raw
# shape as the input fixtures; the S0 gate compares them directly
# with the TS production analysis of the same files.
PARITY_FIXTURE_IDS = sorted(
    p.stem for p in INPUT_FIXTURE_DIR.glob("parity_*.json"))
# FIX-R3 RUN_FINISHED lifecycle + D-02 parity fixtures (P1-R3-01 /
# P1-R3-02 / P2-R3-03): 8 fixtures, NOT Goldens — the 24/24 Golden
# count is untouched. Same raw shape as the input/parity fixtures;
# the S0 gate compares them directly with the TS production analysis
# of the same files. Sorted for a stable output order.
FIXR3_FIXTURE_IDS = sorted(
    p.stem for p in INPUT_FIXTURE_DIR.glob("fixr3_*.json"))


def _path_fields(path):
    """Evaluation-path view (messageOrder/toolCallOrder/sharedState/
    pendingToolCallIds/runStatus + finalStateHash) from a path dict.
    The report path carries no runStatus (§13.2); the caller fills
    it from the parity path — see _eval_path_fields."""
    if path is None:
        return None
    return {
        "finalStateHash": path.get("finalStateHash"),
        "messageOrder": [m["id"] for m in path.get("messages", [])],
        "toolCallOrder": [c["id"] for c in path.get("toolCalls", [])],
        "sharedState": path.get("sharedState"),
        "pendingToolCallIds": path.get("pendingToolCallIds"),
        "runStatus": path.get("runStatus"),
    }


def _eval_path_fields(report_path, parity_path):
    """The evaluation path view: the report path plus runStatus
    (TS planner.ts toPathResult shape — the S0 gate's pathFields
    reads runStatus). runStatus is a property of the state, so the
    parity path (same state, parity projection) carries the same
    value."""
    fields = _path_fields(report_path)
    if fields is not None and parity_path is not None:
        fields["runStatus"] = parity_path.get("runStatus")
    return fields


def _diagnostics_for_report(report):
    return [
        {"code": d["code"], "severity": d["severity"],
         "sourceIndex": d.get("sourceIndex")}
        for d in report["diagnostics"]
    ]


def _trace(scenario_id, fixture, source_text, target):
    """One trace: verdict/diagnostics/firstDivergence/shortest +
    evaluation paths + parity hashes/paths + production report
    hash + full diagnostics + firstDivergence object +
    visitedStates + bfsVisited. Missing parity values on error
    returns (INVALID_INPUT / INCONCLUSIVE_LIMIT) — the gate treats
    a missing value as "no parity" and fails closed on Goldens."""
    report = analyze(fixture, target_code=target, source_text=source_text,
                     source_format="JSONL")
    full_parity = report.get("parityFullPath")
    resume_parity = report.get("parityResumePath")
    first_div = report.get("firstDivergence")
    return {
        "verdict": report["verdict"],
        "diagnostics": _diagnostics_for_report(report),
        "firstDivergenceSourceIndex": (
            first_div or {}).get("sourceIndex"),
        "shortestInjectionSequence": report["shortestInjectionSequence"],
        "fullPath": _eval_path_fields(report["fullPath"], full_parity),
        "resumePath": _eval_path_fields(report["resumePath"], resume_parity),
        "durationMs": report["metrics"]["durationMs"],
        "parityFullStateHash": (
            full_parity.get("finalStateHash") if full_parity else None),
        "parityResumeStateHash": (
            resume_parity.get("finalStateHash") if resume_parity else None),
        "parityReportHash": (
            parity_report_hash(report, full_parity, resume_parity)
            if full_parity is not None and resume_parity is not None
            else None
        ),
        "parityFullPath": full_parity,
        "parityResumePath": resume_parity,
        # FIX-R2 production report (§2.1): full byte-for-byte
        # reproduction of the TS report hash.
        "reportHash": report_hash(report),
        "diagnosticsFull": report["diagnostics"],
        "firstDivergence": first_div,
        "visitedStates": report["metrics"]["visitedStates"],
        "bfsVisited": report.get("bfsVisited"),
    }


def main():
    with open(EXPECTED_PATH, encoding="utf-8") as handle:
        expected = json.load(handle)["traces"]
    out = {"generatedUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
           "traces": {}, "inputTraces": {}, "parityTraces": {},
           "fixR3Traces": {}}
    for scenario_id in SCENARIO_IDS:
        with open(GOLDEN_DIR / f"{scenario_id}.json",
                  encoding="utf-8") as handle:
            source_text = handle.read()
        fixture = json.loads(source_text)
        want = expected[scenario_id]
        target = want["diagnostics"][0] if want["diagnostics"] else None
        trace = _trace(scenario_id, fixture, source_text, target)
        # Legal-baseline convergence (Oracle side): correct checkpoint,
        # no injections — full and resume canonical hashes must agree.
        baseline = _legal_baseline(fixture)
        base_eval = evaluate(baseline)
        base_full = base_eval.get("fullPath") or {}
        base_resume = base_eval.get("resumePath") or {}
        trace["legalBaseline"] = {
            "verdict": base_eval["verdict"],
            "diagnostics": [d["code"] for d in base_eval["diagnostics"]],
            "fullHash": base_full.get("finalStateHash"),
            "resumeHash": base_resume.get("finalStateHash"),
            "converged": base_full.get("finalStateHash") is not None
            and base_full.get("finalStateHash")
            == base_resume.get("finalStateHash"),
            # Oracle state_hash is over the Oracle projection; kept
            # here only for the Oracle-side convergence check, NOT
            # compared with TS hashes (different field names).
            "oracleStateHashNote": "hashes are Oracle-projection only",
        }
        out["traces"][scenario_id] = trace
    # RUN_STARTED.input fixtures (FIX-R1, P1-R1-02): same shape as the
    # Golden traces (verdict/diagnostics/firstDivergence/shortest +
    # parity hashes/paths), no legal-baseline block, no expected
    # values — the S0 gate compares them directly with the TS
    # production analysis of the same fixture files.
    for scenario_id in INPUT_FIXTURE_IDS:
        with open(INPUT_FIXTURE_DIR / f"{scenario_id}.json",
                  encoding="utf-8") as handle:
            source_text = handle.read()
        fixture = json.loads(source_text)
        out["inputTraces"][scenario_id] = _trace(
            scenario_id, fixture, source_text, None)
    # Dedicated parity fixtures (FIX-R2, P1-R2-02): same shape as the
    # input traces; the S0 gate compares them directly with the TS
    # production analysis of the same fixture files.
    for scenario_id in PARITY_FIXTURE_IDS:
        with open(INPUT_FIXTURE_DIR / f"{scenario_id}.json",
                  encoding="utf-8") as handle:
            source_text = handle.read()
        fixture = json.loads(source_text)
        out["parityTraces"][scenario_id] = _trace(
            scenario_id, fixture, source_text, None)
    # FIX-R3 parity fixtures (P1-R3-01 / P1-R3-02 / P2-R3-03): same
    # shape as the input/parity traces; the S0 gate compares them
    # directly with the TS production analysis of the same files.
    # The count is 8 (F1, F2, F3, F4 main, F4 declared, F5, D-02a,
    # D-02b) — the design memo's "7/7" miscounted the two F4
    # variants as one; the coordinator ruled the delivered count
    # (8) authoritative.
    for scenario_id in FIXR3_FIXTURE_IDS:
        with open(INPUT_FIXTURE_DIR / f"{scenario_id}.json",
                  encoding="utf-8") as handle:
            source_text = handle.read()
        fixture = json.loads(source_text)
        out["fixR3Traces"][scenario_id] = _trace(
            scenario_id, fixture, source_text, None)
    json.dump(out, sys.stdout, ensure_ascii=False, sort_keys=True)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
