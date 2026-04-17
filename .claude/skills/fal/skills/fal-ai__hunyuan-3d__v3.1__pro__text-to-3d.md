---
name: fal-ai/hunyuan-3d/v3.1/pro/text-to-3d
display_name: Hunyuan 3D Pro Text to 3D
category: text-to-3d
creator: Tencent Hunyuan Team
fal_docs: https://fal.ai/models/fal-ai/hunyuan-3d/v3.1/pro/text-to-3d
original_source: https://github.com/Tencent-Hunyuan/Hunyuan3D-1, https://www.tencentcloud.com/product/hunyuan-3d
summary: A professional-grade 3D asset generation model by Tencent that creates high-fidelity textured meshes from text descriptions.
---

# Hunyuan 3D Pro Text to 3D

## Overview
- **Slug:** `fal-ai/hunyuan-3d/v3.1/pro/text-to-3d`
- **Category:** Text-to-3D
- **Creator:** [Tencent Hunyuan Team](https://github.com/Tencent-Hunyuan)
- **Best for:** Generating professional-grade, high-fidelity textured 3D assets for games, AR/VR, and e-commerce from natural language descriptions.
- **FAL docs:** [FAL.ai Hunyuan 3D Pro Docs](https://fal.ai/models/fal-ai/hunyuan-3d/v3.1/pro/text-to-3d)
- **Original source:** [Tencent Cloud Hunyuan 3D](https://www.tencentcloud.com/product/hunyuan-3d)

## What it does
Hunyuan 3D Pro is a state-of-the-art 3D generation model that converts text prompts into detailed, fully-textured 3D meshes. It utilizes a two-stage process (likely based on the Hunyuan3D-DiT and Hunyuan3D-Paint architectures) to first generate accurate geometric structures and then synthesize high-resolution, lighting-invariant textures. The Pro version is optimized for production-ready assets with clean topology and support for Physically Based Rendering (PBR) materials.

## When to use this model
- **Use when:** You need high-quality 3D assets for professional pipelines (Unity, Unreal, Blender). You require PBR materials (metallic, roughness, normal maps) for realistic lighting. You need fine control over polygon counts (up to 1.5M faces).
- **Don't use when:** You need ultra-fast "rapid" results where quality is secondary (use the "Rapid" variant instead). You only have an image input (use the Image-to-3D model).
- **Alternatives:** 
  - **[Hunyuan 3D Rapid](https://fal.ai/models/fal-ai/hunyuan-3d/v3.1/rapid/text-to-3d):** Faster and cheaper, but with lower geometric precision and simpler textures.
  - **[Tripo SR](https://fal.ai/models/fal-ai/tripo-sr):** Extremely fast image-to-3D, but lacks the text-to-3D direct capability and complex texture synthesis of Hunyuan.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/hunyuan-3d/v3.1/pro/text-to-3d` (sync) / `https://queue.fal.run/fal-ai/hunyuan-3d/v3.1/pro/text-to-3d` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | Max 1024 chars | Text description of the 3D content to generate. |
| `generate_type` | string | `Normal` | `Normal`, `Geometry` | `Normal`: Textured model. `Geometry`: White white model (no textures). |
| `enable_pbr` | boolean | `false` | `true`, `false` | Enable PBR material generation (metallic, roughness, normal textures). |
| `face_count` | integer | `500000` | 40,000 - 1,500,000 | Target polygon face count for the final mesh. |
| `seed` | integer | (Random) | Any integer | Seed for reproducibility. |

### Output
The output is a JSON object containing URLs to the generated assets.
- **`model_glb`**: The primary 3D file in GLB format.
- **`thumbnail`**: A 2D image preview of the model.
- **`model_urls`**: A dictionary containing various formats:
  - `glb`: GLB format.
  - `fbx`: FBX format.
  - `obj`: OBJ format.
  - `mtl`: Material file for OBJ.
  - `texture`: The combined texture map.
  - `usdz`: USDZ format (for iOS/AR).
- **`seed`**: The seed value used for the generation.

### Example request
```json
{
  "prompt": "A highly detailed futuristic cybernetic helmet, matte black with neon blue glowing accents, sci-fi style, 8k textures",
  "enable_pbr": true,
  "face_count": 800000
}
```

### Pricing
- **Base cost:** $0.375 per generation.
- **PBR Materials:** Adds $0.15.
- **Custom Face Count:** Adds $0.15.
- **Total Pro Call (typical):** ~$0.525 - $0.675 depending on features.

## API — via Original Source (BYO-key direct)
Tencent offers the **Tencent Hunyuan 3D Global (Professional Edition)** via [Tencent Cloud](https://www.tencentcloud.com/document/product/1281/74121).
- **Auth:** Tencent Cloud SecretId and SecretKey.
- **Endpoint:** `hunyuan.tencentcloudapi.com` (varies by region).
- **Differences:** The native API supports advanced multi-view inputs and provides a credit-based billing system ($0.02 per credit, standard Pro calls consume ~25 credits). It also offers a "Express" version for simpler tasks.

## Prompting best practices
- **Be Structural:** Describe the overall shape first (e.g., "A bipedal robot").
- **Material Specificity:** Explicitly mention materials like "brushed aluminum," "translucent glass," or "weathered leather" to help the texture synthesizer.
- **Style Keywords:** Use "hyper-realistic," "stylized cartoon," "low-poly," or "voxels" to guide the aesthetic.
- **Avoid Ambiguity:** Instead of "a cool thing," use "a steampunk mechanical dragon with brass gears."
- **Common Failure Mode:** Overly complex scenes with multiple disconnected objects often result in a single merged mesh blob. Stick to single subjects or well-defined groups.

## Parameter tuning guide
- **`face_count`**: Increase this for organic shapes or complex machinery to avoid "blockiness." Decrease it for game-ready background assets to improve performance.
- **`enable_pbr`**: Always enable this if the asset is destined for a modern game engine (Unity/Unreal) to ensure realistic light interaction.
- **`generate_type`**: Use `Geometry` if you plan to do custom texturing or "re-topology" in external software.

## Node inputs/outputs
- **Inputs:**
  - `Prompt` (Text)
  - `PBR Toggle` (Boolean)
  - `Target Poly Count` (Number)
- **Outputs:**
  - `GLB File` (3D Asset)
  - `Preview Image` (Image)
  - `USDZ File` (3D Asset)
- **Chain-friendly with:**
  - **[Flux Pro](https://fal.ai/models/fal-ai/flux-pro)**: Generate a concept image first, then use it as a prompt reference.
  - **[Luma Genie](https://fal.ai/models/fal-ai/luma-genie)**: Compare outputs for different style strengths.

## Notes & gotchas
- **Generation Time:** Pro generations are significantly slower than Rapid (often taking 60-120 seconds). Always use `queue` mode for workflow integrations.
- **Orientation:** Models may require a 90-degree rotation depending on your target engine's coordinate system (Y-up vs Z-up).
- **Watertightness:** While generally high quality, complex geometries may occasionally have non-manifold edges or small holes.

## Sources
- [FAL.ai API Documentation](https://fal.ai/models/fal-ai/hunyuan-3d/v3.1/pro/text-to-3d/api)
- [Tencent Cloud Billing Guide](https://www.tencentcloud.com/document/product/1281/74121)
- [Hunyuan3D-1.0 GitHub Repository](https://github.com/Tencent-Hunyuan/Hunyuan3D-1)
- [Vset3D Technical Announcement](https://www.vset3d.com/hunyuan-3d-3-0-the-future-of-ai-powered-modeling/)