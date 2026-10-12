"""Which nodes of a run reached their handler, the only place a provider is called.

The engine records a node just before it awaits the node's handler. A node
that never gets there (it was answered from the cache, or something upstream
failed, or the run stopped first) made no provider request in this run, so
the agent spending limits give its share of the run's count back when the
run ends (main._settle_hold).

Only runs the engine registered (``begin``) are tracked. ``take`` returns
None for any other run, and the caller then keeps the whole count: a run this
module can't vouch for is treated as if every node called its provider.
"""
from __future__ import annotations

import threading
from collections import OrderedDict

MAX_RUNS = 500

_lock = threading.Lock()
_runs: OrderedDict[str, set[str]] = OrderedDict()


def begin(run_id: str) -> None:
    with _lock:
        _runs.setdefault(run_id, set())
        _runs.move_to_end(run_id)
        while len(_runs) > MAX_RUNS:
            _runs.popitem(last=False)


def mark(run_id: str | None, node_id: str) -> None:
    if not run_id:
        return
    with _lock:
        _runs.setdefault(run_id, set()).add(node_id)


def take(run_id: str) -> set[str] | None:
    """The nodes that reached their handler, or None if the run wasn't tracked."""
    with _lock:
        return _runs.pop(run_id, None)
