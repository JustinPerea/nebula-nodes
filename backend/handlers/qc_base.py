"""Shared handler plumbing for the four Video QC nodes."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from models.graph import GraphNode, PortValueDict
from services.qc_common import create_annotated_frame, format_report, resolve_local_media, save_annotated_output

VALID_QC_MODES = {"heuristic", "vision-llm", "opencv"}


def qc_mode(node: GraphNode) -> str:
    mode = str(node.params.get("mode", "heuristic"))
    if mode not in VALID_QC_MODES:
        raise ValueError(f"Unsupported Video QC mode: {mode}")
    return mode


def required_video(inputs: dict[str, PortValueDict]) -> Path:
    port = inputs.get("video")
    if port is None or not port.value:
        raise ValueError("video port is required")
    return resolve_local_media(str(port.value), label="video")


def optional_reference(inputs: dict[str, PortValueDict]) -> Path | None:
    port = inputs.get("reference")
    if port is None or not port.value:
        return None
    return resolve_local_media(str(port.value), label="reference image")


def qc_outputs(
    node: GraphNode,
    *,
    mode: str,
    findings: dict[str, Any],
    frames,
    title: str,
    labels: list[str] | None = None,
    boxes: dict[int, list[tuple[int, int, int, int]]] | None = None,
    footer: list[str] | None = None,
) -> dict[str, Any]:
    annotated = create_annotated_frame(
        frames,
        title=title,
        labels=labels,
        boxes=boxes,
        footer=footer,
    )
    _, url = save_annotated_output(annotated, node_id=node.id, stem=node.definition_id)
    return {
        "frame": {"type": "Image", "value": url},
        "text": {"type": "Text", "value": format_report(findings, node_id=node.id, mode=mode)},
    }
