---
name: fal-ai/trellis-2
display_name: Trellis 2
category: image-to-3d
creator: Microsoft Research
fal_docs: https://fal.ai/models/fal-ai/trellis-2
original_source: https://github.com/microsoft/TRELLIS.2
summary: A state-of-the-art 4B parameter image-to-3D model generating high-fidelity assets with PBR textures and arbitrary topology support.
---

# Trellis 2

## Overview
- **Slug:** `fal-ai/trellis-2`
- **Category:** image-to-3d
- **Creator:** [Microsoft Research](https://github.com/microsoft/TRELLIS.2)
- **Best for:** Generating production-ready 3D assets from single or multiple images.
- **FAL docs:** [fal.ai/models/fal-ai/trellis-2](https://fal.ai/models/fal-ai/trellis-2)
- **Original source:** [Microsoft GitHub Repository](https://github.com/microsoft/TRELLIS.2)

## What it does
Trellis 2 is a state-of-the-art 3D generative model with 4 billion parameters that converts 2D images into high-fidelity 3D assets. It utilizes a novel "field-free" sparse voxel structure (O-Voxel) and flow-matching transformers to reconstruct complex topologies, including thin geometry and transparent objects. The model produces fully textured GLB files featuring Physically-Based Rendering (PBR) materials (base color, metallic, roughness, and opacity) at resolutions up to 1536³.

## When to use this model
- **Use when:** You need high-quality 3D models for game development, AR/VR, or 3D printing from a single reference photo. It is particularly strong at handling complex shapes that traditional models struggle with.
- **Don't use when:** You need real-time generation (it takes 1-3 minutes) or if the input subject is poorly lit or has heavy background clutter.
- **Alternatives:** 
    - **Tripo SR:** Faster but lower fidelity and less control over geometry.
    - **Rodim 3D Gen:** Better for specific artistic styles but may lack the topological flexibility of Trellis 2.
    - **Hunyuan 3D:** Comparable quality but often optimized for different types of subjects; Trellis 2 generally handles thin structures better.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/trellis-2` (sync) / `https://queue.fal.run/fal-ai/trellis-2` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | string | *Required* | URL | URL of the input image to convert to 3D. |
| `resolution` | string | `1024` | `512`, `1024`, `1536` | Output voxel resolution; higher is more detailed but slower. |
| `seed` | integer | Random | - | Seed for reproducibility. |
| `ss_guidance_strength` | float | `7.5` | `0` to `10` | Guidance for initial 3D structure; higher is more faithful but noisier. |
| `ss_guidance_rescale` | float | `0.7` | `0` to `1` | Dampens artifacts in stage 1. |
| `ss_sampling_steps` | integer | `12` | `1` to `50` | Denoising steps for initial structure. |
| `ss_rescale_t` | float | `5.0` | `1` to `6` | Controls noise schedule sharpness for structure. |
| `shape_slat_guidance_strength` | float | `7.5` | `0` to `10` | Detail geometry guidance strength. |
| `shape_slat_guidance_rescale` | float | `0.5` | `0` to `1` | Stabilizes geometry detail. |
| `shape_slat_sampling_steps` | integer | `12` | `1` to `50` | Denoising steps for shape refinement. |
| `shape_slat_rescale_t` | float | `3.0` | `1` to `6` | Controls sharpness of geometric details. |
| `tex_slat_guidance_strength` | float | `1.0` | `0` to `10` | Texture color fidelity guidance. |
| `tex_slat_guidance_rescale` | float | `0.0` | `0` to `1` | Stabilizes texture generation. |
| `tex_slat_sampling_steps` | integer | `12` | `1` to `50` | Denoising steps for texture generation. |
| `tex_slat_rescale_t` | float | `3.0` | `1` to `6` | Controls sharpness of texture details. |
| `decimation_target` | integer | `500000` | `5000` to `2M` | Target vertex count. Reduce for web/mobile optimization. |
| `texture_size` | integer | `2048` | `1024`, `2048`, `4096` | Resolution of baked texture image. |
| `remesh` | boolean | `true` | - | Rebuild topology for cleaner triangles. |
| `remesh_band` | float | `1.0` | `0` to `4` | Smoothing distance for remeshing. |
| `remesh_project` | float | `0.0` | `0` to `1` | Detail projection back to surface. |

### Output
The output is a JSON object containing a `model_glb` file object:
```json
{
  "model_glb": {
    "url": "https://fal.media/files/...",
    "content_type": "model/gltf-binary",
    "file_name": "asset.glb",
    "file_size": 1234567
  }
}
```

### Example request
```json
{
  "image_url": "https://example.com/object.png",
  "resolution": "1024",
  "texture_size": 2048,
  "remesh": true
}
```

### Pricing
- **512p:** $0.25 per request
- **1024p:** $0.30 per request
- **1536p:** $0.35 per request

## API — via Original Source (BYO-key direct)
FAL.ai is currently the primary public API surface for Trellis 2. The original code is open-source and can be self-hosted via the [Microsoft GitHub repo](https://github.com/microsoft/TRELLIS.2), but no separate commercial direct API endpoint exists from Microsoft for BYO-key usage.

## Prompting best practices
- **Background Removal:** Use images with a solid, neutral background (preferably white or transparent) to avoid geometric "ghosting."
- **Lighting:** Avoid harsh shadows or high specular highlights; the model reconstructs geometry from shading cues, and inconsistent lighting can lead to warped surfaces.
- **Subject Framing:** Ensure the object is centered and fills the frame. Multi-view inputs (using the `MultiImageInputModel` schema) significantly improve the reconstruction of occluded areas.
- **Transparent Objects:** Unlike many 3D models, Trellis 2 supports transparency. Use PNGs with alpha channels to help the model identify clear surfaces.
- **Failure Mode:** If the model creates "melted" geometry, increase `ss_guidance_strength` and ensure the input image resolution is at least 512px.

## Parameter tuning guide
- **`resolution`:** Switch to `1536` for assets intended for close-up rendering; keep at `1024` for standard assets to save cost and time.
- **`decimation_target`:** For web-based viewers or mobile games, set this to `20000` to `50000`. The default `500000` is overkill for non-professional rendering.
- **`remesh`:** Always keep this `true` if you plan to rig or animate the model, as it creates a much cleaner manifold topology.
- **`ss_guidance_strength`:** Increase (up to 9.0) if the 3D shape looks too generic and doesn't match your input's unique silhouette.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Image` (Image/URL)
  - `Resolution` (Select: 512, 1024, 1536)
  - `Seed` (Int)
  - `Remesh` (Boolean)
- **Outputs:**
  - `GLB File` (3D Model)
  - `Model URL` (String)
- **Chain-friendly with:**
  - **Flux 1.1 [dev]:** Use to generate the high-quality source image for the 3D conversion.
  - **Lama Cleaner:** To remove background elements from a photo before 3D generation.
  - **Kling Video:** To create a "turnaround" video of the generated 3D asset.

## Notes & gotchas
- **Model Bias:** As a foundation model without RLHF alignment, outputs may vary in style based on training data distributions.
- **Processing Time:** Requests are typically handled via queue mode due to the 1-3 minute inference time.
- **Regional Restrictions:** Generally available globally through FAL's infrastructure.

## Sources
- [FAL.ai Trellis 2 Model Page](https://fal.ai/models/fal-ai/trellis-2)
- [Microsoft TRELLIS.2 GitHub](https://github.com/microsoft/TRELLIS.2)
- [HuggingFace Microsoft TRELLIS.2-4B Card](https://huggingface.co/microsoft/TRELLIS.2-4B)
- [FAL.ai Parameter Guide](https://fal.ai/learn/devs/trellis-2-image-to-3d-prompt-guide)
