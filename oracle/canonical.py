"""P031 RejoinLab — independent JSON canonicalization (Oracle).

Implements RFC 8785 (JSON Canonicalization Scheme, JCS) semantics from
scratch, using only the Python 3.12 standard library. This module is
intentionally independent of the production TypeScript implementation:
it shares no code with it and must never be fed production output as
ground truth.

Rules implemented (PROJECT_BOOK §5.3):
  * object keys sorted by UTF-16 code-unit order;
  * array order preserved;
  * strings JSON-escaped per JCS (control chars escaped, non-ASCII kept
    as UTF-8, lone surrogates escaped as \\uXXXX);
  * numbers in deterministic ECMAScript Number::toString form;
  * no NaN / Infinity (rejected); Python None is JSON null;
  * canonical bytes are UTF-8; digest is SHA-256.

Business-state projection: canonicalize_state() projects a RejoinState
dict onto its business fields only. Local bookkeeping (sourceIndex,
timestamps, file names, timings) is excluded by construction, while
messageId, toolCallId, message order, tool results and the ordered
timeline are retained.
"""

from __future__ import annotations

import hashlib
import json
import math

__all__ = ["canonicalize", "canonical_hash", "canonicalize_state", "JcsError"]


class JcsError(ValueError):
    """Raised when a value cannot be canonicalized (non-JSON value)."""


# ---------------------------------------------------------------------------
# ECMAScript Number::toString (shortest round-trip, JCS §3.2.2.3)
# ---------------------------------------------------------------------------

def format_number(value) -> str:
    """Format an int/float the way ECMAScript Number::toString does.

    Follows the ECMAScript Number::toString algorithm (JCS §3.2.2.3
    defers to it): let s be the shortest decimal digit string (k
    digits) and n the decimal exponent such that
    value = s * 10**(n - k). Then:
      * k <= n <= 21: s followed by (n - k) zeroes;
      * 0 < n <= 21:  s[:n] + "." + s[n:];
      * -6 < n <= 0:  "0." + (-n) zeroes + s;
      * otherwise:    scientific, s[0] + ("." + s[1:] if k > 1)
        + "e" + ("+" iff exponent >= 0) + exponent (no leading zero).

    Python repr(float) already yields the shortest round-trip decimal
    digits (identical digit string to ECMAScript's), but its notation
    switch points (1e16 / 1e-4) differ from ECMAScript's (1e21 /
    1e-6), so repr's output is only parsed for digits + exponent and
    the ES rules above are applied to re-format. -0.0 formats as "0"
    per JCS; NaN / Infinity are rejected.
    """
    if isinstance(value, bool):
        raise JcsError("boolean is not a number")
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if math.isnan(value) or math.isinf(value):
            raise JcsError("NaN and Infinity are not JSON values")
        if value == 0:
            return "0"  # also covers -0.0, per JCS
        text = repr(value)
        if text.startswith("-"):
            sign, text = "-", text[1:]
        else:
            sign = ""
        text = text.replace("E", "e")
        if "e" in text:
            mantissa, _, exp_text = text.partition("e")
            exp = int(exp_text)
        else:
            mantissa, exp = text, 0
        if "." in mantissa:
            int_part, _, frac_part = mantissa.partition(".")
        else:
            int_part, frac_part = mantissa, ""
        # n = decimal-point position relative to the digit string.
        digits = int_part + frac_part
        n = len(int_part) + exp
        # Strip leading zeroes (each one shifts the point left by one).
        stripped = digits.lstrip("0")
        n -= len(digits) - len(stripped)
        digits = stripped
        # Strip trailing zeroes (shortest digits never end in zero;
        # the point position is unchanged by this).
        digits = digits.rstrip("0")
        if not digits:
            return "0"  # unreachable for non-zero value; defensive
        s, k = digits, len(digits)
        if k <= n <= 21:
            out = s + "0" * (n - k)
        elif 0 < n <= 21:
            out = s[:n] + "." + s[n:]
        elif -6 < n <= 0:
            out = "0." + "0" * (-n) + s
        else:
            exp10 = n - 1
            out = s[0]
            if k > 1:
                out += "." + s[1:]
            out += "e" + ("+" if exp10 >= 0 else "-") + str(abs(exp10))
        return sign + out
    raise JcsError(f"not a JSON number: {value!r}")


def _utf16_key(key: str):
    """Sort key for JCS: the sequence of UTF-16 code units of the key."""
    return key.encode("utf-16-be", "surrogatepass")


def _escape_string(value: str) -> str:
    """JSON-escape a string per JCS: escape '"', '\\' and C0 controls
    (\\b \\t \\n \\f \\r, else \\u00XX); lone surrogates as \\uXXXX;
    every other character (including non-ASCII) is emitted raw."""
    out = ['"']
    for ch in value:
        code = ord(ch)
        if ch == '"':
            out.append('\\"')
        elif ch == "\\":
            out.append("\\\\")
        elif ch == "\b":
            out.append("\\b")
        elif ch == "\t":
            out.append("\\t")
        elif ch == "\n":
            out.append("\\n")
        elif ch == "\f":
            out.append("\\f")
        elif ch == "\r":
            out.append("\\r")
        elif code < 0x20 or 0xD800 <= code <= 0xDFFF:
            out.append("\\u%04x" % code)
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def canonicalize(value) -> bytes:
    """Return the JCS canonical UTF-8 bytes of a JSON value."""
    if value is None:
        return b"null"
    if value is True:
        return b"true"
    if value is False:
        return b"false"
    if isinstance(value, (int, float)):
        return format_number(value).encode("ascii")
    if isinstance(value, str):
        return _escape_string(value).encode("utf-8", "surrogatepass")
    if isinstance(value, (list, tuple)):
        parts = [canonicalize(item) for item in value]
        return b"[" + b",".join(parts) + b"]"
    if isinstance(value, dict):
        keys = list(value.keys())
        for key in keys:
            if not isinstance(key, str):
                raise JcsError(f"object key is not a string: {key!r}")
        keys.sort(key=_utf16_key)
        parts = []
        for key in keys:
            parts.append(_escape_string(key).encode("utf-8", "surrogatepass"))
            parts.append(b":")
            parts.append(canonicalize(value[key]))
            parts.append(b",")
        if parts:
            parts.pop()  # trailing comma
        return b"{" + b"".join(parts) + b"}"
    raise JcsError(f"value is not JSON-serializable: {value!r}")


def canonical_hash(value) -> str:
    """SHA-256 hex digest of the JCS canonical bytes of *value*."""
    return hashlib.sha256(canonicalize(value)).hexdigest()


# ---------------------------------------------------------------------------
# Business-state projection (PROJECT_BOOK §5.3)
# ---------------------------------------------------------------------------

# Business fields retained in the canonical state. Everything else
# (timestamps, sourceIndex, file names, timings, diagnostics) is dropped.
_STATE_FIELDS = (
    "threadId",
    "runs",
    "messages",
    "toolCalls",
    "sharedState",
    "orderedTimeline",
    "pendingToolCallIds",
    "runStatus",
)


def canonicalize_state(state: dict) -> bytes:
    """Canonical bytes of a RejoinState dict, business fields only.

    .. deprecated:: FIX-R2 (P1-R2-02)
        Kept for backward compatibility (oracle/tests/test_canonical.py
        and any external caller); it now delegates to the single
        translation source, oracle.parity.project_state_production.
        The old implementation projected runs to {runId, threadId,
        status} only and dropped message owner — that reduced
        projection was the second gap behind P1-R2-02 (the internal
        state_hash differed from the parity hash). New code must use
        oracle.parity.project_state_production /
        oracle.parity.production_state_hash directly.

    Timeline items are projected to business fields as well (kind,
    messageId / toolCallId, delta / text) — sourceIndex and timestamps
    never enter the hash.
    """
    from oracle.parity import project_state_production

    return canonicalize(project_state_production(state))


def state_hash(state: dict) -> str:
    """SHA-256 hex digest of the canonical business state.

    FIX-R2: the production state hash (oracle.parity.
    production_state_hash) — the verbatim TS projectState shape,
    including the five RunState fields (parentRunId,
    protocolVersion, outcome, result, error) and the full message /
    tool-call / timeline fields. This is the hash the report
    finalStateHash and the first-divergence hashes use.
    """
    from oracle.parity import production_state_hash

    return production_state_hash(state)
