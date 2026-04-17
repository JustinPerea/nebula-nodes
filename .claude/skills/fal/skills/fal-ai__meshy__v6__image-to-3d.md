---
name: fal-ai/meshy/v6/image-to-3d
display_name: Meshy-6 Image to 3D
category: image-to-3d
creator: Meshy LLC
fal_docs: https://fal.ai/models/fal-ai/meshy/v6/image-to-3d
original_source: https://docs.meshy.ai/api/image-to-3d
summary: Convert 2D images into high-quality, production-ready 3D models with support for rigging and animation.
---

# Meshy-6 Image to 3D

## Overview
- **Slug:** `fal-ai/meshy/v6/image-to-3d`
- **Category:** 3D Generation (Image-to-3D)
- **Creator:** [Meshy LLC](https://www.meshy.ai/)
- **Best for:** Converting a single 2D image into a professional-grade 3D model with realistic textures and optional rigging.
- **FAL docs:** [FAL.ai Meshy v6 Docs](https://fal.ai/models/fal-ai/meshy/v6/image-to-3d)
- **Original source:** [Meshy Official API Documentation](https://docs.meshy.ai/en/api/image-to-3d)

## What it does
Meshy-6 Image to 3D is a state-of-the-art generative model that transforms 2D images—ranging from concept art and product photos to AI-generated characters—into high-fidelity 3D assets. It reconstructs accurate geometry and generates high-quality PBR (Physically Based Rendering) textures, including base color, metallic, roughness, and normal maps. Beyond static meshes, the model supports automatic humanoid rigging and a library of over 500 animations, making it a comprehensive tool for game development, AR/VR, and digital twin creation.

## When to use this model
- **Use when:**
    - You need to quickly prototype 3D assets from 2D character designs or concept art.
    - You require production-ready 3D models with clean topology (Quad-dominant) for further editing in Blender or Maya.
    - You want to animate a 2D character immediately without manual rigging.
    - You are building an app that requires 3D visualization of 2D product photos.
- **Don't use when:**
    - You need CAD-level precision for engineering or manufacturing (though STL export is supported for 3D printing).
    - The input image is highly cluttered or lacks a clear focal object.
    - You require real-time generation (processing takes 5-10 minutes).
- **Alternatives:**
    - **Tripo AI:** Often faster for low-poly assets but may have different texture fidelity compared to Meshy-6.
    - **Rodin AI:** Known for high-quality geometry, particularly for organic shapes, but may lack the integrated rigging features of Meshy.
    - **Luma AI Genie:** Good for quick, casual 3D previews but often less "production-ready" in terms of export formats and PBR control.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/meshy/v6/image-to-3d` (sync) / `https://queue.fal.run/fal-ai/meshy/v6/image-to-3d` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | string | - | URL or Base64 | **Required.** The source image. Supports .jpg, .jpeg, .png, .webp, .gif, .avif. |
| `topology` | string | `triangle` | `quad`, `triangle` | Specifies the mesh structure. `quad` is better for animation and sculpting. |
| `target_polycount` | integer | `30000` | 100 - 300,000 | The goal number of polygons. Higher values preserve more detail but increase file size. |
| `symmetry_mode` | string | `auto` | `off`, `auto`, `on` | Controls geometric symmetry. `auto` is usually best for characters. |
| `should_remesh` | boolean | `true` | - | If true, applies a remeshing phase to improve polygon flow. |
| `should_texture` | boolean | `true` | - | Whether to generate textures for the model. |
| `enable_pbr` | boolean | `false` | - | If true, generates metallic, roughness, and normal maps. |
| `pose_mode` | string | "" | `a-pose`, `t-pose`, "" | Forces the model into a specific rigging-ready pose. |
| `texture_prompt` | string | - | Max 600 chars | Text guidance to refine the look of the generated textures. |
| `texture_image_url`| string | - | URL or Base64 | A secondary image to guide the texturing process (e.g., a style reference). |
| `enable_rigging` | boolean | `false` | - | Automatically rigs the model as a humanoid character. |
| `rigging_height_meters` | float | `1.7` | - | Estimated character height for proper bone scaling. |
| `enable_animation` | boolean | `false` | - | Applies a preset animation. Requires `enable_rigging` to be true. |
| `animation_action_id` | integer | `1001` | [Library IDs](https://docs.meshy.ai/en/api/animation-library) | The specific ID for the animation preset (e.g., walking, idle). |
| `enable_safety_checker` | boolean | `true` | - | Filters harmful or NSFW content. |

### Output
The API returns a JSON object containing URLs for multiple file formats and metadata:
- `model_glb`: Primary 3D model in GLB format.
- `model_urls`: A dictionary containing `glb`, `fbx`, `obj`, `usdz`, `blend`, and `stl` formats.
- `texture_urls`: An array of objects with keys for `base_color`, `metallic`, `normal`, and `roughness` map URLs.
- `thumbnail`: A preview image of the generated model.
- `animation_glb`/`animation_fbx`: Animated files if `enable_animation` was true.
- `rigged_character_glb`/`fbx`: Static rigged files if `enable_rigging` was true.

### Example request
```json
{
  "image_url": "https://example.com/character.png",
  "topology": "quad",
  "target_polycount": 50000,
  "enable_pbr": true,
  "enable_rigging": true,
  "pose_mode": "t-pose"
}
```

### Pricing
- **Cost:** $0.80 per generation on FAL.ai.
- **Billing unit:** Per successful generation. Note that long-running tasks are handled via the queue system.

## API — via Original Source (BYO-key direct)
Meshy offers a direct REST API for developers who wish to use their own Meshy API keys.
- **Base URL:** `https://api.meshy.ai/openapi/v1/`
- **Authentication:** Bearer Token (`Authorization: Bearer <YOUR_API_KEY>`).
- **Additional Native Parameters:**
    - `model_type`: Can be set to `lowpoly` for a simplified mesh (overrides `target_polycount`).
    - `decimation_mode`: Polycount levels (1: Ultra, 2: High, 3: Medium, 4: Low).
    - `image_enhancement`: Set to `true` (default) to optimize input images via AI vision.
    - `remove_lighting`: Set to `true` to de-light textures (delivers better results for game engines).
    - `target_formats`: An array where you can specify `3mf` (for multi-color 3D printing), which is not always listed in FAL's standard output object.
- **Direct Documentation:** [Meshy API Docs](https://docs.meshy.ai/en/api/image-to-3d)

## Prompting best practices
1. **Clear Silhouettes:** Use images with a clearly defined object against a plain, white, or simple background. Use the "Meshy background remover" tool if the original is too busy.
2. **Standard Perspectives:** Front-facing or three-quarter angle views work best. Extreme top-down or bottom-up views often confuse the geometry reconstruction.
3. **High Resolution:** Input images should ideally be at least 1040x1040px. Low-resolution or blurry images lead to "muddy" geometry and textures.
4. **Balanced Lighting:** Avoid images with heavy directional shadows or high-contrast glares. If the image has baked-in lighting, ensure `remove_lighting` (available via native API) is enabled to get clean PBR textures.
5. **Texture Guidance:** If the colors in your 2D image are complex, use the `texture_prompt` to specify materials (e.g., "weathered leather, polished steel, glowing runes").

## Parameter tuning guide
1. **`topology` (Quad vs Triangle):**
    - Choose **Quad** if you intend to bring the model into Blender for further sculpting or subdivision. Quads deform much better during animation.
    - Choose **Triangle** for static objects or if you need the highest raw detail for 3D printing.
2. **`target_polycount`:**
    - For mobile games/AR, target **10,000 - 15,000**.
    - For high-end PC rendering or close-up shots, target **50,000 - 100,000**.
    - Going above 100,000 significantly increases file size without always improving visual quality.
3. **`pose_mode`:**
    - Always set to `t-pose` or `a-pose` if you plan to use the `enable_rigging` feature. Rigging a character in a "natural" sitting or walking pose usually fails or produces distorted bones.
4. **`enable_pbr`:**
    - Keep this **On** if your target environment (Unreal Engine, Unity, WebGL) supports physical materials. It adds realism by making metal look metallic and rough surfaces look matte.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Image` (File or URL)
    - `Topology` (Dropdown: Quad, Triangle)
    - `Polycount` (Number)
    - `Texture Prompt` (Text)
    - `Rigging Toggle` (Boolean)
- **Outputs:**
    - `GLB File` (3D Model)
    - `USDZ File` (For iOS AR)
    - `PBR Texture Maps` (Collection of Images)
    - `Thumbnail` (Image)
- **Chain-friendly with:**
    - **Remove Background (e.g., `fal-ai/image-background-remover`):** Essential preprocessing step for better 3D isolation.
    - **Upscaler (e.g., `fal-ai/esrgan`):** To prepare low-res source images before 3D generation.
    - **Flux-1 / Stable Diffusion:** To generate the initial 2D character concept that Meshy then converts to 3D.

## Notes & gotchas
- **Processing Time:** This is a "heavy" model. Expect 5-10 minutes for a full texture and rigging pass. Always use `queue` mode for production apps.
- **Humanoid Only:** The rigging and animation features are strictly for **humanoid** characters (two arms, two legs, head). They will not work on animals, vehicles, or furniture.
- **Rate Limits:** Direct Meshy API has specific rate limits based on your tier. FAL.ai provides a more scalable gateway but monitors for abuse.
- **Scale:** The `auto_size` feature (native API) estimates height using AI vision. If accuracy is critical, you should manually scale the model in your 3D app.

## Sources
- [FAL.ai Meshy-6 Documentation](https://fal.ai/models/fal-ai/meshy/v6/image-to-3d/api)
- [Official Meshy API Reference](https://docs.meshy.ai/en/api/image-to-3d)
- [Meshy Pricing and Credit Guide](https://docs.meshy.ai/en/api/pricing)
- [Meshy Help Center: Image to 3D Best Practices](https://help.meshy.ai/en/articles/9996860-how-to-use-the-image-to-3d-feature)
