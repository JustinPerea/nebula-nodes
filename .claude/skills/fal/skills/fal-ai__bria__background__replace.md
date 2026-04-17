---
name: fal-ai/bria/background/replace
display_name: Bria Background Replace
category: image-to-image
creator: Bria AI
fal_docs: https://fal.ai/models/fal-ai/bria/background/replace
original_source: https://docs.bria.ai/image-editing/v2-endpoints/background-replace
summary: A commercially-safe generative background replacement model trained on 100% licensed data, capable of swapping backgrounds via text prompts or reference images.
---

# Bria Background Replace

## Overview
- **Slug:** `fal-ai/bria/background/replace`
- **Category:** Image-to-Image / Generative Background Replacement
- **Creator:** [Bria AI](https://bria.ai)
- **Best for:** Professional e-commerce product staging and commercially-safe marketing asset generation.
- **FAL docs:** [fal.ai/models/fal-ai/bria/background/replace](https://fal.ai/models/fal-ai/bria/background/replace)
- **Original source:** [docs.bria.ai](https://docs.bria.ai/image-editing/v2-endpoints/background-replace)

## What it does
Bria Background Replace is a specialized generative model designed to isolate the foreground of an image and replace its background with a newly generated scene. Unlike generic inpainting models, it is fine-tuned for background consistency and seamless edge blending. It can generate these backgrounds based on either a text prompt or a reference image. 

The model's primary differentiator is its training data: it is trained exclusively on **100% licensed commercial imagery**, ensuring that the outputs are legally safe for enterprise use without the copyright risks associated with models trained on scraped web data.

## When to use this model
- **Use when:** You need to place a product or person in a new environment (e.g., a model in a studio moved to a beach) while maintaining commercial compliance.
- **Use when:** You require high-quality edge handling for hair, fur, or semi-transparent materials.
- **Don't use when:** You need to change the foreground subject itself (use a general inpainting model like Flux Fill for that).
- **Don't use when:** You need high-speed real-time video background removal (use `fal-ai/bria/background/remove` for pure transparency or specialized video models).
- **Alternatives:** 
    - `fal-ai/bria/background/remove`: For pure background removal to PNG/alpha channel without generation.
    - `fal-ai/flux-pro/fill`: For more creative/flexible inpainting if commercial licensing of training data is not a primary concern.
    - `fal-ai/bria/product-shot`: Specifically optimized for e-commerce product placement with studio-quality lighting.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/bria/background/replace` (sync) / `https://queue.fal.run/fal-ai/bria/background/replace` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | string | (Required) | URL / Base64 | The source image containing the foreground subject you want to keep. |
| `prompt` | string | `""` | Text | Description of the new background to generate. (Required if `ref_image_url` is not provided). |
| `ref_image_url` | string | `null` | URL / Base64 | A reference image to guide the style/content of the new background. |
| `negative_prompt` | string | `""` | Text | Elements to exclude from the generated background. |
| `refine_prompt` | boolean | `true` | `true`, `false` | When enabled, automatically enhances the user's prompt for better results. |
| `seed` | integer | Random | 0 - 2^32 | Seed for reproducible generations. |
| `fast` | boolean | `true` | `true`, `false` | Uses a faster inference path. Set to `false` for higher quality/detail. |
| `num_images` | integer | `1` | 1 - 4 | Number of variations to generate in a single request. |
| `sync_mode` | boolean | `false` | `true`, `false` | If true, returns the image as a Data URI instead of a hosted URL. |

### Output
The output is a JSON object containing the generated images and the seed used.
```json
{
  "images": [
    {
      "url": "https://v3.fal.media/files/...",
      "content_type": "image/jpeg",
      "file_name": "generated_image.jpg",
      "file_size": 102400,
      "width": 1024,
      "height": 1024
    }
  ],
  "seed": 4925634
}
```

### Example request
```json
{
  "image_url": "https://example.com/product.jpg",
  "prompt": "In a luxury minimalist living room with soft afternoon sunlight hitting the wall, photorealistic, 8k",
  "fast": false,
  "refine_prompt": true
}
```

### Pricing
- **Cost:** $0.023 per generation (per image).
- **Unit:** Billed per request/image.

## API — via Original Source (BYO-key direct)
Bria AI provides a direct API for enterprise users who wish to bypass FAL.ai.
- **Endpoint:** `POST https://api.bria.ai/v2/image/edit/replace_background`
- **Auth Method:** `api_token` header.
- **Additional Parameters:** The native API supports a `mode` parameter (`base`, `high_control`, `fast`) which is abstracted by FAL's `fast` toggle. It also includes `original_quality` (boolean) to ensure the output matches the exact input resolution.
- **Official Docs:** [Bria AI Background Replace Docs](https://docs.bria.ai/image-editing/v2-endpoints/background-replace)

## Prompting best practices
- **Be Descriptive about Lighting:** Instead of just "on a beach," use "on a tropical beach during golden hour with warm orange light and soft shadows."
- **Use Hex Codes:** Bria supports hex codes for solid backgrounds or color themes. E.g., "In a studio with a #FF5733 background."
- **Spatial Keywords:** Use phrases like "sitting on a wooden table," "placed on a marble countertop," or "floating in space" to help the model ground the subject.
- **Avoid Special Characters:** Stick to standard English text; special symbols may confuse the prompt refiner.
- **Prompt Length:** For `fast=true`, aim for 50-60 words. For `fast=false` (which likely triggers "high_control" internally), you can go up to 110 words for complex scenes.

**Good Prompt:** "A high-end glass skincare bottle on a damp mossy rock in a misty redwood forest, soft focus background, natural lighting, 8k resolution."
**Bad Prompt:** "bottle forest misty !!!!"

## Parameter tuning guide
- **`fast` (Boolean):** This is the most impactful setting. Use `true` for rapid prototyping. Switch to `false` for final assets to enable the "High Control" mode which offers better prompt adherence and finer detail in the background texture.
- **`refine_prompt`:** Leave this as `true` if you are providing short, simple prompts. Turn it `false` only if you have a highly engineered prompt and you find the automatic "enhancements" are drifting away from your specific vision.
- **`ref_image_url`:** If you have a specific brand aesthetic (e.g., a specific marble texture or room layout), use a reference image instead of relying solely on text. This significantly reduces the "trial and error" of prompting.

## Node inputs/outputs
- **Inputs:**
    - `Foreground Image` (Image/URL)
    - `Background Prompt` (String)
    - `Style Reference` (Optional Image/URL)
    - `Quality Toggle` (Fast/Quality)
- **Outputs:**
    - `Result Image` (Image)
    - `Generation Seed` (Integer)
- **Chain-friendly with:**
    - `fal-ai/bria/background/remove`: Use first to verify the mask before replacing.
    - `fal-ai/bria/upscaler`: To take the 1MP result up to 4k for print.
    - `fal-ai/bria/expand`: To change the aspect ratio after the background is replaced.

## Notes & gotchas
- **Resolution:** The model typically scales inputs to ~1MP (e.g., 1024x1024) during processing, though it attempts to preserve the original aspect ratio.
- **Language:** Currently only supports English prompts.
- **Commercial Safety:** The model is "Dichotomous Image Segmentation" based, meaning it's excellent at "all or nothing" foreground/background splits but may struggle with extremely complex transparencies like smoke or glass edges compared to traditional manual masking.
- **Rate Limits:** Standard FAL.ai rate limits apply based on your tier.

## Sources
- [FAL.ai Model Page](https://fal.ai/models/fal-ai/bria/background/replace)
- [Bria AI API Documentation](https://docs.bria.ai/image-editing/v2-endpoints/background-replace)
- [Bria RMBG-2.0 Hugging Face Card](https://huggingface.co/briaai/RMBG-2.0)
- [FAL.ai Pricing](https://fal.ai/pricing)
