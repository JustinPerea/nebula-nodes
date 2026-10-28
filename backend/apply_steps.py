"""Plans of steps for POST /api/graph/apply, shared by `nebula apply` and the
MCP tool edit_canvas (one implementation of the checks and the
stop-and-report rule, never two).

A plan of steps is ``{"note"?, "steps": [plan, plan, ...]}``. Each step is a
normal edit that lands whole or not at all, sent in order. A step can use
the +refs earlier steps created (``+mood`` in step 2 means the node step 1
made for ``+mood``): ``run_steps`` swaps in the node ids each apply returned
in ``idMap``, so the backend never holds plan state.

If a step is refused, the run stops there and reports which step and why,
what the earlier steps applied (with the ids their +refs became) and their
undo tokens, newest first, so the agent can fix the refused step and send
the rest, or undo what landed.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from nebula_api import NebulaAPIError, never_reached, offline_read_only

_STEP_KEYS = frozenset({"note", "steps"})
# `nodeIds` (with `pending: false`) makes the agent's placeholders ready (Q125 item 3).
_EDIT_KEYS = ("nodes", "edges", "params", "rename", "move", "remove", "unwire", "nodeIds")


class PlanError(ValueError):
    """A plan of steps that can't be sent as it is; nothing was sent."""


# Where a plan names a node: these may hold a +ref from an earlier step.
def _named_nodes(step: dict[str, Any]) -> list[str]:
    names: list[str] = []
    for key in ("edges", "unwire"):
        for wire in step.get(key) or []:
            if isinstance(wire, dict):
                names.extend(str(wire.get(end)) for end in ("source", "target") if isinstance(wire.get(end), str))
    for change in step.get("params") or []:
        if isinstance(change, dict) and isinstance(change.get("nodeId"), str):
            names.append(change["nodeId"])
    for key in ("rename", "move"):
        if isinstance(step.get(key), dict):
            names.extend(str(name) for name in step[key])
    for key in ("remove", "nodeIds"):
        names.extend(str(item) for item in step.get(key) or [] if isinstance(item, str))
    return names


def _declared(step: dict[str, Any]) -> list[str]:
    return [str(node["ref"]) for node in step.get("nodes") or []
            if isinstance(node, dict) and isinstance(node.get("ref"), str)]


def check_steps(body: dict[str, Any], *, note: str | None = None, run_hint: str = "`nebula run`") -> list[dict[str, Any]]:
    """A steps plan's steps, checked before anything is sent.

    Each step is a plan without `run`. A +ref is created once across all
    steps, and a step may only use refs it or an earlier step creates, so a
    typo is caught before step 1 lands. `note` (from --note) fills in steps
    that have none, after the plan's own top-level note. `run_hint` names
    how the caller runs nodes (the CLI's `nebula run`, MCP's run_nodes)."""
    unknown = sorted(set(body) - _STEP_KEYS)
    if unknown:
        raise PlanError(f"a plan with steps holds only note and steps; move '{unknown[0]}' into a step")
    raw = body.get("steps")
    if not isinstance(raw, list) or not raw:
        raise PlanError("steps must be a non-empty list of plans")
    default_note = note or body.get("note") or ""
    created: dict[str, int] = {}
    steps: list[dict[str, Any]] = []
    for number, step in enumerate(raw, start=1):
        if not isinstance(step, dict):
            raise PlanError(f"step {number} must be a JSON object (a plan)")
        if "steps" in step:
            raise PlanError(f"step {number} has its own steps; steps don't nest")
        if "run" in step:
            raise PlanError(f"step {number} has run, and apply never runs anything: run the nodes with "
                            f"{run_hint} after the plan is applied")
        if not any(step.get(key) for key in _EDIT_KEYS):
            raise PlanError(f"step {number} changes nothing; give it nodes, edges, params, rename, move, "
                            "remove, unwire or nodeIds (with pending: false), or drop it")
        if step.get("pending") is True and not step.get("nodes"):
            raise PlanError(f"step {number} has pending: true but adds no nodes; pending marks the nodes its own "
                            "step adds, so put it on the step that adds them")
        if step.get("arrange") and not step.get("nodes"):
            raise PlanError(f"step {number} has arrange but adds no nodes; arrange lays out the nodes its own "
                            "step adds, so put it on the step that adds them")
        mine = _declared(step)
        for ref in mine:
            if ref in created:
                raise PlanError(f"step {number} creates {ref}, which step {created[ref]} already created; "
                                "a ref names one node across all steps")
        for name in _named_nodes(step):
            if name.startswith("+") and name not in mine and name not in created:
                raise PlanError(f"step {number} uses {name}, which neither it nor an earlier step creates")
        created.update({ref: number for ref in mine})
        step = dict(step)
        if not step.get("note"):
            step.pop("note", None)
            if default_note:
                step["note"] = default_note
        steps.append(step)
    return steps


def resolve_step(step: dict[str, Any], id_map: dict[str, str]) -> dict[str, Any]:
    """The step with +refs from earlier steps replaced by the node ids they became."""
    own = set(_declared(step))

    def swap(name: Any) -> Any:
        return id_map.get(name, name) if isinstance(name, str) and name not in own else name

    out = dict(step)
    for key in ("edges", "unwire"):
        if isinstance(step.get(key), list):
            out[key] = [{**wire, "source": swap(wire.get("source")), "target": swap(wire.get("target"))}
                        if isinstance(wire, dict) else wire for wire in step[key]]
    if isinstance(step.get("params"), list):
        out["params"] = [{**change, "nodeId": swap(change.get("nodeId"))} if isinstance(change, dict) else change
                         for change in step["params"]]
    for key in ("rename", "move"):
        if isinstance(step.get(key), dict):
            out[key] = {swap(name): value for name, value in step[key].items()}
    for key in ("remove", "nodeIds"):
        if isinstance(step.get(key), list):
            out[key] = [swap(item) for item in step[key]]
    return out


def stop_reason(exc: NebulaAPIError, base_url: str, *, reread: str | None = None) -> str:
    """Why a step didn't land, in words the caller can act on. `reread`: the
    caller's way to read the canvas again; with it, a Nebula never reached
    also says the person's canvas is read-only meanwhile (round 14 of PR #114)."""
    if exc.kind == "connect":
        reason = f"cannot connect to Nebula backend at {base_url}"
        return f"{reason}. {offline_read_only(reread)}" if reread and never_reached(exc) else reason
    if exc.kind == "timeout":
        return "Nebula didn't answer in time; `nebula graph` (MCP: look_at_canvas) shows whether it landed"
    return exc.detail


@dataclass
class StepsOutcome:
    total: int
    applied: list[dict[str, Any]] = field(default_factory=list)
    id_map: dict[str, str] = field(default_factory=dict)
    failed_step: int | None = None
    error: str | None = None

    @property
    def undo_tokens(self) -> list[str]:
        """The applied steps' undo tokens, newest first: the order to undo them in."""
        return [str((result.get("undo") or {}).get("token")) for result in reversed(self.applied)
                if (result.get("undo") or {}).get("token")]

    def as_json(self) -> dict[str, Any]:
        """The result `nebula apply --json` prints and edit_canvas returns."""
        tokens = self.undo_tokens
        undo = {"undo": {"tokens": tokens, "summary": (
            f"Undo the {'step' if len(tokens) == 1 else f'{len(tokens)} steps'} that landed, newest first: "
            "undo_canvas_edit(token=tokens), or `nebula undo` with the tokens in this order.")}} if tokens else {}
        if self.failed_step is None:
            return {"status": "applied", "steps": self.applied, "idMap": self.id_map, **undo}
        return {"status": "stopped", "failedStep": self.failed_step, "steps": self.total, "error": self.error,
                "applied": self.applied, "idMap": self.id_map, **undo}


def run_steps(
    steps: list[dict[str, Any]],
    send: Callable[[dict[str, Any]], dict[str, Any]],
    *,
    reason: Callable[[NebulaAPIError], str],
    on_applied: Callable[[int, int, dict[str, Any]], None] | None = None,
) -> StepsOutcome:
    """Send checked steps one by one through ``send`` (one POST /api/graph/apply
    each), swapping in earlier steps' node ids; stop at the first refusal."""
    outcome = StepsOutcome(total=len(steps))
    for number, step in enumerate(steps, start=1):
        try:
            result = send(resolve_step(step, outcome.id_map))
        except NebulaAPIError as exc:
            outcome.failed_step, outcome.error = number, reason(exc)
            return outcome
        outcome.applied.append(result)
        outcome.id_map.update(result.get("idMap") or {})
        if on_applied is not None:
            on_applied(number, outcome.total, result)
    return outcome


__all__ = ["PlanError", "StepsOutcome", "check_steps", "resolve_step", "run_steps", "stop_reason"]
