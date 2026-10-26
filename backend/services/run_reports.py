"""How far each node of a run got, for agents that collect a run (MCP get_run).

``GET /api/graph/runs/{id}`` used to know only the runs an agent or the CLI
started (main._cli_runs), so the id of a run the person started on the canvas
(from a ``run.started`` journal event) answered 404. This keeps, per run, what
the canvas's cards show from the run's own events: each node's state, its
outputs, its error, its latest progress and the text it has streamed so far.

Bounded and memory-only, like the journal: ``MAX_RUNS`` runs, ``MAX_NODES``
nodes per run, ``MAX_PARTIAL_TEXT`` characters of streamed text per node. A
backend restart forgets them, as it forgets the runs themselves.
"""
from __future__ import annotations

from collections import OrderedDict
from typing import Any

from models.events import (
    ErrorEvent,
    ExecutedEvent,
    ExecutingEvent,
    GraphCompleteEvent,
    ProgressEvent,
    QueuedEvent,
    SkippedEvent,
    StreamDeltaEvent,
)

MAX_RUNS = 256
MAX_NODES = 300
MAX_PARTIAL_TEXT = 4000


class RunReports:
    def __init__(self) -> None:
        self._runs: OrderedDict[str, dict[str, Any]] = OrderedDict()

    def observe(self, event: Any, run_id: str | None) -> None:
        """Record one execution event (main._emit_and_sync); never raises."""
        try:
            self._observe(event, run_id)
        except Exception:  # noqa: BLE001 - a report is decoration on the run
            pass

    def _observe(self, event: Any, run_id: str | None) -> None:
        if not run_id:
            return
        if isinstance(event, GraphCompleteEvent):
            run = self._run(run_id)
            run["duration"] = round(float(event.duration), 2)
            run["nodesExecuted"] = int(event.nodes_executed)
            return
        node_id = getattr(event, "node_id", None)
        if not isinstance(node_id, str):
            return
        if not isinstance(event, (QueuedEvent, ExecutingEvent, ProgressEvent, ExecutedEvent, SkippedEvent,
                                  ErrorEvent, StreamDeltaEvent)):
            return
        run = self._run(run_id)
        nodes: OrderedDict[str, dict[str, Any]] = run["nodes"]
        if node_id not in nodes and len(nodes) >= MAX_NODES:
            return
        node = nodes.setdefault(node_id, {"state": "queued"})
        if isinstance(event, QueuedEvent):
            node.setdefault("state", "queued")
        elif isinstance(event, ExecutingEvent):
            if node["state"] in ("queued", "executing"):
                node["state"] = "executing"
        elif isinstance(event, ProgressEvent):
            node["progress"] = round(max(0.0, min(1.0, float(event.value))), 3)
            if node["state"] == "queued":
                node["state"] = "executing"
        elif isinstance(event, StreamDeltaEvent):
            text = event.accumulated or ""
            node["partialText"] = text[:MAX_PARTIAL_TEXT]
            if len(text) > MAX_PARTIAL_TEXT:
                node["partialTextLength"] = len(text)
            if node["state"] == "queued":
                node["state"] = "executing"
        elif isinstance(event, ExecutedEvent):
            node["state"] = "complete"
            node["outputs"] = event.outputs
            if event.notes:
                node["notes"] = list(event.notes)
            for key in ("progress", "partialText", "partialTextLength"):
                node.pop(key, None)
        elif isinstance(event, SkippedEvent):
            node["state"] = "skipped"
            node["reason"] = event.reason
        elif isinstance(event, ErrorEvent):
            node["state"] = "error"
            node["error"] = event.friendly or event.error or "failed"

    def _run(self, run_id: str) -> dict[str, Any]:
        run = self._runs.get(run_id)
        if run is None:
            run = self._runs[run_id] = {"nodes": OrderedDict()}
            while len(self._runs) > MAX_RUNS:
                self._runs.popitem(last=False)
        else:
            self._runs.move_to_end(run_id)
        return run

    def known(self, run_id: str) -> bool:
        return run_id in self._runs

    def mark_source(self, run_id: str, source: str) -> None:
        """Who started the run, by route: "agent" for /api/graph/run (an agent
        or the CLI); runs never marked came from the canvas."""
        if run_id:
            self._run(run_id)["source"] = source

    def source(self, run_id: str) -> str | None:
        return (self._runs.get(run_id) or {}).get("source")

    def progress(self, run_id: str) -> dict[str, dict[str, Any]]:
        """Per node: state, plus progress, partialText and error when there are any."""
        run = self._runs.get(run_id) or {"nodes": {}}
        shown: dict[str, dict[str, Any]] = {}
        for node_id, node in run["nodes"].items():
            entry = {"state": node["state"]}
            for key in ("progress", "partialText", "partialTextLength", "error"):
                if key in node:
                    entry[key] = node[key]
            shown[node_id] = entry
        return shown

    def outcome(self, run_id: str) -> dict[str, Any]:
        """The run's results, errors, skipped and notes, as a CLI run's outcome has them."""
        run = self._runs.get(run_id) or {"nodes": {}}
        results: dict[str, Any] = {}
        errors: dict[str, str] = {}
        skipped: dict[str, str] = {}
        notes: list[str] = []
        for node_id, node in run["nodes"].items():
            if node["state"] == "complete":
                results[node_id] = node.get("outputs") or {}
                notes.extend(note for note in node.get("notes") or [] if note not in notes)
            elif node["state"] == "error":
                errors[node_id] = node.get("error") or "failed"
            elif node["state"] == "skipped":
                skipped[node_id] = node.get("reason") or ""
        outcome: dict[str, Any] = {"results": results, "errors": errors, "skipped": skipped}
        if notes:
            outcome["notes"] = notes
        for key in ("duration", "nodesExecuted"):
            if key in run:
                outcome[key] = run[key]
        return outcome


run_reports = RunReports()
