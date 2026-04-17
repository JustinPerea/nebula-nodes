---
name: fal-ai/trellis
display_name: Trellis
category: image-to-3d
creator: Microsoft Research
fal_docs: https://fal.ai/models/fal-ai/trellis
original_source: https://github.com/microsoft/TRELLIS
summary: State-of-the-art image-to-3D model by Microsoft Research using Structured LATents (SLAT) for high-fidelity assets.
---

# Trellis

## Overview
- **Slug:** `fal-ai/trellis`
- **Category:** Image-to-3D
- **Creator:** [Microsoft Research](https://github.com/microsoft/TRELLIS)
- **Best for:** Generating high-fidelity, textured 3D meshes from a single 2D image.
- **FAL docs:** [fal.ai/models/fal-ai/trellis](https://fal.ai/models/fal-ai/trellis)
- **Original source:** [GitHub - microsoft/TRELLIS](https://github.com/microsoft/TRELLIS)

## What it does
Trellis is a powerful 3D generative model designed for high-quality 3D asset creation from images ([FAL.ai](https://fal.ai/models/fal-ai/trellis)). It utilizes a novel **Structured LATent (SLAT)** representation and Rectified Flow Transformers to generate 3D assets that maintain intricate geometric structures and rich textures ([Microsoft Research](https://github.com/microsoft/TRELLIS)). The model is trained on a massive dataset of 500,000 diverse 3D objects and supports multiple output formats, including meshes (GLB), 3D Gaussians, and Radiance Fields ([Azure AI Foundry Labs](https://labs.ai.azure.com/projects/trellis/)).

## When to use this model
- **Use when:** You need to rapidly create 3D assets for games, AR/VR experiences, or product visualizations from concept art or single photographs ([Azure AI Foundry Labs](https://labs.ai.azure.com/projects/trellis/)).
- **Don't use when:** You require precise engineering CAD models or the input image is highly cluttered with multiple overlapping objects.
- **Alternatives:**
    - `fal-ai/tripo-sr`: Better for ultra-fast, lower-detail generation.
    - `fal-ai/stable-video-3d`: Useful if you need a 360-degree video representation before mesh extraction.
    - `fal-ai/trellis-2`: The successor model with 4 billion parameters for even higher fidelity ([3D Ai Studio](https://www.3daistudio.com/Models/Trellis-2)).

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/trellis` (sync) / `https://queue.fal.run/fal-ai/trellis` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | string | *Required* | URL | The URL of the input image to convert to 3D. |
| `seed` | integer | null | Any integer | Random seed for reproducibility. |
| `ss_guidance_strength` | float | 7.5 | 0 to 10 | Guidance strength for sparse structure generation. |
| `ss_sampling_steps` | integer | 12 | 1 to 50 | Number of sampling steps for the sparse structure. |
| `slat_guidance_strength` | float | 3.0 | 0 to 10 | Guidance strength for structured latent (SLAT) generation. |
| `slat_sampling_steps` | integer | 12 | 1 to 50 | Number of sampling steps for the structured latent. |
| `mesh_simplify` | float | 0.95 | 0 to 1 | Factor for simplifying the final mesh (0.95 = 95% original density). |
| `texture_size` | enum | 1024 | `512`, `1024`, `2048` | Resolution of the generated texture map. |

*Note: The API also supports a `multi_image` mode via `image_urls` (list of strings) and `multiimage_algo` (`stochastic` or `multidiffusion`).*

### Output
The model returns a JSON object containing the 3D model file and performance metadata:
- `model_mesh`: A [File](https://fal.ai/models/fal-ai/trellis/api#type-File) object containing the `url` to the generated `.glb` file.
- `timings`: A [Timings](https://fal.ai/models/fal-ai/trellis/api#type-Timings) object detailing processing duration.

### Example request
```json
{
  "image_url": "https://storage.googleapis.com/falserverless/web-examples/rodin3d/warriorwoman.png",
  "texture_size": 1024,
  "mesh_simplify": 0.95,
  "seed": 42
}
```

### Pricing
$0.02 per unit (per successful inference call) ([FAL.ai Playground](https://fal.ai/models/fal-ai/trellis/playground)).

## API — via Original Source (BYO-key direct)
FAL.ai is the primary cloud API surface for Trellis. Microsoft Research provides the model as open-source code on [GitHub](https://github.com/microsoft/TRELLIS) under the Apache 2.0 license, allowing for local deployment and hosting without a separate first-party API key ([PiAPI](https://piapi.ai/trellis-3d-api)).

## Prompting best practices
- **Lighting:** Use clear, well-lit images with neutral lighting to avoid baked-in shadows in the 3D texture ([FAL.ai Docs](https://fal.ai/models/fal-ai/trellis/playground)).
- **Subject Clarity:** Ensure the subject is centered and the entire object is visible within the frame. Occluded parts may result in "hallucinated" or blurred geometry.
- **Backgrounds:** Use images with clean or solid backgrounds for the best extraction results. Avoid cluttered backgrounds that might confuse the model about the object's boundaries.
- **Supported Formats:** JPG, JPEG, PNG, WebP, GIF, and AVIF are all supported ([FAL.ai Playground](https://fal.ai/models/fal-ai/trellis/playground)).

## Parameter tuning guide
- **`ss_guidance_strength`**: Higher values (8-10) increase adherence to the input image structure but may introduce artifacts. Lower values (4-6) allow for smoother, more generalized shapes.
- **`slat_guidance_strength`**: Controls the detail level of the latent representation. Increasing this can bring out finer surface details and sharper edges.
- **`mesh_simplify`**: If the resulting `.glb` file is too large for your application (e.g., mobile web), decrease this value to reduce the polygon count.
- **`texture_size`**: Use `2048` for high-resolution close-ups, or `512` for background assets to save memory.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `Image` (Image URL or File)
  - `Seed` (Integer)
  - `Quality Settings` (Guidance strengths and sampling steps)
  - `Mesh Simplify` (Float)
- **Outputs:**
  - `3D Mesh` (GLB file)
- **Chain-friendly with:**
  - `fal-ai/flux-pro`: Generate the source image prompt first, then feed to Trellis.
  - `fal-ai/image-background-remover`: Clean up input images before 3D generation.
  - `fal-ai/model-to-video`: Render the generated GLB into a 360-degree preview video.

## Notes & gotchas
- **Commercial Use:** Assets generated via the Apache 2.0 licensed Trellis model are generally available for commercial use ([PiAPI](https://piapi.ai/trellis-3d-api)).
- **Processing Time:** Generation typically takes between 1 to 3 minutes depending on complexity and queue depth ([3D Ai Studio](https://www.3daistudio.com/Models/Trellis-2)).
- **Topology:** While highly capable, the model may struggle with extremely thin or transparent structures (like wire meshes or glass).

## Sources
- [FAL.ai Trellis Model Page](https://fal.ai/models/fal-ai/trellis)
- [FAL.ai API Reference](https://fal.ai/models/fal-ai/trellis/api)
- [Microsoft Research TRELLIS GitHub](https://github.com/microsoft/TRELLIS)
- [Structured 3D Latents for Scalable and Versatile 3D Generation (Research Paper)](https://arxiv.org/abs/2412.01906)
- [Azure AI Foundry Labs - Trellis Project](https://labs.ai.azure.com/projects/trellis/)