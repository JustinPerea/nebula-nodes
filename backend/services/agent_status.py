"""What each agent is working on, and the roster of agents around now.

Q125 item 2 (Justin, 2026-10-24: "Yes, all four, in that order"): the Agents
panel, Needs you / Working. Built from what Nebula already tracks, plus one
new thing kept here: a status line per agent.

- An identified agent sets one line of text about what it is doing,
  optionally on a node (``set_status``, ``nebula status``, ``POST
  /api/canvas/status``). The text is cleaned like a cursor's ``say``
  (whitespace collapsed, at most MAX_STATUS_CHARS, a longer one cut to end
  in "…"); empty text clears it.
  The browser and anonymous callers have no identity, so they can't set
  one, and an agent sets only its own (the route takes no agent name).
- It lasts until the agent replaces or clears it, or until
  STATUS_IDLE_SECONDS pass with no sign of that agent. A sign is any
  identified request (agent_presence.RequestHeadersContext calls ``saw``
  for each one): a status set, a cursor move, a graph edit, a run, a
  question or a proposal.
- In memory only, like cursors: a restart clears every status (open
  questions are kept with their project; proposals have their own rules).
  Each status belongs to the project that was open when it was set, and
  only that project's roster shows it. Node ids restart per graph, so a
  node delete (``forget_node``) or a graph replace, which a project switch
  is (``forget_graph``), drops the node and keeps the text.
- Every change is an ``agentStatus`` event for every socket, so the panel
  updates without polling: set, cleared, expired, unanchored.

The roster (``build_roster``) is one read for the panel and for agents
(``list_agents``, ``nebula agents``, ``GET /api/canvas/agents``): one entry
per agent that is around in the open project (a live cursor there, a live
status there, or an open question set or proposal there), with its status,
its cursor's last action, and how many questions and proposals wait for the
person. Counts only: never the text of another agent's questions, the
person's answers, or a proposal's note, and never a cursor's ``say`` (a
proposal's cursor says its note).
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any, Callable, Iterable, Mapping

from services.agent_presence import MAX_SAY_CHARS, AgentIdentity

STATUS_IDLE_SECONDS = 600.0
MAX_STATUS_CHARS = MAX_SAY_CHARS


class StatusError(ValueError):
    """A status the backend refuses (422)."""


def clean_status_text(raw: Any) -> str:
    """One line, like a cursor's ``say``: whitespace collapsed, at most
    MAX_STATUS_CHARS. A longer one is cut and ends in "…", so the pill that
    shows it whole (GM - Design, round 6: "let it wrap until the whole status
    shows") never ends mid-word as if that were all of it."""
    if not isinstance(raw, str):
        raise StatusError("text must be text: one line about what you're working on (\"\" clears it)")
    text = " ".join(raw.split())
    if len(text) <= MAX_STATUS_CHARS:
        return text
    return text[:MAX_STATUS_CHARS - 1].rstrip() + "…"


@dataclass
class AgentStatus:
    agent: AgentIdentity
    text: str
    node_id: str | None
    project_id: str | None
    set_at: float


class AgentStatusBook:
    """Each agent's status line and when each agent was last seen."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._statuses: dict[str, AgentStatus] = {}
        self._seen: dict[str, float] = {}
        # Rises with every change, so a reader can tell a roster read from
        # before an event it already applied (the panel's store does).
        self.revision = 0

    def now(self) -> float:
        return self._clock()

    # -- signs ----------------------------------------------------------------
    def saw(self, identity: AgentIdentity) -> None:
        """Any identified request: the agent is still there."""
        now = self._clock()
        self._seen[identity.id] = now
        # Agents with no status are remembered only as long as it matters.
        for agent_id in [key for key, at in self._seen.items()
                         if key not in self._statuses and now - at > STATUS_IDLE_SECONDS]:
            del self._seen[agent_id]

    def last_seen(self, agent_id: str) -> float | None:
        """When this agent last gave a sign (placeholders use the same idle
        rule: services/pending_nodes.py), or None when it gave none lately."""
        return self._seen.get(agent_id)

    def _last_sign(self, status: AgentStatus) -> float:
        return max(status.set_at, self._seen.get(status.agent.id, status.set_at))

    # -- the line -------------------------------------------------------------
    def set(self, identity: AgentIdentity, text: Any, *, node_id: str | None,
            project_id: str | None) -> list[dict[str, Any]]:
        """Set, replace or (with empty text) clear the agent's own line. The
        caller checked the node is on the canvas. Returns the events to send."""
        clean = clean_status_text(text)
        now = self._clock()
        self._seen[identity.id] = now
        if not clean:
            if self._statuses.pop(identity.id, None) is None:
                return []
            return [self._event(identity, None, "cleared")]
        status = AgentStatus(agent=identity, text=clean, node_id=node_id, project_id=project_id, set_at=now)
        self._statuses[identity.id] = status
        return [self._event(identity, status, "set")]

    def get(self, agent_id: str) -> AgentStatus | None:
        return self._statuses.get(agent_id)

    def for_project(self, project_id: str | None) -> list[AgentStatus]:
        return [status for status in self._statuses.values() if status.project_id == project_id]

    # -- expiry ----------------------------------------------------------------
    def next_deadline(self) -> float | None:
        """When the next status runs out, if no sign comes first."""
        deadlines = [self._last_sign(status) + STATUS_IDLE_SECONDS for status in self._statuses.values()]
        return min(deadlines) if deadlines else None

    def sweep(self) -> list[dict[str, Any]]:
        """Drop the statuses whose agent gave no sign for STATUS_IDLE_SECONDS."""
        now = self._clock()
        events = []
        for agent_id, status in list(self._statuses.items()):
            if now - self._last_sign(status) > STATUS_IDLE_SECONDS:
                del self._statuses[agent_id]
                events.append(self._event(status.agent, None, "expired"))
        return events

    # -- the canvas changed under it ----------------------------------------------
    def forget_node(self, node_id: str) -> list[dict[str, Any]]:
        """A deleted node: the lines on it stay, without it."""
        return self._unanchor(lambda status: status.node_id == node_id)

    def forget_graph(self) -> list[dict[str, Any]]:
        """A cleared or replaced graph (a project switch is one): node ids
        start again, so no line keeps a node."""
        return self._unanchor(lambda status: status.node_id is not None)

    def _unanchor(self, hit: Callable[[AgentStatus], bool]) -> list[dict[str, Any]]:
        events = []
        for status in self._statuses.values():
            if hit(status):
                status.node_id = None
                events.append(self._event(status.agent, status, "unanchored"))
        return events

    # -- what readers get --------------------------------------------------------------
    def view(self, status: AgentStatus) -> dict[str, Any]:
        return {"text": status.text, "nodeId": status.node_id, "projectId": status.project_id,
                "at": int(status.set_at * 1000), "secondsAgo": round(self._clock() - status.set_at, 1)}

    def _event(self, identity: AgentIdentity, status: AgentStatus | None, change: str) -> dict[str, Any]:
        self.revision += 1
        return {"type": "agentStatus", "agent": identity.as_dict(),
                "status": self.view(status) if status is not None else None,
                "change": change, "rev": self.revision}


# -- the roster ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Waiting:
    """One open item that needs the person: who it is from and since when."""
    agent: AgentIdentity
    kind: str  # "question" | "proposal"
    created_at: float
    # How many it counts for: a question set counts its questions (as its
    # Update says "has 2 questions"); a proposal counts 1.
    count: int = 1


def _identity(raw: Mapping[str, Any]) -> AgentIdentity:
    return AgentIdentity(id=str(raw.get("id")), name=str(raw.get("name")), color=str(raw.get("color")),
                         verified=bool(raw.get("verified")))


def build_roster(*, project_id: str | None, now: float, cursors: Iterable[Mapping[str, Any]],
                 statuses: Iterable[AgentStatus], waiting: Iterable[Waiting],
                 status_view: Callable[[AgentStatus], dict[str, Any]],
                 pending: Mapping[str, Mapping[str, Any]] | None = None,
                 running: Iterable[tuple[AgentIdentity, list[dict[str, Any]]]] = ()) -> list[dict[str, Any]]:
    """One entry per agent around in ``project_id``, Needs you first (longest
    wait first), then Working (most recent activity first).

    ``cursors`` are agent_presence.active() rows (each with its projectId);
    ``statuses`` and ``waiting`` are already the open project's. ``pending``
    is the open canvas's placeholders by agent (pending_nodes.by_agent) and
    ``running`` each agent's nodes running now in its runs (Q125 item 3):
    every entry lists both, and an agent with only placeholders is listed."""
    entries: dict[str, dict[str, Any]] = {}

    def entry_for(identity: AgentIdentity) -> dict[str, Any]:
        found = entries.get(identity.id)
        if found is None:
            found = entries[identity.id] = {
                "agent": identity.as_dict(), "group": "working", "status": None, "lastAction": None,
                "cursor": None, "needsYou": {"questions": 0, "proposals": 0}, "waitingSeconds": None,
                "activeSecondsAgo": None, "_waitingSince": None, "pending": [], "running": [],
            }
        return found

    def active(entry: dict[str, Any], seconds_ago: float) -> None:
        current = entry["activeSecondsAgo"]
        entry["activeSecondsAgo"] = seconds_ago if current is None else min(current, seconds_ago)

    for cursor in cursors:
        if cursor.get("projectId") != project_id:
            continue
        entry = entry_for(_identity(cursor))
        seconds_ago = float(cursor.get("secondsAgo") or 0.0)
        target = cursor.get("target") or {}
        entry["cursor"] = {"nodeId": target.get("nodeId"), "action": cursor.get("action"), "secondsAgo": seconds_ago}
        did = cursor.get("did")
        if isinstance(did, Mapping) and did.get("verb"):
            # The action's own time: a gesture since then kept it (GM's review).
            did_ago = did.get("secondsAgo")
            entry["lastAction"] = {"verb": did["verb"], "nodeId": did.get("nodeId"), "label": did.get("label"),
                                   "secondsAgo": float(did_ago) if isinstance(did_ago, (int, float)) else seconds_ago}
        active(entry, seconds_ago)

    for status in statuses:
        entry = entry_for(status.agent)
        view = status_view(status)
        entry["status"] = {"text": view["text"], "nodeId": view["nodeId"], "secondsAgo": view["secondsAgo"]}
        active(entry, view["secondsAgo"])

    for agent, nodes in running:
        entry = entry_for(agent)
        entry["running"] = [dict(node) for node in nodes]
        active(entry, 0.0)

    for mine in (pending or {}).values():
        entry = entry_for(_identity(mine["agent"]))
        entry["pending"] = list(mine["nodeIds"])

    for item in waiting:
        entry = entry_for(item.agent)
        entry["needsYou"]["questions" if item.kind == "question" else "proposals"] += item.count
        entry["group"] = "needsYou"
        since = entry["_waitingSince"]
        entry["_waitingSince"] = item.created_at if since is None else min(since, item.created_at)

    for entry in entries.values():
        since = entry["_waitingSince"]
        if since is not None:
            entry["waitingSeconds"] = round(max(0.0, now - since), 1)

    # Needs you on the exact time it began waiting (the panel's order), not the
    # rounded wait, so waits a few ms apart don't tie and fall back to names.
    def order(entry: dict[str, Any]) -> tuple:
        if entry["group"] == "needsYou":
            since = entry["_waitingSince"]
            return (0, since if since is not None else float("inf"), entry["agent"]["name"].lower())
        ago = entry["activeSecondsAgo"]
        return (1, ago if ago is not None else float("inf"), entry["agent"]["name"].lower())

    ordered = sorted(entries.values(), key=order)
    for entry in ordered:
        entry.pop("_waitingSince", None)
    return ordered
