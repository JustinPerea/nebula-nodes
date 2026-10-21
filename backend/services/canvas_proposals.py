"""Proposals: an agent suggests a change, the person accepts or rejects it.

Before a costly change (paid runs, or reworking the person's graph) an agent
submits a proposal: new nodes with temporary refs (``+up``), wires between new
and existing nodes, param changes on existing nodes, nodes to run after
acceptance, and a one-line note. The backend validates it with the same
staging code as ``/api/graph/cluster`` (see ``main._stage_proposal``) and
keeps it here, in memory, until the person decides.

The person sees ghost nodes and dashed wires on the canvas. Ghosts never enter
the real graph, so they can't be autosaved, exported or executed. Accepting
stages the proposal again on a clone of the live graph and commits it in one
step; any validation failure commits nothing.

Who may decide: only the person's canvas. Every proposal carries an
``accept_key`` that is sent only to browser WebSockets and never appears in
any REST response, journal event, snapshot or CLI/MCP output. ``view()``
leaves it out by construction. See ``services/person_gate.py`` and
``docs/MCP-SETUP.md`` for the full layering and the remaining risk.

Cost: each node is ``free`` (a local utility node) or ``paid`` (a provider
call, labelled with the provider). ``estimate`` adds up list prices from
``data/model_pricing.json`` (see ``services/model_pricing.py``) for the nodes
that have one; it is None when none do, and ``open`` when some paid node has
no list price, so the real total can be higher. ``awaitingInput`` (only
when there are some) names the unpriced nodes priced from their input's
size, which isn't known until that input exists (model_pricing sizing).

Memory-only: open and recently decided proposals are lost on restart.
"""
from __future__ import annotations

import copy
import json
import re
import secrets
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping

from services.agent_params import internal_refusal
from services.agent_presence import AgentIdentity
from services.canvas_pins import PinError, clean_text
from services.selection_context import _SECRET_KEY_RE
from services.selection_context import _safe_value as safe_value

PROPOSAL_TTL_SECONDS = 900
MAX_OPEN_PER_AGENT = 3
MAX_OPEN_TOTAL = 12
MAX_NODES = 12
MAX_EDGES = 24
MAX_PARAM_NODES = 12
MAX_RUN = 6
MAX_NOTE = 160
MAX_REASON = 140
MAX_HANDLE = 64
# A node's name, as edit_canvas's rename takes it (canvas_edits.MAX_LABEL).
MAX_NAME = 80
RENAME_EXISTING = "Rename existing nodes with edit_canvas (or `nebula rename`)"
CLOSED_KEEP_SECONDS = 1800
MAX_CLOSED = 50
COORD_LIMIT = 1e7
# How much of one proposed value the person's decision bar shows. Longer text
# is cut with an explicit "N more characters" marker, never silently.
PERSON_VALUE_CHARS = 4000

REF_RE = re.compile(r"^\+[A-Za-z0-9_-]{1,24}$")
NODE_ID_RE = re.compile(r"^n\d{1,9}$")
_ALLOWED_KEYS = frozenset({"note", "nodes", "edges", "params", "run", "rename"})

OPEN = "open"
CLOSED_STATUSES = frozenset({"accepted", "rejected", "withdrawn", "expired", "invalidated"})

COST_NOTE = ("Amounts are list prices from each vendor's pricing page, not a quote. "
             "Paid runs bill your provider account.")


class ProposalError(Exception):
    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


# -- the request ------------------------------------------------------------

@dataclass(frozen=True)
class ProposedNode:
    ref: str
    definition_id: str
    params: dict[str, Any]
    position: dict[str, float] | None


@dataclass(frozen=True)
class ProposedEdge:
    source: str
    source_handle: str
    target: str
    target_handle: str

    def as_dict(self) -> dict[str, str]:
        return {
            "source": self.source,
            "sourceHandle": self.source_handle,
            "target": self.target,
            "targetHandle": self.target_handle,
        }


@dataclass(frozen=True)
class ParamChange:
    node_id: str
    params: dict[str, Any]


@dataclass(frozen=True)
class ProposalSpec:
    note: str
    nodes: tuple[ProposedNode, ...] = ()
    edges: tuple[ProposedEdge, ...] = ()
    params: tuple[ParamChange, ...] = ()
    run: tuple[str, ...] = ()
    # Names for this proposal's own new nodes: (+ref, name). Accepting applies them.
    rename: tuple[tuple[str, str], ...] = ()

    @property
    def names(self) -> dict[str, str]:
        return dict(self.rename)

    @property
    def refs(self) -> set[str]:
        return {node.ref for node in self.nodes}

    @property
    def references(self) -> set[str]:
        """Existing node ids this proposal depends on."""
        found: set[str] = {change.node_id for change in self.params}
        for edge in self.edges:
            found.update(end for end in (edge.source, edge.target) if not end.startswith("+"))
        found.update(item for item in self.run if not item.startswith("+"))
        return found


def clean_note(raw: Any, *, limit: int = MAX_NOTE, label: str = "note") -> str:
    try:
        return clean_text(raw, limit=limit, label=label)
    except PinError as exc:
        raise ProposalError(422, exc.detail) from exc


def _placeable(value: Any) -> bool:
    """A number position takes: finite and under COORD_LIMIT (an int past float's range isn't)."""
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        number = float(value)
    except OverflowError:
        return False
    return number == number and abs(number) < COORD_LIMIT


def _point(raw: Any, label: str) -> dict[str, float]:
    if not isinstance(raw, Mapping):
        raise ProposalError(422, f"{label} must be an object with x and y")
    result: dict[str, float] = {}
    for axis in ("x", "y"):
        value = raw.get(axis)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ProposalError(422, f"{label}.{axis} must be a number")
        if not _placeable(value):
            raise ProposalError(422, f"{label}.{axis} must be a finite canvas coordinate")
        result[axis] = round(float(value), 2)
    return result


def _list(body: Mapping[str, Any], key: str, cap: int | None) -> list[Any]:
    value = body.get(key)
    if value is None:
        return []
    if not isinstance(value, list):
        raise ProposalError(422, f"{key} must be a list")
    if cap is not None and len(value) > cap:
        raise ProposalError(422, f"a proposal can have at most {cap} {key}")
    return value


def _end(raw: Any, refs: set[str], label: str) -> str:
    """An edge or run endpoint: a temporary ref from this proposal or an existing node id."""
    if not isinstance(raw, str):
        raise ProposalError(422, f"{label} must be a node id (n4) or a ref (+up)")
    if raw.startswith("+"):
        if raw not in refs:
            raise ProposalError(400, f"{label} '{raw[:30]}' is not one of this proposal's new nodes")
        return raw
    if not NODE_ID_RE.fullmatch(raw):
        raise ProposalError(422, f"{label} must be a node id (n4) or a ref (+up)")
    return raw


# A wire end's ports, for the line a missing port gets: called with the end
# (a node id, or a ref of this request), the ref's definition id (None for a
# node id) and "outputPorts" or "inputPorts"; it gives (definition id, port
# ids), or None when it can't tell. main passes one that reads the canvas.
PortLookup = Callable[[str, "str | None", str], "tuple[str, list[str]] | None"]
HINT_PORTS = 12


def _handle(raw: Any, label: str, ports: PortLookup | None = None, end: str = "",
            definitions: Mapping[str, str] | None = None, kind: str = "") -> str:
    if not isinstance(raw, str) or not raw.strip() or len(raw) > MAX_HANDLE:
        raise ProposalError(422, f"{label} must be a port id{_ports_hint(ports, end, definitions or {}, kind)}")
    return raw


def _ports_hint(ports: PortLookup | None, end: str, definitions: Mapping[str, str], kind: str) -> str:
    """". Valid outputPorts on +mb (nebula-moodboard): ['moodboard']", as a wrong port name's error says."""
    found = ports(end, definitions.get(end), kind) if ports and end else None
    if not found:
        return ""
    definition_id, ids = found
    more = f" and {len(ids) - HINT_PORTS} more" if len(ids) > HINT_PORTS else ""
    return f". Valid {kind} on {end} ({_short(definition_id, 128)}): {ids[:HINT_PORTS] or '(none)'}{more}"


# Shapes agents guess for a node's type and a wire's ends (the PR26
# measurement's runs sent `type` and `from`/`to`): the error names the right
# field and, when it can, gives the agent's own node or wire rewritten.
_DEFINITION_ALIASES = ("type", "definition", "kind", "definition_id", "definitionID", "nodeType", "node_type",
                       "model")
_EDGE_KEYS = ("source", "sourceHandle", "target", "targetHandle")
_EDGE_ALIASES = {
    "source": ("from", "sourceId", "source_id", "fromNode"),
    "sourceHandle": ("sourcePort", "source_handle", "fromPort", "fromHandle", "sourceOutput", "output"),
    "target": ("to", "targetId", "target_id", "toNode"),
    "targetHandle": ("targetPort", "target_handle", "toPort", "toHandle", "targetInput", "input"),
}
WIRE_SHAPE = "{source, sourceHandle, target, targetHandle}"
# The hints copy the agent's node back, but stay one short line whatever it
# holds (a data URL in a param, a 50,000-character type).
HINT_PARAMS = 8
HINT_VALUE_CHARS = 40


def _short(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


_NODE_KEYS = frozenset({"ref", "definitionId", "params", "position"})
_NAME_KEYS = ("name", "label", "title")


def _node_field_error(index: int, raw: Mapping[str, Any]) -> str | None:
    """A node field parse_spec doesn't take, in one line saying where it goes
    (E1 and E2 sent "x": 0, which was dropped without a word)."""
    unknown = sorted(str(key) for key in raw if key not in _NODE_KEYS)
    if not unknown:
        return None
    if "x" in raw or "y" in raw:
        # The agent's numbers only when position would take them (finite, under COORD_LIMIT).
        point = {axis: raw[axis] for axis in ("x", "y") if _placeable(raw.get(axis))}
        shown = json.dumps(point) if len(point) == 2 else '{"x": ..., "y": ...}'
        return (f"nodes[{index}] puts its place in position {shown}, not x and y "
                "(or leave it out: new nodes are placed for you)")
    name_key = next((key for key in _NAME_KEYS if key in raw), None)
    if name_key is not None:
        ref = _short(str(raw.get("ref")), 30)
        name = raw[name_key]
        shown = json.dumps(_short(name, 60)) if isinstance(name, str) else '"..."'
        return f'nodes[{index}] is named with rename={{"{ref}": {shown}}}, not {name_key}'
    return (f"nodes[{index}] has unknown field '{_short(unknown[0], 40)}': "
            "a node is {ref, definitionId, params, position}")


def _definition_hint(raw: Mapping[str, Any]) -> str:
    """After "nodes[i].definitionId must be a node definition id": where the agent put it instead."""
    alias = next((key for key in _DEFINITION_ALIASES if isinstance(raw.get(key), str) and raw.get(key)), None)
    ref = _short(raw["ref"], 30) if isinstance(raw.get("ref"), str) else "+img"
    if alias is None:
        return f': a node is {{"ref": "{ref}", "definitionId": "nano-banana", "params": {{...}}}}'
    example: dict[str, Any] = {"ref": ref, "definitionId": _short(raw[alias], 128)}
    params = raw.get("params")
    more = ""
    if isinstance(params, dict) and params:
        # Short values as sent, the rest as "...", and at most HINT_PARAMS keys.
        example["params"] = {
            _short(str(key), HINT_VALUE_CHARS):
                value if len(json.dumps(value, ensure_ascii=False, default=str)) <= HINT_VALUE_CHARS else "..."
            for key, value in list(params.items())[:HINT_PARAMS]}
        if len(params) > HINT_PARAMS:
            more = f" (and {len(params) - HINT_PARAMS} more params)"
    return f"; the node type goes in definitionId, not {alias}: {json.dumps(example, ensure_ascii=False)}{more}"


def wire_shape_error(raw: Mapping[str, Any], label: str) -> str | None:
    """A wire written with other keys (from/to, sourcePort/targetPort), in one
    line naming the four fields, with the agent's own wire rewritten when its
    ends can be read ("+mb.moodboard" or "+mb:moodboard" is node and port).
    None when the wire has all four fields or none of those other keys
    (then the field's own error says what is wrong)."""
    if all(key in raw for key in _EDGE_KEYS):
        return None
    aliases = {alias for options in _EDGE_ALIASES.values() for alias in options}
    others = [str(key) for key in raw if key in aliases]
    if not others:
        return None
    ends: dict[str, Any] = {}
    for node_key, handle_key in (("source", "sourceHandle"), ("target", "targetHandle")):
        node = next((raw[key] for key in (node_key, *_EDGE_ALIASES[node_key]) if isinstance(raw.get(key), str)), None)
        handle = next((raw[key] for key in (handle_key, *_EDGE_ALIASES[handle_key])
                       if isinstance(raw.get(key), str)), None)
        if node and handle is None and re.search(r"[.:]", node):
            node, handle = re.split(r"[.:]", node, maxsplit=1)
        ends[node_key], ends[handle_key] = node, handle
    message = f"{label} is a wire {WIRE_SHAPE}, not {'/'.join(others)}"
    # Rewritten only when every end is short enough to be a real one.
    if all(isinstance(ends[key], str) and ends[key] and len(ends[key]) <= MAX_HANDLE for key in _EDGE_KEYS):
        message += ": " + json.dumps({key: ends[key] for key in _EDGE_KEYS}, ensure_ascii=False)
    return message


def _params(raw: Any, label: str, internal_ok: frozenset[str] = frozenset()) -> dict[str, Any]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ProposalError(422, f"{label} must be an object")
    for key in raw:
        if not isinstance(key, str) or not key:
            raise ProposalError(422, f"{label} keys must be text")
        # Underscore keys are the editor's own bookkeeping (_previewUrl, ...).
        if key.startswith("_") and key not in internal_ok:
            raise ProposalError(422, internal_refusal(label, key))
    return dict(raw)


def parse_spec(body: Any, *, internal_ok: frozenset[str] = frozenset(), capped: bool = True,
               ports: PortLookup | None = None) -> ProposalSpec:
    """Shape-check and sanitise a proposal body. Graph validation happens in main.

    `internal_ok` names underscore params a caller may set anyway: proposals
    and direct edits name `_provider` and `_kreaAuth`, who bills a run
    (node_route.BILLING_PARAMS). Only a proposal may change them; direct
    edits from agents that would are refused.

    `capped` applies the per-proposal caps (MAX_NODES, MAX_EDGES,
    MAX_PARAM_NODES, MAX_RUN). The person reviews a proposal item by item, so
    it stays small. A direct edit (services/canvas_edits.py) passes False: it
    is bounded only by the canvas's own size limits, which main checks on the
    staged graph.

    `ports` (PortLookup) lets a wire with no port name the ports its end has."""
    if not isinstance(body, dict):
        raise ProposalError(422, "the proposal must be a JSON object")
    unknown = sorted(set(body) - _ALLOWED_KEYS)
    if unknown:
        raise ProposalError(422, f"unknown proposal field '{str(unknown[0])[:40]}'")
    note = clean_note(body.get("note"))

    nodes: list[ProposedNode] = []
    refs: set[str] = set()
    definitions: dict[str, str] = {}
    for index, raw in enumerate(_list(body, "nodes", MAX_NODES if capped else None)):
        if not isinstance(raw, dict):
            raise ProposalError(422, f"nodes[{index}] must be an object")
        ref = raw.get("ref")
        if not isinstance(ref, str) or not REF_RE.fullmatch(ref):
            raise ProposalError(422, f"nodes[{index}].ref must look like +up (letters, digits, - or _): a node is "
                                     '{"ref": "+up", "definitionId": "...", "params": {...}}')
        if ref in refs:
            raise ProposalError(400, f"duplicate ref '{ref}'")
        refs.add(ref)
        definition_id = raw.get("definitionId")
        if not isinstance(definition_id, str) or not definition_id or len(definition_id) > 128:
            raise ProposalError(422, f"nodes[{index}].definitionId must be a node definition id{_definition_hint(raw)}")
        field_error = _node_field_error(index, raw)
        if field_error:
            raise ProposalError(422, field_error)
        definitions[ref] = definition_id
        position = raw.get("position")
        nodes.append(ProposedNode(
            ref=ref,
            definition_id=definition_id,
            params=_params(raw.get("params"), f"nodes[{index}].params", internal_ok),
            position=_point(position, f"nodes[{index}].position") if position is not None else None,
        ))

    edges: list[ProposedEdge] = []
    for index, raw in enumerate(_list(body, "edges", MAX_EDGES if capped else None)):
        if not isinstance(raw, dict):
            raise ProposalError(422, f"edges[{index}] must be an object")
        shape = wire_shape_error(raw, f"edges[{index}]")
        if shape:
            raise ProposalError(422, shape)
        source = _end(raw.get("source"), refs, f"edges[{index}].source")
        source_handle = _handle(raw.get("sourceHandle"), f"edges[{index}].sourceHandle", ports, source, definitions,
                                "outputPorts")
        target = _end(raw.get("target"), refs, f"edges[{index}].target")
        target_handle = _handle(raw.get("targetHandle"), f"edges[{index}].targetHandle", ports, target, definitions,
                                "inputPorts")
        edges.append(ProposedEdge(source=source, source_handle=source_handle, target=target,
                                  target_handle=target_handle))

    changes: list[ParamChange] = []
    seen_nodes: set[str] = set()
    for index, raw in enumerate(_list(body, "params", MAX_PARAM_NODES if capped else None)):
        if not isinstance(raw, dict):
            raise ProposalError(422, f"params[{index}] must be an object")
        node_id = raw.get("nodeId")
        if not isinstance(node_id, str) or not NODE_ID_RE.fullmatch(node_id):
            raise ProposalError(422, f"params[{index}].nodeId must be an existing node id like n4")
        if node_id in seen_nodes:
            raise ProposalError(400, f"params lists {node_id} twice; merge the changes")
        seen_nodes.add(node_id)
        params = _params(raw.get("params"), f"params[{index}].params", internal_ok)
        if not params:
            raise ProposalError(422, f"params[{index}].params must set at least one key")
        changes.append(ParamChange(node_id=node_id, params=params))

    run: list[str] = []
    for index, raw in enumerate(_list(body, "run", MAX_RUN if capped else None)):
        item = _end(raw, refs, f"run[{index}]")
        if item in run:
            raise ProposalError(400, f"run lists '{item}' twice")
        run.append(item)

    names = _names(body.get("rename"), refs)

    if not (nodes or edges or changes or run):
        raise ProposalError(422, "a proposal needs at least one node, wire, param change or run")
    return ProposalSpec(note=note, nodes=tuple(nodes), edges=tuple(edges), params=tuple(changes), run=tuple(run),
                        rename=tuple(names.items()))


def _names(raw: Any, refs: set[str]) -> dict[str, str]:
    """`rename` names the proposal's own new nodes ({"+g": "Lake hero"}).
    Renaming a node already on the canvas isn't something the person needs to
    decide, so it stays a direct edit (edit_canvas, `nebula rename`)."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ProposalError(422, 'rename must be an object of {"+ref": "name"} for this proposal\'s new nodes')
    names: dict[str, str] = {}
    for key, value in raw.items():
        if isinstance(key, str) and NODE_ID_RE.fullmatch(key):
            raise ProposalError(422, f"{RENAME_EXISTING}; a proposal names only the nodes it adds ({key} is on "
                                     "the canvas already)")
        if not isinstance(key, str) or key not in refs:
            raise ProposalError(400, f"rename names '{str(key)[:30]}', which is not one of this proposal's new nodes")
        names[key] = clean_note(value, limit=MAX_NAME, label=f"rename.{key}")
    return names


def clean_positions(raw: Any, refs: Iterable[str]) -> dict[str, dict[str, float]]:
    """Positions the person dragged ghosts to: {ref: {x, y}}, refs from this proposal only."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ProposalError(422, "positions must be an object of {ref: {x, y}}")
    allowed = set(refs)
    result: dict[str, dict[str, float]] = {}
    for ref, point in raw.items():
        if ref not in allowed:
            raise ProposalError(422, f"positions names '{str(ref)[:30]}', which is not a new node in this proposal")
        result[ref] = _point(point, f"positions.{ref}")
    return result


# -- cost (never a number) ----------------------------------------------------

def cost_for(
    definition: Mapping[str, Any] | None,
    params: Mapping[str, Any] | None = None,
    definitions: Mapping[str, Mapping[str, Any]] | None = None,
    api_keys: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """`free` for local utility nodes, else `paid` with the provider. No prices exist.

    A cinema scene is a utility node that calls its base image model once per
    shot, so it is paid, by that model's provider. A utility node whose
    ``providerVia`` param picks provider work (a QC node in vision-llm or jev
    mode) is paid too, by the provider that value calls (``byValue``), and
    priced only when its own entry has a row for that value (jev).

    A route-table node is paid by the provider of the route it would take
    (node_route.select_route with ``api_keys``); when that route can't run,
    ``provider`` is None, ``unavailable`` says why and, for a setting the
    route doesn't offer, ``fixes`` lists route_unavailable's one-click
    param edits ([{param, value}], value None = clear). Without ``api_keys``
    it names the explicit route's provider, or under Auto the maker's."""
    from services import model_pricing, node_readiness, node_route

    if definition and node_route.has_routes(definition):
        if api_keys is not None:
            route = node_route.select_route(definition, params, api_keys)
            if route.kind == node_route.UNSET:
                why = node_route.route_unavailable(definition, params, api_keys) or {}
                # A stop on a setting the route doesn't offer can be fixed in
                # place: route_unavailable's one-click param edits.
                return {"kind": "paid", "provider": None, "label": "paid · can't run as set",
                        "unavailable": str(why.get("message") or ""),
                        **({"fixes": list(why["fixes"])} if why.get("fixes") else {})}
            routed = str(route.provider or "") or None
        else:
            choice = node_route.provider_choice(params)
            spec = (node_route.route_by_id(definition, choice) if choice != node_route.AUTO
                    else node_route.maker_route(definition) or next(iter(node_route.routes_of(definition)), None))
            routed = str((spec or {}).get("provider") or "") or None
        return {"kind": "paid", "provider": routed, "label": f"paid · {routed or 'provider'}"}

    if (definition or {}).get("id") == model_pricing.CINEMA_SCENE:
        nested = model_pricing.cinema_scene_base(params or {})
        base = (definitions or {}).get(nested[0]) if nested else None
        provider = str((base or {}).get("apiProvider") or "") or None
        return {"kind": "paid", "provider": provider, "label": f"paid · {provider or 'provider'}, per shot"}
    provider = str((definition or {}).get("apiProvider") or "") or None
    if provider == "utility" and not model_pricing.is_local(definition or {}, params or {}):
        via = node_readiness.provider_via(definition or {}) or {}
        _keys, what = node_readiness.param_route(via, node_readiness.param_value(definition or {}, params or {}))
        try:
            entry = (model_pricing.load_pricing().get("nodes") or {}).get(str((definition or {}).get("id") or ""))
        except (OSError, ValueError):
            entry = None
        priced = model_pricing.estimate_node(entry, definition or {}, params or {}) is not None
        return {"kind": "paid", "provider": what,
                "label": f"paid · {what} model{'' if priced else ', no list price'}"}
    if provider == "utility":
        return {"kind": "free", "provider": None, "label": "free · runs locally"}
    return {"kind": "paid", "provider": provider, "label": f"paid · {provider or 'provider'}"}


def summarize_cost(
    entries: list[dict[str, Any]], *, up_to: bool, estimate: dict[str, Any] | None = None,
    not_ready: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """The proposal's run set: each entry is {ref, nodeId, kind, provider, label, price},
    plus `missing` when that node can't run here as set up.

    ``estimate`` is ``model_pricing.estimate_run`` output keyed by the same
    refs; it becomes {currency, low, high, open, unpriced, plan, plus}, or
    None when no node in the run has a list price. ``not_ready`` lists every
    node the run reads that can't run here, cached ancestors included
    ([{ref, nodeId, name, missing}], main._not_ready_nodes), read when the
    proposal was made."""
    paid = sum(1 for entry in entries if entry.get("kind") == "paid")
    providers = sorted({str(entry["provider"]) for entry in entries if entry.get("kind") == "paid" and entry.get("provider")})
    summary_estimate = None
    if estimate and estimate.get("high") is not None:
        summary_estimate = {
            "currency": estimate.get("currency", "usd"),
            "low": estimate["low"],
            "high": estimate["high"],
            "open": bool(estimate.get("unpriced") or estimate.get("plus")),
            "unpriced": list(estimate.get("unpriced") or []),
            "plan": list(estimate.get("plan") or []),
            "plus": list(estimate.get("plus") or []),
        }
        if estimate.get("awaitingInput"):
            # Priced from their input's size, which isn't known until it exists.
            summary_estimate["awaitingInput"] = list(estimate["awaitingInput"])
    return {
        "paidRuns": paid,
        "freeRuns": len(entries) - paid,
        "estimate": summary_estimate,
        "upTo": up_to,
        "providers": providers,
        "nodes": entries,
        "notReady": list(not_ready or []),
        "note": COST_NOTE,
    }


# Where each surface's agent finds a node that runs here. The HTTP answer
# names the route; propose_change (MCP) and `nebula propose` (CLI) word the
# warning again from cost.notReady for their own reader (agent_wording). The CLI names
# `nebula nodes`, find_nodes' twin on the same route: by default it lists only
# what runs here, and `nebula context`'s list is cut at its budget.
READY_NODES_HTTP = "GET /api/agent/nodes"
READY_NODES_MCP = "find_nodes"
READY_NODES_CLI = "`nebula nodes`"

# How each surface's agent withdraws a proposal ({id} is the proposal's id).
# A proposal that can't run here is kept with its warning (Justin, Q109: "Keep
# it with the warning, and tell the agent to withdraw it before proposing
# something else"), so the warning and the reminder name the exact call.
WITHDRAW_HTTP = "DELETE /api/canvas/proposals/{id}"
WITHDRAW_MCP = 'withdraw_proposal(proposal_id="{id}")'
WITHDRAW_CLI = "nebula proposal withdraw {id}"


def cli_withdraw_form(agent_name: str | None) -> str:
    """WITHDRAW_CLI, with `--as <name>` when the agent named itself that way
    (withdrawing needs the same name the proposal was made under)."""
    if not agent_name:
        return WITHDRAW_CLI
    import shlex

    return f"{WITHDRAW_CLI} --as {shlex.quote(agent_name)}"


def withdraw_call(proposal_id: str, form: str = WITHDRAW_HTTP) -> str:
    return form.replace("{id}", proposal_id)


def readiness_warning(cost: Mapping[str, Any], *, lister: str = READY_NODES_HTTP,
                      proposal_id: str | None = None, withdraw: str = WITHDRAW_HTTP) -> str | None:
    """One paragraph for the agent naming the run's nodes that can't run here, or None.

    propose_change and `nebula propose` show it, so the agent can tell the
    person what to set up, or propose a model that runs here, before Accept.
    ``lister`` is what lists the nodes that run here on the caller's surface;
    with ``proposal_id`` it ends with the call (``withdraw``, the caller's
    surface) that takes this proposal back before the agent proposes
    something else, so the person isn't left two to answer."""
    rows = [row for row in cost.get("notReady") or [] if isinstance(row, Mapping)]
    if not rows:
        return None
    lines = []
    for row in rows[:6]:
        label = str(row.get("ref") or row.get("nodeId") or "?")
        # Route messages end in their own period; the join below adds the punctuation.
        need = str(row.get("missing") or "can't run here").rstrip().rstrip(".")
        name = str(row.get("name") or "")
        # Route messages already start with the node's name.
        lines.append(f"{label}: {need}" if name and need.startswith(name) else f"{label} ({name}) {need}")
    more = f" and {len(rows) - 6} more" if len(rows) > 6 else ""
    count = f"{len(rows)} node{'s' if len(rows) != 1 else ''}"
    then = (f" If you propose something else instead, withdraw this one first: "
            f"`{withdraw_call(proposal_id, withdraw)}`." if proposal_id else "")
    return (f"If the person accepts, the run fails: {count} can't run here as set up. "
            f"{'; '.join(lines)}{more}. Tell the person what to set up, or propose a node that runs here "
            f"({lister} lists them).{then}")


def still_open_reminder(rows: Iterable[Mapping[str, Any]], *, withdraw: str = WITHDRAW_HTTP) -> str | None:
    """The line a new proposal's answer carries when the same agent still has
    an open proposal here that can't run (ProposalBook.open_unrunnable)."""
    lines = [f"Your proposal {row['id']} is still open and can't run here; withdraw it if this one replaces it: "
             f"`{withdraw_call(str(row['id']), withdraw)}`." for row in rows]
    return " ".join(lines) or None


def agent_wording(response: Mapping[str, Any], *, lister: str = READY_NODES_HTTP,
                  withdraw: str = WITHDRAW_HTTP) -> dict[str, Any]:
    """A propose answer's agent lines in one surface's words: `warning` and
    `withdrawWith` for this proposal, `stillOpen` and `reminder` for the
    agent's other open proposals that can't run. main words them for HTTP;
    propose_change and `nebula propose` again for their own reader."""
    out = dict(response)
    view = out.get("proposal") if isinstance(out.get("proposal"), Mapping) else {}
    proposal_id = str(view.get("id") or "") or None
    warning = readiness_warning(view.get("cost") or {}, lister=lister, proposal_id=proposal_id, withdraw=withdraw)
    out.pop("withdrawWith", None)
    if warning:
        out["warning"] = warning
        if proposal_id:
            out["withdrawWith"] = withdraw_call(proposal_id, withdraw)
    # A warning the cost can't word again (an older backend) is kept as sent.
    rows = [row for row in out.pop("stillOpen", None) or [] if isinstance(row, Mapping) and row.get("id")]
    out.pop("reminder", None)
    if rows:
        out["stillOpen"] = [{**row, "withdrawWith": withdraw_call(str(row["id"]), withdraw)} for row in rows]
        out["reminder"] = still_open_reminder(rows, withdraw=withdraw)
    return out


# -- placement ----------------------------------------------------------------

GHOST_STEP_X = 380.0
GHOST_STEP_Y = 260.0
GHOST_WIDTH = 240.0
GHOST_HEIGHT = 200.0
DEFAULT_NODE_WIDTH = 300.0
DEFAULT_NODE_HEIGHT = 220.0
PLACEMENT_GAP = 60.0
MAX_PLACEMENT_STEPS = 40


def _box(node: Mapping[str, Any]) -> tuple[float, float, float, float]:
    x = float(node.get("x", 0.0))
    y = float(node.get("y", 0.0))
    return (x, y, x + float(node.get("width") or DEFAULT_NODE_WIDTH), y + float(node.get("height") or DEFAULT_NODE_HEIGHT))


def _overlaps(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def place_new_nodes(
    spec: ProposalSpec,
    known: Mapping[str, Mapping[str, Any]],
    visible_area: Mapping[str, float] | None = None,
) -> dict[str, dict[str, float]]:
    """A position for every new node: its own, else right of the rightmost referenced node.

    `known` maps existing node ids to {x, y, width?, height?} (the browser's
    report, or the stored position). With no referenced node on record,
    ghosts stack in the centre of what the person is looking at, else around
    (0, 0). A ghost that would land on a real node (or another ghost) moves
    right until it is clear, so ghosts never hide the person's nodes.
    """
    placed: dict[str, dict[str, float]] = {}
    anchors = [known[node_id] for node_id in spec.references if node_id in known]
    if anchors:
        right = max(anchors, key=lambda node: _box(node)[2])
        base_x = max(_box(right)[2] + PLACEMENT_GAP + 20.0, float(right.get("x", 0.0)) + GHOST_STEP_X)
        base_y = float(right.get("y", 0.0))
    elif visible_area:
        base_x = float(visible_area.get("x", 0.0)) + float(visible_area.get("width", 0.0)) / 2 - GHOST_WIDTH / 2
        base_y = float(visible_area.get("y", 0.0)) + float(visible_area.get("height", 0.0)) / 2 - GHOST_HEIGHT / 2
    else:
        base_x, base_y = 0.0, 0.0
    taken = [_box(node) for node in known.values()]
    for node in spec.nodes:
        if node.position is not None:
            placed[node.ref] = dict(node.position)
            taken.append(_box({**node.position, "width": GHOST_WIDTH, "height": GHOST_HEIGHT}))
    index = 0
    for node in spec.nodes:
        if node.ref in placed:
            continue
        x, y = base_x, base_y + index * GHOST_STEP_Y
        for _ in range(MAX_PLACEMENT_STEPS):
            box = (x, y, x + GHOST_WIDTH, y + GHOST_HEIGHT)
            hit = next((other for other in taken if _overlaps(box, other)), None)
            if hit is None:
                break
            x = hit[2] + PLACEMENT_GAP
        placed[node.ref] = {"x": round(x, 2), "y": round(y, 2)}
        taken.append((x, y, x + GHOST_WIDTH, y + GHOST_HEIGHT))
        index += 1
    return placed


# -- stored proposals -----------------------------------------------------------

@dataclass
class Proposal:
    id: str
    agent: AgentIdentity
    project_id: str | None
    spec: ProposalSpec
    positions: dict[str, dict[str, float]]
    created_at: float
    expires_at: float
    cost: dict[str, Any]
    # What the existing nodes looked like at submit time, for the view.
    existing: dict[str, dict[str, Any]] = field(default_factory=dict)
    # What the listed runs would start, per node (new nodes by ref), at submit
    # time. Accept refuses when the live graph would run anything else.
    run_fingerprint: dict[str, str] = field(default_factory=dict)
    status: str = OPEN
    reason: str | None = None
    # Only ever sent to browser sockets; never in view(), REST, journal or logs.
    accept_key: str = field(default_factory=lambda: secrets.token_urlsafe(24), repr=False)
    id_map: dict[str, str] | None = None
    run_node_ids: list[str] | None = None
    closed_at: float | None = None

    @property
    def references(self) -> set[str]:
        return self.spec.references

    @property
    def is_open(self) -> bool:
        return self.status == OPEN


def person_value(value: Any, *, key: str = "", depth: int = 0) -> Any:
    """A proposed value as the person should see it before approving it.

    Unlike the agent-facing sanitizer this keeps URLs whole and shows text up
    to PERSON_VALUE_CHARS, marking anything longer. Data URIs are described
    by size, and secret-looking keys only say that a value is set.
    """
    if _SECRET_KEY_RE.search(key) and value not in (None, ""):
        return "<secret value set>"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    if isinstance(value, str):
        if value.lstrip().lower().startswith("data:"):
            return f"<inline file data, {len(value)} characters>"
        if len(value) > PERSON_VALUE_CHARS:
            return f"{value[:PERSON_VALUE_CHARS]}… <{len(value) - PERSON_VALUE_CHARS} more characters not shown>"
        return value
    if depth >= 4:
        return "<nested value>"
    if isinstance(value, Mapping):
        return {str(k): person_value(v, key=str(k), depth=depth + 1) for k, v in list(value.items())[:50]}
    if isinstance(value, (list, tuple)):
        return [person_value(item, key=key, depth=depth + 1) for item in list(value)[:50]]
    return str(value)[:200]


def cant_run(proposal: Proposal) -> int:
    """How many of the proposal's run nodes can't run here (cost.notReady, read when it was made)."""
    return sum(1 for row in (proposal.cost or {}).get("notReady") or [] if isinstance(row, Mapping))


def new_proposal_id() -> str:
    return "p_" + secrets.token_hex(4)


class ProposalBook:
    """Open proposals plus recently decided ones (readable for 30 minutes, at most 50)."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._items: OrderedDict[str, Proposal] = OrderedDict()

    def now(self) -> float:
        return self._clock()

    def create(
        self,
        *,
        agent: AgentIdentity,
        project_id: str | None,
        spec: ProposalSpec,
        positions: dict[str, dict[str, float]],
        cost: dict[str, Any],
        existing: dict[str, dict[str, Any]] | None = None,
        run_fingerprint: dict[str, str] | None = None,
    ) -> Proposal:
        """Build and open a proposal (enforcing the open caps)."""
        now = self._clock()
        proposal = Proposal(
            id=new_proposal_id(),
            agent=agent,
            project_id=project_id,
            spec=spec,
            positions=copy.deepcopy(positions),
            created_at=now,
            expires_at=now + PROPOSAL_TTL_SECONDS,
            cost=cost,
            existing=copy.deepcopy(existing or {}),
            run_fingerprint=dict(run_fingerprint or {}),
        )
        self.open(proposal)
        return proposal

    def open(self, proposal: Proposal) -> None:
        open_now = self.open_list()
        mine = [p for p in open_now if p.agent.id == proposal.agent.id]
        if len(mine) >= MAX_OPEN_PER_AGENT:
            raise ProposalError(
                429,
                f"You already have {len(mine)} open proposals; withdraw or wait for one to be decided.",
            )
        if len(open_now) >= MAX_OPEN_TOTAL:
            raise ProposalError(429, "Too many proposals are waiting for the person; withdraw or wait for one to be decided.")
        while proposal.id in self._items:  # vanishingly unlikely, but ids must be unique
            proposal.id = new_proposal_id()
        self._items[proposal.id] = proposal

    def get(self, proposal_id: str) -> Proposal | None:
        return self._items.get(proposal_id)

    def open_list(self) -> list[Proposal]:
        return [p for p in self._items.values() if p.is_open]

    def open_unrunnable(self, proposal: Proposal) -> list[Proposal]:
        """The same agent's other open proposals on this canvas (project) whose
        run can't run here, as read when each was made (cost.notReady). Another
        agent's proposals, and ones that can run, are not this agent's to withdraw."""
        return [p for p in self.open_list()
                if p.id != proposal.id and p.agent.id == proposal.agent.id
                and p.project_id == proposal.project_id and cant_run(p)]

    def close(
        self,
        proposal_id: str,
        status: str,
        reason: str | None = None,
        id_map: dict[str, str] | None = None,
        run_node_ids: list[str] | None = None,
    ) -> Proposal:
        if status not in CLOSED_STATUSES:
            raise ValueError(f"unknown proposal status '{status}'")
        proposal = self._items.get(proposal_id)
        if proposal is None:
            raise ProposalError(404, f"No proposal {proposal_id[:20]}")
        if not proposal.is_open:
            raise ProposalError(409, f"Proposal {proposal_id} is already {proposal.status}")
        proposal.status = status
        proposal.reason = reason
        proposal.id_map = dict(id_map) if id_map else None
        proposal.run_node_ids = list(run_node_ids) if run_node_ids else None
        proposal.closed_at = self._clock()
        self._prune()
        return proposal

    def sweep(self) -> list[Proposal]:
        """Expire open proposals past their TTL. Returns the ones that just expired."""
        now = self._clock()
        expired: list[Proposal] = []
        for proposal in self.open_list():
            if proposal.expires_at <= now:
                proposal.status = "expired"
                proposal.reason = "nobody decided within 15 minutes"
                proposal.closed_at = now
                expired.append(proposal)
        self._prune()
        return expired

    def invalidate_referencing(self, node_id: str, reason: str) -> list[Proposal]:
        hit = [p for p in self.open_list() if node_id in p.references]
        for proposal in hit:
            self.close(proposal.id, "invalidated", reason=reason)
        return hit

    def invalidate_all(self, reason: str) -> list[Proposal]:
        hit = self.open_list()
        for proposal in hit:
            self.close(proposal.id, "invalidated", reason=reason)
        return hit

    def _prune(self) -> None:
        now = self._clock()
        closed = [p for p in self._items.values() if not p.is_open]
        for proposal in closed:
            if proposal.closed_at is not None and now - proposal.closed_at > CLOSED_KEEP_SECONDS:
                self._items.pop(proposal.id, None)
        closed = [p for p in self._items.values() if not p.is_open]
        for proposal in closed[: max(0, len(closed) - MAX_CLOSED)]:
            self._items.pop(proposal.id, None)

    # -- what agents and the canvas see (never the accept key) ---------------
    def view(self, proposal: Proposal, *, registry: Any) -> dict[str, Any]:
        definitions = registry.get_all() if registry is not None else {}
        spec = proposal.spec
        node_costs = {entry.get("ref"): entry for entry in proposal.cost.get("nodes", [])}
        nodes: list[dict[str, Any]] = []
        names = spec.names
        for node in spec.nodes:
            definition = definitions.get(node.definition_id, {}) if isinstance(definitions, dict) else {}
            model = str(definition.get("displayName") or node.definition_id)
            nodes.append({
                "ref": node.ref,
                "definitionId": node.definition_id,
                # The name the proposal gives it (accepting applies it), else the model's.
                "name": names.get(node.ref) or model,
                **({"model": model} if names.get(node.ref) else {}),
                "category": str(definition.get("category") or ""),
                "params": safe_value(node.params, key="params"),
                "position": dict(proposal.positions.get(node.ref) or node.position or {"x": 0.0, "y": 0.0}),
                "cost": cost_for(definition, node.params, definitions if isinstance(definitions, dict) else None),
                "runs": node.ref in spec.run,
                "willRun": node.ref in node_costs,
                "ports": _ports_for(node.ref, definition, spec.edges),
            })
        params: list[dict[str, Any]] = []
        for change in spec.params:
            before = (proposal.existing.get(change.node_id) or {}).get("params") or {}
            params.append({
                "nodeId": change.node_id,
                "name": (proposal.existing.get(change.node_id) or {}).get("name") or change.node_id,
                "changes": {
                    key: {
                        "from": safe_value(before.get(key), key=key),
                        "to": safe_value(value, key=key),
                    }
                    for key, value in change.params.items()
                },
            })
        return {
            "id": proposal.id,
            "status": proposal.status,
            "agent": proposal.agent.as_dict(),
            "note": spec.note,
            "projectId": proposal.project_id,
            "createdAt": int(proposal.created_at * 1000),
            "expiresAt": int(proposal.expires_at * 1000),
            "nodes": nodes,
            "edges": [edge.as_dict() for edge in spec.edges],
            "params": params,
            "run": list(spec.run),
            "cost": copy.deepcopy(proposal.cost),
            "references": sorted(proposal.references, key=_node_sort_key),
            "reason": proposal.reason,
            "idMap": dict(proposal.id_map) if proposal.id_map else None,
            "runNodeIds": list(proposal.run_node_ids) if proposal.run_node_ids else None,
        }

    def person_values(self, proposal: Proposal) -> dict[str, Any]:
        """The values Accept will apply, for the person's canvas only.

        view() uses the agent-facing sanitizer, which cuts text at 500
        characters and drops URL queries. The person approves with one
        click, so the bar needs what will really be written. This goes only
        into the browser-only proposalOpened/proposalSync messages.
        """
        nodes = {node.ref: {key: person_value(value, key=key) for key, value in node.params.items()}
                 for node in proposal.spec.nodes}
        params: dict[str, dict[str, Any]] = {}
        for change in proposal.spec.params:
            before = (proposal.existing.get(change.node_id) or {}).get("params") or {}
            params[change.node_id] = {
                key: {"from": person_value(before.get(key), key=key), "to": person_value(value, key=key)}
                for key, value in change.params.items()
            }
        return {"nodes": nodes, "params": params}

    def brief(self, proposal: Proposal) -> dict[str, Any]:
        """The one-line form `nebula look`, `nebula context` and start_here list.
        `cantRun` counts the run's nodes that can't run here, when any do, so an
        agent that comes back later sees it should withdraw that one."""
        missing = cant_run(proposal)
        return {
            "id": proposal.id,
            "agent": proposal.agent.name,
            "note": proposal.spec.note,
            "status": proposal.status,
            "expiresInSeconds": max(0, int(proposal.expires_at - self._clock())),
            **({"cantRun": missing} if missing else {}),
        }


def _node_sort_key(node_id: str) -> tuple[int, str]:
    digits = node_id[1:]
    return (int(digits) if digits.isdigit() else 0, node_id)


def _port_info(port: Mapping[str, Any] | None, handle: str) -> dict[str, str]:
    port = port or {}
    return {
        "id": handle,
        "label": str(port.get("label") or handle),
        "dataType": str(port.get("dataType") or "Any"),
    }


def _ports_for(ref: str, definition: Mapping[str, Any], edges: Iterable[ProposedEdge]) -> dict[str, list[dict[str, str]]]:
    """Only the ports this proposal wires, so a ghost card shows where its wires attach."""
    inputs = {str(p.get("id")): p for p in definition.get("inputPorts") or [] if isinstance(p, Mapping)}
    outputs = {str(p.get("id")): p for p in definition.get("outputPorts") or [] if isinstance(p, Mapping)}
    wanted_in: list[str] = []
    wanted_out: list[str] = []
    for edge in edges:
        if edge.target == ref and edge.target_handle not in wanted_in:
            wanted_in.append(edge.target_handle)
        if edge.source == ref and edge.source_handle not in wanted_out:
            wanted_out.append(edge.source_handle)
    return {
        "inputs": [_port_info(inputs.get(handle), handle) for handle in wanted_in],
        "outputs": [_port_info(outputs.get(handle), handle) for handle in wanted_out],
    }


canvas_proposals = ProposalBook()
