from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError

from handlers.spatial import (
    handle_camera_path,
    handle_camera_pose,
    handle_sensor_rig,
    handle_spatial_context,
    handle_spatial_value_validate,
)
from models.graph import GraphNode, PortValueDict
from services import output as output_mod


REPO_ROOT = Path(__file__).resolve().parents[2]
LOCAL_NODE_IDS = {
    "camera-pose",
    "camera-path",
    "spatial-context",
    "sensor-rig",
    "spatial-value-validate",
}


def node(identifier: str, definition_id: str, params: dict | None = None) -> GraphNode:
    return GraphNode(id=identifier, definitionId=definition_id, params=params or {})


async def authored_pose(
    identifier: str,
    timestamp: float = 0.0,
    *,
    intrinsics: bool = True,
) -> dict:
    result = await handle_camera_pose(
        node(
            identifier,
            "camera-pose",
            {
                "coordinate_system_id": "shared-world",
                "timestamp_seconds": timestamp,
                "include_intrinsics": intrinsics,
            },
        ),
        {},
        {},
    )
    return result["pose"]["value"]


@pytest.mark.asyncio
async def test_camera_pose_authors_normalized_versioned_value_without_api_key() -> None:
    result = await handle_camera_pose(
        node(
            "cam",
            "camera-pose",
            {
                "coordinate_system_id": "shared-world",
                "orientation_w": 2.0,
                "unit": "centimeters",
                # A hidden/stale custom value cannot corrupt a fixed unit.
                "meters_per_unit": 9.0,
            },
        ),
        {},
        {"WORLDLABS_API_KEY": "must-not-be-used"},
    )
    port = result["pose"]
    assert port["type"] == "CameraPose"
    assert port["value"]["schemaVersion"] == 1
    assert port["value"]["kind"] == "camera-pose"
    assert port["value"]["orientation"] == [0.0, 0.0, 0.0, 1.0]
    assert port["value"]["coordinateSystem"]["unit"] == "centimeters"
    assert port["value"]["coordinateSystem"]["metersPerUnit"] == 0.01


@pytest.mark.asyncio
async def test_camera_path_preserves_input_order_and_rejects_bad_time_or_frame() -> None:
    first = await authored_pose("a", 0.0)
    second = await authored_pose("b", 1.0)
    result = await handle_camera_path(
        node("path", "camera-path", {"interpolation": "catmull-rom"}),
        {"poses": PortValueDict(type="CameraPose", value=[first, second])},
        {},
    )
    assert [pose["id"] for pose in result["path"]["value"]["poses"]] == ["a", "b"]

    second["timestampSeconds"] = 0.0
    with pytest.raises(ValidationError, match="strictly increasing"):
        await handle_camera_path(
            node("path", "camera-path"),
            {"poses": PortValueDict(type="CameraPose", value=[first, second])},
            {},
        )


@pytest.mark.asyncio
async def test_default_camera_poses_share_the_catalog_coordinate_frame() -> None:
    first = (
        await handle_camera_pose(node("a", "camera-pose"), {}, {})
    )["pose"]["value"]
    second = (
        await handle_camera_pose(
            node("b", "camera-pose", {"timestamp_seconds": 1.0}), {}, {}
        )
    )["pose"]["value"]

    assert first["coordinateSystem"]["id"] == "nebula-world"
    assert second["coordinateSystem"] == first["coordinateSystem"]
    path = await handle_camera_path(
        node("path", "camera-path"),
        {"poses": PortValueDict(type="CameraPose", value=[first, second])},
        {},
    )
    assert len(path["path"]["value"]["poses"]) == 2


@pytest.mark.asyncio
async def test_spatial_context_pairs_only_available_local_assets(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(output_mod, "OUTPUT_ROOT", tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "a.png").write_bytes(b"a")
    (run_dir / "b.png").write_bytes(b"b")
    first = await authored_pose("a", 0.0)
    second = await authored_pose("b", 1.0)
    inputs = {
        "poses": PortValueDict(type="CameraPose", value=[first, second]),
        "assets": PortValueDict(
            type="Image",
            value=["/api/outputs/run/a.png", "/api/outputs/run/b.png"],
        ),
    }
    result = await handle_spatial_context(
        node("context", "spatial-context", {"role": "observation"}), inputs, {}
    )
    anchors = result["context"]["value"]["anchors"]
    assert len(anchors) == 2
    assert {anchor["role"] for anchor in anchors} == {"observation"}

    inputs["assets"] = PortValueDict(
        type="Image", value=["https://provider.example/a.png?token=secret", "/api/outputs/run/b.png"]
    )
    with pytest.raises(ValueError):
        await handle_spatial_context(node("context", "spatial-context"), inputs, {})

    inputs["assets"] = PortValueDict(
        type="Image",
        value=["/api/outputs/run/missing.png", "/api/outputs/run/b.png"],
    )
    with pytest.raises(ValueError, match="available local file"):
        await handle_spatial_context(node("context", "spatial-context"), inputs, {})


@pytest.mark.asyncio
async def test_sensor_rig_enforces_optical_and_nonoptical_intrinsics() -> None:
    optical = await authored_pose("optical", intrinsics=True)
    inertial = await authored_pose("inertial", intrinsics=False)
    result = await handle_sensor_rig(
        node("rig", "sensor-rig", {"modality": "rgbd"}),
        {"poses": PortValueDict(type="CameraPose", value=optical)},
        {},
    )
    assert result["rig"]["value"]["sensors"][0]["modality"] == "rgbd"

    with pytest.raises(ValidationError, match="cannot carry camera intrinsics"):
        await handle_sensor_rig(
            node("rig", "sensor-rig", {"modality": "imu"}),
            {"poses": PortValueDict(type="CameraPose", value=optical)},
            {},
        )
    result = await handle_sensor_rig(
        node("rig", "sensor-rig", {"modality": "imu"}),
        {"poses": PortValueDict(type="CameraPose", value=inertial)},
        {},
    )
    assert result["rig"]["value"]["sensors"][0]["modality"] == "imu"


@pytest.mark.asyncio
async def test_validator_echoes_normalized_type_and_adapts_world_v1_in_memory(
    tmp_path: Path,
    monkeypatch,
) -> None:
    monkeypatch.setattr(output_mod, "OUTPUT_ROOT", tmp_path)
    run_dir = tmp_path / "run"
    run_dir.mkdir()
    (run_dir / "world.spz").write_bytes(b"spz")
    camera = await authored_pose("camera")
    result = await handle_spatial_value_validate(
        node("validate", "spatial-value-validate", {"expected_type": "CameraPose"}),
        {"input": PortValueDict(type="CameraPose", value=camera)},
        {},
    )
    assert result["value"]["type"] == "CameraPose"
    assert json.loads(result["summary"]["value"])["kind"] == "camera-pose"

    legacy = {
        "schemaVersion": 1,
        "provider": "worldlabs",
        "worldId": "legacy",
        "model": "marble-1.1",
        "displayName": "Legacy",
        "promptType": "text",
        "assets": {"splats": {"100k": "/api/outputs/run/world.spz"}},
        "semantics": {"coordinateFrame": "marble_raw_opencv"},
    }
    result = await handle_spatial_value_validate(
        node("validate", "spatial-value-validate", {"expected_type": "World"}),
        {"input": PortValueDict(type="World", value=legacy)},
        {},
    )
    assert legacy["schemaVersion"] == 1
    assert result["value"]["value"]["schemaVersion"] == 2
    assert result["value"]["value"]["kind"] == "world"


def test_local_spatial_nodes_are_keyless_sync_utilities_with_exact_ports() -> None:
    definitions = json.loads(
        (REPO_ROOT / "backend" / "data" / "node_definitions.json").read_text()
    )
    assert LOCAL_NODE_IDS <= definitions.keys()
    for definition_id in LOCAL_NODE_IDS:
        definition = definitions[definition_id]
        assert definition["apiProvider"] == "utility"
        assert definition["envKeyName"] == []
        assert definition["apiEndpoint"] == ""
        assert definition["executionPattern"] == "sync"
        assert "atlas" not in json.dumps(definition).lower()


def test_local_spatial_handlers_are_registered() -> None:
    from execution.sync_runner import get_handler_registry

    registry = get_handler_registry(emit=AsyncMock())
    assert LOCAL_NODE_IDS <= registry.keys()


def test_execution_boundary_rejects_missing_spatial_artifacts(tmp_path, monkeypatch):
    from execution.engine import _canonicalize_spatial_outputs

    monkeypatch.setattr(output_mod, "OUTPUT_ROOT", tmp_path)
    legacy = {
        "schemaVersion": 1,
        "provider": "worldlabs",
        "worldId": "missing-world",
        "assets": {"splats": {"100k": "/api/outputs/run/missing.spz"}},
    }
    with pytest.raises(ValueError, match="available local file"):
        _canonicalize_spatial_outputs({"world": {"type": "World", "value": legacy}})

    from models.spatial import adapt_world_value_v1_to_v2, dump_spatial_value

    world_v2 = dump_spatial_value(adapt_world_value_v1_to_v2(legacy))
    with pytest.raises(ValueError, match="available local file"):
        _canonicalize_spatial_outputs({"world": {"type": "World", "value": world_v2}})
