# World Labs (Marble) in Nebula Nodes

> **Structural integration verified 2026-09-03.** Nebula implements the public
> World API contract with mocked provider tests. This pass made no paid World
> Labs request, so it is not a live-provider smoke result.

World Labs' public Marble API turns text, one image, several views of the same
place, or a video into a navigable 3D environment. Nebula keeps that result
together as a first-class `World` value: Gaussian splats, panorama, collider,
thumbnail, scale metadata, caption, and the World Labs world ID travel through
the graph as one typed bundle.

## What you can make

- **Text to world** — describe a place from scratch.
- **Image to world** — expand one ordinary image or equirectangular panorama
  into an environment.
- **Multi-image to world** — combine up to four views, or up to eight with
  reconstruction mode.
- **Video to world** — reconstruct a traversed scene from a clip up to 100 MB.
- **Portable exports** — convert a generated world's splats to PLY, or request
  a high-quality textured or vertex-colored GLB mesh.

Every successful environment run also exposes the panorama, coarse collider
GLB, thumbnail, and generated caption as ordinary output ports. The structured
`World` output is what should feed another spatial node such as the export node.

## Nodes available in Nebula

| Node | ID | Inputs | Outputs | Purpose |
|---|---|---|---|---|
| World Labs Environment | `worldlabs-environment` | `prompt` (Text, optional), `images` (Image, optional/multiple), `video` (Video, optional) | `world` (World), `panorama` (Image), `collider` (Mesh), `thumbnail` (Image), `caption` (Text) | Generate a Marble world from exactly one media mode, with optional text guidance. |
| World Labs Export | `worldlabs-world-export` | `world` (World, required) | `file` (Mesh), `format` (Text) | Download a PLY Gaussian-splat export or a high-quality GLB mesh. |

Both nodes use `WORLDLABS_API_KEY`. In Nebula, open **Settings → World Labs**, paste
an API key created on the [World Labs Platform](https://platform.worldlabs.ai),
and save. World API credits are separate from credits or subscriptions in the
Marble web app.

Nebula validates the saved credential with the authenticated, non-billable
`GET /marble/v1/credits` endpoint. Its response contains the account's aggregate
`remaining_credits`; this health check does not create a world or start a paid
operation. Credit lookup remains provider-health infrastructure rather than a
first-class graph node.

## Generate an environment

The connected ports select the request mode:

| Connected inputs | World API mode | Notes |
|---|---|---|
| `prompt` only | `text` | A non-empty prompt is required. |
| one `images` value | `image` | `is_pano` can be `auto`, `true`, or `false`. |
| two or more `images` values | `multi-image` | Maximum four normally or eight with `reconstruct_images`; optional azimuths must match the image count. |
| `video`, optionally with `prompt` | `video` | Recommended formats include MP4, WebM, MOV, and AVI; the public API limit is 100 MB. |

Connecting images and a video at the same time is rejected before the paid
generation request. For image, multi-image, and video modes, `prompt` is
optional guidance. `disable_recaption` asks World Labs to use that guidance
verbatim rather than recaption it.

Local image/video files use World Labs' three-step media-asset upload flow:
Nebula prepares an upload, sends the file to the returned signed URL, then puts
only the media-asset ID in the generation request. A public `http(s)` input URL
is passed as a URI. The provider must be able to fetch such a URL without local
cookies or authentication.

### Generation parameters

| Parameter | Default | Contract |
|---|---|---|
| `model` | `marble-1.1` | `marble-1.0-draft`, `marble-1.0`, `marble-1.1`, or `marble-1.1-plus` |
| `display_name` | blank | Optional; at most 64 characters |
| `seed` | random | Integer from 0 through 4,294,967,295 |
| `is_pano` | `auto` | Used for a single image only |
| `reconstruct_images` | `false` | Enables the eight-image reconstruction path |
| `azimuths` | blank | Comma-separated degrees such as `0, 90, 180, 270`; count must equal connected images |
| `disable_recaption` | `false` | Use supplied text guidance as-is |
| `tags` | blank | Comma-separated; at most 10 tags, each at most 32 characters |
| `resume_operation_id` | blank | Resume an accepted operation without submitting another generation |
| `existing_world_id` | blank | Fetch an existing world and rematerialize its assets without generating another |

`marble-1.1-plus` can expand the generated area automatically. It can therefore
cost more than the standard model and should be selected intentionally.

### Recovery checkpoints

Nebula treats the accepted operation ID as durable paid-work state, not as a
transient progress detail. It is written to `resume_operation_id`, persisted in
an exact run/node recovery journal, and sent to the open browser as soon as the
generation response is received. The journal is included in graph hydration,
including when the live backend graph is empty, so the matching frozen history
snapshot can recover after a reload.
When the operation produces a world, Nebula replaces it with
`existing_world_id`. That world ID remains pinned after success, so another run
of the same live node fetches and rematerializes the existing world rather than
starting a new paid generation.

To intentionally create a different world, clear the recovery fields first.
Nebula labels an exact journal-hydrated history entry **Recover**; it uses only
the accepted operation/world ID and cannot submit new paid work. A failed,
cancelled, or legacy history replay is blocked only when its actual execution
scope could cross a fresh paid boundary: a new environment or a new HQ GLB
export without a checkpoint. Free PLY conversion is safe to rerun without a
checkpoint, and a node already pinned to an operation/world ID is recovery work,
not a fresh start. If a journal write fails, the ID still stays pinned in the
live tab and a prominent warning tells you to keep the tab open and copy the ID
before reloading.

Nebula admits paid starts through a shared fail-closed lifecycle guard before it
sends the provider POST. The same guard owns recovery runs, pre-admission Stop
requests, graph mutations, and unresolved submit responses, so a second tab or
backend process cannot bypass an in-flight/recoverable node with stale graph
data. A transport-ambiguous start is held until the operator checks Marble and
acknowledges that exact run; Nebula never replays the POST automatically.

Recovery and ambiguity inventories are merge-only in open clients: a delayed
WebSocket or hydration snapshot may conservatively keep an old lock visible,
but it cannot erase newer safety state. Saving, clearing, importing, cloning, or
duplicating nodes is blocked or recovery-aware while paid-work state is
unresolved. Durable recovery records can be deliberately forgotten only by an
exact-ID, server-confirmed action. A volatile (`durable=false`) checkpoint has
no forget control; keep the tab open and copy its visible ID.

## The `World` output and viewer

Nebula downloads the provider's returned assets before marking the node
complete. Signed asset URLs are not retained as graph outputs; the versioned
`World` value contains local paths instead:

The browser loads only `/api/outputs/` asset references. Graph imports remove
external CDN, tracking, and private-network World asset URLs with a warning;
the separately validated World Labs `marbleUrl` remains available as an
explicit navigation link.

```json
{
  "schemaVersion": 1,
  "provider": "worldlabs",
  "worldId": "...",
  "model": "marble-1.1",
  "displayName": "...",
  "marbleUrl": "https://marble.worldlabs.ai/world/...",
  "promptType": "text",
  "assets": {
    "splats": {
      "100k": "<local .spz>",
      "150k": "<local .spz, when returned>",
      "500k": "<local .spz>",
      "full_res": "<local .spz>"
    },
    "panorama": "<local image>",
    "colliderMesh": "<local .glb>",
    "thumbnail": "<local image>"
  },
  "semantics": {
    "metricScaleFactor": 1.0,
    "groundPlaneOffset": 0.0,
    "coordinateFrame": "marble_raw_opencv"
  },
  "caption": "..."
}
```

The canvas initially shows a lightweight thumbnail card. Choose **Explore** to
load the expandable Spark viewer only when needed. On a desktop-class
connection it prefers the 500K SPZ; low-bandwidth/mobile contexts prefer 100K.
It also labels a returned 150K variant as **Light**, and retains future
provider-named variants rather than discarding them. Full resolution and
unfamiliar future variants are explicit opt-ins: the viewer never automatically
loads them when no bounded 100K, 150K, or 500K preview is available. The viewer
offers orbit and fly navigation, camera reset, quality selection, local asset
downloads, and an **Open in Marble** link. Fly is a free camera, not
collider-backed walking or physics.
If WebGL or an SPZ asset fails, the panorama/collider downloads remain usable.
The browser bounds the compressed source, validates the SPZ header and declared
point count, then streams the complete gzip payload to verify its checksum and
exact inflated length before Spark can allocate it.

Generated SPZ assets use World Labs' `marble_raw_opencv` coordinate convention.
To render one outside Marble, multiply Gaussian centers and linear sizes by the
returned `metricScaleFactor`, then subtract `groundPlaneOffset` from the scaled
center Y only. The offset does not apply to Gaussian sizes. If a decoder exposes
log-space size fields, add `log(metricScaleFactor)` rather than multiplying the
stored logarithms. Apply the target renderer's axis conversion only after that
metric and ground alignment. Nebula's Spark/Three.js viewer follows World Labs'
documented web-rendering conversion by applying `Rx(pi)`, a 180-degree rotation
around X.

## Export a world

Wire `worldlabs-environment.world` to `worldlabs-world-export.world`.

| `format` | Options | Provider behavior | Cost |
|---|---|---|---:|
| `ply` | resolution `full_res`, `500k`, `150k`, or `100k` | Converts Gaussian splats to a broadly compatible PLY; usually completes synchronously and may be provider-cached | Free |
| `glb` | variant `textured` or `vertex_colored` | Requests the high-quality mesh service; asynchronous and can take up to an hour | 3,500 credits ($2.80 at the published standard rate) |

The output is downloaded into the active Nebula run directory before the node
completes. Because a PLY splat is not a polygon mesh, its output card presents a
clear download state instead of trying to open it in the GLB model viewer; use
the upstream `World` card's SPZ viewer for interactive exploration. A collider
is not the same as the paid high-quality mesh: the former is a coarse GLB
included with generation for simple collision/physics, while the latter is a
detailed export.

GLB previews are also explicit and lazy: Nebula fetches them only after **Open
3D preview**, enforces a 128 MiB browser limit, and revokes the temporary object
URL when the modal closes. Panorama downloads preserve the backend-validated
JPEG, PNG, GIF, or WebP filename extension.

The export node has a `resume_operation_id` parameter. Nebula pins the accepted
export operation immediately and keeps it after success. Rerunning that live
node therefore retrieves the same operation; clear the field only when a new
export request is intentional.

## Costs, timing, and rate limits

At the published rate, 1,250 API credits cost $1. World generation charges are
the world event plus a panorama event when needed:

| Model/input | Total credits |
|---|---:|
| Draft + pano image | 150 |
| Draft + text or non-pano image | 230 |
| Draft + multi-image or video | 250 |
| Standard (`marble-1.0`/`marble-1.1`) + pano image | 1,500 |
| Standard + text or non-pano image | 1,580 |
| Standard + multi-image or video | 1,600 |
| `marble-1.1-plus` | Corresponding standard total plus 0–1,500 variable credits |

World Labs says an accepted generation usually takes about five minutes. The
default tier currently allows about three generation starts per minute and 60
per hour, per API user/account rather than per key. A `429` means the start was
not accepted; retry later instead of polling or duplicating starts.

> [!WARNING]
> The published World API has no operation-cancellation endpoint. Nebula's
> **Stop** action durably records local cancellation before admission and keeps
> the run locked until the backend reports a terminal state. If a
> non-idempotent submission is already in flight, Nebula first settles that
> response and persists any returned recovery ID; it then stops local polling
> and graph work. An already accepted generation or export may continue at
> World Labs and remain billable. Nebula does not automatically retry an
> ambiguous submit response because doing so could create a second paid
> operation. If no recovery ID is present, inspect Marble before submitting
> again.

## Atlas boundary

[Atlas](https://www.worldlabs.ai/blog/atlas) was announced on 2026-09-01 and is
in early access with select partners. It is not listed as a model or endpoint
in the public World API, so Nebula does **not** claim Atlas support and does not
offer an Atlas option in these nodes. The first-class `World` contract keeps
downstream viewers and exporters model-independent, allowing a future Atlas
adapter to reuse them once World Labs publishes an accessible API contract.
See the canonical [provider-neutral spatial foundation](../spatial-foundation.md)
for the implemented schemas, local nodes, World v1/v2 compatibility, viewer
registry, and exact backend adapter/entitlement gate.

## API coverage

Nebula covers public world generation (all four input modes), operation polling,
media upload needed by generation, world retrieval after generation, and PLY/
GLB export. Provider health also uses the non-billable credit lookup to validate
the configured API key. Nebula does not expose general world/media CRUD, world
listing, credit lookup, sharing/permission management, or depth-panorama
conversion as graph nodes.

## Sources

- [World API quickstart](https://docs.worldlabs.ai/api)
- [Get remaining API credits](https://docs.worldlabs.ai/api/reference/credits/get)
- [Generate a world](https://docs.worldlabs.ai/api/reference/worlds/generate)
- [Prepare media asset upload](https://docs.worldlabs.ai/api/reference/media-assets/prepare-upload)
- [Get an operation](https://docs.worldlabs.ai/api/reference/operations/get)
- [Get a world](https://docs.worldlabs.ai/api/reference/worlds/get)
- [Export a world](https://docs.worldlabs.ai/api/reference/worlds/export)
- [Models](https://docs.worldlabs.ai/api/models)
- [Pricing](https://docs.worldlabs.ai/api/pricing)
- [Rate limits](https://docs.worldlabs.ai/api/rate-limits)
- [Export file specifications](https://docs.worldlabs.ai/marble/export/specs)
- [Rendering Marble SPZ files in third-party engines](https://docs.worldlabs.ai/api/rendering-spz)
- [Atlas announcement and early-access status](https://www.worldlabs.ai/blog/atlas)
