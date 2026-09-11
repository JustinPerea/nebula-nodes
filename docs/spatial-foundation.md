# Provider-neutral spatial foundation

> **Implementation status (2026-09-05): implemented locally; acceptance review
> is still in progress. Atlas execution is
> not implemented.** Nebula has strict spatial value contracts, local authoring
> and validation nodes, legacy World compatibility, structured viewers, and a
> fail-closed World Labs capability gate. These are adapter-ready building
> blocks, not an Atlas model integration.

This page is the canonical boundary between World Labs' public Atlas
announcement and the spatial infrastructure Nebula actually implements. The
[World Labs provider guide](./api-guides/worldlabs.md) remains the guide for the
executable public Marble nodes.

## Atlas: announced capabilities, not a public API contract

World Labs announced Atlas on September 1, 2026 as an omni world model in early
access with select partners. The announcement demonstrates the following
capability families:

| Official announcement | Demonstrated scope | Nebula's current status |
|---|---|---|
| Camera-controlled generation | Camera-conditioned images and videos, explicit camera poses and paths, spatial-context conditioning, and videos up to one minute at 1440p | Provider-neutral `CameraPose`, `CameraPath`, and `SpatialContext` contracts exist. No Atlas request adapter exists. |
| Spatial reconstruction | Sparse-to-dense reconstruction from images or video, novel views, depth maps, point clouds, and Gaussian splats | `DepthMap`, `DepthSequence`, `PointCloud`, and World-v2 splat contracts exist. They validate data; they do not invoke Atlas. |
| Space-time simulation | Multiview video reframing, real-to-sim scenes, robot-view RGB/depth generation, and interaction simulation | Sensor/session contracts exist. No Atlas reframing, simulation, or robotics execution node exists. |
| Image generation | Standalone images and 360-degree panoramas from text or image prompts | Nebula has other image providers and a portable panorama slot in World v2. No Atlas image-generation option exists. |

The backend exposes these announcement-level concepts as the identifiers
`camera_conditioned_image`, `camera_conditioned_video`,
`spatial_context_conditioning`, `sparse_reconstruction`, `depth`,
`point_cloud`, `gaussian_splat`, `multiview_reframing`,
`space_time_simulation`, `robotics_rgbd`, `standalone_image`, and
`panorama_360`. They are discovery metadata only: every item is returned as
`availability: "announced_only"` and `executable: false`.

There is no public Atlas model identifier or Atlas endpoint in World Labs'
published World API as of this status date. The public model list contains only
`marble-1.0-draft`, `marble-1.0`, `marble-1.1`, and `marble-1.1-plus`, and the
public generation endpoint is under `/marble/v1/`. Consequently:

- Nebula does not add `atlas`, an invented `atlas-*` identifier, or an Atlas
  endpoint to its node definitions or provider handler.
- A configured `WORLDLABS_API_KEY`, a frontend feature flag, or an environment
  variable is not evidence of Atlas entitlement and cannot enable it.
- Marble output must not be described as Atlas output. The executable World
  Labs nodes remain `worldlabs-environment` and `worldlabs-world-export`.
- No Atlas pricing, rate-limit, cancellation, idempotency, request, response,
  or asset-lifetime contract is assumed from the product announcement.

Primary sources: [Atlas announcement](https://www.worldlabs.ai/blog/atlas),
[World API model list](https://docs.worldlabs.ai/api/models), and
[World API quickstart](https://docs.worldlabs.ai/api).

## What Nebula implements

Nebula's shipped foundation has four independent layers:

1. Strict provider-neutral spatial schemas in the backend and browser.
2. Keyless, synchronous graph nodes that author or validate those values
   locally.
3. World v1 compatibility plus an in-memory World v1-to-v2 adapter.
4. A backend-authoritative World Labs capability manifest that blocks Atlas
   execution until an exact adapter and entitlement pair exists.

The public Marble integration is adjacent to these layers, not evidence of
Atlas support. Marble generation currently emits the established World v1
bundle. The Marble exporter consumes that original v1 bundle. World v2 is
portable descriptive data; its session provider/model fields are not proof of
a provider resource identity. Exporting v2 requires a future backend-verified
provider-resource binding and currently fails before any HTTP request.

## Strict spatial contracts

The authoritative backend contracts are in
[`backend/models/spatial.py`](../backend/models/spatial.py). Mirrored browser
types and rejecting parsers live in
[`frontend/src/types/spatial.ts`](../frontend/src/types/spatial.ts) and
[`frontend/src/lib/spatialValue.ts`](../frontend/src/lib/spatialValue.ts).

All top-level spatial values use an exact `schemaVersion` and `kind`. Unknown
keys are rejected. Backend fields reject reassignment; nested collections are
treated as immutable by consumers. Browser values are
parsed from plain objects and recursively frozen. Identifiers, labels, lists,
dimensions, timestamps, point counts, and finite numeric values are bounded.
Coordinate-system equality is structural, not inferred from a provider name.

| Port type | Versioned shape | Important invariants |
|---|---|---|
| `CameraPose` | v1 `camera-pose` | One explicit coordinate system; finite three-vector position; nonzero quaternion normalized in `[x, y, z, w]` order; optional nonnegative timestamp; optional bounded pinhole intrinsics whose principal point lies on the image plane. |
| `CameraPath` | v1 `camera-path` | 1–10,000 unique poses; every pose uses the path coordinate system and has a strictly increasing timestamp; interpolation is `linear`, `step`, or `catmull-rom`. |
| `SpatialContext` | v1 `spatial-context` | 1–4,096 unique anchors; each anchor pairs a unique pose and unique local asset with role `reference`, `observation`, or `target`; every pose uses the context coordinate system. |
| `DepthMap` | v1 `depth-map` | Local asset plus `float32`, `uint16`, or `uint8` encoding; 1–32,768 pixel dimensions; camera intrinsics required and dimensions must match; depth unit and coordinate system must agree; `0 <= minDepth < maxDepth`. |
| `DepthSequence` | v1 `depth-sequence` | 1–10,000 unique depth frames, poses, and assets in one coordinate system; every pose is timestamped and timestamps strictly increase. |
| `PointCloud` | v1 `point-cloud` | Local PLY, PCD, LAS, LAZ, or XYZ asset; 1–1,000,000,000 points; explicit color and normal flags. |
| `SensorRig` | v1 `sensor-rig` | 1–256 unique sensors and poses in one coordinate system; modalities are RGB, depth, RGB-D, LiDAR, or IMU. Optical sensors require intrinsics; LiDAR and IMU forbid them. |
| `SensorStream` | v1 `sensor-stream` | 1–10,000 unique, strictly timestamped local samples; required embedded `rig` snapshot must match `rigId`, contain `sensorId` with the stream modality, and share its coordinate system. Optional sample poses share that frame and, when timestamped, match the sample timestamp. |
| `SpatialSession` | v1 `spatial-session` | Immutable provenance with source `generated`, `reconstructed`, `captured`, `simulated`, or `imported`; optional provider/model/label/time; at most 32 unique bounded tags. |
| `World` | v2 `world` | Provider-neutral ID, display name, coordinate system, session, and assets; supports SPZ/PLY splats, panorama, collider, thumbnail, point cloud, depth sequence, default camera, and spatial context. At least one representation is required; nested coordinate systems must match; local asset IDs are unique across the world. |

The shared `CoordinateSystem` v1 contract records handedness, distinct absolute
up and forward axes, units, meters-per-unit, and a metric origin. Standard
units have fixed scales (`meters=1`, `centimeters=0.01`,
`millimeters=0.001`); only `custom` accepts another positive scale.

These schemas intentionally say how values move through Nebula, not how an
unpublished provider request should be serialized. Schema coverage therefore
means “ready to receive or produce a valid value,” not “the corresponding Atlas
capability is callable.”

## World v1 preservation and World v2 adaptation

World v1 is the existing Marble-specific graph value and remains supported.
Nebula does not rewrite a saved/imported v1 value to v2 merely because a newer
contract exists:

- Output-storage normalization may convert run-owned filesystem paths to
  portable `/api/outputs/...` references. It validates a v1 World through the
  adapter, then reconstructs the supported v1 fields. Unknown fields and opaque
  billing objects are omitted; the Marble navigation URL is derived from the
  validated world ID. The stored schema version remains v1.
- The `spatial-value-validate` node can explicitly return an adapted World v2
  value while leaving its v1 input object unchanged.
- The browser's World viewer parses and renders both versions. Its standalone
  adapter helper creates a frozen v2 view and does not mutate the imported v1
  object.

The adapter accepts only a valid `schemaVersion: 1`, `provider: "worldlabs"`
World with durable local assets and the supported `marble_raw_opencv`
coordinate frame (the old `provider_native` label normalizes to that frame).
It maps Marble scale and ground offset into an explicit right-handed World-v2
coordinate system with `-Y` up and `+Z` forward. It retains portable splats,
panorama, collider, and thumbnail assets; records generic session provenance;
and drops provider-specific navigation, prompt, and cost fields. Caption text
may seed the generic session label, but the provider-specific `caption` field
does not survive as a World-v2 field.

## Local authoring and validation nodes

These utility nodes are synchronous, keyless, and network-free. They do not
contain Atlas in their definitions or make a World Labs call.

| Node | ID | Local behavior |
|---|---|---|
| Camera Pose | `camera-pose` | Authors a v1 pose, coordinate system, normalized quaternion, timestamp, and optional pinhole intrinsics. |
| Camera Path | `camera-path` | Combines existing pose inputs and validates coordinate-system equality, unique IDs, and strictly increasing timestamps. |
| Spatial Context | `spatial-context` | Pairs equal nonzero lists of camera poses and locally materialized image outputs into anchored context. |
| Sensor Rig | `sensor-rig` | Builds an RGB/depth/RGB-D/LiDAR/IMU rig from poses and applies the modality-specific intrinsics rules. |
| Spatial Value Validate | `spatial-value-validate` | Strictly validates any spatial port type and emits a normalized value plus a compact summary; World v1 is adapted to v2 in memory. |

There are deliberately no local author nodes yet for depth maps, depth
sequences, point clouds, sensor streams, or complete World v2 values. Their
contracts are available for validated imports and future adapters; callers must
not infer an unimplemented producer from the existence of a port type.

## Local asset boundary

Depth maps require explicit decoding metadata: `sampleScale` (positive),
`sampleOffset` (finite), `invalidSample` (finite sentinel or null),
`depthConvention` (`axial` camera-forward depth or `ray-distance` from camera
center), and `byteOrder` (`little`, `big`, or `container-defined`). Distance in
the declared unit is `sample * sampleScale + sampleOffset`. Reject nonfinite
samples, the sentinel, and decoded values outside `[minDepth, maxDepth]`.
Raw raster samples are row-major, top-left origin, one sample per pixel;
`container-defined` requires a self-describing container decoder, not host
native byte order. These are contract semantics, not an implemented decoder.
Older draft depth values missing this metadata are rejected rather than guessed.

Every asset embedded in a v1-adapted or native spatial contract must be a
`LocalAssetReference` owned by Nebula:

- `uri` must be a durable path below `/api/outputs/`.
- Schemes, authorities, query strings, fragments, backslashes, malformed
  percent encoding, empty segments, dot segments, and encoded path separators
  are rejected.
- The URI is limited to 2,048 characters. IDs are bounded, `mediaType` must be
  a syntactically valid MIME type, and optional `byteLength` is a positive safe
  integer.
- Remote, provider-signed, data, private-network, and tracking URLs cannot be
  smuggled into a valid spatial value. Local node inputs are normalized through
  the existing portable-output resolver before schema validation.

This rule is stricter than merely hiding a signed URL in the UI: an invalid
reference fails at the contract boundary and cannot render as a successful
structured output.

## Structured viewer registry

[`representationViewerRegistry.ts`](../frontend/src/lib/representationViewerRegistry.ts)
contains the single acceptance registry for structured spatial output rendering;
[`RepresentationViewer.tsx`](../frontend/src/components/nodes/RepresentationViewer.tsx)
consumes it. Every
entry parses before it renders; malformed values receive an explicit invalid
state rather than ad hoc property access.

The registry covers World v1/v2, camera pose/path, spatial context, depth
map/sequence, point cloud, sensor rig/stream, and spatial session. It is reused
by standard nodes, dynamic nodes, and Create Studio output rendering. World v1
keeps the dedicated lazy interactive Marble/SPZ preview. World v2 and the other
types currently render bounded summary cards and local download links; this is
not a claim that Nebula has interactive renderers or authoring nodes for every
representation.

## Backend capability gate

`GET /api/capabilities/worldlabs` returns backend-owned capability facts
without reading credentials or contacting World Labs. In the current build it
reports public Marble support and this Atlas state:

```json
{
  "availability": "announced_only",
  "announcementStage": "early_access_select_partners",
  "adapterStatus": "absent",
  "entitlementStatus": "unverified",
  "executionStatus": "blocked",
  "executable": false,
  "blockReason": "versioned_adapter_not_installed"
}
```

Future Atlas execution requires all of these backend conditions:

1. An installed `AtlasAdapterInstallation` with a nonblank
   `contract_version` and a `contract_hash` exactly matching
   `sha256:` followed by 64 lowercase hexadecimal characters.
2. A backend-verified `VerifiedAtlasEntitlement` whose nonblank
   `contract_version` and exact SHA-256 contract hash both match the installed
   adapter.
3. Every adapter operation has a matching backend operation policy, node
   definition, and exact registered handler. Paid operations must participate in
   durable recovery, start admission, cache bypass, and quick-run policy.

An adapter without a matching entitlement remains blocked with
`entitlement_not_verified_for_adapter`. Entitlement metadata without an
installed adapter remains blocked with `versioned_adapter_not_installed`.
Only a matching pair with complete operation registration changes the top-level Atlas state to `adapter_ready`,
`enabled`, and `executable: true`.

Any future provider execution path must be explicitly wired to the installed
adapter and call `require_atlas_execution()` before submission. The current
singleton installs neither object, and no Atlas handler or node is registered.
The announcement-level capability entries remain non-executable placeholders;
a future adapter must define which operations it actually implements rather
than treating the announcement list as a request contract.

## Code and verification references

- Backend schemas and World adapter:
  [`backend/models/spatial.py`](../backend/models/spatial.py)
- Local spatial handlers:
  [`backend/handlers/spatial.py`](../backend/handlers/spatial.py)
- Capability manifest and execution guard:
  [`backend/services/worldlabs_capabilities.py`](../backend/services/worldlabs_capabilities.py)
- Node definitions:
  [`backend/data/node_definitions.json`](../backend/data/node_definitions.json)
- Browser parsers and adapter:
  [`frontend/src/lib/spatialValue.ts`](../frontend/src/lib/spatialValue.ts)
- Viewer registry:
  [`frontend/src/lib/representationViewerRegistry.ts`](../frontend/src/lib/representationViewerRegistry.ts) and
  [`frontend/src/components/nodes/RepresentationViewer.tsx`](../frontend/src/components/nodes/RepresentationViewer.tsx)
- Contract and compatibility tests:
  [`backend/tests/test_spatial_contracts.py`](../backend/tests/test_spatial_contracts.py),
  [`backend/tests/test_spatial_handlers.py`](../backend/tests/test_spatial_handlers.py), and
  [`backend/tests/test_worldlabs_capabilities.py`](../backend/tests/test_worldlabs_capabilities.py)
