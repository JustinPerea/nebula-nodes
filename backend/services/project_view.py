"""A saved project as agents read it, without opening it (MCP get_project).

``GET /api/projects/{id}`` hands the canvas the raw snapshot it loads. With
``?view=agent`` the same route answers with this view instead: every node as
look_at_canvas shows a live one (services/agent_presence.redacted_node:
redacted params, which outputs exist and never their values, wires in), the
wires, the cover and the run history as what ran and what it made. A link
keeps its path and loses its query (signed URLs), a data URI never comes
through, and editor bookkeeping (``_`` keys) is left out.
"""
from __future__ import annotations

from typing import Any, Iterable, Mapping

from services.agent_presence import MAX_SNAPSHOT_NODES, NODE_STATES, output_availability, redacted_node
from services.key_echoes import hide_key_echoes
from services.selection_context import _safe_value as safe_value

# The newest run records an agent gets; the panel keeps more.
MAX_RUN_RECORDS = 20
MAX_RUN_NODE_IDS = 50
_RUN_FIELDS = ("trigger", "status", "startedAt", "targetNodeId", "durationSec", "nodesExecuted", "sourceRunId",
               "replayAction")


def agent_project(project: Mapping[str, Any], definitions: Mapping[str, Any], *, open_id: str | None,
                  secrets: Iterable[str] = ()) -> dict[str, Any]:
    """`secrets`: the configured keys, hidden wherever a provider quoted one
    in an error (services/key_echoes.py)."""
    secrets = list(secrets)
    snapshot = project.get("snapshot") or {}
    rf_nodes = [node for node in snapshot.get("nodes") or [] if isinstance(node, dict) and isinstance(node.get("id"), str)]
    rf_edges = [edge for edge in snapshot.get("edges") or [] if isinstance(edge, dict)]
    incoming: dict[str, list[str]] = {}
    for edge in rf_edges:
        incoming.setdefault(str(edge.get("target", "")), []).append(
            f"{edge.get('source')}.{edge.get('sourceHandle')}→{edge.get('targetHandle')}")
    nodes = [_node(node, definitions, incoming, secrets) for node in rf_nodes[:MAX_SNAPSHOT_NODES]]
    history = [record for record in snapshot.get("runHistory") or [] if isinstance(record, dict)]
    history.sort(key=lambda record: record.get("startedAt") if isinstance(record.get("startedAt"), (int, float)) else 0,
                 reverse=True)
    view: dict[str, Any] = {
        key: project.get(key) for key in ("id", "name", "createdAt", "updatedAt", "lastOpenedAt")
    }
    view.update({
        "open": project.get("id") == open_id,
        "nodeCount": len(rf_nodes),
        "edgeCount": len(rf_edges),
        "truncated": len(rf_nodes) > MAX_SNAPSHOT_NODES,
        "nodes": nodes,
        "edges": [{key: edge.get(key) for key in ("source", "sourceHandle", "target", "targetHandle")}
                  for edge in rf_edges],
        "cover": safe_value(project.get("cover"), key="cover"),
        "runHistory": [_run(record, secrets) for record in history[:MAX_RUN_RECORDS]],
        "runHistoryCount": len(history),
    })
    if isinstance(project.get("createdBy"), dict):
        view["createdBy"] = safe_value(project["createdBy"], key="createdBy")
    return view


def _node(rf: Mapping[str, Any], definitions: Mapping[str, Any], incoming: Mapping[str, list[str]],
          secrets: list[str]) -> dict[str, Any]:
    data = rf.get("data") if isinstance(rf.get("data"), dict) else {}
    definition_id = str(data.get("definitionId", ""))
    definition = definitions.get(definition_id, {}) if isinstance(definitions, Mapping) else {}
    label = data.get("label")
    # A saved card always has a label; it is the person's name for the node
    # only when it isn't the model's own (main._cli_node_to_rf writes that).
    custom = label if isinstance(label, str) and label and label != (definition.get("displayName") or definition_id) else None
    entry = redacted_node(rf["id"], {"definitionId": definition_id, "params": data.get("params") or {},
                                     "outputs": data.get("outputs") or {}, "label": custom},
                          definition, list(incoming.get(rf["id"], [])))
    state = data.get("state")
    entry["state"] = state if state in NODE_STATES else ("complete" if any(
        output["available"] for output in entry["outputs"].values()) else "idle")
    if isinstance(data.get("error"), str) and data["error"]:
        entry["error"] = safe_value(hide_key_echoes(data["error"], secrets), key="error")
    position = rf.get("position")
    if isinstance(position, dict) and all(isinstance(position.get(axis), (int, float)) for axis in ("x", "y")):
        entry["position"] = {"x": round(position["x"], 1), "y": round(position["y"], 1)}
    return entry


def _run(record: Mapping[str, Any], secrets: list[str]) -> dict[str, Any]:
    """What a run did, never what it sent or made: its recipe's params and
    output values stay in the project."""
    brief: dict[str, Any] = {"id": safe_value(record.get("id"), key="id")}
    for key in _RUN_FIELDS:
        if record.get(key) is not None:
            brief[key] = safe_value(record[key], key=key)
    if record.get("statusNote"):
        brief["statusNote"] = safe_value(hide_key_echoes(record["statusNote"], secrets), key="statusNote")
    recipe = record.get("snapshot") if isinstance(record.get("snapshot"), dict) else {}
    node_ids = [node["id"] for node in recipe.get("nodes") or [] if isinstance(node, dict) and isinstance(node.get("id"), str)]
    brief["nodeIds"] = node_ids[:MAX_RUN_NODE_IDS]
    outputs = record.get("resultOutputs") if isinstance(record.get("resultOutputs"), dict) else {}
    brief["outputs"] = {str(node_id): output_availability(ports) for node_id, ports in list(outputs.items())[:MAX_RUN_NODE_IDS]}
    skipped = record.get("skippedNodes")
    if isinstance(skipped, dict) and skipped:
        brief["skipped"] = safe_value(skipped, key="skipped")
    return brief
