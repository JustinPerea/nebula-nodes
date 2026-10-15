"""Gates: a node can leave some outputs empty on purpose, and what that does downstream.

A gate is a node with output ports marked ``"conditional": true`` in its
definition (Jev Decide's ``on_pass`` and ``on_fail``). After it runs, each of
those ports either carries a value or is *withheld*: deliberately empty, with
a reason a person can read.

The handler withholds a port by returning ``withheld(reason)`` for it::

    return {"on_pass": {"type": "Image", "value": path},
            "on_fail": withheld("Jev Decide passed (answered yes, 0.93)")}

A conditional port the handler leaves out entirely counts as withheld too,
so a gate that forgets a port fails closed (nothing downstream runs) instead
of letting a paid node run with its input missing. Only conditional ports
can be withheld; anything else is a handler bug and fails the node.

The engine (execution/engine.py) applies one rule, per invocation: a node
runs only if none of its inbound edges comes from a withheld port or from a
skipped node. Otherwise it is skipped with the gate's reason, and its own
descendants follow the same rule. A node fed by both branches of one gate is
therefore always skipped. Ports simply absent from a normal (non-conditional)
node keep the old behaviour: downstream still runs, with that input missing.

The withheld entries stay in the outputs that go into the cache, so a cache
hit replays exactly the same skips. They never reach port values, events,
manifests or the canvas: ``split_outputs`` takes them out first.
"""
from __future__ import annotations

from typing import Any, Mapping

WITHHELD_KEY = "withheld"


def withheld(reason: str) -> dict[str, Any]:
    """The output entry for a port left empty on purpose."""
    text = " ".join(str(reason or "").split())
    if not text:
        raise ValueError("A withheld output needs a reason")
    return {"type": "Any", "value": None, WITHHELD_KEY: text}


def is_withheld(entry: Any) -> bool:
    return isinstance(entry, Mapping) and WITHHELD_KEY in entry


def conditional_ports(definition: Mapping[str, Any] | None) -> dict[str, str]:
    """Conditional output port id -> label, from a node definition."""
    ports: dict[str, str] = {}
    for port in (definition or {}).get("outputPorts") or []:
        if isinstance(port, Mapping) and port.get("conditional") is True and isinstance(port.get("id"), str):
            ports[port["id"]] = str(port.get("label") or port["id"])
    return ports


def split_outputs(
    outputs: Mapping[str, Any], definition: Mapping[str, Any] | None,
) -> tuple[dict[str, Any], dict[str, str]]:
    """(real port values, withheld port -> reason) for one invocation's outputs."""
    conditional = conditional_ports(definition)
    ports: dict[str, Any] = {}
    held: dict[str, str] = {}
    for port_id, entry in outputs.items():
        if not is_withheld(entry):
            ports[port_id] = entry
            continue
        if port_id not in conditional:
            name = (definition or {}).get("displayName") or "This node"
            raise RuntimeError(f"{name} withheld '{port_id}', which isn't a conditional output")
        reason = " ".join(str(entry.get(WITHHELD_KEY) or "").split())
        if not reason:
            raise RuntimeError(f"Withheld output '{port_id}' has no reason")
        held[port_id] = reason
    # "Jev Decide (judge / classify / yes-no)" -> "Jev Decide".
    name = str((definition or {}).get("displayName") or "The node").split(" (")[0]
    for port_id, label in conditional.items():
        if port_id not in ports and port_id not in held:
            held[port_id] = f"{name} sent nothing on {label}"
    return ports, held


def join_outputs(ports: Mapping[str, Any], held: Mapping[str, str]) -> dict[str, Any]:
    """The outputs as the cache stores them: real values plus withheld entries."""
    joined = dict(ports)
    for port_id, reason in held.items():
        joined[port_id] = withheld(reason)
    return joined
