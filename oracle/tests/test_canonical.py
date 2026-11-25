"""Tests for the independent JCS canonicalization (oracle/canonical.py).
"""

import math

import pytest

from oracle.canonical import (
    JcsError,
    canonical_hash,
    canonicalize,
    canonicalize_state,
    format_number,
    state_hash,
)


def test_key_order_is_canonical():
    first = {"b": 1, "a": {"d": 4, "c": 3}}
    second = {"a": {"c": 3, "d": 4}, "b": 1}
    assert canonicalize(first) == canonicalize(second)
    assert canonicalize(first) == b'{"a":{"c":3,"d":4},"b":1}'


def test_determinism_100_runs():
    value = {"messages": [{"id": "m1", "content": "hello \u4e16\u754c"}],
             "n": [3, 1.5, -0.0], "ok": True, "none": None}
    hashes = {canonical_hash(value) for _ in range(100)}
    assert len(hashes) == 1


def test_number_formatting():
    assert canonicalize(0) == b"0"
    assert canonicalize(-0.0) == b"0"
    assert canonicalize(42) == b"42"
    assert canonicalize(-7) == b"-7"
    assert canonicalize(1.5) == b"1.5"
    assert canonicalize(0.1) == b"0.1"
    assert canonicalize(1e21) == b"1e+21"
    assert canonicalize(1e-7) == b"1e-7"
    assert canonicalize(123456789.0) == b"123456789"


def test_format_number_matches_ecmascript_number_to_string():
    # Expected values are ECMAScript String(n) (verified against Node),
    # hardcoded here — NOT copied from the implementation under test.
    # Covers both notation switch points (1e21 / 1e-6) and the zones
    # where Python repr() used to diverge ([1e16, 1e21), [1e-6, 1e-4)).
    cases = [
        (1e15, "1000000000000000"),
        (1e16, "10000000000000000"),
        (1.23e16, "12300000000000000"),
        (1e20, "100000000000000000000"),
        (1e21, "1e+21"),
        (1e22, "1e+22"),
        (1e-4, "0.0001"),
        (1e-5, "0.00001"),
        (1e-6, "0.000001"),
        (1e-7, "1e-7"),
        (0.0, "0"),
        (-0.0, "0"),
        (123.456, "123.456"),
        (1.5e-5, "0.000015"),
        (5e-324, "5e-324"),
        (1.7976931348623157e308, "1.7976931348623157e+308"),
        (-1e16, "-10000000000000000"),
        (-1.5e-5, "-0.000015"),
        # Regression guards around the switch points and ordinary values.
        (1e15 + 1.0, "1000000000000001"),
        (9.999999999999999e20, "999999999999999900000"),
        (2e-6, "0.000002"),
        (1.5e-10, "1.5e-10"),
        (0.30000000000000004, "0.30000000000000004"),
        (-7.25, "-7.25"),
    ]
    for value, want in cases:
        assert format_number(value) == want, f"{value!r}"
        assert canonicalize(value) == want.encode("ascii"), f"{value!r}"


def test_non_json_numbers_rejected():
    with pytest.raises(JcsError):
        canonicalize(math.nan)
    with pytest.raises(JcsError):
        canonicalize(math.inf)
    with pytest.raises(JcsError):
        canonicalize(object())


def test_string_escaping():
    # Non-ASCII stays raw UTF-8; controls are escaped.
    assert canonicalize("hi") == b'"hi"'
    assert canonicalize("a\nb") == b'"a\\nb"'
    assert canonicalize("a\tb") == b'"a\\tb"'
    assert canonicalize("中文") == b'"\xe4\xb8\xad\xe6\x96\x87"'
    assert canonicalize('say "x"') == b'"say \\"x\\""'
    assert canonicalize("a\x01b") == b'"a\\u0001b"'


def test_array_order_preserved():
    assert canonicalize([3, 2, 1]) == b"[3,2,1]"
    assert canonicalize([3, 2, 1]) != canonicalize([1, 2, 3])


def test_state_projection_excludes_local_bookkeeping():
    base = {
        "threadId": "t1", "runs": [], "messages": [],
        "toolCalls": [], "sharedState": {}, "orderedTimeline": [],
        "pendingToolCallIds": [], "runStatus": "FINISHED",
    }
    noisy = dict(base)
    noisy["timestamp"] = 123456789
    noisy["sourceIndex"] = 99
    noisy["importFileName"] = "trace.jsonl"
    noisy["durationMs"] = 12
    assert canonicalize_state(base) == canonicalize_state(noisy)

    with_index = dict(base)
    with_index["orderedTimeline"] = [
        {"kind": "text", "messageId": "m1", "delta": "hi", "sourceIndex": 4,
         "timestamp": 900}]
    without_index = dict(base)
    without_index["orderedTimeline"] = [
        {"kind": "text", "messageId": "m1", "delta": "hi"}]
    assert canonicalize_state(with_index) == canonicalize_state(without_index)


def test_state_hash_changes_with_business_fields():
    base = {
        "threadId": "t1", "runs": [], "messages": [],
        "toolCalls": [], "sharedState": {}, "orderedTimeline": [],
        "pendingToolCallIds": [], "runStatus": "FINISHED",
    }
    changed = dict(base)
    changed["messages"] = [{"id": "m1", "role": "assistant",
                            "content": "hi", "segments": [{"text": "hi"}],
                            "toolCalls": [], "open": False,
                            "incomplete": False}]
    assert state_hash(base) != state_hash(changed)
