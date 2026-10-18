"""Direct canvas edits from agents: the proposal shape, applied at once.

POST /api/graph/apply takes what propose_change takes (new nodes with +refs,
wires, param changes) plus renames, moves, removals and unwires, and applies
all of it or none of it. Graph validation happens in main, with the same
validators as proposals and single edits.

A direct edit has no per-edit caps (decision C1): it can be undone, so its
only bound is the canvas's own size limit, which main checks on the staged
graph (RESTORE_MAX_GRAPH_NODES / RESTORE_MAX_GRAPH_EDGES), plus the request
complexity limits every graph route has. Proposals keep their caps because
the person reviews them item by item.

`arrange` asks the open canvas to lay out this edit's new nodes once it has
drawn them (decision C3; services/canvas_arrange.py).
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

from services.canvas_proposals import (
    NODE_ID_RE,
    ProposalError,
    ProposalSpec,
    ProposedEdge,
    REF_RE,
    _handle,
    _point,
    clean_note,
    parse_spec,
)
from services.node_route import BILLING_PARAMS

MAX_LABEL = 80
_ALLOWED_KEYS = frozenset({"note", "nodes", "edges", "params", "rename", "move", "remove", "unwire", "arrange"})
ARRANGE_DIRECTIONS = ("right", "down")
DEFAULT_ARRANGE_GAP = 120.0
MAX_ARRANGE_GAP = 2000.0
# Who bills a run: a route-table node's provider choice (_provider) and the
# Krea billing choice (_kreaAuth, Krea account vs API token). Proposals carry
# them so an agent can ask for a switch; main checks each value per node, and
# refuses a direct edit that would change one (main._refuse_agent_billing_change).
INTERNAL_OK = frozenset(BILLING_PARAMS)


@dataclass(frozen=True)
class ArrangeRequest:
    """Lay out this edit's new nodes once a canvas has drawn them.

    `direction` is where the flow goes: "right" puts each step of the wiring
    in a new column, "down" in a new row. `gap` is the space in canvas pixels
    between those columns (or rows); nodes in the same column sit 40 apart."""
    direction: str = "right"
    gap: float = DEFAULT_ARRANGE_GAP

    def as_dict(self) -> dict[str, Any]:
        return {"direction": self.direction, "gap": self.gap}


@dataclass(frozen=True)
class EditSpec:
    additions: ProposalSpec
    rename: dict[str, str] = field(default_factory=dict)
    move: dict[str, dict[str, float]] = field(default_factory=dict)
    remove: tuple[str, ...] = ()
    unwire: tuple[ProposedEdge, ...] = ()
    arrange: ArrangeRequest | None = None

    @property
    def empty(self) -> bool:
        a = self.additions
        return not (a.nodes or a.edges or a.params or self.rename or self.move or self.remove or self.unwire)


def _node_id(raw: Any, label: str) -> str:
    if not isinstance(raw, str) or not NODE_ID_RE.fullmatch(raw):
        raise ProposalError(422, f"{label} must be an existing node id like n4")
    return raw


def _mapping(body: Mapping[str, Any], key: str) -> dict[str, Any]:
    value = body.get(key)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ProposalError(422, f"{key} must be an object keyed by node id or +ref")
    return value


def parse_arrange(raw: Any) -> ArrangeRequest | None:
    """`true`, `false`/absent, or {"direction": "right" | "down", "gap": number}."""
    if raw is None or raw is False:
        return None
    if raw is True:
        return ArrangeRequest()
    if not isinstance(raw, dict):
        raise ProposalError(422, 'arrange must be true or {"direction": "right" or "down", "gap": pixels}')
    unknown = sorted(set(raw) - {"direction", "gap"})
    if unknown:
        raise ProposalError(422, f"unknown arrange field '{str(unknown[0])[:40]}'; use direction and gap")
    direction = raw.get("direction", "right")
    if direction not in ARRANGE_DIRECTIONS:
        raise ProposalError(422, 'arrange.direction must be "right" or "down"')
    gap = raw.get("gap", DEFAULT_ARRANGE_GAP)
    if isinstance(gap, bool) or not isinstance(gap, (int, float)) or not 0 <= gap <= MAX_ARRANGE_GAP:
        raise ProposalError(422, f"arrange.gap must be a number of pixels from 0 to {int(MAX_ARRANGE_GAP)}")
    return ArrangeRequest(direction=str(direction), gap=float(gap))


def _target(raw: Any, refs: set[str], label: str) -> str:
    if isinstance(raw, str) and raw.startswith("+"):
        if not REF_RE.fullmatch(raw) or raw not in refs:
            raise ProposalError(400, f"{label} '{raw[:30]}' is not one of this edit's new nodes")
        return raw
    return _node_id(raw, label)


def parse_edit(body: Any) -> EditSpec:
    if not isinstance(body, dict):
        raise ProposalError(422, "the edit must be a JSON object")
    unknown = sorted(set(body) - _ALLOWED_KEYS)
    if unknown:
        raise ProposalError(422, f"unknown edit field '{str(unknown[0])[:40]}'")
    adding = {key: body[key] for key in ("nodes", "edges", "params") if body.get(key)}
    note = body.get("note") or "edit"
    additions = (parse_spec({"note": note, **adding}, internal_ok=INTERNAL_OK, capped=False)
                 if adding else ProposalSpec(note=clean_note(note)))
    refs = additions.refs

    rename: dict[str, str] = {}
    for key, raw in _mapping(body, "rename").items():
        target = _target(key, refs, "rename key")
        if not isinstance(raw, str) or len(raw) > MAX_LABEL:
            raise ProposalError(422, f"rename.{target} must be a name of at most {MAX_LABEL} characters ('' restores the model's name)")
        rename[target] = raw

    move: dict[str, dict[str, float]] = {}
    for key, raw in _mapping(body, "move").items():
        target = _target(key, refs, "move key")
        move[target] = _point(raw, f"move.{target}")

    remove_raw = body.get("remove") or []
    if not isinstance(remove_raw, list):
        raise ProposalError(422, "remove must be a list of node ids")
    remove = tuple(dict.fromkeys(_node_id(item, "remove[]") for item in remove_raw))

    unwire_raw = body.get("unwire") or []
    if not isinstance(unwire_raw, list):
        raise ProposalError(422, "unwire must be a list of wires")
    unwire: list[ProposedEdge] = []
    for index, raw in enumerate(unwire_raw):
        if not isinstance(raw, dict):
            raise ProposalError(422, f"unwire[{index}] must be {{source, sourceHandle, target, targetHandle}}")
        unwire.append(ProposedEdge(
            source=_node_id(raw.get("source"), f"unwire[{index}].source"),
            source_handle=_handle(raw.get("sourceHandle"), f"unwire[{index}].sourceHandle"),
            target=_node_id(raw.get("target"), f"unwire[{index}].target"),
            target_handle=_handle(raw.get("targetHandle"), f"unwire[{index}].targetHandle"),
        ))

    gone = set(remove)
    clash = sorted(gone & (additions.references | {k for k in {**rename, **move} if not k.startswith("+")}))
    if clash:
        raise ProposalError(400, f"{clash[0]} is removed in this edit, so it can't also be wired, changed, renamed or moved")

    arrange = parse_arrange(body.get("arrange"))
    if arrange is not None and not additions.nodes:
        raise ProposalError(422, "arrange lays out the new nodes this edit adds, and it adds none")

    spec = EditSpec(additions=additions, rename=rename, move=move, remove=remove, unwire=tuple(unwire),
                    arrange=arrange)
    if spec.empty:
        raise ProposalError(422, "an edit needs at least one node, wire, param change, rename, move, removal or unwire")
    return spec


__all__ = ["ArrangeRequest", "EditSpec", "INTERNAL_OK", "parse_arrange", "parse_edit"]
