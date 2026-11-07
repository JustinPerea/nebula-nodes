"""Which run's result last landed on each node, in the order Nebula saw them.

A node's run result (its outputs, state, run notes, error, batch previews) is
the product of a run, not a setting. When a tab's late save (a handoff,
PR #199 review 18 handoff-reopen MEDIUM-3) holds a result for a node whose
result Nebula's side changed too, the newer run wins. Every run reaches the
backend (the tab's runs carry the tab's run id, an agent's carry theirs), so
the order their results landed on each node is known here: each landing gets
the next number of one counter (``seq``) and the time it landed (epoch ms,
the clock the tab's run records use).

In memory only: after a restart nothing is known, and the handoff then
judges by the tab's run record alone. Bounded: a few landings per node, a few
thousand nodes, the oldest dropped first.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Any, Mapping

PER_NODE = 8
MAX_NODES = 4096


class NodeResultRuns:
    def __init__(self, *, per_node: int = PER_NODE, max_nodes: int = MAX_NODES) -> None:
        self._per_node = max(1, per_node)
        self._max_nodes = max(1, max_nodes)
        self._seq = 0
        # (project key, node id) -> [{runId, seq, at}], oldest first.
        self._landed: OrderedDict[tuple[str, str], list[dict[str, Any]]] = OrderedDict()

    @property
    def seq(self) -> int:
        """The number of the latest landing (0 before any)."""
        return self._seq

    def landed(self, project_id: str | None, node_id: str, run_id: str, *, at: float | None = None) -> None:
        """A result of ``run_id`` landed on ``node_id`` (its ExecutedEvent,
        ErrorEvent or SkippedEvent)."""
        if not node_id or not run_id:
            return
        self._seq += 1
        key = (str(project_id or ""), node_id)
        entries = [entry for entry in self._landed.pop(key, []) if entry["runId"] != run_id]
        entries.append({"runId": run_id, "seq": self._seq, "at": time.time() * 1000 if at is None else at})
        self._landed[key] = entries[-self._per_node:]
        while len(self._landed) > self._max_nodes:
            self._landed.popitem(last=False)

    def entries(self, project_id: str | None, node_id: str) -> list[dict[str, Any]]:
        """The node's landings, oldest first (copies)."""
        return [dict(entry) for entry in self._landed.get((str(project_id or ""), node_id), [])]

    def renumber(self, project_id: str | None, mapping: Mapping[str, str]) -> None:
        """The project's nodes got new ids ({old: new}): their landings move
        with them. Landings already under a new id are kept, the moved ones
        merged in by their order."""
        project = str(project_id or "")
        for old, new in mapping.items():
            moved = self._landed.pop((project, old), None)
            if not moved or old == new:
                continue
            merged = {entry["runId"]: entry for entry in [*self._landed.pop((project, new), []), *moved]}
            self._landed[(project, new)] = sorted(merged.values(), key=lambda entry: entry["seq"])[-self._per_node:]

    def clear(self) -> None:
        self._landed.clear()
