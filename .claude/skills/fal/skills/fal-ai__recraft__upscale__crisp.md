---
name: fal-ai/recraft/upscale/crisp
display_name: Recraft Crisp Upscale
category: upscaling
creator: Recraft.ai
fal_docs: https://fal.ai/models/fal-ai/recraft/upscale/crisp
original_source: https://www.recraft.ai/docs/api-reference/endpoints#crisp-upscale
summary: A high-fidelity image upscaler designed to enhance resolution while maintaining sharpness and refining fine details and faces.
---

# Recraft Crisp Upscale

## Overview
- **Slug:** `fal-ai/recraft/upscale/crisp`
- **Category:** Image-to-Image / Upscaling
- **Creator:** [Recraft.ai](https://www.recraft.ai/)
- **Best for:** Refining small details, sharpening faces, and increasing resolution without creative deviation.
- **FAL docs:** [fal-ai/recraft/upscale/crisp](https://fal.ai/models/fal-ai/recraft/upscale/crisp)
- **Original source:** [Recraft API Docs](https://www.recraft.ai/docs/api-reference/endpoints#crisp-upscale)

## What it does
Recraft Crisp Upscale is a precision-engineered tool designed to boost the resolution of raster images. Unlike "creative" upscalers that might hallucinate new details, the "Crisp" model focuses on enhancing existing textures, sharpening edges, and refining fine details—especially human faces. It is optimized for turning low-resolution assets into high-quality visuals suitable for web displays or professional print materials.

## When to use this model
- **Use when:** You have a clean but low-resolution image that needs to be larger without losing its original character. It is particularly effective for logos, portraits, and product photography.
- **Don't use when:** You want to fundamentally change the content of the image or add artistic flair (use [Recraft Creative Upscale](https://fal.ai/models/fal-ai/recraft/upscale/creative) instead).
- **Alternatives:** 
    - **[Recraft Creative Upscale](https://fal.ai/models/fal-ai/recraft/upscale/creative):** Best when you want the AI to "re-imagine" details to make a very low-quality image look significantly better.
    - **[ESRGAN](https://fal.ai/models/fal-ai/esrgan):** A faster, more generic upscaler, but often lacks the specialized face-refinement of Recraft.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/recraft/upscale/crisp` (sync) / `https://queue.fal.run/fal-ai/recraft/upscale/crisp` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | string | (None) | Required | The URL of the image to be upscaled. Must be in PNG format for best results. |
| `sync_mode` | boolean | `false` | `true`, `false` | If `true`, the media will be returned as a data URI and won't be saved in history. |
| `enable_safety_checker` | boolean | `true` | `true`, `false` | Enables the safety filter to block NSFW content. |

### Output
The output returns an object containing the upscaled image details:
- **`image`**: A [File object](https://fal.ai/models/fal-ai/recraft/upscale/crisp/api#type-File) containing:
    - `url`: The public URL of the upscaled image.
    - `content_type`: Mime type (e.g., `image/png`).
    - `file_name`: Generated filename.
    - `file_size`: Size in bytes.

### Example request
```json
{
  "image_url": "https://storage.googleapis.com/falserverless/model_tests/recraft/recraft.png",
  "sync_mode": false,
  "enable_safety_checker": true
}
```

### Pricing
- **Cost:** $0.004 per image (on FAL.ai).

## API — via Original Source (BYO-key direct)
Recraft provides a direct REST API for their tools.
- **Endpoint:** `POST https://external.api.recraft.ai/v1/images/crispUpscale`
- **Auth method:** Bearer Token (`Authorization: Bearer <RECRAFT_API_TOKEN>`)
- **Parameters:** 
    - `file`: The image file (multipart/form-data).
    - `response_format`: `url` or `b64_json`.
- **Pricing:** $0.04 per raster image (10x the cost of FAL.ai).
- **Official Docs:** [Recraft.ai API Reference](https://www.recraft.ai/docs/api-reference/endpoints#crisp-upscale)

## Prompting best practices
*Note: As an upscaler, this model does not take a text prompt. Instead, the "prompt" is the input image itself.*
- **Clean Inputs:** Start with the cleanest version of your image. While it can sharpen, it works best when the input isn't heavily compressed with artifacts.
- **PNG Format:** The API documentation specifically recommends PNG format for input images to maintain data integrity before upscaling.
- **Portrait Focus:** If upscaling a face, ensure the face is clearly visible in the source; the model has specific weights for face refinement.
- **Avoid Over-Cropping:** The model performs better when it has the full context of the image rather than a tiny, tight crop.

## Parameter tuning guide
- **`sync_mode`:** Use this for real-time applications where you need the image immediately as a base64 string, but be aware of payload size limits in some environments.
- **`enable_safety_checker`:** Always keep this enabled for public-facing apps. Note that in the FAL playground, this cannot be disabled, but it is optional via the API.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Image URL`: The source image to enhance.
- **Outputs:**
    - `Upscaled Image`: The high-resolution result.
- **Chain-friendly with:**
    - **[Recraft V4](https://fal.ai/models/fal-ai/recraft-v3):** Generate a 1MP image first, then pass it to Crisp Upscale for a high-res finish.
    - **[Remove Background](https://fal.ai/models/fal-ai/recraft/upscale/crisp/api#schema-other):** Chain after upscaling to get a high-res, transparent asset.

## Notes & gotchas
- **Source Constraints:** The original Recraft API limits inputs to 5MB, 4MP resolution, and a maximum dimension of 4096px.
- **Cost Efficiency:** FAL.ai is significantly more cost-effective ($0.004) compared to the direct Recraft API ($0.04) for single image calls.
- **Format:** Ensure your input image is a valid raster format (PNG/JPG/WEBP); SVG is not supported as an input for this specific endpoint.

## Sources
- [FAL.ai Recraft Crisp Upscale Documentation](https://fal.ai/models/fal-ai/recraft/upscale/crisp)
- [Official Recraft API Reference](https://www.recraft.ai/docs/api-reference/endpoints)
- [Recraft Pricing Page](https://www.recraft.ai/docs/api-reference/pricing)
