---
name: fal-ai/topaz/upscale/image
display_name: Topaz Image Upscale
category: image-to-image
creator: Topaz Labs
fal_docs: https://fal.ai/models/fal-ai/topaz/upscale/image
original_source: https://www.topazlabs.com/api
summary: Professional-grade AI image upscaling and enhancement with face restoration and generative detail recovery.
---

# Topaz Image Upscale

## Overview
- **Slug:** `fal-ai/topaz/upscale/image`
- **Category:** image-to-image (Upscaling & Enhancement)
- **Creator:** [Topaz Labs](https://www.topazlabs.com/)
- **Best for:** Professional-grade upscaling, restoring low-resolution faces, and fixing compression artifacts.
- **FAL docs:** [fal-ai/topaz/upscale/image](https://fal.ai/models/fal-ai/topaz/upscale/image)
- **Original source:** [Topaz Labs Developer Portal](https://developer.topazlabs.com/reference/api-endpoints/image/enhance)

## What it does
Topaz Image Upscale is an industry-leading enhancement model suite that goes beyond simple bicubic upscaling. It uses specialized AI models to intelligently "hallucinate" missing details, remove noise, and sharpen blurry edges. It is particularly renowned for its **Face Enhancement** technology, which can reconstruct facial details from extremely low-quality sources. Its latest "Redefine" mode introduces generative upscaling, allowing users to guide the creation of new textures and details via text prompts.

## When to use this model
- **Use when:** You need to prepare small images for large-format printing, restore old family photos, or clean up heavily compressed web assets.
- **Don't use when:** You need a creative "style transfer" (use Flux or SDXL for that) or when you have a perfectly sharp 4K image that just needs a slight resize.
- **Alternatives:**
    - `fal-ai/lucataco/real-esrgan`: Faster and cheaper, but lacks face restoration and generative detail.
    - `fal-ai/creative-upscaler`: Better for adding extreme artistic detail (hallucination) to AI-generated art.
    - `fal-ai/aura-sr`: Specialized for super-resolution of high-quality base images.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/topaz/upscale/image` (sync) / `https://queue.fal.run/fal-ai/topaz/upscale/image` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | string | (required) | URL | Publicly accessible URL of the image to upscale. |
| `model` | enum | `Standard V2` | `Low Resolution V2`, `Standard V2`, `CGI`, `High Fidelity V2`, `Text Refine`, `Recovery`, `Redefine`, `Recovery V2` | The specific enhancement model to use. |
| `upscale_factor` | float | `2.0` | 1.0 - 6.0 | Factor to increase dimensions (e.g., 2.0 doubles width/height). |
| `face_enhancement` | boolean | `true` | `true`, `false` | Whether to automatically detect and enhance faces. |
| `face_enhancement_strength` | float | `0.8` | 0.0 - 1.0 | Intensity of the face reconstruction. |
| `sharpen` | float | `0.0` | 0.0 - 1.0 | Level of sharpening applied (ignored by some models). |
| `denoise` | float | `0.0` | 0.0 - 1.0 | Level of noise reduction applied. |
| `fix_compression` | float | `0.0` | 0.0 - 1.0 | Level of JPEG artifact removal. |
| `output_format` | enum | `jpeg` | `jpeg`, `png` | Format of the resulting image. |
| `prompt` | string | `""` | max 1024 chars | Text prompt to guide detail (used only in `Redefine` model). |
| `creativity` | integer | `1` | 1 - 6 | Level of generative hallucination (used only in `Redefine`). |
| `texture` | integer | `1` | 1 - 5 | Amount of texture detail added (used only in `Redefine`). |
| `detail` | float | `0.0` | 0.0 - 1.0 | Detail recovery level (used only in `Recovery V2`). |

### Output
The output is a JSON object containing the processed image details.
```json
{
  "image": {
    "url": "https://fal.media/files/...",
    "content_type": "image/jpeg",
    "file_name": "upscaled_image.jpg",
    "file_size": 4404019
  }
}
```

### Example request
```json
{
  "image_url": "https://example.com/photo.jpg",
  "model": "High Fidelity V2",
  "upscale_factor": 4.0,
  "face_enhancement": true,
  "face_enhancement_strength": 0.9
}
```

### Pricing
Billed per successful request based on output resolution:
- **Up to 24MP:** ~$0.08
- **Up to 48MP:** ~$0.16
- **Up to 96MP:** ~$0.32
- **Up to 512MP:** ~$1.36
*(Rates are approximate and based on Topaz's credit-weighting on the FAL platform.)*

## API — via Original Source (BYO-key direct)
Topaz Labs offers a direct Enterprise API for high-volume users.
- **Endpoint:** `https://api.topazlabs.com/image/v1/enhance/async`
- **Auth method:** `X-API-Key` header.
- **Additional parameters:** Supports `webhook_url` for async notification and `crop_to_fill` for strict dimension matching.
- **Official Docs:** [Topaz Labs Developer Documentation](https://developer.topazlabs.com/reference/api-endpoints/image/enhance)

## Prompting best practices (for `Redefine` mode)
- **Describe textures, not just the subject:** Use keywords like "fine skin texture", "intricate fabric weave", or "weathered wood grain".
- **Keep it descriptive but concise:** Instead of "a high quality photo of a man", use "middle-aged man, realistic pores, subtle wrinkles, soft studio lighting".
- **Match the original lighting:** If the photo is dark, include "cinematic shadows" or "low light" to ensure the generative detail fits the mood.
- **Failure mode:** Avoid asking for major content changes (e.g., "add a hat"). Redefine is for *texture* and *clarity*, not object replacement.

## Parameter tuning guide
- **`model` selection:**
    - **Standard V2:** Best all-rounder for typical photos.
    - **High Fidelity V2:** Use for high-quality originals where you want to preserve the "look" exactly.
    - **Low Resolution V2:** Essential for tiny thumbnails or blurry smartphone shots.
    - **Redefine:** Use for "lost causes" where you want AI to generate new sharp detail from scratch.
- **`face_enhancement_strength`:** Set to `0.5` if faces look too "smooth" or "plastic". Increase to `0.9+` for heavily pixelated portraits.
- **`creativity` (Redefine only):** Start at `2`. Level `5-6` often introduces "hallucinations" that might not match the original person's likeness.

## Node inputs/outputs
- **Inputs:**
    - `Image` (Image URL)
    - `Scale` (Number, default 2)
    - `Model` (Selection dropdown)
    - `Prompt` (Text, optional)
- **Outputs:**
    - `Upscaled Image` (Image URL)
- **Chain-friendly with:**
    - `fal-ai/flux/schnell`: Generate an image, then pipe to Topaz for a 4K finish.
    - `fal-ai/topaz/upscale/video`: Use the image upscale for keyframes in a video workflow.

## Notes & gotchas
- **Max Resolution:** Supports output up to **32,000 pixels** on the longest edge (total 512MP).
- **Aspect Ratio:** By default, Topaz preserves the original aspect ratio. If you force specific dimensions, it will letterbox unless `crop_to_fill` is true.
- **Face Detection:** It can occasionally miss faces if they are at extreme angles or heavily obscured.
- **Processing Time:** High-factor upscales (4x+) on large images can take 20-40 seconds to process.

## Sources
- [FAL.ai Topaz Documentation](https://fal.ai/models/fal-ai/topaz/upscale/image/api)
- [Topaz Labs Official API Reference](https://developer.topazlabs.com/reference/api-endpoints/image/enhance)
- [Topaz Labs Pricing Model](https://www.topazlabs.com/api)
