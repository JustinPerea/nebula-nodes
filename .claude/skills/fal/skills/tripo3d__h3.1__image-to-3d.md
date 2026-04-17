---
name: tripo3d/h3.1/image-to-3d
display_name: Tripo H3.1 Image to 3D
category: image-to-3d
creator: Tripo AI (VAST-AI-Research)
fal_docs: https://fal.ai/models/tripo3d/h3.1/image-to-3d
original_source: https://platform.tripo3d.ai/docs/generation
summary: Generate production-ready, high-fidelity 3D models with PBR textures and quad topology from a single 2D image.
---

# Tripo H3.1 Image to 3D

## Overview
- **Slug:** `tripo3d/h3.1/image-to-3d`
- **Category:** Image-to-3D
- **Creator:** [Tripo AI](https://www.tripo3d.ai)
- **Best for:** Creating high-quality, textured 3D assets for games, AR/VR, and 3D printing from single reference photos.
- **FAL docs:** [fal.ai/models/tripo3d/h3.1/image-to-3d](https://fal.ai/models/tripo3d/h3.1/image-to-3d)
- **Original source:** [Tripo AI Platform Docs](https://platform.tripo3d.ai/docs/generation)

## What it does
Tripo H3.1 is a state-of-the-art generative 3D model that transforms a single 2D image into a fully textured 3D mesh. Unlike earlier rapid-reconstruction models, H3.1 focuses on **geometric precision** and **production-level textures**, supporting Physically Based Rendering (PBR) materials and optional quad-based topology. It excels at capturing complex shapes, sharp edges, and detailed surface appearances, making it suitable for hero assets rather than just rapid prototypes.

## When to use this model
- **Use when:** You need a single-image-to-3D solution that produces high-fidelity geometry and realistic lighting/materials.
- **Use when:** You require clean quad-topology for further editing in software like Blender or Maya.
- **Don't use when:** You need 100% exact architectural dimensions (photogrammetry is better) or for extremely complex multi-object scenes.
- **Alternatives:** 
    - [Tripo v2.5](https://fal.ai/models/tripo3d/tripo/v2.5/image-to-3d): Faster but with lower geometric detail.
    - [Tripo Multiview-to-3D](https://fal.ai/models/tripo3d/h3.1/multiview-to-3d): Better accuracy if you have multiple angles of the same object.

## API — via FAL.ai
**Endpoint:** `https://fal.run/tripo3d/h3.1/image-to-3d` (sync) / `https://queue.fal.run/tripo3d/h3.1/image-to-3d` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | string | - | Required | URL of the input image. Suggested resolution > 256x256px. |
| `face_limit` | integer | adaptive | 500 - 20000 | Target number of faces for the generated mesh. |
| `texture` | boolean | `true` | - | Whether to generate textures for the model. |
| `pbr` | boolean | `true` | - | If true, generates PBR materials (overrides `texture` to true). |
| `model_seed` | integer | random | - | Seed for geometry generation reproducibility. |
| `texture_seed` | integer | random | - | Seed for texture generation reproducibility. |
| `texture_quality` | string | `standard` | `standard`, `detailed` | `detailed` produces higher-resolution textures. |
| `geometry_quality` | string | `standard` | `standard`, `detailed` | `detailed` enables "Ultra Mode" for maximum geometric detail. |
| `texture_alignment`| string | `original_image` | `original_image`, `geometry` | `original_image` prioritizes visual fidelity; `geometry` prioritizes structural alignment. |
| `auto_size` | boolean | `false` | - | Auto-scale model to real-world dimensions (meters). |
| `orientation` | string | `default` | `default`, `align_image` | `align_image` auto-rotates model to match the input image perspective. |
| `quad` | boolean | `false` | - | Generate quad (4-sided) mesh topology instead of triangles. Forces FBX output. |

### Output
The API returns a JSON object containing:
- `model_mesh`: A [File](https://fal.ai/models/tripo3d/h3.1/image-to-3d/api#type-File) object for the primary GLB model.
- `model_urls`: A dictionary containing URLs for:
    - `glb`: The standard GLB file.
    - `base_model`: The untextured mesh.
    - `pbr_model`: The model with PBR texture maps.
- `rendered_image`: A preview render of the generated 3D model.

### Example request
```json
{
  "image_url": "https://example.com/my_image.png",
  "texture": true,
  "pbr": true,
  "geometry_quality": "detailed",
  "texture_quality": "detailed",
  "quad": true
}
```

### Pricing
- **Base Request (No texture):** ~$0.20
- **Standard Texture:** ~$0.30 total
- **HD Texture:** ~$0.40 total
- **Detailed Geometry (Ultra):** +$0.20
- **Quad Mesh:** +$0.05
*(Note: Pricing is approximate based on [FAL.ai's pay-per-use model](https://fal.ai/pricing).)*

## API — via Original Source (BYO-key direct)
Tripo AI offers a native API with additional specialized features.
- **Endpoint:** `POST https://api.tripo3d.ai/v2/openapi/task`
- **Auth:** Bearer token (API Key from [Tripo Platform](https://platform.tripo3d.ai/)).
- **Extra Parameters:**
    - `smart_low_poly`: Specifically optimized low-poly generation (1k-20k faces).
    - `generate_parts`: Segmented mesh output where parts are editable (incompatible with textures).
    - `compress`: Options for `geometry` or `meshopt` compression.
    - `export_uv`: Toggle for UV unwrapping (speed up generation if not needed).

## Prompting best practices
3D models are highly sensitive to the quality of the input 2D image.
- **Background:** Use a clean, solid, or transparent background. Busy backgrounds cause "blobs" in the mesh.
- **Lighting:** Even, neutral lighting is best. Strong shadows or highlights will be "baked" into the texture.
- **Subject Framing:** Ensure the entire object is within the frame. Cut-off limbs or edges result in incomplete models.
- **Angles:** Front-facing or 3/4 views are generally most reliable.
- **Bad Input:** Images with heavy motion blur, low resolution (<256px), or occluded subjects (e.g., a hand covering the object).

## Parameter tuning guide
1. **`geometry_quality`**: Set to `detailed` for "Hero Assets" or objects with complex mechanical parts. Use `standard` for background props to save cost and time.
2. **`quad`**: Always set to `true` if you intend to animate the model or use it in a professional pipeline. Quads allow for predictable deformation during rigging.
3. **`texture_alignment`**: Set to `original_image` for characters or art where the "look" is paramount. Set to `geometry` for rigid objects (furniture, tools) to ensure textures don't "swim" on the surface.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Image` (Image/URL)
    - `Detailed Geometry` (Boolean)
    - `HD Textures` (Boolean)
    - `Quad Topology` (Boolean)
    - `Face Limit` (Integer)
- **Outputs:**
    - `GLB URL` (String)
    - `PBR Model URL` (String)
    - `Preview Image` (Image)
- **Chain-friendly with:**
    - [fal-ai/flux-pro](https://fal.ai/models/fal-ai/flux-pro): Generate the perfect source image for 3D conversion.
    - [fal-ai/image-background-remover](https://fal.ai/models/fal-ai/image-background-remover): Pre-process images to improve 3D quality.

## Notes & gotchas
- **File Format:** Enabling `quad=true` typically switches the output to FBX or a specific GLB variant compatible with quad data.
- **Processing Time:** High-fidelity modes (`detailed`) can take 2-5 minutes compared to the 30-60 seconds of standard mode.
- **Character Sizing:** Use `auto_size=true` if you need the model to be roughly 1:1 scale for AR applications.

## Sources
- [FAL.ai Tripo H3.1 Documentation](https://fal.ai/models/tripo3d/h3.1/image-to-3d/api)
- [Tripo AI Official API Reference](https://platform.tripo3d.ai/docs/generation)
- [FAL.ai Pricing Page](https://fal.ai/pricing)
- [VAST-AI-Research GitHub](https://github.com/VAST-AI-Research/TripoSR)
