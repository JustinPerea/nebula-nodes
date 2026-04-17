---
name: fal-ai/triposr
display_name: TripoSR
category: image-to-3d
creator: Stability AI & Tripo AI
fal_docs: https://fal.ai/models/fal-ai/triposr
original_source: https://github.com/VAST-AI-Research/TripoSR, https://platform.tripo3d.ai/docs/introduction
summary: A high-speed feed-forward model that generates 3D meshes from single images in under 0.5 seconds.
---

# TripoSR

## Overview
- **Slug:** `fal-ai/triposr`
- **Category:** Image-to-3D
- **Creator:** [Stability AI](https://stability.ai/) & [Tripo AI](https://www.tripo3d.ai/)
- **Best for:** Rapid prototyping of 3D assets from single 2D images.
- **FAL docs:** [fal-ai/triposr](https://fal.ai/models/fal-ai/triposr)
- **Original source:** [GitHub Repository](https://github.com/VAST-AI-Research/TripoSR), [HuggingFace Model Card](https://huggingface.co/stabilityai/TripoSR)

## What it does
TripoSR is a state-of-the-art feed-forward 3D reconstruction model capable of generating high-quality 3D meshes from a single RGB image in under 0.5 seconds ([Stability AI](https://stability.ai/news-updates/triposr-3d-generation)). It leverages a Large Reconstruction Model (LRM) architecture, optimized for speed and efficiency, making it significantly faster than traditional photogrammetry or optimization-based AI methods ([GitHub](https://github.com/VAST-AI-Research/TripoSR)). While it prioritizes speed, it produces production-ready GLB or OBJ files suitable for gaming, AR/VR, and industrial design previews ([fal.ai](https://fal.ai/models/fal-ai/triposr)).

## When to use this model
- **Use when:** You need near-instant 3D previews for concept art, rapid asset iteration in game development, or automated 3D product visualization.
- **Don't use when:** You require high-fidelity textures, complex part-based segmentation, or precise geometric accuracy for manufacturing.
- **Alternatives:** 
    - [Tripo3D v2.5](https://fal.ai/models/tripo3d/tripo/v2.5/image-to-3d): Offers higher fidelity and better texture quality but at slightly different cost and processing trade-offs.
    - [Rodin](https://fal.ai/models/fal-ai/rodin): Better for high-detail character generation if available.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/triposr` (Synchronous) / `https://queue.fal.run/fal-ai/triposr` (Asynchronous/Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | string | (required) | Valid URL | The URL of the image to be processed into a 3D model. Supports JPEG, PNG, WebP, GIF, AVIF. |
| `output_format` | enum | `glb` | `glb`, `obj` | The file format of the generated 3D model. |
| `do_remove_background` | boolean | `true` | `true`, `false` | Whether to automatically remove the background from the input image before processing. |
| `foreground_ratio` | float | `0.9` | 0.5 - 1.0 | Ratio of the foreground object to the original image area. Higher values scale the object larger. |
| `mc_resolution` | integer | `256` | 32 - 1024 | Marching Cubes resolution. Higher values increase mesh density but take longer. Above 512 is not recommended. |

### Output
The output JSON contains:
- `model_mesh`: A file object containing the `url`, `content_type`, `file_name`, and `file_size` (bytes) of the generated 3D model.
- `timings`: Detailed inference timing data.
- `remeshing_dir`: (Optional) A directory containing textures for remeshed models if applicable.

### Example request
```json
{
  "image_url": "https://raw.githubusercontent.com/VAST-AI-Research/TripoSR/main/examples/hamburger.png",
  "output_format": "glb",
  "do_remove_background": true,
  "foreground_ratio": 0.9,
  "mc_resolution": 256
}
```

### Pricing
- **Cost:** $0.07 per generation ([fal.ai](https://fal.ai/models/fal-ai/triposr)).

### Features
- **Queue Mode:** Supported via the `/queue` endpoint.
- **Webhooks:** Supported by providing a `webhookUrl` in the queue submission request.
- **Streaming:** Not supported (returns complete files).

## API — via Original Source (BYO-key direct)
The original creator, Tripo AI, provides a direct API with expanded capabilities beyond the TripoSR model specifically.
- **Endpoint:** `https://api.tripo3d.ai/v2/openapi/task`
- **Auth:** Bearer Token (`TRIPO_API_KEY`).
- **Additional Parameters:** The native API supports `text_to_model`, `multiview_to_model`, and advanced features like `smart_low_poly`, `quad` mesh output, PBR textures, and animation ([Tripo AI Docs](https://platform.tripo3d.ai/docs/generation)).
- **Direct Docs:** [Tripo AI Platform Documentation](https://platform.tripo3d.ai/docs/introduction)

## Prompting best practices
Since TripoSR is image-to-3D, "prompting" refers to the quality of the input image:
- **Use clear silhouettes:** Objects with distinct, non-overlapping parts work best.
- **High contrast:** Ensure the object is well-lit and contrasts sharply with the background if not using auto-background removal.
- **Single Object:** Avoid images with multiple distinct objects; the model works best on a single focused subject.
- **Center the Subject:** Keep the main object centered in the frame to prevent distortion or clipping.
- **Avoid occlusion:** Parts of the object hidden from the camera view will be "hallucinated" by the model, which may lead to artifacts.

## Parameter tuning guide
- **`mc_resolution`**: Set to `256` for quick previews. If the model looks "blocky," increase to `512`. Only use `1024` for final exports where high polygon count is needed for sculpting.
- **`foreground_ratio`**: If the object appears too small or cut off in the 3D space, adjust the ratio. `0.9` is generally safe, but `0.7` can help if the object is very thin.
- **`do_remove_background`**: Always leave `true` unless you have pre-masked the image (alpha channel PNG), as background noise significantly degrades 3D reconstruction.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Image` (URL/File)
  - `Format` (Dropdown: GLB, OBJ)
  - `Remove Background` (Switch)
  - `MC Resolution` (Slider: 32-1024)
- **Outputs:**
  - `3D Mesh` (File/URL)
  - `Inference Logs` (Text)
- **Chain-friendly with:**
  - [Flux 2](https://fal.ai/models/fal-ai/flux-2-flex): Generate the source image via text-to-image first.
  - [Background Removal](https://fal.ai/models/fal-ai/bria/background-removal): For manual control over the alpha mask before 3D processing.

## Notes & gotchas
- **Complexity:** Highly complex or transparent objects (like glass or fine wire meshes) often fail or produce "blobs."
- **Symmetry:** The model assumes a degree of symmetry for the "back" of the object based on its training data.
- **Commercial Use:** TripoSR is released under the MIT license, allowing for commercial use ([GitHub](https://github.com/VAST-AI-Research/TripoSR)).

## Sources
- [FAL.ai Triposr API Docs](https://fal.ai/models/fal-ai/triposr/api)
- [Stability AI TripoSR Announcement](https://stability.ai/news-updates/triposr-3d-generation)
- [Tripo AI API Platform](https://platform.tripo3d.ai/docs/introduction)
- [TripoSR GitHub Repository](https://github.com/VAST-AI-Research/TripoSR)