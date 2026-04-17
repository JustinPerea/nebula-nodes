---
name: fal-ai/hyper3d/rodin/v2
display_name: Hyper3D Rodin v2
category: image-to-3d
creator: Hyper3D (Deemos Technology)
fal_docs: https://fal.ai/models/fal-ai/hyper3d/rodin/v2
original_source: https://developer.hyper3d.ai/api-specification/rodin-generation-gen2
summary: Generate production-ready 3D assets with clean topology, UVs, and textures from single or multi-view images and text prompts.
---

# Hyper3D Rodin v2

## Overview
- **Slug:** `fal-ai/hyper3d/rodin/v2`
- **Category:** Image-to-3D / Text-to-3D
- **Creator:** [Hyper3D (Deemos Technology)](https://www.hyper3d.ai/)
- **Best for:** Generating production-ready 3D models with clean quad topology and PBR textures for games, VFX, and XR.
- **FAL docs:** [fal.ai/models/fal-ai/hyper3d/rodin/v2](https://fal.ai/models/fal-ai/hyper3d/rodin/v2)
- **Original source:** [Hyper3D Developer Docs](https://developer.hyper3d.ai/api-specification/rodin-generation-gen2)

## What it does
Rodin v2 is a state-of-the-art 3D generation model that transforms text descriptions or images into high-quality 3D assets. Unlike earlier "sketch" models, Rodin v2 focuses on "production-ready" outputs, delivering clean meshes (often quad-based), professional UV unwrapping, and Physically Based Rendering (PBR) textures. It supports both single-image reconstruction and multi-view fusion for higher accuracy.

## When to use this model
- **Use when:** You need a high-fidelity 3D model with usable topology and textures for integration into Unity, Unreal Engine, or Blender. It is excellent for characters (thanks to T/A-Pose support) and complex props.
- **Don't use when:** You need instant, low-cost "sketch" models where topology doesn't matter, or if you are on an extremely tight budget ($0.40 per run can add up during rapid iteration).
- **Alternatives:** 
  - **Tripo SR / CRM:** Faster and cheaper for simple object "sketches" but with much messier topology.
  - **Rodin v1:** Legacy version available if specific compatibility with older workflows is needed.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/hyper3d/rodin/v2` (sync) / `https://queue.fal.run/fal-ai/hyper3d/rodin/v2` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | | | Textual prompt to guide generation. Optional in Image-to-3D mode. |
| `input_image_urls` | list<string> | | | URLs of images (up to 5). Multiple images trigger multi-view fusion. |
| `use_original_alpha` | boolean | `false` | | Preserves transparency from input images during processing. |
| `seed` | integer | | 0 - 65535 | Seed for randomization. |
| `geometry_file_format` | enum | `glb` | `glb`, `usdz`, `fbx`, `obj`, `stl` | Output file format. |
| `material` | enum | `PBR` | `PBR`, `Shaded`, `All` | Material type (PBR for realism, Shaded for simple lighting). |
| `quality_mesh_option` | enum | `18K Quad` | `4K/8K/18K/50K Quad`, `2K/20K/150K/500K Triangle` | Combined quality and mesh type selection. |
| `TAPose` | boolean | `false` | | Forces human-like characters into T-pose or A-pose for easier rigging. |
| `bbox_condition` | list<int> | `[]` | | Bounding box dimensions [width, height, length] for scale control. |
| `addons` | string | | `HighPack` | Provides 4K textures instead of 1K (triples cost). |
| `preview_render` | boolean | `false` | | Generates a high-quality preview image alongside the model. |

### Output
The API returns a JSON object containing:
- `model_mesh`: A `File` object containing the URL to the generated 3D file.
- `textures`: A list of `Image` objects (base color, normal, metallic, etc.).
- `seed`: The seed used for the generation.

### Example request
```json
{
  "prompt": "A futuristic robot with sleek metallic design.",
  "input_image_urls": ["https://example.com/robot_front.png"],
  "quality_mesh_option": "50K Quad",
  "material": "PBR",
  "geometry_file_format": "fbx"
}
```

### Pricing
- **Base Cost:** $0.40 per generation on FAL.ai.
- **Addons:** Using `HighPack` (4K textures) triples the billable units (approx $1.20).

## API — via Original Source (BYO-key direct)
**Endpoint:** `https://api.hyper3d.com/api/v2/rodin`
**Auth:** Bearer Token (`RODIN_API_KEY`)
**Notes:** The native API supports additional granularity, such as `quality_override` for exact face counts and an `hd_texture` boolean. It also supports `mesh_mode` ("Quad" or "Raw") directly.
**Pricing:** Creator plan starts at ~$24/month for 30 credits ($0.80/credit).

## Prompting best practices
- **Be Descriptive:** For Text-to-3D, specify materials and style (e.g., "weathered bronze mechanical owl, highly detailed feathers").
- **Neutral Lighting:** For Image-to-3D, use reference images with flat, neutral lighting to avoid baked-in shadows in the textures.
- **Character Posing:** If generating a character, don't mention the pose in the prompt if you are using the `TAPose` parameter; the parameter will handle the structure.
- **Multiple Views:** If an object has complex occlusions (e.g., a backpack with straps), provide front and back images to ensure the model isn't "hallucinated" incorrectly.

## Parameter tuning guide
- **quality_mesh_option:** Use `8K Quad` for rapid prototyping and `50K Quad` for final assets. Use `Triangle` modes only if your target engine specifically requires raw triangles (e.g., some mobile optimizations).
- **addons (HighPack):** Essential for hero assets that will be viewed closely, as it bumps resolution from 1K to 4K.
- **bbox_condition:** Use this when generating a set of objects (e.g., furniture) to ensure they are scaled correctly relative to one another.

## Node inputs/outputs
- **Inputs:** `prompt` (text), `input_images` (image list), `quality` (dropdown), `format` (dropdown), `T/A Pose` (toggle).
- **Outputs:** `mesh_file` (3D file), `texture_maps` (image list), `render_preview` (image).
- **Chain-friendly with:** 
  - **Flux 1.1 Pro:** To generate the high-quality reference image for the input.
  - **Luma Dream Machine:** To animate the generated asset after rigging.

## Notes & gotchas
- **Billing:** The `HighPack` addon is a significant cost multiplier (3x).
- **Transparency:** If your input image has a background, `use_original_alpha` won't help; use a background removal node first.
- **Generation Time:** 3D generation is significantly slower than 2D; always use `queue` mode for reliable delivery in workflow apps.

## Sources
- [FAL.ai Documentation](https://fal.ai/models/fal-ai/hyper3d/rodin/v2/api)
- [Hyper3D Official API Docs](https://developer.hyper3d.ai/api-specification/rodin-generation-gen2)
- [Hyper3D Pricing & Plans](https://hyper3d.ai/pricing)
