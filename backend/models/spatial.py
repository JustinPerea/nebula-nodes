"""Strict, provider-neutral spatial value contracts.

These models describe values that may flow between Nebula graph ports. They do
not describe a provider request and deliberately contain no Atlas endpoint or
model identifier. Every asset reference is a durable, backend-owned output URL;
ephemeral or signed provider URLs are rejected at the contract boundary.
"""

from __future__ import annotations

import math
import re
from typing import Annotated, Any, Callable, ClassVar, Literal, Self
from urllib.parse import quote, unquote, urlsplit

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)


def _trimmed_without_controls(value: str) -> str:
    if value != value.strip() or any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError("must be trimmed and contain no control characters")
    return value


Identifier = Annotated[
    str,
    StringConstraints(strict=True, min_length=1, max_length=128),
    AfterValidator(_trimmed_without_controls),
]
Label = Annotated[
    str,
    StringConstraints(strict=True, min_length=1, max_length=256),
    AfterValidator(_trimmed_without_controls),
]
ShortString = Annotated[
    str,
    StringConstraints(strict=True, min_length=1, max_length=128),
    AfterValidator(_trimmed_without_controls),
]
AssetUri = Annotated[
    str,
    StringConstraints(strict=True, min_length=1, max_length=2048),
    AfterValidator(_trimmed_without_controls),
]
Tag = Annotated[
    str,
    StringConstraints(strict=True, min_length=1, max_length=64),
    AfterValidator(_trimmed_without_controls),
]
Dimension = Annotated[int, Field(strict=True, ge=1, le=32_768)]
ByteLength = Annotated[int, Field(strict=True, ge=1, le=9_007_199_254_740_991)]
PointCount = Annotated[int, Field(strict=True, ge=1, le=1_000_000_000)]
FiniteFloat = Annotated[float, Field(strict=True, allow_inf_nan=False)]
NonNegativeFloat = Annotated[float, Field(strict=True, allow_inf_nan=False, ge=0)]
PositiveFloat = Annotated[float, Field(strict=True, allow_inf_nan=False, gt=0)]
Vec3 = Annotated[list[FiniteFloat], Field(min_length=3, max_length=3)]
Quaternion = Annotated[list[FiniteFloat], Field(min_length=4, max_length=4)]

AxisDirection = Literal["x", "-x", "y", "-y", "z", "-z"]
SpatialUnit = Literal["meters", "centimeters", "millimeters", "custom"]
Handedness = Literal["right", "left"]
Interpolation = Literal["linear", "step", "catmull-rom"]
AnchorRole = Literal["reference", "observation", "target"]
DepthEncoding = Literal["float32", "uint16", "uint8"]
PointFormat = Literal["ply", "pcd", "las", "laz", "xyz"]
SensorModality = Literal["rgb", "depth", "rgbd", "lidar", "imu"]
SessionSource = Literal["generated", "reconstructed", "captured", "simulated", "imported"]
SplatFormat = Literal["spz", "ply"]


class ExactSpatialModel(BaseModel):
    """Base contract: strict input, exact keys, immutable normalized output."""

    model_config = ConfigDict(extra="forbid", frozen=True, strict=True)

    @model_validator(mode="before")
    @classmethod
    def reject_boolean_schema_version(cls, value: Any) -> Any:
        if isinstance(value, dict) and isinstance(value.get("schemaVersion"), bool):
            raise ValueError("schemaVersion must be a numeric version, not a boolean")
        return value


class CoordinateSystem(ExactSpatialModel):
    schemaVersion: Literal[1]
    kind: Literal["coordinate-system"]
    id: Identifier
    handedness: Handedness
    upAxis: AxisDirection
    forwardAxis: AxisDirection
    unit: SpatialUnit
    metersPerUnit: PositiveFloat
    originMeters: Vec3

    _UNIT_SCALE: ClassVar[dict[str, float]] = {
        "meters": 1.0,
        "centimeters": 0.01,
        "millimeters": 0.001,
    }

    @model_validator(mode="after")
    def validate_axes_and_scale(self) -> Self:
        if self.upAxis.lstrip("-") == self.forwardAxis.lstrip("-"):
            raise ValueError("upAxis and forwardAxis must use different absolute axes")
        expected = self._UNIT_SCALE.get(self.unit)
        if expected is not None and self.metersPerUnit != expected:
            raise ValueError(f"metersPerUnit must be {expected:g} for unit {self.unit}")
        return self


class LocalAssetReference(ExactSpatialModel):
    id: Identifier
    uri: AssetUri
    mediaType: ShortString
    byteLength: ByteLength | None = None

    @field_validator("uri")
    @classmethod
    def validate_local_output_uri(cls, value: str) -> str:
        if any(ord(character) < 32 or ord(character) == 127 for character in value):
            raise ValueError("asset uri contains control characters")
        if "\\" in value:
            raise ValueError("asset uri cannot contain backslashes")
        if re.search(r"%(?![0-9a-fA-F]{2})", value):
            raise ValueError("asset uri contains malformed URL encoding")
        parsed = urlsplit(value)
        if parsed.scheme or parsed.netloc or parsed.query or parsed.fragment:
            raise ValueError("asset uri must not contain a scheme, authority, query, or fragment")
        if not parsed.path.startswith("/api/outputs/") or parsed.path == "/api/outputs/":
            raise ValueError("asset uri must be a durable /api/outputs/... path")
        for segment in parsed.path.removeprefix("/api/outputs/").split("/"):
            try:
                decoded = unquote(segment, errors="strict")
            except (UnicodeDecodeError, ValueError) as exc:
                raise ValueError("asset uri contains malformed UTF-8 encoding") from exc
            if (
                not decoded
                or decoded in {".", ".."}
                or any(character in decoded for character in ("/", "\\", "?", "#"))
                or any(ord(character) < 32 or ord(character) == 127 for character in decoded)
            ):
                raise ValueError("asset uri cannot contain empty, dot, or encoded path segments")
        return value

    @field_validator("mediaType")
    @classmethod
    def validate_media_type(cls, value: str) -> str:
        if not re.fullmatch(
            r"[a-z0-9][a-z0-9!#$&^_.+\-]*/[a-z0-9][a-z0-9!#$&^_.+*\-]*",
            value,
            flags=re.IGNORECASE,
        ):
            raise ValueError("mediaType must be a MIME media type")
        return value


class CameraIntrinsics(ExactSpatialModel):
    model: Literal["pinhole"]
    width: Dimension
    height: Dimension
    fx: Annotated[float, Field(strict=True, allow_inf_nan=False, gt=0, le=10_000_000)]
    fy: Annotated[float, Field(strict=True, allow_inf_nan=False, gt=0, le=10_000_000)]
    cx: FiniteFloat
    cy: FiniteFloat
    skew: Annotated[float, Field(strict=True, allow_inf_nan=False, ge=-10_000_000, le=10_000_000)] | None = None

    @model_validator(mode="after")
    def validate_principal_point(self) -> Self:
        if not 0 <= self.cx <= self.width:
            raise ValueError("cx must lie within the image width")
        if not 0 <= self.cy <= self.height:
            raise ValueError("cy must lie within the image height")
        return self


class CameraPose(ExactSpatialModel):
    """Camera origin and camera-to-world rotation in its coordinate system.

    Orientation is a normalized quaternion in x, y, z, w order. Position is
    expressed in coordinateSystem.unit relative to coordinateSystem.originMeters.
    """
    schemaVersion: Literal[1]
    kind: Literal["camera-pose"]
    id: Identifier
    coordinateSystem: CoordinateSystem
    position: Vec3
    orientation: Quaternion
    intrinsics: CameraIntrinsics | None = None
    timestampSeconds: NonNegativeFloat | None = None

    @field_validator("orientation")
    @classmethod
    def normalize_orientation(cls, value: Quaternion) -> Quaternion:
        norm = math.hypot(*value)
        if not math.isfinite(norm) or norm <= 1e-12:
            raise ValueError("orientation quaternion must have a non-zero finite norm")
        return [component / norm for component in value]


def _same_coordinate_system(left: CoordinateSystem, right: CoordinateSystem) -> bool:
    return left == right


def _require_unique_ids(items: list[Any], label: str) -> None:
    ids = [item.id for item in items]
    if len(ids) != len(set(ids)):
        raise ValueError(f"{label} ids must be unique")


class CameraPath(ExactSpatialModel):
    schemaVersion: Literal[1]
    kind: Literal["camera-path"]
    id: Identifier
    coordinateSystem: CoordinateSystem
    interpolation: Interpolation
    closed: bool
    poses: Annotated[list[CameraPose], Field(min_length=1, max_length=10_000)]

    @model_validator(mode="after")
    def validate_path(self) -> Self:
        _require_unique_ids(self.poses, "camera pose")
        timestamps: list[float] = []
        for pose in self.poses:
            if not _same_coordinate_system(pose.coordinateSystem, self.coordinateSystem):
                raise ValueError("every path pose must use the path coordinateSystem")
            if pose.timestampSeconds is None:
                raise ValueError("every path pose must include timestampSeconds")
            timestamps.append(pose.timestampSeconds)
        if any(current <= previous for previous, current in zip(timestamps, timestamps[1:])):
            raise ValueError("camera path timestamps must be strictly increasing")
        return self


class SpatialAnchor(ExactSpatialModel):
    id: Identifier
    role: AnchorRole
    pose: CameraPose
    asset: LocalAssetReference


class SpatialContext(ExactSpatialModel):
    schemaVersion: Literal[1]
    kind: Literal["spatial-context"]
    id: Identifier
    coordinateSystem: CoordinateSystem
    anchors: Annotated[list[SpatialAnchor], Field(min_length=1, max_length=4_096)]

    @model_validator(mode="after")
    def validate_anchors(self) -> Self:
        _require_unique_ids(self.anchors, "anchor")
        _require_unique_ids([anchor.pose for anchor in self.anchors], "anchor pose")
        _require_unique_ids([anchor.asset for anchor in self.anchors], "anchor asset")
        if any(
            not _same_coordinate_system(anchor.pose.coordinateSystem, self.coordinateSystem)
            for anchor in self.anchors
        ):
            raise ValueError("every anchor pose must use the context coordinateSystem")
        return self


class DepthMap(ExactSpatialModel):
    schemaVersion: Literal[1]
    kind: Literal["depth-map"]
    id: Identifier
    coordinateSystem: CoordinateSystem
    cameraPose: CameraPose
    asset: LocalAssetReference
    width: Dimension
    height: Dimension
    encoding: DepthEncoding
    sampleScale: PositiveFloat
    sampleOffset: FiniteFloat
    invalidSample: FiniteFloat | None
    depthConvention: Literal["axial", "ray-distance"]
    byteOrder: Literal["little", "big", "container-defined"]
    unit: SpatialUnit
    minDepth: NonNegativeFloat
    maxDepth: PositiveFloat

    @model_validator(mode="after")
    def validate_depth_map(self) -> Self:
        if self.invalidSample is not None and self.encoding != "float32":
            limit = 255 if self.encoding == "uint8" else 65_535
            if not self.invalidSample.is_integer() or not 0 <= self.invalidSample <= limit:
                raise ValueError("invalidSample must be representable in the depth encoding")
        if not _same_coordinate_system(self.cameraPose.coordinateSystem, self.coordinateSystem):
            raise ValueError("depth cameraPose must use the depth coordinateSystem")
        if self.unit != self.coordinateSystem.unit:
            raise ValueError("depth unit must match coordinateSystem.unit")
        intrinsics = self.cameraPose.intrinsics
        if intrinsics is None:
            raise ValueError("depth cameraPose requires pinhole intrinsics")
        if intrinsics.width != self.width or intrinsics.height != self.height:
            raise ValueError("depth dimensions must match camera intrinsics")
        if self.minDepth >= self.maxDepth:
            raise ValueError("minDepth must be less than maxDepth")
        return self


class DepthSequence(ExactSpatialModel):
    schemaVersion: Literal[1]
    kind: Literal["depth-sequence"]
    id: Identifier
    coordinateSystem: CoordinateSystem
    frames: Annotated[list[DepthMap], Field(min_length=1, max_length=10_000)]

    @model_validator(mode="after")
    def validate_frames(self) -> Self:
        _require_unique_ids(self.frames, "depth frame")
        _require_unique_ids([frame.cameraPose for frame in self.frames], "depth camera pose")
        _require_unique_ids([frame.asset for frame in self.frames], "depth asset")
        timestamps: list[float] = []
        for frame in self.frames:
            if not _same_coordinate_system(frame.coordinateSystem, self.coordinateSystem):
                raise ValueError("every depth frame must use the sequence coordinateSystem")
            if frame.unit != self.coordinateSystem.unit:
                raise ValueError("every depth frame unit must match the sequence coordinateSystem")
            timestamp = frame.cameraPose.timestampSeconds
            if timestamp is None:
                raise ValueError("every depth frame cameraPose requires timestampSeconds")
            timestamps.append(timestamp)
        if any(current <= previous for previous, current in zip(timestamps, timestamps[1:])):
            raise ValueError("depth frame timestamps must be strictly increasing")
        return self


class PointCloud(ExactSpatialModel):
    schemaVersion: Literal[1]
    kind: Literal["point-cloud"]
    id: Identifier
    coordinateSystem: CoordinateSystem
    asset: LocalAssetReference
    format: PointFormat
    pointCount: PointCount
    hasColor: bool
    hasNormals: bool


class SensorDefinition(ExactSpatialModel):
    id: Identifier
    modality: SensorModality
    pose: CameraPose

    @model_validator(mode="after")
    def validate_intrinsics_for_modality(self) -> Self:
        if self.modality in {"rgb", "depth", "rgbd"} and self.pose.intrinsics is None:
            raise ValueError(f"{self.modality} sensors require camera intrinsics")
        if self.modality in {"lidar", "imu"} and self.pose.intrinsics is not None:
            raise ValueError(f"{self.modality} sensors cannot carry camera intrinsics")
        return self


class SensorRig(ExactSpatialModel):
    schemaVersion: Literal[1]
    kind: Literal["sensor-rig"]
    id: Identifier
    coordinateSystem: CoordinateSystem
    sensors: Annotated[list[SensorDefinition], Field(min_length=1, max_length=256)]

    @model_validator(mode="after")
    def validate_sensors(self) -> Self:
        _require_unique_ids(self.sensors, "sensor")
        _require_unique_ids([sensor.pose for sensor in self.sensors], "sensor pose")
        if any(
            not _same_coordinate_system(sensor.pose.coordinateSystem, self.coordinateSystem)
            for sensor in self.sensors
        ):
            raise ValueError("every sensor pose must use the rig coordinateSystem")
        return self


class SensorSample(ExactSpatialModel):
    id: Identifier
    timestampSeconds: NonNegativeFloat
    asset: LocalAssetReference
    pose: CameraPose | None = None

    @model_validator(mode="after")
    def validate_pose_timestamp(self) -> Self:
        if (
            self.pose is not None
            and self.pose.timestampSeconds is not None
            and self.pose.timestampSeconds != self.timestampSeconds
        ):
            raise ValueError("sample pose timestampSeconds must equal the sample timestampSeconds")
        return self


class SensorStream(ExactSpatialModel):
    schemaVersion: Literal[1]
    kind: Literal["sensor-stream"]
    id: Identifier
    coordinateSystem: CoordinateSystem
    rigId: Identifier
    rig: SensorRig
    sensorId: Identifier
    modality: SensorModality
    samples: Annotated[list[SensorSample], Field(min_length=1, max_length=10_000)]

    @model_validator(mode="after")
    def validate_samples(self) -> Self:
        if self.rig.id != self.rigId:
            raise ValueError("stream rigId must match embedded rig.id")
        if not _same_coordinate_system(self.rig.coordinateSystem, self.coordinateSystem):
            raise ValueError("stream rig must use the stream coordinateSystem")
        sensor = next((sensor for sensor in self.rig.sensors if sensor.id == self.sensorId), None)
        if sensor is None or sensor.modality != self.modality:
            raise ValueError("stream sensorId and modality must match an embedded rig sensor")
        _require_unique_ids(self.samples, "sensor sample")
        _require_unique_ids([sample.asset for sample in self.samples], "sensor sample asset")
        _require_unique_ids(
            [sample.pose for sample in self.samples if sample.pose is not None],
            "sensor sample pose",
        )
        timestamps = [sample.timestampSeconds for sample in self.samples]
        if any(current <= previous for previous, current in zip(timestamps, timestamps[1:])):
            raise ValueError("sensor sample timestamps must be strictly increasing")
        for sample in self.samples:
            if sample.pose and not _same_coordinate_system(
                sample.pose.coordinateSystem, self.coordinateSystem
            ):
                raise ValueError("every sample pose must use the stream coordinateSystem")
        return self


class SpatialSessionMetadata(ExactSpatialModel):
    """Descriptive session metadata; it grants no provider resource authority."""
    schemaVersion: Literal[1]
    kind: Literal["spatial-session"]
    id: Identifier
    source: SessionSource
    createdAtMs: Annotated[int, Field(strict=True, ge=0, le=9_007_199_254_740_991)] | None = None
    provider: ShortString | None = None
    model: ShortString | None = None
    label: Label | None = None
    tags: Annotated[list[Tag], Field(max_length=32)]

    @field_validator("tags")
    @classmethod
    def validate_unique_tags(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("tags must not contain duplicates")
        return value


class WorldSplatRepresentation(ExactSpatialModel):
    id: Identifier
    format: SplatFormat
    asset: LocalAssetReference
    pointCount: PointCount | None = None

    @model_validator(mode="after")
    def validate_media_role(self) -> Self:
        allowed = {"application/octet-stream"}
        allowed.update({"application/vnd.spark.spz"} if self.format == "spz" else
                       {"application/ply", "application/x-ply", "model/ply"})
        if self.asset.mediaType.lower() not in allowed:
            raise ValueError("splat mediaType must match its format")
        return self


class WorldAssetsV2(ExactSpatialModel):
    splats: Annotated[list[WorldSplatRepresentation], Field(max_length=64)]
    panorama: LocalAssetReference | None = None
    colliderMesh: LocalAssetReference | None = None
    thumbnail: LocalAssetReference | None = None
    pointCloud: PointCloud | None = None
    depthSequence: DepthSequence | None = None

    @model_validator(mode="after")
    def validate_media_roles(self) -> Self:
        image_types = {"application/octet-stream", "image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"}
        for asset in (self.panorama, self.thumbnail):
            if asset and asset.mediaType.lower() not in image_types:
                raise ValueError("world image mediaType must be a supported raster type")
        if self.colliderMesh and self.colliderMesh.mediaType.lower() not in {
            "application/octet-stream", "model/gltf-binary", "model/gltf+json"
        }:
            raise ValueError("collider mediaType must be glTF")
        return self


class WorldValueV2(ExactSpatialModel):
    schemaVersion: Literal[2]
    kind: Literal["world"]
    id: Identifier
    displayName: Label
    coordinateSystem: CoordinateSystem
    session: SpatialSessionMetadata
    assets: WorldAssetsV2
    defaultCamera: CameraPose | None = None
    spatialContext: SpatialContext | None = None

    @model_validator(mode="after")
    def validate_world(self) -> Self:
        representations = self.assets.splats
        _require_unique_ids(representations, "splat representation")
        if not any(
            (
                representations,
                self.assets.panorama,
                self.assets.colliderMesh,
                self.assets.pointCloud,
                self.assets.depthSequence,
            )
        ):
            raise ValueError("world assets must contain at least one spatial representation")

        nested_systems: list[CoordinateSystem] = []
        if self.assets.pointCloud:
            nested_systems.append(self.assets.pointCloud.coordinateSystem)
        if self.assets.depthSequence:
            nested_systems.append(self.assets.depthSequence.coordinateSystem)
        if self.defaultCamera:
            nested_systems.append(self.defaultCamera.coordinateSystem)
        if self.spatialContext:
            nested_systems.append(self.spatialContext.coordinateSystem)
        if any(not _same_coordinate_system(system, self.coordinateSystem) for system in nested_systems):
            raise ValueError("every nested spatial value must use the world coordinateSystem")

        asset_references: list[LocalAssetReference] = [item.asset for item in representations]
        for optional_asset in (
            self.assets.panorama,
            self.assets.colliderMesh,
            self.assets.thumbnail,
        ):
            if optional_asset:
                asset_references.append(optional_asset)
        if self.assets.pointCloud:
            asset_references.append(self.assets.pointCloud.asset)
        if self.assets.depthSequence:
            asset_references.extend(frame.asset for frame in self.assets.depthSequence.frames)
        if self.spatialContext:
            asset_references.extend(anchor.asset for anchor in self.spatialContext.anchors)
        _require_unique_ids(asset_references, "local asset")
        return self


SPATIAL_VALUE_MODELS: dict[str, type[ExactSpatialModel]] = {
    "CameraPose": CameraPose,
    "CameraPath": CameraPath,
    "SpatialContext": SpatialContext,
    "DepthMap": DepthMap,
    "DepthSequence": DepthSequence,
    "PointCloud": PointCloud,
    "SensorRig": SensorRig,
    "SensorStream": SensorStream,
    "SpatialSession": SpatialSessionMetadata,
    "World": WorldValueV2,
}


def parse_spatial_value(port_type: str, value: Any) -> ExactSpatialModel:
    """Validate and normalize a structured value for a spatial port type."""

    model = SPATIAL_VALUE_MODELS.get(port_type)
    if model is None:
        raise ValueError(f"unsupported spatial port type: {port_type}")
    return model.model_validate(value)


def dump_spatial_value(value: ExactSpatialModel) -> dict[str, Any]:
    """Return the canonical JSON representation used on graph ports."""

    return value.model_dump(mode="json", exclude_none=True)


def iter_local_asset_references(value: Any):
    """Walk validated spatial models without interpreting arbitrary JSON keys."""
    if isinstance(value, LocalAssetReference):
        yield value
    elif isinstance(value, BaseModel):
        for field_name in type(value).model_fields:
            yield from iter_local_asset_references(getattr(value, field_name))
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from iter_local_asset_references(item)


def _legacy_string(record: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value
    return None


def _legacy_number(record: dict[str, Any], *keys: str) -> float | None:
    for key in keys:
        value = record.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
            return float(value)
    return None


def _legacy_asset(
    asset_id: str,
    uri: Any,
    media_type: str,
    normalize_uri: Callable[[str], str],
) -> LocalAssetReference | None:
    if uri is None:
        return None
    if not isinstance(uri, str):
        raise ValueError(f"legacy asset {asset_id} must be a string")
    return LocalAssetReference(id=asset_id, uri=normalize_uri(uri), mediaType=media_type)


def adapt_world_value_v1_to_v2(
    value: Any,
    *,
    session_id: str | None = None,
    created_at_ms: int | None = None,
    asset_uri_normalizer: Callable[[str], str] | None = None,
) -> WorldValueV2:
    """Adapt a valid legacy Marble World value in memory.

    The legacy value is never mutated. Provider navigation URLs, captions, and
    cost metadata intentionally do not enter the provider-neutral v2 contract.
    All represented media must already be a durable local output.
    """

    normalize_asset_uri = asset_uri_normalizer or (lambda uri: uri)
    if not isinstance(value, dict):
        raise ValueError("legacy World value must be an object")
    schema_version = value.get("schemaVersion", value.get("schema_version"))
    if isinstance(schema_version, bool) or schema_version != 1 or value.get("provider") != "worldlabs":
        raise ValueError("legacy World value must be a World Labs schemaVersion 1 value")

    world_id = _legacy_string(value, "worldId", "world_id")
    if world_id is None:
        raise ValueError("legacy World value requires worldId")
    model = _legacy_string(value, "model") or "marble"
    display_name = _legacy_string(value, "displayName", "display_name") or world_id
    assets = value.get("assets")
    semantics = value.get("semantics", {})
    if not isinstance(assets, dict) or not isinstance(semantics, dict):
        raise ValueError("legacy World value requires an assets object and optional semantics object")

    coordinate_frame = _legacy_string(semantics, "coordinateFrame", "coordinate_frame")
    if coordinate_frame in {None, "provider_native"}:
        coordinate_frame = "marble_raw_opencv"
    if coordinate_frame != "marble_raw_opencv":
        raise ValueError("legacy World coordinateFrame is not supported by the v2 adapter")

    metric_scale = _legacy_number(semantics, "metricScaleFactor", "metric_scale_factor")
    if metric_scale is None:
        metric_scale = 1.0
    if metric_scale <= 0:
        raise ValueError("legacy metricScaleFactor must be positive")
    ground_offset = _legacy_number(semantics, "groundPlaneOffset", "ground_plane_offset") or 0.0
    coordinate_system = CoordinateSystem(
        schemaVersion=1,
        kind="coordinate-system",
        id="world",
        handedness="right",
        upAxis="-y",
        forwardAxis="z",
        unit="meters" if metric_scale == 1.0 else "custom",
        metersPerUnit=metric_scale,
        originMeters=[0.0, -ground_offset, 0.0],
    )

    raw_splats = assets.get("splats")
    if not isinstance(raw_splats, dict):
        raise ValueError("legacy World assets.splats must be an object")
    if len(raw_splats) > 64:
        raise ValueError("legacy World assets.splats must contain at most 64 variants")
    splats: list[WorldSplatRepresentation] = []
    seen_variants: set[str] = set()
    aliases = {"full": "full_res", "fullRes": "full_res"}
    for raw_variant, raw_uri in raw_splats.items():
        if not isinstance(raw_variant, str) or not raw_variant or len(raw_variant) > 128:
            raise ValueError("legacy splat variant ids must be bounded non-empty strings")
        if raw_variant in {"__proto__", "prototype", "constructor"}:
            raise ValueError("legacy splat variant id is reserved")
        if raw_variant != raw_variant.strip() or any(ord(char) <= 31 or ord(char) == 127 for char in raw_variant):
            raise ValueError("legacy splat variant ids must be trimmed and control-free")
        variant = aliases.get(raw_variant, raw_variant)
        asset = _legacy_asset(
            f"splat-{len(splats) + 1}",
            raw_uri,
            "application/vnd.spark.spz",
            normalize_asset_uri,
        )
        if asset is None:
            continue
        if variant in seen_variants:
            continue
        seen_variants.add(variant)
        count_match = re.fullmatch(r"(\d+)k", variant, flags=re.IGNORECASE)
        point_count = int(count_match.group(1)) * 1_000 if count_match else None
        if point_count is not None and not 1 <= point_count <= 1_000_000_000:
            point_count = None
        splats.append(
            WorldSplatRepresentation(
                id=variant,
                format="spz",
                asset=asset,
                pointCount=point_count,
            )
        )
    if not splats:
        raise ValueError("legacy World requires at least one durable local splat")

    def legacy_image_type(uri: Any) -> str:
        suffix = str(uri).rsplit("/", 1)[-1].rsplit(".", 1)[-1].lower()
        return {
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg",
            "webp": "image/webp",
            "gif": "image/gif",
        }.get(suffix, "image/png")

    panorama_uri = assets.get("panorama")
    panorama = _legacy_asset(
        "panorama",
        panorama_uri,
        legacy_image_type(panorama_uri),
        normalize_asset_uri,
    )
    collider = _legacy_asset(
        "collider-mesh",
        assets.get("colliderMesh"),
        "model/gltf-binary",
        normalize_asset_uri,
    )
    legacy_collider = _legacy_asset(
        "collider-mesh",
        assets.get("collider_mesh"),
        "model/gltf-binary",
        normalize_asset_uri,
    )
    collider = collider or legacy_collider
    thumbnail_uri = assets.get("thumbnail")
    thumbnail = _legacy_asset(
        "thumbnail",
        thumbnail_uri,
        legacy_image_type(thumbnail_uri),
        normalize_asset_uri,
    )
    session_label = _legacy_string(value, "caption") or display_name
    session = SpatialSessionMetadata(
        schemaVersion=1,
        kind="spatial-session",
        id=session_id or world_id,
        source="generated",
        createdAtMs=created_at_ms,
        provider="worldlabs",
        model=model,
        label=session_label,
        tags=[],
    )
    return WorldValueV2(
        schemaVersion=2,
        kind="world",
        id=world_id,
        displayName=display_name,
        coordinateSystem=coordinate_system,
        session=session,
        assets=WorldAssetsV2(
            splats=splats,
            panorama=panorama,
            colliderMesh=collider,
            thumbnail=thumbnail,
        ),
    )


def canonicalize_world_value_v1(
    value: Any,
    *,
    asset_uri_normalizer: Callable[[str], str] | None = None,
) -> dict[str, Any]:
    """Preserve schema v1 using only validated, portable legacy fields.

    Opaque provider fields and navigation URLs are not a persistence contract.
    Reconstructing the allowlist also removes signed URLs hidden in extra keys.
    """
    adapted = adapt_world_value_v1_to_v2(
        value, asset_uri_normalizer=asset_uri_normalizer
    )
    assets: dict[str, Any] = {
        "splats": {splat.id: splat.asset.uri for splat in adapted.assets.splats},
    }
    for name in ("panorama", "colliderMesh", "thumbnail"):
        asset = getattr(adapted.assets, name)
        if asset is not None:
            assets[name] = asset.uri
    result: dict[str, Any] = {
        "schemaVersion": 1,
        "provider": "worldlabs",
        "worldId": adapted.id,
        "model": adapted.session.model,
        "displayName": adapted.displayName,
        "marbleUrl": f"https://marble.worldlabs.ai/world/{quote(adapted.id, safe='')}",
        "promptType": _legacy_string(value, "promptType", "prompt_type") or "text",
        "assets": assets,
        "semantics": {
            "coordinateFrame": "marble_raw_opencv",
            "metricScaleFactor": adapted.coordinateSystem.metersPerUnit,
            "groundPlaneOffset": -adapted.coordinateSystem.originMeters[1],
        },
    }
    caption = _legacy_string(value, "caption")
    if caption is not None:
        result["caption"] = caption
    return result
