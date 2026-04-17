---
name: fal-ai/bytedance/seedream/v4.5/edit
display_name: ByteDance Seedream v4.5 Edit
category: image-to-image
creator: ByteDance
fal_docs: https://fal.ai/models/fal-ai/bytedance/seedream/v4.5/edit
original_source: https://seed.bytedance.com/en/seedream4_5
summary: A professional-grade image editing and creation model optimized for multi-image consistency and exceptional typography.
---

# ByteDance Seedream v4.5 Edit

## Overview
- **Slug:** `fal-ai/bytedance/seedream/v4.5/edit`
- **Category:** Image Editing / Multi-Image Generation
- **Creator:** [ByteDance](https://seed.bytedance.com/en/seedream4_5)
- **Best for:** Professional product photography, brand-consistent marketing assets, and accurate text rendering.
- **FAL docs:** [fal-ai/bytedance/seedream/v4.5/edit](https://fal.ai/models/fal-ai/bytedance/seedream/v4.5/edit)
- **Original source:** [ByteDance Seed](https://seed.bytedance.com/en/seedream4_5)

## What it does
ByteDance Seedream v4.5 is a unified image creation and editing model that integrates generation and modification capabilities into a single architecture. It is specifically engineered to handle **multi-image editing** with high subject consistency, preserving fine details of reference images (like labels, textures, and lighting) while accurately rendering complex typography ([MindStudio](https://www.mindstudio.ai/blog/what-is-bytedance-seedream-4-5/)). Unlike traditional editing models, it understands spatial relationships and material textures with near-photographic fidelity, making it a top-tier choice for commercial production ([EvoLink](https://evolink.ai/blog/seedream-api-image-generation-cost-optimization-guide)).

## When to use this model
- **Use when:** 
    - You need to maintain consistent characters or products across multiple images ([MindStudio](https://www.mindstudio.ai/blog/what-is-bytedance-seedream-4-5/)).
    - Your image requires legible, dense, or multi-line text (e.g., posters, product labels, menus) ([ImagineArt](https://www.imagine.art/blogs/Seedream-5-vs-4-5)).
    - You are performing complex edits like background swaps or outfit changes while keeping the main subject identical ([MindStudio](https://www.mindstudio.ai/blog/what-is-bytedance-seedream-4-5/)).
    - You require high-resolution (up to 4K) output for print or professional digital use ([MindStudio](https://www.mindstudio.ai/blog/what-is-bytedance-seedream-4-5/)).
- **Don't use when:** 
    - You need deep logical reasoning or vague intent editing (use **Seedream 5.0 Lite** instead) ([ImagineArt](https://www.imagine.art/blogs/Seedream-5-vs-4-5)).
    - You are looking for highly experimental or abstract artistic styles; the model trends toward "commercial" hyper-realism ([MindStudio](https://www.mindstudio.ai/blog/what-is-bytedance-seedream-4-5/)).
- **Alternatives:** 
    - **fal-ai/bytedance/seedance-2.0**: For text-to-video workflows within the same ecosystem ([FAL.ai](https://fal.ai/models/bytedance/seedance-2.0/fast/text-to-video)).
    - **fal-ai/flux-2-flex**: For state-of-the-art open-weights image generation with high prompt adherence but less focus on multi-image consistency.
    - **fal-ai/kling-video**: For high-end image-to-video transformations.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/bytedance/seedream/v4.5/edit` (sync) / `https://queue.fal.run/fal-ai/bytedance/seedream/v4.5/edit` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | *Required* | N/A | The text prompt used to edit or generate the image. |
| `image_urls` | list<string> | *Required* | Max 10 | List of URLs for input reference images. Critical for editing tasks. |
| `image_size` | string/object | `square_hd` | Enums: `square_hd, square, portrait_4_3, portrait_16_9, landscape_4_3, landscape_16_9, auto_2K, auto_4K` | The size of the output image. Can also be an object: `{"width": 1280, "height": 720}` (1920-4096 px). |
| `num_images` | integer | `1` | 1-8 | Number of separate generation runs. |
| `max_images` | integer | `1` | N/A | Enables multi-image generation per run. Total images (input + output) must not exceed 15. |
| `seed` | integer | Random | N/A | Seed for reproducibility. |
| `enable_safety_checker`| boolean | `true` | `true, false` | Toggles the content safety filter. |
| `sync_mode` | boolean | `false` | `true, false` | If true, returns base64 data URI directly. |

### Output
The output returns an object containing a list of generated images.
```json
{
  "images": [
    {
      "url": "https://fal.run/.../image.png",
      "width": 1024,
      "height": 1024,
      "content_type": "image/png",
      "file_name": "generated_0.png",
      "file_size": 123456
    }
  ]
}
```

### Example request
```json
{
  "prompt": "Change the background to a minimalist marble studio, maintain the lighting on the perfume bottle in image 1.",
  "image_urls": ["https://example.com/product_bottle.jpg"],
  "image_size": "auto_2K",
  "seed": 42
}
```

### Pricing
- **Cost:** $0.04 per image generation/edit ([FAL.ai](https://fal.ai/learn/devs/seedream-v4-5-vs-v4-0)).
- Pricing is flat-rate regardless of resolution (up to 4K) ([MindStudio](https://www.mindstudio.ai/blog/what-is-bytedance-seedream-4-5/)).

## API — via Original Source (BYO-key direct)
ByteDance provides direct API access through its **BytePlus** (Global) and **Volcengine** (China) platforms.
- **Provider:** BytePlus / Volcengine
- **Endpoint:** `https://api.byteplus.com/...` (specific to region/account)
- **Advantages:** Supports up to **14 reference images** (FAL is currently capped at 10) and tiered credit packages for high volume ([ImagineArt](https://www.imagine.art/blogs/seedream-pricing-guide)).
- **Auth:** HMAC-SHA256 signature using AccessKey/SecretKey.
- **Docs:** [BytePlus AI Image Docs](https://www.byteplus.com/en/product/image-generation)

## Prompting best practices
- **Word Count:** Keep prompts between 30 and 100 words. The model is highly sensitive to the first few words ([MindStudio](https://www.mindstudio.ai/blog/what-is-bytedance-seedream-4-5/)).
- **Text Keywords:** For clear typography, use tokens like "sharp text", "legible typography", "vector-style lettering", or "clean font" ([EvoLink](https://evolink.ai/blog/seedream-api-image-generation-cost-optimization-guide)).
- **Reference Management:** Explicitly refer to images by their index (e.g., "Keep the character in Figure 1, but change the outfit to Figure 2") ([MindStudio](https://www.mindstudio.ai/blog/what-is-bytedance-seedream-4-5/)).
- **Style Consistency:** Include "studio lighting", "50mm lens", or "commercial photography" to leverage the model's professional training data.
- **Common Failure:** Curved text layouts (e.g., text on a circle) fail in ~59% of cases. Stick to horizontal or vertical text paths for best results ([MindStudio](https://www.mindstudio.ai/blog/what-is-bytedance-seedream-4-5/)).

## Parameter tuning guide
- **`image_size`**: Use `auto_4K` only for final exports as it increases latency to ~60 seconds. Use `square_hd` or `auto_2K` for rapid prototyping (~3-5s) ([FAL.ai](https://fal.ai/learn/devs/seedream-v4-5-developer-guide)).
- **`seed`**: Essential for iterative editing. Lock the seed when testing slight prompt adjustments to keep the background/subject stable.
- **`max_images`**: Increase this when you need multiple variations of a character or product in a single call to ensure identity consistency across the batch.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Prompt` (Text)
    - `Image References` (List of Image URLs)
    - `Size Preset` (Dropdown)
    - `Seed` (Number)
- **Outputs:**
    - `Result Images` (List of Images)
- **Chain-friendly with:**
    - **Topaz Upscaler**: To take 2K outputs to 8K/16K.
    - **Remove.bg**: To extract generated subjects for further compositing.
    - **CapCut / Seedance**: To animate the generated consistent characters into video.

## Notes & gotchas
- **"Plasticky" Skin:** The model can sometimes over-beautify subjects, leading to a "plasticky" or overly-smooth skin texture. Reduce adjectives like "perfect" or "flawless" to maintain realism ([MindStudio](https://www.mindstudio.ai/blog/what-is-bytedance-seedream-4-5/)).
- **Rate Limits:** As a partner model, it may have lower concurrency limits than FAL's proprietary models. Use `queue` mode for batch processing.
- **Image Limit:** Total images (inputs + outputs) cannot exceed 15 in one request ([FAL.ai](https://fal.ai/models/fal-ai/bytedance/seedream/v4.5/edit/api)).

## Sources
- [FAL.ai Seedream v4.5 API Docs](https://fal.ai/models/fal-ai/bytedance/seedream/v4.5/edit/api)
- [ByteDance Seed Official Page](https://seed.bytedance.com/en/seedream4_5)
- [MindStudio Technical Review](https://www.mindstudio.ai/blog/what-is-bytedance-seedream-4-5/)
- [ImagineArt Model Comparison](https://www.imagine.art/blogs/Seedream-5-vs-4-5)
- [EvoLink pricing and Dev Guide](https://evolink.ai/blog/seedream-pricing-guide-2026)