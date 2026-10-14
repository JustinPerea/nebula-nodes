# 3D Generation — Text, Image, Multi-Image

Sourced from docs.meshy.ai (fetched 2026-04-17). Every parameter verified against the canonical API reference.

## Text-to-3D (`/openapi/v2/text-to-3d`)

Two-stage workflow: **preview** creates a base mesh without texture, then **refine** adds the texture. You can stop after preview if you only want geometry.

### Preview — create mesh

`POST /openapi/v2/text-to-3d` with `mode=preview`.

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `mode` | string | ✅ | — | Must be `"preview"` |
| `prompt` | string | ✅ | — | Max **600 characters**. Noun-phrase style works best ("a monster mask", "a futuristic robot warrior") |
| `ai_model` | string | | `"latest"` | `"latest"` (= `meshy-7.1`), `"meshy-7.1"`, `"meshy-7"` (deprecated, superseded by 7.1), `"meshy-6"` (previous generation), `"meshy-6-lite"` (cheapest, 5 credits), `"meshy-t2"` (only with `model_type: "smart-topology"`). 7/7.1/T2 need account entitlement. `meshy-5` is no longer accepted (openapi.yaml, checked 2026-10-14) |
| `model_type` | string | | `"standard"` | `"standard"` (high detail), `"smart-topology"` (Meshy T2: clean triangles at a face count you choose, 100–15,000, no quad) or `"lowpoly"`. **`lowpoly` is deprecated and retires 2026-10-30; after that it returns an error.** Use `smart-topology` + `meshy-t2` instead |
| `should_remesh` | boolean | | `false` on meshy-6; `true` on others | When `false`, returns the highest-precision triangular mesh. Turn on for quad topology or polycount control |
| `topology` | string | | `"triangle"` | `"quad"` or `"triangle"`. Only applied when `should_remesh=true` |
| `target_polycount` | integer | | `30000` | Range **100–300,000**. Actual count may deviate based on geometry |
| `decimation_mode` | integer | | — | Adaptive decimation level: `1` (ultra), `2` (high), `3` (medium), `4` (low). **Overrides `target_polycount` when set.** Better for wildly-varying geometry complexity |
| `symmetry_mode` | string | | `"auto"` | `"off"`, `"auto"` (auto-detect), `"on"` (enforce) |
| `pose_mode` | string | | `""` | `"a-pose"`, `"t-pose"`, or empty. Character rigging later needs `a-pose` or `t-pose` |
| `target_formats` | string[] | | all except `3mf` | `["glb", "obj", "fbx", "stl", "usdz", "3mf"]`. Request only the formats you need — **reduces completion time**. `3mf` only generated when explicitly requested |
| `moderation` | boolean | | `false` | Screens prompt for harmful content. Blocks task if detected |
| `auto_size` | boolean | | `false` | AI estimates real-world height and resizes. Sets `origin_at=bottom` unless overridden |
| `origin_at` | string | | `"bottom"` | `"bottom"` or `"center"`. Only applies when `auto_size=true` |

**Deprecated, do not use** (shown for completeness): `is_a_t_pose` (use `pose_mode`), `art_style` (not supported by meshy-6), `negative_prompt`, `texture_richness`, `video_url`.

### Refine — add texture

`POST /openapi/v2/text-to-3d` with `mode=refine`.

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `mode` | string | ✅ | — | Must be `"refine"` |
| `preview_task_id` | string | ✅ | — | ID of a succeeded preview task |
| `ai_model` | string | | `"latest"` | Must be compatible with the preview task's model |
| `enable_pbr` | boolean | | `false` | Generates metallic + roughness + normal maps alongside base color |
| `texture_prompt` | string | | — | Max 600 chars. Additional text guidance for the texture |
| `texture_image_url` | string | | — | 2D image URL or data URI (jpg/jpeg/png) to guide the texture. **Works best when geometry closely matches the reference.** If both `texture_prompt` and `texture_image_url` are provided, **`texture_prompt` wins** (docs explicit about this ordering) |
| `remove_lighting` | boolean | | `true` | Removes highlights + shadows from base color for cleaner custom lighting. Only `meshy-6`/`latest` |
| `target_formats` | string[] | | all except `3mf` | Same as preview |
| `moderation` | boolean | | `false` | Screens `texture_prompt` and `texture_image_url` |
| `auto_size` | boolean | | `false` | Same as preview |
| `origin_at` | string | | `"bottom"` | Same as preview |

### Response (submit)

```json
{"result": "018a210d-8ba4-705c-b111-1f1776f7f578"}
```

### Response (poll)

```json
{
  "id": "...",
  "type": "text-to-3d-preview" | "text-to-3d-refine",
  "status": "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "CANCELED",
  "progress": 0-100,
  "model_urls": {"glb": "...", "fbx": "...", "obj": "...", "mtl": "...", "usdz": "...", "stl": "...", "3mf": "..."},
  "texture_urls": [{"base_color": "...", "metallic": "...", "normal": "...", "roughness": "..."}],
  "thumbnail_url": "...",
  "prompt": "...",
  "texture_prompt": "...",
  "created_at": ms, "started_at": ms, "finished_at": ms,
  "preceding_tasks": N,  // queue position when PENDING
  "task_error": {"message": "..."}  // populated on FAILED
}
```

Format keys in `model_urls` are **omitted** when the format wasn't generated (not returned as empty strings).

---

## Image-to-3D (`/openapi/v1/image-to-3d`)

One-stage workflow. Single reference image → textured 3D model.

### Parameters

| Param | Type | Required | Default | Notes |
|---|---|---|---|---|
| `image_url` | string | ✅ | — | Public URL OR base64 data URI. Formats: `.jpg`, `.jpeg`, `.png`. Example: `data:image/jpeg;base64,<data>` |
| `ai_model` | string | | `"latest"` | Same values as text-to-3d: `latest` (= `meshy-7.1`), `meshy-7.1`, `meshy-7`, `meshy-6`, `meshy-6-lite`, `meshy-t2` |
| `model_type` | string | | `"standard"` | `"standard"`, `"smart-topology"` (Meshy T2) or `"lowpoly"` (retires 2026-10-30) |
| `should_texture` | boolean | | `true` | Skip texture phase with `false` — returns mesh only |
| `enable_pbr` | boolean | | `false` | Metallic + roughness + normal maps |
| `texture_prompt` | string | | — | Max 600 chars. Guide texture with text. Costs 10 additional credits |
| `texture_image_url` | string | | — | 2D image URL/data URI to guide texture. Costs 10 additional credits |
| `should_remesh` | boolean | | `false` on meshy-6; `true` on others | Remesh phase |
| `topology` | string | | `"triangle"` | `"quad"` or `"triangle"` — only when `should_remesh=true` |
| `target_polycount` | integer | | `30000` | Range 100–300,000 — only when `should_remesh=true` |
| `decimation_mode` | integer | | — | 1/2/3/4 levels. Overrides `target_polycount` when set |
| `save_pre_remeshed_model` | boolean | | `false` | Also return the GLB before remeshing (useful for comparison) |
| `symmetry_mode` | string | | `"auto"` | `"off"`, `"auto"`, `"on"` |
| `pose_mode` | string | | `""` | `"a-pose"` or `"t-pose"` |
| `image_enhancement` | boolean | | `true` | Optimizes input image. Set `false` to preserve exact input appearance. **Not supported under `smart-topology`** |
| `remove_lighting` | boolean | | `true` | **Not supported under `smart-topology`** |
| `moderation` | boolean | | `false` | Screens `image_url`, `texture_image_url`, `texture_prompt` |
| `target_formats` | string[] | | all except `3mf` | Limit to what you need |
| `auto_size` | boolean | | `false` | |
| `origin_at` | string | | `"bottom"` | Only when `auto_size=true` |

**Deprecated**: `is_a_t_pose` (use `pose_mode`).

**Lowpoly caveat:** `model_type="lowpoly"` retires 2026-10-30. Until then it ignores `ai_model`, `topology`, `target_polycount`, `should_remesh`, `save_pre_remeshed_model`. Nebula moves saved lowpoly nodes to `smart-topology` from that date (`backend/services/retired_nodes.py`).

**Smart topology:** the direct handler sends `ai_model: "meshy-t2"` and drops `image_enhancement`/`remove_lighting`; it refuses `topology: "quad"` and `target_polycount` above 15,000 before calling Meshy. The fal fallback (`fal-ai/meshy/v6/text-to-3d`, same limits) is checked the same way before it bills.

**Seed:** `meshy-text-to-3d` sends `seed` on the preview request on both routes (Meshy's TextTo3DRequest has it; image-to-3d and multi-image-to-3d don't, so there it stays fal-only). **Meshy 6 Lite** makes 2K textures only, so the handlers refuse it with `hd_texture: true`.

**PBR dependency:** `enable_pbr=true` requires `should_texture=true`. The API returns 400 otherwise.

### Response

Same envelope as text-to-3d. Submit returns `{"result": "<id>"}`. Poll response adds `model_urls.pre_remeshed_glb` when both `should_remesh=true` and `save_pre_remeshed_model=true`. `texture_urls` populated when `should_texture=true`.

---

## Multi-Image-to-3D (`/openapi/v1/multi-image-to-3d`)

Multiple reference images (1–4) of the **same object from different angles**.

### Parameters

Same as image-to-3d, **except**:

- `image_urls` (array, **required**) — 1 to 4 images. Each is a public URL or data URI. Formats: `.jpg`, `.jpeg`, `.png`.
- No `image_url` (singular) — it's `image_urls` (plural).

All other params identical to image-to-3d: `ai_model`, `should_texture`, `enable_pbr`, `texture_prompt`, `texture_image_url`, `should_remesh`, `topology`, `target_polycount`, `decimation_mode`, `save_pre_remeshed_model`, `symmetry_mode`, `pose_mode`, `image_enhancement`, `remove_lighting`, `moderation`, `target_formats`, `auto_size`, `origin_at`.

### Best practice (from docs)

> All images should depict the **same object from different angles** for best results.

Front + back + left + right is ideal. Mixed subjects degrade quality. Clean background helps.

---

## Prompting guidance (synthesized from docs + examples)

Meshy's official prompting advice is sparse. What's confirmed:

1. **Stay under 600 characters** for both main prompts and `texture_prompt`.
2. **Noun-phrase descriptions** work well — `"a monster mask"`, `"a futuristic robot warrior"`.
3. **Describe materials separately in `texture_prompt`** when you want precise surface detail. E.g. preview prompt: `"a medieval shield"`. Texture prompt: `"weathered iron rim, dark cracked leather center, tarnished bronze boss"`.
4. **For character rigging later**, use `pose_mode: "a-pose"` or `"t-pose"` — cleaner topology around limbs = better rig.
5. **`ai_model: latest`** (Meshy 7.1) is the newest. Use `meshy-6` for the previous generation and `meshy-6-lite` for the cheapest mesh (5 credits, 2k textures only).
6. **Don't ask for text in the mesh.** Meshy doesn't render legible glyphs on 3D surfaces — use retexture with a `texture_image_url` that already has the text baked in.
7. **Use `should_texture: false` for quick iterations** on silhouette/form. Once the geometry is right, run a retexture pass.
8. **For 3D printing**, set `target_polycount` near your slicer's comfort zone (often ~50k). For a clean low-poly mesh use `model_type: "smart-topology"` (up to 15,000 triangles).

## Common failure modes

- **`400 — insufficient credits`:** check balance (`GET /openapi/v1/balance`)
- **`400 — invalid image format`:** only `.jpg`/`.jpeg`/`.png` accepted for image inputs
- **`400 — unreachable URL`:** public URLs must be reachable without auth (no signed URLs, no localhost). Use data URIs instead
- **Geometry mismatch when using `texture_image_url`:** docs warn this happens when geometry and reference image don't align. Regenerate geometry or fall back to `texture_prompt`
- **`lowpoly` after 2026-10-30:** returns an error. Use `smart-topology`

## Example calls

### Text-to-3D preview with quad topology + 20k polys
```bash
curl -X POST https://api.meshy.ai/openapi/v2/text-to-3d \
  -H "Authorization: Bearer $MESHY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "preview",
    "prompt": "a small wooden dragon figurine with curled tail",
    "ai_model": "meshy-6",
    "should_remesh": true,
    "topology": "quad",
    "target_polycount": 20000,
    "symmetry_mode": "auto"
  }'
```

### Image-to-3D with PBR texture from reference image
```bash
curl -X POST https://api.meshy.ai/openapi/v1/image-to-3d \
  -H "Authorization: Bearer $MESHY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "image_url": "https://example.com/robot.png",
    "ai_model": "meshy-6",
    "should_texture": true,
    "enable_pbr": true,
    "texture_image_url": "https://example.com/robot-materials.png",
    "target_formats": ["glb", "fbx"]
  }'
```
