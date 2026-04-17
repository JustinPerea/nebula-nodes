---
name: fal-ai/bria/background/remove
display_name: Bria RMBG 2.0
category: image-to-image
creator: Bria AI
fal_docs: https://fal.ai/models/fal-ai/bria/background/remove
original_source: https://docs.bria.ai/image-editing/v2-endpoints/background-remove
summary: Production-grade, commercially-safe background removal tool optimized for e-commerce and professional asset workflows.
---

# Bria RMBG 2.0

## Overview
- **Slug:** `fal-ai/bria/background/remove`
- **Category:** Image-to-Image / Image Editing
- **Creator:** [Bria AI](https://bria.ai/)
- **Best for:** High-precision background removal in commercial and enterprise environments where legal safety and high resolution are required.
- **FAL docs:** [fal.ai/models/fal-ai/bria/background/remove](https://fal.ai/models/fal-ai/bria/background/remove)
- **Original source:** [Bria AI Documentation](https://docs.bria.ai/image-editing/v2-endpoints/background-remove)

## What it does
Bria RMBG 2.0 is a state-of-the-art background removal model specifically designed for professional-grade image segmentation. Unlike models trained on scraped web data, RMBG 2.0 is trained exclusively on a dataset of over 15,000 high-quality, manually labeled, and fully licensed images ([Bria AI](https://huggingface.co/briaai/RMBG-2.0)). It produces a high-resolution 8-bit alpha matte, allowing for smooth, non-binary edges that handle fine details like hair, fur, and semi-transparent objects much better than traditional background removers.

The model is built on the **BiRefNet architecture** and is optimized to preserve the original image's aspect ratio and resolution up to 1024x1024 for the core inference step, with results typically resized back to the original dimensions ([FAL.ai](https://fal.ai/models/fal-ai/bria/background/remove)).

## When to use this model
- **Use when:**
  - You are building e-commerce tools, marketing asset pipelines, or professional photo editing apps.
  - You need "legal certainty" and want to avoid models trained on unlicensed web-scraped data ([FAL.ai](https://fal.ai/models/fal-ai/bria/background/remove)).
  - You require high-quality transparency (alpha channels) rather than just a binary mask.
- **Don't use when:**
  - You need to *replace* the background with a specific generated scene (use `fal-ai/bria/background/replace` instead).
  - You are working with extremely low-resolution thumbnails where a simpler, cheaper model might suffice.
- **Alternatives:**
  - **fal-ai/bria/background/replace:** Similar quality but includes generative fill to place the subject in a new context.
  - **fal-ai/bria/product-shot:** Combines background removal with studio-quality scene generation for e-commerce.
  - **BiRefNet (General):** The underlying architecture, available in various open-source versions, though Bria's RMBG 2.0 is specifically tuned for commercial safety and better accuracy.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/bria/background/remove` (sync) / `https://queue.fal.run/fal-ai/bria/background/remove` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | string | *Required* | Any valid image URL | The URL of the input image to remove the background from. |
| `sync_mode` | boolean | `false` | `true`, `false` | If `true`, the media will be returned as a data URI and won't be saved in request history. |

### Output
The output is a JSON object containing the processed image details:
```json
{
  "image": {
    "url": "https://v3.fal.media/files/...",
    "width": 1024,
    "height": 768,
    "file_name": "filename.png",
    "file_size": 1278318,
    "content_type": "image/png"
  }
}
```
The output image is always a **PNG with an alpha channel** (transparency).

### Example request
```json
{
  "image_url": "https://example.com/product_photo.jpg",
  "sync_mode": false
}
```

### Pricing
- **$0.018 per generation** on FAL.ai ([FAL.ai](https://fal.ai/models/fal-ai/bria/background/remove)).
- This is approximately 55 images per $1.00.

## API — via Original Source (BYO-key direct)
Bria AI provides a direct API for enterprise users who wish to use their own keys and access additional features like content moderation.

- **Endpoint:** `POST https://engine.prod.bria-api.com/v2/image/edit/remove_background`
- **Auth method:** Header `api_token: YOUR_BRIA_API_KEY`
- **Additional Parameters (Direct API Only):**
  - `preserve_alpha` (boolean): Controls if existing transparency in the input is kept.
  - `visual_input_content_moderation` (boolean): Enables safety filtering on the input.
  - `visual_output_content_moderation` (boolean): Enables safety filtering on the result.
- **Official Docs:** [Bria API Reference](https://docs.bria.ai/image-editing/v2-endpoints/background-remove)

## Prompting best practices
*Note: This is a segmentation model, not a text-to-image model, so it does not take text prompts.*
- **High Contrast:** Ensure the subject has a relatively clear distinction from the background for the best edge detection.
- **Lighting:** Consistent lighting on the subject helps the model differentiate between the foreground object and background shadows.
- **Resolution:** For best results, use images where the subject occupies at least 50% of the frame.
- **Avoid Busy Backgrounds:** While the model is robust, extremely "noisy" backgrounds (like a crowd or thick forest) may require manual touch-ups for fine hair.

## Parameter tuning guide
FAL.ai's implementation is highly streamlined, so there are no tuning parameters like "threshold." However, the model natively outputs an 8-bit alpha matte (0-255 transparency levels). 
- **Binarization Tip:** If your application requires a hard "cut" (binary mask), you can apply a threshold (e.g., any alpha > 128 becomes 255) in your post-processing code ([Bria Docs](https://docs.bria.ai/image-editing/v2-endpoints/background-remove)).

## Node inputs/outputs
- **Inputs:**
  - `Image URL` (The source image)
- **Outputs:**
  - `Image URL` (The transparent PNG result)
- **Chain-friendly with:**
  - **fal-ai/bria/expand:** Use after background removal to fit the subject into a new aspect ratio.
  - **fal-ai/flux/dev:** Use the isolated subject as an overlay on a newly generated Flux background.
  - **fal-ai/bria/product-shot:** Feed the isolated subject into product staging workflows.

## Notes & gotchas
- **Resolution:** The model is optimized for 1024x1024 inference. While it can handle larger inputs, it may internally downscale and upscale, which can slightly soften edges on 4K+ imagery.
- **Formats:** Supports JPEG, PNG, WebP, GIF, and AVIF.
- **Legal Safe:** This is the primary model used by enterprises (like stock photo sites) because the training data is 100% licensed ([Hugging Face](https://huggingface.co/briaai/RMBG-2.0)).

## Sources
- [FAL.ai Bria RMBG 2.0 Documentation](https://fal.ai/models/fal-ai/bria/background/remove)
- [Bria AI Official API Docs](https://docs.bria.ai/image-editing/v2-endpoints/background-remove)
- [Bria RMBG 2.0 Model Card on Hugging Face](https://huggingface.co/briaai/RMBG-2.0)
- [Replicate Pricing Comparison](https://replicate.com/bria/remove-background)