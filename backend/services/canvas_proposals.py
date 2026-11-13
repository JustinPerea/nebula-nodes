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

from services import agent_words
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
NODE_ID_RE = re.compile(r"^n[0-9]{1,9}$")
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
        # A proposal's note stays one line with its spaces collapsed: GM r19's
        # "spaces inside show as typed" is for notes and replies (PR #200 fix
        # round 12), not this summary line.
        return " ".join(clean_text(raw, limit=limit, label=label).split())
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
    message = f"{label} is a connection {WIRE_SHAPE}, not {'/'.join(others)}"
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
        raise ProposalError(422, "a proposal needs at least one node, connection, param change or run")
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
    params: Mapping[str, Any] | None,
    definitions: Mapping[str, Mapping[str, Any]] | None,
    api_keys: Mapping[str, Any],
    *,
    wired: Any = (),
    cost_class: str | None = None,
) -> dict[str, Any]:
    """`free` for local utility nodes, else the node's cost class
    (model_pricing.cost_class) with the provider: `paid`, `plan` for a run
    on the person's Krea plan (GM, PR #203 r19 item 1), `mayCost` or `free`
    for a key-billing route. ``cost_class`` is the class the run's estimate
    gave this node (model_pricing.estimate_run ``classes``), which also
    knows its price: a sourced $0 is `free` (r18 item 1).

    A cinema scene is a utility node that calls its base image model once per
    shot, so it is paid, by that model's provider. A utility node whose
    ``providerVia`` param picks provider work (a QC node in vision-llm or jev
    mode) is paid too, by the provider that value calls (``byValue``), and
    priced only when its own entry has a row for that value (jev).

    A route-table node is paid by the provider of the route it would take
    (node_route.select_route with ``api_keys``); when that route can't run,
    ``provider`` is None, ``unavailable`` says why and, for a setting the
    route doesn't offer, ``fixes`` lists route_unavailable's one-click
    param edits ([{param, value}], value None = clear).

    ``api_keys`` is required, the person's keys as set now (GM, PR #203 r15
    item 1): who bills a route-table node, and whether a ``mayBillWithKey``
    route is "free" or "may cost", depend on them, so no surface prices one
    without them (tests/test_cost_for_keys_ratchet.py reads every caller).

    Any other node that can run on more than one provider (a Krea copy that
    runs on its maker's API with the person's key, a fal copy on its maker's)
    is paid by the provider of the route select_route picks with ``api_keys``
    and the input ports ``wired`` into it (a Krea-only input keeps the run on
    Krea): the route that actually runs, as the estimate beside it prices it
    (GM - Design, round 15, item 3; review 14, L-I)."""
    from services import model_pricing, node_readiness, node_route

    if definition and node_route.has_routes(definition):
        # The params as the router reads them, with the wired inputs (as the
        # estimate beside it reads them): a wire can block the Krea plan
        # route or unblock it (review 10 of PR #203, LOW-3).
        params = node_route.with_wired_blockers(definition, params, wired or ())
        route = node_route.select_route(definition, params, api_keys)
        if route.kind == node_route.UNSET:
            why = node_route.route_unavailable(definition, params, api_keys) or {}
            # A stop on a setting the route doesn't offer can be fixed in
            # place: route_unavailable's one-click param edits.
            return {"kind": "paid", "provider": None, "label": "paid · can't run as set",
                    "unavailable": str(why.get("message") or ""),
                    **({"fixes": list(why["fixes"])} if why.get("fixes") else {})}
        routed = str(route.provider or "") or None
        # A route that is free unless the person's own key is set, and
        # then may bill their account (RouteSpec mayBillWithKey: Idol on
        # its Space): never "paid" (GM, PR #203 r11 item 2, r12).
        billing = model_pricing.cost_class(definition, params, api_keys)
        if billing in (model_pricing.MAY_COST, model_pricing.FREE):
            # Named by who it runs on and may bill: a Space's host (the one
            # cost class and its account, node_route; review 8, LOW-3).
            host = node_route.key_billing_account(definition, params, api_keys) or "provider"
            # Where it runs, as an id ("huggingface"): the CLI's tag for it
            # (GM, PR #203 r24 item 1). `provider` stays the route's maker.
            runs_on = node_route.key_billing_host(definition, params, api_keys) or routed
            return {"kind": billing, "provider": routed, "label": node_route.key_billing_label(billing, host),
                    "name": str(definition.get("displayName") or definition.get("id") or ""), "account": host,
                    **({"runsOn": runs_on} if runs_on else {})}
        return _class_entry(cost_class or billing, definition, routed)

    if (definition or {}).get("id") == model_pricing.CINEMA_SCENE:
        nested = model_pricing.cinema_scene_base(params or {})
        base = (definitions or {}).get(nested[0]) if nested else None
        provider = str((base or {}).get("apiProvider") or "") or None
        if cost_class in (model_pricing.PLAN, model_pricing.FREE):
            return _class_entry(cost_class, base, provider)
        return {"kind": "paid", "provider": provider, "label": f"paid · {provider or 'provider'}, per shot"}
    provider = str((definition or {}).get("apiProvider") or "") or None
    if definition and provider not in (None, "utility"):
        routed = node_route.with_wired_blockers(definition, params or {}, wired or ())
        provider = str(node_route.select_route(definition, routed, api_keys).provider or "") or provider
        return _class_entry(cost_class or model_pricing.cost_class(definition, routed, api_keys), definition, provider)
    if provider == "utility" and not model_pricing.is_local(definition or {}, params or {}):
        via = node_readiness.provider_via(definition or {}) or {}
        _keys, what = node_readiness.param_route(via, node_readiness.param_value(definition or {}, params or {}))
        try:
            entry = (model_pricing.load_pricing().get("nodes") or {}).get(str((definition or {}).get("id") or ""))
        except (OSError, ValueError):
            entry = None
        priced = model_pricing.estimate_node(entry, definition or {}, params or {}) is not None
        if cost_class == model_pricing.FREE:
            return _class_entry(cost_class, definition, what)
        return {"kind": "paid", "provider": what,
                "label": f"paid · {what} model{'' if priced else ', no list price'}"}
    if provider == "utility":
        return {"kind": "free", "provider": None, "label": "free · runs locally"}
    return {"kind": "paid", "provider": provider, "label": _paid_label(definition, provider)}


# The ghost card's tag for a run on the Krea plan, by the chip's words ("1 on
# Krea plan"; GM, PR #203 r19 item 1): never "paid", never "billed".
PLAN_LABEL = "on Krea plan"


def _ghost_cost(node: Any, definition: Mapping[str, Any], definitions: Mapping[str, Mapping[str, Any]] | None,
                api_keys: Mapping[str, Any], run_entry: Mapping[str, Any] | None,
                edges: Iterable[Any]) -> dict[str, Any]:
    """A ghost card's cost tag, in its cost class: the run entry's class
    when the proposal runs it (the estimate's, which knows a sourced $0 is
    free), else the class its own price gives it (model_pricing.estimate_run),
    so the tag and the run entry never disagree (review 10 of PR #203, NIT-3).
    Key-billing classes are read with the keys set now, in cost_for."""
    from services import model_pricing

    wired = sorted({str(edge.target_handle) for edge in edges
                    if getattr(edge, "target", None) == node.ref and getattr(edge, "target_handle", None)})
    cls = str((run_entry or {}).get("kind") or "") or None
    if run_entry is None and definition:
        try:
            item = {"id": node.ref, "definitionId": node.definition_id, "params": dict(node.params or {})}
            cls = model_pricing.estimate_run([item], model_pricing.load_pricing(), definitions or {}, api_keys,
                                             wired={node.ref: wired})["classes"].get(node.ref)
        except (OSError, ValueError, KeyError, model_pricing.PricingError):
            cls = None
    if cls not in model_pricing.CLASS_ENTRIES:
        cls = None
    return cost_for(definition, node.params, definitions, api_keys, wired=wired, cost_class=cls)


def _class_entry(cls: str, definition: Mapping[str, Any] | None, provider: str | None) -> dict[str, Any]:
    """A provider call's cost entry by its cost class (model_pricing.cost_class):
    "on Krea plan", "free · <provider>" for a sourced $0, else paid."""
    from services import model_pricing, node_route

    if cls == model_pricing.PLAN:
        return {"kind": "plan", "provider": provider, "label": PLAN_LABEL}
    if cls == model_pricing.FREE:
        return {"kind": "free", "provider": provider,
                "label": f"free · {node_route.provider_label(provider) if provider else 'provider'}"}
    return {"kind": "paid", "provider": provider, "label": _paid_label(definition, provider)}


def _paid_label(definition: Mapping[str, Any] | None, provider: str | None) -> str:
    """"paid · <provider>", or, for a run that leaves the gateway its name
    says, the route built as the confirm dialog builds it (GM - Design, round
    16 (b), verbatim: "Grok Imagine 2.0 via xAI"): "paid · Grok Imagine 2.0
    via xAI". node_route.name_on_route is frontend nameOnRoute's twin."""
    from services import node_route

    name = str((definition or {}).get("displayName") or "")
    built = node_route.name_on_route(definition or {}, provider) if definition else name
    if built and built != name:
        return f"paid · {built}"
    return f"paid · {provider or 'provider'}"


def live_cost(proposal: "Proposal", definitions: Mapping[str, Mapping[str, Any]],
              api_keys: Mapping[str, Any]) -> dict[str, Any]:
    """The proposal's run cost with each key-billing node's class read from
    the keys set now (node_route.key_billing through cost_for): a token
    added after the proposal makes Idol "may cost", one removed makes it
    "free" (GM, PR #203 r15 item 2; review 7, NIT-5). Prices and paid runs
    are as proposed: no key-billing node is paid or priced."""
    cost = copy.deepcopy(proposal.cost)
    entries = cost.get("nodes")
    if not isinstance(entries, list):
        return cost
    changed = False
    for index, entry in enumerate(entries):
        definition = definitions.get(str(entry.get("definitionId") or ""))
        if not definition or entry.get("kind") not in ("free", "mayCost"):
            continue
        # The params it was priced with (main._proposal_cost: the staged
        # graph's, after the proposal's own param changes).
        params = proposal.key_params.get(str(entry.get("ref")))
        if params is None or not _key_billing(definition, params, api_keys):
            continue
        fresh = cost_for(definition, params, definitions, api_keys)
        entries[index] = {**entry, **fresh, **({"name": entry["name"]} if entry.get("name") else {})}
        changed = True
    if changed:
        paid, plan, may_cost, free = class_counts(entries)
        cost["mayCostRuns"] = len(may_cost)
        cost["mayCost"] = [{"name": name, "account": account} for name, account in dict.fromkeys(
            (str(entry.get("name") or ""), str(entry.get("account") or "")) for entry in may_cost)]
        cost["freeRuns"] = free
    return cost


def class_counts(entries: Iterable[Mapping[str, Any]]) -> tuple[int, int, list[Mapping[str, Any]], int]:
    """(paid, plan, the mayCost entries, free) of a run's cost entries, each
    from its own `kind`. A kind this backend doesn't name (CLASS_ENTRIES)
    counts as paid, as propose_change's description tells an agent to read
    it ("paid with no listed price"), never as free: free runs are only
    those whose kind is "free" (review 11 of PR #203, NIT-4). The spend gate
    never reads a kind: it reads the one cost class (model_pricing.cost_class,
    agent_spend.may_bill_nodes), which is always one of the four."""
    rows = list(entries)
    plan = sum(1 for entry in rows if entry.get("kind") == "plan")
    may_cost = [entry for entry in rows if entry.get("kind") == "mayCost"]
    free = sum(1 for entry in rows if entry.get("kind") == "free")
    return len(rows) - plan - len(may_cost) - free, plan, may_cost, free


def _key_billing(definition: Mapping[str, Any], params: Mapping[str, Any], api_keys: Mapping[str, Any]) -> str | None:
    """The key-billing class ("mayCost" or "free") of the one cost class
    (model_pricing.cost_class), else None."""
    from services import model_pricing

    cls = model_pricing.cost_class(definition, params, api_keys)
    return cls if cls in (model_pricing.MAY_COST, model_pricing.FREE) else None


def summarize_cost(
    entries: list[dict[str, Any]], *, up_to: bool, estimate: dict[str, Any] | None = None,
    not_ready: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """The proposal's run set: each entry is {ref, nodeId, kind, provider, label, price},
    plus `missing` when that node can't run here as set up, and `reason` when
    a paid node leaves the total open or a node runs on the Krea plan
    (model_pricing.estimate_run reasons). ``kind`` is the node's cost class:
    paid, plan (counted in ``planRuns``), mayCost or free.

    ``estimate`` is ``model_pricing.estimate_run`` output keyed by the same
    refs; it becomes {currency, low, high, open, unpriced, plan, plus}, or
    None when no node in the run has a list price. ``not_ready`` lists every
    node the run reads that can't run here, cached ancestors included
    ([{ref, nodeId, name, missing}], main._not_ready_nodes), read when the
    proposal was made."""
    # Runs that may bill the person's own account (a mayBillWithKey route
    # with their key set: Idol with an HF token), counted apart from paid
    # (GM, PR #203 r11 item 2: "2 paid · 1 may cost"), with their names for
    # the bar's own clause ("Runs 2 paid models and Idol"). Runs on the
    # person's Krea plan, counted apart from paid too (GM, PR #203 r19 item
    # 1: "2 paid · 1 on Krea plan"). class_counts reads an unknown kind.
    paid, plan, may_cost, free = class_counts(entries)
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
        "planRuns": plan,
        "mayCostRuns": len(may_cost),
        "mayCost": [{"name": name, "account": account} for name, account in dict.fromkeys(
            (str(entry.get("name") or ""), str(entry.get("account") or "")) for entry in may_cost)],
        "freeRuns": free,
        "estimate": summary_estimate,
        "upTo": up_to,
        "providers": providers,
        "nodes": entries,
        "notReady": list(not_ready or []),
        "note": COST_NOTE,
    }


# -- the plan line (GM - Design, 2026-11-01, the proposal card redesign) ------
# One line under the agent's note saying what Accept changes and costs, with
# node names, never ids: "Changes and runs “Hero shot” · Krea 2 on your Krea
# plan · no list price". The view carries it as `plan`, so the card, the CLI
# and MCP read the same words.

# Up to this many nodes named in a group; from one more, a count ("Changes 4 nodes").
PLAN_NAMES = 3
NOTHING_RUNS = "nothing runs until you choose"
PLAN_NO_PRICE = "no list price"


def billed_to(definition: Mapping[str, Any] | None, params: Mapping[str, Any] | None,
              cost: Mapping[str, Any], *, wired: Any = ()) -> str | None:
    """Who pays for a paid run, in the person's words: "your Krea plan",
    "your Krea API key", "your OpenAI key", "your Nous account". It names
    the provider the node is routed to even when that provider's key or
    sign-in is missing (the not-ready line says so). None for a free run, or
    when the route names no provider the person could hold a key or account
    for (a utility node, an unknown provider)."""
    from services import node_route

    if cost.get("kind") not in ("paid", "plan") or not definition:
        return None
    if node_route.uses_krea_plan(definition, node_route.with_wired_blockers(definition, params or {}, wired or ())):
        return "your Krea plan"
    provider = str(cost.get("provider") or "")
    if not provider or provider == "utility" or provider not in node_route.PROVIDER_LABELS:
        return None
    if provider == "krea":
        return "your Krea API key"
    label = node_route.provider_label(provider)
    keyed = provider in set(node_route.KEY_PROVIDERS.values())
    return f"your {label} {'key' if keyed else 'account'}"


def _plural(count: int, word: str) -> str:
    return f"{count} {word}{'' if count == 1 else 's'}"


_QUOTES = "“”\"'‘’"


def _plan_name(name: Any) -> str | None:
    """A node's name for the line, without quotes of its own (review 1 N1:
    “Hero” never reads ““Hero””). Only quotes that wrap it, at both ends: an
    apostrophe the name ends in stays ("Artists'", review 3 NIT-3). None
    when it has none."""
    text = str(name).strip() if isinstance(name, str) else ""
    while len(text) >= 2 and text[0] in _QUOTES and text[-1] in _QUOTES:
        text = text[1:-1].strip()
    return text or None


plan_name = _plan_name


def model_label(definition: Mapping[str, Any] | None, params: Mapping[str, Any] | None,
                models: Mapping[tuple[str, str], Any] | None = None) -> str:
    """The model a node runs, as the card, the plan line, get_proposal, MCP
    and the CLI name it: the canvas title ("Krea 2"), or for a universal node
    the model it is set to, by its catalog name (GM - Design, PR #216 r4-r5:
    "Claude Sonnet 4.5 on your OpenRouter key", "“Second look” · GPT-4o",
    never "OpenRouter"). ``models`` is _look_up_models' data; without it the
    pickers' cache, else the model id."""
    from services import node_route, universal_ports

    definition = definition or {}
    definition_id = str(definition.get("id") or "")
    model = universal_ports.model_of(definition_id, params) if universal_ports.is_universal(definition_id) else ""
    if model:
        return universal_ports.model_name(definition_id, model, (models or {}).get((definition_id, model)))
    return node_route.canvas_title(definition) or definition_id


def _and_list(words: list[str]) -> str:
    """“A”, “A” and “B”, “A”, “B” and “C”: no serial comma."""
    return words[0] if len(words) == 1 else f"{', '.join(words[:-1])} and {words[-1]}"


def _group_words(keys: list[str], names: Mapping[str, str | None], said: set[str]) -> list[str]:
    """One group's nodes (GM - Design, PR #216 r3), as list items: up to
    PLAN_NAMES by name, from one more a count. Nodes are told apart by id,
    never by name: two in the group with one name read "2 “Image” nodes", and
    a name an earlier group already said, on another node, reads "another
    “Image”" (GM r4: also after that group's count of them)."""
    if len(keys) > PLAN_NAMES:
        return [_plural(len(keys), "node")]
    counts: dict[str | None, int] = {}
    for key in keys:
        name = names.get(key)
        counts[name] = counts.get(name, 0) + 1
    words: list[str] = []
    unnamed = counts.pop(None, 0)
    for name, count in counts.items():
        if name in said:
            words.append(f"another “{name}”" if count == 1 else f"{count} other “{name}” nodes")
        else:
            words.append(f"“{name}”" if count == 1 else f"{count} “{name}” nodes")
    if unnamed:
        # Every node the view names has a name; this is the last resort (review 1 L3:
        # one without never turns the others into a count).
        words.append(_plural(unnamed, "more node") if words else _plural(unnamed, "node"))
    return words


def _group_names(keys: list[str], names: Mapping[str, str | None], said: set[str]) -> str:
    return _and_list(_group_words(keys, names, said))


def _spoke(keys: list[str], names: Mapping[str, str | None], said: set[str]) -> None:
    """The names a group said aloud join `said` (review 2 L2): a group that
    counted its nodes ("4 nodes") said none, so a later "another" has
    nothing to point back to."""
    if len(keys) <= PLAN_NAMES:
        said.update(name for name in (names.get(key) for key in keys) if name)


def _runs_of(group: list[str], running: list[str], names: Mapping[str, str | None]) -> str:
    """Which of a group's nodes it runs, after its verb (GM - Design, PR #216
    r4): "both", "all 3", or, when only some run, those by name ("“A”"); "1
    of them" when a name doesn't tell them apart."""
    if len(running) == len(group):
        return "both" if len(group) == 2 else f"all {len(group)}"
    run_names = [names.get(key) for key in running]
    group_names = [names.get(key) for key in group]
    if (len(running) > PLAN_NAMES or None in run_names
            or any(group_names.count(name) > run_names.count(name) for name in run_names)):
        return f"{len(running)} of them"
    return _group_names(running, names, set())


def _plan_names(view: Mapping[str, Any]) -> dict[str, str | None]:
    """Every node the proposal touches, by id or ref, with its name: a new
    node's, a changed node's title, then the view's `names` (each node it
    references, by its canvas name), then the run's price items."""
    names: dict[str, str | None] = {}
    cost = view.get("cost") or {}
    for entry in cost.get("nodes") or []:
        if isinstance(entry, Mapping) and _plan_name(entry.get("name")):
            names[str(entry.get("ref"))] = _plan_name(entry.get("name"))
    for key, name in (view.get("names") or {}).items():
        if _plan_name(name):
            names[str(key)] = _plan_name(name)
    for change in view.get("params") or []:
        if isinstance(change, Mapping) and _plan_name(change.get("title")):
            names[str(change.get("nodeId"))] = _plan_name(change.get("title"))
    for node in view.get("nodes") or []:
        if isinstance(node, Mapping):
            names[str(node.get("ref"))] = _plan_name(node.get("name"))
    return names


def _runs_nothing(view: Mapping[str, Any]) -> bool:
    cost = view.get("cost") or {}
    pending = cost.get("pendingSkipped") or None
    return (bool(view.get("run")) and int(cost.get("paidRuns") or 0) == 0 and int(cost.get("freeRuns") or 0) == 0
            and int(cost.get("planRuns") or 0) == 0 and int(cost.get("mayCostRuns") or 0) == 0
            and bool(pending and pending.get("count")))


def plan_groups(view: Mapping[str, Any]) -> list[str]:
    """What Accept does, one group per kind of change (GM - Design, PR #216
    r3-r4): the nodes it adds, then the nodes it changes, each followed by
    which of them it runs, then the other nodes it runs, then the wires a
    model change removes.

    - One node keeps its verbs merged: "Adds and runs “A” plus 1
      connection", "Changes and runs “K”".
    - More than one names them, and the run follows: "Adds “A”, “B” and 1
      connection, runs both" ("runs all 3", "runs all 4" after "Adds 4 nodes
      and 1 connection"); only some running are named: "runs “A”".
    - New connections close the list of the nodes added ("“A”, “B” and 1
      connection"; "plus 1 connection" after a merged verb, so no group says
      "and" twice), or make their own group with no node added.
    - The other runs join the last run named ("runs both plus “C”"), else
      make their own group ("runs “C”", "another “Image”" after a group that
      said "Image").
    - Wires a model change drops close the line ("removes 2 connections").

    A run that waits on placeholders runs nothing yet, so it adds no run."""
    names = _plan_names(view)
    verbs: dict[str, list[str]] = {}

    def mark(key: str, verb: str) -> None:
        verbs.setdefault(key, [])
        if verb not in verbs[key]:
            verbs[key].append(verb)

    for node in view.get("nodes") or []:
        if isinstance(node, Mapping):
            mark(str(node.get("ref")), "adds")
    for change in view.get("params") or []:
        if isinstance(change, Mapping):
            mark(str(change.get("nodeId")), "changes")
    if not _runs_nothing(view):
        for target in view.get("run") or []:
            mark(str(target), "runs")

    edges = len(view.get("edges") or [])
    removed = len(view.get("removedEdges") or [])
    connections = _plural(edges, "connection") if edges else ""
    said: set[str] = set()
    groups: list[str] = []
    # The last group's run clause, while it is the line's last words: the
    # other runs join it. ("both"/"all N"/"N of them" join with "plus".)
    last_run: tuple[list[str], str] | None = None
    for verb in ("adds", "changes"):
        keys = [key for key, done in verbs.items() if done[0] == verb]
        if not keys:
            if verb == "adds" and connections:
                groups.append(f"adds {connections}")
            continue
        running = [key for key in keys if "runs" in verbs[key]]
        extra = connections if verb == "adds" else ""
        if len(keys) == 1:
            words = _group_names(keys, names, said)
            if running:
                groups.append(f"{verb} and runs {words}" + (f" plus {extra}" if extra else ""))
            else:
                groups.append(f"{verb} {words}" + (f" and {extra}" if extra else ""))
            last_run = None
        else:
            items = _group_words(keys, names, said)
            groups.append(f"{verb} {_and_list([*items, *([extra] if extra else [])])}")
            last_run = None
            if running:
                which = _runs_of(keys, running, names)
                groups.append(f"runs {which}")
                last_run = (running, which)
        _spoke(keys, names, said)
    others = [key for key, done in verbs.items() if done == ["runs"]]
    if others:
        if last_run is not None:
            running, which = last_run
            if which.startswith(("both", "all ")) or which.endswith(" of them"):
                groups[-1] = f"runs {which} plus {_group_names(others, names, said)}"
            else:
                groups[-1] = f"runs {_and_list([*_group_words(running, names, set()), *_group_words(others, names, said)])}"
        else:
            groups.append(f"runs {_group_names(others, names, said)}")
    if removed:
        groups.append(f"removes {_plural(removed, 'connection')}")
    return groups


def _may_cost_clauses(rows: list[Mapping[str, Any]], *, named: bool) -> str:
    """"may use your Hugging Face credits", or named when other classes run
    beside it, or for several accounts: "Idol may use your Hugging Face
    credits" (GM, PR #203 r14 item 2). Frontend mayCostSentence's twin for the
    plan line."""
    by_account: dict[str, list[str]] = {}
    for row in rows:
        names = by_account.setdefault(str(row.get("account") or ""), [])
        name = str(row.get("name") or "")
        if name and name not in names:
            names.append(name)
    clauses = []
    for account, names in by_account.items():
        who = f"{_and_list(names)} " if names and (named or len(by_account) > 1) else ""
        clauses.append(f"{who}may use your {account} credits")
    return " · ".join(clauses)


def plan_line(view: Mapping[str, Any]) -> str:
    """What Accept changes and costs, in one line of segments joined by " · ":
    what happens, with node names (plan_groups, joined by ", "); for exactly
    one paid run its model and who pays ("Krea 2 on your Krea plan"), for
    more the count ("3 paid runs"), for free runs "free"; then the run
    chip's price ("~$0.03", "Up to $0.43", "$0.07 + unpriced") or "no list
    price". The chip's "Up to" covers a paid run that may be skipped (GM -
    Design, PR #216 r3). With no run it says nothing runs until the person
    chooses; a run that waits on agents' placeholders says so, as before."""
    from services import money

    run = list(view.get("run") or [])
    cost = view.get("cost") or {}
    entries = [entry for entry in cost.get("nodes") or [] if isinstance(entry, Mapping)]
    paid = int(cost.get("paidRuns") or 0)
    pending = cost.get("pendingSkipped") or None

    groups = plan_groups(view)
    segments = [", ".join(groups)] if groups else []
    if not run:
        segments.append(NOTHING_RUNS)
    elif _runs_nothing(view):
        # Its whole run waits on agents' placeholders, which it skips (GM -
        # Design, round 4), counting the placeholders themselves (review 4, M2).
        count = int(pending.get("placeholders") or pending.get("count") or 0)
        agents = [str(agent) for agent in pending.get("agents") or []]
        who = f"{agents[0]} finishes" if len(agents) == 1 and agents[0] else "agents finish"
        segments.append(f"runs nothing until {who} {_plural(count, 'node')}")
    else:
        # Runs by cost class (GM, PR #203 r11 item 2, r19 item 1): paid ones,
        # ones on the person's Krea plan, and ones that may bill their own
        # account (Idol with a Hugging Face token) are each said, never
        # "free". A node's own name leads a may-cost clause only beside other
        # classes, or when several accounts are named ("Idol may use your
        # Hugging Face credits").
        plan_runs = int(cost.get("planRuns") or 0)
        may_rows = [row for row in (cost.get("mayCost") or []) if isinstance(row, Mapping)] \
            if int(cost.get("mayCostRuns") or 0) > 0 else []
        billed_entries = [entry for entry in entries if entry.get("kind") not in ("free", "mayCost")]
        if paid + plan_runs == 1 and len(billed_entries) == 1:
            entry = billed_entries[0]
            model = str(entry.get("model") or entry.get("name") or "1 paid run")
            segments.append(f"{model} on {entry['billedTo']}" if entry.get("billedTo") else model)
        else:
            if paid > 0:
                segments.append(_plural(paid, "paid run"))
            if plan_runs > 0:
                segments.append(f"{plan_runs} on your Krea plan")
        if may_rows:
            segments.append(_may_cost_clauses(may_rows, named=bool(paid or plan_runs)))
        if not paid and not plan_runs and not may_rows:
            segments.append("free")
        if paid > 0 or plan_runs > 0:
            # A run on the Krea plan has no list price (GM - Design, PR #216
            # r3: "Krea 2 on your Krea plan · no list price").
            estimate = cost.get("estimate")
            if estimate and estimate.get("high") is not None:
                segments.append(money.chip_label(estimate.get("low"), estimate.get("high"), bool(estimate.get("open"))))
            else:
                segments.append(PLAN_NO_PRICE)
    text = " · ".join(segment for segment in segments if segment)
    return text[:1].upper() + text[1:]


# Where each surface's agent finds a node that runs here, the MCP and CLI
# words from the one table (services/agent_words.WORDS). The HTTP answer
# names the route; propose_change (MCP) and `nebula propose` (CLI) word the
# warning again from cost.notReady for their own reader (agent_wording). The CLI names
# `nebula nodes`, find_nodes' twin on the same route: by default it lists only
# what runs here, and `nebula context`'s list is cut at its budget.
READY_NODES_HTTP = "GET /api/agent/nodes"
READY_NODES_MCP = agent_words.WORDS[agent_words.MCP]["find"]
READY_NODES_CLI = agent_words.WORDS[agent_words.CLI]["find"]

# How each surface's agent withdraws a proposal ({id} is the proposal's id).
# A proposal that can't run here is kept with its warning (Justin, Q109: "Keep
# it with the warning, and tell the agent to withdraw it before proposing
# something else"), so the warning and the reminder name the exact call.
WITHDRAW_HTTP = "DELETE /api/canvas/proposals/{id}"
WITHDRAW_MCP = agent_words.WORDS[agent_words.MCP]["withdraw"]
WITHDRAW_CLI = agent_words.WORDS[agent_words.CLI]["withdraw"]


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
    if view.get("status", OPEN) != OPEN:
        # It closed already (it can while its Update is written), so there is nothing to withdraw.
        out.pop("warning", None)
        warning = None
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
    # The params each key-billing run entry was priced with, by its ref
    # (main._proposal_cost): live_cost re-reads its class with the keys set
    # at each view. Never in view(), REST or logs.
    key_params: dict[str, dict[str, Any]] = field(default_factory=dict, repr=False)
    status: str = OPEN
    reason: str | None = None
    # Only ever sent to browser sockets; never in view(), REST, journal or logs.
    accept_key: str = field(default_factory=lambda: secrets.token_urlsafe(24), repr=False)
    id_map: dict[str, str] | None = None
    run_node_ids: list[str] | None = None
    closed_at: float | None = None
    # Its Update on the project's list ({id, projectId}; Justin's Q112 a), or
    # None when no project was open. main posts it and settles it.
    update: dict[str, str] | None = None
    # The node deletes that closed it, or deleted another node it needs while
    # it was closed that way: removal id (rm_...) -> node id. Only deletes in
    # its own project tag it, and only the undo of a matching (removal, node)
    # pair may reopen it (ProposalBook.closed_by_pairs, reopen).
    closed_by: dict[str, str] = field(default_factory=dict)
    # Tags a clear, an import or a project switch dropped (node ids started
    # again, so a later delete of "n1" may be another node): the undo of
    # those deletes can't reopen it, and says so (``dropped_reason``).
    dropped_by: dict[str, str] = field(default_factory=dict)
    # The canvas revision it was made on (main._canvas_revision). Accept is
    # refused once it moved: a clear or an import landed since, so node ids
    # may name other nodes (round 21 of PR #195, review 20 L-3).
    canvas_revision: str | None = None
    dropped_reason: str | None = None
    # Which node it read under each id (main.node_removals.lineage, set when
    # it was made): a delete tags it only when it took that very node.
    lineage: dict[str, str] = field(default_factory=dict)
    # The card's words for each wire it makes, one per spec edge, in order:
    # {sourceName, targetName, targetLabel} (main writes them when it is made).
    wires: list[dict[str, str]] = field(default_factory=list)
    # The wires Accept removes: a model change drops the ones on ports the new
    # model doesn't have, as the picker does for the person (GM - Design,
    # PR #216 r3). Each is {source, sourceHandle, target, targetHandle,
    # sourceName, targetName, targetLabel}; Accept refuses when the live
    # graph would drop any others.
    removed_edges: list[dict[str, str]] = field(default_factory=list)
    # The proposing request's raw presence session (agent_presence.
    # presence_session; None for the agent's plain cursor), so the person's
    # tabs show "Accepted" on that session's cursor (PR #211 r4). Person
    # side only: never in view(), brief(), REST, the journal or logs.
    presence_session: str | None = field(default=None, repr=False)

    @property
    def references(self) -> set[str]:
        return self.spec.references

    @property
    def touched(self) -> set[str]:
        """The existing nodes the card names: those it references, and the far
        end of each connection Accept removes (review 3 LOW-2: a rename of the
        photo connected to a swapped node follows on the card too)."""
        ends = {str(edge.get(key)) for edge in self.removed_edges for key in ("source", "target") if edge.get(key)}
        return set(self.existing) | ends

    def shown_names(self) -> dict[str, str]:
        """Each touched node's name as the proposal was made: its title, or
        the name a removed connection carried for it."""
        names: dict[str, str] = {}
        for edge in self.removed_edges:
            for end, word in (("source", "sourceName"), ("target", "targetName")):
                if edge.get(end) and edge.get(word):
                    names[str(edge[end])] = str(edge[word])
        names.update({node_id: str(row.get("title") or "") for node_id, row in self.existing.items()
                      if isinstance(row, Mapping)})
        return names

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
        key_params: dict[str, dict[str, Any]] | None = None,
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
            key_params=copy.deepcopy(key_params or {}),
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
        # A snapshot first: the asset Update's share fields are read on a notes
        # worker thread while the loop may add or close an ask (PR #204 round 3).
        return [p for p in list(self._items.values()) if p.is_open]

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
        proposal.closed_by = {}
        proposal.dropped_by = {}
        proposal.dropped_reason = None
        self._prune()
        return proposal

    def closed_by_pairs(self, pairs: Iterable[tuple[str, str]], project_id: str | None) -> list[Any]:
        """Proposals in ``project_id`` a node delete closed that are still
        closed that way: invalidated, and tagged by one of these (removal id,
        node id) pairs. Never by a removal id or a node id alone."""
        wanted = set(pairs)
        return [p for p in self._items.values()
                if p.status == "invalidated" and p.project_id == project_id
                and any(pair in wanted for pair in p.closed_by.items())]

    def drop_removal_tags(self, reason: str) -> None:
        """Node ids start again (a clear, an import) or another project's
        ids are live now (a project switch): no earlier delete's undo may
        reopen a proposal by its node id any more. The dropped tags are kept
        to say why (``dropped_by``)."""
        for proposal in self._items.values():
            if proposal.closed_by:
                proposal.dropped_by.update(proposal.closed_by)
                proposal.dropped_reason = reason
                proposal.closed_by = {}

    def reopen(self, proposal_id: str) -> Any:
        """Open again an invalidated proposal a node delete closed (main finds
        it by its removal, closed_by_pairs) once main checked it still fits
        the restored graph. Its expiry stays the one it had: a proposal past
        it doesn't reopen. The open caps apply, as to a new proposal (429)."""
        proposal = self._items.get(proposal_id)
        if proposal is None:
            raise ProposalError(404, f"No proposal {proposal_id[:20]}")
        if proposal.status != "invalidated":
            raise ProposalError(409, f"Proposal {proposal_id} is {proposal.status}")
        if proposal.expires_at <= self._clock():
            raise ProposalError(409, "it expired")
        open_now = self.open_list()
        if len([p for p in open_now if p.agent.id == proposal.agent.id]) >= MAX_OPEN_PER_AGENT:
            raise ProposalError(429, "its agent already has the most open proposals it may have")
        if len(open_now) >= MAX_OPEN_TOTAL:
            raise ProposalError(429, "too many proposals are waiting for the person")
        proposal.status = OPEN
        proposal.reason = None
        proposal.closed_at = None
        proposal.closed_by = {}
        proposal.dropped_by = {}
        proposal.dropped_reason = None
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

    def invalidate_referencing(self, node_id: str, reason: str, removal: str | None = None,
                               project_id: str | None = None, lineage: str | None = None) -> list[Proposal]:
        """Close the open proposals that read ``node_id`` (it was deleted).
        ``removal`` is that delete's removal id, so its undo may reopen them;
        it tags only proposals of ``project_id``, the project the delete was
        in, that read this very node (``lineage``), not another node that had
        the same id."""
        def read_it(proposal: Proposal) -> bool:
            return (proposal.project_id == project_id
                    and proposal.lineage.get(node_id, lineage) == lineage)

        hit = [p for p in self.open_list() if node_id in p.references]
        for proposal in hit:
            self.close(proposal.id, "invalidated", reason=reason)
            if removal and read_it(proposal):
                proposal.closed_by = {removal: node_id}
        if removal:
            # Closed by an earlier delete in this project and needing this
            # node too: undoing only that earlier delete won't bring it back,
            # undoing both may.
            for proposal in self._items.values():
                if (proposal.status == "invalidated" and proposal.closed_by and proposal not in hit
                        and node_id in proposal.references and read_it(proposal)):
                    proposal.closed_by[removal] = node_id
        return hit

    def invalidate_all(self, reason: str) -> list[Proposal]:
        hit = self.open_list()
        for proposal in hit:
            self.close(proposal.id, "invalidated", reason=reason)
        self.drop_removal_tags(reason)
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
    def view(self, proposal: Proposal, *, registry: Any, api_keys: Mapping[str, Any],
             live: Mapping[str, str] | None = None) -> dict[str, Any]:
        """What agents and the canvas read. ``api_keys``: the person's keys as
        set now. The ghost cards' costs and the run's key-billing classes are
        read with them (GM, PR #203 r15 items 1 and 2), so a token added or
        removed after the proposal changes "free" and "may cost" in every
        listing. ``live`` maps the existing nodes it touches to their names on
        the canvas now: names follow a rename while the proposal is open (GM -
        Design, PR #216 r4 4: ids are what's applied; the agent's note stays
        as written)."""
        from services import node_route

        definitions = registry.get_all() if registry is not None else {}
        spec = proposal.spec
        touched = proposal.touched
        live = {key: value for key, value in (live or {}).items() if key in touched and value}

        def existing_row(node_id: str) -> dict[str, Any]:
            row = dict(proposal.existing.get(node_id) or {})
            if node_id in live:
                row.update(title=live[node_id], name=f"{live[node_id]} ({node_id})")
            return row
        node_costs = {entry.get("ref"): entry for entry in proposal.cost.get("nodes", [])}
        nodes: list[dict[str, Any]] = []
        names = spec.names
        for node in spec.nodes:
            definition = definitions.get(node.definition_id, {}) if isinstance(definitions, dict) else {}
            model = model_label(definition, node.params) or node.definition_id
            nodes.append({
                "ref": node.ref,
                "definitionId": node.definition_id,
                # The name the proposal gives it (accepting applies it), else
                # its canvas title (review 18 M-D).
                "name": names.get(node.ref) or node_route.node_name(definition, None, node.definition_id),
                **({"model": model} if names.get(node.ref) else {}),
                "category": str(definition.get("category") or ""),
                "params": safe_value(node.params, key="params"),
                "position": dict(proposal.positions.get(node.ref) or node.position or {"x": 0.0, "y": 0.0}),
                "cost": _ghost_cost(node, definition, definitions if isinstance(definitions, dict) else None,
                                    api_keys, node_costs.get(node.ref), spec.edges),
                "runs": node.ref in spec.run,
                "willRun": node.ref in node_costs,
                "ports": _ports_for(node.ref, definition, spec.edges),
            })
        params: list[dict[str, Any]] = []
        for change in spec.params:
            row = existing_row(change.node_id)
            before = row.get("params") or {}
            params.append({
                "nodeId": change.node_id,
                "name": row.get("name") or change.node_id,
                # The card's words: the node's name and model, never its id.
                **({"title": row["title"]} if row.get("title") else {}),
                **({"model": row["model"]} if row.get("model") else {}),
                # The same model set again, its ports read again (GM - Design, PR #216 r4 8).
                **({"inputsUpdated": dict(row["inputsUpdated"])} if row.get("inputsUpdated") else {}),
                "changes": {
                    key: {
                        "from": safe_value(before.get(key), key=key),
                        "to": safe_value(value, key=key),
                    }
                    for key, value in change.params.items()
                },
            })
        # Each node it touches by its canvas name, by id or ref: the plan line's
        # and the panel's words (review 1 L3: a run-only node keeps its name).
        node_names: dict[str, str] = {
            node_id: str(existing_row(node_id)["title"]) for node_id, row in sorted(proposal.existing.items())
            if isinstance(row, Mapping) and existing_row(node_id).get("title")}
        node_names.update({node["ref"]: node["name"] for node in nodes if node.get("name")})
        # The far end of a connection Accept removes, by its name now (review 3 LOW-2).
        node_names.update({node_id: name for node_id, name in sorted(live.items()) if node_id not in node_names})
        new_ports = {node["ref"]: {port["id"]: port["label"] for port in node["ports"]["inputs"]} for node in nodes}
        edges: list[dict[str, Any]] = []
        for index, edge in enumerate(spec.edges):
            words = proposal.wires[index] if index < len(proposal.wires) else {}
            edges.append({
                **edge.as_dict(),
                # “Prompt” → “Second take” · Prompt (GM - Design, PR #216 r3).
                "sourceName": live.get(edge.source) or words.get("sourceName") or node_names.get(edge.source) or edge.source,
                "targetName": live.get(edge.target) or words.get("targetName") or node_names.get(edge.target) or edge.target,
                "targetLabel": (words.get("targetLabel") or new_ports.get(edge.target, {}).get(edge.target_handle)
                                or edge.target_handle),
            })
        view = {
            "id": proposal.id,
            "status": proposal.status,
            "agent": proposal.agent.as_dict(),
            "note": spec.note,
            "projectId": proposal.project_id,
            "createdAt": int(proposal.created_at * 1000),
            "expiresAt": int(proposal.expires_at * 1000),
            "nodes": nodes,
            "edges": edges,
            "removedEdges": [{**edge, **({"sourceName": live[edge["source"]]} if edge.get("source") in live else {}),
                              **({"targetName": live[edge["target"]]} if edge.get("target") in live else {})}
                             for edge in copy.deepcopy(proposal.removed_edges)],
            "names": node_names,
            "params": params,
            "run": list(spec.run),
            "cost": _cost_with_names(
                live_cost(proposal, definitions if isinstance(definitions, dict) else {}, api_keys), live),
            "references": sorted(proposal.references, key=_node_sort_key),
            "reason": proposal.reason,
            "idMap": dict(proposal.id_map) if proposal.id_map else None,
            "runNodeIds": list(proposal.run_node_ids) if proposal.run_node_ids else None,
            "update": dict(proposal.update) if proposal.update else None,
        }
        # One count for the card, the Update and MCP (GM - Design, PR #216 r3).
        view["changeCount"] = change_count(spec, removed=len(proposal.removed_edges))
        view["plan"] = plan_line(view)
        return view

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


def _cost_with_names(cost: Mapping[str, Any], live: Mapping[str, str]) -> dict[str, Any]:
    """The proposal's cost with each existing node under its name now: its
    price item, and its not-ready row (the person's line names it first)."""
    cost = copy.deepcopy(dict(cost))
    for entry in cost.get("nodes") or []:
        if isinstance(entry, dict) and entry.get("nodeId") in live:
            entry["name"] = live[entry["nodeId"]]
    for row in cost.get("notReady") or []:
        if not isinstance(row, dict) or row.get("nodeId") not in live:
            continue
        old, new = str(row.get("name") or ""), live[row["nodeId"]]
        person = row.get("person")
        quoted = f"“{_plan_name(old) or old}”"
        if isinstance(person, str) and person.startswith(quoted):
            row["person"] = f"“{_plan_name(new) or new}”{person[len(quoted):]}"
        row["name"] = new
    return cost


def _node_sort_key(node_id: str) -> tuple[int, str]:
    digits = node_id[1:]
    return (int(digits) if digits.isascii() and digits.isdigit() else 0, node_id)


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


# -- the Update each proposal posts (Justin's Q112 a, 2026-10-21) --------------
#
# "a) Yes, every one: "Claude Code proposes 3 changes on the canvas", with
# Review taking you to the canvas and its bar. It settles like the others
# (Accepted, Rejected, Expired, Closed: Nebula restarted)." main posts it on
# the project's Updates when the proposal opens and settles it when it ends.

def change_count(spec: ProposalSpec, *, removed: int = 0) -> int:
    """What the Update, the card and MCP count as a change (GM - Design, PR
    #216 r2-r3: one unit, the operation): each new node, each new wire, each
    existing node whose params change and each wire Accept removes (the
    panel's groups and connection lines). A run changes nothing on the
    canvas, and a name belongs to its new node."""
    return len(spec.nodes) + len(spec.edges) + len(spec.params) + removed


def update_text(proposal: Proposal) -> str:
    """The Update's line, from a fixed template: never the agent's note
    (that is the bar's), as an asset proposal's never is."""
    agent = proposal.agent.name
    count = change_count(proposal.spec, removed=len(proposal.removed_edges))
    if count == 0:
        return f"{agent} proposes a run on the canvas"
    return f"{agent} proposes {count} change{'' if count == 1 else 's'} on the canvas"


# How the Update reads once its proposal closed, in place of Review. A
# restart's line is asset_proposals.RESTART_OUTCOME (main settles it).
_OUTCOMES = {"accepted": "Accepted", "rejected": "Rejected", "expired": "Expired",
             "invalidated": "No longer fits"}


def update_outcome(proposal: Proposal) -> str:
    """Short, never the person's reason: "Accepted", "Rejected", "Expired",
    "Withdrawn by <agent>" or "No longer fits" (a node it needed was
    deleted, the canvas was cleared or replaced, or what it changes was
    edited since)."""
    if proposal.status == "withdrawn":
        return f"Withdrawn by {proposal.agent.name}"
    return _OUTCOMES.get(proposal.status, "No longer fits")


canvas_proposals = ProposalBook()
