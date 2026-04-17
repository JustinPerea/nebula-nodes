---
name: fal-ai/stable-diffusion-xl
display_name: Stable Diffusion XL (SDXL)
category: text-to-image
creator: Stability AI
fal_docs: https://fal.ai/models/fal-ai/fast-sdxl/api
original_source: https://stability.ai/stable-diffusion, https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0
summary: Stability AI's flagship high-resolution latent diffusion model, featuring dual text encoders and a 1024x1024 native resolution.
---

# Stable Diffusion XL (SDXL)

## Overview
- **Slug:** `fal-ai/stable-diffusion-xl` (Note: Often aliased or documented on FAL as `fal-ai/fast-sdxl`)
- **Category:** Text-to-Image
- **Creator:** [Stability AI](https://stability.ai/)
- **Best for:** High-fidelity, production-grade image generation with complex prompt adherence and 1024x1024 native resolution.
- **FAL docs:** [FAL.ai Fast-SDXL API](https://fal.ai/models/fal-ai/fast-sdxl/api)
- **Original source:** [Hugging Face Model Card](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0), [Stability AI Platform](https://platform.stability.ai/)

## What it does
Stable Diffusion XL (SDXL) is a significant upgrade over previous Stable Diffusion versions (1.5 and 2.1), featuring a 3x larger UNet backbone (2.6B parameters) and dual text encoders (OpenCLIP-ViT/G and CLIP-ViT/L). It generates images natively at 1024x1024 pixels, offering much higher detail, better lighting, and improved composition compared to its predecessors. While it can be used with a refiner model for extra detail, the base model is powerful enough for most high-end creative workflows ([Hugging Face](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0)).

## When to use this model
- **Use when:** You need high-resolution (1024px+) images, complex scene composition, or better handling of short prompts. It is the industry standard for open-weights high-quality generation.
- **Don't use when:** You need real-time speeds (<1 second), as SDXL is computationally heavy. For speed, use "Turbo" or "Lightning" variants.
- **Alternatives:** 
  - `fal-ai/fast-lightning-sdxl`: Much faster, lower quality (distilled).
  - `fal-ai/flux/dev`: Higher prompt adherence and better text rendering, but higher cost.
  - `fal-ai/stable-diffusion-v35-large`: The next generation after SDXL with even better performance.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/fast-sdxl` (sync) / `https://queue.fal.run/fal-ai/fast-sdxl` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | *Required* | N/A | The main description of the image. Be descriptive for best results. |
| `negative_prompt` | string | `""` | N/A | Text describing what to exclude from the image. |
| `image_size` | string/obj | `square_hd` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9` | Predefined aspect ratios or custom `{width, height}` object. |
| `num_inference_steps` | integer | `25` | `10 - 50` | Higher steps increase detail but also generation time. |
| `guidance_scale` | float | `7.5` | `1.0 - 20.0` | Controls how strictly the model follows the prompt (CFG). |
| `seed` | integer | `null` | `0 - 4294967295` | Set for deterministic results. |
| `num_images` | integer | `1` | `1 - 8` | Number of images to generate per request. |
| `enable_safety_checker`| boolean | `true` | `true`, `false` | Filters NSFW content. |
| `expand_prompt` | boolean | `false` | `true`, `false` | If true, uses an LLM to enrich the user's prompt. |
| `format` | string | `jpeg` | `jpeg`, `png` | The file format of the output image. |
| `loras` | list | `[]` | N/A | List of LoRA weights to apply (requires `path` and `scale`). |
| `embeddings` | list | `[]` | N/A | List of Textual Inversion embeddings to use. |
| `sync_mode` | boolean | `false` | `true`, `false` | If true, returns data URIs instead of URLs. |

### Output
The API returns a JSON object containing:
- `images`: A list of objects with `url`, `width`, `height`, and `content_type`.
- `seed`: The seed used for generation (useful if randomized).
- `has_nsfw_concepts`: A list of booleans indicating if any image was filtered.
- `timings`: Inference time details.

### Example request
```json
{
  "input": {
    "prompt": "Cinematic photo of a futuristic cyberpunk city with neon lights and rain, 8k resolution, highly detailed",
    "negative_prompt": "cartoon, low quality, blurry",
    "image_size": "landscape_16_9",
    "num_inference_steps": 30,
    "guidance_scale": 7.5
  }
}
```

### Pricing
Approximately **$0.003 - $0.005 per image** ([TeamDay.ai](https://www.teamday.ai/blog/fal-ai-vs-replicate-comparison)). Actual costs may vary based on compute time if using custom GPU deployments on FAL (H100 starts at $0.0005/sec).

## API — via Original Source (BYO-key direct)
Stability AI provides a direct REST API for SDXL:
- **Endpoint:** `https://api.stability.ai/v1/generation/stable-diffusion-xl-1024-v1-0/text-to-image`
- **Parameters:** Similar to FAL but includes `style_preset` (e.g., "cinematic", "anime") and `clip_guidance_preset`.
- **Auth method:** Bearer Token (API Key) via `Authorization` header.
- **Docs:** [Stability AI Platform API Reference](https://platform.stability.ai/docs/api-reference#tag/v1generation/operation/textToImage)

## Prompting best practices
- **Be Descriptive:** SDXL is trained to understand longer, more nuanced prompts than SD 1.5. Use "photo of...", "in the style of...", and lighting descriptions ("golden hour", "soft studio lighting").
- **Avoid Over-Prompting:** While it handles complexity well, a "prompt salad" of contradictory tokens can confuse the dual encoders.
- **Negative Prompts:** Use them to remove common artifacts like "extra limbs", "blurry", or "deformed faces".
- **Resolution matters:** Prompting for "8k", "highly detailed", or "masterpiece" still helps guide the model toward high-quality aesthetics.
- **Example Good Prompt:** "A majestic lion standing on a rocky outcrop at sunset, cinematic lighting, national geographic style, ultra-realistic, 8k."
- **Example Bad Prompt:** "lion, cool, 8k, nice." (Too vague, doesn't leverage SDXL's capacity for composition).

## Parameter tuning guide
- **CFG Scale (Guidance Scale):** 
  - **3.0 - 5.0:** More creative, "dreamy" results with softer edges.
  - **7.0 - 9.0:** (Recommended) The sweet spot for most prompts, balanced adherence.
  - **12.0+:** Very strict adherence, but can lead to "fried" or over-saturated colors.
- **Inference Steps:** 
  - **20 - 30:** Sufficient for most use cases with modern schedulers.
  - **50:** Diminishing returns; use only if you notice missing fine details.
- **Image Size:** Always use the `image_size` presets or ensure custom dimensions are multiples of 64. SDXL is native at 1024x1024; deviating too far (e.g., 512x512) can cause repetitive patterns.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
  - `prompt` (Text)
  - `negative_prompt` (Text)
  - `image_size` (Dropdown/Select)
  - `seed` (Number)
  - `num_inference_steps` (Number)
  - `guidance_scale` (Number)
- **Outputs:**
  - `image_url` (Image/URL)
  - `seed_out` (Number)
- **Chain-friendly with:**
  - `fal-ai/esrgan`: For upscaling generated 1024px images to 4k.
  - `fal-ai/face-swap`: To replace faces in generated portraits.
  - `fal-ai/layer-diffusion`: To generate the same subject with transparent backgrounds.

## Notes & gotchas
- **404 Warning:** The exact slug `fal-ai/stable-diffusion-xl` may redirect to or be replaced by `fal-ai/fast-sdxl` in modern FAL environments. Ensure your API calls use the currently active endpoint.
- **NSFW Filtering:** FAL's safety checker is aggressive; images with skin-tones or certain poses might be flagged even if benign.
- **LoRA Support:** LoRAs must be specifically trained for SDXL; SD 1.5 LoRAs will not work ([Reddit](https://www.reddit.com/r/StableDiffusion/comments/1kl2qhy/sd15_sdxl_pony_sd35_flux_whats_the_difference/)).

## Sources
- [FAL.ai Fast-SDXL Documentation](https://fal.ai/models/fal-ai/fast-sdxl/api)
- [Stability AI SDXL AWS Guide](https://stability.ai/sdxl-aws-documentation)
- [Stability AI Official API Docs](https://platform.stability.ai/docs/api-reference)
- [Hugging Face SDXL 1.0 Base Card](https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0)
- [FAL.ai Pricing Analysis](https://www.teamday.ai/blog/fal-ai-vs-replicate-comparison)
