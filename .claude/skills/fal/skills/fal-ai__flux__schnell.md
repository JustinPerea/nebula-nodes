---
name: fal-ai/flux/schnell
display_name: FLUX.1 [schnell]
category: text-to-image
creator: Black Forest Labs
fal_docs: https://fal.ai/models/fal-ai/flux/schnell
original_source: https://blackforestlabs.ai/
summary: A 12B parameter ultra-fast text-to-image model by Black Forest Labs, optimized for 1-4 step generation with commercial-ready licensing.
---

# FLUX.1 [schnell]

## Overview
- **Slug:** `fal-ai/flux/schnell`
- **Category:** Text-to-Image
- **Creator:** [Black Forest Labs](https://blackforestlabs.ai/)
- **Best for:** Ultra-fast, high-quality image generation for prototyping and commercial applications.
- **FAL docs:** [fal-ai/flux/schnell Documentation](https://fal.ai/models/fal-ai/flux/schnell)
- **Original source:** [Black Forest Labs Official Site](https://blackforestlabs.ai/), [Hugging Face Model Card](https://huggingface.co/black-forest-labs/FLUX.1-schnell)

## What it does
FLUX.1 [schnell] is a 12 billion parameter "rectified flow transformer" model designed for extreme efficiency, capable of generating high-fidelity images in just **1 to 4 inference steps**. As the "turbo" variant of the FLUX family, it utilizes adversarial diffusion distillation to maintain impressive prompt adherence and aesthetic quality while delivering sub-second results on high-end hardware. Unlike the "Dev" version, Schnell is released under the **Apache-2.0 license**, making it fully available for personal, scientific, and commercial use.

## When to use this model
- **Use when:** You need the fastest possible generation (sub-second to ~3s), are iterating quickly on prompts, or require an Apache-2.0 licensed model for commercial products.
- **Don't use when:** You need maximum possible detail, complex multi-word text rendering, or the absolute highest photorealism (use `FLUX.1 [dev]` or `FLUX.1 [pro]` instead).
- **Alternatives:** 
    - **[FLUX.1 [dev]](https://fal.ai/models/fal-ai/flux/dev):** Better quality and text rendering, but slower (20-50 steps) and non-commercial license.
    - **[FLUX.1 [pro]](https://fal.ai/models/fal-ai/flux-pro):** Maximum quality and prompt adherence, API-only.
    - **[SDXL Lightning](https://fal.ai/models/fal-ai/sdxl-lightning):** Another fast alternative, but generally lacks the anatomical precision and prompt following of the FLUX architecture.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/flux/schnell` (Sync) / `https://queue.fal.run/fal-ai/flux/schnell` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (Required) | 1-256 tokens | The text description of the image to generate. |
| `image_size` | enum/object | `landscape_4_3` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` or `{width: int, height: int}` | The size/aspect ratio of the generated image. |
| `num_inference_steps`| integer | `4` | 1 - 4 | Number of denoising steps. Higher = slightly better quality but slower. |
| `seed` | integer | Random | any int | Seed for reproducible results. |
| `guidance_scale` | float | `3.5` | 1.0 - 5.0 | CFG scale. Schnell is distilled, so keep this low (1.0-3.5) for best results. |
| `num_images` | integer | `1` | 1 - 12 | Number of images to generate per request. |
| `enable_safety_checker`| boolean | `true` | true, false | Filters NSFW content if enabled. |
| `output_format` | enum | `webp` | `jpeg`, `png`, `webp` | Format of the output image file. |
| `sync_mode` | boolean | `false` | true, false | If true, returns the media as a data URI immediately. |
| `acceleration` | enum | `none` | `none`, `regular`, `high` | Speed optimization levels. |

### Output
The API returns a JSON object containing a list of image objects.
```json
{
  "images": [
    {
      "url": "https://fal.run/files/...",
      "width": 1024,
      "height": 768,
      "content_type": "image/webp"
    }
  ],
  "seed": 12345678,
  "has_nsfw_concepts": [false],
  "prompt": "The original prompt used",
  "timings": { "inference": 0.85 }
}
```

### Example request
```json
{
  "prompt": "A futuristic cyberpunk city street at night, neon signs in Japanese, cinematic lighting, ultra-detailed, 8k resolution",
  "image_size": "landscape_16_9",
  "num_inference_steps": 4,
  "guidance_scale": 3.5
}
```

### Pricing
- **FAL.ai:** Approximately **$0.003 per megapixel** (roughly $0.003 per 1024x1024 image). 
- Note: Pricing is based on output resolution.

## API — via Original Source (BYO-key direct)
The creator, **Black Forest Labs**, provides a direct API at `api.bfl.ai`, though it primarily focuses on the `pro` and `pro-1.1` models. Because FLUX.1 [schnell] is **open-weights**, it is most commonly accessed via providers like FAL.ai or self-hosted.
- **Direct BFL API URL:** `https://api.bfl.ai/v1/flux-pro-1.1` (Note: BFL's own API often prioritizes the Pro versions).
- **Self-Hosting:** Users can run Schnell locally using the [official GitHub repo](https://github.com/black-forest-labs/flux) or [ComfyUI](https://github.com/comfyanonymous/ComfyUI).

## Prompting best practices
- **Be Natural:** FLUX is trained on a T5-XXL text encoder and understands natural language better than "keyword soup." Write full, descriptive sentences.
- **Token Limit:** Keep prompts under **256 tokens** for Schnell (unlike Dev which supports up to 512). The sweet spot is 40-60 words.
- **Subject-Action-Context:** Use a modular structure: `[Subject] [doing action] in [environment], [lighting style], [aesthetic style]`.
- **Avoid Over-prompting:** Because the model is distilled, overly complex prompts can sometimes lead to "hallucinated" details.
- **Good Prompt:** *"A realistic portrait of an elderly fisherman with weathered skin, wearing a yellow raincoat, standing on a wooden pier during a misty morning, cinematic lighting, 8k."*
- **Bad Prompt:** *"man, fisherman, old, rain, mist, pier, 8k, ultra hd, super detailed, masterpiece, trending on artstation."* (FLUX doesn't need these generic "booster" keywords).

## Parameter tuning guide
- **Steps:** **4 steps** is the standard for production. 1 step is "preview" quality; 2-3 steps are often enough for rapid iteration.
- **Guidance Scale:** Keep it between **1.0 and 3.5**. Setting it too high (>5.0) on a distilled model like Schnell often causes "burned" colors or artifacts.
- **Resolution:** Natively trained for **1 Megapixel** (e.g., 1024x1024). While it supports custom sizes, sticking to the standard aspect ratios ensures the best anatomical consistency.

## Node inputs/outputs
- **Inputs:**
    - `Prompt` (String)
    - `Image Size` (Enum)
    - `Steps` (Int, 1-4)
    - `Seed` (Int)
- **Outputs:**
    - `Image URL` (String)
    - `Seed Used` (Int)
- **Chain-friendly with:**
    - `fal-ai/flux-subject` (for character consistency)
    - `fal-ai/flux/dev` (use Schnell for fast previews, then switch to Dev for final high-quality render)
    - `fal-ai/upscaler` (to bring 1MP outputs to 4K)

## Notes & gotchas
- **Text Rendering:** While FLUX is famous for text, Schnell is slightly less reliable than the Dev/Pro versions. If text is garbled, try a few different seeds or switch to Dev.
- **Licensing:** Fully **Apache-2.0**. This is the only FLUX model you can use commercially "out of the box" without a separate commercial agreement from BFL (unlike Dev).
- **VRAM:** For local users, Schnell is lightweight, running on as little as **6GB-8GB VRAM** with quantization (FP8/GGUF).

## Sources
- [FAL.ai Flux Schnell Documentation](https://fal.ai/models/fal-ai/flux/schnell)
- [Black Forest Labs Official Site](https://blackforestlabs.ai/)
- [Hugging Face: black-forest-labs/FLUX.1-schnell](https://huggingface.co/black-forest-labs/FLUX.1-schnell)
- [BFL API Integration Guide](https://docs.bfl.ml/)
- [FAL Learn: How to use Flux](https://fal.ai/learn/tools/how-to-use-flux)