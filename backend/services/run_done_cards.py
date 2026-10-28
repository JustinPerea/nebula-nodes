"""Agents' runs: the mark on the node they run, and the done card after (Q125 item 3).

Justin, 2026-10-24, merge-oks Q125, item 3: "The agent's mark stays on its
node with a status line ("Running FLUX.2 [pro] · 0:41") ... A finished run
posts a card with a thumbnail and Show on canvas, without the agent having to
remember to." GM - Design's rulings, 2026-10-25, are built verbatim here.

``AgentRunBook`` keeps, per run an identified agent started (any route: MCP
run_nodes and `nebula run` through /api/graph/run, or an agent's own
/api/execute or /api/execute-node), who started it, in which project, the
nodes it set out to run in run order, and which of them are running now. In
memory only, like cursors and status lines: a restart ends every run anyway.
Runs the person starts (or an unnamed caller) are not kept: no mark, no card.

Every change to what an agent is running is an ``agentRun`` socket event
(``change``: started, ended), so the canvas draws the mark without polling;
the roster read (GET /api/canvas/agents) carries each agent's ``running``
nodes for a tab that loads mid-run.

``done_text`` is GM's copy for the card; ``thumbnail_for`` picks its picture.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping

from services.agent_presence import AgentIdentity

# A thumbnail is a picture or a video's first frame; text and audio have none.
_THUMB_KINDS = {"image": "image", "video": "video"}


def possessive(name: str) -> str:
    """GM's pattern ("Codex's run of ..."): 's after any name, one ending in s too."""
    return f"{name}'s"


def _quoted(labels: Mapping[str, str], node_id: str) -> str:
    return f"“{labels.get(node_id) or node_id}”"


def done_text(agent_name: str, labels: Mapping[str, str], planned: list[str], *,
              succeeded: Iterable[str], failed: Iterable[str]) -> tuple[str, str]:
    """(the card's line, its outcome: success | partial | failure). GM - Design,
    2026-10-25, verbatim:

    - Success: Codex finished “Hero shots”. / Codex finished 3 nodes.
    - Partial: Codex finished 2 of 3 nodes. “Upscale” failed. With more than
      one failed: Codex finished 2 of 5 nodes. 3 failed.
    - Failure: Codex's run of “Hero shots” failed. / Codex's run of 3 nodes failed.
    """
    done = [node_id for node_id in planned if node_id in set(succeeded)]
    broke = [node_id for node_id in planned if node_id in set(failed)]
    total = len(planned)
    if not done:
        what = _quoted(labels, planned[0]) if total == 1 else f"{total} nodes"
        return f"{possessive(agent_name)} run of {what} failed.", "failure"
    if broke:
        failures = f"{_quoted(labels, broke[0])} failed." if len(broke) == 1 else f"{len(broke)} failed."
        return f"{agent_name} finished {len(done)} of {total} nodes. {failures}", "partial"
    what = _quoted(labels, done[0]) if len(done) == 1 else f"{len(done)} nodes"
    return f"{agent_name} finished {what}.", "success"


def thumbnail_for(outputs: Mapping[str, Any] | None,
                  url_for: Callable[[str], str | None]) -> dict[str, str] | None:
    """The card's picture: the node's first output, when it is an image or a
    video Nebula keeps in its output folder. ``url_for`` is main's
    _output_url_from_ref: the /api/outputs URL of a file inside the output
    folder, None for anything else (a provider's URL, which may be signed, or
    a path elsewhere). Never a copy: the card links the output itself."""
    if not isinstance(outputs, Mapping) or not outputs:
        return None
    first = next(iter(outputs.values()))
    if not isinstance(first, Mapping):
        return None
    kind = _THUMB_KINDS.get(str(first.get("type") or "").lower())
    if kind is None:
        return None
    value = first.get("value")
    if isinstance(value, list):
        value = value[0] if value else None
    if not isinstance(value, str) or not value:
        return None
    url = url_for(value)
    if not url or not url.startswith("/api/outputs/"):
        return None
    return {"kind": kind, "url": url}


@dataclass
class AgentRun:
    run_id: str
    agent: AgentIdentity
    project_id: str | None
    planned: list[str]
    started_at: float
    # Node id -> when it started running (its ExecutingEvent), while it runs.
    running: dict[str, float] = field(default_factory=dict)
    models: dict[str, str] = field(default_factory=dict)
    # How each node ended: its outputs when it ran, or that it failed.
    succeeded: dict[str, Any] = field(default_factory=dict)
    failed: list[str] = field(default_factory=list)


class AgentRunBook:
    """The runs agents started, while they go."""

    def __init__(self, clock: Callable[[], float] = time.time) -> None:
        self._clock = clock
        self._runs: dict[str, AgentRun] = {}

    def now(self) -> float:
        return self._clock()

    def start(self, run_id: str, agent: AgentIdentity, *, project_id: str | None, planned: list[str],
              models: Mapping[str, str] | None = None) -> AgentRun:
        run = AgentRun(run_id=run_id, agent=agent, project_id=project_id, planned=list(planned),
                       started_at=self._clock(), models=dict(models or {}))
        self._runs[run_id] = run
        return run

    def get(self, run_id: str | None) -> AgentRun | None:
        return self._runs.get(run_id) if run_id else None

    def node_started(self, run_id: str | None, node_id: str) -> dict[str, Any] | None:
        run = self.get(run_id)
        if run is None or node_id in run.running:
            return None
        run.running[node_id] = self._clock()
        return self._event(run, node_id, "started")

    def node_ended(self, run_id: str | None, node_id: str, *, failed: bool = False,
                   outputs: Mapping[str, Any] | None = None, ran: bool = True) -> dict[str, Any] | None:
        """The node ended (``ran``: it ran or failed; not for a skip). The
        mark's end event, when it was marked running."""
        run = self.get(run_id)
        if run is None:
            return None
        if ran and failed and node_id not in run.failed:
            run.failed.append(node_id)
            run.succeeded.pop(node_id, None)
        elif ran and not failed:
            run.succeeded[node_id] = dict(outputs or {})
        if node_id not in run.running:
            return None
        event = self._event(run, node_id, "ended")
        del run.running[node_id]
        return event

    def finish(self, run_id: str | None) -> tuple[AgentRun | None, list[dict[str, Any]]]:
        """The run ended: forget it; the events for the nodes still marked running."""
        run = self._runs.pop(run_id, None) if run_id else None
        if run is None:
            return None, []
        events = [self._event(run, node_id, "ended") for node_id in list(run.running)]
        run.running.clear()
        return run, events

    def forget_graph(self) -> list[dict[str, Any]]:
        """Node ids restarted (a project switch, a load): no mark keeps a node."""
        events: list[dict[str, Any]] = []
        for run in self._runs.values():
            events += [self._event(run, node_id, "ended") for node_id in list(run.running)]
            run.running.clear()
        return events

    def running_in(self, project_id: str | None) -> dict[str, list[dict[str, Any]]]:
        """Per agent id, the nodes its runs are running in ``project_id`` (the roster's ``running``)."""
        found: dict[str, list[dict[str, Any]]] = {}
        now = self._clock()
        for run in self._runs.values():
            if run.project_id != project_id:
                continue
            for node_id, since in run.running.items():
                found.setdefault(run.agent.id, []).append({
                    "runId": run.run_id, "nodeId": node_id, "model": run.models.get(node_id),
                    "secondsAgo": round(max(0.0, now - since), 1)})
        return found

    def agents_in(self, project_id: str | None) -> list[AgentIdentity]:
        seen: dict[str, AgentIdentity] = {}
        for run in self._runs.values():
            if run.project_id == project_id and run.running:
                seen.setdefault(run.agent.id, run.agent)
        return list(seen.values())

    def _event(self, run: AgentRun, node_id: str, change: str) -> dict[str, Any]:
        since = run.running.get(node_id, self._clock())
        return {"type": "agentRun", "agent": run.agent.as_dict(), "runId": run.run_id, "nodeId": node_id,
                "model": run.models.get(node_id), "projectId": run.project_id, "change": change,
                "secondsAgo": round(max(0.0, self._clock() - since), 1)}


__all__ = ["AgentRun", "AgentRunBook", "done_text", "possessive", "thumbnail_for"]
