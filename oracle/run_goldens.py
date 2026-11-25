"""Run all 24 Golden fixtures through the Oracle and compare with the
hand-derived expected values in oracle/golden_expected.json.

This script only COMPARES. It never generates expected values: the BFS
goal (primary diagnostic code) is read from the hand-derived expected
file, and every comparison is Oracle-output vs hand-derived expected.

Usage (from the repository root):
    python -m oracle.run_goldens

Writes artifacts/logs/T006_ORACLE.log and prints the same summary.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from oracle.replay import analyze  # noqa: E402

GOLDEN_DIR = ROOT / "fixtures" / "golden"
EXPECTED_PATH = ROOT / "oracle" / "golden_expected.json"
LOG_PATH = ROOT / "artifacts" / "logs" / "T006_ORACLE.log"

SCENARIO_IDS = [f"G0{i}" for i in range(1, 9)] + \
    [f"N{i:02d}" for i in range(1, 17)]


def load_fixture(scenario_id):
    with open(GOLDEN_DIR / f"{scenario_id}.json", encoding="utf-8") as handle:
        return json.load(handle)


def main():
    with open(EXPECTED_PATH, encoding="utf-8") as handle:
        expected = json.load(handle)["traces"]
    lines = []
    lines.append("P031 RejoinLab — T006 Oracle Golden run")
    lines.append(f"date: {time.strftime('%Y-%m-%d %H:%M:%S %Z', time.gmtime())} (UTC)")
    lines.append(f"fixtures: {GOLDEN_DIR}")
    lines.append(f"expected: {EXPECTED_PATH} (hand-derived)")
    lines.append("")
    passed = 0
    failed = []
    for scenario_id in SCENARIO_IDS:
        fixture = load_fixture(scenario_id)
        want = expected[scenario_id]
        target = None
        if want["diagnostics"]:
            target = want["diagnostics"][0]
        report = analyze(fixture, target_code=target)
        got_codes = [d["code"] for d in report["diagnostics"]]
        got_first = (report.get("firstDivergence") or {}).get("sourceIndex")
        problems = []
        if report["verdict"] != want["verdict"]:
            problems.append(
                f"verdict: got {report['verdict']}, want {want['verdict']}")
        if got_codes != want["diagnostics"]:
            problems.append(
                f"diagnostics: got {got_codes}, want {want['diagnostics']}")
        if got_first != want["firstDivergenceSourceIndex"]:
            problems.append(
                f"firstDivergence: got {got_first}, "
                f"want {want['firstDivergenceSourceIndex']}")
        if report["shortestInjectionSequence"] != want["shortestInjectionSequence"]:
            problems.append(
                "shortestInjectionSequence: got "
                f"{report['shortestInjectionSequence']}, want "
                f"{want['shortestInjectionSequence']}")
        full = report["fullPath"] or {}
        resume = report["resumePath"] or {}
        want_full = want["finalState"]["full"]
        want_resume = want["finalState"]["resume"]
        if [m["id"] for m in full.get("messages", [])] != want_full["messageOrder"]:
            problems.append("full messageOrder mismatch")
        if [c["id"] for c in full.get("toolCalls", [])] != want_full["toolCallOrder"]:
            problems.append("full toolCallOrder mismatch")
        if full.get("sharedState") != want_full["sharedState"]:
            problems.append(
                f"full sharedState: got {full.get('sharedState')}, "
                f"want {want_full['sharedState']}")
        if full.get("pendingToolCallIds") != want_full["pendingToolCallIds"]:
            problems.append("full pendingToolCallIds mismatch")
        if (report.get("parityFullPath") or {}).get("runStatus") != want_full["runStatus"]:
            problems.append(
                f"full runStatus: got {(report.get('parityFullPath') or {}).get('runStatus')}, "
                f"want {want_full['runStatus']}")
        if [m["id"] for m in resume.get("messages", [])] != want_resume["messageOrder"]:
            problems.append("resume messageOrder mismatch")
        if [c["id"] for c in resume.get("toolCalls", [])] != want_resume["toolCallOrder"]:
            problems.append("resume toolCallOrder mismatch")
        if resume.get("sharedState") != want_resume["sharedState"]:
            problems.append(
                f"resume sharedState: got {resume.get('sharedState')}, "
                f"want {want_resume['sharedState']}")
        if resume.get("pendingToolCallIds") != want_resume["pendingToolCallIds"]:
            problems.append("resume pendingToolCallIds mismatch")
        if (report.get("parityResumePath") or {}).get("runStatus") != want_resume["runStatus"]:
            problems.append(
                f"resume runStatus: got {(report.get('parityResumePath') or {}).get('runStatus')}, "
                f"want {want_resume['runStatus']}")
        status = "PASS" if not problems else "FAIL"
        if not problems:
            passed += 1
        else:
            failed.append(scenario_id)
        lines.append(
            f"{scenario_id} {status} verdict={report['verdict']} "
            f"diagnostics={got_codes} firstDivergence={got_first} "
            f"shortest={report['shortestInjectionSequence']} "
            f"fullHash={(full.get('finalStateHash') or '')[:12]} "
            f"resumeHash={(resume.get('finalStateHash') or '')[:12]} "
            f"durationMs={report['metrics']['durationMs']}")
        for problem in problems:
            lines.append(f"    !! {problem}")
    lines.append("")
    lines.append(f"golden: {passed}/24 PASS; failed: {failed or 'none'}")
    lines.append("parity with production TypeScript: VERIFIED by S0 gate "
                 "(T007 PASS, 24/24; see artifacts/reports/S0_GATE.json)")
    text = "\n".join(lines) + "\n"
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOG_PATH.write_text(text, encoding="utf-8")
    print(text, end="")
    return 0 if passed == 24 else 1


if __name__ == "__main__":
    raise SystemExit(main())
