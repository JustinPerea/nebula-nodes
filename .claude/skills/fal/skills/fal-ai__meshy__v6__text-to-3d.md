---
name: fal-ai/meshy/v6/text-to-3d
display_name: Meshy-6 Text to 3D
category: image-to-3d
creator: Meshy (Meshy.ai)
fal_docs: https://fal.ai/models/fal-ai/meshy/v6/text-to-3d
original_source: https://docs.meshy.ai/api/text-to-3d
summary: A state-of-the-art AI model that converts text descriptions into high-quality, production-ready 3D models with PBR textures and auto-rigging capabilities.
---

# Meshy-6 Text to 3D

## Overview
- **Slug:** `fal-ai/meshy/v6/text-to-3d`
- **Category:** 3D Generation
- **Creator:** [Meshy (Meshy.ai)](https://www.meshy.ai/)
- **Best for:** Rapidly generating game-ready 3D assets with high-fidelity textures and automatic humanoid rigging.
- **FAL docs:** [fal-ai/meshy/v6/text-to-3d](https://fal.ai/models/fal-ai/meshy/v6/text-to-3d)
- **Original source:** [Meshy API Documentation](https://docs.meshy.ai/api/text-to-3d)

## What it does
Meshy-6 is a generative 3D model that transforms natural language descriptions into detailed 3D assets. It supports two distinct stages: a fast **preview mode** for geometry evaluation and a **full mode** that generates high-resolution PBR textures. Beyond simple modeling, it features built-in **humanoid rigging** and access to a library of over 500 animations, making it a comprehensive tool for character creation ([Meshy Docs](https://docs.meshy.ai/api/text-to-3d)).

## When to use this model
- **Use when:**
    - You need rapid prototyping of 3D objects or characters for games and AR/VR.
    - You require production-ready outputs with metallic, roughness, and normal maps (PBR).
    - You want to generate humanoid characters that are already rigged and ready for animation.
- **Don't use when:**
    - You need extremely high-fidelity architectural CAD models for manufacturing.
    - You are generating non-humanoid creatures (e.g., quadrupeds) and expect auto-rigging to work perfectly.
- **Alternatives:**
    - `fal-ai/meshy/v6/image-to-3d`: Better if you already have a 2D concept or reference image.
    - `fal-ai/tripo-3d`: A fast alternative often used for simpler objects.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/meshy/v6/text-to-3d` (sync) / `https://queue.fal.run/fal-ai/meshy/v6/text-to-3d` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | - | 1-600 chars | Description of the 3D model. |
| `mode` | string | `preview` | `preview`, `full` | `preview`: geometry only; `full`: textured model. |
| `art_style` | string | `realistic` | `realistic`, `sculpture` | Style of the object. Note: Meshy-6 primarily supports `realistic`. |
| `seed` | integer | - | - | For reproducible results. |
| `topology` | string | - | `quad`, `triangle` | `quad` for smooth surfaces; `triangle` for detail. |
| `target_polycount` | integer | `30000` | - | Target number of polygons. |
| `should_remesh` | boolean | `true` | - | Whether to enable the remesh phase for cleaner geometry. |
| `symmetry_mode` | string | `auto` | `off`, `auto`, `on` | Controls symmetry during generation. |
| `enable_pbr` | boolean | `false` | - | Generate metallic, roughness, and normal maps. |
| `pose_mode` | string | - | `a-pose`, `t-pose` | Pose for character models. |
| `enable_prompt_expansion` | boolean | `false` | - | Uses an LLM to enrich the input prompt. |
| `texture_prompt` | string | - | - | Optional guide for texturing in `full` mode. |
| `texture_image_url` | string | - | - | Optional 2D image guide for texturing. |
| `enable_rigging` | boolean | `false` | - | Automatically rig humanoid characters. |
| `rigging_height_meters` | float | `1.7` | > 0 | Approximate character height. |
| `enable_animation` | boolean | `false` | - | Apply an animation (requires `enable_rigging`). |
| `animation_action_id` | integer | `1001` | [Library](https://docs.meshy.ai/en/api/animation-library) | ID for a specific animation action. |
| `enable_safety_checker` | boolean | `true` | - | Filters input for safety policy compliance. |

### Output
The output returns a JSON object containing URLs to the generated assets:
- `model_glb`: Primary 3D model file.
- `model_urls`: A map of formats including `fbx`, `obj`, `usdz`, `blend`, and `stl`.
- `texture_urls`: Array containing `base_color`, `metallic`, `normal`, and `roughness` map URLs.
- `thumbnail`: A preview image of the model.
- `animation_glb`/`fbx`: Animated files if animation was enabled.
- `rigged_character_glb`/`fbx`: Static rigged model.
- `basic_animations`: Pre-set walking/running animations.

### Example request
```json
{
  "prompt": "a highly detailed sci-fi warrior in power armor, obsidian and gold finish",
  "mode": "full",
  "art_style": "realistic",
  "enable_pbr": true,
  "topology": "quad",
  "enable_rigging": true,
  "pose_mode": "t-pose"
}
```

### Pricing
- **Preview Mode:** 20 credits per request ([FAL API](https://fal.ai/models/fal-ai/meshy/v6/text-to-3d/api)).
- **Full Mode:** 30 credits per request ([FAL API](https://fal.ai/models/fal-ai/meshy/v6/text-to-3d/api)).
*FAL credits are typically billed at approximately $0.01 per credit.*

## API — via Original Source (BYO-key direct)
Meshy provides a direct REST API for developers.
- **Endpoint:** `https://api.meshy.ai/openapi/v2/text-to-3d`
- **Auth:** Bearer Token (`Authorization: Bearer <API_KEY>`)
- **Key Difference:** Meshy's native API treats Preview and Refine (Texture) as two separate steps. You create a preview task, wait for success, and then submit a "refine" request using the `preview_task_id`. It also supports Server-Sent Events (SSE) for real-time status updates at `/stream` ([Meshy Docs](https://docs.meshy.ai/api/text-to-3d)).

## Prompting best practices
- **The "Subject-Modifier-Style" Formula:** Start with the core object, add material properties, and end with the art style. 
    - *Example:* "A medieval castle (Subject), weathered stone and moss-covered walls (Modifiers), photorealistic (Style)."
- **Avoid Ambiguity:** Instead of "cool sword," use "a glowing blue crystalline longsword with a silver hilt."
- **Reference Real Materials:** Keywords like `polished brass`, `oxidized copper`, or `hand-painted wood` help the PBR system generate accurate maps ([Meshy Blog](https://www.meshy.ai/blog/how-to-write-better-prompts-for-meshy-a-guide-for-beginners)).
- **Single Object Focus:** Meshy performs best on single objects or characters. Do not try to prompt entire scenes or landscapes ([Meshy Help Center](https://help.meshy.ai/en/articles/11972484-best-practices-for-creating-a-text-prompt)).
- **Negative Prompting:** While `negative_prompt` is deprecated in some versions, you can exclude unwanted features in your main prompt by specifying what the object is *not* (e.g., "clean, no rust").

## Parameter tuning guide
1. **Mode (`preview` vs `full`):** Always run a `preview` first to verify the geometry shape. Once satisfied, use `full` with the same seed or use the direct refine workflow to add textures.
2. **Topology (`quad` vs `triangle`):** Use `quad` if you plan to sculpt or subdivide the model further in software like Blender. Use `triangle` for the most accurate capture of fine, sharp details.
3. **Polycount:** Higher polycounts (up to 300,000 in native) increase detail but also file size and rendering cost. 30,000 is the standard sweet spot for real-time applications ([Meshy Docs](https://docs.meshy.ai/en/api/pricing)).
4. **Pose Mode:** For characters meant for rigging, **always** specify `t-pose` or `a-pose`. This ensures the auto-rigger can identify limbs correctly ([Meshy Help Center](https://help.meshy.ai/en/articles/11972484-best-practices-for-creating-a-text-prompt)).

## Node inputs/outputs
- **Inputs:**
    - `Prompt` (String)
    - `Mode` (Dropdown: Preview, Full)
    - `Texture Guidance Image` (Image/URL)
    - `Animation Action ID` (Integer)
- **Outputs:**
    - `GLB File` (3D Model)
    - `PBR Textures` (Image Pack: Base, Metal, Normal, Rough)
    - `Preview Video/Thumbnail` (Image/Video)
    - `Rigged Asset` (3D Model)
- **Chain-friendly with:**
    - `fal-ai/flux/dev`: Generate 2D concept art first, then pass to `image-to-3d`.
    - `fal-ai/meshy/retexture`: Take the generated 3D model and apply new textures without changing geometry.

## Notes & gotchas
- **Humanoid Only Rigging:** The auto-rigging and animation library currently only supports bipedal, humanoid structures. Quadruped or multi-limb rigging is not supported ([Meshy Docs](https://docs.meshy.ai/api/rigging-and-animation)).
- **Resolution Limits:** Textures are typically generated at 1K or 2K resolution depending on the refinement tier.
- **Character Limit:** Prompts are strictly capped at 600 characters ([FAL API](https://fal.ai/models/fal-ai/meshy/v6/text-to-3d/api)).

## Sources
- [FAL.ai Meshy-6 API Docs](https://fal.ai/models/fal-ai/meshy/v6/text-to-3d/api)
- [Meshy Official API Quickstart](https://docs.meshy.ai/api/quick-start)
- [Meshy Pricing and Credit Guide](https://docs.meshy.ai/en/api/pricing)
- [Meshy Prompting Guide](https://www.meshy.ai/blog/how-to-write-better-prompts-for-meshy-a-guide-for-beginners)
- [Meshy Rigging & Animation Reference](https://docs.meshy.ai/api/rigging-and-animation)
