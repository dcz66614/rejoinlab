"""P031 RejoinLab — the single translation source for cross-language
parity (FIX-R2, P1-R2-02; ADR-003).

Two projections, one module (PROJECT_BOOK §5.3 / §10.4):

* P — the PRODUCTION projection: the verbatim TS projectState shape
  (src/core/canonical.ts projectState: 8 protocol fields, keys in
  the TS construction order, undefined dropped). This is what
  state_hash, the report finalStateHash, and the first-divergence
  hashes/differences are computed over. Timeline items carry runId
  ONLY where TS carries it (run events).
* Q — the PARITY projection: P plus the derived timeline runId on
  every item (ADR-003 §3(b), coordinator ruling: runId ENTERS the
  canonical form; run events take the event runId, other items take
  the current RUNNING run's runId, absent when no run is open).
  Q is what the S0 parity state hash and the parity paths compare.

The memo's §9.2 draft §2 ("state_hash and parity hash must be the
same function") is corrected here: they cannot be one function,
because the production report hash must reproduce the production
hash (coordinator ruling 2) while the parity canonical form carries
the derived runId (ruling 6). P and Q share this one translation
module, so they cannot drift apart silently; the R-11 protection
test asserts the parity run key set covers the production run key
set.

Report conversions mirror src/report/json.ts toReportDiagnostic /
toReportFirstDivergence key rules: sourceIndex is omitted when
None, relatedSourceIndices when None or empty, firstDivergence
when null; a missing expected/actual in a difference becomes null.
"""

from __future__ import annotations

import copy

from oracle.canonical import canonical_hash

SPEC_VERSION = "1.0.2"
PROTOCOL_VERSION = "1.0"

# Frozen report texts (src/report/schema.ts REPORT_ASSUMPTIONS /
# REPORT_LIMITATIONS), verbatim. The Oracle used to carry two
# different English texts each; FIX-R2 reuses the TS frozen Chinese
# texts byte-for-byte (memo §7).
REPORT_ASSUMPTIONS = [
    "使用 AG-UI 1.0 事件语义",
    "事件到达顺序为权威顺序",
    "恢复游标为 RejoinLab 本地 sourceIndex；AG-UI 1.0 HTTP+SSE 本身不支持流恢复",
    "检查点状态来自断线前缀折叠或显式检查点 capturedState",
]
REPORT_LIMITATIONS = [
    "不证明真实 Agent 后端 exactly-once",
    "不执行真实网络重连",
    "不证明真实 Agent 后端业务逻辑正确",
    "不证明真实服务端支持断点恢复",
    "不覆盖超过 40 条事件的轨迹",
]

__all__ = [
    "SPEC_VERSION",
    "PROTOCOL_VERSION",
    "project_state_production",
    "production_state_hash",
    "parity_project_state",
    "parity_state_hash",
    "parity_project_path",
    "report_project_path",
    "to_report_diagnostic",
    "report_hash",
    "parity_report_hash",
]


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


def _production_run(run):
    # Key order mirrors the TS RunState construction: runId,
    # threadId, status, then the optional fields in the order the
    # Reducer adds them (parentRunId / protocolVersion at creation,
    # outcome / result on finish, error on failure).
    entry = {
        "runId": run["runId"],
        "threadId": run["threadId"],
        "status": run["status"],
    }
    if "parentRunId" in run:
        entry["parentRunId"] = run["parentRunId"]
    if "protocolVersion" in run:
        entry["protocolVersion"] = run["protocolVersion"]
    if "outcome" in run:
        entry["outcome"] = copy.deepcopy(run["outcome"])
    if "result" in run:
        entry["result"] = copy.deepcopy(run["result"])
    if "error" in run:
        entry["error"] = copy.deepcopy(run["error"])
    return entry


def _production_message(message):
    # Key order mirrors the TS MessageState construction (id, role,
    # name?, content, segments, status, owner, with toolCalls /
    # toolCallId / error appended by the snapshot/seed paths). The
    # toolCalls key is present only for a non-empty list: a streamed
    # message carries no toolCalls key in TS (Oracle keeps an empty
    # list internally), while a snapshot/input message carries the
    # full wire ToolCall objects. The explicit-[] corner (TS keeps
    # [], Oracle drops it) has no fixture; see ADR-003.
    entry = {
        "id": message["id"],
        "role": message["role"],
    }
    if message.get("name") is not None:
        entry["name"] = message["name"]
    if "content" in message:
        entry["content"] = copy.deepcopy(message["content"])
    entry["segments"] = copy.deepcopy(message.get("segments") or [])
    if message.get("toolCalls"):
        entry["toolCalls"] = copy.deepcopy(message["toolCalls"])
    if message.get("toolCallId") is not None:
        entry["toolCallId"] = message["toolCallId"]
    if "error" in message:
        entry["error"] = message["error"]
    entry["status"] = _message_status(message)
    # Owner: the stored key wins; a fragment message without one
    # follows TS convertMessage (activity/reasoning -> "client",
    # everything else -> "producer").
    owner = message.get("owner")
    if owner is None:
        owner = ("client" if message.get("role") in ("activity", "reasoning")
                 else "producer")
    entry["owner"] = owner
    return entry


def _production_tool_call(call):
    entry = {
        "id": call["toolCallId"],
        "name": call["toolCallName"],
    }
    if call.get("parentMessageId") is not None:
        entry["parentMessageId"] = call["parentMessageId"]
    entry["arguments"] = call.get("args", "")
    entry["status"] = _tool_call_status(call)
    entry["hasResult"] = call.get("result") is not None
    entry["runId"] = call.get("runId")
    if call.get("resultMessageId") is not None:
        entry["resultMessageId"] = call["resultMessageId"]
    if call.get("result") is not None:
        entry["resultContent"] = copy.deepcopy(call["result"])
    return entry


_TIMELINE_KIND_MAP = {
    "run_started": ("run", "RUN_STARTED"),
    "run_finished": ("run", "RUN_FINISHED"),
    "run_error": ("run", "RUN_ERROR"),
    "text_start": ("message", "TEXT_MESSAGE_START"),
    "text": ("message", "TEXT_MESSAGE_CONTENT"),
    "text_end": ("message", "TEXT_MESSAGE_END"),
    "tool_start": ("tool-call", "TOOL_CALL_START"),
    "tool_args": ("tool-call", "TOOL_CALL_ARGS"),
    "tool_end": ("tool-call", "TOOL_CALL_END"),
    "tool_result": ("tool-call", "TOOL_CALL_RESULT"),
    "state_snapshot": ("state", "STATE_SNAPSHOT"),
    "state_delta": ("state", "STATE_DELTA"),
    "messages_snapshot": ("messages-snapshot", "MESSAGES_SNAPSHOT"),
}


def _production_timeline_item(item):
    # Key order mirrors the TS appendTimeline literals per kind:
    # run {kind, eventType, runId}; message START/END {kind,
    # eventType, messageId}; CONTENT {kind, eventType, messageId,
    # text}; tool-call START {kind, eventType, toolCallId,
    # messageId}; ARGS {kind, eventType, toolCallId, text}; END
    # {kind, eventType, toolCallId}; RESULT {kind, eventType,
    # messageId, toolCallId}; state / messages-snapshot {kind,
    # eventType}.
    kind, event_type = _TIMELINE_KIND_MAP[item["kind"]]
    entry = {"kind": kind, "eventType": event_type}
    if kind == "run":
        if item.get("runId") is not None:
            entry["runId"] = item["runId"]
        return entry
    if kind == "state" or kind == "messages-snapshot":
        return entry
    if event_type == "TOOL_CALL_RESULT":
        if item.get("messageId") is not None:
            entry["messageId"] = item["messageId"]
        if item.get("toolCallId") is not None:
            entry["toolCallId"] = item["toolCallId"]
        return entry
    if event_type == "TOOL_CALL_START":
        if item.get("toolCallId") is not None:
            entry["toolCallId"] = item["toolCallId"]
        if item.get("messageId") is not None:
            entry["messageId"] = item["messageId"]
        return entry
    if item.get("messageId") is not None:
        entry["messageId"] = item["messageId"]
    if item.get("toolCallId") is not None:
        entry["toolCallId"] = item["toolCallId"]
    text = item.get("text", item.get("delta"))
    if text is not None:
        entry["text"] = text
    return entry


def project_state_production(state):
    """The production projection P (verbatim TS projectState shape)."""
    return {
        "threadId": state.get("threadId"),
        "runs": [_production_run(r) for r in state.get("runs") or []],
        "messages": [_production_message(m)
                     for m in state.get("messages") or []],
        "toolCalls": [_production_tool_call(c)
                      for c in state.get("toolCalls") or []],
        "sharedState": copy.deepcopy(state.get("sharedState")),
        "orderedTimeline": [_production_timeline_item(i)
                            for i in state.get("orderedTimeline") or []],
        "pendingToolCallIds": list(state.get("pendingToolCallIds") or []),
        "runStatus": state.get("runStatus"),
    }


def production_state_hash(state):
    """SHA-256 of the JCS canonical bytes of the production projection."""
    return canonical_hash(project_state_production(state))


def parity_project_state(state):
    """The parity projection Q: P plus the derived timeline runId.

    Walk the production timeline: a run item sets (STARTED) or
    clears (FINISHED / RUN_ERROR, after the item) the current run;
    every other item takes the current run's runId when one is open
    and carries no runId key otherwise. The derived runId is
    appended last on non-run items (it is a parity-only key with no
    production position).
    """
    projected = project_state_production(state)
    current_run_id = None
    for item in projected["orderedTimeline"]:
        if item["kind"] == "run":
            if item["eventType"] == "RUN_STARTED":
                current_run_id = item.get("runId")
            elif item["eventType"] in ("RUN_FINISHED", "RUN_ERROR"):
                current_run_id = None
            continue
        if current_run_id is not None:
            item["runId"] = current_run_id
    return projected


def parity_state_hash(state):
    """SHA-256 of the JCS canonical bytes of the parity projection."""
    return canonical_hash(parity_project_state(state))


def parity_project_path(state):
    """§13.2 PathResult in parity form: parity hash + parity contents
    + runStatus (the parity path is the production path plus
    runStatus; §13.2's production PathResult has no such field)."""
    projected = parity_project_state(state)
    return {
        "finalStateHash": canonical_hash(projected),
        "messages": projected["messages"],
        "toolCalls": projected["toolCalls"],
        "sharedState": projected["sharedState"],
        "pendingToolCallIds": projected["pendingToolCallIds"],
        "runStatus": projected["runStatus"],
    }


def report_project_path(state):
    """§13.2 PathResult in production form: production hash +
    production contents, WITHOUT runStatus (mirrors TS
    src/report/json.ts toReportPath)."""
    projected = project_state_production(state)
    return {
        "finalStateHash": canonical_hash(projected),
        "messages": projected["messages"],
        "toolCalls": projected["toolCalls"],
        "sharedState": projected["sharedState"],
        "pendingToolCallIds": projected["pendingToolCallIds"],
    }


def evaluation_project_path(state):
    """The evaluation path (TS planner.ts toPathResult): the report
    path PLUS runStatus. The S0 gate compares this shape (its
    pathFields reads runStatus); _report converts it to the report
    path with to_report_path below."""
    path = report_project_path(state)
    path["runStatus"] = state.get("runStatus")
    return path


def to_report_path(path):
    """Convert an evaluation path to the report path (TS
    src/report/json.ts toReportPath): drop runStatus. Returns a
    copy; the input is untouched."""
    if path is None:
        return None
    converted = dict(path)
    converted.pop("runStatus", None)
    return converted


def to_report_diagnostic(diagnostic):
    """Convert an internal diagnostic to the report form (TS
    toReportDiagnostic key rules): sourceIndex is omitted when None,
    relatedSourceIndices when None or empty; message and evidence are
    carried verbatim."""
    entry = {
        "code": diagnostic["code"],
        "severity": diagnostic["severity"],
    }
    if diagnostic.get("sourceIndex") is not None:
        entry["sourceIndex"] = diagnostic["sourceIndex"]
    related = diagnostic.get("relatedSourceIndices")
    if related:
        entry["relatedSourceIndices"] = list(related)
    entry["message"] = diagnostic["message"]
    entry["evidence"] = copy.deepcopy(diagnostic.get("evidence") or {})
    return entry


def report_hash(report):
    """The production report canonical hash (TS src/report/json.ts
    reportHash): SHA-256 of the JCS canonical bytes of the full
    report minus metrics.durationMs only. The top-level "bfsVisited"
    key that analyze() attaches for the S0 bridge is also dropped:
    it is not part of rejoinlab.report/v1 (TS keeps bfsVisited out
    of the JSON report entirely — json.ts WorkerReportBuild)."""
    stripped = copy.deepcopy(report)
    metrics = stripped.get("metrics")
    if isinstance(metrics, dict):
        metrics.pop("durationMs", None)
    stripped.pop("bfsVisited", None)
    stripped.pop("parityFullPath", None)
    stripped.pop("parityResumePath", None)
    return canonical_hash(stripped)


def parity_report_hash(report, parity_full_path, parity_resume_path):
    """The parity report hash: the production report hash input with
    fullPath / resumePath replaced by the parity paths (which carry
    runStatus). All other fields are the full production fields —
    diagnostics with message/evidence, input, recovery, assumptions,
    limitations, firstDivergence — byte for byte."""
    stripped = copy.deepcopy(report)
    metrics = stripped.get("metrics")
    if isinstance(metrics, dict):
        metrics.pop("durationMs", None)
    stripped.pop("bfsVisited", None)
    stripped.pop("parityFullPath", None)
    stripped.pop("parityResumePath", None)
    stripped["fullPath"] = parity_full_path
    stripped["resumePath"] = parity_resume_path
    return canonical_hash(stripped)
