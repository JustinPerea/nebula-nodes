---
name: worldlabs
description: Build and operate Nebula graphs that generate navigable Marble environments with `worldlabs-environment`, pass the structured `World` value, preview local SPZ splats, or export PLY/GLB with `worldlabs-world-export`. Use for World Labs, Marble, text/image/multi-image/video-to-world, Gaussian-splat environment, panorama, collider, or World port requests in Nebula. Do not use this skill to claim Atlas support; Atlas is not in the public API.
---

# World Labs environments in Nebula

Use the public Marble World API through two first-class nodes:

- `worldlabs-environment`: text/image/multi-image/video → `World` plus panorama,
  collider, thumbnail, and caption.
- `worldlabs-world-export`: `World` → PLY splat or high-quality GLB mesh.

Read `docs/api-guides/worldlabs.md` when cost, API coverage, or provider behavior
needs more detail. Treat `backend/data/node_definitions.json` as the current
parameter authority.

## Safety and truth

1. World generation is billable. If the user has not already asked to execute
   the graph, show the selected model/input cost range before starting it.
2. A new high-quality GLB export costs 3,500 credits ($2.80 at the provider's
   published standard rate). PLY conversion is free. Do not silently switch a
   requested PLY export to GLB.
3. The public API has no operation-cancel endpoint. **Stop** ends Nebula polling
   after any in-flight submission response is captured, but an accepted
   provider job may continue and remain billable. Say this plainly; never
   report it as cancelled upstream.
4. Do not auto-retry an ambiguous generation/export submission. A retry could
   create a second paid operation. Check the World Labs dashboard first.
5. Never put `WORLDLABS_API_KEY`, signed upload/download URLs, or base64 media into
   prompts, notes, manifests, or chat. Configure the key in Nebula Settings.
6. Do not call Marble "Atlas." Atlas is early access and has no public API model
   or endpoint. Nebula currently supports the public Marble models only.
7. Load World assets only from Nebula's `/api/outputs/` route. Imported remote
   or private-network asset URLs are unavailable by design; use the validated
   `marbleUrl` link to open the provider-hosted world explicitly.

## Pick the input mode

The environment node selects the mode from its connected ports:

| Goal | Connections | Important settings |
|---|---|---|
| Invent a place | `prompt` only | Start with `marble-1.0-draft` for a cheap composition test; use `marble-1.1` for the standard final. |
| Expand one still | one image → `images`; optional `prompt` | Leave `is_pano=auto` unless the source is known to be or not be equirectangular. |
| Reconstruct a photographed place | 2–4 images → `images`; optional `prompt` | Set `azimuths` when known. Enable `reconstruct_images` only for reconstruction and up to 8 images. |
| Reconstruct a camera path | video → `video`; optional `prompt` | Video must be at most 100 MB. Use a short, coherent traversal rather than scene cuts. |

Never connect images and video together. For media-driven modes, a prompt is
guidance rather than the source. `disable_recaption=true` means use that text
verbatim; leave it false when semantic cleanup is welcome.

## `worldlabs-environment` contract

Inputs:

| Port | Type | Required | Notes |
|---|---|---:|---|
| `prompt` | Text | no | Required only when no media is connected. |
| `images` | Image, multiple | no | One selects image mode; two or more select multi-image mode. |
| `video` | Video | no | Mutually exclusive with images. |

Parameters:

| Key | Default | Allowed/meaning |
|---|---|---|
| `model` | `marble-1.1` | `marble-1.0-draft`, `marble-1.0`, `marble-1.1`, `marble-1.1-plus` |
| `display_name` | blank | Up to 64 characters |
| `seed` | random | Integer 0–4,294,967,295 |
| `is_pano` | `auto` | `auto`, `true`, or `false`; single-image mode only |
| `reconstruct_images` | `false` | Raises multi-image cap from 4 to 8 |
| `azimuths` | blank | One comma-separated degree value per connected image |
| `disable_recaption` | `false` | Preserve supplied text guidance verbatim |
| `tags` | blank | Up to 10 comma-separated tags, each at most 32 characters |
| `resume_operation_id` | blank | Resume an accepted generation operation without submitting another paid job |
| `existing_world_id` | blank | Fetch and rematerialize an existing world without generating another |

Outputs:

- `world` (`World`): the versioned structured spatial result; use this for
  downstream world-aware nodes.
- `panorama` (`Image`): local equirectangular panorama.
- `collider` (`Mesh`): local coarse GLB for collision/physics, not the paid HQ
  mesh.
- `thumbnail` (`Image`) and `caption` (`Text`).

The `World` bundle keeps local SPZ variants, scale/ground metadata, coordinate
frame, world ID, and Marble link together. Do not unpack and reconstruct it by
hand. Feed the typed port directly to `worldlabs-world-export`.

As soon as World Labs returns an accepted operation ID, Nebula pins it on the
live node and persists it. When polling yields a world ID, that replaces the
operation ID. The successful environment node intentionally keeps
`existing_world_id`, so rerunning it rematerializes the same world rather than
starting a new paid generation. Clear both recovery fields only when the user
explicitly wants a new world.

## Inspect the result

The compact card does not load WebGL. Open **Explore** to lazy-load the Spark
viewer. Use:

- **Preview / 100K** for mobile or a quick inspection.
- **Light / 150K** when the provider returns that intermediate variant.
- **Standard / 500K** for the normal desktop review.
- **Full** or an unfamiliar future variant only after explicitly choosing it;
  neither is an automatic fallback because its size is unbounded.
- **Orbit** to inspect composition; **Fly** for free-camera navigation. Fly is
  not collider-backed walking or physics.
- Panorama and collider downloads as fallbacks when WebGL/SPZ cannot load.

Generated SPZ assets use the `marble_raw_opencv` coordinate frame. When building
a spatial consumer, use the returned values rather than constants: multiply
Gaussian centers and linear sizes by `metricScaleFactor`, then subtract
`groundPlaneOffset` from the scaled center Y only. Apply the target renderer's
axis conversion after that metric/ground alignment. For log-space Gaussian
sizes, add `log(metricScaleFactor)` instead of multiplying the stored values.
Marble's Spark/Three.js web rendering path applies `Rx(pi)` (a 180-degree
rotation around X) after the metric conversion.

## Export the world

Wire `worldlabs-environment.world` → `worldlabs-world-export.world`.

| Need | `format` | Other param | Result |
|---|---|---|---|
| Gaussian splat for broad tool compatibility | `ply` | `resolution`: `100k`, `150k`, `500k`, or `full_res` | Local `.ply`; free conversion |
| Detailed conventional mesh | `glb` | `mesh_variant`: `textured` or `vertex_colored` | Local `.glb`; paid HQ export, potentially up to an hour |

`resume_operation_id` is also a node parameter for export recovery. Nebula
pins it immediately after acceptance and keeps it after success, so a rerun
retrieves that operation instead of silently requesting another export. Clear
it only to start a deliberately new export.

The PLY result is intentionally download-only on its output card; it is splat
data, not a polygon mesh. Explore the source `World` interactively through its
SPZ viewer.

Use the included collider output when coarse physics geometry is sufficient.
Only request the HQ GLB when its detail justifies the separate provider charge.

After a failed or locally cancelled World Labs run, use **Recover** only when the
history row says its exact provider checkpoint was restored. Nebula rehydrates
that ID from its run/node journal and the recovery replay cannot start a new
paid operation. A history row is disabled when its actual scope could start a
fresh paid environment or HQ GLB and lacks the matching checkpoint—even if it
is a legacy completed row. Free PLY conversion needs no checkpoint and remains
safe to rerun. In a blocked case, inspect the live World node and Marble before
doing anything that could start new work. If Nebula warns that the checkpoint
was not saved durably, keep the tab open and copy the pinned ID before
reloading; volatile checkpoints intentionally have no forget action.

Paid starts and recovery runs are admitted through one shared fail-closed
lifecycle guard. It also fences pre-admission Stop intent, unresolved provider
responses, and graph mutations across backend processes. Do not work around an
active lock by cloning, importing, editing raw graph JSON, switching tabs, or
restarting the backend. Nebula merges recovery/ambiguity snapshots
conservatively and does not replay mutation requests during backend discovery.
An ambiguous submit hold can be cleared only after checking Marble and
acknowledging the exact run shown in the UI.

## Cost and scheduling expectations

- Draft totals: 150 credits from a pano, 230 from text/non-pano image, 250 from
  multi-image/video.
- Standard Marble 1.0/1.1 totals: 1,500 / 1,580 / 1,600 credits for those same
  input groups.
- Marble 1.1 Plus can add 0–1,500 credits to the corresponding standard total.
- Accepted generation usually takes about five minutes.
- Default throughput is about three generation starts/minute and 60/hour per
  account. A 429 means slow the starts; do not create a retry storm.

## Capability boundary

Nebula exposes generation from all four public inputs and PLY/HQ-GLB export. It
does not expose world/media listing or CRUD, sharing permissions, credit lookup,
or depth-pano conversion as nodes.

Nebula may call the authenticated, non-billable `GET /marble/v1/credits`
endpoint to check whether a saved key can reach World Labs. That is provider
health infrastructure only, not a graph node and not authorization to start a
billable generation.

Atlas remains outside this skill. Its 2026-09-01 announcement says early access
for select partners; the public model list contains only Marble 1.0 Draft, 1.0,
1.1, and 1.1 Plus. A future Atlas adapter may reuse the `World` port and viewer,
but no current graph should promise Atlas generation, simulation, or export.

## Sources

- https://docs.worldlabs.ai/api
- https://docs.worldlabs.ai/api/reference/worlds/generate
- https://docs.worldlabs.ai/api/reference/worlds/export
- https://docs.worldlabs.ai/api/reference/media-assets/prepare-upload
- https://docs.worldlabs.ai/api/pricing
- https://docs.worldlabs.ai/api/rate-limits
- https://docs.worldlabs.ai/marble/export/specs
- https://docs.worldlabs.ai/api/rendering-spz
- https://www.worldlabs.ai/blog/atlas
