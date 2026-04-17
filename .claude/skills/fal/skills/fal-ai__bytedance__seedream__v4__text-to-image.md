---
name: fal-ai/bytedance/seedream/v4/text-to-image
display_name: Bytedance Seedream v4
category: text-to-image
creator: ByteDance Seed Team
fal_docs: https://fal.ai/models/fal-ai/bytedance/seedream/v4/text-to-image
original_source: https://seed.bytedance.com/en/seedream4_0
summary: A professional-grade, ultra-fast multimodal image generation model by ByteDance capable of native 4K resolution and superior typography rendering.
---

# Bytedance Seedream v4

## Overview
- **Slug:** `fal-ai/bytedance/seedream/v4/text-to-image`
- **Category:** text-to-image
- **Creator:** [ByteDance Seed](https://seed.bytedance.com/en/seedream4_0)
- **Best for:** High-fidelity 4K image generation with complex text and instruction following.
- **FAL docs:** [fal.ai/models/fal-ai/bytedance/seedream/v4/text-to-image](https://fal.ai/models/fal-ai/bytedance/seedream/v4/text-to-image)
- **Original source:** [ByteDance Seedream 4.0 Official Page](https://seed.bytedance.com/en/seedream4_0) / [Volcano Engine](https://www.volcengine.com/)

## What it does
Seedream v4 (also known as Seedream 4.0) is a next-generation multimodal image creation model developed by ByteDance. It utilizes a unified architecture that integrates high-speed text-to-image synthesis with advanced image editing capabilities. Built on a highly efficient **Diffusion Transformer (DiT)** and a high-compression **Variational Autoencoder (VAE)**, it achieves up to 10x inference acceleration compared to previous versions while supporting native high-resolution outputs up to 4K. It is particularly noted for its ability to render accurate typography, complex knowledge-centric content (like charts and formulas), and stable character consistency.

## When to use this model
- **Use when:** 
    - You need ultra-fast generation of high-resolution (up to 4K) images.
    - Your prompt requires legible, accurate text or complex typography.
    - You are generating professional design materials, charts, or structured visual content.
    - You require high instruction adherence for complex compositions.
- **Don't use when:**
    - You need video output (use [Seedance](https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video)).
    - You require extremely stylized "abstract" art where exact prompt adherence is less important than artistic flair (other models like Flux might offer more varied "artistic" biases).
- **Alternatives:**
    - **[Nano Banana](https://fal.ai/models/fal-ai/nano-banana):** The primary competitor in the "fast professional" tier; Seedream v4 claims superior speed and accuracy in text rendering.
    - **[Flux.1 [Pro]](https://fal.ai/models/fal-ai/flux-pro):** Excellent for artistic variety and realism, though often slower than the Seedream v4 optimized pipeline.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/bytedance/seedream/v4/text-to-image` (sync) / `https://queue.fal.run/fal-ai/bytedance/seedream/v4/text-to-image` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | `string` | *Required* | N/A | The text prompt describing the content, style, or composition of the image to be generated. |
| `image_size` | `enum / object` | `square_hd` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`, `auto`, `auto_2K`, `auto_4K` or `{width: int, height: int}` | The size of the generated image. Total pixels must be between 960x960 and 4096x4096 (4K). |
| `num_images` | `integer` | `1` | 1 - 8 | Number of separate model generations to be run. |
| `max_images` | `integer` | `1` | N/A | If >1, enables multi-image generation within a single request for higher variety. |
| `seed` | `integer` | `null` | N/A | Random seed to control stochasticity. Using the same seed/prompt results in identical images. |
| `sync_mode` | `boolean` | `false` | `true`, `false` | If `true`, returns media as a data URI and bypasses history storage. |
| `enable_safety_checker` | `boolean` | `true` | `true`, `false` | Enables the internal content safety filter. |
| `enhance_prompt_mode` | `enum` | `standard` | `standard`, `fast` | `standard` provides higher quality results but takes longer; `fast` prioritizes speed. |

### Output
The API returns a JSON object containing the generated images and the seed used.
```json
{
  "images": [
    {
      "url": "https://storage.googleapis.com/...",
      "width": 1024,
      "height": 1024,
      "content_type": "image/png",
      "file_name": "seedream_output.png",
      "file_size": 123456
    }
  ],
  "seed": 746406749
}
```

### Example request
```json
{
  "prompt": "A futuristic city skyline at sunset with a billboard that says 'SEEDREAM 4.0' in glowing neon letters, highly detailed, 4K resolution.",
  "image_size": "landscape_16_9",
  "enhance_prompt_mode": "standard"
}
```

### Pricing
- **Cost:** ~$0.03 per 1MP image.
- **Efficiency:** Approximately 33 images per $1.00 USD on [fal.ai](https://fal.ai/pricing).

## API — via Original Source (BYO-key direct)
ByteDance provides direct access to Seedream models via **Volcano Engine**, their enterprise cloud platform.
- **Endpoint:** Region-specific Volcano Engine API endpoints (e.g., `visual.volcengineapi.com`).
- **Auth method:** HMAC-SHA256 signature using Access Key / Secret Key.
- **Native features:** Supports advanced features like "Instruction Editing" (adding/removing objects) and "Multi-Image Reference" (up to 10+ images) which may not be fully exposed in the basic FAL T2I endpoint.
- **Documentation:** [Volcano Engine Visual Technology](https://www.volcengine.com/docs/6705/1324706)

## Prompting best practices
- **Be Literal with Text:** If you need specific text, use quotes (e.g., `a cafe sign that says "Open 24/7"`). The model has a 94% accuracy rate on complex typography.
- **Describe Lighting and Texture:** Leverage the model's 4K capabilities by specifying textures (e.g., "brushed aluminum," "soft morning mist," "hyper-realistic skin pores").
- **Natural Language Instructions:** Since the model unifies editing and generation, it responds well to natural language descriptions of composition (e.g., "Place a small cat in the bottom-right corner looking at the camera").
- **Use Quality Tokens sparingly:** The model is trained on high-aesthetic data; terms like "photorealistic" or "4K" are effective, but "standard" prompt enhancement usually handles this automatically.
- **Avoid Over-prompting:** Due to its "thinking" budget (AdaCoT), extremely long, contradictory prompts might dilute the primary subject. Stick to clear, structural descriptions.

## Parameter tuning guide
- **`enhance_prompt_mode`: Standard vs Fast** 
    - Use **Standard** for professional work or marketing materials where prompt fidelity and aesthetic detail are paramount.
    - Use **Fast** for rapid prototyping or if you are running the model in a real-time application.
- **`image_size`: Custom Resolutions**
    - For cinema-wide shots, use `landscape_16_9`. 
    - For mobile apps/TikTok-style content, use `portrait_16_9`.
    - Always prefer the `auto_4K` enum if your goal is the highest possible quality for large displays.
- **`max_images`:**
    - Setting `max_images` > 1 is excellent for "best-of-N" workflows, as the model's unified architecture can generate slightly different variations of the same prompt in one pass.

## Node inputs/outputs
- **Inputs:**
    - `prompt` (String): The core visual description.
    - `image_size` (Enum/Object): Resolution selection.
    - `seed` (Int): Reproducibility control.
    - `enhance_mode` (Enum): Quality vs Speed toggle.
- **Outputs:**
    - `image_url` (URL): Direct link to the generated file.
    - `metadata` (JSON): Details on resolution, seed, and file size.
- **Chain-friendly with:**
    - **[Flux Pro Upscaler](https://fal.ai/models/fal-ai/flux-pro/upscaler):** Take Seedream's 4K output and push it to even higher fidelity.
    - **[Seedance 2.0](https://fal.ai/models/bytedance/seedance-2.0):** Use a Seedream-generated image as the first-frame reference for video generation.

## Notes & gotchas
- **Safety Filters:** The model has a robust safety checker (`enable_safety_checker`). If your prompt is flagged, it will return a safety error rather than a blurred image.
- **Region Availability:** While FAL provides global access, the underlying model is a ByteDance (TikTok parent) product, which may have specific data-handling policies.
- **Inference Speed:** Typical generation for a 2K image is between 1.4s to 1.8s, making it one of the fastest high-res models on the market as of 2026.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/bytedance/seedream/v4/text-to-image)
- [ByteDance Seed Official Site](https://seed.bytedance.com/en/seedream4_0)
- [arXiv: Seedream 4.0 Technical Report](https://arxiv.org/abs/2509.20427)
- [FAL.ai Pricing Documentation](https://fal.ai/pricing)
- [Volcano Engine API Reference](https://www.volcengine.com/product/cv)
