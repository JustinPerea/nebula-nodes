"""Which nodes of a run reached their handler, the only place a provider is called.

The engine records a node just before it awaits the node's handler. A node
that never gets there (it was answered from the cache, or something upstream
failed, or the run stopped first) made no provider request in this run, so
the agent spending limits give its share of the run's count back when the
run ends (main._settle_hold).

Every doubt keeps the whole count, so a wrong record can only over-count:

- Only runs registered with ``begin`` are recorded. main registers a run
  once, when it places the run's spend hold, so the record covers the whole
  run. ``mark`` never creates a record, so a run whose record was dropped
  can't come back with a partial one.
- A second ``begin`` for a run id already recorded (run ids can come from
  the client) makes that run unrecorded.
- When the table is full, a new run isn't recorded. main drops a record
  whenever it drops the run's hold, so the table never outgrows the holds.

``take`` returns None for any run without a trustworthy record, and the
caller then keeps the whole count.
"""
from __future__ import annotations

import threading
from collections import OrderedDict

MAX_RUNS = 500

_lock = threading.Lock()
# run id -> nodes whose handler was called; None once the record can't be trusted.
_runs: OrderedDict[str, set[str] | None] = OrderedDict()


def begin(run_id: str) -> None:
    with _lock:
        if run_id in _runs:
            _runs[run_id] = None
        elif len(_runs) < MAX_RUNS:
            _runs[run_id] = set()


def mark(run_id: str | None, node_id: str) -> None:
    if not run_id:
        return
    with _lock:
        called = _runs.get(run_id)
        if called is not None:
            called.add(node_id)


def take(run_id: str) -> set[str] | None:
    """The nodes that reached their handler, or None if the run has no trustworthy record."""
    with _lock:
        return _runs.pop(run_id, None)
