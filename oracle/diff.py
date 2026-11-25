"""P031 RejoinLab — deterministic state comparison + first divergence
location (FIX-R2, P1-R2-02; ADR-003).

A verbatim mirror of src/core/diff.ts (diffValues, diffStates,
findFirstDivergence) + src/replay/align.ts
(findFirstDivergenceForReplay), over the PRODUCTION projection
(oracle.parity.project_state_production). The previous Oracle
implementation compared hashes only (replay._first_divergence
returned an int); the review showed the second gap behind P1-R2-02:
first divergence was computed on reduced hashes too. This module
returns the full firstDivergence object (§13.2 shape plus the
resolved event identity); the report layer strips the identity
fields and the note (A-07) via to_report_first_divergence.
"""

from __future__ import annotations

import copy

from oracle.canonical import _utf16_key, canonical_hash
from oracle.parity import project_state_production
from oracle.reference import _json_deep_equal, initial_state

__all__ = [
    "MISSING",
    "diff_values",
    "diff_states",
    "find_first_divergence",
    "to_report_first_divergence",
]


class _Missing:
    """Sentinel for an absent key/index (TS: undefined). Converted to
    None (JSON null) at the report layer only."""

    def __repr__(self):  # pragma: no cover - debugging aid
        return "MISSING"


MISSING = _Missing()


def _escape_pointer_token(token):
    return token.replace("~", "~0").replace("/", "~1")


def _join_pointer(base, token):
    return base + "/" + _escape_pointer_token(token)


def diff_values(expected, actual, base_pointer=""):
    """Recursive value diff (TS diff.ts diffValues).

    Deterministic order: object keys in JCS (UTF-16 code-unit)
    order, array indices ascending. Returns [] when deeply equal
    (strict JSON equality: True != 1). A missing key/index yields
    ONE entry with kind added/removed and the missing side MISSING.
    """
    if _json_deep_equal(expected, actual):
        return []
    if isinstance(expected, dict) and isinstance(actual, dict):
        keys = sorted(set(expected) | set(actual), key=_utf16_key)
        diffs = []
        for key in keys:
            in_expected = key in expected
            in_actual = key in actual
            pointer = _join_pointer(base_pointer, key)
            if not in_expected:
                diffs.append({
                    "jsonPointer": pointer,
                    "expected": MISSING,
                    "actual": actual[key],
                    "kind": "added",
                })
            elif not in_actual:
                diffs.append({
                    "jsonPointer": pointer,
                    "expected": expected[key],
                    "actual": MISSING,
                    "kind": "removed",
                })
            else:
                diffs.extend(diff_values(expected[key], actual[key],
                                         pointer))
        return diffs
    if isinstance(expected, list) and isinstance(actual, list):
        diffs = []
        for i in range(max(len(expected), len(actual))):
            pointer = _join_pointer(base_pointer, str(i))
            if i >= len(expected):
                diffs.append({
                    "jsonPointer": pointer,
                    "expected": MISSING,
                    "actual": actual[i],
                    "kind": "added",
                })
            elif i >= len(actual):
                diffs.append({
                    "jsonPointer": pointer,
                    "expected": expected[i],
                    "actual": MISSING,
                    "kind": "removed",
                })
            else:
                diffs.extend(diff_values(expected[i], actual[i], pointer))
        return diffs
    return [{
        "jsonPointer": base_pointer,
        "expected": expected,
        "actual": actual,
        "kind": "changed",
    }]


def diff_states(full_state, resume_state):
    """Diff two states over their production projections."""
    return diff_values(project_state_production(full_state),
                       project_state_production(resume_state))


def _event_identity_at(events, source_index):
    """Resolve the event identity at a divergent index (TS
    diff.ts eventIdentityAt): eventType plus the business ids the
    event carries (messageId from parentMessageId when the event
    has no messageId of its own)."""
    if events is None:
        return {}
    found = next((w for w in events
                  if w.get("sourceIndex") == source_index), None)
    if found is None:
        return {}
    event = found.get("event") or {}
    identity = {"eventType": event.get("type")}
    if isinstance(event.get("messageId"), str):
        identity["messageId"] = event["messageId"]
    if isinstance(event.get("toolCallId"), str):
        identity["toolCallId"] = event["toolCallId"]
    if isinstance(event.get("runId"), str):
        identity["runId"] = event["runId"]
    if isinstance(event.get("parentMessageId"), str) \
            and "messageId" not in identity:
        identity["messageId"] = event["parentMessageId"]
    return identity


def find_first_divergence(full_history, resume_history, base_state,
                          checkpoint_index, events=None):
    """Locate the first divergence between two per-event histories
    (TS align.ts findFirstDivergenceForReplay + diff.ts
    findFirstDivergence).

    Histories are (sourceIndex, state, state_hash) triples as
    returned by oracle.reference.fold(collect_history=True). The
    full history is sliced to sourceIndex >= checkpoint_index; the
    resume history is seeded with the base state at the checkpoint
    index (a replayed entry AT the checkpoint overrides the seed);
    the carried resume state starts as the initial state and is
    carried forward until the resume stream produces the next entry.
    Returns the full firstDivergence object, or None when every
    compared step agrees.
    """
    full_by_index = {}
    for source_index, state, _digest in full_history:
        if source_index >= checkpoint_index:
            full_by_index[source_index] = state
    if not full_by_index:
        return None
    resume_by_index = {checkpoint_index: base_state}
    for source_index, state, _digest in resume_history:
        if source_index >= checkpoint_index:
            resume_by_index[source_index] = state
    carried_resume_state = initial_state()
    carried_resume_hash = canonical_hash(
        project_state_production(carried_resume_state))
    carried_from = None
    for index in sorted(full_by_index):
        full_state = full_by_index[index]
        full_hash = canonical_hash(project_state_production(full_state))
        resume_entry = resume_by_index.get(index)
        if resume_entry is not None:
            carried_resume_state = resume_entry
            carried_resume_hash = canonical_hash(
                project_state_production(resume_entry))
            carried_from = index
        if full_hash != carried_resume_hash:
            identity = _event_identity_at(events, index)
            notes = []
            if resume_entry is None:
                notes.append(
                    "no resume entry at or before this index; "
                    "compared against the initial state"
                    if carried_from is None else
                    "no resume entry at this index; resume state "
                    f"carried forward from sourceIndex {carried_from}")
            if events is None:
                notes.append("no expanded event sequence supplied; "
                             "event identity not resolved")
            elif "eventType" not in identity:
                notes.append(
                    f"no expanded event found at sourceIndex {index}; "
                    "event identity not resolved")
            found = {
                "sourceIndex": index,
                **identity,
                "fullStateHash": full_hash,
                "resumeStateHash": carried_resume_hash,
                "differences": diff_states(full_state,
                                           carried_resume_state),
            }
            if notes:
                found["note"] = "; ".join(notes)
            return found
    return None


def to_report_first_divergence(first_divergence):
    """Convert a firstDivergence object to the report form (TS
    src/report/json.ts toReportFirstDivergence / A-07): strip kind,
    eventType, messageId, toolCallId, runId and note; a missing
    expected/actual becomes null; the field is omitted entirely
    when the divergence is null (the caller handles that)."""
    if first_divergence is None:
        return None
    return {
        "sourceIndex": first_divergence["sourceIndex"],
        "fullStateHash": first_divergence["fullStateHash"],
        "resumeStateHash": first_divergence["resumeStateHash"],
        "differences": [
            {
                "jsonPointer": d["jsonPointer"],
                "expected": (None if d["expected"] is MISSING
                             else copy.deepcopy(d["expected"])),
                "actual": (None if d["actual"] is MISSING
                           else copy.deepcopy(d["actual"])),
            }
            for d in first_divergence["differences"]
        ],
    }
