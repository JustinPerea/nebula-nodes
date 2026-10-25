from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Mapping, Sequence

from services.universal_ports import stored_ports


# These node definitions may receive provider-discovered ports at runtime.  A
# direction is dynamic only when the registry declares no ports for that
# direction; fixed ports on a universal node remain an enforceable contract.
DYNAMIC_PORT_DEFINITION_IDS = frozenset(
    {
        "openrouter-universal",
        "replicate-universal",
        "fal-universal",
        "nous-portal-universal",
    }
)


@dataclass(frozen=True)
class ContractNode:
    node_id: str
    definition_id: str
    params: Mapping[str, Any] | None = None


@dataclass(frozen=True)
class ContractEdge:
    edge_id: str
    source: str
    source_handle: str | None
    target: str
    target_handle: str | None


@dataclass(frozen=True)
class PortContractIssue:
    node_id: str
    port_id: str
    message: str
    edge_index: int | None = None
    # "retyped": the wire was valid under the port's type before RETYPED_PORTS
    # changed it. A saved project keeps such an edge; a run refuses it.
    kind: str = ""
    # The person's line (error copy round 3e, ValidationErrorDetail.person):
    # the input by its label, no node, edge or handle ids. None for states
    # only an agent or a damaged saved graph reaches (a duplicate id, a wire
    # to a node that isn't there, an unknown node type).
    person: str | None = None


@dataclass(frozen=True)
class EdgeContractResult:
    issues: tuple[PortContractIssue, ...]
    valid_edge_indexes: frozenset[int]
    valid_connected_inputs: frozenset[tuple[str, str]]


@dataclass(frozen=True)
class _PortLookup:
    definition: Mapping[str, Any] | None
    dynamic: bool = False


# What to do instead, said after "Incompatible port types" for an input
# whose type changed under saved graphs. Krea 2's `moodboard` port was Any
# until the moodboard adapters (plan PR13) made it a Moodboard port, so a
# saved graph may still wire text (a Krea moodboard id) into it: the edge is
# kept, and the run names where the id goes now.
# The type each retyped input had before, so a saved wire that was valid then
# is told apart from one that never was.
RETYPED_PORTS: dict[tuple[str, str], str] = {("krea-2-generate", "moodboard"): "Any"}
PORT_TYPE_HINTS: dict[tuple[str, str], str] = {
    ("krea-2-generate", "moodboard"): (
        "Krea 2's Moodboard input takes a Nebula moodboard or the Krea Moodboard node's Moodboard output; "
        "put a Krea moodboard id in the node's Moodboard ID setting instead."),
}
# The same, for the card (error copy round 3e): it replaces the general
# wrong-kind line.
PORT_TYPE_PERSON_HINTS: dict[tuple[str, str], str] = {
    ("krea-2-generate", "moodboard"): (
        "“Moodboard” takes a Nebula moodboard now. To use a Krea moodboard, put its ID in “Moodboard ID” and "
        "remove the connection."),
}

# The card's lines for a wire the run can't use (error copy round 3e).
STALE_INPUT_LINE = "A connection into this node no longer matches its inputs. Remove it, then connect it again."
STALE_OUTPUT_LINE = "A connection from this node no longer matches its outputs. Remove it, then connect it again."


def _input_name(port: Mapping[str, Any] | None, port_id: str) -> str:
    """The input's label exactly as the node shows it, for a line that names it
    in quotes (error copy round 3g, GM: "anything a person reads as a label on
    the node goes in quotes, field or port"). An unlabeled port reads "Input"."""
    return str((port or {}).get("label") or "").strip() or "Input"


def _wrong_kind_line(port: Mapping[str, Any] | None, port_id: str) -> str:
    # GM's example, round 3g: "The wire into “Prompt” brings something it can't take."
    # Connection, never wire (GM - Design, 2026-10-25).
    return (f"The connection into “{_input_name(port, port_id)}” brings something it can't take. "
            "Remove that connection, then connect a matching output.")


def _too_many_line(port: Mapping[str, Any] | None, port_id: str, limit: int) -> str:
    takes = "one connection" if limit == 1 else f"up to {limit} connections"
    extra = "the extra one" if limit == 1 else "the extra ones"
    return f"“{_input_name(port, port_id)}” takes {takes}. Remove {extra}, then run the node again."


# A configured Replicate node's ports are its model's file inputs; its other
# inputs are params (services/universal_ports.replicate_inputs).
_REPLICATE_PARAMS_HINT = (". The model's other inputs are params of the same name: "
                          "set them with params instead of a connection")


def port_types_compatible(source_type: str, target_type: str) -> bool:
    """Return whether a declared output may feed a declared input."""

    return (
        source_type == "Any"
        or target_type == "Any"
        or source_type == target_type
        or {source_type, target_type} == {"Image", "Mask"}
    )


def cinema_output_ports(params: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    """Derive Cinema's typed handles from the authoritative saved shot IDs."""
    scene = params.get("scene") if isinstance(params, Mapping) else None
    shots = scene.get("shots") if isinstance(scene, Mapping) else None
    if not isinstance(shots, list):
        return []
    return [
        {"id": f"shot_{shot['id']}", "label": f"Shot {index + 1}",
         "dataType": "Image", "required": False}
        for index, shot in enumerate(shots)
        if isinstance(shot, Mapping) and isinstance(shot.get("id"), str) and shot["id"]
    ]


def node_ports(
    definition_id: str,
    params: Mapping[str, Any] | None,
    definition: Mapping[str, Any] | None,
    port_key: str,
) -> list[dict[str, Any]]:
    """The ports one node has (``port_key`` "inputPorts" or "outputPorts"):
    Cinema's shot handles from its scene, a configured universal node's from
    its model (services/universal_ports.py), else its definition's. The
    canvas export, the wire checks and the run check all read this."""
    if definition_id == "cinema-scene" and port_key == "outputPorts":
        return cinema_output_ports(params)
    stored = stored_ports(definition_id, params)
    if stored is not None:
        return stored[0] if port_key == "inputPorts" else stored[1]
    raw = (definition or {}).get(port_key, [])
    return raw if isinstance(raw, list) else []


def _declared_port(
    definition_id: str,
    port_id: str | None,
    *,
    port_key: str,
    definitions: Mapping[str, Mapping[str, Any]],
    params: Mapping[str, Any] | None = None,
) -> _PortLookup:
    definition = definitions.get(definition_id)
    if definition is None:
        return _PortLookup(None)

    ports = node_ports(definition_id, params, definition, port_key)
    # A configured universal node declares exactly its model's ports, even
    # none; only one never configured is open to any handle.
    if (definition_id in DYNAMIC_PORT_DEFINITION_IDS and not ports
            and stored_ports(definition_id, params) is None):
        return _PortLookup(None, dynamic=True)

    for port in ports:
        if isinstance(port, Mapping) and port.get("id") == port_id:
            return _PortLookup(port)
    return _PortLookup(None)


def _valid_port_ids(
    definition: Mapping[str, Any],
    port_key: str,
) -> list[str]:
    ports = definition.get(port_key, [])
    if not isinstance(ports, list):
        return []
    return [
        str(port["id"])
        for port in ports
        if isinstance(port, Mapping) and isinstance(port.get("id"), str)
    ]


def _input_connection_limit(port: Mapping[str, Any] | None) -> int | None:
    if port is None:
        return None
    if not port.get("multiple", False):
        return 1
    configured = port.get("maxConnections")
    if isinstance(configured, int) and not isinstance(configured, bool) and configured >= 0:
        return configured
    return None


def validate_edge_contracts(
    nodes: Sequence[ContractNode],
    edges: Sequence[ContractEdge],
    definitions: Mapping[str, Mapping[str, Any]],
) -> EdgeContractResult:
    """Validate graph wiring against the authoritative node registry.

    Edges enter ``valid_edge_indexes`` only after their endpoints, handles,
    declared data types, identity, and target-port capacity all pass.  Callers
    use that same set for required-port accounting, so a fabricated handle or
    incompatible wire can never masquerade as a connected required input.
    """

    issues: list[PortContractIssue] = []
    node_by_id: dict[str, ContractNode] = {}
    ambiguous_node_ids: set[str] = set()
    for node in nodes:
        if node.node_id in node_by_id:
            ambiguous_node_ids.add(node.node_id)
            issues.append(
                PortContractIssue(
                    node_id=node.node_id,
                    port_id="",
                    message=f"Duplicate node id '{node.node_id}' makes edge endpoints ambiguous",
                )
            )
            continue
        node_by_id[node.node_id] = node

    seen_edge_ids: set[str] = set()
    seen_signatures: set[tuple[str, str, str, str]] = set()
    target_connection_counts: dict[tuple[str, str], int] = {}
    valid_indexes: set[int] = set()
    connected_inputs: set[tuple[str, str]] = set()

    for index, edge in enumerate(edges):
        edge_issues: list[PortContractIssue] = []
        source_handle = edge.source_handle or ""
        target_handle = edge.target_handle or ""
        signature = (edge.source, source_handle, edge.target, target_handle)

        if not edge.edge_id:
            edge_issues.append(
                PortContractIssue(
                    node_id=edge.target,
                    port_id=target_handle,
                    message=f"Edge at index {index} requires a non-empty id",
                    edge_index=index,
                )
            )
        elif edge.edge_id in seen_edge_ids:
            edge_issues.append(
                PortContractIssue(
                    node_id=edge.target,
                    port_id=target_handle,
                    message=f"Duplicate edge id '{edge.edge_id}' at edge index {index}",
                    edge_index=index,
                )
            )
        seen_edge_ids.add(edge.edge_id)

        if signature in seen_signatures:
            edge_issues.append(
                PortContractIssue(
                    node_id=edge.target,
                    port_id=target_handle,
                    message=(
                        "Duplicate edge connection "
                        f"'{edge.source}:{source_handle} -> {edge.target}:{target_handle}'"
                    ),
                    edge_index=index,
                )
            )
        seen_signatures.add(signature)

        source_node = node_by_id.get(edge.source)
        target_node = node_by_id.get(edge.target)
        if source_node is None or edge.source in ambiguous_node_ids:
            edge_issues.append(
                PortContractIssue(
                    node_id=edge.source,
                    port_id=source_handle,
                    message=f"Edge '{edge.edge_id}' references missing or ambiguous source node '{edge.source}'",
                    edge_index=index,
                )
            )
        if target_node is None or edge.target in ambiguous_node_ids:
            edge_issues.append(
                PortContractIssue(
                    node_id=edge.target,
                    port_id=target_handle,
                    message=f"Edge '{edge.edge_id}' references missing or ambiguous target node '{edge.target}'",
                    edge_index=index,
                )
            )
        if source_node is None or target_node is None or edge_issues:
            issues.extend(edge_issues)
            continue

        source_definition = definitions.get(source_node.definition_id)
        target_definition = definitions.get(target_node.definition_id)
        source_port = _declared_port(
            source_node.definition_id,
            edge.source_handle,
            port_key="outputPorts",
            definitions=definitions,
            params=source_node.params,
        )
        target_port = _declared_port(
            target_node.definition_id,
            edge.target_handle,
            port_key="inputPorts",
            definitions=definitions,
            params=target_node.params,
        )

        if source_definition is None:
            edge_issues.append(
                PortContractIssue(
                    node_id=edge.source,
                    port_id=source_handle,
                    message=(
                        f"Cannot validate source handle '{source_handle}' on node "
                        f"'{edge.source}': unknown definition '{source_node.definition_id}'"
                    ),
                    edge_index=index,
                )
            )
        elif source_port.definition is None and not source_port.dynamic:
            valid_outputs = node_ports(source_node.definition_id, source_node.params,
                                       source_definition, "outputPorts")
            edge_issues.append(
                PortContractIssue(
                    node_id=edge.source,
                    port_id=source_handle,
                    message=(
                        f"Invalid source handle '{source_handle}' on node '{edge.source}' "
                        f"(definition '{source_node.definition_id}'). Valid outputPorts: "
                        f"{_valid_port_ids({'outputPorts': valid_outputs}, 'outputPorts') or '(none)'}"
                    ),
                    edge_index=index,
                    person=STALE_OUTPUT_LINE,
                )
            )

        if target_definition is None:
            edge_issues.append(
                PortContractIssue(
                    node_id=edge.target,
                    port_id=target_handle,
                    message=(
                        f"Cannot validate target handle '{target_handle}' on node "
                        f"'{edge.target}': unknown definition '{target_node.definition_id}'"
                    ),
                    edge_index=index,
                )
            )
        elif target_port.definition is None and not target_port.dynamic:
            valid_inputs = node_ports(target_node.definition_id, target_node.params,
                                      target_definition, "inputPorts")
            edge_issues.append(
                PortContractIssue(
                    node_id=edge.target,
                    port_id=target_handle,
                    message=(
                        f"Invalid target handle '{target_handle}' on node '{edge.target}' "
                        f"(definition '{target_node.definition_id}'). Valid inputPorts: "
                        f"{_valid_port_ids({'inputPorts': valid_inputs}, 'inputPorts') or '(none)'}"
                        + (_REPLICATE_PARAMS_HINT if target_node.definition_id == "replicate-universal"
                           and stored_ports(target_node.definition_id, target_node.params) is not None else "")
                    ),
                    edge_index=index,
                    person=STALE_INPUT_LINE,
                )
            )

        if not edge_issues and source_port.definition and target_port.definition:
            source_type = source_port.definition.get("dataType")
            target_type = target_port.definition.get("dataType")
            if (
                isinstance(source_type, str)
                and source_type
                and isinstance(target_type, str)
                and target_type
                and not port_types_compatible(source_type, target_type)
            ):
                edge_issues.append(
                    PortContractIssue(
                        node_id=edge.target,
                        port_id=target_handle,
                        message=(
                            f"Incompatible port types: source '{source_handle}' on node "
                            f"'{edge.source}' outputs {source_type}, but target "
                            f"'{target_handle}' on node '{edge.target}' accepts {target_type}"
                            + (f". {hint}" if (hint := PORT_TYPE_HINTS.get(
                                (target_node.definition_id, str(target_handle)))) else "")
                        ),
                        edge_index=index,
                        kind="retyped" if (was := RETYPED_PORTS.get(
                            (target_node.definition_id, str(target_handle)))) is not None
                        and port_types_compatible(source_type, was) else "",
                        person=PORT_TYPE_PERSON_HINTS.get((target_node.definition_id, str(target_handle)))
                        or _wrong_kind_line(target_port.definition, target_handle),
                    )
                )

        if not edge_issues:
            target_key = (edge.target, target_handle)
            limit = _input_connection_limit(target_port.definition)
            current_count = target_connection_counts.get(target_key, 0)
            if limit is not None and current_count >= limit:
                if limit == 1:
                    message = (
                        f"Input port '{target_handle}' on node '{edge.target}' "
                        "does not allow multiple connections"
                    )
                else:
                    message = (
                        f"Input port '{target_handle}' on node '{edge.target}' "
                        f"exceeds maxConnections {limit}"
                    )
                edge_issues.append(
                    PortContractIssue(
                        node_id=edge.target,
                        port_id=target_handle,
                        message=message,
                        edge_index=index,
                        person=_too_many_line(target_port.definition, target_handle, limit),
                    )
                )

        if edge_issues:
            issues.extend(edge_issues)
            continue

        valid_indexes.add(index)
        connected_inputs.add((edge.target, target_handle))
        target_key = (edge.target, target_handle)
        target_connection_counts[target_key] = target_connection_counts.get(target_key, 0) + 1

    return EdgeContractResult(
        issues=tuple(issues),
        valid_edge_indexes=frozenset(valid_indexes),
        valid_connected_inputs=frozenset(connected_inputs),
    )
