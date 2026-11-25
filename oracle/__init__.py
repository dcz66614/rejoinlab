"""P031 RejoinLab — independent Python Oracle (T006).

Standard-library-only reference implementation of the frozen
PROJECT_BOOK v1.0.0 reducer, canonicalization, dual-track replay and
BFS shortest-fault search. See oracle/README.md.
"""

from oracle import canonical, reference, replay

__all__ = ["canonical", "reference", "replay"]
