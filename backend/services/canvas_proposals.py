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

Cost: Nebula has no price list (``node_definitions.json`` has no price or
credit fields), so no amount is ever shown. Each node is ``free`` (a local
utility node) or ``paid`` (a provider call, labelled with the provider), and
``estimate`` is always None.

Memory-only: open and recently decided proposals are lost on restart.
"""
from __future__ import annotations

import copy
import re
import secrets
import time
from collections import OrderedDict
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping

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
CLOSED_KEEP_SECONDS = 1800
MAX_CLOSED = 50
COORD_LIMIT = 1e7
# How much of one proposed value the person's decision bar shows. Longer text
# is cut with an explicit "N more characters" marker, never silently.
PERSON_VALUE_CHARS = 4000

REF_RE = re.compile(r"^\+[A-Za-z0-9_-]{1,24}$")
NODE_ID_RE = re.compile(r"^n\d{1,9}$")
_ALLOWED_KEYS = frozenset({"note", "nodes", "edges", "params", "run"})

OPEN = "open"
CLOSED_STATUSES = frozenset({"accepted", "rejected", "withdrawn", "expired", "invalidated"})

COST_NOTE = "Nebula has no price list, so no amount is shown. Paid runs bill your provider account."


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


def _point(raw: Any, label: str) -> dict[str, float]:
    if not isinstance(raw, Mapping):
        raise ProposalError(422, f"{label} must be an object with x and y")
    result: dict[str, float] = {}
    for axis in ("x", "y"):
        value = raw.get(axis)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ProposalError(422, f"{label}.{axis} must be a number")
        number = float(value)
        if number != number or abs(number) >= COORD_LIMIT:
            raise ProposalError(422, f"{label}.{axis} must be a finite canvas coordinate")
        result[axis] = round(number, 2)
    return result


def _list(body: Mapping[str, Any], key: str, cap: int) -> list[Any]:
    value = body.get(key)
    if value is None:
        return []
    if not isinstance(value, list):
        raise ProposalError(422, f"{key} must be a list")
    if len(value) > cap:
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


def _handle(raw: Any, label: str) -> str:
    if not isinstance(raw, str) or not raw.strip() or len(raw) > MAX_HANDLE:
        raise ProposalError(422, f"{label} must be a port id")
    return raw


def _params(raw: Any, label: str) -> dict[str, Any]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ProposalError(422, f"{label} must be an object")
    for key in raw:
        if not isinstance(key, str) or not key:
            raise ProposalError(422, f"{label} keys must be text")
        # Underscore keys are the editor's own bookkeeping (_previewUrl, ...).
        if key.startswith("_"):
            raise ProposalError(422, f"{label}.{key[:40]} is internal and can't be proposed")
    return dict(raw)


def parse_spec(body: Any) -> ProposalSpec:
    """Shape-check and sanitise a proposal body. Graph validation happens in main."""
    if not isinstance(body, dict):
        raise ProposalError(422, "the proposal must be a JSON object")
    unknown = sorted(set(body) - _ALLOWED_KEYS)
    if unknown:
        raise ProposalError(422, f"unknown proposal field '{str(unknown[0])[:40]}'")
    note = clean_note(body.get("note"))

    nodes: list[ProposedNode] = []
    refs: set[str] = set()
    for index, raw in enumerate(_list(body, "nodes", MAX_NODES)):
        if not isinstance(raw, dict):
            raise ProposalError(422, f"nodes[{index}] must be an object")
        ref = raw.get("ref")
        if not isinstance(ref, str) or not REF_RE.fullmatch(ref):
            raise ProposalError(422, f"nodes[{index}].ref must look like +up (letters, digits, - or _)")
        if ref in refs:
            raise ProposalError(400, f"duplicate ref '{ref}'")
        refs.add(ref)
        definition_id = raw.get("definitionId")
        if not isinstance(definition_id, str) or not definition_id or len(definition_id) > 128:
            raise ProposalError(422, f"nodes[{index}].definitionId must be a node definition id")
        position = raw.get("position")
        nodes.append(ProposedNode(
            ref=ref,
            definition_id=definition_id,
            params=_params(raw.get("params"), f"nodes[{index}].params"),
            position=_point(position, f"nodes[{index}].position") if position is not None else None,
        ))

    edges: list[ProposedEdge] = []
    for index, raw in enumerate(_list(body, "edges", MAX_EDGES)):
        if not isinstance(raw, dict):
            raise ProposalError(422, f"edges[{index}] must be an object")
        edges.append(ProposedEdge(
            source=_end(raw.get("source"), refs, f"edges[{index}].source"),
            source_handle=_handle(raw.get("sourceHandle"), f"edges[{index}].sourceHandle"),
            target=_end(raw.get("target"), refs, f"edges[{index}].target"),
            target_handle=_handle(raw.get("targetHandle"), f"edges[{index}].targetHandle"),
        ))

    changes: list[ParamChange] = []
    seen_nodes: set[str] = set()
    for index, raw in enumerate(_list(body, "params", MAX_PARAM_NODES)):
        if not isinstance(raw, dict):
            raise ProposalError(422, f"params[{index}] must be an object")
        node_id = raw.get("nodeId")
        if not isinstance(node_id, str) or not NODE_ID_RE.fullmatch(node_id):
            raise ProposalError(422, f"params[{index}].nodeId must be an existing node id like n4")
        if node_id in seen_nodes:
            raise ProposalError(400, f"params lists {node_id} twice; merge the changes")
        seen_nodes.add(node_id)
        params = _params(raw.get("params"), f"params[{index}].params")
        if not params:
            raise ProposalError(422, f"params[{index}].params must set at least one key")
        changes.append(ParamChange(node_id=node_id, params=params))

    run: list[str] = []
    for index, raw in enumerate(_list(body, "run", MAX_RUN)):
        item = _end(raw, refs, f"run[{index}]")
        if item in run:
            raise ProposalError(400, f"run lists '{item}' twice")
        run.append(item)

    if not (nodes or edges or changes or run):
        raise ProposalError(422, "a proposal needs at least one node, wire, param change or run")
    return ProposalSpec(note=note, nodes=tuple(nodes), edges=tuple(edges), params=tuple(changes), run=tuple(run))


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

def cost_for(definition: Mapping[str, Any] | None) -> dict[str, Any]:
    """`free` for local utility nodes, else `paid` with the provider. No prices exist."""
    provider = str((definition or {}).get("apiProvider") or "") or None
    if provider == "utility":
        return {"kind": "free", "provider": None, "label": "free · runs locally"}
    return {"kind": "paid", "provider": provider, "label": f"paid · {provider or 'provider'}"}


def summarize_cost(entries: list[dict[str, Any]], *, up_to: bool) -> dict[str, Any]:
    """The proposal's run set: each entry is {ref, nodeId, kind, provider, label}."""
    paid = sum(1 for entry in entries if entry.get("kind") == "paid")
    providers = sorted({str(entry["provider"]) for entry in entries if entry.get("kind") == "paid" and entry.get("provider")})
    return {
        "paidRuns": paid,
        "freeRuns": len(entries) - paid,
        "estimate": None,
        "upTo": up_to,
        "providers": providers,
        "nodes": entries,
        "note": COST_NOTE,
    }


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
        for node in spec.nodes:
            definition = definitions.get(node.definition_id, {}) if isinstance(definitions, dict) else {}
            nodes.append({
                "ref": node.ref,
                "definitionId": node.definition_id,
                "name": str(definition.get("displayName") or node.definition_id),
                "category": str(definition.get("category") or ""),
                "params": safe_value(node.params, key="params"),
                "position": dict(proposal.positions.get(node.ref) or node.position or {"x": 0.0, "y": 0.0}),
                "cost": cost_for(definition),
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
        """The one-line form `nebula look` lists."""
        return {
            "id": proposal.id,
            "agent": proposal.agent.name,
            "note": proposal.spec.note,
            "status": proposal.status,
            "expiresInSeconds": max(0, int(proposal.expires_at - self._clock())),
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
