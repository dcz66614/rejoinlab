"""Golden tests: every one of the 24 hand-written fixtures must make
the Oracle produce exactly the hand-derived expected verdict,
diagnostics, first divergence, shortest injection sequence and final
key fields in oracle/golden_expected.json.
"""

import json
from pathlib import Path

import pytest

from oracle.replay import analyze

ROOT = Path(__file__).resolve().parent.parent.parent
GOLDEN_DIR = ROOT / "fixtures" / "golden"

with open(ROOT / "oracle" / "golden_expected.json", encoding="utf-8") as handle:
    EXPECTED = json.load(handle)["traces"]

SCENARIO_IDS = [f"G0{i}" for i in range(1, 9)] + \
    [f"N{i:02d}" for i in range(1, 17)]


def load_fixture(scenario_id):
    with open(GOLDEN_DIR / f"{scenario_id}.json", encoding="utf-8") as handle:
        return json.load(handle)


@pytest.mark.parametrize("scenario_id", SCENARIO_IDS)
def test_fixture_structure(scenario_id):
    fixture = load_fixture(scenario_id)
    assert fixture["schema"] == "rejoinlab.golden/v1"
    assert fixture["scenarioId"] == scenario_id
    indices = [w["sourceIndex"] for w in fixture["events"]]
    assert indices == list(range(len(indices))), "sourceIndex must run 0..n"
    assert 1 <= len(indices) <= 40
    assert "recovery" in fixture
    assert fixture["recovery"]["strategy"] in (
        "FULL_REPLAY_FROM_START", "RESUME_FROM_CHECKPOINT",
        "REPLAY_AFTER_SOURCE_CURSOR")
    assert scenario_id in EXPECTED


@pytest.mark.parametrize("scenario_id", SCENARIO_IDS)
def test_golden_matches_hand_derived_expected(scenario_id):
    fixture = load_fixture(scenario_id)
    want = EXPECTED[scenario_id]
    target = want["diagnostics"][0] if want["diagnostics"] else None
    report = analyze(fixture, target_code=target)

    assert report["verdict"] == want["verdict"], (
        f"{scenario_id}: verdict {report['verdict']} != {want['verdict']}")
    got_codes = [d["code"] for d in report["diagnostics"]]
    assert got_codes == want["diagnostics"], (
        f"{scenario_id}: diagnostics {got_codes} != {want['diagnostics']}")
    got_first = (report.get("firstDivergence") or {}).get("sourceIndex")
    assert got_first == want["firstDivergenceSourceIndex"], (
        f"{scenario_id}: firstDivergence {got_first} != "
        f"{want['firstDivergenceSourceIndex']}")
    assert report["shortestInjectionSequence"] == \
        want["shortestInjectionSequence"], (
            f"{scenario_id}: shortest {report['shortestInjectionSequence']} "
            f"!= {want['shortestInjectionSequence']}")
    for side in ("full", "resume"):
        path = report["fullPath"] if side == "full" else report["resumePath"]
        want_side = want["finalState"][side]
        assert path is not None, f"{scenario_id}: {side} path is missing"
        assert [m["id"] for m in path["messages"]] == \
            want_side["messageOrder"], f"{scenario_id}: {side} messageOrder"
        assert [c["id"] for c in path["toolCalls"]] == \
            want_side["toolCallOrder"], f"{scenario_id}: {side} toolCallOrder"
        assert path["sharedState"] == want_side["sharedState"], \
            f"{scenario_id}: {side} sharedState"
        assert path["pendingToolCallIds"] == \
            want_side["pendingToolCallIds"], \
            f"{scenario_id}: {side} pendingToolCallIds"
        # The §13.2 report PathResult carries no runStatus (TS
        # toReportPath drops it); runStatus is checked on the parity
        # path, which carries the same value (parity path =
        # production path + runStatus).
        parity_path = (report["parityFullPath"] if side == "full"
                       else report["parityResumePath"])
        assert parity_path["runStatus"] == want_side["runStatus"], \
            f"{scenario_id}: {side} runStatus"


def test_golden_thresholds():
    """PROJECT_BOOK §9.4: 8/8 faults found, 16/16 normal pass, 0 FP/FN."""
    faults_found = 0
    normals_passed = 0
    for scenario_id in SCENARIO_IDS:
        fixture = load_fixture(scenario_id)
        want = EXPECTED[scenario_id]
        target = want["diagnostics"][0] if want["diagnostics"] else None
        report = analyze(fixture, target_code=target)
        if scenario_id.startswith("G"):
            if report["verdict"] in ("INCONSISTENT", "INCOMPLETE_TRACE"):
                faults_found += 1
        else:
            if report["verdict"] == "CONSISTENT":
                normals_passed += 1
    assert faults_found == 8
    assert normals_passed == 16
