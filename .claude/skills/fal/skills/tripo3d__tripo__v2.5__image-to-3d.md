---
name: tripo3d/tripo/v2.5/image-to-3d
display_name: Tripo3D v2.5 Image-to-3D
category: image-to-3d
creator: Tripo AI
fal_docs: https://fal.ai/models/tripo3d/tripo/v2.5/image-to-3d
original_source: https://www.tripo3d.ai/
summary: A state-of-the-art AI model that generates high-fidelity 3D meshes with PBR textures from a single 2D image in seconds.
---

# Tripo3D v2.5 Image-to-3D

## Overview
- **Slug:** `tripo3d/tripo/v2.5/image-to-3d`
- **Category:** image-to-3d
- **Creator:** [Tripo AI](https://www.tripo3d.ai/)
- **Best for:** Rapidly creating production-ready 3D assets from photos or AI-generated character/object concepts.
- **FAL docs:** [fal.ai/models/tripo3d/tripo/v2.5/image-to-3d](https://fal.ai/models/tripo3d/tripo/v2.5/image-to-3d)
- **Original source:** [tripo3d.ai](https://www.tripo3d.ai/)

## What it does
Tripo3D v2.5 is a professional-grade AI model designed to reconstruct high-quality 3D geometry and textures from a single 2D input image. It utilizes a transformer-based architecture (evolving from the open-source [TripoSR](https://github.com/VAST-AI-Research/TripoSR) project) to produce manifold meshes with high geometric accuracy and physically-based rendering (PBR) materials. The model excels at preserving the silhouette and details of the input image while hallucinating the "back side" of objects with remarkable consistency.

## When to use this model
- **Use when:** You need a 3D asset for gaming, AR/VR, or 3D printing and only have a single reference image. It is ideal for characters, furniture, and standalone props.
- **Don't use when:** You need perfect CAD-level precision for industrial parts or when the object has extremely complex occlusions (e.g., a pile of tangled wires).
- **Alternatives:** 
    - [tripo3d/tripo/v2.5/multiview-to-3d](https://fal.ai/models/tripo3d/tripo/v2.5/multiview-to-3d): Use this if you have multiple angles of the same object for higher accuracy.
    - [tripo3d/tripo/v3.0/image-to-3d](https://fal.ai/models/tripo3d/tripo/v3.0/image-to-3d): Use for even higher geometric "sculpture-level" precision with sharper edges.

## API — via FAL.ai
**Endpoint:** `https://fal.run/tripo3d/tripo/v2.5/image-to-3d` (sync) / `https://queue.fal.run/tripo3d/tripo/v2.5/image-to-3d` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | string | — | — | **Required.** The URL of the input image. Works best with a clear subject on a neutral background. |
| `texture` | enum | `standard` | `no`, `standard`, `HD` | Selects texture quality. `HD` costs an additional $0.10. |
| `pbr` | boolean | `true` | `true`, `false` | Enable/disable Physically Based Rendering material maps. |
| `quad` | boolean | `false` | `true`, `false` | Enable quad-based mesh output instead of triangles. Costs an additional $0.05. |
| `face_limit` | integer | — | 500 – 500,000 | Limits the number of faces in the output mesh. |
| `seed` | integer | random | — | Random seed for geometry generation consistency. |
| `texture_seed` | integer | random | — | Random seed for texture generation consistency. |
| `auto_size` | boolean | `false` | `true`, `false` | Automatically scales the model to real-world dimensions (meters). |
| `orientation` | enum | `default` | `default`, `align_image` | `align_image` rotates the model to match the original image perspective. |
| `texture_alignment` | enum | `original_image` | `original_image`, `geometry` | Prioritizes texture alignment based on either the input image or the generated geometry. |

### Output
The output returns a JSON object containing URLs to the generated assets:
- `task_id`: Unique identifier for the generation task.
- `model_mesh`: A [File](https://fal.ai/models/tripo3d/tripo/v2.5/image-to-3d/api#type-File) object containing the final 3D model (typically GLB).
- `base_model`: The raw geometric mesh without textures.
- `pbr_model`: The model including PBR material maps.
- `rendered_image`: A 2D preview render of the generated 3D model.

### Example request
```json
{
  "image_url": "https://platform.tripo3d.ai/assets/front-235queJB.jpg",
  "texture": "standard",
  "pbr": true,
  "quad": false
}
```

### Pricing
- **Base model (no texture):** $0.20 per run.
- **Standard texture:** $0.30 per run.
- **HD texture:** $0.40 per run.
- **Optional Quad mesh:** +$0.05 per run.
- **Optional Style:** +$0.05 per run.

## API — via Original Source (BYO-key direct)
Tripo AI offers a native REST API via their developer platform.
- **Endpoint:** `https://api.tripo3d.ai/v2/openapi/task`
- **Auth Method:** Bearer Token (starts with `tsk_`).
- **Extra Parameters:** Native access allows using `model_version` (e.g., `v3.0`, `P1`), `negative_prompt`, and `smart_low_poly` options not always exposed in standard FAL wrappers.
- **Official Docs:** [Tripo Platform Docs](https://platform.tripo3d.ai/docs/introduction)

## Prompting best practices
- **Contrast is Key:** Use images with a high contrast between the subject and the background. If possible, use images where the background is already removed (PNG with transparency).
- **Standard Pose:** For characters, A-pose or T-pose images result in the most riggable and symmetrical models.
- **Lighting:** Even, soft lighting is preferred. Harsh shadows can be misinterpreted as geometric features or baked into the texture incorrectly.
- **Avoid Occlusion:** If an object's part is hidden (e.g., a hand behind a back), the AI must guess its shape, which may lead to artifacts.

## Parameter tuning guide
- **`texture`: `HD`**: Crucial for assets that will be viewed up close in high-resolution renders.
- **`quad`: `true`**: Essential if you plan to sculpt or animate the model in software like Blender or Maya, as quad topology deforms much better than triangles.
- **`face_limit`**: Lower this to ~5,000-10,000 for mobile AR or web games to ensure fast loading and performance.
- **`orientation`: `align_image`**: Use this when the input image is an angled shot (like a 3/4 view) and you want the 3D model to be correctly oriented in 3D space relative to that camera angle.

## Node inputs/outputs
- **Inputs:**
    - `Image` (Image Port): The source 2D image.
    - `Texture Quality` (Dropdown): No, Standard, HD.
    - `Topology` (Boolean): Triangle (False) vs Quad (True).
- **Outputs:**
    - `3D Mesh` (GLB/Model Port): The final textured model.
    - `Preview Image` (Image Port): A render of the generated model.
- **Chain-friendly with:** 
    - **Pre-chain:** [fal-ai/flux/dev](https://fal.ai/models/fal-ai/flux/dev) to generate a character concept first.
    - **Post-chain:** [tripo3d/tripo/v2/animate](https://fal.ai/models/tripo3d/tripo/v2/animate) (via native Tripo) to rig and animate the output.

## Notes & gotchas
- **Queue Mode:** Highly recommended. 3D generation can take 20-60 seconds; using synchronous calls may result in timeouts in some node environments.
- **Commercial Use:** Models generated on paid FAL.ai tiers or Tripo Pro/API tiers generally include commercial usage rights ([Source](https://skywork.ai/blog/tripo-ai-review-2025/)).
- **Transparency:** The model usually handles background removal automatically, but providing a clean PNG often improves edge quality.

## Sources
- [FAL.ai Tripo3D v2.5 Docs](https://fal.ai/models/tripo3d/tripo/v2.5/image-to-3d)
- [Tripo AI Platform API Reference](https://platform.tripo3d.ai/docs/schema)
- [Tripo AI Official Pricing](https://www.tripo3d.ai/pricing)
- [TripoSR GitHub Repository](https://github.com/VAST-AI-Research/TripoSR)
