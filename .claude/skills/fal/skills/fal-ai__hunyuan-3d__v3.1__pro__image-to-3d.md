---
name: fal-ai/hunyuan-3d/v3.1/pro/image-to-3d
display_name: Hunyuan 3D v3.1 Pro Image-to-3D
category: image-to-3d
creator: Tencent
fal_docs: https://fal.ai/models/fal-ai/hunyuan-3d/v3.1/pro/image-to-3d/api
original_source: https://3d.hunyuanglobal.com
summary: A professional-grade generative AI model by Tencent that transforms single or multi-view images into high-fidelity, textured 3D assets with PBR materials.
---

# Hunyuan 3D v3.1 Pro Image-to-3D

## Overview
- **Slug:** `fal-ai/hunyuan-3d/v3.1/pro/image-to-3d`
- **Category:** Image-to-3D
- **Creator:** [Tencent](https://3d.hunyuanglobal.com)
- **Best for:** Professional-grade 3D asset generation for games, e-commerce, and VR from 2D images.
- **FAL docs:** [fal.ai/models/fal-ai/hunyuan-3d/v3.1/pro/image-to-3d](https://fal.ai/models/fal-ai/hunyuan-3d/v3.1/pro/image-to-3d)
- **Original source:** [Tencent Hunyuan 3D Studio](https://3d.hunyuanglobal.com) / [Tencent Cloud API](https://www.tencentcloud.com/document/product/1284/75540)

## What it does
Hunyuan 3D v3.1 Pro is Tencent's state-of-the-art 3D generation model that converts 2D images into high-quality 3D models. It excels at producing production-ready assets with clean topology (quad-dominant), high-fidelity textures, and Physically Based Rendering (PBR) materials. Unlike basic models, the Pro version supports up to 8 multi-view image inputs (front, back, sides, top, bottom, and diagonals) to drastically improve reconstruction accuracy and reduce geometry artifacts in complex objects ([FAL.ai](https://fal.ai/models/fal-ai/hunyuan-3d/v3.1/pro/image-to-3d)).

## When to use this model
- **Use when:** 
    - You need high-fidelity 3D meshes for professional game engines or VR/AR.
    - You have multiple views of an object and want a highly accurate reconstruction.
    - You require PBR textures (metallic, roughness, normal maps) for realistic rendering.
- **Don't use when:** 
    - You need instant, low-poly placeholders (consider the "Rapid" version instead).
    - You are processing highly transparent, refractive (glass), or extremely thin/wire-like objects without multi-view support.
- **Alternatives:** 
    - **[Hunyuan 3D v3.1 Rapid](https://fal.ai/models/fal-ai/hunyuan-3d/v3.1/rapid/image-to-3d):** Faster and cheaper ($0.225), optimized for speed over absolute fidelity.
    - **[Stable Fast 3D](https://fal.ai/models/fal-ai/stable-fast-3d):** Extremely fast (sub-second) for simple objects, but with lower mesh and texture quality.
    - **[Tripo SR](https://fal.ai/models/fal-ai/tripo-sr):** Good for quick previews but lacks the professional PBR and multi-view features of Hunyuan Pro.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/hunyuan-3d/v3.1/pro/image-to-3d` (sync) / `https://queue.fal.run/fal-ai/hunyuan-3d/v3.1/pro/image-to-3d` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `input_image_url` | string | - | Required | Primary front view image URL. 128-5000px, max 8MB. |
| `back_image_url` | string | - | Optional | Back/rear view image URL. |
| `left_image_url` | string | - | Optional | Left side view image URL. |
| `right_image_url` | string | - | Optional | Right side view image URL. |
| `top_image_url` | string | - | Optional | Top view image URL (v3.1 Pro exclusive). |
| `bottom_image_url` | string | - | Optional | Bottom view image URL (v3.1 Pro exclusive). |
| `left_front_image_url` | string | - | Optional | Left-front 45° angle view image URL (v3.1 Pro exclusive). |
| `right_front_image_url` | string | - | Optional | Right-front 45° angle view image URL (v3.1 Pro exclusive). |
| `generate_type` | string | `Normal` | `Normal`, `Geometry` | `Normal`: Textured model. `Geometry`: White model (no textures). |
| `enable_pbr` | boolean | `false` | `true`, `false` | Enables PBR materials (metallic, roughness, normal). Ignored if `generate_type` is `Geometry`. |
| `face_count` | integer | `500,000` | 40,000 - 1,500,000 | Target polygon face count for the final mesh. |

### Output
The API returns a JSON object containing:
- `model_glb`: A [File](https://fal.ai/docs/model-api-reference/3d-api/hunyuan-3d-v3.1-pro#type-File) object for the primary GLB mesh.
- `thumbnail`: A preview image of the generated model.
- `model_urls`: A dictionary containing links to various formats:
    - `glb`, `fbx`, `obj`, `mtl`, `texture`, `usdz`.
- `seed`: The integer seed used for the generation process.

### Example request
```json
{
  "input_image_url": "https://example.com/front_view.jpg",
  "back_image_url": "https://example.com/back_view.jpg",
  "enable_pbr": true,
  "face_count": 800000
}
```

### Pricing
- **Base Generation:** $0.375 per call.
- **PBR Materials:** +$0.15.
- **Multi-view Images:** +$0.15.
- **Custom Face Count:** +$0.15.
*Pricing is pay-per-use and based on [FAL.ai standard rates](https://fal.ai/models/fal-ai/hunyuan-3d/v3.1/pro/image-to-3d).*

## API — via Original Source (BYO-key direct)
Tencent provides direct API access through **Tencent Cloud** using the `hunyuan.intl.tencentcloudapi.com` endpoint. 
- **Endpoint:** `POST https://hunyuan.intl.tencentcloudapi.com`
- **Action:** `SubmitHunyuanTo3DProJob`
- **Authentication:** Tencent Cloud API SecretId and SecretKey.
- **Additional Features:** The native API supports advanced job management, batching, and tighter integration with Tencent's broader cloud ecosystem. Individual creators can also use the web interface at [3d.hunyuanglobal.com](https://3d.hunyuanglobal.com) which offers up to 20 free generations per day ([Vset3D](https://www.vset3d.com/hunyuan-3d-3-1-international-version/)).

## Prompting best practices
Since this is an image-to-3D model, "prompting" refers to the input image quality:
- **Centering:** Ensure the subject is centered and takes up most of the frame.
- **Background:** Use a clean, solid, or transparent background. Cluttered backgrounds lead to geometry noise.
- **Lighting:** Use flat, neutral lighting. Harsh shadows or highlights can be misinterpreted as texture or geometry features.
- **Multi-view:** If the object has hidden details or complex concavities, provide at least a back view.
- **Resolution:** Input images should be high quality (ideally >1024px) but within the 8MB limit.

## Parameter tuning guide
- **`enable_pbr`:** Always turn this on if you intend to use the model in a modern game engine (Unreal, Unity). It significantly improves how the model interacts with light.
- **`face_count`:** 
    - Use **40k-100k** for background props or mobile games.
    - Use **500k (default)** for hero assets or close-up objects.
    - Use **1M+** only for high-fidelity rendering or 3D printing where mesh density is critical.
- **`generate_type`:** Use `Geometry` if you plan to do custom texturing or "re-topology" in external software like ZBrush or Blender.

## Node inputs/outputs
- **Inputs:**
    - `Image (Front)`: Primary reference image.
    - `Images (Auxiliary)`: Up to 7 additional views (Back, Left, Right, etc.).
    - `Face Count`: Integer slider for poly count.
    - `PBR Toggle`: Boolean switch.
- **Outputs:**
    - `GLB File`: Primary 3D asset for web/engine.
    - `FBX/OBJ`: Export formats for DCC tools.
    - `Thumbnail`: Image for UI preview.
- **Chain-friendly with:**
    - **[FAL.ai Flux Pro](https://fal.ai/models/fal-ai/flux-pro):** Generate the "perfect" front-view image first.
    - **[FAL.ai Background Remover](https://fal.ai/models/fal-ai/fast-remove-background):** Clean up input images before feeding them to Hunyuan.

## Notes & gotchas
- **Cost Accumulation:** Be aware that each additional "feature" (PBR, multi-view, custom face count) adds to the base cost on FAL.ai ([FAL.ai Search Result](https://fal.ai/models/fal-ai/hunyuan-3d/v3.1/pro/image-to-3d)).
- **Time to Result:** The Pro model is slower than the Rapid version, typically taking 20-40 seconds per generation.
- **Topology:** While "quad-dominant," the mesh may still require a manual "re-topo" pass for high-end character animation.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/hunyuan-3d/v3.1/pro/image-to-3d)
- [FAL.ai API Reference](https://fal.ai/docs/model-api-reference/3d-api/hunyuan-3d-v3.1-pro)
- [Tencent Cloud API Documentation](https://www.tencentcloud.com/document/product/1284/75540)
- [Hunyuan 3D Studio Official](https://3d.hunyuanglobal.com)
- [Vset3D Technical Overview](https://www.vset3d.com/hunyuan-3d-3-1-international-version/)