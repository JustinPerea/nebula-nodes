---
name: fal-ai/flux-pro/v1/fill
display_name: FLUX.1 [pro] Fill
category: image-to-image
creator: Black Forest Labs
fal_docs: https://fal.ai/models/fal-ai/flux-pro/v1/fill
original_source: https://blackforestlabs.ai/
summary: Professional-grade inpainting and outpainting model for surgical image edits and scene expansion.
---

# FLUX.1 [pro] Fill

## Overview
- **Slug:** `fal-ai/flux-pro/v1/fill`
- **Category:** image-to-image (Inpainting / Outpainting)
- **Creator:** [Black Forest Labs](https://blackforestlabs.ai/)
- **Best for:** Surgical object replacement, seamless background filling, and extending image boundaries (outpainting).
- **FAL docs:** [fal.ai/models/fal-ai/flux-pro/v1/fill](https://fal.ai/models/fal-ai/flux-pro/v1/fill)
- **Original source:** [docs.bfl.ml/flux_tools/flux_1_fill](https://docs.bfl.ml/flux_tools/flux_1_fill)

## What it does
FLUX.1 [pro] Fill is a high-performance generative model specialized for mask-based image editing. Unlike standard image-to-image models that often regenerate the entire canvas, this model uses a "fill" architecture to precisely modify only the areas defined by a mask. It excels at maintaining the integrity of the unmasked regions while seamlessly blending new content, text, or textures into the target area. It is capable of both **inpainting** (replacing objects within a frame) and **outpainting** (extending the image borders).

## When to use this model
- **Use when:** 
    - You need to swap specific objects (e.g., changing a character's clothing or a product's color).
    - You want to add text or logos to specific surfaces in a photo.
    - You need to extend an image to a different aspect ratio (e.g., turning a portrait photo into a landscape hero banner).
    - You require professional-grade consistency where the surrounding environment must remain 100% untouched.
- **Don't use when:** 
    - You want a total stylistic transformation of the entire image (use `flux-pro` or `flux-dev` for that).
    - You have multiple reference images for style and subject (use `flux-pro/kontext` instead).
- **Alternatives:** 
    - **FLUX.1 Kontext [pro]:** Better for multi-reference conditioning where you want to "copy" a style from one image into another.
    - **FLUX.1 [pro] v1.1:** Faster and higher quality for pure text-to-image, but lacks the specialized filling architecture.

## API — via FAL.ai
**Endpoint:** `https://fal.run/fal-ai/flux-pro/v1/fill` (sync) / `https://queue.fal.run/fal-ai/flux-pro/v1/fill` (queue)

### Input parameters
| Parameter | Type | Default | Range/Values | Description |
|---|---|---|---|---|
| `prompt` | string | (required) | N/A | Text description of what should appear in the masked area. |
| `image_url` | string | (required) | URL | The source image to be edited. Supports jpg, png, webp, gif, avif. |
| `mask_url` | string | (required) | URL | A black and white mask where white (255) defines the area to be changed. Must match source image dimensions. |
| `seed` | integer | random | 0 to 2^32-1 | For reproducible results. Using the same seed/prompt/mask ensures the same output. |
| `num_images` | integer | 1 | 1 - 4 | Number of variations to generate per request. |
| `output_format` | string | `jpeg` | `jpeg`, `png` | The file format of the generated image. |
| `sync_mode` | boolean | `false` | `true`, `false` | If true, returns the image as a Base64 URI immediately. |
| `safety_tolerance` | string | `2` | `1` to `6` | Content moderation strictness (1 is most strict, 6 is most permissive). |
| `enhance_prompt` | boolean | `false` | `true`, `false` | Automatically rewrites the prompt for better detail and adherence. |

### Output
The model returns a JSON object containing a list of generated images and execution metadata.
```json
{
  "images": [
    {
      "url": "https://fal.run/storage/...",
      "width": 1024,
      "height": 1024,
      "content_type": "image/jpeg"
    }
  ],
  "seed": 12345678,
  "has_nsfw_concepts": [false],
  "prompt": "...",
  "timings": { "inference": 5.42 }
}
```

### Example request
```json
{
  "prompt": "a futuristic cybernetic arm with glowing blue circuits",
  "image_url": "https://example.com/character.jpg",
  "mask_url": "https://example.com/arm_mask.png",
  "num_images": 1,
  "enhance_prompt": true
}
```

### Pricing
- **$0.05 per Megapixel:** Billed by rounding up to the nearest megapixel.
- Batching multiple images (up to 4) scales the cost linearly based on the total pixels generated.

## API — via Original Source (BYO-key direct)
The model creator, Black Forest Labs, provides a direct API for the "FLUX.1 Fill [pro]" model.
- **Endpoint:** `https://api.bfl.ai/v1/flux-pro-1.0-fill`
- **Auth Method:** Header `x-key: $BFL_API_KEY`
- **Unique Parameters:** The BFL native API exposes `steps` (range 1-50) and `guidance` (CFG scale, often defaulted to 30.0 for Fill).
- **Official Docs:** [docs.bfl.ml](https://docs.bfl.ml/flux_tools/flux_1_fill)

## Prompting best practices
- **Describe the Change, Not the Whole Image:** Focus the prompt strictly on what should happen *inside* the mask. For example, instead of "A man wearing a red hat in a park," if the mask is just over the head, use "a red wool beanie with a small logo."
- **Natural Language is King:** FLUX models are trained on T5 encoders and understand complex, descriptive sentences better than comma-separated keywords.
- **Hierarchical Structure:** Place the primary subject first, followed by textures, lighting, and then technical specs.
- **Avoid "Anti-Prompts":** Negative prompts are not officially supported in the same way as Stable Diffusion; instead, describe what you *do* want clearly.
- **Outpainting Tip:** When extending an image, your prompt should describe the newly created environment (e.g., "expanding into a lush tropical forest with dappled sunlight").

## Parameter tuning guide
- **`enhance_prompt`:** Turn this **ON** for simple one-word prompts to let the model add stylistic detail. Turn it **OFF** if you have a very specific, technical prompt where you don't want the AI to "improvise" extra elements.
- **`safety_tolerance`:** Set to `1` or `2` for production environments to avoid any unintended edgy content. Levels `5` and `6` are best for artistic freedom in private workflows.
- **`num_images`:** Generating **4** images is highly recommended for inpainting, as subtle differences in how the AI blends the edges can make a big difference in realism.
- **`seed`:** If you find a "pose" or "lighting" you like but want a different object, keep the seed fixed and only vary the subject keywords in the prompt.

## Node inputs/outputs (for a node-based workflow app)
- **Inputs:**
    - `Prompt` (Text)
    - `Base Image` (Image/URL)
    - `Mask Image` (Image/URL)
    - `Seed` (Number)
    - `Enhance` (Boolean)
- **Outputs:**
    - `Generated Image` (Image/URL)
    - `Seed` (Number)
- **Chain-friendly with:**
    - **Segment Anything (SAM):** Use a SAM node to automatically generate the `mask_url` based on a text query (e.g., "the sunglasses") before passing it to FLUX Fill.
    - **Upscaler:** Chain the output to a `fal-ai/esrgan` or `flux-pro/v1.1/ultra` node to bring the inpainted result to 4K resolution.

## Notes & gotchas
- **Mask Alignment:** The `mask_url` image **must** have the exact same dimensions as the `image_url`. Even a 1-pixel difference can cause the API to return an error.
- **Resolution Limits:** While it handles variable resolutions, it is optimized for the **1MP to 2MP** range (around 1024x1024 or 1440x1440). Pushing to 4MP is possible but may increase generation time significantly.
- **Transparency:** The BFL native model supports Alpha channels in PNGs as masks, but the FAL.ai implementation strictly requires a separate `mask_url`.

## Sources
- [FAL.ai FLUX.1 [pro] Fill Documentation](https://fal.ai/models/fal-ai/flux-pro/v1/fill/api)
- [Black Forest Labs Official Documentation](https://docs.bfl.ml/flux_tools/flux_1_fill)
- [Black Forest Labs Technical Blog](https://blackforestlabs.ai/flux-1-tools/)
- [FAL.ai Pricing Page](https://fal.ai/pricing)
- [Hugging Face Model Card (Fill Dev)](https://huggingface.co/black-forest-labs/FLUX.1-Fill-dev)
