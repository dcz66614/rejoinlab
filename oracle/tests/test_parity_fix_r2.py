"""FIX-R2 (P1-R2-02) reverse-regression tests: the five RunState fields
must enter the parity hash.

Each test builds two trajectories that differ ONLY in one RunState
field and asserts the Oracle parity hash (and the production state
hash) differs. Before the FIX-R2 Oracle change these tests FAIL: the
Oracle never stored the fields, so both trajectories hashed alike
(the leak the R2 final review demonstrated with RUN_FINISHED.result).
After the fix they PASS.

These tests use in-memory fixtures only; the cross-language (TS vs
Oracle) assertions for the same fields live in tests/s0/gate.test.ts
(new parity fixtures parity_*.json).
"""

import copy

import pytest

from oracle.canonical import state_hash
from oracle.parity import parity_state_hash
from oracle.replay import evaluate
from oracle.reference import fold


def wrap(index, event, key=None):
    return {"sourceIndex": index, "sourceEventKey": key,
            "transportEventId": None, "event": event}


def base_run_events():
    """A minimal valid single run: START, one text message, FINISHED."""
    return [
        wrap(0, {"type": "RUN_STARTED", "threadId": "thread-1",
                 "runId": "run-1"}),
        wrap(1, {"type": "TEXT_MESSAGE_START", "messageId": "msg-1"}),
        wrap(2, {"type": "TEXT_MESSAGE_CONTENT", "messageId": "msg-1",
                 "delta": "Hi"}),
        wrap(3, {"type": "TEXT_MESSAGE_END", "messageId": "msg-1"}),
        wrap(4, {"type": "RUN_FINISHED", "threadId": "thread-1",
                 "runId": "run-1"}),
    ]


def fixture_with(events, scenario_id="parity-probe"):
    return {
        "scenarioId": scenario_id,
        "events": events,
        "recovery": {"strategy": "RESUME_FROM_CHECKPOINT",
                     "disconnectAfter": 2,
                     "resumeAfterSourceIndex": 2,
                     "checkpoint": None, "injections": []},
    }


def _hashes(events):
    state, _, _ = fold(events)
    return parity_state_hash(state), state_hash(state)


def test_r04_result_only_difference_changes_hashes():
    """R-04 (the R2 counterexample): only RUN_FINISHED.result differs."""
    ok = base_run_events()
    changed = base_run_events()
    ok[4]["event"] = dict(ok[4]["event"],
                          result={"summary": "ok"})
    changed[4]["event"] = dict(changed[4]["event"],
                               result={"summary": "changed"})
    parity_ok, prod_ok = _hashes(ok)
    parity_changed, prod_changed = _hashes(changed)
    assert prod_ok != prod_changed
    assert parity_ok != parity_changed


def test_r04_result_falsy_values_are_stored():
    """result 0 / false / "" / {} / null must each hash differently
    from 'absent' (guards truthiness / `is not None` sentinel bugs)."""
    variants = []
    for result in (0, False, "", {}, None):
        events = base_run_events()
        event = dict(events[4]["event"])
        event["result"] = result
        events[4]["event"] = event
        variants.append(_hashes(events))
    absent = _hashes(base_run_events())
    assert absent not in variants
    assert len({v[0] for v in variants}) == 5
    assert len({v[1] for v in variants}) == 5


def test_r01_parent_run_id_changes_hashes():
    """R-01: only RUN_STARTED.parentRunId differs."""
    first = base_run_events()
    second = base_run_events()
    second[0]["event"] = dict(second[0]["event"],
                              parentRunId="run-p")
    assert _hashes(first) != _hashes(second)


def test_r02_protocol_version_changes_hashes():
    """R-02: only RUN_STARTED.protocolVersion differs (and present
    vs absent)."""
    absent = base_run_events()
    present = base_run_events()
    present[0]["event"] = dict(present[0]["event"],
                               protocolVersion="1.1")
    other = base_run_events()
    other[0]["event"] = dict(other[0]["event"],
                             protocolVersion="1.0")
    assert _hashes(absent) != _hashes(present)
    assert _hashes(present) != _hashes(other)


def test_r03_outcome_changes_hashes():
    """R-03: outcome present vs absent, and [] vs missing
    pendingToolCallIds inside the outcome."""
    absent = base_run_events()
    with_outcome = base_run_events()
    with_outcome[4]["event"] = dict(
        with_outcome[4]["event"],
        outcome={"type": "success", "pendingToolCallIds": []})
    without_list = base_run_events()
    without_list[4]["event"] = dict(
        without_list[4]["event"], outcome={"type": "success"})
    assert _hashes(absent) != _hashes(with_outcome)
    assert _hashes(with_outcome) != _hashes(without_list)


def test_r05_error_message_and_code_change_hashes():
    """R-05: RUN_ERROR message / code differences change the hash."""
    def error_events(message, code=None):
        events = [
            wrap(0, {"type": "RUN_STARTED", "threadId": "thread-1",
                     "runId": "run-1"}),
            wrap(1, {"type": "TEXT_MESSAGE_START", "messageId": "msg-1"}),
        ]
        error = {"type": "RUN_ERROR", "message": message}
        if code is not None:
            error["code"] = code
        events.append(wrap(2, error))
        return events
    a = _hashes(error_events("upstream failed"))
    b = _hashes(error_events("downstream failed"))
    c = _hashes(error_events("upstream failed", "UPSTREAM_500"))
    assert a != b
    assert a != c


def test_r05_error_without_open_run_stores_nothing():
    """N11 shape: RUN_ERROR before any RUN_STARTED builds no run
    entry, so the run list stays empty on both sides."""
    state, _, _ = fold([
        wrap(0, {"type": "RUN_ERROR", "message": "failed to start",
                 "code": "START_FAILED"}),
    ])
    assert state["runs"] == []


def test_r06_first_divergence_uses_complete_hash():
    """R-06: two folds differing only in RUN_FINISHED.result must
    diverge at the RUN_FINISHED step (before the fix the Oracle
    reported no divergence at all)."""
    from oracle.diff import find_first_divergence
    from oracle.reference import initial_state
    ok = base_run_events()
    changed = base_run_events()
    ok[4]["event"] = dict(ok[4]["event"], result={"summary": "ok"})
    changed[4]["event"] = dict(changed[4]["event"],
                               result={"summary": "changed"})
    _, _, full_history = fold(ok, collect_history=True)
    _, _, resume_history = fold(changed, collect_history=True)
    found = find_first_divergence(full_history, resume_history,
                                  initial_state(), -1)
    assert found is not None
    assert found["sourceIndex"] == 4
    assert found["fullStateHash"] != found["resumeStateHash"]
    assert any(d["jsonPointer"].startswith("/runs/0/result")
               for d in found["differences"])


def test_r11_parity_run_keys_cover_production_run_keys():
    """R-11 (Oracle side): the parity projection's run key set must
    cover the production projection's run key set, so a future
    production field cannot silently drop out of parity again."""
    from oracle.parity import (
        parity_project_state, project_state_production)
    events = base_run_events()
    events[0]["event"] = dict(events[0]["event"],
                              parentRunId="run-p", protocolVersion="1.1")
    events[4]["event"] = dict(
        events[4]["event"],
        outcome={"type": "success", "pendingToolCallIds": []},
        result={"summary": "ok"})
    state, _, _ = fold(events)
    parity_runs = parity_project_state(state)["runs"]
    prod_runs = project_state_production(state)["runs"]
    assert len(parity_runs) == len(prod_runs) == 1
    assert set(prod_runs[0].keys()) <= set(parity_runs[0].keys())
    assert parity_runs[0]["parentRunId"] == "run-p"
    assert parity_runs[0]["protocolVersion"] == "1.1"
    assert parity_runs[0]["outcome"] == {
        "type": "success", "pendingToolCallIds": []}
    assert parity_runs[0]["result"] == {"summary": "ok"}


def test_r08_visited_states_is_fold_history_length():
    """R-08: evaluate() metrics.visitedStates must equal the full +
    resume fold history lengths (TS planner.ts:1331)."""
    from oracle.replay import (
        build_resume_stream, resolve_checkpoint)
    from oracle.reference import fold as ref_fold
    import json
    from pathlib import Path
    golden = json.loads(
        (Path(__file__).resolve().parent.parent.parent
         / "fixtures" / "golden" / "N01.json").read_text(
             encoding="utf-8"))
    result = evaluate(golden)
    _, _, full_history = ref_fold(golden["events"], collect_history=True)
    base, checkpoint_index = resolve_checkpoint(golden)
    stream = build_resume_stream(golden, checkpoint_index)
    _, _, resume_history = ref_fold(
        stream, initial=base, applied_through=checkpoint_index,
        collect_history=True)
    assert result["metrics"]["visitedStates"] == (
        len(full_history) + len(resume_history))
