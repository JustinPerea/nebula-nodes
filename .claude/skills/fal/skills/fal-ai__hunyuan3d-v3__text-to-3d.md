---
name: fal-ai/hunyuan3d-v3/text-to-3d
display_name: Hunyuan3D V3 Text-to-3D
category: text-to-3d
creator: Tencent
fal_docs: https://fal.ai/models/fal-ai/hunyuan3d-v3/text-to-3d
source: llms.txt (fetched 2026-04-17)
summary: Generate textured, fully-rigged 3D models from text prompts.
---

# Hunyuan3D V3 Text-to-3D

## Overview
- **Slug:** `fal-ai/hunyuan3d-v3/text-to-3d`
- **Endpoint:** `https://fal.run/fal-ai/hunyuan3d-v3/text-to-3d`
- **Pricing:** $0.375/generation (Normal), $0.45 (LowPoly), $0.225 (Geometry). +$0.15 for PBR, +$0.15 for multi-view inputs, +$0.15 for custom face count.

## Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | required | ≤1024 UTF-8 chars | Content description. |
| `enable_pbr` | boolean | `false` | — | Enable PBR materials (metallic/roughness/normal). |
| `face_count` | integer | `500000` | 40000–1500000 | Target polygon count. |
| `generate_type` | enum | `Normal` | `Normal`, `LowPoly`, `Geometry` | Normal=textured, LowPoly=reduced, Geometry=untextured. |
| `polygon_type` | enum | `triangle` | `triangle`, `quadrilateral` | Only when `generate_type=LowPoly`. |

## Output
```json
{
  "model_glb": { "url": "...", "content_type": "model/gltf-binary" },
  "thumbnail": { "url": "...", "content_type": "image/png" },
  "model_urls": { "glb": { "url": "..." }, "obj": { "url": "..." } },
  "seed": 12345
}
```
