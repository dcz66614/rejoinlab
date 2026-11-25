"""Tests for the independent reducer (oracle/reference.py):
snapshot reconciliation, pending tool calls, chunk expansion, message
reopen, duplicate tool calls, out-of-order events, JSON Patch.
"""

import copy

import pytest

from oracle.reference import (
    InvalidInput,
    expand_chunks,
    fold,
    initial_state,
    reconcile_messages_snapshot,
)


def wrap(index, event, key=None):
    return {"sourceIndex": index, "sourceEventKey": key,
            "transportEventId": None, "event": event}


def run_started(i=0, run_id="run-1"):
    return wrap(i, {"type": "RUN_STARTED", "threadId": "thread-1",
                    "runId": run_id})


def test_snapshot_reconciliation_four_rules():
    state = initial_state()
    state["messages"] = [
        {"id": "msg-a", "role": "assistant", "name": None, "content": "A",
         "segments": [{"text": "A"}], "toolCalls": [], "open": False,
         "incomplete": False},
        {"id": "msg-b", "role": "assistant", "name": None, "content": "B",
         "segments": [{"text": "B"}], "toolCalls": [], "open": False,
         "incomplete": False},
    ]
    # Rule 1: msg-b replaced, position kept. Rule 2: msg-c appended.
    # Rule 3: producer-owned msg-a absent -> removed.
    reconcile_messages_snapshot(state, [
        {"id": "msg-b", "role": "assistant", "content": "B2"},
        {"id": "msg-c", "role": "assistant", "content": "C"},
    ])
    assert [m["id"] for m in state["messages"]] == ["msg-b", "msg-c"]
    assert state["messages"][0]["content"] == "B2"


def test_snapshot_per_role_self_revoking():
    state = initial_state()
    state["messages"] = [
        {"id": "act-1", "role": "activity", "name": None, "content": "",
         "segments": [{"text": ""}], "toolCalls": [], "open": False,
         "incomplete": False, "owner": "client"},
        {"id": "msg-a", "role": "assistant", "name": None, "content": "A",
         "segments": [{"text": "A"}], "toolCalls": [], "open": False,
         "incomplete": False, "owner": "producer"},
    ]
    # Rule 4: no activity message in the snapshot -> act-1 retained.
    reconcile_messages_snapshot(state, [
        {"id": "msg-a", "role": "assistant", "content": "A"},
    ])
    assert [m["id"] for m in state["messages"]] == ["act-1", "msg-a"]
    # The snapshot declares an activity message -> act-1 is dropped.
    # (FIX-R2 D2 item 2: the snapshot message is schema-legal —
    # activity requires activityType and an object content — because
    # reconcile_messages_snapshot now validates each message with
    # _validate_message, as the wire path does.)
    reconcile_messages_snapshot(state, [
        {"id": "msg-a", "role": "assistant", "content": "A"},
        {"id": "act-2", "role": "activity", "activityType": "step",
         "content": {}},
    ])
    assert [m["id"] for m in state["messages"]] == ["msg-a", "act-2"]


def test_snapshot_message_needs_id_and_role():
    state = initial_state()
    with pytest.raises(InvalidInput):
        reconcile_messages_snapshot(state, [{"id": "x"}])


def test_snapshot_direct_call_validates_messages():
    # FIX-R2 D2 item 2: reconcile_messages_snapshot validates each
    # message with _validate_message even when called directly (the
    # wire path is already covered by validate_event in fold).
    state = initial_state()
    with pytest.raises(InvalidInput):
        reconcile_messages_snapshot(state, [
            {"id": "act-9", "role": "activity", "content": ""},
        ])
    reconcile_messages_snapshot(state, [
        {"id": "act-9", "role": "activity", "activityType": "step",
         "content": {"done": True}},
    ])
    assert [m["id"] for m in state["messages"]] == ["act-9"]


def test_pending_tool_call_cleared_by_next_run():
    events = [
        run_started(0, "run-1"),
        wrap(1, {"type": "TEXT_MESSAGE_START", "messageId": "msg-1"}),
        wrap(2, {"type": "TOOL_CALL_START", "toolCallId": "call-1",
                 "toolCallName": "confirm", "parentMessageId": "msg-1"}),
        wrap(3, {"type": "TOOL_CALL_ARGS", "toolCallId": "call-1",
                 "delta": "{}"}),
        wrap(4, {"type": "TOOL_CALL_END", "toolCallId": "call-1"}),
        wrap(5, {"type": "RUN_FINISHED", "threadId": "thread-1",
                 "runId": "run-1",
                 "outcome": {"type": "success",
                             "pendingToolCallIds": ["call-1"]}}),
    ]
    state, _, _ = fold(events)
    assert state["pendingToolCallIds"] == ["call-1"]
    assert state["runStatus"] == "FINISHED"
    state2, _, _ = fold(events + [
        run_started(6, "run-2"),
        wrap(7, {"type": "TOOL_CALL_RESULT", "messageId": "msg-r2",
                 "toolCallId": "call-1", "content": "ok"}),
    ])
    assert state2["pendingToolCallIds"] == []
    assert state2["toolCalls"][0]["result"] == "ok"


def test_chunk_expansion_text_and_tool():
    events = [
        run_started(0),
        wrap(1, {"type": "TEXT_MESSAGE_CHUNK", "messageId": "msg-1",
                 "delta": "Hel"}),
        wrap(2, {"type": "TEXT_MESSAGE_CHUNK", "delta": "lo"}),
        wrap(3, {"type": "TOOL_CALL_CHUNK", "toolCallId": "call-1",
                 "toolCallName": "search", "delta": "{}"}),
        wrap(4, {"type": "TOOL_CALL_CHUNK", "delta": ""}),
        wrap(5, {"type": "RUN_FINISHED", "threadId": "thread-1",
                 "runId": "run-1"}),
    ]
    expanded = expand_chunks(events)
    types = [w["event"]["type"] for w in expanded]
    # A tool chunk is a different lane, so it does not close the open
    # text chunk item; only the run-level event closes all lanes.
    assert types == ["RUN_STARTED", "TEXT_MESSAGE_START",
                     "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_CONTENT",
                     "TOOL_CALL_START",
                     "TOOL_CALL_ARGS", "TOOL_CALL_ARGS",
                     "TEXT_MESSAGE_END", "TOOL_CALL_END",
                     "RUN_FINISHED"]
    state, diagnostics, _ = fold(events)
    assert not diagnostics
    assert state["messages"][0]["content"] == "Hello"
    assert state["toolCalls"][0]["args"] == "{}"


def test_chunk_first_chunk_without_id_is_invalid():
    with pytest.raises(InvalidInput):
        expand_chunks([wrap(0, {"type": "TEXT_MESSAGE_CHUNK",
                                "delta": "x"})])
    with pytest.raises(InvalidInput):
        expand_chunks([wrap(0, {"type": "TOOL_CALL_CHUNK",
                                "delta": "x"})])


def test_message_reopen_keeps_segments():
    events = [
        run_started(0),
        wrap(1, {"type": "TEXT_MESSAGE_START", "messageId": "msg-1"}),
        wrap(2, {"type": "TEXT_MESSAGE_CONTENT", "messageId": "msg-1",
                 "delta": "Hello, "}),
        wrap(3, {"type": "TEXT_MESSAGE_END", "messageId": "msg-1"}),
        wrap(4, {"type": "TEXT_MESSAGE_START", "messageId": "msg-1"}),
        wrap(5, {"type": "TEXT_MESSAGE_CONTENT", "messageId": "msg-1",
                 "delta": "world."}),
        wrap(6, {"type": "TEXT_MESSAGE_END", "messageId": "msg-1"}),
    ]
    state, diagnostics, _ = fold(events)
    assert not diagnostics
    assert len(state["messages"]) == 1
    assert state["messages"][0]["content"] == "Hello, world."
    assert [s["text"] for s in state["messages"][0]["segments"]] == \
        ["Hello, ", "world."]


def test_message_reopen_role_change_is_diagnosed():
    events = [
        run_started(0),
        wrap(1, {"type": "TEXT_MESSAGE_START", "messageId": "msg-1",
                 "role": "assistant"}),
        wrap(2, {"type": "TEXT_MESSAGE_END", "messageId": "msg-1"}),
        wrap(3, {"type": "TEXT_MESSAGE_START", "messageId": "msg-1",
                 "role": "user"}),
    ]
    _, diagnostics, _ = fold(events)
    assert [d["code"] for d in diagnostics] == ["OUT_OF_ORDER"]


def test_duplicate_tool_call_on_replay():
    prefix = [
        run_started(0),
        wrap(1, {"type": "TEXT_MESSAGE_START", "messageId": "msg-1"}),
        wrap(2, {"type": "TOOL_CALL_START", "toolCallId": "call-1",
                 "toolCallName": "search", "parentMessageId": "msg-1"}),
        wrap(3, {"type": "TOOL_CALL_ARGS", "toolCallId": "call-1",
                 "delta": "{}"}),
        wrap(4, {"type": "TOOL_CALL_END", "toolCallId": "call-1"}),
    ]
    base, _, _ = fold(prefix)
    _, diagnostics, _ = fold(prefix, initial=base, applied_through=4)
    assert [d["code"] for d in diagnostics] == ["DUPLICATE_TOOL_CALL"]
    assert diagnostics[0]["sourceIndex"] == 2


def test_content_without_start_is_out_of_order():
    _, diagnostics, _ = fold([
        run_started(0),
        wrap(1, {"type": "TEXT_MESSAGE_CONTENT", "messageId": "msg-1",
                 "delta": "orphan"}),
    ])
    assert [d["code"] for d in diagnostics] == ["OUT_OF_ORDER"]


def test_result_without_call_is_out_of_order():
    _, diagnostics, _ = fold([
        run_started(0),
        wrap(1, {"type": "TOOL_CALL_RESULT", "messageId": "msg-r",
                 "toolCallId": "call-9", "content": "x"}),
    ])
    assert [d["code"] for d in diagnostics] == ["OUT_OF_ORDER"]


def test_empty_delta_is_legal():
    state, diagnostics, _ = fold([
        run_started(0),
        wrap(1, {"type": "TEXT_MESSAGE_START", "messageId": "msg-1"}),
        wrap(2, {"type": "TEXT_MESSAGE_CONTENT", "messageId": "msg-1",
                 "delta": ""}),
        wrap(3, {"type": "TEXT_MESSAGE_END", "messageId": "msg-1"}),
    ])
    assert not diagnostics
    assert state["messages"][0]["content"] == ""


def test_state_delta_atomicity():
    events = [
        run_started(0),
        wrap(1, {"type": "STATE_SNAPSHOT", "snapshot": {"a": 1}}),
        wrap(2, {"type": "STATE_DELTA", "delta": [
            {"op": "replace", "path": "/a", "value": 2},
            {"op": "replace", "path": "/missing", "value": 3}]}),
    ]
    state, diagnostics, _ = fold(events)
    assert state["sharedState"] == {"a": 1}  # failed patch: no partial apply
    assert [d["code"] for d in diagnostics] == ["SNAPSHOT_MISMATCH"]


def test_unknown_patch_op_dropped_with_warning():
    events = [
        run_started(0),
        wrap(1, {"type": "STATE_SNAPSHOT", "snapshot": {"a": 1}}),
        wrap(2, {"type": "STATE_DELTA", "delta": [
            {"op": "frobnicate", "path": "/a", "value": 2},
            {"op": "replace", "path": "/a", "value": 5}]}),
    ]
    state, diagnostics, _ = fold(events)
    assert state["sharedState"] == {"a": 5}
    assert [d["code"] for d in diagnostics] == ["UNKNOWN_PATCH_OP"]


def test_state_delta_move_and_test():
    events = [
        run_started(0),
        wrap(1, {"type": "STATE_SNAPSHOT",
                 "snapshot": {"a": 1, "b": 2}}),
        wrap(2, {"type": "STATE_DELTA", "delta": [
            {"op": "test", "path": "/a", "value": 1},
            {"op": "move", "from": "/b", "path": "/c"}]}),
    ]
    state, diagnostics, _ = fold(events)
    assert not diagnostics
    assert state["sharedState"] == {"a": 1, "c": 2}


def test_run_error_first_is_terminal():
    state, diagnostics, _ = fold([
        wrap(0, {"type": "RUN_ERROR", "message": "boom"}),
    ])
    assert not diagnostics
    assert state["runStatus"] == "ERROR"


def test_timestamp_never_reorders():
    events = [
        wrap(0, {"type": "RUN_STARTED", "threadId": "thread-1",
                 "runId": "run-1", "timestamp": 1000}),
        wrap(1, {"type": "TEXT_MESSAGE_START", "messageId": "msg-1",
                 "timestamp": 100}),
        wrap(2, {"type": "TEXT_MESSAGE_CONTENT", "messageId": "msg-1",
                 "delta": "x", "timestamp": 50}),
    ]
    state, _, _ = fold(events)
    assert state["messages"][0]["content"] == "x"


def test_unsupported_event_raises():
    from oracle.reference import UnsupportedEvent
    with pytest.raises(UnsupportedEvent):
        fold([wrap(0, {"type": "STEP_STARTED"})])


def test_missing_required_field_is_invalid():
    with pytest.raises(InvalidInput):
        fold([wrap(0, {"type": "RUN_STARTED", "threadId": "t"})])


def test_fold_does_not_mutate_input():
    events = [run_started(0),
              wrap(1, {"type": "TEXT_MESSAGE_START", "messageId": "msg-1"})]
    snapshot = copy.deepcopy(events)
    fold(events)
    assert events == snapshot
