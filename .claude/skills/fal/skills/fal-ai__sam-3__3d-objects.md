---
name: fal-ai/sam-3/3d-objects
display_name: SAM 3D: Single-Image 3D Object Reconstruction
category: image-to-3d
creator: Meta AI (facebookresearch)
fal_docs: https://fal.ai/models/fal-ai/sam-3/3d-objects
original_source: https://github.com/facebookresearch/sam-3d-objects
summary: High-fidelity single-image 3D object reconstruction producing both GLB meshes and Gaussian splats.
---

# SAM 3D: Single-Image 3D Object Reconstruction

## Overview
- **Slug:** `fal-ai/sam-3/3d-objects`
- **Category:** Image-to-3D
- **Creator:** [Meta AI](https://ai.meta.com/blog/sam-3d/)
- **Best for:** Creating photorealistic 3D models and Gaussian splats from standard 2D photographs.
- **FAL docs:** [fal.ai/models/fal-ai/sam-3/3d-objects](https://fal.ai/models/fal-ai/sam-3/3d-objects)
- **Original source:** [GitHub (facebookresearch/sam-3d-objects)](https://github.com/facebookresearch/sam-3d-objects), [arXiv Paper](https://arxiv.org/abs/2511.16624)

## What it does
SAM 3D Objects is a generative foundation model that reconstructs the full 3D geometry, texture, and spatial layout of one or more objects from a single RGB image. Unlike traditional photogrammetry which requires multiple views, SAM 3D leverages the "Segment Anything" (SAM) paradigm to isolate objects and predict their hidden surfaces and volumetric structure. It outputs both traditional polygon meshes (GLB) and high-fidelity point-based neural renderings (Gaussian Splats), making it suitable for both game engines and web-based photorealistic viewers.

## When to use this model
- **Use when:** You need to turn a single photo of a product, furniture, or real-world object into a 3D asset for AR/VR, e-commerce, or digital twins.
- **Don't use when:** You need extremely precise CAD-level measurements or when the object is almost entirely occluded by other foreground elements.
- **Alternatives:** 
    - [SAM 3D Body](https://fal.ai/models/fal-ai/sam-3/3d-body): Specialized specifically for human anatomical reconstruction.
    - [Tripo3D](https://fal.ai/models/fal-ai/tripo-3d): Better for stylized, "clean" 3D assets from prompts or isolated images.
    - [Hunyuan3D v2](https://fal.ai/models/fal-ai/hunyuan-3d-v2): Optimized for general-purpose 3D asset creation with high geometric complexity.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/sam-3/3d-objects` (sync) / `https://queue.fal.run/fal-ai/sam-3/3d-objects` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | string | *required* | URL | The URL of the input image containing the object(s) to reconstruct. |
| `mask_urls` | list<string> | `[]` | List of URLs | Optional list of binary masks. Each mask identifies one object to be reconstructed. |
| `prompt` | string | `""` | Text | Text prompt for auto-segmentation (e.g., 'chair', 'vintage car') if masks are not provided. |
| `point_prompts` | list<object> | `[]` | `[{x, y, label, object_id}]` | Interactive points to guide segmentation. Label 1 for foreground, 0 for background. |
| `box_prompts` | list<object> | `[]` | `[{x_min, y_min, x_max, y_max, object_id}]` | Bounding boxes to specify object regions for reconstruction. |
| `seed` | integer | random | 0 - 2^32 | Random seed for reproducible generation. |
| `pointmap_url` | string | `null` | URL | Optional URL to external depth data (NPY/NPZ) to improve reconstruction accuracy. |
| `detection_threshold` | float | `0.5` | 0.1 - 1.0 | Confidence threshold for object detection. Lower values detect more objects but may be less accurate. |
| `export_textured_glb` | boolean | `false` | true/false | If true, exports the GLB with a baked texture map and UVs rather than vertex colors. |

### Output
The API returns a JSON object containing links to the generated 3D files:
- **`gaussian_splat`**: A `.ply` file containing the combined Gaussian Splat representation.
- **`model_glb`**: A `.glb` file containing the 3D mesh (useful for Three.js, Unity, etc.).
- **`metadata`**: A list of object metadata including rotation, translation, and scale relative to the camera.
- **`individual_splats` / `individual_glbs`**: Lists of files for each distinct object reconstructed from the scene.
- **`artifacts_zip`**: A comprehensive bundle of all generated outputs.

### Example request
```json
{
  "image_url": "https://storage.googleapis.com/fals-media/samples/car.jpg",
  "prompt": "vintage sports car",
  "export_textured_glb": true
}
```

### Pricing
- **Cost per generation:** $0.02
- Approximately **50 generations per $1.00** on fal.ai.

## API — via Original Source (BYO-key direct)
FAL.ai is the primary managed API surface for SAM 3D. While the weights and code are open-source on [GitHub](https://github.com/facebookresearch/sam-3d-objects), Meta does not provide a hosted direct-access API for individual developers to use with a "BYO-key" outside of their research demos or third-party providers like FAL. To use natively, you must self-host the model on GPU infrastructure (A100/H100 recommended).

## Prompting best practices
- **Be Specific:** Use descriptive adjectives. Instead of "chair," use "mid-century modern wooden chair" to help the model disambiguate from the background.
- **Isolate the Object:** If the scene is cluttered, use **Box Prompts** to draw a tight boundary around the target object.
- **Image Quality:** Use images with a minimum resolution of 512px on the shortest side. 1024px+ is recommended for capturing fine textures.
- **Lighting:** Avoid extreme shadows or reflections, as the model may interpret them as geometric features.
- **Good Prompt:** "A detailed ceramic vase with blue patterns on a white table."
- **Bad Prompt:** "Vase" (too generic in a room full of objects).

## Parameter tuning guide
- **`export_textured_glb`**: Always set to `true` if you intend to use the model in standard 3D software (Blender, Unity) that relies on UV mapping rather than vertex colors.
- **`detection_threshold`**: If the model is missing your object, lower this to `0.3`. If it's picking up background "ghost" objects, raise it to `0.7`.
- **`seed`**: If the geometry looks slightly "melted" or distorted, try a different seed to get a fresh flow-transformer initialization.

## Node inputs/outputs
- **Inputs:**
  - `Image` (Image/URL)
  - `Prompt` (String)
  - `Masks` (List of Images)
  - `Settings` (Threshold, Seed, Export Type)
- **Outputs:**
  - `Mesh` (GLB File)
  - `Splat` (PLY File)
  - `Metadata` (JSON)
- **Chain-friendly with:**
  - `fal-ai/sam-3/3d-align`: Use this to combine the output of `3d-objects` and `3d-body` into a single, correctly scaled scene.
  - `fal-ai/flux/dev`: Generate a high-quality 2D image first, then pass it to SAM 3D for a full 2D-to-3D workflow.

## Notes & gotchas
- **File Sizes:** Gaussian splat files can be large (50MB+). Ensure your application can handle high-bandwidth 3D assets.
- **Processing Time:** Usually takes 4-8 seconds. Use the `queue` mode for a better user experience in web apps.
- **License:** Commercial use is permitted under Meta's SAM 3 license, but you must include a copy of the license with any distribution.

## Sources
- [FAL.ai SAM 3D Objects Documentation](https://fal.ai/models/fal-ai/sam-3/3d-objects)
- [Meta AI Blog: Introducing SAM 3D](https://ai.meta.com/blog/sam-3d/)
- [SAM 3D Research Paper (arXiv:2511.16624)](https://arxiv.org/abs/2511.16624)
- [Official GitHub Repository](https://github.com/facebookresearch/sam-3d-objects)
