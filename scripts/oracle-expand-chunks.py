"""FIX-R2 helper — expand chunk events with the Oracle.

Reads a JSON array of NormalizedEvent wrappers on stdin, writes the
Oracle expansion on stdout: {"expanded": [{type, messageId?,
toolCallId?}, ...], "count": n}. The S0 gate feeds the same input
to TS expandChunks (src/parser/normalize.ts) and compares the
expanded TYPE sequences + counts (memo §6.3-(A) prerequisite).

sourceIndex is deliberately NOT compared: TS re-indexes the
expansion 0..n in emission order while the Oracle keeps the
original indices — a known, documented corner (ADR-003); the
expanded event sequence is what the fold consumes.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from oracle.reference import expand_chunks  # noqa: E402


def main():
    events = json.load(sys.stdin)
    expanded = expand_chunks(events)
    out = []
    for wrapper in expanded:
        event = wrapper["event"]
        item = {"type": event["type"]}
        if "messageId" in event:
            item["messageId"] = event["messageId"]
        if "toolCallId" in event:
            item["toolCallId"] = event["toolCallId"]
        out.append(item)
    json.dump({"expanded": out, "count": len(out)}, sys.stdout,
              ensure_ascii=False)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
