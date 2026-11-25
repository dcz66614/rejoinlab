"""P031 RejoinLab — independent Oracle dual-track replay (replay.py).

Implements PROJECT_BOOK §5 (dual-track comparison), §6 (diagnostic
classification), §7 (verdicts) and §8 (bounded replay + BFS shortest
fault sequence) from the frozen written specification only.

How a fixture is analysed
--------------------------
1. Full path: fold every event from the empty initial state.
2. Resume path: rebuild a base state from the fixture's recovery
   checkpoint (computed by folding the covered prefix, an explicit
   state fragment, or the empty state), then fold the resume event
   stream (strategy FULL_REPLAY_FROM_START / RESUME_FROM_CHECKPOINT /
   REPLAY_AFTER_SOURCE_CURSOR) with the fixture's injections applied.
3. Compare canonical hashes (oracle.canonical.state_hash). On a
   difference, classify the divergence and locate the first
   divergence sourceIndex.
4. BFS (fixed operator order CURSOR_SKIP, DROP_EVENT, DUPLICATE_EVENT,
   MESSAGE_ID_REMAP, REPLAY_PREFIX, STALE_SNAPSHOT, SWAP_ADJACENT,
   TRUNCATE_STREAM; depth <= 3; <= 5000 nodes) searches for the
   shortest injection sequence reproducing the fault, starting from
   the *legal* recovery of the same events (correct checkpoint,
   no injections). For fault fixtures the goal is the fixture's
   primary diagnostic code; for normal fixtures any divergence.

Judgment calls (documented for the independent reviewer)
--------------------------------------------------------
* BFS goal is the fault's primary diagnostic, not "any divergence":
  a generic DROP_EVENT diverges almost every trace, so "any
  divergence" would report DROP_EVENT for every Golden and say
  nothing about the fault being tested (PROJECT_BOOK §8.5 speaks of
  "a confirmable state divergence" for the fault under test; §13.3
  likewise shows G01 -> ["REPLAY_PREFIX"]).
* G08 has no clean baseline: the trace itself is truncated before
  any terminal event, so the empty injection sequence already yields
  TRUNCATED_RUN. Its shortest sequence is [].
* MESSAGE_ID_REMAP renames the message consistently (base state and
  every resume-stream reference) and moves it to the end of the
  message list, modelling the #3119 reconciliation behaviour
  (a re-ID'd message is appended at the end). A bare rename with no
  order change is DIVERGENT_STATE, not MESSAGE_REORDER.
* CURSOR_SKIP's canonical form skips only already-covered events,
  which is a legal no-op; skipping uncovered events is DROP_EVENT.
* STALE_SNAPSHOT needs an earlier STATE_SNAPSHOT to be stale *from*;
  with no snapshot in the trace it is inapplicable (no-op).
* A CRITICAL diagnostic proves an inconsistency even if the final
  canonical hashes happen to agree; INCOMPLETE_TRACE (truncated
  stream) is only reported when no CRITICAL diagnostic exists.
* When the full trace itself lacks a terminal event, LOST_EVENT is
  suppressed: the incompleteness dominates (G08 expects only
  TRUNCATED_RUN).
"""

from __future__ import annotations

import copy
import hashlib
import json
import re
import time

from oracle.canonical import canonical_hash, state_hash
from oracle.diff import find_first_divergence, to_report_first_divergence
from oracle.parity import (
    PROTOCOL_VERSION,
    REPORT_ASSUMPTIONS,
    REPORT_LIMITATIONS,
    SPEC_VERSION,
    evaluation_project_path,
    parity_project_path,
    parity_project_state,
    parity_report_hash,
    parity_state_hash,
    report_hash,
    report_project_path,
    to_report_diagnostic,
    to_report_path,
)
from oracle.reference import (
    InvalidInput,
    UnsupportedEvent,
    expand_chunks,
    fold,
    initial_state,
)

__all__ = [
    "MAX_EVENTS",
    "MAX_NODES",
    "MAX_DEPTH",
    "OPERATOR_ORDER",
    "resolve_checkpoint",
    "build_resume_stream",
    "apply_injection",
    "evaluate",
    "analyze",
    "bfs_shortest",
    "parity_project_state",
    "parity_state_hash",
    "parity_project_path",
    "parity_report_hash",
]

MAX_EVENTS = 40
MAX_NODES = 5000
MAX_DEPTH = 3

OPERATOR_ORDER = (
    "CURSOR_SKIP",
    "DROP_EVENT",
    "DUPLICATE_EVENT",
    "MESSAGE_ID_REMAP",
    "REPLAY_PREFIX",
    "STALE_SNAPSHOT",
    "SWAP_ADJACENT",
    "TRUNCATE_STREAM",
)

CRITICAL_CODES = {
    "DUPLICATE_TOOL_CALL", "LOST_EVENT", "OUT_OF_ORDER",
    "MESSAGE_REORDER", "SNAPSHOT_MISMATCH", "DIVERGENT_STATE",
}

TERMINAL_TYPES = ("RUN_FINISHED", "RUN_ERROR")


# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

def _events_by_index(fixture):
    return {w["sourceIndex"]: w for w in fixture["events"]}


def _prefix_fold(fixture, through_index):
    """Fold events with sourceIndex <= through_index from empty."""
    events = [w for w in fixture["events"] if w["sourceIndex"] <= through_index]
    state, diagnostics, _ = fold(events)
    return state, diagnostics


def _convert_checkpoint_message(message):
    """Convert one explicit-checkpoint fragment message, mirroring
    TS tests/replay/golden-helpers.ts convertMessage: drop
    toolCalls entirely, default content to "", normalise segments
    to {text} (falling back to the single-segment form of the
    content when absent). Status/owner are derived downstream by
    oracle.parity._production_message (open/incomplete ->
    status; activity/reasoning without an owner key -> "client")."""
    converted = copy.deepcopy(message)
    converted.pop("toolCalls", None)
    if "content" not in converted:
        converted["content"] = ""
    segments = converted.get("segments")
    if isinstance(segments, list):
        converted["segments"] = [
            {"text": s.get("text") if isinstance(s, dict)
             and isinstance(s.get("text"), str) else ""}
            for s in segments]
    else:
        content = converted["content"]
        converted["segments"] = [
            {"text": content if isinstance(content, str) else ""}]
    return converted


def resolve_checkpoint(fixture):
    """Return (base_state, checkpoint_index).

    checkpoint None      -> fold the covered prefix (0..disconnectAfter).
    {"empty": true}      -> the empty initial state.
    explicit dict        -> the given state fragment; fields it does not
                            cover fall back to the prefix fold (see the
                            "coverage" member: sharedState / messages).
    """
    recovery = fixture.get("recovery") or {}
    disconnect_after = recovery.get("disconnectAfter")
    if disconnect_after is None:
        disconnect_after = -1
    checkpoint = recovery.get("checkpoint")
    if checkpoint is None:
        state, _ = _prefix_fold(fixture, disconnect_after)
        return state, disconnect_after
    if isinstance(checkpoint, dict) and checkpoint.get("empty"):
        return initial_state(), -1
    if not isinstance(checkpoint, dict):
        raise InvalidInput("fixture checkpoint must be an object or null")
    checkpoint_index = checkpoint.get("sourceIndex", disconnect_after)
    prefix_state, _ = _prefix_fold(fixture, checkpoint_index)
    coverage = checkpoint.get("coverage") or {}
    base = initial_state()
    base["threadId"] = checkpoint.get("threadId", prefix_state["threadId"])
    base["runs"] = copy.deepcopy(
        checkpoint.get("runs", prefix_state["runs"]))
    base["runStatus"] = checkpoint.get("runStatus", prefix_state["runStatus"])
    base["pendingToolCallIds"] = copy.deepcopy(
        checkpoint.get("pendingToolCallIds", prefix_state["pendingToolCallIds"]))
    if coverage.get("sharedState", True):
        base["sharedState"] = copy.deepcopy(
            checkpoint.get("sharedState", prefix_state["sharedState"]))
    else:
        base["sharedState"] = copy.deepcopy(prefix_state["sharedState"])
    if coverage.get("messages", True):
        fragment_messages = checkpoint.get("messages")
        base["messages"] = copy.deepcopy(
            fragment_messages if fragment_messages is not None
            else prefix_state["messages"])
        if fragment_messages is not None:
            # FIX-R2: mirror TS tests/replay/golden-helpers.ts
            # convertMessage for explicit-checkpoint fragment
            # messages — the fragment's message.toolCalls (id lists)
            # are dropped entirely, content defaults to "", and
            # segments fall back to the single-segment form of the
            # content. A TS streamed message never carries toolCalls,
            # and synthesising ToolCall objects from id lists would
            # make the checkpoint state differ from every TS fold of
            # the same trace (G02/G03 resume paths).
            base["messages"] = [
                _convert_checkpoint_message(m)
                for m in base["messages"]]
        base["toolCalls"] = copy.deepcopy(
            checkpoint.get("toolCalls", prefix_state["toolCalls"]))
    else:
        base["messages"] = copy.deepcopy(prefix_state["messages"])
        base["toolCalls"] = copy.deepcopy(prefix_state["toolCalls"])
    base["orderedTimeline"] = copy.deepcopy(prefix_state["orderedTimeline"])
    # FIX-R1: the checkpoint fragment carries no runId on tool calls
    # (the Oracle fragment format has no such field); take it from
    # the prefix fold for the same call when one exists — mirrors TS
    # tests/replay/golden-helpers.ts convertToolCall, which fills
    # runId from the TS prefix fold. Fill only when missing; a
    # fragment-provided runId is the fragment's claim and is kept.
    prefix_run_id = {c.get("toolCallId"): c.get("runId")
                     for c in prefix_state.get("toolCalls") or []}
    for call in base["toolCalls"]:
        if call.get("runId") is None:
            run_id = prefix_run_id.get(call.get("toolCallId"))
            if run_id is not None:
                call["runId"] = run_id
    return base, checkpoint_index


def build_resume_stream(fixture, checkpoint_index):
    """The resume event stream before injections, per strategy."""
    recovery = fixture.get("recovery") or {}
    strategy = recovery.get("strategy", "RESUME_FROM_CHECKPOINT")
    events = fixture["events"]
    if strategy == "FULL_REPLAY_FROM_START":
        return [copy.deepcopy(w) for w in events]
    resume_after = recovery.get("resumeAfterSourceIndex")
    if resume_after is None:
        resume_after = recovery.get("disconnectAfter", checkpoint_index)
    return [copy.deepcopy(w) for w in events
            if w["sourceIndex"] > resume_after]


# ---------------------------------------------------------------------------
# Fault injection (§8.4). Each returns (stream, base_state, dropped, changed).
# ---------------------------------------------------------------------------

def apply_injection(stream, base_state, fixture, injection):
    """Apply one injection operator to (stream, base_state)."""
    op = injection.get("op")
    stream = [copy.deepcopy(w) for w in stream]
    base = copy.deepcopy(base_state)
    dropped = []

    if op == "DROP_EVENT":
        target = injection["sourceIndex"]
        kept = []
        for wrapper in stream:
            if wrapper["sourceIndex"] == target:
                dropped.append(wrapper)
            else:
                kept.append(wrapper)
        return kept, base, dropped, bool(dropped)

    if op == "DUPLICATE_EVENT":
        target = injection["sourceIndex"]
        out = []
        changed = False
        for wrapper in stream:
            out.append(wrapper)
            if wrapper["sourceIndex"] == target:
                out.append(copy.deepcopy(wrapper))
                changed = True
        return out, base, dropped, changed

    if op == "SWAP_ADJACENT":
        target = injection["sourceIndex"]
        position = next((i for i, w in enumerate(stream)
                         if w["sourceIndex"] == target), None)
        if position is None or position + 1 >= len(stream):
            return stream, base, dropped, False
        stream[position], stream[position + 1] = \
            stream[position + 1], stream[position]
        return stream, base, dropped, True

    if op == "MESSAGE_ID_REMAP":
        old_id = injection.get("messageId")
        if old_id is None:
            assistant = next(
                (m for m in base["messages"] if m.get("role") == "assistant"),
                None)
            if assistant is None:
                return stream, base, dropped, False
            old_id = assistant["id"]
        new_id = injection.get("newMessageId", old_id + "-remapped")
        if old_id == new_id:
            return stream, base, dropped, False
        renamed = None
        kept_messages = []
        for message in base["messages"]:
            if message["id"] == old_id:
                renamed = copy.deepcopy(message)
                renamed["id"] = new_id
            else:
                kept_messages.append(message)
        if renamed is None:
            return stream, base, dropped, False
        # #3119 behaviour: the re-ID'd message is appended at the end.
        base["messages"] = kept_messages + [renamed]
        for call in base["toolCalls"]:
            if call.get("parentMessageId") == old_id:
                call["parentMessageId"] = new_id
        for wrapper in stream:
            event = wrapper["event"]
            if event.get("messageId") == old_id:
                event["messageId"] = new_id
            if event.get("parentMessageId") == old_id:
                event["parentMessageId"] = new_id
            if event["type"] == "MESSAGES_SNAPSHOT":
                messages = []
                moved = None
                for message in event["messages"]:
                    if message.get("id") == old_id:
                        moved = copy.deepcopy(message)
                        moved["id"] = new_id
                    else:
                        messages.append(message)
                if moved is not None:
                    event["messages"] = messages + [moved]
        return stream, base, dropped, True

    if op == "REPLAY_PREFIX":
        disconnect_after = (fixture.get("recovery") or {}).get("disconnectAfter")
        if disconnect_after is None:
            return stream, base, dropped, False
        prefix = [copy.deepcopy(w) for w in fixture["events"]
                  if w["sourceIndex"] <= disconnect_after]
        return prefix + stream, base, dropped, bool(prefix)

    if op == "STALE_SNAPSHOT":
        first_snapshot = next(
            (w["sourceIndex"] for w in fixture["events"]
             if w["event"]["type"] == "STATE_SNAPSHOT"), None)
        if first_snapshot is None:
            return stream, base, dropped, False
        stale_state, _ = _prefix_fold(fixture, first_snapshot)
        return stream, stale_state, dropped, True

    if op == "CURSOR_SKIP":
        start = injection.get("from")
        end = injection.get("to")
        kept = []
        for wrapper in stream:
            if start <= wrapper["sourceIndex"] <= end:
                dropped.append(wrapper)
            else:
                kept.append(wrapper)
        return kept, base, dropped, bool(dropped)

    if op == "TRUNCATE_STREAM":
        target = injection["sourceIndex"]
        kept = [w for w in stream if w["sourceIndex"] < target]
        dropped = [w for w in stream if w["sourceIndex"] >= target]
        return kept, base, dropped, bool(dropped)

    raise InvalidInput(f"unknown injection operator {op!r}")


def apply_injections(stream, base_state, fixture, injections):
    """Apply a sequence of injections; returns (stream, base, dropped)."""
    dropped_all = []
    for injection in injections or []:
        stream, base_state, dropped, _ = apply_injection(
            stream, base_state, fixture, injection)
        dropped_all.extend(dropped)
    return stream, base_state, dropped_all


# ---------------------------------------------------------------------------
# Divergence classification
# ---------------------------------------------------------------------------

def _message_role_order(state):
    return [m.get("role") for m in state["messages"]]


def _segment_interleave_lost(full_state, resume_state):
    """True when a message whose full-path segments are interleaved with
    a tool call has collapsed to a single merged segment in the resume
    path (AG-UI #3368, PROJECT_BOOK §5.6)."""
    full_timeline = full_state["orderedTimeline"]
    resume_by_id = {m["id"]: m for m in resume_state["messages"]}
    for message in full_state["messages"]:
        message_id = message["id"]
        segments = message.get("segments") or []
        if len(segments) < 2:
            continue
        text_positions = [i for i, item in enumerate(full_timeline)
                          if item.get("kind") == "text"
                          and item.get("messageId") == message_id]
        tool_positions = [i for i, item in enumerate(full_timeline)
                          if item.get("kind") in (
                              "tool_start", "tool_args", "tool_end",
                              "tool_result")]
        if not text_positions or not tool_positions:
            continue
        interleaved = any(text_positions[0] < t < text_positions[-1]
                          for t in tool_positions)
        if not interleaved:
            continue
        resume_message = resume_by_id.get(message_id)
        if resume_message is None:
            continue
        resume_segments = resume_message.get("segments") or []
        if len(resume_segments) == 1 and \
                resume_message.get("content") == message.get("content"):
            return message_id
    return None


def _lost_events(fixture, dropped, resume_state):
    """Dropped resume-stream events whose effect is missing."""
    found = []
    messages = {m["id"]: m for m in resume_state["messages"]}
    calls = {}
    for call in resume_state["toolCalls"]:
        calls.setdefault(call["toolCallId"], call)
    for wrapper in dropped:
        event = wrapper["event"]
        event_type = event["type"]
        if event_type == "TEXT_MESSAGE_CONTENT":
            message = messages.get(event["messageId"])
            content = message.get("content", "") if message else ""
            if event["delta"] not in content:
                found.append(wrapper["sourceIndex"])
        elif event_type == "TOOL_CALL_ARGS":
            call = calls.get(event["toolCallId"])
            args = call.get("args", "") if call else ""
            if event["delta"] not in args:
                found.append(wrapper["sourceIndex"])
        elif event_type == "TOOL_CALL_RESULT":
            call = calls.get(event["toolCallId"])
            if call is None or call.get("result") is None:
                found.append(wrapper["sourceIndex"])
    return found


def _primary_code(diagnostics):
    for diagnostic in diagnostics:
        if diagnostic["severity"] == "CRITICAL":
            return diagnostic["code"]
    return diagnostics[0]["code"] if diagnostics else None


def _path_result(state):
    """The evaluation PathResult (TS planner.ts toPathResult):
    production hash + contents + runStatus. _report converts it to
    the §13.2 report PathResult (runStatus dropped) via
    parity.to_report_path."""
    return evaluation_project_path(state)


# ---------------------------------------------------------------------------
# Cross-language parity projection (FIX-R2, P1-R2-02; ADR-003)
# ---------------------------------------------------------------------------
# The single translation source is oracle.parity: the production
# projection P (verbatim TS projectState shape) and the parity
# projection Q (P + derived timeline runId). The functions are
# re-exported here so existing import sites keep working.
# See oracle/parity.py for the projections, the report conversions
# and the report hashes.

def _first_divergence(full_history, resume_history, base_state,
                      checkpoint_index, events=None):
    """First divergence object (PROJECT_BOOK §8.6).

    Delegates to oracle.diff.find_first_divergence — the verbatim
    mirror of src/replay/align.ts findFirstDivergenceForReplay +
    src/core/diff.ts findFirstDivergence, over the production
    projection. Returns the full firstDivergence object
    {sourceIndex, fullStateHash, resumeStateHash, differences, ...}
    or None. (Before FIX-R2 this returned only the sourceIndex int:
    the first divergence was computed on reduced hashes too.)
    """
    return find_first_divergence(
        full_history, resume_history, base_state, checkpoint_index,
        events=events)


# ---------------------------------------------------------------------------
# Evaluation (no BFS) and full analysis (with BFS)
# ---------------------------------------------------------------------------

def _invalid_input_diagnostic(exc):
    """Build the INVALID_INPUT report diagnostic for a fold failure.

    Two forms, both frozen (FIX-R2, P1-R2-02; coordinator ruling 8):
    * an unsupported or unknown event type reproduces the TS
      template verbatim (planner.ts evaluateFixture):
      `Event at sourceIndex <i> has unsupported or unknown type
      <JSON type>: not one of the 15 MVP events.`
    * every other malformed input uses the fixed template
      (memo §5.5): `Input is invalid: INVALID_INPUT at sourceIndex
      <i>.` — the Oracle's internal wording (e.g. which required
      field is missing) is never a TS message, so it is not
      reproduced; the fixed template keeps the diagnostic
      deterministic and cross-language stable. sourceIndex is
    omitted when the failure carries no index.
    """
    text = str(exc)
    match = re.match(
        r"^sourceIndex (\d+): unsupported event type (.+)$", text)
    if match is not None:
        index = int(match.group(1))
        return {
            "code": "INVALID_INPUT", "severity": "CRITICAL",
            "sourceIndex": index, "relatedSourceIndices": None,
            "message": "Event at sourceIndex "
                       f"{index} has unsupported or unknown type "
                       f"{json.dumps(match.group(2), ensure_ascii=False)}"
                       ": not one of the 15 MVP events.",
            "evidence": {}}
    match = re.match(r"^sourceIndex (\d+): unknown event type '(.+)'$",
                     text)
    if match is not None:
        index = int(match.group(1))
        return {
            "code": "INVALID_INPUT", "severity": "CRITICAL",
            "sourceIndex": index, "relatedSourceIndices": None,
            "message": "Event at sourceIndex "
                       f"{index} has unsupported or unknown type "
                       f"{json.dumps(match.group(2), ensure_ascii=False)}"
                       ": not one of the 15 MVP events.",
            "evidence": {}}
    match = re.match(r"^sourceIndex (\d+):", text)
    if match is not None:
        index = int(match.group(1))
        return {
            "code": "INVALID_INPUT", "severity": "CRITICAL",
            "sourceIndex": None, "relatedSourceIndices": None,
            "message": "Input is invalid: INVALID_INPUT at sourceIndex "
                       f"{index}.",
            "evidence": {}}
    return {
        "code": "INVALID_INPUT", "severity": "CRITICAL",
        "sourceIndex": None, "relatedSourceIndices": None,
        "message": "Input is invalid: INVALID_INPUT.",
        "evidence": {}}


def evaluate(fixture):
    """Analyse one fixture without the BFS shortest-sequence search."""
    started = time.monotonic()
    scenario_id = fixture.get("scenarioId", "?")
    events = fixture.get("events") or []
    if len(events) > MAX_EVENTS:
        return {
            "scenarioId": scenario_id,
            "verdict": "INCONCLUSIVE_LIMIT",
            "diagnostics": [{
                "code": "LIMIT_EXCEEDED", "severity": "WARNING",
                "sourceIndex": None, "relatedSourceIndices": None,
                "message": f"Event count {len(events)} exceeds the "
                           f"{MAX_EVENTS} limit.",
                "evidence": {"eventCount": len(events)}},
            ],
            "firstDivergence": None,
            "fullPath": None,
            "resumePath": None,
            "shortestInjectionSequence": None,
            "metrics": {"durationMs": 0, "visitedStates": 0},
        }
    expanded = expand_chunks(events)
    try:
        full_state, full_diagnostics, full_history = fold(
            events, collect_history=True)
        # TS resolves the checkpoint in the same try as the full
        # fold (planner.ts evaluateFixture): a resolution failure
        # reports fullPath null and visitedStates 0, like a
        # full-fold failure.
        base_state, checkpoint_index = resolve_checkpoint(fixture)
    except (UnsupportedEvent, InvalidInput) as exc:
        # Unsupported event type / malformed input: INVALID_INPUT
        # (§7), not a §8.1 bound overflow — LIMIT_EXCEEDED is
        # reserved for true §8.1 overflows (event count > MAX_EVENTS,
        # BFS node budget).
        return {
            "scenarioId": scenario_id,
            "verdict": "INVALID_INPUT",
            "diagnostics": [_invalid_input_diagnostic(exc)],
            "firstDivergence": None,
            "fullPath": None,
            "resumePath": None,
            "shortestInjectionSequence": None,
            "metrics": {"durationMs": 0, "visitedStates": 0},
        }

    recovery = fixture.get("recovery") or {}
    try:
        stream = build_resume_stream(fixture, checkpoint_index)
        stream, base_state, dropped = apply_injections(
            stream, base_state, fixture, recovery.get("injections") or [])
        resume_state, resume_diagnostics, resume_history = fold(
            stream, initial=base_state, applied_through=checkpoint_index,
            collect_history=True)
    except (UnsupportedEvent, InvalidInput) as exc:
        # TS evaluateFixture: a resume-fold failure reports the full
        # path and visitedStates = full history length (the resume
        # fold contributed nothing).
        return {
            "scenarioId": scenario_id,
            "verdict": "INVALID_INPUT",
            "diagnostics": [_invalid_input_diagnostic(exc)],
            "firstDivergence": None,
            "fullPath": _path_result(full_state),
            "resumePath": None,
            "shortestInjectionSequence": None,
            "metrics": {"durationMs": 0,
                        "visitedStates": len(full_history)},
        }

    truncated = full_state["runStatus"] in ("RUNNING", "NOT_STARTED") \
        and len(events) > 0
    diagnostics = list(resume_diagnostics)
    full_digest = state_hash(full_state)
    resume_digest = state_hash(resume_state)
    diverged = full_digest != resume_digest

    if diverged or diagnostics:
        # Stale-checkpoint snapshot mismatch (G06): the recovery base
        # claims an older sourceIndex than the disconnect point (an
        # explicit stale checkpoint, or a STALE_SNAPSHOT injection)
        # and its shared state disagrees with the full prefix at the
        # disconnect point.
        disconnect_after = recovery.get("disconnectAfter")
        checkpoint = recovery.get("checkpoint")
        stale_source_index = None
        if isinstance(checkpoint, dict) and not checkpoint.get("empty") \
                and disconnect_after is not None \
                and checkpoint.get("sourceIndex", disconnect_after) \
                < disconnect_after:
            stale_source_index = checkpoint.get("sourceIndex")
        if any((inj or {}).get("op") == "STALE_SNAPSHOT"
               for inj in recovery.get("injections") or []):
            stale_source_index = next(
                (w["sourceIndex"] for w in fixture["events"]
                 if w["event"]["type"] == "STATE_SNAPSHOT"), None)
        if stale_source_index is not None and disconnect_after is not None:
            prefix_state, _ = _prefix_fold(fixture, disconnect_after)
            if prefix_state["sharedState"] != base_state["sharedState"] \
                    and not any(d["code"] == "SNAPSHOT_MISMATCH"
                                for d in diagnostics):
                diagnostics.append({
                    "code": "SNAPSHOT_MISMATCH", "severity": "CRITICAL",
                    "sourceIndex": stale_source_index,
                    "relatedSourceIndices": [disconnect_after],
                    "message": "Recovery checkpoint is older than the "
                               "disconnect point and its shared state "
                               "disagrees with the full prefix.",
                    "evidence": {
                        "checkpointIndex": stale_source_index,
                        "disconnectAfter": disconnect_after,
                        "expectedSharedState": prefix_state["sharedState"],
                        "actualSharedState": base_state["sharedState"]},
                })
        # Message order (G02): compare role order of the two paths.
        if _message_role_order(full_state) != _message_role_order(resume_state) \
                and not any(d["code"] == "MESSAGE_REORDER"
                            for d in diagnostics):
            diagnostics.append({
                "code": "MESSAGE_REORDER", "severity": "CRITICAL",
                "sourceIndex": checkpoint_index,
                "relatedSourceIndices": None,
                "message": "Final message order differs from the full path.",
                "evidence": {
                    "expectedOrder": [m["id"] for m in full_state["messages"]],
                    "actualOrder": [m["id"] for m in resume_state["messages"]],
                    "expectedRoles": _message_role_order(full_state),
                    "actualRoles": _message_role_order(resume_state)},
            })
        # Segment interleave lost (G03).
        merged_id = _segment_interleave_lost(full_state, resume_state)
        if merged_id is not None and not any(
                d["code"] == "MESSAGE_REORDER" for d in diagnostics):
            diagnostics.append({
                "code": "MESSAGE_REORDER", "severity": "CRITICAL",
                "sourceIndex": checkpoint_index,
                "relatedSourceIndices": None,
                "message": "A message reopened after a tool call lost its "
                           "text/tool interleave in the resume path.",
                "evidence": {"messageId": merged_id},
            })
        # Lost events (G04): dropped resume-stream payloads whose effect
        # is missing. Suppressed when the trace itself is truncated.
        if not truncated:
            for source_index in _lost_events(fixture, dropped, resume_state):
                if not any(d["code"] == "LOST_EVENT"
                           and d["sourceIndex"] == source_index
                           for d in diagnostics):
                    diagnostics.append({
                        "code": "LOST_EVENT", "severity": "CRITICAL",
                        "sourceIndex": source_index,
                        "relatedSourceIndices": [source_index],
                        "message": "An event from the full trace did not "
                                   "reach the resume path and its effect "
                                   "is missing.",
                        "evidence": {"sourceIndex": source_index},
                    })
        # Order permutation (G05): the resume stream applied the same
        # events in a different order and the states diverged.
        if not any(d["code"] == "OUT_OF_ORDER" for d in diagnostics):
            def _first_occurrence(sequence):
                seen = []
                for item in sequence:
                    if item not in seen:
                        seen.append(item)
                return seen
            full_order = _first_occurrence(
                [i for i, _s, _h in full_history])
            resume_order = _first_occurrence(
                [i for i, _s, _h in resume_history])
            common = [i for i in full_order if i in set(resume_order)]
            resume_common = [i for i in resume_order if i in set(full_order)]
            if len(common) >= 2 and common != resume_common:
                first_diff = next(i for i, (a, b) in enumerate(
                    zip(common, resume_common)) if a != b)
                diagnostics.append({
                    "code": "OUT_OF_ORDER", "severity": "CRITICAL",
                    "sourceIndex": common[first_diff],
                    "relatedSourceIndices": None,
                    "message": "The resume path applied events in a "
                               "different order than the full path.",
                    "evidence": {"expectedOrder": common,
                                 "actualOrder": resume_common},
                })
        if diverged and not truncated and not diagnostics:
            diagnostics.append({
                "code": "DIVERGENT_STATE", "severity": "CRITICAL",
                "sourceIndex": None,
                "relatedSourceIndices": None,
                "message": "Canonical full and resume states differ.",
                "evidence": {"fullStateHash": full_digest,
                             "resumeStateHash": resume_digest},
            })

    diagnostics.sort(key=lambda d: (
        d["sourceIndex"] is None,
        d["sourceIndex"] if d["sourceIndex"] is not None else 0,
        d["code"]))
    has_critical = any(d["severity"] == "CRITICAL" for d in diagnostics)
    if has_critical:
        verdict = "INCONSISTENT"
    elif truncated:
        verdict = "INCOMPLETE_TRACE"
        diagnostics.append({
            "code": "TRUNCATED_RUN", "severity": "WARNING",
            "sourceIndex": len(events) - 1,
            "relatedSourceIndices": None,
            "message": "The stream ended before a terminal event "
                       "(RUN_FINISHED / RUN_ERROR).",
            "evidence": {"lastSourceIndex": len(events) - 1,
                         "runStatus": full_state["runStatus"]},
        })
    elif diverged:
        verdict = "INCONSISTENT"
    else:
        verdict = "CONSISTENT"

    first_divergence = None
    if verdict in ("INCONSISTENT", "INCOMPLETE_TRACE"):
        first_divergence = _first_divergence(
            full_history, resume_history, base_state, checkpoint_index,
            events=expanded)

    duration_ms = int((time.monotonic() - started) * 1000)
    return {
        "scenarioId": scenario_id,
        "verdict": verdict,
        "diagnostics": diagnostics,
        "firstDivergence": first_divergence,
        "fullPath": _path_result(full_state),
        "resumePath": _path_result(resume_state),
        "shortestInjectionSequence": None,
        # TS planner.ts:1331 — visitedStates is the full + resume
        # fold history lengths (error paths: limit/unknown/full-fold
        # failure -> 0, resume-fold failure -> len(full_history);
        # those returns are built above).
        "metrics": {"durationMs": duration_ms,
                    "visitedStates": len(full_history)
                    + len(resume_history)},
        # FIX-R2 parity (§10.4): hashes/paths over the shared parity
        # projection Q (oracle.parity), present on successful
        # evaluations; error returns (INVALID_INPUT /
        # INCONCLUSIVE_LIMIT) omit them — the S0 bridge reads them
        # with .get() and treats a missing value as "no parity".
        "parityFullStateHash": parity_state_hash(full_state),
        "parityResumeStateHash": parity_state_hash(resume_state),
        "parityFullPath": parity_project_path(full_state),
        "parityResumePath": parity_project_path(resume_state),
    }


# ---------------------------------------------------------------------------
# BFS shortest fault sequence (§8.5)
# ---------------------------------------------------------------------------

def _legal_baseline(fixture):
    """The legal recovery of the same events: correct checkpoint, no
    injections. A FULL_REPLAY over a populated checkpoint is itself
    the G01 fault, so the baseline uses RESUME_FROM_CHECKPOINT there.
    """
    baseline = copy.deepcopy(fixture)
    recovery = baseline.setdefault("recovery", {})
    recovery["injections"] = []
    # An explicit (non-empty) checkpoint is the fault itself in G02/G03/
    # G06, so the legal baseline recomputes it from the covered prefix.
    # An {"empty": true} checkpoint is already the legal empty base and
    # must be kept (N06: full replay from empty).
    checkpoint = (fixture.get("recovery") or {}).get("checkpoint")
    if isinstance(checkpoint, dict) and not checkpoint.get("empty"):
        recovery["checkpoint"] = None
    if recovery.get("strategy") == "FULL_REPLAY_FROM_START":
        # A full replay over a populated checkpoint is itself the G01
        # fault: the covered prefix is applied twice. The legal baseline
        # resumes after the checkpoint instead. A replay from the empty
        # base (N06) stays a full replay.
        disconnect_after = (fixture.get("recovery") or {}).get(
            "disconnectAfter")
        empty_base = isinstance(checkpoint, dict) and checkpoint.get("empty")
        populated = (not empty_base) and disconnect_after is not None \
            and disconnect_after >= 0
        if populated:
            recovery["strategy"] = "RESUME_FROM_CHECKPOINT"
            # The fixture's resumeAfterSourceIndex belongs to the full
            # replay (0); resuming after the checkpoint instead.
            recovery["resumeAfterSourceIndex"] = disconnect_after
    return baseline


def _canonical_injection(operator, fixture, base_state, stream):
    """The single canonical application of *operator* on the clean
    baseline (see module docstring for the definitions)."""
    if operator == "CURSOR_SKIP":
        recovery = fixture.get("recovery") or {}
        checkpoint_index = recovery.get("disconnectAfter", -1)
        # Skipping only already-covered events is a legal no-op. If the
        # resume stream actually contains events in that range (e.g. a
        # FULL_REPLAY stream), the range is not skippable: the operator
        # is inapplicable rather than a disguised DROP_EVENT.
        if any(checkpoint_index - 1 <= w["sourceIndex"] <= checkpoint_index
               for w in stream):
            return None
        return {"op": "CURSOR_SKIP",
                "from": checkpoint_index - 1, "to": checkpoint_index}
    if operator == "DROP_EVENT":
        if not stream:
            return None
        return {"op": "DROP_EVENT",
                "sourceIndex": stream[0]["sourceIndex"]}
    if operator == "DUPLICATE_EVENT":
        for wrapper in stream:
            if wrapper["event"]["type"] in (
                    "TEXT_MESSAGE_CONTENT", "TOOL_CALL_ARGS"):
                return {"op": "DUPLICATE_EVENT",
                        "sourceIndex": wrapper["sourceIndex"]}
        return None
    if operator == "MESSAGE_ID_REMAP":
        assistant = next(
            (m for m in base_state["messages"]
             if m.get("role") == "assistant"), None)
        if assistant is None:
            return None
        return {"op": "MESSAGE_ID_REMAP",
                "messageId": assistant["id"],
                "newMessageId": assistant["id"] + "-remapped"}
    if operator == "REPLAY_PREFIX":
        return {"op": "REPLAY_PREFIX"}
    if operator == "STALE_SNAPSHOT":
        return {"op": "STALE_SNAPSHOT"}
    if operator == "SWAP_ADJACENT":
        if len(stream) < 2:
            return None
        return {"op": "SWAP_ADJACENT",
                "sourceIndex": stream[0]["sourceIndex"]}
    if operator == "TRUNCATE_STREAM":
        terminal = next(
            (w for w in stream
             if w["event"]["type"] in TERMINAL_TYPES), None)
        if terminal is not None:
            return {"op": "TRUNCATE_STREAM",
                    "sourceIndex": terminal["sourceIndex"]}
        if stream:
            return {"op": "TRUNCATE_STREAM",
                    "sourceIndex": stream[-1]["sourceIndex"]}
        return None
    return None


def _goal_reached(result, target_code):
    if target_code is None:
        # Normal fixture: any divergence from CONSISTENT.
        return result["verdict"] != "CONSISTENT"
    codes = [d["code"] for d in result["diagnostics"]]
    return target_code in codes


def bfs_shortest(fixture, target_code, max_depth=MAX_DEPTH,
                 max_nodes=MAX_NODES):
    """Deterministic BFS for the shortest injection sequence.

    Returns (sequence, visited): a list of operator names (possibly
    []), or None when no sequence within the bounds reproduces the
    goal, and the number of evaluateSequence calls made — including
    the initial [] evaluation and, on exhaustion, the exceeding call
    (TS search.ts counts the same way: visited = maxNodes+1).
    Raises InvalidInput when the node budget is exhausted (caller
    maps it to INCONCLUSIVE_LIMIT); the exception carries .visited.
    (Before FIX-R2 this returned only the list; the visited count
    was a discarded local — memo §6.3-(B).)
    """
    baseline = _legal_baseline(fixture)
    visited = 0

    def evaluate_sequence(sequence):
        nonlocal visited
        visited += 1
        if visited > max_nodes:
            exc = InvalidInput(
                f"BFS node budget {max_nodes} exhausted")
            exc.visited = visited
            raise exc
        trial = copy.deepcopy(baseline)
        injections = []
        base_state, checkpoint_index = resolve_checkpoint(trial)
        stream = build_resume_stream(trial, checkpoint_index)
        for operator in sequence:
            injection = _canonical_injection(
                operator, trial, base_state, stream)
            if injection is None:
                return None  # operator inapplicable here
            stream, base_state, _dropped, changed = apply_injection(
                stream, base_state, trial, injection)
            if not changed:
                return None  # no-op: this branch cannot diverge
            injections.append(injection)
        trial["recovery"]["injections"] = injections
        return evaluate(trial)

    initial = evaluate_sequence(())
    if initial is not None and _goal_reached(initial, target_code):
        return [], visited
    frontier = [()]
    for _depth in range(1, max_depth + 1):
        next_frontier = []
        for sequence in frontier:
            for operator in OPERATOR_ORDER:
                candidate = sequence + (operator,)
                result = evaluate_sequence(candidate)
                if result is None:
                    continue
                if _goal_reached(result, target_code):
                    return list(candidate), visited
                next_frontier.append(candidate)
        frontier = next_frontier
    return None, visited


# ---------------------------------------------------------------------------
# Full analysis
# ---------------------------------------------------------------------------

def analyze(fixture, target_code=None, source_text=None,
            source_format=None):
    """Full Oracle analysis of one fixture, including the BFS search.

    *target_code* is the fixture's primary diagnostic code for fault
    fixtures (None for normal fixtures, where any divergence is the
    goal). The report follows rejoinlab.report/v1 (§13.2).
    *source_text* is the raw fixture file text (for
    input.sourceSha256); when omitted the legacy json.dumps hash is
    used. *source_format* is the source format ("JSONL" default).
    bfsVisited is returned as a top-level key, NOT inside metrics:
    TS keeps it out of the JSON report entirely (json.ts
    WorkerReportBuild — "仅 HTML 展示用，不进 JSON"), so it must not
    enter the production report hash.
    """
    result = evaluate(fixture)
    scenario_id = fixture.get("scenarioId", "?")
    if result["verdict"] in ("INVALID_INPUT", "INCONCLUSIVE_LIMIT"):
        result["bfsVisited"] = 0
        report = _report(fixture, result, None, source_text=source_text,
                         source_format=source_format)
        report["bfsVisited"] = 0
        report["parityFullPath"] = result.get("parityFullPath")
        report["parityResumePath"] = result.get("parityResumePath")
        return report
    try:
        shortest, bfs_visited = bfs_shortest(fixture, target_code)
    except InvalidInput as exc:
        result["verdict"] = "INCONCLUSIVE_LIMIT"
        shortest = None
        bfs_visited = getattr(exc, "visited", 0)
    result["shortestInjectionSequence"] = shortest
    result["bfsVisited"] = bfs_visited
    report = _report(fixture, result, shortest, source_text=source_text,
                     source_format=source_format)
    report["bfsVisited"] = bfs_visited
    report["parityFullPath"] = result.get("parityFullPath")
    report["parityResumePath"] = result.get("parityResumePath")
    return report


def _report(fixture, result, shortest, source_text=None,
            source_format=None):
    """Build the rejoinlab.report/v1 report (PROJECT_BOOK §13.2).

    Byte-equal to TS buildReport (src/report/json.ts) for the same
    analysis, except metrics.durationMs (excluded from the report
    hash by both sides). Rules reproduced verbatim:
    * input.sourceSha256 = sha256 of the RAW source text (UTF-8, no
      newline normalisation); the legacy json.dumps fallback applies
      only when no source text was supplied.
    * input.sourceFormat is the actual source format.
    * recovery optional keys are included iff present in the fixture
      recovery object (TS `!== undefined` — a JSON null is kept).
    * diagnostics pass through to_report_diagnostic (sourceIndex /
      relatedSourceIndices omitted when empty).
    * firstDivergence is omitted entirely when null; otherwise the
      A-07-stripped form from oracle.diff.
    * assumptions / limitations are the frozen TS Chinese texts
      (src/report/schema.ts REPORT_ASSUMPTIONS /
      REPORT_LIMITATIONS), verbatim.
    * metrics = {durationMs, visitedStates} only — bfsVisited never
      enters the JSON report (TS WorkerReportBuild).
    """
    recovery = fixture.get("recovery") or {}
    events = fixture.get("events") or []
    if source_text is not None:
        source_sha = hashlib.sha256(
            source_text.encode("utf-8")).hexdigest()
    else:
        source_sha = hashlib.sha256(
            json.dumps(events, sort_keys=True,
                       ensure_ascii=False).encode("utf-8")).hexdigest()
    report_recovery = {
        "strategy": recovery.get("strategy", "RESUME_FROM_CHECKPOINT"),
    }
    if "disconnectAfter" in recovery:
        report_recovery["disconnectAfter"] = recovery["disconnectAfter"]
    if "resumeAfterSourceIndex" in recovery:
        report_recovery["resumeAfterSourceIndex"] = (
            recovery["resumeAfterSourceIndex"])
    report = {
        "schema": "rejoinlab.report/v1",
        "specVersion": SPEC_VERSION,
        "protocolVersion": PROTOCOL_VERSION,
        "scenarioId": fixture.get("scenarioId", "?"),
        "verdict": result["verdict"],
        "input": {
            "sourceFormat": source_format or "JSONL",
            "eventCount": len(events),
            "sourceSha256": source_sha,
        },
        "recovery": report_recovery,
        # result paths are evaluation paths (runStatus carried);
        # the report PathResult drops runStatus (TS toReportPath).
        "fullPath": to_report_path(result["fullPath"]),
        "resumePath": to_report_path(result["resumePath"]),
        "diagnostics": [to_report_diagnostic(d)
                        for d in result["diagnostics"]],
        "shortestInjectionSequence": shortest,
        "metrics": {"durationMs": result["metrics"]["durationMs"],
                    "visitedStates": result["metrics"]["visitedStates"]},
        "assumptions": list(REPORT_ASSUMPTIONS),
        "limitations": list(REPORT_LIMITATIONS),
    }
    first_divergence = result.get("firstDivergence")
    if first_divergence is not None:
        report["firstDivergence"] = to_report_first_divergence(
            first_divergence)
    return report
