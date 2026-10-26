"""Placeholders: nodes an agent is still setting up (Q125 item 3).

Justin, 2026-10-24, merge-oks Q125 ("Yes, all four, in that order"), item 3:
"The agent stays on the node it's working on, and reserves the spot ... A
node an agent is about to fill shows as a placeholder in its colour."
GM - Design, 2026-10-25: "A dashed outline in the agent's color: OK. Dashed
means pending; the color says whose."

The flag lives on the canvas node (``cli_graph.nodes[id]["pending"]``) with
the owning agent's identity, so it is saved with the graph and the project
(the React Flow node carries it as ``data.pending``) and survives a reload.
Old graphs have none. Shape: ``{"agent": {id, name, color, verified}, "at":
epoch ms}``.

Only an agent's edit makes a node pending, and only the nodes that edit adds
(edit_canvas / `nebula apply` with ``pending: true``). No agent marks an
existing node or the person's node. A pending node turns normal, and nothing
is ever deleted by any of these:

- the owning agent runs it, or says ``pending: false`` for it;
- the owning agent goes quiet for IDLE_SECONDS (the status line's rule,
  services/agent_status.py: any identified request is a sign);
- the person edits it in any way (params, name, position, a connection to or from it);
- the person runs it directly (GM: "counts as their edit").

Another agent can't clear or claim it. A run skips pending nodes, and every
node downstream that takes their output, on every way to run (``run_skips``),
and reports them in ``skipped`` like a gate's skips. Nothing is spent on them.
"""
from __future__ import annotations

import re
from collections import deque
from typing import Any, Callable, Iterable, Mapping

from services.agent_presence import AgentIdentity
from services.agent_status import STATUS_IDLE_SECONDS

PENDING_KEY = "pending"
IDLE_SECONDS = STATUS_IDLE_SECONDS

_COLOR = re.compile(r"^#[0-9A-Fa-f]{6}$")


class PendingError(Exception):
    """A pending change the backend refuses: ``status`` for HTTP."""

    def __init__(self, status: int, detail: str) -> None:
        super().__init__(detail)
        self.status = status
        self.detail = detail


def make(identity: AgentIdentity, now: float) -> dict[str, Any]:
    return {"agent": identity.as_dict(), "at": int(now * 1000)}


def clean(raw: Any) -> dict[str, Any] | None:
    """A stored or sent flag, kept only when well formed (a saved project, an
    undo step): an agent's id, name, #rrggbb colour and verified, and when."""
    if not isinstance(raw, Mapping):
        return None
    agent = raw.get("agent")
    if not isinstance(agent, Mapping):
        return None
    agent_id, name, color = agent.get("id"), agent.get("name"), agent.get("color")
    if not isinstance(agent_id, str) or not 0 < len(agent_id) <= 128:
        return None
    if not isinstance(name, str) or not name.strip():
        return None
    if not isinstance(color, str) or not _COLOR.fullmatch(color):
        return None
    at = raw.get("at")
    if isinstance(at, bool) or not isinstance(at, (int, float)) or at < 0:
        at = 0
    return {"agent": {"id": agent_id, "name": " ".join(name.split())[:40], "color": color,
                      "verified": agent.get("verified") is True},
            "at": int(at)}


def owner(node: Mapping[str, Any] | None) -> dict[str, Any] | None:
    """The agent a pending node belongs to (``{id, name, color, verified}``), or None."""
    flag = clean((node or {}).get(PENDING_KEY))
    return flag["agent"] if flag is not None else None


def is_pending(node: Mapping[str, Any] | None) -> bool:
    return owner(node) is not None


def pending_ids(nodes: Mapping[str, Mapping[str, Any]]) -> list[str]:
    return [node_id for node_id, node in nodes.items() if is_pending(node)]


def mark(nodes: Mapping[str, dict[str, Any]], node_ids: Iterable[str], identity: AgentIdentity,
         now: float) -> list[str]:
    """Make ``node_ids`` (the nodes an agent's edit just added) the agent's placeholders."""
    marked = []
    for node_id in node_ids:
        node = nodes.get(node_id)
        if node is not None:
            node[PENDING_KEY] = make(identity, now)
            marked.append(node_id)
    return marked


def clear(nodes: Mapping[str, dict[str, Any]], node_ids: Iterable[str]) -> list[str]:
    """Turn these nodes normal (any that were pending); the ids that changed."""
    cleared = []
    for node_id in dict.fromkeys(node_ids):
        node = nodes.get(node_id)
        if node is not None and PENDING_KEY in node:
            had = is_pending(node)
            del node[PENDING_KEY]
            if had:
                cleared.append(node_id)
    return cleared


def clear_owned(nodes: Mapping[str, dict[str, Any]], node_ids: Iterable[str], agent_id: str) -> list[str]:
    """The owning agent's run: its own pending nodes among ``node_ids`` turn normal."""
    return clear(nodes, [node_id for node_id in node_ids if (owner(nodes.get(node_id)) or {}).get("id") == agent_id])


def check_ready(nodes: Mapping[str, Mapping[str, Any]], node_ids: Iterable[str],
                identity: AgentIdentity) -> tuple[list[str], list[str]]:
    """``pending: false`` from an agent: (its own pending nodes to clear, ids
    that weren't pending). Refuses the whole call (nothing changes) for a node
    that isn't on the canvas or is another agent's placeholder."""
    mine: list[str] = []
    not_pending: list[str] = []
    for node_id in dict.fromkeys(node_ids):
        node = nodes.get(node_id)
        if node is None:
            raise PendingError(404, f"{node_id} is not on the canvas")
        who = owner(node)
        if who is None:
            not_pending.append(node_id)
        elif who["id"] != identity.id:
            raise PendingError(403, (
                f"{node_id} is {who['name']}'s placeholder: only {who['name']} makes it ready (or the person, "
                "by editing or running it). Nothing changed."))
        else:
            mine.append(node_id)
    return mine, not_pending


# -- runs -----------------------------------------------------------------------------

def pending_reason(agent_name: str) -> str:
    """A skipped placeholder's reason: GM - Design's tooltip line, 2026-10-25,
    which the canvas shows as "Skipped: Codex is still setting this up."."""
    return f"{agent_name} is still setting this up."


def downstream_reason(root_label: str, agent_name: str) -> str:
    """A node downstream of a placeholder: GM - Design's round-4 line,
    2026-10-25, verbatim ("needs “Hero prompt”, which Codex is still setting
    up."), naming the placeholder by its name (its type's name when it has
    no label; the caller's ``label``), never its id."""
    return f"needs “{root_label}”, which {agent_name} is still setting up."


def run_skips(scope: Iterable[str], edges: Iterable[tuple[str, str]], nodes: Mapping[str, Mapping[str, Any]],
              label: Callable[[str], str], *, ready: Iterable[str] = ()) -> dict[str, dict[str, Any]]:
    """The nodes a run must skip: each pending node in ``scope``, and every
    node in scope downstream of one (connected from it, directly or further on).
    ``edges`` are (source, target) pairs. ``ready`` are placeholders this run
    turns normal once it is admitted (its owner's run, the person's direct
    run): they count as normal here, though nothing changes until then. Per
    node: ``reason`` (for agents), ``agent`` (the placeholder's owner) and
    ``root`` (the pending node)."""
    in_scope = list(dict.fromkeys(scope))
    allowed = set(in_scope)
    made_ready = set(ready)
    out: dict[str, list[str]] = {}
    for source, target in edges:
        if source in allowed and target in allowed:
            out.setdefault(source, []).append(target)
    skips: dict[str, dict[str, Any]] = {}
    roots = [node_id for node_id in in_scope if node_id not in made_ready and is_pending(nodes.get(node_id))]
    for root in roots:
        who = owner(nodes.get(root)) or {}
        skips[root] = {"reason": pending_reason(str(who.get("name"))), "agent": who, "root": root}
    queue = deque(roots)
    while queue:
        current = queue.popleft()
        root = skips[current]["root"]
        who = skips[root]["agent"]
        for child in out.get(current, []):
            if child in skips:
                continue
            skips[child] = {"reason": downstream_reason(label(root), str(who.get("name"))),
                            "agent": who, "root": root}
            queue.append(child)
    return skips


def skip_summary(skips: Mapping[str, Mapping[str, Any]]) -> dict[str, Any] | None:
    """What the canvas says after Run: how many nodes it skipped and whose
    placeholders they wait on (names, in order). None when nothing was skipped."""
    if not skips:
        return None
    names: list[str] = []
    for info in skips.values():
        name = str((info.get("agent") or {}).get("name") or "")
        if name and name not in names:
            names.append(name)
    return {"count": len(skips), "agents": names}


def skip_line(summary: Mapping[str, Any] | None) -> str | None:
    """GM - Design's line for a run that skipped placeholders (2026-10-25,
    verbatim): "Skipped 1 node Codex is still setting up.", "Skipped 3 nodes
    Codex is still setting up.", "Skipped 3 nodes agents are still setting
    up.": the agent named when every skipped node is one agent's (downstream
    nodes count toward the agent whose placeholder blocked them). The canvas
    has its twin (frontend lib/pendingNodes.ts pendingSkipLine)."""
    count = int((summary or {}).get("count") or 0)
    if count < 1:
        return None
    agents = [str(name) for name in (summary or {}).get("agents") or [] if name]
    who = f"{agents[0]} is" if len(agents) == 1 else "agents are"
    return f"Skipped {count} node{'' if count == 1 else 's'} {who} still setting up."


# -- the idle rule ----------------------------------------------------------------------------

def _last_sign(node: Mapping[str, Any], last_seen: Callable[[str], float | None]) -> float | None:
    flag = clean(node.get(PENDING_KEY))
    if flag is None:
        return None
    marked = flag["at"] / 1000.0
    seen = last_seen(flag["agent"]["id"])
    return marked if seen is None else max(marked, seen)


def next_deadline(nodes: Mapping[str, Mapping[str, Any]], last_seen: Callable[[str], float | None]) -> float | None:
    deadlines = [sign + IDLE_SECONDS for node in nodes.values()
                 if (sign := _last_sign(node, last_seen)) is not None]
    return min(deadlines) if deadlines else None


def expired(nodes: Mapping[str, Mapping[str, Any]], last_seen: Callable[[str], float | None],
            now: float) -> list[str]:
    """Pending nodes whose agent gave no sign for IDLE_SECONDS."""
    return [node_id for node_id, node in nodes.items()
            if (sign := _last_sign(node, last_seen)) is not None and now - sign > IDLE_SECONDS]


def by_agent(nodes: Mapping[str, Mapping[str, Any]]) -> dict[str, dict[str, Any]]:
    """Each agent's pending nodes (the roster's ``pending``): {agent id: {agent, nodeIds}}."""
    found: dict[str, dict[str, Any]] = {}
    for node_id, node in nodes.items():
        who = owner(node)
        if who is not None:
            found.setdefault(who["id"], {"agent": who, "nodeIds": []})["nodeIds"].append(node_id)
    return found


__all__ = [
    "IDLE_SECONDS", "PENDING_KEY", "PendingError", "by_agent", "check_ready", "clean", "clear", "clear_owned",
    "downstream_reason", "expired", "is_pending", "make", "mark", "next_deadline", "owner", "pending_ids",
    "pending_reason", "run_skips", "skip_line", "skip_summary",
]
