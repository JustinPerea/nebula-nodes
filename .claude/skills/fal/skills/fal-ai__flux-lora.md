---
name: fal-ai/flux-lora
display_name: FLUX.1 [dev] with LoRAs
category: text-to-image
creator: Black Forest Labs (BFL)
fal_docs: https://fal.ai/models/fal-ai/flux-lora
original_source: https://bfl.ai/
summary: The industry-leading 12B parameter transformer model by Black Forest Labs, optimized by FAL for rapid LoRA-enhanced image generation.
---

# FLUX.1 [dev] with LoRAs

## Overview
- **Slug:** `fal-ai/flux-lora`
- **Category:** Text-to-Image
- **Creator:** [Black Forest Labs](https://bfl.ai/)
- **Best for:** High-quality, personalized image generation with precise style or character control via LoRA adapters.
- **FAL docs:** [fal-ai/flux-lora](https://fal.ai/models/fal-ai/flux-lora)
- **Original source:** [Black Forest Labs Documentation](https://docs.bfl.ai/)

## What it does
FLUX.1 [dev] is a state-of-the-art 12 billion parameter rectified flow transformer model that balances high-fidelity image generation with efficient inference [Black Forest Labs](https://huggingface.co/black-forest-labs/FLUX.1-dev). This specific FAL.ai implementation adds a high-performance LoRA (Low-Rank Adaptation) merging layer, allowing users to apply multiple style, character, or object adapters to the base model on-the-fly without the overhead of full model fine-tuning [fal.ai](https://fal.ai/models/fal-ai/flux-lora). It excels at text rendering, complex prompt adherence, and producing human anatomy with high accuracy.

## When to use this model
- **Use when:** You need professional-grade image quality with specific style consistency (e.g., brand assets, consistent characters) using LoRAs from platforms like Civitai.
- **Don't use when:** You need ultra-fast, low-cost generation (use `fal-ai/flux-schnell` instead) or if you are doing simple generations without any specialized style requirements.
- **Alternatives:** 
    - `fal-ai/flux-pro`: Higher quality and better prompt adherence but higher cost and no LoRA support.
    - `fal-ai/flux-schnell`: Much faster (1-4 steps) and cheaper, but lower detail and no LoRA support.
    - `fal-ai/flux-general`: A versatile endpoint that supports various FLUX versions but may lack the specialized LoRA optimization of this endpoint.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/flux-lora` (Sync) / `https://queue.fal.run/fal-ai/flux-lora` (Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | `string` | *Required* | N/A | The description of the image to generate. |
| `loras` | `list` | `[]` | N/A | A list of LoRA weights to merge. Each item contains a `path` (URL) and `scale` (float). |
| `image_size` | `enum/object` | `landscape_4_3` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` or `{width, height}` | The aspect ratio or specific dimensions of the image. |
| `num_inference_steps`| `integer` | `28` | `1 - 50` | Number of denoising steps. Higher values increase detail but cost more. |
| `guidance_scale` | `float` | `3.5` | `1.5 - 5.0` | How strictly the model follows the prompt. |
| `seed` | `integer` | `null` | Any integer | For reproducible results. |
| `num_images` | `integer` | `1` | `1 - 8` | Number of images to generate per request. |
| `enable_safety_checker`| `boolean` | `true` | `true`, `false` | Filters out NSFW content if enabled. |
| `output_format` | `enum` | `jpeg` | `jpeg`, `png` | Format of the resulting image. |
| `acceleration` | `enum` | `regular` | `none`, `regular` | Speed optimization level. |
| `sync_mode` | `boolean` | `false` | `true`, `false` | If true, returns the media as a data URI immediately. |

### Output
The output is a JSON object containing:
- `images`: A list of image objects, each with a `url`, `width`, `height`, and `content_type`.
- `seed`: The seed used for generation (useful if a random seed was used).
- `has_nsfw_concepts`: A list of booleans indicating if NSFW content was detected for each image.
- `timings`: Performance metrics of the request.

### Example request
```json
{
  "prompt": "A cinematic shot of a futuristic city, neon lights, 8k resolution, highly detailed",
  "loras": [
    {
      "path": "https://civitai.com/api/download/models/123456",
      "scale": 0.8
    }
  ],
  "image_size": "landscape_16_9",
  "num_inference_steps": 28,
  "guidance_scale": 3.5
}
```

### Pricing
FAL.ai bills this model at **$0.035 per megapixel** [fal.ai Pricing](https://fal.ai/pricing). Images are billed by rounding up to the nearest megapixel.

## API — via Original Source (BYO-key direct)
Black Forest Labs provides a direct API for the FLUX.1 [dev] model, but **it does not natively support on-the-fly LoRA merging** in the same manner as FAL's specialized LoRA endpoint [BFL API Docs](https://docs.bfl.ai/).
- **Endpoint:** `https://api.bfl.ai/v1/flux-dev`
- **Auth Method:** Header `x-key: <api-key>`
- **Pricing:** Approximately **$0.025 per image** (Standard 1MP) [BFL Pricing](https://bfl.ai/pricing).
- **Official Docs:** [docs.bfl.ai](https://docs.bfl.ai/api-reference/models/generate-an-image-with-flux1-[dev])

## Prompting best practices
- **Use Natural Language:** Unlike SDXL, FLUX performs best with descriptive, full-sentence prompts rather than comma-separated keywords [getimg.ai](https://getimg.ai/blog/flux-1-prompt-guide-pro-tips-and-common-mistakes-to-avoid).
- **Be Hierarchical:** Describe the main subject first, then the background, then the lighting and mood. "A portrait of a woman in a red dress, standing in a foggy forest, lit by warm moonlight" works better than "woman, red dress, forest, fog, moon, warm light".
- **Avoid "White Background":** In the [dev] variant, the phrase "white background" can sometimes trigger a known bug that results in blurry or hazy images [getimg.ai](https://getimg.ai/blog/flux-1-prompt-guide-pro-tips-and-common-mistakes-to-avoid). Use "minimalist background" or "solid light gray backdrop" instead.
- **Direct Object Placement:** Explicitly state positions like "on the left," "in the foreground," or "visible through the window" for superior composition control [getimg.ai](https://getimg.ai/blog/flux-1-prompt-guide-pro-tips-and-common-mistakes-to-avoid).

## Parameter tuning guide
- **Guidance Scale (CFG):** The default **3.5** is the sweet spot for almost all use cases [Deep Infra](https://deepinfra.com/blog/flux1-dev-guide). Increasing it to 5.0 can make images feel "over-baked" or airbrushed, while dropping it to 1.5-2.0 allows for more creative, artistic freedom but risks prompt drifting [Reddit](https://www.reddit.com/r/StableDiffusion/comments/1etc918/the_difference_in_quality_from_lowering_the/).
- **Inference Steps:** Use **28 steps** for high-quality results. Going above 40 steps rarely yields significant improvements and increases cost/latency [Deep Infra](https://deepinfra.com/blog/flux1-dev-guide).
- **LoRA Scales:** When using multiple LoRAs, keep the total combined scale near **1.0**. If using a single LoRA, a scale between **0.6 and 0.9** usually preserves the base model's quality while applying the style effectively [Hugging Face](https://huggingface.co/black-forest-labs/FLUX.1-Depth-dev-lora).

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Prompt` (Text)
    - `LoRAs` (Array of objects: {path, scale})
    - `Dimensions` (Enum or Width/Height)
    - `Steps` (Int)
    - `Guidance` (Float)
    - `Seed` (Int)
- **Outputs:**
    - `Image URL` (String)
    - `Metadata` (JSON including Seed and NSFW flag)
- **Chain-friendly with:**
    - `fal-ai/esrgan`: For upscaling the final output to 4k.
    - `fal-ai/modnet`: For removing backgrounds to create stickers/assets.
    - `fal-ai/flux-lora-canny`: If you need to swap the base node for one that supports structural control.

## Notes & gotchas
- **Non-Commercial License:** The [dev] model is under a non-commercial license from Black Forest Labs, though FAL's API provides commercial usage rights for the *output* in most tiers [fal.ai](https://fal.ai/models/fal-ai/flux-lora). Always check the latest FAL terms for commercial deployment.
- **LoRA Format:** Ensure LoRAs are in `safetensors` format. Civitai links must be direct download URLs.
- **NSFW Filter:** The safety checker is quite robust but can sometimes produce false positives for certain artistic styles.

## Sources
- [FAL.ai Model Documentation](https://fal.ai/models/fal-ai/flux-lora)
- [Black Forest Labs Official API Docs](https://docs.bfl.ai/)
- [Hugging Face Model Card - FLUX.1 [dev]](https://huggingface.co/black-forest-labs/FLUX.1-dev)
- [Black Forest Labs Pricing](https://bfl.ai/pricing)
- [Deep Infra FLUX Guide](https://deepinfra.com/blog/flux1-dev-guide)
- [getimg.ai Prompting Guide](https://getimg.ai/blog/flux-1-prompt-guide-pro-tips-and-common-mistakes-to-avoid)
