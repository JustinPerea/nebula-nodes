from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class PortValueDict(BaseModel):
    type: str
    value: str | list[Any] | dict[str, Any] | None = None


class GraphNode(BaseModel):
    id: str
    definition_id: str = Field(alias="definitionId")
    params: dict[str, Any] = Field(default_factory=dict)
    outputs: dict[str, PortValueDict] = Field(default_factory=dict)

    model_config = {"populate_by_name": True}


class GraphEdge(BaseModel):
    id: str
    source: str
    source_handle: str | None = Field(None, alias="sourceHandle")
    target: str
    target_handle: str | None = Field(None, alias="targetHandle")

    model_config = {"populate_by_name": True}


class ExecuteRequest(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]

    model_config = {"populate_by_name": True}


class ExecuteNodeRequest(BaseModel):
    nodes: list[GraphNode]
    edges: list[GraphEdge]
    target_node_id: str = Field(alias="targetNodeId")

    model_config = {"populate_by_name": True}


class GenerateShotRequest(BaseModel):
    """Regenerate a SINGLE shot of a cinema-scene node. Carries the full graph
    (nodes + edges) like ExecuteNodeRequest so upstream character/image inputs
    resolve, plus the cinema node id and the target shot id."""

    nodes: list[GraphNode]
    edges: list[GraphEdge]
    node_id: str = Field(alias="nodeId")
    shot_id: str = Field(alias="shotId")
    # Optional explicit base seed. With `variations` > 1 the batch uses
    # seed, seed+1, … (or random seeds when omitted).
    seed: int | None = None
    # When > 1, regenerate the shot this many times at distinct seeds and store
    # the results as selectable variations. None / 1 → a single canonical run.
    variations: int | None = None

    model_config = {"populate_by_name": True}
