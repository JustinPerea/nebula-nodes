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


# What a delete's undo needs to put a pin back (canvas_pins._detach): kept
# with the pin, never shown to anyone (agents could otherwise name the
# person's removal ids in a restore of their own).
_UNDO_KEYS = ("detachedBy", "detachedDefinition", "attachedPosition")
_ANY_PROJECT = object()
ANOTHER_PROJECT = "another project is open now"
CHANGED_SINCE = "changed since"
ANOTHER_MODEL = "its node came back as another model"
DELETED_SINCE = "deleted since"
# A pin an undo left as it is says why twice: ``reason`` for agents to read,
# ``code`` for the canvas to count by. Only "another-model" is said in the
# person's notice (GM, 2026-10-23: "1 pin couldn't be re-attached."); a pin
# they deleted or changed since is their own doing and stays quiet.
PIN_LEFT_CODES = {
    CHANGED_SINCE: "changed",
    ANOTHER_MODEL: "another-model",
    DELETED_SINCE: "deleted",
    ANOTHER_PROJECT: "another-project",
}


def pin_left(pin_id: str, reason: str) -> dict[str, str]:
    """A pin an undo left as it is: ``{id, reason, code}``."""
    return {"id": pin_id, "reason": reason, "code": PIN_LEFT_CODES[reason]}


def public_pin(pin: Mapping[str, Any]) -> dict[str, Any]:
    """A pin as the person's tabs and agents read it."""
    return {key: copy.deepcopy(value) for key, value in pin.items() if key not in _UNDO_KEYS}


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

    @property
    def store(self) -> ProjectStore:
        source = self._store_source
        return source if isinstance(source, ProjectStore) else source()

    def forget_cache(self) -> None:
        """Nothing is kept here: the store's projection follows catalog.json."""

    # -- reading ---------------------------------------------------------
    def _active(self) -> tuple[str | None, list[dict[str, Any]]]:
        """The open project and its pins, as catalog.json holds them now
        (a copy: callers may change it).

        From ProjectStore.projection, which follows the file itself (every
        commit replaces catalog.json, whichever route or process makes it),
        so nothing has to remember to clear anything. Clearing a cache only
        after a project switch's broadcast let a listing taken meanwhile
        answer with the project open before (review 4 of PR #114, H1); and
        re-reading the whole catalog after every unrelated commit (an
        autosave) cost a parse, an upgrade and a deep copy per listing
        (review 5, M2). The store shares one projection per file with the
        workspace and the journal's project tag."""
        view = self.store.projection()
        return view.project_id, copy.deepcopy(list(view.pins))

    @staticmethod
    def _ordered(pins: list[dict[str, Any]]) -> list[dict[str, Any]]:
        # Open first, newest first inside each group.
        newest = sorted(pins, key=lambda pin: str(pin.get("createdAt") or ""), reverse=True)
        return [pin for pin in newest if pin.get("status") == "open"] + [
            pin for pin in newest if pin.get("status") != "open"
        ]

    def list(self) -> dict[str, Any]:
        project_id, pins = self._active()
        return {"projectId": project_id, "pins": [public_pin(pin) for pin in self._ordered(pins)]}

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
        return {"projectId": project_id, "pins": [public_pin(pin) for pin in shown[:limit]], "openCount": open_count}

    # -- writing ---------------------------------------------------------
    def _write(self, mutate: Callable[[list[dict[str, Any]]], Any], *,
               project: str | None | object = _ANY_PROJECT) -> tuple[str, Any]:
        """Run ``mutate(pins)`` on the active project's list inside one catalog
        transaction. With ``project``, only while that project is the open one."""
        store = self.store
        with store.transaction() as catalog:
            project_id = catalog.get("activeProjectId")
            if project is not _ANY_PROJECT and project_id != project:
                raise PinError(409, ANOTHER_PROJECT)
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
        return project_id, result

    # add, remove and resolve answer the pin; their ``*_in`` twins answer
    # (project_id, pin): the project the write itself went to, for the
    # route's journal tag. A second read of the catalog after the write could
    # name a project opened since (review 6 of PR #114, LOW-1).
    def add(
        self,
        text: Any,
        *,
        node_id: str | None = None,
        position: Any = None,
        graph_nodes: Mapping[str, Any],
    ) -> dict[str, Any]:
        return self.add_in(text, node_id=node_id, position=position, graph_nodes=graph_nodes)[1]

    def add_in(
        self,
        text: Any,
        *,
        node_id: str | None = None,
        position: Any = None,
        graph_nodes: Mapping[str, Any],
    ) -> tuple[str, dict[str, Any]]:
        clean = clean_text(text, limit=MAX_PIN_TEXT)
        if (node_id is None) == (position is None):
            raise PinError(422, "Pin a note to a node (nodeId) or to a canvas spot (position), not both")
        if node_id is not None:
            if not isinstance(node_id, str) or node_id not in graph_nodes:
                raise PinError(404, "That node isn't on the canvas anymore.")
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
            return public_pin(pin)

        return self._write(mutate)

    def remove(self, pin_id: str) -> dict[str, Any]:
        return self.remove_in(pin_id)[1]

    def remove_in(self, pin_id: str) -> tuple[str, dict[str, Any]]:
        def mutate(pins: list[dict[str, Any]]) -> dict[str, Any]:
            for index, pin in enumerate(pins):
                if pin.get("id") == pin_id:
                    return public_pin(pins.pop(index))
            raise PinError(404, "That note isn't there anymore. Reload to get the latest notes.")

        return self._write(mutate)

    def resolve(self, pin_id: str, reply: Any, identity: AgentIdentity) -> dict[str, Any]:
        return self.resolve_in(pin_id, reply, identity)[1]

    def resolve_in(self, pin_id: str, reply: Any, identity: AgentIdentity) -> tuple[str, dict[str, Any]]:
        text = clean_text(reply, limit=MAX_REPLY, label="Reply")

        def mutate(pins: list[dict[str, Any]]) -> dict[str, Any]:
            for pin in pins:
                if pin.get("id") == pin_id:
                    # Resolving again replaces the reply: the latest answer wins.
                    pin["status"] = "resolved"
                    pin["reply"] = {"agent": identity.as_dict(), "text": text, "at": _iso(self._clock())}
                    return public_pin(pin)
            # Round 23 (review 22, M-1): pins belong to a project, and an agent
            # that read them before a switch holds another project's ids.
            raise PinError(404, f"No note {pin_id[:40]} on this canvas: that note isn't in the open project "
                                "(it may have changed since you read it). Read the canvas again (look_at_canvas, "
                                "or nebula pins) and answer a note listed there.")

        return self._write(mutate)

    def _detach(self, pins: list[dict[str, Any]], node_ids: Callable[[str], bool],
                positions: Mapping[str, Any], removals: Mapping[str, Mapping[str, Any]] | None = None,
                ) -> list[dict[str, Any]]:
        """Keep each pin of a gone node where the node stood, marked detached.

        ``removals`` maps a deleted node to its removal ({id, definitionId}):
        the pin then keeps that id (``detachedBy``), the model it was on
        (``detachedDefinition``) and the position it had (``attachedPosition``),
        so the undo of that very delete, and only that, can put it back as it
        was (``reattach``). A pin an import or a clear detached gets none of
        them: no undo of a delete brings it back. None of the three is ever
        shown (``public_pin``)."""
        changed = []
        for pin in pins:
            anchored = (pin.get("anchor") or {}).get("nodeId")
            if not isinstance(anchored, str) or not node_ids(anchored):
                continue
            was = copy.deepcopy(pin.get("position"))
            spot = _stored_position({"position": positions.get(anchored)}) or _stored_position(pin)
            spot = spot or {"x": 0.0, "y": 0.0}
            pin["anchor"] = dict(spot)
            pin["position"] = dict(spot)
            pin["detached"] = True
            pin["detachedFrom"] = anchored
            removal = (removals or {}).get(anchored) or {}
            if removal.get("id"):
                pin["detachedBy"] = str(removal["id"])
                pin["detachedDefinition"] = str(removal.get("definitionId") or "")
                pin["attachedPosition"] = was
            else:
                for key in _UNDO_KEYS:
                    pin.pop(key, None)
            changed.append(copy.deepcopy(pin))
        return changed

    def detach_node(self, node_id: str, position: Any = None, removal: str | None = None,
                    definition_id: str = "") -> list[dict[str, Any]]:
        """The node is gone: keep its pins where it stood, marked detached.
        ``removal`` is the delete's removal id and ``definition_id`` the
        node's model, for its undo (``reattach``)."""
        if not any((pin.get("anchor") or {}).get("nodeId") == node_id for pin in self._active()[1]):
            return []
        removals = {node_id: {"id": removal, "definitionId": definition_id}} if removal else None
        return self._write(lambda pins: self._detach(pins, lambda nid: nid == node_id,
                                                     {node_id: position}, removals))[1]

    def reattach(self, removals: list[Mapping[str, Any]], back: Mapping[str, str],
                 project_id: str | None) -> dict[str, list[dict[str, Any]]]:
        """The undo of a delete brought nodes back: put each pin that delete
        detached on its node again, as if the delete never happened.

        ``removals`` are the removal records the restore names ({id, nodeId,
        pins?}); ``back`` maps each node this restore brought back to its
        model, in ``project_id``. A pin goes back only if it is still
        detached by that very removal (``detachedBy``) from that node
        (``detachedFrom``), and the node came back as the model it was on
        (``detachedDefinition``), in the project it is in. So a stale or
        forged list attaches nothing: a pin someone deleted since, one another
        delete, an import or a clear detached, or one whose node came back as
        another model is left as it is and reported in ``left`` ({id,
        reason, code}, see ``pin_left``). Pins the record doesn't name but the removal detached go
        back too (the record may come from a canvas that never saw the
        delete's answer)."""
        wanted = {str(r["id"]): str(r["nodeId"]) for r in removals if r.get("nodeId") in back}
        if not wanted:
            return {"reattached": [], "left": []}
        named = {str(pin_id): str(r["id"]) for r in removals if r.get("nodeId") in back
                 for pin_id in r.get("pins") or []}

        def mutate(pins: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
            back_on: list[dict[str, Any]] = []
            left: list[dict[str, Any]] = []
            seen: set[str] = set()
            for pin in pins:
                pin_id = str(pin.get("id") or "")
                removal = pin.get("detachedBy")
                if not (pin.get("detached") and isinstance(removal, str) and removal in wanted
                        and pin.get("detachedFrom") == wanted[removal]):
                    if pin_id in named:
                        seen.add(pin_id)
                        left.append(pin_left(pin_id, CHANGED_SINCE))
                    continue
                seen.add(pin_id)
                node_id = wanted[removal]
                if pin.get("detachedDefinition") != back[node_id]:
                    # The node under that id now is another model: not the one it was on.
                    left.append(pin_left(pin_id, ANOTHER_MODEL))
                    continue
                spot = _stored_position({"position": pin.get("attachedPosition")})
                pin["anchor"] = {"nodeId": node_id}
                pin["position"] = spot
                pin["detached"] = False
                for key in ("detachedFrom", *_UNDO_KEYS):
                    pin.pop(key, None)
                back_on.append(copy.deepcopy(pin))
            left.extend(pin_left(pin_id, DELETED_SINCE) for pin_id in named if pin_id not in seen)
            return {"reattached": back_on, "left": left}

        try:
            return self._write(mutate, project=project_id)[1]
        except PinError as exc:
            if exc.detail != ANOTHER_PROJECT:
                raise
            return {"reattached": [], "left": [pin_left(pin_id, ANOTHER_PROJECT) for pin_id in named]}

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
