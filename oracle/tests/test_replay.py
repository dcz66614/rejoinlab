"""Tests for dual-track replay, fault injection and BFS
(oracle/replay.py), plus the §8.1 size/search bounds.
"""

import copy
import json
from pathlib import Path

import pytest

from oracle.replay import (
    MAX_EVENTS,
    OPERATOR_ORDER,
    _legal_baseline,
    analyze,
    apply_injection,
    bfs_shortest,
    build_resume_stream,
    evaluate,
    resolve_checkpoint,
)
from oracle.reference import InvalidInput, initial_state

ROOT = Path(__file__).resolve().parent.parent.parent
GOLDEN_DIR = ROOT / "fixtures" / "golden"


def load_fixture(scenario_id):
    with open(GOLDEN_DIR / f"{scenario_id}.json", encoding="utf-8") as handle:
        return json.load(handle)


def test_operator_order_is_the_frozen_lexicographic_order():
    assert OPERATOR_ORDER == (
        "CURSOR_SKIP", "DROP_EVENT", "DUPLICATE_EVENT",
        "MESSAGE_ID_REMAP", "REPLAY_PREFIX", "STALE_SNAPSHOT",
        "SWAP_ADJACENT", "TRUNCATE_STREAM")


def test_bfs_is_deterministic():
    fixture = load_fixture("G01")
    first, first_visited = bfs_shortest(fixture, "DUPLICATE_TOOL_CALL")
    second, second_visited = bfs_shortest(fixture, "DUPLICATE_TOOL_CALL")
    assert first == second == ["REPLAY_PREFIX"]
    assert first_visited == second_visited
    assert first_visited > 0


def test_bfs_finds_each_fault_characteristic_sequence():
    assert bfs_shortest(load_fixture("G02"), "MESSAGE_REORDER")[0] == \
        ["MESSAGE_ID_REMAP"]
    assert bfs_shortest(load_fixture("G03"), "MESSAGE_REORDER")[0] == \
        ["MESSAGE_ID_REMAP"]
    assert bfs_shortest(load_fixture("G04"), "LOST_EVENT")[0] == ["DROP_EVENT"]
    assert bfs_shortest(load_fixture("G05"), "OUT_OF_ORDER")[0] == \
        ["SWAP_ADJACENT"]
    assert bfs_shortest(load_fixture("G06"), "SNAPSHOT_MISMATCH")[0] == \
        ["STALE_SNAPSHOT"]
    assert bfs_shortest(load_fixture("G07"), "SUSPECTED_DUPLICATE")[0] == \
        ["DUPLICATE_EVENT"]
    # G08: the trace itself is truncated; the empty sequence suffices.
    assert bfs_shortest(load_fixture("G08"), "TRUNCATED_RUN")[0] == []


def test_bfs_normal_fixture_breaks_with_drop_event():
    for scenario_id in ("N01", "N05", "N08", "N16"):
        assert bfs_shortest(load_fixture(scenario_id), None)[0] == ["DROP_EVENT"]


def test_bfs_node_budget_returns_inconclusive():
    with pytest.raises(InvalidInput):
        bfs_shortest(load_fixture("G01"), "DUPLICATE_TOOL_CALL",
                     max_nodes=5)


def test_event_limit_returns_inconclusive():
    fixture = load_fixture("N01")
    big = copy.deepcopy(fixture)
    padding = []
    for i in range(MAX_EVENTS + 1):
        padding.append({"sourceIndex": i, "sourceEventKey": None,
                        "transportEventId": None,
                        "event": {"type": "TEXT_MESSAGE_CONTENT",
                                  "messageId": "msg-1", "delta": "x"}})
    big["events"] = padding
    result = evaluate(big)
    assert result["verdict"] == "INCONCLUSIVE_LIMIT"


def test_event_limit_still_uses_limit_exceeded():
    """True §8.1 overflow keeps LIMIT_EXCEEDED / INCONCLUSIVE_LIMIT."""
    fixture = load_fixture("N01")
    big = copy.deepcopy(fixture)
    big["events"] = [
        {"sourceIndex": i, "sourceEventKey": None,
         "transportEventId": None,
         "event": {"type": "TEXT_MESSAGE_CONTENT",
                   "messageId": "msg-1", "delta": "x"}}
        for i in range(MAX_EVENTS + 1)]
    result = evaluate(big)
    assert result["verdict"] == "INCONCLUSIVE_LIMIT"
    assert [d["code"] for d in result["diagnostics"]] == ["LIMIT_EXCEEDED"]
    assert result["diagnostics"][0]["severity"] == "WARNING"


def test_unsupported_event_is_invalid_input_not_limit():
    """A known-but-unsupported event type is INVALID_INPUT (§7), not a
    §8.1 bound overflow: no LIMIT_EXCEEDED / INCONCLUSIVE_LIMIT."""
    fixture = load_fixture("N01")
    bad = copy.deepcopy(fixture)
    bad["events"] = bad["events"][:2] + [
        {"sourceIndex": 2, "sourceEventKey": None,
         "transportEventId": None,
         "event": {"type": "STEP_STARTED"}}]
    result = evaluate(bad)
    assert result["verdict"] == "INVALID_INPUT"
    assert [d["code"] for d in result["diagnostics"]] == ["INVALID_INPUT"]
    assert result["diagnostics"][0]["severity"] == "CRITICAL"


def test_malformed_event_code_is_invalid_input_not_divergent():
    """A malformed event reports diagnostic code INVALID_INPUT, not
    DIVERGENT_STATE (§6 reserves that code for unequal canonical
    states)."""
    fixture = load_fixture("N01")
    bad = copy.deepcopy(fixture)
    bad["events"] = bad["events"][:1] + [
        {"sourceIndex": 1, "sourceEventKey": None,
         "transportEventId": None,
         "event": {"type": "RUN_STARTED", "threadId": "t"}}]
    result = evaluate(bad)
    assert result["verdict"] == "INVALID_INPUT"
    assert [d["code"] for d in result["diagnostics"]] == ["INVALID_INPUT"]
    assert result["diagnostics"][0]["severity"] == "CRITICAL"


def test_each_injection_operator():
    fixture = load_fixture("N02")
    base, checkpoint_index = resolve_checkpoint(fixture)
    stream = build_resume_stream(fixture, checkpoint_index)
    assert [w["sourceIndex"] for w in stream] == [4, 5, 6]

    dropped_stream, _, dropped, changed = apply_injection(
        stream, base, fixture, {"op": "DROP_EVENT", "sourceIndex": 4})
    assert changed and [w["sourceIndex"] for w in dropped_stream] == [5, 6]
    assert [w["sourceIndex"] for w in dropped] == [4]

    dup_stream, _, _, changed = apply_injection(
        stream, base, fixture, {"op": "DUPLICATE_EVENT", "sourceIndex": 4})
    assert changed and [w["sourceIndex"] for w in dup_stream] == [4, 4, 5, 6]

    swapped, _, _, changed = apply_injection(
        stream, base, fixture, {"op": "SWAP_ADJACENT", "sourceIndex": 4})
    assert changed and [w["sourceIndex"] for w in swapped] == [5, 4, 6]

    truncated, _, _, changed = apply_injection(
        stream, base, fixture, {"op": "TRUNCATE_STREAM", "sourceIndex": 6})
    assert changed and [w["sourceIndex"] for w in truncated] == [4, 5]

    # CURSOR_SKIP over already-covered indices is a legal no-op.
    _, _, _, changed = apply_injection(
        stream, base, fixture,
        {"op": "CURSOR_SKIP", "from": 2, "to": 3})
    assert not changed

    # STALE_SNAPSHOT is inapplicable: N02 has no STATE_SNAPSHOT.
    _, _, _, changed = apply_injection(
        stream, base, fixture, {"op": "STALE_SNAPSHOT"})
    assert not changed


def test_message_id_remap_moves_to_end():
    fixture = _legal_baseline(load_fixture("G02"))
    base, checkpoint_index = resolve_checkpoint(fixture)
    # The legal baseline (computed checkpoint) keeps msg-a first.
    assert [m["id"] for m in base["messages"]] == ["msg-a", "msg-r1"]
    stream = build_resume_stream(fixture, checkpoint_index)
    remapped_stream, remapped_base, _, changed = apply_injection(
        stream, base, fixture,
        {"op": "MESSAGE_ID_REMAP", "messageId": "msg-a",
         "newMessageId": "msg-a-remapped"})
    assert changed
    assert [m["id"] for m in remapped_base["messages"]] == \
        ["msg-r1", "msg-a-remapped"]


def test_replay_prefix_reproduces_g01():
    fixture = _legal_baseline(load_fixture("G01"))
    base, checkpoint_index = resolve_checkpoint(fixture)
    stream = build_resume_stream(fixture, checkpoint_index)
    assert [w["sourceIndex"] for w in stream] == [5, 6, 7, 8]
    prefixed, _, _, changed = apply_injection(
        stream, base, fixture, {"op": "REPLAY_PREFIX"})
    assert changed
    assert [w["sourceIndex"] for w in prefixed] == \
        [0, 1, 2, 3, 4, 5, 6, 7, 8]


def test_unknown_injection_operator_is_invalid():
    fixture = load_fixture("N01")
    base, checkpoint_index = resolve_checkpoint(fixture)
    stream = build_resume_stream(fixture, checkpoint_index)
    with pytest.raises(InvalidInput):
        apply_injection(stream, base, fixture, {"op": "NOPE"})


def test_first_divergence_g04_is_the_dropped_event():
    result = evaluate(load_fixture("G04"))
    assert result["verdict"] == "INCONSISTENT"
    assert result["firstDivergence"]["sourceIndex"] == 3


def test_g08_is_incomplete_not_inconsistent():
    result = evaluate(load_fixture("G08"))
    assert result["verdict"] == "INCOMPLETE_TRACE"
    assert [d["code"] for d in result["diagnostics"]] == ["TRUNCATED_RUN"]
    assert result["firstDivergence"]["sourceIndex"] == 4


def test_analyze_report_shape():
    report = analyze(load_fixture("N01"))
    assert report["schema"] == "rejoinlab.report/v1"
    assert report["specVersion"] == "1.0.2"
    assert report["protocolVersion"] == "1.0"
    assert report["scenarioId"] == "N01"
    assert report["verdict"] == "CONSISTENT"
    assert report["input"]["eventCount"] == 5
    assert len(report["input"]["sourceSha256"]) == 64
    assert report["fullPath"]["finalStateHash"] == \
        report["resumePath"]["finalStateHash"]
    assert report["shortestInjectionSequence"] == ["DROP_EVENT"]


def test_full_replay_from_empty_base():
    base, checkpoint_index = resolve_checkpoint(load_fixture("N06"))
    assert checkpoint_index == -1
    assert base == initial_state()
