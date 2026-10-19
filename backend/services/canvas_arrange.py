"""Arranges an agent asked for: lay out one edit's new nodes once a canvas draws them.

An agent can't know how big a node will render (an image card sizes to its
image), so `arrange` on a direct edit (POST /api/graph/apply, edit_canvas,
`nebula apply`) leaves the layout to the canvas, which can measure. The
backend keeps each request here and sends the open ones with every graphSync
(`arrange: [{id, nodeIds, direction, gap}]`), including the one a canvas gets
when it connects. So with no canvas open the nodes stay where they were
placed, and the first canvas that opens lays them out.

A canvas finishes a request with PUT /api/graph/layout and its `arrangeId`.
The first write wins and closes the request; a second open tab's write for
the same id changes nothing and is told so. Only that edit's new nodes may be
positioned by that write, so the person's own nodes never move.

A request shrinks when one of its nodes gets an explicit position (the
person drags it, or an agent moves it): that position wins. It closes when
none of its nodes are left on the canvas, and every request closes when the
canvas is replaced (another project opened) or cleared.

Memory-only, like proposals: a backend restart forgets open requests, and
their nodes keep the positions they were placed at.
"""
from __future__ import annotations

import secrets
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable, Container, Iterable

MAX_OPEN = 50


@dataclass
class PendingArrange:
    id: str
    node_ids: list[str]
    direction: str
    gap: float
    actor: dict[str, Any] | None = None
    created_at: float = field(default_factory=time.time)

    def view(self) -> dict[str, Any]:
        return {"id": self.id, "nodeIds": list(self.node_ids), "direction": self.direction, "gap": self.gap}


class ArrangeBook:
    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._items: OrderedDict[str, PendingArrange] = OrderedDict()

    def add(self, node_ids: Iterable[str], *, direction: str, gap: float,
            actor: dict[str, Any] | None = None) -> PendingArrange:
        ids = list(dict.fromkeys(str(node_id) for node_id in node_ids))
        # A node belongs to one request: a newer request for it replaces its place in an older one.
        self.forget_nodes(ids)
        entry = PendingArrange(id="a_" + secrets.token_hex(6), node_ids=ids, direction=direction,
                               gap=float(gap), actor=actor, created_at=self._clock())
        self._items[entry.id] = entry
        while len(self._items) > MAX_OPEN:
            self._items.popitem(last=False)
        return entry

    def get(self, arrange_id: str) -> PendingArrange | None:
        return self._items.get(arrange_id)

    def pending(self, existing: Container[str]) -> list[dict[str, Any]]:
        """Open requests as graphSync sends them, keeping only nodes still on the canvas."""
        views: list[dict[str, Any]] = []
        for arrange_id in list(self._items):
            entry = self._items[arrange_id]
            entry.node_ids = [node_id for node_id in entry.node_ids if node_id in existing]
            if not entry.node_ids:
                del self._items[arrange_id]
                continue
            views.append(entry.view())
        return views

    def complete(self, arrange_id: str) -> PendingArrange | None:
        """Close a request; None when it is already closed (another tab won) or unknown."""
        return self._items.pop(arrange_id, None)

    def forget_nodes(self, node_ids: Iterable[str]) -> None:
        """These nodes got an explicit position; no request may move them now."""
        gone = set(node_ids)
        if not gone:
            return
        for arrange_id in list(self._items):
            entry = self._items[arrange_id]
            entry.node_ids = [node_id for node_id in entry.node_ids if node_id not in gone]
            if not entry.node_ids:
                del self._items[arrange_id]

    def clear(self) -> None:
        self._items.clear()

    def __len__(self) -> int:
        return len(self._items)


canvas_arrange = ArrangeBook()

__all__ = ["ArrangeBook", "MAX_OPEN", "PendingArrange", "canvas_arrange"]
