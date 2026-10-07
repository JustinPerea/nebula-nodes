from __future__ import annotations

import asyncio
import copy
import hashlib
import logging
import os
import shutil
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timezone
from graphlib import TopologicalSorter, CycleError as _GraphlibCycleError
from pathlib import Path
from typing import Any, Callable, Awaitable
from uuid import uuid4

from models.graph import GraphNode, GraphEdge, PortValueDict
from models.spatial import (
    SPATIAL_VALUE_MODELS,
    canonicalize_world_value_v1,
    dump_spatial_value,
    iter_local_asset_references,
    parse_spatial_value,
)
from services.cache import ExecutionCache
from services.image_input import is_remote_or_data_uri
from services.output import (
    OUTPUT_ROOT,
    create_run_dir,
    execution_run_dir,
    get_run_dir,
    materialize_media_value,
    portable_output_ref,
    resolve_output_ref,
    write_manifest,
)
from services.document_extract import extract_text
from services.port_contracts import (
    ContractEdge,
    ContractNode,
    validate_edge_contracts,
)
from services.provider_capabilities import gemini_omni_capability_error
from services.provider_operation_policy import bypasses_output_cache, operation_policy
from services.worldlabs_capabilities import worldlabs_capability_gate
from execution.error_classifier import classify_error
from models.events import (
    ExecutionEvent,
    QueuedEvent,
    ExecutingEvent,
    ExecutedEvent,
    ErrorEvent,
    ValidationErrorDetail,
    GraphCompleteEvent,
    execution_run_id,
    execution_variant,
)

CycleError = _GraphlibCycleError

logger = logging.getLogger(__name__)

_DURABLE_MEDIA_TYPES = {"Image", "Video", "Audio", "Mesh", "SVG"}
_REMOTE_HANDLE_PORTS = {"source_uri", "model_url"}
class _CachedArtifactMissingError(FileNotFoundError):
    """A cache entry became stale between validation and run rebinding."""


class _CachedArtifactInvalidError(ValueError):
    """A cached structured value no longer satisfies its port contract."""


def _canonicalize_spatial_outputs(node_outputs: dict[str, Any]) -> dict[str, Any]:
    """Validate structured ports before cache, downstream use, or emission."""

    canonical: dict[str, Any] = {}
    for port_id, raw_port in node_outputs.items():
        if not isinstance(raw_port, dict):
            canonical[port_id] = raw_port
            continue
        port_type = raw_port.get("type")
        value = raw_port.get("value")
        if port_type not in SPATIAL_VALUE_MODELS:
            canonical[port_id] = raw_port
            continue
        if value is None:
            raise ValueError(f"{port_type} output cannot be null")
        if (
            port_type == "World"
            and isinstance(value, dict)
            and value.get("schemaVersion", value.get("schema_version")) == 1
        ):
            legacy = canonicalize_world_value_v1(
                value,
                asset_uri_normalizer=lambda uri: portable_output_ref(uri, require_file=True),
            )
            canonical[port_id] = {**raw_port, "value": legacy}
            continue
        parsed = parse_spatial_value(str(port_type), value)
        for asset in iter_local_asset_references(parsed):
            portable_output_ref(asset.uri, require_file=True)
        canonical[port_id] = {
            **raw_port,
            "value": dump_spatial_value(parsed),
        }
    return canonical


async def _materialize_media_outputs(
    node_outputs: dict[str, Any], run_dir: Path
) -> dict[str, Any]:
    """Replace provider-hosted media with run-owned local files.

    Capability handles such as Veo's expiring ``source_uri`` and Meshy's
    informational ``model_url`` remain untouched because downstream APIs need
    the original provider reference. User-facing media ports are materialized
    before caching, manifests, and execution events see them.
    """
    durable: dict[str, Any] = {}
    for port_id, raw_port in node_outputs.items():
        if not isinstance(raw_port, dict):
            durable[port_id] = raw_port
            continue
        port = dict(raw_port)
        media_type = str(port.get("type") or "")
        value = port.get("value")
        if media_type not in _DURABLE_MEDIA_TYPES or port_id in _REMOTE_HANDLE_PORTS:
            durable[port_id] = port
            continue

        values = value if isinstance(value, list) else [value]
        converted: list[Any] = []
        for item in values:
            if isinstance(item, str) and item.startswith(("http://", "https://", "data:")):
                converted.append(str(await materialize_media_value(item, media_type, run_dir)))
            else:
                converted.append(item)
        port["value"] = converted if isinstance(value, list) else converted[0]
        durable[port_id] = port
    return durable


def _link_or_copy_cached_artifact(source: Path, destination: Path) -> None:
    """Atomically clone an immutable cached artifact into the current run."""
    if destination.is_file():
        return
    partial = destination.with_name(f".{destination.name}.{uuid4().hex[:8]}.part")
    try:
        try:
            os.link(source, partial)
        except FileNotFoundError as exc:
            if not source.is_file():
                raise _CachedArtifactMissingError(str(source)) from exc
            raise
        except OSError:
            try:
                shutil.copy2(source, partial)
            except FileNotFoundError as exc:
                if not source.is_file():
                    raise _CachedArtifactMissingError(str(source)) from exc
                raise
        partial.replace(destination)
    finally:
        partial.unlink(missing_ok=True)


async def _rebind_cached_output_artifacts(
    node_outputs: dict[str, Any], run_dir: Path
) -> dict[str, Any]:
    """Recursively make a cache hit own every local artifact it returns.

    A cache entry points at the run that first produced it. Re-emitting those
    paths would make the new manifest omit them and allow archiving the old run
    to break the current result. Hard-link (or cross-filesystem copy) each
    nested artifact into the bound run, preserving duplicate references such
    as ``World.assets.panorama`` and the separate panorama output.
    """
    run_root = run_dir.resolve()
    rebound_paths: dict[Path, Path] = {}

    async def rewrite(value: Any, *, portable_assets: bool) -> Any:
        if isinstance(value, str):
            portable_value = portable_assets or value.startswith("/api/outputs/")
            source = _owned_output_path(value)
            if source is None:
                return value
            if not source.is_file():
                raise _CachedArtifactMissingError(str(source))
            try:
                source.relative_to(run_root)
                return portable_output_ref(str(source)) if portable_value else str(source)
            except ValueError:
                pass

            destination = rebound_paths.get(source)
            if destination is None:
                digest = hashlib.sha256(str(source).encode("utf-8")).hexdigest()[:16]
                suffix = source.suffix.lower()
                if len(suffix) > 17 or (suffix and not suffix[1:].isalnum()):
                    suffix = ""
                destination = run_root / f"cache-{digest}{suffix}"
                await asyncio.to_thread(
                    _link_or_copy_cached_artifact,
                    source,
                    destination,
                )
                rebound_paths[source] = destination
            return (
                portable_output_ref(str(destination))
                if portable_value
                else str(destination)
            )
        if isinstance(value, dict):
            return {
                key: await rewrite(item, portable_assets=portable_assets)
                for key, item in value.items()
            }
        if isinstance(value, list):
            return [
                await rewrite(item, portable_assets=portable_assets)
                for item in value
            ]
        if isinstance(value, tuple):
            return tuple(
                [
                    await rewrite(item, portable_assets=portable_assets)
                    for item in value
                ]
            )
        return value

    rebound: dict[str, Any] = {}
    for port_id, raw_port in node_outputs.items():
        port_type = raw_port.get("type") if isinstance(raw_port, dict) else None
        raw_value = raw_port.get("value") if isinstance(raw_port, dict) else None
        legacy_world = bool(
            port_type == "World"
            and isinstance(raw_value, dict)
            and raw_value.get("schemaVersion", raw_value.get("schema_version")) == 1
        )
        portable_spatial = port_type in SPATIAL_VALUE_MODELS and not legacy_world
        rewritten = await rewrite(raw_port, portable_assets=portable_spatial)
        rebound[port_id] = rewritten
    try:
        return _canonicalize_spatial_outputs(rebound)
    except (TypeError, ValueError) as exc:
        raise _CachedArtifactInvalidError(
            "cached spatial output no longer satisfies its contract"
        ) from exc


def _image_input_output(params: dict) -> dict:
    file_path = resolve_output_ref(str(params.get("filePath", "")))
    # Fail at the source when the configured file is gone, rather than passing a
    # dead path downstream where a vision node would otherwise silently analyze
    # zero references. An empty path (unconfigured node) and remote/data values
    # pass through untouched.
    if file_path and not is_remote_or_data_uri(file_path) and not Path(file_path).exists():
        raise ValueError(
            f"Image Input file not found: {file_path!r}. Set a valid path — "
            "downstream nodes would otherwise receive a reference no model can load."
        )
    return {"image": {"type": "Image", "value": file_path}}


async def _maybe_probe_video_output(node: GraphNode, node_outputs: dict[str, Any]) -> None:
    """Probe the current Video artwork whenever an output is replaced,
    run ffprobe and stash private source metadata on node.params. Mirrors the
    upload-time probe so every video source —
    Veo, Kling, Sora, Seedance, Wan, etc. — opens its downstream editor
    with a pre-populated clip instead of forcing the user to Run the
    edit node first. Best-effort: failures are silent (the editor's
    Run-to-populate fallback still works as graceful degradation)."""
    from pathlib import Path
    for v in node_outputs.values():
        if not isinstance(v, dict) or v.get("type") != "Video":
            continue
        value = v.get("value")
        if isinstance(value, list):
            value = value[0] if value else None
        for key in ("_sourceDuration", "_sourceFps", "_sourceIsVfr"):
            node.params.pop(key, None)
        # video-edit's public metadata describes its upstream timeline, while
        # private metadata describes its newly rendered output for consumers.
        if node.definition_id != "video-edit":
            for key in ("sourceDuration", "sourceFps", "sourceIsVfr"):
                node.params.pop(key, None)
        if not isinstance(value, str) or not value:
            continue
        # Outputs are absolute local paths after handlers write to OUTPUT_ROOT.
        # Skip remote URLs and missing files — nothing we can probe.
        if value.startswith(("http://", "https://")):
            continue
        path = Path(resolve_output_ref(value))
        if not path.exists():
            continue
        try:
            from services.ffmpeg import ffprobe_video
            probe = await ffprobe_video(path)
            # These are runtime facts, not provider inputs. The private
            # namespace survives graph persistence while remaining outside
            # strict provider parameter schemas.
            node.params["_sourceDuration"] = probe.duration
            node.params["_sourceFps"] = probe.fps
            node.params["_sourceIsVfr"] = probe.is_vfr
        except Exception:
            pass
        return

NODE_DEFS: dict[str, dict[str, Any]] = {
    "gpt-image-1-generate": {
        "inputPorts": [{"id": "prompt", "required": True}],
        "outputPorts": [{"id": "image"}],
        "envKeyName": "OPENAI_API_KEY",
    },
    "claude-chat": {
        "inputPorts": [
            {"id": "messages", "required": True},
            {"id": "images", "required": False},
        ],
        "outputPorts": [{"id": "text"}],
        "envKeyName": "ANTHROPIC_API_KEY",
    },
    "runway-gen4-turbo": {
        "inputPorts": [
            {"id": "image", "required": True},
            {"id": "prompt", "required": False},
        ],
        "outputPorts": [{"id": "video"}],
        "envKeyName": "RUNWAY_API_KEY",
    },
    "elevenlabs-tts": {
        "inputPorts": [{"id": "text", "required": True}],
        "outputPorts": [{"id": "audio"}],
        "envKeyName": "ELEVENLABS_API_KEY",
    },
    "flux-1-1-ultra": {
        "inputPorts": [
            {"id": "prompt", "required": True},
            {"id": "image", "required": False},
        ],
        "outputPorts": [{"id": "image"}],
        "envKeyName": "FAL_KEY",
    },
    "text-input": {
        "inputPorts": [],
        "outputPorts": [{"id": "text"}],
        "envKeyName": [],
    },
    "image-input": {
        "inputPorts": [],
        "outputPorts": [{"id": "image"}],
        "envKeyName": [],
    },
    "document-input": {
        "inputPorts": [],
        "outputPorts": [{"id": "text"}],
        "envKeyName": [],
    },
    "preview": {
        "inputPorts": [{"id": "input", "required": True}],
        "outputPorts": [],
        "envKeyName": [],
    },
    "combine-text": {
        "inputPorts": [
            {"id": "text1", "required": True},
            {"id": "text2", "required": False},
            {"id": "text3", "required": False},
        ],
        "outputPorts": [{"id": "text"}],
        "envKeyName": [],
    },
    "router": {
        "inputPorts": [{"id": "input", "required": True}],
        "outputPorts": [{"id": "out1"}, {"id": "out2"}, {"id": "out3"}],
        "envKeyName": [],
    },
    "reroute": {
        "inputPorts": [{"id": "input", "required": True}],
        "outputPorts": [{"id": "output"}],
        "envKeyName": [],
    },
    "gpt-4o-chat": {
        "inputPorts": [
            {"id": "messages", "required": True},
            {"id": "images", "required": False},
        ],
        "outputPorts": [{"id": "text"}],
        "envKeyName": "OPENAI_API_KEY",
    },
    "gemini-chat": {
        "inputPorts": [
            {"id": "messages", "required": True},
            {"id": "images", "required": False},
        ],
        "outputPorts": [{"id": "text"}],
        "envKeyName": "GOOGLE_API_KEY",
    },
    "imagen-4-generate": {
        "inputPorts": [{"id": "prompt", "required": True}],
        "outputPorts": [{"id": "image"}],
        "envKeyName": "GOOGLE_API_KEY",
    },
    "kling-v2-1": {
        "inputPorts": [
            {"id": "image", "required": True},
            {"id": "prompt", "required": False},
        ],
        "outputPorts": [{"id": "video"}],
        "envKeyName": "FAL_KEY",
    },
    "sora-2": {
        "inputPorts": [{"id": "prompt", "required": True}],
        "outputPorts": [{"id": "video"}],
        "envKeyName": "FAL_KEY",
    },
    "nano-banana": {
        "inputPorts": [
            {"id": "prompt", "required": True},
            {"id": "images", "required": False},
        ],
        "outputPorts": [{"id": "image"}, {"id": "text"}],
        "envKeyName": "GOOGLE_API_KEY",
    },
    "veo-3": {
        "inputPorts": [{"id": "prompt", "required": True}],
        "outputPorts": [{"id": "video"}],
        "envKeyName": "FAL_KEY",
    },
    "gemini-omni-flash": {
        "inputPorts": [
            {"id": "prompt", "required": True},
            {"id": "images", "required": False},
            {"id": "video", "required": False},
            {"id": "previous_interaction_id", "required": False},
        ],
        "outputPorts": [{"id": "video"}, {"id": "interaction_id"}],
        "envKeyName": "GOOGLE_API_KEY",
    },
    "flux-schnell": {
        "inputPorts": [{"id": "prompt", "required": True}],
        "outputPorts": [{"id": "image"}],
        "envKeyName": "FAL_KEY",
    },
    "fast-sdxl": {
        "inputPorts": [{"id": "prompt", "required": True}],
        "outputPorts": [{"id": "image"}],
        "envKeyName": "FAL_KEY",
    },
    "wan-2-6-t2v": {
        "inputPorts": [{"id": "prompt", "required": True}],
        "outputPorts": [{"id": "video"}],
        "envKeyName": "FAL_KEY",
    },
    "luma-ray2-t2v": {
        "inputPorts": [{"id": "prompt", "required": True}],
        "outputPorts": [{"id": "video"}],
        "envKeyName": "FAL_KEY",
    },
    "ltx-video-2": {
        "inputPorts": [
            {"id": "image", "required": True},
            {"id": "prompt", "required": True},
        ],
        "outputPorts": [{"id": "video"}],
        "envKeyName": "FAL_KEY",
    },
}

LOCAL_EXECUTION_NODE_IDS = frozenset(
    {
        "text-input",
        "image-input",
        "paper-source",
        "document-input",
        "video-input",
        "audio-input",
        "sticky-note",
        "frame-extractor",
        "array-builder",
        "array-selector",
        "image-compare",
        "svg-rasterize",
        "mask-painter",
        "iterator-image",
        "iterator-text",
        "batch",
        "preview",
        "combine-text",
        "router",
        "reroute",
    }
)


_REGISTRY_NODE_DEFS: dict[str, dict[str, Any]] | None = None


def _registry_node_defs() -> dict[str, dict[str, Any]]:
    """Load the full exported node registry lazily for metadata not in NODE_DEFS."""
    global _REGISTRY_NODE_DEFS
    if _REGISTRY_NODE_DEFS is None:
        try:
            from services.node_registry import NodeRegistry

            _REGISTRY_NODE_DEFS = NodeRegistry().get_all()
        except Exception:
            _REGISTRY_NODE_DEFS = {}
    return _REGISTRY_NODE_DEFS


def _node_def_for(definition_id: str) -> dict[str, Any] | None:
    return _registry_node_defs().get(definition_id) or NODE_DEFS.get(definition_id)


def _multiple_input_ports(definition_id: str) -> set[str]:
    node_def = _node_def_for(definition_id)
    if not node_def:
        return set()
    return {
        str(port["id"])
        for port in node_def.get("inputPorts", [])
        if isinstance(port, dict) and port.get("id") and port.get("multiple")
    }


def _as_multiple_values(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return list(value)
    return [value]


def _append_multiple_input(
    existing: PortValueDict | None,
    incoming: PortValueDict,
) -> PortValueDict:
    values = _as_multiple_values(existing.value if existing else None)
    values.extend(_as_multiple_values(incoming.value))

    port_type = incoming.type
    if existing:
        port_type = existing.type if existing.type == incoming.type else "Any"
    return PortValueDict(type=port_type, value=values)


def topological_sort(nodes: list[GraphNode], edges: list[GraphEdge]) -> list[str]:
    graph: dict[str, set[str]] = {node.id: set() for node in nodes}
    for edge in edges:
        if edge.target in graph:
            graph[edge.target].add(edge.source)

    sorter = TopologicalSorter(graph)
    try:
        return list(sorter.static_order())
    except _GraphlibCycleError as exc:
        raise CycleError(str(exc)) from exc


def get_subgraph(
    nodes: list[GraphNode],
    edges: list[GraphEdge],
    target_node_id: str,
) -> tuple[list[GraphNode], list[GraphEdge]]:
    """Return the subgraph of all ancestors of target_node_id (inclusive).

    Traverses edges in reverse (target -> source) to find every node that
    feeds into the target. Returns filtered lists of nodes and edges that
    belong to this subgraph.
    """
    # Build reverse adjacency: node_id -> set of upstream node_ids
    reverse_adj: dict[str, set[str]] = {n.id: set() for n in nodes}
    for edge in edges:
        if edge.target in reverse_adj:
            reverse_adj[edge.target].add(edge.source)

    # BFS from target node to find all ancestors
    needed: set[str] = set()
    queue = [target_node_id]
    while queue:
        nid = queue.pop()
        if nid in needed:
            continue
        needed.add(nid)
        for upstream in reverse_adj.get(nid, set()):
            if upstream not in needed:
                queue.append(upstream)

    node_map = {n.id: n for n in nodes}
    sub_nodes = [node_map[nid] for nid in needed if nid in node_map]
    sub_edges = [e for e in edges if e.source in needed and e.target in needed]
    return sub_nodes, sub_edges


_ITERATOR_NODE_IDS = {"iterator-image", "iterator-text"}
_FANOUT_NODE_IDS = _ITERATOR_NODE_IDS | {"batch"}
InvocationContext = tuple[tuple[str, int], ...]

# ECMAScript TrimString: WhiteSpace union LineTerminator. Python's default
# strip() additionally removes control separators and does not remove BOM.
# https://tc39.es/ecma262/multipage/text-processing.html#sec-trimstring
_JS_TRIM_WHITESPACE = (
    "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680"
    "\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a"
    "\u2028\u2029\u202f\u205f\u3000\ufeff"
)


@dataclass(frozen=True)
class _InvocationResult:
    outputs: dict[str, Any]
    params: dict[str, Any]
    context: InvocationContext


def _batch_items(params: dict[str, Any]) -> list[str]:
    """Parse the editable source without coercion or silent truncation."""
    for key, default in (("display_name", "Batch"), ("items_text", "")):
        if not isinstance(params.get(key, default), str):
            raise ValueError(f"Batch {key} must be a string")
    mode = params.get("split_mode", "by_line")
    if not isinstance(mode, str) or mode not in {"by_line", "none"}:
        raise ValueError("Batch split_mode must be 'by_line' or 'none'")
    cap = params.get("batch_size_cap", 10)
    if isinstance(cap, bool) or not isinstance(cap, int) or not 1 <= cap <= 25:
        raise ValueError("Batch batch_size_cap must be an integer from 1 to 25")
    text = params.get("items_text", "")
    if mode == "none":
        items = [text] if text else []
    else:
        items = [trimmed for line in text.split("\n")
                 if (trimmed := line.strip(_JS_TRIM_WHITESPACE))]
    if len(items) > cap:
        raise ValueError(
            f"Batch has {len(items)} items, exceeding its batch_size_cap of {cap}. "
            "Reduce the list or raise the cap before running; no generation was started."
        )
    return items


def _variant_label(item: Any) -> str:
    text = str(item)
    return text if len(text) <= 40 else f"{text[:37]}…"


def _iterator_validation_errors(
    nodes: list[GraphNode], edges: list[GraphEdge]
) -> list[ValidationErrorDetail]:
    """Reject ambiguous batch joins rather than multiplying paid work silently."""
    node_map = {node.id: node for node in nodes}
    if not any(node.definition_id in _FANOUT_NODE_IDS for node in nodes):
        return []
    errors = []
    for node in nodes:
        if node.definition_id == "batch":
            try:
                _batch_items(node.params)
            except ValueError as exc:
                errors.append(ValidationErrorDetail(
                    node_id=node.id, port_id="set", message=str(exc),
                ))
            continue
        if node.definition_id not in _ITERATOR_NODE_IDS:
            continue
        cap = node.params.get("batch_size_cap", 10)
        if isinstance(cap, bool) or not isinstance(cap, int) or not 1 <= cap <= 25:
            errors.append(ValidationErrorDetail(
                node_id=node.id, port_id="array",
                message="Iterator batch_size_cap must be an integer from 1 to 25",
            ))
    try:
        order = topological_sort(nodes, edges)
    except CycleError:
        return errors  # The normal cycle check supplies its own error.
    incoming: dict[str, set[str]] = {node.id: set() for node in nodes}
    for edge in edges:
        if edge.source in node_map and edge.target in node_map:
            incoming[edge.target].add(edge.source)
    ancestors: dict[str, set[str]] = {}
    for nid in order:
        if nid not in node_map:
            continue
        upstream = set().union(*(ancestors[src] for src in incoming[nid]))
        independent = any(
            left not in ancestors[right] and right not in ancestors[left]
            for left in upstream for right in upstream if left != right
        )
        if independent:
            errors.append(ValidationErrorDetail(
                node_id=nid, port_id="",
                message="Joining independent iterator batches is unsupported. "
                        "Use one iterator for the shared downstream workflow; "
                        "Nebula will not implicitly multiply generation requests.",
            ))
        policy = operation_policy(node_map[nid].definition_id)
        if upstream and policy is not None and policy.provider == "worldlabs":
            errors.append(ValidationErrorDetail(
                node_id=nid, port_id="",
                message="World Labs recovery-aware operations cannot run inside an iterator. "
                        "Use separate tracked nodes so every operation retains its own recovery ID.",
            ))
        ancestors[nid] = upstream | ({nid} if node_map[nid].definition_id in _FANOUT_NODE_IDS else set())
    return errors


def validate_graph(
    nodes: list[GraphNode],
    edges: list[GraphEdge],
    api_keys: dict[str, str],
) -> list[ValidationErrorDetail]:
    errors: list[ValidationErrorDetail] = []
    errors.extend(_iterator_validation_errors(nodes, edges))

    definitions = dict(NODE_DEFS)
    definitions.update(_registry_node_defs())
    edge_contracts = validate_edge_contracts(
        [
            ContractNode(node_id=node.id, definition_id=node.definition_id, params=node.params)
            for node in nodes
        ],
        [
            ContractEdge(
                edge_id=edge.id,
                source=edge.source,
                source_handle=edge.source_handle,
                target=edge.target,
                target_handle=edge.target_handle,
            )
            for edge in edges
        ],
        definitions,
    )
    errors.extend(
        ValidationErrorDetail(
            node_id=issue.node_id,
            port_id=issue.port_id,
            message=issue.message,
        )
        for issue in edge_contracts.issues
    )

    connected_ports = set(edge_contracts.valid_connected_inputs)
    node_by_id = {node.id: node for node in nodes}
    incoming_edges: dict[str, list[GraphEdge]] = {node.id: [] for node in nodes}
    for index, edge in enumerate(edges):
        if index not in edge_contracts.valid_edge_indexes:
            continue
        if edge.target in incoming_edges:
            incoming_edges[edge.target].append(edge)

    for node in nodes:
        node_def = _node_def_for(node.definition_id)
        if not node_def:
            # Unknown or future dynamic node — still validate API key for
            # known dynamic shells when the exported registry is unavailable.
            DYNAMIC_ENV_KEYS: dict[str, str] = {
                "openrouter-universal": "OPENROUTER_API_KEY",
                "replicate-universal": "REPLICATE_API_TOKEN",
                "fal-universal": "FAL_KEY",
            }
            env_key = DYNAMIC_ENV_KEYS.get(node.definition_id)
            if env_key and not api_keys.get(env_key):
                errors.append(
                    ValidationErrorDetail(
                        node_id=node.id,
                        port_id="",
                        message=f"Missing API key: {env_key}",
                    )
                )
            continue

        for port in node_def["inputPorts"]:
            if port.get("required", False):
                if (node.id, port["id"]) not in connected_ports:
                    errors.append(
                        ValidationErrorDetail(
                            node_id=node.id,
                            port_id=port["id"],
                            message=f"Required input port '{port['id']}' is not connected",
                        )
                    )

        env_key = node_def.get("envKeyName", [])
        if isinstance(env_key, str) and env_key:
            key_names = [env_key]
        elif isinstance(env_key, list):
            key_names = env_key
        else:
            key_names = []

        from handlers.krea_gateway import catalog_models
        krea_account = node.definition_id in catalog_models() and node.params.get("_kreaAuth", "api-token") == "mcp"
        if krea_account:
            from services.krea_connector import is_krea_connected
            if not is_krea_connected():
                errors.append(ValidationErrorDetail(node_id=node.id, port_id="",
                                                   message="Connect your Krea account in Settings before running this recipe"))
        if key_names and not krea_account and not any(api_keys.get(k) for k in key_names):
            key_display = " or ".join(key_names)
            errors.append(
                ValidationErrorDetail(
                    node_id=node.id,
                    port_id="",
                    message=f"Missing API key: {key_display}",
                )
            )

        if node.definition_id == "gemini-omni-flash":
            prompt = ""
            has_previous_interaction = bool(
                str(node.params.get("previous_interaction_id") or "").strip()
            )
            has_video_input = False

            for edge in incoming_edges.get(node.id, []):
                if edge.target_handle == "previous_interaction_id":
                    has_previous_interaction = True
                elif edge.target_handle == "video":
                    has_video_input = True
                elif edge.target_handle == "prompt" and edge.source_handle:
                    source = node_by_id.get(edge.source)
                    if not source:
                        continue
                    if source.definition_id == "text-input":
                        prompt = str(source.params.get("value") or "")
                    elif edge.source_handle in source.outputs:
                        output = source.outputs[edge.source_handle]
                        if isinstance(output.value, str):
                            prompt = output.value

            capability_error = gemini_omni_capability_error(
                prompt,
                has_previous_interaction=has_previous_interaction,
                has_video_input=has_video_input,
                task=str(node.params.get("task") or ""),
            )
            if capability_error:
                errors.append(
                    ValidationErrorDetail(
                        node_id=node.id,
                        port_id="prompt",
                        message=capability_error,
                    )
                )

    return errors


NodeHandler = Callable[
    [GraphNode, dict[str, PortValueDict], dict[str, str]],
    Awaitable[dict[str, Any]],
]


async def execute_graph(
    nodes: list[GraphNode],
    edges: list[GraphEdge],
    api_keys: dict[str, str],
    handler_registry: dict[str, NodeHandler],
    emit: Callable[[ExecutionEvent], Awaitable[None]],
    cache: ExecutionCache | None = None,
    max_parallel_nodes: int = 4,
    run_id: str | None = None,
) -> None:
    """Execute a graph with task-local lifecycle correlation.

    Handler callbacks can emit directly through their registry closure rather
    than the engine's ``emit`` argument. A ContextVar therefore scopes every
    event serialized from this async task, including child node tasks.
    """

    iterator_errors = _iterator_validation_errors(nodes, edges)
    if iterator_errors:
        raise ValueError(iterator_errors[0].message)
    manifest_run_id = run_id or str(uuid4())
    run_dir = create_run_dir(manifest_run_id)
    token = execution_run_id.set(run_id)
    variant_token = execution_variant.set(None)
    run_dir_token = execution_run_dir.set(run_dir)
    try:
        await _execute_graph(
            nodes=nodes,
            edges=edges,
            api_keys=api_keys,
            handler_registry=handler_registry,
            emit=emit,
            cache=cache,
            max_parallel_nodes=max_parallel_nodes,
            run_id=manifest_run_id,
            run_dir=run_dir,
        )
    finally:
        execution_run_dir.reset(run_dir_token)
        execution_run_id.reset(token)
        execution_variant.reset(variant_token)


async def _execute_graph(
    nodes: list[GraphNode],
    edges: list[GraphEdge],
    api_keys: dict[str, str],
    handler_registry: dict[str, NodeHandler],
    emit: Callable[[ExecutionEvent], Awaitable[None]],
    cache: ExecutionCache | None = None,
    max_parallel_nodes: int = 4,
    run_id: str | None = None,
    run_dir: Path | None = None,
) -> None:
    run_dir = run_dir or get_run_dir()
    bound_run_dir = run_dir
    start_time = time.monotonic()
    started_at = datetime.now(timezone.utc)  # wall clock, for the run manifest
    from services.paper_run import write_paper_receipt
    write_paper_receipt(nodes, edges, bound_run_dir, run_id)
    nodes_executed = 0
    node_map: dict[str, GraphNode] = {n.id: n for n in nodes}
    # Values used on edges belong to an invocation, not merely a node ID.
    # Static ancestors use (), and a nested iterator appends its item index.
    invocation_outputs: dict[str, dict[InvocationContext, dict[str, PortValueDict]]] = {}
    batch_outputs: dict[str, list[dict[str, Any]]] = {}
    batch_variants: dict[str, list[dict[str, Any]]] = {}
    axis_items: dict[InvocationContext, Any] = {}
    invocation_results: dict[str, list[_InvocationResult]] = {}
    order = topological_sort(nodes, edges)
    order_index = {nid: index for index, nid in enumerate(order)}
    concurrency = max(1, max_parallel_nodes)

    incoming_edges: dict[str, list[GraphEdge]] = {nid: [] for nid in node_map}
    outgoing_edges: dict[str, list[GraphEdge]] = {nid: [] for nid in node_map}
    remaining_dependencies: dict[str, int] = {nid: 0 for nid in node_map}
    for edge in edges:
        if edge.source not in node_map or edge.target not in node_map:
            continue
        incoming_edges[edge.target].append(edge)
        outgoing_edges[edge.source].append(edge)
        remaining_dependencies[edge.target] += 1

    ready: deque[str] = deque(
        nid for nid in order if nid in node_map and remaining_dependencies[nid] == 0
    )
    queued_nodes: set[str] = set()
    failed_nodes: set[str] = set()

    async def queue_ready_node(nid: str) -> None:
        if nid in queued_nodes:
            return
        queued_nodes.add(nid)
        await emit(QueuedEvent(node_id=nid))

    async def queue_initial_ready_nodes() -> None:
        for nid in list(ready):
            await queue_ready_node(nid)

    def invocation_contexts(nid: str) -> list[InvocationContext]:
        parents = list(dict.fromkeys(edge.source for edge in incoming_edges[nid]))
        if not parents:
            return [()]
        contexts = {context for parent in parents for context in invocation_outputs.get(parent, {})}
        # An outer context broadcasts to its nested children; sibling branches
        # of the same iterator join on the exact item context.
        leaves = [context for context in contexts if not any(
            len(other) > len(context) and other[:len(context)] == context for other in contexts
        )]
        return sorted(context for context in leaves if all(
            any(context[:len(parent_context)] == parent_context
                for parent_context in invocation_outputs.get(parent, {}))
            for parent in parents
        ))

    def resolve_inputs(nid: str, context: InvocationContext) -> dict[str, PortValueDict]:
        node = node_map[nid]
        resolved_inputs: dict[str, PortValueDict] = {}
        multiple_ports = _multiple_input_ports(node.definition_id)
        for edge in incoming_edges[nid]:
            if edge.source_handle and edge.target_handle:
                candidates = invocation_outputs.get(edge.source, {})
                compatible = [key for key in candidates if context[:len(key)] == key]
                upstream_outputs = candidates[max(compatible, key=len)] if compatible else {}
                if edge.source_handle in upstream_outputs:
                    incoming = upstream_outputs[edge.source_handle]
                    if edge.target_handle in multiple_ports:
                        resolved_inputs[edge.target_handle] = _append_multiple_input(
                            resolved_inputs.get(edge.target_handle),
                            incoming,
                        )
                    else:
                        resolved_inputs[edge.target_handle] = incoming
        return resolved_inputs

    def variant_scope(nid: str, context: InvocationContext) -> dict[str, Any] | None:
        if not any(node_map[axis].definition_id == "batch" for axis, _index in context):
            return None
        lineage = []
        for depth, (axis, index) in enumerate(context, 1):
            source = node_map[axis]
            if source.definition_id == "batch":
                raw_name = source.params.get("display_name", "Batch")
                source_label = raw_name if raw_name.strip(_JS_TRIM_WHITESPACE) else "Batch"
            else:
                source_label = (_node_def_for(source.definition_id) or {}).get("displayName", source.definition_id)
            lineage.append({
                "source_node_id": axis, "source_label": source_label,
                "index": index, "item_label": _variant_label(axis_items[context[:depth]]),
            })
        return {
            "index": len(batch_outputs.get(nid, [])),
            "label": _variant_label(" × ".join(item["item_label"] for item in lineage)),
            "lineage": lineage,
        }

    async def record_outputs(
        nid: str, context: InvocationContext, node_outputs: dict[str, Any],
        effective_params: dict[str, Any],
    ) -> None:
        snapshot = copy.deepcopy(node_outputs)
        typed = {key: PortValueDict(type=value.get("type", "Any"), value=value.get("value"))
                 for key, value in snapshot.items()}
        scope = variant_scope(nid, context)
        invocation_outputs.setdefault(nid, {})[context] = typed
        batch_outputs.setdefault(nid, []).append(snapshot)
        if scope is not None:
            batch_variants.setdefault(nid, []).append(copy.deepcopy(scope))
        invocation_results.setdefault(nid, []).append(_InvocationResult(
            outputs=copy.deepcopy(snapshot), params=copy.deepcopy(effective_params),
            context=context,
        ))
        await emit(ExecutedEvent(
            node_id=nid, outputs=snapshot,
            batch_outputs=copy.deepcopy(batch_outputs[nid])
            if context or node_map[nid].definition_id in _FANOUT_NODE_IDS else None,
            variant=scope,
            batch_variants=copy.deepcopy(batch_variants[nid]) if scope is not None else None,
        ))

    async def run_invocation(
        nid: str, context: InvocationContext, node: GraphNode
    ) -> tuple[str, bool, int]:
        registered_node_def = _node_def_for(node.definition_id)
        definition_metadata = registered_node_def or {}
        provider_policy = operation_policy(node.definition_id)
        handler = handler_registry.get(node.definition_id)
        materialize_provider_outputs = (
            definition_metadata.get("apiProvider") not in {None, "utility"}
        )
        await emit(ExecutingEvent(node_id=nid))
        resolved_inputs = resolve_inputs(nid, context)

        try:
            if (
                definition_metadata.get("apiProvider") == "worldlabs"
                or (
                    provider_policy is not None
                    and provider_policy.provider == "worldlabs"
                )
            ):
                worldlabs_capability_gate.require_worldlabs_execution(
                    node.definition_id,
                    handler,
                    node_definition=registered_node_def,
                )
            cache_key: str | None = None
            cache_enabled = (
                cache is not None
                and node.definition_id != "paper-source"
                and not bypasses_output_cache(node.definition_id)
            )
            if cache_enabled:
                inputs_for_key = {
                    k: {"type": v.type, "value": v.value}
                    for k, v in resolved_inputs.items()
                }
                cache_params = dict(node.params)
                if node.params.get("_kreaAuth") == "mcp":
                    from handlers.krea_gateway import catalog_models
                    if node.definition_id in catalog_models():
                        from services.krea_connector import connection_revision
                        cache_params["_kreaConnectionRevision"] = connection_revision()
                cache_key = ExecutionCache.get_key(
                    node.definition_id, cache_params, inputs_for_key, node_id=node.id,
                    batch_context=context if any(
                        node_map[axis].definition_id == "batch" for axis, _index in context
                    ) else None,
                )
                cached_outputs = cache.get(cache_key)
                if cached_outputs is not None:
                    # A cache hit describes the original artifact, including
                    # handler-selected settings. Do not replace the submitted
                    # recipe/live node params with historical cache metadata.
                    effective_params = cache.get_effective_params(cache_key)
                    if effective_params is None:
                        effective_params = copy.deepcopy(node.params)
                    try:
                        durable_cached_outputs = (
                            await _materialize_media_outputs(cached_outputs, bound_run_dir)
                            if materialize_provider_outputs
                            else cached_outputs
                        )
                        rebound_cached_outputs = await _rebind_cached_output_artifacts(
                            durable_cached_outputs,
                            bound_run_dir,
                        )
                    except (_CachedArtifactMissingError, _CachedArtifactInvalidError):
                        # The source disappeared after cache.get() verified it.
                        # Treat this narrow race exactly like a normal stale miss.
                        cache.delete(cache_key)
                    else:
                        if rebound_cached_outputs != cached_outputs:
                            cache.set(cache_key, rebound_cached_outputs,
                                      effective_params=effective_params)
                        cached_outputs = rebound_cached_outputs
                        await _maybe_probe_video_output(node, cached_outputs)
                        await record_outputs(nid, context, cached_outputs, effective_params)
                        return nid, True, 1

            if handler is None:
                if node.definition_id == "text-input":
                    text_value = node.params.get("value", "")
                    node_outputs = {"text": {"type": "Text", "value": str(text_value)}}
                elif node.definition_id == "image-input":
                    node_outputs = _image_input_output(node.params)
                elif node.definition_id == "document-input":
                    fp = resolve_output_ref(str(node.params.get("filePath", "")))
                    text_value = extract_text(fp) if fp else ""
                    node_outputs = {"text": {"type": "Text", "value": text_value}}
                elif node.definition_id == "video-input":
                    file_path = node.params.get("filePath", "")
                    node_outputs = {"video": {"type": "Video", "value": str(file_path)}}
                elif node.definition_id == "audio-input":
                    file_path = node.params.get("filePath", "")
                    node_outputs = {"audio": {"type": "Audio", "value": str(file_path)}}
                elif node.definition_id == "sticky-note":
                    node_outputs = {}
                elif node.definition_id == "frame-extractor":
                    video_input = resolved_inputs.get("video")
                    if not video_input or not video_input.value:
                        raise ValueError("Video input is required for frame extraction")
                    try:
                        from services.ffmpeg import ffprobe_video, run_ffmpeg
                        from services.output import get_run_dir
                        from uuid import uuid4

                        video_path = resolve_output_ref(str(video_input.value))
                        is_remote = video_path.startswith(("http://", "https://"))
                        if not is_remote and not Path(video_path).is_file():
                            raise ValueError("Video source file not found; restore or upload the source video before extracting frames")
                        mode = node.params.get("mode", "first_frame")
                        timestamp = float(node.params.get("timestamp", 0))

                        run_dir = get_run_dir()
                        out_path = run_dir / f"{uuid4().hex[:12]}.png"

                        if mode == "first_frame":
                            ts = "00:00:00.000"
                        elif mode == "last_frame":
                            dur = (await ffprobe_video(video_path)).duration
                            ts_secs = max(0, dur - 0.1)
                            ts = f"{int(ts_secs//3600):02d}:{int((ts_secs%3600)//60):02d}:{ts_secs%60:06.3f}"
                        elif mode == "middle_frame":
                            dur = (await ffprobe_video(video_path)).duration
                            ts_secs = dur / 2
                            ts = f"{int(ts_secs//3600):02d}:{int((ts_secs%3600)//60):02d}:{ts_secs%60:06.3f}"
                        else:  # timestamp mode
                            ts = f"{int(timestamp//3600):02d}:{int((timestamp%3600)//60):02d}:{timestamp%60:06.3f}"

                        await run_ffmpeg(
                            ["-ss", ts, "-i", video_path, "-frames:v", "1",
                             "-q:v", "2", str(out_path)]
                        )
                        node_outputs = {"image": {"type": "Image", "value": str(out_path)}}
                    except FileNotFoundError:
                        raise ValueError("ffmpeg not found — install ffmpeg to use Frame Extractor")
                elif node.definition_id == "array-builder":
                    items = []
                    for port_id in ("item1", "item2", "item3", "item4", "item5", "item6", "item7", "item8"):
                        if port_id in resolved_inputs and resolved_inputs[port_id].value is not None:
                            items.append(resolved_inputs[port_id].value)
                    node_outputs = {"array": {"type": "Array", "value": items}}
                elif node.definition_id == "array-selector":
                    array_input = resolved_inputs.get("array")
                    if array_input and isinstance(array_input.value, list) and len(array_input.value) > 0:
                        mode = node.params.get("mode", "first")
                        arr = array_input.value
                        if mode == "first":
                            selected = arr[0]
                        elif mode == "last":
                            selected = arr[-1]
                        elif mode == "random":
                            import random
                            selected = random.choice(arr)
                        else:  # index
                            idx = int(node.params.get("index", 0))
                            selected = arr[min(idx, len(arr) - 1)]
                        node_outputs = {"item": {"type": "Any", "value": selected}}
                    else:
                        node_outputs = {}
                elif node.definition_id == "image-compare":
                    node_outputs = {}
                    if "imageA" in resolved_inputs:
                        node_outputs["imageA"] = {"type": resolved_inputs["imageA"].type, "value": resolved_inputs["imageA"].value}
                    if "imageB" in resolved_inputs:
                        node_outputs["imageB"] = {"type": resolved_inputs["imageB"].type, "value": resolved_inputs["imageB"].value}
                elif node.definition_id == "svg-rasterize":
                    svg_input = resolved_inputs.get("svg")
                    if not svg_input or not svg_input.value:
                        raise ValueError("SVG input is required")
                    svg_value = str(svg_input.value)
                    width = int(node.params.get("width", 1024))
                    height = int(node.params.get("height", 1024))
                    bg = node.params.get("background", "transparent")

                    from services.output import get_run_dir
                    from uuid import uuid4

                    run_dir = get_run_dir()
                    out_path = run_dir / f"{uuid4().hex[:12]}.png"

                    try:
                        import cairosvg
                        # Read SVG content — could be a file path or raw SVG string
                        from pathlib import Path as _Path
                        svg_path = _Path(svg_value)
                        if svg_path.exists():
                            svg_data = svg_path.read_text()
                        else:
                            svg_data = svg_value

                        bg_color = None if bg == "transparent" else "#FFFFFF"
                        cairosvg.svg2png(
                            bytestring=svg_data.encode("utf-8"),
                            write_to=str(out_path),
                            output_width=width,
                            output_height=height,
                            background_color=bg_color,
                        )
                        node_outputs = {"image": {"type": "Image", "value": str(out_path)}}
                    except ImportError:
                        raise ValueError("cairosvg not installed — run: pip install cairosvg")
                elif node.definition_id == "mask-painter":
                    # Painted strokes are stored WHITE-on-BLACK in params._maskData
                    # (a PNG data URI written by the paint modal). Export resizes the
                    # mask to the input image's exact dimensions (Ideogram 422s on a
                    # mismatch) and applies the polarity the consumer expects:
                    #   white-edit (FLUX Fill)  -> painted stays white
                    #   black-edit (Ideogram)   -> inverted, painted becomes black
                    mask_data = node.params.get("_maskData")
                    if not mask_data or not str(mask_data).startswith("data:image"):
                        raise ValueError("No mask painted yet — open the Mask Painter node and paint one")
                    image_input = resolved_inputs.get("image")
                    if not image_input or not image_input.value:
                        raise ValueError("Image input is required (the mask must match its dimensions)")

                    import base64 as _b64
                    import io as _io

                    from PIL import Image as _PILImage, ImageOps as _ImageOps
                    from services.output import get_run_dir
                    from uuid import uuid4

                    mask_bytes = _b64.b64decode(str(mask_data).partition(",")[2])
                    mask_img = _PILImage.open(_io.BytesIO(mask_bytes)).convert("L")

                    # Match the source image dimensions exactly. The source may be a
                    # local path or a data URI; remote URLs are downloaded.
                    src_value = str(image_input.value)
                    if src_value.startswith("data:image"):
                        src_bytes = _b64.b64decode(src_value.partition(",")[2])
                        src_img = _PILImage.open(_io.BytesIO(src_bytes))
                    elif src_value.startswith(("http://", "https://")):
                        import httpx as _httpx
                        async with _httpx.AsyncClient(timeout=60.0) as _client:
                            _resp = await _client.get(src_value, follow_redirects=True)
                            _resp.raise_for_status()
                        src_img = _PILImage.open(_io.BytesIO(_resp.content))
                    else:
                        src_img = _PILImage.open(src_value)

                    if mask_img.size != src_img.size:
                        # NEAREST keeps mask edges hard instead of introducing greys.
                        mask_img = mask_img.resize(src_img.size, _PILImage.NEAREST)

                    if node.params.get("polarity", "white-edit") == "black-edit":
                        mask_img = _ImageOps.invert(mask_img)

                    out_path = get_run_dir() / f"{uuid4().hex[:12]}.png"
                    mask_img.save(out_path, format="PNG")
                    node_outputs = {"mask": {"type": "Image", "value": str(out_path)}}
                elif node.definition_id == "preview":
                    node_outputs = {}
                    if "input" in resolved_inputs:
                        node_outputs["input"] = {
                            "type": resolved_inputs["input"].type,
                            "value": resolved_inputs["input"].value,
                        }
                elif node.definition_id == "combine-text":
                    texts = []
                    for port_id in ("text1", "text2", "text3"):
                        if port_id in resolved_inputs and resolved_inputs[port_id].value:
                            texts.append(str(resolved_inputs[port_id].value))

                    template = node.params.get("template", "")
                    if template:
                        # Template mode: replace {text1}, {text2}, {text3}
                        result = str(template)
                        for port_id in ("text1", "text2", "text3"):
                            val = ""
                            if port_id in resolved_inputs and resolved_inputs[port_id].value:
                                val = str(resolved_inputs[port_id].value)
                            result = result.replace(f"{{{port_id}}}", val)
                        node_outputs = {"text": {"type": "Text", "value": result}}
                    else:
                        # Separator mode: join non-empty texts
                        separator = node.params.get("separator", "\n")
                        separator = str(separator).replace("\\n", "\n").replace("\\t", "\t")
                        node_outputs = {"text": {"type": "Text", "value": separator.join(texts)}}
                elif node.definition_id == "router":
                    input_val = resolved_inputs.get("input")
                    if input_val and input_val.value is not None:
                        port_val = {"type": input_val.type, "value": input_val.value}
                        node_outputs = {
                            "out1": port_val,
                            "out2": port_val,
                            "out3": port_val,
                        }
                    else:
                        node_outputs = {}
                elif node.definition_id == "reroute":
                    input_val = resolved_inputs.get("input")
                    if input_val and input_val.value is not None:
                        node_outputs = {"output": {"type": input_val.type, "value": input_val.value}}
                    else:
                        node_outputs = {}
                else:
                    raise RuntimeError(f"No handler registered for '{node.definition_id}'")
            else:
                node_outputs = await handler(node, resolved_inputs, api_keys)

            if handler is not None and materialize_provider_outputs:
                node_outputs = await _materialize_media_outputs(
                    node_outputs, bound_run_dir
                )

            node_outputs = _canonicalize_spatial_outputs(node_outputs)

            await _maybe_probe_video_output(node, node_outputs)

            if cache_enabled and cache is not None and cache_key is not None and handler is not None:
                cache.set(cache_key, node_outputs, effective_params=node.params)

            await record_outputs(nid, context, node_outputs, node.params)
            return nid, True, 1

        except Exception as exc:
            category, friendly, retryable = classify_error(str(exc))
            await emit(
                ErrorEvent(
                    node_id=nid,
                    error=str(exc),
                    retryable=retryable,
                    category=category,
                    friendly=friendly,
                )
            )
            return nid, False, 0

    async def run_node(nid: str) -> tuple[str, bool, int]:
        node = node_map[nid]
        contexts = invocation_contexts(nid)
        invocation_outputs[nid] = {}
        if node.definition_id in _FANOUT_NODE_IDS:
            await emit(ExecutingEvent(node_id=nid))
            try:
                cap = node.params.get("batch_size_cap", 10)
                planned: list[tuple[InvocationContext, Any]] = []
                for context in contexts:
                    if node.definition_id == "batch":
                        items = _batch_items(node.params)
                    else:
                        source = resolve_inputs(nid, context).get("array")
                        if source is None or not isinstance(source.value, list):
                            raise ValueError("Iterator requires an Array input")
                        items = source.value[:cap]
                    planned.extend((context + ((nid, index),), item)
                                   for index, item in enumerate(items))
                if len(planned) > cap:
                    raise ValueError(
                        f"Nested iterator expands to {len(planned)} items, exceeding "
                        f"this iterator's batch_size_cap of {cap}. Reduce the batch "
                        "before running; no downstream generation was started."
                    )
                out_type, out_key = (
                    ("Text", "set") if node.definition_id == "batch" else
                    ("Image", "image") if node.definition_id == "iterator-image" else ("Text", "text")
                )
                if not planned:
                    await emit(ExecutedEvent(
                        node_id=nid, outputs={}, batch_outputs=[],
                        batch_variants=[] if node.definition_id == "batch" else None,
                    ))
                for context, item in planned:
                    axis_items[context] = item
                    await record_outputs(nid, context, {out_key: {"type": out_type, "value": item}}, node.params)
                return nid, True, len(contexts)
            except Exception as exc:
                category, friendly, retryable = classify_error(str(exc))
                await emit(ErrorEvent(node_id=nid, error=str(exc), category=category,
                                      friendly=friendly, retryable=retryable))
                return nid, False, 0

        executed_count = 0
        recipe_params = copy.deepcopy(node.params)
        for context in contexts:
            # Even a handler with a fixed filename must not overwrite the
            # artwork produced by an earlier item of the same node/run.
            token = None
            if context:
                item_dir = bound_run_dir / "batch" / uuid4().hex
                item_dir.mkdir(parents=True, exist_ok=False)
                token = execution_run_dir.set(item_dir)
            invocation_node = node.model_copy(deep=True, update={"params": copy.deepcopy(recipe_params)}) if context else node
            scope_token = execution_variant.set(variant_scope(nid, context))
            try:
                _, succeeded, count = await run_invocation(nid, context, invocation_node)
            finally:
                # Runtime metadata from the latest item is retained for the
                # canvas, but it cannot become the next item's input recipe.
                if invocation_node is not node:
                    node.params = copy.deepcopy(invocation_node.params)
                if token is not None:
                    execution_run_dir.reset(token)
                execution_variant.reset(scope_token)
            executed_count += count
            if not succeeded:
                return nid, False, executed_count
        return nid, True, executed_count

    running: dict[asyncio.Task[tuple[str, bool, int]], str] = {}
    try:
        await queue_initial_ready_nodes()

        while ready or running:
            while ready and len(running) < concurrency:
                nid = ready.popleft()
                if nid in failed_nodes:
                    continue
                task = asyncio.create_task(run_node(nid))
                running[task] = nid

            if not running:
                break

            done, _pending = await asyncio.wait(
                running.keys(),
                return_when=asyncio.FIRST_COMPLETED,
            )

            for task in done:
                running.pop(task, None)
                nid, succeeded, executed_count = task.result()
                nodes_executed += executed_count

                if not succeeded:
                    failed_nodes.add(nid)
                    continue

                newly_ready: list[str] = []
                for edge in outgoing_edges[nid]:
                    if edge.target in failed_nodes:
                        continue
                    remaining_dependencies[edge.target] -= 1
                    if remaining_dependencies[edge.target] == 0:
                        newly_ready.append(edge.target)

                for target in sorted(newly_ready, key=lambda node_id: order_index[node_id]):
                    await queue_ready_node(target)
                    ready.append(target)
    finally:
        # Cancelling the parent execution must cancel and await every in-flight
        # node task. Handlers can then run their CancelledError provider cleanup
        # without becoming orphaned billable work.
        pending = [task for task in running if not task.done()]
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

        # A failed or cancelled batch still owns every successful earlier
        # artifact. Manifest settlement happens in cleanup, before any terminal
        # event, and therefore also runs when cancellation unwinds this task.
        completed_at = datetime.now(timezone.utc)
        try:
            manifest_outputs = {
                nid: {"batch": PortValueDict(type="Any", value=snapshots)}
                for nid, snapshots in batch_outputs.items()
            }
            manifest_records = _collect_manifest_records(
                node_map, manifest_outputs, order, run_dir,
                invocation_results=invocation_results,
            )
            write_manifest(
                run_id=run_id or str(uuid4()), started_at=started_at,
                completed_at=completed_at, outputs=manifest_records,
                output_dir=run_dir,
            )
        except Exception as exc:
            logger.warning("[engine] manifest write failed for run %s: %s", run_id, exc)

    duration = time.monotonic() - start_time

    # Terminal success is emitted last: once the frontend sees this event the
    # run directory and best-effort manifest lifecycle are already settled.
    await emit(GraphCompleteEvent(duration=round(duration, 3), nodes_executed=nodes_executed))


def _owned_output_path(value: Any) -> Path | None:
    """Resolve an output value to a contained path under OUTPUT_ROOT.

    Remote URLs, data URIs, non-string values, paths outside OUTPUT_ROOT, and
    relative strings are skipped. The path need not currently exist so cache
    rebinding can distinguish a raced deletion from ordinary text.
    """
    if not isinstance(value, str) or not value:
        return None
    if value.startswith(("http://", "https://", "data:")):
        return None
    candidate = value
    if value.startswith("/api/outputs/"):
        resolved = resolve_output_ref(value)
        if resolved == value:
            return None  # traversal attempt — resolve_output_ref refused
        candidate = resolved
    path = Path(candidate)
    if not path.is_absolute():
        return None
    try:
        path = path.resolve()
        path.relative_to(OUTPUT_ROOT.resolve())
    except (ValueError, OSError):
        return None
    return path


def _local_output_file(value: Any) -> Path | None:
    """Resolve an output value to an existing file under OUTPUT_ROOT, else None."""
    path = _owned_output_path(value)
    return path if path is not None and path.is_file() else None


def _nested_output_values(value: Any):
    """Yield leaf values from a structured port without looping on cycles."""
    stack = [value]
    seen_containers: set[int] = set()
    while stack:
        current = stack.pop()
        if isinstance(current, dict):
            identity = id(current)
            if identity in seen_containers:
                continue
            seen_containers.add(identity)
            stack.extend(reversed(tuple(current.values())))
            continue
        if isinstance(current, (list, tuple, set)):
            identity = id(current)
            if identity in seen_containers:
                continue
            seen_containers.add(identity)
            stack.extend(reversed(tuple(current)))
            continue
        yield current


def _collect_manifest_records(
    node_map: dict[str, GraphNode],
    outputs_cache: dict[str, dict[str, PortValueDict]],
    order: list[str],
    run_dir: Path,
    *,
    invocation_results: dict[str, list[_InvocationResult]] | None = None,
) -> list[dict[str, Any]]:
    """Build manifest records for files contained by the bound run directory.

    Files outside this run are never silently adopted or used to select a
    different manifest directory.
    """
    files: list[tuple[str, Path, dict[str, Any], InvocationContext]] = []
    seen_files: set[tuple[str, Path]] = set()
    for nid in order:
        results = invocation_results.get(nid, []) if invocation_results is not None else []
        if not results:
            node_outputs = outputs_cache.get(nid)
            if not node_outputs:
                continue
            results = [_InvocationResult(
                outputs={key: {"type": port.type, "value": port.value}
                         for key, port in node_outputs.items()},
                params=node_map[nid].params, context=(),
            )]
        for result in results:
            for value in _nested_output_values(result.outputs):
                path = _local_output_file(value)
                if path is None:
                    continue
                identity = (nid, path.resolve())
                if identity in seen_files:
                    continue
                seen_files.add(identity)
                files.append((nid, identity[1], result.params, result.context))

    records: list[dict[str, Any]] = []
    resolved_run_dir = run_dir.resolve()
    for nid, path, params, context in files:
        try:
            rel = path.relative_to(resolved_run_dir).as_posix()
        except ValueError:
            logger.warning(
                "[engine] output %s escaped run directory %s; excluding from manifest",
                path,
                run_dir,
            )
            continue
        node = node_map[nid]
        node_def = _node_def_for(node.definition_id) or {}
        endpoint = node_def.get("apiEndpoint") or params.get("endpoint_id") or None
        model = params.get("model")
        prompt = params.get("prompt")
        timestamp = datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
        records.append(
            {
                "node_id": nid,
                "node_type": node.definition_id,
                "model": str(model) if model else None,
                "endpoint": str(endpoint) if endpoint else None,
                "prompt": str(prompt) if prompt else None,
                "params": copy.deepcopy(params),
                "output_path": rel,
                "timestamp": timestamp,
                **({"batch_context": [{"iterator_node_id": iterator, "item_index": index}
                                      for iterator, index in context]} if context else {}),
            }
        )
    return records
