from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class PortValueDict(BaseModel):
    type: str
    value: str | list[str] | dict[str, str] | None = None


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
