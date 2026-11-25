"""Serialize the 24 hand-authored Golden fixtures to fixtures/golden/.

The trace DATA in this file is hand-written from PROJECT_BOOK §9
(8 fault traces G01-G08, 16 normal traces N01-N16). This script only
adds the NormalizedEvent wrappers (sourceIndex from 0, null keys) and
writes the JSON files; it does not derive anything from program
output. Regenerate with: python oracle/generate_goldens.py
"""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "fixtures" / "golden"

THREAD = "thread-1"


def run_started(run_id="run-1", **extra):
    event = {"type": "RUN_STARTED", "threadId": THREAD, "runId": run_id}
    event.update(extra)
    return event


def run_finished(run_id="run-1", **extra):
    event = {"type": "RUN_FINISHED", "threadId": THREAD, "runId": run_id}
    event.update(extra)
    return event


def run_error(message, **extra):
    event = {"type": "RUN_ERROR", "message": message}
    event.update(extra)
    return event


def text_start(message_id, **extra):
    event = {"type": "TEXT_MESSAGE_START", "messageId": message_id}
    event.update(extra)
    return event


def text_content(message_id, delta, **extra):
    event = {"type": "TEXT_MESSAGE_CONTENT",
             "messageId": message_id, "delta": delta}
    event.update(extra)
    return event


def text_end(message_id, **extra):
    return {"type": "TEXT_MESSAGE_END", "messageId": message_id, **extra}


def tool_start(tool_call_id, name, parent=None, **extra):
    event = {"type": "TOOL_CALL_START", "toolCallId": tool_call_id,
             "toolCallName": name}
    if parent is not None:
        event["parentMessageId"] = parent
    event.update(extra)
    return event


def tool_args(tool_call_id, delta, **extra):
    return {"type": "TOOL_CALL_ARGS", "toolCallId": tool_call_id,
            "delta": delta, **extra}


def tool_end(tool_call_id, **extra):
    return {"type": "TOOL_CALL_END", "toolCallId": tool_call_id, **extra}


def tool_result(message_id, tool_call_id, content, **extra):
    return {"type": "TOOL_CALL_RESULT", "messageId": message_id,
            "toolCallId": tool_call_id, "content": content, **extra}


def state_snapshot(snapshot, **extra):
    return {"type": "STATE_SNAPSHOT", "snapshot": snapshot, **extra}


def state_delta(patch, **extra):
    return {"type": "STATE_DELTA", "delta": patch, **extra}


def messages_snapshot(messages, **extra):
    return {"type": "MESSAGES_SNAPSHOT", "messages": messages, **extra}


# -- explicit checkpoint state fragments (internal RejoinState format) ----

def _msg(message_id, role, content, tool_calls=(), tool_call_id=None):
    entry = {
        "id": message_id, "role": role, "name": None,
        "content": content,
        "segments": [{"text": content if isinstance(content, str) else ""}],
        "toolCalls": list(tool_calls),
        "open": False, "incomplete": False,
    }
    if tool_call_id is not None:
        entry["toolCallId"] = tool_call_id
    return entry


def _call(tool_call_id, name, parent, args, result=None, result_message=None):
    return {
        "toolCallId": tool_call_id, "toolCallName": name,
        "parentMessageId": parent, "args": args,
        "result": result, "resultMessageId": result_message,
        "open": False, "incomplete": False, "duplicate": False,
    }


G02_CHECKPOINT = {
    "sourceIndex": 7, "threadId": THREAD,
    "runs": [{"runId": "run-1", "threadId": THREAD, "status": "RUNNING"}],
    # #3119: the producer snapshot re-ID'd msg-a -> msg-a2 and the
    # reconciliation appended the new id at the end, so the tool
    # result message now precedes its assistant message.
    "messages": [
        _msg("msg-r1", "tool", "sunny", tool_call_id="call-1"),
        _msg("msg-a2", "assistant", "It is sunny.", tool_calls=["call-1"]),
    ],
    "toolCalls": [_call("call-1", "search", "msg-a", '{"q":"x"}',
                        result="sunny", result_message="msg-r1")],
    "sharedState": {}, "pendingToolCallIds": [], "runStatus": "RUNNING",
    "coverage": {"sharedState": True, "messages": True},
}

G03_CHECKPOINT = {
    "sourceIndex": 10, "threadId": THREAD,
    "runs": [{"runId": "run-1", "threadId": THREAD, "status": "RUNNING"}],
    # #3368: the checkpoint snapshot merged the two text segments of
    # msg-1 ("Hello, " + "it is sunny.") into one string, so the
    # A / tool-call / B interleave is lost.
    "messages": [
        _msg("msg-1", "assistant", "Hello, it is sunny.",
             tool_calls=["call-1"]),
        _msg("msg-r1", "tool", "sunny", tool_call_id="call-1"),
    ],
    "toolCalls": [_call("call-1", "search", "msg-1", '{"q":"x"}',
                        result="sunny", result_message="msg-r1")],
    "sharedState": {}, "pendingToolCallIds": [], "runStatus": "RUNNING",
    "coverage": {"sharedState": True, "messages": True},
}

G06_CHECKPOINT = {
    "sourceIndex": 1, "threadId": THREAD,
    "runs": [{"runId": "run-1", "threadId": THREAD, "status": "RUNNING"}],
    "messages": [], "toolCalls": [],
    # Stale: the snapshot at index 1, before the deltas at 2 and 3.
    "sharedState": {"counter": 1, "items": ["a"]},
    "pendingToolCallIds": [], "runStatus": "RUNNING",
    "coverage": {"sharedState": True, "messages": True},
}

N16_CHECKPOINT = {
    "sourceIndex": 3,
    # Only the shared state is covered by this checkpoint; the local
    # messages are NOT covered and must be kept from the prefix fold.
    "sharedState": {"count": 5},
    "coverage": {"sharedState": True, "messages": False},
}


def recovery(strategy, disconnect_after, resume_after=None,
             checkpoint=None, injections=None):
    return {
        "strategy": strategy,
        "disconnectAfter": disconnect_after,
        "resumeAfterSourceIndex": resume_after if resume_after is not None
        else disconnect_after,
        "checkpoint": checkpoint,
        "injections": injections or [],
    }


# -- the 24 traces: (scenario_id, title, spec_ref, events, recovery) ------
# Each event is (event_dict, sourceEventKey_or_None).

TRACES = []

TRACES.append(("G01", "duplicate tool call on replay (AG-UI #1524)",
               "PROJECT_BOOK §9.2 G01; AG-UI #1524",
               [(run_started(), None),
                (text_start("msg-1"), None),
                (tool_start("call-1", "search", "msg-1"), None),
                (tool_args("call-1", '{"q":"weather"}'), None),
                (tool_end("call-1"), None),
                (tool_result("msg-r1", "call-1", "sunny"), None),
                (text_content("msg-1", "It is sunny."), None),
                (text_end("msg-1"), None),
                (run_finished(), None)],
               recovery("FULL_REPLAY_FROM_START", 4, resume_after=0)))

TRACES.append(("G02", "messages snapshot re-IDs assistant message (AG-UI #3119)",
               "PROJECT_BOOK §9.2 G02; AG-UI #3119",
               [(run_started(), None),
                (text_start("msg-a"), None),
                (tool_start("call-1", "search", "msg-a"), None),
                (tool_args("call-1", '{"q":"x"}'), None),
                (tool_end("call-1"), None),
                (tool_result("msg-r1", "call-1", "sunny"), None),
                (text_content("msg-a", "It is sunny."), None),
                (text_end("msg-a"), None),
                (run_finished(), None)],
               recovery("RESUME_FROM_CHECKPOINT", 7,
                        checkpoint=G02_CHECKPOINT)))

TRACES.append(("G03", "same messageId reopened after tool call (AG-UI #3368)",
               "PROJECT_BOOK §9.2 G03; AG-UI #3368",
               [(run_started(), None),
                (text_start("msg-1"), None),
                (text_content("msg-1", "Hello, "), None),
                (text_end("msg-1"), None),
                (tool_start("call-1", "search", "msg-1"), None),
                (tool_args("call-1", '{"q":"x"}'), None),
                (tool_end("call-1"), None),
                (tool_result("msg-r1", "call-1", "sunny"), None),
                (text_start("msg-1"), None),
                (text_content("msg-1", "it is sunny."), None),
                (text_end("msg-1"), None),
                (run_finished(), None)],
               recovery("RESUME_FROM_CHECKPOINT", 10,
                        checkpoint=G03_CHECKPOINT)))

TRACES.append(("G04", "dropped TEXT_MESSAGE_CONTENT on resume",
               "PROJECT_BOOK §9.2 G04",
               [(run_started(), None),
                (text_start("msg-1"), None),
                (text_content("msg-1", "Hello "), None),
                (text_content("msg-1", "world"), None),
                (text_end("msg-1"), None),
                (run_finished(), None)],
               recovery("RESUME_FROM_CHECKPOINT", 2,
                        injections=[{"op": "DROP_EVENT", "sourceIndex": 3}])))

TRACES.append(("G05", "adjacent TOOL_CALL_ARGS fragments swapped",
               "PROJECT_BOOK §9.2 G05",
               [(run_started(), None),
                (text_start("msg-1"), None),
                (text_content("msg-1", "Hello "), None),
                (tool_start("call-1", "search", "msg-1"), None),
                (tool_args("call-1", '{"q":'), None),
                (tool_args("call-1", '"x"}'), None),
                (tool_end("call-1"), None),
                (text_content("msg-1", "done."), None),
                (text_end("msg-1"), None),
                (run_finished(), None)],
               recovery("RESUME_FROM_CHECKPOINT", 3,
                        injections=[{"op": "SWAP_ADJACENT", "sourceIndex": 4}])))

TRACES.append(("G06", "stale STATE_SNAPSHOT overwrites newer state",
               "PROJECT_BOOK §9.2 G06",
               [(run_started(), None),
                (state_snapshot({"counter": 1, "items": ["a"]}), None),
                (state_delta([{"op": "replace", "path": "/counter",
                               "value": 2}]), None),
                (state_delta([{"op": "add", "path": "/items/1",
                               "value": "b"}]), None),
                (text_start("msg-1"), None),
                (text_content("msg-1", "hi"), None),
                (text_end("msg-1"), None),
                (run_finished(), None)],
               recovery("RESUME_FROM_CHECKPOINT", 3,
                        checkpoint=G06_CHECKPOINT)))

TRACES.append(("G07", "same content replayed with no stable event id",
               "PROJECT_BOOK §9.2 G07",
               [(run_started(), None),
                (text_start("msg-1"), None),
                (text_content("msg-1", "Hello"), None),
                (text_end("msg-1"), None),
                (run_finished(), None)],
               recovery("RESUME_FROM_CHECKPOINT", 1,
                        injections=[{"op": "DUPLICATE_EVENT",
                                     "sourceIndex": 2}])))

TRACES.append(("G08", "stream truncated before RUN_FINISHED",
               "PROJECT_BOOK §9.2 G08",
               [(run_started(), None),
                (text_start("msg-1"), None),
                (text_content("msg-1", "Hello"), None),
                (tool_start("call-1", "search", "msg-1"), None),
                (tool_args("call-1", '{"q":"x"}'), None)],
               recovery("RESUME_FROM_CHECKPOINT", 2,
                        injections=[{"op": "TRUNCATE_STREAM",
                                     "sourceIndex": 4}])))

TRACES.append(("N01", "single normal text run",
               "PROJECT_BOOK §9.3 N01",
               [(run_started(), None),
                (text_start("msg-1"), None),
                (text_content("msg-1", "Hi there."), None),
                (text_end("msg-1"), None),
                (run_finished(), None)],
               recovery("RESUME_FROM_CHECKPOINT", 2)))

TRACES.append(("N02", "multi-segment TEXT_MESSAGE_CONTENT",
               "PROJECT_BOOK §9.3 N02",
               [(run_started(), None),
                (text_start("msg-1"), None),
                (text_content("msg-1", "Hello "), None),
                (text_content("msg-1", "brave "), None),
                (text_content("msg-1", "world."), None),
                (text_end("msg-1"), None),
                (run_finished(), None)],
               recovery("RESUME_FROM_CHECKPOINT", 3)))

TRACES.append(("N03", "normal tool call and result",
               "PROJECT_BOOK §9.3 N03",
               [(run_started(), None),
                (text_start("msg-1"), None),
                (tool_start("call-1", "search", "msg-1"), None),
                (tool_args("call-1", '{"q":"x"}'), None),
                (tool_end("call-1"), None),
                (tool_result("msg-r1", "call-1", "sunny"), None),
                (text_content("msg-1", "Sunny."), None),
                (text_end("msg-1"), None),
                (run_finished(), None)],
               recovery("RESUME_FROM_CHECKPOINT", 4)))

TRACES.append(("N04", "frontend tool pending, result in next run",
               "PROJECT_BOOK §9.3 N04",
               [(run_started("run-1"), None),
                (text_start("msg-1"), None),
                (tool_start("call-1", "confirm", "msg-1"), None),
                (tool_args("call-1", '{"action":"pay"}'), None),
                (tool_end("call-1"), None),
                (run_finished("run-1", outcome={
                    "type": "success",
                    "pendingToolCallIds": ["call-1"]}), None),
                (run_started("run-2"), None),
                (tool_result("msg-r2", "call-1", "confirmed"), None),
                (text_start("msg-2"), None),
                (text_content("msg-2", "Payment confirmed."), None),
                (text_end("msg-2"), None),
                (run_finished("run-2"), None)],
               recovery("RESUME_FROM_CHECKPOINT", 5)))

TRACES.append(("N05", "normal STATE_SNAPSHOT + STATE_DELTA",
               "PROJECT_BOOK §9.3 N05",
               [(run_started(), None),
                (state_snapshot({"theme": "dark", "count": 0}), None),
                (state_delta([{"op": "replace", "path": "/count",
                               "value": 3}]), None),
                (state_delta([{"op": "add", "path": "/items",
                               "value": ["a"]}]), None),
                (run_finished(), None)],
               recovery("RESUME_FROM_CHECKPOINT", 1)))

TRACES.append(("N06", "full replay then identical messages snapshot",
               "PROJECT_BOOK §9.3 N06",
               [(run_started(), None),
                (text_start("msg-1"), None),
                (text_content("msg-1", "Hello"), None),
                (text_end("msg-1"), None),
                (messages_snapshot([{"id": "msg-1", "role": "assistant",
                                     "content": "Hello"}]), None),
                (run_finished(), None)],
               recovery("FULL_REPLAY_FROM_START", 3, resume_after=0,
                        checkpoint={"empty": True})))

TRACES.append(("N07", "normal disconnect, complete checkpoint resume",
               "PROJECT_BOOK §9.3 N07",
               [(run_started(), None),
                (text_start("msg-1"), None),
                (text_content("msg-1", "Hello "), None),
                (state_snapshot({"count": 1}), None),
                (text_content("msg-1", "world."), None),
                (text_end("msg-1"), None),
                (run_finished(), None)],
               recovery("RESUME_FROM_CHECKPOINT", 4)))

TRACES.append(("N08", "same message legally reopened, timeline kept",
               "PROJECT_BOOK §9.3 N08",
               [(run_started(), None),
                (text_start("msg-1"), None),
                (text_content("msg-1", "Hello, "), None),
                (text_end("msg-1"), None),
                (text_start("msg-1"), None),
                (text_content("msg-1", "world."), None),
                (text_end("msg-1"), None),
                (run_finished(), None)],
               recovery("RESUME_FROM_CHECKPOINT", 3)))

TRACES.append(("N09", "multiple independent interleaved tool calls",
               "PROJECT_BOOK §9.3 N09",
               [(run_started(), None),
                (text_start("msg-1"), None),
                (tool_start("call-1", "search", "msg-1"), None),
                (tool_start("call-2", "calc", "msg-1"), None),
                (tool_args("call-1", '{"q":"a"}'), None),
                (tool_args("call-2", '{"x":1}'), None),
                (tool_end("call-1"), None),
                (tool_end("call-2"), None),
                (tool_result("msg-r1", "call-1", "A"), None),
                (tool_result("msg-r2", "call-2", "2"), None),
                (text_content("msg-1", "done."), None),
                (text_end("msg-1"), None),
                (run_finished(), None)],
               recovery("RESUME_FROM_CHECKPOINT", 7)))

TRACES.append(("N10", "multiple runs in one thread, in order",
               "PROJECT_BOOK §9.3 N10",
               [(run_started("run-1"), None),
                (text_start("msg-1"), None),
                (text_content("msg-1", "First."), None),
                (text_end("msg-1"), None),
                (run_finished("run-1"), None),
                (run_started("run-2"), None),
                (text_start("msg-2"), None),
                (text_content("msg-2", "Second."), None),
                (text_end("msg-2"), None),
                (run_finished("run-2"), None)],
               recovery("RESUME_FROM_CHECKPOINT", 4)))

TRACES.append(("N11", "RUN_ERROR as the first event (failed run)",
               "PROJECT_BOOK §9.3 N11",
               [(run_error("failed to start", code="START_FAILED"), None),
                (run_started("run-1"), None),
                (text_start("msg-1"), None),
                (text_content("msg-1", "Recovered."), None),
                (text_end("msg-1"), None),
                (run_finished("run-1"), None)],
               recovery("RESUME_FROM_CHECKPOINT", 0)))

TRACES.append(("N12", "RUN_ERROR ends an unfinished stream",
               "PROJECT_BOOK §9.3 N12",
               [(run_started(), None),
                (text_start("msg-1"), None),
                (text_content("msg-1", "Partial"), None),
                (tool_start("call-1", "search", "msg-1"), None),
                (tool_args("call-1", '{"q":"x"}'), None),
                (run_error("upstream failed"), None)],
               recovery("RESUME_FROM_CHECKPOINT", 2)))

TRACES.append(("N13", "non-monotonic timestamps, correct arrival order",
               "PROJECT_BOOK §9.3 N13",
               [(run_started(timestamp=1000), None),
                (text_start("msg-1", timestamp=900), None),
                (text_content("msg-1", "Hello", timestamp=800), None),
                (text_end("msg-1", timestamp=700), None),
                (run_finished(timestamp=600), None)],
               recovery("RESUME_FROM_CHECKPOINT", 2)))

TRACES.append(("N14", "same text, two different sourceEventKeys",
               "PROJECT_BOOK §9.3 N14",
               [(run_started(), "k-run"),
                (text_start("msg-1"), "k-start-1"),
                (text_content("msg-1", "Hello"), "k-a"),
                (text_start("msg-2"), "k-start-2"),
                (text_content("msg-2", "Hello"), "k-b"),
                (text_end("msg-1"), "k-end-1"),
                (text_end("msg-2"), "k-end-2"),
                (run_finished(), "k-fin")],
               recovery("RESUME_FROM_CHECKPOINT", 3)))

TRACES.append(("N15", "same tool args, different toolCallIds",
               "PROJECT_BOOK §9.3 N15",
               [(run_started(), None),
                (text_start("msg-1"), None),
                (tool_start("call-1", "search"), None),
                (tool_args("call-1", '{"q":"x"}'), None),
                (tool_end("call-1"), None),
                (tool_start("call-2", "search"), None),
                (tool_args("call-2", '{"q":"x"}'), None),
                (tool_end("call-2"), None),
                (tool_result("msg-r1", "call-1", "A"), None),
                (tool_result("msg-r2", "call-2", "B"), None),
                (text_end("msg-1"), None),
                (run_finished(), None)],
               recovery("RESUME_FROM_CHECKPOINT", 4)))

TRACES.append(("N16", "restore only the shared-state snapshot",
               "PROJECT_BOOK §9.3 N16",
               [(run_started(), None),
                (text_start("msg-1"), None),
                (text_content("msg-1", "Local text"), None),
                (state_snapshot({"count": 5}), None),
                (text_end("msg-1"), None),
                (run_finished(), None)],
               recovery("RESUME_FROM_CHECKPOINT", 3,
                        checkpoint=N16_CHECKPOINT)))


def build_fixture(scenario_id, title, spec_ref, events, recovery_config):
    normalized = []
    for index, (event, key) in enumerate(events):
        normalized.append({
            "sourceIndex": index,
            "sourceEventKey": key,
            "transportEventId": None,
            "event": event,
        })
    return {
        "schema": "rejoinlab.golden/v1",
        "scenarioId": scenario_id,
        "title": title,
        "specRef": spec_ref,
        "events": normalized,
        "recovery": recovery_config,
    }


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    assert len(TRACES) == 24, f"expected 24 traces, got {len(TRACES)}"
    for scenario_id, title, spec_ref, events, recovery_config in TRACES:
        fixture = build_fixture(scenario_id, title, spec_ref, events,
                                recovery_config)
        path = OUT_DIR / f"{scenario_id}.json"
        path.write_text(json.dumps(fixture, indent=2, ensure_ascii=False)
                        + "\n", encoding="utf-8")
        print(f"{scenario_id}: {len(events)} events -> {path}")
    print("wrote 24 fixtures")


if __name__ == "__main__":
    main()
