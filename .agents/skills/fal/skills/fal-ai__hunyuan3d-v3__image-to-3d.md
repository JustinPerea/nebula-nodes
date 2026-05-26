---
name: fal-ai/hunyuan3d-v3/image-to-3d
display_name: Hunyuan3D-v3 Image-to-3D
category: image-to-3d
creator: Tencent
fal_docs: https://fal.ai/models/fal-ai/hunyuan3d-v3/image-to-3d
original_source: https://github.com/Tencent-Hunyuan/Hunyuan3D-2, https://www.tencentcloud.com/document/product/1281/74125
summary: Transform single or multi-view images into ultra-high-resolution 3D models with optional PBR textures and custom polygon counts.
---

# Hunyuan3D-v3 Image-to-3D

## Overview
- **Slug:** `fal-ai/hunyuan3d-v3/image-to-3d`
- **Category:** 3D Generation (Image-to-3D)
- **Creator:** [Tencent](https://github.com/Tencent-Hunyuan)
- **Best for:** Creating production-ready 3D assets for games, AR/VR, and e-commerce from reference images.
- **FAL docs:** [fal-ai/hunyuan3d-v3/image-to-3d](https://fal.ai/models/fal-ai/hunyuan3d-v3/image-to-3d)
- **Original source:** [Tencent Hunyuan3D-V3 GitHub](https://github.com/Tencent-Hunyuan), [Tencent Cloud API Documentation](https://www.tencentcloud.com/document/product/1281/74125)

## What it does
Hunyuan3D-v3 Image-to-3D is a state-of-the-art model designed to transform photos into ultra-high-resolution 3D models. It utilizes an advanced architecture (similar to a Mixture-of-Experts DiT) to generate film-quality geometry with optional Physically Based Rendering (PBR) textures. The model supports both single-image inputs and multi-view consistency by accepting additional back, left, and right view images for more accurate reconstruction of complex shapes.

## When to use this model
- **Use when:**
  - You need high-fidelity 3D meshes (up to 1.5M polygons) for professional use.
  - You have multiple reference angles of an object and want to ensure 360-degree accuracy.
  - You require PBR materials for realistic lighting in engines like Unity or Unreal.
- **Don't use when:**
  - You need real-time generation (latency is approximately 1 minute).
  - You are generating highly organic or fluid shapes that lack clear structural definition.
- **Alternatives:**
  - **Hunyuan 3D Rapid:** Faster and cheaper ($0.225) but with simplified parameters and lower geometric detail.
  - **Tripo3D:** Good for rapid prototyping with a more fixed pipeline.
  - **Rodin:** Often used for high-quality human head and body generation.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/hunyuan3d-v3/image-to-3d` (sync) / `https://queue.fal.run/fal-ai/hunyuan3d-v3/image-to-3d` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `input_image_url` | string | (required) | URL | Primary front-view image of the object. |
| `back_image_url` | string | null | URL | Optional back view for improved 3D reconstruction. |
| `left_image_url` | string | null | URL | Optional left view for improved 3D reconstruction. |
| `right_image_url` | string | null | URL | Optional right view for improved 3D reconstruction. |
| `enable_pbr` | boolean | `false` | `true`, `false` | Enables PBR material generation (surcharge applies). |
| `face_count` | integer | `500000` | `40000` - `1500000` | Target polygon count for the output mesh. |
| `generate_type` | string | `Normal` | `Normal`, `LowPoly`, `Geometry` | `Normal`: Textured; `LowPoly`: Optimized; `Geometry`: White mesh. |
| `polygon_type` | string | `triangle` | `triangle`, `quadrilateral` | Mesh topology (LowPoly only). |
| `seed` | integer | null | (any) | Seed for reproducible generation. |

### Output
The output is a JSON object containing URLs to the generated 3D files and metadata:
- `model_glb`: (File) Main 3D model in GLB format.
- `thumbnail`: (File) Preview image of the model.
- `model_urls`: (Object) Contains links to `glb`, `fbx`, `obj`, and `usdz` formats.
- `seed`: (integer) The seed used during inference.

### Example request
```json
{
  "input_image_url": "https://example.com/front_view.png",
  "back_image_url": "https://example.com/back_view.png",
  "enable_pbr": true,
  "face_count": 800000,
  "generate_type": "Normal"
}
```

### Pricing
- **Base Generation (Normal):** $0.375 per call.
- **Geometry Only (White Mesh):** $0.225 per call.
- **LowPoly Generation:** $0.45 per call.
- **PBR Materials Surcharge:** +$0.15.
- **Multi-view Surcharge:** +$0.15 (applied if back/left/right URLs are provided).
- **Custom Face Count Surcharge:** +$0.15.

## API — via Original Source (BYO-key direct)
Tencent Cloud provides the native API under the "Hunyuan 3D Global" product.
- **Endpoint:** `https://hy3d.tencentcloudapi.com`
- **Method:** Async pattern using `SubmitHunyuanTo3DProJob` and `QueryHunyuanTo3DProJob`.
- **Auth:** Tencent Cloud API Key (SecretId/SecretKey).
- **Extra Features:** The native Tencent API may support up to 8 view angles in the latest v3.1 Pro version.

## Prompting best practices
- **Neutral Backgrounds:** Use images with clean, neutral backgrounds to avoid geometry noise.
- **Uniform Lighting:** Avoid harsh shadows or high-contrast lighting on the source image; the model interprets these as surface details or baked lighting.
- **Multi-View Consistency:** If providing multiple views, ensure the object is in the exact same pose across all images.
- **Occlusion Awareness:** If an object has hidden parts (e.g., inside a cup), the model will guess. Providing a top-view (if supported by native) or more side views helps.
- **Failure Mode:** Translucent objects (glass, water) often fail to reconstruct properly as the model struggles with depth estimation through transparent surfaces.

## Parameter tuning guide
- **`generate_type`:** Set to `Geometry` for rapid architectural testing where textures don't matter. Use `LowPoly` for mobile/web games where polygon budget is tight.
- **`face_count`:** 500k is the sweet spot for most objects. Go to 1.5M only for extremely complex hero assets meant for close-ups.
- **`enable_pbr`:** Always turn this on if you intend to use the asset in a modern game engine like Unreal Engine 5 to get proper roughness and metallic maps.

## Node inputs/outputs
- **Inputs:**
  - `Image` (Main)
  - `Image` (Back View)
  - `Image` (Left View)
  - `Image` (Right View)
  - `Enable PBR` (Boolean)
  - `Target Polygons` (Number)
- **Outputs:**
  - `GLB File`
  - `FBX/OBJ Bundle`
  - `Thumbnail`
- **Chain-friendly with:**
  - `fal-ai/flux-pro` (to generate the initial reference image)
  - `fal-ai/tripo3d` (for alternative mesh variants)
  - `fal-ai/kling-video` (to generate a turnaround video for previewing)

## Notes & gotchas
- **Latency:** Expect 45-90 seconds for high-poly PBR generations.
- **Queue Mode:** Highly recommended for this model due to long inference times; use `fal.queue.submit` and poll for results.
- **Commercial Use:** FAL.ai labels this model as available for commercial use, matching Tencent's open-source license terms.

## Sources
- [FAL.ai Hunyuan3D API Docs](https://fal.ai/models/fal-ai/hunyuan3d-v3/image-to-3d/api)
- [Tencent Hunyuan3D GitHub](https://github.com/Tencent-Hunyuan)
- [Tencent Cloud API Explorer](https://www.tencentcloud.com/document/product/1281/74125)
- [FAL.ai Pricing Page](https://fal.ai/pricing)
