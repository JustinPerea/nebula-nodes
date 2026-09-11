"""Deterministic authoring and validation nodes for spatial graph values.

These handlers perform no network or provider work. They author a small set of
portable spatial primitives and validate imported/provider-produced values at
the same strict boundary used by the backend contract models.
"""

from __future__ import annotations

import json
import math
from typing import Any, Awaitable, Callable

from pydantic import BaseModel

from models.events import ExecutionEvent
from models.graph import GraphNode, PortValueDict
from models.spatial import (
    CameraIntrinsics,
    CameraPath,
    CameraPose,
    CoordinateSystem,
    LocalAssetReference,
    SensorDefinition,
    SensorRig,
    SpatialAnchor,
    SpatialContext,
    adapt_world_value_v1_to_v2,
    dump_spatial_value,
    iter_local_asset_references,
    parse_spatial_value,
)
from services.output import portable_output_ref


Emit = Callable[[ExecutionEvent], Awaitable[None]] | None


def _bounded_id(value: str, suffix: str = "") -> str:
    raw = f"{value}{suffix}"
    if len(raw) <= 128:
        return raw
    if suffix:
        return f"{value[: 128 - len(suffix)]}{suffix}"
    return value[:128]


def _string_param(params: dict[str, Any], key: str, default: str) -> str:
    value = params.get(key, default)
    if value == "":
        value = default
    if not isinstance(value, str) or not value or len(value) > 256:
        raise ValueError(f"{key} must be a non-empty bounded string")
    return value


def _float_param(params: dict[str, Any], key: str, default: float) -> float:
    raw = params.get(key, default)
    if isinstance(raw, bool):
        raise ValueError(f"{key} must be a finite number")
    try:
        value = float(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{key} must be a finite number") from exc
    if not math.isfinite(value):
        raise ValueError(f"{key} must be a finite number")
    return value


def _int_param(params: dict[str, Any], key: str, default: int) -> int:
    raw = params.get(key, default)
    if isinstance(raw, bool):
        raise ValueError(f"{key} must be an integer")
    try:
        value = int(raw)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{key} must be an integer") from exc
    if isinstance(raw, float) and raw != value:
        raise ValueError(f"{key} must be an integer")
    if isinstance(raw, str) and raw.strip() != str(value):
        raise ValueError(f"{key} must be an integer")
    return value


def _bool_param(params: dict[str, Any], key: str, default: bool) -> bool:
    value = params.get(key, default)
    if isinstance(value, bool):
        return value
    if value in {"true", "True", 1}:
        return True
    if value in {"false", "False", 0}:
        return False
    raise ValueError(f"{key} must be a boolean")


def _coordinate_system(params: dict[str, Any], node_id: str) -> CoordinateSystem:
    unit = _string_param(params, "unit", "meters")
    default_scale = {"meters": 1.0, "centimeters": 0.01, "millimeters": 0.001}.get(unit, 1.0)
    return CoordinateSystem(
        schemaVersion=1,
        kind="coordinate-system",
        # Keep the handler fallback identical to the catalog default. Graph
        # creation deliberately stores only explicitly supplied parameters, so
        # deriving the frame from the node id would make two otherwise-default
        # Camera Pose nodes impossible to compose.
        id=_bounded_id(_string_param(params, "coordinate_system_id", "nebula-world")),
        handedness=_string_param(params, "handedness", "right"),
        upAxis=_string_param(params, "up_axis", "y"),
        forwardAxis=_string_param(params, "forward_axis", "-z"),
        unit=unit,
        metersPerUnit=(
            _float_param(params, "meters_per_unit", default_scale)
            if unit == "custom"
            else default_scale
        ),
        originMeters=[
            _float_param(params, "origin_x", 0.0),
            _float_param(params, "origin_y", 0.0),
            _float_param(params, "origin_z", 0.0),
        ],
    )


def _port_values(port: PortValueDict | None) -> list[Any]:
    if port is None or port.value is None:
        return []
    return list(port.value) if isinstance(port.value, list) else [port.value]


async def handle_camera_pose(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Emit = None,
) -> dict[str, Any]:
    del inputs, api_keys, emit
    params = node.params or {}
    intrinsics = None
    if _bool_param(params, "include_intrinsics", True):
        intrinsics = CameraIntrinsics(
            model="pinhole",
            width=_int_param(params, "image_width", 1920),
            height=_int_param(params, "image_height", 1080),
            fx=_float_param(params, "fx", 1000.0),
            fy=_float_param(params, "fy", 1000.0),
            cx=_float_param(params, "cx", 960.0),
            cy=_float_param(params, "cy", 540.0),
            skew=_float_param(params, "skew", 0.0),
        )
    camera_pose = CameraPose(
        schemaVersion=1,
        kind="camera-pose",
        id=_bounded_id(_string_param(params, "pose_id", node.id)),
        coordinateSystem=_coordinate_system(params, node.id),
        position=[
            _float_param(params, "position_x", 0.0),
            _float_param(params, "position_y", 1.7),
            _float_param(params, "position_z", 0.0),
        ],
        orientation=[
            _float_param(params, "orientation_x", 0.0),
            _float_param(params, "orientation_y", 0.0),
            _float_param(params, "orientation_z", 0.0),
            _float_param(params, "orientation_w", 1.0),
        ],
        timestampSeconds=_float_param(params, "timestamp_seconds", 0.0),
        intrinsics=intrinsics,
    )
    return {"pose": {"type": "CameraPose", "value": dump_spatial_value(camera_pose)}}


async def handle_camera_path(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Emit = None,
) -> dict[str, Any]:
    del api_keys, emit
    raw_poses = _port_values(inputs.get("poses"))
    poses = [CameraPose.model_validate(value) for value in raw_poses]
    if not poses:
        raise ValueError("Camera Path requires at least one CameraPose input")
    params = node.params or {}
    camera_path = CameraPath(
        schemaVersion=1,
        kind="camera-path",
        id=_bounded_id(_string_param(params, "path_id", node.id)),
        coordinateSystem=poses[0].coordinateSystem,
        interpolation=_string_param(params, "interpolation", "linear"),
        closed=_bool_param(params, "closed", False),
        poses=poses,
    )
    return {"path": {"type": "CameraPath", "value": dump_spatial_value(camera_path)}}


def _asset_uri(value: Any) -> str:
    if isinstance(value, str):
        return portable_output_ref(value, require_file=True)
    if isinstance(value, dict) and isinstance(value.get("url"), str):
        return portable_output_ref(value["url"], require_file=True)
    raise ValueError("Spatial Context assets must be local image output URLs")


def _require_available_local_assets(value: BaseModel) -> None:
    for asset in iter_local_asset_references(value):
        portable_output_ref(asset.uri, require_file=True)


async def handle_spatial_context(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Emit = None,
) -> dict[str, Any]:
    del api_keys, emit
    raw_poses = _port_values(inputs.get("poses"))
    raw_assets = _port_values(inputs.get("assets"))
    if not raw_poses or len(raw_poses) != len(raw_assets):
        raise ValueError("Spatial Context requires equal non-zero CameraPose and Image inputs")
    poses = [CameraPose.model_validate(value) for value in raw_poses]
    params = node.params or {}
    role = _string_param(params, "role", "reference")
    anchors: list[SpatialAnchor] = []
    for index, (pose, raw_asset) in enumerate(zip(poses, raw_assets, strict=True)):
        anchors.append(
            SpatialAnchor(
                id=_bounded_id(node.id, f":anchor:{index}"),
                role=role,
                pose=pose,
                asset=LocalAssetReference(
                    id=_bounded_id(node.id, f":asset:{index}"),
                    uri=_asset_uri(raw_asset),
                    mediaType="application/octet-stream",
                ),
            )
        )
    context = SpatialContext(
        schemaVersion=1,
        kind="spatial-context",
        id=_bounded_id(_string_param(params, "context_id", node.id)),
        coordinateSystem=poses[0].coordinateSystem,
        anchors=anchors,
    )
    return {"context": {"type": "SpatialContext", "value": dump_spatial_value(context)}}


async def handle_sensor_rig(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Emit = None,
) -> dict[str, Any]:
    del api_keys, emit
    poses = [CameraPose.model_validate(value) for value in _port_values(inputs.get("poses"))]
    if not poses:
        raise ValueError("Sensor Rig requires at least one CameraPose input")
    params = node.params or {}
    modality = _string_param(params, "modality", "rgb")
    sensors = [
        SensorDefinition(
            id=_bounded_id(node.id, f":sensor:{index}"),
            modality=modality,
            pose=pose,
        )
        for index, pose in enumerate(poses)
    ]
    rig = SensorRig(
        schemaVersion=1,
        kind="sensor-rig",
        id=_bounded_id(_string_param(params, "rig_id", node.id)),
        coordinateSystem=poses[0].coordinateSystem,
        sensors=sensors,
    )
    return {"rig": {"type": "SensorRig", "value": dump_spatial_value(rig)}}


async def handle_spatial_value_validate(
    node: GraphNode,
    inputs: dict[str, PortValueDict],
    api_keys: dict[str, str],
    emit: Emit = None,
) -> dict[str, Any]:
    del api_keys, emit
    incoming = inputs.get("input")
    if incoming is None or incoming.value is None:
        raise ValueError("Spatial Value Validate requires an input")
    expected_type = _string_param(node.params or {}, "expected_type", incoming.type)
    if incoming.type not in {expected_type, "Any"}:
        raise ValueError(f"expected {expected_type} input, received {incoming.type}")
    if expected_type == "World" and isinstance(incoming.value, dict) and incoming.value.get("schemaVersion") == 1:
        parsed = adapt_world_value_v1_to_v2(
            incoming.value,
            asset_uri_normalizer=lambda uri: portable_output_ref(
                uri, require_file=True
            ),
        )
    else:
        parsed = parse_spatial_value(expected_type, incoming.value)
        _require_available_local_assets(parsed)
    value = dump_spatial_value(parsed)
    summary = json.dumps(
        {
            "type": expected_type,
            "schemaVersion": value.get("schemaVersion"),
            "kind": value.get("kind"),
            "id": value.get("id"),
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    return {
        "value": {"type": expected_type, "value": value},
        "summary": {"type": "Text", "value": summary},
    }
