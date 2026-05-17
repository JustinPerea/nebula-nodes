---
id: nebula-hunyuan-3d
kind: project-model-integration
project: nebula_nodes
provider: hunyuan
status: active
verified: 2026-05-17
stale_after_days: 14
---

# Hunyuan3D in Nebula Nodes

Nebula-specific integration notes for Hunyuan3D nodes.

Read the shared provider reference first:

`~/Documents/Workspace/Reference/model-providers/hunyuan/hunyuan3d.md`

## Node Matrix

| Node ID | Route | Key | Endpoint | Use |
|---|---|---|---|---|
| `hunyuan3d-text-to-3d` | FAL | `FAL_KEY` | `fal-ai/hunyuan3d-v3/text-to-3d` | Text prompt to mesh |
| `hunyuan3d-image-to-3d` | FAL | `FAL_KEY` | `fal-ai/hunyuan3d-v3/image-to-3d` | 1-4 views (front + back/left/right) to mesh |

Both nodes are async-poll execution pattern. Both route through FAL's v3
endpoints; the v3.1 Pro and Rapid surfaces are not currently exposed as
separate Nebula nodes.

## `hunyuan3d-text-to-3d` Params

| Param | Values | Default | Notes |
|---|---|---|---|
| `generate_type` | `Normal`, `LowPoly`, `Geometry` | `Normal` | `Normal` = textured; `LowPoly` = polygon-reduced; `Geometry` = white untextured. |
| `face_count` | 40000-1500000 | 500000 | Target polygon count. |
| `enable_pbr` | boolean | `false` | Adds metallic, roughness, normal maps. Ignored when `generate_type` is `Geometry`. |
| `polygon_type` | `triangle`, `quadrilateral` | `triangle` | Only meaningful when `generate_type` is `LowPoly`. |

Inputs: `prompt` (Text, required).
Output: `mesh` (Mesh).

## `hunyuan3d-image-to-3d` Params

| Param | Values | Default | Notes |
|---|---|---|---|
| `generate_type` | `Normal`, `LowPoly`, `Geometry` | `Normal` | Same semantics as text-to-3D. |
| `face_count` | 40000-1500000 | 500000 | Target polygon count. |
| `enable_pbr` | boolean | `false` | Adds metallic, roughness, normal maps. |
| `polygon_type` | `triangle`, `quadrilateral` | `triangle` | Only meaningful when `generate_type` is `LowPoly`. |

Inputs:

| Input | Required | Notes |
|---|---:|---|
| `front_image` | Yes | Maps to `input_image_url`. |
| `back_image` | No | Maps to `back_image_url`. |
| `left_image` | No | Maps to `left_image_url`. |
| `right_image` | No | Maps to `right_image_url`. |

Output: `mesh` (Mesh).

## Known Integration Gaps

These are gaps between the official Hunyuan3D surface and Nebula's currently
exposed node schema. Treat them as implementation targets, not required graph
inputs.

### Endpoint Generation

- Both nodes target the **v3** endpoints. The v3.1 Pro endpoints add four
  new view angles (`top_image_url`, `bottom_image_url`,
  `left_front_image_url`, `right_front_image_url`) and Tencent considers v3.1
  Pro the current production tier. Migrate `hunyuan3d-image-to-3d` to
  `fal-ai/hunyuan-3d/v3.1/pro/image-to-3d` and add the four view inputs to
  unlock better reconstruction on complex objects.
- v3.1 Pro **removed** `LowPoly` and the `polygon_type` knob. If Nebula
  migrates the node ID to the v3.1 Pro endpoint, the UI must hide both
  options from the `generate_type` enum, or the handler must downgrade to v3
  when `LowPoly` is selected.
- A separate Nebula node for `fal-ai/hunyuan-3d/v3.1/rapid/image-to-3d` would
  be useful for cheap single-image previews. Rapid uses `enable_geometry`
  (boolean) instead of `generate_type` (enum) and does not accept multi-view
  inputs.

### View Inputs

- Multi-view ports stop at 4 (front + back/left/right). v3.1 Pro supports up
  to 8 views. The four missing ports are `top_image`, `bottom_image`,
  `left_front_image`, `right_front_image`.

### Missing Native Knobs

- `seed` is not exposed on either node, so reproducibility across runs is
  not available from Nebula. FAL endpoints accept and return `seed`.
- `sync_mode` is not exposed (always queue). This is intentional for long
  Hunyuan3D jobs; do not change.

### Output Surface

- Output port is a single `Mesh` (Mesh). The FAL response carries `model_glb`
  plus `model_urls.{glb,fbx,obj,mtl,texture,usdz}` and a `thumbnail`. Today
  Nebula likely exposes only the primary GLB downstream. Adding outputs for
  `thumbnail`, `usdz` (for AR Quick Look), and `fbx` would help
  multi-pipeline workflows.

### Text Prompt Length

- Native API enforces a 1024 UTF-8 character cap on `prompt`. The Nebula
  node does not currently validate this; long prompts will be rejected at
  the FAL boundary with a 400.

## Daedalus Workflow

Before building a Hunyuan3D graph:

1. Read the shared Hunyuan3D reference.
2. Run `nebula nodes` to confirm the current node IDs.
3. Run `nebula info <node_id>` to confirm the live input/param schema.
4. Build one stage at a time, download/inspect the GLB, then continue.

Recommended asset-generation chain (uses other already-migrated providers):

```text
nano-banana (gemini-3-pro-image-preview, request "white background")
  -> [optional] background removal node
  -> hunyuan3d-image-to-3d (front view; add back/left/right when available)
  -> download GLB
  -> [optional] gltf-transform optimize / Blender retopo
  -> [optional] meshy-retexture or meshy-rigging for downstream stages
```

When the asset is a humanoid that needs rigging or animation in the same API,
switch to Meshy from the start rather than chaining out of Hunyuan3D — Meshy
provides native auto-rigging and animation, which Hunyuan3D does not.

When the agent has only a prompt and no reference image, prefer the
Hephaestus chain that generates a Nano Banana Pro reference first, then
feeds it into `hunyuan3d-image-to-3d`. This typically beats
`hunyuan3d-text-to-3d` for fidelity at similar cost.

## Audit Notes — 2026-05-17

Source: FAL model cards fetched 2026-05-17.
- `https://fal.ai/models/fal-ai/hunyuan3d-v3/text-to-3d/api`
- `https://fal.ai/models/fal-ai/hunyuan3d-v3/image-to-3d/api`

### text-to-3d

- Endpoint `fal-ai/hunyuan3d-v3/text-to-3d` confirmed current (v3 still active).
- Required input: `prompt` (string, max 1024 UTF-8 chars).
- Params confirmed: `generate_type` (Normal/LowPoly/Geometry, default Normal), `face_count` (int 40000–1500000, default 500000), `enable_pbr` (boolean), `polygon_type` (triangle/quadrilateral, default triangle).
- Output JSON: top-level `model_glb` (File dict with `url`), `thumbnail` (File dict), `model_urls` (object with `glb`/`fbx`/`obj`/`usdz` File entries), `seed` (integer).
- Handler `_parse_fal_output` resolves `model_glb` dict → `mesh` port correctly (model_glb branch at line 278–282).
- **No drift found.** Node definition, handler mapping, and FAL API are in sync.

### image-to-3d

- Endpoint `fal-ai/hunyuan3d-v3/image-to-3d` confirmed current.
- Required input: `input_image_url` (string). The FAL UI labels this `image_url` but the API schema field is `input_image_url`. Handler maps `front_image` port → `input_image_url` — correct.
- Optional view inputs: `back_image_url`, `left_image_url`, `right_image_url` — all confirmed.
- Params identical to text-to-3d (generate_type, face_count, enable_pbr, polygon_type).
- Output JSON identical to text-to-3d (model_glb dict, model_urls, thumbnail, seed).
- **No drift found.** Handler mapping and node definition match FAL API.

### Structural tests added (`backend/tests/test_fal_handler.py`)

- `TestParseFalOutputHunyuan3D.test_model_glb_dict_resolves_mesh` — FAL File dict response → mesh port
- `TestParseFalOutputHunyuan3D.test_model_urls_glb_resolves_mesh` — model_urls.glb fallback → mesh port
- `TestParseFalOutputHunyuan3D.test_thumbnail_not_returned_as_image_when_mesh_present` — thumbnail must not leak into image port
- `test_hunyuan3d_text_to_3d_prompt_sent_and_mesh_returned` — end-to-end: prompt sent, model_glb → mesh
- `test_hunyuan3d_image_to_3d_maps_input_image_url_and_returns_mesh` — front+back view mapping, input_image_url field name
- `test_hunyuan3d_image_to_3d_front_only_minimal` — front-only path; optional view keys absent from payload

## Storage and Provenance

- Save downloaded `model_glb`, FBX, OBJ, texture, and thumbnail outputs
  under the project or experiment run that requested the asset, not under
  this docs folder.
- Keep the FAL request ID, source images, prompt, selected params,
  `face_count`, `enable_pbr` state, and downloaded output paths in the run
  README so future agents can trace provenance.
- Do not store `FAL_KEY` in this docs folder, the Workspace reference, or
  agent identity files.
