---
id: nebula-meshy
kind: project-model-integration
project: nebula_nodes
provider: meshy
status: active
verified: 2026-05-17
stale_after_days: 14
---

# Meshy in Nebula Nodes

Nebula-specific integration notes for Meshy nodes.

## Node Matrix

| Node ID | Route | Key | Endpoint | Use |
|---|---|---|---|---|
| `meshy-text-to-3d` | FAL-backed Meshy | `FAL_KEY` | `fal-ai/meshy/v6/text-to-3d` | Text prompt to GLB-style model output |
| `meshy-image-to-3d` | FAL-backed Meshy | `FAL_KEY` | `fal-ai/meshy/v6/image-to-3d` | One image to model output |
| `meshy-multi-image-to-3d` | Meshy direct | `MESHY_API_KEY` | `/openapi/v1/multi-image-to-3d` | 1-4 same-object images to model |
| `meshy-retexture` | Meshy direct | `MESHY_API_KEY` | `/openapi/v1/retexture` | New texture style for a model |
| `meshy-rigging` | Meshy direct | `MESHY_API_KEY` | `/openapi/v1/rigging` | Rig textured humanoid GLB |
| `meshy-animate` | Meshy direct | `MESHY_API_KEY` | `/openapi/v1/animations` | Apply animation to rigged model |
| `meshy-remesh` | Meshy direct | `MESHY_API_KEY` | `/openapi/v1/remesh` | Retopology/export conversion |
| `meshy-text-to-image` | Meshy direct | `MESHY_API_KEY` | `/openapi/v1/text-to-image` | Prompt to reference image or multi-view sheet |
| `meshy-image-to-image` | Meshy direct | `MESHY_API_KEY` | `/openapi/v1/image-to-image` | Reference image transformation |
| `meshy-3d-print` | Meshy direct | `MESHY_API_KEY` | `/openapi/v1/print/multi-color` | Multi-color `.3mf` print output |

## Current Nebula Exposure

The Text to 3D and Image to 3D nodes are currently FAL-backed convenience nodes.
They do not expose the full native Meshy parameter surface documented in the
shared reference. Use direct Meshy nodes for workflows that need task IDs,
remesh/retexture/rigging/animation chaining, or native parameter control.

`meshy-text-to-3d` inputs:

| Input | Required | Notes |
|---|---:|---|
| `prompt` | Yes | Text prompt for model generation. |
| `texture_image` | No | Optional texture reference image. |

`meshy-image-to-3d` inputs:

| Input | Required | Notes |
|---|---:|---|
| `image` | Yes | Source image. |
| `texture_image` | No | Optional texture reference image. |

`meshy-multi-image-to-3d` params:

| Param | Values | Default | Notes |
|---|---|---|---|
| `ai_model` | `latest`, `meshy-6`, `meshy-5` | `latest` | Meshy model. |
| `should_remesh` | boolean | `false` | Native Meshy remesh toggle. |
| `topology` | `triangle`, `quad` | `triangle` | Mesh topology. |
| `target_polycount` | 100-300000 | `30000` | Target count. |
| `symmetry_mode` | `off`, `auto`, `on` | `auto` | Symmetry control. |
| `should_texture` | boolean | `true` | Skip texture for geometry-only drafts. |
| `enable_pbr` | boolean | `false` | PBR maps. |
| `pose_mode` | `""`, `a-pose`, `t-pose` | `""` | Character pose. |
| `image_enhancement` | boolean | `true` | Input image cleanup/enhancement. |
| `remove_lighting` | boolean | `true` | Cleaner base color. |

Post-processing params:

| Node | Exposed params |
|---|---|
| `meshy-retexture` | `ai_model`, `enable_original_uv`, `enable_pbr`, `remove_lighting` |
| `meshy-rigging` | `height_meters` |
| `meshy-animate` | `action_id`, `fps` |
| `meshy-remesh` | `topology`, `target_polycount`, `target_formats`, `resize_height`, `convert_format_only` |
| `meshy-3d-print` | `max_colors`, `max_depth` |

2D image params:

| Node | Exposed params |
|---|---|
| `meshy-text-to-image` | `ai_model`, `generate_multi_view`, `aspect_ratio`, `pose_mode` |
| `meshy-image-to-image` | `ai_model`, `generate_multi_view` |

## Known Integration Gaps

These are gaps between the official Meshy surface and Nebula's currently exposed
node schema. Treat them as implementation targets, not required graph inputs.

Text/Image to 3D:

- Native Meshy options such as `target_formats`, `moderation`, `auto_size`,
  `origin_at`, `decimation_mode`, `hd_texture`, `texture_prompt`,
  `remove_lighting`, and `save_pre_remeshed_model` are not generally exposed on
  the FAL-backed text/image nodes.
- If a graph needs native Meshy task chaining, use or add direct Meshy nodes
  rather than forcing FAL-backed nodes into that role.

Multi Image to 3D:

- Current node covers the main controls but does not expose `input_task_id`,
  `decimation_mode`, `save_pre_remeshed_model`, `texture_prompt`,
  `texture_image_url`, `moderation`, `target_formats`, `auto_size`, or
  `origin_at`.

Retexture:

- Current node starts from `model_url` and text prompt. Native Meshy also accepts
  `input_task_id`, `image_style_url`, and `target_formats`.

Rigging:

- Current node starts from `model_url`. Native Meshy also accepts
  `input_task_id` and `texture_image_url`.

Animation:

- Current node exposes a small `action_id` set and an `fps` helper. Native Meshy
  also supports `post_process.operation_type` values `change_fps`, `fbx2usdz`,
  and `extract_armature`.

Remesh:

- Current node starts from `model_url`. Native Meshy also accepts
  `input_task_id`, `decimation_mode`, `auto_size`, and `origin_at`.

Text to Image:

- Official Meshy docs say `generate_multi_view` and `aspect_ratio` are mutually
  exclusive. When `generate_multi_view` is true, agents should omit
  `aspect_ratio` even if the UI shows a default.
- `nano-banana-2` is now exposed in the node definition alongside `nano-banana`
  and `nano-banana-pro` (added 2026-05-17).

## Daedalus Workflow

Before building a Meshy graph:

1. Read the shared Meshy reference.
2. Run `nebula nodes` to confirm the current node IDs.
3. Run `nebula info <node_id>` to confirm the live input/param schema.
4. Build one stage, run it, download/inspect the output, then continue.

Recommended asset-generation chain:

```text
meshy-text-to-image or meshy-image-to-image
  -> meshy-multi-image-to-3d or meshy-image-to-3d
  -> meshy-remesh
  -> meshy-retexture
  -> meshy-rigging
  -> meshy-animate
```

Only include later stages when the asset actually needs them. Props usually stop
after remesh/retexture. Humanoid characters may continue into rigging/animation.

## Storage and Provenance

- Save downloaded outputs under the project or experiment run that requested the
  asset, not under this docs folder.
- Keep the Meshy task ID, node graph, prompt, source images, selected params,
  and downloaded output paths in the run README.
- Do not store `MESHY_API_KEY` in this docs folder, Workspace reference, or
  agent identity files.

## Audit Log

### 2026-05-17 — Full 10-node audit (node-contract-hardening-meshy)

Sources fetched:
- `https://docs.meshy.ai/api/text-to-3d` (2026-05-17)
- `https://docs.meshy.ai/api/image-to-3d` (2026-05-17)
- `https://docs.meshy.ai/api/remesh` (2026-05-17)
- `https://docs.meshy.ai/api/retexture` (2026-05-17)
- `https://docs.meshy.ai/api/rigging` (2026-05-17)
- `https://docs.meshy.ai/api/animation` (2026-05-17)
- `https://docs.meshy.ai/api/text-to-image` (2026-05-17)
- `https://fal.ai/models/fal-ai/meshy/v6/image-to-3d` (2026-05-17)
- `https://fal.ai/models/fal-ai/meshy/v6/text-to-3d` (2026-05-17)

Per-node findings:

| Node | Endpoint | Auth | Task ID field | Status values | Output field | Result |
|---|---|---|---|---|---|---|
| `meshy-text-to-3d` (direct) | `/v2/text-to-3d` | `Bearer` | `result` | PENDING/IN_PROGRESS/SUCCEEDED/FAILED/CANCELED | `model_urls.glb` (string) | PASS |
| `meshy-image-to-3d` (direct) | `/v1/image-to-3d` | `Bearer` | `result` | same | `model_urls.glb` (string) | PASS |
| `meshy-image-to-3d` (FAL) | `fal-ai/meshy/v6/image-to-3d` | `Key` | `request_id` | COMPLETED/FAILED | `model_glb.url` or `model_urls.glb.url` | PASS — `_parse_fal_output` handles both dict and string |
| `meshy-text-to-3d` (FAL) | `fal-ai/meshy/v6/text-to-3d` | `Key` | `request_id` | COMPLETED/FAILED | `model_glb.url` or `model_urls.glb.url` | PASS — same parser |
| `meshy-multi-image-to-3d` | `/v1/multi-image-to-3d` | `Bearer` | `result` | same | `model_urls.glb` (string) | PASS |
| `meshy-retexture` | `/v1/retexture` | `Bearer` | `result` | same | `model_urls.glb` (string) | PASS — input port `prompt` correctly mapped to `text_style_prompt` in body |
| `meshy-rigging` | `/v1/rigging` | `Bearer` | `result` | same | `result.rigged_character_glb_url` | PASS |
| `meshy-animate` | `/v1/animations` | `Bearer` | `result` | same | `result.animation_glb_url` | PASS |
| `meshy-remesh` | `/v1/remesh` | `Bearer` | `result` | same | `model_urls.glb` (string) | PASS |
| `meshy-text-to-image` | `/v1/text-to-image` | `Bearer` | `result` | same | `image_urls[0]` (array) | PASS — added `nano-banana-2` to node definition |
| `meshy-image-to-image` | `/v1/image-to-image` | `Bearer` | `result` | same | `image_urls[0]` (array) | PASS — added `nano-banana-2` to node definition |
| `meshy-3d-print` | `/v1/print/multi-color` | `Bearer` | `result` | same | `model_urls.3mf` or `model_urls.glb` | PASS |

Changes made:
- Stripped `runtime_skill_sources` and `shared_reference` from frontmatter (local-only, not portable)
- Updated `verified` date to 2026-05-17
- Added `nano-banana-2` to `meshy-text-to-image` and `meshy-image-to-image` node definitions
- Updated gap note for nano-banana-2 (gap is now closed)

No handler code changes were required — all endpoints, auth headers, request body fields,
poll URL patterns, and output field paths match the canonical docs as of 2026-05-17.
