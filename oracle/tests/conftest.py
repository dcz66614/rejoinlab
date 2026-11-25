"""pytest configuration: make the repository root importable so the
tests can import the oracle package no matter where pytest is run from.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
