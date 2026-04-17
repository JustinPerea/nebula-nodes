---
name: fal-ai/imageutils/rembg
display_name: Remove Background (Rembg)
category: image-to-image
creator: Daniel Gatis (Rembg)
fal_docs: https://fal.ai/models/fal-ai/imageutils/rembg
original_source: https://github.com/danielgatis/rembg
summary: A high-performance utility for removing image backgrounds using the Rembg library.
---

# Remove Background (Rembg)

## Overview
- **Slug:** `fal-ai/imageutils/rembg`
- **Category:** image-to-image / utility
- **Creator:** [Daniel Gatis](https://github.com/danielgatis)
- **Best for:** Fast, automated background removal for e-commerce, portraits, and social media assets.
- **FAL docs:** [fal.ai/models/fal-ai/imageutils/rembg](https://fal.ai/models/fal-ai/imageutils/rembg)
- **Original source:** [github.com/danielgatis/rembg](https://github.com/danielgatis/rembg)

## What it does
`fal-ai/imageutils/rembg` is a specialized image-processing utility designed to automatically detect and remove backgrounds from images. It leverages the popular `rembg` Python library, which uses a variety of pre-trained deep learning models (primarily based on U2-Net) to separate the foreground subject from its surroundings with high precision. The result is a transparent PNG or a data URI containing the isolated subject.

## When to use this model
- **Use when:** 
    - You need to prepare product photos for e-commerce (e.g., Shopify, Amazon).
    - You want to isolate people or objects for graphic design or social media stickers.
    - You are building an automated pipeline that requires clean, transparent-background images.
- **Don't use when:** 
    - The foreground and background have extremely similar colors or complex textures (e.g., fine hair against a busy background), as it may lead to "choppy" edges.
    - You need manual control over the selection area (this is a fully automated tool).
- **Alternatives:**
    - **fal-ai/imageutils/rembg-enhance:** A similar model optimized for 2D vector images and photos using advanced matting technology for smoother edges.
    - **fal-ai/photomaker:** Useful if you are trying to generate new images of a specific person rather than just isolating an existing one.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/imageutils/rembg` (sync) / `https://queue.fal.run/fal-ai/imageutils/rembg` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `image_url` | `string` | *(required)* | URL | The URL of the image to process. Supported types: jpg, jpeg, png, webp, gif, avif. |
| `sync_mode` | `boolean` | `false` | `true`, `false` | If `true`, the media will be returned as a Base64 data URI and the output data won't be available in the request history. |
| `crop_to_bbox` | `boolean` | `false` | `true`, `false` | If set to `true`, the resulting image will be cropped to a tight bounding box around the subject. |

### Output
The API returns a JSON object containing the processed image information.

```json
{
  "image": {
    "url": "https://v3.fal.media/files/...",
    "content_type": "image/png",
    "file_name": "image.png",
    "file_size": 123456,
    "width": 1024,
    "height": 1024
  }
}
```

### Example request
```json
{
  "image_url": "https://storage.googleapis.com/falserverless/model_tests/remove_background/elephant.jpg",
  "crop_to_bbox": true
}
```

### Pricing
- **Cost:** $0 per compute second (as per latest [FAL docs](https://fal.ai/models/fal-ai/imageutils/rembg/api)). 
- *Note:* While listed as $0/s, FAL typically applies standard compute pricing for utility models or includes them in tier-based usage. Check the [pricing page](https://fal.ai/pricing) for the most current rates on utility-class models.

## API — via Original Source (BYO-key direct)
The original `rembg` is an open-source Python library. While there is no centralized "Rembg API" provided by the creator, you can run it natively.

- **Endpoint:** Self-hosted (e.g., via `rembg s` command for an HTTP server).
- **Auth method:** None (Local/Self-hosted).
- **Link to official docs:** [Rembg Usage Documentation](https://github.com/danielgatis/rembg/blob/main/USAGE.md)

**Additional features in the original source:**
- **Model Selection:** The CLI/Library allows choosing specific models like `u2net`, `u2net_human_seg`, `u2net_cloth_seg`, `silueta`, `isnet-general-use`, `sam`, and `bria-rmbg`.
- **Alpha Matting:** Support for foreground/background erosion and sigma values for finer edge control.
- **Batch Processing:** Native support for processing entire folders (`rembg p`).

## Prompting best practices
*Rembg is a utility model, not a generative text-to-image model. "Prompting" does not apply in the traditional sense. However, for best results:*
- **Contrast:** Ensure the subject has reasonable contrast with the background.
- **Lighting:** Evenly lit subjects without heavy shadows casting onto the background yield the cleanest masks.
- **Resolution:** Provide high-resolution source images; `rembg` works best when it can clearly identify edges.
- **Avoid Overlap:** If the subject is partially obscured by another object, the model may struggle to define the "correct" subject.

## Parameter tuning guide
- **`crop_to_bbox`:** 
    - Set to **`true`** if you are preparing assets for a UI where you want the subject to be centered and the file size minimized.
    - Set to **`false`** if you need the output to maintain the original aspect ratio and positioning of the source image.
- **`sync_mode`:**
    - Use **`true`** for real-time web applications where you want to avoid extra network requests for the image URL and instead get the image data immediately.
    - Use **`false`** for high-volume or background workflows where you want to keep a history of processed files on FAL's storage.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:** 
    - `Image URL`: The source image to be processed.
    - `Crop To Bounding Box`: Boolean toggle for tight cropping.
- **Outputs:**
    - `Image`: The background-removed PNG image object (includes URL, width, and height).
- **Chain-friendly with:** 
    - **fal-ai/flux/schnell:** Generate an image, then pass it to Rembg to isolate the subject.
    - **fal-ai/imageutils/upscale:** Upscale the isolated subject for high-quality print or web use.
    - **fal-ai/kling-video:** Use the isolated subject as an Image-to-Video source.

## Notes & gotchas
- **Max Resolution:** While not strictly capped, extremely large images (e.g., 8K+) may time out or consume significant memory.
- **Transparent Areas:** The model might occasionally remove transparent or semi-transparent parts of the subject (like glass or fine mesh) if they are perceived as background.
- **Multiple Subjects:** By default, it tries to keep all prominent subjects. If you have multiple items in a shot, they will all remain in the foreground.

## Sources
- [FAL.ai rembg Documentation](https://fal.ai/models/fal-ai/imageutils/rembg)
- [Original Rembg GitHub Repository](https://github.com/danielgatis/rembg)
- [Hugging Face Space for Rembg](https://huggingface.co/spaces/KenjieDec/RemBG)
