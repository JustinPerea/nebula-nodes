"""Direct canvas edits from agents: the proposal shape, applied at once.

POST /api/graph/apply takes what propose_change takes (new nodes with +refs,
wires, param changes) plus renames, moves, removals and unwires, and applies
all of it or none of it. Graph validation happens in main, with the same
validators as proposals and single edits.
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

MAX_REMOVE = 24
MAX_UNWIRE = 24
MAX_RENAME = 24
MAX_MOVE = 50
MAX_LABEL = 80
_ALLOWED_KEYS = frozenset({"note", "nodes", "edges", "params", "rename", "move", "remove", "unwire"})
# Who bills a run: a route-table node's provider choice (_provider) and the
# Krea billing choice (_kreaAuth, Krea account vs API token). Proposals carry
# them so an agent can ask for a switch; main checks each value per node, and
# refuses a direct edit that would change one (main._refuse_agent_billing_change).
INTERNAL_OK = frozenset(BILLING_PARAMS)


@dataclass(frozen=True)
class EditSpec:
    additions: ProposalSpec
    rename: dict[str, str] = field(default_factory=dict)
    move: dict[str, dict[str, float]] = field(default_factory=dict)
    remove: tuple[str, ...] = ()
    unwire: tuple[ProposedEdge, ...] = ()

    @property
    def empty(self) -> bool:
        a = self.additions
        return not (a.nodes or a.edges or a.params or self.rename or self.move or self.remove or self.unwire)


def _node_id(raw: Any, label: str) -> str:
    if not isinstance(raw, str) or not NODE_ID_RE.fullmatch(raw):
        raise ProposalError(422, f"{label} must be an existing node id like n4")
    return raw


def _mapping(body: Mapping[str, Any], key: str, cap: int) -> dict[str, Any]:
    value = body.get(key)
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ProposalError(422, f"{key} must be an object keyed by node id or +ref")
    if len(value) > cap:
        raise ProposalError(422, f"an edit can {key} at most {cap} nodes")
    return value


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
    additions = parse_spec({"note": note, **adding}, internal_ok=INTERNAL_OK) if adding else ProposalSpec(note=clean_note(note))
    refs = additions.refs

    rename: dict[str, str] = {}
    for key, raw in _mapping(body, "rename", MAX_RENAME).items():
        target = _target(key, refs, "rename key")
        if not isinstance(raw, str) or len(raw) > MAX_LABEL:
            raise ProposalError(422, f"rename.{target} must be a name of at most {MAX_LABEL} characters ('' restores the model's name)")
        rename[target] = raw

    move: dict[str, dict[str, float]] = {}
    for key, raw in _mapping(body, "move", MAX_MOVE).items():
        target = _target(key, refs, "move key")
        move[target] = _point(raw, f"move.{target}")

    remove_raw = body.get("remove") or []
    if not isinstance(remove_raw, list) or len(remove_raw) > MAX_REMOVE:
        raise ProposalError(422, f"remove must be a list of at most {MAX_REMOVE} node ids")
    remove = tuple(dict.fromkeys(_node_id(item, "remove[]") for item in remove_raw))

    unwire_raw = body.get("unwire") or []
    if not isinstance(unwire_raw, list) or len(unwire_raw) > MAX_UNWIRE:
        raise ProposalError(422, f"unwire must be a list of at most {MAX_UNWIRE} wires")
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

    spec = EditSpec(additions=additions, rename=rename, move=move, remove=remove, unwire=tuple(unwire))
    if spec.empty:
        raise ProposalError(422, "an edit needs at least one node, wire, param change, rename, move, removal or unwire")
    return spec


__all__ = ["EditSpec", "INTERNAL_OK", "parse_edit"]
