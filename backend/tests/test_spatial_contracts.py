from __future__ import annotations

import copy
import math

import pytest
from pydantic import ValidationError

from models.spatial import (
    CameraPath,
    CameraPose,
    CoordinateSystem,
    DepthMap,
    DepthSequence,
    LocalAssetReference,
    PointCloud,
    SensorRig,
    SensorStream,
    SpatialContext,
    SpatialSessionMetadata,
    WorldValueV2,
    adapt_world_value_v1_to_v2,
    canonicalize_world_value_v1,
    dump_spatial_value,
    parse_spatial_value,
)


def coordinate_system(identifier: str = "world") -> dict:
    return {
        "schemaVersion": 1,
        "kind": "coordinate-system",
        "id": identifier,
        "handedness": "right",
        "upAxis": "y",
        "forwardAxis": "-z",
        "unit": "meters",
        "metersPerUnit": 1.0,
        "originMeters": [0.0, 0.0, 0.0],
    }


def intrinsics(width: int = 640, height: int = 480) -> dict:
    return {
        "model": "pinhole",
        "width": width,
        "height": height,
        "fx": 500.0,
        "fy": 500.0,
        "cx": width / 2,
        "cy": height / 2,
    }


def pose(
    identifier: str = "pose-1",
    timestamp: float | None = 0.0,
    *,
    system: dict | None = None,
    with_intrinsics: bool = True,
) -> dict:
    value = {
        "schemaVersion": 1,
        "kind": "camera-pose",
        "id": identifier,
        "coordinateSystem": system or coordinate_system(),
        "position": [0.0, 1.5, 3.0],
        "orientation": [0.0, 0.0, 0.0, 2.0],
    }
    if timestamp is not None:
        value["timestampSeconds"] = timestamp
    if with_intrinsics:
        value["intrinsics"] = intrinsics()
    return value


def asset(identifier: str, filename: str) -> dict:
    return {
        "id": identifier,
        "uri": f"/api/outputs/run-1/{filename}",
        "mediaType": "application/octet-stream",
    }


def test_camera_pose_normalizes_quaternion_and_rejects_extra_or_nonfinite_values() -> None:
    parsed = CameraPose.model_validate(pose())
    assert parsed.orientation == [0.0, 0.0, 0.0, 1.0]
    assert dump_spatial_value(parsed)["kind"] == "camera-pose"

    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        CameraPose.model_validate({**pose(), "providerPayload": {"secret": True}})
    invalid = pose()
    invalid["position"] = [0.0, math.inf, 0.0]
    with pytest.raises(ValidationError):
        CameraPose.model_validate(invalid)


def test_version_booleans_and_thumbnail_only_worlds_are_rejected() -> None:
    with pytest.raises(ValidationError, match="numeric version"):
        CameraPose.model_validate({**pose(), "schemaVersion": True})
    world = world_v2()
    world["assets"] = {"splats": [], "thumbnail": asset("thumb", "thumb.png")}
    with pytest.raises(ValidationError, match="spatial representation"):
        WorldValueV2.model_validate(world)


def test_large_finite_quaternion_uses_stable_norm() -> None:
    parsed = CameraPose.model_validate({**pose(), "orientation": [1e200, 0.0, 0.0, 1e200]})
    assert parsed.orientation == pytest.approx([math.sqrt(0.5), 0, 0, math.sqrt(0.5)])
    invalid = pose()
    invalid["orientation"] = [0.0, 0.0, 0.0, 0.0]
    with pytest.raises(ValidationError, match="non-zero finite norm"):
        CameraPose.model_validate(invalid)


@pytest.mark.parametrize(
    "mutation",
    [
        {"upAxis": "y", "forwardAxis": "-y"},
        {"unit": "meters", "metersPerUnit": 0.01},
        {"unit": "custom", "metersPerUnit": 0.0},
    ],
)
def test_coordinate_system_rejects_ambiguous_axes_and_inconsistent_scale(mutation: dict) -> None:
    with pytest.raises(ValidationError):
        CoordinateSystem.model_validate({**coordinate_system(), **mutation})


@pytest.mark.parametrize(
    "uri",
    [
        "https://provider.example/signed.ply?token=secret",
        "/api/outputs/run/file.ply?token=secret",
        "/api/outputs/run/../secret.ply",
        "/api/outputs/run/%2E%2E/secret.ply",
        "/api/outputs/run%2Fsecret.ply",
        "/api/outputs/run/%3Fsecret.ply",
        "/api/outputs/run/%23secret.ply",
        "/api/outputs/run/%0Asecret.ply",
        "/api/outputs/run/%FFsecret.ply",
        "/api/outputs/run\\file.ply",
        "/api/uploads/input.ply",
    ],
)
def test_local_assets_reject_remote_signed_and_traversal_paths(uri: str) -> None:
    with pytest.raises(ValidationError):
        LocalAssetReference.model_validate(
            {"id": "asset", "uri": uri, "mediaType": "application/octet-stream"}
        )


def test_camera_path_requires_one_coordinate_system_unique_ids_and_monotonic_time() -> None:
    value = {
        "schemaVersion": 1,
        "kind": "camera-path",
        "id": "path",
        "coordinateSystem": coordinate_system(),
        "interpolation": "catmull-rom",
        "closed": False,
        "poses": [pose("a", 0.0), pose("b", 1.0)],
    }
    assert len(CameraPath.model_validate(value).poses) == 2

    invalid = copy.deepcopy(value)
    invalid["poses"][1]["timestampSeconds"] = 0.0
    with pytest.raises(ValidationError, match="strictly increasing"):
        CameraPath.model_validate(invalid)
    invalid = copy.deepcopy(value)
    invalid["poses"][1]["id"] = "a"
    with pytest.raises(ValidationError, match="ids must be unique"):
        CameraPath.model_validate(invalid)
    invalid = copy.deepcopy(value)
    invalid["poses"][1]["coordinateSystem"]["id"] = "other"
    with pytest.raises(ValidationError, match="path coordinateSystem"):
        CameraPath.model_validate(invalid)


def test_spatial_context_rejects_duplicate_assets_and_mixed_frames() -> None:
    value = {
        "schemaVersion": 1,
        "kind": "spatial-context",
        "id": "context",
        "coordinateSystem": coordinate_system(),
        "anchors": [
            {"id": "a", "role": "reference", "pose": pose("pa", 0.0), "asset": asset("ia", "a.png")},
            {"id": "b", "role": "target", "pose": pose("pb", 1.0), "asset": asset("ib", "b.png")},
        ],
    }
    assert len(SpatialContext.model_validate(value).anchors) == 2
    invalid = copy.deepcopy(value)
    invalid["anchors"][1]["asset"]["id"] = "ia"
    with pytest.raises(ValidationError, match="anchor asset ids must be unique"):
        SpatialContext.model_validate(invalid)
    invalid = copy.deepcopy(value)
    invalid["anchors"][1]["pose"]["coordinateSystem"]["id"] = "other"
    with pytest.raises(ValidationError, match="context coordinateSystem"):
        SpatialContext.model_validate(invalid)


def depth_frame(identifier: str, timestamp: float, filename: str) -> dict:
    return {
        "schemaVersion": 1,
        "kind": "depth-map",
        "id": identifier,
        "coordinateSystem": coordinate_system(),
        "cameraPose": pose(f"{identifier}-pose", timestamp),
        "asset": asset(f"{identifier}-asset", filename),
        "width": 640,
        "height": 480,
        "encoding": "float32",
        "sampleScale": 1.0, "sampleOffset": 0.0, "invalidSample": None,
        "depthConvention": "axial", "byteOrder": "little",
        "unit": "meters",
        "minDepth": 0.1,
        "maxDepth": 100.0,
    }


def test_depth_contracts_pin_dimensions_units_and_timestamps() -> None:
    frame = depth_frame("depth-a", 0.0, "a.depth")
    assert DepthMap.model_validate(frame).maxDepth == 100.0
    for override in ({"sampleScale": 0}, {"sampleOffset": math.inf},
                     {"encoding": "uint8", "invalidSample": 256},
                     {"encoding": "uint16", "invalidSample": 0.5},
                     {"depthConvention": "unknown"}, {"byteOrder": "native"}):
        with pytest.raises(ValidationError):
            DepthMap.model_validate({**frame, **override})
    assert DepthMap.model_validate({**frame, "encoding": "uint16", "invalidSample": 0,
                                    "sampleScale": 0.001}).sampleScale == 0.001
    sequence = {
        "schemaVersion": 1,
        "kind": "depth-sequence",
        "id": "depths",
        "coordinateSystem": coordinate_system(),
        "frames": [frame, depth_frame("depth-b", 0.1, "b.depth")],
    }
    assert len(DepthSequence.model_validate(sequence).frames) == 2

    invalid = copy.deepcopy(frame)
    invalid["width"] = 320
    with pytest.raises(ValidationError, match="dimensions must match"):
        DepthMap.model_validate(invalid)
    invalid = copy.deepcopy(frame)
    invalid["minDepth"] = 100.0
    with pytest.raises(ValidationError, match="minDepth"):
        DepthMap.model_validate(invalid)
    invalid = copy.deepcopy(sequence)
    invalid["frames"][1]["cameraPose"]["timestampSeconds"] = 0.0
    with pytest.raises(ValidationError, match="strictly increasing"):
        DepthSequence.model_validate(invalid)


def test_point_cloud_bounds_and_sensor_modality_rules() -> None:
    cloud = {
        "schemaVersion": 1,
        "kind": "point-cloud",
        "id": "cloud",
        "coordinateSystem": coordinate_system(),
        "asset": asset("cloud-file", "cloud.ply"),
        "format": "ply",
        "pointCount": 1_000,
        "hasColor": True,
        "hasNormals": False,
    }
    assert PointCloud.model_validate(cloud).pointCount == 1_000
    with pytest.raises(ValidationError):
        PointCloud.model_validate({**cloud, "pointCount": 1_000_000_001})

    rig = {
        "schemaVersion": 1,
        "kind": "sensor-rig",
        "id": "rig",
        "coordinateSystem": coordinate_system(),
        "sensors": [{"id": "rgb", "modality": "rgb", "pose": pose()}],
    }
    assert SensorRig.model_validate(rig).sensors[0].modality == "rgb"
    invalid = copy.deepcopy(rig)
    invalid["sensors"][0]["pose"].pop("intrinsics")
    with pytest.raises(ValidationError, match="require camera intrinsics"):
        SensorRig.model_validate(invalid)
    invalid = copy.deepcopy(rig)
    invalid["sensors"][0]["modality"] = "lidar"
    with pytest.raises(ValidationError, match="cannot carry"):
        SensorRig.model_validate(invalid)


def test_sensor_stream_rejects_duplicate_nonmonotonic_and_mixed_frame_samples() -> None:
    stream = {
        "schemaVersion": 1,
        "kind": "sensor-stream",
        "id": "stream",
        "coordinateSystem": coordinate_system(),
        "rigId": "rig",
        "rig": {"schemaVersion": 1, "kind": "sensor-rig", "id": "rig",
                "coordinateSystem": coordinate_system(),
                "sensors": [{"id": "rgb", "modality": "rgb", "pose": pose()}]},
        "sensorId": "rgb",
        "modality": "rgb",
        "samples": [
            {"id": "a", "timestampSeconds": 0.0, "asset": asset("sa", "a.png")},
            {"id": "b", "timestampSeconds": 0.1, "asset": asset("sb", "b.png"), "pose": pose("pb", 0.1)},
        ],
    }
    assert len(SensorStream.model_validate(stream).samples) == 2
    for override in ({"rigId": "other"}, {"sensorId": "missing"}, {"modality": "depth"}):
        with pytest.raises(ValidationError, match="embedded rig"):
            SensorStream.model_validate({**stream, **override})
    with pytest.raises(ValidationError, match="coordinateSystem"):
        SensorStream.model_validate({**stream, "coordinateSystem": coordinate_system("other-frame")})
    without_rig = {key: value for key, value in stream.items() if key != "rig"}
    with pytest.raises(ValidationError, match="rig"):
        SensorStream.model_validate(without_rig)
    invalid = copy.deepcopy(stream)
    invalid["samples"][1]["timestampSeconds"] = 0.0
    invalid["samples"][1]["pose"]["timestampSeconds"] = 0.0
    with pytest.raises(ValidationError, match="strictly increasing"):
        SensorStream.model_validate(invalid)
    invalid = copy.deepcopy(stream)
    invalid["samples"][1]["pose"]["coordinateSystem"]["id"] = "other"
    with pytest.raises(ValidationError, match="stream coordinateSystem"):
        SensorStream.model_validate(invalid)


def world_v2() -> dict:
    return {
        "schemaVersion": 2,
        "kind": "world",
        "id": "world-1",
        "displayName": "Studio",
        "coordinateSystem": coordinate_system(),
        "session": {
            "schemaVersion": 1,
            "kind": "spatial-session",
            "id": "session",
            "source": "reconstructed",
            "provider": "fixture",
            "model": "local",
            "tags": ["test"],
        },
        "assets": {
            "splats": [
                {"id": "preview", "format": "spz", "asset": asset("spz-file", "world.spz")}
            ],
            "pointCloud": {
                "schemaVersion": 1,
                "kind": "point-cloud",
                "id": "cloud",
                "coordinateSystem": coordinate_system(),
                "asset": asset("cloud-file", "world.ply"),
                "format": "ply",
                "pointCount": 100,
                "hasColor": True,
                "hasNormals": False,
            },
        },
        "defaultCamera": pose("default-camera", 0.0),
    }


def test_world_v2_requires_local_unique_representations_and_one_coordinate_system() -> None:
    for role in ("splat", "panorama", "colliderMesh"):
        invalid_media = copy.deepcopy(world_v2())
        if role == "splat":
            invalid_media["assets"]["splats"][0]["asset"]["mediaType"] = "image/png"
        else:
            invalid_media["assets"][role] = {**asset("wrong-media", "wrong.bin"), "mediaType": "text/html"}
        with pytest.raises(ValidationError, match="mediaType"):
            WorldValueV2.model_validate(invalid_media)
    parsed = WorldValueV2.model_validate(world_v2())
    assert parsed.schemaVersion == 2
    assert parse_spatial_value("World", world_v2()) == parsed

    invalid = copy.deepcopy(world_v2())
    invalid["assets"]["splats"].append(copy.deepcopy(invalid["assets"]["splats"][0]))
    with pytest.raises(ValidationError, match="splat representation ids must be unique"):
        WorldValueV2.model_validate(invalid)
    invalid = copy.deepcopy(world_v2())
    invalid["assets"]["pointCloud"]["asset"]["id"] = "spz-file"
    with pytest.raises(ValidationError, match="local asset ids must be unique"):
        WorldValueV2.model_validate(invalid)
    invalid = copy.deepcopy(world_v2())
    invalid["defaultCamera"]["coordinateSystem"]["id"] = "other"
    with pytest.raises(ValidationError, match="world coordinateSystem"):
        WorldValueV2.model_validate(invalid)


def test_session_metadata_has_bounded_exact_shape() -> None:
    value = {
        "schemaVersion": 1,
        "kind": "spatial-session",
        "id": "session",
        "source": "captured",
        "tags": [],
    }
    assert SpatialSessionMetadata.model_validate(value).source == "captured"
    with pytest.raises(ValidationError):
        SpatialSessionMetadata.model_validate({**value, "tags": ["x"] * 33})


def test_legacy_splat_aliases_validate_every_asset_and_skip_nulls() -> None:
    value = {"schemaVersion": 1, "provider": "worldlabs", "worldId": "world",
             "assets": {"splats": {"full": None, "full_res": "/api/outputs/run/full.spz"}}}
    assert adapt_world_value_v1_to_v2(value).assets.splats[0].id == "full_res"
    for variant in (" padded ", "bad\nkey"):
        invalid = copy.deepcopy(value)
        invalid["assets"]["splats"][variant] = None
        with pytest.raises(ValueError, match="trimmed and control-free"):
            adapt_world_value_v1_to_v2(invalid)
    value["assets"]["splats"] = {"full": "/api/outputs/run/full.spz", "full_res": "https://invalid.example/secret"}
    with pytest.raises(ValueError):
        adapt_world_value_v1_to_v2(value)


def test_legacy_collider_aliases_validate_both_and_fall_back_from_null() -> None:
    value = {"schemaVersion": 1, "provider": "worldlabs", "worldId": "world",
             "assets": {"splats": {"100k": "/api/outputs/run/world.spz"},
                        "colliderMesh": None, "collider_mesh": "/api/outputs/run/mesh.glb"}}
    assert adapt_world_value_v1_to_v2(value).assets.colliderMesh.uri == "/api/outputs/run/mesh.glb"
    value["assets"]["colliderMesh"] = "/api/outputs/run/mesh.glb"
    value["assets"]["collider_mesh"] = "https://invalid.example/secret"
    with pytest.raises(ValueError):
        adapt_world_value_v1_to_v2(value)


def test_world_v1_adapter_is_in_memory_provider_neutral_and_rejects_remote_assets() -> None:
    legacy = {
        "schemaVersion": 1,
        "provider": "worldlabs",
        "worldId": "marble-world",
        "model": "marble-1.1",
        "displayName": "Rooftop",
        "marbleUrl": "https://marble.worldlabs.ai/world/secret",
        "promptType": "image",
        "assets": {
            "splats": {"100k": "/api/outputs/run/world-100k.spz"},
            "panorama": "/api/outputs/run/panorama.jpg",
        },
        "semantics": {
            "coordinateFrame": "marble_raw_opencv",
            "metricScaleFactor": 0.5,
            "groundPlaneOffset": 1.25,
        },
        "caption": "legacy-only metadata",
    }
    original = copy.deepcopy(legacy)
    adapted = adapt_world_value_v1_to_v2(legacy)
    assert legacy == original
    assert adapted.kind == "world"
    assert adapted.coordinateSystem.upAxis == "-y"
    assert adapted.coordinateSystem.forwardAxis == "z"
    assert adapted.coordinateSystem.unit == "custom"
    assert adapted.coordinateSystem.originMeters == [0.0, -1.25, 0.0]
    dumped = dump_spatial_value(adapted)
    assert "marbleUrl" not in dumped
    assert dumped["session"]["provider"] == "worldlabs"

    remote = copy.deepcopy(legacy)
    remote["assets"]["splats"]["100k"] = "https://cdn.example/world.spz?token=secret"
    with pytest.raises(ValidationError):
        adapt_world_value_v1_to_v2(remote)

    early = copy.deepcopy(legacy)
    early.pop("semantics")
    adapted_early = adapt_world_value_v1_to_v2(early)
    assert adapted_early.coordinateSystem.upAxis == "-y"
    assert adapted_early.coordinateSystem.forwardAxis == "z"


def test_unknown_spatial_port_type_rejects() -> None:
    with pytest.raises(ValueError, match="unsupported spatial port type"):
        parse_spatial_value("AtlasWorld", {})


def test_legacy_canonicalization_removes_opaque_provider_urls():
    raw = {
        "schemaVersion": 1, "provider": "worldlabs", "worldId": "legacy",
        "marbleUrl": "https://provider.invalid/private?token=secret",
        "cost": {"receipt": "https://provider.invalid/secret"},
        "extra": {"url": "https://provider.invalid/secret"},
        "assets": {"splats": {"100k": "/api/outputs/run/world.spz"}, "debug": "secret"},
    }
    canonical = canonicalize_world_value_v1(raw)
    assert canonical["schemaVersion"] == 1
    assert canonical["assets"] == {"splats": {"100k": "/api/outputs/run/world.spz"}}
    assert canonical["marbleUrl"] == "https://marble.worldlabs.ai/world/legacy"
    assert "cost" not in canonical and "extra" not in canonical
    assert "secret" not in repr(canonical)
    assert canonicalize_world_value_v1(canonical) == canonical
