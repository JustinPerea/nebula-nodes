"""Run approvals: what the person's Accept click approved, value for value.

Accepting a proposal that lists runs is the person's approval to run those
nodes now, outside the agent spending limits (the canvas starts the run
itself, as the person). That approval has to cover the values that run, not
just the node ids. Otherwise an agent that sees the proposal close can change
an accepted node's model, size or inputs in the moment before the canvas
starts it, and the person-exempt run would use the agent's new values.

So on accept the backend records a fingerprint of the run set: for every node
the run can start (the run targets and everything that feeds them), its
definitionId, its params and its incoming wires. The accept response returns
the approval id; the canvas sends it with the run it starts for those nodes,
including a run held back because another was going ("deferred").

While an approval is waiting:

- Nothing but the person may change a node in its run set. ``main`` stages
  each agent edit on a copy of the graph and refuses it (409) when any open
  approval's fingerprint would change: params, deletes, and wires into the
  set all count.
- The run that carries the id must be the person's, must start exactly the
  approved nodes with the approved wires, and the live graph must still match
  the fingerprint. Anything else is refused ("changed since you accepted"),
  and the person can look at the node and run it themselves.

An approval is single-use: the run that carries it uses it up, matched or
not, and the locks lift. It also ends when the person dismisses the held run,
when the canvas is replaced or cleared, or after ``APPROVAL_TTL_SECONDS``.

Memory-only, like proposals: a restart drops every approval, which only means
a held run is refused and the person starts it by hand.
"""
from __future__ import annotations

import hashlib
import json
import secrets
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping

from services import pending_nodes

APPROVAL_TTL_SECONDS = 1800
MAX_APPROVALS = 50


def _canonical(value: Any) -> Any:
    """JSON-stable form: sorted keys, and 4.0 written like 4 (both mean the same)."""
    if isinstance(value, bool) or value is None or isinstance(value, (int, str)):
        return value
    if isinstance(value, float):
        return int(value) if value.is_integer() else value
    if isinstance(value, Mapping):
        return {str(key): _canonical(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_canonical(item) for item in value]
    return str(value)


def run_scope(edges: Iterable[Mapping[str, Any]], run_ids: Iterable[str]) -> set[str]:
    """The run targets plus every node that feeds them, following wires backwards."""
    feeds: dict[str, list[str]] = {}
    for edge in edges:
        feeds.setdefault(str(edge.get("target")), []).append(str(edge.get("source")))
    scope: set[str] = set()
    stack = [str(node_id) for node_id in run_ids]
    while stack:
        node_id = stack.pop()
        if node_id in scope:
            continue
        scope.add(node_id)
        stack.extend(feeds.get(node_id, []))
    return scope


def _inputs(edges: Iterable[Mapping[str, Any]], node_id: str, name: Callable[[str], str]) -> list[list[str]]:
    return sorted(
        [name(str(edge.get("source"))), str(edge.get("sourceHandle")), str(edge.get("targetHandle"))]
        for edge in edges
        if str(edge.get("target")) == node_id
    )


def shape(
    nodes: Mapping[str, Mapping[str, Any]],
    edges: list[Mapping[str, Any]],
    scope: Iterable[str],
    name: Callable[[str], str] = str,
) -> dict[str, list[Any]]:
    """Per node in scope: [definitionId, incoming wires]. No params."""
    return {
        name(node_id): [
            str((nodes.get(node_id) or {}).get("definitionId") or "") if node_id in nodes else None,
            _inputs(edges, node_id, name),
        ]
        for node_id in scope
    }


def fingerprint(
    nodes: Mapping[str, Mapping[str, Any]],
    edges: list[Mapping[str, Any]],
    run_ids: Iterable[str],
    name: Callable[[str], str] = str,
) -> dict[str, str]:
    """A digest per node a run of ``run_ids`` can start: definitionId, params,
    connections in, and whose placeholder it is.

    ``nodes`` maps id -> {definitionId, params, ...}; ``edges`` are
    {source, sourceHandle, target, targetHandle}. ``name`` renames ids (a
    proposal's new nodes get different ids each time it is staged, so the
    pre-accept comparison names them by their refs). Outputs, positions and
    labels are left out: they don't change what a run does. A placeholder
    does (Q125 item 3): the run skips it and what needs it, so its owner is
    in the digest and a placeholder turned normal since (its owner's
    ``pending: false``, the idle rule) changes what the run would start and
    spend: the proposal's Accept and the approved run both refuse it.
    """
    scope = run_scope(edges, run_ids)
    result: dict[str, str] = {}
    for node_id in scope:
        node = nodes.get(node_id)
        payload: Any = None if node is None else {
            "definitionId": str(node.get("definitionId") or ""),
            "params": _canonical(node.get("params") or {}),
            "inputs": _inputs(edges, node_id, name),
        }
        owner = None if node is None else pending_nodes.owner(node)
        if owner is not None:
            payload["pending"] = owner["id"]
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=True)
        result[name(node_id)] = hashlib.sha256(encoded.encode("utf-8")).hexdigest()
    return result


def changed_nodes(approved: Mapping[str, str], now: Mapping[str, str]) -> list[str]:
    """Node names whose digest differs, appeared or disappeared, sorted."""
    return sorted(key for key in set(approved) | set(now) if approved.get(key) != now.get(key))


@dataclass
class RunApproval:
    id: str
    proposal_id: str
    agent_name: str
    run_node_ids: list[str]
    fingerprint: dict[str, str]
    shape: dict[str, list[Any]]
    expires_at: float


class RunApprovals:
    """Open approvals, keyed by an unguessable id that only the person's canvas receives."""

    def __init__(self, clock: Callable[[], float] = time.time, ttl: float = APPROVAL_TTL_SECONDS) -> None:
        self._clock = clock
        self._ttl = ttl
        self._items: OrderedDict[str, RunApproval] = OrderedDict()

    def grant(
        self,
        *,
        proposal_id: str,
        agent_name: str,
        run_node_ids: list[str],
        fingerprint: dict[str, str],
        shape: dict[str, list[Any]],
    ) -> RunApproval:
        approval = RunApproval(
            id="ra_" + secrets.token_urlsafe(18),
            proposal_id=proposal_id,
            agent_name=agent_name,
            run_node_ids=list(run_node_ids),
            fingerprint=dict(fingerprint),
            shape=dict(shape),
            expires_at=self._clock() + self._ttl,
        )
        self._items[approval.id] = approval
        while len(self._items) > MAX_APPROVALS:
            self._items.popitem(last=False)
        return approval

    def _sweep(self) -> None:
        now = self._clock()
        for approval_id in [key for key, item in self._items.items() if item.expires_at <= now]:
            del self._items[approval_id]

    def open_list(self) -> list[RunApproval]:
        self._sweep()
        return list(self._items.values())

    def take(self, approval_id: str) -> RunApproval | None:
        """Use an approval up. None when unknown, already used or expired."""
        self._sweep()
        return self._items.pop(approval_id, None)

    def drop(self, approval_id: str) -> bool:
        return self._items.pop(approval_id, None) is not None

    def clear(self) -> None:
        self._items.clear()
