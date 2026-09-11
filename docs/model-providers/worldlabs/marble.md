---
id: nebula-worldlabs-marble
kind: project-model-integration
project: nebula_nodes
provider: worldlabs
status: active
verified: 2026-09-03
stale_after_days: 14
---

# World Labs Marble structural audit

This note audits Nebula's World Labs integration against the public Marble
World API. It is a structural audit with mocked HTTP coverage; no paid live
generation or HQ mesh export was performed on 2026-09-03.

## Canonical sources

Accessed 2026-09-03:

- [Public API quickstart](https://docs.worldlabs.ai/api)
- [Get credits OpenAPI](https://docs.worldlabs.ai/api/reference/credits/get)
- [Generate world OpenAPI](https://docs.worldlabs.ai/api/reference/worlds/generate)
- [Prepare upload OpenAPI](https://docs.worldlabs.ai/api/reference/media-assets/prepare-upload)
- [Operation polling OpenAPI](https://docs.worldlabs.ai/api/reference/operations/get)
- [Get world OpenAPI](https://docs.worldlabs.ai/api/reference/worlds/get)
- [Export world OpenAPI](https://docs.worldlabs.ai/api/reference/worlds/export)
- [Model mapping](https://docs.worldlabs.ai/api/models)
- [Pricing](https://docs.worldlabs.ai/api/pricing)
- [Rate limits](https://docs.worldlabs.ai/api/rate-limits)
- [API FAQ](https://docs.worldlabs.ai/api/faq)
- [Export file specifications](https://docs.worldlabs.ai/marble/export/specs)
- [Rendering Marble SPZ files in third-party engines](https://docs.worldlabs.ai/api/rendering-spz)
- [Atlas announcement](https://www.worldlabs.ai/blog/atlas)

## Node matrix

| Node ID | Category | Inputs | Outputs | Endpoint | Key |
|---|---|---|---|---|---|
| `worldlabs-environment` | `3d-gen` | `prompt`, `images`, `video` | `world`, `panorama`, `collider`, `thumbnail`, `caption` | `POST /marble/v1/worlds:generate` | `WORLDLABS_API_KEY` |
| `worldlabs-world-export` | `transform` | `world` | `file`, `format` | `POST /marble/v1/worlds/{world_id}:export` | `WORLDLABS_API_KEY` |

Handler: `backend/handlers/worldlabs.py`.

Both definitions use `executionPattern: "async-poll"`. Authentication is the
`WLT-Api-Key` request header. The environment handler explicitly requests a
private world (`public: false`, ID access off, empty reader/writer lists).

## Generation contract

The handler derives the discriminated `world_prompt.type` from connected ports:

| Nebula state | API request shape |
|---|---|
| prompt only | `{type: "text", text_prompt}` |
| one image | `{type: "image", image_prompt, is_pano, text_prompt?}` |
| multiple images | `{type: "multi-image", multi_image_prompt, reconstruct_images, text_prompt?}` |
| video | `{type: "video", video_prompt, text_prompt?}` |

Images plus video are rejected before submission. Multi-image requests enforce
the public limits of four images normally and eight in reconstruction mode.
Azimuth parsing accepts a comma-separated list or JSON list, requires one entry
per image, and sends values as degrees. Video input is capped at 100 MB.

Supported public model IDs are exactly `marble-1.0-draft`, `marble-1.0`,
`marble-1.1`, and `marble-1.1-plus`; the node intentionally defaults to an
explicit `marble-1.1` rather than depending on the API's compatibility default.
The handler also validates the documented display-name, seed, and tag limits
before starting a paid operation.

### Input transport

- Public `http(s)` values become `source: "uri"` references.
- Local/Nebula output files use `POST /media-assets:prepare_upload`, upload to
  the signed URL with the provider-required method/headers, then send only the
  returned `media_asset_id`.
- Inline data URIs use `source: "data_base64"` and are limited to 10 MB by the
  handler. They are not added to node parameters.
- Browser `blob:` URLs and missing files fail locally.

The upload path avoids treating a localhost output URL as provider-accessible
and keeps large base64 payloads out of the graph contract.

## Poll, fetch, and materialize

Generation returns an Operation. Nebula polls
`GET /marble/v1/operations/{operation_id}`, propagates provider progress when
present, and fails on the Operation error object. After success it fetches the
current world with `GET /marble/v1/worlds/{world_id}` rather than relying only
on the potentially partial operation snapshot.

Before success is emitted, the handler downloads every SPZ variant in
`assets.splats.spz_urls` plus the panorama, collider GLB, and thumbnail when
present. Downloads use `.part` files followed by an atomic rename; partial
files are removed on failure. Returned signed asset URLs are consumed during
the run and are not stored in the structured output or manifest-facing params.

The canonical `World` value is schema version 1:

```text
provider/worldId/model/displayName/marbleUrl/promptType
assets.splats[variant] + panorama + colliderMesh + thumbnail
semantics.metricScaleFactor + groundPlaneOffset + coordinateFrame
caption + settled operation cost (when returned)
```

All asset fields are local paths. The separate panorama/collider/thumbnail/
caption ports reference the same materialized result. `coordinateFrame` is
`marble_raw_opencv`, the convention World Labs documents for generated SPZ
assets. The provider adapter preserves `metricScaleFactor` and
`groundPlaneOffset`; it does not destructively rewrite the local SPZ.

A renderer must multiply Gaussian centers and linear sizes by
`metricScaleFactor`, subtract `groundPlaneOffset` from the scaled center Y only,
and then apply its own axis conversion. Log-space size fields instead add
`log(metricScaleFactor)`. The Nebula Spark/Three.js viewer applies the documented
web conversion `Rx(pi)` after metric/ground alignment.

## Viewer contract

`frontend/src/components/nodes/WorldPreview.tsx` keeps the node card cheap and
lazy-loads `WorldEnvironmentViewer.tsx` only after **Explore**. The viewer uses
React Three Fiber and `@sparkjsdev/spark` for SPZ rendering, preserves arbitrary
safe provider variant names, prefers 500K on a normal desktop connection and
100K on low-bandwidth/mobile contexts. Its automatic choices are bounded to
100K, 150K, and 500K; full resolution and unfamiliar future variants require an
explicit user choice. It supports orbit/fly modes, reset, keyboard/touch
navigation, downloads, a validated Marble link, an error boundary, abortable
fetches, and renderer/mesh/control disposal. Fly is free-camera navigation, not
collider-backed walking or physics.

World media is previewed or downloaded only through Nebula's `/api/outputs/`
route. Portable graph imports normalize localhost backend URLs to that route and
omit arbitrary remote or private-network World asset references before any
thumbnail, viewer, or download request can occur.

## Export contract

| UI `format` | Request body | Result |
|---|---|---|
| `ply` | `asset_type: "splats"`, `format: "ply"`, selected resolution (`full_res`, `500k`, `150k`, `100k`) | Local `.ply` on `file`; conversion is free, normally synchronous, and may be provider-cached |
| `glb` | `asset_type: "mesh"`, `format: "glb"`, selected `mesh_variant` (`textured`, `vertex_colored`) | Local `.glb` on `file`; HQ export is asynchronous and costs 3,500 credits when a new export run starts |

The handler polls either form uniformly because the API wraps both in an
Operation. It does not retry a transport-ambiguous submit, preventing accidental
duplicate paid operations. The fixed `file` port uses the existing `Mesh` data
type for both formats; `MeshPreview` recognizes PLY as splat data and renders a
download-only state rather than mounting the GLB model viewer.

## Billing and throughput invariants

- Provider health validates `WORLDLABS_API_KEY` with the authenticated,
  non-billable `GET /marble/v1/credits` endpoint. The required
  `remaining_credits` response is an aggregate API balance; checking it does
  not start an operation.
- API credits are separate from Marble web-app credits.
- Draft generation costs 150 credits plus a 0/80/100-credit pano event.
- Standard generation costs 1,500 credits plus a 0/80/100-credit pano event.
- Marble 1.1 Plus can add 0–1,500 variable world-generation credits.
- PLY export is free. A new HQ mesh export costs 3,500 credits; cached/in-flight
  reuse for that world does not start another charge according to the provider.
- Accepted world generation usually takes about five minutes.
- The default account tier is about three generation starts/minute and 60/hour.

These values are documentation, not hard-coded billing assumptions in the
adapter. Reverify before changing any product copy that estimates cost.

## Cancellation truth

The published OpenAPI exposes operation retrieval but no cancellation endpoint.
Nebula therefore cannot stop an accepted World Labs operation. A paid POST is
handled as a cancellation-shielded handshake: if **Stop** arrives while the
response is in flight, the handler settles the response, validates and records
the operation ID, emits a `providerRecovery` checkpoint, and only then
propagates `asyncio.CancelledError` to stop local polling/graph work. The event
updates both persisted CLI graph state and frontend-only UUID nodes, and is not
suppressed by the run's cancelling state.

Generation checkpoints advance from `resume_operation_id` to
`existing_world_id`; the successful environment node keeps the world ID.
Export keeps `resume_operation_id` after success. This makes reruns of the live
node recovery-safe. Clearing the applicable field is the explicit request to
start new paid work. Each checkpoint is journaled under its exact run/node and
rehydrated into the matching frozen history snapshot on startup. A fully
checkpointed entry becomes **Recover**; any World Labs execution scope missing
a checkpoint stays blocked only if it could start fresh paid work: a new world
generation or new HQ GLB export. Free PLY conversion does not cross that
boundary and remains rerunnable without a checkpoint; an environment or GLB
node already carrying its exact operation/world ID is recovery work.

The recovery event reports whether its journal write was durable. A write
failure never discards the live ID: the frontend pins it, preserves it through
the Stop race, and displays a persistent warning to keep the tab open and copy
the ID before reload. Journal mutation endpoints fail closed if disk cleanup
cannot be committed.

If the transport fails without returning an operation ID, the submission is
ambiguous. Nebula does not retry it. The operator must inspect Marble before a
new submit, since the provider may have accepted the original request. The
handler logs that provider work may continue and remain billable; it never
fabricates a DELETE/POST cancel call or reports provider cancellation.

Admission, recovery, cancellation intent, ambiguity, and destructive graph
mutation share one durable process-safe lifecycle fence. The paid-start record
is reserved before the provider POST, and a recovery ID is reserved before its
task is scheduled. Stale tabs and separate backend workers therefore cannot
use a blank payload or an imported graph to race known provider work. Stop sent
before POST admission is durable and remains effective when that POST arrives.
Safety journals are fail-closed at capacity rather than evicting unresolved
records.

The frontend treats recovery and ambiguity hydration as merge-only safety
state. Delayed snapshots may over-lock until an exact server-confirmed cleanup,
but they cannot silently unlock a newer operation. Mutation requests are never
automatically replayed against a rediscovered backend. Save/import/clear and
node clone/delete/edit paths are either blocked or checkpoint-aware while a
paid lifecycle is unresolved; an exact durable checkpoint can be forgotten
only when the server confirms the same recovery identity is still current.

## Coverage boundaries

Implemented: all four public generation input modes, media upload needed by
those modes, operation polling, post-generation world retrieval, local asset
materialization, SPZ viewing, and PLY/HQ-GLB export.

Provider health uses the credit lookup as a credential probe. Not exposed as
first-class graph nodes: world/media CRUD and listing, credit lookup,
permission/sharing management, and depth-panorama-to-RGB conversion.

Atlas is also intentionally absent. World Labs announced Atlas on 2026-09-01
as early access for select partners, and the public World API contains no Atlas
model ID or endpoint. The provider-neutral, versioned `World` value and split
generation/export adapter make a later implementation possible without
mislabeling Marble as Atlas today.

## Verification status

- Contract and handler behavior: covered by mocked backend tests.
- Node registry/frontend mirror: checked by repository contract tooling.
- World value parsing and viewer states: covered by frontend unit tests.
- Recovery checkpoints, Stop ordering, and frontend UUID hydration: covered by
  cancellation-focused backend and frontend tests.
- Browser SPZ loading validates the full gzip stream (integrity, exact inflated
  size, and concatenated payload rejection) after its compressed-byte/header
  preflight and before Spark allocation.
- Paid live generation/export: **not run** in this audit.
