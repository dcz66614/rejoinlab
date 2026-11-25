"""Tests for RUN_STARTED.input seeding (FIX-R1, P1-R1-02).

The Oracle implements input seeding independently (oracle/reference.py
_seed_run_input), from PROJECT_BOOK §3.3 and the TS behaviour notes;
these tests pin the fold behaviour, and tests/s0/gate.test.ts proves
the cross-language parity against the TypeScript production code on
the fixtures in oracle/tests/fixtures/input_*.json.
"""

import pytest

from oracle.reference import InvalidInput, fold, initial_state, validate_event
from oracle.replay import evaluate


def wrap(index, event, key=None):
    return {"sourceIndex": index, "sourceEventKey": key,
            "transportEventId": None, "event": event}


def run_started(i=0, run_id="run-1", input=None):
    event = {"type": "RUN_STARTED", "threadId": "thread-1",
             "runId": run_id}
    if input is not None:
        event["input"] = input
    return wrap(i, event)


def run_finished(i, run_id="run-1"):
    return wrap(i, {"type": "RUN_FINISHED", "threadId": "thread-1",
                    "runId": run_id})


def tool_call_open(i0, call_id="call-1", parent="msg-1"):
    return [
        wrap(i0, {"type": "TEXT_MESSAGE_START", "messageId": parent}),
        wrap(i0 + 1, {"type": "TOOL_CALL_START", "toolCallId": call_id,
                      "toolCallName": "search", "parentMessageId": parent}),
        wrap(i0 + 2, {"type": "TOOL_CALL_ARGS", "toolCallId": call_id,
                      "delta": '{"q":"weather"}'}),
        wrap(i0 + 3, {"type": "TOOL_CALL_END", "toolCallId": call_id}),
        wrap(i0 + 4, {"type": "TEXT_MESSAGE_END", "messageId": parent}),
    ]


def tool_input(mid, call_id, content="sunny"):
    return {"id": mid, "role": "tool", "toolCallId": call_id,
            "content": content}


def test_input_seeds_messages_state_and_owners():
    events = [run_started(0, "run-1", {
        "threadId": "thread-1", "runId": "run-1",
        "messages": [
            {"id": "msg-u1", "role": "user", "content": "Hello"},
            {"id": "msg-a1", "role": "assistant", "content": "I can help.",
             "toolCalls": [{"id": "call-9", "type": "function",
                            "function": {"name": "search",
                                         "arguments": '{"q":"x"}'}}]},
            {"id": "msg-r0", "role": "reasoning", "content": "thinking..."}],
        "state": {"count": 7}})]
    state, diags, _ = fold(events)
    assert state["sharedState"] == {"count": 7}
    assert [m["id"] for m in state["messages"]] == [
        "msg-u1", "msg-a1", "msg-r0"]
    assert state["messages"][0]["owner"] == "producer"
    assert state["messages"][0]["segments"] == [{"text": "Hello"}]
    # toolCalls passthrough (ids only in the parity projection).
    assert state["messages"][1]["toolCalls"][0]["id"] == "call-9"
    # reasoning is client-owned history the producer does not track.
    assert state["messages"][2]["owner"] == "client"
    # Oracle messages carry open/incomplete flags, not a status string:
    # closed == not open and not incomplete.
    assert state["messages"][2]["open"] is False
    assert state["messages"][2]["incomplete"] is False
    assert diags == []


def test_input_empty_and_missing_default_to_empty_baseline():
    state, _, _ = fold([run_started(0, "run-1", {
        "threadId": "thread-1", "runId": "run-1", "messages": []})])
    assert state["sharedState"] == {}
    assert state["messages"] == []
    state, _, _ = fold([run_started(0, "run-1")])
    assert state["sharedState"] == {}
    # No baseline at all before any RUN_STARTED: None, not {}.
    assert initial_state()["sharedState"] is None


def test_input_state_adopted_only_without_baseline():
    events = [
        run_started(0, "run-1", {"threadId": "thread-1", "runId": "run-1",
                                 "messages": [], "state": {"count": 1}}),
        run_finished(1, "run-1"),
        run_started(2, "run-2", {"threadId": "thread-1", "runId": "run-2",
                                 "messages": [], "state": {"count": 99}}),
    ]
    state, diags, _ = fold(events)
    assert state["sharedState"] == {"count": 1}
    assert [d["code"] for d in diags] == ["SNAPSHOT_MISMATCH"]
    assert diags[0]["severity"] == "CRITICAL"
    assert diags[0]["sourceIndex"] == 2


def test_replayed_run_started_does_not_reseed():
    events = [
        run_started(0, "run-1", {"threadId": "thread-1", "runId": "run-1",
                                 "messages": [], "state": {"count": 7}}),
        wrap(1, {"type": "STATE_DELTA",
                 "delta": [{"op": "replace", "path": "/count",
                            "value": 8}]}),
        # Replay of the same RUN_STARTED over state that already holds
        # the run and the newer count: re-activate, do NOT re-seed.
        run_started(2, "run-1", {"threadId": "thread-1", "runId": "run-1",
                                 "messages": [], "state": {"count": 7}}),
    ]
    state, diags, _ = fold(events)
    assert state["sharedState"] == {"count": 8}
    assert diags == []


def test_input_tool_message_marks_call_resulted():
    events = [
        run_started(0, "run-1"),
        *tool_call_open(1),
        run_finished(6, "run-1"),
        run_started(7, "run-2", {"threadId": "thread-1", "runId": "run-2",
                                 "messages": [tool_input("msg-r1", "call-1")]}),
    ]
    state, diags, _ = fold(events)
    call = state["toolCalls"][0]
    assert call["open"] is False
    assert call["result"] == "sunny"
    assert call["resultMessageId"] == "msg-r1"
    assert state["pendingToolCallIds"] == []
    assert [m["id"] for m in state["messages"]] == ["msg-1", "msg-r1"]
    assert state["messages"][1]["toolCallId"] == "call-1"
    assert diags == []


def test_input_tool_message_unknown_call_recorded_not_invented():
    events = [
        run_started(0, "run-1", {"threadId": "thread-1", "runId": "run-1",
                                 "messages": [tool_input("msg-rx", "call-9",
                                                         "unknown")]}),
    ]
    state, diags, _ = fold(events)
    assert [m["id"] for m in state["messages"]] == ["msg-rx"]
    assert state["messages"][0]["content"] == "unknown"
    assert state["toolCalls"] == []
    # No diagnostic: the message is history, not a fault (the TS
    # fold-local TOOL_CALL_RESULT_UNMATCHED_INPUT is likewise never
    # harvested into the report).
    assert diags == []


def test_input_tool_message_already_resulted_is_skipped():
    events = [
        run_started(0, "run-1"),
        *tool_call_open(1),
        run_finished(6, "run-1"),
        run_started(7, "run-2", {"threadId": "thread-1", "runId": "run-2",
                                 "messages": [tool_input("msg-r1", "call-1")]}),
        run_finished(8, "run-2"),
        # Same call answered again: history echo, message not recorded.
        run_started(9, "run-3", {"threadId": "thread-1", "runId": "run-3",
                                 "messages": [tool_input("msg-r1b", "call-1",
                                                         "sunny again")]}),
    ]
    state, _, _ = fold(events)
    assert [m["id"] for m in state["messages"]] == ["msg-1", "msg-r1"]
    assert state["toolCalls"][0]["result"] == "sunny"


def test_input_tool_message_incomplete_call_is_skipped():
    events = [
        run_started(0, "run-1"),
        wrap(1, {"type": "TEXT_MESSAGE_START", "messageId": "msg-1"}),
        wrap(2, {"type": "TOOL_CALL_START", "toolCallId": "call-1",
                 "toolCallName": "search", "parentMessageId": "msg-1"}),
        # Run ends with the call still open -> incomplete, no result.
        run_finished(3, "run-1"),
        run_started(4, "run-2", {"threadId": "thread-1", "runId": "run-2",
                                 "messages": [tool_input("msg-r1", "call-1")]}),
    ]
    state, _, _ = fold(events)
    assert [m["id"] for m in state["messages"]] == ["msg-1"]
    assert state["toolCalls"][0]["result"] is None


def test_input_identity_mismatch_is_out_of_order():
    for field, bad in (("threadId", "thread-OTHER"),
                       ("runId", "run-OTHER")):
        bad_input = {"threadId": "thread-1", "runId": "run-1",
                     "messages": [], "state": {"count": 5}}
        bad_input[field] = bad
        state, diags, _ = fold([run_started(0, "run-1", bad_input)])
        assert state["runs"] == []
        assert state["runStatus"] == "NOT_STARTED"
        # The input is not seeded: no baseline exists yet.
        assert state["sharedState"] is None
        assert len(diags) == 1
        assert diags[0]["code"] == "OUT_OF_ORDER"
        assert "[RUN_INPUT_MISMATCH]" in diags[0]["message"]
        assert diags[0]["sourceIndex"] == 0


@pytest.mark.parametrize("bad_input", [
    "not-an-object",
    {"threadId": "thread-1", "runId": "run-1"},  # messages missing
    {"threadId": "thread-1", "runId": "run-1", "messages": "nope"},
    {"threadId": "thread-1", "runId": "run-1",
     "messages": [{"role": "user", "content": "x"}]},  # message w/o id
    {"threadId": "thread-1", "runId": "run-1",
     "messages": [{"id": "m1", "role": "wizard", "content": "x"}]},
    # Tool-role input message without content: both sides reject with
    # INVALID_INPUT (FIX-R2, P1-R2-01); the FIX-R1 asymmetry is closed.
    {"threadId": "thread-1", "runId": "run-1",
     "messages": [{"id": "msg-r1", "role": "tool", "toolCallId": "call-1"}]},
])
def test_input_illegal_shapes_raise_invalid_input(bad_input):
    event = {"type": "RUN_STARTED", "threadId": "thread-1",
             "runId": "run-1", "input": bad_input}
    with pytest.raises(InvalidInput):
        validate_event(event, 0)
    with pytest.raises(InvalidInput):
        fold([wrap(0, event)])


def test_state_delta_without_baseline_is_mismatch():
    state, diags, _ = fold([
        run_started(0, "run-1"),
        wrap(1, {"type": "STATE_DELTA",
                 "delta": [{"op": "add", "path": "/count",
                            "value": 1}]}),
    ])
    # The RUN_STARTED with no input.state set the {} baseline, so a
    # delta applies; with NO run at all there is no baseline to patch.
    assert state["sharedState"] == {"count": 1}
    state, diags, _ = fold([
        wrap(0, {"type": "STATE_DELTA",
                 "delta": [{"op": "replace", "path": "/count",
                            "value": 1}]}),
    ])
    assert state["sharedState"] is None
    assert [d["code"] for d in diags] == ["SNAPSHOT_MISMATCH"]


# ---------------------------------------------------------------------------
# FIX-R2, P1-R2-01 (Oracle side): per-role required fields, both paths.
# Same 17 illegal + 7 legal messages as the TS checkMessagesArray cases
# (tests/parser/normalize.test.ts); the Oracle must reject / accept
# exactly the same shapes on RUN_STARTED.input and MESSAGES_SNAPSHOT.
# ---------------------------------------------------------------------------

INVALID_MESSAGES = [
    ("developer missing content", {"id": "m1", "role": "developer"}),
    ("system missing content", {"id": "m1", "role": "system"}),
    ("user missing content", {"id": "m1", "role": "user"}),
    ("reasoning missing content", {"id": "m1", "role": "reasoning"}),
    ("tool missing content",
     {"id": "m1", "role": "tool", "toolCallId": "c1"}),
    ("tool missing toolCallId",
     {"id": "m1", "role": "tool", "content": "ok"}),
    ("tool missing content and toolCallId", {"id": "m1", "role": "tool"}),
    ("activity missing activityType",
     {"id": "m1", "role": "activity", "content": {}}),
    ("activity missing content",
     {"id": "m1", "role": "activity", "activityType": "step"}),
    ("assistant missing id", {"role": "assistant", "content": "x"}),
    ("assistant content wrong type",
     {"id": "m1", "role": "assistant", "content": 123}),
    ("developer content wrong type",
     {"id": "m1", "role": "developer", "content": 123}),
    ("user content wrong type",
     {"id": "m1", "role": "user", "content": 123}),
    ("tool content wrong type",
     {"id": "m1", "role": "tool", "toolCallId": "c1", "content": 123}),
    ("tool toolCallId wrong type",
     {"id": "m1", "role": "tool", "toolCallId": 7, "content": "ok"}),
    ("activity content wrong type",
     {"id": "m1", "role": "activity", "activityType": "step",
      "content": "x"}),
    ("activity activityType wrong type",
     {"id": "m1", "role": "activity", "activityType": 7, "content": {}}),
]

VALID_MESSAGES = [
    ("assistant without content", {"id": "m1", "role": "assistant"}),
    ("assistant with toolCalls, no content",
     {"id": "m1", "role": "assistant",
      "toolCalls": [{"id": "c1", "type": "function",
                     "function": {"name": "f", "arguments": "{}"}}]}),
    ("user with ContentPart array content",
     {"id": "m1", "role": "user",
      "content": [{"type": "text", "text": "hi"}]}),
    ("tool with ContentPart array content",
     {"id": "m1", "role": "tool", "toolCallId": "c1",
      "content": [{"type": "text", "text": "ok"}]}),
    ("activity with object content",
     {"id": "m1", "role": "activity", "activityType": "step",
      "content": {"done": True}}),
    ("developer with string content",
     {"id": "m1", "role": "developer", "content": "do x"}),
    ("reasoning with string content",
     {"id": "m1", "role": "reasoning", "content": "hmm"}),
]


def _both_paths_events(message):
    """The same message carried by RUN_STARTED.input and by
    MESSAGES_SNAPSHOT."""
    run_started = {"type": "RUN_STARTED", "threadId": "thread-1",
                   "runId": "run-1",
                   "input": {"threadId": "thread-1", "runId": "run-1",
                             "messages": [message]}}
    snapshot = {"type": "MESSAGES_SNAPSHOT", "messages": [message]}
    return run_started, snapshot


def _evaluate_diagnostic_shape(result):
    return [{k: d[k] for k in ("code", "severity", "sourceIndex")}
            for d in result["diagnostics"]]


@pytest.mark.parametrize("name,message",
                         [pytest.param(n, m, id=n)
                          for n, m in INVALID_MESSAGES])
def test_per_role_illegal_rejected_both_paths(name, message):
    for event in _both_paths_events(message):
        with pytest.raises(InvalidInput):
            validate_event(event, 0)
        with pytest.raises(InvalidInput):
            fold([wrap(0, event)])
        result = evaluate({
            "scenarioId": "probe-per-role-illegal",
            "events": [{"sourceIndex": 0, "event": event}],
            "recovery": {}})
        assert result["verdict"] == "INVALID_INPUT"
        assert _evaluate_diagnostic_shape(result) == [
            {"code": "INVALID_INPUT", "severity": "CRITICAL",
             "sourceIndex": None}]


@pytest.mark.parametrize("name,message",
                         [pytest.param(n, m, id=n)
                          for n, m in VALID_MESSAGES])
def test_per_role_legal_accepted_both_paths(name, message):
    for event in _both_paths_events(message):
        validate_event(event, 0)
        state, diags, _ = fold([wrap(0, event)])
        assert [m["id"] for m in state["messages"]] == ["m1"]


def test_assistant_without_content_keeps_empty_default_both_paths():
    # The "" default in _seed_run_input / _snapshot_message_to_state
    # is retained, but it is now reachable only for a legal assistant
    # message without content — every other role without content is
    # rejected above and never reaches the fold.
    message = {"id": "m1", "role": "assistant"}
    for event in _both_paths_events(message):
        state, _, _ = fold([wrap(0, event)])
        assert state["messages"][0]["content"] == ""


def test_content_part_array_content_preserved_both_paths():
    for message in (
            {"id": "m1", "role": "user",
             "content": [{"type": "text", "text": "hi"}]},
            {"id": "m1", "role": "tool", "toolCallId": "c1",
             "content": [{"type": "text", "text": "ok"}]}):
        for event in _both_paths_events(message):
            state, _, _ = fold([wrap(0, event)])
            assert state["messages"][0]["content"] == message["content"]


# ---------------------------------------------------------------------------
# FIX-R2 supplement (P1-R2-01 same-class residual): ContentPart array
# depth validation. TS checkContentParts (src/parser/normalize.ts)
# rejects malformed part arrays; the Oracle previously accepted any
# list. The same cases must be INVALID_INPUT / accepted on both
# message paths (RUN_STARTED.input and MESSAGES_SNAPSHOT).
# ---------------------------------------------------------------------------

INVALID_CONTENT_PARTS = [
    ("user unknown part type",
     {"id": "m1", "role": "user", "content": [{"type": "bogus"}]}),
    ("user text part missing text",
     {"id": "m1", "role": "user", "content": [{"type": "text"}]}),
    ("user text part wrong type text",
     {"id": "m1", "role": "user",
      "content": [{"type": "text", "text": 123}]}),
    ("user image part missing source",
     {"id": "m1", "role": "user", "content": [{"type": "image"}]}),
    ("user image part source missing value",
     {"id": "m1", "role": "user",
      "content": [{"type": "image", "source": {"type": "url"}}]}),
    ("user image part source wrong type value",
     {"id": "m1", "role": "user",
      "content": [{"type": "image",
                    "source": {"type": "url", "value": 123}}]}),
    ("user image part source not an object",
     {"id": "m1", "role": "user",
      "content": [{"type": "image", "source": "x"}]}),
    ("user part not an object",
     {"id": "m1", "role": "user", "content": ["not-a-part"]}),
    ("user part missing type",
     {"id": "m1", "role": "user", "content": [{"text": "hi"}]}),
    ("tool unknown part type",
     {"id": "m1", "role": "tool", "toolCallId": "c1",
      "content": [{"type": "bogus"}]}),
    ("tool text part missing text",
     {"id": "m1", "role": "tool", "toolCallId": "c1",
      "content": [{"type": "text"}]}),
]

VALID_CONTENT_PARTS = [
    ("user image part with url source",
     {"id": "m1", "role": "user",
      "content": [{"type": "image",
                    "source": {"type": "url",
                               "value": "https://example.invalid/y.png"}}]}),
    ("user audio part with data source",
     {"id": "m1", "role": "user",
      "content": [{"type": "audio",
                    "source": {"type": "data", "value": "AAAA"}}]}),
    ("user video part with file source",
     {"id": "m1", "role": "user",
      "content": [{"type": "video",
                    "source": {"type": "file", "value": "f1"}}]}),
    ("user document part with url source",
     {"id": "m1", "role": "user",
      "content": [{"type": "document",
                    "source": {"type": "url",
                               "value": "https://example.invalid/d.pdf"}}]}),
    ("tool image part with url source",
     {"id": "m1", "role": "tool", "toolCallId": "c1",
      "content": [{"type": "image",
                    "source": {"type": "url",
                               "value": "https://example.invalid/y.png"}}]}),
    ("user mixed text and image parts",
     {"id": "m1", "role": "user",
      "content": [{"type": "text", "text": "look"},
                  {"type": "image",
                   "source": {"type": "url",
                              "value": "https://example.invalid/y.png"}}]}),
    # An empty part array is accepted by TS checkContentParts (its
    # forEach over zero parts raises nothing); the Oracle matches.
    ("user empty part array",
     {"id": "m1", "role": "user", "content": []}),
]


@pytest.mark.parametrize("name,message",
                         [pytest.param(n, m, id=n)
                          for n, m in INVALID_CONTENT_PARTS])
def test_content_part_illegal_rejected_both_paths(name, message):
    for event in _both_paths_events(message):
        with pytest.raises(InvalidInput):
            validate_event(event, 0)
        with pytest.raises(InvalidInput):
            fold([wrap(0, event)])
        result = evaluate({
            "scenarioId": "probe-part-illegal",
            "events": [{"sourceIndex": 0, "event": event}],
            "recovery": {}})
        assert result["verdict"] == "INVALID_INPUT"
        assert _evaluate_diagnostic_shape(result) == [
            {"code": "INVALID_INPUT", "severity": "CRITICAL",
             "sourceIndex": None}]


@pytest.mark.parametrize("name,message",
                         [pytest.param(n, m, id=n)
                          for n, m in VALID_CONTENT_PARTS])
def test_content_part_legal_accepted_both_paths(name, message):
    for event in _both_paths_events(message):
        validate_event(event, 0)
        state, _, _ = fold([wrap(0, event)])
        assert [m["id"] for m in state["messages"]] == ["m1"]
        assert state["messages"][0]["content"] == message["content"]


# ---------------------------------------------------------------------------
# FIX-R2 D2 micro-task item 1: TOOL_CALL_RESULT content part depth
# validation. TS validateEvent calls checkContentParts for
# TOOL_CALL_RESULT too (src/parser/normalize.ts, normalize.test.ts
# "TOOL_CALL_RESULT content parts are validated (text part needs
# text)"); the Oracle validate_event branch previously only checked
# isinstance(content, (str, list)), so a malformed part array was
# accepted. Same rule as the user/tool message branches: a string
# content passes, a list is deep-validated part by part.
# ---------------------------------------------------------------------------

INVALID_TOOL_CALL_RESULT_CONTENTS = [
    ("text part missing text", [{"type": "text"}]),
    ("text part wrong type text", [{"type": "text", "text": 123}]),
    ("unknown part type", [{"type": "bogus"}]),
    ("image part missing source", [{"type": "image"}]),
    ("image part source missing value",
     [{"type": "image", "source": {"type": "url"}}]),
    ("part not an object", ["not-a-part"]),
    ("part missing type", [{"text": "ok"}]),
]

VALID_TOOL_CALL_RESULT_CONTENTS = [
    ("string content", "ok"),
    ("text part array", [{"type": "text", "text": "ok"}]),
    ("image part array",
     [{"type": "image",
       "source": {"type": "url",
                  "value": "https://example.invalid/y.png"}}]),
    # An empty part array is accepted by TS checkContentParts (its
    # forEach over zero parts raises nothing); the Oracle matches.
    ("empty part array", []),
]


def _tool_call_result_event(content):
    return {"type": "TOOL_CALL_RESULT", "messageId": "msg-r",
            "toolCallId": "call-1", "content": content}


@pytest.mark.parametrize("name,content",
                         [pytest.param(n, c, id=n)
                          for n, c in INVALID_TOOL_CALL_RESULT_CONTENTS])
def test_tool_call_result_malformed_parts_rejected(name, content):
    event = _tool_call_result_event(content)
    with pytest.raises(InvalidInput):
        validate_event(event, 0)
    with pytest.raises(InvalidInput):
        fold([wrap(0, event)])
    result = evaluate({
        "scenarioId": "probe-tool-result-parts-illegal",
        "events": [{"sourceIndex": 0, "event": event}],
        "recovery": {}})
    assert result["verdict"] == "INVALID_INPUT"
    assert _evaluate_diagnostic_shape(result) == [
        {"code": "INVALID_INPUT", "severity": "CRITICAL",
         "sourceIndex": None}]


@pytest.mark.parametrize("name,content",
                         [pytest.param(n, c, id=n)
                          for n, c in VALID_TOOL_CALL_RESULT_CONTENTS])
def test_tool_call_result_legal_content_accepted(name, content):
    event = _tool_call_result_event(content)
    validate_event(event, 0)
    # Open a call first so the result is actually stored, not just
    # an OUT_OF_ORDER diagnostic for an unknown call. The stream
    # needs an open run: TS requireOpenRun (src/core/reducer.ts)
    # refuses TEXT/TOOL events with no run open, and the Oracle
    # reproduces that (FIX-R2, P1-R2-02).
    state, diags, _ = fold([run_started(0)] + tool_call_open(1)
                           + [wrap(6, event)])
    assert state["toolCalls"][0]["result"] == content
    assert state["messages"][-1]["content"] == content
    assert [d["code"] for d in diags] == []
