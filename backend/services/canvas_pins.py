"""Pins: short notes the person leaves on the canvas for agents.

The person pins "warmer" or "redo this one" to a node (or to a spot on the
canvas). Agents read open pins in ``nebula look`` and in watch events, act on
them, and answer with a one-line reply that resolves the pin.

Pins are the person's content, so they persist with the project. They live on
the project record in the catalog, ``catalog["projects"][id]["pins"]``, next
to ``snapshot`` rather than inside it. The browser's autosave
(``PUT /api/projects/{id}``) only replaces ``snapshot``, so it can never
overwrite or drop a pin, and switching projects brings each project's pins
with it.

Only the person creates and deletes pins (the routes check that); agents only
resolve them. Text is plain text: whitespace is collapsed, control characters
are stripped, and length is capped. It is never interpreted.
"""
from __future__ import annotations

import copy
import secrets
import time
import unicodedata
from datetime import datetime, timezone
from typing import Any, Callable, Mapping

from services.agent_presence import AgentIdentity
from services.project_store import ProjectStore

MAX_PIN_TEXT = 280
MAX_REPLY = 280
MAX_OPEN_PINS = 100
MAX_PINS = 200
RECENT_RESOLVED_SECONDS = 600
MAX_AGENT_PINS = 20
_COORD_LIMIT = 1e7


class PinError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def _iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()


def _epoch(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value).timestamp()
    except ValueError:
        return None


def clean_text(raw: Any, *, limit: int, label: str = "Note") -> str:
    """Plain, single-line text: control characters dropped, whitespace collapsed, 1..limit chars."""
    if not isinstance(raw, str):
        raise PinError(422, f"{label} must be text")
    # Cc covers C0, DEL and C1 controls. Format characters (Cf: bidi
    # overrides, zero-width joiners) are dropped too so a note can't render
    # differently from what agents read.
    kept = "".join(
        " " if char in "\t\n\r" else char
        for char in raw
        if char in "\t\n\r" or unicodedata.category(char) not in {"Cc", "Cf"}
    )
    text = " ".join(kept.split())
    if not text:
        raise PinError(422, f"{label} can't be empty")
    if len(text) > limit:
        raise PinError(422, f"{label} must be {limit} characters or fewer")
    return text


def _point(raw: Any, label: str = "position") -> dict[str, float]:
    if not isinstance(raw, Mapping):
        raise PinError(422, f"{label} must be an object with x and y")
    result: dict[str, float] = {}
    for axis in ("x", "y"):
        value = raw.get(axis)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise PinError(422, f"{label}.{axis} must be a number")
        number = float(value)
        if number != number or abs(number) >= _COORD_LIMIT:
            raise PinError(422, f"{label}.{axis} must be a finite canvas coordinate")
        result[axis] = round(number, 2)
    return result


def _stored_position(node: Mapping[str, Any] | None) -> dict[str, float] | None:
    position = (node or {}).get("position")
    try:
        return _point(position) if position is not None else None
    except PinError:
        return None


class CanvasPins:
    """Pins of the active project, stored on its catalog record."""

    def __init__(
        self,
        store: ProjectStore | Callable[[], ProjectStore],
        clock: Callable[[], float] = time.time,
    ) -> None:
        # A getter lets main.py follow `main.project_store` when tests swap it.
        self._store_source = store
        self._clock = clock
        self._cache: tuple[str | None, list[dict[str, Any]]] | None = None

    @property
    def store(self) -> ProjectStore:
        source = self._store_source
        return source if isinstance(source, ProjectStore) else source()

    def forget_cache(self) -> None:
        self._cache = None

    # -- reading ---------------------------------------------------------
    def _active(self) -> tuple[str | None, list[dict[str, Any]]]:
        if self._cache is None:
            catalog = self.store.read()
            project_id = catalog.get("activeProjectId")
            project = catalog["projects"].get(project_id) if project_id else None
            pins = [pin for pin in (project or {}).get("pins") or [] if isinstance(pin, dict)]
            self._cache = (project_id, pins)
        project_id, pins = self._cache
        return project_id, copy.deepcopy(pins)

    @staticmethod
    def _ordered(pins: list[dict[str, Any]]) -> list[dict[str, Any]]:
        # Open first, newest first inside each group.
        newest = sorted(pins, key=lambda pin: str(pin.get("createdAt") or ""), reverse=True)
        return [pin for pin in newest if pin.get("status") == "open"] + [
            pin for pin in newest if pin.get("status") != "open"
        ]

    def list(self) -> dict[str, Any]:
        project_id, pins = self._active()
        return {"projectId": project_id, "pins": self._ordered(pins)}

    def get(self, pin_id: str) -> dict[str, Any] | None:
        return next((pin for pin in self._active()[1] if pin.get("id") == pin_id), None)

    def for_agents(self, limit: int = MAX_AGENT_PINS) -> dict[str, Any]:
        """Open pins, plus pins resolved in the last ten minutes (so agents see the replies)."""
        project_id, pins = self._active()
        now = self._clock()
        shown = []
        for pin in self._ordered(pins):
            if pin.get("status") == "open":
                shown.append(pin)
                continue
            resolved_at = _epoch((pin.get("reply") or {}).get("at"))
            if resolved_at is not None and now - resolved_at <= RECENT_RESOLVED_SECONDS:
                shown.append(pin)
        open_count = sum(1 for pin in pins if pin.get("status") == "open")
        return {"projectId": project_id, "pins": shown[:limit], "openCount": open_count}

    # -- writing ---------------------------------------------------------
    def _write(self, mutate: Callable[[list[dict[str, Any]]], Any]) -> tuple[str, Any]:
        """Run ``mutate(pins)`` on the active project's list inside one catalog transaction."""
        self._cache = None
        store = self.store
        with store.transaction() as catalog:
            project_id = catalog.get("activeProjectId")
            if not project_id or project_id not in catalog["projects"]:
                raise PinError(409, "Open or create a project before leaving notes")
            project = catalog["projects"][project_id]
            pins = project.setdefault("pins", [])
            if not isinstance(pins, list):
                pins = project["pins"] = []
            before = copy.deepcopy(pins)
            result = mutate(pins)
            if pins != before:
                store.commit(catalog)
        self._cache = None
        return project_id, result

    def add(
        self,
        text: Any,
        *,
        node_id: str | None = None,
        position: Any = None,
        graph_nodes: Mapping[str, Any],
    ) -> dict[str, Any]:
        clean = clean_text(text, limit=MAX_PIN_TEXT)
        if (node_id is None) == (position is None):
            raise PinError(422, "Pin a note to a node (nodeId) or to a canvas spot (position), not both")
        if node_id is not None:
            if not isinstance(node_id, str) or node_id not in graph_nodes:
                raise PinError(404, "That node isn't on the canvas")
            anchor: dict[str, Any] = {"nodeId": node_id}
            spot = _stored_position(graph_nodes.get(node_id))
        else:
            spot = _point(position)
            anchor = dict(spot)
        pin = {
            "id": "pin_" + secrets.token_hex(4),
            "text": clean,
            "anchor": anchor,
            "position": spot,
            "status": "open",
            "createdAt": _iso(self._clock()),
            "detached": False,
            "reply": None,
        }

        def mutate(pins: list[dict[str, Any]]) -> dict[str, Any]:
            if sum(1 for p in pins if p.get("status") == "open") >= MAX_OPEN_PINS:
                raise PinError(409, f"There are already {MAX_OPEN_PINS} open notes; delete some first")
            pins.append(pin)
            # Keep the list bounded: drop the oldest resolved pins first.
            while len(pins) > MAX_PINS:
                resolved = [p for p in pins if p.get("status") != "open"]
                if not resolved:
                    break
                oldest = min(resolved, key=lambda p: str(p.get("createdAt") or ""))
                pins.remove(oldest)
            return copy.deepcopy(pin)

        return self._write(mutate)[1]

    def remove(self, pin_id: str) -> dict[str, Any]:
        def mutate(pins: list[dict[str, Any]]) -> dict[str, Any]:
            for index, pin in enumerate(pins):
                if pin.get("id") == pin_id:
                    return pins.pop(index)
            raise PinError(404, "That note no longer exists")

        return self._write(mutate)[1]

    def resolve(self, pin_id: str, reply: Any, identity: AgentIdentity) -> dict[str, Any]:
        text = clean_text(reply, limit=MAX_REPLY, label="Reply")

        def mutate(pins: list[dict[str, Any]]) -> dict[str, Any]:
            for pin in pins:
                if pin.get("id") == pin_id:
                    # Resolving again replaces the reply: the latest answer wins.
                    pin["status"] = "resolved"
                    pin["reply"] = {"agent": identity.as_dict(), "text": text, "at": _iso(self._clock())}
                    return copy.deepcopy(pin)
            raise PinError(404, f"No note {pin_id[:40]} on this canvas")

        return self._write(mutate)[1]

    def _detach(self, pins: list[dict[str, Any]], node_ids: Callable[[str], bool],
                positions: Mapping[str, Any]) -> list[dict[str, Any]]:
        changed = []
        for pin in pins:
            anchored = (pin.get("anchor") or {}).get("nodeId")
            if not isinstance(anchored, str) or not node_ids(anchored):
                continue
            spot = _stored_position({"position": positions.get(anchored)}) or _stored_position(pin)
            spot = spot or {"x": 0.0, "y": 0.0}
            pin["anchor"] = dict(spot)
            pin["position"] = dict(spot)
            pin["detached"] = True
            pin["detachedFrom"] = anchored
            changed.append(copy.deepcopy(pin))
        return changed

    def detach_node(self, node_id: str, position: Any = None) -> list[dict[str, Any]]:
        """The node is gone: keep its pins where it stood, marked detached."""
        if not any((pin.get("anchor") or {}).get("nodeId") == node_id for pin in self._active()[1]):
            return []
        return self._write(lambda pins: self._detach(pins, lambda nid: nid == node_id,
                                                     {node_id: position}))[1]

    def reanchor_missing(self, live_node_ids: set[str], positions: Mapping[str, Any] | None = None) -> list[dict[str, Any]]:
        """Detach every pin whose node is no longer on the canvas (after an import or a clear)."""
        stale = [
            pin for pin in self._active()[1]
            if isinstance((pin.get("anchor") or {}).get("nodeId"), str)
            and pin["anchor"]["nodeId"] not in live_node_ids
        ]
        if not stale:
            return []
        try:
            return self._write(lambda pins: self._detach(pins, lambda nid: nid not in live_node_ids,
                                                         positions or {}))[1]
        except PinError:
            return []


def pin_summary(pin: Mapping[str, Any]) -> str:
    anchor = pin.get("anchor") or {}
    where = f"on {anchor['nodeId']}" if "nodeId" in anchor else "on the canvas"
    text = str(pin.get("text") or "")
    return f'pinned "{text[:60]}{"…" if len(text) > 60 else ""}" {where}'
