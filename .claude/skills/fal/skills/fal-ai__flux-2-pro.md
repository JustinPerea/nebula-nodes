---
name: fal-ai/flux-2-pro
display_name: FLUX.2 [pro]
category: text-to-image
creator: Black Forest Labs
fal_docs: https://fal.ai/models/fal-ai/flux-2-pro
original_source: https://docs.bfl.ml/flux_2/flux2_overview
summary: The flagship professional text-to-image model by Black Forest Labs, optimized for zero-config production-grade quality and precise text rendering.
---

# FLUX.2 [pro]

## Overview
- **Slug:** `fal-ai/flux-2-pro`
- **Category:** Text-to-Image / Image Editing
- **Creator:** [Black Forest Labs](https://blackforestlabs.ai/)
- **Best for:** Professional-grade, zero-configuration image generation with state-of-the-art prompt following and typography.
- **FAL docs:** [fal.ai/models/fal-ai/flux-2-pro](https://fal.ai/models/fal-ai/flux-2-pro)
- **Original source:** [docs.bfl.ml](https://docs.bfl.ml/flux_2/flux2_overview)

## What it does
FLUX.2 [pro] is the premier commercial model from [Black Forest Labs](https://blackforestlabs.ai/), designed to deliver studio-quality visuals with a streamlined, "zero-config" pipeline. It features a 32-billion parameter architecture that integrates a Mistral-3 24B vision-language model with a rectified flow transformer. This combination enables the model to follow complex natural language instructions with extreme fidelity, render legible and contextually accurate text, and maintain precise color matching through HEX code support. It is specifically optimized for production environments where reliability and quality are prioritized over manual parameter tuning.

## When to use this model
- **Use when:** You need high-resolution (up to 4MP) assets for marketing, editorial, or commercial use; your prompt contains specific text or brand colors; or you require "out-of-the-box" professional results without tuning.
- **Don't use when:** You need sub-second generation (use [FLUX.2 [klein]](https://fal.ai/models/fal-ai/flux-2-klein-9b)); you want granular control over sampling steps and guidance (use [FLUX.2 [flex]](https://fal.ai/models/fal-ai/flux-2-flex)); or you need real-time web-grounded information in the image (use [FLUX.2 [max]](https://fal.ai/models/fal-ai/flux-2-max)).
- **Alternatives:**
  - **fal-ai/flux-2-max:** The absolute highest quality tier with "grounding search" for real-world knowledge.
  - **fal-ai/flux-2-flex:** Allows manual adjustment of inference steps and guidance scales.
  - **fal-ai/flux-2-klein-9b:** A faster, more economical variant that still supports multi-reference editing.

## API — via FAL.ai
**Endpoints:** 
- `https://fal.run/fal-ai/flux-2-pro` (Synchronous)
- `https://queue.fal.run/fal-ai/flux-2-pro` (Asynchronous/Queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | *Required* | - | Text description of the image. Supports up to 32K tokens and HEX color codes. |
| `image_size` | enum / object | `landscape_4_3` | `square_hd`, `square`, `portrait_4_3`, `portrait_16_9`, `landscape_4_3`, `landscape_16_9`, or `{ "width": int, "height": int }` | The dimensions of the output image. |
| `seed` | integer | null | - | Seed for deterministic generation. |
| `safety_tolerance` | enum | `"2"` | `"1"` (strict) to `"5"` (permissive) | Moderation level for content filtering. |
| `enable_safety_checker` | boolean | `true` | - | Whether to enable the safety filter. |
| `output_format` | enum | `"jpeg"` | `"jpeg"`, `"png"` | Format of the resulting image file. |
| `sync_mode` | boolean | `false` | - | If `true`, returns the image as a base64 data URI in the response. |

### Output
The API returns a JSON object containing a list of image objects and the seed used.
```json
{
  "images": [
    {
      "url": "https://v3.fal.media/files/...",
      "width": 1024,
      "height": 768,
      "content_type": "image/jpeg"
    }
  ],
  "seed": 42
}
```

### Example request
```json
{
  "prompt": "A cinematic macro shot of a cybernetic butterfly resting on a neon-lit circuit board, colors #00FFCC and #FF00FF, depth of field, hyper-detailed textures.",
  "image_size": "landscape_16_9",
  "output_format": "png"
}
```

### Pricing
Standard pricing is **$0.03 per megapixel** for the first megapixel, plus **$0.015 per additional megapixel** (rounded up). For example, a 1024x1024 image (1MP) costs $0.03.

## API — via Original Source (BYO-key direct)
[Black Forest Labs](https://docs.bfl.ml/flux_2/flux2_text_to_image) provides a direct API for those bringing their own keys.
- **Endpoint:** `https://api.bfl.ai/v1/flux-2-pro`
- **Auth:** `x-key` header containing the BFL API Key.
- **Native-only Parameters:**
  - `prompt_upsampling` (boolean): Automatically enhances short prompts for better visual variety.
  - `webhook_url`: Allows for asynchronous callbacks when the image is ready.
  - `multi-reference`: BFL supports `input_image_2` through `input_image_8` for advanced compositing.

## Prompting best practices
- **Hex Color Accuracy:** Use the syntax `color #HEXCODE` (e.g., `the car is color #FFD700`) to ensure brand-perfect color reproduction.
- **Reference by Index:** When using multi-reference images, use the `@` syntax (e.g., `@image1 wearing the style of @image2`) to describe relationships between inputs.
- **Natural Language vs. Keywords:** The model responds better to descriptive prose than comma-separated "tag clouds." Instead of "girl, blonde, forest," use "A portrait of a girl with flowing blonde hair standing in a sun-drenched forest."
- **Avoid Quality Buzzwords:** Phrases like "masterpiece" or "8k" are less effective than describing the specific technical attributes you want (e.g., "shot on 35mm film," "high-contrast lighting").

## Parameter tuning guide
- **Image Size:** Use the custom `{width, height}` object to match specific UI dimensions or print aspect ratios, ensuring both are multiples of 16.
- **Safety Tolerance:** For creative projects requiring more artistic freedom, setting this to `"5"` allows for more permissive generation, while `"1"` is recommended for enterprise/internal tools.
- **Seed:** Locking the seed is essential for "prompt engineering" to see how small changes in the text affect the same base composition.

## Node inputs/outputs
- **Inputs:**
  - `prompt`: (String) Primary text instruction.
  - `seed`: (Number) For consistency.
  - `image_size`: (Dropdown) Aspect ratio selector.
- **Outputs:**
  - `image_url`: (URL) The primary output for display or further processing.
  - `metadata`: (JSON) Contains dimensions and generation seed.
- **Chain-friendly with:**
  - **fal-ai/flux-1-fill-pro:** For inpainting or local edits on the generated Pro output.
  - **fal-ai/flux-lora-fast-training:** Use high-quality Pro generations as training data for custom LoRAs.

## Notes & gotchas
- **Signed URLs:** FAL.ai result URLs are temporary (typically expiring in 10 minutes). Ensure the app downloads or persists the image immediately.
- **Zero-Config Limitation:** Because Pro is optimized for ease of use, you cannot adjust internal diffusion parameters like "Guidance Scale" — if you find the model is following your prompt *too* strictly or not enough, you must switch to the **Flex** variant.

## Sources
- [FAL.ai Flux 2 Pro API Reference](https://fal.ai/models/fal-ai/flux-2-pro/api)
- [Black Forest Labs FLUX.2 Technical Documentation](https://docs.bfl.ml/flux_2/flux2_overview)
- [BFL API Reference](https://docs.bfl.ml/flux_2/flux2_text_to_image)