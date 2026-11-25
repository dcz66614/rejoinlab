"""P031 RejoinLab — independent Python Oracle reducer (reference.py).

A from-scratch implementation of the PROJECT_BOOK §5 deterministic
state reducer, written only from the frozen written specification
(PROJECT_BOOK.md v1.0.2 §3–§6, docs/EVENT_SCHEMA.md,
docs/AGUI_SCOPE.md). It shares no code with the production TypeScript
implementation, never reads production output, and must never be used
to generate Golden expected values — those are hand-derived in
oracle/golden_expected.json.

State shape (PROJECT_BOOK §5.1):
  threadId, runs, messages, toolCalls, sharedState, orderedTimeline,
  pendingToolCallIds, runStatus.

Notable rules implemented here:
  * arrival order is authoritative; timestamp is never used to sort;
  * TEXT_MESSAGE_CHUNK / TOOL_CALL_CHUNK are expanded to
    START / CONTENT|ARGS / END before reduction (EVENT_SCHEMA §4.5/§5.4);
  * MESSAGES_SNAPSHOT follows the four reconciliation rules plus the
    per-role self-revoking exception (EVENT_SCHEMA §6.3);
  * STATE_DELTA is an atomic RFC 6902 patch (EVENT_SCHEMA §6.2);
  * a TOOL_CALL_START replayed over an already-applied closed call
    (AG-UI #1524) is a DUPLICATE_TOOL_CALL and is recorded as a second
    tool-call entry, so the divergence stays visible in the state;
  * a TEXT_MESSAGE_START replayed over an already-open message is a
    harmless no-op; a START for a closed message is a legal reopen
    (new text segment, same message entry);
  * payloads (TEXT_MESSAGE_CONTENT / TOOL_CALL_ARGS) re-applied with
    no stable event id are NOT de-duplicated — they are applied again
    and flagged SUSPECTED_DUPLICATE (PROJECT_BOOK §4.3);
  * RUN_ERROR may precede RUN_STARTED; it is a terminal event;
  * pendingToolCallIds is a DERIVED field, not a wire echo (PROJECT_BOOK
    §3.14/§5.5; docs/ADR-F01-pending-derived.md): after every event it
    is recomputed as the closed-and-unresulted tool calls (TOOL_CALL_END
    seen, no TOOL_CALL_RESULT yet), in tool-call order. A RUN_FINISHED
    outcome.success pendingToolCallIds list is CHECKED against the
    derived subset of that run and never copied into state; a mismatch
    raises InvalidInput ([PENDING_TOOL_CALL_MISMATCH]). A frontend tool
    call may therefore end its run pending with no outcome at all, and
    its result may arrive in a later run.
"""

from __future__ import annotations

import copy
import json
import re

from oracle.canonical import state_hash

__all__ = [
    "InvalidInput",
    "UnsupportedEvent",
    "initial_state",
    "expand_chunks",
    "validate_event",
    "fold",
    "apply_json_patch",
    "reconcile_messages_snapshot",
    "MVP_EVENT_TYPES",
    "DIAGNOSTIC_SEVERITY",
]

MVP_EVENT_TYPES = (
    "RUN_STARTED", "RUN_FINISHED", "RUN_ERROR",
    "TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END",
    "TEXT_MESSAGE_CHUNK",
    "TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_END",
    "TOOL_CALL_CHUNK", "TOOL_CALL_RESULT",
    "STATE_SNAPSHOT", "STATE_DELTA", "MESSAGES_SNAPSHOT",
)

# AG-UI 1.0 event types that exist but are out of MVP scope (AGUI_SCOPE §3).
KNOWN_UNSUPPORTED_TYPES = (
    "STEP_STARTED", "STEP_FINISHED",
    "REASONING_START", "REASONING_MESSAGE_START",
    "REASONING_MESSAGE_CONTENT", "REASONING_MESSAGE_END",
    "REASONING_MESSAGE_CHUNK", "REASONING_END",
    "REASONING_ENCRYPTED_VALUE",
    "ACTIVITY_SNAPSHOT", "ACTIVITY_DELTA",
    "SUBAGENT_STARTED", "SUBAGENT_FINISHED", "SUBAGENT_ERROR",
    "RAW", "CUSTOM",
)

DIAGNOSTIC_SEVERITY = {
    "DUPLICATE_TOOL_CALL": "CRITICAL",
    "LOST_EVENT": "CRITICAL",
    "OUT_OF_ORDER": "CRITICAL",
    "MESSAGE_REORDER": "CRITICAL",
    "SNAPSHOT_MISMATCH": "CRITICAL",
    "DIVERGENT_STATE": "CRITICAL",
    "SUSPECTED_DUPLICATE": "WARNING",
    "TOOL_CALL_ID_REUSE": "WARNING",
    "TRUNCATED_RUN": "WARNING",
    "MISSING_TERMINAL": "WARNING",
    # Oracle extension (not in PROJECT_BOOK §6): a JSON Patch op whose
    # name RFC 6902 does not define is dropped with a warning, per
    # EVENT_SCHEMA §6.2. Documented here so a reviewer can see it.
    "UNKNOWN_PATCH_OP": "WARNING",
    # Oracle extension: the §8.1 size/search bounds were exceeded.
    "LIMIT_EXCEEDED": "WARNING",
    # Oracle extension: the INVALID_INPUT verdict path reports its own
    # diagnostic code (same name as the verdict). It is an Oracle-internal
    # code, not in PROJECT_BOOK §6: §6's DIVERGENT_STATE means "the two
    # tracks' canonical states differ", which must not be used for a
    # malformed input. Documented here so a reviewer can see it.
    "INVALID_INPUT": "CRITICAL",
}

# ReducerError -> report diagnostic mapping (FIX-R2, P1-R2-02).
# Verbatim mirror of src/replay/planner.ts REDUCER_ERROR_TO_DIAGNOSTIC
# (frozen T005 ruling): a ReducerError thrown by the strict TS Reducer
# becomes a report diagnostic with the mapped code/severity, the
# message "[CODE] <ReducerError body>", and evidence
# {reducerCode, messageId?, toolCallId?, runId?} (only the ids the
# ReducerError carries). Codes not listed here fall back to
# OUT_OF_ORDER / CRITICAL. The foldTrack-injected diagnostics
# (DUPLICATE_TOOL_CALL, TOOL_CALL_ID_REUSE on an incomplete reopen,
# the merged TEXT reopen message, SUSPECTED_DUPLICATE) do NOT go
# through this table: they are built directly in _reduce_one with
# their own TS-verbatim messages.
REDUCER_ERROR_TO_DIAGNOSTIC = {
    "CONTENT_WITHOUT_START": ("OUT_OF_ORDER", "CRITICAL"),
    "ARGS_WITHOUT_START": ("OUT_OF_ORDER", "CRITICAL"),
    "END_WITHOUT_START": ("OUT_OF_ORDER", "CRITICAL"),
    "RESULT_WITHOUT_CALL": ("OUT_OF_ORDER", "CRITICAL"),
    "RESULT_FOR_INCOMPLETE_CALL": ("OUT_OF_ORDER", "CRITICAL"),
    "DUPLICATE_TOOL_CALL_RESULT": ("DUPLICATE_TOOL_CALL", "CRITICAL"),
    "DUPLICATE_MESSAGE_START": ("OUT_OF_ORDER", "CRITICAL"),
    "DUPLICATE_MESSAGE_ID": ("OUT_OF_ORDER", "CRITICAL"),
    "MESSAGE_REOPEN_ROLE_MISMATCH": ("OUT_OF_ORDER", "CRITICAL"),
    "MESSAGE_REOPEN_NAME_MISMATCH": ("OUT_OF_ORDER", "CRITICAL"),
    "REOPEN_INCOMPLETE_MESSAGE": ("OUT_OF_ORDER", "CRITICAL"),
    "REOPEN_INCOMPLETE_TOOL_CALL": ("OUT_OF_ORDER", "CRITICAL"),
    "TOOL_CALL_REOPEN_NAME_MISMATCH": ("TOOL_CALL_ID_REUSE", "WARNING"),
    "TOOL_CALL_ID_REUSE": ("TOOL_CALL_ID_REUSE", "WARNING"),
    "EVENT_WITHOUT_RUN": ("OUT_OF_ORDER", "CRITICAL"),
    "DUPLICATE_RUN_ID": ("OUT_OF_ORDER", "CRITICAL"),
    "RUN_ALREADY_RUNNING": ("OUT_OF_ORDER", "CRITICAL"),
    "THREAD_MISMATCH": ("OUT_OF_ORDER", "CRITICAL"),
    "RUN_INPUT_MISMATCH": ("OUT_OF_ORDER", "CRITICAL"),
}
# FIX-R3 (P1-R3-01, ADR-004): PENDING_TOOL_CALL_MISMATCH,
# FINISH_WITHOUT_START and FINISH_WRONG_RUN are deliberately ABSENT
# from this table. They never reach _reducer_diagnostic: _reduce_one
# raises InvalidInput for them (RUN_FINISHED branch), which
# replay.evaluate maps to verdict INVALID_INPUT — the same channel
# the TS planner's [INVALID_INPUT] re-throw uses. Do not re-add
# them here: the fallback would report them as OUT_OF_ORDER and the
# fold would continue (the fail-open shape R3 caught).


def _reducer_diagnostic(code, source_index, body, message_id=None,
                        tool_call_id=None, run_id=None):
    """Build a ReducerError-translation diagnostic (see the table).

    *body* is the ReducerError message WITHOUT the "[CODE] " prefix;
    the prefix is added here, exactly as the TS planner does
    (diagnostic(mapped.code, mapped.severity, error.message, ...),
    where error.message already carries "[CODE] " — the TS
    ReducerError constructor prepends it; here the caller passes the
    bare body and this helper prepends it once).
    """
    mapped_code, _severity = REDUCER_ERROR_TO_DIAGNOSTIC.get(
        code, ("OUT_OF_ORDER", "CRITICAL"))
    evidence = {"reducerCode": code}
    if message_id is not None:
        evidence["messageId"] = message_id
    if tool_call_id is not None:
        evidence["toolCallId"] = tool_call_id
    if run_id is not None:
        evidence["runId"] = run_id
    return {
        "code": mapped_code,
        "severity": _severity,
        "sourceIndex": source_index,
        "relatedSourceIndices": None,
        "message": f"[{code}] {body}",
        "evidence": evidence,
    }


def _require_open_run(state, event_type, source_index, diagnostics):
    """Mirror TS requireOpenRun (src/core/reducer.ts): stream events
    belong to a run. Returns the open run's runId, or None after
    recording the EVENT_WITHOUT_RUN diagnostic (state unchanged)."""
    run_id = _current_run_id(state)
    if run_id is not None:
        return run_id
    diagnostics.append(_reducer_diagnostic(
        "EVENT_WITHOUT_RUN", source_index,
        f"{event_type} arrived with no run open: stream events belong "
        "to a run (RUN_STARTED ... RUN_FINISHED / RUN_ERROR). "
        "State-only snapshots outside a run are the single exception "
        "and are handled separately."))
    return None


def _message_status(message):
    if message.get("incomplete"):
        return "incomplete"
    if message.get("open"):
        return "open"
    return "closed"


def _tool_call_status(call):
    if call.get("incomplete"):
        return "incomplete"
    if call.get("result") is not None:
        return "resulted"
    if call.get("open"):
        return "open"
    return "closed"


class InvalidInput(ValueError):
    """The input event stream is malformed (PROJECT_BOOK verdict)."""


class UnsupportedEvent(ValueError):
    """A known AG-UI 1.0 event outside the MVP scope was encountered."""


# ---------------------------------------------------------------------------
# State construction
# ---------------------------------------------------------------------------

def initial_state() -> dict:
    # sharedState is None ("no baseline yet", mirroring TS
    # RejoinState.sharedState === undefined, which the TS projection
    # encodes as null). The first RUN_STARTED adopts its input.state
    # (or {} when there is no input); a STATE_SNAPSHOT installs its
    # snapshot. Never default to {} here: {} is a real (empty)
    # baseline, and conflating the two would let a later RUN_STARTED
    # input.state silently overwrite an established empty baseline
    # (or fail to adopt a first input.state) — see _seed_run_input.
    return {
        "threadId": None,
        "runs": [],
        "messages": [],
        "toolCalls": [],
        "sharedState": None,
        "orderedTimeline": [],
        "pendingToolCallIds": [],
        "runStatus": "NOT_STARTED",
    }


def _new_message(message_id, role="assistant", name=None):
    return {
        "id": message_id,
        "role": role,
        "name": name,
        "content": "",
        "segments": [{"text": ""}],
        "toolCalls": [],
        "open": True,
        "incomplete": False,
        # Owner mirrors TS MessageState.owner (PROJECT_BOOK §5.1):
        # "producer" for everything that arrives on the event stream
        # or in a producer snapshot; "client" is set only by
        # _seed_run_input for activity/reasoning input messages. The
        # key is NOT part of canonicalize_state()'s projection (like
        # TS diagnostics), so existing state hashes are unchanged; it
        # exists so the S0 parity projection can compare owner
        # cross-language instead of dropping the field.
        "owner": "producer",
    }


def _new_tool_call(tool_call_id, tool_call_name, parent_message_id=None,
                   run_id=None):
    return {
        "toolCallId": tool_call_id,
        "toolCallName": tool_call_name,
        "parentMessageId": parent_message_id,
        "args": "",
        "result": None,
        "resultMessageId": None,
        "open": True,
        "incomplete": False,
        "duplicate": False,
        # The run that (re)opened this logical execution (mirrors TS
        # ToolCallState.runId). Needed only for the run-scoped
        # RUN_FINISHED pending comparison (ADR-F01); it is NOT part of
        # the canonical state projection (oracle/canonical.py), so
        # existing state hashes are unchanged.
        "runId": run_id,
    }


def _diagnostic(code, source_index, message, evidence=None,
                related=None):
    # related is None when TS omits relatedSourceIndices entirely
    # (most diagnostics); a list when TS carries it (only
    # DUPLICATE_TOOL_CALL, LOST_EVENT, and the stale-checkpoint
    # SNAPSHOT_MISMATCH). The report conversion drops a None/empty
    # value; the internal shape keeps the distinction.
    return {
        "code": code,
        "severity": DIAGNOSTIC_SEVERITY[code],
        "sourceIndex": source_index,
        "relatedSourceIndices": related,
        "message": message,
        "evidence": evidence or {},
    }


# ---------------------------------------------------------------------------
# Validation (EVENT_SCHEMA §9, layers 1–2)
# ---------------------------------------------------------------------------

_REQUIRED_FIELDS = {
    "RUN_STARTED": ("threadId", "runId"),
    "RUN_FINISHED": ("threadId", "runId"),
    "RUN_ERROR": ("message",),
    "TEXT_MESSAGE_START": ("messageId",),
    "TEXT_MESSAGE_CONTENT": ("messageId", "delta"),
    "TEXT_MESSAGE_END": ("messageId",),
    "TOOL_CALL_START": ("toolCallId", "toolCallName"),
    "TOOL_CALL_ARGS": ("toolCallId", "delta"),
    "TOOL_CALL_END": ("toolCallId",),
    "TOOL_CALL_RESULT": ("messageId", "toolCallId", "content"),
    "STATE_SNAPSHOT": ("snapshot",),
    "STATE_DELTA": ("delta",),
    "MESSAGES_SNAPSHOT": ("messages",),
}


def _validate_content_parts(content, source_index, where):
    """Validate a ContentPart array, mirroring TS checkContentParts
    (src/parser/normalize.ts) verbatim, anchored on the AG-UI 1.0
    Schema $defs ContentPart / TextPart / ImagePart / AudioPart /
    VideoPart / DocumentPart (docs/ag-ui-1.0-schema.json):
      * a part must be an object with a string "type";
      * type "text" requires "text" (string);
      * types "image" / "audio" / "video" / "document" require
        "source" (object with string "type" and "value");
      * any other type is rejected.
    A string content returns unchanged (it is not a part array);
    anything else is not a valid content at all. Raises
    InvalidInput on the first violation.
    """
    if isinstance(content, str):
        return
    if not isinstance(content, list):
        raise InvalidInput(
            f"sourceIndex {source_index}: {where} must be a string or "
            "an array of content parts")
    for i, part in enumerate(content):
        if not isinstance(part, dict) \
                or not isinstance(part.get("type"), str):
            raise InvalidInput(
                f"sourceIndex {source_index}: {where}[{i}].type must be "
                "a string")
        part_type = part["type"]
        if part_type == "text":
            if not isinstance(part.get("text"), str):
                raise InvalidInput(
                    f"sourceIndex {source_index}: {where}[{i}].text must "
                    "be a string for a text part")
        elif part_type in ("image", "audio", "video", "document"):
            source = part.get("source")
            if not isinstance(source, dict) \
                    or not isinstance(source.get("type"), str) \
                    or not isinstance(source.get("value"), str):
                raise InvalidInput(
                    f"sourceIndex {source_index}: {where}[{i}].source "
                    "must be an object with string \"type\" and "
                    "\"value\" for a media part")
        else:
            raise InvalidInput(
                f"sourceIndex {source_index}: {where}[{i}].type is not "
                "a known content part type: "
                f"{part_type!r}")


def _validate_message(message, source_index, where):
    """Per-role required-field check for one AG-UI message.

    Shared by both call sites that carry a messages array —
    RUN_STARTED.input and MESSAGES_SNAPSHOT — so the two paths
    reject exactly the same shapes (FIX-R2, P1-R2-01). Mirrors the
    TS checkMessagesArray (src/parser/normalize.ts), anchored on the
    AG-UI 1.0 Schema $defs (docs/ag-ui-1.0-schema.json):
      * developer / system / reasoning: content must be a string;
      * assistant: content is optional (a turn may be tool calls
        only), but must be a string when present;
      * user / tool: content must be a string or a ContentPart
        array; tool additionally requires toolCallId (string).
        Each part of an array is validated by
        _validate_content_parts (TS checkContentParts mirror);
      * activity: activityType must be a string and content must
        be an object.
    Common id/role are checked here too, so a caller needs no
    separate shape check. Raises InvalidInput on the first
    violation; a missing content is never defaulted here.
    """
    if not isinstance(message, dict):
        raise InvalidInput(
            f"sourceIndex {source_index}: {where} must be a message object")
    if not isinstance(message.get("id"), str):
        raise InvalidInput(
            f"sourceIndex {source_index}: {where}.id must be a string")
    role = message.get("role")
    if role not in ("developer", "system", "assistant", "user", "tool",
                    "activity", "reasoning"):
        raise InvalidInput(
            f"sourceIndex {source_index}: {where}.role must be one of "
            "developer, system, assistant, user, tool, activity, "
            f"reasoning, got {role!r}")
    if role in ("developer", "system", "reasoning"):
        if not isinstance(message.get("content"), str):
            raise InvalidInput(
                f"sourceIndex {source_index}: {where}.content must be a "
                f"string (role {role!r} requires content)")
    elif role == "assistant":
        if "content" in message \
                and not isinstance(message.get("content"), str):
            raise InvalidInput(
                f"sourceIndex {source_index}: {where}.content must be a "
                "string when present (role 'assistant')")
    elif role in ("user", "tool"):
        content = message.get("content")
        if isinstance(content, str):
            pass
        elif isinstance(content, list):
            _validate_content_parts(
                content, source_index, f"{where}.content")
        else:
            raise InvalidInput(
                f"sourceIndex {source_index}: {where} (role {role!r}) must "
                "carry a string or ContentPart-array 'content'")
    elif role == "activity":
        if not isinstance(message.get("activityType"), str):
            raise InvalidInput(
                f"sourceIndex {source_index}: {where}.activityType must be "
                "a string (role 'activity' requires activityType)")
        if not isinstance(message.get("content"), dict):
            raise InvalidInput(
                f"sourceIndex {source_index}: {where}.content must be an "
                "object (role 'activity' requires content)")
    if role == "tool" and not isinstance(message.get("toolCallId"), str):
        raise InvalidInput(
            f"sourceIndex {source_index}: {where}.toolCallId must be a "
            "string (role 'tool' requires toolCallId)")


def validate_event(event: dict, source_index: int) -> None:
    """Raise InvalidInput / UnsupportedEvent for a malformed event."""
    if not isinstance(event, dict):
        raise InvalidInput(f"sourceIndex {source_index}: event is not an object")
    event_type = event.get("type")
    if not isinstance(event_type, str):
        raise InvalidInput(f"sourceIndex {source_index}: missing event type")
    if event_type in KNOWN_UNSUPPORTED_TYPES:
        raise UnsupportedEvent(
            f"sourceIndex {source_index}: unsupported event type {event_type}")
    if event_type not in MVP_EVENT_TYPES:
        raise InvalidInput(
            f"sourceIndex {source_index}: unknown event type {event_type!r}")
    for field in _REQUIRED_FIELDS.get(event_type, ()):
        if field not in event:
            raise InvalidInput(
                f"sourceIndex {source_index}: {event_type} missing required "
                f"field {field!r}")
    if "timestamp" in event and not isinstance(event["timestamp"], int):
        raise InvalidInput(
            f"sourceIndex {source_index}: timestamp must be an integer")
    if event_type == "TEXT_MESSAGE_CONTENT" and not isinstance(event["delta"], str):
        raise InvalidInput(f"sourceIndex {source_index}: delta must be a string")
    if event_type == "TOOL_CALL_ARGS" and not isinstance(event["delta"], str):
        raise InvalidInput(f"sourceIndex {source_index}: delta must be a string")
    if event_type == "TOOL_CALL_RESULT":
        if event.get("role") is not None and event["role"] != "tool":
            raise InvalidInput(
                f"sourceIndex {source_index}: TOOL_CALL_RESULT role must be 'tool'")
        content = event["content"]
        if not isinstance(content, (str, list)):
            raise InvalidInput(
                f"sourceIndex {source_index}: TOOL_CALL_RESULT content must be "
                "a string or a ContentPart array")
        if isinstance(content, list):
            # Same rule as the user/tool message branches of
            # _validate_message: a part array is deep-validated by the
            # shared _validate_content_parts (TS checkContentParts
            # mirror, FIX-R2 P1-R2-01 same-class residual). A string
            # content passes through unchanged.
            _validate_content_parts(
                content, source_index, "TOOL_CALL_RESULT content")
    if event_type == "STATE_DELTA" and not isinstance(event["delta"], list):
        raise InvalidInput(
            f"sourceIndex {source_index}: STATE_DELTA delta must be an array")
    if event_type == "MESSAGES_SNAPSHOT" and not isinstance(event["messages"], list):
        raise InvalidInput(
            f"sourceIndex {source_index}: MESSAGES_SNAPSHOT messages must be an array")
    if event_type == "MESSAGES_SNAPSHOT":
        # Per-message check shared with RUN_STARTED.input (see
        # _validate_message): a snapshot must not silently accept a
        # message the other path rejects.
        for i, message in enumerate(event["messages"]):
            _validate_message(
                message, source_index, f"MESSAGES_SNAPSHOT messages[{i}]")
    if event_type == "RUN_STARTED" and event.get("input") is not None:
        # Shape validation mirrors the TS parser (normalize.ts
        # RUN_STARTED case + checkMessagesArray): input must be an
        # object; threadId/runId are required strings; messages is
        # required and must be an array; each message is checked by
        # the shared _validate_message helper (per-role required
        # fields, FIX-R2 P1-R2-01) — the same helper the
        # MESSAGES_SNAPSHOT path uses, so the two paths reject
        # exactly the same shapes. A missing content is never
        # defaulted at validation time; the "" default in
        # _seed_run_input is reachable only for a legal assistant
        # message without content.
        input_data = event["input"]
        if not isinstance(input_data, dict):
            raise InvalidInput(
                f"sourceIndex {source_index}: RUN_STARTED input must be "
                "an object")
        for field in ("threadId", "runId"):
            if not isinstance(input_data.get(field), str):
                raise InvalidInput(
                    f"sourceIndex {source_index}: RUN_STARTED input "
                    f"field {field!r} must be a string")
        if "messages" not in input_data:
            raise InvalidInput(
                f"sourceIndex {source_index}: RUN_STARTED input is "
                "missing required field 'messages'")
        if not isinstance(input_data["messages"], list):
            raise InvalidInput(
                f"sourceIndex {source_index}: RUN_STARTED input "
                "field 'messages' must be an array of messages")
        for i, message in enumerate(input_data["messages"]):
            _validate_message(
                message, source_index,
                f"RUN_STARTED input messages[{i}]")
    if event_type == "RUN_FINISHED" and event.get("outcome") is not None:
        outcome = event["outcome"]
        if not isinstance(outcome, dict) or outcome.get("type") not in (
                "success", "interrupt", "cancelled"):
            raise InvalidInput(
                f"sourceIndex {source_index}: invalid RUN_FINISHED outcome")
        if outcome["type"] == "success" and "pendingToolCallIds" in outcome:
            pending = outcome["pendingToolCallIds"]
            if not isinstance(pending, list) or not all(
                    isinstance(x, str) for x in pending):
                raise InvalidInput(
                    f"sourceIndex {source_index}: pendingToolCallIds must be "
                    "an array of strings")


# ---------------------------------------------------------------------------
# Chunk expansion (EVENT_SCHEMA §4.5 / §5.4)
# ---------------------------------------------------------------------------

# Fields a chunk carries explicitly (TS normalize.ts
# TEXT_CHUNK_KNOWN_FIELDS / TOOL_CHUNK_KNOWN_FIELDS): everything
# outside these sets is an "extra" that rides on the synthetic event
# the chunk produces (timestamp, subagentRunId, rawEvent,
# producer-added fields). `type` / `delta` are rewritten by the
# expansion itself and `metadata` follows its own merge rule.
_TEXT_CHUNK_KNOWN_FIELDS = frozenset(
    ("type", "messageId", "role", "name", "delta", "metadata"))
_TOOL_CHUNK_KNOWN_FIELDS = frozenset(
    ("type", "toolCallId", "toolCallName", "parentMessageId", "delta",
     "metadata"))


def _wrap(source_index, event, source_event_key=None, transport_event_id=None):
    return {
        "sourceIndex": source_index,
        "sourceEventKey": source_event_key,
        "transportEventId": transport_event_id,
        "event": event,
    }


def expand_chunks(normalized_events):
    """Expand TEXT_MESSAGE_CHUNK / TOOL_CALL_CHUNK into START / CONTENT|ARGS
    / END before reduction.

    Mirror of TS src/parser/normalize.ts expandChunks (EVENT_SCHEMA
    §4.5 / §5.4), with two documented fail-closed divergences (ADR-003):
    a first chunk without an id raises InvalidInput here while TS
    passes it through unchanged, and role/name conflicts on a
    continuation chunk raise here while TS ignores them. Rules applied:
    the first chunk of an item must carry its id (a chunk stream opened
    without one is a protocol violation); a chunk naming a different id
    closes the previous item; a non-chunk event closes lanes
    SELECTIVELY (run-level events and MESSAGES_SNAPSHOT close both;
    TEXT_* closes the text lane only; TOOL_* closes the tool lane
    only; STATE_SNAPSHOT / STATE_DELTA close neither); the stream end
    closes any item still open. A continuation chunk carrying extras
    (fields outside the chunk's known set) but no delta still expands
    into an empty-delta CONTENT/ARGS carrying the extras; a
    metadata-only trailing chunk merges onto the previous event of the
    item (no new event — metadata never affects state, so the merge is
    not reproduced); a chunk with neither delta, extras nor metadata
    expands into nothing. The two forms (chunk vs explicit
    START/CONTENT/END) are never mixed inside one item.
    """
    expanded = []
    open_text = None   # messageId of the open text chunk item, or None
    open_text_meta = {}
    open_tool = None   # toolCallId of the open tool chunk item, or None
    open_tool_meta = {}

    def close_text(source_index):
        nonlocal open_text, open_text_meta
        if open_text is not None:
            expanded.append(_wrap(source_index, {
                "type": "TEXT_MESSAGE_END", "messageId": open_text}))
            open_text = None
            open_text_meta = {}

    def close_tool(source_index):
        nonlocal open_tool, open_tool_meta
        if open_tool is not None:
            expanded.append(_wrap(source_index, {
                "type": "TOOL_CALL_END", "toolCallId": open_tool}))
            open_tool = None
            open_tool_meta = {}

    def _extras(event, known):
        return {k: v for k, v in event.items() if k not in known}

    for wrapper in normalized_events:
        event = wrapper["event"]
        source_index = wrapper["sourceIndex"]
        event_type = event.get("type")
        if event_type == "TEXT_MESSAGE_CHUNK":
            message_id = event.get("messageId")
            is_first_chunk = False
            if message_id is None:
                if open_text is None:
                    raise InvalidInput(
                        f"sourceIndex {source_index}: first TEXT_MESSAGE_CHUNK "
                        "must carry messageId")
                message_id = open_text
            elif message_id != open_text:
                close_text(source_index)
                start = {"type": "TEXT_MESSAGE_START", "messageId": message_id}
                if event.get("role") is not None:
                    start["role"] = event["role"]
                if event.get("name") is not None:
                    start["name"] = event["name"]
                expanded.append(_wrap(source_index, start))
                open_text = message_id
                open_text_meta = {
                    "role": event.get("role", "assistant"),
                    "name": event.get("name"),
                }
                is_first_chunk = True
            else:
                # Continuation chunk: repeated role/name must agree.
                if (event.get("role") is not None
                        and event["role"] != open_text_meta.get("role")):
                    raise InvalidInput(
                        f"sourceIndex {source_index}: TEXT_MESSAGE_CHUNK role "
                        "conflicts with the opener")
                if (event.get("name") is not None
                        and event["name"] != open_text_meta.get("name")):
                    raise InvalidInput(
                        f"sourceIndex {source_index}: TEXT_MESSAGE_CHUNK name "
                        "conflicts with the opener")
            if event.get("delta") is not None:
                expanded.append(_wrap(source_index, {
                    "type": "TEXT_MESSAGE_CONTENT",
                    "messageId": message_id, "delta": event["delta"]}))
            elif not is_first_chunk and _extras(
                    event, _TEXT_CHUNK_KNOWN_FIELDS):
                # Extras-only trailing chunk (no delta, no metadata):
                # it must still expand into an event, not vanish.
                # Empty delta adds no text. A first chunk needs no
                # such event: its START already carries the extras.
                expanded.append(_wrap(source_index, {
                    "type": "TEXT_MESSAGE_CONTENT",
                    "messageId": message_id, "delta": ""}))
            continue
        if event_type == "TOOL_CALL_CHUNK":
            tool_call_id = event.get("toolCallId")
            tool_call_name = event.get("toolCallName")
            is_first_chunk = False
            if tool_call_id is None:
                if open_tool is None:
                    raise InvalidInput(
                        f"sourceIndex {source_index}: first TOOL_CALL_CHUNK "
                        "must carry toolCallId and toolCallName")
                tool_call_id = open_tool
                tool_call_name = open_tool_meta.get("toolCallName")
            elif tool_call_id != open_tool:
                if tool_call_name is None:
                    raise InvalidInput(
                        f"sourceIndex {source_index}: first TOOL_CALL_CHUNK "
                        "for a new call must carry toolCallName")
                close_tool(source_index)
                start = {"type": "TOOL_CALL_START",
                         "toolCallId": tool_call_id,
                         "toolCallName": tool_call_name}
                if event.get("parentMessageId") is not None:
                    start["parentMessageId"] = event["parentMessageId"]
                expanded.append(_wrap(source_index, start))
                open_tool = tool_call_id
                open_tool_meta = {
                    "toolCallName": tool_call_name,
                    "parentMessageId": event.get("parentMessageId"),
                }
                is_first_chunk = True
            else:
                if (tool_call_name is not None
                        and tool_call_name != open_tool_meta.get("toolCallName")):
                    raise InvalidInput(
                        f"sourceIndex {source_index}: TOOL_CALL_CHUNK "
                        "toolCallName conflicts with the opener")
            if event.get("delta") is not None:
                expanded.append(_wrap(source_index, {
                    "type": "TOOL_CALL_ARGS",
                    "toolCallId": tool_call_id, "delta": event["delta"]}))
            elif not is_first_chunk and _extras(
                    event, _TOOL_CHUNK_KNOWN_FIELDS):
                # Extras-only trailing chunk: empty-delta ARGS, as above.
                expanded.append(_wrap(source_index, {
                    "type": "TOOL_CALL_ARGS",
                    "toolCallId": tool_call_id, "delta": ""}))
            continue
        # Any other event closes open chunk items first — selectively:
        # run-level events and MESSAGES_SNAPSHOT close both lanes,
        # TEXT_* closes the text lane only, TOOL_* closes the tool
        # lane only, STATE_SNAPSHOT / STATE_DELTA close neither.
        if event_type in ("RUN_STARTED", "RUN_FINISHED", "RUN_ERROR",
                          "MESSAGES_SNAPSHOT"):
            close_text(source_index)
            close_tool(source_index)
        elif event_type in ("TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT",
                            "TEXT_MESSAGE_END"):
            close_text(source_index)
        elif event_type in ("TOOL_CALL_START", "TOOL_CALL_ARGS",
                            "TOOL_CALL_END", "TOOL_CALL_RESULT"):
            close_tool(source_index)
        expanded.append(wrapper)
    last_index = (normalized_events[-1]["sourceIndex"]
                  if normalized_events else 0)
    close_text(last_index)
    close_tool(last_index)
    return expanded


# ---------------------------------------------------------------------------
# RFC 6902 JSON Patch (EVENT_SCHEMA §6.2; atomic application)
# ---------------------------------------------------------------------------

def _json_string(value):
    """JSON.stringify equivalent (compact, no spaces after separators)."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _is_array_index(token):
    return re.fullmatch(r"(0|[1-9][0-9]*)", token) is not None


class _PatchFailure(Exception):
    """A known-op failure with TS applyJsonPatch taxonomy."""

    def __init__(self, reason, detail):
        super().__init__(f"{reason}: {detail}")
        self.reason = reason
        self.detail = detail


def _unescape_pointer(token: str) -> str:
    return token.replace("~1", "/").replace("~0", "~")


def _parse_pointer(pointer: str, what="path"):
    if pointer == "":
        return []
    if not isinstance(pointer, str) or not pointer.startswith("/"):
        raise _PatchFailure(
            "INVALID_POINTER",
            f"{what} {_json_string(pointer)} is not a valid JSON Pointer")
    return [_unescape_pointer(t) for t in pointer[1:].split("/")]


def _resolve_parent(doc, tokens):
    """Resolve all but the last token (TS snapshot.ts resolveParent).

    Returns (parent, last_token). Raises _PatchFailure with the TS
    reason/detail strings.
    """
    current = doc
    for token in tokens[:-1]:
        if isinstance(current, list):
            if not _is_array_index(token):
                raise _PatchFailure(
                    "INVALID_INDEX",
                    f"array index {_json_string(token)} is not a "
                    "non-negative integer")
            index = int(token)
            if index >= len(current):
                raise _PatchFailure(
                    "MISSING_PATH", f"array index {index} does not exist")
            current = current[index]
        elif isinstance(current, dict):
            if token not in current:
                raise _PatchFailure(
                    "MISSING_PATH",
                    f"object key {_json_string(token)} does not exist")
            current = current[token]
        else:
            raise _PatchFailure(
                "NOT_AN_OBJECT_OR_ARRAY",
                f"cannot descend into a scalar at {_json_string(token)}")
    if isinstance(current, (list, dict)):
        return current, tokens[-1]
    raise _PatchFailure("NOT_AN_OBJECT_OR_ARRAY", "parent is a scalar value")


def _read_at(doc, tokens):
    """Read the value at a pointer (TS snapshot.ts readAt)."""
    if not tokens:
        return doc
    parent, last = _resolve_parent(doc, tokens)
    if isinstance(parent, list):
        if not _is_array_index(last):
            raise _PatchFailure(
                "INVALID_INDEX",
                f"array index {_json_string(last)} is not a non-negative "
                "integer")
        index = int(last)
        if index >= len(parent):
            raise _PatchFailure(
                "MISSING_PATH", f"array index {index} does not exist")
        return parent[index]
    if last not in parent:
        raise _PatchFailure(
            "MISSING_PATH", f"object key {_json_string(last)} does not exist")
    return parent[last]


def _apply_op(doc, op):
    """Apply one patch op to the working copy (TS applyJsonPatch).

    Returns "unknown" for a discarded unknown op, "ok" otherwise.
    Raises _PatchFailure (known-op failure, first failure aborts the
    patch) or InvalidInput (structurally malformed op: missing
    'value' / 'from' / 'path' — the TS parser rejects these before
    they reach the snapshot layer).
    """
    name = op.get("op")
    if name not in ("add", "remove", "replace", "move", "copy", "test"):
        return "unknown"  # dropped with a warning, run continues (§6.2)
    if name in ("add", "replace", "test") and "value" not in op:
        raise InvalidInput(f"JSON Patch op {name!r} missing 'value'")
    if name in ("move", "copy") and "from" not in op:
        raise InvalidInput(f"JSON Patch op {name!r} missing 'from'")
    if "path" not in op:
        raise InvalidInput(f"JSON Patch op {name!r} missing 'path'")
    tokens = _parse_pointer(op["path"])
    if name == "test":
        actual = _read_at(doc, tokens)
        if not _json_deep_equal(actual, op["value"]):
            raise _PatchFailure(
                "TEST_FAILED",
                f"test at {_json_string(op['path'])} failed: expected "
                f"{_json_string(op['value'])}, got "
                f"{_json_string(actual)}")
        return "ok"
    if name == "move":
        from_tokens = _parse_pointer(op["from"], what="from")
        if (len(tokens) > len(from_tokens)
                and tokens[:len(from_tokens)] == from_tokens):
            raise _PatchFailure(
                "MOVE_INTO_CHILD",
                f"cannot move {_json_string(op['from'])} into its own "
                f"child {_json_string(op['path'])}")
        value = copy.deepcopy(_read_at(doc, from_tokens))
        _apply_op(doc, {"op": "remove", "path": op["from"]})
        _apply_op(doc, {"op": "add", "path": op["path"], "value": value})
        return "ok"
    if name == "copy":
        value = copy.deepcopy(_read_at(doc, _parse_pointer(op["from"],
                                                           what="from")))
        _apply_op(doc, {"op": "add", "path": op["path"], "value": value})
        return "ok"
    if name == "add" and not tokens:
        return "replace-whole"
    if name == "replace" and not tokens:
        return "replace-whole"
    if name == "remove" and not tokens:
        raise _PatchFailure(
            "INVALID_POINTER", "cannot remove the whole document")
    parent, last = _resolve_parent(doc, tokens)
    if isinstance(parent, dict):
        if name == "add":
            parent[last] = copy.deepcopy(op["value"])
        elif name == "remove":
            if last not in parent:
                raise _PatchFailure(
                    "MISSING_PATH",
                    f"object key {_json_string(last)} does not exist")
            del parent[last]
        elif name == "replace":
            if last not in parent:
                raise _PatchFailure(
                    "MISSING_PATH",
                    f"object key {_json_string(last)} does not exist")
            parent[last] = copy.deepcopy(op["value"])
        return "ok"
    if isinstance(parent, list):
        if last == "-":
            if name != "add":
                raise _PatchFailure(
                    "INVALID_INDEX", "'-' is only valid for add")
            parent.append(copy.deepcopy(op["value"]))
            return "ok"
        if not _is_array_index(last):
            raise _PatchFailure(
                "INVALID_INDEX",
                f"array index {_json_string(last)} is not a non-negative "
                "integer")
        index = int(last)
        if name == "add":
            if index > len(parent):
                raise _PatchFailure(
                    "INVALID_INDEX",
                    f"array index {index} is beyond the end "
                    f"({len(parent)})")
            parent.insert(index, copy.deepcopy(op["value"]))
        elif name == "remove":
            if index >= len(parent):
                raise _PatchFailure(
                    "MISSING_PATH", f"array index {index} does not exist")
            del parent[index]
        elif name == "replace":
            if index >= len(parent):
                raise _PatchFailure(
                    "MISSING_PATH", f"array index {index} does not exist")
            parent[index] = copy.deepcopy(op["value"])
        return "ok"
    raise _PatchFailure("NOT_AN_OBJECT_OR_ARRAY", "parent is a scalar value")


def _json_deep_equal(a, b):
    """Strict JSON deep equality (TS state.ts jsonDeepEqual): bool is
    not equal to 1, key sets must match, arrays compare by index."""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if type(a) is not type(b):
        # str vs str handled above by equality; None vs None too.
        if a is None and b is None:
            return True
        return False
    if isinstance(a, dict):
        if set(a) != set(b):
            return False
        return all(_json_deep_equal(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(
            _json_deep_equal(x, y) for x, y in zip(a, b))
    return a == b


def apply_json_patch(doc, patch):
    """Apply an RFC 6902 patch atomically (TS snapshot.ts applyJsonPatch).

    Returns (new_doc, failure_or_None, dropped_unknown_ops) where
    failure is {"index", "reason", "detail"} for the FIRST failing
    known op (the patch is discarded atomically: new_doc is the
    original document), and dropped_unknown_ops is a list of
    {"index", "op"} for the unknown ops discarded before the failure
    (or before the end). On success failure is None and new_doc is
    the patched document.
    """
    if not isinstance(patch, list):
        raise InvalidInput("STATE_DELTA delta must be an array")
    for operation in patch:
        if not isinstance(operation, dict) or "op" not in operation:
            raise InvalidInput("JSON Patch operation must be an object with 'op'")
    working = copy.deepcopy(doc)
    dropped = []
    for i, operation in enumerate(patch):
        try:
            outcome = _apply_op(working, operation)
        except _PatchFailure as exc:
            return doc, {"index": i, "reason": exc.reason,
                         "detail": exc.detail}, dropped
        if outcome == "unknown":
            dropped.append({"index": i, "op": operation.get("op")})
        elif outcome == "replace-whole":
            working = copy.deepcopy(operation["value"])
    return working, None, dropped


# ---------------------------------------------------------------------------
# MESSAGES_SNAPSHOT reconciliation (EVENT_SCHEMA §6.3)
# ---------------------------------------------------------------------------

def _snapshot_message_to_state(message):
    content = message.get("content", "")
    entry = {
        "id": message["id"],
        "role": message["role"],
        "name": message.get("name"),
        "content": copy.deepcopy(content),
        "segments": [{"text": content if isinstance(content, str) else ""}],
        "toolCalls": [],
        "open": False,
        "incomplete": False,
        # Snapshot-installed messages are producer-owned (TS
        # snapshot.ts builds MessageState with owner "producer").
        "owner": "producer",
    }
    # TS snapshotMessageToState keeps the FULL wire ToolCall objects,
    # and only for assistant messages (a tool message carries
    # toolCallId instead; other roles carry no toolCalls at all).
    if message["role"] == "assistant" and isinstance(
            message.get("toolCalls"), list):
        entry["toolCalls"] = copy.deepcopy(message["toolCalls"])
    if message["role"] == "tool":
        entry["toolCallId"] = message.get("toolCallId")
    if "error" in message:
        entry["error"] = message["error"]
    return entry


def reconcile_messages_snapshot(state, messages, source_index=None):
    """Apply the four reconciliation rules (PROJECT_BOOK §3.17):

    1. same messageId -> replace, keep original position;
    2. new message -> append in snapshot order;
    3. producer-owned old message absent from the snapshot -> remove;
    4. client-only activity/reasoning messages are retained, except the
       per-role self-revoking exception: a snapshot carrying any message
       of that role declares that role's complete set.
    """
    for message in messages:
        if not isinstance(message, dict) or "id" not in message \
                or "role" not in message:
            raise InvalidInput("MESSAGES_SNAPSHOT message needs 'id' and 'role'")
    for i, message in enumerate(messages):
        # Direct-call defence in depth (FIX-R2 D2 item 2): the wire
        # path already validated every message in validate_event, but
        # a direct caller of this function bypasses it, so each
        # snapshot message is checked here too with the shared
        # _validate_message helper. source_index is None for direct
        # calls (no source event); the fold path passes the real one.
        _validate_message(
            message, source_index, f"MESSAGES_SNAPSHOT messages[{i}]")
    snapshot_ids = {m["id"] for m in messages}
    roles_declared = {m["role"] for m in messages}
    old_by_id = {m["id"]: m for m in state["messages"]}
    merged = []
    for old in state["messages"]:
        if old["id"] in snapshot_ids:
            merged.append(_snapshot_message_to_state(
                next(m for m in messages if m["id"] == old["id"])))
        elif old.get("owner") == "client" \
                and old["role"] in ("activity", "reasoning") \
                and old["role"] not in roles_declared:
            merged.append(old)  # rule 4: retained client-only message
        # else rule 3: producer-owned message absent from snapshot -> removed
    for message in messages:
        if message["id"] not in old_by_id:
            merged.append(_snapshot_message_to_state(message))
    state["messages"] = merged
    # Sync snapshot toolCalls into toolCalls (create-only, never
    # clobber — TS snapshot.ts reconcileMessagesSnapshot): a snapshot
    # assistant message naming a call this trace never saw creates a
    # "closed" entry (args complete as given, no result yet).
    for message in messages:
        if message.get("role") != "assistant" \
                or not isinstance(message.get("toolCalls"), list):
            continue
        for call in message["toolCalls"]:
            if not isinstance(call, dict) \
                    or not isinstance(call.get("id"), str):
                continue
            if any(c["toolCallId"] == call["id"]
                   for c in state["toolCalls"]):
                continue
            function = call.get("function")
            if not isinstance(function, dict) \
                    or not isinstance(function.get("name"), str) \
                    or not isinstance(function.get("arguments"), str):
                raise InvalidInput(
                    "MESSAGES_SNAPSHOT toolCalls entry needs "
                    "'function' with string 'name' and 'arguments'")
            state["toolCalls"].append({
                "toolCallId": call["id"],
                "toolCallName": function["name"],
                "parentMessageId": message["id"],
                "args": function["arguments"],
                "result": None,
                "resultMessageId": None,
                "open": False,
                "incomplete": False,
                "duplicate": False,
                "runId": None,
            })


# ---------------------------------------------------------------------------
# The reducer
# ---------------------------------------------------------------------------

def _find_message(state, message_id):
    for message in state["messages"]:
        if message["id"] == message_id:
            return message
    return None


def _find_tool_call(state, tool_call_id, *, want_open=False):
    found = None
    for call in state["toolCalls"]:
        if call["toolCallId"] == tool_call_id:
            found = call
            if want_open and call["open"]:
                return call
    return found


def _current_run_id(state):
    """runId of the currently RUNNING run, or None (ADR-F01: mirrors
    the TS ToolCallState.runId attribution, needed for the run-scoped
    RUN_FINISHED pending comparison)."""
    for run in reversed(state["runs"]):
        if run.get("status") == "RUNNING":
            return run["runId"]
    return None


def _compute_pending_tool_call_ids(state, run_id=None):
    """The derived pending set (PROJECT_BOOK §3.14/§5.5; ADR-F01).

    Pending is a property of the LOGICAL call — the toolCallId — not
    of individual state entries. A call is pending iff its args
    stream is closed (TOOL_CALL_END seen, so ``open`` is False), it
    was not left incomplete by a run end, and it has no result yet.
    Order is the toolCalls list order (START order), exactly as TS
    computePendingToolCallIds filters its toolCalls array
    (src/core/lifecycle.ts). Each id appears at most once.

    Grouping by id matters because the Oracle records a replayed
    TOOL_CALL_START over an already-closed call as a SECOND entry
    (DUPLICATE_TOOL_CALL, AG-UI #1524) while §3.14 forbids mistaking
    one id for multiple calls ("同一调用 ID 不得因重放而被误认为
    多个不同调用"). The duplicate entry is diagnostic evidence, not
    a second logical call: an id is pending only when NO entry for
    it holds a result (G01 resume path: the original entry holds the
    result 'sunny' while the duplicate entry is closed-unresulted —
    the id is not pending). With *run_id* given, only that run's
    entries are considered (the RUN_FINISHED comparison scope, §3.14:
    "当前 run 中尚未收到结果的调用"); without it, the global set
    across all runs.
    """
    order = []
    entries_by_id = {}
    for call in state["toolCalls"]:
        tool_call_id = call["toolCallId"]
        if tool_call_id not in entries_by_id:
            entries_by_id[tool_call_id] = []
            order.append(tool_call_id)
        entries_by_id[tool_call_id].append(call)
    pending = []
    for tool_call_id in order:
        entries = entries_by_id[tool_call_id]
        scoped = [c for c in entries
                  if run_id is None or c.get("runId") == run_id]
        if not scoped:
            continue
        if any(c["result"] is not None for c in scoped):
            continue  # some execution of this id already has a result
        if any(not c["open"] and not c["incomplete"] for c in scoped):
            pending.append(tool_call_id)
    return pending


def _refresh_pending_tool_call_ids(state):
    """Recompute state["pendingToolCallIds"] from the tool calls.

    The field is a derived projection, never copied from the wire:
    a RUN_FINISHED outcome.pendingToolCallIds list is CHECKED against
    the derived set (see the RUN_FINISHED branch), never trusted.
    """
    state["pendingToolCallIds"] = _compute_pending_tool_call_ids(state)


def _close_open_items(state):
    for message in state["messages"]:
        if message["open"]:
            message["open"] = False
            message["incomplete"] = True
    for call in state["toolCalls"]:
        if call["open"]:
            call["open"] = False
            call["incomplete"] = True


def _seed_run_input(state, event, source_index, diagnostics):
    """Seed state from a RUN_STARTED input (PROJECT_BOOK §3.3).

    Semantics cross-checked against TS lifecycle.seedRunInput; the
    code below is written from the frozen spec text and the TS
    behaviour notes, not translated line by line, and the agreement
    is proved by the cross-language regression (oracle/tests/
    test_run_started_input.py + tests/s0/gate.test.ts "RUN_STARTED.
    input parity"):
      * sharedState: adopted only when no baseline exists yet
        (sharedState is None). When a baseline exists and
        input.state differs, the live baseline is kept and a
        SNAPSHOT_MISMATCH diagnostic is recorded (a snapshot after
        the fact must not overwrite valid later updates, §5.7).
      * messages: idempotent history merge. A message whose id is
        already present is skipped (streamed state wins). A new tool
        message answers a pending call (marks it resulted); for an
        already-resulted or incomplete call, or an unknown call, the
        message is recorded (unknown) or skipped (echo/incomplete)
        without inventing call state. Other messages are appended as
        closed; activity/reasoning roles are client-owned, the rest
        producer-owned. A seeded message holds a single segment with
        its whole content (same rule as _snapshot_message_to_state).
      * No input: when there is no baseline yet, the baseline
        becomes {} (TS reduceRunStarted, §6.2).
    Callers must have validated the input shape (validate_event);
    malformed shapes raise InvalidInput instead of crashing.
    The TS fold-local TOOL_CALL_RESULT_UNMATCHED_INPUT diagnostic is
    deliberately NOT emitted here: the TS planner never harvests it
    into report diagnostics, so emitting it would make Oracle
    reports disagree with TS reports about the same input.
    """
    input_data = event.get("input")
    if input_data is None:
        if state["sharedState"] is None:
            state["sharedState"] = {}
        return
    if not isinstance(input_data, dict):
        raise InvalidInput(
            f"sourceIndex {source_index}: RUN_STARTED input must be "
            "an object")
    messages = input_data.get("messages")
    if not isinstance(messages, list):
        raise InvalidInput(
            f"sourceIndex {source_index}: RUN_STARTED input field "
            "'messages' must be an array of messages")
    # --- sharedState baseline ---
    if state["sharedState"] is None:
        if "state" in input_data:
            state["sharedState"] = copy.deepcopy(input_data["state"])
        else:
            state["sharedState"] = {}
    elif "state" in input_data \
            and not _json_deep_equal(input_data["state"],
                                    state["sharedState"]):
        # TS lifecycle.seedRunInput verbatim; the planner harvests
        # this into the report with evidence rewritten to
        # {reducerCode} (planner.ts harvest) — the Oracle emits the
        # harvested form directly, as it does for the snapshot-path
        # SNAPSHOT_MISMATCH diagnostics.
        diagnostics.append(_diagnostic(
            "SNAPSHOT_MISMATCH", source_index,
            "RUN_STARTED input.state differs from the live sharedState "
            "baseline; the live baseline is kept and the input state "
            "is not applied (a snapshot must not overwrite valid "
            "later updates, PROJECT_BOOK §5.7).",
            {"reducerCode": "SNAPSHOT_MISMATCH"}))
    # --- messages: idempotent history merge ---
    for message in messages:
        if not isinstance(message, dict) or "id" not in message:
            raise InvalidInput(
                f"sourceIndex {source_index}: RUN_STARTED input "
                "message needs an 'id'")
        if _find_message(state, message["id"]) is not None:
            continue  # history echo; streamed state wins
        content = copy.deepcopy(message["content"]) \
            if "content" in message else None
        segments = [{"text": content if isinstance(content, str) else ""}]
        if message.get("role") == "tool":
            tool_call_id = message.get("toolCallId")
            call = _find_tool_call(state, tool_call_id) \
                if isinstance(tool_call_id, str) else None
            if call is None:
                # Unknown call: history the reducer never saw. Record
                # the message, invent no call state (no diagnostic:
                # see the docstring note above).
                recorded = {
                    "id": message["id"],
                    "role": "tool",
                    "name": None,
                    "segments": segments,
                    "toolCalls": [],
                    "open": False,
                    "incomplete": False,
                    "owner": "producer",
                }
                # Content mirrors TS: present (even JSON null) when
                # the input carried it, absent when it did not (TS
                # undefined is dropped by the state projection).
                if "content" in message:
                    recorded["content"] = content
                if isinstance(tool_call_id, str):
                    recorded["toolCallId"] = tool_call_id
                state["messages"].append(recorded)
                continue
            if call["result"] is not None:
                continue  # history echo of an already-answered call
            if call["incomplete"]:
                continue  # its execution ended without a result
            call["open"] = False
            call["result"] = copy.deepcopy(content)
            call["resultMessageId"] = message["id"]
            recorded = {
                "id": message["id"],
                "role": "tool",
                "name": None,
                "segments": segments,
                "toolCalls": [],
                "toolCallId": tool_call_id,
                "open": False,
                "incomplete": False,
                "owner": "producer",
            }
            if "content" in message:
                recorded["content"] = content
            state["messages"].append(recorded)
            continue
        owner = "client" if message.get("role") in (
            "activity", "reasoning") else "producer"
        seeded = {
            "id": message["id"],
            "role": message.get("role"),
            "name": message.get("name"),
            # TS defaults a missing content to "" but keeps an
            # explicit JSON null as null (content !== undefined).
            "content": copy.deepcopy(message["content"])
            if "content" in message else "",
            "segments": segments,
            "toolCalls": copy.deepcopy(message["toolCalls"])
            if isinstance(message.get("toolCalls"), list) else [],
            "open": False,
            "incomplete": False,
            "owner": owner,
        }
        state["messages"].append(seeded)


def _reduce_one(state, wrapper, applied_through, seen_tool_starts,
                applied_payloads, diagnostics):
    event = wrapper["event"]
    source_index = wrapper["sourceIndex"]
    event_type = event["type"]
    timeline = state["orderedTimeline"]

    if event_type == "RUN_STARTED":
        existing = next((r for r in state["runs"]
                         if r["runId"] == event["runId"]), None)
        open_run = next((r for r in state["runs"]
                         if r["status"] == "RUNNING"), None)
        thread_mismatch = (
            state["threadId"] is not None
            and state["threadId"] != event["threadId"])
        if existing is not None or open_run is not None or thread_mismatch:
            # Replay tolerance (mirrors the TS planner's RUN_STARTED
            # replay branch): an already-known runId, a run that is
            # still open, or a threadId change is a replay, not a
            # fresh run. Re-activate the known run (or record the new
            # runId under the established threadId) and do NOT re-seed
            # input: the checkpoint base already carries whatever the
            # prefix fold seeded.
            if existing is not None:
                existing["status"] = "RUNNING"  # replay of the same run
            else:
                run_entry = {
                    "runId": event["runId"],
                    "threadId": event["threadId"],
                    "status": "RUNNING",
                }
                if "parentRunId" in event:
                    run_entry["parentRunId"] = event["parentRunId"]
                if "protocolVersion" in event:
                    run_entry["protocolVersion"] = event["protocolVersion"]
                state["runs"].append(run_entry)
            if state["threadId"] is None:
                state["threadId"] = event["threadId"]
            state["runStatus"] = "RUNNING"
            timeline.append({"kind": "run_started",
                             "runId": event["runId"]})
            return
        # Fresh run. An input whose threadId/runId disagree with the
        # event is a fold diagnostic (OUT_OF_ORDER, carrying the TS
        # code name RUN_INPUT_MISMATCH — the TS planner maps that
        # ReducerError to OUT_OF_ORDER): the run is not created and
        # the input is not seeded.
        input_data = event.get("input")
        if input_data is not None and not isinstance(input_data, dict):
            raise InvalidInput(
                f"sourceIndex {source_index}: RUN_STARTED input must "
                "be an object")
        if input_data is not None and (
                input_data.get("threadId") != event["threadId"]
                or input_data.get("runId") != event["runId"]):
            diagnostics.append(_reducer_diagnostic(
                "RUN_INPUT_MISMATCH", source_index,
                f"RUN_STARTED input threadId/runId "
                f"(\"{input_data.get('threadId')}\""
                f"/\"{input_data.get('runId')}\") disagree with the event "
                f"threadId/runId (\"{event['threadId']}\""
                f"/\"{event['runId']}\").",
                run_id=event["runId"]))
            return
        state["threadId"] = event["threadId"]
        run_entry = {
            "runId": event["runId"],
            "threadId": event["threadId"],
            "status": "RUNNING",
        }
        if "parentRunId" in event:
            run_entry["parentRunId"] = event["parentRunId"]
        if "protocolVersion" in event:
            run_entry["protocolVersion"] = event["protocolVersion"]
        state["runs"].append(run_entry)
        state["runStatus"] = "RUNNING"
        _seed_run_input(state, event, source_index, diagnostics)
        timeline.append({"kind": "run_started",
                         "runId": event["runId"]})
        return

    if event_type == "RUN_FINISHED":
        # FIX-R3, P1-R3-01 (design §2.1): checks BEFORE any mutation.
        # The old shape wrote run["status"] / state["runStatus"]
        # first and validated after, so an illegal RUN_FINISHED
        # still reported CONSISTENT with runStatus FINISHED.
        # Identity is judged against the OPEN run, never against
        # event.runId's presence in runs: run-2 never started while
        # run-1 is RUNNING is FINISH_WRONG_RUN; run-2 never started
        # with no run RUNNING at all is FINISH_WITHOUT_START
        # (WITHOUT_START takes priority). No threadId check here:
        # coordinator ruling, recorded as a known corner in ADR-004
        # (C group), not mirrored in this round.
        open_run = next((r for r in state["runs"]
                         if r["status"] == "RUNNING"), None)
        if open_run is None:
            raise InvalidInput(
                f"sourceIndex {source_index}: "
                "[FINISH_WITHOUT_START] RUN_FINISHED for run "
                f"{event['runId']!r} but no run is RUNNING")
        if open_run["runId"] != event["runId"]:
            raise InvalidInput(
                f"sourceIndex {source_index}: "
                "[FINISH_WRONG_RUN] RUN_FINISHED for run "
                f"{event['runId']!r} but the open run is "
                f"{open_run['runId']!r}")
        run = open_run
        outcome = event.get("outcome") or {}
        status = "CANCELLED" if outcome.get("type") == "cancelled" else "FINISHED"
        if outcome.get("type") == "success":
            # PROJECT_BOOK §3.14: a declared pending list must agree
            # with this run's calls still without a result. The
            # declaration is CHECKED against the derived set, never
            # copied into state (ADR-F01; the TS counterpart is
            # ReducerError PENDING_TOOL_CALL_MISMATCH, reducer.ts).
            # A missing list counts as [] (TS: declared ?? []).
            # Channel: raise InvalidInput — the Oracle's existing
            # hard-violation channel (validate_event / _reduce_one
            # raise it for malformed input; replay.evaluate maps it to
            # verdict INVALID_INPUT with diagnostic code INVALID_INPUT).
            # A soft diagnostic was rejected: §6 has no
            # PENDING_TOOL_CALL_MISMATCH code (inventing one would be
            # a spec extension), and a diagnostic appended during the
            # full-path fold is discarded by evaluate while the same
            # input on the resume path would report it — the two paths
            # would disagree about the same malformed input. Raising
            # aborts the fold on both paths, exactly as the TS throw
            # does. The TS code name is carried in the message for
            # cross-reference.
            declared = list(outcome.get("pendingToolCallIds") or [])
            current_run_pending = _compute_pending_tool_call_ids(
                state, run_id=event["runId"])
            if declared != current_run_pending:
                raise InvalidInput(
                    f"sourceIndex {source_index}: "
                    "[PENDING_TOOL_CALL_MISMATCH] RUN_FINISHED "
                    "outcome.pendingToolCallIds "
                    f"{declared!r} does not match this run's calls "
                    "still without a result "
                    f"{current_run_pending!r} (PROJECT_BOOK §3.14)")
        # All checks passed — only now mutate. (run is the open run;
        # the identity checks above proved it is event.runId.)
        run["status"] = status
        state["runStatus"] = status
        # TS reduceRunFinished stores the wire outcome/result on the
        # finished run (FIX-R2, P1-R2-02): outcome as a whole deepcopy,
        # result whenever the wire carries the key — JSON null is a
        # legal JsonValue, so the test is `"result" in event`, never
        # `is not None` (falsy 0 / false / "" / {} / null all store).
        if "outcome" in event:
            run["outcome"] = copy.deepcopy(event["outcome"])
        if "result" in event:
            run["result"] = copy.deepcopy(event["result"])
        _close_open_items(state)
        timeline.append({"kind": "run_finished",
                         "runId": event["runId"]})
        return

    if event_type == "RUN_ERROR":
        run = next((r for r in state["runs"] if r["status"] == "RUNNING"), None)
        if run is not None:
            run["status"] = "ERROR"
            # TS reduceRunError stores {message, code?} on the open
            # run only (a RUN_ERROR before any RUN_STARTED creates no
            # run entry, N11 shape).
            error = {"message": event["message"]}
            if "code" in event:
                error["code"] = event["code"]
            run["error"] = error
        state["runStatus"] = "ERROR"
        _close_open_items(state)
        timeline.append({"kind": "run_error",
                         **({"runId": run["runId"]} if run is not None
                            else {})})
        return

    if event_type == "TEXT_MESSAGE_START":
        message = _find_message(state, event["messageId"])
        role = event.get("role", "assistant")
        if message is not None and message["open"]:
            return  # replay of an already-open message: harmless no-op
        if message is not None:
            # Legal reopen (PROJECT_BOOK §3.8): same owner/role/name.
            # The foldTrack-injected diagnostic is the MERGED
            # role-or-name message (the Reducer's separate
            # MESSAGE_REOPEN_* codes are unreachable through the
            # fold: foldTrack intercepts every closed-message reopen).
            if message["role"] != role or message.get("name") != event.get("name"):
                diagnostics.append(_diagnostic(
                    "OUT_OF_ORDER", source_index,
                    f"Reopened message \"{event['messageId']}\" changed "
                    "role or name.",
                    {"messageId": event["messageId"],
                     "expectedRole": message["role"], "actualRole": role}))
                return
            if not message["incomplete"] and _require_open_run(
                    state, event_type, source_index,
                    diagnostics) is None:
                # Closed-message reopen goes through the strict
                # Reducer (requireOpenRun first); an incomplete
                # message is reopened manually by foldTrack, which
                # does not check for an open run.
                return
            message["open"] = True
            message["incomplete"] = False
            message["segments"].append({"text": ""})
        else:
            if _require_open_run(state, event_type, source_index,
                                 diagnostics) is None:
                return
            message = _new_message(event["messageId"], role, event.get("name"))
            state["messages"].append(message)
        timeline.append({"kind": "text_start", "messageId": event["messageId"]})
        return

    if event_type == "TEXT_MESSAGE_CONTENT":
        key = ("TEXT_MESSAGE_CONTENT", event["messageId"], event["delta"])
        message = _find_message(state, event["messageId"])
        if message is not None and message["open"]:
            # SUSPECTED_DUPLICATE pre-check (foldTrack): only for an
            # open message, before requireOpenRun — the diagnostic is
            # recorded even when the payload is then refused for
            # having no run open.
            if key in applied_payloads and wrapper.get("sourceEventKey") is None:
                diagnostics.append(_diagnostic(
                    "SUSPECTED_DUPLICATE", source_index,
                    "Identical text content applied again with no stable "
                    "event id (PROJECT_BOOK §4.3: suspected duplicate, "
                    "never auto-deduplicated).",
                    {"messageId": event["messageId"],
                     "delta": event["delta"]}))
            applied_payloads.add(key)
        if _require_open_run(state, event_type, source_index,
                             diagnostics) is None:
            return
        if message is None:
            diagnostics.append(_reducer_diagnostic(
                "CONTENT_WITHOUT_START", source_index,
                f"TEXT_MESSAGE_CONTENT for messageId "
                f"\"{event['messageId']}\" with no such message: content "
                "must target an already-opened message (PROJECT_BOOK "
                "§5.4; OUT_OF_ORDER).",
                message_id=event["messageId"]))
            return
        if not message["open"]:
            diagnostics.append(_reducer_diagnostic(
                "CONTENT_WITHOUT_START", source_index,
                f"TEXT_MESSAGE_CONTENT for messageId "
                f"\"{event['messageId']}\" which is "
                f"{_message_status(message)}, not open: content must "
                "target an already-opened message (PROJECT_BOOK §5.4; "
                "OUT_OF_ORDER).",
                message_id=event["messageId"]))
            return
        message["content"] += event["delta"]
        message["segments"][-1]["text"] += event["delta"]
        timeline.append({"kind": "text", "messageId": event["messageId"],
                         "delta": event["delta"]})
        return

    if event_type == "TEXT_MESSAGE_END":
        message = _find_message(state, event["messageId"])
        if _require_open_run(state, event_type, source_index,
                             diagnostics) is None:
            return
        if message is None:
            diagnostics.append(_reducer_diagnostic(
                "END_WITHOUT_START", source_index,
                f"TEXT_MESSAGE_END for messageId "
                f"\"{event['messageId']}\" with no such message: END must "
                "target an already-opened message (EVENT_SCHEMA §4.1).",
                message_id=event["messageId"]))
            return
        if not message["open"]:
            diagnostics.append(_reducer_diagnostic(
                "END_WITHOUT_START", source_index,
                f"TEXT_MESSAGE_END for messageId "
                f"\"{event['messageId']}\" which is "
                f"{_message_status(message)}, not open: END must target "
                "an already-opened message (EVENT_SCHEMA §4.1).",
                message_id=event["messageId"]))
            return
        message["open"] = False
        timeline.append({"kind": "text_end", "messageId": event["messageId"]})
        return

    if event_type == "TOOL_CALL_START":
        replayed_in_fold = source_index in seen_tool_starts
        seen_tool_starts.add(source_index)
        existing = _find_tool_call(state, event["toolCallId"])
        if existing is not None and existing["open"]:
            return  # replay of an already-open call: harmless no-op
        if existing is not None:
            # Closed call started again: a replay over already-applied
            # state is a duplicate (AG-UI #1524); a genuinely new event
            # past the checkpoint is a legal reopen.
            if source_index <= applied_through or replayed_in_fold:
                duplicate = _new_tool_call(
                    event["toolCallId"], event["toolCallName"],
                    event.get("parentMessageId"),
                    run_id=_current_run_id(state))
                duplicate["duplicate"] = True
                state["toolCalls"].append(duplicate)
                evidence = {"toolCallId": event["toolCallId"]}
                if event.get("parentMessageId") is not None:
                    evidence["parentMessageId"] = event["parentMessageId"]
                diagnostics.append(_diagnostic(
                    "DUPLICATE_TOOL_CALL", source_index,
                    f"Tool call \"{event['toolCallId']}\" already present "
                    "was started again (AG-UI #1524: a replayed "
                    "TOOL_CALL_START over already-applied state).",
                    evidence,
                    related=[source_index]))
                timeline.append({"kind": "tool_start",
                                 "toolCallId": event["toolCallId"],
                                 **({"messageId": event["parentMessageId"]}
                                    if event.get("parentMessageId") is not None
                                    else {})})
                return
            if existing["incomplete"]:
                # foldTrack manual reopen of an incomplete call (the
                # strict Reducer would throw REOPEN_INCOMPLETE_
                # TOOL_CALL): a name/parent mismatch is a diagnostic
                # and the call is NOT reopened; agreement reopens it
                # (new logical execution — hasResult resets, runId
                # updates, arguments KEEP appending, §5.5).
                if existing["toolCallName"] != event["toolCallName"] \
                        or existing.get("parentMessageId") != event.get("parentMessageId"):
                    diagnostics.append(_diagnostic(
                        "TOOL_CALL_ID_REUSE", source_index,
                        f"Tool call \"{event['toolCallId']}\" reopened "
                        "with a different name or parent message.",
                        {"toolCallId": event["toolCallId"]}))
                    return
                existing["open"] = True
                existing["incomplete"] = False
                existing["result"] = None
                existing["resultMessageId"] = None
                existing["runId"] = _current_run_id(state)
                timeline.append({"kind": "tool_start",
                                 "toolCallId": event["toolCallId"],
                                 **({"messageId": event["parentMessageId"]}
                                    if event.get("parentMessageId") is not None
                                    else {})})
                return
            # Closed call past the checkpoint: the strict Reducer owns
            # it (requireOpenRun first, then the name/parent checks).
            if _require_open_run(state, event_type, source_index,
                                 diagnostics) is None:
                return
            if existing["toolCallName"] != event["toolCallName"]:
                diagnostics.append(_reducer_diagnostic(
                    "TOOL_CALL_REOPEN_NAME_MISMATCH", source_index,
                    f"TOOL_CALL_START reopens toolCallId "
                    f"\"{event['toolCallId']}\" with toolCallName "
                    f"\"{event['toolCallName']}\" but the closed call "
                    f"has name \"{existing['toolCallName']}\"; a reopen "
                    "must keep toolCallName identical "
                    "(PROJECT_BOOK §3.12).",
                    tool_call_id=event["toolCallId"]))
                return
            if existing.get("parentMessageId") != event.get("parentMessageId"):
                diagnostics.append(_reducer_diagnostic(
                    "TOOL_CALL_ID_REUSE", source_index,
                    f"TOOL_CALL_START reopens toolCallId "
                    f"\"{event['toolCallId']}\" with parentMessageId "
                    f"{_json_string(event.get('parentMessageId'))} but "
                    "the closed call has parentMessageId "
                    f"{_json_string(existing.get('parentMessageId'))}; "
                    "the same id for a different parent is identity "
                    "reuse (PROJECT_BOOK §5.5; TOOL_CALL_ID_REUSE).",
                    tool_call_id=event["toolCallId"]))
                return
            existing["open"] = True
            existing["incomplete"] = False
            existing["result"] = None
            existing["resultMessageId"] = None
            existing["runId"] = _current_run_id(state)
            timeline.append({"kind": "tool_start",
                             "toolCallId": event["toolCallId"],
                             **({"messageId": event["parentMessageId"]}
                                if event.get("parentMessageId") is not None
                                else {})})
            return
        if _require_open_run(state, event_type, source_index,
                             diagnostics) is None:
            return
        call = _new_tool_call(event["toolCallId"], event["toolCallName"],
                              event.get("parentMessageId"),
                              run_id=_current_run_id(state))
        state["toolCalls"].append(call)
        # Q1 (ii): a streamed call is NOT attached to its parent
        # message's toolCalls list (TS leaves toolCalls absent for
        # streamed messages); the linkage lives in the top-level
        # toolCalls array via parentMessageId.
        timeline.append({"kind": "tool_start",
                         "toolCallId": event["toolCallId"],
                         **({"messageId": event["parentMessageId"]}
                            if event.get("parentMessageId") is not None
                            else {})})
        return

    if event_type == "TOOL_CALL_ARGS":
        key = ("TOOL_CALL_ARGS", event["toolCallId"], event["delta"])
        call = _find_tool_call(state, event["toolCallId"], want_open=True)
        if call is not None:
            # SUSPECTED_DUPLICATE pre-check (foldTrack): only for an
            # open call, before requireOpenRun.
            if key in applied_payloads and wrapper.get("sourceEventKey") is None:
                diagnostics.append(_diagnostic(
                    "SUSPECTED_DUPLICATE", source_index,
                    "Identical tool args applied again with no stable "
                    "event id (PROJECT_BOOK §4.3: suspected duplicate, "
                    "never auto-deduplicated).",
                    {"toolCallId": event["toolCallId"],
                     "delta": event["delta"]}))
            applied_payloads.add(key)
        if _require_open_run(state, event_type, source_index,
                             diagnostics) is None:
            return
        if call is None:
            existing_call = _find_tool_call(state, event["toolCallId"])
            if existing_call is None:
                diagnostics.append(_reducer_diagnostic(
                    "ARGS_WITHOUT_START", source_index,
                    f"TOOL_CALL_ARGS for toolCallId "
                    f"\"{event['toolCallId']}\" with no such call: args "
                    "must target an already-opened call (PROJECT_BOOK "
                    "§5.5; OUT_OF_ORDER).",
                    tool_call_id=event["toolCallId"]))
            else:
                diagnostics.append(_reducer_diagnostic(
                    "ARGS_WITHOUT_START", source_index,
                    f"TOOL_CALL_ARGS for toolCallId "
                    f"\"{event['toolCallId']}\" which is "
                    f"{_tool_call_status(existing_call)}, not open: args "
                    "must target an already-opened call (PROJECT_BOOK "
                    "§5.5; OUT_OF_ORDER).",
                    tool_call_id=event["toolCallId"]))
            return
        call["args"] += event["delta"]
        timeline.append({"kind": "tool_args", "toolCallId": event["toolCallId"],
                         "delta": event["delta"]})
        return

    if event_type == "TOOL_CALL_END":
        call = _find_tool_call(state, event["toolCallId"])
        if _require_open_run(state, event_type, source_index,
                             diagnostics) is None:
            return
        if call is None:
            diagnostics.append(_reducer_diagnostic(
                "END_WITHOUT_START", source_index,
                f"TOOL_CALL_END for toolCallId "
                f"\"{event['toolCallId']}\" with no such call: END must "
                "target an already-opened call (EVENT_SCHEMA §4.1).",
                tool_call_id=event["toolCallId"]))
            return
        if not call["open"]:
            diagnostics.append(_reducer_diagnostic(
                "END_WITHOUT_START", source_index,
                f"TOOL_CALL_END for toolCallId "
                f"\"{event['toolCallId']}\" which is "
                f"{_tool_call_status(call)}, not open: END must target "
                "an already-opened call (EVENT_SCHEMA §4.1).",
                tool_call_id=event["toolCallId"]))
            return
        call["open"] = False
        timeline.append({"kind": "tool_end", "toolCallId": event["toolCallId"]})
        return

    if event_type == "TOOL_CALL_RESULT":
        entries = [c for c in state["toolCalls"]
                   if c["toolCallId"] == event["toolCallId"]]
        target = next((c for c in entries if c["result"] is None), None)
        if len(entries) > 1 and target is not None:
            # foldTrack multi-entry intercept: a result for a
            # duplicated call answers the FIRST entry with no result,
            # by identity — no requireOpenRun, no incomplete / duplicate
            # messageId check on this path (TS planner.ts).
            content = copy.deepcopy(event["content"])
            target["result"] = content
            target["resultMessageId"] = event["messageId"]
            target["open"] = False
            result_message = {
                "id": event["messageId"],
                "role": "tool",
                "name": None,
                "content": content,
                "segments": [{"text": content if isinstance(content, str) else ""}],
                "toolCalls": [],
                "toolCallId": event["toolCallId"],
                "open": False,
                "incomplete": False,
                "owner": "producer",
            }
            state["messages"].append(result_message)
            timeline.append({"kind": "tool_result",
                             "messageId": event["messageId"],
                             "toolCallId": event["toolCallId"]})
            return
        if _require_open_run(state, event_type, source_index,
                             diagnostics) is None:
            return
        if not entries:
            diagnostics.append(_reducer_diagnostic(
                "RESULT_WITHOUT_CALL", source_index,
                f"TOOL_CALL_RESULT for toolCallId "
                f"\"{event['toolCallId']}\" with no such call: a result "
                "must correspond to an existing call (PROJECT_BOOK §5.5).",
                message_id=event["messageId"],
                tool_call_id=event["toolCallId"]))
            return
        first = entries[0]
        if first["incomplete"]:
            diagnostics.append(_reducer_diagnostic(
                "RESULT_FOR_INCOMPLETE_CALL", source_index,
                f"TOOL_CALL_RESULT for toolCallId "
                f"\"{event['toolCallId']}\" which was left incomplete by "
                "a run end: its execution is over without a result; a "
                "result cannot revive it (PROJECT_BOOK §3.14).",
                message_id=event["messageId"],
                tool_call_id=event["toolCallId"]))
            return
        if first["result"] is not None:
            diagnostics.append(_reducer_diagnostic(
                "DUPLICATE_TOOL_CALL_RESULT", source_index,
                f"TOOL_CALL_RESULT for toolCallId "
                f"\"{event['toolCallId']}\" which already has a result "
                f"(messageId "
                f"\"{first.get('resultMessageId') or '?'}\"): one logical "
                "execution has at most one result (PROJECT_BOOK §3.14).",
                message_id=event["messageId"],
                tool_call_id=event["toolCallId"]))
            return
        if _find_message(state, event["messageId"]) is not None:
            diagnostics.append(_reducer_diagnostic(
                "DUPLICATE_MESSAGE_ID", source_index,
                f"TOOL_CALL_RESULT messageId \"{event['messageId']}\" "
                "already exists as a message: a result creates a NEW "
                "tool message (PROJECT_BOOK §3.14).",
                message_id=event["messageId"],
                tool_call_id=event["toolCallId"]))
            return
        content = copy.deepcopy(event["content"])
        target["result"] = content
        target["resultMessageId"] = event["messageId"]
        target["open"] = False
        if event["toolCallId"] in state["pendingToolCallIds"]:
            state["pendingToolCallIds"] = [
                x for x in state["pendingToolCallIds"]
                if x != event["toolCallId"]]
        result_message = {
            "id": event["messageId"],
            "role": "tool",
            "name": None,
            "content": content,
            "segments": [{"text": content if isinstance(content, str) else ""}],
            "toolCalls": [],
            "toolCallId": event["toolCallId"],
            "open": False,
            "incomplete": False,
            "owner": "producer",
        }
        state["messages"].append(result_message)
        timeline.append({"kind": "tool_result",
                         "messageId": event["messageId"],
                         "toolCallId": event["toolCallId"]})
        return

    if event_type == "STATE_SNAPSHOT":
        state["sharedState"] = copy.deepcopy(event["snapshot"])
        timeline.append({"kind": "state_snapshot"})
        return

    if event_type == "STATE_DELTA":
        if state["sharedState"] is None:
            # No baseline yet (no RUN_STARTED input.state and no
            # STATE_SNAPSHOT): mirror TS applyStateDelta, which
            # records SNAPSHOT_MISMATCH and does not apply the delta.
            diagnostics.append(_diagnostic(
                "SNAPSHOT_MISMATCH", source_index,
                "STATE_DELTA arrived with no shared-state baseline "
                "(no RUN_STARTED input.state and no STATE_SNAPSHOT "
                "yet); the delta is not applied and the state stays "
                "unset (EVENT_SCHEMA §6.2: a producer must not send a "
                "delta without a baseline).",
                {"reducerCode": "SNAPSHOT_MISMATCH"}))
            return
        new_state, failure, dropped = apply_json_patch(
            state["sharedState"], event["delta"])
        for item in dropped:
            diagnostics.append(_diagnostic(
                "UNKNOWN_PATCH_OP", source_index,
                f"STATE_DELTA op #{item['index']} names unknown "
                f"operation {_json_string(item['op'])}; the element is "
                "discarded and the run continues (EVENT_SCHEMA §6.2).",
                {"reducerCode": "UNKNOWN_PATCH_OP"}))
        if failure is not None:
            diagnostics.append(_diagnostic(
                "SNAPSHOT_MISMATCH", source_index,
                f"STATE_DELTA could not be applied "
                f"(op #{failure['index']}: {failure['reason']}"
                f"{' — ' + failure['detail'] if failure.get('detail') else ''}); "
                "the patch is discarded atomically and the prior "
                "shared state is kept (EVENT_SCHEMA §6.2).",
                {"reducerCode": "SNAPSHOT_MISMATCH"}))
            return
        state["sharedState"] = new_state
        timeline.append({"kind": "state_delta"})
        return

    if event_type == "MESSAGES_SNAPSHOT":
        reconcile_messages_snapshot(state, event["messages"], source_index)
        timeline.append({"kind": "messages_snapshot"})
        return

    raise InvalidInput(f"unhandled event type {event_type!r}")


def fold(normalized_events, initial=None, applied_through=-1,
         collect_history=False):
    """Fold events into a RejoinState.

    Returns (state, diagnostics, history) where history is a list of
    (sourceIndex, state_hash) after each applied event (only when
    collect_history is True, else an empty list).

    *initial* is deep-copied, never mutated. *applied_through* is the
    sourceIndex the initial state already covers (a checkpoint index,
    or -1 for an empty base): a TOOL_CALL_START at or below it for an
    already-closed call is a replay duplicate (AG-UI #1524).
    """
    state = copy.deepcopy(initial) if initial is not None else initial_state()
    diagnostics = []
    history = []
    seen_tool_starts = set()
    applied_payloads = set()
    expanded = expand_chunks(normalized_events)
    # pendingToolCallIds is a derived field (ADR-F01): normalise any
    # checkpoint-provided value to the derived set before folding, so
    # the invariant holds for the returned state even when the resume
    # stream is empty.
    _refresh_pending_tool_call_ids(state)
    for wrapper in expanded:
        event = wrapper["event"]
        source_index = wrapper["sourceIndex"]
        validate_event(event, source_index)
        _reduce_one(state, wrapper, applied_through, seen_tool_starts,
                    applied_payloads, diagnostics)
        # Recompute the derived pending set after every event (same
        # rule as TS refreshPending); this subsumes the explicit
        # removal in the TOOL_CALL_RESULT branch, whose lines are
        # retained verbatim.
        _refresh_pending_tool_call_ids(state)
        if collect_history:
            history.append((source_index, copy.deepcopy(state),
                            state_hash(state)))
    return state, diagnostics, history
