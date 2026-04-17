---
name: fal-ai/seedvr/upscale/image
display_name: SeedVR2 Image Upscale
category: upscaling
creator: ByteDance Seed
fal_docs: https://fal.ai/models/fal-ai/seedvr/upscale/image
original_source: https://github.com/ByteDance-Seed/SeedVR, https://iceclear.github.io/projects/seedvr2/
summary: A high-performance one-step diffusion-based upscaler by ByteDance that enhances image resolution up to 10K with exceptional speed and detail preservation.
---

# SeedVR2 Image Upscale

## Overview
- **Slug:** `fal-ai/seedvr/upscale/image`
- **Category:** Image Restoration / Upscaling
- **Creator:** [ByteDance Seed](https://github.com/ByteDance-Seed/SeedVR)
- **Best for:** High-speed, high-fidelity upscaling of images up to 10K resolution.
- **FAL docs:** [fal.ai/models/fal-ai/seedvr/upscale/image](https://fal.ai/models/fal-ai/seedvr/upscale/image)
- **Original source:** [SeedVR2 Project Page](https://iceclear.github.io/projects/seedvr2/), [GitHub](https://github.com/ByteDance-Seed/SeedVR)

## What it does
SeedVR2 is a state-of-the-art restoration model that utilizes a one-step diffusion process to upscale images while intelligently restoring lost details and removing artifacts. Unlike traditional upscalers that may produce "plastic" or overly smoothed textures, SeedVR2 leverages a 16B parameter GAN-based diffusion transformer to maintain structural integrity and natural sharpness. It is particularly effective at handling high-resolution outputs (up to 10K) that were previously computationally prohibitive for multi-step diffusion models.

## When to use this model
- **Use when:** You need to upscale low-resolution images to 4K or 8K for print or high-res displays, or when you need to process large batches of images quickly without sacrificing detail.
- **Don't use when:** You require pixel-perfect medical or forensic accuracy where AI hallucination of detail (even minimal) is unacceptable.
- **Alternatives:** 
    - **AuraSR:** Better for preserving extreme photographic realism but restricted to smaller output sizes.
    - **ESRGAN:** Faster and cheaper but lacks the sophisticated generative detail of diffusion-based models.
    - **SUPIR:** Offers more control via text prompts but is significantly slower and more expensive.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/seedvr/upscale/image` (sync) / `https://queue.fal.run/fal-ai/seedvr/upscale/image` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | `string` | - | - | **Required.** The URL of the input image to be processed. |
| `upscale_mode` | `enum` | `factor` | `target`, `factor` | Determines if the upscale is based on a multiplier or a fixed resolution. |
| `upscale_factor` | `float` | `2` | `1.0` - `10.0` | Multiplies dimensions by this factor when `upscale_mode` is `factor`. |
| `target_resolution` | `enum` | `1080p` | `720p`, `1080p`, `1440p`, `2160p` | Target resolution when `upscale_mode` is `target`. |
| `seed` | `integer` | - | - | Random seed for reproducible generation. |
| `noise_scale` | `float` | `0.1` | `0.0` - `1.0` | Controls the amount of noise added during the restoration process. Higher values can add more texture but may diverge from the source. |
| `output_format` | `enum` | `jpg` | `png`, `jpg`, `webp` | The file format of the generated image. |
| `sync_mode` | `boolean` | `false` | `true`, `false` | If `true`, returns the image as a data URI and bypasses request history. |

### Output
The output is a JSON object containing the upscaled image metadata and the seed used.
```json
{
  "image": {
    "url": "https://fal.run/storage/...",
    "content_type": "image/png",
    "file_name": "upscaled.png",
    "file_size": 2048576,
    "width": 3840,
    "height": 2160
  },
  "seed": 12345
}
```

### Example request
```json
{
  "image_url": "https://example.com/input.jpg",
  "upscale_mode": "factor",
  "upscale_factor": 4,
  "noise_scale": 0.15,
  "output_format": "png"
}
```

### Pricing
SeedVR2 on FAL.ai is billed based on output resolution at approximately **$0.001 per megapixel**. For example, a 4K (8.3MP) upscale costs roughly **$0.0083**.

## API — via Original Source (BYO-key direct)
ByteDance has released the weights and inference code under the **Apache 2.0 license**. While there is no official "ByteDance API" for public consumption, the model can be hosted on private infrastructure.
- **Endpoint:** Custom (Self-hosted)
- **Auth method:** None (Local)
- **Official Repo:** [ByteDance-Seed/SeedVR](https://github.com/ByteDance-Seed/SeedVR)
- **Technical Note:** Native inference supports multi-GPU sequence parallelism to handle extremely large resolutions (e.g., 4x H100s for 4K video frames).

## Prompting best practices
SeedVR2 Image Upscale is a non-conditioned restoration model, meaning it does **not** take a text prompt input. Instead, performance is optimized through image quality and parameter tuning:
- **Clean Inputs:** While it removes artifacts, providing an input image with minimal compression will yield much better "natural" results.
- **Aspect Ratios:** The model handles arbitrary aspect ratios, but ensure the input dimensions are multiples of 32 for optimal performance and to avoid cropping.
- **Transparency:** SeedVR2 supports alpha channels; for transparent PNGs, ensure `output_format` is set to `png` to preserve the background.

## Parameter tuning guide
- **`noise_scale` (The Sweet Spot):** 
    - **0.05 - 0.10:** Best for preserving the original look of photos.
    - **0.20 - 0.40:** Use for heavily compressed or blurry images where the model needs to "re-invent" texture.
    - **> 0.50:** May introduce unwanted AI-generated artifacts.
- **`upscale_factor` vs `target_resolution`:** 
    - Use `target_resolution` for standard displays (e.g., upscaling a random photo for a 4K monitor).
    - Use `upscale_factor` when you need specific scaling for design workflows (e.g., making a 512px icon exactly 2048px).

## Node inputs/outputs
- **Inputs:**
    - `Image` (Image URL/File)
    - `Upscale Mode` (Dropdown)
    - `Scale Factor` (Float)
    - `Noise Scale` (Float)
- **Outputs:**
    - `Upscaled Image` (Image URL)
    - `Seed` (Integer)
- **Chain-friendly with:**
    - **Flux.1 [dev]:** Use SeedVR2 to upscale low-res Flux generations to print-ready 8K.
    - **Segment Anything (SAM):** Crop specific objects, upscale them with SeedVR2 for high-detail assets, then composite back.
    - **Remove Background:** Clean up the edges of a low-res masked object after upscaling.

## Notes & gotchas
- **Resolution Limit:** While marketed for "10K", stability may vary depending on the specific GPU backend; sticking to 8K (7680px) is recommended for production reliability.
- **Multiples of 32:** The model architecture requires input dimensions to be divisible by 32. FAL handles this internally, but it may involve slight padding or cropping of the edges.
- **One-Step Nature:** Because it is a one-step model, it is incredibly fast but lacks the iterative refinement steps of models like StableSR. If the result looks "flat," try increasing the `noise_scale`.

## Sources
- [FAL.ai API Reference](https://fal.ai/models/fal-ai/seedvr/upscale/image/api)
- [SeedVR2 Official Project Page](https://iceclear.github.io/projects/seedvr2/)
- [ArXiv: One-Step Video Restoration via Diffusion Adversarial Post-Training](https://arxiv.org/abs/2506.05301)
- [ByteDance SeedVR GitHub Repository](https://github.com/ByteDance-Seed/SeedVR)