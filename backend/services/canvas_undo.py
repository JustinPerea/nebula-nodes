"""Undo for an agent's own canvas edits: the inverse the server keeps.

Every edit through ``POST /api/graph/apply`` (the MCP tools edit_canvas and
remove_from_canvas, ``nebula apply``) that changes something gets an edit id
and an undo token:

- The edit id (``ed_...``) is public. It rides on the edit's graphSync
  (``edit.id``), so a canvas's undo step knows which edit it holds, and on
  each of the edit's journal events (``edit: {id}``).
- The token is the agent's alone. Only the reply to its own request carries
  it, and ``POST /api/graph/apply/undo`` takes it back only from the same
  agent, while the canvas shows the project the edit was made in.

Per edit the book keeps what the edit changed (``inverse``): the nodes it
added, the params, names and positions it changed (before and after), the
nodes it removed (whole: params with the canvas's own ``_`` keys, outputs,
name, position) and the wires it added or took away. ``plan_undo`` checks
each part against how the edit left it (the "expect" side) and leaves a part
someone changed since as it is, reporting it, as a moodboard restore does
(services/moodboard_edits.py). A node someone ran since the edit counts as
changed since (Q82): the book keeps who started each run and when (``mark``,
``run_started``, ``node_ran``), and the undo leaves such a node whole, its
params, name, position and the wires into it, unless the undoing agent
started every one of those runs itself. main turns the plan into one restore (the
staging ``POST /api/graph/restore`` uses), trusted for ``_`` keys because the
server wrote them; an agent still can't send them.

Memory-only and bounded: ``UNDO_TTL_SECONDS``, ``MAX_EDITS``,
``MAX_EDIT_BYTES`` and ``MAX_TOTAL_BYTES``. A backend restart forgets every
inverse (a token then gets 404). Clearing the canvas or loading a graph into
the open project ends that project's tokens, because its node ids start
again.

Links: every edit id handed out (an agent's edit, an agent's undo, the
person's Cmd+Z of a step the canvas knew the edit of) keeps a small brief
(``EditLink``: whose, what kind, which journal events) for ``MAX_LINKS``
ids, after its inverse is gone, so the journal can still say whose edit an
undo reverted.
"""
from __future__ import annotations

import copy
import json
import re
import secrets
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable, Mapping

from services.canvas_events import actor_record

UNDO_TTL_SECONDS = 3600
MAX_EDITS = 100
MAX_EDIT_BYTES = 16 * 1024 * 1024
MAX_TOTAL_BYTES = 64 * 1024 * 1024
MAX_LINKS = 500
MAX_GONE = 500
# A link keeps at most this many of its bulk events (node.*, edge.*, ...),
# oldest first. Its pin.* and proposal.* events are always kept: they are few
# and agents act on them. A cut link says so (EditLink.truncated, .total).
MAX_LINK_EVENTS = 50
LINK_KEPT_KINDS = ("pin.", "proposal.")
MAX_TRACKED_RUNS = 256
MAX_RUN_NODES = 2000

EDIT_ID_RE = re.compile(r"^ed_[0-9a-f]{16}$")
_TOKEN_RE = re.compile(r"^[0-9a-f]{40}$")

APPLIED = "applied"
UNDONE = "undone"

Wire = tuple[str, str, str, str]
_MISSING = object()


class UndoError(Exception):
    def __init__(self, status: int, detail: str, code: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail
        self.code = code


def actor_brief(actor: Mapping[str, Any] | None) -> dict[str, Any]:
    """Whose edit, as a link names it: kind, and id and name for an agent."""
    actor = actor or {}
    kind = str(actor.get("kind") or "anonymous")
    brief: dict[str, Any] = {"kind": kind}
    for key in ("id", "name"):
        if isinstance(actor.get(key), str) and actor[key]:
            brief[key] = actor[key]
    return brief


def wire_key(edge: Mapping[str, Any]) -> Wire:
    return (str(edge.get("source") or ""), str(edge.get("sourceHandle") or ""),
            str(edge.get("target") or ""), str(edge.get("targetHandle") or ""))


def wire_body(wire: Wire) -> dict[str, str]:
    return {"source": wire[0], "sourceHandle": wire[1], "target": wire[2], "targetHandle": wire[3]}


def _wire_text(wire: Wire) -> str:
    return f"{wire[0]}.{wire[1]} → {wire[2]}.{wire[3]}"


# -- what an edit changed ------------------------------------------------------

def capture_before(nodes: Mapping[str, dict[str, Any]], edges: list[dict[str, Any]], *,
                   removed: list[str], changed: list[str], renamed: list[str], moved: list[str],
                   shown: Mapping[str, Any]) -> dict[str, Any]:
    """The canvas as an edit is about to change it: only what the edit names.

    ``shown`` are the positions the canvas shows (a node without a stored one
    is laid out on export), so undoing a move puts a node back where the
    person saw it."""
    def node_copy(node_id: str) -> dict[str, Any]:
        node = nodes[node_id]
        position = node.get("position") or shown.get(node_id)
        return {
            "id": node_id,
            "definitionId": str(node.get("definitionId") or ""),
            "params": copy.deepcopy(node.get("params") or {}),
            "label": node.get("label") or None,
            **({"position": {"x": float(position["x"]), "y": float(position["y"])}}
               if isinstance(position, Mapping) else {}),
            "outputs": copy.deepcopy(node.get("outputs") or {}),
        }

    return {
        "removed": [node_copy(node_id) for node_id in dict.fromkeys(removed) if node_id in nodes],
        "params": {node_id: copy.deepcopy(nodes[node_id].get("params") or {})
                   for node_id in changed if node_id in nodes},
        "labels": {node_id: nodes[node_id].get("label") or None for node_id in renamed if node_id in nodes},
        "positions": {node_id: _point(nodes[node_id].get("position") or shown.get(node_id))
                      for node_id in moved if node_id in nodes},
        "wires": sorted({wire_key(edge) for edge in edges}),
    }


def _point(value: Any) -> dict[str, float] | None:
    if not isinstance(value, Mapping):
        return None
    try:
        return {"x": float(value["x"]), "y": float(value["y"])}
    except (KeyError, TypeError, ValueError):
        return None


def build_inverse(before: Mapping[str, Any], nodes: Mapping[str, dict[str, Any]], edges: list[dict[str, Any]],
                  *, added: list[str]) -> dict[str, Any] | None:
    """What undoing the edit means, from the canvas before it and now; None
    when the edit changed nothing that undo would put back."""
    wires_before = {tuple(wire) for wire in before["wires"]}
    wires_after = {wire_key(edge) for edge in edges}
    inverse: dict[str, Any] = {
        "added": [{"id": node_id, "definitionId": str(nodes[node_id].get("definitionId") or ""),
                   "params": copy.deepcopy(nodes[node_id].get("params") or {}),
                   "label": nodes[node_id].get("label") or None}
                  for node_id in added if node_id in nodes],
        "addedWires": sorted(wires_after - wires_before),
        "changed": [],
        "renamed": [],
        "moved": [],
        "removed": [copy.deepcopy(node) for node in before["removed"] if node["id"] not in nodes],
        "removedWires": sorted(wires_before - wires_after),
    }
    for node_id, params in before["params"].items():
        now = nodes.get(node_id)
        if now is not None and (now.get("params") or {}) != params:
            inverse["changed"].append({"id": node_id, "definitionId": str(now.get("definitionId") or ""),
                                       "before": copy.deepcopy(params),
                                       "after": copy.deepcopy(now.get("params") or {})})
    for node_id, label in before["labels"].items():
        now = nodes.get(node_id)
        if now is not None and (now.get("label") or None) != label:
            inverse["renamed"].append({"id": node_id, "before": label, "after": now.get("label") or None})
    for node_id, point in before["positions"].items():
        now = nodes.get(node_id)
        if now is not None and point is not None and _point(now.get("position")) != point:
            inverse["moved"].append({"id": node_id, "before": point, "after": _point(now.get("position"))})
    if not any(inverse.values()):
        return None
    return inverse


def describe(inverse: Mapping[str, Any]) -> str:
    """One line on what undoing this edit does."""
    parts: list[str] = []
    if inverse["added"]:
        parts.append("removes " + _ids([node["id"] for node in inverse["added"]]))
    if inverse["removed"]:
        parts.append("puts back " + _ids([node["id"] for node in inverse["removed"]]))
    earlier = [item["id"] for key in ("changed", "renamed", "moved") for item in inverse[key]]
    if earlier:
        parts.append("returns " + _ids(list(dict.fromkeys(earlier))) + " to how they were")
    wires = len(inverse["addedWires"]) + len(inverse["removedWires"])
    if wires and not parts:
        parts.append(f"puts {wires} connection{'s' if wires != 1 else ''} back")
    return "Undo " + "; ".join(parts) + ". Anything changed or run since is left as it is."


def _ids(ids: list[str], limit: int = 6) -> str:
    shown = ", ".join(ids[:limit])
    return shown + (f" and {len(ids) - limit} more" if len(ids) > limit else "")


# -- the plan: what undo does to the canvas as it is now -----------------------------

def touched_nodes(inverse: Mapping[str, Any]) -> list[str]:
    """The nodes on the canvas an undo of this edit would change: those it
    added, changed, renamed or moved, and those its wires go into."""
    ids = [node["id"] for node in inverse["added"]]
    ids += [item["id"] for key in ("changed", "renamed", "moved") for item in inverse[key]]
    ids += [str(wire[2]) for key in ("addedWires", "removedWires") for wire in inverse[key]]
    return list(dict.fromkeys(ids))


@dataclass
class UndoPlan:
    restore: dict[str, Any]
    trusted: frozenset[str]
    skipped: list[dict[str, Any]]

    @property
    def empty(self) -> bool:
        body = self.restore
        return not (body["nodes"] or body["remove"] or body["wire"] or body["unwire"])


def authored(definition_id: str, params: Mapping[str, Any]) -> Any:
    """Params as the person authored them, as the canvas's undo compares them
    (frontend lib/canvasUndo.ts authoredParams): a Cinema scene without the
    media a run put into its shots, a Paper source as which source it is."""
    params = dict(params or {})
    if definition_id == "cinema-scene" and isinstance(params.get("scene"), dict):
        scene = dict(params["scene"])
        if isinstance(scene.get("shots"), list):
            scene["shots"] = [{key: value for key, value in shot.items()
                               if key not in ("output", "variations", "selectedVariation")}
                              if isinstance(shot, dict) else shot for shot in scene["shots"]]
        params["scene"] = scene
    if definition_id == "paper-source":
        source = params.get("_paperSource")
        params["_paperSource"] = source.get("id") if isinstance(source, dict) else None
    return params


def plan_undo(
    inverse: Mapping[str, Any],
    nodes: Mapping[str, dict[str, Any]],
    edges: list[dict[str, Any]],
    *,
    cannot_remove: Callable[[str, dict[str, Any]], str | None],
    refused_change: Callable[[str, str, dict[str, Any], dict[str, Any]], str | None],
    ran: Mapping[str, list[dict[str, Any]]] | None = None,
) -> UndoPlan:
    """The restore that undoes ``inverse`` on the canvas as it is now.

    A part goes back only if it is still as the edit left it; one that is
    already back is left alone; one someone changed since is skipped and
    reported. Parts are judged one by one: a node the person moved still
    gets its params back, and a param the person changed stays while the
    edit's other params go back.

    ``ran`` are the nodes someone other than the undoing agent ran since the
    edit, each with who ran them (actor briefs, ``CanvasUndoBook.ran_since``).
    Such a node is left whole: not removed, its params, name and position
    not put back, and no wire into it (its inputs made the result) taken
    away or put back. It is one ``skipped`` item, reason "ran since", with
    ``ranBy`` and the parts it ``left``. Wires out of it follow the usual
    rules.

    ``cannot_remove`` says why a node can't be deleted now (paid state), and
    ``refused_change`` why a param change isn't the agent's to make (who
    bills a run, notes to generators); both None when it is fine."""
    skipped: list[dict[str, Any]] = []
    current_wires = {wire_key(edge) for edge in edges}
    edit_wires = {tuple(wire) for wire in inverse["addedWires"]}
    ran = {node_id: list(actors) for node_id, actors in (ran or {}).items() if actors and node_id in nodes}
    ran_left: dict[str, list[str]] = {}  # node that ran since -> the parts it kept

    def leave(node_id: str, part: str) -> None:
        parts = ran_left.setdefault(node_id, [])
        if part not in parts:
            parts.append(part)

    remove: list[str] = []
    kept: set[str] = set()
    for node in inverse["added"]:
        node_id = node["id"]
        now = nodes.get(node_id)
        if now is None:
            continue
        if node_id in ran:
            # Not removed (never in ``remove``), but not in ``kept`` either: a
            # wire the edit added out of it into a node that didn't run is
            # unwired, as for a node that was already there; one into it is
            # left by the "wires in" branch below.
            leave(node_id, "node")
            continue
        reason: str | None = None
        if (str(now.get("definitionId") or "") != node["definitionId"]
                or authored(node["definitionId"], now.get("params") or {})
                != authored(node["definitionId"], node["params"])
                or (now.get("label") or None) != node["label"]):
            reason, message = "changed since", f"{node_id} changed since, so it stays"
        else:
            foreign = sorted(wire for wire in current_wires if node_id in (wire[0], wire[2]) and wire not in edit_wires)
            if foreign:
                other = foreign[0][2] if foreign[0][0] == node_id else foreign[0][0]
                reason, message = "wired since", f"{node_id} was connected to {other} since, so it stays"
            else:
                refusal = cannot_remove(node_id, now)
                if refusal:
                    reason, message = "can't be removed now", f"{node_id} stays: {refusal}"
        if reason:
            kept.add(node_id)
            skipped.append({"nodeId": node_id, "part": "node", "reason": reason, "message": message})
        else:
            remove.append(node_id)

    gone = set(remove)
    unwire: list[dict[str, str]] = []
    for raw in inverse["addedWires"]:
        edge = tuple(raw)
        if edge not in current_wires or gone & {edge[0], edge[2]} or kept & {edge[0], edge[2]}:
            continue
        if edge[2] in ran:
            leave(edge[2], "wires in")
            continue
        unwire.append(wire_body(edge))

    items: dict[str, dict[str, Any]] = {}

    def item(node_id: str) -> dict[str, Any]:
        return items.setdefault(node_id, {"id": node_id, "definitionId": str(nodes[node_id].get("definitionId") or "")})

    for change in inverse["changed"]:
        node_id = change["id"]
        now = nodes.get(node_id)
        if now is None:
            skipped.append({"nodeId": node_id, "part": "params", "reason": "removed since",
                            "message": f"{node_id} was removed since"})
            continue
        if str(now.get("definitionId") or "") != change["definitionId"]:
            skipped.append({"nodeId": node_id, "part": "params", "reason": "a different node now",
                            "message": f"{node_id} is a different node now"})
            continue
        current = dict(now.get("params") or {})
        before, after = change["before"], change["after"]
        keys = sorted(key for key in set(before) | set(after) if before.get(key, _MISSING) != after.get(key, _MISSING))
        back: dict[str, Any] = {}
        stale: list[str] = []
        for key in keys:
            was, left, value = before.get(key, _MISSING), after.get(key, _MISSING), current.get(key, _MISSING)
            if value == was:
                continue
            if value != left:
                stale.append(key)
                continue
            back[key] = was
        if node_id in ran:
            if back or stale:
                leave(node_id, "params")
            continue
        held: list[tuple[str, str]] = []
        for key in sorted(back):
            refusal = refused_change(node_id, change["definitionId"], current, _with(current, {key: back[key]}))
            if refusal:
                held.append((key, refusal))
        for key, _reason in held:
            back.pop(key)
        if back and refused_change(node_id, change["definitionId"], current, _with(current, back)):
            held.extend((key, "together") for key in sorted(back))
            back = {}
        if stale:
            skipped.append({"nodeId": node_id, "part": "params", "keys": stale, "reason": "changed since",
                            "message": f"{node_id}'s {', '.join(stale)} changed since, left as is"})
        if held:
            names = [key for key, _reason in held]
            skipped.append({"nodeId": node_id, "part": "params", "keys": names, "reason": "the person's to change",
                            "message": f"{node_id}'s {', '.join(names)} is the person's to change back "
                                       "(propose_change sends it to them)"})
        if back:
            item(node_id)["params"] = _with(current, back)

    for rename in inverse["renamed"]:
        node_id = rename["id"]
        now = nodes.get(node_id)
        if now is None:
            continue
        label = now.get("label") or None
        if label == rename["before"]:
            continue
        if node_id in ran:
            leave(node_id, "name")
            continue
        if label != rename["after"]:
            skipped.append({"nodeId": node_id, "part": "name", "reason": "changed since",
                            "message": f"{node_id}'s name changed since, left as is"})
            continue
        item(node_id)["label"] = rename["before"] or ""

    for move in inverse["moved"]:
        node_id = move["id"]
        now = nodes.get(node_id)
        if now is None:
            continue
        point = _point(now.get("position"))
        if point == move["before"]:
            continue
        if node_id in ran:
            leave(node_id, "position")
            continue
        if point != move["after"]:
            skipped.append({"nodeId": node_id, "part": "position", "reason": "moved since",
                            "message": f"{node_id} was moved since, left where it is"})
            continue
        item(node_id)["position"] = dict(move["before"])

    back_again: list[str] = []
    for node in inverse["removed"]:
        if node["id"] in nodes:
            continue  # already back: ids are never handed out twice
        restored = {key: copy.deepcopy(node[key]) for key in ("id", "definitionId", "params", "outputs", "position")
                    if key in node}
        if node.get("label"):
            restored["label"] = node["label"]
        items[node["id"]] = restored
        back_again.append(node["id"])

    present = (set(nodes) - gone) | set(back_again)
    wire: list[dict[str, str]] = []
    for raw in inverse["removedWires"]:
        edge = tuple(raw)
        if edge in current_wires:
            continue
        if edge[2] in ran and edge[2] in present:
            leave(edge[2], "wires in")
            continue
        missing = next((end for end in (edge[0], edge[2]) if end not in present), None)
        if missing is not None:
            skipped.append({"part": "wire", "wire": wire_body(edge), "reason": "gone since",
                            "nodeId": missing,
                            "message": f"the connection {_wire_text(edge)} can't come back: {missing} is gone"})
            continue
        wire.append(wire_body(edge))

    ran_skips = [{"nodeId": node_id, "part": "node", "reason": "ran since", "left": parts,
                  "ranBy": [actor_record(actor) for actor in ran[node_id]],
                  "message": f"{node_id} ran since (run by {_runners(ran[node_id])}), so it stays"}
                 for node_id, parts in ran_left.items()]
    return UndoPlan(
        restore={"action": "undo", "nodes": list(items.values()), "remove": remove, "wire": wire, "unwire": unwire},
        trusted=frozenset(items),
        skipped=ran_skips + skipped,
    )


# What an undo did, in its reply and in `nebula undo`'s first line, in this
# order: "Undone: removed 1, disconnected 1." A wire counts too, so an undo that
# only took a wire away doesn't read "no change".
UNDONE_VERBS = (("removed", "removed"), ("added", "put back"), ("changed", "reset"), ("renamed", "renamed"),
                ("moved", "moved"), ("wired", "connected back"), ("unwired", "disconnected"))


def nothing_went_back(skipped: list[dict[str, Any]], left: str = "") -> str:
    """The reply when an undo put nothing back: every part was changed or run
    since. ``left`` (the per-part list, for MCP and HTTP callers) goes in the
    middle; `nebula undo` lists the parts on their own lines instead.

    The token stays usable, but only a changed part can be put back the way
    the edit left it; a run can't be taken back, so a node someone ran since
    stays for good and retrying won't change it."""
    ran = any(item.get("reason") == "ran since" for item in skipped)
    fixable = any(item.get("reason") != "ran since" for item in skipped)
    if fixable and ran:
        tail = ("The token still works if the parts that changed are put back the way the edit left them; "
                "a node someone ran since stays for good.")
    elif fixable:
        tail = "The token still works if those parts are put back the way the edit left them."
    else:
        tail = ("A node someone ran since stays for good, so trying this token again won't change that."
                if sum(item.get("reason") == "ran since" for item in skipped) == 1 else
                "Nodes someone ran since stay for good, so trying this token again won't change that.")
    return " ".join(part for part in (
        "Nothing went back: every part of this edit was changed or run since.", left, tail) if part)


def _runners(actors: list[dict[str, Any]]) -> str:
    """Who ran a node, in a skip's message: "the person", "Codex", "the person and Codex"."""
    names: list[str] = []
    for actor in actors:
        kind = actor.get("kind")
        name = ("the person" if kind == "person" else str(actor_record(actor)["name"]) if kind == "agent"
                else "Nebula" if kind == "system" else "an unnamed client")
        if name not in names:
            names.append(name)
    return names[0] if len(names) == 1 else ", ".join(names[:-1]) + " and " + names[-1]


def _with(params: Mapping[str, Any], back: Mapping[str, Any]) -> dict[str, Any]:
    out = dict(params)
    for key, value in back.items():
        if value is _MISSING:
            out.pop(key, None)
        else:
            out[key] = copy.deepcopy(value)
    return out


# -- the book ----------------------------------------------------------------------

@dataclass
class EditLink:
    """What an edit id names, kept after the edit's inverse is gone."""
    id: str
    kind: str  # "edit" (an agent's apply), "undo" or "redo"
    actor: dict[str, Any]
    target: str | None = None  # for an undo or redo: the edit id it acts on
    events: list[int] = field(default_factory=list)
    # Every event noted under it (``events`` may hold fewer), and whether any was cut.
    total: int = 0
    truncated: bool = False
    kinds: dict[int, str] = field(default_factory=dict)  # of ``events``, for a later merge

    def events_view(self) -> dict[str, Any]:
        """``events`` for an edit.undone / edit.redone, with ``eventsTruncated``
        and ``eventsTotal`` when the link was cut."""
        view: dict[str, Any] = {"events": list(self.events)}
        if self.truncated:
            view.update(eventsTruncated=True, eventsTotal=self.total)
        return view


@dataclass
class EditRecord:
    edit_id: str
    token: str
    agent_id: str
    actor: dict[str, Any]
    project_id: str | None
    project_name: str
    expires: float
    inverse: dict[str, Any]
    size: int
    state: str = APPLIED
    undone_by: dict[str, Any] | None = None
    undo_id: str | None = None
    last_skipped: list[dict[str, Any]] = field(default_factory=list)
    # The book's clock when the edit committed: runs that started after it
    # count as "ran since" (CanvasUndoBook.ran_since).
    mark: int = 0
    # The removal records of the nodes the edit deleted ({id, nodeId, pins,
    # proposals}; main._remove_side_effects): the undo names them to the
    # restore, which puts those pins back and reopens those proposals.
    removals: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class _Run:
    """A run as the undo book keeps it: when it started, who started it, in
    which project, and the nodes it set out to run."""
    tick: int
    actor: dict[str, Any]
    project_id: str | None
    nodes: frozenset[str] = frozenset()


def _actor_key(actor: Mapping[str, Any]) -> str:
    """One run-er: an agent by its id, the person, or nobody we know."""
    kind = str(actor.get("kind") or "anonymous")
    if kind == "agent":
        return f"agent:{actor.get('id') or actor.get('name') or ''}"
    return kind


class CanvasUndoBook:
    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._records: OrderedDict[str, EditRecord] = OrderedDict()  # by token, oldest first
        self._by_edit: dict[str, str] = {}
        self._links: OrderedDict[str, EditLink] = OrderedDict()
        self._gone: OrderedDict[str, str] = OrderedDict()  # token -> why it no longer works
        self._bytes = 0
        # Per project: how many times its node ids started again (forget_project),
        # so an edit that was still finishing then keeps no token.
        self._epochs: dict[str | None, int] = {}
        # Runs, for "ran since": a clock that only goes up (``mark``), each
        # run's start, and per node the latest run each run-er started.
        self._tick = 0
        self._runs: OrderedDict[str, _Run] = OrderedDict()
        self._node_runs: OrderedDict[tuple[str | None, str], dict[str, tuple[int, dict[str, Any]]]] = OrderedDict()

    @staticmethod
    def new_id() -> str:
        return "ed_" + secrets.token_hex(8)

    # -- links
    def link(self, edit_id: str, *, kind: str, actor: Mapping[str, Any], target: str | None = None) -> EditLink:
        entry = EditLink(id=edit_id, kind=kind, actor=actor_brief(actor), target=target)
        self._links[edit_id] = entry
        self._links.move_to_end(edit_id)
        while len(self._links) > MAX_LINKS:
            self._links.popitem(last=False)
        return entry

    def link_of(self, edit_id: str | None) -> EditLink | None:
        return self._links.get(edit_id) if edit_id else None

    def note_events(self, edit_id: str, events: list[tuple[int, str]], *, merge: bool = False) -> None:
        """The link's events, from (seq, kind) pairs: every pin.* and proposal.*
        one, and the oldest MAX_LINK_EVENTS of the rest. ``merge`` adds them to
        what it kept before (events that left the journal's buffer since stay,
        and still count in ``total``)."""
        entry = self._links.get(edit_id)
        if entry is None:
            return
        found = {**(entry.kinds if merge else {}), **dict(events)}
        total = max(entry.total, len(found)) if merge else len(found)
        ordered = sorted(found.items())
        kept = sorted([pair for pair in ordered if pair[1].startswith(LINK_KEPT_KINDS)]
                      + [pair for pair in ordered if not pair[1].startswith(LINK_KEPT_KINDS)][:MAX_LINK_EVENTS])
        entry.events = [seq for seq, _kind in kept]
        entry.kinds = dict(kept)
        entry.total = total
        entry.truncated = len(kept) < total

    # -- runs
    def mark(self) -> int:
        """The book's clock, one step on: a run with a later mark started after."""
        self._tick += 1
        return self._tick

    def run_started(self, run_id: str | None, *, actor: Mapping[str, Any], project_id: str | None) -> None:
        """A run was asked for (POST /api/execute, /api/execute-node,
        /api/cinema/generate-shot, /api/graph/run): who, in which project, when."""
        if not run_id:
            return
        self._runs[run_id] = _Run(tick=self.mark(), actor=actor_brief(actor), project_id=project_id)
        self._runs.move_to_end(run_id)
        while len(self._runs) > MAX_TRACKED_RUNS:
            self._runs.popitem(last=False)

    def run_nodes(self, run_id: str | None, node_ids: list[str]) -> None:
        """The nodes a run set out to run: while it is still going they count
        as ran, before the engine reaches them."""
        run = self._runs.get(run_id) if run_id else None
        if run is not None:
            run.nodes = frozenset(node_ids)

    def node_ran(self, run_id: str | None, node_id: str, *, actor: Mapping[str, Any], project_id: str | None) -> None:
        """A run started a node (its ``run.started``). The run's own start
        counts as when, so a run asked for before an edit doesn't count
        against it; a run the book never saw starts now."""
        run = self._runs.get(run_id) if run_id else None
        tick = run.tick if run is not None else self.mark()
        who = run.actor if run is not None else actor_brief(actor)
        key = (run.project_id if run is not None else project_id, node_id)
        entry = self._node_runs.setdefault(key, {})
        self._node_runs.move_to_end(key)
        runner = _actor_key(who)
        if runner not in entry or entry[runner][0] < tick:
            entry[runner] = (tick, who)
        while len(self._node_runs) > MAX_RUN_NODES:
            self._node_runs.popitem(last=False)

    def ran_since(self, project_id: str | None, node_id: str, *, since: int, agent_id: str,
                  active: Callable[[str], bool] | None = None) -> list[dict[str, Any]]:
        """Who, other than the agent ``agent_id``, started a run of the node
        after ``since`` (an edit's mark), oldest first. A run still going
        (``active``) counts for every node it set out to run."""
        found: dict[str, tuple[int, dict[str, Any]]] = {
            runner: (tick, who) for runner, (tick, who) in self._node_runs.get((project_id, node_id), {}).items()
            if tick > since}
        if active is not None:
            for run_id, run in self._runs.items():
                if run.tick > since and run.project_id == project_id and node_id in run.nodes and active(run_id):
                    found.setdefault(_actor_key(run.actor), (run.tick, run.actor))
        mine = _actor_key({"kind": "agent", "id": agent_id})
        return [dict(who) for runner, (_tick, who) in sorted(found.items(), key=lambda item: item[1][0])
                if runner != mine]

    # -- records
    def epoch(self, project_id: str | None) -> int:
        """Pass it to ``keep`` from when the edit committed."""
        return self._epochs.get(project_id, 0)

    def keep(self, *, edit_id: str, actor: Mapping[str, Any], agent_id: str, project_id: str | None,
             project_name: str, inverse: dict[str, Any], epoch: int | None = None,
             mark: int | None = None, removals: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        """Keep an edit's inverse; the reply's ``undo``. ``mark`` is the
        book's clock when the edit committed (now when not given)."""
        self._expire()
        if epoch is not None and epoch != self.epoch(project_id):
            return {"token": None, "editId": edit_id, "reason": (
                "The canvas was cleared or a graph was loaded into it while this edit was finishing, so its "
                "node ids started again and the edit can't be undone.")}
        size = len(json.dumps(inverse, ensure_ascii=False, default=str).encode("utf-8"))
        if size > MAX_EDIT_BYTES:
            return {"token": None, "editId": edit_id, "reason": (
                "This edit is too large for Nebula to keep its undo. The person can still undo it on the canvas.")}
        token = secrets.token_hex(20)
        record = EditRecord(edit_id=edit_id, token=token, agent_id=agent_id, actor=actor_brief(actor),
                            project_id=project_id, project_name=project_name,
                            expires=self._clock() + UNDO_TTL_SECONDS, inverse=inverse, size=size,
                            mark=self.mark() if mark is None else mark,
                            removals=copy.deepcopy(list(removals or [])))
        self._records[token] = record
        self._by_edit[edit_id] = token
        self._bytes += size
        while self._records and (len(self._records) > MAX_EDITS or self._bytes > MAX_TOTAL_BYTES):
            oldest = next(iter(self._records))
            self._drop(oldest, f"Nebula keeps the undo of the last {MAX_EDITS} edits, and this is now older "
                               "(the oldest is dropped first)")
        return {"token": token, "editId": edit_id, "expiresInSeconds": UNDO_TTL_SECONDS,
                "summary": describe(inverse)}

    def take(self, token: str, *, agent_id: str, project_id: str | None) -> EditRecord:
        """The record a token undoes, for this agent on this project."""
        self._expire()
        if not isinstance(token, str) or _TOKEN_RE.fullmatch(token) is None:
            raise UndoError(404, "That isn't an undo token Nebula gave out (it is the `undo.token` of an "
                                 "edit_canvas or remove_from_canvas result).", "unknown_token")
        record = self._records.get(token)
        if record is None:
            why = self._gone.get(token)
            if why is not None:
                raise UndoError(410, f"This undo token no longer works: {why}. The person can still undo "
                                     "the edit on the canvas (Cmd+Z).", "token_gone")
            raise UndoError(404, "There's no edit for that undo token. Nebula forgets undo tokens when it "
                                 "restarts.", "unknown_token")
        if record.agent_id != agent_id:
            name = record.actor.get("name") or "another agent"
            raise UndoError(403, f"This undo token is for an edit {name} made; only {name} can undo it with "
                                 "it. The person can undo it on the canvas.", "not_your_edit")
        if record.project_id != project_id:
            raise UndoError(409, f"This edit was made in the project “{record.project_name}”, which isn't open. "
                                 "Open it again (open_project) to undo it.", "other_project")
        return record

    def renew_removals(self, removals: list[dict[str, Any]]) -> None:
        """New deletes that supersede removals kept edits name (a redo of the
        edit, an undo of its undo): each new record says which removal it
        replaces (``replaces``: the one the restore that brought its node back
        undid), and only an item with exactly that id, in a kept edit of the
        record's own project, takes the new record. Never by the node id
        alone: an import, a clear or another project gives the same id to
        another node (second review). main re-checks every id."""
        fresh: dict[tuple[str | None, str], dict[str, Any]] = {}
        for item in removals:
            if isinstance(item, dict) and isinstance(item.get("replaces"), str) and item["replaces"]:
                fresh[(item.get("projectId"), item["replaces"])] = item
        if not fresh:
            return
        for record in self._records.values():
            if not record.removals:
                continue
            if any((record.project_id, str(item.get("id"))) in fresh for item in record.removals):
                record.removals = [copy.deepcopy(fresh.get((record.project_id, str(item.get("id"))), item))
                                   for item in record.removals]

    def by_edit(self, edit_id: str | None) -> EditRecord | None:
        token = self._by_edit.get(edit_id or "")
        return self._records.get(token) if token else None

    def forget_project(self, project_id: str | None, why: str) -> None:
        self._epochs[project_id] = self.epoch(project_id) + 1
        for key in [key for key in self._node_runs if key[0] == project_id]:
            del self._node_runs[key]
        for token in [token for token, record in self._records.items() if record.project_id == project_id]:
            self._drop(token, why)

    def _expire(self) -> None:
        now = self._clock()
        for token in [token for token, record in self._records.items() if record.expires <= now]:
            self._drop(token, f"it expired ({UNDO_TTL_SECONDS // 60} minutes after the edit)")

    def _drop(self, token: str, why: str) -> None:
        record = self._records.pop(token, None)
        if record is None:
            return
        self._bytes -= record.size
        self._by_edit.pop(record.edit_id, None)
        self._gone[token] = why
        while len(self._gone) > MAX_GONE:
            self._gone.popitem(last=False)
